// Google Identity Services OAuth2 token client.
// Returns access tokens for the Drive scope. Expires after ~1 hour, refreshed
// silently via prompt='' (uses the existing Google session — no UI flicker).
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
        if (Date.now() - start > 10000) return reject(new Error('Google Identity Services failed to load'));
        setTimeout(check, 100);
      })();
    });
  }

  async function init() {
    await gisReady();

    if (window.CONFIG.CLIENT_ID.startsWith('__REPLACE')) {
      throw new Error(
        'OAuth not configured: edit js/config.js and set CLIENT_ID. See README.'
      );
    }

    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: window.CONFIG.CLIENT_ID,
      scope: window.CONFIG.SCOPES,
      hd: window.CONFIG.HOSTED_DOMAIN, // restricts the chooser to the workspace domain
      prompt: '',
      callback: () => { /* set per-request below */ }
    });

    // Restore cached user (token must be re-acquired after a reload).
    const cachedUser = await window.DB.kvGet('user');
    if (cachedUser) user = cachedUser;
  }

  // Request an access token. opts: { interactive: bool }
  function requestToken(opts = {}) {
    return new Promise((resolve, reject) => {
      if (!tokenClient) return reject(new Error('Auth not initialized'));

      tokenClient.callback = async (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        accessToken = resp.access_token;
        // expires_in is seconds; subtract 60s buffer.
        tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000;
        try {
          await fetchAndVerifyUser();
          notifyChange();
          resolve({ accessToken, user });
        } catch (err) {
          accessToken = null;
          notifyChange();
          reject(err);
        }
      };

      // Empty prompt lets Google decide: silent if scopes are already granted,
      // popup on first auth. We never force 'consent' — that re-prompts on
      // every sign-in for no benefit.
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
  // forceRefresh=true after a 401 to bypass the in-memory timer (the token
  // may have been revoked even though our expiry clock thinks it's fresh).
  async function getAccessToken(forceRefresh = false) {
    if (!forceRefresh && accessToken && Date.now() < tokenExpiresAt) return accessToken;
    accessToken = null;
    tokenExpiresAt = 0;
    const { accessToken: t } = await requestToken({ interactive: false });
    return t;
  }

  async function signIn() {
    return requestToken({ interactive: true });
  }

  async function signOut() {
    if (accessToken && window.google?.accounts?.oauth2?.revoke) {
      try { window.google.accounts.oauth2.revoke(accessToken, () => {}); } catch (e) { /* ignore */ }
    }
    accessToken = null;
    tokenExpiresAt = 0;
    user = null;
    await window.DB.kvDelete('user');
    notifyChange();
  }

  function getUser() { return user; }
  function isSignedIn() { return !!accessToken && Date.now() < tokenExpiresAt; }

  return {
    init,
    signIn,
    signOut,
    getAccessToken,
    getUser,
    isSignedIn,
    onChange
  };
})();
