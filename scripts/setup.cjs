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
const {official} = require('./lib/official-cli.cjs');
function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function verify(root, manifest) {
  const pkg = read(path.join(root,'package.json'));
  check(manifest.name === 'fargowork-openyida-skills' && manifest.version === pkg.version && Array.isArray(manifest.files) && manifest.files.length > 10, 'PACKAGE_MANIFEST_INVALID');
  const workflows = read(path.join(root, 'config/workflow-index.json'));
  const categories = new Set(['finance','leave','assets','business','hr']);
  check(Array.isArray(workflows) && workflows.length > 0
    && workflows.every(item => item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).length === 2 && typeof item.key === 'string'
      && /^[a-z][a-z0-9_]*$/.test(item.key) && categories.has(item.category))
    && new Set(workflows.map(item => item.key)).size === workflows.length, 'PACKAGE_MANIFEST_INVALID');
  const required = ['README.md','README.en.md','SKILL.md','LICENSE','package.json','package-lock.json','scripts/setup.cjs','scripts/fargowork.cjs',
    'scripts/lib/common.cjs','scripts/lib/auth.cjs','scripts/lib/official-cli.cjs','scripts/lib/policy.cjs','scripts/lib/runtime.cjs',
    'scripts/lib/process.cjs','scripts/lib/native-attachment.cjs','scripts/lib/verification.cjs','scripts/lib/support.cjs',
    'scripts/lib/personal.cjs','scripts/lib/workflow-directory.cjs','scripts/lib/attachment-verification-cache.cjs',
    'shared/finance-local-update.cjs','shared/finance-detail-editor.cjs','assets/finance-detail-editor.html','references/FINANCE-DETAIL-EDITOR.md',
    'shared/local-datetime.cjs','shared/scoped-catalog.cjs','shared/account-recommendation.cjs','shared/finance-catalog.cjs',
    'shared/finance-details.cjs','shared/detail-review.cjs','shared/exchange-rates.cjs','shared/leave-calendar.cjs',
    'shared/reimbursement-info.cjs','shared/employee-selection.cjs','shared/workflow-subject.cjs','shared/travel-allowance.cjs',
    'shared/payment-history.cjs',
    'shared/department-hierarchy.cjs',
    'shared/department-details.cjs',
    'shared/decimal-arithmetic.cjs',
    'shared/employee-roster.cjs',
    'shared/initial-values.cjs',
    'shared/process-association.cjs',
    'shared/workflow-attachments.cjs',
    'references/ADAPTING.md','references/ATTACHMENTS.md','references/CHECKS.md','references/CONNECTORS.md','references/DEBUG.md','references/FINANCE-DETAILS.md',
    'references/PERSONAL.md','references/WORKFLOW-DIRECTORY.md',
    'config/company.json','config/sources.json','config/workflow-index.json','config/workflow-versions.json',
    ...workflows.map(({key,category})=>'config/workflows/'+category+'/'+key+'.json'),
    ...workflows.map(({key,category})=>'skills/'+category+'/'+key.replaceAll('_','-')+'/SKILL.md'),
    ...workflows.map(({key,category})=>'workflows/'+category+'/'+key.replaceAll('_','-')+'.cjs'),
    'workflows/business-trip-common.cjs','workflows/leave-trip-common.cjs','workflows/payment-core.cjs','workflows/payment-sources.cjs',
    'workflows/procurement-common.cjs','workflows/asset-common.cjs','workflows/hr-common.cjs','workflows/leave-common.cjs'];
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
  check(args.length <= 1 && args.every(arg => arg === '--no-login'), 'ARGUMENT_INVALID');
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
    officialInfo = {openyidaVersion: official().version};
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
    identity = await require(path.join(dest, 'scripts', 'lib', 'auth.cjs')).login();
  }
  return {
    installed: true,
    version: manifest.version,
    ...officialInfo,
    identity: identity.status,
    skillEntry: path.join(dest, 'SKILL.md'),
    skills: manifest.files.filter(f => /^skills\/(finance|leave|assets|business|hr)\/[^/]+\/SKILL\.md$/.test(f.path))
      .map(f => path.join(dest,f.path)),
    command: [process.execPath, path.join(dest, 'scripts', 'fargowork.cjs')],
    message: identity.status === 'ready' ? '已安装并登录，可以办理包内固定流程。' : '安装完成，办理前需要登录。'
  };
}
if (require.main === module) setup(process.argv.slice(2)).then(r => process.stdout.write(JSON.stringify(r, null, 2) + '\n')).catch(e => {
  process.stdout.write(JSON.stringify({
    installed: false,
    code: safeCode(e),
    message: '安装未完成，请按错误码处理，不要尝试其他安装入口。'
  }) + '\n');
  process.exitCode = 1;
});
module.exports = {
  setup,
  verify
};
