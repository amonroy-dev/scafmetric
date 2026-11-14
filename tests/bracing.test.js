import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlangeBracing, resolveFlangeBracing } from '../src/bracing.js';

test('independent flange inputs add end restraints and retain different intervals', () => {
  const result = parseFlangeBracing({ top: '15, 5, 10, 5', bottom: '6, 14', spanFt: 20 });
  assert.deepEqual(result.top, { locations: [0, 5, 10, 15, 20], segments: [5, 5, 5, 5] });
  assert.deepEqual(result.bottom, { locations: [0, 6, 14, 20], segments: [6, 8, 6] });
  assert.equal(result.compressionFlange, 'top');
  assert.deepEqual(result.locations, [0, 5, 10, 15, 20]);
  assert.deepEqual(parseFlangeBracing({ top: '', bottom: ' ', spanFt: 20 }).top.locations, [0, 20]);
  assert.deepEqual(parseFlangeBracing({ top: '0, 20', spanFt: 20 }).top.locations, [0, 20]);
});

test('invalid brace text is rejected instead of silently dropping tokens or clipping positions', () => {
  for (const value of ['5,,10', ',5', '5,', '-1', '21', 'five', 'NaN', 'Infinity', '0x10', '1e500']) {
    assert.throws(() => parseFlangeBracing({ top: value, spanFt: 20 }), /top-flange|Top-flange/);
    assert.throws(() => parseFlangeBracing({ bottom: value, spanFt: 20 }), /bottom-flange|Bottom-flange/);
  }
  for (const spanFt of [0, -1, NaN, Infinity]) assert.throws(() => parseFlangeBracing({ spanFt }), /span/);
});

test('numerical definitions validate each flange and copy caller arrays', () => {
  const top = [0, 10, 20], bottom = [0, 20];
  const result = resolveFlangeBracing({ spanFt: 20, topBracesFt: top, bottomBracesFt: bottom });
  top[1] = 5;
  assert.deepEqual(result.top.locations, [0, 10, 20]);
  assert.throws(() => resolveFlangeBracing({ spanFt: 20, topBracesFt: [0, 20], bottomBracesFt: [0, 20, 20] }), /bottom/);
  assert.throws(() => resolveFlangeBracing({ spanFt: 20, topBracesFt: [0, 5], bottomBracesFt: [0, 20] }), /top/);
  const legacy = resolveFlangeBracing({ spanFt: 20, bracesFt: [0, 10, 20] });
  assert.deepEqual(legacy.top, legacy.bottom);
});
