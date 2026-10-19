'use strict';
const Association = require('../../shared/process-association.cjs');
const {displayText} = Association;

const {
  check,
  today
} = require('./common.cjs');
const {
  APP,
  ROOT,
  TENANT,
  roster,
  rosterAgentId,
  sources,
  workflow,
  processCode,
  assertTargetStartAllowed
} = require('./policy.cjs');
const INVOKE = '/query/publicService/invokeService.json';
const Roster = require('../../shared/employee-roster.cjs');
const Department = require('../../shared/department-details.cjs');
const Subject = require('../../shared/workflow-subject.cjs');
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
  fetchImpl = globalThis.fetch,
  runOfficial = auth.command
} = {}) {
  const w = workflow(key),
    initial = auth.actor();
  const rosterPolicy = Roster.rosterPolicy(w.policy);
  Subject.delegationActors(w.policy);
  const subjectScopes = new WeakSet();
  let directoryVersion = 0;
  let directoryUsers = [];
  // A derived role's permission exists only during its internal roster call.
  // Neither public request wrappers nor employee selection receive this scope.
  const departmentRosterScopes = new WeakSet();
  const departmentRoleResults = new Map();
  // Only the latest native picker results can supply a business subject. This
  // local contract is not a substitute for the connector's server-side ACL.
  let directoryPeople = new Set();
  const sameActor = () => {
    const a = auth.actor();
    check(a.userid === initial.userid && a.corp_id === initial.corp_id, 'IDENTITY_CHANGED');
    return a;
  };
  function assertSubjectScope(scope) {
    sameActor();
    check(subjectScopes.has(scope), 'WORKFLOW_SUBJECT_INVALID');
    check(!scope.subject.delegated || scope.directoryVersion === directoryVersion
      && directoryPeople.has(scope.subject.userid) && Subject.canDelegate(initial, w.policy), 'EMPLOYEE_SELECTION_REQUIRED');
    return scope.subject;
  }
  function associationSubject(source, scope) {
    if (!scope) return initial.userid;
    const subject = assertSubjectScope(scope), policy = Association.sourceConstraints(source);
    check(policy.scope === 'applicant' && typeof policy.applicantField === 'string'
      && JSON.stringify(policy.statuses) === '["COMPLETED"]'
      && JSON.stringify(policy.approvedResults) === '["agree"]' && policy.fields?.length > 0,
    'WORKFLOW_SUBJECT_RELATED_POLICY_INVALID');
    return subject.userid;
  }
  function assertPaymentCompanyScope(form, search, fields, scope) {
    if (!w.policy.delegation || form !== sources.employeePaymentCompanies.formUuid) return;
    const subjectId = scope ? assertSubjectScope(scope).userid : initial.userid;
    const source = sources.employeePaymentCompanies;
    check(search && typeof search === 'object' && !Array.isArray(search)
      && Object.keys(search).length === 1 && search[source.employeeIdField] === subjectId,
    'WORKFLOW_SUBJECT_SOURCE_DENIED');
    if (fields) check(fields.every(field => [source.employeeIdField, source.companyField].includes(field)),
      'WORKFLOW_SUBJECT_SOURCE_DENIED');
  }
  async function getToken() {
    sameActor();
    // The official read path refreshes a rejected token before any gap request.
    // Reuse this runtime's fixed-form schema read; never retry a gap write.
    if (typeof runOfficial === 'function') await schema();
    sameActor();
    const value = await auth.token();
    sameActor();
    return value;
  }
  function allowed(base, method, p, b, rosterSubject) {
    const subjectScope = subjectScopes.has(rosterSubject) ? rosterSubject : undefined;
    if (subjectScope) assertSubjectScope(subjectScope);
    if (base === TENANT) {
      if (method === 'GET' && p === '/ossSign') {
        check(b.appType === APP, 'REQUEST_TARGET_DENIED');
        assertTargetStartAllowed(APP, w.formUuid);
        return;
      }
      if (method === 'POST' && p === '/query/attach/uploadCallBack.json') {
        check(b.appType === APP && b.formUuid === w.formUuid, 'REQUEST_TARGET_DENIED');
        assertTargetStartAllowed(APP, w.formUuid);
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
      assertPaymentCompanyScope(b.formUuid, b.searchFieldJson ? parsed(b.searchFieldJson) : undefined, undefined, subjectScope);
      return;
    }
    if (method === 'GET' && p === PROCESS + 'getInstances.json') {
      check(Object.keys(b).every(name => ['formUuid','currentPage','pageSize','originatorId',
        'searchFieldJson','instanceStatus','approvedResult'].includes(name)), 'REQUEST_TARGET_DENIED');
      check(Object.values(w.policy.relatedSources || {}).some(s => {
        if (s.form !== b.formUuid) return false;
        const filters = Association.queryConstraints(s, associationSubject(s, subjectScope));
        return ['originatorId','searchFieldJson','instanceStatus','approvedResult']
          .every(name => b[name] === filters[name]);
      }), 'REQUEST_TARGET_DENIED');
      return;
    }
    if (method === 'GET' && p === PROCESS + 'getInstanceById.json') {
      check(typeof b.processInstanceId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(b.processInstanceId), 'REQUEST_TARGET_DENIED');
      return;
    }
    if (method === 'POST' && p === PROCESS + 'startInstance.json') {
      check(b.formUuid === w.formUuid && b.processCode === processCode(key), 'REQUEST_TARGET_DENIED');
      assertTargetStartAllowed(APP, w.formUuid, b.processCode);
      return;
    }
    if (method === 'POST' && p === INVOKE) {
      check(b.formUuid === w.formUuid && b.appType === APP, 'REQUEST_TARGET_DENIED');
      const info = parsed(b.serviceInfo)?.connectorInfo,
        inputs = parsed(b.inputs);
      check(info && inputs, 'CONNECTOR_DENIED');
      if (info.connectorId === roster.connectorId && info.actionId === roster.actionId && info.connection === roster.connection && info.type === roster.type) {
        const target = inputs.Query?.userid_list;
        const selfOnly = target === initial.userid;
        const departmentRole = departmentRosterScopes.has(rosterSubject)
          && rosterSubject.subject === target;
        const delegatedSubject = subjectScope && subjectScope.subject.userid === target;
        check(String(inputs.Query?.agentid) === String(rosterAgentId)
          && (selfOnly || departmentRole || delegatedSubject || target === rosterSubject && directoryPeople.has(target)
            && rosterPolicy.selected), 'ROSTER_SELF_ONLY');
        Roster.assertConnectorQuery(inputs, {agentId:rosterAgentId, subject:target,
          permitted:departmentRole ? rosterSubject.fields
            : selfOnly || delegatedSubject ? rosterPolicy.self : rosterPolicy.selected});
        return;
      }
      const known = Object.values(w.policy.connectors || {}).find(c => c.connectorId === info.connectorId && c.actionId === info.actionId && c.connection === info.connection && c.type === info.type);
      check(known && inputs['Content-Type'] === 'application/json'
        && Object.keys(inputs).every(name => ['Body','Content-Type'].includes(name))
        && Number.isSafeInteger(inputs.Body?.dept_id) && inputs.Body.dept_id > 0, 'CONNECTOR_DENIED');
      return;
    }
    check(false, 'REQUEST_PATH_DENIED');
  }
  async function officialRequest(method, p, b) {
    const run = async (args, options) => {
      sameActor();
      const result = await runOfficial(args, options);
      sameActor();
      return result;
    };
    if (method === 'GET' && p === SCHEMA) return run(['get-schema', APP, w.formUuid]);
    if (method === 'GET' && p === FORM) {
      const args = ['data', 'query', 'form', APP, b.formUuid, '--page', String(b.currentPage), '--size', String(b.pageSize)];
      if (b.searchFieldJson) args.push('--search-file', '__FARGOWORK_INPUT__');
      const result = await run(args, b.searchFieldJson ? {input: b.searchFieldJson} : {});
      // Official data query form flattens content into data/totalCount/page.
      return result?.success === true && Array.isArray(result.data)
        ? {...result, content: {data: result.data, totalCount: result.totalCount, currentPage: result.currentPage}} : result;
    }
    if (method === 'GET' && p === PROCESS + 'getInstances.json') {
      const args = ['data', 'query', 'process', APP, b.formUuid,
        '--page', String(b.currentPage), '--size', String(b.pageSize)];
      for (const [field, flag] of [['originatorId','--originator-id'],
        ['instanceStatus','--instance-status'], ['approvedResult','--approved-result']]) {
        if (b[field] !== undefined) args.push(flag, b[field]);
      }
      if (b.searchFieldJson !== undefined) args.push('--search-file', '__FARGOWORK_INPUT__');
      return run(args, b.searchFieldJson === undefined ? {} : {input: b.searchFieldJson});
    }
    if (method === 'GET' && p === PROCESS + 'getInstanceById.json') return run([
      'data', 'get', 'process', APP, '--process-inst-id', b.processInstanceId]);
    if (method === 'POST' && p === PROCESS + 'startInstance.json') {
      // Read the name of this exact fixed target only. Never choose an alternative
      // form from navigation; the official create command verifies it again.
      let matches;
      try {
        const rows = await run(['list-forms', APP, '--keyword', w.formUuid]);
        matches = Array.isArray(rows) ? rows.filter(r => r.formUuid === w.formUuid
          && ['process', 'process-form', 'workflow'].includes(r.formType)
          && typeof r.formName === 'string' && r.formName.trim()) : [];
      } catch {
        require('./official-cli.cjs').targetFailure();
      }
      if (matches.length !== 1) require('./official-cli.cjs').targetFailure();
      const args = ['data', 'create', 'process', APP, w.formUuid,
        '--process-code', b.processCode, '--data-file', '__FARGOWORK_INPUT__',
        '--expect-form-name', matches[0].formName.trim(), '--expect-form-type', 'process'];
      if (b.deptId) args.push('--dept-id', String(b.deptId));
      const result = await run(args, {mutation: true, input: b.formDataJson});
      // Official create normalizes string/object responses to a verified ID.
      // The durable submission layer consumes one unambiguous scalar receipt.
      if (result?.success === true) {
        check(result.idVerified === true && result.resource?.type === 'processInstance'
          && result.resource.id === result.processInstanceId, 'WRITE_OUTCOME_UNKNOWN');
        return {success: true, content: result.processInstanceId};
      }
      return result;
    }
    return null;
  }
  async function request(base, method, p, b, rosterSubject) {
    allowed(base, method, p, b, rosterSubject);
    if (base === ROOT && p !== INVOKE && typeof runOfficial === 'function') {
      const value = await officialRequest(method, p, b);
      if (subjectScopes.has(rosterSubject)) assertSubjectScope(rosterSubject);
      check(value && typeof value === 'object' && typeof value.success === 'boolean',
        method === 'POST' ? 'WRITE_OUTCOME_UNKNOWN' : 'UPSTREAM_FORMAT_INVALID');
      return value;
    }
    // Gap adapter only: native attachments and fixed page connector actions.
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
    if (subjectScopes.has(rosterSubject)) assertSubjectScope(rosterSubject);
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
  async function invokeInfo(info, inputs, rosterSubject) {
    const r = await request(ROOT, 'POST', INVOKE, {
      appType: APP,
      formUuid: w.formUuid,
      serviceInfo: JSON.stringify({
        connectorInfo: info
      }),
      inputs: JSON.stringify({
        'Content-Type': 'application/json',
        ...inputs
      })
    }, rosterSubject);
    check(r.success === true, 'CONNECTOR_ACCESS_DENIED');
    const c = parsed(r.content),
      v = parsed(c?.serviceReturnValue ?? c);
    check(v && v.success !== false && [undefined, 0, '0'].includes(v.errcode), 'CONNECTOR_SOURCE_FAILED');
    return v;
  }
  async function readRoster(userId, codes, selected = false, subjectScope) {
    const fields = Roster.permittedFields(codes, selected ? rosterPolicy.selected : rosterPolicy.self);
    const v = await invokeInfo(roster, Roster.connectorQuery({agentId:rosterAgentId,
      subject:userId, fields, permitted:selected ? rosterPolicy.selected : rosterPolicy.self}),
    subjectScope || (selected ? userId : undefined));
    return Roster.projectRoster(v, {subject:userId, corpId:initial.corp_id, fields});
  }
  const self = codes => readRoster(initial.userid, codes);
  async function rosterForSelectedEmployee(userId) {
    check(rosterPolicy.selected, 'SELECTED_EMPLOYEE_ROSTER_NOT_ALLOWED');
    sameActor();
    check(typeof userId === 'string' && directoryPeople.has(userId), 'EMPLOYEE_SELECTION_REQUIRED');
    return readRoster(userId, rosterPolicy.selected, true);
  }
  async function departmentRole(alias) {
    sameActor();
    check(typeof alias === 'string' && Object.hasOwn(w.policy.departmentRoles || {}, alias),
      'DEPARTMENT_ROLE_NOT_ALLOWED');
    if (!departmentRoleResults.has(alias)) {
      const configured = w.policy.departmentRoles[alias];
      check(configured && typeof configured === 'object' && !Array.isArray(configured)
        && Object.keys(configured).every(name => ['connector','departmentId','managerIndex','rosterFields'].includes(name))
        && typeof configured.connector === 'string'
        && configured.connector !== 'roster'
        && Object.hasOwn(w.policy.connectors || {}, configured.connector)
        && Number.isSafeInteger(configured.managerIndex), 'DEPARTMENT_ROLE_POLICY_INVALID');
      const fields = Roster.fieldList(configured.rosterFields, 'DEPARTMENT_ROLE_POLICY_INVALID');
      const role = {connector:configured.connector, departmentId:configured.departmentId,
        managerIndex:configured.managerIndex, fields};
      departmentRoleResults.set(alias, (async () => {
        const details = await Department.queryDepartmentDetails(ctx, role);
        sameActor();
        const userId = Department.departmentManagerAt(details, role.managerIndex);
        if (userId === null) return null;
        const scope = Object.freeze({subject:userId, fields});
        departmentRosterScopes.add(scope);
        try {
          const response = await invokeInfo(roster, Roster.connectorQuery({agentId:rosterAgentId,
            subject:userId, fields, permitted:fields}), scope);
          sameActor();
          const row = Roster.projectRoster(response, {subject:userId,
            corpId:initial.corp_id, fields});
          return {departmentId:details.departmentId, userId, roster:row};
        } finally {
          departmentRosterScopes.delete(scope);
        }
      })());
    }
    const result = await departmentRoleResults.get(alias);
    sameActor();
    // Business code can format its own fields without mutating the cached facts.
    return structuredClone(result);
  }
  async function query(form, search, fields, subjectScope) {
    if (subjectScope) assertSubjectScope(subjectScope);
    check(w.policy.dataForms.includes(form), 'SOURCE_NOT_ALLOWED');
    check(Array.isArray(fields) && fields.length > 0 && fields.every(f => /^[A-Za-z0-9_]+$/.test(f)), 'SOURCE_FIELDS_INVALID');
    assertPaymentCompanyScope(form, search, fields, subjectScope);
    const all = [],
      seen = new Set();
    let total;
    for (let page = 1; page <= 100; page++) {
      const r = await request(ROOT, 'GET', FORM, {
        appType: APP,
        formUuid: form,
        currentPage: page,
        pageSize: 100,
        ...(search ? {
          searchFieldJson: JSON.stringify(search)
        } : {})
      }, subjectScope);
      check(r.success === true, 'COMPANY_SOURCE_UNAVAILABLE');
      const c = r.content;
      check(Array.isArray(c?.data) && Number.isInteger(c.totalCount) && c.totalCount >= 0, 'COMPANY_SOURCE_FORMAT_INVALID');
      check(c.currentPage === undefined || Number(c.currentPage) === page || page === 1 && Number(c.currentPage) === 0 && c.totalCount === 0 && c.data.length === 0, 'COMPANY_SOURCE_PAGE_MISMATCH');
      if (total === undefined) total = c.totalCount;
      check(total === c.totalCount, 'COMPANY_SOURCE_CHANGED');
      for (const row of c.data) {
        check(typeof row.formInstId === 'string' && !seen.has(row.formInstId), 'COMPANY_SOURCE_DUPLICATE');
        seen.add(row.formInstId);
        if (w.policy.delegation && form === sources.employeePaymentCompanies.formUuid) {
          const subjectId = subjectScope ? assertSubjectScope(subjectScope).userid : initial.userid;
          if (row.formData?.[sources.employeePaymentCompanies.employeeIdField] !== subjectId) continue;
        }
        const projected = {
          formInstId: row.formInstId
        };
        for (const f of fields) if (row.formData && Object.hasOwn(row.formData, f)) projected[f] = row.formData[f];
        all.push(projected);
      }
      if (seen.size === total) return all;
      check(c.data.length > 0 && seen.size < total, 'COMPANY_SOURCE_INCOMPLETE');
    }
    check(false, 'COMPANY_SOURCE_TOO_LARGE');
  }
  async function related(type, subjectScope) {
    if (subjectScope) assertSubjectScope(subjectScope);
    check(Object.hasOwn(w.policy.relatedSources || {}, type), 'RELATED_SOURCE_NOT_ALLOWED');
    const s = w.policy.relatedSources[type],
      constraints = Association.sourceConstraints(s),
      subjectId = associationSubject(s, subjectScope),
      filters = Association.queryConstraints(s, subjectId),
      all = [],
      seen = new Set();
    let total;
    for (let page = 1; page <= 100; page++) {
      const r = await request(ROOT, 'GET', PROCESS + 'getInstances.json', {
        formUuid: s.form,
        currentPage: page,
        pageSize: 100,
        ...filters
      }, subjectScope);
      check(r.success === true, 'RELATED_SOURCE_UNAVAILABLE');
      const c = r.content;
      check(Array.isArray(c?.data) && Number.isInteger(c.totalCount) && c.totalCount >= 0, 'RELATED_SOURCE_INVALID');
      check(c.currentPage === undefined || Number(c.currentPage) === page || page === 1 && Number(c.currentPage) === 0 && c.totalCount === 0 && c.data.length === 0, 'RELATED_SOURCE_PAGE_MISMATCH');
      if (total === undefined) total = c.totalCount;
      check(total === c.totalCount, 'RELATED_SOURCE_CHANGED');
      for (const row of c.data) {
        check(row && typeof row === 'object' && !Array.isArray(row), 'RELATED_SOURCE_INVALID');
        const id = row.processInstanceId;
        check(typeof id === 'string' && id.length > 0 && !seen.has(id), 'RELATED_SOURCE_DUPLICATE');
        seen.add(id);
        check(row.formUuid === s.form && typeof row.originator?.userId === 'string'
          && row.originator.userId.length > 0 && row.originatorCorpId === initial.corp_id
          && (row.appType === undefined || row.appType === APP)
          && (constraints.scope !== 'self' || row.originator.userId === initial.userid),
        'RELATED_SOURCE_IDENTITY_MISMATCH');
        check(typeof row.instanceStatus === 'string' && row.instanceStatus.length > 0, 'RELATED_SOURCE_INVALID');
        if (constraints.statuses && !constraints.statuses.includes(row.instanceStatus)) continue;
        const result = constraints.approvedResults ? Association.approvedResult(row) : undefined;
        // A requested agree filter is not evidence that an undocumented or
        // missing result property means approval. Keep such rows out of scope.
        if (constraints.approvedResults && !constraints.approvedResults.includes(result)) continue;
        const d = parsed(row.data) || {};
        if (constraints.scope === 'applicant') {
          const ids = Association.applicantIds(d, constraints.applicantField);
          if (ids.length !== 1 || ids[0] !== subjectId) continue;
        }
        all.push({
          instance_id: id,
          app_type: APP,
          form_uuid: s.form,
          form_type: 'process',
          instance_status: row.instanceStatus,
          originator_userid: row.originator.userId,
          originator_corp_id: row.originatorCorpId,
          ...(constraints.scope === 'applicant' ? {applicant_userid: subjectId} : {}),
          ...(result === undefined ? {} : {approved_result: result}),
          ...(constraints.fields ? {data: Association.projectData(d, constraints.fields)} : {}),
          title: displayText(d[s.title] ?? row.title ?? ''),
          sub_title: s.subtitle ? displayText(d[s.subtitle]) : '',
          created_at: row.gmtCreate ?? null
        });
      }
      if (seen.size === total) return all;
      check(c.data.length > 0 && seen.size < total, 'RELATED_SOURCE_INCOMPLETE');
    }
    check(false, 'RELATED_SOURCE_TOO_LARGE');
  }
  const date = today();
  async function searchEmployees(keyword) {
    directoryPeople = new Set();
    directoryUsers = [];
    directoryVersion++;
    check(w.policy.delegation === undefined ? w.policy.employeeSelection === true
      : Subject.canDelegate(initial, w.policy), 'EMPLOYEE_SELECTION_NOT_ALLOWED');
    check(typeof keyword === 'string' && keyword.trim().length > 0
      && keyword.length <= 100 && !/^[\s]*-/.test(keyword)
      && !/[\x00-\x1f\x7f]/.test(keyword), 'EMPLOYEE_SEARCH_INVALID');
    check(typeof runOfficial === 'function', 'OPENYIDA_COMMAND_REQUIRED');
    sameActor();
    // This official subcommand only reads the native employee picker. It does
    // not read/change app permissions and never accepts a roster target user.
    const result = await runOfficial(['app-permission', 'search-user', keyword.trim(), '--size', '50']);
    sameActor();
    check(result?.success === true && Array.isArray(result.users), 'EMPLOYEE_SOURCE_INVALID');
    const users = result.users.map(user => {
      check(user && typeof user === 'object' && typeof user.userId === 'string'
        && /^[A-Za-z0-9_.@-]{1,160}$/.test(user.userId)
        && (user.corpId === undefined || user.corpId === initial.corp_id)
        && (user.corp_id === undefined || user.corp_id === initial.corp_id)
        && Array.isArray(user.departmentIds) && Array.isArray(user.departments)
        && user.departments.every(dept => dept && typeof dept === 'object'), 'EMPLOYEE_SOURCE_INVALID');
      return {userId:user.userId, userName:user.userName,
        departmentIds:user.departmentIds, departments:user.departments.map(dept => ({
          id:dept.id, name:dept.name, path:dept.path
        }))};
    });
    directoryPeople = new Set(users.map(user => user.userId));
    directoryUsers = structuredClone(users);
    return {success:true, users};
  }
  function forSubject(selectedUserId) {
    sameActor();
    check(w.policy.delegation !== undefined, 'WORKFLOW_SUBJECT_NOT_ALLOWED');
    const subject = Subject.resolveWorkflowSubject({actor: initial, policy: w.policy,
      selectedUserId, candidates: directoryUsers});
    const scope = Object.freeze({subject, directoryVersion});
    subjectScopes.add(scope);
    const scopedRead = async operation => {
      assertSubjectScope(scope);
      const result = await operation();
      assertSubjectScope(scope);
      return result;
    };
    return Object.freeze({actor: Object.freeze({...initial}), subject, today: date, todayMs: ctx.todayMs,
      schema: () => scopedRead(schema),
      roster: codes => scopedRead(() => readRoster(subject.userid, codes, false, scope)),
      query: (form, search, fields) => scopedRead(() => query(form, search, fields, scope)),
      related: type => scopedRead(() => related(type, scope)),
      departmentRole: alias => scopedRead(() => departmentRole(alias)),
      invoke: (alias, inputs) => scopedRead(() => ctx.invoke(alias, inputs))});
  }
  const ctx = {
    actor: initial,
    today: date,
    todayMs: Date.parse(date + 'T00:00:00+08:00'),
    schema,
    roster: self,
    rosterForSelectedEmployee,
    departmentRole,
    query: (form, search, fields) => query(form, search, fields),
    related: type => related(type),
    searchEmployees,
    forSubject,
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
