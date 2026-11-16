// Check the server-owned account immediately before each calculation. Never
// treat a missing, malformed, or unavailable session response as access.
export async function getAnalysisAccess(request = fetch) {
  try {
    const response = await request('/api/auth/session', { cache: 'no-store' });
    if (!response.ok) return 'unavailable';
    const session = await response.json();
    if (session?.configured !== true) return 'unavailable';
    if (session.authenticated !== true) return 'signin';
    if (session.termsAccepted !== true || session.profileComplete !== true) return 'onboarding';
    return 'allowed';
  } catch { return 'unavailable'; }
}
