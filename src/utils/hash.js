const bcrypt = require('bcryptjs');

const SALT_ROUNDS = Number(process.env.OTP_BCRYPT_SALT_ROUNDS) || 10;

function hashOtp(otp) {
  if (!otp && otp !== 0) throw new Error('OTP is required');
  return new Promise((resolve, reject) => {
    bcrypt.genSalt(SALT_ROUNDS, (err, salt) => {
      if (err) return reject(err);
      bcrypt.hash(String(otp), salt, (hErr, hashed) => {
        if (hErr) return reject(hErr);
        resolve(hashed);
      });
    });
  });
}

function verifyOtpHash(otp, hashed) {
  if (!hashed) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    bcrypt.compare(String(otp), hashed, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

module.exports = { hashOtp, verifyOtpHash };
