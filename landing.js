// Scafmetric landing page: the bid check wall.
//
// A line drawing of what the tool does, running: a scaffold's legs put their
// loads on a beam, the beam bends, the check reads it, and the answer is
// kept. It turns between the beam carried on a guess (a W8X10, far over) and
// the one the check finds (a W12X30, which holds). The figures are from
// Scafmetric's own checks for the example named under the drawing; the
// drawing itself is a picture, not a calculation.

document.documentElement.classList.add('js');

const CYAN = '#19e3e3', AMBER = '#ff9f1a', GREEN = '#22c55e', INK = '#eceef1', DIM = '#6b7280', LINE = '#2a303a', FAINT = '#1b1f26';
const MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, Menlo, monospace';
const LEG_FRACTIONS = [0.125, 0.375, 0.625, 0.875];
const TURN_SECONDS = 7; // how long each beam is shown

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

function startWall(canvas) {
  const g = canvas.getContext('2d');
  let W = 0, H = 0, stars = [];

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The same stars every time, so they do not jump when the window is resized.
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    stars = Array.from({ length: Math.round((W * H) / 9000) }, () => ({ x: rnd() * W, y: rnd() * H * 0.78, a: 0.15 + rnd() * 0.5, c: rnd() < 0.12 ? CYAN : rnd() < 0.1 ? AMBER : '#ffffff' }));
  }

  const label = (text, x, y, color = DIM, size = 10, align = 'center') => {
    g.font = `600 ${size}px ${MONO}`;
    g.textAlign = align; g.textBaseline = 'middle';
    g.fillStyle = color;
    // Wide tracking, as on a drawing.
    if ('letterSpacing' in g) g.letterSpacing = '1.5px';
    g.fillText(text, x, y);
  };
  const line = (x0, y0, x1, y1, color = LINE, width = 1) => { g.strokeStyle = color; g.lineWidth = width; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
  /** Dashes moving along a path: `pts` is a polyline, `shift` how far along they have run. */
  const flow = (pts, color, shift, dash = [2, 9], width = 1) => {
    g.save(); g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash); g.lineDashOffset = -shift;
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke(); g.restore();
  };
  /** A bright dash travelling along a polyline, at `t` from 0 to 1. */
  const pulse = (pts, t, color, length = 16) => {
    const segs = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    const total = segs.reduce((a, b) => a + b, 0);
    const at = d => { let rest = Math.max(0, Math.min(total, d)); for (let i = 0; i < segs.length; i++) { if (rest <= segs[i] || i === segs.length - 1) { const k = segs[i] ? rest / segs[i] : 0; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k]; } rest -= segs[i]; } return pts[0]; };
    const head = at(t * total), tail = at(t * total - length);
    line(tail[0], tail[1], head[0], head[1], color, 1.5);
    g.fillStyle = color; g.beginPath(); g.arc(head[0], head[1], 1.8, 0, Math.PI * 2); g.fill();
  };
  const arc = (x0, y0, x1, y1, lift, n = 40) => Array.from({ length: n + 1 }, (_, i) => { const t = i / n; return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t - Math.sin(Math.PI * t) * lift]; });

  function draw(seconds) {
    g.clearRect(0, 0, W, H);
    const narrow = W < 760;
    const ground = H * (narrow ? 0.76 : 0.7);
    const x0 = W * (narrow ? 0.08 : 0.4), x1 = W * (narrow ? 0.92 : 0.76);
    const span = x1 - x0;
    const turn = Math.floor(seconds / TURN_SECONDS) % 2; // 0: the guess, 1: the checked size
    const within = (seconds % TURN_SECONDS) / TURN_SECONDS;
    const settle = Math.min(1, within * 4);                // the beam taking up its shape
    const guess = turn === 0;
    const accent = guess ? AMBER : CYAN;

    for (const s of stars) { g.globalAlpha = s.a; g.fillStyle = s.c; g.fillRect(s.x, s.y, 1, 1); }
    g.globalAlpha = 1;

    // The ground, and the two supports the beam sits on.
    g.fillStyle = '#0b0d10'; g.fillRect(0, ground + 18, W, H - ground - 18);
    line(0, ground + 18, W, ground + 18, FAINT);
    for (const x of [x0, x1]) {
      g.strokeStyle = LINE; g.lineWidth = 1; g.beginPath(); g.moveTo(x, ground); g.lineTo(x - 9, ground + 18); g.lineTo(x + 9, ground + 18); g.closePath(); g.stroke();
    }

    // The beam: shallow and sagging on the guess, deeper and nearly straight once checked.
    const depth = guess ? 4 : 11;
    const sag = (guess ? 30 : 5) * settle;
    const beamY = t => ground - depth - Math.sin(Math.PI * t) * -sag;
    const top = Array.from({ length: 41 }, (_, i) => [x0 + span * (i / 40), beamY(i / 40)]);
    g.strokeStyle = accent; g.lineWidth = 1.2; g.beginPath();
    top.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    for (let i = 40; i >= 0; i--) g.lineTo(top[i][0], top[i][1] + depth);
    g.closePath(); g.stroke();
    g.globalAlpha = 0.08; g.fillStyle = accent; g.fill(); g.globalAlpha = 1;

    // The scaffold standing on it: four legs, three lifts, a brace in each bay.
    const legs = LEG_FRACTIONS.map(f => ({ x: x0 + span * f, foot: beamY(f) }));
    const height = Math.min(H * (narrow ? 0.22 : 0.28), 220), lifts = 3;
    const head = ground - depth - height;
    for (const l of legs) line(l.x, head, l.x, l.foot, '#3a414d', 1.2);
    for (let k = 0; k <= lifts; k++) {
      const y = head + (height * k) / lifts;
      if (k < lifts) line(legs[0].x, y, legs[3].x, y, LINE);
    }
    for (let b = 0; b < 3; b++) for (let k = 0; k < lifts; k++) {
      const ya = head + (height * k) / lifts, yb = head + (height * (k + 1)) / lifts;
      line(legs[b].x, b % 2 ? ya : yb, legs[b + 1].x, b % 2 ? yb : ya, FAINT);
    }
    // Its decks, and the load coming down each leg.
    for (const k of [0, 1]) { const y = head + (height * k) / lifts; g.fillStyle = '#12151a'; g.fillRect(legs[0].x, y - 3, legs[3].x - legs[0].x, 3); }
    legs.forEach((l, i) => {
      const path = [[l.x, head], [l.x, l.foot]];
      flow(path, AMBER, seconds * 26);
      pulse(path, (seconds * 0.45 + i * 0.23) % 1, AMBER, 14);
      label('4,500 LB', l.x, head - 14, AMBER, narrow ? 8 : 9);
    });
    label('SCAFFOLD', (legs[0].x + legs[3].x) / 2, head - 34, INK, 10);

    // Reactions going into the supports.
    for (const [i, x] of [x0, x1].entries()) pulse([[x, ground - 2], [x, ground + 16]], (seconds * 0.9 + i * 0.5) % 1, accent, 8);
    label(guess ? 'ASSUMED W8X10' : 'CHECKED W12X30', x0 + span / 2, ground + 36, accent, 11);
    label('20 FT SPAN', x0 + span / 2, ground + 54, DIM, 9);

    // The bending moment under the beam, drawn as it is read.
    const mTop = ground + 78, mDeep = Math.min(70, H - mTop - 60);
    if (mDeep > 24) {
      const moment = Array.from({ length: 41 }, (_, i) => { const t = i / 40; return [x0 + span * t, mTop + mDeep * 4 * t * (1 - t)]; });
      line(x0, mTop, x1, mTop, FAINT);
      flow(moment, CYAN, seconds * 18, [1, 0], 1);
      for (let k = 0; k < 4; k++) pulse(moment, (seconds * 0.12 + k * 0.25) % 1, CYAN, 10);
      // (On a narrow screen the strip along the bottom is where its name would go.)
      if (!narrow) label('BENDING MOMENT', x0 + span / 2, mTop + mDeep + 16, CYAN, 9);
    }

    if (narrow) return;

    // The check: a node above, read from the beam and written to the record.
    const node = { x: W * 0.9, y: H * 0.22 };
    const up = arc(x0 + span / 2, head - 48, node.x, node.y + 14, H * 0.16);
    flow(up, CYAN, seconds * 22);
    for (let k = 0; k < 3; k++) pulse(up, (seconds * 0.16 + k / 3) % 1, CYAN, 16);
    g.strokeStyle = LINE; g.lineWidth = 1; g.strokeRect(node.x - 26, node.y - 9, 52, 18);
    g.strokeRect(node.x - 44, node.y - 5, 14, 10); g.strokeRect(node.x + 30, node.y - 5, 14, 10);
    label('CHECK // AISC 360-16 ASD', node.x, node.y - 24, CYAN, 9);
    label(guess ? 'BENDING 12.8× OVER' : 'BENDING 1.00  HOLDS', node.x, node.y + 28, guess ? AMBER : GREEN, 10);

    const record = { x: W * 0.9, y: ground + 18 };
    const down = [[node.x, node.y + 40], [record.x, record.y - 44]];
    flow(down, guess ? AMBER : CYAN, seconds * 22);
    pulse(down, (seconds * 0.3) % 1, guess ? AMBER : CYAN, 14);
    g.strokeStyle = LINE; g.strokeRect(record.x - 20, record.y - 42, 40, 42);
    for (let k = 0; k < 4; k++) line(record.x - 13, record.y - 34 + k * 8, record.x + (k === 3 ? 2 : 13), record.y - 34 + k * 8, FAINT);
    label('CALCULATION RECORD', record.x, record.y + 18, INK, 9);

    // Field assets off to the left, as the guess is made: a stock beam on the rack.
    const rack = { x: W * 0.2, y: ground + 18 };
    if (rack.x + 60 < x0 - 30) {
      for (let k = 0; k < 3; k++) { g.strokeStyle = k === 0 && guess ? AMBER : LINE; g.strokeRect(rack.x - 44, rack.y - 10 - k * 9, 88, 5); }
      label('YARD STOCK', rack.x, rack.y + 18, DIM, 9);
      const carry = arc(rack.x, rack.y - 30, x0 + span * 0.1, ground - 40, 26, 20);
      flow(carry, guess ? AMBER : FAINT, seconds * 16);
      if (guess) pulse(carry, (seconds * 0.35) % 1, AMBER, 12);
    }
  }

  resize();
  addEventListener('resize', resize);
  if (reduced) { draw(TURN_SECONDS * 1.6); addEventListener('resize', () => draw(TURN_SECONDS * 1.6)); return; }
  let visible = true;
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; }).observe(canvas);
  const began = performance.now();
  const frame = now => { if (visible && !document.hidden) draw((now - began) / 1000); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);

  // The bar over the wall follows the turn.
  const assumed = document.querySelector('[data-out="assumed"]');
  if (assumed) setInterval(() => {
    const guess = Math.floor(((performance.now() - began) / 1000) / TURN_SECONDS) % 2 === 0;
    assumed.style.opacity = guess ? '1' : '.45';
  }, 250);
}

const wall = document.querySelector('[data-wall]');
if (wall) startWall(wall);

// How long this page has been open, in the header.
const clock = document.querySelector('[data-clock]');
if (clock) {
  const opened = Date.now();
  const two = n => String(n).padStart(2, '0');
  const tick = () => { const s = Math.floor((Date.now() - opened) / 1000); clock.textContent = `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`; };
  tick(); setInterval(tick, 1000);
}

// Sections come in as they are scrolled to.
const reveals = document.querySelectorAll('.reveal');
if (reduced || !('IntersectionObserver' in window)) reveals.forEach(el => el.classList.add('is-in'));
else {
  const seen = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); seen.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  reveals.forEach(el => seen.observe(el));
}
