# Auth architecture

This file documents how Google sign-in works in the Site Visit Logger across browser and installed-PWA contexts, why the architecture is what it is, and what was tried first.

## TL;DR

- **Desktop Chrome / Edge** → GIS popup (`google.accounts.oauth2.requestAccessToken({prompt:'select_account'})`).
- **Safari browser** and **iOS PWA standalone** → PKCE Authorization Code flow with full-page redirect to Google, code exchange via a **Cloudflare Worker proxy** that holds the OAuth `client_secret` server-side.
- Refresh tokens (`access_type=offline`) keep PWA users signed in across reloads via the same Worker.

## Why this exists: iOS PWA cookie isolation

When an installed iOS PWA navigates to an external URL (e.g. `accounts.google.com`), iOS opens that URL in an `SFSafariViewController`-style in-app browser sheet (the one with the "Done" button top-left). That sheet has its own cookie jar, **isolated from both the PWA's webview and regular Safari**. Google's OAuth completion needs cookie context to validate 2FA — and the OAuth sheet has none of the cookies the user established when they were "logged into Google" elsewhere on the device.

This breaks any OAuth flow that depends on cookie continuity between the OAuth sheet and the PWA — which is every "popup" or "implicit redirect with `response_type=token`" pattern.

PKCE Authorization Code flow doesn't have this problem because the token exchange (`code` → `access_token`) happens via `fetch()` POST from inside the PWA's own webview after the redirect returns. The cookie isolation in the OAuth sheet during the user-facing auth step is irrelevant to the exchange step.

## Why the Worker proxy

The OAuth client registered at `console.cloud.google.com` for `elona-svg.github.io` is a "Web application" client type. Google's `oauth2.googleapis.com/token` endpoint **requires `client_secret` from a Web application client, even when using PKCE**. We confirmed this empirically — direct browser POSTs returned `invalid_request: client_secret is missing`.

Embedding the secret in the static site is a non-starter — the repo is public, GitHub Pages is public, and GitHub's secret-scanning bots auto-revoke leaked Google credentials within minutes.

The Worker is a tiny token-exchange proxy:

- **URL:** `https://dancon-token-proxy.dancon-services.workers.dev`
- **Source:** managed in the Cloudflare dashboard (not in this repo)
- **Accepts:** `POST` with `{code, code_verifier, redirect_uri, grant_type: 'authorization_code'}` or `{refresh_token, grant_type: 'refresh_token'}`
- **Injects** `client_id` and `client_secret` server-side
- **Returns** Google's token response verbatim (`{access_token, expires_in, refresh_token?, scope, token_type}` or `{error, error_description}`)
- **Should** validate the `Origin` header is `https://elona-svg.github.io` so it can't be reused as a free token-minting service for any website with our `client_id`.

## Flow selection

Two factors decide which flow to use, computed once at module init in [docs/js/auth.js](docs/js/auth.js):

```js
const IS_STANDALONE = window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;
const IS_SAFARI_BROWSER = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
const USE_REDIRECT = IS_STANDALONE || IS_SAFARI_BROWSER;
```

The `!Chrome` guard correctly excludes desktop Chrome / Edge (which include "Safari" in UA for compatibility). iOS Chrome uses `CriOS` (no `Chrome` token) and is bucketed as Safari — correct, since it's WebKit-under-the-hood and has the same cookie isolation issue.

| Context | `USE_REDIRECT` | Flow |
|---|---|---|
| Desktop Chrome / Edge / Firefox | `false` | GIS popup |
| Safari browser (any platform) | `true` | PKCE redirect via Worker |
| Installed iOS PWA standalone | `true` | PKCE redirect via Worker |

## PKCE flow walk-through

Functions in [docs/js/auth.js](docs/js/auth.js):

1. User taps **Sign in with Google** → `signIn()` → `signInViaRedirect()`.
2. Generate random `state` nonce and `code_verifier` (64 random bytes, base64url-no-padding); compute `code_challenge` = SHA-256 of verifier, same encoding.
3. Save `state` to `localStorage['auth.oauth_state']` and verifier to `localStorage['auth.pkce_verifier']` (single-use, deleted on consume).
4. Navigate to `accounts.google.com/o/oauth2/v2/auth` with:
   - `response_type=code`
   - `code_challenge=<challenge>`, `code_challenge_method=S256`
   - `access_type=offline` (required for refresh_token issuance)
   - `prompt=select_account`, `hd=danconservices.com`
   - `scope=https://www.googleapis.com/auth/drive openid email profile`
5. User completes Google's auth + 2FA.
6. Google redirects to `https://elona-svg.github.io/dancon-site-visit-logger/?code=…&state=…`.
7. App boots fresh; `init()` calls `consumeRedirectCallback()` which dispatches to `handleCodeFlow()` (query-string `code`) or `handleImplicitFlow()` (legacy hash `access_token`, kept as fallback for in-flight redirects mid-deploy).
8. `handleCodeFlow()` validates `state`, then `POST {code, code_verifier, redirect_uri, grant_type: 'authorization_code'}` to the Worker.
9. Worker returns `{access_token, refresh_token, expires_in, …}`.
10. Persist `access_token` to IDB + localStorage, persist `refresh_token` to IDB + localStorage (`auth.refresh_token`), call `fetchAndVerifyUser()` for the email/name/picture, `setTokenStatus('valid')`, render home.

## Refresh-token flow

`tryRefreshTokenGrant()` runs **first** inside `requestTokenWithRetries()` before any GIS fallback:

