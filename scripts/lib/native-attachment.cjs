'use strict';

// Native AttachmentField upload only. Authentication stays with the official
// OpenYida provider supplied by the caller; this module never reads credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = 'https://www.aliwork.com';
const TENANT = 'https://xdlonl.aliwork.com';
const APP = 'APP_GITLRTH76PM6J4M29F5D';
const FORMS = new Set(['FORM-4E378FADE81F40F8A520A47251D804E6MT1K',
  'FORM-AEE70BC941234A97B25DE3D5340B7DA7IXT3', 'FORM-188915A63185430D9A57AD9114129887TVCT']);
const TYPES = Object.freeze({'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.gif':'image/gif','.webp':'image/webp','.txt':'text/plain',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'});

function failure(code) {
  const error = new Error(code);
  error.code = code;
  error.safeCode = code;
  return error;
}
function check(value, code) { if (!value) throw failure(code); }
function text(value, max = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function successful(value) {
  return value?.success === true && [undefined, null, '', 0, '0'].includes(value.errorCode);
}
function safeUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw failure('ATTACHMENT_URL_INVALID'); }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port,
    'ATTACHMENT_URL_INVALID');
  return url;
}
function assertTenant(value) {
  const url = safeUrl(value);
  check(url.origin === TENANT && url.pathname === '/' && !url.search,
  'ATTACHMENT_TENANT_REQUIRED');
  return url.origin;
}
function validateLink(value, tenantOrigin) {
  check(text(value, 8192), 'ATTACHMENT_REFERENCE_LINK_INVALID');
  const url = safeUrl(value, tenantOrigin);
  check([tenantOrigin, 'https://www.aliwork.com'].includes(url.origin) ||
    url.hostname.endsWith('.aliyuncs.com'), 'ATTACHMENT_REFERENCE_HOST_REJECTED');
  // Persist only ordinary platform references, never signed/authenticated URLs.
  for (const name of url.searchParams.keys()) {
    check(!/(?:token|secret|signature|credential|authorization|authcode|^code$|^sig$|^policy$|^expires$|accesskey)/i.test(name),
      'ATTACHMENT_REFERENCE_CREDENTIAL_QUERY');
  }
  return value; // Keep the server's complete reference; do not rebuild its links.
}
function equalityConditions(policy) {
  const values = new Map();
  for (const condition of policy.conditions || []) {
    const pairs = Array.isArray(condition)
      ? (condition[0] === 'eq' && typeof condition[1] === 'string'
        ? [[condition[1].replace(/^\$/, ''), condition[2]]] : [])
      : (condition && typeof condition === 'object' ? Object.entries(condition) : []);
    for (const [name, value] of pairs) {
      const key = name.toLowerCase();
      check(!values.has(key) || values.get(key) === value, 'ATTACHMENT_POLICY_CONFLICT');
      values.set(key, value);
    }
  }
  return values;
}
function validateSignature(content, input, tenantOrigin, now) {
  check(content && content.appType === input.appType && text(content.objectName), 'ATTACHMENT_SIGN_REFERENCE_INVALID');
  for (const key of ['host', 'accessid', 'signature', 'policy']) {
    check(text(content[key], key === 'policy' ? 1024 * 1024 : 8192), 'ATTACHMENT_SIGN_INCOMPLETE');
  }
  const host = safeUrl(content.host);
  check(host.hostname.endsWith('.aliyuncs.com') && host.pathname === '/' && !host.search,
    'ATTACHMENT_OSS_HOST_REJECTED');
  let policy;
  try { policy = JSON.parse(Buffer.from(content.policy, 'base64').toString('utf8').replace(/\\\$/g, '$')); }
  catch { throw failure('ATTACHMENT_POLICY_INVALID'); }
  check(policy && Array.isArray(policy.conditions), 'ATTACHMENT_POLICY_INVALID');
  if (policy.expiration) check(Date.parse(policy.expiration) > now(), 'ATTACHMENT_POLICY_EXPIRED');
  const eq = equalityConditions(policy);
  if (eq.has('key')) check(eq.get('key') === content.objectName, 'ATTACHMENT_POLICY_KEY_MISMATCH');
  for (const condition of policy.conditions) {
    if (Array.isArray(condition) && condition[0] === 'starts-with' && condition[1] === '$key') {
      check(typeof condition[2] === 'string' && content.objectName.startsWith(condition[2]), 'ATTACHMENT_POLICY_KEY_MISMATCH');
    }
    if (Array.isArray(condition) && condition[0] === 'content-length-range') {
      check(input.size >= Number(condition[1]) && input.size <= Number(condition[2]), 'ATTACHMENT_POLICY_SIZE_MISMATCH');
    }
  }
  const disposition = eq.get('content-disposition');
  check(text(disposition, 4096), 'ATTACHMENT_POLICY_DISPOSITION_MISSING');
  const status = String(eq.get('success_action_status') || '200');
  check(['200', '201', '204'].includes(status), 'ATTACHMENT_POLICY_STATUS_INVALID');
  const reference = {name: input.name, size: input.size, fileUuid: content.objectName};
  for (const key of ['url', 'downloadUrl', 'previewUrl']) {
    reference[key] = validateLink(content[key], tenantOrigin);
  }
  return {host: host.href, disposition, status, reference};
}
function summaryOf(state, reused) {
  return {
    status: state.phase,
    uploaded: state.phase === 'complete',
    registered: state.phase === 'complete',
    bytes: state.size,
    upload_attempts: state.uploadAttempts,
    reused,
  };
}
function mimeFor(filePath) {
  const mime = TYPES[path.extname(filePath).toLowerCase()];
  check(mime, 'ATTACHMENT_EXTENSION_NOT_SUPPORTED');
  return mime;
}
function localFile(filePath) {
  check(text(filePath, 4096) && path.isAbsolute(filePath) && !/^[\\/]{2}/.test(filePath), 'ATTACHMENT_LOCAL_ABSOLUTE_PATH_REQUIRED');
  check(!/[<>|?*]/.test(filePath) && !filePath.slice(path.parse(filePath).root.length).includes(':'), 'ATTACHMENT_PATH_INVALID');
  const resolved = path.resolve(filePath);
  let current = resolved;
  try {
    while (current !== path.dirname(current)) {
      check(!fs.lstatSync(current).isSymbolicLink(), 'ATTACHMENT_SYMLINK_NOT_ALLOWED');
      current = path.dirname(current);
    }
  } catch (error) { throw failure(error.safeCode || 'ATTACHMENT_FILE_UNREADABLE'); }
  return resolved;
}
function validateBytes(bytes, contentType) {
  let valid = false;
  if(contentType==='application/pdf') valid=bytes.subarray(0,5).toString('ascii')==='%PDF-';
  else if(contentType==='image/png') valid=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  else if(contentType==='image/jpeg') valid=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  else if(contentType==='image/gif') valid=['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii'));
  else if(contentType==='image/webp') valid=bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP';
  else if(contentType==='text/plain') valid=!bytes.includes(0)&&!bytes.subarray(0,2).equals(Buffer.from('MZ'));
  else valid=bytes.subarray(0,4).equals(Buffer.from([80,75,3,4]));
  check(valid, 'ATTACHMENT_FILE_TYPE_MISMATCH');
}
function actorKey(actor) {
  check(actor&&text(actor.userid,160)&&text(actor.corp_id,160),'ATTACHMENT_ACTOR_REQUIRED');
  return digest(JSON.stringify({userid:actor.userid,corp_id:actor.corp_id}));
}

