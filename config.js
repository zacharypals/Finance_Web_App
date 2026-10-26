// Finance Pal — shared front-end config (no secrets belong in this file; it is public).
window.FP_CONFIG = {
  // Printed by `wrangler deploy`. Update if your workers.dev subdomain differs.
  API_URL: 'https://finance-api.plannertracker.workers.dev',
  GOOGLE_CLIENT_ID: '760221993582-3nakfl51js22pij1am369v8cnhu4kr4e.apps.googleusercontent.com',
  REDIRECT_URI: 'https://zacharypals.github.io/Finance_Web_App/oauth.html',
};

// localStorage keys are prefixed "fp_" because every page on zacharypals.github.io
// (including the LP Planner) shares one origin and therefore one localStorage.
window.FP_KEYS = {
  session: 'fp_session',
  email: 'fp_email',
  oauthState: 'fp_oauth_state',
  authError: 'fp_auth_error',
  plaidRedirect: 'fp_plaid_oauth_redirect',
  plaidLink: 'fp_plaid_link',   // {token, type, itemId, t} saved while Plaid Link is open (for bank OAuth round-trips)
};
