'use strict';

// Local confirmation and one-attempt submission for the four shipped workflows.
// The workflow caller owns data-source, amount and attachment validation.
// prepare creates a local confirmation snapshot; it does not save a Yida draft.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const APP = 'APP_GITLRTH76PM6J4M29F5D';
const FORMS = new Set(['FORM-E0E2F1E273B7400F8CDEC9EF505B960EGPYE',
  'FORM-188915A63185430D9A57AD9114129887TVCT', 'FORM-4E378FADE81F40F8A520A47251D804E6MT1K',
  'FORM-AEE70BC941234A97B25DE3D5340B7DA7IXT3']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  fail('PROCESS_NON_JSON_INPUT');
}

const sha = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const copy = value => JSON.parse(canonical(value));
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);

function actorIdentity(actor) {
  if (!actor || !validId(actor.corp_id) || typeof actor.userid !== 'string'
      || !actor.userid.trim() || actor.userid.length > 256 || /[\x00-\x1f]/.test(actor.userid)) {
    fail('PROCESS_ACTOR_INVALID');
  }
  return { corp_id: actor.corp_id, userid: actor.userid };
}

function businessDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail('PROCESS_CLOCK_INVALID');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = key => parts.find(part => part.type === key).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function writeExclusive(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, canonical(value) + '\n', 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function atomicWrite(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    writeExclusive(temporary, value);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function responseInstanceId(response) {
  if (!response || response.success !== true) return null;
  const ids = [response.result, response.content].filter(value => typeof value === 'string');
  if (!ids.length || ids.some(value => !validId(value)) || new Set(ids).size !== 1) return null;
  return ids[0];
}

function safeUpstreamCode(response) {
  const code = response.errorCode ?? response.code ?? response.errcode;
  const text = typeof code === 'string' ? code : Number.isSafeInteger(code) ? String(code) : '';
  return /^[A-Za-z0-9_.-]{1,100}$/.test(text) ? text : null;
}

function rejectPreviouslySent(state) {
  const error = new Error('PROCESS_SUBMISSION_REJECTED_DO_NOT_RETRY');
  Object.assign(error, { code: error.message, status: 'rejected', upstreamErrorCode: state.upstreamErrorCode || null });
  throw error;
}

function createProcessTrial({ client, appType, formUuid, processCode, stateDir,
                              currentActorResolver, now = () => new Date() }) {
  if (!client || typeof client.postFormOnce !== 'function' || typeof client.get !== 'function'
      || typeof currentActorResolver !== 'function' || ![appType, formUuid, processCode].every(validId)
      || typeof stateDir !== 'string' || !stateDir) fail('PROCESS_CONFIGURATION_INVALID');
  if(appType!==APP||!FORMS.has(formUuid)||!/^TPROC[-_][A-Za-z0-9_-]+$/.test(processCode))fail('PROCESS_TARGET_NOT_ALLOWED');
  const target = Object.freeze({ appType, formUuid, processCode });
  const root = path.resolve(stateDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stateFile = path.join(root, 'state.json');
  const lockFile = path.join(root, 'operation.lock');
  const endpoint = suffix => `/dingtalk/web/${appType}/v1/process/${suffix}.json`;

  async function locked(operation) {
    let fd;
    try { fd = fs.openSync(lockFile, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') fail('PROCESS_BUSY_OR_INTERRUPTED');
      throw error;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: now().toISOString() }));
      fs.fsyncSync(fd);
      return await operation();
    } finally {
      fs.closeSync(fd);
      // A stale lock is never automatically removed on a later invocation.
      fs.unlinkSync(lockFile);
    }
  }

  function loadState() {
    if (!fs.existsSync(stateFile)) return null;
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.version !== 1 || !['prepared', 'unknown', 'submitted', 'rejected'].includes(state.status)
          || !/^[0-9a-f]{64}$/.test(state.draftSha256)) fail('PROCESS_STATE_INVALID');
      return state;
    } catch { fail('PROCESS_STATE_INVALID'); }
  }

  function loadSnapshot(state, expectedSha) {
    if (typeof expectedSha !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha)
        || state.draftSha256 !== expectedSha) fail('PROCESS_CONFIRMATION_SNAPSHOT_MISMATCH');
    let snapshot;
    try { snapshot = JSON.parse(fs.readFileSync(path.join(root, `draft-${expectedSha}.json`), 'utf8')); }
    catch { fail('PROCESS_SNAPSHOT_UNREADABLE'); }
    if (sha(snapshot) !== expectedSha) fail('PROCESS_SNAPSHOT_CHANGED');
    if (canonical(snapshot.target) !== canonical(target)) fail('PROCESS_TARGET_CHANGED');
    return snapshot;
  }

  async function verifyActor(snapshot) {
    let actor;
    try { actor = actorIdentity(await currentActorResolver()); }
    catch { fail('PROCESS_ACTOR_UNAVAILABLE'); }
    if (canonical(actor) !== canonical(snapshot.actor)) fail('PROCESS_ACTOR_CHANGED');
    return actor;
  }

  function receipt(state) {
    return {
      status: state.status, draftSha256: state.draftSha256,
      processInstanceId: state.status === 'submitted' ? state.processInstanceId : null,
      submittedAt: state.submittedAt || null, localDraftOnly: state.status === 'prepared',
      upstreamRejected: state.status === 'rejected',
      upstreamErrorCode: state.status === 'rejected' ? state.upstreamErrorCode || null : null,
    };
  }

  async function prepare({ formData, deptId, preview, validBusinessDate } = {}) {
    return locked(async () => {
      const prior = loadState();
      if (prior && prior.status !== 'prepared') fail('PROCESS_ATTEMPT_ALREADY_SENT');
      if (!formData || Object.getPrototypeOf(formData) !== Object.prototype || !Object.keys(formData).length
          || !validId(deptId) || !preview || typeof preview !== 'object') fail('PROCESS_DRAFT_INPUT_INVALID');
      const instant = now();
      const day = businessDate(instant);
      if (validBusinessDate !== undefined && validBusinessDate !== day) fail('PROCESS_DRAFT_DATE_INVALID');
      let actor;
      try { actor = actorIdentity(await currentActorResolver()); }
      catch { fail('PROCESS_ACTOR_UNAVAILABLE'); }
      if(prior){
        const previous=loadSnapshot(prior,prior.draftSha256);
        if(canonical(previous.actor)!==canonical(actor))fail('PROCESS_ACTOR_CHANGED');
      }
      const snapshot = copy({
        version: 1, target, actor, businessDate: day, timeZone: 'Asia/Shanghai',
        preparedAt: instant.toISOString(), formData, deptId, preview,
      });
      const draftSha256 = sha(snapshot);
      const snapshotFile = path.join(root, `draft-${draftSha256}.json`);
      if (!fs.existsSync(snapshotFile)) writeExclusive(snapshotFile, snapshot);
      else if (sha(JSON.parse(fs.readFileSync(snapshotFile, 'utf8'))) !== draftSha256) fail('PROCESS_SNAPSHOT_CHANGED');
      const state = { version: 1, status: 'prepared', draftSha256, preparedAt: snapshot.preparedAt };
      atomicWrite(stateFile, state);
      return { ...receipt(state), snapshot: copy(snapshot), snapshotPath: snapshotFile };
    });
  }

  async function submit({ draftSha256, confirm } = {}) {
    if (confirm !== true) fail('PROCESS_EXPLICIT_CONFIRMATION_REQUIRED');
    return locked(async () => {
      const state = loadState();
      if (!state) fail('PROCESS_NOT_PREPARED');
      const snapshot = loadSnapshot(state, draftSha256);
      await verifyActor(snapshot);
      if (state.status === 'submitted') {
        if (!validId(state.processInstanceId)) fail('PROCESS_STATE_INVALID');
        return { ...receipt(state), replayed: true };
      }
      if (state.status === 'unknown') fail('PROCESS_SUBMISSION_UNKNOWN_DO_NOT_RETRY');
      if (state.status === 'rejected') rejectPreviouslySent(state);
      if (snapshot.businessDate !== businessDate(now())) fail('PROCESS_DRAFT_EXPIRED');
      // Durable unknown marker precedes the network call. A crash, timeout,
      // malformed response or local receipt failure must never trigger a repost.
      const attempted = { ...state, status: 'unknown', attemptedAt: now().toISOString() };
      atomicWrite(stateFile, attempted);
      let response;
      try {
        response = await client.postFormOnce(endpoint('startInstance'), {
          processCode, formUuid, formDataJson: JSON.stringify(snapshot.formData), deptId: snapshot.deptId,
        });
      } catch { fail('PROCESS_SUBMISSION_UNKNOWN_DO_NOT_RETRY'); }
      if (response && response.success === false) {
        const rejected = { ...attempted, status: 'rejected', upstreamRejected: true,
          upstreamErrorCode: safeUpstreamCode(response), rejectedAt: now().toISOString() };
        atomicWrite(stateFile, rejected);
        rejectPreviouslySent(rejected);
      }
      const processInstanceId = responseInstanceId(response);
      if (!processInstanceId) fail('PROCESS_SUBMISSION_UNKNOWN_DO_NOT_RETRY');
      const submitted = { ...attempted, status: 'submitted', processInstanceId, submittedAt: now().toISOString() };
      atomicWrite(stateFile, submitted);
      await verifyActor(snapshot);
      return { ...receipt(submitted), replayed: false };
    });
  }

  async function readback({ draftSha256 } = {}) {
    return locked(async () => {
      const state = loadState();
      if (!state) fail('PROCESS_NOT_PREPARED');
      const snapshot = loadSnapshot(state, draftSha256);
      await verifyActor(snapshot);
      if (state.status !== 'submitted' || !validId(state.processInstanceId)) fail('PROCESS_NO_CONFIRMED_INSTANCE');
      let response;
      try {
        response = await client.get(endpoint('getInstanceById'), { processInstanceId: state.processInstanceId });
      } catch { fail('PROCESS_READBACK_FAILED'); }
      await verifyActor(snapshot);
      if (!response || response.success !== true) fail('PROCESS_READBACK_FAILED');
      const instance = response.result ?? response.content;
      if (!instance || typeof instance !== 'object' || Array.isArray(instance)) fail('PROCESS_READBACK_INVALID');
      // A formInstId can identify a distinct form instance; it is not proof of
      // the process instance identity requested here. The caller must stop final
      // verification if responseIdentityVerified is false.
      const returnedIds = ['processInstanceId', 'instanceId']
        .filter(key => instance[key] !== undefined && instance[key] !== null).map(key => instance[key]);
      if (returnedIds.some(id => id !== state.processInstanceId)) fail('PROCESS_READBACK_INSTANCE_MISMATCH');
      atomicWrite(stateFile, { ...state, lastReadbackAt: now().toISOString() });
      return { ...receipt(state), requestedInstanceId: state.processInstanceId,
        responseIdentityVerified: returnedIds.length > 0, instance };
    });
  }

  async function inspect({draftSha256}={}) {
    return locked(async()=>{
      const state=loadState();
      if(!state)fail('PROCESS_NOT_PREPARED');
      const snapshot=loadSnapshot(state,draftSha256??state.draftSha256);
      await verifyActor(snapshot);
      return {...receipt(state),snapshot:copy(snapshot)};
    });
  }

  return Object.freeze({ prepare, submit, readback, inspect });
}

module.exports = { createProcessTrial, createProcessManager:createProcessTrial };