function createNativeAttachmentUploader(options) {
  const {tenantClient, appType, formUuid, stateDir, fetchImpl = globalThis.fetch,
    maxBytes = 20 * 1024 * 1024, now = Date.now} = options;
  const tenantOrigin = assertTenant(options.tenantOrigin);
  check(tenantClient && typeof tenantClient.get === 'function', 'ATTACHMENT_CLIENT_REQUIRED');
  const postOnce = options.postFormOnce || (typeof tenantClient.postFormOnce === 'function'
    ? tenantClient.postFormOnce.bind(tenantClient) : null);
  check(typeof postOnce === 'function', 'ATTACHMENT_CALLBACK_ONCE_REQUIRED');
  check(typeof fetchImpl === 'function', 'ATTACHMENT_HTTP_REQUIRED');
  check(text(appType, 160) && text(formUuid, 160) && typeof stateDir === 'string' && stateDir,
    'ATTACHMENT_CONFIG_INVALID');
  check(appType === APP && FORMS.has(formUuid), 'ATTACHMENT_TARGET_NOT_ALLOWED');
  const actorDigest = actorKey(options.actor);
  check(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 20 * 1024 * 1024, 'ATTACHMENT_SIZE_LIMIT_INVALID');
  // The caller must establish tenant ownership from an observed official route.
  // A DNS suffix alone does not prove which company the tenant belongs to.
  if (typeof tenantClient.getAuthRef === 'function') {
    check(tenantClient.getAuthRef()?.baseUrl === tenantOrigin, 'ATTACHMENT_CLIENT_TENANT_MISMATCH');
  }
  const root = path.resolve(stateDir);
  try { fs.mkdirSync(root, {recursive: true, mode: 0o700}); }
  catch { throw failure('ATTACHMENT_STATE_CREATE_FAILED'); }
  const bindingPath = path.join(root,'.binding.json');
  const binding = {schema:1,tenantOrigin,appType,formUuid,actorDigest};
  try { fs.writeFileSync(bindingPath,JSON.stringify(binding),{flag:'wx',mode:0o600}); }
  catch (error) {
    check(error.code==='EEXIST','ATTACHMENT_STATE_CREATE_FAILED');
    let prior;
    try { prior=JSON.parse(fs.readFileSync(bindingPath,'utf8')); } catch { throw failure('ATTACHMENT_STATE_UNREADABLE'); }
    check(JSON.stringify(prior)===JSON.stringify(binding),'ATTACHMENT_DRAFT_ACCOUNT_OR_TARGET_CHANGED');
  }

  async function upload({filePath, contentType, attemptId, expectedSha256}) {
    check(typeof filePath === 'string' && text(attemptId, 160) && /^[a-zA-Z0-9_-]+$/.test(attemptId),
      'ATTACHMENT_INPUT_INVALID');
    filePath = localFile(filePath);
    const expectedMime = mimeFor(filePath);
    contentType = contentType || expectedMime;
    check(contentType===expectedMime, 'ATTACHMENT_CONTENT_TYPE_INVALID');
    const name = path.basename(filePath);
    check(text(name, 255), 'ATTACHMENT_FILENAME_INVALID');
    let stat;
    try { stat = fs.statSync(filePath); } catch { throw failure('ATTACHMENT_FILE_UNREADABLE'); }
    check(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, 'ATTACHMENT_FILE_SIZE_INVALID');
    let bytes;
    try { bytes = fs.readFileSync(filePath); } catch { throw failure('ATTACHMENT_FILE_UNREADABLE'); }
    check(bytes.length === stat.size && bytes.length <= maxBytes, 'ATTACHMENT_FILE_CHANGED');
    validateBytes(bytes, contentType);
    const sha256 = digest(bytes);
    if(expectedSha256!==undefined)check(expectedSha256===sha256,'ATTACHMENT_FILE_CHANGED');
    const identity = {tenantOrigin, appType, formUuid, actorDigest, sha256, contentType};
    // Content-based key also prevents a fresh attemptId from silently re-uploading
    // the same file after an unknown result within this draft's state directory.
    const key = digest(JSON.stringify(identity));
    const statePath = path.join(root, key + '.json');
    let fd;
    try { fd = fs.openSync(statePath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw failure('ATTACHMENT_STATE_CREATE_FAILED');
      let prior;
      try { prior = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { throw failure('ATTACHMENT_STATE_UNREADABLE'); }
      check(prior.schema === 1 && prior.key === key && prior.size === bytes.length && prior.actorDigest===actorDigest && prior.name===name && prior.sha256===sha256, 'ATTACHMENT_STATE_INVALID');
      if (prior.phase === 'complete' && prior.reference) {
        check(prior.reference.name === name && prior.reference.size === bytes.length && text(prior.reference.fileUuid),
          'ATTACHMENT_STATE_INVALID');
        for (const k of ['url', 'downloadUrl', 'previewUrl']) validateLink(prior.reference[k], tenantOrigin);
        return {reference: prior.reference, sha256, summary: summaryOf(prior, true)};
      }
      throw failure('ATTACHMENT_PREVIOUS_ATTEMPT_REQUIRES_REVIEW');
    }
    let state = {schema: 1, key, attemptId, actorDigest, name, sha256, phase: 'signing', size: bytes.length, uploadAttempts: 0,
      createdAt: new Date(now()).toISOString()};
    function save() {
      const value = Buffer.from(JSON.stringify(state, null, 2) + '\n');
      fs.writeSync(fd, value, 0, value.length, 0);
      fs.ftruncateSync(fd, value.length);
      fs.fsyncSync(fd); // Finish the durable guard before allowing an OSS request.
    }
    let phase = 'signing';
    try {
      save();
      const proposedObject = `${appType}/${crypto.randomUUID()}${path.extname(name)}`;
      const signed = await tenantClient.get('/ossSign', {
        scene: 'AttachmentField', _api: 'nattyFetch', _mock: 'false', appType,
        fileName: name, fileSize: String(bytes.length), contentType, isOpen: 'n', newContext: 'y',
        objectName: proposedObject, procInstId: '', businessType: '', accelerate: 'y', _stamp: String(now()),
      }, {silentStatus: true});
      check(successful(signed), 'ATTACHMENT_SIGN_FAILED');
      const signedContent = signed.content;
      const validated = validateSignature(signedContent, {appType, name, size: bytes.length}, tenantOrigin, now);
      const form = new FormData();
      const parameters = {accessid: signedContent.accessid, key: signedContent.objectName, policy: signedContent.policy,
        OSSAccessKeyId: signedContent.accessid, signature: signedContent.signature, expire: signedContent.expire,
        appType, success_action_status: validated.status, 'Content-Disposition': validated.disposition};
      for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== null) form.append(key, String(value));
      form.append('file', new Blob([bytes], {type: contentType}), name);
      phase = 'upload_unknown';
      state.phase = phase;
      state.uploadAttempts = 1;
      save();
      // No headers from the authenticated client are reused here. Never follow
      // redirects and never replay an uncertain upload.
      const response = await fetchImpl(validated.host, {
        method: 'POST', body: form, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000),
      });
      check(response && Number.isInteger(response.status), 'ATTACHMENT_OSS_RESPONSE_INVALID');
      state.httpStatus = response.status;
      const requestId = response.headers?.get('x-oss-request-id');
      if (![200, 201, 204].includes(response.status)) {
        phase = 'upload_rejected';
        state.phase = phase;
        save();
        throw failure('ATTACHMENT_OSS_REJECTED');
      }
      check(text(requestId, 256), 'ATTACHMENT_OSS_REQUEST_ID_MISSING');
      // Receiving the status and actual OSS request ID establishes upload success;
      // cancelling an unused body is not a reason to upload again.
      if (response.body?.cancel) { try { await response.body.cancel(); } catch {} }
      phase = 'registration_unknown';
      state.phase = phase;
      state.objectName = signedContent.objectName;
      state.ossRequestId = requestId;
      save();
      const registered = await postOnce('/query/attach/uploadCallBack.json', {
        appType, formUuid, fileName: name, fileSize: String(bytes.length), objectName: signedContent.objectName,
        procInstId: '', ossRequestId: requestId, businessType: 'inst',
      }, {silentStatus: true});
      check(successful(registered), 'ATTACHMENT_REGISTRATION_FAILED');
      state.phase = 'complete';
      state.reference = validated.reference;
      state.completedAt = new Date(now()).toISOString();
      save();
      return {reference: validated.reference, sha256, summary: summaryOf(state, false)};
    } catch (error) {
      const code = error.safeCode || ({signing: 'ATTACHMENT_SIGN_TRANSPORT_FAILED',
        upload_unknown: 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN', upload_rejected: 'ATTACHMENT_OSS_REJECTED',
        registration_unknown: 'ATTACHMENT_REGISTRATION_OUTCOME_UNKNOWN'})[phase] || 'ATTACHMENT_OPERATION_FAILED';
      state.errorCode = code;
      try { save(); } catch {} // Existing guard remains blocking even if receipt writing fails.
      throw failure(code); // Never expose provider errors, headers, URLs or response bodies.
    } finally { fs.closeSync(fd); }
  }
  return {upload};
}

