import { cp, mkdir, rm } from 'node:fs/promises';

// Publish a complete static site without copying repository metadata or reports.
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const path of ['index.html', 'calculator.html', 'app.js', 'landing.js', 'landing.css', 'styles.css', 'diagram.css', 'src', 'public']) {
  await cp(path, `dist/${path}`, { recursive: true });
}
console.log('Static site built in dist/');
