const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();
const initFirebaseAdmin = require('../lib/firebaseAdmin');
const authController = require('../controllers/auth.controller');
const rateLimiter = require('../middleware/rateLimiter');

/**
 * @openapi
 * /api/v1/auth/signup:
 *   post:
 *     summary: Create a new user (email/password)
 *
 * /api/v1/auth/login:
 *   post:
 *     summary: Login with email/password
 *
 * /api/v1/auth/magic-link:
 *   post:
 *     summary: Send magic link email
 *
 * /api/v1/auth/send-otp:
 *   post:
 *     summary: Send OTP
 *
 * /api/v1/auth/verify-otp:
 *   post:
 *     summary: Verify OTP
 *
 * /api/v1/auth/custom-token:
 *   post:
 *     summary: Create a custom token for uid or phone
 *
 * /api/v1/auth/me:
 *   get:
 *     summary: Get current user (requires Authorization header)
 */
// POST /api/v1/auth/signup
// Creates a Firebase Auth user (email/password) and returns a custom token the client can exchange
router.post('/signup', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const userRecord = await adm.auth().createUser({ email, password });
    const customToken = await adm.auth().createCustomToken(userRecord.uid);
    return res.json({ uid: userRecord.uid, customToken });
  } catch (err) {
    console.error('Error creating user:', err);
    // Map common Firebase error codes to friendly messages
    const code = err.code || err.error || '';
    if (code.includes('auth/email-already-exists') || code.includes('EMAIL_EXISTS')) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    return res.status(500).json({ error: 'Could not create user', details: err.message || err });
  }
});

// POST /api/v1/auth/login
// Signs in using Firebase REST API (email/password) and returns the ID token + refresh token
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Firebase API key not configured on server' });

  try {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const data = await r.json();
    if (!r.ok) {
      // Forward the error message from Firebase
      return res.status(401).json({ error: data.error || data });
    }
    // data contains idToken, refreshToken, expiresIn, localId, email
    return res.json(data);
  } catch (err) {
    console.error('Error signing in:', err);
    return res.status(500).json({ error: 'Login failed', details: err.message || err });
  }
});

// POST /api/v1/auth/magic-link
// Server-side send of an email sign-in link. Checks for an existing user profile in Firestore first.
router.post('/magic-link', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });

  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    // Check users collection for a profile with this email
    const usersCol = adm.firestore().collection('users');
    const q = usersCol.where('email', '==', email);
    const snap = await q.get();
    if (snap.empty) {
      return res.status(404).json({ error: 'No account found for this email' });
    }

    const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Firebase API key not configured on server' });

    const continueUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000/login';

    const url = `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`;
    const body = {
      requestType: 'EMAIL_SIGNIN',
      email,
      continueUrl,
      canHandleCodeInApp: true,
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(500).json({ error: 'Failed to send magic link', details: data });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Error sending magic link:', err);
    return res.status(500).json({ error: 'Failed to send magic link', details: err.message || err });
  }
});

// POST /api/v1/auth/send-otp
router.post('/send-otp', rateLimiter, async (req, res) => {
  return authController.sendOtpHandler(req, res);
});

// POST /api/v1/auth/resend-otp
router.post('/resend-otp', rateLimiter, async (req, res) => {
  return authController.sendOtpHandler(req, res);
});

// POST /api/v1/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  return authController.verifyOtpHandler(req, res);
});

// POST /api/v1/auth/custom-token
// Generates a Firebase custom token for a given `uid` or `phone`.
// If `phone` is provided, the server will ensure a Firebase user exists and return a token.
router.post('/custom-token', async (req, res) => {
  const { uid, phone } = req.body || {};
  if (!uid && !phone) return res.status(400).json({ error: 'uid or phone required' });

  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    if (phone) {
      // Delegate phone-handling to the existing auth service which creates or finds a user
      const authService = require('../services/auth.service');
      const result = await authService.createCustomTokenForPhone(phone);
      return res.json({ uid: result.uid, token: result.token });
    }

    // If uid provided, mint a custom token directly. Firebase will accept any uid.
    const token = await adm.auth().createCustomToken(uid);
    return res.json({ uid, token });
  } catch (err) {
    console.error('Error creating custom token:', err);
    return res.status(500).json({ error: 'Could not create custom token', details: err.message || err });
  }
});

// POST /api/v1/auth/verify-token
// Verify an ID token and return decoded claims
router.post('/verify-token', async (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'idToken required' });

  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const decoded = await adm.auth().verifyIdToken(idToken);
    return res.json({ decoded });
  } catch (err) {
    console.error('Error verifying id token:', err);
    return res.status(401).json({ error: 'Invalid token', details: err.message || err });
  }
});

// GET /api/v1/auth/me
// Protected route: expects Authorization: Bearer <idToken>
router.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  const idToken = match ? match[1] : null;
  if (!idToken) return res.status(401).json({ error: 'Authorization token missing' });

  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const decoded = await adm.auth().verifyIdToken(idToken);
    return res.json({ uid: decoded.uid, claims: decoded });
  } catch (err) {
    console.error('Error in /me:', err);
    return res.status(401).json({ error: 'Invalid token', details: err.message || err });
  }
});

// POST /api/v1/auth/logout
// Revokes the user's refresh tokens so existing ID tokens will expire
// Expects Authorization: Bearer <idToken>
router.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  const idToken = match ? match[1] : null;
  if (!idToken) return res.status(401).json({ error: 'Authorization token missing' });

  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    // Verify token first to ensure it's valid and extract uid
    const decoded = await adm.auth().verifyIdToken(idToken);
    try {
      // Revoke refresh tokens for the user; forces clients to reauthenticate
      await adm.auth().revokeRefreshTokens(decoded.uid);
      return res.json({ success: true });
    } catch (revErr) {
      console.error('Error revoking refresh tokens:', revErr);
      return res.status(500).json({ error: 'Logout failed', details: revErr.message || revErr });
    }
  } catch (err) {
    console.error('Error verifying token for logout:', err);
    return res.status(401).json({ error: 'Invalid token', details: err.message || err });
  }
});

module.exports = router;
