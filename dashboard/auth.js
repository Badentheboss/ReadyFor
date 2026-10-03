import { createAuthClient } from '@neondatabase/auth';

const config = window.READYFOR_CONFIG ?? {};
const root = document.querySelector('#auth-root');
const shell = document.querySelector('.app-shell');
let client;
let staff;
let currentEmail = '';
let resolveAccess;
let busy = false;
let authenticationNeeded = false;
let accessGranted = false;

const escape = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const roleLabel = (role) => ({ admin: 'Clinic administrator', coordinator: 'Care coordinator', nurse: 'Nurse', surgeon: 'Surgeon' })[role] ?? role;

export async function getAccessToken(refresh = false) {
  if (config.demoMode) return null;
  if (!client || authenticationNeeded) throw new Error('Sign in to continue.');
  try {
    const { data, error } = await client.token(refresh ? { fetchOptions: { headers: { 'X-Force-Fetch': '1' } } } : undefined);
    if (error || !data?.token) throw new Error('Your session has expired. Sign in again to continue.');
    return data.token;
  } catch (error) { requireSignIn(); throw error; }
}

export function requireSignIn() {
  authenticationNeeded = true;
  accountForm(false);
  document.querySelector('.auth-copy').textContent = 'Your session has expired. Sign in again to continue.';
}

export function hasStaffAccess() { return config.demoMode || (Boolean(staff) && !authenticationNeeded); }

