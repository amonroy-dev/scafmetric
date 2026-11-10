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

// The complete text is present before JavaScript runs and separately available to
// assistive technology. Only the visual copy is progressively revealed.
for (const element of document.querySelectorAll('[data-typewriter]')) {
  const lines = [...element.querySelectorAll('.type-ink')];
  const texts = lines.map(line => line.textContent);
  const speed = Number(element.dataset.speed) || 30;
  const pause = Number(element.dataset.pause) || 250;
  const delay = Number(element.dataset.delay) || 0;
  let timer;
  const finish = () => {
    clearTimeout(timer);
    lines.forEach((line, index) => { line.textContent = texts[index]; });
  };
  if (reducedMotion.matches) continue;
  lines.forEach(line => { line.textContent = ''; });
  let row = 0, column = 0;
  const cursor = document.createElement('span');
  cursor.className = 'type-cursor';
  function advance() {
    if (reducedMotion.matches) { finish(); return; }
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
  }
  timer = setTimeout(advance, delay);
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) finish(); });
}
