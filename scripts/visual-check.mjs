// Headless WebGL verification for the scaffold builder.
//
// Unit tests prove the math; they cannot prove anything reaches the screen.
// This script runs the real built site in headless Chrome with a software GL
// backend (SwiftShader), drives the builder through real pointer and keyboard
// events, screenshots every step, and fails if a step did not change the model
// or if the canvas came back blank.
//
//   npm run visual              build, then run the whole walkthrough
//   npm run visual -- --keep    leave Chrome running (for a manual look)
//
// Screenshots and report.json land in .visual/ (git-ignored).

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Cdp, browserTargets } from './lib/cdp.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'dist');
const OUT = process.env.VISUAL_OUT || join(ROOT, '.visual');
const KEEP = process.argv.includes('--keep');
const WIDTH = 1600;
const HEIGHT = 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json; charset=utf-8',
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

// Console noise that is expected when the site runs without Firebase env vars.
const IGNORED_ERRORS = /firebase|auth-config|\/api\/|account\.js|installations|Failed to load resource/i;

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(`No Chrome or Edge found. Set CHROME_PATH.\nLooked in:\n  ${CHROME_CANDIDATES.join('\n  ')}`);
}

// The calculator page and its bundles are kept out of dist/ so the deployed
// site can only serve them through the paid-access gate. Locally there is no
// gate, so serve them from where the build leaves them.
const PRIVATE_ASSETS = {
  '/calculator.html': join(ROOT, 'calculator.html'),
  '/app.js': join(ROOT, 'workspace-private', 'app.js'),
  '/scaffold-app.js': join(ROOT, 'workspace-private', 'scaffold-app.js'),
};

