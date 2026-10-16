'use strict';

// Resolve an already installed official CLI; no bundled dependency or install.
const fs = require('node:fs'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {check, dataRoot, read, write} = require('./common.cjs');
const SUPPORTED = Object.freeze(['2026.7.14-2', '2026.10.16']);
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
  for (const file of ['bin/yida.js', 'lib/auth/token-auth.js', 'lib/core/utils.js']) {
    const full = path.join(real, file);
    check(fs.existsSync(full) && fs.statSync(full).isFile()
      && fs.realpathSync(full).startsWith(real + path.sep), 'OPENYIDA_PROVIDER_UNAVAILABLE');
  }
  const provider = require(path.join(real, 'lib/auth/token-auth.js'));
  const utils = require(path.join(real, 'lib/core/utils.js'));
  check(['tokenLogin', 'tokenStatus', 'tokenRefresh', 'tokenLogout', 'getAccessToken'].every(k => typeof provider[k] === 'function')
    && typeof utils.findProjectRoot === 'function', 'OPENYIDA_PROVIDER_UNAVAILABLE');
  return {packageRoot: real, version: pkg.version, provider, findProjectRoot: utils.findProjectRoot};
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
function bindingData(file) {
  const binding = read(file);
  check(binding.schema === 1 && typeof binding.projectRoot === 'string' && path.isAbsolute(binding.projectRoot), 'OPENYIDA_WORKSPACE_UNAVAILABLE');
  return binding;
}
function directoryExists(dir) {
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}
function workspace() {
  const file = path.join(dataRoot(), 'official-openyida.json');
  check(fs.existsSync(file), 'SETUP_REQUIRED');
  const binding = bindingData(file);
  if (!directoryExists(binding.projectRoot)) {
    try { check(false, 'OPENYIDA_WORKSPACE_UNAVAILABLE'); }
    catch (error) { error.officialWorkingDirectory = binding.projectRoot; throw error; }
  }
  return binding.projectRoot;
}
function bindWorkspace({sourceRoot, fallbackRoot, rebind = false} = {}) {
  const cli = official(), file = path.join(dataRoot(), 'official-openyida.json');
  const existing = fs.existsSync(file) ? bindingData(file) : null;
  if (rebind) check(existing && !fs.existsSync(existing.projectRoot), 'OPENYIDA_REBIND_NOT_NEEDED');
  if (!existing || rebind) {
    const found = cli.findProjectRoot();
    check(typeof found === 'string' && path.isAbsolute(found) && directoryExists(found), 'OPENYIDA_WORKSPACE_UNAVAILABLE');
    let projectRoot = fs.realpathSync(found);
    let createdFallback = false;
    const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    // Check presence only. The official provider alone owns the contents of
    // project credentials and profile pointers, including legacy migration.
    const hasOfficialWorkspace = ['config.json', '.cache/auth-token-public.json',
      '.cache/openyida/auth-profile-public.json'].some(name => fs.existsSync(path.join(projectRoot, name)));
    if (sourceRoot && samePath(projectRoot, fs.realpathSync(sourceRoot)) && !hasOfficialWorkspace) {
      check(typeof fallbackRoot === 'string' && path.isAbsolute(fallbackRoot), 'OPENYIDA_WORKSPACE_UNAVAILABLE');
      createdFallback = !fs.existsSync(fallbackRoot);
      fs.mkdirSync(fallbackRoot, {recursive: true, mode: 0o700});
      projectRoot = fs.realpathSync(fallbackRoot);
    }
    const binding = {schema: 1, projectRoot};
    if (rebind) {
      // Setup holds install.lock. A valid existing workspace is never replaced.
      check(bindingData(file).projectRoot === existing.projectRoot
        && (!fs.existsSync(existing.projectRoot) || createdFallback && samePath(projectRoot, existing.projectRoot)), 'OPENYIDA_WORKSPACE_CHANGED');
      write(file, binding);
    } else {
      let fd;
      try { fd = fs.openSync(file, 'wx', 0o600); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (fd !== undefined) {
        try { fs.writeFileSync(fd, JSON.stringify(binding) + '\n'); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
      }
    }
  }
  return {officialWorkingDirectory: workspace(), openyidaVersion: cli.version,
    ...(rebind ? {workspaceRebound: true, identityReviewRequired: true} : {})};
}
module.exports = {SUPPORTED, official, bindWorkspace, workspace};
