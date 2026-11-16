/* Deformed-shape view for the input model. After a run, the beam is drawn in its
   computed deflected shape at a stated vertical scale, over a dashed undeformed
   reference. "Animate" loads and unloads the beam repeatedly until "Stop" is
   pressed: the analysis is linear, so every frame is exactly the load fraction ×
   δ(x). Loads and brace marks move with the beam at their own stations. When a
   deflection limit is given, the beam turns red while its sag exceeds the limit. */
import { MODEL, SCALE_OPTIONS, deflectedShape, dropUnits, autoScale, fitsDrawing, drawnPoints } from './deflection-shape.js';
import { updatePointLoads, updateSupportReactions } from './input-visual.js';

const NS = 'http://www.w3.org/2000/svg';
const fmt = (n, digits) => Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
const factor = scale => (scale === 1 ? '1× (true scale)' : `${fmt(scale, 2)}×`);
const pathOf = points => 'M' + points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(3)}`).join('L');
// One loading cycle: apply the load, hold at full load, remove it, hold unloaded.
export const CYCLE = Object.freeze({ rise: 1800, holdFull: 900, fall: 1800, holdEmpty: 500 });
const CYCLE_MS = CYCLE.rise + CYCLE.holdFull + CYCLE.fall + CYCLE.holdEmpty;
const ease = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
// Load fraction (0 to 1) at a time into the repeating cycle.
export function loadFractionAt(elapsedMs) {
  const t = ((elapsedMs % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
  if (t < CYCLE.rise) return ease(t / CYCLE.rise);
  if (t < CYCLE.rise + CYCLE.holdFull) return 1;
  if (t < CYCLE.rise + CYCLE.holdFull + CYCLE.fall) return 1 - ease((t - CYCLE.rise - CYCLE.holdFull) / CYCLE.fall);
  return 0;
}

export function createDeflectionView({ panel, button, select, readout, status }) {
  let analysis = null, shape = null, limit = null, loadFraction = 1, frame = 0, playing = false;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const model = () => panel.querySelector('#schematic .input-beam');
  const scale = () => (select.value === 'auto' ? autoScale(shape.peak.deflectionIn, shape.spanFt) : Number(select.value));
  // The drawn sag is exactly loadFraction × δmax, so the comparison is exact too.
  const overLimit = () => limit !== null && loadFraction * shape.peak.deflectionIn > limit.allowableIn;

  // Auto states the factor it picked; factors that would not fit are disabled, never clipped.
  function refreshScaleOptions() {
    const previous = select.value || 'auto';
    const peak = shape.peak.deflectionIn, span = shape.spanFt;
    select.innerHTML = `<option value="auto">Auto · ${factor(autoScale(peak, span))}</option>` + SCALE_OPTIONS.map(value => {
      const fits = fitsDrawing(peak, span, value);
      return `<option value="${value}"${fits ? '' : ' disabled'}>${factor(value)}${fits ? '' : ' · too large to draw'}</option>`;
    }).join('');
    const keep = [...select.options].some(option => option.value === previous && !option.disabled);
    select.value = keep ? previous : 'auto';
  }

  function describe(final) {
    const s = scale();
    const peak = loadFraction * shape.peak.deflectionIn;
    const over = overLimit();
    const limitText = limit === null ? ''
      : over ? ` · exceeds the L/${limit.limitRatio} limit of ${fmt(limit.allowableIn, 4)} in`
      : ` · limit L/${limit.limitRatio} = ${fmt(limit.allowableIn, 4)} in`;
    readout.classList.toggle('is-over', over);
    readout.innerHTML = `<span>${Math.round(loadFraction * 100)}% of service load</span><span class="deflection-value">Max δ ${fmt(peak, 4)} in at ${fmt(shape.peak.xFt, 3)} ft${limitText}</span><span>Vertical ${factor(s)} · horizontal true scale · ${fmt(analysis.input.stiffnessFactor, 2)} EI</span>`;
    if (final) {
      const verdict = limit === null ? '' : limit.meets ? ` Within the L/${limit.limitRatio} limit of ${fmt(limit.allowableIn, 4)} inches.` : ` Exceeds the L/${limit.limitRatio} limit of ${fmt(limit.allowableIn, 4)} inches.`;
      status.textContent = `Full service load. Maximum adjusted deflection ${fmt(shape.peak.deflectionIn, 4)} inches at ${fmt(shape.peak.xFt, 3)} feet, drawn at ${factor(s)} vertical scale.${verdict}`;
    }
  }

  function draw(final = false) {
    const svg = model();
    if (!svg || !shape) return;
    const s = scale();
    const beam = svg.querySelector('.in-beam');
    if (!svg.querySelector('.in-beam-ghost')) {
      const ghost = document.createElementNS(NS, 'path');
      ghost.setAttribute('class', 'in-beam-ghost');
      ghost.setAttribute('d', `M${MODEL.left} ${MODEL.beamY}H${MODEL.right}`);
      beam.before(ghost);
    }
    const points = drawnPoints(shape, s, loadFraction);
    beam.setAttribute('d', pathOf(points));
    svg.classList.toggle('is-over-limit', overLimit());
    // Loads and brace marks ride on the beam at their own stations, exactly.
    for (const element of svg.querySelectorAll('[data-x-ft]')) {
      const xFt = Number(element.dataset.xFt);
      if (!Number.isFinite(xFt) || xFt < 0 || xFt > shape.spanFt) continue;
      element.setAttribute('transform', `translate(0 ${dropUnits(analysis.at(xFt)[shape.basis], shape.spanFt, s, loadFraction).toFixed(3)})`);
    }
    svg.querySelector('[data-load-bar]')?.setAttribute('d', pathOf(points.map(([x, y]) => [x, y - (MODEL.beamY - MODEL.loadBarY)])));
    const loadOpacity = String(0.25 + 0.75 * loadFraction);
    svg.querySelectorAll('.in-load, .input-hotspot[data-point-index]').forEach(element => { element.style.opacity = loadOpacity; });
    updatePointLoads(svg, loadFraction);
    updateSupportReactions(svg, analysis, loadFraction);
    describe(final);
  }

  function setButton() {
    button.setAttribute('aria-pressed', String(playing));
    button.querySelector('.model-action-label').textContent = playing ? 'Stop' : 'Animate';
    button.querySelector('.model-action-icon').textContent = playing ? '■' : '▶';
  }
  // Stop wherever the cycle is and show the full service load.
  function finish() {
    cancelAnimationFrame(frame);
    playing = false; loadFraction = 1;
    setButton(); draw(true);
  }
  function play() {
    if (!shape) return;
    if (reducedMotion()) { finish(); return; }
    cancelAnimationFrame(frame);
    playing = true; loadFraction = 0;
    setButton(); draw();
    const start = performance.now();
    const step = now => {
      if (!playing) return;
      loadFraction = loadFractionAt(now - start);
      draw();
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  button.addEventListener('click', () => (playing ? finish() : play()));
  select.addEventListener('change', () => { if (shape) draw(!playing); });

  return {
    show(result, deflectionLimit = null) {
      cancelAnimationFrame(frame);
      analysis = result; shape = deflectedShape(result); limit = deflectionLimit?.status === 'evaluated' ? deflectionLimit : null;
      loadFraction = 1; playing = false;
      refreshScaleOptions();
      button.disabled = false; select.disabled = false;
      setButton(); draw(true);
    },
    clear() {
      cancelAnimationFrame(frame);
      analysis = null; shape = null; limit = null; playing = false; loadFraction = 1;
      updatePointLoads(model());
      updateSupportReactions(model(), null);
      button.disabled = true; select.disabled = true;
      setButton();
      readout.classList.remove('is-over');
      readout.innerHTML = '<span>Run analysis to see the deflected shape under load.</span>';
      status.textContent = '';
    }
  };
}
