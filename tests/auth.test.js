import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { authCallbackFailure, authEmailRedirect, authErrorMessage, cleanAuthCallbackUrl, createEmailRequestGate, googleSignInAvailable, googleSignInUrl, initialAuthSession, sendAuthEmail } from '../src/auth.js';

function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function setupGate(storage = memoryStorage()) {
  let time = 1_000_000;
  const options = { storage: () => storage, now: () => time };
  return { gate: createEmailRequestGate(options), storage, options, advance: ms => { time += ms; } };
}

test('email limits are distinguished from invalid credentials and unconfirmed email', () => {
  assert.match(authErrorMessage({ code: 'over_email_send_rate_limit', status: 429 }), /email sending limit/);
  assert.match(authErrorMessage({ code: 'invalid_credentials', status: 400 }), /email or password is incorrect/);
  assert.match(authErrorMessage({ code: 'email_not_confirmed', status: 400 }), /Resend verification email/);
  assert.match(authErrorMessage({ status: 429 }), /Too many attempts/);
});

test('password, network, and service failures have actionable messages', () => {
  assert.match(authErrorMessage({ code: 'passwords_do_not_match' }), /don’t match/);
  assert.match(authErrorMessage({ code: 'weak_password' }), /stronger password/);
  assert.match(authErrorMessage({ code: 'same_password' }), /haven’t used/);
  assert.match(authErrorMessage({ code: 'pkce_code_verifier_not_found' }), /same browser/);
  assert.match(authErrorMessage({ name: 'AuthRetryableFetchError', status: 0 }), /internet connection/);
  assert.match(authErrorMessage({ name: 'AuthRetryableFetchError', status: 503 }), /temporarily unavailable/);
});

test('unknown failures never expose provider messages or account existence', () => {
  const sensitive = 'SMTP password=secret; internal host; private email';
  for (const action of ['login', 'signup', 'reset', 'verify', 'password', 'profile']) {
    for (const code of [undefined, 'unknown', '__proto__', 'constructor', 'user_already_exists', 'email_exists', 'user_not_found']) {
      assert.equal(authErrorMessage({ code, message: sensitive }, action).includes(sensitive), false);
    }
  }
  assert.equal(authErrorMessage({ code: 'user_not_found' }, 'reset'), authErrorMessage({ code: 'user_already_exists' }, 'reset'));
});

test('one successful email request blocks repeat sends across form remount and reload', async () => {
  const { gate, options, storage, advance } = setupGate();
  let calls = 0;
  const request = async () => { calls++; return { data: {}, error: null }; };
  await gate.run(request);
  assert.equal(gate.remainingSeconds(), 60);
  await assert.rejects(gate.run(request), { code: 'email_cooldown' });
  const reloaded = createEmailRequestGate(options);
  await assert.rejects(reloaded.run(request), { code: 'email_cooldown' });
  assert.equal(calls, 1);
  assert.equal(storage.values.size, 1);
  assert.ok([...storage.values.values()].every(value => /^\d+$/.test(value)));
  advance(59_001);
  assert.equal(reloaded.remainingSeconds(), 1);
  advance(999);
  await reloaded.run(request);
  assert.equal(calls, 2);
});

test('overlapping email requests cannot send twice, even before the first response', async () => {
  const { gate } = setupGate();
  let resolve;
  let calls = 0;
  const first = gate.run(() => { calls++; return new Promise(done => { resolve = done; }); });
  await assert.rejects(gate.run(async () => { calls++; return { error: null }; }), { code: 'email_request_pending' });
  resolve({ error: null });
  await first;
  assert.equal(calls, 1);
});

test('429 responses pause manual retries without automatically re-sending', async () => {
  for (const error of [{ status: 429 }, { code: 'over_email_send_rate_limit' }, { code: 'over_request_rate_limit' }]) {
    const { gate } = setupGate();
    let calls = 0;
    await assert.rejects(gate.run(async () => { calls++; return { error }; }), cause => cause === error);
    assert.equal(gate.remainingSeconds(), 60);
    await assert.rejects(gate.run(async () => { calls++; return { error: null }; }), { code: 'email_cooldown' });
    assert.equal(calls, 1);
  }
});

test('correcting validation errors and retrying a failed network request stays possible', async () => {
  const { gate } = setupGate();
  await assert.rejects(gate.run(async () => ({ error: { code: 'email_address_invalid' } })), { code: 'email_address_invalid' });
  assert.equal(gate.remainingSeconds(), 0);
  await assert.rejects(gate.run(async () => { throw new Error('offline'); }));
  assert.equal(gate.remainingSeconds(), 0);
  await gate.run(async () => ({ error: null }));
  assert.equal(gate.remainingSeconds(), 60);
});

