const crypto = require('crypto');

/**
 * Verify RevenueCat webhook signature using HMAC SHA256.
 * Note: RevenueCat supports signing webhooks; verify using the shared secret
 * if provided in env var `REVENUECAT_WEBHOOK_SECRET`.
 * Header expected: `x-revenuecat-signature` or `revenuecat-signature`.
 */
function verifyRevenuecatSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;

  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const digest = hmac.digest('hex');

    const sigBuf = Buffer.from(signature, 'utf8');
    const digestBuf = Buffer.from(digest, 'utf8');

    if (sigBuf.length !== digestBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, digestBuf);
  } catch (e) {
    console.error('[revenuecatSignature] verification error', e);
    return false;
  }
}

module.exports = verifyRevenuecatSignature;
