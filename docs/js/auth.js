// Google Identity Services OAuth2 token client.
//
// Persistence model
// -----------------
// GIS implicit-flow access tokens last ~1 hour. We cache the access token,
// its expiry, and the user profile in BOTH IndexedDB and localStorage so a
// torn-down storage (rare iOS Safari ITP case) doesn't lose the session.
//
// "Signed in" rule
// ----------------
// `isSignedIn()` returns true as long as we have a cached `user` profile.
// We DO NOT gate that on the access token's expiry — the token is just
// short-lived plumbing for Drive calls, not a proxy for "is the tech
// signed in". This is what makes the app stay logged in indefinitely:
//   - Boot: cached user → home screen, no prompt.
//   - First Drive call: uses cached token. If the token is expired Drive
//     returns 401, authedFetch calls getAccessToken(true), GIS attempts
//     a silent refresh (no UI on most browsers; popup if Safari ITP
//     blocked the silent path).
//   - Refresh succeeds → we keep going, totally invisible.
//   - Refresh fails (Google session truly gone) → we clear the cached
//     user so the app routes back to the Sign-in screen.
window.Auth = (function () {
  let tokenClient = null;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let user = null;
  let onChangeListeners = [];
  let pendingRefresh = null; // de-dupes concurrent refresh attempts

  function notifyChange() {
    onChangeListeners.forEach((fn) => {
      try { fn({ user, hasToken: !!accessToken }); } catch (e) { console.warn(e); }
    });
  }

  function onChange(fn) {
    onChangeListeners.push(fn);
    return () => { onChangeListeners = onChangeListeners.filter((f) => f !== fn); };
  }

  function gisReady() {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function check() {
        if (window.google?.accounts?.oauth2) return resolve();
        if (Date.now() - start > 8000) return reject(new Error('Google Identity Services failed to load'));
        setTimeout(check, 100);
      })();
    });
  }

  // ---- Persistence helpers ---------------------------------------------
  // We write to IDB and localStorage in parallel. Either store can be used
  // to restore on launch — whichever responds first wins.
  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* private mode etc */ }
  }
  function lsDelete(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  async function persistToken() {
    try {
      if (accessToken) {
        await window.DB.kvSet('auth.token', accessToken);
        await window.DB.kvSet('auth.expiresAt', tokenExpiresAt);
        lsSet('auth.token', accessToken);
        lsSet('auth.expiresAt', String(tokenExpiresAt));
      } else {
        await window.DB.kvDelete('auth.token');
        await window.DB.kvDelete('auth.expiresAt');
        lsDelete('auth.token');
        lsDelete('auth.expiresAt');
      }
    } catch (e) { /* best effort */ }
  }

  async function persistUser() {
    try {
      if (user) {
        await window.DB.kvSet('user', user);
        lsSet('user', JSON.stringify(user));
      } else {
        await window.DB.kvDelete('user');
        lsDelete('user');
      }
    } catch (e) { /* best effort */ }
  }

  async function init() {
    await gisReady();

    if (window.CONFIG.CLIENT_ID.startsWith('__REPLACE')) {
      throw new Error('OAuth not configured: edit js/config.js and set CLIENT_ID. See README.');
    }

    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: window.CONFIG.CLIENT_ID,
      scope: window.CONFIG.SCOPES,
      hd: window.CONFIG.HOSTED_DOMAIN,
      prompt: '',
      callback: () => { /* set per-request below */ }
    });

    // Restore from IDB first; fall back to localStorage if IDB is empty
    // for any of the values (e.g. iOS standalone PWA wiping IDB while
    // keeping LS, or vice versa).
    try {
      let cachedUser = await window.DB.kvGet('user');
      if (!cachedUser) {
        const raw = lsGet('user');
        if (raw) try { cachedUser = JSON.parse(raw); } catch (e) { /* ignore */ }
      }
      if (cachedUser) user = cachedUser;

      let cachedToken = await window.DB.kvGet('auth.token');
      let cachedExp = await window.DB.kvGet('auth.expiresAt');
      if (!cachedToken) {
        cachedToken = lsGet('auth.token');
        cachedExp = lsGet('auth.expiresAt');
      }
      if (cachedToken) {
        accessToken = cachedToken;
        tokenExpiresAt = Number(cachedExp || 0);
      }
      console.log('[auth] init restored user?', !!user, 'token?', !!accessToken,
        'expiresIn(s)=', accessToken ? Math.round((tokenExpiresAt - Date.now()) / 1000) : 'n/a');
    } catch (e) {
      console.warn('[auth] init restore failed:', e);
    }
  }

  // ---- Token request -----------------------------------------------------
  function requestToken() {
    return new Promise((resolve, reject) => {
      if (!tokenClient) return reject(new Error('Auth not initialized'));
      const safety = setTimeout(() => reject(new Error('Token request timed out')), 30000);
      tokenClient.callback = async (resp) => {
        clearTimeout(safety);
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000;
        try {
          await fetchAndVerifyUser();
          await persistToken();
          notifyChange();
          resolve({ accessToken, user });
        } catch (err) {
          accessToken = null;
          tokenExpiresAt = 0;
          await persistToken();
          notifyChange();
          reject(err);
        }
      };
      tokenClient.requestAccessToken({ prompt: '' });
    });
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

  // Returns a valid access token. With forceRefresh=false we trust whatever
  // is cached if it's not nominally expired. With forceRefresh=true we
  // discard the cache and ask GIS for a new one (silent if possible).
  // Concurrent callers share the same in-flight refresh.
  async function getAccessToken(forceRefresh = false) {
    if (!forceRefresh && accessToken && Date.now() < tokenExpiresAt) return accessToken;
    if (pendingRefresh) return pendingRefresh;

    pendingRefresh = (async () => {
      accessToken = null;
      tokenExpiresAt = 0;
      await persistToken();
      try {
        const { accessToken: t } = await requestToken();
        return t;
      } catch (err) {
        // We had a session and the refresh failed. Treat as fully signed
        // out so the app routes back to the Sign-in screen.
        if (user) {
          console.warn('[auth] silent refresh failed — clearing session:', err.message);
          user = null;
          await persistUser();
          notifyChange();
        }
        throw err;
      } finally {
        pendingRefresh = null;
      }
    })();
    return pendingRefresh;
  }

  async function signIn() {
    return requestToken();
  }

  async function signOut() {
    if (accessToken && window.google?.accounts?.oauth2?.revoke) {
      try { window.google.accounts.oauth2.revoke(accessToken, () => {}); } catch (e) { /* ignore */ }
    }
    accessToken = null;
    tokenExpiresAt = 0;
    user = null;
    try {
      await persistToken();
      await persistUser();
    } catch (e) { /* ignore */ }
    notifyChange();
  }

  function getUser() { return user; }

  // We're "signed in" as long as a user profile is cached. The token may
  // be nominally expired — getAccessToken handles refresh on demand.
  function isSignedIn() { return !!user; }

  return { init, signIn, signOut, getAccessToken, getUser, isSignedIn, onChange };
})();
