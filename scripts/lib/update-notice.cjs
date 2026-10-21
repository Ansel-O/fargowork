'use strict';

// A best-effort public release notice, independent of the company directory's
// compatibility checks. It never installs code or receives workflow/identity data.
const fs = require('node:fs');
const path = require('node:path');
const {dataRoot, write} = require('./common.cjs');
const VERSION = require('../../package.json').version;
const RELEASE_API = 'https://api.github.com/repos/Ansel-O/fargowork/releases/latest';
const RELEASE_BASE = 'https://github.com/Ansel-O/fargowork/releases/tag/v';
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 2000;
const MAX_ATTEMPTS = 2;
const MAX_RESPONSE_BYTES = 256 * 1024;
const versionParts = value => {
  if (typeof value !== 'string' || value.length > 60
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
};
function newer(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function cacheValue(value) {
  if (!value || value.schemaVersion !== 1) return {};
  const result = {schemaVersion: 1};
  for (const key of ['checkedAt', 'failedAt'])
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  for (const key of ['latestVersion', 'lastNotifiedVersion'])
    if (versionParts(value[key])) result[key] = value[key];
  return result;
}
function within(at, current, ttl) {
  return Number.isSafeInteger(at) && current >= at && current - at < ttl;
}
async function releaseVersion(response) {
  if (!response?.ok || response.redirected || !response.body?.getReader
    || Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES) throw Error('release unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw Error('release too large');
      chunks.push(Buffer.from(value));
    }
    const record = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
    const version = typeof record.tag_name === 'string' ? record.tag_name.replace(/^v/, '') : '';
    if (record.draft !== false || record.prerelease !== false || !versionParts(version)) throw Error('release invalid');
    // Deliberately ignore body, name, assets, URLs and every other remote property.
    return version;
  } finally {
    reader.cancel().catch(() => {});
  }
}
function createUpdateChecker({root, version = VERSION, fetchImpl = globalThis.fetch,
  now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout} = {}) {
  let memoryCache;
  let inFlight;
  function cacheFile() {
    const base = root === undefined ? dataRoot() : root;
    if (typeof base !== 'string' || !path.isAbsolute(base)) throw Error('cache unavailable');
    return path.join(base, 'cache', 'public-release.json');
  }
  function readCache() {
    if (memoryCache) return {...memoryCache};
    try {
      const file = cacheFile();
      if (fs.statSync(file).size > 8192) return {};
      memoryCache = cacheValue(JSON.parse(fs.readFileSync(file, 'utf8')));
      return {...memoryCache};
    } catch {return {};}
  }
  function saveCache(value) {
    memoryCache = cacheValue({...value, schemaVersion: 1});
    try {write(cacheFile(), memoryCache);} catch { /* A notice must never block business work. */ }
  }
  async function request() {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeoutImpl(() => {
        controller.abort();
        reject(Error('release timeout'));
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => fetchImpl(RELEASE_API, {
          method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
          headers: {Accept: 'application/vnd.github+json', 'User-Agent': 'FargoWork-update-check'}
        })).then(releaseVersion),
        timeout
      ]);
    } finally {
      clearTimeoutImpl(timer);
      controller.abort();
    }
  }
  function result(cache, status) {
    const available = newer(cache.latestVersion, version);
    const output = {status, actualClientVersion: version, latestClientVersion: cache.latestVersion,
      updateAvailable: available, releaseUrl: RELEASE_BASE + cache.latestVersion};
    if (available && cache.lastNotifiedVersion !== cache.latestVersion) {
      output.notice = {code: 'CLIENT_UPDATE_AVAILABLE', actualClientVersion: version,
        latestClientVersion: cache.latestVersion, releaseUrl: output.releaseUrl,
        message: `FargoWork ${cache.latestVersion} 已发布，当前运行 ${version}。可在方便时更新。`};
      cache.lastNotifiedVersion = cache.latestVersion;
      saveCache(cache);
    }
    return output;
  }
  async function perform(force) {
    if (!versionParts(version) || typeof fetchImpl !== 'function') return {status: 'skipped'};
    const cache = readCache(), current = now();
    if (!force) {
      if (within(cache.failedAt, current, FAILURE_TTL_MS)) return {status: 'skipped'};
      if (versionParts(cache.latestVersion) && within(cache.checkedAt, current, SUCCESS_TTL_MS))
        return result(cache, 'cached');
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const latestVersion = await request();
        const next = {schemaVersion: 1, latestVersion, checkedAt: now(),
          ...(cache.lastNotifiedVersion ? {lastNotifiedVersion: cache.lastNotifiedVersion} : {})};
        saveCache(next);
        return result(next, 'checked');
      } catch { /* Two bounded attempts; no user-facing transport or body content. */ }
    }
    saveCache({...cache, failedAt: now()});
    return {status: 'skipped'};
  }
  return {
    check({force = false} = {}) {
      if (!inFlight) inFlight = perform(force === true).catch(() => ({status: 'skipped'}))
        .finally(() => {inFlight = undefined;});
      return inFlight;
    }
  };
}
module.exports = {createUpdateChecker, RELEASE_API, RELEASE_BASE, SUCCESS_TTL_MS,
  FAILURE_TTL_MS, REQUEST_TIMEOUT_MS, MAX_ATTEMPTS};
