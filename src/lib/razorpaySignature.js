const crypto = require('crypto');

/**
 * Verify Razorpay webhook signature using HMAC SHA256.
 * @param {Buffer} rawBody - The raw request body (Buffer).
 * @param {string} signature - The value of the x-razorpay-signature header.
 * @param {string} secret - The webhook secret from env.
 * @returns {boolean}
 */
function verifyRazorpaySignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;

  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const digest = hmac.digest('hex');

    const sigBuf = Buffer.from(signature, 'utf8');
    const digestBuf = Buffer.from(digest, 'utf8');

    // Use timingSafeEqual to avoid timing attacks. Lengths must match.
    if (sigBuf.length !== digestBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, digestBuf);
  } catch (e) {
    console.error('[razorpaySignature] verification error', e);
    return false;
  }
}

module.exports = verifyRazorpaySignature;
