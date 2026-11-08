"""3D perspective, sold-seat head occlusion raycasting, and stereo acoustics engine.

Uses the exact same Hall geometry (meters, X right, Y up, Z from screen toward back wall)
defined in `contracts/openapi.json` and `docs/architecture.md`. Works automatically for
any Hall configuration loaded from the database.
"""
from __future__ import annotations

from collections import defaultdict
import math

from app.domain.enums import SeatStatus, SeatType, SeatZone
from app.domain.models import (
    Hall,
    RecommendedSeatBucket,
    Seat,
    SeatAcousticMetrics,
    SeatAvailability,
    SeatComparisonResponse,
    SeatInsight,
    SeatRecommendationsResponse,
    SeatViewMetrics,
    SessionInsightsResponse,
    Vector3,
    ZonePriceSummary,
)

SPEED_OF_SOUND_M_S = 343.0
TYPICAL_HEAD_RADIUS_M = 0.115
TYPICAL_HEAD_TOP_OFFSET_M = 0.12

ZONE_LABELS_RU: dict[SeatZone, str] = {
    SeatZone.FRONT: "Ряды у кромки поля",
    SeatZone.MIDDLE: "Центр трибуны",
    SeatZone.SOFA: "Ложи (верхний ряд)",
}


def _dist3(a: Vector3, b: Vector3) -> float:
    return math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)


def _clamp(val: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, val))


def _ray_segment_point_distance(
    origin: tuple[float, float, float],
    target: tuple[float, float, float],
    point: tuple[float, float, float],
) -> tuple[float, float]:
    """Returns (perpendicular_distance_m, t_along_segment) from `point` to segment origin->target."""
    dx = target[0] - origin[0]
    dy = target[1] - origin[1]
    dz = target[2] - origin[2]
    seg_len_sq = dx * dx + dy * dy + dz * dz
    if seg_len_sq <= 1e-9:
        return math.dist(origin, point), 0.0
    t = (
        (point[0] - origin[0]) * dx
        + (point[1] - origin[1]) * dy
        + (point[2] - origin[2]) * dz
    ) / seg_len_sq
    if t <= 0.0 or t >= 1.0:
        return float("inf"), t
    proj = (origin[0] + t * dx, origin[1] + t * dy, origin[2] + t * dz)
    return math.dist(proj, point), t


def _compute_head_occlusion(
    seat: Seat,
    eye: Vector3,
    hall: Hall,
    sold_seats: list[Seat],
) -> tuple[float, list[str]]:
    """Checks whether heads of buyers on `sold` seats in front rows occlude the lower screen edge.

    Matches `docs/architecture.md`: heads are placed only above `sold` seats (not `held`),
    excluding the viewer's own seat.
    """
    if not sold_seats:
        return 0.0, []

    screen_bottom_y = hall.screen.center.y - hall.screen.height * 0.42
    sample_xs = [
        hall.screen.center.x + frac * (hall.screen.width * 0.42)
        for frac in (-1.0, -0.5, 0.0, 0.5, 1.0)
    ]
    origin = (eye.x, eye.y, eye.z)

    occluding_ids: set[str] = set()
    blocked_rays = 0
    candidates = [
        other
        for other in sold_seats
        if other.id != seat.id and other.position.z < seat.position.z - 0.25
    ]
    if not candidates:
        return 0.0, []

    for sx in sample_xs:
        target = (sx, screen_bottom_y, hall.screen.center.z)
        ray_blocked = False
        for other in candidates:
            head_center = (
                other.position.x,
                other.position.y + hall.camera.eye_height + TYPICAL_HEAD_TOP_OFFSET_M,
                other.position.z,
            )
            dist_to_ray, t = _ray_segment_point_distance(origin, target, head_center)
            # Nearby row in front has larger apparent angular size than a distant front row
            row_gap = max(0.7, seat.position.z - other.position.z)
            effective_radius = TYPICAL_HEAD_RADIUS_M * (1.0 + 0.55 / row_gap)
            if 0.01 < t < 0.95 and dist_to_ray <= effective_radius:
                occluding_ids.add(other.id)
                ray_blocked = True
        if ray_blocked:
            blocked_rays += 1

    ratio = round(blocked_rays / len(sample_xs), 2)
    return ratio, sorted(occluding_ids)


