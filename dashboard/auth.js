import { createAuthClient } from '@neondatabase/auth';

const config = window.READYFOR_CONFIG ?? {};
const root = document.querySelector('#auth-root');
const shell = document.querySelector('.app-shell');
const invitationToken = new URL(location.href).searchParams.get('invite');
let client;
let identity;
let invitation;
let currentEmail = '';
let resolveAccess;
let busy = false;

const escape = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const roleLabel = (role) => ({ admin: 'Clinic administrator', coordinator: 'Care coordinator', nurse: 'Nurse', surgeon: 'Surgeon' })[role] ?? role;

export async function getAccessToken() {
  if (!client) return null;
  const { data, error } = await client.token();
  if (error || !data?.token) throw new Error('Your session has expired. Sign in again to continue.');
  return data.token;
}

async function api(path, body, { authenticated = true } = {}) {
  const token = authenticated ? await getAccessToken() : null;
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message ?? 'We could not complete this request. Please try again.');
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
    frame('We could not complete sign-in', 'Refresh the page and try again. Your account does not grant access until staff membership is confirmed.', '<button class="primary-button" id="retry-signin">Try again</button>');
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

function accountForm(signUp = false) {
  const email = invitation?.email ?? currentEmail;
  frame(signUp ? 'Join your care team' : 'Welcome back', invitation
    ? `${invitation.clinicName} invited you to join as ${roleLabel(invitation.role).toLowerCase()}.`
    : 'Sign in with your staff account. Patient replies continue through iMessage.',
  `<form id="auth-form" class="auth-form">${signUp ? '<label>Your name<input name="name" autocomplete="name" required maxlength="100" /></label>' : ''}
    <label>Work email<input name="email" type="email" autocomplete="email" value="${escape(email)}" ${invitation ? 'readonly' : ''} required maxlength="254" /></label>
    <label>Password<input name="password" type="password" autocomplete="${signUp ? 'new-password' : 'current-password'}" minlength="8" maxlength="128" required /></label>
    <button class="primary-button auth-submit" type="submit">${signUp ? 'Create account' : 'Sign in'}</button></form>
    <button class="auth-link" id="switch-account">${signUp ? 'Already have an account? Sign in' : 'Create a staff account'}</button>
    ${!signUp ? '<button class="auth-link" id="recover-password">Forgot your password?</button>' : ''}
    ${!invitation ? '<button class="auth-link" id="request-access">Need an invitation? Request access</button>' : ''}`);
  formHandler(async (values) => {
    currentEmail = values.get('email').trim();
    if (signUp) {
      checkResult(await client.signUp.email({ email: currentEmail, password: values.get('password'), name: values.get('name').trim() }));
      await verificationForm();
    } else {
      const result = await client.signIn.email({ email: currentEmail, password: values.get('password') });
      if (result.error?.code === 'EMAIL_NOT_VERIFIED') { await verificationForm(); return; }
      checkResult(result);
      await restoreAccess();
    }
  });
  document.querySelector('#switch-account').onclick = () => accountForm(!signUp);
  document.querySelector('#request-access')?.addEventListener('click', requestAccessForm);
  document.querySelector('#recover-password')?.addEventListener('click', recoveryForm);
}

async function verificationForm() {
  frame('Verify your work email', `Enter the verification code sent to ${currentEmail}.`,
    '<form id="auth-form" class="auth-form"><label>Verification code<input name="otp" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required /></label><button class="primary-button auth-submit" type="submit">Verify email</button></form><button class="auth-link" id="resend-code">Send a new code</button><button class="auth-link" id="back-signin">Back to sign in</button>');
  formHandler(async (values) => {
    checkResult(await client.emailOtp.verifyEmail({ email: currentEmail, otp: values.get('otp') }));
    accountForm(false);
    document.querySelector('.auth-copy').textContent = 'Email verified. Sign in to finish joining your team.';
  });
  document.querySelector('#resend-code').onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      checkResult(await client.emailOtp.sendVerificationOtp({ email: currentEmail, type: 'email-verification' }));
      button.textContent = 'New code sent';
    } catch (error) { showError(error); }
    finally { button.disabled = false; }
  };
  document.querySelector('#back-signin').onclick = () => accountForm(false);
}

