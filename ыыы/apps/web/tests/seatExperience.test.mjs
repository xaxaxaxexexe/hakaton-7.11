import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { comfortColor, findSeatPairs } from '../src/lib/seatExperience.ts';
const template = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/halls.json', import.meta.url))).items[0];
const seat = (id, x, changes = {}) => ({ ...template.seats[0], id, row: 1, number: x + 10, position: { x, y: 0, z: 10 }, rotation_y: 0, width: .72, depth: .78, ...changes });
const hall = seats => ({ ...template, seats });
const available = seats => ({ session_id: 'test', updated_at: '2026-11-07', seats: seats.map(s => ({ seat_id: s.id, status: 'available', price_minor: 35000 })) });

test('finds geometric neighbours even with unordered non-sequential numbers', () => {
  const seats = [seat('b', .82, {number: 99}), seat('a', 0, {number: 3})];
  const pairs = findSeatPairs(hall(seats), available(seats));
  assert.equal(pairs.length, 1); assert.deepEqual(pairs[0].seats.map(s => s.id), ['a', 'b']); assert.equal(pairs[0].totalMinor, 70000);
});
test('never recommends a pair across an aisle', () => {
  const seats = [seat('a', 0), seat('b', 2)];
  assert.equal(findSeatPairs(hall(seats), available(seats)).length, 0);
});
test('does not skip occupied seats and removes newly held recommendations', () => {
  const seats = [seat('a', 0), seat('b', .82), seat('c', 1.64)];
  const state = available(seats);
  assert.equal(findSeatPairs(hall(seats), state).length, 2);
  state.seats[1].status = 'held'; assert.equal(findSeatPairs(hall(seats), state).length, 0);
  state.seats[1].status = 'sold'; assert.equal(findSeatPairs(hall(seats), state).length, 0);
});
test('requires both server prices and both availability records', () => {
  const seats = [seat('a', 0), seat('b', .82)];const state = available(seats);
  state.seats.pop(); assert.equal(findSeatPairs(hall(seats), state).length, 0);
  state.seats.push({seat_id:'b', status:'available', price_minor:NaN});assert.equal(findSeatPairs(hall(seats), state).length, 0);
});
test('keeps rows, categories and individual sofas separate', () => {
  for(const changes of [{row:2}, {zone:'middle'}, {type:'sofa'}, {position:{x:.82,y:1,z:10}}]) {
    const seats=[seat('a',0),seat('b',.82,changes)];assert.equal(findSeatPairs(hall(seats),available(seats)).length,0);
  }
});
test('both real hall fixtures have valid pairs without mutating geometry', () => {
  for(const h of JSON.parse(readFileSync(new URL('../../../contracts/fixtures/halls.json', import.meta.url))).items){
    const before=JSON.stringify(h); const pairs=findSeatPairs(h,available(h.seats));assert.ok(pairs.length>0);
    assert.equal(JSON.stringify(h),before);for(const pair of pairs)assert.equal(pair.seats[0].row,pair.seats[1].row);
  }
});
test('comfort colours clamp to a fixed scale', () => {
  assert.equal(comfortColor(0),'#dc8b4d');assert.equal(comfortColor(100),'#53c0a4');assert.equal(comfortColor(-10),comfortColor(0));assert.equal(comfortColor(120),comfortColor(100));
});
