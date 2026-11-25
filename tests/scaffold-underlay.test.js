// The drawing underlay: how a sheet's stated scale and a two-point calibration
// turn into where the picture lies on the ground.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { sheetWidthFt, rasterScaleFor, calibrateLayout, MAX_UNDERLAY_EDGE_PX } from '../src/scaffold/workspace/underlay.js';

test('a sheet lies as wide as its paper at the scale written on it', () => {
  // A 36 in wide sheet (2592 pt) at 1/8 in to the foot: 1 in is 8 ft.
  assert.equal(sheetWidthFt(2592, 8), 288);
  // The same sheet at 1/4 in to the foot.
  assert.equal(sheetWidthFt(2592, 4), 144);
});

test('a page is rendered up to the texture limit and never more than four times its size', () => {
  assert.equal(rasterScaleFor(792, 612), 4, 'a letter page is small: four times, 3168 px');
  const big = rasterScaleFor(3456, 2592); // 48 x 36 in
  assert.ok(Math.abs(big * 3456 - MAX_UNDERLAY_EDGE_PX) < 1e-6, 'a large sheet is held to the limit');
});

test('two points a known distance apart bring the drawing to scale about the first', () => {
  const layout = { x: 0, y: 0, widthFt: 88, heightFt: 68 };
  const next = calibrateLayout(layout, { x: 16, y: 16 }, { x: 64, y: 16 }, 30);
  assert.deepEqual(next, { x: 6, y: 6, widthFt: 55, heightFt: 42.5 }, '48 ft drawn is 30 ft real: five eighths the size');
  // The first point has not moved: it is still 10/88 of... the same fraction of the way across.
  assert.ok(Math.abs((16 - next.x) / next.widthFt - 16 / 88) < 1e-12);
  assert.equal(calibrateLayout(layout, { x: 5, y: 5 }, { x: 5, y: 5 }, 30), null, 'one spot clicked twice is no distance');
  assert.equal(calibrateLayout(layout, { x: 0, y: 0 }, { x: 5, y: 0 }, 0), null);
});

test('pdf.js is copied beside the site by the build and not bundled into the builder', async () => {
  const build = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  assert.match(build, /dist\/pdfjs/);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.dependencies['pdfjs-dist'], /^\d/, 'pinned to an exact version: the reader and its worker must be the same release');
  const src = await readFile(new URL('../src/scaffold/workspace/underlay.js', import.meta.url), 'utf8');
  assert.equal(/from 'pdfjs-dist/.test(src), false);
});
