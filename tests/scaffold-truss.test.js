import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sideBracketFrame, sideBracketWorldMembers, sideBracketTubeLengthFt } from '../src/scaffold/workspace/parts.js';
import { buildCenterlineModel, LAYERS } from '../src/scaffold/workspace/dxf.js';
import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { CATALOG } from '../src/scaffold/workspace/catalog.js';

const SEG = 6.5625;

test('a side bracket is a closed frame: chord, post, diagonal and socket', () => {
  for (const reach of [2, 3, 3.5]) {
    const { points, members } = sideBracketFrame(reach);
    const roles = members.map(m => m.role);
    for (const r of ['chord', 'post', 'diagonal', 'socket']) assert.ok(roles.includes(r), `${reach} ft bracket has a ${r}`);
    assert.deepEqual(points.tip, [reach, 0], 'the chord is level and reaches the tip rosette');
    assert.equal(points.lowerFixing[0], 0, 'the diagonal fixes to the standard');
    assert.ok(points.lowerFixing[1] < -1, 'below the rosette the bracket hangs on');
    // The post's foot lies on the straight line of the diagonal, so it closes.
    const [lo, lu] = points.lowerFixing, [to, tu] = points.diagonalTop, [po, pu] = points.postFoot;
    const onLine = lu + ((po - lo) / (to - lo)) * (tu - lu);
    assert.ok(Math.abs(onLine - pu) < 1e-9, `${reach} ft: post foot on the diagonal`);
  }
  // The longer brackets hang their diagonal from about twice as far down.
  assert.ok(sideBracketFrame(3).points.lowerFixing[1] < 1.8 * sideBracketFrame(2).points.lowerFixing[1]);
  assert.ok(sideBracketTubeLengthFt(3.5) > sideBracketTubeLengthFt(2), 'more reach, more tube');
});

test('a side bracket points where it is told and hangs from its rosette', () => {
  const members = sideBracketWorldMembers({ x: 10, y: 4, z: 6 }, [0, -1], 3);
  const chord = members.filter(m => m.role === 'chord');
  const ends = chord.flatMap(m => [m.a, m.b]);
  assert.ok(ends.some(p => Math.abs(p[0] - 10) < 1e-9 && Math.abs(p[1] - 1) < 1e-9 && Math.abs(p[2] - 6) < 1e-9), 'tip 3 ft out along -y, level');
  assert.ok(members.every(m => Math.abs(m.a[0] - 10) < 1e-9 && Math.abs(m.b[0] - 10) < 1e-9), 'the frame stays in its own plane');
});

