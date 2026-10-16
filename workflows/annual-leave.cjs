'use strict';
const C = require('./leave-trip-common.cjs');

const key = 'annual_leave';
const title = '年假申请';
const formUuid = 'FORM-E0E2F1E273B7400F8CDEC9EF505B960EGPYE';
const F = Object.freeze({applicant:'employeeField_m0m0xxmy', applicantId:'textField_m0n7mvdm', application:'dateField_m0m0xxn4', start:'dateField_m0m0xxne', startPeriod:'selectField_m0m0xxnf', end:'dateField_m0m0xxnh', endPeriod:'selectField_m0m0xxng', reason:'textField_m984jxqu', year:'textField_m0vv112d', remaining:'numberField_m3x6ohmv', days:'numberField_m0m0xxnr', validUntil:'dateField_m3x6ohmx', contract:'numberField_m0m0xxnp', adjustment:'numberField_m3x6ohmt', carryover:'numberField_m3x6ohmu', workdays:'numberField_m0m0xxnz', officeAdmin:'employeeField_m0m0xxo4', company:'textField_m0m0xxo0', attendanceAdmin:'employeeField_m0m0xxo5', status:'textField_m0m0xxoa', attendanceEnd:'dateField_mmbngbt3', group:'textField_m0m0xxo1', availableFrom:'dateField_m3x6ohms', office:'textField_m0m0xxo3', calendarAdjustment:'numberField_m0m0xxo7'});
const B = Object.freeze({form:'FORM-40A7D242ECEA4E07AA6C1A94BA6904D6AOQC', userid:'textField_m0n7wtlr', year:'selectField_m0lvidyi', remaining:'numberField_m0lvidyn', contract:'numberField_m0lvidyl', adjustment:'numberField_m0lvidyo', carryover:'numberField_m3wuh1ee', availableFrom:'dateField_m0vssxiv', validUntil:'dateField_m0lvidyp'});
const CAL = Object.freeze({form:'FORM-3F61EBF8217141A78D2D48342E7B1A19XNH0', group:'selectField_m0ls2e74', date:'dateField_m0ls2e75', kind:'selectField_m0ls2e76'});
const policy = Object.freeze({
  dataForms: [C.OFFICE.form, C.COMPANY.form, B.form, CAL.form],
  rosterFields: [C.ROSTER.name, C.ROSTER.company, C.ROSTER.status, C.ROSTER.group, C.ROSTER.office, C.ROSTER.main, C.ROSTER.departments],
  connectors: {roster: C.ROSTER_CONNECTOR}
});
const requirements = Object.freeze({
  required: [
    {field:'start_date', label:'开始日期', type:'date', format:'YYYY-MM-DD'},
    {field:'start_period', label:'开始时段', choices:['上午','下午']},
    {field:'end_date', label:'结束日期', type:'date', format:'YYYY-MM-DD'},
    {field:'end_period', label:'结束时段', choices:['上午','下午']},
    {field:'reason', label:'请假事由', type:'text'}
  ],
  optional: [{field:'department_id', label:'发起部门', source:'只能选本人任职部门；默认主部门'}],
  notes: ['余额、工作日、节假日调休、身份和管理员信息由脚本查询。', '预览后须本人确认；跨日须重新准备。']
});
const INPUTS = ['start_date','start_period','end_date','end_period','reason','department_id'];

function weekdayCount(start, end) {
  const inclusive = (end - start) / C.DAY + 1;
  let days = Math.floor(inclusive / 7) * 5;
  for (let i = 0; i < inclusive % 7; i++) {
    const weekday = C.dayOfWeek(start + i * C.DAY);
    if (weekday !== 0 && weekday !== 6) days++;
  }
  return days;
}

async function balance(ctx, year) {
  const names = Object.keys(B).filter(k => k !== 'form');
  const rows = await ctx.query(B.form, {[B.userid]: ctx.actor.userid, [B.year]: year}, names.map(k => B[k]));
  C.check(Array.isArray(rows) && rows.length === 1, 'ANNUAL_BALANCE_NOT_UNIQUE', '未找到唯一的本人年度年假余额，请联系 HR。');
  const row = rows[0];
  C.check(C.exact(row[B.userid], ctx.actor.userid) && C.exact(row[B.year], year), 'ANNUAL_BALANCE_IDENTITY_MISMATCH', '年假余额不属于当前账号和申请年份。');
  const result = {};
  for (const field of ['remaining','contract','adjustment','carryover']) result[field] = C.number(row[B[field]], {nonnegative: field !== 'adjustment', code:'ANNUAL_BALANCE_INVALID'});
  result.validUntil = C.sourceDate(row[B.validUntil], 'ANNUAL_BALANCE_INVALID');
  if (!C.absent(row[B.availableFrom]) && !(Array.isArray(row[B.availableFrom]) && !row[B.availableFrom].length)) result.availableFrom = C.sourceDate(row[B.availableFrom], 'ANNUAL_BALANCE_INVALID');
  return result;
}

async function calendar(ctx, group, start, end) {
  const rows = await ctx.query(CAL.form, {[CAL.group]:group, [CAL.date]:[start,end]}, [CAL.group,CAL.date,CAL.kind]);
  C.check(Array.isArray(rows), 'WORK_CALENDAR_INVALID');
  let sum = 0;
  const adjustments = [];
  for (const row of rows) {
    C.check(C.exact(row[CAL.group], group), 'WORK_CALENDAR_SCOPE_MISMATCH');
    const day = C.sourceDate(row[CAL.date], 'WORK_CALENDAR_INVALID');
    C.check(day >= start && day <= end, 'WORK_CALENDAR_SCOPE_MISMATCH');
    const kinds = C.values(row[CAL.kind]);
    const rest = kinds.some(x => ['休息日','1','+1'].includes(x));
    const makeup = kinds.some(x => ['调配工作日','調配工作日','-1'].includes(x));
    C.check(rest !== makeup, 'WORK_CALENDAR_KIND_INVALID', '节假日调整数据无效，请联系 HR。');
    const value = rest ? 1 : -1;
    sum += value;
    adjustments.push({date:C.dateText(day), kind:rest ? '休息日' : '调配工作日', adjustment:value});
  }
  return {sum, adjustments};
}

