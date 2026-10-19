'use strict';

const C = require('../leave-trip-common.cjs');
const config = require('../../config/workflows/business/contract.json');
const sources = require('../../config/sources.json');

const {key, title, target, fields: F, options, policy: policyConfig} = config;
const formUuid = target.formUuid;
const attachmentField = config.attachments.field;
const companySource = sources.companyDirectory;
const rateSource = sources.exchangeRates;
const policy = Object.freeze({
  dataForms: [...policyConfig.dataForms], rosterFields: [...policyConfig.rosterFields], connectors: {}
});
const requirements = Object.freeze({
  required: [],
  optional: [
    {field:'contract_name', label:'合同名称', type:'text'},
    {field:'contract_number', label:'合同编号', type:'text'},
    {field:'company', label:'我方合同公司', source:'公司目录候选'},
    {field:'contract_type', label:'合同类型', choices:options.contractTypes},
    {field:'content', label:'合同主要内容', type:'text'},
    {field:'counterparty', label:'对方单位', type:'text'},
    {field:'contract_amount', label:'合同总价', type:'number'},
    {field:'currency', label:'原币种', source:'公司汇率表候选'},
    {field:'payment_terms', label:'付款条件', type:'text'},
    {field:'remarks', label:'备注', type:'text'}
  ],
  attachments: {required:true, field:'合同正文', maximumCount:9, maximumMiB:20},
  notes:['公司和币种使用固定目录；静态占位选项不作为候选。','港币汇率和港币总价按原表联动公式计算。','盖章后扫描件属于后续节点，本次发起不处理。']
});
const INPUTS = ['contract_name','contract_number','company','contract_type','content','counterparty','contract_amount','currency','payment_terms','remarks'];

function textValue(input, field) {
  return C.absent(input[field]) ? '' : C.text(input[field], 'CONTRACT_INPUT_INVALID');
}
function directoryValues(rows, field) {
  const byKey = new Map();
  for (const row of rows) {
    if (C.absent(row[field])) continue;
    for (const value of C.values(row[field])) {
      const name = value.trim();
      if (name && !byKey.has(C.normalized(name))) byKey.set(C.normalized(name), name);
    }
  }
  return [...byKey.values()];
}
function uniqueChoice(value, choices, field) {
  const match = choices.find(choice => C.normalized(choice) === C.normalized(value));
  return match || null;
}
function rosterText(map, field) {
  try { return C.rosterValue(map, field, 'value'); } catch { return ''; }
}

