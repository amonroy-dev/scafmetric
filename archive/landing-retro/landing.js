// Scafmetric landing page interactions.
// Everything here is decorative or navigational. The beam lab uses closed-form
// statics for a unit load on a simply supported span; it is not a calculated result.
const root = document.documentElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const motionOK = () => !reducedMotion.matches;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, digits = 3) => Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });

// Wide-flange outline centred on (cx, cy); dimensions already in drawing units.
function iBeamPath(cx, cy, depth, width, flange, web) {
  const x = cx - width / 2, y = cy - depth / 2, outstand = (width - web) / 2, clear = depth - 2 * flange;
  const n = v => Number(v.toFixed(2));
  return `M${n(x)} ${n(y)}h${n(width)}v${n(flange)}h${n(-outstand)}v${n(clear)}h${n(outstand)}v${n(flange)}h${n(-width)}v${n(-flange)}h${n(outstand)}v${n(-clear)}h${n(-outstand)}z`;
}

// Runs a callback while an element is on screen; returns a cleanup-free observer.
function whenVisible(element, callback, margin = '0px') {
  if (!('IntersectionObserver' in window)) { callback(true); return; }
  new IntersectionObserver(entries => entries.forEach(entry => callback(entry.isIntersecting)), { rootMargin: margin }).observe(element);
}

/* Header: shadow once scrolled and a segmented progress meter. */
{
  const header = document.querySelector('.site-header');
  const meter = document.querySelector('.scroll-meter span');
  let queued = false;
  const update = () => {
    queued = false;
    const max = root.scrollHeight - window.innerHeight;
    meter?.style.setProperty('--progress', String(max > 0 ? clamp(window.scrollY / max, 0, 1) : 0));
    header?.classList.toggle('is-scrolled', window.scrollY > 8);
  };
  window.addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(update); } }, { passive: true });
  window.addEventListener('resize', update);
  update();
}

/* Scroll reveals. Items already on screen are shown immediately so nothing flickers. */
{
  const items = [...document.querySelectorAll('.reveal')];
  if ('IntersectionObserver' in window && motionOK()) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
    }, { rootMargin: '0px 0px -8% 0px' });
    for (const item of items) {
      const box = item.getBoundingClientRect();
      if (box.top < window.innerHeight && box.bottom > 0) item.classList.add('is-visible');
      else observer.observe(item);
    }
    root.classList.add('reveal-ready');
  } else items.forEach(item => item.classList.add('is-visible'));
}

/* Typewriter. The complete text is in the page and separately available to
   assistive technology; only the visual copy is progressively revealed. */
for (const element of document.querySelectorAll('[data-typewriter]')) {
  const lines = [...element.querySelectorAll('.type-ink')];
  const texts = lines.map(line => line.textContent);
  const speed = Number(element.dataset.speed) || 30;
  const pause = Number(element.dataset.pause) || 250;
  const delay = Number(element.dataset.delay) || 0;
  let timer;
  const finish = () => { clearTimeout(timer); lines.forEach((line, index) => { line.textContent = texts[index]; }); };
  if (!motionOK()) continue;
  lines.forEach(line => { line.textContent = ''; });
  let row = 0, column = 0;
  const cursor = document.createElement('span');
  cursor.className = 'type-cursor';
  const advance = () => {
    if (!motionOK()) { finish(); return; }
    const line = lines[row];
    if (column < texts[row].length) {
      column += 1;
      line.textContent = texts[row].slice(0, column);
      line.append(cursor);
      timer = setTimeout(advance, speed);
    } else if (row < lines.length - 1) {
      cursor.remove(); row += 1; column = 0;
      timer = setTimeout(advance, pause);
    }
  };
  timer = setTimeout(advance, delay);
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) finish(); });
}