1. Read `auth.refresh_token` from IDB (preferred) or localStorage.
2. `POST {refresh_token, grant_type: 'refresh_token'}` to the Worker.
3. On success: update in-memory `accessToken` / `tokenExpiresAt`, `persistToken()`, `setTokenStatus('valid')`.
4. On `invalid_grant`: the refresh_token is dead (revoked, expired, or user changed password) — purge it from IDB + localStorage so we don't keep retrying. The next user action will fall through to interactive sign-in.
5. On network error: silent fall-through to the GIS iframe retry loop (which itself fast-fails for PWAs without a user).

## PWA cold-start gating

The GIS iframe `requestAccessToken({prompt:''})` path times out 5–6× ten seconds in the SFSafariViewController sandbox before giving up. We short-circuit it:

```js
if (USE_REDIRECT && !user && !lsGet(REFRESH_TOKEN_KEY)) {
  throw new Error('SIGN_IN_REQUIRED');  // skip GIS retries
}
```

…and gate the upstream callers too: `pumpQueue` no-ops without `isSignedIn()`, and `startReconnectLoop` checks `isSignedIn()` at entry and on each tick. This keeps the login screen responsive on a fresh install — no 60-second silent-refresh chain before the user can tap **Sign in**.

## Required Google Cloud Console setup

OAuth 2.0 Client ID (Web application type) at `console.cloud.google.com → APIs & Services → Credentials`:

- **Authorized JavaScript origins:** `https://elona-svg.github.io`
- **Authorized redirect URIs:** `https://elona-svg.github.io/dancon-site-visit-logger/` (exact, with trailing slash)

The Worker URL is **not** registered with Google — only the browser-facing redirect URI is. Worker → Google calls go server-to-server with the secret.

## Five approaches tried before landing here

| # | Approach | Result |
|---|---|---|
| 1 | **GIS popup** (`requestAccessToken` with `prompt:'select_account'`) | Works in browser Safari and desktop. Breaks in installed iOS PWA — the popup's `postMessage` never reaches the PWA's window because of process isolation. |
| 2 | **GIS redirect, implicit grant** (`response_type=token`) for PWA only, popup for browser | Opens OAuth in SFSafariViewController sheet inside the PWA. 2FA fails with Google's "Something went wrong" because the sheet's cookie jar is isolated from the PWA. |
| 3 | **GIS One Tap** (inline iframe via `google.accounts.id`) for PWA | One Tap renders inline so cookies stay in the PWA — but it only returns an ID token, not an access token. The follow-up `requestAccessToken` call falls back to the same broken iframe path that fails in the sandbox. |
| 4 | **PKCE Authorization Code flow direct from browser** to `oauth2.googleapis.com/token` | Rejected at planning — Google's "Web application" client type requires `client_secret` even with PKCE; verified empirically with `invalid_request: client_secret is missing`. |
| 5 | **PKCE with `client_secret` embedded in source** | Rejected — public repo + public github.io site = leaked credentials within minutes; Google auto-revokes; not a viable long-term path. |
| **6** | **PKCE via Cloudflare Worker proxy** *(current)* | Worker holds the secret server-side; browser only sees the Worker URL. Works in browser Safari, installed iOS PWA, and supports `refresh_token` for persistent sign-in. |

## Files

- [docs/js/auth.js](docs/js/auth.js) — all sign-in logic. Key functions: `signIn`, `signInViaRedirect`, `consumeRedirectCallback`, `handleCodeFlow`, `handleImplicitFlow`, `tryRefreshTokenGrant`, `requestTokenWithRetries`, `hardSignOut`, `initOneTap` (kept for reference, not currently invoked).
- [docs/js/config.js](docs/js/config.js) — `CLIENT_ID`, `TOKEN_PROXY_URL`, `HOSTED_DOMAIN`, `SCOPES`.
- [docs/js/app.js](docs/js/app.js) — login screen rendering, on-screen debug log panel, `pumpQueue` and reconnect-loop gates.
- Cloudflare Worker source — **not** in this repo; managed in the Cloudflare dashboard.

## Debug log

The login screen has an on-screen log panel ([docs/js/app.js](docs/js/app.js) → `appendDebugLine`) that mirrors every `[auth]`-prefixed `console.log` / `.warn` / `.error`. A successful PWA sign-in looks like:

```
[auth] standalone mode: true — safari browser: true
[auth] init restored — user? false token? false …
[auth] PWA cold start, no refresh token — skipping GIS retries (sign in required)
[auth] tokenStatus → failed (SIGN_IN_REQUIRED)
  …user taps Sign in with Google…
[auth] signIn() called
[auth] using flow: redirect
[auth] redirecting to OAuth URL (PKCE code flow)
  …Google sign-in + 2FA…
[auth] PKCE: code received, exchanging via token proxy...
[auth] PKCE: token exchange success (with refresh_token)
[auth] token persisted, user signed in: elona@danconservices.com
```

Failure modes to recognize:

- `network error: Failed to fetch` on token exchange → Worker CORS misconfig, or Worker preflight (`OPTIONS`) not handled.
- `token exchange failed: invalid_grant` → redirect URI mismatch in Google Cloud Console, or stale `code` (re-tap sign-in).
- `state mismatch — possible CSRF, ignoring response` → localStorage was evicted between redirect-out and return (Safari ITP can do this on cold devices); harmless if user re-tries sign-in.
- `refresh_token grant failed: invalid_grant` → refresh token revoked or expired; auto-purged, user falls through to interactive sign-in next time.
