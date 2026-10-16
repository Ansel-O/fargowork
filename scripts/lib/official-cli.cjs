'use strict';

// Resolve an already installed official CLI; no bundled dependency or install.
const fs = require('node:fs'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {check, dataRoot, read} = require('./common.cjs');
const SUPPORTED = Object.freeze(['2026.10.16']);
let cached;
function commandPaths(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 65536});
  if (result.status !== 0) return [];
  return String(result.stdout || '').split(/\r?\n/).map(v => v.trim())
    .filter(v => path.isAbsolute(v) && fs.existsSync(v));
}
function npmGlobalRoot() {
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const file of commandPaths(process.platform === 'win32' ? 'npm.cmd' : 'npm')) {
    const real = fs.realpathSync(file);
    candidates.push(path.join(path.dirname(real), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    if (path.basename(real) === 'npm-cli.js') candidates.push(real);
  }
  for (const file of [...new Set(candidates)]) {
    if (!fs.existsSync(file)) continue;
    const result = spawnSync(process.execPath, [file, 'root', '--global'], {
      encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 65536});
    const root = String(result.stdout || '').trim();
    if (result.status === 0 && !/[\r\n]/.test(root) && path.isAbsolute(root) && fs.existsSync(root)) return root;
  }
  return null;
}
function validatePackage(root) {
  const real = fs.realpathSync(root), pkg = read(path.join(real, 'package.json'));
  check(pkg.name === 'openyida' && pkg.bin?.openyida === 'bin/yida.js', 'OPENYIDA_PROVIDER_UNAVAILABLE');
  check(SUPPORTED.includes(pkg.version), 'OPENYIDA_VERSION_UNSUPPORTED');
  const entry = path.join(real, 'bin/yida.js');
  check(fs.existsSync(entry) && fs.statSync(entry).isFile()
    && fs.realpathSync(entry).startsWith(real + path.sep), 'OPENYIDA_PROVIDER_UNAVAILABLE');
  return {packageRoot: real, entry, version: pkg.version};
}

function official() {
  if (cached) return cached;
  const roots = [];
  for (const file of commandPaths(process.platform === 'win32' ? 'openyida.cmd' : 'openyida')) {
    const real = fs.realpathSync(file);
    if (path.basename(real) === 'yida.js' && path.basename(path.dirname(real)) === 'bin') roots.push(path.dirname(path.dirname(real)));
    roots.push(path.join(path.dirname(real), 'node_modules', 'openyida'));
  }
  const globalRoot = npmGlobalRoot();
  if (globalRoot) roots.push(path.join(globalRoot, 'openyida'));
  for (const root of [...new Set(roots)]) {
    if (!fs.existsSync(path.join(root, 'package.json'))) continue;
    try { cached = validatePackage(root); return cached; }
    catch (error) {
      if (error.code === 'OPENYIDA_VERSION_UNSUPPORTED') throw error;
      check(false, 'OPENYIDA_PROVIDER_UNAVAILABLE');
    }
  }
  check(false, 'OPENYIDA_CLI_REQUIRED');
}
// The public CLI owns profiles, project selection, login, refresh and endpoints.
// No FargoWork auth directory or workspace pointer is created.
function parseJson(text) {
  try { return JSON.parse(String(text || '').trim()); } catch { return null; }
}
function targetFailure() {
  const error = Object.assign(new Error('OPENYIDA_TARGET_UNVERIFIED'), {
    code: 'OPENYIDA_TARGET_UNVERIFIED', sideEffectState: 'none', retrySafe: true});
  throw error;
}
function run(args, {mutation = false, login = false, identity, input} = {}) {
  const cli = official();
  const argv = [...args, '--json'];
  let temporary;
  try {
    if (input !== undefined) {
      temporary = fs.mkdtempSync(path.join(dataRoot(), 'command-'));
      const file = path.join(temporary, 'input.json');
      fs.writeFileSync(file, typeof input === 'string' ? input : JSON.stringify(input), {mode: 0o600, flag: 'wx'});
      const index = argv.indexOf('__FARGOWORK_INPUT__');
      check(index > 0 && ['--data-file', '--search-file'].includes(argv[index - 1]), 'OFFICIAL_ARGUMENT_INVALID');
      argv[index] = file;
    }
    const env = {...process.env, YIDA_QUIET: '1', OPENYIDA_NO_AUTO_UPDATE: '1'};
    if (identity) {
      // Select the exact already observed official profile for this command.
      // This is a process-local selector, never a persisted FargoWork binding.
      env.OPENYIDA_AUTH_CORP_ID = identity.corp_id;
      env.OPENYIDA_AUTH_USER_ID = identity.user_id;
      if (identity.auth_profile) env.OPENYIDA_AUTH_PROFILE = identity.auth_profile;
    }
    const result = spawnSync(process.execPath, [cli.entry, ...argv], {
      cwd: process.cwd(), env, encoding: 'utf8', windowsHide: true, shell: false,
      timeout: login ? 600000 : 120000, maxBuffer: 8 * 1024 * 1024});
    const value = parseJson(result.stdout);
    if (result.status === 0 && !result.error && value !== null) return value;
    const error = parseJson(result.stderr);
    // These official errors occur before createProcess calls sendPostOnce.
    if (mutation && ['DATA_TARGET_IDENTITY_UNVERIFIED', 'DATA_TARGET_IDENTITY_MISMATCH',
      'DATA_FORM_MODE_UNVERIFIED', 'DATA_TARGET_EXPECTATION_INVALID', 'DATA_INVALID_ARGUMENTS'].includes(error?.errorCode)) targetFailure();
    const rejected = error?.errorCode === 'DATA_API_ERROR' ? error.details : null;
    const upstreamCode = rejected?.errorCode;
    if (mutation && rejected?.success === false && !Object.keys(rejected).some(k => k.startsWith('__'))
      && (typeof upstreamCode === 'string' || Number.isSafeInteger(upstreamCode))
      && /^[A-Za-z0-9_.-]{1,100}$/.test(String(upstreamCode))
      && !['TOKEN_AUTH_REQUIRED', 'TOKEN_REFRESH_FAILED', 'NON_IDEMPOTENT_RESULT_UNKNOWN', 'AUTH_IDENTITY_CHANGED'].includes(String(upstreamCode))) {
      return {success: false, errorCode: upstreamCode};
    }
    check(false, mutation ? 'WRITE_OUTCOME_UNKNOWN' : login ? 'LOGIN_NOT_COMPLETED' : 'OPENYIDA_COMMAND_FAILED');
  } finally {
    if (temporary) {
      const file = path.join(temporary, 'input.json');
      if (fs.existsSync(file)) fs.unlinkSync(file);
      fs.rmdirSync(temporary);
    }
  }
}
// Only native attachments and existing page connector actions need this gap
// adapter. The upstream module is not a public SDK; keep the tested CLI pin.
function gapProvider() {
  const cli = official(), file = path.join(cli.packageRoot, 'lib/auth/token-auth.js');
  check(fs.existsSync(file) && fs.realpathSync(file).startsWith(cli.packageRoot + path.sep), 'OPENYIDA_PROVIDER_UNAVAILABLE');
  const provider = require(file);
  check(typeof provider.getAccessToken === 'function', 'OPENYIDA_PROVIDER_UNAVAILABLE');
  return provider;
}
module.exports = {SUPPORTED, official, run, gapProvider, targetFailure};
