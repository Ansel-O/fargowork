'use strict';

// Official OpenYida owns OAuth state, callback validation and credential storage.
// The parent opens its complete URL safely on Windows; no token reaches stdout.
const {
  provider,
  options
} = require('./auth.cjs');
delete process.env.OPENYIDA_DINGTALK_CLIENT_ID;
delete process.env.OPENYIDA_DINGTALK_SCOPE;
process.env.OPENYIDA_NO_BROWSER = '1';
provider().tokenLogin({
  ...options(),
  noBrowser: true,
  quiet: false,
  timeoutMs: 5 * 60 * 1000
}).then(r => {
  process.exitCode = r?.access_token ? 0 : 1;
}).catch(() => {
  process.exitCode = 1;
});