/* Count-up stats. Screen readers get the final value from a separate span. */
for (const element of document.querySelectorAll('[data-count]')) {
  const target = Number(element.dataset.count);
  if (!Number.isFinite(target) || !motionOK()) continue;
  element.textContent = '0';
  let started = false;
  whenVisible(element, visible => {
    if (!visible || started) return;
    started = true;
    const start = performance.now() + 500, duration = 1300;
    const step = now => {
      const t = clamp((now - start) / duration, 0, 1);
      element.textContent = Math.round(target * (1 - (1 - t) ** 3)).toLocaleString('en-US');
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/* Pixel starfield behind the hero and the closing call to action. */
for (const canvas of document.querySelectorAll('.starfield')) {
  const context = canvas.getContext?.('2d');
  if (!context) continue;
  const host = canvas.parentElement;
  const palette = ['#e8ecf4', '#e8ecf4', '#9fb3cc', '#3dd9c9', '#ffa41b'];
  let stars = [], width = 0, height = 0, frame = 0, last = 0, onScreen = true;
  const paint = dt => {
    context.clearRect(0, 0, width, height);
    for (const star of stars) {
      star.x -= dt * 0.007 * star.z;
      if (star.x < -2) { star.x = width + 2; star.y = Math.random() * height; }
      star.phase += dt * 0.0021 * star.z;
      context.globalAlpha = (0.2 + 0.6 * star.z) * (0.62 + 0.38 * Math.sin(star.phase));
      context.fillStyle = star.color;
      const size = star.z > 0.78 ? 2 : 1;
      context.fillRect(Math.round(star.x), Math.round(star.y), size, size);
    }
    context.globalAlpha = 1;
  };
  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = host.clientWidth; height = host.clientHeight;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.min(150, Math.round(width * height / 8500));
    stars = Array.from({ length: count }, () => ({ x: Math.random() * width, y: Math.random() * height, z: 0.15 + Math.random() * 0.85, phase: Math.random() * 6.3, color: palette[Math.floor(Math.random() * palette.length)] }));
    paint(0);
  };
  const tick = now => { paint(last ? Math.min(64, now - last) : 16); last = now; frame = requestAnimationFrame(tick); };
  const sync = () => {
    cancelAnimationFrame(frame); last = 0;
    if (onScreen && !document.hidden && motionOK()) frame = requestAnimationFrame(tick);
  };
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(host); else resize();
  whenVisible(host, visible => { onScreen = visible; sync(); });
  document.addEventListener('visibilitychange', sync);
  reducedMotion.addEventListener('change', sync);
}

/* Cursor spotlight: a soft glow that follows the pointer over marked surfaces. */
for (const surface of document.querySelectorAll('[data-spotlight]')) {
  surface.addEventListener('pointermove', event => {
    const target = surface.matches('[data-spotlight-group]') ? event.target.closest('.spot') : surface;
    if (!target) return;
    const box = target.getBoundingClientRect();
    target.style.setProperty('--mx', `${event.clientX - box.left}px`);
    target.style.setProperty('--my', `${event.clientY - box.top}px`);
  }, { passive: true });
}

/* Beam lab: drag a unit point load along a simply supported span, or switch to a
   full-span uniform load. Shapes are exact; magnitudes are normalized. */
{
  const lab = document.querySelector('[data-beam-lab]');
  if (lab) {
    const svg = lab.querySelector('svg');
    const part = id => lab.querySelector(`#${id}`);
    const beam = part('lab-beam'), point = part('lab-point'), marker = part('lab-marker');
    const momentLine = part('lab-moment-line'), momentFill = part('lab-moment-fill'), momentPeak = part('lab-moment-peak'), momentLabel = part('lab-moment-label');
    const bars = { a: part('lab-ra-bar'), b: part('lab-rb-bar') }, barText = { a: part('lab-ra-text'), b: part('lab-rb-text') };
    const slider = lab.querySelector('#lab-position');
    const outputs = Object.fromEntries([...lab.querySelectorAll('[data-out]')].map(node => [node.dataset.out, node]));
    const modeButtons = [...lab.querySelectorAll('[data-lab-mode]')];
    const G = { x0: 100, span: 280, beamY: 122, amp: 24, pointY: 24, momentBase: 350, momentHeight: 44, barBottom: 235, barHeight: 80 };
    let mode = lab.dataset.mode === 'uniform' ? 'uniform' : 'point';
    let target = 0.5, shown = 0.5, amplitude = 1, dragging = false, lastTouch = -Infinity;
    let frame = 0, last = 0, clock = 0, onScreen = true, running = false;

    // Normalized to the midspan value of each case (PL³/48EI or 5wL⁴/384EI).
    const deflection = (xi, a) => {
      if (mode === 'uniform') return (xi * (1 - 2 * xi * xi + xi ** 3) / 24) / (5 / 384);
      const b = 1 - a;
      return 48 * (xi <= a ? b * xi * (1 - b * b - xi * xi) : a * (1 - xi) * (2 * xi - xi * xi - a * a)) / 6;
    };
    // Normalized to PL/4 or wL²/8.
    const moment = (xi, a) => mode === 'uniform' ? 4 * xi * (1 - xi) : 4 * (xi <= a ? (1 - a) * xi : a * (1 - xi));
    const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
    const xs = a => [...new Set([...Array.from({ length: 49 }, (_, i) => i / 48), ...(mode === 'point' ? [a] : [])])].sort((p, q) => p - q);
    const pathOf = points => 'M' + points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L');

    const render = (a, amp) => {
      const samples = xs(a);
      const curve = samples.map(xi => [G.x0 + xi * G.span, G.beamY + G.amp * amp * deflection(xi, a)]);
      const [p0, p1] = curve, [pn, pm] = [curve[curve.length - 1], curve[curve.length - 2]];
      const stub = 14;
      // The overhang stubs follow the end rotation, so they lift as the span sags.
      const left = [p0[0] - stub, p0[1] - (p1[1] - p0[1]) / (p1[0] - p0[0]) * stub];
      const right = [pn[0] + stub, pn[1] + (pn[1] - pm[1]) / (pn[0] - pm[0]) * stub];
      beam.setAttribute('d', pathOf([left, ...curve, right]));

      const momentPoints = samples.map(xi => [G.x0 + xi * G.span, G.momentBase - G.momentHeight * moment(xi, a)]);
      const momentPath = pathOf(momentPoints);
      momentLine.setAttribute('d', momentPath);
      momentFill.setAttribute('d', `${momentPath}L${G.x0 + G.span} ${G.momentBase}L${G.x0} ${G.momentBase}Z`);
      const peakXi = mode === 'point' ? a : 0.5;
      const peakX = G.x0 + peakXi * G.span, peakY = G.momentBase - G.momentHeight * moment(peakXi, a);
      momentPeak.setAttribute('cx', peakX.toFixed(1)); momentPeak.setAttribute('cy', peakY.toFixed(1));
      const flip = peakX > 300;
      momentLabel.setAttribute('x', (peakX + (flip ? -10 : 10)).toFixed(1));
      momentLabel.setAttribute('y', (peakY - 4).toFixed(1));
      momentLabel.setAttribute('text-anchor', flip ? 'end' : 'start');

      const loadX = G.x0 + a * G.span;
      point.setAttribute('transform', `translate(${loadX.toFixed(1)} ${(G.pointY + G.amp * amp * deflection(a, a)).toFixed(1)})`);
      marker.setAttribute('transform', `translate(${loadX.toFixed(1)} 0)`);

      const shareA = mode === 'uniform' ? 0.5 : 1 - a, shareB = 1 - shareA;
      for (const [key, share] of [['a', shareA], ['b', shareB]]) {
        const h = G.barHeight * share;
        bars[key].setAttribute('y', (G.barBottom - h).toFixed(1));
        bars[key].setAttribute('height', h.toFixed(1));
      }
      // Readouts use the displayed position so R_A, R_B and M_max agree with it exactly.
      const at = Math.round(a * 100) / 100;
      const textA = mode === 'uniform' ? '0.50' : (1 - at).toFixed(2), textB = mode === 'uniform' ? '0.50' : at.toFixed(2);
      setText(barText.a, textA); setText(barText.b, textB);
      const unit = mode === 'uniform' ? 'wL' : 'P';
      const momentText = mode === 'uniform' ? '0.125 wL²' : `${(at * (1 - at)).toFixed(3)} PL`;
      setText(outputs.pos, mode === 'uniform' ? 'Full span' : `${at.toFixed(2)} L`);
      setText(outputs.ra, `${textA} ${unit}`);
      setText(outputs.rb, `${textB} ${unit}`);
      setText(outputs.m, momentText);
      setText(momentLabel, momentText);
      if (slider && document.activeElement !== slider && mode === 'point') {
        const value = String(Math.round(a * 100));
        if (slider.value !== value) slider.value = value;
      }
      slider?.setAttribute('aria-valuetext', `${a.toFixed(2)} of the span from the left support`);
    };

    const loop = now => {
      const dt = last ? Math.min(50, now - last) : 16;
      last = now; clock += dt;
      // Attract mode: with no recent input the load glides along the span.
      if (mode === 'point' && !dragging && now - lastTouch > 4200) target = 0.5 + 0.36 * Math.sin(clock * 2 * Math.PI / 9000);
      const ease = 1 - Math.exp(-dt / 90);
      shown += (target - shown) * ease;
      const ampTarget = mode === 'uniform' ? 0.3 + 0.35 * (1 - Math.cos(clock * 2 * Math.PI / 5000)) : 1;
      amplitude += (ampTarget - amplitude) * ease;
      render(shown, amplitude);
      frame = requestAnimationFrame(loop);
    };
    const sync = () => {
      cancelAnimationFrame(frame); last = 0;
      running = onScreen && !document.hidden && motionOK();
      if (running) frame = requestAnimationFrame(loop);
      else { shown = target; amplitude = 1; render(target, 1); }
    };
    const touched = () => { lastTouch = performance.now(); if (!running) { shown = target; render(target, 1); } };
    const setMode = next => {
      if (mode === next) return;
      mode = next; lab.dataset.mode = next;
      modeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.labMode === next)));
      touched();
    };
    const ratioAt = event => {
      const box = svg.getBoundingClientRect();
      return clamp(((event.clientX - box.left) / box.width * 480 - G.x0) / G.span, 0.04, 0.96);
    };
    svg.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      dragging = true; lab.classList.add('is-dragging');
      svg.setPointerCapture?.(event.pointerId);
      setMode('point'); target = ratioAt(event); touched();
    });
    svg.addEventListener('pointermove', event => { if (dragging) { target = ratioAt(event); touched(); } });
    const release = () => { dragging = false; lab.classList.remove('is-dragging'); lastTouch = performance.now(); };
    svg.addEventListener('pointerup', release);
    svg.addEventListener('pointercancel', release);
    slider?.addEventListener('input', () => { setMode('point'); target = Number(slider.value) / 100; touched(); });
    modeButtons.forEach(button => button.addEventListener('click', () => setMode(button.dataset.labMode)));
    whenVisible(lab, visible => { onScreen = visible; sync(); });
    document.addEventListener('visibilitychange', sync);
    reducedMotion.addEventListener('change', sync);
  }
}

