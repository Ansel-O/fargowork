'use strict';

const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
function check(ok, code) {
  if (!ok) {
    const e = new Error(code);
    e.code = code;
    throw e;
  }
}
function dataRoot() {
  const base = process.env.FARGOWORK_OPENYIDA_HOME || path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), '.local', 'share'), 'FargoWorkOpenYida');
  check(path.isAbsolute(base), 'STATE_DIRECTORY_INVALID');
  fs.mkdirSync(base, {
    recursive: true,
    mode: 0o700
  });
  return path.resolve(base);
}
function canonical(x) {
  if (x === null || typeof x === 'string' || typeof x === 'boolean' || typeof x === 'number' && Number.isFinite(x)) return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  check(x && Object.getPrototypeOf(x) === Object.prototype, 'JSON_VALUE_INVALID');
  return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
}
function digest(x) {
  return crypto.createHash('sha256').update(canonical(x)).digest('hex');
}
function write(file, x) {
  fs.mkdirSync(path.dirname(file), {
    recursive: true,
    mode: 0o700
  });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, canonical(x) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function read(file) {
  check(fs.statSync(file).size <= 8 * 1024 * 1024, 'LOCAL_FILE_TOO_LARGE');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function today() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
function fields(schema) {
  const map = {};
  function walk(x) {
    if (!x || typeof x !== 'object') return;
    if (x.props?.fieldId) map[x.props.fieldId] = x;
    Object.values(x).forEach(walk);
  }
  walk(schema);
  return map;
}
function safeCode(e) {
  const c = e?.code || e?.safeCode || e?.message;
  return typeof c === 'string' && /^[A-Z][A-Z0-9_.-]{2,100}$/.test(c) ? c : 'OPERATION_FAILED';
}
module.exports = {
  check,
  dataRoot,
  canonical,
  digest,
  write,
  read,
  today,
  fields,
  safeCode
};
