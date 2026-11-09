import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signOut } from 'firebase/auth';
const anchor = document.getElementById('account-link');
if (anchor) {
  fetch('/api/auth/session', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(session => {
    if (!session?.authenticated) return;
    anchor.textContent = 'Sign out';
    anchor.href = '#';
    anchor.addEventListener('click', async e => {
      e.preventDefault();
      try {
        const response = await fetch('/api/auth/session', { method:'DELETE' });
        if (!response.ok) throw new Error('Sign out failed');
        const configResponse = await fetch('/auth-config.json');
        if (configResponse.ok) {
          const config = await configResponse.json();
          if (config.apiKey && config.authDomain && config.projectId) await signOut(getAuth(getApps()[0] || initializeApp(config)));
        }
        location.href = '/signin.html';
      } catch { anchor.textContent = 'Sign out failed. Try again.'; }
    });
  }).catch(() => {});
}