function recoveryForm() {
  frame('Reset your password', 'We will send a recovery code to your work email.',
    `<form id="auth-form" class="auth-form"><label>Work email<input name="email" type="email" autocomplete="email" value="${escape(currentEmail)}" required /></label><button class="primary-button auth-submit" type="submit">Send recovery code</button></form><button class="auth-link" id="back-signin">Back to sign in</button>`);
  formHandler(async (values) => {
    currentEmail = values.get('email').trim();
    checkResult(await client.forgetPassword.emailOtp({ email: currentEmail }));
    frame('Choose a new password', 'If an account exists for that email, a recovery code has been sent.',
      '<form id="auth-form" class="auth-form"><label>Recovery code<input name="otp" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" required /></label><label>New password<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required /></label><button class="primary-button auth-submit" type="submit">Reset password</button></form>');
    formHandler(async (newValues) => {
      checkResult(await client.emailOtp.resetPassword({ email: currentEmail, otp: newValues.get('otp'), password: newValues.get('password') }));
      accountForm(false);
      document.querySelector('.auth-copy').textContent = 'Password updated. Sign in to continue.';
    });
  });
  document.querySelector('#back-signin').onclick = () => accountForm(false);
}

function requestAccessForm() {
  frame('Request a staff invitation', 'Your clinic administrator will review your request. Submitting it does not grant access to surgery records.',
    '<form id="auth-form" class="auth-form"><label>Your name<input name="name" autocomplete="name" maxlength="100" required /></label><label>Work email<input name="email" type="email" autocomplete="email" maxlength="254" required /></label><label>Message to the administrator<textarea name="note" maxlength="500" rows="3"></textarea></label><button class="primary-button auth-submit" type="submit">Request access</button></form><button class="auth-link" id="back-signin">Back to sign in</button>');
  formHandler(async (values) => {
    await api('/auth/access-requests', { name: values.get('name').trim(), email: values.get('email').trim(), note: values.get('note').trim() }, { authenticated: false });
    frame('Request received', 'Ask your clinic administrator to review your request and send an invitation.', '<button class="primary-button" id="back-signin">Back to sign in</button>');
    document.querySelector('#back-signin').onclick = () => accountForm(false);
  });
  document.querySelector('#back-signin').onclick = () => accountForm(false);
}

async function restoreAccess() {
  const session = checkResult(await client.getSession());
  if (!session?.user) { accountForm(Boolean(invitation)); return; }
  currentEmail = session.user.email;
  if (!session.user.emailVerified) { await verificationForm(); return; }
  identity = await api('/auth/me');
  if (invitation) {
    await api(`/auth/invitations/${encodeURIComponent(invitationToken)}/accept`, {});
    invitation = undefined;
    history.replaceState(null, '', '/');
    identity = await api('/auth/me');
  }
  if (!identity.membership) {
    frame('Your account is ready', 'You need a staff invitation before you can view surgery records.',
      `${identity.canBootstrap ? '<button class="primary-button" id="activate-clinic">Activate clinic administration</button>' : ''}<button class="auth-link" id="request-access">Request access</button><button class="auth-link" id="sign-out">Sign out</button>`);
    document.querySelector('#activate-clinic')?.addEventListener('click', async () => {
      try { await api('/auth/bootstrap', {}); await restoreAccess(); } catch (error) { showError(error); }
    });
    document.querySelector('#request-access').onclick = requestAccessForm;
    document.querySelector('#sign-out').onclick = signOut;
    return;
  }
  if (!identity.membership.onboardedAt) { orientation(); return; }
  grantAccess();
}

function orientation() {
  frame(`Welcome to ${identity.membership.clinicName}`, 'Three things to know before your first surgery review.',
    '<ol class="orientation-list"><li><strong>Readiness follows rules.</strong><p>Ready, needs attention, and at risk reflect the current blockers and time before surgery.</p></li><li><strong>Evidence needs staff review.</strong><p>A patient photo can supply evidence. Verify its details before clearing a requirement.</p></li><li><strong>Your actions are accountable.</strong><p>Approvals and task changes record your signed-in identity. Medication wording comes from staff-approved templates.</p></li></ol><form id="auth-form"><button class="primary-button auth-submit" type="submit">Open my dashboard</button></form>');
  formHandler(async () => { await api('/auth/onboarding', {}); grantAccess(); });
}

