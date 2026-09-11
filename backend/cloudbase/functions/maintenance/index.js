const cloud = require('wx-server-sdk');
const { run } = require('./lib/expiry');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => run(cloud.database(), new Date(), 100);