async function prepare(input, ctx) {
  C.inputKeys(input, INPUTS);
  const needsInput = requirements.required.filter(row => C.absent(input[row.field])).map(row => ({field:row.field,message:`请补充${row.label}。`,...(row.choices ? {choices:row.choices} : {})}));
  if (needsInput.length) return {needsInput};
  const actor = C.identity(ctx);
  const {start,end} = C.inputRange(input);
  const startPeriod = C.text(input.start_period, 'INPUT_PERIOD_INVALID'), endPeriod = C.text(input.end_period, 'INPUT_PERIOD_INVALID');
  C.check(['上午','下午'].includes(startPeriod) && ['上午','下午'].includes(endPeriod), 'INPUT_PERIOD_INVALID', '请选择上午或下午。');
  C.check(!(start === end && startPeriod === '下午' && endPeriod === '上午'), 'PERIOD_RANGE_INVALID', '结束时段不能早于开始时段。');
  const reason = C.text(input.reason, 'REASON_INVALID');
  const schema = C.assertFields(await ctx.schema(), F);
  C.option(schema, F.startPeriod, startPeriod, ['上午','下午']);
  C.option(schema, F.endPeriod, endPeriod, ['上午','下午']);
  const roster = C.rosterFields(await ctx.roster(policy.rosterFields), actor);
  const name = C.rosterValue(roster, C.ROSTER.name, 'value'), office = C.rosterValue(roster, C.ROSTER.office, 'value');
  const company = C.rosterValue(roster, C.ROSTER.company, 'value'), group = C.rosterValue(roster, C.ROSTER.group);
  const status = C.rosterValue(roster, C.ROSTER.status);
  const dep = C.department(roster, input.department_id);
  const officeAdmin = await C.contacts(ctx, C.OFFICE, office, {required:C.required(schema,F.officeAdmin)});
  const attendanceAdmin = await C.contacts(ctx, C.COMPANY, company, {required:C.required(schema,F.attendanceAdmin)});
  const year = input.start_date.slice(0,4);
  const quota = await balance(ctx, year);
  const calendarResult = await calendar(ctx, group, start, end);
  // Match the page JS + native formula exactly: the workday field is an
  // integer before half-day deductions. Keep deductions out of that field
  // so Yida formula recalculation cannot deduct them a second time.
  const workdays = weekdayCount(start,end);
  const days = workdays - calendarResult.sum - (startPeriod === '下午' ? 0.5 : 0) - (endPeriod === '上午' ? 0.5 : 0);
  C.check(days > 0, 'NONPOSITIVE_LEAVE', '本次请假天数必须大于零，请检查日期与时段。');
  C.check(days <= quota.remaining, 'INSUFFICIENT_BALANCE', '本次请假天数超过剩余年假，请调整申请或咨询 HR。');
  const formData = {
    [F.applicant]:[actor.userid], [F.applicantId]:actor.userid, [F.application]:ctx.todayMs,
    [F.start]:start, [F.startPeriod]:startPeriod, [F.end]:end, [F.endPeriod]:endPeriod, [F.reason]:reason,
    [F.year]:year, [F.remaining]:quota.remaining, [F.days]:days, [F.validUntil]:quota.validUntil,
    [F.contract]:quota.contract, [F.adjustment]:quota.adjustment, [F.carryover]:quota.carryover,
    [F.workdays]:workdays, [F.officeAdmin]:officeAdmin.ids, [F.company]:company,
    [F.attendanceAdmin]:attendanceAdmin.ids, [F.status]:status,
    [F.attendanceEnd]:end + (endPeriod === '下午' ? 23 : 11) * 3600000,
    [F.group]:group, [F.office]:office, [F.calendarAdjustment]:calendarResult.sum
  };
  if (quota.availableFrom !== undefined) formData[F.availableFrom] = quota.availableFrom;
  return {
    formData, departmentId:dep.id,
    preview:{流程:title, 申请人:name, 申请日期:ctx.today, 开始:`${input.start_date} ${startPeriod}`, 结束:`${input.end_date} ${endPeriod}`, 请假事由:reason,
      请假天数:days, 剩余年假:quota.remaining, 年假年份:year, 年假有效期:C.dateText(quota.validUntil),
      工作日基础天数:workdays, 调整天数:calendarResult.sum, 日历调整:calendarResult.adjustments,
      发起部门:dep.id, 其他任职部门:dep.alternatives, 默认主部门:dep.defaulted,
      签约公司:company, 办公场所:office, 假勤组:group, 员工状态:status, 办公室行政:officeAdmin.names, 考勤管理员:attendanceAdmin.names,
      提示:[...(!officeAdmin.ids.length ? ['办公室行政未匹配到配置，按原流程保留为空。'] : []),...(!attendanceAdmin.ids.length ? ['考勤管理员未匹配到配置，按原流程保留为空。'] : [])]},
    resolvedInputs:{...input, reason, start_period:startPeriod, end_period:endPeriod, department_id:dep.id}
  };
}
module.exports = {key,title,formUuid,policy,requirements,prepare};
