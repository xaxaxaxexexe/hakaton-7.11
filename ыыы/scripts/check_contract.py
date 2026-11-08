#!/usr/bin/env python3
"""Dependency-free structural/schema checks for the shared contract and fixtures."""
import json
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
SPEC = json.loads((ROOT / "contracts/openapi.json").read_text())


def resolve(reference):
    assert reference.startswith("#/"), reference
    node = SPEC
    for key in reference[2:].split("/"):
        node = node[key]
    return node


def validate(value, schema, path="$"):
    if "$ref" in schema:
        return validate(value, resolve(schema["$ref"]), path)
    if "anyOf" in schema:
        for choice in schema["anyOf"]:
            try:
                validate(value, choice, path)
                return
            except AssertionError:
                pass
        raise AssertionError(path + ": no anyOf match")
    kind = schema.get("type")
    checks = {
        "object": lambda: isinstance(value, dict),
        "array": lambda: isinstance(value, list),
        "string": lambda: isinstance(value, str),
        "integer": lambda: type(value) is int,
        "number": lambda: type(value) in (int, float),
        "boolean": lambda: type(value) is bool,
        "null": lambda: value is None,
    }
    if kind:
        assert checks[kind](), path + ": wrong type " + kind
    if "enum" in schema:
        assert value in schema["enum"], path + ": invalid enum"
    if kind == "object":
        assert set(schema.get("required", [])) <= set(value), path + ": missing fields"
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            assert set(value) <= set(props), path + ": extra fields"
        for key, child in value.items():
            if key in props:
                validate(child, props[key], path + "." + key)
    if kind == "array":
        for index, item in enumerate(value):
            validate(item, schema["items"], path + "[" + str(index) + "]")
    if kind in ("integer", "number"):
        if "minimum" in schema:
            assert value >= schema["minimum"], path
        if "exclusiveMinimum" in schema:
            assert value > schema["exclusiveMinimum"], path
        if "exclusiveMaximum" in schema:
            assert value < schema["exclusiveMaximum"], path
    if kind == "string":
        assert len(value) >= schema.get("minLength", 0), path
        assert len(value) <= schema.get("maxLength", float("inf")), path
        if schema.get("format") == "date-time":
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                assert parsed.tzinfo is not None, path
            except ValueError:
                raise AssertionError(path + ": invalid date-time")
        if schema.get("format") == "uri":
            assert urlparse(value).scheme in ("http", "https"), path
        if schema.get("format") == "email":
            assert re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value), path


def check_refs(node):
    if isinstance(node, dict):
        if "$ref" in node:
            resolve(node["$ref"])
        for item in node.values():
            check_refs(item)
    elif isinstance(node, list):
        for item in node:
            check_refs(item)


def check():
    check_refs(SPEC)
    operation_ids = []
    for path, methods in SPEC["paths"].items():
        for operation in methods.values():
            operation_ids.append(operation["operationId"])
            defined = {p["name"] for p in operation.get("parameters", []) if p["in"] == "path"}
            assert defined == set(re.findall(r"{([^}]+)}", path)), path
    assert len(operation_ids) == len(set(operation_ids))
    fixtures = ROOT / "contracts/fixtures"
    catalog = json.loads((fixtures / "catalog.json").read_text())
    halls = json.loads((fixtures / "halls.json").read_text())["items"]
    availability = json.loads((fixtures / "availability.json").read_text())["items"]
    for entity, schema_name in (("cinemas", "Cinema"), ("movies", "Movie"), ("sessions", "Session")):
        for item in catalog[entity]:
            validate(item, SPEC["components"]["schemas"][schema_name])
        assert len({item["id"] for item in catalog[entity]}) == len(catalog[entity])
    cinema_ids = {item["id"] for item in catalog["cinemas"]}
    hall_map = {item["id"]: item for item in halls}
    session_map = {item["id"]: item for item in catalog["sessions"]}
    assert len(hall_map) == len(halls)
    for hall in halls:
        validate(hall, SPEC["components"]["schemas"]["Hall"])
        assert hall["cinema_id"] in cinema_ids
        ids = {seat["id"] for seat in hall["seats"]}
        assert len(ids) == len(hall["seats"])
        assert len({(s["row"], s["number"]) for s in hall["seats"]}) == len(ids)
        for seat in hall["seats"]:
            assert abs(seat["position"]["x"]) + seat["width"] / 2 <= hall["dimensions"]["width"] / 2
            assert abs(seat["position"]["z"]) + seat["depth"] / 2 <= hall["dimensions"]["depth"] / 2
    for session in session_map.values():
        assert session["cinema_id"] in cinema_ids
        assert hall_map[session["hall_id"]]["cinema_id"] == session["cinema_id"]
    assert {a["session_id"] for a in availability} == set(session_map)
    for item in availability:
        validate(item, SPEC["components"]["schemas"]["Availability"])
        hall = hall_map[session_map[item["session_id"]]["hall_id"]]
        assert {s["seat_id"] for s in item["seats"]} == {s["id"] for s in hall["seats"]}
        assert len({s["seat_id"] for s in item["seats"]}) == len(item["seats"])
    first = next(item for item in availability if item["session_id"] == "session_nevskaya_1_C")
    for seat_id in ("nevC-r01-s03", "nevC-r06-s12", "nevC-r10-s07"):
        assert next(s for s in first["seats"] if s["seat_id"] == seat_id)["status"] == "available"
    validate(json.loads((ROOT / "contracts/examples/create-order.json").read_text()),
             SPEC["components"]["schemas"]["CreateOrder"])
    print("Contract OK: references, path parameters, fixture schemas, relationships and control seats.")


if __name__ == "__main__":
    check()
