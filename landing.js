// Decorative illustration only; it does not represent an engineering result.
const beam = document.getElementById('hero-beam');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let frame;
let start;

function draw(amount) {
  const y = 117 + 31 * amount;
  beam.setAttribute('d', `M76 117H119 C173 117 188 ${y} 240 ${y} S307 117 361 117 H404`);
}
function tick(time) {
  if (start === undefined) start = time;
  const phase = ((time - start) % 5000) / 5000;
  draw((1 - Math.cos(phase * 2 * Math.PI)) / 2);
  frame = requestAnimationFrame(tick);
}
function updateMotion() {
  cancelAnimationFrame(frame);
  start = undefined;
  if (reducedMotion.matches || document.hidden) draw(1);
  else frame = requestAnimationFrame(tick);
}
if (beam) {
  reducedMotion.addEventListener('change', updateMotion);
  document.addEventListener('visibilitychange', updateMotion);
  updateMotion();
}