test('blocked or corrupted session storage cannot break auth or leave a permanent pause', async () => {
  const { gate } = setupGate({ getItem() { throw new Error(); }, setItem() { throw new Error(); } });
  await gate.run(async () => ({ error: null }));
  await assert.rejects(gate.run(async () => ({ error: null })), { code: 'email_cooldown' });
  for (const value of ['NaN', 'Infinity', '-1', '999999999999999']) {
    const broken = setupGate({ getItem: () => value, setItem() {} });
    assert.equal(broken.gate.remainingSeconds(), 0);
    await broken.gate.run(async () => ({ error: null }));
  }
});

test('all email flows use the existing Supabase SDK with PKCE and same-origin redirects', async () => {
  for (const [mode, endpoint] of [['signup', 'signup'], ['reset', 'recover'], ['verify', 'resend']]) {
    const requests = [];
    const client = createClient('https://auth-test.invalid', 'public-test-key', {
      auth: { flowType: 'pkce', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storage: memoryStorage() },
      global: { fetch: async (input, init) => {
        requests.push({ url: new URL(input), body: JSON.parse(init.body) });
        return new Response(JSON.stringify(mode === 'signup' ? { user: { id: 'test-user' } } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } },
    });
    const { gate } = setupGate();
    await sendAuthEmail(client.auth, mode, { email: ' test@example.test ', password: 'test-only-password', profile: { name: 'Test Member' }, origin: 'https://www.interoom.org' }, gate);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.pathname, '/auth/v1/' + endpoint);
    assert.equal(requests[0].body.email, 'test@example.test');
    const redirect = new URL(requests[0].url.searchParams.get('redirect_to'));
    assert.equal(redirect.origin, 'https://www.interoom.org');
    assert.equal(redirect.pathname, '/');
    assert.equal(redirect.searchParams.get('reset'), mode === 'reset' ? '1' : null);
    assert.ok(requests[0].body.code_challenge);
    assert.equal(requests[0].body.code_challenge_method, 's256');
    if (mode === 'verify') assert.equal(requests[0].body.type, 'signup');
    if (mode !== 'signup') assert.equal(requests[0].body.password, undefined);
  }
});

test('real SDK HTTP 429 error reaches the UI mapper and prevents a second network call', async () => {
  let calls = 0;
  const client = createClient('https://auth-test.invalid', 'public-test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }), { status: 429, headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' } });
    } },
  });
  const { gate } = setupGate();
  const fields = { email: 'test@example.test', origin: 'https://www.interoom.org' };
  await assert.rejects(sendAuthEmail(client.auth, 'reset', fields, gate), error => {
    assert.equal(error.status, 429);
    assert.match(authErrorMessage(error, 'reset'), /email sending limit/);
    return true;
  });
  await assert.rejects(sendAuthEmail(client.auth, 'verify', fields, gate), { code: 'email_cooldown' });
  assert.equal(calls, 1);
});

test('email callbacks preserve the initiating production, room, or preview origin', () => {
  for (const origin of ['https://interoom.org', 'https://www.interoom.org', 'https://study.interoom.org', 'https://preview.vercel.app']) {
    assert.equal(authEmailRedirect(origin, 'signup'), origin + '/');
    assert.equal(authEmailRedirect(origin, 'verify'), origin + '/');
    assert.equal(authEmailRedirect(origin, 'reset'), origin + '/?reset=1');
  }
});

test('failed verification and password recovery links offer the appropriate next step', () => {
  assert.equal(authCallbackFailure(new URL('https://www.interoom.org/'), null, null), null);
  assert.equal(authCallbackFailure(new URL('https://www.interoom.org/?code=used'), null, null).mode, 'verify');
  assert.equal(authCallbackFailure(new URL('https://www.interoom.org/?reset=1&code=used'), null, null).mode, 'reset');
  assert.equal(authCallbackFailure(new URL('https://www.interoom.org/#error_code=otp_expired'), null, {}).mode, 'verify');
  assert.equal(authCallbackFailure(new URL('https://www.interoom.org/?reset=1#error=access_denied'), null, {}).mode, 'reset');
  assert.equal(authCallbackFailure(new URL('https://www.interoom.org/?code=valid'), null, { user: {} }), null);
  assert.equal(authCallbackFailure(new URL('https://www.interoom.org/?reset=1&code=valid'), null, { user: {} }), null);
  assert.equal(authCallbackFailure(new URL('https://www.interoom.org/'), { code: 'session_not_found' }, null).mode, 'login');
});

test('callback cleanup removes auth data but preserves room navigation', () => {
  const url = new URL('https://www.interoom.org/?room=general&view=chat&reset=1&code=secret&sb_flow_id=verifier-id&error=bad&error_code=otp_expired&error_description=private#access_token=secret');
  assert.equal(cleanAuthCallbackUrl(url), '/?room=general&view=chat');
  assert.ok(url.searchParams.has('code'), 'input URL is not mutated');
});

