'use strict';

// Shared asset-workflow composition. Fixed departments, field targets and
// sources are supplied by each workflow config; transport stays in runtime.
const C = require('./leave-trip-common.cjs');
const sources = require('../config/sources.json');
const Decimal = require('../shared/decimal-arithmetic.cjs');

function textInput(input, key, fields, fieldId) {
  if (C.absent(input[key])) return '';
  const value = C.text(input[key], 'ASSET_TEXT_INVALID');
  const maximum = Number(fields.get(fieldId)?.props?.maxLength);
  C.check((!Number.isFinite(maximum) || maximum <= 0 || value.length <= maximum)
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value),
  'ASSET_TEXT_INVALID', '输入文字超出表单限制或含无效字符，请调整。');
  return value;
}

function numberInput(value) {
  C.check(typeof value === 'number' || typeof value === 'string'
    && /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()), 'ASSET_NUMBER_INVALID', '请填写有效数值。');
  try { return Decimal.number(Decimal.decimal(value)); }
  catch { C.fail('ASSET_NUMBER_INVALID','数值无效或超出可准确表示的范围，请核对。'); }
}

function optionalRosterValue(roster, code) {
  const entries = roster.get(code);
  if (!entries?.length) return '';
  const value = !C.absent(entries[0].value) ? entries[0].value : entries[0].label;
  return C.absent(value) ? '' : C.single(value, 'ASSET_PROFILE_INVALID');
}

function requiredInput(fields, mapping, input) {
  return Object.entries(mapping).filter(([key,id]) => C.required(fields,id) && C.absent(input[key]))
    .map(([field]) => ({field,message:'请补充表单要求的 '+field+'。'}));
}

async function prepareContext(config, ctx) {
  const F=config.fields, fields=C.assertFields(await ctx.schema(),F), actor=C.identity(ctx);
  const roster=C.rosterFields(await ctx.roster(config.policy.rosterFields),actor);
  const departmentId=C.department(roster).id;
  const name=optionalRosterValue(roster,sources.rosterFields.name) || actor.name || actor.userid;
  const office=optionalRosterValue(roster,sources.rosterFields.office);
  const source=sources[config.sources.office];
  const it=office ? await C.contacts(ctx,{form:source.formUuid,key:source.officeField,admin:source.itField},office)
    : {ids:[],names:[]};
  const role=await ctx.departmentRole(config.managerRole);
  let manager=[];
  if (role) {
    const roleRoster=C.rosterFields(role.roster,{userid:role.userId,corp_id:actor.corp_id});
    if (optionalRosterValue(roleRoster,sources.rosterFields.name)) manager=[role.userId];
  }
  for (const [id,values] of [[F.it,it.ids],[F.manager,manager]]) {
    C.check(values.length || !C.required(fields,id), 'ASSET_REQUIRED_CONTACT_MISSING',
      '当前表单要求的 IT 联系人未能取得，请联系 IT 核查。');
  }
  const formData={
    [F.applicant]:[actor.userid],[F.department]:[departmentId],[F.applicationDate]:ctx.todayMs,
    [F.applicantId]:actor.userid,[F.it]:it.ids,[F.manager]:manager
  };
  if (office) formData[F.office]=office;
  return {fields,formData,departmentId,name,
    verification:{optionalEmptyFields:[...(!it.ids.length?[F.it]:[]),...(!manager.length?[F.manager]:[])]}};
}

module.exports={prepareContext,textInput,numberInput,requiredInput};