/* Workflow poster 01: the section outline steps through real W-shape sizes. */
{
  const poster = document.querySelector('[data-morph]');
  if (poster) {
    const sizes = [
      { label: 'W10X33', W: 33, d: 9.73, bf: 7.96, tf: 0.435, tw: 0.29, Ix: 171 },
      { label: 'W12X26', W: 26, d: 12.2, bf: 6.49, tf: 0.38, tw: 0.23, Ix: 204 },
      { label: 'W16X31', W: 31, d: 15.9, bf: 5.53, tf: 0.44, tw: 0.275, Ix: 375 },
      { label: 'W21X44', W: 44, d: 20.7, bf: 6.5, tf: 0.45, tw: 0.35, Ix: 843 },
      { label: 'W24X55', W: 55, d: 23.6, bf: 7.01, tf: 0.505, tw: 0.395, Ix: 1350 }
    ];
    const shape = poster.querySelector('.morph-shape'), dimension = poster.querySelector('.morph-dim');
    const text = key => poster.querySelector(`[data-morph-${key}]`);
    const scale = 4, cx = 172, cy = 78;
    const draw = s => {
      const depth = s.d * scale;
      shape.setAttribute('d', iBeamPath(cx, cy, depth, s.bf * scale, Math.max(s.tf * scale, 1.4), Math.max(s.tw * scale, 1.4)));
      const top = (cy - depth / 2).toFixed(1), bottom = (cy + depth / 2).toFixed(1);
      dimension.setAttribute('d', `M134 ${top}h8M138 ${top}V${bottom}M134 ${bottom}h8`);
    };
    const label = s => {
      text('name').textContent = s.label;
      text('weight').textContent = `${s.W} lb/ft`;
      text('depth').textContent = `${s.d} in`;
      text('ix').textContent = `${fmt(s.Ix)} in⁴`;
    };
    let index = 2, current = sizes[index], timer = 0, onScreen = false;
    const morphTo = next => {
      const from = current, to = sizes[next], start = performance.now();
      let labelled = false;
      const step = now => {
        const t = clamp((now - start) / 650, 0, 1);
        const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
        const mix = key => from[key] + (to[key] - from[key]) * e;
        draw({ d: mix('d'), bf: mix('bf'), tf: mix('tf'), tw: mix('tw') });
        if (t >= 0.5 && !labelled) { label(to); labelled = true; }
        if (t < 1) requestAnimationFrame(step); else current = to;
      };
      requestAnimationFrame(step);
    };
    const schedule = () => {
      clearInterval(timer);
      if (onScreen && motionOK() && !document.hidden) timer = setInterval(() => { index = (index + 1) % sizes.length; morphTo(index); }, 2600);
    };
    draw(current); label(current);
    whenVisible(poster, visible => { onScreen = visible; schedule(); });
    document.addEventListener('visibilitychange', schedule);
    reducedMotion.addEventListener('change', schedule);
  }
}

