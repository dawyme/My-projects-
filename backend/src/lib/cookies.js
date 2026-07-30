const secure = String(process.env.COOKIE_SECURE || 'false') === 'true';
const domain = process.env.COOKIE_DOMAIN || undefined;

const ACCESS_COOKIE = 'hvac_access';
const REFRESH_COOKIE = 'hvac_refresh';
const CSRF_COOKIE = 'hvac_csrf';

const base = { httpOnly: true, secure, sameSite: secure ? 'none' : 'lax', domain, path: '/' };

function setAuthCookies(res, { accessToken, refreshToken, refreshExpires }) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...base, maxAge: 15 * 60 * 1000 });
  if (refreshToken) {
    res.cookie(REFRESH_COOKIE, refreshToken, {
      ...base,
      maxAge: Math.max(0, new Date(refreshExpires).getTime() - Date.now()),
    });
  }
}

// The CSRF cookie is deliberately preserved: it is not a session secret, and
// clearing it would break the very next authenticated request from the client.
function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...base });
  res.clearCookie(REFRESH_COOKIE, { ...base });
}

function setCsrfCookie(res, token) {
  res.cookie(CSRF_COOKIE, token, { ...base, httpOnly: false, maxAge: 12 * 3600 * 1000 });
}

module.exports = { ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE, setAuthCookies, clearAuthCookies, setCsrfCookie };
