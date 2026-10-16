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
  processCode
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
  if (['prepare', 'submit', 'preview', 'result', 'requirements'].includes(command)) check(positionals.length === 1, 'ARGUMENT_INVALID');else check(positionals.length === 0, 'ARGUMENT_INVALID');
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
  check(Number.isFinite(Number(p.limit)) && Number(p.limit) > 0 && Number.isFinite(Number(p.maxFileSize)) && Number(p.maxFileSize) > 0, 'ATTACHMENT_SCHEMA_LIMIT_INVALID');
  return {
    required: p.required === true || Array.isArray(p.validation) && p.validation.some(v => v.type === 'required'),
    maxCount: Math.min(9, Number(p.limit)),
    maxBytes: Math.min(20, Number(p.maxFileSize)) * 1024 * 1024,
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
function inputData(options) {
  check(options.input && path.isAbsolute(options.input), 'INPUT_FILE_REQUIRED');
  const raw = read(options.input);
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'INPUT_OBJECT_REQUIRED');
  const input = {
    ...raw
  };
  const files = input.attachments ?? [];
  delete input.attachments;
  check(Array.isArray(files) && files.every(file => typeof file === 'string' && path.isAbsolute(file)), 'ATTACHMENT_INPUT_INVALID');
  return {
    input,
    files
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
async function run(args, deps = {}) {
  const {
      command,
      arg,
      options
    } = parse(args),
    auth = deps.auth || require('./lib/auth.cjs'),
    runtime = deps.runtime || createRuntime,
    root = deps.root || dataRoot();
  if (command === 'workflows') return {
    workflows: Object.values(registry).map(w => ({
      key: w.key,
      title: w.title
    })),
    scope: '仅这四个固定流程；不检索其他流程。'
  };
  if (command === 'requirements') {
    const w = workflow(arg);
    return {
      workflow: w.key,
      title: w.title,
      requirements: w.requirements,
      attachments: {
        required: arg === 'external_expense_request',
        supported: arg !== 'annual_leave',
        format: '绝对路径数组，顶层 attachments',
        maximumCount: 9,
        maximumMiB: 20
      }
    };
  }
  if (command === 'status' || command === 'login' || command === 'logout') return auth[command]();
  if (command === 'doctor') return {
    version: VERSION,
    node: process.versions.node,
    platform: process.platform,
    identity: (await auth.status()).status,
    scope: 'four-fixed-workflows',
    diagnostics: '如需支持，仅提供时间、命令名、错误码和草稿编号。'
  };
  check((await auth.status()).status === 'ready', 'OPENYIDA_LOGIN_REQUIRED');
  if (command === 'prepare') {
    const w = workflow(arg);
    const rt = runtime(arg, {
        auth
      }),
      actor = rt.actor();
    let id = options.draft;
    let initialData;
    if (!id) {
      initialData = inputData(options);
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
        const {
          input,
          files
        } = initialData || inputData(options);
        const identity = intentIdentity(arg, actor, {
          input,
          files
        });
        check(claimIntent(intentPath(root, identity), id) === id, 'DRAFT_INTENT_ALREADY_BOUND');
        write(infoFile, {
          version: VERSION,
          workflow: arg,
          actor: {
            userid: actor.userid,
            corp_id: actor.corp_id
          },
          input,
          files,
          identity,
          revisionId
        });
        const prepared = json(await w.prepare(input, rt.ctx));
        rt.actor();
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
        const schema = await rt.ctx.schema(),
          rules = attachmentRules(schema, prepared.attachmentField);
        checkFiles(files, rules);
        if (rules?.required && !files.length) {
          write(revisionFile, {
            ...pending,
            code: 'PREPARATION_NEEDS_INPUT'
          });
          return {
            status: 'needs_input',
            draftId: id,
            needsInput: [{
              field: 'attachments',
              message: '这个流程要求附件，请提供需要随申请提交的本地文件。'
            }]
          };
        }
        const uploaded = [];
        if (files.length) {
          const uploader = createNativeAttachmentUploader({
            tenantClient: rt.tenant,
            tenantOrigin: TENANT,
            appType: APP,
            formUuid: w.formUuid,
            stateDir: path.join(dir, 'attachments'),
            actor: rt.actor(),
            maxBytes: rules.maxBytes
          });
          for (const file of files) {
            rt.actor();
            const up = await uploader.upload({
              filePath: file,
              ...fileAttempt(file)
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
            check(!uploaded.some(x => x.reference.fileUuid === up.reference.fileUuid), 'ATTACHMENT_DUPLICATE_CONTENT');
            uploaded.push(up);
          }
        }
        // Freeze an empty selection too, so readback detects unexpected attachments.
        if (prepared.attachmentField) prepared.formData[prepared.attachmentField] = uploaded.map(x => x.reference);
        const attachmentSummary = uploaded.map(x => ({
          name: x.reference.name,
          size: x.reference.size,
          sha256: x.sha256
        }));
        const preview = {
          流程: w.title,
          ...prepared.preview,
          ...(prepared.attachmentField ? {
            附件: attachmentSummary.map(x => ({
              名称: x.name,
              字节数: x.size
            }))
          } : {})
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
          businessDigest: digest({
            formData: json({
              ...prepared.formData,
              ...(prepared.attachmentField ? {
                [prepared.attachmentField]: null
              } : {})
            }),
            departmentId: String(prepared.departmentId)
          }),
          attachmentField: prepared.attachmentField || null,
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
    const info = read(path.join(dir, 'input.json')),
      w = workflow(info.workflow),
      rt = runtime(info.workflow, {
        auth
      });
    check(sameActor(info.actor, rt.actor()), 'DRAFT_IDENTITY_MISMATCH');
    const pm = manager(rt, w, dir);
    const revisionFile = path.join(dir, 'revision.json');
    const revision = fs.existsSync(revisionFile) ? read(revisionFile) : null;
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
        const fresh = json(await w.prepare(info.input, rt.ctx));
        check(!fresh.needsInput?.length && fresh.formData && fresh.departmentId, 'BUSINESS_FACTS_CHANGED_REPREPARE');
        const af = saved.attachmentField;
        const freshDigest = digest({
          formData: json({
            ...fresh.formData,
            ...(af ? {
              [af]: null
            } : {})
          }),
          departmentId: String(fresh.departmentId)
        });
        check(freshDigest === saved.businessDigest && fresh.attachmentField === af || freshDigest === saved.businessDigest && !fresh.attachmentField && !af, 'BUSINESS_FACTS_CHANGED_REPREPARE');
        const rules = attachmentRules(await rt.ctx.schema(), af);
        check(!rules?.required || saved.attachments.length > 0, 'BUSINESS_FACTS_CHANGED_REPREPARE');
        check(!rules || saved.attachments.length <= rules.maxCount && saved.attachments.every(x => x.size <= rules.maxBytes), 'BUSINESS_FACTS_CHANGED_REPREPARE');
        for (const item of saved.attachments) {
          const ref = (state.snapshot.formData[af] || []).find(x => x.name === item.name && Number(x.size) === Number(item.size));
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
          failedChecks: Object.entries(verification.checks).filter(([, v]) => !v).map(([k]) => k),
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
      ...supportForError(safeCode(e))
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
