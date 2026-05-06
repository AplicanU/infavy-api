const express = require('express');
const initFirebaseAdmin = require('../lib/firebaseAdmin');

const router = express.Router();

/**
 * @openapi
 * /api/v1/profiles/{uid}:
 *   get:
 *     summary: Get profiles for a user
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema:
 *           type: string
 *
 * /api/v1/profiles:
 *   post:
 *     summary: Create a profile
 *
 * /api/v1/profiles/{id}:
 *   put:
 *     summary: Update a profile
 */
// GET /:uid - fetch all profiles for a given user
router.get('/:uid', async (req, res) => {
  const uid = req.params.uid;
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ error: 'Firebase Admin not initialized' });

  try {
    const q = admin.firestore().collection('profiles').where('userId', '==', uid);
    const snap = await q.get();
    const profiles = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, profiles });
  } catch (err) {
    console.error('[profiles] GET error', err);
    return res.status(500).json({ error: 'Failed to fetch profiles' });
  }
});

// POST / - create a new profile
router.post('/', async (req, res) => {
  const { userId, name, avatarColor, avatarId } = req.body || {};
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ error: 'Firebase Admin not initialized' });

  if (!userId || !name) return res.status(400).json({ error: 'Missing required fields: userId and name' });

  try {
    const docRef = await admin.firestore().collection('profiles').add({
      userId,
      name,
      avatarColor: avatarColor || null,
      avatarId: avatarId || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const snap = await docRef.get();
    return res.status(201).json({ ok: true, profile: { id: docRef.id, ...snap.data() } });
  } catch (err) {
    console.error('[profiles] POST error', err);
    return res.status(500).json({ error: 'Failed to create profile' });
  }
});

// PUT /:id - update an existing profile
router.put('/:id', async (req, res) => {
  const id = req.params.id;
  const { name, avatarColor, avatarId } = req.body || {};
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ error: 'Firebase Admin not initialized' });

  try {
    const docRef = admin.firestore().collection('profiles').doc(id);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Profile not found' });

    const updates = {};
    if (typeof name === 'string' && name.trim().length > 0) updates.name = name.trim();
    if (avatarColor !== undefined) updates.avatarColor = avatarColor;
    if (avatarId !== undefined) updates.avatarId = avatarId;

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updates provided' });

    await docRef.update(updates);
    const updated = await docRef.get();
    return res.json({ ok: true, profile: { id: updated.id, ...updated.data() } });
  } catch (err) {
    console.error('[profiles] PUT error', err);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