def _compute_acoustics(
    eye: Vector3,
    hall: Hall,
    reference_distance_m: float,
) -> SeatAcousticMetrics:
    left_spk = next((s for s in hall.speakers if "left" in s.id.lower() or s.position.x < 0), None)
    right_spk = next((s for s in hall.speakers if "right" in s.id.lower() or s.position.x > 0), None)
    if left_spk is None and hall.speakers:
        left_spk = hall.speakers[0]
    if right_spk is None and len(hall.speakers) > 1:
        right_spk = hall.speakers[-1]

    if left_spk is None or right_spk is None:
        return SeatAcousticMetrics(
            left_distance_m=round(reference_distance_m, 2),
            right_distance_m=round(reference_distance_m, 2),
            spl_offset_db=0.0,
            stereo_pan=0.0,
            itd_ms=0.0,
            acoustic_balance_score=85,
        )

    d_left = max(0.5, _dist3(eye, left_spk.position))
    d_right = max(0.5, _dist3(eye, right_spk.position))

    inv_left = 1.0 / (d_left * d_left)
    inv_right = 1.0 / (d_right * d_right)
    combined_energy = inv_left + inv_right
    ref_energy = 2.0 / (reference_distance_m * reference_distance_m)

    spl_offset_db = 10.0 * math.log10(max(1e-9, combined_energy / ref_energy))
    # Negative = louder on left speaker, Positive = louder on right speaker
    stereo_pan = (inv_right - inv_left) / combined_energy
    # Positive ITD means right speaker arrives first; negative means left arrives first
    itd_ms = ((d_left - d_right) / SPEED_OF_SOUND_M_S) * 1000.0

    pan_penalty = abs(stereo_pan) * 55.0
    level_penalty = min(25.0, abs(spl_offset_db) * 2.4)
    balance_score = int(round(_clamp(100.0 - pan_penalty - level_penalty, 15.0, 100.0)))

    return SeatAcousticMetrics(
        left_distance_m=round(d_left, 2),
        right_distance_m=round(d_right, 2),
        spl_offset_db=round(spl_offset_db, 2),
        stereo_pan=round(_clamp(stereo_pan, -1.0, 1.0), 3),
        itd_ms=round(itd_ms, 2),
        acoustic_balance_score=balance_score,
    )


