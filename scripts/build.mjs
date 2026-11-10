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
for (const path of ['index.html', 'calculator.html', 'signin.html', 'app.js', 'landing.js', 'landing.css', 'styles.css', 'diagram.css', 'input-diagram.css', 'report-print.css', 'refined.css', 'auth.css', 'src', 'public']) {
  await cp(path, `dist/${path}`, { recursive: true });
}
await build({ entryPoints: ['src/auth/client.js'], bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], outfile: 'dist/auth.js', minify: true });
await build({ entryPoints: ['src/auth/account.js'], bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], outfile: 'dist/account.js', minify: true });
await writeFile('dist/auth-config.json', JSON.stringify(firebaseConfig));
console.log('Static site built in dist/');
