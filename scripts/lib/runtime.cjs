'use strict';

const {
  check,
  today
} = require('./common.cjs');
const {
  APP,
  ROOT,
  TENANT,
  roster,
  relatedSources,
  workflow,
  processCode
} = require('./policy.cjs');
const INVOKE = '/query/publicService/invokeService.json';
const SCHEMA = `/alibaba/web/${APP}/_view/query/formdesign/getFormSchema.json`;
const FORM = `/dingtalk/web/${APP}/v1/form/searchFormDatas.json`;
const PROCESS = `/dingtalk/web/${APP}/v1/process/`;
function parsed(x) {
  if (typeof x === 'string') {
    try {
      return JSON.parse(x);
    } catch {
      check(false, 'UPSTREAM_FORMAT_INVALID');
    }
  }
  return x;
}
function createRuntime(key, {
  auth = require('./auth.cjs'),
  fetchImpl = globalThis.fetch
} = {}) {
  const w = workflow(key),
    initial = auth.actor();
  const sameActor = () => {
    const a = auth.actor();
    check(a.userid === initial.userid && a.corp_id === initial.corp_id, 'IDENTITY_CHANGED');
    return a;
  };
  async function getToken() {
    sameActor();
    const value = await auth.token();
    sameActor();
    return value;
  }
  function allowed(base, method, p, b) {
    if (base === TENANT) {
      if (method === 'GET' && p === '/ossSign') {
        check(b.appType === APP, 'REQUEST_TARGET_DENIED');
        return;
      }
      if (method === 'POST' && p === '/query/attach/uploadCallBack.json') {
        check(b.appType === APP && b.formUuid === w.formUuid, 'REQUEST_TARGET_DENIED');
        return;
      }
      check(false, 'REQUEST_PATH_DENIED');
    }
    check(base === ROOT, 'REQUEST_ORIGIN_DENIED');
    if (method === 'GET' && p === SCHEMA) {
      check(b.formUuid === w.formUuid && b.schemaVersion === 'V5', 'REQUEST_TARGET_DENIED');
      return;
    }
    if (method === 'GET' && p === FORM) {
      check(w.policy.dataForms.includes(b.formUuid) && b.appType === APP, 'REQUEST_TARGET_DENIED');
      return;
    }
    if (method === 'GET' && p === PROCESS + 'getInstances.json') {
      check(key === 'external_expense_request' && Object.values(relatedSources).some(s => s.form === b.formUuid) && b.originatorId === initial.userid, 'REQUEST_TARGET_DENIED');
      return;
    }
    if (method === 'GET' && p === PROCESS + 'getInstanceById.json') {
      check(typeof b.processInstanceId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(b.processInstanceId), 'REQUEST_TARGET_DENIED');
      return;
    }
    if (method === 'POST' && p === PROCESS + 'startInstance.json') {
      check(b.formUuid === w.formUuid && b.processCode === processCode(key), 'REQUEST_TARGET_DENIED');
      return;
    }
    if (method === 'POST' && p === INVOKE) {
      check(b.formUuid === w.formUuid && b.appType === APP, 'REQUEST_TARGET_DENIED');
      const info = parsed(b.serviceInfo)?.connectorInfo,
        inputs = parsed(b.inputs);
      check(info && inputs, 'CONNECTOR_DENIED');
      if (info.connectorId === roster.connectorId && info.actionId === roster.actionId && info.connection === roster.connection && info.type === roster.type) {
        check(inputs.Query?.userid_list === initial.userid && inputs.Query.agentid === '3195124669', 'ROSTER_SELF_ONLY');
        check(String(inputs.Query.field_filter_list).split(',').every(c => w.policy.rosterFields.includes(c)), 'ROSTER_FIELD_DENIED');
        return;
      }
      const known = Object.values(w.policy.connectors || {}).find(c => c.connectorId === info.connectorId && c.actionId === info.actionId && c.connection === info.connection && c.type === info.type);
      check(known && Number.isSafeInteger(inputs.Body?.dept_id) && inputs.Body.dept_id > 0, 'CONNECTOR_DENIED');
      return;
    }
    check(false, 'REQUEST_PATH_DENIED');
  }
  async function request(base, method, p, b) {
    allowed(base, method, p, b);
    const t = await getToken();
    const url = new URL(p, base);
    if (method === 'GET') for (const [k, v] of Object.entries(b)) url.searchParams.set(k, String(v));
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${t}`,
          Accept: 'application/json',
          Origin: base,
          Referer: base + '/',
          'x-requested-with': 'XMLHttpRequest',
          ...(method === 'POST' ? {
            'Content-Type': 'application/x-www-form-urlencoded'
          } : {})
        },
        ...(method === 'POST' ? {
          body: new URLSearchParams(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v)]))).toString()
        } : {}),
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(30000)
      });
    } catch {
      check(false, method === 'POST' && p !== INVOKE ? 'WRITE_OUTCOME_UNKNOWN' : 'UPSTREAM_UNAVAILABLE');
    }
    sameActor();
    check(response.status === 200, method === 'POST' && p !== INVOKE ? 'WRITE_OUTCOME_UNKNOWN' : [401, 403].includes(response.status) ? 'UPSTREAM_ACCESS_DENIED' : 'UPSTREAM_READ_FAILED');
    let result;
    try {
      result = await response.json();
    } catch {
      check(false, method === 'POST' && p !== INVOKE ? 'WRITE_OUTCOME_UNKNOWN' : 'UPSTREAM_FORMAT_INVALID');
    }
    check(result && typeof result === 'object' && typeof result.success === 'boolean', method === 'POST' && p !== INVOKE ? 'WRITE_OUTCOME_UNKNOWN' : 'UPSTREAM_FORMAT_INVALID');
    return result;
  }
  const client = {
    get: (p, b) => request(ROOT, 'GET', p, b),
    postFormOnce: (p, b) => request(ROOT, 'POST', p, b)
  };
  const tenant = {
    get: (p, b) => request(TENANT, 'GET', p, b),
    postFormOnce: (p, b) => request(TENANT, 'POST', p, b)
  };
  let schemaPromise;
  async function schema() {
    if (!schemaPromise) schemaPromise = client.get(SCHEMA, {
      formUuid: w.formUuid,
      schemaVersion: 'V5'
    }).then(r => {
      check(r.success && r.content, 'SCHEMA_UNAVAILABLE');
      return parsed(r.content);
    });
    return schemaPromise;
  }
  async function invokeInfo(info, inputs) {
    const r = await client.postFormOnce(INVOKE, {
      appType: APP,
      formUuid: w.formUuid,
      serviceInfo: JSON.stringify({
        connectorInfo: info
      }),
      inputs: JSON.stringify({
        'Content-Type': 'application/json',
        ...inputs
      })
    });
    check(r.success === true, 'CONNECTOR_ACCESS_DENIED');
    const c = parsed(r.content),
      v = parsed(c?.serviceReturnValue ?? c);
    check(v && v.success !== false && [undefined, 0, '0'].includes(v.errcode), 'CONNECTOR_SOURCE_FAILED');
    return v;
  }
  async function self(codes) {
    check(Array.isArray(codes) && codes.length && codes.every(c => w.policy.rosterFields.includes(c)), 'ROSTER_FIELD_DENIED');
    const v = await invokeInfo(roster, {
      Query: {
        agentid: '3195124669',
        userid_list: initial.userid,
        field_filter_list: codes.join(',')
      }
    });
    check(Array.isArray(v.result) && v.result.length === 1 && v.result[0].userid === initial.userid, 'ROSTER_IDENTITY_MISMATCH');
    const row = v.result[0];
    check(Array.isArray(row.field_data_list), 'ROSTER_FORMAT_INVALID');
    return {
      ...row,
      field_data_list: row.field_data_list.filter(f => codes.includes(f.field_code))
    };
  }
  async function query(form, search, fields) {
    check(w.policy.dataForms.includes(form), 'SOURCE_NOT_ALLOWED');
    check(Array.isArray(fields) && fields.length > 0 && fields.every(f => /^[A-Za-z0-9_]+$/.test(f)), 'SOURCE_FIELDS_INVALID');
    const all = [],
      seen = new Set();
    let total;
    for (let page = 1; page <= 100; page++) {
      const r = await client.get(FORM, {
        appType: APP,
        formUuid: form,
        currentPage: page,
        pageSize: 100,
        ...(search ? {
          searchFieldJson: JSON.stringify(search)
        } : {})
      });
      check(r.success === true, 'COMPANY_SOURCE_UNAVAILABLE');
      const c = r.content;
      check(Array.isArray(c?.data) && Number.isInteger(c.totalCount) && c.totalCount >= 0, 'COMPANY_SOURCE_FORMAT_INVALID');
      check(c.currentPage === undefined || Number(c.currentPage) === page || page === 1 && Number(c.currentPage) === 0 && c.totalCount === 0 && c.data.length === 0, 'COMPANY_SOURCE_PAGE_MISMATCH');
      if (total === undefined) total = c.totalCount;
      check(total === c.totalCount, 'COMPANY_SOURCE_CHANGED');
      for (const row of c.data) {
        check(typeof row.formInstId === 'string' && !seen.has(row.formInstId), 'COMPANY_SOURCE_DUPLICATE');
        seen.add(row.formInstId);
        const projected = {
          formInstId: row.formInstId
        };
        for (const f of fields) if (row.formData && Object.hasOwn(row.formData, f)) projected[f] = row.formData[f];
        all.push(projected);
      }
      if (all.length === total) return all;
      check(c.data.length > 0 && all.length < total, 'COMPANY_SOURCE_INCOMPLETE');
    }
    check(false, 'COMPANY_SOURCE_TOO_LARGE');
  }
  async function related(type) {
    check(key === 'external_expense_request' && Object.hasOwn(relatedSources, type), 'RELATED_SOURCE_NOT_ALLOWED');
    const s = relatedSources[type],
      all = [],
      seen = new Set();
    let total;
    for (let page = 1; page <= 100; page++) {
      const r = await client.get(PROCESS + 'getInstances.json', {
        formUuid: s.form,
        currentPage: page,
        pageSize: 100,
        originatorId: initial.userid
      });
      check(r.success === true, 'RELATED_SOURCE_UNAVAILABLE');
      const c = r.content;
      check(Array.isArray(c?.data) && Number.isInteger(c.totalCount), 'RELATED_SOURCE_INVALID');
      check(c.currentPage === undefined || Number(c.currentPage) === page || page === 1 && Number(c.currentPage) === 0 && c.totalCount === 0 && c.data.length === 0, 'RELATED_SOURCE_PAGE_MISMATCH');
      if (total === undefined) total = c.totalCount;
      check(total === c.totalCount, 'RELATED_SOURCE_CHANGED');
      for (const row of c.data) {
        const id = row.processInstanceId;
        check(typeof id === 'string' && !seen.has(id), 'RELATED_SOURCE_DUPLICATE');
        seen.add(id);
        check(row.formUuid === s.form && row.originator?.userId === initial.userid && row.originatorCorpId === initial.corp_id, 'RELATED_SOURCE_IDENTITY_MISMATCH');
        if (!['RUNNING', 'COMPLETED'].includes(row.instanceStatus)) continue;
        const d = parsed(row.data) || {};
        all.push({
          instance_id: id,
          app_type: APP,
          form_uuid: s.form,
          form_type: 'process',
          instance_status: row.instanceStatus,
          originator_userid: initial.userid,
          title: String(d[s.title] ?? row.title ?? ''),
          sub_title: String(d[s.subtitle] ?? ''),
          created_at: row.gmtCreate ?? null
        });
      }
      if (seen.size === total) return all;
      check(c.data.length > 0 && seen.size < total, 'RELATED_SOURCE_INCOMPLETE');
    }
    check(false, 'RELATED_SOURCE_TOO_LARGE');
  }
  const date = today();
  const ctx = {
    actor: initial,
    today: date,
    todayMs: Date.parse(date + 'T00:00:00+08:00'),
    schema,
    roster: self,
    query,
    related,
    invoke: (alias, inputs) => {
      check(Object.hasOwn(w.policy.connectors || {}, alias) && alias !== 'roster', 'CONNECTOR_NOT_ALLOWED');
      const id = inputs?.Body?.dept_id;
      check(typeof id === 'number' || typeof id === 'string' && /^\d+$/.test(id), 'DEPARTMENT_ID_INVALID');
      return invokeInfo(w.policy.connectors[alias], {
        ...inputs,
        Body: {
          ...inputs.Body,
          dept_id: Number(id)
        }
      });
    }
  };
  return {
    ctx,
    client,
    tenant,
    actor: sameActor,
    getAccessToken: getToken
  };
}
module.exports = {
  createRuntime
};