def compute_session_insights(
    hall: Hall,
    session_id: str,
    updated_at: str,
    availability_items: list[SeatAvailability],
) -> SessionInsightsResponse:
    avail_by_id = {item.seat_id: item for item in availability_items}
    seat_by_id = {seat.id: seat for seat in hall.seats}

    sold_seats = [
        seat_by_id[seat_id]
        for seat_id, item in avail_by_id.items()
        if item.status == SeatStatus.SOLD and seat_id in seat_by_id
    ]

    # Reference sweet spot distance: ~0.62 of auditorium depth along centerline
    ref_point = Vector3(
        x=hall.screen.center.x,
        y=hall.camera.eye_height + 0.8,
        z=hall.dimensions.depth * 0.58,
    )
    ref_speaker_dist = (
        max(1.0, _dist3(ref_point, hall.speakers[0].position))
        if hall.speakers
        else max(1.0, hall.dimensions.depth * 0.58)
    )

    max_row = max((s.row for s in hall.seats), default=1)
    insights: list[SeatInsight] = []
    best_ref_seat_id: str | None = None
    best_ref_score = -1.0

    zone_rows: dict[SeatZone, set[int]] = defaultdict(set)
    zone_prices: dict[SeatZone, int] = {}
    zone_avail: dict[SeatZone, int] = defaultdict(int)
    zone_total: dict[SeatZone, int] = defaultdict(int)

    sold_count = 0
    held_count = 0
    available_count = 0

    for seat in hall.seats:
        avail = avail_by_id.get(seat.id)
        status = avail.status if avail else SeatStatus.AVAILABLE
        price_minor = avail.price_minor if avail else 0

        if status == SeatStatus.SOLD:
            sold_count += 1
        elif status == SeatStatus.HELD:
            held_count += 1
        else:
            available_count += 1
            zone_avail[seat.zone] += 1

        zone_rows[seat.zone].add(seat.row)
        zone_total[seat.zone] += 1
        zone_prices.setdefault(seat.zone, price_minor)

        eye = Vector3(
            x=round(seat.position.x, 3),
            y=round(seat.position.y + hall.camera.eye_height, 3),
            z=round(seat.position.z, 3),
        )

        dx_center = hall.screen.center.x - eye.x
        dy_center = hall.screen.center.y - eye.y
        dz_plane = max(0.25, eye.z - hall.screen.center.z)
        dist_center = math.sqrt(dx_center * dx_center + dy_center * dy_center + dz_plane * dz_plane)

        # Horizontal subtended angle between left and right edges of screen
        left_x = hall.screen.center.x - hall.screen.width / 2.0
        right_x = hall.screen.center.x + hall.screen.width / 2.0
        angle_left = math.atan2(left_x - eye.x, dz_plane)
        angle_right = math.atan2(right_x - eye.x, dz_plane)
        hfov_occupancy_deg = math.degrees(abs(angle_right - angle_left))

        lateral_off_axis_deg = math.degrees(math.atan2(abs(dx_center), dz_plane))
        horiz_ground_dist = math.hypot(dx_center, dz_plane)
        vertical_center_deg = math.degrees(math.atan2(dy_center, horiz_ground_dist))
        top_y = hall.screen.center.y + hall.screen.height / 2.0
        vertical_top_deg = math.degrees(math.atan2(top_y - eye.y, horiz_ground_dist))

        distortion = _clamp(
            (lateral_off_axis_deg / 55.0) * 0.65 + (max(0.0, vertical_top_deg - 24.0) / 40.0) * 0.35,
            0.0,
            1.0,
        )

        occlusion_ratio, occluding_ids = _compute_head_occlusion(seat, eye, hall, sold_seats)
        acoustics = _compute_acoustics(eye, hall, ref_speaker_dist)

        # Comfort score (0..100): SMPTE/THX optimal horizontal viewing angle ~36..45 deg,
        # minimal lateral off-axis (<15 deg), comfortable vertical tilt (<30 deg top), low head occlusion.
        ideal_hfov_penalty = abs(hfov_occupancy_deg - 40.0) * 0.75
        lateral_penalty = max(0.0, lateral_off_axis_deg - 8.0) * 1.05
        neck_penalty = max(0.0, vertical_top_deg - 28.0) * 1.35
        occlusion_penalty = occlusion_ratio * 18.0
        acoustic_bonus = (acoustics.acoustic_balance_score - 70) * 0.18
        sofa_bonus = 6.0 if seat.type == SeatType.SOFA else 0.0

        raw_comfort = (
            96.0
            - ideal_hfov_penalty
            - lateral_penalty
            - neck_penalty
            - occlusion_penalty
            + acoustic_bonus
            + sofa_bonus
        )
        comfort_score = int(round(_clamp(raw_comfort, 18.0, 99.0)))

        badges: list[str] = []
        mid_lo = max(2, int(round(max_row * 0.45)))
        mid_hi = max(mid_lo, int(round(max_row * 0.78)))
        if mid_lo <= seat.row <= mid_hi and abs(acoustics.stereo_pan) <= 0.09 and lateral_off_axis_deg <= 10.0:
            badges.append("reference_listening_position")
        if abs(acoustics.stereo_pan) <= 0.22 and acoustics.acoustic_balance_score >= 78:
            badges.append("surround_balanced")
        if seat.type == SeatType.SOFA:
            badges.append("vip_sofa")
        if occlusion_ratio == 0.0 and seat.row >= 4:
            badges.append("unobstructed_view")
        if vertical_top_deg >= 38.0 or lateral_off_axis_deg >= 35.0:
            badges.append("close_angle_warning")

        ref_candidate_rank = comfort_score - abs(acoustics.stereo_pan) * 30.0 - lateral_off_axis_deg * 0.8
        if mid_lo <= seat.row <= mid_hi and ref_candidate_rank > best_ref_score:
            best_ref_score = ref_candidate_rank
            best_ref_seat_id = seat.id

        summary_parts: list[str] = []
        if vertical_top_deg >= 40.0:
            summary_parts.append("Совсем близко к полю, дальняя половина сливается в полосу")
        elif lateral_off_axis_deg >= 28.0:
            summary_parts.append("Заметный угол к центру поля")
        elif lateral_off_axis_deg <= 11.0 and mid_lo <= seat.row <= mid_hi:
            summary_parts.append("Эталонная геометрия обзора почти без искажений")
        else:
            summary_parts.append("Сбалансированная дистанция до поля")

        if occlusion_ratio > 0.0:
            summary_parts.append("болельщики впереди частично перекрывают ближнюю бровку")
        elif seat.row >= max_row:
            summary_parts.append("головы впереди не мешают обзору")

        if abs(acoustics.stereo_pan) <= 0.12:
            summary_parts.append("ровный стереобаланс")
        elif acoustics.stereo_pan < 0:
            summary_parts.append("левая колонка звучит ближе")
        else:
            summary_parts.append("правая колонка звучит ближе")

        insights.append(
            SeatInsight(
                seat_id=seat.id,
                row=seat.row,
                number=seat.number,
                type=seat.type,
                zone=seat.zone,
                status=status,
                price_minor=price_minor,
                currency="RUB",
                comfort_score=comfort_score,
                badges=badges,
                summary_ru="; ".join(summary_parts) + ".",
                view=SeatViewMetrics(
                    eye_position=eye,
                    distance_to_screen_m=round(dist_center, 2),
                    horizontal_fov_occupancy_deg=round(hfov_occupancy_deg, 1),
                    lateral_off_axis_deg=round(lateral_off_axis_deg, 1),
                    vertical_tilt_center_deg=round(vertical_center_deg, 1),
                    vertical_tilt_top_deg=round(vertical_top_deg, 1),
                    distortion_index=round(distortion, 3),
                    head_occlusion_ratio=occlusion_ratio,
                    occluding_sold_seat_ids=occluding_ids,
                ),
                acoustics=acoustics,
            )
        )

    zone_order = [SeatZone.FRONT, SeatZone.MIDDLE, SeatZone.SOFA]
    zones_summary = [
        ZonePriceSummary(
            zone=z,
            label_ru=ZONE_LABELS_RU.get(z, z.value),
            rows=sorted(zone_rows[z]),
            price_minor=zone_prices.get(z, 0),
            available_count=zone_avail[z],
            total_count=zone_total[z],
        )
        for z in zone_order
        if zone_total[z] > 0
    ]

    return SessionInsightsResponse(
        session_id=session_id,
        hall_id=hall.id,
        updated_at=updated_at,
        sold_count=sold_count,
        held_count=held_count,
        available_count=available_count,
        zones=zones_summary,
        reference_seat_id=best_ref_seat_id,
        seats=insights,
    )


