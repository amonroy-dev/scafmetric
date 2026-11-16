import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangePointLabels, updatePointLoads } from '../src/input-visual.js';

test('point labels show individual totals, stay in bounds and separate nearby loads', () => {
 const points = [
  { index: 0, location: 0, magnitude: 3500 },
  { index: 1, location: 0, magnitude: 2000 },
  { index: 2, location: 20, magnitude: 1000 }
 ];
 const labels = arrangePointLabels(points, n => 77 + n / 20 * 566);
 assert.equal(labels[0].label, 'P1 = 3,500 lbs');
 assert.equal(labels[1].label, 'P2 = 2,000 lbs');
 assert.notEqual(labels[0].labelY, labels[1].labelY);
 for (const label of labels) {
  assert.ok(label.labelX - label.labelWidth / 2 >= 5);
  assert.ok(label.labelX + label.labelWidth / 2 <= 715);
 }
});

test('point-load animation displays the same fraction as reactions and resets at full load', () => {
 const text = { dataset: { pointNumber: '1', pointMagnitude: '3500' }, textContent: '' };
 const svg = { querySelectorAll: () => [text] };
 updatePointLoads(svg, 0.5);
 assert.equal(text.textContent, 'P1 = 1,750 lbs');
 updatePointLoads(svg, 0);
 assert.equal(text.textContent, 'P1 = 0 lbs');
 updatePointLoads(svg);
 assert.equal(text.textContent, 'P1 = 3,500 lbs');
});
