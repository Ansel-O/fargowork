'use strict';

const path = require('node:path'),
  {
    spawn
  } = require('node:child_process');
const {
  check,
  today
} = require('./common.cjs');
const {
  ROOT,
  CORP
} = require('./policy.cjs');
const {official, workspace} = require('./official-cli.cjs');
function provider() {
  return official().provider;
}
function options() {
  return {
    projectRoot: workspace(),
    envName: 'public',
    endpoint: ROOT,
    loginOrigin: 'https://login.dingtalk.com',
    scope: 'openid corpid'
  };
}
function actor() {
  const s = provider().tokenStatus(options());
  check(s.status !== 'profile_required', 'OPENYIDA_PROFILE_REQUIRED');
  check(s.user_id && s.corp_id && s.base_url === ROOT, 'OPENYIDA_LOGIN_REQUIRED');
  check(s.corp_id === CORP, 'COMPANY_MISMATCH');
  return {
    userid: s.user_id,
    corp_id: s.corp_id,
    name: s.user_name || s.user_id
  };
}
async function token() {
  const auth = provider(), opts = options(), before = auth.tokenStatus(opts);
  check(before.status !== 'profile_required', 'OPENYIDA_PROFILE_REQUIRED');
  if (before.corp_id) check(before.corp_id === CORP, 'COMPANY_MISMATCH');
  if (before.base_url) check(before.base_url === ROOT, 'OPENYIDA_ENVIRONMENT_UNSUPPORTED');
  // Refresh near-expiry tokens via the official provider before business writes.
  // This does not retry any business operation after an uncertain response.
  const expires = typeof before.expires_at === 'string' ? Date.parse(before.expires_at) : NaN;
  if (before.status === 'expired' || Number.isFinite(expires) && expires <= Date.now() + 60000) {
    const refreshed = await auth.tokenRefresh(opts);
    check(refreshed && refreshed.ok !== false && refreshed.can_auto_use !== false, 'OPENYIDA_LOGIN_REQUIRED');
  }
  const t = await auth.getAccessToken(opts);
  check(typeof t === 'string' && t.length > 0, 'OPENYIDA_LOGIN_REQUIRED');
  const after = actor();
  if (before.user_id && before.corp_id) check(after.userid === before.user_id && after.corp_id === before.corp_id, 'IDENTITY_CHANGED');
  return t;
}
async function status() {
  try {
    await token();
    return {
      status: 'ready',
      actor: actor(),
      businessDate: today(),
      timeZone: 'Asia/Shanghai'
    };
  } catch (e) {
    if (e.code === 'OPENYIDA_LOGIN_REQUIRED' || e.code === 'TOKEN_AUTH_REQUIRED' || e.message === 'not_logged_in') return {
      status: 'login_required',
      businessDate: today(),
      timeZone: 'Asia/Shanghai'
    };
    if (e.code) throw e;
    check(false, 'AUTH_STATUS_UNAVAILABLE');
  }
}
async function logout() {
  await provider().tokenLogout(options());
  return {
    status: 'logged_out'
  };
}
function browser(url) {
  const u = new URL(url);
  check(u.origin === 'https://login.dingtalk.com' && u.pathname === '/oauth2/auth' && u.searchParams.get('client_id') && u.searchParams.get('state'), 'LOGIN_URL_INVALID');
  const redirect = new URL(u.searchParams.get('redirect_uri'));
  check(redirect.protocol === 'http:' && redirect.hostname === '127.0.0.1' && redirect.pathname === '/oauth/callback', 'LOGIN_CALLBACK_INVALID');
  let cmd, args;
  if (process.platform === 'win32') {
    cmd = 'powershell.exe';
    const script = "Start-Process -FilePath '" + url.replace(/'/g, "''") + "'";
    args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  } else {
    cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    args = [url];
  }
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, {
      stdio: 'ignore',
      windowsHide: true
    });
    c.once('error', () => reject(Object.assign(new Error('BROWSER_OPEN_FAILED'), {
      code: 'BROWSER_OPEN_FAILED'
    })));
    c.once('close', code => code === 0 ? resolve() : reject(Object.assign(new Error('BROWSER_OPEN_FAILED'), {
      code: 'BROWSER_OPEN_FAILED'
    })));
  });
}
async function login() {
  const current = await status();
  if (current.status === 'ready') return current;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'login-worker.cjs')], {
      cwd: workspace(),
      env: {
        ...process.env,
        OPENYIDA_NO_BROWSER: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let pending = '',
      opened = false,
      problem;
    child.stderr.on('data', chunk => {
      pending += chunk.toString();
      if (pending.length > 16384) {
        problem = 'LOGIN_OUTPUT_INVALID';
        child.kill();
        return;
      }
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        if (!opened && line.startsWith('https://login.dingtalk.com/oauth2/auth?')) {
          opened = true;
          browser(line.trim()).catch(e => {
            problem = e.code;
            child.kill();
          });
        }
      }
    });
    child.stdout.resume();
    child.once('error', () => reject(Object.assign(new Error('LOGIN_START_FAILED'), {
      code: 'LOGIN_START_FAILED'
    })));
    child.once('close', async code => {
      if (code !== 0 || problem) {
        reject(Object.assign(new Error(problem || 'LOGIN_NOT_COMPLETED'), {
          code: problem || 'LOGIN_NOT_COMPLETED'
        }));
        return;
      }
      try {
        const s = await status();
        check(s.status === 'ready', 'LOGIN_NOT_COMPLETED');
        resolve(s);
      } catch (e) {
        reject(e);
      }
    });
  });
}
module.exports = {
  provider,
  options,
  actor,
  token,
  status,
  login,
  logout,
  browser
};