function grantAccess() {
  root.hidden = true;
  shell.hidden = false;
  const name = identity.user.name || identity.user.email;
  document.querySelector('.user-card strong').textContent = name;
  document.querySelector('.user-card small').textContent = roleLabel(identity.membership.role);
  document.querySelector('.avatar').textContent = name.split(/\s+/).map((word) => word[0]).slice(0, 2).join('').toUpperCase();
  document.querySelector('.page-heading h1').textContent = `Welcome, ${name.split(' ')[0]}`;
  const signout = document.querySelector('#staff-signout');
  signout.hidden = false;
  signout.onclick = signOut;
  const inviteButton = document.querySelector('#invite-staff');
  inviteButton.hidden = identity.membership.role !== 'admin';
  inviteButton.onclick = openStaffInvitation;
  document.querySelector('#reset-demo').hidden = identity.membership.role !== 'admin';
  resolveAccess(identity);
}

async function signOut() {
  try { checkResult(await client.signOut()); location.assign('/'); } catch (error) { showError(error); }
}

export function initStaffAccess() {
  const promise = new Promise((resolve) => { resolveAccess = resolve; });
  (async () => {
    if (config.demoMode) {
      root.hidden = true;
      shell.hidden = false;
      resolveAccess({ user: { name: 'Jordan Davis', email: 'demo@example.invalid' }, membership: { role: 'admin' }, demo: true });
      return;
    }
    if (!config.authConfigured) {
      frame('Staff sign-in is being configured', 'Your clinic administrator needs to connect Neon Auth and enable staff access in the core service before accounts can join.', '');
      return;
    }
    frame('Checking staff access', 'Please wait while we restore your session.', '');
    client = createAuthClient(`${location.origin}/auth/provider`);
    if (invitationToken) {
      try { invitation = await api(`/auth/invitations/${encodeURIComponent(invitationToken)}`, undefined, { authenticated: false }); }
      catch { frame('This invitation is unavailable', 'It may have expired or already been accepted. Ask your clinic administrator for a new invitation.', '<button class="primary-button" id="request-access">Request access</button>'); document.querySelector('#request-access').onclick = requestAccessForm; return; }
    }
    await restoreAccess();
  })().catch(showError);
  return promise;
}

export async function openStaffInvitation() {
  if (identity?.membership?.role !== 'admin') return;
  frame('Invite a care-team member', 'Create an invitation link for the correct work email and role. Share the link directly with that colleague.',
    '<form id="auth-form" class="auth-form"><label>Work email<input name="email" type="email" maxlength="254" required /></label><label>Staff role<select name="role"><option value="coordinator">Care coordinator</option><option value="nurse">Nurse</option><option value="surgeon">Surgeon</option><option value="admin">Clinic administrator</option></select></label><button class="primary-button auth-submit" type="submit">Create invitation</button></form><button class="auth-link" id="return-dashboard">Back to dashboard</button>');
  document.querySelector('#return-dashboard').onclick = grantAccess;
  formHandler(async (values) => {
    const result = await api('/auth/invitations', { email: values.get('email').trim(), role: values.get('role') });
    const link = new URL('/', location.origin);
    link.searchParams.set('invite', result.token);
    frame('Invitation ready', 'Copy this link and share it with your colleague. It expires in seven days.',
      `<label class="auth-form">Invitation link<input readonly value="${escape(link.href)}" id="invitation-link" /></label><button class="primary-button" id="copy-invitation">Copy invitation</button><button class="auth-link" id="return-dashboard">Back to dashboard</button>`);
    document.querySelector('#copy-invitation').onclick = async (event) => {
      const button = event.currentTarget;
      try { await navigator.clipboard.writeText(link.href); button.textContent = 'Copied'; } catch { document.querySelector('#invitation-link').select(); }
    };
    document.querySelector('#return-dashboard').onclick = grantAccess;
  });
}
