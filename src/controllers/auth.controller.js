const otpService = require('../services/otp.service');
const authService = require('../services/auth.service');

function structuredError(res, status, code, message, extras = {}) {
  return res.status(status).json({ error: { code, message, ...extras } });
}

async function sendOtpHandler(req, res) {
  const { phone } = req.body || {};
  if (!phone) return structuredError(res, 400, 'PHONE_REQUIRED', 'phone is required');

  try {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const result = await otpService.sendOtp(phone, ip);
    // In production, the server would send SMS via provider and not return OTP
    // For testing/development we return a hint (but production should avoid this)
    return res.json({ success: true, hint: process.env.NODE_ENV === 'production' ? undefined : { otp: result.otp }, expiresAt: result.expiresAt });
  } catch (err) {
    console.error('sendOtpHandler error', err);
    if (err.code === 'INVALID_PHONE') return structuredError(res, 400, err.code, err.message);
    if (err.code === 'TOO_MANY_REQUESTS') return structuredError(res, 429, err.code, err.message);
    if (err.code === 'RESEND_COOLDOWN') return structuredError(res, 429, err.code, err.message, { retryAfter: err.retryAfter });
    if (err.code === 'SMS_NOT_CONFIGURED') return structuredError(res, 500, err.code, err.message);
    return structuredError(res, 500, 'SEND_OTP_FAILED', 'Failed to send OTP');
  }
}

async function verifyOtpHandler(req, res) {
  const { phone, otp } = req.body || {};
  if (!phone || !otp) return structuredError(res, 400, 'PHONE_OTP_REQUIRED', 'phone and otp required');

  try {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    await otpService.verifyOtp(phone, otp, ip);
    const { uid, token, isNewUser } = await authService.createCustomTokenForPhone(phone);
    return res.json({ success: true, token, isNewUser, uid });
  } catch (err) {
    console.error('verifyOtpHandler error', err);
    if (err.code === 'OTP_NOT_FOUND') return structuredError(res, 404, err.code, err.message);
    if (err.code === 'OTP_EXPIRED') return structuredError(res, 410, err.code, err.message);
    if (err.code === 'VERIFICATION_LOCKED') return structuredError(res, 423, err.code, err.message, { lockedUntil: err.lockedUntil });
    if (err.code === 'OTP_INVALID') return structuredError(res, 401, err.code, err.message, { attempts: err.attempts });
    return structuredError(res, 500, 'VERIFY_OTP_FAILED', 'Failed to verify OTP');
  }
}

module.exports = { sendOtpHandler, verifyOtpHandler };
