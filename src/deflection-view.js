/* Deformed-shape view for the input model. After a run, the beam is drawn in its
   computed deflected shape at a stated vertical scale, over a dashed undeformed
   reference. "Animate" applies the full service load from 0% to 100%: the
   analysis is linear, so every frame is exactly the load fraction × δ(x). Loads
   and brace marks move with the beam at their own stations. */
import { MODEL, SCALE_OPTIONS, deflectedShape, dropUnits, autoScale, fitsDrawing, drawnPoints } from './deflection-shape.js';

const NS = 'http://www.w3.org/2000/svg';
const fmt = (n, digits) => Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
const factor = scale => (scale === 1 ? '1× (true scale)' : `${fmt(scale, 2)}×`);
const pathOf = points => 'M' + points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(3)}`).join('L');
const DURATION = 2000;

export function createDeflectionView({ panel, button, select, readout, status }) {
  let analysis = null, shape = null, loadFraction = 1, frame = 0, playing = false;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const model = () => panel.querySelector('#schematic .input-beam');
  const scale = () => (select.value === 'auto' ? autoScale(shape.peak.deflectionIn, shape.spanFt) : Number(select.value));

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
    const loadText = `${Math.round(loadFraction * 100)}% of service load`;
    readout.innerHTML = `<span>${loadText}</span><span>Max δ ${fmt(peak, 4)} in at ${fmt(shape.peak.xFt, 3)} ft</span><span>Vertical ${factor(s)} · horizontal true scale</span><span>Adjusted 0.8 EI</span>`;
    if (final) status.textContent = `Full service load. Maximum adjusted deflection ${fmt(shape.peak.deflectionIn, 4)} inches at ${fmt(shape.peak.xFt, 3)} feet, drawn at ${factor(s)} vertical scale.`;
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
    // Loads and brace marks ride on the beam at their own stations, exactly.
    for (const element of svg.querySelectorAll('[data-x-ft]')) {
      const xFt = Number(element.dataset.xFt);
      if (!Number.isFinite(xFt) || xFt < 0 || xFt > shape.spanFt) continue;
      element.setAttribute('transform', `translate(0 ${dropUnits(analysis.at(xFt)[shape.basis], shape.spanFt, s, loadFraction).toFixed(3)})`);
    }
    svg.querySelector('[data-load-bar]')?.setAttribute('d', pathOf(points.map(([x, y]) => [x, y - (MODEL.beamY - MODEL.loadBarY)])));
    const loadOpacity = String(0.25 + 0.75 * loadFraction);
    svg.querySelectorAll('.in-load, .input-hotspot[data-point-index]').forEach(element => { element.style.opacity = loadOpacity; });
    describe(final);
  }

  function setButton() {
    button.setAttribute('aria-pressed', String(playing));
    button.querySelector('.model-action-label').textContent = playing ? 'Stop' : 'Animate';
    button.querySelector('.model-action-icon').textContent = playing ? '■' : '▶';
  }
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
      const t = Math.min(1, (now - start) / DURATION);
      // Smooth start and stop; the drawn shape always equals the stated load fraction.
      loadFraction = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      if (t < 1) { draw(); frame = requestAnimationFrame(step); } else finish();
    };
    frame = requestAnimationFrame(step);
  }

  button.addEventListener('click', () => (playing ? finish() : play()));
  select.addEventListener('change', () => { if (shape) draw(!playing); });

  return {
    show(result) {
      analysis = result; shape = deflectedShape(result); loadFraction = 1; playing = false;
      refreshScaleOptions();
      button.disabled = false; select.disabled = false;
      setButton(); draw(true);
    },
    clear() {
      cancelAnimationFrame(frame);
      analysis = null; shape = null; playing = false; loadFraction = 1;
      button.disabled = true; select.disabled = true;
      setButton();
      readout.innerHTML = '<span>Run analysis to see the deflected shape under load.</span>';
      status.textContent = '';
    }
  };
}