async function api(path) {
  const token = await getAccessToken();
  let response = await fetch(`${config.apiBaseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401) {
    const refreshed = await getAccessToken(true);
    response = await fetch(`${config.apiBaseUrl}${path}`, { headers: { authorization: `Bearer ${refreshed}` } });
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) requireSignIn();
    throw Object.assign(new Error(result?.error?.message ?? 'We could not complete this request. Please try again.'), { status: response.status });
  }
  return result;
}

function frame(title, copy, contents) {
  root.hidden = false;
  shell.hidden = true;
  root.innerHTML = `<div class="auth-layout"><aside class="auth-story"><a class="brand" href="/"> <span class="brand-mark">R</span> readyfor</a><div><span class="eyebrow">CARE COORDINATION</span><h1>Get ahead of<br>surgery day.</h1><p>Bring the care team, preparation evidence, and next steps together.</p><ol><li>Catch preparation blockers early</li><li>Give every follow-up an owner</li><li>Keep staff in control of approvals</li></ol></div><small>Synthetic-data demonstration</small></aside><main class="auth-main"><div class="auth-card"><h2>${escape(title)}</h2><p class="auth-copy">${escape(copy)}</p><div id="auth-error" class="auth-error" role="alert" hidden></div>${contents}</div></main></div>`;
}

function showError(error) {
  let target = document.querySelector('#auth-error');
  if (!target || root.hidden) {
    frame('We could not complete sign-in', 'Refresh the page and try again. Staff access must be confirmed before surgery records can be viewed.', '<button class="primary-button" id="retry-signin">Try again</button>');
    document.querySelector('#retry-signin').onclick = () => location.reload();
    target = document.querySelector('#auth-error');
  }
  target.textContent = error?.message ?? String(error);
  target.hidden = false;
}

function formHandler(handler) {
  document.querySelector('#auth-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const button = event.currentTarget.querySelector('[type="submit"]');
    const previous = button.textContent;
    button.disabled = true;
    button.textContent = 'Please wait…';
    try { await handler(new FormData(event.currentTarget)); }
    catch (error) { showError(error); }
    finally { busy = false; button.disabled = false; button.textContent = previous; }
  });
}

function checkResult(result) {
  if (result.error) throw new Error(result.error.message ?? 'Please check your details and try again.');
  return result.data;
}
const unverified = (error) => ['EMAIL_NOT_VERIFIED', 'email_not_confirmed'].includes(error?.code);

function accountForm(signUp = false) {
  frame(signUp ? 'Create your staff account' : 'Welcome back', signUp
    ? 'Create an account and verify your work email. Your clinic administrator must add you to the staff list before you can view surgeries.'
    : 'Sign in with your staff account. Patient replies continue through iMessage.',
  `<form id="auth-form" class="auth-form">${signUp ? '<label>Your name<input name="name" autocomplete="name" required maxlength="100" /></label>' : ''}
    <label>Work email<input name="email" type="email" autocomplete="email" value="${escape(currentEmail)}" required maxlength="254" /></label>
    <label>Password<input name="password" type="password" autocomplete="${signUp ? 'new-password' : 'current-password'}" minlength="8" maxlength="128" required /></label>
    <button class="primary-button auth-submit" type="submit">${signUp ? 'Create account' : 'Sign in'}</button></form>
    <button class="auth-link" id="switch-account">${signUp ? 'Already have an account? Sign in' : 'Create a staff account'}</button>
    ${!signUp ? '<button class="auth-link" id="recover-password">Forgot your password?</button>' : ''}`);
  formHandler(async (values) => {
    currentEmail = values.get('email').trim();
    if (signUp) {
      checkResult(await client.signUp.email({ email: currentEmail, password: values.get('password'), name: values.get('name').trim() }));
      await verificationForm(true);
    } else {
      let result;
      try { result = await client.signIn.email({ email: currentEmail, password: values.get('password') }); }
      catch (error) { if (unverified(error)) { await verificationForm(true); return; } throw error; }
      if (unverified(result.error)) { await verificationForm(true); return; }
      checkResult(result);
      authenticationNeeded = false;
      await restoreAccess();
    }
  });
  document.querySelector('#switch-account').onclick = () => accountForm(!signUp);
  document.querySelector('#recover-password')?.addEventListener('click', recoveryForm);
}

async function verificationForm(sendCode = false) {
  frame('Verify your work email', `Enter the verification code for ${currentEmail}.`,
    '<form id="auth-form" class="auth-form"><label>Verification code<input name="otp" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required /></label><button class="primary-button auth-submit" type="submit">Verify email</button></form><button class="auth-link" id="resend-code">Send a new code</button><button class="auth-link" id="back-signin">Back to sign in</button>');
  const send = async () => checkResult(await client.emailOtp.sendVerificationOtp({ email: currentEmail, type: 'email-verification' }));
  formHandler(async (values) => {
    checkResult(await client.emailOtp.verifyEmail({ email: currentEmail, otp: values.get('otp') }));
    accountForm(false);
    document.querySelector('.auth-copy').textContent = 'Email verified. Sign in to continue.';
  });
  document.querySelector('#resend-code').onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await send(); button.textContent = 'New code sent'; } catch (error) { showError(error); }
    finally { button.disabled = false; }
  };
  document.querySelector('#back-signin').onclick = () => accountForm(false);
  if (sendCode) { try { await send(); } catch (error) { showError(error); } }
}

function recoveryForm() {
  frame('Reset your password', 'We will send a recovery code to your work email.',
    `<form id="auth-form" class="auth-form"><label>Work email<input name="email" type="email" autocomplete="email" value="${escape(currentEmail)}" required /></label><button class="primary-button auth-submit" type="submit">Send recovery code</button></form><button class="auth-link" id="back-signin">Back to sign in</button>`);
  formHandler(async (values) => {
    currentEmail = values.get('email').trim();
    checkResult(await client.forgetPassword.emailOtp({ email: currentEmail }));
    frame('Choose a new password', 'If an account exists for that email, a recovery code has been sent.',
      '<form id="auth-form" class="auth-form"><label>Recovery code<input name="otp" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required /></label><label>New password<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required /></label><button class="primary-button auth-submit" type="submit">Reset password</button></form>');
    formHandler(async (newValues) => {
      checkResult(await client.emailOtp.resetPassword({ email: currentEmail, otp: newValues.get('otp'), password: newValues.get('password') }));
      accountForm(false);
      document.querySelector('.auth-copy').textContent = 'Password updated. Sign in to continue.';
    });
  });
  document.querySelector('#back-signin').onclick = () => accountForm(false);
}

async function restoreAccess() {
  const session = checkResult(await client.getSession());
  if (!session?.user) { accountForm(false); return; }
  currentEmail = session.user.email;
  if (!session.user.emailVerified) { await verificationForm(true); return; }
  let caller;
  try { caller = await api('/me'); }
  catch (error) {
    if (error.status !== 403) throw error;
    frame('Your account is ready', 'Your verified account needs to be added to the clinic staff list. Ask your administrator to approve this work email before you can view surgery records.', '<button class="primary-button" id="sign-out">Sign out</button>');
    document.querySelector('#sign-out').onclick = signOut;
    return;
  }
  if (caller.auth !== 'neon' || caller.identity?.kind !== 'staff') throw new Error('The core service did not confirm staff access.');
  staff = { user: { id: caller.identity.userId, name: caller.identity.name, email: currentEmail },
    membership: { role: caller.identity.role }, actor: caller.actor };
  grantAccess();
}

function grantAccess() {
  if (accessGranted) { location.reload(); return; }
  accessGranted = true;
  root.hidden = true;
  shell.hidden = false;
  document.querySelector('.user-card strong').textContent = staff.user.name;
  document.querySelector('.user-card small').textContent = roleLabel(staff.membership.role);
  document.querySelector('.avatar').textContent = staff.user.name.split(/\s+/).map((word) => word[0]).slice(0, 2).join('').toUpperCase();
  document.querySelector('.page-heading h1').textContent = `Welcome, ${staff.user.name.split(' ')[0]}`;
  const signout = document.querySelector('#staff-signout');
  signout.hidden = false;
  signout.onclick = signOut;
  document.querySelector('#reset-demo').hidden = staff.membership.role !== 'admin';
  resolveAccess(staff);
  window.dispatchEvent(new CustomEvent('readyfor:staff-access', { detail: staff }));
}

async function signOut() {
  authenticationNeeded = true;
  shell.hidden = true;
  try { checkResult(await client.signOut()); location.assign('/'); } catch (error) { showError(error); }
}

export function initStaffAccess() {
  const promise = new Promise((resolve) => { resolveAccess = resolve; });
  (async () => {
    if (config.demoMode) {
      root.hidden = true;
      shell.hidden = false;
      staff = { user: { name: 'Jordan Davis', email: 'demo@example.invalid' }, membership: { role: 'admin' }, demo: true };
      resolveAccess(staff);
      return;
    }
    if (!config.authConfigured) {
      frame('Staff sign-in is being configured', 'Your clinic administrator needs to connect Neon Auth and enable staff access in the core service before accounts can join.', '');
      return;
    }
    frame('Checking staff access', 'Please wait while we restore your session.', '');
    client = createAuthClient(`${location.origin}/auth/provider`);
    await restoreAccess();
  })().catch(showError);
  return promise;
}