/* Section library: filter chips, cards drawn to scale, lazy-loaded data. */
{
  const library = document.querySelector('[data-library]');
  if (library) {
    const chipRow = library.querySelector('[data-family-chips]');
    const grid = library.querySelector('[data-shape-grid]');
    const more = library.querySelector('[data-library-more]');
    const status = library.querySelector('[data-library-status]');
    const PAGE = 12;
    let families = new Map(), current = 'W16', expanded = false, requested = false;
    const familyOf = label => label.slice(0, label.indexOf('X'));

    const card = (s, scale, badges) => {
      const label = escapeHtml(s.AISC_Manual_Label);
      const outline = iBeamPath(60, 60, s.d * scale, s.bf * scale, Math.max(s.tf * scale, 1.2), Math.max(s.tw * scale, 1.2));
      return `<a class="shape-card spot" href="signin.html">`
        + badges.map(badge => `<span class="shape-badge shape-badge-${badge.toLowerCase()}">${badge}</span>`).join('')
        + `<svg class="shape-svg" viewBox="0 0 120 120" aria-hidden="true"><path class="shape-axis" d="M6 60H114"/><path class="shape-fill" d="${outline}"/></svg>`
        + `<span class="shape-name">${label}</span>`
        + `<span class="shape-meta"><span>${fmt(s.W)} lb/ft</span><span>I<sub>x</sub> ${fmt(s.Ix)} in⁴</span></span>`
        + `<span class="shape-dims">d ${fmt(s.d)} × b<sub>f</sub> ${fmt(s.bf)} in</span>`
        + `<span class="shape-open">Sign in to analyze <span aria-hidden="true">→</span></span></a>`;
    };
    // Cards before `settled` are already on screen and skip the entrance animation.
    const render = (settled = 0) => {
      const list = families.get(current) || [];
      if (!list.length) return;
      const scale = 92 / Math.max(...list.map(s => Math.max(s.d, s.bf)));
      const lightest = list[0];
      const stiffest = list.reduce((a, b) => (b.Ix > a.Ix ? b : a), list[0]);
      const shown = expanded ? list : list.slice(0, PAGE);
      grid.innerHTML = shown.map(s => card(s, scale, list.length > 1 ? [s === lightest && 'Lightest', s === stiffest && 'Stiffest'].filter(Boolean) : [])).join('');
      grid.querySelectorAll('.shape-card').forEach((node, i) => {
        if (i < settled) node.style.animation = 'none';
        else node.style.setProperty('--i', String(i - settled));
      });
      more.hidden = expanded || list.length <= PAGE;
      more.textContent = `Show all ${list.length} ${current} sections`;
      status.textContent = `Showing ${shown.length} of ${list.length} ${current} sections, lightest first.`;
    };
    const load = () => {
      if (requested) return;
      requested = true;
      fetch('public/data/aisc-w-shapes-v15.json').then(response => { if (!response.ok) throw new Error('Library unavailable'); return response.json(); }).then(data => {
        const byFamily = new Map();
        for (const s of data.filter(s => s?.AISC_Manual_Label && s.d > 0 && s.bf > 0).sort((a, b) => a.W - b.W)) {
          const family = familyOf(s.AISC_Manual_Label);
          if (!byFamily.has(family)) byFamily.set(family, []);
          byFamily.get(family).push(s);
        }
        families = new Map([...byFamily].sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1))));
        if (!families.has(current)) current = families.keys().next().value;
        chipRow.innerHTML = [...families].map(([family, list]) => `<button type="button" class="chip" data-family="${escapeHtml(family)}" aria-pressed="${family === current}">${escapeHtml(family)}<span class="chip-count">${list.length}<span class="sr-only"> sections</span></span></button>`).join('');
        library.classList.add('is-loaded');
        render();
      }).catch(() => {
        grid.innerHTML = '<p class="library-error">The section library could not be loaded here. <a href="signin.html">Sign in</a> to use the beam workspace.</p>';
        status.textContent = 'The section library could not be loaded.';
      });
    };
    chipRow.addEventListener('click', event => {
      const chip = event.target.closest('[data-family]');
      if (!chip || chip.dataset.family === current) return;
      current = chip.dataset.family; expanded = false;
      chipRow.querySelectorAll('[data-family]').forEach(node => node.setAttribute('aria-pressed', String(node === chip)));
      render();
    });
    more.addEventListener('click', () => { expanded = true; render(PAGE); grid.querySelectorAll('.shape-card')[PAGE]?.focus({ preventScroll: true }); });
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); } }, { rootMargin: '700px 0px' });
      observer.observe(library);
    } else load();
  }
}

/* A small reward for anyone who still remembers the code. */
{
  const sequence = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  let position = 0, toastTimer = 0;
  window.addEventListener('keydown', event => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    position = key === sequence[position] ? position + 1 : key === sequence[0] ? 1 : 0;
    if (position < sequence.length) return;
    position = 0;
    const on = root.classList.toggle('crt');
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast'; toast.setAttribute('role', 'status');
      document.body.append(toast);
    }
    toast.textContent = on ? 'CRT MODE ON. Enter the code again to switch it off.' : 'CRT MODE OFF';
    toast.classList.add('is-shown');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-shown'), 2800);
  });
}
