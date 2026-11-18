import { TERMS_VERSION } from '../terms.js';
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail, updateProfile, signOut } from 'firebase/auth';
import { validateSignupProfile, savePendingSignup, readPendingSignup, clearPendingSignup, pendingForUser } from './signup-profile.js';

const $ = id => document.getElementById(id);
let auth, view = 'signin', busy = false, pendingTermsUser = null, pendingTermsVersion = null, pendingProfileUser = null, pendingSignup = null;
const settings = () => ({ url: `${location.origin}/signin.html`, handleCodeInApp: false });
const notify = (message = '') => { $('auth-status').textContent = message; $('auth-status').hidden = !message; };
const errors = {
 'auth/invalid-credential': 'Incorrect email or password.', 'auth/invalid-email': 'Enter a valid email address.',
 'auth/email-already-in-use': 'An account with this email already exists. Sign in, continue with Google, or reset your password.',
 'auth/weak-password': 'Choose a stronger password of at least 8 characters.', 'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
 'auth/network-request-failed': "We couldn't reach the server. Check your connection and try again.", 'auth/unauthorized-domain': "Sign-in isn't enabled for this web address.",
 'auth/operation-not-allowed': "This sign-in method isn't available right now.", 'auth/user-disabled': 'This account has been disabled.'
};
const failure = e => notify(['The terms have changed. Reload this page to review them.', 'Your browser could not keep your signup details for Google sign-in. Please allow session storage or use email.'].includes(e?.message) ? e.message : errors[e?.code] || 'Something went wrong. Please try again.');
const storage = () => { try { return sessionStorage; } catch { return null; } };
const signupProfile = () => validateSignupProfile({ name:$('signup-name').value, company:$('signup-company').value, discovery:$('signup-discovery').value });
function updateControls() {
 const missingSignup = view === 'signup' && !signupProfile();
 $('google-signin').disabled = busy || !auth || missingSignup;
 $('submit-auth').disabled = busy || !auth || missingSignup;
}
function bindSignup(user, profile, provider) {
 pendingSignup = { uid:user.uid, profile, provider };
 savePendingSignup(storage(), pendingSignup);
}
function forgetSignup() { pendingSignup = null; clearPendingSignup(storage()); }
function clearSignupFields() { for (const id of ['signup-name', 'signup-company', 'signup-discovery']) $(id).value = ''; }
function setBusy(value) {
 busy = value; $('auth-fields').disabled = value; $('signup-details').disabled = value;
 $('check-verified').disabled = value; $('resend-verification').disabled = value;
 $('accept-terms').disabled = value; $('decline-terms').disabled = value;
 $('profile-fields').disabled = value; $('cancel-profile').disabled = value;
 $('signin-tab').disabled = value; $('signup-tab').disabled = value; updateControls();
}
function setView(next) {
 view = next; notify(); $('password').value = ''; $('password').type = 'password'; $('show-password').textContent = 'Show'; $('show-password').setAttribute('aria-pressed', 'false');
 const signup = next === 'signup', reset = next === 'reset', verify = next === 'verify', terms = next === 'terms', profile = next === 'profile';
 $('auth-form').hidden = verify || terms || profile; $('verify-view').hidden = !verify; $('terms-view').hidden = !terms; $('profile-view').hidden = !profile;
 $('google-signin').hidden = verify || terms || profile || reset; document.querySelector('.divider').hidden = verify || terms || profile || reset;
 $('auth-tabs').hidden = reset || verify || terms || profile; $('signup-details').hidden = !signup; $('password-row').hidden = reset;
 $('forgot-password').hidden = signup; $('back-to-signin').hidden = !reset;
 $('signin-tab').setAttribute('aria-selected', String(next === 'signin')); $('signup-tab').setAttribute('aria-selected', String(signup));
 $('password').autocomplete = signup ? 'new-password' : 'current-password';
 $('submit-auth').textContent = reset ? 'Send reset link' : signup ? 'Create account' : 'Sign in';
 updateControls();
}
async function continueAfterSignIn() {
 let destination = '/billing.html';
 try {
  const response = await fetch('/api/billing/status', { cache:'no-store' });
  if (response.ok && (await response.json()).hasAccess === true) destination = '/calculator.html';
 } catch { /* The billing page explains outages and offers retry. */ }
 location.replace(destination);
}
async function finish(user, acceptTermsVersion, profile) {
 const idToken = await user.getIdToken(true);
 const response = await fetch('/api/auth/session', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({idToken, acceptTermsVersion, profile}) });
 if (response.status === 409) throw new Error('The terms have changed. Reload this page to review them.');
 if (!response.ok) throw new Error('Session could not be created.');
 const session=await response.json();
 if (session.termsVersion !== TERMS_VERSION) { notify('The terms have changed. Reload this page to review them.'); return; }
 if (!session.termsAccepted) { pendingTermsUser=user; pendingTermsVersion=session.termsVersion; setView('terms'); return; }
 pendingTermsUser=null; pendingTermsVersion=null;
 if (!session.profileComplete && !profile) {
  const saved = pendingForUser(pendingSignup, user.uid) ? pendingSignup : readPendingSignup(storage());
  if (pendingForUser(saved, user.uid)) { pendingSignup = saved; return finish(user, undefined, saved.profile); }
 }
 if (!session.profileComplete) { pendingProfileUser=user; $('profile-name').value ||= user.displayName || ''; setView('profile'); return; }
 pendingProfileUser=null;
 forgetSignup();
 await continueAfterSignIn();
}
$('accept-terms').addEventListener('click', async () => {
 if (busy || !pendingTermsUser || !pendingTermsVersion) return;
 notify(); setBusy(true);
 try { await finish(pendingTermsUser, pendingTermsVersion); } catch (e) { failure(e); } finally { setBusy(false); }
});
async function cancelOnboarding() {
 if (busy) return; setBusy(true);
 try { const response=await fetch('/api/auth/session', { method:'DELETE' }); if (!response.ok) throw new Error('Sign out failed'); if (auth) await signOut(auth); pendingTermsUser=null; pendingTermsVersion=null; pendingProfileUser=null; forgetSignup(); clearSignupFields(); $('profile-form').reset(); setView('signin'); }
 catch (e) { failure(e); } finally { setBusy(false); }
}
$('decline-terms').addEventListener('click', cancelOnboarding);
$('cancel-profile').addEventListener('click', cancelOnboarding);
$('profile-form').addEventListener('submit', async e => {
 e.preventDefault(); if (busy || !pendingProfileUser) return;
 const profile = { name:$('profile-name').value.trim(), company:$('profile-company').value.trim(), discovery:$('profile-discovery').value.trim() };
 if (!profile.name || !profile.company || !profile.discovery) return notify('Enter your name, company, and how you found Scafmetric.');
 notify(); setBusy(true);
 try { await finish(pendingProfileUser, undefined, profile); } catch (err) { failure(err); } finally { setBusy(false); }
});
$('signin-tab').addEventListener('click', () => setView('signin'));
$('signup-tab').addEventListener('click', () => setView('signup'));
for (const id of ['signup-name', 'signup-company', 'signup-discovery']) $(id).addEventListener('input', updateControls);
$('signup-discovery').addEventListener('change', updateControls);
$('forgot-password').addEventListener('click', () => setView('reset'));
$('back-to-signin').addEventListener('click', () => setView('signin'));
$('show-password').addEventListener('click', () => { const p=$('password'), showing=p.type==='password'; p.type=showing?'text':'password'; $('show-password').textContent=showing?'Hide':'Show'; $('show-password').setAttribute('aria-pressed', String(showing)); });
$('google-signin').addEventListener('click', async () => {
 if (busy || !auth) return; notify(); setBusy(true);
 try { const details = view === 'signup' ? signupProfile() : null; if (view === 'signup' && !details) return notify('Enter your name, company, and how you found Scafmetric.');
  const previous=readPendingSignup(storage()); if (!details && previous?.provider === 'google' && previous.uid === null) clearPendingSignup(storage());
  const provider=new GoogleAuthProvider(); provider.setCustomParameters({prompt:'select_account'}); let result;
  try { result=await signInWithPopup(auth,provider); } catch(e) { if (['auth/popup-blocked','auth/operation-not-supported-in-this-environment'].includes(e.code)) { if (details && !savePendingSignup(storage(), {profile:details, provider:'google'})) throw new Error('Your browser could not keep your signup details for Google sign-in. Please allow session storage or use email.'); await signInWithRedirect(auth,provider); return; } throw e; }
  if (details) bindSignup(result.user, details, 'google');
  await finish(result.user);
 } catch(e) { if (!['auth/popup-closed-by-user','auth/cancelled-popup-request'].includes(e.code)) failure(e); } finally { setBusy(false); }
});
$('auth-form').addEventListener('submit', async e => {
 e.preventDefault(); if (busy || !auth) return; notify(); const email=$('email').value.trim().toLowerCase(), password=$('password').value;
 if (!email || email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return notify('Enter a valid email address.');
 if (view !== 'reset' && !password) return notify('Enter your password.');
 if (view === 'signup') {
  if (!signupProfile()) return notify('Enter your name, company, and how you found Scafmetric.');
  if (password.length<8 || password.length>128 || /^(.)\1+$/.test(password) || ['password','password1','password123','12345678','qwerty123','welcome123'].includes(password.toLowerCase())) return notify('Choose a stronger password of 8 to 128 characters.');
  const local=email.split('@')[0]; if (local.length>=4 && password.toLowerCase().includes(local)) return notify("Your password shouldn't contain your email name.");
 }
 setBusy(true);
 try {
  if (view === 'reset') { await sendPasswordResetEmail(auth,email,settings()).catch(err=>{if(err.code!=='auth/user-not-found') throw err}); notify(`If an account exists for ${email}, we've sent a link to reset the password.`); }
  else if (view === 'signup') { const details=signupProfile(); const result=await createUserWithEmailAndPassword(auth,email,password); bindSignup(result.user, details, 'email'); await updateProfile(result.user,{displayName:details.name}).catch(()=>{}); $('verify-address').textContent=email; setView('verify'); try { await sendEmailVerification(result.user,settings()); } catch { notify('Your account was created, but the verification email could not be sent. Please select Resend the email.'); } }
  else { const result=await signInWithEmailAndPassword(auth,email,password); if(!result.user.emailVerified) { await sendEmailVerification(result.user,settings()).catch(()=>{}); $('verify-address').textContent=email; setView('verify'); notify('Your email is not verified yet. Check for a verification link.'); } else await finish(result.user); }
 } catch(err) { failure(err); } finally { setBusy(false); }
});
$('check-verified').addEventListener('click', async()=>{if(!auth?.currentUser)return setView('signin');setBusy(true);try{await auth.currentUser.reload();if(!auth.currentUser.emailVerified)notify('Verification not seen yet. Open the link in your email and try again.');else await finish(auth.currentUser);}catch(e){failure(e)}finally{setBusy(false)}});
$('resend-verification').addEventListener('click',async()=>{if(!auth?.currentUser)return setView('signin');setBusy(true);try{await sendEmailVerification(auth.currentUser,settings());notify('A new verification link was sent. Check your spam folder too.')}catch(e){failure(e)}finally{setBusy(false)}});
$('start-over').addEventListener('click',async()=>{if(auth)await signOut(auth).catch(()=>{});forgetSignup();clearSignupFields();$('email').value='';setView('signup')});
async function initialize() {
 try {
  const [configResponse,serverResponse]=await Promise.all([fetch('/auth-config.json',{cache:'no-store'}),fetch('/api/auth/session',{cache:'no-store'})]);
  if(!configResponse.ok || !serverResponse.ok) return;
  const config=await configResponse.json(), server=await serverResponse.json();
  if(!config.apiKey || !config.authDomain || !config.projectId || !server.configured) return;
  auth=getAuth(initializeApp(config)); $('config-notice').hidden=true; setBusy(false);
  const result=await getRedirectResult(auth); if(result?.user) {setBusy(true);try { const saved=readPendingSignup(storage()); if(saved?.provider === 'google' && saved.uid === null) bindSignup(result.user, saved.profile, 'google'); await finish(result.user); } finally { setBusy(false); }}
  else { await auth.authStateReady(); const saved=readPendingSignup(storage()), user=auth.currentUser; if(saved?.provider === 'email' && pendingForUser(saved,user?.uid)) { pendingSignup=saved; if(user.emailVerified) {setBusy(true);try{await finish(user)}finally{setBusy(false)}} else {$('verify-address').textContent=user.email || '';setView('verify')} } else if (server.authenticated && server.termsAccepted && server.profileComplete) await continueAfterSignIn(); }
 } catch(e) { if(auth) { failure(e); setBusy(false); } }
}
initialize();
