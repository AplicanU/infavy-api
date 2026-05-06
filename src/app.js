const express = require('express');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const useragent = require('express-useragent');
const basicAuth = require('./lib/basicAuth');

// Load .env.local if present (useful for local development), otherwise fall back to .env
const envLocalPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath });
} else {
  dotenv.config();
}

const app = express();
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';

const corsOptions = {
  origin: function (origin, callback) {
    if (ALLOWED_ORIGINS === '*' || !origin) return callback(null, true);
    const allowed = ALLOWED_ORIGINS.split(',').map((s) => s.trim());
    if (allowed.indexOf(origin) !== -1) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
};

app.use(cors(corsOptions));

// Use JSON parser for all routes except webhook routes which require raw body
const jsonBodyParser = express.json();
app.use((req, res, next) => {
  if (req.originalUrl && (req.originalUrl.startsWith('/api/v1/webhooks/razorpay') || req.originalUrl.startsWith('/api/v1/webhooks/revenuecat'))) return next();
  return jsonBodyParser(req, res, next);
});

// device detection: parse User-Agent and attach `req.deviceType` and `req.clientInfo`

app.use(useragent.express());
// header-first device/platform detection. prefer `x-client-platform` from trusted clients
app.use((req, res, next) => {
  const header = (req.get('x-client-platform') || '').toLowerCase();
  if (header) {
    if (header.includes('ios') || header.includes('iphone') || header.includes('ipad')) {
      req.devicePlatform = 'ios';
      req.deviceType = 'mobile';
    } else if (header.includes('android')) {
      req.devicePlatform = 'android';
      req.deviceType = 'mobile';
    } else if (header.includes('web')) {
      req.devicePlatform = 'web';
      req.deviceType = 'desktop';
    } else {
      // unknown header value — store raw and fall back to UA heuristics for type
      req.devicePlatform = header;
      req.deviceType = 'desktop';
    }

    req.clientInfo = { fromHeader: header, ua: req.get('user-agent') || '' };
    return next();
  }

  // fallback to User-Agent parsing (heuristic)
  const ua = req.useragent || {};
  const uaSource = (ua.source || req.get('user-agent') || '').toLowerCase();

  if (/android/.test(uaSource)) req.devicePlatform = 'android';
  else if (/(ipad|iphone|ipod)\b/.test(uaSource) || /iphone os|cpu os|ios/.test(uaSource)) req.devicePlatform = 'ios';
  else req.devicePlatform = 'web';

  if (ua.isTablet) req.deviceType = 'tablet';
  else if (ua.isMobile) req.deviceType = 'mobile';
  else req.deviceType = 'desktop';

  req.clientInfo = ua;
  next();
});

// Simple request logger to surface entry and progress in Vercel logs
app.use((req, res, next) => {
  const start = Date.now();
  console.log('[api] -> incoming', req.method, req.originalUrl, 'from', req.devicePlatform, req.deviceType);

  // safety timer: respond early for debugging if a handler stalls
  const safety = setTimeout(() => {
    if (!res.headersSent) {
      console.error('[api] -> safety timeout reached for', req.method, req.originalUrl, 'from', req.devicePlatform, req.deviceType);
      try {
        res.status(504).json({ error: 'Function safety timeout reached' });
      } catch (e) {
        console.error('[api] -> failed to send safety timeout response', e);
      }
    }
  }, 28 * 1000); // 28s

  res.on('finish', () => {
    clearTimeout(safety);
    console.log('[api] <- finished', req.method, req.originalUrl, 'status=', res.statusCode, 'dur=', Date.now() - start, 'ms');
  });

  next();
});

// Import and attach APIs + UI
const routePrefix = '/api/v1';
const attachApis = require('./apis');
const attachUi = require('./ui');

attachApis(app, routePrefix);

// Protect the API explorer UI when UI_BASIC_USER/UI_BASIC_PASS are set
app.use(basicAuth);

attachUi(app);

module.exports = app;
