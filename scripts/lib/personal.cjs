'use strict';

// Optional, local preferences. Identity is resolved by the official auth adapter,
// never by a target supplied with a business request.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {check, dataRoot, write} = require('./common.cjs');
const {corpId: COMPANY} = require('../../config/company.json');

const SCHEMA_VERSION = 2;
const MAX_BYTES = 16 * 1024;
const PREFERENCE_FIELDS = Object.freeze(Object.fromEntries(Object.entries({
  language: ['zh-CN', 'zh-TW', 'en'],
  verbosity: ['brief', 'normal', 'detailed'],
  display_mode: ['table', 'list'],
  date_format: ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'],
  amount_format: ['plain', 'grouped'],
  trip_purpose_hint: ['internal_collaboration', 'customer_visit'],
  expense_context_hint: ['normal', 'project']
}).map(([key, values]) => [key, Object.freeze(values)])));
const PERSONAL_KEYS = Object.freeze([...Object.keys(PREFERENCE_FIELDS), 'card_hints']);
const USAGE = Object.freeze({
  advisoryOnly: true,
  verifyCurrentFacts: true,
  currentInputWins: true,
  automaticLearning: false,
  mayOverrideCompanyRules: false,
  sensitiveDataAllowed: false,
  mayContinueWithoutPersonal: true
});
const SAFE_WARNINGS = new Set([
  'PERSONAL_IDENTITY_UNAVAILABLE', 'PERSONAL_IDENTITY_CHANGED',
  'PERSONAL_COMPANY_MISMATCH', 'PERSONAL_STORAGE_INVALID',
  'PERSONAL_DATA_INVALID', 'PERSONAL_SCHEMA_UNSUPPORTED',
  'PERSONAL_OWNER_MISMATCH', 'PERSONAL_STORE_BUSY'
]);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function shape(value, keys, code = 'PERSONAL_INPUT_INVALID') {
  check(object(value) && Object.keys(value).every(key => keys.includes(key)), code);
}
function hintText(value, maximum, code) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    && (value.normalize('NFKC').match(/\p{Nd}/gu) || []).length <= 4, code);
  return value.trim();
}
function cardHints(value, code) {
  check(Array.isArray(value) && value.length <= 10, code);
  return value.map(hint => {
    shape(hint, ['nickname', 'last4', 'purpose'], code);
    check(typeof hint.last4 === 'string' && /^[0-9]{4}$/.test(hint.last4), code);
    return {nickname: hintText(hint.nickname, 30, code), last4: hint.last4,
      purpose: hintText(hint.purpose, 60, code)};
  });
}
function values(value, {allowEmpty = true, legacy = false, code = 'PERSONAL_VALUE_INVALID'} = {}) {
  shape(value, legacy ? Object.keys(PREFERENCE_FIELDS) : PERSONAL_KEYS, 'PERSONAL_FIELD_NOT_ALLOWED');
  check(allowEmpty || Object.keys(value).length > 0, code);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'card_hints') result[key] = cardHints(item, code);
    else {
      check(typeof item === 'string' && PREFERENCE_FIELDS[key].includes(item), code);
      result[key] = item;
    }
  }
  return result;
}
function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function safeWarning(error) {
  return SAFE_WARNINGS.has(error?.code) ? error.code : 'PERSONAL_STORAGE_UNAVAILABLE';
}
function response(operation, status, stored = {}, {changed = false, warning} = {}) {
  return {
    operation, status, schemaVersion: SCHEMA_VERSION, values: {...stored},
    ...(operation === 'view' ? {} : {changed}),
    warnings: warning ? [warning] : [], usage: {...USAGE}
  };
}

