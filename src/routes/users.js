const express = require('express');
const initFirebaseAdmin = require('../lib/firebaseAdmin');

const router = express.Router();

// GET /:uid - fetch user document
router.get('/:uid', async (req, res) => {
  const uid = req.params.uid;
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ error: 'Firebase Admin not initialized' });

  try {
    const docRef = admin.firestore().collection('users').doc(uid);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found' });
    const data = snap.data();
    return res.json({ ok: true, user: data });
  } catch (err) {
    console.error('[users] GET error', err);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// PUT /:uid - update displayName and/or photo (accepts base64 image in `photoBase64`)
router.put('/:uid', async (req, res) => {
  const uid = req.params.uid;
  const { displayName, photoBase64 } = req.body || {};
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ error: 'Firebase Admin not initialized' });

  try {
    const updates = {};

    // Update displayName if provided
    if (typeof displayName === 'string' && displayName.trim().length > 0) {
      updates.displayName = displayName.trim();
    }

    // Handle base64 photo upload if provided
    if (photoBase64) {
      // Allow data URLs or plain base64
      let matches = photoBase64.match(/^data:(image\/[^;]+);base64,(.+)$/);
      let mimeType = 'image/jpeg';
      let base64Data = photoBase64;
      if (matches) {
        mimeType = matches[1];
        base64Data = matches[2];
      }

      const buffer = Buffer.from(base64Data, 'base64');
      const bucket = admin.storage().bucket();
      const filePath = `UserData/${uid}/avatar.jpg`;
      const file = bucket.file(filePath);

      await file.save(buffer, {
        metadata: { contentType: mimeType },
        resumable: false,
      });

      // Create a signed URL for read access
      const [url] = await file.getSignedUrl({ action: 'read', expires: '03-09-2491' });
      updates.photoURL = url;
    }

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updates provided' });

    const docRef = admin.firestore().collection('users').doc(uid);
    await docRef.update(updates);
    const snap = await docRef.get();
    return res.json({ ok: true, user: snap.data() });
  } catch (err) {
    console.error('[users] PUT error', err);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /:uid - archive user reference to `deletedUsers` and remove account
router.delete('/:uid', async (req, res) => {
  const uid = req.params.uid;
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ error: 'Firebase Admin not initialized' });

  try {
    const docRef = admin.firestore().collection('users').doc(uid);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found' });
    const userData = snap.data();

    // Save a copy into `deletedUsers` collection for reference by other tables
    const deletedRef = admin.firestore().collection('deletedUsers').doc(uid);
    await deletedRef.set({
      uid,
      deletedAt: admin.firestore.FieldValue.serverTimestamp(),
      userData,
    });

    // Remove the user document from `users`
    await docRef.delete();

    // Attempt to remove the Auth user as well (best-effort)
    try {
      await admin.auth().deleteUser(uid);
    } catch (authErr) {
      console.warn('[users] failed to delete auth user', uid, authErr);
    }

    return res.json({ ok: true, uid });
  } catch (err) {
    console.error('[users] DELETE error', err);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