def compare_two_seats(
    session_insights: SessionInsightsResponse,
    seat_a_id: str,
    seat_b_id: str,
) -> SeatComparisonResponse | None:
    by_id = {item.seat_id: item for item in session_insights.seats}
    seat_a = by_id.get(seat_a_id)
    seat_b = by_id.get(seat_b_id)
    if seat_a is None or seat_b is None:
        return None

    price_delta = seat_a.price_minor - seat_b.price_minor
    comfort_delta = seat_a.comfort_score - seat_b.comfort_score

    # Prefer available seats when recommending between two options
    if seat_a.status == SeatStatus.AVAILABLE and seat_b.status != SeatStatus.AVAILABLE:
        recommended = seat_a
    elif seat_b.status == SeatStatus.AVAILABLE and seat_a.status != SeatStatus.AVAILABLE:
        recommended = seat_b
    else:
        recommended = seat_a if seat_a.comfort_score >= seat_b.comfort_score else seat_b

    other = seat_b if recommended.seat_id == seat_a.seat_id else seat_a
    verdict = (
        f"Ряд {recommended.row}, место {recommended.number} даёт индекс комфорта "
        f"{recommended.comfort_score}/100 (угол отклонения {recommended.view.lateral_off_axis_deg}°, "
        f"дистанция {recommended.view.distance_to_screen_m} м) против "
        f"{other.comfort_score}/100 у ряда {other.row}, места {other.number}."
    )
    return SeatComparisonResponse(
        session_id=session_insights.session_id,
        seat_a=seat_a,
        seat_b=seat_b,
        price_delta_minor=price_delta,
        comfort_delta=comfort_delta,
        recommended_seat_id=recommended.seat_id,
        verdict_ru=verdict,
    )


