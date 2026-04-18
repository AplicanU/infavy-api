// Basic HTTP auth middleware for protecting the API explorer UI
// Enabled when both UI_BASIC_USER and UI_BASIC_PASS env vars are set.
module.exports = function basicAuth(req, res, next) {
  try {
    const user = process.env.UI_BASIC_USER;
    const pass = process.env.UI_BASIC_PASS;

    // If not configured, middleware is a no-op
    if (!user || !pass) return next();

    const authHeader = (req.get('authorization') || '').trim();
    if (!authHeader || !authHeader.toLowerCase().startsWith('basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="API Explorer"');
      return res.status(401).send('Unauthorized');
    }

    const b64 = authHeader.slice(6).trim();
    let creds = '';
    try { creds = Buffer.from(b64, 'base64').toString('utf8'); } catch (e) { creds = ''; }
    const idx = creds.indexOf(':');
    const reqUser = idx === -1 ? creds : creds.slice(0, idx);
    const reqPass = idx === -1 ? '' : creds.slice(idx + 1);

    const crypto = require('crypto');
    const safeEqual = (a, b) => {
      const bufA = Buffer.from(String(a));
      const bufB = Buffer.from(String(b));
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    };

    if (safeEqual(reqUser, user) && safeEqual(reqPass, pass)) return next();

    res.set('WWW-Authenticate', 'Basic realm="API Explorer"');
    return res.status(401).send('Unauthorized');
  } catch (err) {
    console.error('[basicAuth] error', err);
    return res.status(500).send('Auth error');
  }
};