function createPersonalStore(options = {}) {
  shape(options, ['root', 'actorResolver']);
  check(options.root === undefined || typeof options.root === 'string'
    && path.isAbsolute(options.root), 'PERSONAL_STORAGE_INVALID');
  check(options.actorResolver === undefined || typeof options.actorResolver === 'function',
    'PERSONAL_INPUT_INVALID');
  const resolveActor = options.actorResolver || (() => require('./auth.cjs').actor());
  // root is a dependency-injection option, not a CLI input or profile target.
  const resolveRoot = () => options.root === undefined
    ? path.join(dataRoot(), 'personal') : path.resolve(options.root);

  function owner() {
    let actor;
    try { actor = resolveActor(); } catch { check(false, 'PERSONAL_IDENTITY_UNAVAILABLE'); }
    check(object(actor) && typeof actor.corp_id === 'string'
      && typeof actor.userid === 'string' && actor.userid.trim() === actor.userid
      && actor.userid.length > 0 && actor.userid.length <= 256
      && !/[\x00-\x1f\x7f]/.test(actor.userid), 'PERSONAL_IDENTITY_UNAVAILABLE');
    check(actor.corp_id === COMPANY, 'PERSONAL_COMPANY_MISMATCH');
    return {companyKey: hash(actor.corp_id), key: hash(JSON.stringify([actor.corp_id, actor.userid]))};
  }
  function sameOwner(initial) {
    const current = owner();
    check(current.key === initial.key, 'PERSONAL_IDENTITY_CHANGED');
  }
  function locations(identity) {
    const root = resolveRoot();
    const directory = path.join(root, identity.companyKey);
    return {root, directory, file: path.join(directory, identity.key + '.json')};
  }
  function safePath(location) {
    for (const [name, directory] of [[location.root, true], [location.directory, true], [location.file, false]]) {
      let stat;
      try { stat = fs.lstatSync(name); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      check(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()),
        'PERSONAL_STORAGE_INVALID');
    }
  }
  function load(location, identity) {
    safePath(location);
    let content;
    try {
      check(fs.statSync(location.file).size <= MAX_BYTES, 'PERSONAL_DATA_INVALID');
      content = fs.readFileSync(location.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return {exists: false, values: {}};
      throw error;
    }
    let record;
    try { record = JSON.parse(content.replace(/^\uFEFF/, '')); }
    catch { check(false, 'PERSONAL_DATA_INVALID'); }
    shape(record, ['schemaVersion', 'ownerKey', 'values', 'updatedAt'], 'PERSONAL_DATA_INVALID');
    check(record.schemaVersion === 1 || record.schemaVersion === SCHEMA_VERSION, 'PERSONAL_SCHEMA_UNSUPPORTED');
    check(record.ownerKey === identity.key, 'PERSONAL_OWNER_MISMATCH');
    check(typeof record.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.updatedAt)
      && Number.isFinite(Date.parse(record.updatedAt)), 'PERSONAL_DATA_INVALID');
    let stored;
    try { stored = values(record.values, {legacy: record.schemaVersion === 1}); } catch { check(false, 'PERSONAL_DATA_INVALID'); }
    return {exists: true, values: stored};
  }
  function unavailable(operation, error) {
    return response(operation, 'unavailable', {}, {warning: safeWarning(error)});
  }
  function view(request = {}) {
    shape(request, []);
    try {
      const identity = owner(), location = locations(identity);
      const stored = load(location, identity);
      sameOwner(identity);
      return response('view', Object.keys(stored.values).length ? 'ready' : 'empty', stored.values);
    } catch (error) { return unavailable('view', error); }
  }
  function mutate(operation, update) {
    let lock, lockFile;
    try {
      const identity = owner(), location = locations(identity);
      safePath(location);
      fs.mkdirSync(location.directory, {recursive: true, mode: 0o700});
      safePath(location);
      lockFile = location.file + '.lock';
      try { lock = fs.openSync(lockFile, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') check(false, 'PERSONAL_STORE_BUSY'); throw error; }
      sameOwner(identity);
      // Explicit clear can remove a corrupt or newer-schema profile without
      // interpreting it. Other writes preserve unreadable data for recovery.
      const prior = operation === 'clear'
        ? {exists: fs.existsSync(location.file), values: {}} : load(location, identity);
      const next = update({...prior.values});
      const changed = operation === 'clear' ? prior.exists
        : JSON.stringify(Object.entries(prior.values).sort()) !== JSON.stringify(Object.entries(next).sort());
      sameOwner(identity);
      if (changed) {
        safePath(location);
        if (Object.keys(next).length === 0) fs.unlinkSync(location.file);
        else write(location.file, {
          schemaVersion: SCHEMA_VERSION, ownerKey: identity.key,
          values: next, updatedAt: new Date().toISOString()
        });
      }
      return response(operation, Object.keys(next).length ? 'ready' : 'empty', next, {changed});
    } catch (error) { return unavailable(operation, error); }
    finally {
      if (lock !== undefined) {
        try { fs.closeSync(lock); } catch {}
        try { fs.unlinkSync(lockFile); } catch {}
      }
    }
  }
  function set(request) {
    shape(request, ['values', 'confirmed']);
    check(request.confirmed === true, 'PERSONAL_EXPLICIT_CONFIRMATION_REQUIRED');
    const patch = values(request.values, {allowEmpty: false});
    return mutate('set', prior => ({...prior, ...patch}));
  }
  function remove(request) {
    shape(request, ['keys']);
    check(Array.isArray(request.keys) && request.keys.length > 0
      && request.keys.length <= PERSONAL_KEYS.length
      && new Set(request.keys).size === request.keys.length
      && request.keys.every(key => typeof key === 'string' && PERSONAL_KEYS.includes(key)),
    'PERSONAL_KEYS_INVALID');
    const keys = [...request.keys];
    return mutate('delete', prior => {
      keys.forEach(key => { delete prior[key]; });
      return prior;
    });
  }
  function clear(request = {}) {
    shape(request, []);
    return mutate('clear', () => ({}));
  }
  return Object.freeze({view, set, delete: remove, clear});
}

module.exports = {SCHEMA_VERSION, PERSONAL_KEYS, PREFERENCE_FIELDS, USAGE, createPersonalStore};
