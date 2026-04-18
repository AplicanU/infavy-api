// Utility to load blocked channel ids for a given user (uid)
module.exports.getBlockedChannelIds = async function getBlockedChannelIds(db, uid) {
  if (!db || !uid) return new Set();
  try {
    const col = db.collection('blockedChannels');
    const snap = await col.where('uid', '==', String(uid)).get();
    const s = new Set();
    snap.forEach((d) => {
      const data = d.data() || {};
      if (data.channelId) s.add(String(data.channelId));
    });
    return s;
  } catch (e) {
    // on error, return empty set to avoid blocking functionality
    return new Set();
  }
};
