// Google Identity Services OAuth2 token client.
//
// Persistence: GIS implicit-flow access tokens last ~1 hour. We cache the
// access token and its expiry in IndexedDB so a page refresh within that
// hour stays signed in. After expiry, requestAccessToken({prompt:''})
// silently refreshes from the user's Google session. The user only sees
// the Sign-in button if a) they tap Sign out, or b) silent refresh is
// blocked by Safari ITP / no Google session.
window.Auth = (function () {
  let tokenClient = null;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let user = null; // { email, name, firstName, picture }
  let onChangeListeners = [];

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

    // Restore cached identity + token.
    try {
      const cachedUser = await window.DB.kvGet('user');
      if (cachedUser) user = cachedUser;
      const cachedToken = await window.DB.kvGet('auth.token');
      const cachedExp = await window.DB.kvGet('auth.expiresAt');
      if (cachedToken && cachedExp && Date.now() < Number(cachedExp)) {
        accessToken = cachedToken;
        tokenExpiresAt = Number(cachedExp);
      }
    } catch (e) { /* ignore — fresh start */ }
  }

  async function persistToken() {
    try {
      if (accessToken) {
        await window.DB.kvSet('auth.token', accessToken);
        await window.DB.kvSet('auth.expiresAt', tokenExpiresAt);
      } else {
        await window.DB.kvDelete('auth.token');
        await window.DB.kvDelete('auth.expiresAt');
      }
    } catch (e) { /* best effort */ }
  }

  function requestToken() {
    return new Promise((resolve, reject) => {
      if (!tokenClient) return reject(new Error('Auth not initialized'));

      // Fail-safe: GIS sometimes never invokes the callback if a popup is
      // blocked or the iframe is sandboxed. After 30s, give up.
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
    await window.DB.kvSet('user', user);
  }

  // Returns a valid access token, refreshing silently if needed. Pass
  // forceRefresh=true after a 401 to bypass the in-memory timer.
  async function getAccessToken(forceRefresh = false) {
    if (!forceRefresh && accessToken && Date.now() < tokenExpiresAt) return accessToken;
    accessToken = null;
    tokenExpiresAt = 0;
    await persistToken();
    const { accessToken: t } = await requestToken();
    return t;
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
      await window.DB.kvDelete('user');
      await window.DB.kvDelete('auth.token');
      await window.DB.kvDelete('auth.expiresAt');
    } catch (e) { /* ignore */ }
    notifyChange();
  }

  function getUser() { return user; }
  function isSignedIn() { return !!accessToken && Date.now() < tokenExpiresAt; }

  return { init, signIn, signOut, getAccessToken, getUser, isSignedIn, onChange };
})();