async function verifyDownload({reference, expectedSha256, tenantOrigin, rootOrigin = 'https://www.aliwork.com',
  getAccessToken, fetchImpl = globalThis.fetch}) {
  tenantOrigin = assertTenant(tenantOrigin);
  check(rootOrigin === 'https://www.aliwork.com', 'ATTACHMENT_DOWNLOAD_ROOT_INVALID');
  check(reference && text(reference.downloadUrl, 8192) && Number.isSafeInteger(reference.size) &&
    reference.size > 0 && reference.size <= 20 * 1024 * 1024 && /^[a-f0-9]{64}$/i.test(expectedSha256),
  'ATTACHMENT_DOWNLOAD_INPUT_INVALID');
  check(typeof getAccessToken === 'function' && typeof fetchImpl === 'function', 'ATTACHMENT_DOWNLOAD_PROVIDER_REQUIRED');
  let url = safeUrl(reference.downloadUrl, rootOrigin);
  for (let hop = 0; hop < 4; hop++) {
    const authenticated = [rootOrigin, tenantOrigin].includes(url.origin);
    check(authenticated || url.hostname.endsWith('.aliyuncs.com'), 'ATTACHMENT_DOWNLOAD_HOST_REJECTED');
    let response;
    try {
      const headers = authenticated ? {Authorization: `Bearer ${await getAccessToken()}`} : {};
      response = await fetchImpl(url.href, {method: 'GET', headers, redirect: 'manual', credentials: 'omit',
        signal: AbortSignal.timeout(30000)});
    } catch { throw failure('ATTACHMENT_DOWNLOAD_TRANSPORT_FAILED'); }
    check(response && Number.isInteger(response.status), 'ATTACHMENT_DOWNLOAD_RESPONSE_INVALID');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get('location');
      if (response.body?.cancel) { try { await response.body.cancel(); } catch {} }
      check(text(location, 16384), 'ATTACHMENT_DOWNLOAD_REDIRECT_INVALID');
      url = safeUrl(location, url);
      continue;
    }
    check(response.status === 200, 'ATTACHMENT_DOWNLOAD_HTTP_FAILED');
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            check(size <= reference.size, 'ATTACHMENT_DOWNLOAD_SIZE_MISMATCH');
            hash.update(chunk.value);
          }
        } finally { try { await reader.cancel(); } catch {} }
      } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        size = bytes.length;
        hash.update(bytes);
      }
    } catch (error) { throw failure(error.safeCode || 'ATTACHMENT_DOWNLOAD_TRANSPORT_FAILED'); }
    check(size === reference.size, 'ATTACHMENT_DOWNLOAD_SIZE_MISMATCH');
    check(hash.digest('hex') === expectedSha256.toLowerCase(), 'ATTACHMENT_DOWNLOAD_HASH_MISMATCH');
    return {http_status: 200, bytes: size, sha256_match: true, redirects: hop};
  }
  throw failure('ATTACHMENT_DOWNLOAD_REDIRECT_LIMIT');
}

module.exports = {createNativeAttachmentUploader, verifyDownload, mimeFor};
