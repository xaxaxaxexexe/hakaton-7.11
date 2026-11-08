const assert = require('node:assert/strict');
const test = require('node:test');
const hall = require('./hall-model.js');

test('standing up from every chair leaves the camera in a walkable space', () => {
  for (const q of hall.seats) {
    assert(hall.canStand(q.x, q.z - 0.87), q.id);
    assert.equal(hall.floorAt(q.z - 0.87), q.y);
    assert(!hall.canStand(q.x, q.z), q.id + ' must block walking');
  }
});
test('both side aisles are connected from front to back', () => {
  for (const x of [-6.8, 6.8]) {
    let p = { x, z: 2 };
    for (let i = 0; i < 170; i++) p = hall.move(p, 0, 0.1);
    assert(Math.abs(p.z - 19) < 0.01);
    assert.equal(p.x, x);
  }
});
test('each row can be crossed to either side without intersecting seats', () => {
  for (let row = 1; row <= 8; row++) {
    let p = { x: -6.8, z: hall.get(row + '-1').z - 0.87 };
    p = hall.move(p, 13.6, 0);
    assert(Math.abs(p.x - 6.8) < 0.001);
  }
});
test('a large frame cannot tunnel through a chair or a wall', () => {
  const seat = hall.get('3-4');
  const p = hall.move({ x: seat.x, z: seat.z - 0.87 }, 0, 8);
  assert(p.z < seat.z - 0.55);
  assert(hall.canStand(p.x, p.z));
  const wall = hall.move({ x: 0, z: 2 }, 50, -50);
  assert(hall.canStand(wall.x, wall.z));
});
test('diagonal movement is normalized and follows camera yaw', () => {
  const v = hall.direction(0, 1, 1);
  assert(Math.abs(Math.hypot(v.x, v.z) - 1) < 1e-10);
  assert(v.x > 0 && v.z < 0);
  const turn = hall.direction(-Math.PI / 2, 1, 0);
  assert(Math.abs(turn.x - 1) < 1e-10 && Math.abs(turn.z) < 1e-10);
});
