const verification = require('../modules/verification/service');

module.exports = {
  module: 'verification',
  data: verification.data,
  execute: verification.execute,
};
