const express = require('express');
const crypto = require('crypto');

const router = express.Router();

// POST / - returns requested public environment variables after verifying token
// Request body: { names: ["PUBLIC_FOO", "PUBLIC_BAR", ...] }
// Token must be provided in header `x-public-env-token` or in body `token`.
// Only environment variables that begin with the allowed prefix will be returned.

router.post('/', (req, res) => {
  const providedToken = (req.get('x-public-env-token') || (req.body && req.body.token) || '').toString();
  const expectedToken = (process.env.PUBLIC_VARS_TOKEN || process.env.VARS_EXPOSE_TOKEN || '').toString();

  if (!expectedToken) return res.status(500).json({ error: 'Public env token not configured' });

  try {
    const a = Buffer.from(providedToken);
    const b = Buffer.from(expectedToken);
    if (!providedToken || providedToken.length !== expectedToken.length) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let namesRaw = req.body && req.body.names;
  let names = [];
  if (Array.isArray(namesRaw)) names = namesRaw;
  else if (typeof namesRaw === 'string') {
    names = namesRaw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (names.length > 100) return res.status(400).json({ error: 'Too many names requested' });

  const prefix = process.env.PUBLIC_VARIABLE_PREFIX || 'PUBLIC_';
  const values = {};

  names.forEach((name) => {
    if (typeof name !== 'string') return;
    if (!name.startsWith(prefix)) return;
    if (Object.prototype.hasOwnProperty.call(process.env, name)) {
      values[name] = process.env[name];
    }
  });

  return res.json({ ok: true, values });
});

module.exports = router;
