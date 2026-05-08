// Edit CLIENT_ID after creating an OAuth client in Google Cloud Console.
// See README.md → "OAuth setup" for step-by-step instructions.
window.CONFIG = {
  CLIENT_ID: '266285578217-2gr3mn0ad7njl017ocfdk9otknhgu2a0.apps.googleusercontent.com',

  // Cloudflare Worker that holds the OAuth client_secret server-side and
  // proxies POSTs to oauth2.googleapis.com/token for the PKCE code flow
  // and refresh_token grant. Keeping the secret out of this repo.
  TOKEN_PROXY_URL: 'https://dancon-token-proxy.dancon-services.workers.dev',

  // Restrict the Google account chooser to a single Workspace domain.
  // Note: this is a UX hint — the email-domain check in auth.js is the real gate.
  HOSTED_DOMAIN: 'danconservices.com',

  // Drive scope is broad enough to read/write inside the shared "Site Visits"
  // folder regardless of which teammate created a given file.
  SCOPES: 'https://www.googleapis.com/auth/drive openid email profile',

  // Parent Drive folder where all project folders live.
  SITE_VISITS_FOLDER_ID: '10qzHqY5bY71_QQjNYqYv1l8SXC9Zfn4A',

  // Photo capture defaults.
  PHOTO_JPEG_QUALITY: 0.92,
  PHOTO_MAX_DIMENSION: 2560, // longest edge in pixels; downsamples huge sensors

  // Retry/backoff for failed uploads (ms).
  RETRY_BASE_DELAY: 2000,
  RETRY_MAX_DELAY: 60000
};
