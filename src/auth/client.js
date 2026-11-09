import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail, updateProfile, signOut } from 'firebase/auth';

const $ = id => document.getElementById(id);
let auth, view = 'signin', busy = false;
const settings = () => ({ url: `${location.origin}/signin.html`, handleCodeInApp: false });
const notify = (message = '') => { $('auth-status').textContent = message; $('auth-status').hidden = !message; };
const errors = {
 'auth/invalid-credential': 'Incorrect email or password.', 'auth/invalid-email': 'Enter a valid email address.',
 'auth/email-already-in-use': 'An account with this email already exists. Sign in, continue with Google, or reset your password.',
 'auth/weak-password': 'Choose a stronger password of at least 8 characters.', 'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
 'auth/network-request-failed': "We couldn't reach the server. Check your connection and try again.", 'auth/unauthorized-domain': "Sign-in isn't enabled for this web address.",
 'auth/operation-not-allowed': "This sign-in method isn't available right now.", 'auth/user-disabled': 'This account has been disabled.'
};
const failure = e => notify(errors[e?.code] || 'Something went wrong. Please try again.');
function setBusy(value) {
 busy = value; $('auth-fields').disabled = value; $('google-signin').disabled = value;
 $('check-verified').disabled = value; $('resend-verification').disabled = value;
}
function setView(next) {
 view = next; notify(); $('password').value = ''; $('password').type = 'password'; $('show-password').textContent = 'Show'; $('show-password').setAttribute('aria-pressed', 'false');
 const signup = next === 'signup', reset = next === 'reset', verify = next === 'verify';
 $('auth-form').hidden = verify; $('verify-view').hidden = !verify;
 $('signin-tab').parentElement.hidden = reset; $('name-row').hidden = !signup; $('password-row').hidden = reset; $('terms-row').hidden = !signup;
 $('forgot-password').hidden = signup; $('back-to-signin').hidden = !reset;
 $('signin-tab').setAttribute('aria-selected', String(next === 'signin')); $('signup-tab').setAttribute('aria-selected', String(signup));
 $('password').autocomplete = signup ? 'new-password' : 'current-password';
 $('submit-auth').textContent = reset ? 'Send reset link' : signup ? 'Create account' : 'Sign in';
}
async function finish(user) {
 const idToken = await user.getIdToken(true);
 const response = await fetch('/api/auth/session', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({idToken}) });
 if (!response.ok) throw new Error('Session could not be created.');
 location.replace('/calculator.html');
}
$('signin-tab').addEventListener('click', () => setView('signin'));
$('signup-tab').addEventListener('click', () => setView('signup'));
$('forgot-password').addEventListener('click', () => setView('reset'));
$('back-to-signin').addEventListener('click', () => setView('signin'));
$('show-password').addEventListener('click', () => { const p=$('password'), showing=p.type==='password'; p.type=showing?'text':'password'; $('show-password').textContent=showing?'Hide':'Show'; $('show-password').setAttribute('aria-pressed', String(showing)); });
$('google-signin').addEventListener('click', async () => {
 if (busy || !auth) return; notify(); setBusy(true);
 try { const provider=new GoogleAuthProvider(); provider.setCustomParameters({prompt:'select_account'}); let result;
  try { result=await signInWithPopup(auth,provider); } catch(e) { if (['auth/popup-blocked','auth/operation-not-supported-in-this-environment'].includes(e.code)) { await signInWithRedirect(auth,provider); return; } throw e; }
  await finish(result.user);
 } catch(e) { if (!['auth/popup-closed-by-user','auth/cancelled-popup-request'].includes(e.code)) failure(e); setBusy(false); }
});
$('auth-form').addEventListener('submit', async e => {
 e.preventDefault(); if (busy || !auth) return; notify(); const email=$('email').value.trim().toLowerCase(), password=$('password').value;
 if (!email || email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return notify('Enter a valid email address.');
 if (view !== 'reset' && !password) return notify('Enter your password.');
 if (view === 'signup') {
  if (!$('name').value.trim()) return notify('Enter your name.');
  if (password.length<8 || password.length>128 || /^(.)\1+$/.test(password) || ['password','password1','password123','12345678','qwerty123','welcome123'].includes(password.toLowerCase())) return notify('Choose a stronger password of 8 to 128 characters.');
  const local=email.split('@')[0]; if (local.length>=4 && password.toLowerCase().includes(local)) return notify("Your password shouldn't contain your email name.");
  if (!$('terms').checked) return notify('Please agree to the terms of use to create an account.');
 }
 setBusy(true);
 try {
  if (view === 'reset') { await sendPasswordResetEmail(auth,email,settings()).catch(err=>{if(err.code!=='auth/user-not-found') throw err}); notify(`If an account exists for ${email}, we've sent a link to reset the password.`); }
  else if (view === 'signup') { const result=await createUserWithEmailAndPassword(auth,email,password); await updateProfile(result.user,{displayName:$('name').value.trim()}).catch(()=>{}); await sendEmailVerification(result.user,settings()); $('verify-address').textContent=email; setView('verify'); }
  else { const result=await signInWithEmailAndPassword(auth,email,password); if(!result.user.emailVerified) { await sendEmailVerification(result.user,settings()).catch(()=>{}); $('verify-address').textContent=email; setView('verify'); notify('Your email is not verified yet. Check for a verification link.'); } else await finish(result.user); }
 } catch(err) { failure(err); } finally { setBusy(false); }
});
$('check-verified').addEventListener('click', async()=>{if(!auth?.currentUser)return setView('signin');setBusy(true);try{await auth.currentUser.reload();if(!auth.currentUser.emailVerified)notify('Verification not seen yet. Open the link in your email and try again.');else await finish(auth.currentUser);}catch(e){failure(e)}finally{setBusy(false)}});
$('resend-verification').addEventListener('click',async()=>{if(!auth?.currentUser)return setView('signin');setBusy(true);try{await sendEmailVerification(auth.currentUser,settings());notify('A new verification link was sent. Check your spam folder too.')}catch(e){failure(e)}finally{setBusy(false)}});
$('start-over').addEventListener('click',async()=>{if(auth)await signOut(auth).catch(()=>{});$('email').value='';setView('signup')});
async function initialize() {
 try {
  const [configResponse,serverResponse]=await Promise.all([fetch('/auth-config.json',{cache:'no-store'}),fetch('/api/auth/session',{cache:'no-store'})]);
  if(!configResponse.ok || !serverResponse.ok) return;
  const config=await configResponse.json(), server=await serverResponse.json();
  if(!config.apiKey || !config.authDomain || !config.projectId || !server.configured) return;
  auth=getAuth(initializeApp(config)); $('config-notice').hidden=true; setBusy(false);
  const result=await getRedirectResult(auth); if(result?.user) {setBusy(true);await finish(result.user)}
 } catch(e) { if(auth) { failure(e); setBusy(false); } }
}
initialize();
