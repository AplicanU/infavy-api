const initFirebaseAdmin = require('../lib/firebaseAdmin');

// Middleware that enforces per-phone OTP request limits (delegates to Firestore record checks)
module.exports = async function rateLimiter(req, res, next) {
  const phone = (req.body && req.body.phone) || null;
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (!phone) return res.status(400).json({ error: { code: 'PHONE_REQUIRED', message: 'phone is required' } });

  try {
    const adm = initFirebaseAdmin();
    if (!adm) return res.status(500).json({ error: { code: 'FIREBASE_NOT_INIT', message: 'Firebase Admin not initialized' } });
    const col = adm.firestore().collection('otps');
    const id = `otp:${phone.replace(/[^0-9]/g, '')}`;
    const doc = await col.doc(id).get();
    const now = Math.floor(Date.now() / 1000);
    const REQUEST_WINDOW_MINUTES = 10;
    const MAX_REQUESTS_PER_WINDOW = 3; // per phone
    const MAX_IP_REQUESTS_PER_WINDOW = 3; // per IP for this phone
    if (!doc.exists) return next();
    const rec = doc.data();
    const windowFrom = now - REQUEST_WINDOW_MINUTES * 60;
    const recent = Array.isArray(rec.requestLog) ? rec.requestLog.filter((r) => r.ts >= windowFrom) : [];
    if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
      return res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message: 'Too many OTP requests for this phone' } });
    }
    const recentFromIp = recent.filter((r) => r.ip === ip);
    if (recentFromIp.length >= MAX_IP_REQUESTS_PER_WINDOW) {
      return res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS_IP', message: 'Too many OTP requests from this IP for this phone' } });
    }
    return next();
  } catch (err) {
    console.error('rateLimiter error', err);
    return res.status(500).json({ error: { code: 'RATE_LIMITER_ERROR', message: 'Rate limiter failed' } });
  }
};
