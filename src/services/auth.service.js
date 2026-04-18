const initFirebaseAdmin = require('../lib/firebaseAdmin');

async function ensureFirebaseUserForPhone(phone) {
  const adm = initFirebaseAdmin();
  if (!adm) throw new Error('Firebase Admin not initialized');

  try {
    // Try existing user
    const user = await adm.auth().getUserByPhoneNumber(phone);
    return { uid: user.uid, isNewUser: false };
  } catch (err) {
    if (
      err.code === 'auth/user-not-found' ||
      (err.message && err.message.includes('no user'))
    ) {
      try {
        const userRecord = await adm.auth().createUser({ phoneNumber: phone });
        return { uid: userRecord.uid, isNewUser: true };
      } catch (createErr) {
        // Race condition fallback: someone else created the user
        const retry = await adm.auth().getUserByPhoneNumber(phone);
        return { uid: retry.uid, isNewUser: false };
      }
    }
    throw err;
  }
}

async function createCustomTokenForPhone(phone) {
  const adm = initFirebaseAdmin();
  if (!adm) throw new Error('Firebase Admin not initialized');

  const { uid, isNewUser } = await ensureFirebaseUserForPhone(phone);

  const token = await adm.auth().createCustomToken(uid);
  return { uid, token, isNewUser };
}

module.exports = { createCustomTokenForPhone };