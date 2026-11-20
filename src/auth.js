// Only known, user-safe messages are shown. Never render provider error text,
// which can include infrastructure details or user-supplied data.
export function authErrorMessage(error, action = 'login') {
  const code = error?.code;
  const messages = {
    over_email_send_rate_limit: 'Interoom has temporarily reached its email sending limit. Please try again later. If you already confirmed your email, you can still sign in.',
    over_request_rate_limit: 'Too many attempts. Please wait a few minutes before trying again.',
    email_cooldown: 'Please wait before requesting another email. Check your inbox and spam folder for the most recent message.',
    email_request_pending: 'An email request is already in progress. Please wait.',
    invalid_credentials: 'The email or password is incorrect. Try again, or use “Forgot password?” to reset it.',
    email_not_confirmed: 'Confirm your email before signing in. Check your inbox and spam folder, or choose “Resend verification email”.',
    email_address_invalid: 'Enter a valid email address.',
    validation_failed: 'Check your email address and the required fields, then try again.',
    weak_password: 'Choose a stronger password with at least 8 characters. Avoid common or previously exposed passwords.',
    same_password: 'Choose a password you haven’t used for this account before.',
    passwords_do_not_match: 'The passwords don’t match. Enter the same new password in both fields.',
    otp_expired: 'This email link has expired or has already been used. Request a new link and open the newest email.',
    flow_state_expired: 'This email link has expired. Request a new link and open it in the same browser.',
    flow_state_not_found: 'Open the newest email link in the same browser where you requested it, or request a new link here.',
    bad_code_verifier: 'Open the newest email link in the same browser where you requested it, or request a new link here.',
    pkce_code_verifier_not_found: 'Open the newest email link in the same browser where you requested it, or request a new link here.',
    session_not_found: 'Your session has expired. Sign in again, or request a new password reset link.',
    refresh_token_not_found: 'Your session has expired. Please sign in again.',
    refresh_token_already_used: 'Your session has expired. Please sign in again.',
    signup_disabled: 'New registrations are temporarily unavailable. Please try again later.',
    email_provider_disabled: 'Email sign-in is temporarily unavailable. Please try again later.',
    email_address_not_authorized: 'We couldn’t send an email to this address right now. Please try again later.',
    captcha_failed: 'The security check failed. Please try again.',
    request_timeout: 'The request timed out. Check your connection before trying again.',
  };
  // Avoid revealing whether an account exists through reset/resend responses.
  if (['user_already_exists', 'email_exists', 'user_not_found'].includes(code)) {
    return 'We couldn’t complete this request. Try signing in, or use “Forgot password?” if you have an account.';
  }
  if (Object.hasOwn(messages, code)) return messages[code];
  if (error?.status === 429) return messages.over_request_rate_limit;
  if (error?.status >= 500) return 'Interoom’s sign-in service is temporarily unavailable. Please try again later.';
  if (error?.name === 'AuthRetryableFetchError' || error?.status === 0) {
    return 'We couldn’t reach Interoom. Check your internet connection and try again.';
  }
  if (action === 'profile') return 'Couldn’t save your profile. Please try again.';
  if (['signup', 'reset', 'verify'].includes(action)) return 'Couldn’t complete the email request. Please try again later.';
  if (action === 'password') return 'Couldn’t update your password. Request a new reset link and try again.';
  return 'Couldn’t sign in right now. Please try again.';
}

export const EMAIL_COOLDOWN_SECONDS = 60;
const cooldownKey = 'interoom.auth.email-next-at';

// A convenience guard, not a security boundary. Supabase enforces actual limits.
// Store only a timestamp, never an email, password, token, or provider error.
export function createEmailRequestGate({ storage = () => globalThis.sessionStorage, now = Date.now } = {}) {
  let nextAt = 0;
  let pending = false;
  function remainingSeconds() {
    try {
      const saved = Number(storage()?.getItem(cooldownKey));
      if (Number.isFinite(saved) && saved <= now() + EMAIL_COOLDOWN_SECONDS * 1000) nextAt = Math.max(nextAt, saved);
    } catch { /* Private browsing can disable storage. Keep the in-memory guard. */ }
    return Math.max(0, Math.ceil((nextAt - now()) / 1000));
  }
  function startCooldown() {
    nextAt = now() + EMAIL_COOLDOWN_SECONDS * 1000;
    try { storage()?.setItem(cooldownKey, String(nextAt)); } catch { /* In-memory fallback. */ }
  }
  async function run(request) {
    if (pending) throw Object.assign(new Error(), { code: 'email_request_pending' });
    if (remainingSeconds()) throw Object.assign(new Error(), { code: 'email_cooldown' });
    pending = true;
    try {
      const result = await request();
      if (result.error) throw result.error;
      startCooldown();
      return result;
    } catch (error) {
      // The client cannot know when a project-wide limit clears. This pause
      // discourages repeats; the UI does not promise delivery after it expires.
      if (error?.status === 429 || ['over_email_send_rate_limit', 'over_request_rate_limit'].includes(error?.code)) startCooldown();
      throw error;
    } finally { pending = false; }
  }
  return { run, remainingSeconds };
}

export const emailRequests = createEmailRequestGate();

export function authEmailRedirect(origin, mode) {
  const url = new URL('/', origin);
  if (mode === 'reset') url.searchParams.set('reset', '1');
  return url.href;
}

export function sendAuthEmail(auth, mode, { email, password, profile, origin }, gate = emailRequests) {
  const address = email.trim();
  const redirect = authEmailRedirect(origin, mode);
  if (mode === 'signup') return gate.run(() => auth.signUp({ email: address, password, options: { emailRedirectTo: redirect, data: profile } }));
  if (mode === 'reset') return gate.run(() => auth.resetPasswordForEmail(address, { redirectTo: redirect }));
  if (mode === 'verify') return gate.run(() => auth.resend({ type: 'signup', email: address, options: { emailRedirectTo: redirect } }));
  throw new Error('Unsupported email action');
}

export function authCallbackFailure(url, error, session) {
  const query = url.searchParams;
  const hash = new URLSearchParams(url.hash.slice(1));
  const hasError = ['error', 'error_code', 'error_description'].some(key => query.has(key) || hash.has(key));
  const recovery = query.get('reset') === '1' || hash.get('type') === 'recovery';
  const callback = recovery || query.has('code') || hash.has('access_token') || hasError;
  if (!error && !hasError && !(callback && !session)) return null;
  if (!callback) return { mode: 'login', message: authErrorMessage(error) };
  return {
    mode: recovery ? 'reset' : 'verify',
    message: recovery
      ? 'That password reset link couldn’t be used. Request a new link here and open the newest email in this same browser.'
      : 'That verification link couldn’t be used. Try signing in if you already confirmed your email, or request a new verification email and open it in this same browser.',
  };
}

export function cleanAuthCallbackUrl(url) {
  const clean = new URL(url);
  ['code', 'error', 'error_code', 'error_description', 'reset', 'sb_flow_id'].forEach(key => clean.searchParams.delete(key));
  clean.hash = '';
  return clean.pathname + clean.search;
}
