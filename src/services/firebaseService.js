const authService = require('./auth.service');

// Thin wrapper to match desired service filename. Re-exports auth service functions.
module.exports = {
  createCustomTokenForPhone: authService.createCustomTokenForPhone,
};
