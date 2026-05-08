// Google Identity Services OAuth2 token client.
//
// Design rules
// ------------
// 1. `init()` is synchronous-cheap. It only restores the cached profile +
//    token from IndexedDB / localStorage. The GIS script and tokenClient
//    are NOT awaited here — the boot path must NEVER block on GIS, even
//    if the script is slow to load on iOS Safari after wake-from-idle.
//    `ensureTokenClient()` does the GIS wait lazily, the first time we
//    actually need to mint a token.
// 2. `isSignedIn()` is keyed on the cached USER PROFILE, never on token
//    freshness. The token is short-lived plumbing; its absence/expiry
//    doesn't mean "logged out".
// 3. `getAccessToken()` retries on backoff (5 retries, 500/1/2/4/8s).
//    On exhausted retries it sets tokenStatus='failed' and rejects, but
//    DOES NOT clear the cached user. Sign-out only happens for: (a) the
//    explicit signOut() call, (b) an OAuth `invalid_grant` /
//    `unauthorized_client` error, or (c) a token issued >7 days ago that
//    has had no successful refresh since.
window.Auth = (function () {
  let tokenClient = null;
  let tokenClientReady = false;
  let tokenClientReadyPromise = null;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let tokenIssuedAt = 0;
  let user = null;
  let onChangeListeners = [];
  let pendingRefresh = null;

  // 'unknown' | 'valid' | 'refreshing' | 'failed'
  let tokenStatus = 'unknown';
  let lastAuthError = null;

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const TOKEN_REFRESH_CUSHION_MS = 2 * 60 * 1000;

  // ---- PWA / redirect-flow plumbing -----------------------------------
  // iOS Safari isolates the OAuth popup from the installed PWA's window
  // context, so postMessage never reaches us and requestAccessToken hangs
  // until the safety timeout. In standalone mode we use a full-page
  // redirect to accounts.google.com instead — the response comes back as
  // an OAuth-fragment on the app URL and we consume it in init().
  const IS_STANDALONE = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  // Safari (any context) blocks/strips the OAuth popup callback the same way
  // an installed PWA does, so we route Safari through the redirect flow even
  // when not in standalone mode. Desktop Chrome, Edge, etc. include "Safari"
  // in their UA — the !Chrome guard excludes them. iOS Chrome uses CriOS
  // (no "Chrome" token) and IS WebKit underneath, so it's correctly bucketed
  // as Safari by this rule.
  const IS_SAFARI_BROWSER = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
  const USE_REDIRECT = IS_STANDALONE || IS_SAFARI_BROWSER;
  const OAUTH_STATE_KEY = 'auth.oauth_state';

  function getRedirectUri() {
    // Strip the filename so we land on the app directory (matches what the
    // user registers in Google Cloud Console as an Authorized redirect URI).
    const { origin, pathname } = window.location;
    return origin + pathname.replace(/[^/]*$/, '');
  }
  function generateNonce() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // PKCE (RFC 7636) helpers for the Authorization Code flow used by PWA
  // and Safari users. The verifier is a random 64-byte string; the
  // challenge is its SHA-256 hash, both base64url-encoded without padding.
  function generateCodeVerifier() {
    const arr = new Uint8Array(64);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  async function generateCodeChallenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  const PKCE_VERIFIER_KEY = 'auth.pkce_verifier';
  const REFRESH_TOKEN_KEY = 'auth.refresh_token';

  function notifyChange() {
    onChangeListeners.forEach((fn) => {
      try { fn({ user, hasToken: !!accessToken, tokenStatus }); } catch (e) { console.warn(e); }
    });
  }
  function onChange(fn) {
    onChangeListeners.push(fn);
    return () => { onChangeListeners = onChangeListeners.filter((f) => f !== fn); };
  }

  function setTokenStatus(s, err) {
    if (s === tokenStatus && (!err || lastAuthError === err)) return;
    tokenStatus = s;
    lastAuthError = err || null;
    console.log('[auth] tokenStatus →', s, err ? `(${err.message || err})` : '');
    notifyChange();
  }

  // ---- Persistence ------------------------------------------------------
  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, v) { try { localStorage.setItem(key, v); } catch (e) {} }
  function lsDelete(key) { try { localStorage.removeItem(key); } catch (e) {} }

  async function persistToken() {
    try {
      if (accessToken) {
        await window.DB.kvSet('auth.token', accessToken);
        await window.DB.kvSet('auth.expiresAt', tokenExpiresAt);
        await window.DB.kvSet('auth.issuedAt', tokenIssuedAt);
        lsSet('auth.token', accessToken);
        lsSet('auth.expiresAt', String(tokenExpiresAt));
        lsSet('auth.issuedAt', String(tokenIssuedAt));
      } else {
        await window.DB.kvDelete('auth.token');
        await window.DB.kvDelete('auth.expiresAt');
        // Note: we keep auth.issuedAt so the 7-day-stale rule keeps working
        lsDelete('auth.token');
        lsDelete('auth.expiresAt');
      }
    } catch (e) { /* best-effort */ }
  }
  async function persistUser() {
    try {
      if (user) {
        await window.DB.kvSet('user', user);
        lsSet('user', JSON.stringify(user));
      } else {
        await window.DB.kvDelete('user');
        await window.DB.kvDelete('auth.token');
        await window.DB.kvDelete('auth.expiresAt');
        await window.DB.kvDelete('auth.issuedAt');
        lsDelete('user');
        lsDelete('auth.token');
        lsDelete('auth.expiresAt');
        lsDelete('auth.issuedAt');
      }
    } catch (e) { /* best-effort */ }
  }

  // ---- Init: cache-only, no GIS wait -----------------------------------
  async function init() {
    if (window.CONFIG.CLIENT_ID.startsWith('__REPLACE')) {
      throw new Error('OAuth not configured: edit js/config.js and set CLIENT_ID. See README.');
    }
    console.log('[auth] standalone mode:', IS_STANDALONE, '— safari browser:', IS_SAFARI_BROWSER);
    // Redirect-flow callback (PWA path). If we landed here from Google's
    // OAuth redirect, this consumes the hash, persists the token, and
    // sets `user`. Returning early avoids re-running the cached-token
    // restore on top of the freshly minted token.
    try {
      const cb = await consumeRedirectCallback();
      if (cb && cb.signedIn) return;
    } catch (e) {
      console.warn('[auth] redirect callback handler threw:', e);
    }
    try {
      let cachedUser = await window.DB.kvGet('user');
      if (!cachedUser) {
        const raw = lsGet('user');
        if (raw) try { cachedUser = JSON.parse(raw); } catch (e) {}
      }
      if (cachedUser) user = cachedUser;

      let cachedToken = await window.DB.kvGet('auth.token');
      let cachedExp = await window.DB.kvGet('auth.expiresAt');
      let cachedIssued = await window.DB.kvGet('auth.issuedAt');
      if (!cachedToken) {
        cachedToken = lsGet('auth.token');
        cachedExp = lsGet('auth.expiresAt');
        cachedIssued = lsGet('auth.issuedAt');
      }
      if (cachedToken) {
        accessToken = cachedToken;
        tokenExpiresAt = Number(cachedExp || 0);
        tokenIssuedAt = Number(cachedIssued || 0);
      }

      // 7-day stale check: if the last successfully-issued token is older
      // than 7 days the user really should re-auth.
      if (user && tokenIssuedAt > 0 && (Date.now() - tokenIssuedAt) > SEVEN_DAYS_MS) {
        console.warn('[auth] cached token issued >7d ago — forcing sign-out');
        await hardSignOut();
        return;
      }

      console.log('[auth] init restored — user?', !!user, 'token?', !!accessToken,
        'expiresIn(s)=', accessToken ? Math.round((tokenExpiresAt - Date.now()) / 1000) : 'n/a',
        'issuedAgo(s)=', tokenIssuedAt ? Math.round((Date.now() - tokenIssuedAt) / 1000) : 'n/a');

      if (accessToken && (tokenExpiresAt - Date.now()) > TOKEN_REFRESH_CUSHION_MS) {
        setTokenStatus('valid');
      } else if (user) {
        setTokenStatus('refreshing'); // expired but signed in — will refresh on demand
      }
    } catch (e) {
      console.warn('[auth] init restore failed:', e);
    }
  }

  // ---- Lazy GIS init ---------------------------------------------------
  async function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    if (tokenClientReadyPromise) return tokenClientReadyPromise;
    tokenClientReadyPromise = (async () => {
      // Wait for the GIS script to load (up to 8s — same as before).
      const start = Date.now();
      while (!window.google?.accounts?.oauth2) {
        if (Date.now() - start > 8000) throw new Error('Google Identity Services failed to load');
        await new Promise((r) => setTimeout(r, 100));
      }
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: window.CONFIG.CLIENT_ID,
        scope: window.CONFIG.SCOPES,
        hd: window.CONFIG.HOSTED_DOMAIN,
        prompt: '',
        callback: () => { /* set per-request */ }
      });
      tokenClientReady = true;
      return tokenClient;
    })();
    return tokenClientReadyPromise;
  }

  // ---- Token request ---------------------------------------------------
  // Single attempt with caller-controlled timeout + prompt. Used both for
  // interactive sign-in (long timeout, prompt:'select_account') and for
  // silent refresh (short timeout + retries, prompt:'').
  //
  // CRITICAL: we set client.callback BEFORE invoking requestAccessToken
  // so when GIS fires it (after the user picks an account), the response
  // lands in our handler. We never call requestAccessToken twice for the
  // same user gesture — that races the in-flight popup and swallows the
  // user's actual response.
  function requestTokenOnce({ timeoutMs = 10000, prompt = '' } = {}) {
    return new Promise((resolve, reject) => {
      ensureTokenClient().then((client) => {
        console.log('[auth] ensureTokenClient() resolved');
        const safety = setTimeout(() => {
          console.warn(`[auth] token request timed out after ${timeoutMs}ms`);
          reject(new Error('TOKEN_TIMEOUT'));
        }, timeoutMs);

        client.callback = async (resp) => {
          clearTimeout(safety);
          console.log('[auth] token callback fired', resp && resp.error ? `(error: ${resp.error})` : '(success)');
          if (resp.error) {
            const code = resp.error || '';
            const desc = resp.error_description || code;
            const err = new Error(desc);
            err.oauthCode = code;
            console.warn('[auth] token callback received error:', code, '-', desc);
            return reject(err);
          }
          accessToken = resp.access_token;
          tokenIssuedAt = Date.now();
          tokenExpiresAt = tokenIssuedAt + (resp.expires_in - 60) * 1000;
          try {
            await fetchAndVerifyUser();
            await persistToken();
            setTokenStatus('valid');
            console.log('[auth] token persisted, user signed in:', user?.email);
            resolve({ accessToken, user });
          } catch (err) {
            console.warn('[auth] post-callback failure:', err.message);
            accessToken = null;
            tokenExpiresAt = 0;
            tokenIssuedAt = 0;
            await persistToken();
            reject(err);
          }
        };

        console.log('[auth] requestAccessToken called with prompt=', JSON.stringify(prompt));
        try { client.requestAccessToken({ prompt }); }
        catch (err) {
          clearTimeout(safety);
          console.warn('[auth] requestAccessToken threw synchronously:', err.message);
          reject(err);
        }
      }, (err) => {
        console.warn('[auth] ensureTokenClient failed:', err.message);
        reject(err);
      });
    });
  }

  // Try a refresh_token grant against Google's token endpoint. Only works
  // for users who signed in via the PKCE flow with access_type=offline.
  // Returns { accessToken, user } on success, null otherwise.
  async function tryRefreshTokenGrant() {
    let rt = null;
    try { rt = await window.DB.kvGet(REFRESH_TOKEN_KEY); } catch (_) {}
    if (!rt) rt = lsGet(REFRESH_TOKEN_KEY);
    if (!rt) return null;
    try {
      const resp = await fetch(window.CONFIG.TOKEN_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refresh_token: rt,
          grant_type: 'refresh_token'
        })
      });
      const t = await resp.json();
      if (t.error) {
        console.warn('[auth] refresh_token grant failed:', t.error, '-', t.error_description || '');
        // invalid_grant means the refresh token is dead — purge it so we
        // don't keep retrying. The user will fall through to interactive
        // sign-in on the next attempt.
        if (t.error === 'invalid_grant') {
          try { await window.DB.kvDelete(REFRESH_TOKEN_KEY); } catch (_) {}
          lsDelete(REFRESH_TOKEN_KEY);
        }
        return null;
      }
      accessToken = t.access_token;
      tokenIssuedAt = Date.now();
      tokenExpiresAt = tokenIssuedAt + ((t.expires_in || 3600) - 60) * 1000;
      await persistToken();
      setTokenStatus('valid');
      console.log('[auth] refresh_token grant success');
      return { accessToken, user };
    } catch (err) {
      console.warn('[auth] refresh_token grant network error:', err && err.message);
      return null;
    }
  }

  // Silent-refresh wrapper with backoff. Used by getAccessToken when the
  // cached token is stale. Tries refresh_token grant first (PKCE users),
  // then falls back to GIS iframe-driven refresh with retries.
  async function requestTokenWithRetries() {
    const refreshed = await tryRefreshTokenGrant();
    if (refreshed) return refreshed;

    // PWA cold start with no session: GIS iframe requestAccessToken() will
    // time out 6x10s = 60s in the SFSafariViewController sandbox before
    // giving up. There's no point — the user has to sign in interactively
    // via the PKCE redirect anyway. Bail fast so the login screen stays
    // responsive instead of grinding through dead retries.
    if (USE_REDIRECT && !user && !lsGet(REFRESH_TOKEN_KEY)) {
      console.log('[auth] PWA cold start, no refresh token — skipping GIS retries (sign in required)');
      const err = new Error('SIGN_IN_REQUIRED');
      err.signInRequired = true;
      throw err;
    }

    const delays = [500, 1000, 2000, 4000, 8000];
    let lastErr;
    for (let i = 0; i <= delays.length; i += 1) {
      try {
        if (i > 0) console.log(`[auth] silent refresh retry ${i}/${delays.length}`);
        return await requestTokenOnce({ timeoutMs: 10000, prompt: '' });
      } catch (err) {
        lastErr = err;
        const code = err && err.oauthCode;
        if (code === 'invalid_grant' || code === 'unauthorized_client') {
          console.warn('[auth] terminal OAuth error', code, '— signing out');
          await hardSignOut();
          throw err;
        }
        if (i < delays.length) await new Promise((r) => setTimeout(r, delays[i]));
      }
    }
    throw lastErr || new Error('Token request failed after retries');
  }

  async function fetchAndVerifyUser() {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
    const info = await res.json();
    if (!info.email || !info.email.toLowerCase().endsWith('@' + window.CONFIG.HOSTED_DOMAIN)) {
      throw new Error(
        `Only @${window.CONFIG.HOSTED_DOMAIN} accounts are allowed. Signed in as ${info.email || 'unknown'}.`
      );
    }
    user = {
      email: info.email,
      name: info.name || info.email,
      firstName: (info.given_name || (info.name || '').split(' ')[0] || 'Tech').trim(),
      picture: info.picture || ''
    };
    await persistUser();
  }

  // ---- Public ----------------------------------------------------------
  async function getAccessToken(forceRefresh = false) {
    if (!forceRefresh && accessToken && (tokenExpiresAt - Date.now()) > TOKEN_REFRESH_CUSHION_MS) {
      if (tokenStatus !== 'valid') setTokenStatus('valid');
      return accessToken;
    }
    if (pendingRefresh) return pendingRefresh;

    pendingRefresh = (async () => {
      setTokenStatus('refreshing');
      try {
        const { accessToken: t } = await requestTokenWithRetries();
        return t;
      } catch (err) {
        // CRITICAL: do NOT clear user on refresh failure. A timeout, a
        // network blip, or a generic GIS hang must NOT silently sign the
        // tech out. Only OAuth invalid_grant (handled inside requestToken)
        // and the 7-day stale check (in init) trigger sign-out.
        setTokenStatus('failed', err);
        throw err;
      } finally {
        pendingRefresh = null;
      }
    })();
    return pendingRefresh;
  }

  async function signIn() {
    console.log('[auth] signIn() called');
    console.log('[auth] using flow:', USE_REDIRECT ? 'redirect' : 'popup');
    if (USE_REDIRECT) {
      return signInViaRedirect();
    }
    // Browser path — single attempt with a generous 60-second budget.
    // The user is actively interacting with the Google account picker,
    // possibly typing a 2FA code, and we MUST NOT race them by firing
    // a second requestAccessToken halfway through. No retries.
    // prompt:'select_account' forces the picker every time so the tech
    // can switch accounts cleanly.
    return requestTokenOnce({ timeoutMs: 60000, prompt: 'select_account' });
  }

  // Full-page redirect to Google using PKCE Authorization Code flow.
  // Implicit grant (response_type=token) was breaking 2FA inside the iOS
  // PWA's SFSafariViewController sheet; PKCE works because the token
  // exchange happens via fetch() POST from inside the PWA itself, with no
  // dependency on the OAuth sheet's cookie context. The returned promise
  // intentionally never resolves — the page is navigating away.
  async function signInViaRedirect() {
    const nonce = generateNonce();
    const verifier = generateCodeVerifier();
    let challenge;
    try {
      challenge = await generateCodeChallenge(verifier);
    } catch (e) {
      console.warn('[auth] PKCE: code challenge generation failed:', e.message);
      return Promise.reject(new Error('PKCE init failed — sign-in cannot proceed'));
    }
    try {
      localStorage.setItem(OAUTH_STATE_KEY, nonce);
      localStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    } catch (e) {
      console.warn('[auth] could not save PKCE state to localStorage:', e);
      return Promise.reject(new Error('Could not save OAuth state — sign-in cannot proceed'));
    }
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', window.CONFIG.CLIENT_ID);
    url.searchParams.set('redirect_uri', getRedirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', window.CONFIG.SCOPES);
    url.searchParams.set('state', nonce);
    url.searchParams.set('prompt', 'select_account');
    url.searchParams.set('hd', window.CONFIG.HOSTED_DOMAIN);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('access_type', 'offline');
    console.log('[auth] redirecting to OAuth URL (PKCE code flow)');
    window.location.href = url.toString();
    return new Promise(() => {});
  }

  // Consume an OAuth redirect response. Two formats supported:
  //   1. PKCE code flow: ?code=...&state=...   (current)
  //   2. Legacy implicit:  #access_token=...   (kept as a fallback for any
  //      in-flight redirects that started before the PKCE deploy)
  // Returns { signedIn: true } on success; null otherwise. Always cleans
  // the URL + state nonce so a refresh can't re-trigger the flow.
  async function consumeRedirectCallback() {
    const search = window.location.search || '';
    if (search.length > 1) {
      const qp = new URLSearchParams(search.slice(1));
      if (qp.has('code') || (qp.has('error') && qp.has('state'))) {
        return await handleCodeFlow(qp);
      }
    }
    const hash = window.location.hash || '';
    if (hash.length > 1) {
      const hp = new URLSearchParams(hash.slice(1));
      if (hp.has('access_token') || hp.has('error')) {
        return await handleImplicitFlow(hp);
      }
    }
    return null;
  }

  async function handleCodeFlow(params) {
    const code = params.get('code');
    const errCode = params.get('error');
    const expectedState = lsGet(OAUTH_STATE_KEY);
    const returnedState = params.get('state') || '';
    const verifier = lsGet(PKCE_VERIFIER_KEY);

    // Always strip the URL + state + verifier so nothing can be replayed.
    try { history.replaceState(null, '', window.location.pathname); } catch (_) {}
    lsDelete(OAUTH_STATE_KEY);
    lsDelete(PKCE_VERIFIER_KEY);

    if (errCode) {
      console.warn('[auth] PKCE: OAuth returned error:', errCode, '-', params.get('error_description') || '');
      return null;
    }
    if (!expectedState || returnedState !== expectedState) {
      console.warn('[auth] state mismatch — possible CSRF, ignoring response');
      return null;
    }
    if (!verifier) {
      console.warn('[auth] PKCE: missing code_verifier in localStorage; ignoring response');
      return null;
    }

    console.log('[auth] PKCE: code received, exchanging via token proxy...');
    let tokens;
    try {
      const resp = await fetch(window.CONFIG.TOKEN_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          code_verifier: verifier,
          redirect_uri: getRedirectUri(),
          grant_type: 'authorization_code'
        })
      });
      tokens = await resp.json();
    } catch (err) {
      console.error('[auth] PKCE: token exchange network error:', err && err.message);
      return null;
    }
    if (tokens.error) {
      console.error('[auth] PKCE: token exchange failed:', tokens.error, '-', tokens.error_description || '');
      return null;
    }
    console.log('[auth] PKCE: token exchange success', tokens.refresh_token ? '(with refresh_token)' : '(no refresh_token)');

    accessToken = tokens.access_token;
    tokenIssuedAt = Date.now();
    tokenExpiresAt = tokenIssuedAt + ((tokens.expires_in || 3600) - 60) * 1000;
    if (tokens.refresh_token) {
      try {
        await window.DB.kvSet(REFRESH_TOKEN_KEY, tokens.refresh_token);
        lsSet(REFRESH_TOKEN_KEY, tokens.refresh_token);
      } catch (e) { /* best-effort */ }
    }

    try {
      await fetchAndVerifyUser();
      await persistToken();
      setTokenStatus('valid');
      console.log('[auth] token persisted, user signed in:', user?.email);
      return { signedIn: true };
    } catch (err) {
      console.warn('[auth] post-redirect failure:', err.message);
      accessToken = null;
      tokenExpiresAt = 0;
      tokenIssuedAt = 0;
      await persistToken();
      return null;
    }
  }

  async function handleImplicitFlow(params) {
    const accessTok = params.get('access_token');
    const errCode = params.get('error');
    const expectedState = lsGet(OAUTH_STATE_KEY);
    const returnedState = params.get('state') || '';
    try {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (_) {}
    lsDelete(OAUTH_STATE_KEY);
    lsDelete(PKCE_VERIFIER_KEY);

    if (errCode) {
      console.warn('[auth] OAuth redirect returned error:', errCode, '-', params.get('error_description') || '');
      return null;
    }
    if (!expectedState || returnedState !== expectedState) {
      console.warn('[auth] state mismatch — possible CSRF, ignoring response');
      return null;
    }

    console.log('[auth] token captured from URL hash (legacy implicit flow)');
    accessToken = accessTok;
    tokenIssuedAt = Date.now();
    const expiresIn = Number(params.get('expires_in') || 3600);
    tokenExpiresAt = tokenIssuedAt + (expiresIn - 60) * 1000;
    try {
      await fetchAndVerifyUser();
      await persistToken();
      setTokenStatus('valid');
      console.log('[auth] token persisted, user signed in:', user?.email);
      return { signedIn: true };
    } catch (err) {
      console.warn('[auth] post-redirect failure:', err.message);
      accessToken = null;
      tokenExpiresAt = 0;
      tokenIssuedAt = 0;
      await persistToken();
      return null;
    }
  }

  async function hardSignOut() {
    if (accessToken && window.google?.accounts?.oauth2?.revoke) {
      try { window.google.accounts.oauth2.revoke(accessToken, () => {}); } catch (e) {}
    }
    // Purge refresh_token too — otherwise a sign-out + reload would
    // silently re-authenticate via the refresh grant.
    try { await window.DB.kvDelete(REFRESH_TOKEN_KEY); } catch (_) {}
    lsDelete(REFRESH_TOKEN_KEY);
    accessToken = null;
    tokenExpiresAt = 0;
    tokenIssuedAt = 0;
    user = null;
    setTokenStatus('unknown');
    await persistUser();
    notifyChange();
  }
  async function signOut() {
    console.warn('[auth] explicit signOut');
    return hardSignOut();
  }

  function getUser() { return user; }
  function isSignedIn() { return !!user; }
  function getTokenStatus() { return tokenStatus; }
  function getLastAuthError() { return lastAuthError; }

  // ---- GIS One Tap (PWA-only inline sign-in) -----------------------------
  // The redirect flow opens Google in an SFSafariViewController-style sheet
  // when used inside an installed iOS PWA; that sheet's cookie jar is
  // isolated from the PWA's webview, which breaks 2FA. One Tap renders an
  // inline iframe inside the PWA itself, sharing the PWA's cookie context.
  // We then attempt a silent access-token grant via the existing GIS oauth2
  // client. The silent grant may still fail in restricted contexts — in
  // that case we roll back so we don't leave a half-signed-in state.
  let oneTapInitialized = false;
  function initOneTap() {
    if (!IS_STANDALONE) return; // browser users keep popup/redirect
    if (oneTapInitialized) return;
    ensureTokenClient().then(() => {
      if (!window.google?.accounts?.id) {
        console.warn('[auth] One Tap unavailable: google.accounts.id missing');
        return;
      }
      oneTapInitialized = true;
      window.google.accounts.id.initialize({
        client_id: window.CONFIG.CLIENT_ID,
        callback: async (credentialResponse) => {
          console.log('[auth] One Tap callback fired');
          let candidateUser = null;
          try {
            const payload = JSON.parse(atob(credentialResponse.credential.split('.')[1]));
            if (!payload.email || !payload.email.toLowerCase().endsWith('@' + window.CONFIG.HOSTED_DOMAIN)) {
              throw new Error(`Only @${window.CONFIG.HOSTED_DOMAIN} accounts are allowed.`);
            }
            candidateUser = {
              email: payload.email,
              name: payload.name || payload.email,
              firstName: (payload.given_name || (payload.name || '').split(' ')[0] || 'Tech').trim(),
              picture: payload.picture || ''
            };
            user = candidateUser;
            await persistUser();
            // Silent access-token grant. May fail in restricted PWA
            // contexts — if so, roll back so the app doesn't sit in a
            // half-signed-in state with no Drive token.
            await getAccessToken(true);
            setTokenStatus('valid');
            notifyChange();
            console.log('[auth] One Tap signed in:', user.email);
          } catch (err) {
            console.warn('[auth] One Tap callback error:', err.message);
            user = null;
            await persistUser();
            notifyChange();
          }
        },
        hosted_domain: window.CONFIG.HOSTED_DOMAIN,
        use_fedcm_for_prompt: true
      });
      try { window.google.accounts.id.prompt(); }
      catch (e) { console.warn('[auth] One Tap prompt threw:', e.message); }
    }).catch((err) => {
      console.warn('[auth] One Tap init failed:', err && err.message);
    });
  }

  return {
    init,
    ensureTokenClient,
    signIn,
    signOut,
    getAccessToken,
    getUser,
    isSignedIn,
    onChange,
    getTokenStatus,
    getLastAuthError,
    initOneTap
  };
})();