async function serveDist() {
  const rootWithSep = DIST.endsWith(sep) ? DIST : DIST + sep;
  const server = createServer(async (req, res) => {
    const clean = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    const rel = normalize(clean).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    let full = PRIVATE_ASSETS[clean] || join(DIST, rel);
    if (PRIVATE_ASSETS[clean]) {
      try { const body = await readFile(full); res.writeHead(200, { 'content-type': MIME[extname(full)] }); res.end(body); }
      catch { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); }
      return;
    }
    if (full !== DIST && !full.startsWith(rootWithSep)) { res.writeHead(403).end(); return; }
    try {
      const info = await stat(full);
      if (info.isDirectory()) full = join(full, 'index.html');
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

function launchChrome(url) {
  const bin = findChrome();
  const profile = join(tmpdir(), `scafmetric-visual-${process.pid}`);
  const port = 9222 + (process.pid % 500);
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    // Software GL: no GPU in CI or on a headless box, but WebGL must still work.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--force-device-scale-factor=1',
    url,
  ];
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', c => stderr.push(c.toString()));
  return { child, port, bin, profile, stderr };
}

function killChrome(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

// What each step must have achieved. Returns a list of failures (empty = pass).
const CHECKS = {
  open: r => [
    !r.gl?.ok && 'no WebGL context on the canvas',
    r.counts.columns !== 0 && `a fresh builder should start empty, got ${r.counts.columns} standards`,
    r.counts.ledgers !== 0 && `a fresh builder should start empty, got ${r.counts.ledgers} ledgers`,
    r.initial.projection !== 'orthographic' && `a fresh builder should open in the top view, got ${r.initial.projection}`,
    Math.abs(r.initial.camDir[2]) < 0.999 && `the opening view must look straight down, camera is at ${JSON.stringify(r.initial.camDir)}`,
    r.button.name !== 'Scaffold builder' && `the button on the beam form should be named Scaffold builder, it says ${r.button.name}`,
    !/estimating/i.test(r.notice.title) && `the notice should say the builder is for estimating, its title is: ${r.notice.title}`,
    !(r.notice.builderHeldBack && r.notice.agreeLockedAtFirst && r.notice.agreeLockedWithOneTick && r.notice.agreeOpenWithBoth && r.notice.boxes === 2)
      && `the builder must stay shut until both statements are ticked and agreed: ${JSON.stringify(r.notice)}`,
    !(r.notice.goneAfterAgreeing && !r.notice.askedAgain) && `the notice should be asked once, then never in the way again: ${JSON.stringify(r.notice)}`,
    r.initial.tool !== 'block' && `the Block tool should be in hand on open, got ${r.initial.tool}`,
    r.initial.toolOrder.join() !== 'select,block,standard' && `the toolbar should run Select, Block, Standard; it runs ${r.initial.toolOrder}`,
    !r.initial.blockCard && 'the block card should be up on open, the Block tool being in hand',
    !r.initial.home.icon && 'the home button should be a house icon',
    !(r.initial.home.flat && r.initial.home.label === '3D view' && r.initial.home.pulsing)
      && `in the top view the home button should name the way back and pulse: ${JSON.stringify(r.initial.home)}`,
    r.initial.undoDisabled !== 'true' && 'Undo should show "Nothing to undo" on a fresh builder',
    r.initial.activeButton !== 'block' && `the toolbar should highlight Block on open, got ${r.initial.activeButton}`,
    r.initial.coverage > 0.002 && `an empty model should draw nothing teal (no beam line), coverage ${r.initial.coverage}`,
  ],
  escToSelect: r => [
    r.fromBrace !== 'select' && `Esc from the brace tool should switch to Select, got ${r.fromBrace}`,
    r.fromStandard !== 'select' && `Esc from the standard tool should switch to Select, got ${r.fromStandard}`,
    r.activeButton !== 'select' && `the toolbar should highlight Select after Esc, got ${r.activeButton}`,
    !r.open && 'Esc must not close the builder',
    (r.homeIn3d.flat || r.homeIn3d.label || r.homeIn3d.pulsing) && `in the 3D view the home button should be a plain house: ${JSON.stringify(r.homeIn3d)}`,
  ],
  marqueeSelect: r => [
    r.selected !== 4 && `a marquee over the four placed stacks should select 4 standards, selected ${r.selected}`,
  ],
  autoHeightStandards: r => [
    r.plan.length < 2 && `a 19.7 ft target should plan a multi-segment stack, got ${JSON.stringify(r.plan)}`,
    r.added !== r.plan.length * 4 && `four clicks should add ${r.plan.length * 4} segments, added ${r.added}`,
  ],
  shiftPreviewInPlace: r => [
    !(r.held > r.single) && `pressing Shift over a node should preview the whole level at once (ghosts ${r.single} -> ${r.held})`,
    !r.batchPending && 'pressing Shift should arm the batch (Enter or click to confirm)',
    !(r.drew > 0) && 'pressing Shift changed the preview but drew no frame',
    !/SHIFT/.test(r.heldHint || '') && `the hint should describe the Shift fill, said: ${r.heldHint}`,
    r.released !== r.single && `releasing Shift should go back to the single preview (${r.single} ghosts, got ${r.released})`,
    r.releasedPending && 'releasing Shift should disarm the batch',
    (r.inField.ghosts !== 0 || r.inField.shiftHeld || r.inField.batchPending) && `Shift typed in a field with the pointer off the canvas must not start a fill: ${JSON.stringify(r.inField)}`,
  ],
  ledgersEveryLevel: r => [r.added < 4 && `SHIFT+click added only ${r.added} ledgers across 3 levels`],
  bracePreview: r => [
    !r.target && `hovering a bay face found no brace target (${r.miss})`,
    r.ghosts < 1 && 'no brace ghost was drawn on hover',
    !(r.shiftFromField.focus && r.shiftFromField.count > 1) && `Shift with a card dropdown focused should preview the perimeter at once: ${JSON.stringify(r.shiftFromField)}`,
    r.target && r.target.levelB - r.target.levelA !== -4 && r.target.levelB - r.target.levelA !== 4
      && `a diagonal must climb 4 rosette levels, got ${r.target.levelB - r.target.levelA}`,
  ],
  braceOne: r => [
    r.added !== 1 && `clicking a face should place exactly 1 brace, placed ${r.added}`,
    !(r.lengthFt > 1) && `brace length looks wrong: ${r.lengthFt}`,
  ],
  braceShiftFill: r => [
    r.added < 2 && `SHIFT+click braced only ${r.added} further faces`,
    r.undoSteps !== 1 && `a SHIFT fill must be one undo step, it was ${r.undoSteps}`,
    r.afterUndo !== r.before && `one Ctrl+Z should take back the whole run: ${r.before} braces before, ${r.afterUndo} after undo`,
    r.afterRedo !== r.added && `Ctrl+Y should restore all ${r.added} braces, restored ${r.afterRedo}`,
  ],
  bracketsAndCollar: r => [
    r.collarZ === null && 'the base collar has no rosette node (lift 0)',
    r.collarLedgers !== 1 && `clicking the collar rosette with the Ledger tool should add 1 ledger at collar height, added ${r.collarLedgers}`,
    r.bracketsAdded !== 2 && `two clicks with the Bracket tool should hang 2 brackets, hung ${r.bracketsAdded}`,
    r.members !== 16 && `each bracket should draw as its 7-member frame plus the elbow at the socket (16 for two), drew ${r.members}`,
    (r.tipNodes !== 2 || r.nodesAdded !== 2) && `each bracket should add a tip rosette node (tips ${r.tipNodes}, nodes +${r.nodesAdded})`,
    !(r.tipLedger && r.tipLedger.a && r.tipLedger.b) && `a ledger from a bracket tip should run to the next tip, got ${JSON.stringify(r.tipLedger)}`,
  ],
  renderOnDemand: r => [
    r.idleFrames !== 0 && `the canvas drew ${r.idleFrames} frames in 20 with nothing changing`,
    r.idleAgain !== 0 && `the canvas kept drawing after the pan ended (${r.idleAgain} frames in 20)`,
    !(r.ghosts > 0 && r.hoverFrames > 0) && `a hover that shows a ghost must draw (ghosts ${r.ghosts}, frames ${r.hoverFrames})`,
    !(r.panFrames > 0) && 'panning the camera drew no frames',
    !(r.members > r.contentObjects * 5) && `the model should be instanced: ${r.members} members in ${r.contentObjects} draw objects`,
    !(r.drawCalls < 120) && `a frame should take few draw calls, took ${r.drawCalls}`,
  ],
  braceRotate: r => [r.after === r.before && `R did not flip the brace direction (${r.before})`],
  deckOne: r => [
    r.ghosts < 1 && 'no deck ghost was drawn on hover',
    r.added !== 1 && `clicking a ledger should deck exactly 1 bay, got ${r.added}`,
    r.boards < 2 && `a decked bay should lay multiple boards, got ${r.boards}`,
  ],
  deckShiftFill: r => [r.added < 1 && 'SHIFT+click decked no bays'],
  liveLoadPatch: r => [
    r.defaults.value !== '25' && `the load field should open on 25 psf, showed ${r.defaults.value}`,
    r.defaults.placeholder !== '25' && `an empty load field should show 25 greyed out, showed ${r.defaults.placeholder}`,
    r.defaults.dir !== 'along' && `loads should start along the planks, the card said ${r.defaults.dir}`,
    !(r.ghosts > 0) && 'pointing at a planked bay with the Live load tool drew no preview',
    !/along the planks/.test(r.hoverHint || '') && `the hint should say which way the load runs, said: ${r.hoverHint}`,
    r.added !== 1 && `clicking a planked bay should place 1 load, got ${r.added}`,
    !(r.load && r.load.psf === 75 && r.load.across === false) && `the load should sit on the bay clicked, 75 psf along the planks: ${JSON.stringify(r.load)}`,
    r.liveBefore !== 0 && `planks should carry no live load until one is placed on them, carried ${r.liveBefore} lb`,
    !(r.placedLiveLb > 0) && `the load carried no live load (${r.placedLiveLb} lb)`,
    !(r.cyanDelta > 0.002) && `the load patch never reached the screen (cyan ${r.cyanBefore} -> ${r.cyanAfter})`,
    !(r.turned.across === true && r.turned.dir === 'across') && `R should turn the load across the planks and the card should follow: ${JSON.stringify(r.turned)}`,
    !(r.turned.ghosts > 0) && 'R turned the load but drew no preview: the ghost waited for the mouse',
    !(r.turned.loadAcross === true && r.turned.loads === 1) && `a click after R should turn the load already on the bay, not add another: ${JSON.stringify(r.turned)}`,
    !(r.platform.decks >= 1 && r.platform.loaded === r.platform.decks) && `SHIFT+click should load every bay of the platform: ${JSON.stringify(r.platform)}`,
  ],
  blockCard: r => [
    !r.shown && 'choosing the Block tool should bring up the block card',
    r.defaults !== '7,3,10,1' && `the card should open on ScaffoldPro's defaults 7 x 3 x 10 ft, 1 level; showed ${r.defaults}`,
    !(r.settings.widthFt === 8 && r.settings.depthFt === 6 && r.settings.heightFt === 13 && r.settings.braceFrontBack === 'slash') && `typing in the card did not reach the block: ${JSON.stringify(r.settings)}`,
    r.summary && `the card should stay quiet when the block fits, said: ${r.summary}`,
    !(r.ghosts > 0) && 'hovering with the Block tool drew no ghost block',
    r.turned.steps !== (r.before + 1) % 4 && `R should turn the block a quarter turn (${r.before} -> ${r.turned.steps})`,
    !(r.turned.drew > 0) && 'R turned the block but drew no frame: the ghost waited for the mouse',
    !/turned 90/.test(r.turned.hint || '') && `the hint should say the block is turned, said: ${r.turned.hint}`,
  ],
  blockPlace: r => [
    r.addedColumns !== 4 && `one click should place a 1 x 1 bay block of 4 standards, placed ${r.addedColumns}`,
    r.addedLedgers < 4 && `the block should come with ledgers, got ${r.addedLedgers}`,
    r.addedBraces < 1 && 'front/back braces were asked for but none were placed',
    r.addedDecks < 1 && 'the block should come with its deck',
    r.undoSteps !== 1 && `a block should be one undo step, it was ${r.undoSteps}`,
    r.xs.join() !== '-15,-7' && `the 8 ft block should stand at x = -15 and -7, stood at ${r.xs}`,
  ],
  blockSnap: r => [
    !/Snapped/.test(r.snappedHint || '') && `a block hovered near another should snap onto it, hint said: ${r.snappedHint}`,
    r.addedColumns !== 2 && `the snapped block shares a face, so it should add 2 standards, added ${r.addedColumns}`,
    !r.sharedUnchanged && 'the shared standards were stacked on instead of shared',
    r.newXs.join() !== '-23' && `the new block should stand at x = -23, got ${r.newXs}`,
  ],
  bracketTurnR: r => [
    !r.before && 'no bracket direction on a free rosette',
    !(r.after && r.after.join() !== r.before.join()) && `R should turn the bracket to another direction (${r.before} -> ${r.after})`,
    !(r.drew > 0 && r.ghostsAfter > 0) && 'R turned the bracket but the preview did not redraw',
    !/pointing/.test(r.turnedHint || '') && `the hint should say where the bracket points, said: ${r.turnedHint}`,
    !(r.run.count >= 2 && /along this run/.test(r.run.hint || '')) && `Shift should preview a bracket on every standard along the run: ${JSON.stringify(r.run)}`,
    r.added !== 1 && `the click should hang 1 bracket, hung ${r.added}`,
    r.placedDir && r.after && r.placedDir.join() !== r.after.join() && `the bracket was hung ${r.placedDir}, not the way R turned it (${r.after})`,
  ],
  plankTurnR: r => [
    r.before === null && 'no deck preview on the open collar-level bay',
    !(r.after !== null && Math.abs(Math.abs(r.after - r.before) - Math.PI / 2) < 1e-3) && `R should turn the boards a quarter turn (${r.before} -> ${r.after})`,
    !/Boards now run/.test(r.turnedHint || '') && `the hint should say which way the boards run, said: ${r.turnedHint}`,
    r.added !== 1 && `the click should deck the bay, added ${r.added}`,
    r.placedRotation !== r.after && `the deck was laid at ${r.placedRotation}, not the way R turned it (${r.after})`,
  ],
  backGuard: r => [
    !r.guarded && 'opening the builder should arm the Back guard',
    !(r.stillOpen && r.sameUrl) && `Back (a sideways wheel press) left the builder: open ${r.stillOpen}, same page ${r.sameUrl}`,
    !r.reArmed && 'after a Back the guard should re-arm for the next one',
    !r.releasedOnClose && 'closing the builder should take the guard back out',
  ],
  braceShortStackMessage: r => [
    r.miss !== 'too-short' && `a short pair (no base collar) should report 'too-short', reported '${r.miss}'`,
    r.withCollar !== null && `with its base collar the same pair carries a diagonal from the collar rosette, but reported '${r.withCollar}'`,
    !/rosette levels/.test(r.hint || '') && `the hint should explain the 4-level climb, said: ${r.hint}`,
  ],
  marqueeFrontView: r => [
    !(r.during && r.during.shown && r.during.width > 100) && 'dragging in the Front view drew no selection box',
    r.during && !(r.during.inBuilder && r.during.onTop && r.during.visible) && `the selection box is drawn where it cannot be seen: ${JSON.stringify(r.during)}`,
    !(r.esc.before > 0 && r.esc.after === 0 && r.esc.toolsAfter === 0) && `Esc should unselect everything: ${JSON.stringify(r.esc)}`,
    r.esc.props && `after Esc the selection card should be empty, said: ${r.esc.props}`,
    r.during && r.during.mode !== 'crossing' && `a right-to-left drag should be a crossing box, was ${r.during.mode}`,
    !r.hidden && 'the selection box should go away when the drag ends',
    r.kinds.standard !== r.total.standards && `a crossing box over the whole Front view should take every standard (${r.kinds.standard} of ${r.total.standards})`,
    r.kinds.ledger !== r.total.ledgers && `and every ledger (${r.kinds.ledger} of ${r.total.ledgers})`,
    r.kinds.brace !== r.total.braces && `and every brace (${r.kinds.brace} of ${r.total.braces})`,
    !(r.kinds.plank > 0) && 'and the decks',
    r.windowMode !== 'window' && `a left-to-right drag should be a window box, was ${r.windowMode}`,
    !(r.windowKinds.standard >= 1) && `a window box round one standard should select it: ${JSON.stringify(r.windowKinds)}`,
    !(r.windowKinds.standard < r.total.standards) && `a window box round one standard must not take them all: ${JSON.stringify(r.windowKinds)}`,
    r.windowKinds.plank && `a window box takes only what is wholly inside it, not the deck: ${JSON.stringify(r.windowKinds)}`,
  ],
  panTopView: r => [
    r.error > 2 && `middle-drag in Top: the grabbed point should stay under the cursor, it is ${r.error}px off`,
    (Math.abs(r.moved[0]) < 0.5 || Math.abs(r.moved[1]) < 0.5) && `middle-drag in Top must pan on both axes, moved ${JSON.stringify(r.moved)}`,
    Math.abs(r.camDir[2]) < 0.999 && `panning must not tilt the top view, camera is at ${JSON.stringify(r.camDir)}`,
  ],
  wheelZoomTop: r => [
    r.drift > 0.05 && `wheel in Top: the point under the cursor drifted ${r.drift} ft`,
    !(r.zoomAfter > r.zoomBefore * 1.3) && `wheel up should zoom in, zoom ${r.zoomBefore} -> ${r.zoomAfter}`,
  ],
  wheelZoomPerspective: r => [
    r.drift > 0.05 && `wheel in 3D: the point under the cursor drifted ${r.drift} ft`,
    !(r.distAfter < r.distBefore) && `wheel up should move in, distance ${r.distBefore} -> ${r.distAfter}`,
  ],
  doubleMiddleFits: r => [
    r.offBefore.inside && 'the setup pan should have pushed the model off screen',
    !r.inside && 'double middle-click should bring the whole model into view',
    r.fill < 0.6 && `Zoom Extents should fill the view, model spans ${r.fill}`,
  ],
  orbitShiftMiddle: r => [
    r.projection !== 'perspective' && `orbit runs in perspective, got ${r.projection}`,
    r.turned < 0.2 && `SHIFT+middle-drag should orbit, turned only ${r.turned} rad`,
    r.pivotShiftPx > 3 && `the orbit pivot should hold its place on screen, moved ${r.pivotShiftPx}px`,
    !r.markerShown && 'the pivot marker should show during an orbit',
    !r.markerHiddenAfter && 'the pivot marker should hide after the orbit',
  ],
  orbitLockedInTop: r => [
    Math.abs(r.camDir[2]) < 0.999 && `SHIFT+middle-drag must not turn out of Top, camera is at ${JSON.stringify(r.camDir)}`,
  ],
  viewTransition: r => [
    !r.started && 'an animated view change should start a transition',
    r.midDir && (Math.hypot(...r.midDir.map((c, i) => c - r.startDir[i])) < 0.05 || Math.hypot(r.midDir[0], r.midDir[1] + 1, r.midDir[2]) < 0.05)
      && `halfway through, the camera should be between Home and Front, it is at ${JSON.stringify(r.midDir)}`,
    r.projection !== 'orthographic' && `an animated face view should land orthographic, got ${r.projection}`,
    Math.abs(r.camDir[1] + 1) > 0.001 && `an animated Front should land exactly on -Y, camera is at ${JSON.stringify(r.camDir)}`,
  ],
  undoRedo: r => [
    r.placed !== r.before + 1 && `a click should place one standard, ${r.before} -> ${r.placed}`,
    !r.undoEnabled && 'the Undo arrow should be enabled after a change',
    r.afterCtrlZ !== r.before && `Ctrl+Z should undo the standard, got ${r.afterCtrlZ}`,
    !r.redoEnabled && 'the Redo arrow should be enabled after an undo',
    r.afterCtrlY !== r.placed && `Ctrl+Y should redo it, got ${r.afterCtrlY}`,
    r.afterShiftZ !== r.placed && `Ctrl+Shift+Z should redo it, got ${r.afterShiftZ}`,
    r.afterButton !== r.before && `the Undo arrow should undo, got ${r.afterButton}`,
    r.afterFieldCtrlZ !== r.before && 'Ctrl+Z while typing in a field must not undo the model',
    !r.besideView && 'the undo / redo arrows should sit on the canvas beside the view toggles',
  ],
  historyButtons: r => [
    !r.backPrevented && 'the mouse Back button should be swallowed over the canvas',
    !r.open && 'the Back button must not close the builder',
  ],
  viewTop: r => [
    r.projection !== 'orthographic' && `a face view must be orthographic, got ${r.projection}`,
    r.coverage < 0.008 && `top view rendered blank (coverage ${r.coverage})`,
    Math.abs(r.camDir[2]) < 0.999 && `top view must look straight down, camera is at ${JSON.stringify(r.camDir)}`,
  ],
  viewFront: r => [
    r.projection !== 'orthographic' && `a face view must be orthographic, got ${r.projection}`,
    r.coverage < 0.008 && `front view rendered blank (coverage ${r.coverage})`,
    Math.abs(r.camDir[1] + 1) > 0.001 && `front view must look along -Y, camera is at ${JSON.stringify(r.camDir)}`,
  ],
  lineView: r => [r.coverage < 0.004 && `line view rendered blank (coverage ${r.coverage})`],
  solidAgain: r => [
    r.coverage < 0.02 && `solid view did not come back (coverage ${r.coverage})`,
    !(r.legs > 0) && 'no legs in the takeoff',
    !(r.bomLineItems > 0) && 'empty bill of materials',
  ],
};

async function main() {
  if (!existsSync(PRIVATE_ASSETS['/scaffold-app.js'])) {
    throw new Error('dist/ is not built. Run `npm run build` first (or use `npm run visual`).');
  }
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const { server, port } = await serveDist();
  const url = `http://127.0.0.1:${port}/calculator.html`;
  const chrome = launchChrome(url);
  const report = { url, chrome: chrome.bin, steps: [], errors: [], ignored: [], failures: [] };
  let cdp = null;

  try {
    const targets = await browserTargets(chrome.port);
    const page = targets.find(t => t.type === 'page' && t.url.includes('calculator.html')) || targets.find(t => t.type === 'page');
    cdp = await Cdp.attach(page.webSocketDebuggerUrl);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    cdp.on('Runtime.exceptionThrown', p => {
      const d = p.exceptionDetails || {};
      report.errors.push(`uncaught: ${d.exception?.description || d.text}`);
    });
    cdp.on('Log.entryAdded', p => {
      const e = p.entry || {};
      if (e.level !== 'error') return;
      const line = `${e.source}: ${e.text}${e.url ? ` (${e.url})` : ''}`;
      (IGNORED_ERRORS.test(line) ? report.ignored : report.errors).push(line);
    });

    // The page is already loading; make sure it has finished before driving it.
    await cdp.send('Page.navigate', { url });
    await new Promise(r => {
      const done = () => r();
      cdp.on('Page.loadEventFired', done);
      setTimeout(done, 20000);
    });
    await new Promise(r => setTimeout(r, 400));

    const driver = await readFile(join(ROOT, 'tests/visual/drive.js'), 'utf8');
    await cdp.evaluate(driver, { awaitPromise: false });
    const names = await cdp.evaluate('window.__sv.names');
    console.log(`Chrome: ${chrome.bin}`);
    console.log(`Driving ${names.length} steps at ${WIDTH}x${HEIGHT}\n`);

    let index = 0;
    for (const name of names) {
      index += 1;
      const label = `${String(index).padStart(2, '0')}-${name}`;
      let result;
      try {
        result = await cdp.evaluate(`window.__sv.run(${JSON.stringify(name)})`);
      } catch (err) {
        report.failures.push(`${name}: ${err.message}`);
        console.log(`  ${label}  THREW  ${err.message}`);
        break;
      }
      await cdp.evaluate('window.__sv.paint()', { awaitPromise: false });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(OUT, `${label}.png`), Buffer.from(shot.data, 'base64'));

      const checks = (CHECKS[name] ? CHECKS[name](result) : []).filter(Boolean);
      for (const c of checks) report.failures.push(`${name}: ${c}`);
      report.steps.push({ ...result, shot: `${label}.png`, failures: checks });

      const mark = checks.length ? 'FAIL' : 'ok  ';
      console.log(`  ${label}  ${mark}  ${summarize(result)}`);
      for (const c of checks) console.log(`        ${c}`);
    }

    const pageErrors = await cdp.evaluate('window.__sv.drainErrors()');
    for (const e of pageErrors || []) (IGNORED_ERRORS.test(e) ? report.ignored : report.errors).push(e);
  } finally {
    if (cdp) cdp.close();
    if (!KEEP) killChrome(chrome.child);
    server.close();
  }

  for (const e of report.errors) report.failures.push(`page error: ${e}`);
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log(`\nScreenshots: ${OUT}`);
  if (report.ignored.length) console.log(`Ignored ${report.ignored.length} auth/network console errors (no Firebase env).`);
  if (report.failures.length) {
    console.log(`\n${report.failures.length} failure(s):`);
    for (const f of report.failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${report.steps.length} steps rendered and behaved.`);
  }
}

function summarize(r) {
  const bits = [];
  if (r.gl) bits.push(`${r.gl.renderer}`);
  if (r.plan) bits.push(`plan ${r.plan.join('+')}`);
  if (r.added !== undefined) bits.push(`+${r.added}`);
  if (r.selected !== undefined) bits.push(`${r.selected} selected`);
  if (r.addedColumns !== undefined) bits.push(`+${r.addedColumns} std, +${r.addedLedgers} ldg, +${r.addedBraces} brc`);
  if (r.miss) bits.push(`miss: ${r.miss}`);
  if (r.target) bits.push(`lift ${r.target.levelA}->${r.target.levelB}`);
  if (r.lengthFt) bits.push(`${r.lengthFt} ft`);
  if (r.boards) bits.push(`${r.boards} boards @ ${r.boardLengthFt} ft`);
  if (r.before !== undefined && r.after !== undefined) bits.push(`${r.before} -> ${r.after}`);
  if (r.placedLiveLb) bits.push(`${r.placedLiveLb} lb live`);
  if (r.cyanDelta !== undefined) bits.push(`cyan +${r.cyanDelta}`);
  if (r.projection) bits.push(r.projection);
  if (r.coverage !== undefined) bits.push(`cov ${r.coverage}`);
  if (r.legs) bits.push(`${r.legs} legs`);
  if (r.bomLineItems) bits.push(`BOM ${r.bomLineItems}`);
  return bits.join(' · ');
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
