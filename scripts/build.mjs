import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

// Public Firebase web settings only. Never put admin credentials in this file.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || '',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || '',
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || '',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || ''
};
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
// Calculator HTML and its JavaScript are served only through the authenticated
// workspace function. Do not copy them into the public output: static files
// take precedence over Vercel rewrites and would bypass the access check.
for (const path of ['index.html', 'signin.html', 'terms.html', 'terms.css', 'billing.html', 'billing.css', 'billing.js', 'admin.html', 'admin.js', 'admin.css', 'landing.js', 'landing.css', 'styles.css', 'diagram.css', 'input-diagram.css', 'report-print.css', 'capacity.css', 'auth.css', 'ui.css', 'scaffold.css', 'public']) {
  await cp(path, `dist/${path}`, { recursive: true });
}
await build({ entryPoints: ['src/auth/client.js'], bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], outfile: 'dist/auth.js', minify: true });
await build({ entryPoints: ['src/auth/account.js'], bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], outfile: 'dist/account.js', minify: true });
// Bundle the calculator outside the public output. Serving one protected asset
// avoids repeated entitlement checks on every imported JavaScript module.
await mkdir('workspace-private', { recursive:true });
await build({ entryPoints: ['app.js'], bundle:true, format:'esm', platform:'browser', target:['es2020'], outfile:'workspace-private/app.js', minify:true });
// Scaffold-to-beam 3D workspace (three.js). Bundled so the site needs no CDN, and
// kept private like app.js because calculator.html loads it.
await build({ entryPoints: ['src/scaffold/workspace/main.js'], bundle:true, format:'esm', platform:'browser', target:['es2020'], outfile:'workspace-private/scaffold-app.js', minify:true });
// pdf.js, for a PDF drawing laid under the scaffold. Copied beside the site,
// not bundled: the builder fetches it the first time a PDF is opened. It is a
// public library, so it needs no access check.
await mkdir('dist/pdfjs', { recursive: true });
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) await cp(`node_modules/pdfjs-dist/build/${file}`, `dist/pdfjs/${file}`);
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) await cp(`node_modules/pdfjs-dist/${dir}`, `dist/pdfjs/${dir}`, { recursive: true });
await writeFile('dist/auth-config.json', JSON.stringify(firebaseConfig));
console.log('Static site built in dist/');