def build_seat_recommendations(
    session_insights: SessionInsightsResponse,
) -> SeatRecommendationsResponse:
    available = [s for s in session_insights.seats if s.status == SeatStatus.AVAILABLE]
    buckets: list[RecommendedSeatBucket] = []
    used_ids: set[str] = set()

    if not available:
        return SeatRecommendationsResponse(session_id=session_insights.session_id, items=[])

    # 1. Reference center (best overall comfort & acoustic balance)
    best_center = max(
        available,
        key=lambda s: (s.comfort_score, s.acoustics.acoustic_balance_score, -s.price_minor),
    )
    buckets.append(
        RecommendedSeatBucket(
            category="reference_center",
            title_ru="Эталон обзора и звука",
            reason_ru="Минимальные перспективные искажения и симметричная стереосцена.",
            seat=best_center,
        )
    )
    used_ids.add(best_center.seat_id)

    # 2. Best value (comfort per ruble, preferring lower/middle price tiers)
    value_candidates = [s for s in available if s.seat_id not in used_ids] or available
    best_value = max(
        value_candidates,
        key=lambda s: (s.comfort_score / max(1.0, s.price_minor / 10000.0), s.comfort_score),
    )
    if best_value.seat_id not in used_ids:
        buckets.append(
            RecommendedSeatBucket(
                category="best_value",
                title_ru="Лучшее соотношение цены и вида",
                reason_ru="Оптимальный обзор без переплаты за премиальную зону.",
                seat=best_value,
            )
        )
        used_ids.add(best_value.seat_id)

    # 3. Unobstructed view (zero head occlusion, raised row)
    clear_candidates = [
        s for s in available if s.seat_id not in used_ids and s.view.head_occlusion_ratio == 0.0
    ]
    if clear_candidates:
        best_clear = max(clear_candidates, key=lambda s: (s.comfort_score, -s.view.lateral_off_axis_deg))
        buckets.append(
            RecommendedSeatBucket(
                category="unobstructed_view",
                title_ru="Чистый обзор без голов впереди",
                reason_ru="Ближняя бровка полностью открыта с учётом уже купленных мест.",
                seat=best_clear,
            )
        )
        used_ids.add(best_clear.seat_id)

    # 4. VIP Sofa
    sofas = [s for s in available if s.type == SeatType.SOFA and s.seat_id not in used_ids]
    if sofas:
        best_sofa = max(sofas, key=lambda s: (s.comfort_score, -abs(s.acoustics.stereo_pan)))
        buckets.append(
            RecommendedSeatBucket(
                category="vip_sofa",
                title_ru="Лучшая свободная ложа",
                reason_ru="Широкая посадка на поднятой платформе заднего ряда.",
                seat=best_sofa,
            )
        )

    return SeatRecommendationsResponse(session_id=session_insights.session_id, items=buckets)
