#!/usr/bin/env node
'use strict';

const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const {
  check,
  dataRoot,
  digest,
  write,
  read,
  today,
  fields,
  safeCode
} = require('./lib/common.cjs');
const {
  APP,
  TENANT,
  ROOT,
  registry,
  workflow,
  workflowAvailability,
  workflowGroup,
  workflowCategory,
  assertWorkflowStartAllowed,
  processCode,
  attachmentAllowed
} = require('./lib/policy.cjs');
const {
  createRuntime
} = require('./lib/runtime.cjs');
const {
  createProcessManager
} = require('./lib/process.cjs');
const {
  createNativeAttachmentUploader,
  verifyDownload
} = require('./lib/native-attachment.cjs');
const {
  validateInstance
} = require('./lib/verification.cjs');
const {supportForError} = require('./lib/support.cjs');
const DetailReview = require('../shared/detail-review.cjs');
const {
  attachmentJobs,
  attachmentGroupKey,
  attachmentRuleGroups,
  resolveAttachmentRules,
  attachmentCounts,
  bindUploadedAttachments,
  withoutAttachmentReferences,
  referenceFor
} = require('../shared/workflow-attachments.cjs');
const VERSION = require('../package.json').version;
const json = x => JSON.parse(JSON.stringify(x));
function parse(args) {
  const [command, ...tail] = args,
    positionals = [],
    options = {};
  for (let i = 0; i < tail.length; i++) {
    const v = tail[i];
    if (v.startsWith('--')) {
      check(['--input', '--draft', '--confirm'].includes(v) && !Object.hasOwn(options, v.slice(2)) && tail[i + 1] && !tail[i + 1].startsWith('--'), 'ARGUMENT_INVALID');
      options[v.slice(2)] = tail[++i];
    } else positionals.push(v);
  }
  check(positionals.length <= 1, 'ARGUMENT_INVALID');
  const accepted = {
    details: ['input'],
    review: ['input', 'draft'],
    'confirm-details': ['confirm'],
    prepare: ['input', 'draft'],
    submit: ['confirm'],
    preview: [],
    result: [],
    status: [],
    login: [],
    logout: [],
    workflows: [],
    requirements: [],
    doctor: []
  };
  check(Object.hasOwn(accepted, command) && Object.keys(options).every(k => accepted[command].includes(k)), 'COMMAND_NOT_ALLOWED');
  if (['details', 'review', 'confirm-details', 'prepare', 'submit', 'preview', 'result', 'requirements'].includes(command)) check(positionals.length === 1, 'ARGUMENT_INVALID');else check(positionals.length === 0, 'ARGUMENT_INVALID');
  return {
    command,
    arg: positionals[0],
    options
  };
}
function draftDir(root, id) {
  check(typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id), 'DRAFT_ID_INVALID');
  return path.join(root, 'drafts', id);
}
function sameActor(a, b) {
  return a.corp_id === b.corp_id && a.userid === b.userid;
}
function fileAttempt(file) {
  const expectedSha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return {
    expectedSha256,
    attemptId: crypto.createHash('sha256').update(path.basename(file) + '\0' + expectedSha256).digest('hex')
  };
}
async function locked(dir, fn) {
  fs.mkdirSync(dir, {
    recursive: true,
    mode: 0o700
  });
  const file = path.join(dir, 'command.lock');
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch {
    check(false, 'DRAFT_BUSY_OR_INTERRUPTED');
  }
  let preserveLock = true;
  try {
    fs.writeFileSync(fd, JSON.stringify({pid: process.pid}) + '\n');
    fs.fsyncSync(fd);
    preserveLock = false;
    return await fn();
  } catch (error) {
    if (error.retainDraftLock === true) preserveLock = true;
    throw error;
  } finally {
    fs.closeSync(fd);
    if (!preserveLock) fs.unlinkSync(file);
  }
}
function manager(rt, w, dir) {
  return createProcessManager({
    client: rt.client,
    appType: APP,
    formUuid: w.formUuid,
    processCode: processCode(w.key),
    stateDir: path.join(dir, 'process'),
    currentActorResolver: rt.actor
  });
}
function attachmentRules(schema, field) {
  if (!field) return null;
  const n = fields(schema)[field];
  check(n?.componentName === 'AttachmentField', 'NATIVE_ATTACHMENT_UNAVAILABLE');
  const p = n.props;
  check(Number.isSafeInteger(Number(p.limit)) && Number(p.limit) > 0 && Number.isFinite(Number(p.maxFileSize)) && Number(p.maxFileSize) > 0, 'ATTACHMENT_SCHEMA_LIMIT_INVALID');
  return {
    required: p.required === true || Array.isArray(p.validation) && p.validation.some(v => v.type === 'required'),
    maxCount: Number(p.limit),
    maxBytes: Math.min(100, Number(p.maxFileSize)) * 1024 * 1024,
    accept: typeof p.accept === 'string' ? p.accept.split(',').map(x => x.trim().toLowerCase()).filter(Boolean) : []
  };
}
function checkFiles(files, rules) {
  check(Array.isArray(files) && files.every(p => typeof p === 'string' && path.isAbsolute(p)), 'ATTACHMENT_INPUT_INVALID');
  check(new Set(files.map(p => path.resolve(p).toLowerCase())).size === files.length, 'ATTACHMENT_DUPLICATE');
  check(rules || files.length === 0, 'WORKFLOW_ATTACHMENT_NOT_SUPPORTED');
  if (!rules) return;
  check(files.length <= rules.maxCount, 'ATTACHMENT_COUNT_EXCEEDED');
  for (const f of files) {
    check(fs.existsSync(f), 'ATTACHMENT_FILE_NOT_FOUND');
    check(fs.statSync(f).size <= rules.maxBytes, 'ATTACHMENT_FILE_TOO_LARGE');
    if (rules.accept.length) check(rules.accept.includes(path.extname(f).toLowerCase()) || rules.accept.includes('*') || rules.accept.includes('*/*'), 'ATTACHMENT_TYPE_NOT_ALLOWED_BY_FORM');
  }
}
function inputData(options, detailReview = false) {
  check(options.input && path.isAbsolute(options.input), 'INPUT_FILE_REQUIRED');
  const raw = read(options.input);
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'INPUT_OBJECT_REQUIRED');
  const input = {
    ...raw
  };
  const files = input.attachments ?? [];
  delete input.attachments;
  const materials = detailReview ? input.materials : undefined;
  const materialUploads=detailReview?input.materialUploads:undefined;
  if (detailReview) {delete input.materials;delete input.materialUploads;}
  check(Array.isArray(files) && files.every(file => typeof file === 'string' && path.isAbsolute(file)), 'ATTACHMENT_INPUT_INVALID');
  return {
    input,
    files,
    filesProvided: Object.hasOwn(raw, 'attachments'),
    ...(detailReview ? {materials, materialsProvided: Object.hasOwn(raw, 'materials'),
      materialUploads,materialUploadsProvided:Object.hasOwn(raw,'materialUploads')} : {})
  };
}
function intentIdentity(key, actor, data) {
  return digest({
    workflow: key,
    actor: {
      userid: actor.userid,
      corp_id: actor.corp_id
    },
    date: today(),
    input: data.input,
    files: data.files.map(file => path.resolve(file))
  });
}
function intentPath(root, identity) {
  const dir = path.join(root, 'intents');
  fs.mkdirSync(dir, {
    recursive: true,
    mode: 0o700
  });
  return path.join(dir, identity + '.json');
}
function claimIntent(file, id) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return read(file).draftId;
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({
      draftId: id
    }) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return id;
}
function incompleteDraft(id, revision) {
  return {
    status: 'not_submitted',
    draftId: id,
    code: revision?.code || 'PREPARATION_INCOMPLETE',
    mayRetry: false,
    requiresConfirmation: false,
    message: '流程尚未提交，本次草稿准备未完成，旧预览和确认已经失效。若上传结果未知，先联系维护者核对，不要重传。'
  };
}
function reviewRequired(id) {
  return {status:'needs_detail_review',...(id?{draftId:id}:{}),code:'DETAIL_REVIEW_REQUIRED',
    nextAction:'review',requiresConfirmation:false,localDraftOnly:true,
    message:'请先整理并展示本流程明细，用 review 保存草稿；员工确认明细后，再继续补齐申请信息。'};
}
function revisionPending(dir, workflowKey, actor) {
  const pending={version:VERSION,status:'pending',revisionId:crypto.randomUUID(),workflow:workflowKey,
    actor:{userid:actor.userid,corp_id:actor.corp_id}};
  try {write(path.join(dir,'revision.json'),pending);}
  catch(error) {error.retainDraftLock=true;throw error;}
  return pending;
}
function readonlyDetailContext(rt,actor,w) {
  check(sameActor(actor,rt.ctx.actor),'IDENTITY_CHANGED');
  const context={actor:{...rt.ctx.actor},schema:rt.ctx.schema,query:rt.ctx.query};
  // Only workflows with an explicit delegation policy receive native picker
  // and subject-scoped reads. First-round details never receive roster or
  // general connector/upload/submit capabilities from either context.
  if(w.policy?.delegation!==undefined) {
    check(typeof rt.ctx.searchEmployees==='function'&&typeof rt.ctx.forSubject==='function',
      'WORKFLOW_DETAIL_CONTEXT_INVALID');
    context.searchEmployees=rt.ctx.searchEmployees;
    if(typeof rt.ctx.related==='function') context.related=rt.ctx.related;
    context.forSubject=userId=>{
      const selected=rt.ctx.forSubject(userId);
      check(selected&&sameActor(actor,selected.actor),'IDENTITY_CHANGED');
      return {actor:{...selected.actor},subject:{...selected.subject},schema:selected.schema,
        query:selected.query,related:selected.related};
    };
  }
  return context;
}
async function refreshReview(dir,w,rt,info,prior) {
  const file=path.join(dir,'details-review.json');
  // Failure cannot leave a previously confirmed but now unverified review live.
  write(file,{...(prior||{}),status:'pending',confirmedSha256:null});
  const materials=DetailReview.normalizeMaterials(info.materials||[],info.input.items?.length||0,w.materialRoles);
  if(info.materialUploads!==undefined) DetailReview.normalizeMaterialUploads(info.materialUploads,w.materialRoles);
  const result=json(await w.details(info.input,readonlyDetailContext(rt,info.actor,w)));
  if(w.materialRoles!==undefined) check(digest(result.detailReviewContract?.materialRoles)===digest(w.materialRoles),
    'WORKFLOW_DETAIL_REVIEW_CONTRACT_INVALID');
  check(sameActor(info.actor,rt.actor()),'IDENTITY_CHANGED');
  check(!['draftId','draftSha256','authorization','requiresConfirmation','formData','processInstanceId']
    .some(key=>Object.hasOwn(result,key)),'WORKFLOW_DETAILS_RESULT_INVALID');
  const review=DetailReview.checkpoint({workflow:w.key,actor:info.actor,result,materials,previous:prior});
  write(file,review);
  return review;
}
function attemptedResult(state,id) {
  return {status:state.status,draftId:id,processInstanceId:state.processInstanceId,mayRetry:false,
    message:'此草稿已经发出提交尝试，请用 result 查看，不能重新起草或重复提交。'};
}
function assertPreparedReview(dir,w,info,review,prepared) {
  const current=DetailReview.checkpoint({workflow:w.key,actor:info.actor,previous:review,
    result:{rows:review.rows,preview:review.preview,needsInput:review.needsInput,
      ...(review.detailReviewContract===undefined?{}:{detailReviewContract:review.detailReviewContract})},
    materials:DetailReview.normalizeMaterials(info.materials||[],info.input.items?.length||0,w.materialRoles)});
  if(current.reviewSha256!==review.reviewSha256||!DetailReview.preparedMatches(review,prepared)) {
    write(path.join(dir,'details-review.json'),{...current,status:'pending',confirmedSha256:null});
    check(false,'DETAIL_FACTS_CHANGED_REVIEW_REQUIRED');
  }
}
async function run(args, deps = {}) {
  const {
      command,
      arg,
      options
    } = parse(args);
  if (command === 'workflows') return {
    workflows: Object.values(registry).map(w => {
      const availability = workflowAvailability(w.key);
      return {key: w.key, title: w.title, category: workflowCategory(w.key), group: workflowGroup(w.key),
        ...(!availability.canStart ? {availability, message: availability.message} : {})};
    }),
    scope: `仅 ${Object.keys(registry).length} 个固定流程；不检索其他流程。`
  };
  if (command === 'requirements') {
    const w = workflow(arg);
    const availability = workflowAvailability(w.key);
    if (!availability.canStart) return {
      status: 'unavailable', code: 'WORKFLOW_UNAVAILABLE', workflow: w.key, title: w.title,
      category: workflowCategory(w.key), group: workflowGroup(w.key),
      availability, message: availability.message, mayRetry: false, requiresConfirmation: false,
      nextAction: 'follow_workflow_guidance'
    };
    return {
      workflow: w.key,
      title: w.title,
      category: workflowCategory(w.key),
      group: workflowGroup(w.key),
      requirements: w.requirements,
      attachments: w.requirements.attachments || {required:false,supported:false}
    };
  }
  if (command === 'details') {
    // This branch deliberately finishes before dataRoot(), draft locks, intent
    // records, attachment handling, or the process manager can be constructed.
    assertWorkflowStartAllowed(arg);
    const w = workflow(arg);
    check(typeof w.details === 'function', 'WORKFLOW_DETAILS_NOT_SUPPORTED');
    check(options.input && path.isAbsolute(options.input), 'INPUT_FILE_REQUIRED');
    const input = read(options.input);
    check(input && typeof input === 'object' && !Array.isArray(input), 'INPUT_OBJECT_REQUIRED');
    check(!Object.hasOwn(input, 'attachments'), 'READ_ONLY_ATTACHMENTS_NOT_ALLOWED');
    const detailsAuth = deps.auth || require('./lib/auth.cjs');
    const detailsRuntime = deps.runtime || createRuntime;
    check((await detailsAuth.status()).status === 'ready', 'OPENYIDA_LOGIN_REQUIRED');
    const rt = detailsRuntime(arg, {auth: detailsAuth});
    const current = rt.actor(), actor = {userid: current.userid, corp_id: current.corp_id};
    check(sameActor(actor, rt.ctx.actor), 'IDENTITY_CHANGED');
    // No roster, connectors, raw HTTP client, upload or submit capability is
    // passed to a first-round details adapter.
    const result = json(await w.details(input, readonlyDetailContext(rt,actor,w)));
    check(sameActor(actor, rt.actor()), 'IDENTITY_CHANGED');
    check(result && typeof result === 'object' && !Array.isArray(result)
      && Array.isArray(result.rows)
      && (result.needsInput === undefined || Array.isArray(result.needsInput))
      && !['draftId', 'draftSha256', 'authorization', 'requiresConfirmation',
        'formData', 'processInstanceId'].some(key => Object.hasOwn(result, key)),
    'WORKFLOW_DETAILS_RESULT_INVALID');
    const needs = result.needsInput || [];
    return {
      ...result, readOnly: true, status: needs.length ? 'needs_input' : 'details_ready', workflow: arg,
      nextAction: needs.some(need => need.resolver === 'agent_recommendation')
        ? 'agent_recommendation' : needs.length ? 'clarify_details' : 'review_details'
    };
  }
  if (command === 'prepare' || command === 'review') assertWorkflowStartAllowed(arg);
  if (command === 'review') check(workflow(arg).detailReview === true
    && typeof workflow(arg).details === 'function','WORKFLOW_DETAIL_REVIEW_NOT_SUPPORTED');
  // Starting this workflow at prepare must not trigger main-form reads or an
  // upload, nor manufacture a second intent before its detail review exists.
  if (command === 'prepare' && workflow(arg).detailReview === true && !options.draft) return reviewRequired();
  const root = deps.root || dataRoot();
  if (command === 'preview' || command === 'submit' || command === 'confirm-details') {
    const info = read(path.join(draftDir(root, arg), 'input.json'));
    assertWorkflowStartAllowed(info.workflow);
  }
  const auth = deps.auth || require('./lib/auth.cjs'),
    runtime = deps.runtime || createRuntime;
  if (command === 'status' || command === 'login' || command === 'logout') return auth[command]();
  if (command === 'doctor') return {
    version: VERSION,
    node: process.versions.node,
    platform: process.platform,
    identity: (await auth.status()).status,
    scope: `${Object.keys(registry).length}-fixed-workflows`,
    diagnostics: '如需支持，仅提供时间、命令名、错误码和草稿编号。'
  };
  check((await auth.status()).status === 'ready', 'OPENYIDA_LOGIN_REQUIRED');
  if (command === 'review') {
    const w=workflow(arg),rt=runtime(arg,{auth}),actor=rt.actor();
    let id=options.draft,initialData;
    if(!id) {
      initialData=inputData(options,true);
      id=claimIntent(intentPath(root,intentIdentity(arg,actor,initialData)),crypto.randomUUID());
    }
    const dir=draftDir(root,id);
    return locked(dir,async()=>{
      const infoFile=path.join(dir,'input.json'),previous=fs.existsSync(infoFile)?read(infoFile):null;
      if(options.draft) check(previous,'DRAFT_NOT_FOUND');
      if(previous) check(previous.workflow===arg&&sameActor(previous.actor,actor),'DRAFT_IDENTITY_OR_WORKFLOW_MISMATCH');
      if(fs.existsSync(path.join(dir,'process','state.json'))) {
        const state=await manager(rt,w,dir).inspect();
        if(state.status!=='prepared') return attemptedResult(state,id);
      }
      const pending=revisionPending(dir,arg,actor);
      const reviewFile=path.join(dir,'details-review.json'),prior=fs.existsSync(reviewFile)?read(reviewFile):null;
      // Invalid input on a revision also revokes its old final preview.
      write(reviewFile,{...(prior||{}),status:'pending',confirmedSha256:null});
      const request=initialData||inputData(options,true),input={...previous?.input,...request.input};
      const files=previous&&!request.filesProvided?previous.files:request.files;
      const materials=request.materialsProvided?request.materials:previous?.materials||[];
      const identity=intentIdentity(arg,actor,{input,files});
      check(claimIntent(intentPath(root,identity),id)===id,'DRAFT_INTENT_ALREADY_BOUND');
      const info={version:VERSION,workflow:arg,actor:{userid:actor.userid,corp_id:actor.corp_id},input,files,materials,
        identity,revisionId:pending.revisionId,workflowState:previous?.workflowState||null};
      if(request.materialUploadsProvided||previous?.materialUploads!==undefined)
        info.materialUploads=request.materialUploadsProvided?request.materialUploads:previous.materialUploads;
      write(infoFile,info);
      const review=await refreshReview(dir,w,rt,info,prior);
      return DetailReview.response(review,id);
    }).catch(error=>{error.draftId=id;throw error;});
  }
  if (command === 'prepare') {
    const w = workflow(arg);
    const rt = runtime(arg, {
        auth
      }),
      actor = rt.actor();
    let id = options.draft;
    let initialData;
    if (!id) {
      initialData = inputData(options, w.detailReview === true);
      id = claimIntent(intentPath(root, intentIdentity(arg, actor, initialData)), crypto.randomUUID());
    }
    const dir = draftDir(root, id);
    return locked(dir, async () => {
      const infoFile = path.join(dir, 'input.json');
      const previous = fs.existsSync(infoFile) ? read(infoFile) : null;
      if (options.draft) check(previous, 'DRAFT_NOT_FOUND');
      if (previous) check(previous.workflow === arg && sameActor(previous.actor, actor), 'DRAFT_IDENTITY_OR_WORKFLOW_MISMATCH');
      const pm = manager(rt, w, dir);
      if (fs.existsSync(path.join(dir, 'process', 'state.json'))) {
        const old = await pm.inspect();
        if (old.status !== 'prepared') return {
          status: old.status,
          draftId: id,
          processInstanceId: old.processInstanceId,
          mayRetry: false,
          message: '此草稿已经发出提交尝试，请用 result 查看，不能重新起草或重复提交。'
        };
      }
      // Persist invalidation before input/source validation or any attachment work.
      // Only the final revision commit can make the new snapshot confirmable.
      const revisionFile = path.join(dir, 'revision.json');
      const revisionId = crypto.randomUUID();
      const pending = {
        version: VERSION,
        status: 'pending',
        revisionId,
        workflow: arg,
        actor: {
          userid: actor.userid,
          corp_id: actor.corp_id
        }
      };
      try {
        write(revisionFile, pending);
      } catch (error) {
        // If storage cannot persist invalidation, retain the durable command
        // lock so later commands cannot fall back to the prior confirmation.
        error.retainDraftLock = true;
        throw error;
      }
      try {
        const request = initialData || inputData(options, w.detailReview === true);
        const input = w.partialUpdates || w.detailReview === true ? {...previous?.input,...request.input} : request.input;
        // Workflows with editable initial defaults also accept partial replies.
        // Omission preserves files there; an explicit [] always clears them.
        const files = (w.partialUpdates || w.detailReview === true) && previous && !request.filesProvided ? previous.files : request.files;
        const identity = intentIdentity(arg, actor, {
          input,
          files
        });
        check(claimIntent(intentPath(root, identity), id) === id, 'DRAFT_INTENT_ALREADY_BOUND');
        const info = {
          version: VERSION,
          workflow: arg,
          actor: {
            userid: actor.userid,
            corp_id: actor.corp_id
          },
          input,
          files,
          identity,
          revisionId,
          workflowState: previous?.workflowState || null
        };
        if(w.detailReview === true) info.materials=request.materialsProvided?request.materials:previous?.materials||[];
        if(w.detailReview===true&&(request.materialUploadsProvided||previous?.materialUploads!==undefined))
          info.materialUploads=request.materialUploadsProvided?request.materialUploads:previous.materialUploads;
        write(infoFile, info);
        let detailReview;
        if(w.detailReview === true) {
          const file=path.join(dir,'details-review.json'),prior=fs.existsSync(file)?read(file):null;
          if(!prior) return reviewRequired(id);
          detailReview=await refreshReview(dir,w,rt,info,prior);
          if(detailReview.needsInput.length||detailReview.confirmedSha256!==detailReview.reviewSha256)
            return DetailReview.response(detailReview,id);
        }
        const prepared = json(await w.prepare(input, {...rt.ctx, workflowState: info.workflowState,
          inputUpdateKeys:Object.keys(request.input)}));
        rt.actor();
        if (Object.hasOwn(prepared, 'workflowState')) {
          info.workflowState = prepared.workflowState;
          write(infoFile, info);
        }
        if (prepared.needsInput?.length) {
          write(revisionFile, {
            ...pending,
            code: 'PREPARATION_NEEDS_INPUT'
          });
          return {
            status: 'needs_input',
            draftId: id,
            needsInput: prepared.needsInput
          };
        }
        check(prepared.formData && prepared.departmentId && prepared.preview, 'WORKFLOW_RESULT_INVALID');
        if(detailReview) assertPreparedReview(dir,w,info,detailReview,prepared);
        const schema = await rt.ctx.schema();
        const jobs = attachmentJobs(input, files, prepared, field => attachmentAllowed(APP, w.formUuid, field));
        const resolvedRules = resolveAttachmentRules(prepared, field => attachmentRules(schema, field));
        const groups = attachmentRuleGroups(input, prepared, jobs);
        const rulesByGroup = new Map();
        for (const group of groups) {
          const rules = resolvedRules.rulesByField.get(group.field);
          rulesByGroup.set(attachmentGroupKey(group), rules);
          checkFiles(group.jobs.map(job => job.filePath), rules);
          if (rules.required && !group.jobs.length) {
          write(revisionFile, {
            ...pending,
            code: 'PREPARATION_NEEDS_INPUT'
          });
          return {
            status: 'needs_input',
            draftId: id,
            needsInput: [{
              field: group.inputField,
              message: group.rowIndex === undefined
                ? group.previewField ? `请补充“${group.previewField}”要求的本地文件。` : '这个流程要求附件，请提供需要随申请提交的本地文件。'
                : `请补充第 ${group.rowIndex + 1} 行要求的文件。`
            }]
          };
          }
        }
        const materialUploadScope=detailReview&&w.materialRoles!==undefined
          ?DetailReview.assertMaterialUploadScope(detailReview,prepared,jobs,info.materialUploads||[]):null;
        if(materialUploadScope) prepared.preview.附件来源=materialUploadScope.summary;
        const uploaded = [];
        if (jobs.length) {
          const uploaders = new Map();
          for (const job of jobs) {
            rt.actor();
            // Validate each field separately. Keep the content ledger shared by
            // this draft so moving an uncertain upload to another field cannot
            // accidentally upload it again; field placement is frozen below.
            if (!uploaders.has(job.field)) uploaders.set(job.field, createNativeAttachmentUploader({
              tenantClient: rt.tenant,
              tenantOrigin: TENANT,
              appType: APP,
              formUuid: w.formUuid,
              fieldId: job.field,
              stateDir: path.join(dir, 'attachments'),
              actor: rt.actor(),
              maxBytes: rulesByGroup.get(attachmentGroupKey(job)).maxBytes
            }));
            const uploader = uploaders.get(job.field);
            const attempt=fileAttempt(job.filePath);
            if(materialUploadScope) check(materialUploadScope.files.some(item=>item.field===job.field
              &&item.filePath===job.filePath&&item.sha256===attempt.expectedSha256),'DETAIL_MATERIAL_UPLOAD_SCOPE_INVALID');
            const up = await uploader.upload({
              filePath: job.filePath,
              ...attempt
            });
            rt.actor();
            await verifyDownload({
              reference: up.reference,
              expectedSha256: up.sha256,
              tenantOrigin: TENANT,
              rootOrigin: ROOT,
              getAccessToken: rt.getAccessToken
            });
            rt.actor();
            check(!uploaded.some(x => attachmentGroupKey(x) === attachmentGroupKey(job)
              && x.reference.fileUuid === up.reference.fileUuid), 'ATTACHMENT_DUPLICATE_CONTENT');
            uploaded.push({...job,reference:up.reference,sha256:up.sha256});
          }
        }
        const bound = bindUploadedAttachments(prepared, uploaded);
        prepared.formData = bound.formData;
        const attachmentSummary = bound.attachments;
        const preview = {
          流程: w.title,
          ...bound.preview
        };
        const receipt = await pm.prepare({
          formData: prepared.formData,
          deptId: String(prepared.departmentId),
          preview: json(preview),
          verification: prepared.verification || {},
          validBusinessDate: today()
        });
        write(path.join(dir, 'prepared.json'), {
          version: VERSION,
          workflow: arg,
          revisionId,
          identity,
          draftSha256: receipt.draftSha256,
          workflowStateDigest: digest(info.workflowState),
          ...(detailReview ? {detailReviewSha256:detailReview.reviewSha256} : {}),
          ...(materialUploadScope?{materialUploadScopeDigest:materialUploadScope.digest}:{}),
          businessDigest: digest({
            formData: withoutAttachmentReferences(prepared.formData,prepared.attachmentField,prepared.attachmentInputs,prepared.attachmentFields),
            departmentId: String(prepared.departmentId)
          }),
          attachmentField: prepared.attachmentField || null,
          attachmentInputs: prepared.attachmentInputs || null,
          attachmentFields: prepared.attachmentFields || null,
          attachmentRequirements: resolvedRules.requirements,
          attachments: attachmentSummary
        });
        check(read(revisionFile).revisionId === revisionId, 'DRAFT_REVISION_CHANGED');
        rt.actor();
        write(revisionFile, {
          ...pending,
          status: 'prepared',
          identity,
          draftSha256: receipt.draftSha256
        });
        return {
          status: 'prepared',
          draftId: id,
          nextAction: 'preview',
          requiresConfirmation: true,
          localDraftOnly: true,
          message: '草稿已准备。先读取并展示最终预览，然后等待员工回复；本步骤不授权提交。'
        };
      } catch (error) {
        // This is inside command.lock, so a failed older prepare cannot clobber
        // the completion/error marker of a newer revision.
        if (read(revisionFile).revisionId === revisionId) {
          write(revisionFile, {
            ...pending,
            code: safeCode(error)
          });
        }
        throw error;
      }
    }).catch(error => {
      error.draftId = id;
      throw error;
    });
  }
  const dir = draftDir(root, arg);
  return locked(dir, async () => {
    const info = read(path.join(dir, 'input.json'));
    if (command !== 'result') assertWorkflowStartAllowed(info.workflow);
    const w = workflow(info.workflow),
      rt = runtime(info.workflow, {
        auth
      });
    check(sameActor(info.actor, rt.actor()), 'DRAFT_IDENTITY_MISMATCH');
    const pm = manager(rt, w, dir);
    const revisionFile = path.join(dir, 'revision.json');
    const revision = fs.existsSync(revisionFile) ? read(revisionFile) : null;
    if(command === 'confirm-details') {
      check(w.detailReview===true,'WORKFLOW_DETAIL_REVIEW_NOT_SUPPORTED');
      if(fs.existsSync(path.join(dir,'process','state.json'))) {
        const state=await pm.inspect();
        if(state.status!=='prepared') return attemptedResult(state,arg);
      }
      const file=path.join(dir,'details-review.json');
      check(fs.existsSync(file),'DETAIL_REVIEW_REQUIRED');
      const prior=read(file);
      check(prior.status==='ready'&&options.confirm&&options.confirm===prior.reviewSha256,'DETAIL_EXPLICIT_CONFIRMATION_REQUIRED');
      check(!prior.needsInput.length,'DETAIL_REVIEW_INCOMPLETE');
      let current;
      try {
        current=DetailReview.checkpoint({workflow:w.key,actor:info.actor,previous:prior,
          result:{rows:prior.rows,preview:prior.preview,needsInput:prior.needsInput,
            ...(prior.detailReviewContract===undefined?{}:{detailReviewContract:prior.detailReviewContract})},
      materials:DetailReview.normalizeMaterials(info.materials||[],info.input.items?.length||0,w.materialRoles)});
      } catch(error) {
        revisionPending(dir,w.key,info.actor);
        write(file,{...prior,status:'pending',confirmedSha256:null});
        throw error;
      }
      if(current.reviewSha256!==prior.reviewSha256) {
        revisionPending(dir,w.key,info.actor);write(file,current);
        return DetailReview.response(current,arg);
      }
      check(sameActor(info.actor,rt.actor()),'IDENTITY_CHANGED');
      write(file,{...current,confirmedSha256:current.reviewSha256});
      return DetailReview.response({...current,confirmedSha256:current.reviewSha256},arg);
    }
    if (!fs.existsSync(path.join(dir, 'process', 'state.json'))) {
      return incompleteDraft(arg, revision);
    }
    const state = await pm.inspect();
    let saved;
    if (state.status === 'prepared') {
      if (revision?.status !== 'prepared') return incompleteDraft(arg, revision);
      saved = read(path.join(dir, 'prepared.json'));
      check(revision.version === VERSION && revision.workflow === info.workflow && sameActor(revision.actor, info.actor) && revision.revisionId === info.revisionId && revision.revisionId === saved.revisionId && revision.identity === info.identity && revision.identity === saved.identity && revision.draftSha256 === state.draftSha256 && revision.draftSha256 === saved.draftSha256, 'DRAFT_REVISION_INCOMPLETE');
    }
    if (command === 'preview') {
      if (state.status === 'prepared') {
        check(state.snapshot.businessDate === today(), 'PROCESS_DRAFT_EXPIRED');
        // Records that this exact visible preview was requested, not human consent.
        write(path.join(dir, 'prepared.json'), {...saved, previewedDraftSha256: state.draftSha256});
      }
      return {
        status: state.status === 'prepared' ? 'awaiting_user_confirmation' : state.status,
        draftId: arg,
        draftSha256: state.draftSha256,
        preview: state.snapshot.preview,
        processInstanceId: state.processInstanceId,
        requiresConfirmation: state.status === 'prepared',
        nextAction: state.status === 'prepared' ? 'wait_for_user_reply' : 'result',
        ...(state.status === 'prepared' ? {
          message: '向员工展示这份业务预览并结束本轮操作，等待员工下一条明确确认。此前提出申请或说提交，不代替此处确认。'
        } : {})
      };
    }
    if (command === 'submit') {
      check(options.confirm && options.confirm === state.draftSha256, 'PROCESS_EXPLICIT_CONFIRMATION_REQUIRED');
      if (state.status === 'prepared') {
        check(saved.previewedDraftSha256 === state.draftSha256, 'PROCESS_PREVIEW_REQUIRED');
        check(saved.version === VERSION && info.version === VERSION, 'DRAFT_VERSION_CHANGED');
        check(state.snapshot.businessDate === today(), 'PROCESS_DRAFT_EXPIRED');
        check(saved.workflowStateDigest === digest(info.workflowState || null), 'DRAFT_WORKFLOW_STATE_CHANGED');
        let detailReview;
        if(w.detailReview===true) {
          const file=path.join(dir,'details-review.json');
          check(fs.existsSync(file),'DETAIL_REVIEW_REQUIRED');
          const prior=read(file);
          check(prior.status==='ready'&&prior.confirmedSha256===prior.reviewSha256
            &&saved.detailReviewSha256===prior.reviewSha256,'DETAIL_REVIEW_REQUIRED');
          try {detailReview=await refreshReview(dir,w,rt,info,prior);}
          catch(error) {revisionPending(dir,w.key,info.actor);throw error;}
          if(detailReview.needsInput.length||detailReview.confirmedSha256!==detailReview.reviewSha256) {
            revisionPending(dir,w.key,info.actor);
            return DetailReview.response(detailReview,arg);
          }
        }
        const fresh = json(await w.prepare(info.input, {...rt.ctx, workflowState: info.workflowState || null,inputUpdateKeys:[]}));
        check(!fresh.needsInput?.length && fresh.formData && fresh.departmentId, 'BUSINESS_FACTS_CHANGED_REPREPARE');
        if(detailReview) {
          try {assertPreparedReview(dir,w,info,detailReview,fresh);}
          catch(error) {revisionPending(dir,w.key,info.actor);throw error;}
        }
        const af = saved.attachmentField;
        const freshDigest = digest({
          formData: withoutAttachmentReferences(fresh.formData,af,saved.attachmentInputs,saved.attachmentFields),
          departmentId: String(fresh.departmentId)
        });
        check(freshDigest === saved.businessDigest && (fresh.attachmentField || null) === af
          && digest(fresh.attachmentInputs || null) === digest(saved.attachmentInputs || null)
          && digest(fresh.attachmentFields || null) === digest(saved.attachmentFields || null), 'BUSINESS_FACTS_CHANGED_REPREPARE');
        const freshJobs = attachmentJobs(info.input,info.files,fresh,field => attachmentAllowed(APP,w.formUuid,field));
        if(detailReview&&w.materialRoles!==undefined) {
          try {
            const scope=DetailReview.assertMaterialUploadScope(detailReview,fresh,freshJobs,info.materialUploads||[]);
            check(scope.digest===saved.materialUploadScopeDigest,'BUSINESS_FACTS_CHANGED_REPREPARE');
          } catch(error) {revisionPending(dir,w.key,info.actor);throw error;}
        }
        check(freshJobs.length === saved.attachments.length, 'BUSINESS_FACTS_CHANGED_REPREPARE');
        const schema = await rt.ctx.schema();
        const resolvedRules = resolveAttachmentRules(fresh, field => attachmentRules(schema, field));
        check(digest(resolvedRules.requirements) === digest(saved.attachmentRequirements === undefined ? {} : saved.attachmentRequirements),
          'BUSINESS_FACTS_CHANGED_REPREPARE');
        const currentGroups = attachmentCounts(freshJobs);
        for (const [key,count] of attachmentCounts(saved.attachments)) check(currentGroups.get(key) === count, 'BUSINESS_FACTS_CHANGED_REPREPARE');
        const ruleGroups = attachmentRuleGroups(info.input,fresh,freshJobs);
        for (const group of ruleGroups) {
          const rules = resolvedRules.rulesByField.get(group.field);
          check(group.jobs.length <= rules.maxCount, 'BUSINESS_FACTS_CHANGED_REPREPARE');
          check(!rules.required || group.jobs.length > 0, 'BUSINESS_FACTS_CHANGED_REPREPARE');
          check(group.jobs.every(job => fs.statSync(job.filePath).size <= rules.maxBytes), 'BUSINESS_FACTS_CHANGED_REPREPARE');
          check(!rules.accept.length || group.jobs.every(job => rules.accept.includes(path.extname(job.filePath).toLowerCase())
            || rules.accept.includes('*') || rules.accept.includes('*/*')), 'BUSINESS_FACTS_CHANGED_REPREPARE');
        }
        check(freshJobs.every((job,index) => {
          const item = saved.attachments[index];
          return item.field === job.field && (item.rowIndex ?? null) === (job.rowIndex ?? null)
            && fileAttempt(job.filePath).expectedSha256 === item.sha256;
        }), 'BUSINESS_FACTS_CHANGED_REPREPARE');
        for (const item of saved.attachments) {
          const ref = referenceFor(state.snapshot,saved,item);
          check(ref, 'ATTACHMENT_SNAPSHOT_MISMATCH');
          await verifyDownload({
            reference: ref,
            expectedSha256: item.sha256,
            tenantOrigin: TENANT,
            rootOrigin: ROOT,
            getAccessToken: rt.getAccessToken
          });
        }
        rt.actor();
      }
      const receipt = await pm.submit({
        draftSha256: options.confirm,
        confirm: true
      });
      return {
        ...receipt,
        draftId: arg,
        message: '申请已提交，尚不代表审批通过。'
      };
    }
    if (command === 'result') {
      if (state.status !== 'submitted') return {
        status: state.status,
        draftId: arg,
        mayRetry: false,
        message: state.status === 'unknown' ? '提交结果未知，请先在宜搭核对，勿重提。' : '尚无已确认成功的流程实例。'
      };
      try {
        const back = await pm.readback({
            draftSha256: state.draftSha256
          }),
          verification = validateInstance({
            instance: back.instance,
            snapshot: state.snapshot,
            expectedInstanceId: state.processInstanceId
          });
        return {
          status: 'submitted',
          draftId: arg,
          processInstanceId: state.processInstanceId,
          mayRetry: false,
          verificationStatus: back.responseIdentityVerified ? verification.status : 'unavailable',
          attachmentVerification: back.responseIdentityVerified ? verification.attachmentStatus : 'unavailable',
          contentVerified: back.responseIdentityVerified && verification.allPassed,
          message: verification.allPassed && back.responseIdentityVerified ? '申请已提交，内容及附件已核对。' : verification.status === 'mismatch' ? '申请已提交；回读发现需核对的数据差异，请联系支持人员核查，勿重提。' : '申请已提交；部分内容暂未完成核对，勿重提。'
        };
      } catch (e) {
        const identityMismatch = safeCode(e) === 'PROCESS_READBACK_INSTANCE_MISMATCH';
        return {
          status: 'submitted',
          draftId: arg,
          processInstanceId: state.processInstanceId,
          mayRetry: false,
          verificationStatus: identityMismatch ? 'mismatch' : 'unavailable',
          attachmentVerification: 'unavailable',
          contentVerified: false,
          code: safeCode(e),
          message: identityMismatch ? '申请已提交；回读返回了不同实例，请联系 IT 核查，勿重提。' : '已提交；暂时无法回读核对，不要重新提交。'
        };
      }
    }
  });
}
if (require.main === module) {
  run(process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value, null, 2) + '\n')).catch(e => {
    process.stdout.write(JSON.stringify({
      status: 'stopped',
      code: safeCode(e),
      ...(e.draftId ? {
        draftId: e.draftId
      } : {}),
      mayRetry: false,
      ...(safeCode(e) === 'WORKFLOW_UNAVAILABLE' && e.availability ? {
        workflow: e.workflow, availability: e.availability,
        message: e.availability.message, requiresConfirmation: false,
        nextAction: 'follow_workflow_guidance'
      } : supportForError(safeCode(e)))
    }) + '\n');
    process.exitCode = 1;
  });
}
module.exports = {
  run,
  parse,
  attachmentRules,
  checkFiles,
  fileAttempt
};
