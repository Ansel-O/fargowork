#!/usr/bin/env node
'use strict';

const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const {
  check,
  dataRoot,
  read,
  safeCode
} = require('./lib/common.cjs');
const {bindWorkspace} = require('./lib/official-cli.cjs');
function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function verify(root, manifest) {
  check(manifest.name === 'fargowork-openyida-skills' && manifest.version === '2.0.0' && Array.isArray(manifest.files) && manifest.files.length > 10, 'PACKAGE_MANIFEST_INVALID');
  const required = ['README.md', 'SKILL.md', 'LICENSE', 'package.json', 'package-lock.json', 'scripts/setup.cjs', 'scripts/fargowork.cjs', 'scripts/lib/common.cjs', 'scripts/lib/auth.cjs', 'scripts/lib/login-worker.cjs', 'scripts/lib/official-cli.cjs', 'scripts/lib/policy.cjs', 'scripts/lib/runtime.cjs', 'scripts/lib/process.cjs', 'scripts/lib/native-attachment.cjs', 'scripts/lib/verification.cjs', 'references/CONNECTORS.md', 'references/DEBUG.md', ...['annual-leave', 'business-trip', 'procurement-request', 'external-expense-request'].flatMap(w => ['skills/' + w + '/SKILL.md', 'workflows/' + w + '.cjs']), 'workflows/leave-trip-common.cjs', 'workflows/payment-core.cjs', 'workflows/payment-sources.cjs'];
  const seen = new Set(),
    realRoot = fs.realpathSync(root) + path.sep;
  for (const f of manifest.files) {
    check(typeof f.path === 'string' && f.path.length > 0 && !f.path.includes('\\') && !f.path.includes(':') && !f.path.startsWith('/') && f.path.split('/').every(p => p && p !== '.' && p !== '..') && !seen.has(f.path) && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes >= 0, 'PACKAGE_MANIFEST_INVALID');
    seen.add(f.path);
    check(required.includes(f.path) || f.path === '.gitignore', 'PACKAGE_MANIFEST_INVALID');
    const p = path.join(root, f.path);
    check(fs.existsSync(p) && fs.lstatSync(p).isFile() && !fs.lstatSync(p).isSymbolicLink() && fs.realpathSync(p).startsWith(realRoot) && fs.statSync(p).size === f.bytes && hash(p) === f.sha256, 'PACKAGE_INTEGRITY_FAILED');
  }
  check(required.every(p => seen.has(p)), 'PACKAGE_MANIFEST_INVALID');
}
async function setup(args) {
  check(Number(process.versions.node.split('.')[0]) >= 22, 'NODE_22_REQUIRED');
  check(process.platform === 'win32', 'WINDOWS_REQUIRED');
  check(args.length <= 2 && new Set(args).size === args.length
    && args.every(arg => ['--no-login', '--rebind-workspace'].includes(arg)), 'ARGUMENT_INVALID');
  const source = path.resolve(__dirname, '..'),
    manifest = read(path.join(source, 'manifest.json'));
  verify(source, manifest);
  const base = dataRoot(),
    fingerprint = hash(path.join(source, 'manifest.json')).slice(0, 16),
    dest = path.join(base, 'packages', manifest.version + '-' + fingerprint);
  const lock = path.join(base, 'install.lock');
  let fd;
  let officialInfo;
  try {
    fd = fs.openSync(lock, 'wx', 0o600);
  } catch {
    check(false, 'INSTALL_BUSY_OR_INTERRUPTED');
  }
  try {
    officialInfo = bindWorkspace({sourceRoot: source, fallbackRoot: path.join(base, 'official-workspace'),
      rebind: args.includes('--rebind-workspace')});
    fs.mkdirSync(dest, {
      recursive: true,
      mode: 0o700
    });
    if (path.resolve(source) !== path.resolve(dest)) {
      for (const f of manifest.files) {
        const out = path.join(dest, f.path);
        fs.mkdirSync(path.dirname(out), {
          recursive: true,
          mode: 0o700
        });
        if (fs.existsSync(out)) check(hash(out) === f.sha256, 'EXISTING_PACKAGE_CHANGED');else fs.copyFileSync(path.join(source, f.path), out, fs.constants.COPYFILE_EXCL);
      }
      fs.copyFileSync(path.join(source, 'manifest.json'), path.join(dest, 'manifest.json'));
    }
    verify(dest, manifest);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
  let identity = {
    status: 'not_requested'
  };
  if (!args.includes('--no-login')) {
    try { identity = await require(path.join(dest, 'scripts', 'lib', 'auth.cjs')).login(); }
    catch (error) { error.officialWorkingDirectory = officialInfo.officialWorkingDirectory; throw error; }
  }
  return {
    installed: true,
    version: manifest.version,
    ...officialInfo,
    identity: identity.status,
    skillEntry: path.join(dest, 'SKILL.md'),
    skills: ['annual-leave', 'business-trip', 'procurement-request', 'external-expense-request'].map(s => path.join(dest, 'skills', s, 'SKILL.md')),
    command: [process.execPath, path.join(dest, 'scripts', 'fargowork.cjs')],
    message: officialInfo.workspaceRebound ? '官方工作目录已重新绑定。请核对当前账号后继续；既有草稿仍保持原账号约束。'
      : identity.status === 'ready' ? '已安装并登录，可以办理四个已支持的流程。' : '安装完成，办理前需要登录。'
  };
}
if (require.main === module) setup(process.argv.slice(2)).then(r => process.stdout.write(JSON.stringify(r, null, 2) + '\n')).catch(e => {
  process.stdout.write(JSON.stringify({
    installed: false,
    code: safeCode(e),
    ...(e.officialWorkingDirectory ? {officialWorkingDirectory: e.officialWorkingDirectory} : {}),
    message: '安装未完成，请按错误码处理，不要尝试其他安装入口。'
  }) + '\n');
  process.exitCode = 1;
});
module.exports = {
  setup,
  verify
};
