import { test } from 'node:test';
import assert from 'node:assert/strict';

import { workspaceSupported } from '../src/scaffold/workspace/viewport.js';

test('the 3D builder is gated off phone-sized screens', () => {
  // Common phone viewports, portrait and landscape.
  assert.equal(workspaceSupported({ innerWidth: 390, innerHeight: 844 }), false, 'iPhone portrait');
  assert.equal(workspaceSupported({ innerWidth: 844, innerHeight: 390 }), false, 'iPhone landscape: too short');
  assert.equal(workspaceSupported({ innerWidth: 360, innerHeight: 800 }), false, 'small Android');
  assert.equal(workspaceSupported({ innerWidth: 768, innerHeight: 1024 }), false, 'tablet portrait: too narrow');
});

test('laptops and desktops get the builder', () => {
  assert.equal(workspaceSupported({ innerWidth: 1280, innerHeight: 800 }), true, 'laptop');
  assert.equal(workspaceSupported({ innerWidth: 1920, innerHeight: 1080 }), true, 'desktop');
  assert.equal(workspaceSupported({ innerWidth: 1024, innerHeight: 768 }), true, 'small laptop');
});

test('the gate needs both width and height, and survives a missing window', () => {
  assert.equal(workspaceSupported({ innerWidth: 1600, innerHeight: 400 }), false, 'wide but too short');
  assert.equal(workspaceSupported({ innerWidth: 700, innerHeight: 1200 }), false, 'tall but too narrow');
  assert.equal(workspaceSupported(null), false, 'no window at all (server render)');
});
