const initFirebaseAdmin = require('../lib/firebaseAdmin');
const { generateNumericOtp } = require('../utils/otpGenerator');
const { hashOtp, verifyOtpHash } = require('../utils/hash');
const smsService = require('./smsService');

const DEFAULT_EXPIRY_MINUTES = 5;
const DEFAULT_MAX_ATTEMPTS = 5;
const REQUEST_WINDOW_MINUTES = 10; // for rate limiting
const MAX_REQUESTS_PER_WINDOW = 3; // per phone
const RESEND_COOLDOWN_SECONDS = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 30);

function nowTs() { return Math.floor(Date.now() / 1000); }

function docIdForPhone(phone) {
  // Firestore doc id: otp:{digits}
  const digits = phone.replace(/[^0-9]/g, '');
  return `otp:${digits}`;
}

async function sendOtp(phone, ip = 'unknown') {
  if (!/^\+91\d{10}$/.test(phone)) {
    const err = new Error('Invalid Indian phone format, must be +91XXXXXXXXXX');
    err.code = 'INVALID_PHONE';
    throw err;
  }

  const adm = initFirebaseAdmin();
  if (!adm) throw new Error('Firebase Admin not initialized');

  const col = adm.firestore().collection('otps');
  const id = docIdForPhone(phone);
  const docRef = col.doc(id);
  const doc = await docRef.get();

  const now = nowTs();
  // Rate limiting: check request timestamps in last REQUEST_WINDOW_MINUTES
  let record = doc.exists ? doc.data() : null;
  const windowFrom = now - REQUEST_WINDOW_MINUTES * 60;
  const recentRequests = (record && Array.isArray(record.requestLog))
    ? record.requestLog.filter((r) => r.ts >= windowFrom)
    : [];
  if (recentRequests.length >= MAX_REQUESTS_PER_WINDOW) {
    const err = new Error('Too many OTP requests for this phone recently');
    err.code = 'TOO_MANY_REQUESTS';
    throw err;
  }

  // Resend cooldown: if last request was too recent
  if (record && record.lastRequestedAt && (now - record.lastRequestedAt) < RESEND_COOLDOWN_SECONDS) {
    const retryAfter = RESEND_COOLDOWN_SECONDS - (now - record.lastRequestedAt);
    const err = new Error('Resend cooldown active');
    err.code = 'RESEND_COOLDOWN';
    err.retryAfter = retryAfter;
    throw err;
  }

  // Generate OTP
  const otp = generateNumericOtp(6);
  const hashed = await hashOtp(otp);

  const expiresAt = now + DEFAULT_EXPIRY_MINUTES * 60;

  const newRecord = {
    phone,
    hashedOtp: hashed,
    createdAt: now,
    lastRequestedAt: now,
    expiresAt,
    attempts: 0,
    lockedUntil: null,
    requestLog: [...recentRequests, { ts: now, ip }],
  };

  await docRef.set(newRecord, { merge: true });

  // Send SMS via smsService (DLT provider)
  const smsResult = await smsService.sendOtpSms(phone, otp, { templateId: process.env.DLT_TEMPLATE_ID });

  return { expiresAt, smsResult, otp: process.env.NODE_ENV === 'production' ? undefined : otp };
}

async function verifyOtp(phone, otp, ip = 'unknown') {
  const adm = initFirebaseAdmin();
  if (!adm) throw new Error('Firebase Admin not initialized');

  const col = adm.firestore().collection('otps');
  const id = docIdForPhone(phone);
  const docRef = col.doc(id);
  const snap = await docRef.get();
  if (!snap.exists) {
    const err = new Error('No OTP request found for this phone');
    err.code = 'OTP_NOT_FOUND';
    throw err;
  }

  const record = snap.data();
  const now = nowTs();

  if (record.lockedUntil && now < record.lockedUntil) {
    const err = new Error('Verification locked due to multiple failed attempts');
    err.code = 'VERIFICATION_LOCKED';
    err.lockedUntil = record.lockedUntil;
    throw err;
  }

  if (record.expiresAt && now > record.expiresAt) {
    // delete expired record
    await docRef.delete();
    const err = new Error('OTP expired');
    err.code = 'OTP_EXPIRED';
    throw err;
  }

  // Verify hash
  let ok = false;
  try {
    ok = await verifyOtpHash(otp, record.hashedOtp);
  } catch (e) {
    ok = false;
  }

  if (!ok) {
    const attempts = (record.attempts || 0) + 1;
    const update = { attempts };
    let lockedUntil = record.lockedUntil || null;
    if (attempts >= DEFAULT_MAX_ATTEMPTS) {
      // lock for 15 minutes
      lockedUntil = now + 15 * 60;
      update.lockedUntil = lockedUntil;
    }
    // append failed attempt to requestLog for auditing
    const newLog = Array.isArray(record.requestLog) ? [...record.requestLog, { ts: now, ip, success: false }] : [{ ts: now, ip, success: false }];
    update.requestLog = newLog;
    await docRef.set(update, { merge: true });
    // log suspicious
    console.warn('OTP verification failed', { phone, ip, attempts });
    const err = new Error('Invalid OTP');
    err.code = 'OTP_INVALID';
    err.attempts = attempts;
    if (lockedUntil) err.lockedUntil = lockedUntil;
    throw err;
  }

  // Success: delete record and return true
  await docRef.delete();
  return true;
}

module.exports = { sendOtp, verifyOtp };