async function prepare(input, ctx) {
  C.inputKeys(input, INPUTS);
  const schema = C.assertFields(await ctx.schema(), F);
  const actor = C.identity(ctx);
  const roster = C.rosterFields(await ctx.roster(policy.rosterFields), actor);
  const departmentId = rosterText(roster, C.ROSTER.main);
  C.check(/^\d+$/.test(departmentId), 'CONTRACT_ORIGINATOR_DEPARTMENT_UNAVAILABLE', '当前账号主部门资料暂不可用，请联系 IT 核查。');
  const applicantName = rosterText(roster, C.ROSTER.name) || actor.userid;

  const contractName = textValue(input, 'contract_name');
  const contractNumber = textValue(input, 'contract_number');
  const contractType = textValue(input, 'contract_type');
  if (contractType) C.option(schema, F.type, contractType, options.contractTypes);
  const content = textValue(input, 'content');
  const counterparty = textValue(input, 'counterparty');
  const paymentTerms = textValue(input, 'payment_terms');
  const remarks = textValue(input, 'remarks');

  let company = '';
  if (!C.absent(input.company)) {
    const rows = await ctx.query(companySource.formUuid, null, [companySource.companyField]);
    const choices = directoryValues(rows, companySource.companyField);
    C.check(choices.length > 0, 'CONTRACT_COMPANY_DIRECTORY_EMPTY', '公司目录暂时没有可用候选，请联系 Finance。');
    company = uniqueChoice(C.text(input.company, 'CONTRACT_COMPANY_INVALID'), choices);
    if (!company) return {needsInput:[{field:'company', message:'请选择公司目录中的我方合同公司。', choices}]};
  }

  let currency = '', rate = null, amountHkd = null;
  if (!C.absent(input.currency)) {
    const rows = await ctx.query(rateSource.formUuid, null,
      [rateSource.currencyField, rateSource.targetCurrencyField, rateSource.rateField]);
    const choices = directoryValues(rows.filter(row => C.exact(row[rateSource.targetCurrencyField], rateSource.targetCurrency)), rateSource.currencyField);
    C.check(choices.length > 0, 'CONTRACT_CURRENCY_DIRECTORY_EMPTY', '币种目录暂时没有可用候选，请联系 Finance。');
    currency = uniqueChoice(C.text(input.currency, 'CONTRACT_CURRENCY_INVALID'), choices);
    if (!currency) return {needsInput:[{field:'currency', message:'请选择公司汇率表中的原币种。', choices}]};
    const matches = await ctx.query(rateSource.formUuid, {
      [rateSource.currencyField]:currency,
      [rateSource.targetCurrencyField]:rateSource.targetCurrency
    }, [rateSource.currencyField, rateSource.targetCurrencyField, rateSource.rateField]);
    const exactRows = matches.filter(row => C.exact(row[rateSource.currencyField], currency)
      && C.exact(row[rateSource.targetCurrencyField], rateSource.targetCurrency));
    const rates = [...new Set(exactRows.map(row => C.number(row[rateSource.rateField], {code:'CONTRACT_RATE_INVALID'})))];
    C.check(rates.length === 1 && rates[0] > 0, rates.length ? 'CONTRACT_RATE_AMBIGUOUS' : 'CONTRACT_RATE_NOT_FOUND', '该币种的兑港币汇率未能唯一核实，请联系 Finance。');
    rate = rates[0];
    if (!C.absent(input.contract_amount)) {
      const amount = C.number(input.contract_amount, {code:'CONTRACT_AMOUNT_INVALID'});
      amountHkd = amount * rate;
      C.check(Number.isFinite(amountHkd), 'CONTRACT_AMOUNT_INVALID');
    }
  } else if (!C.absent(input.contract_amount)) {
    C.number(input.contract_amount, {code:'CONTRACT_AMOUNT_INVALID'});
  }

  const formData = {
    [F.applicant]:[actor.userid],
    [F.department]:[departmentId],
    [F.applicationDate]:ctx.todayMs
  };
  if (contractName) formData[F.name] = contractName;
  if (contractNumber) formData[F.number] = contractNumber;
  if (company) formData[F.company] = company;
  if (contractType) formData[F.type] = contractType;
  if (content) formData[F.content] = content;
  if (counterparty) formData[F.counterparty] = counterparty;
  if (!C.absent(input.contract_amount)) formData[F.amount] = C.number(input.contract_amount, {code:'CONTRACT_AMOUNT_INVALID'});
  if (currency) {
    formData[F.currency] = currency;
    formData[F.targetCurrency] = rateSource.targetCurrency;
    formData[F.rate] = rate;
    if (amountHkd !== null) formData[F.amountHkd] = amountHkd;
  }
  if (paymentTerms) formData[F.paymentTerms] = paymentTerms;
  if (remarks) formData[F.remarks] = remarks;

  return {
    formData, departmentId, attachmentField, attachmentPreviewField:'合同正文',
    preview:{流程:title, 申请人:applicantName, 申请日期:ctx.today, 合同名称:contractName,
      合同编号:contractNumber, 我方合同公司:company, 合同类型:contractType, 合同正文:'待选择',
      合同主要内容:content, 对方单位:counterparty,
      合同总价:C.absent(input.contract_amount) ? '' : Number(input.contract_amount), 原币种:currency,
      兑港币汇率:rate ?? '', 港币总价:amountHkd ?? '', 付款条件:paymentTerms, 备注:remarks},
    verification:{},
    resolvedInputs:{...input,...(company?{company}:{}),...(currency?{currency}:{})}
  };
}

module.exports = {key,title,formUuid,attachmentField,policy,requirements,prepare};
