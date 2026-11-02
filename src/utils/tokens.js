const jwt = require('jsonwebtoken');
const config = require('../config');

const signAuthToken = (user) =>
  jwt.sign({ sub: user.id, v: user.token_version, typ: 'auth' }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });

/** Short-lived token proving the reset OTP was verified. */
const signResetToken = (user) =>
  jwt.sign({ sub: user.id, v: user.token_version, typ: 'reset' }, config.jwtSecret, {
    expiresIn: '15m',
  });

function verifyToken(token, typ) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return payload.typ === typ ? payload : null;
  } catch {
    return null;
  }
}

module.exports = { signAuthToken, signResetToken, verifyToken };