test('Google OAuth uses the existing Auth project, PKCE, minimal scopes and an exact callback', async () => {
  let networkCalls = 0;
  const storage = memoryStorage();
  const client = createClient('https://auth-test.invalid', 'public-test-key', {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storage },
    global: { fetch: async () => { networkCalls++; throw new Error('No email or token request should be made when starting OAuth'); } },
  });
  const url = new URL(await googleSignInUrl(client.auth, 'https://www.interoom.org'));
  assert.equal(url.origin, 'https://auth-test.invalid');
  assert.equal(url.pathname, '/auth/v1/authorize');
  assert.equal(url.searchParams.get('provider'), 'google');
  assert.equal(url.searchParams.get('redirect_to'), 'https://www.interoom.org/?auth=google');
  assert.equal(url.searchParams.get('scopes'), 'openid email profile');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.equal(url.searchParams.get('access_type'), null);
  assert.equal(url.searchParams.get('code_challenge_method'), 's256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(networkCalls, 0);
  assert.ok([...storage.values.keys()].some(key => key.includes('code-verifier')));
});

test('Google initiation failures do not navigate and have safe user-facing errors', async () => {
  const providerError = { code: 'provider_disabled', message: 'private provider detail' };
  await assert.rejects(googleSignInUrl({ signInWithOAuth: async () => ({ error: providerError }) }, 'https://www.interoom.org'), cause => cause === providerError);
  assert.match(authErrorMessage(providerError, 'google'), /temporarily unavailable/);
  assert.equal(authErrorMessage(providerError, 'google').includes(providerError.message), false);
  await assert.rejects(googleSignInUrl({ signInWithOAuth: async () => ({ data: {} }) }, 'https://www.interoom.org'), { code: 'oauth_redirect_failed' });
  assert.match(authErrorMessage(new Error('sensitive detail'), 'google'), /Couldn’t continue with Google/);
});

test('Google availability is read using only the publishable key without a user session', async () => {
  const controller = new AbortController();
  let calls = 0;
  const available = await googleSignInAvailable('https://auth-test.invalid', 'public-test-key', {
    signal: controller.signal,
    fetch: async (url, options) => {
      calls++;
      assert.equal(url.href, 'https://auth-test.invalid/auth/v1/settings');
      assert.deepEqual(options.headers, { apikey: 'public-test-key' });
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.signal, controller.signal);
      return new Response(JSON.stringify({ external: { google: true } }));
    },
  });
  assert.equal(available, true);
  assert.equal(calls, 1);
});

test('unconfigured providers and settings failures keep Google unavailable without breaking email', async () => {
  for (const payload of [{}, { external: {} }, { external: { google: false } }, { external: { google: 'true' } }, null]) {
    assert.equal(await googleSignInAvailable('https://auth-test.invalid', 'public-test-key', {
      fetch: async () => new Response(JSON.stringify(payload)),
    }), false);
  }
  for (const request of [
    async () => new Response('{}', { status: 500 }),
    async () => new Response('not json'),
    async () => { throw new Error('offline'); },
  ]) assert.equal(await googleSignInAvailable('https://auth-test.invalid', 'public-test-key', { fetch: request }), false);
  assert.equal(await googleSignInAvailable('', ''), false);
});

test('cancelled and expired Google callbacks return to sign-in rather than requesting email verification', () => {
  for (const query of ['?auth=google#error=access_denied&error_description=private', '?auth=google&code=expired', '?auth=google']) {
    const failure = authCallbackFailure(new URL('https://www.interoom.org/' + query), null, null);
    assert.equal(failure.mode, 'login');
    assert.match(failure.message, /Google sign-in wasn’t completed/);
    assert.equal(failure.message.includes('private'), false);
  }
  assert.equal(authCallbackFailure(new URL('https://www.interoom.org/?auth=google&code=valid'), null, { user: { id: 'existing-user' } }), null);
  assert.equal(authCallbackFailure(new URL('https://www.interoom.org/?auth=google#error=access_denied'), null, { user: {} }).mode, 'login');
  assert.equal(cleanAuthCallbackUrl(new URL('https://www.interoom.org/?auth=google&code=secret&view=messages&conversation=thread#provider_token=secret')), '/?view=messages&conversation=thread');
});

test('an expired callback cannot look successful just because an older session is still valid', async () => {
  const session = { user: { id: 'existing-user' } };
  const callbackError = { code: 'flow_state_expired' };
  const result = await initialAuthSession({
    initialize: async () => ({ error: callbackError }),
    getSession: async () => ({ data: { session }, error: null }),
  });
  assert.equal(result.data.session, session, 'the existing account stays signed in');
  assert.equal(result.error, callbackError);
  assert.equal(authCallbackFailure(new URL('https://www.interoom.org/?auth=google&code=expired'), result.error, result.data.session).mode, 'login');
  assert.equal(authCallbackFailure(new URL('https://www.interoom.org/?reset=1&code=expired'), result.error, result.data.session).mode, 'reset');
});
