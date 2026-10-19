'use strict';

// Fixed workflow composition. Calendar arithmetic and association projection
// are shared tools; source/field bindings and business choices are configuration.
const C = require('./leave-trip-common.cjs');
const Calendar = require('../shared/leave-calendar.cjs');
const Association = require('../shared/process-association.cjs');
const {retainedWorkflow} = require('./hr-common.cjs');
const sources = require('../config/sources.json');
const company = require('../config/company.json');
const PERIODS = ['上午','下午'];
const DATE_INPUTS = [
  {field:'start_date',label:'开始日期',type:'date',format:'YYYY-MM-DD'},
  {field:'start_period',label:'开始时段',choices:PERIODS},
  {field:'end_date',label:'结束日期',type:'date',format:'YYYY-MM-DD'},
  {field:'end_period',label:'结束时段',choices:PERIODS}
];

function optionalRoster(map, field) {
  const entries = map.get(field);
  if (!entries?.length || entries.every(row => C.absent(row.value) && C.absent(row.label))) return '';
  return C.rosterValue(map, field);
}
function missing(items,input) {
  return items.filter(row => C.absent(input[row.field])).map(row => ({field:row.field,
    message:`请补充${row.label}。`,...(row.choices ? {choices:row.choices} : {})}));
}
function sourceDay(value) { return C.date(C.dateText(C.sourceDate(value, 'RELATED_LEAVE_DATE_INVALID'))); }
function period(value) {
  const result = C.single(value,'RELATED_LEAVE_PERIOD_INVALID');
  C.check(PERIODS.includes(result),'RELATED_LEAVE_PERIOD_INVALID');
  return result;
}
function slot(day, part) { return day / C.DAY * 2 + (part === '下午' ? 1 : 0); }

function createLeaveWorkflow(config) {
  const {key,title,target,fields:F,policy,rules} = config;
  const cancellation = rules.kind === 'cancellation';
  const requirements = {
    required:[...DATE_INPUTS,
      ...(cancellation ? [{field:'leave_instance_id',label:'原请假单',source:'从本人已结束且审批通过的原请假单中选择'}] : []),
      ...(F.leaveType ? [{field:'leave_type',label:'假期类型',choices:config.options.leaveTypes.map(x=>x.trim())}] : []),
      ...(rules.reasonRequired ? [{field:'reason',label:cancellation?'销假事由':'请假事由',type:'text'}] : [])],
    optional:[...(!rules.reasonRequired ? [{field:'reason',label:cancellation?'销假事由':'请假事由',type:'text'}] : []),
      {field:'department_id',label:'发起部门',source:'本人任职部门；默认主部门'}],
    attachments:F.attachment ? {supported:true,required:rules.attachmentRequired === true,
      maximumCount:config.attachments.maximumCount,maximumMiB:config.attachments.maximumMiB,
      ...(rules.proofAtDays ? {requiredWhen:'请假达到1天，或本人同一开始日期已有病假记录'} : {})} : {supported:false,required:false},
    notes:[rules.dayMode==='calendar' ? '按含首尾的自然日及上午/下午计算，不扣周末和节假日。' : '按工作日、公司假勤日历及上午/下午计算。',
      ...(cancellation ? ['销假为新申请，不是直接撤回原单；范围不能超过所选原假期。'] : []),
      '正常隐藏资料自动填写；最终预览后等待本人新一条明确确认。']
  };
  const inputFields=[...DATE_INPUTS.map(r=>r.field),'reason','department_id',
    ...(cancellation?['leave_instance_id']:[]),...(F.leaveType?['leave_type']:[])];

  async function quota(ctx,year) {
    const source=sources[config.sources.balance], values=rules.balanceValues;
    const columns=[source.userid,source.year,...values.map(name=>source[name])];
    const rows=await ctx.query(source.formUuid,{[source.userid]:ctx.actor.userid,[source.year]:year},columns);
    C.check(Array.isArray(rows)&&rows.length===1,'LEAVE_BALANCE_NOT_UNIQUE','未找到唯一的本人年度假期资料，请联系 HR。');
    const row=rows[0];
    C.check(C.exact(row[source.userid],ctx.actor.userid)&&C.exact(row[source.year],year),
      'LEAVE_BALANCE_IDENTITY_MISMATCH','假期资料与本人或申请年份不符，请联系 HR。');
    const result={};
    for(const name of values) {
      const raw=row[source[name]];
      if(name==='availableFrom'&&(C.absent(raw)||Array.isArray(raw)&&!raw.length)) continue;
      result[name]=['availableFrom','validUntil'].includes(name)?C.sourceDate(raw,'LEAVE_BALANCE_INVALID')
        :C.number(raw,{nonnegative:name!=='adjustment',code:'LEAVE_BALANCE_INVALID'});
    }
    return result;
  }

  async function originalLeave(ctx,input,actor) {
    const source=policy.relatedSources.leave;
    const candidates=Association.validateCandidates(await ctx.related('leave'),{
      appType:company.appType,formUuid:source.form,actorId:actor.userid,corpId:actor.corp_id,
      ...Association.sourceConstraints(source)});
    C.check(candidates.length>0,'RELATED_LEAVE_NOT_FOUND','没有找到本人已结束且审批通过的原请假单，请核对原申请或联系 HR。');
    if(C.absent(input.leave_instance_id)) return {needsInput:[{field:'leave_instance_id',message:'请选择要销假的原请假单。',
      choices:candidates.map(row=>({value:row.instance_id,label:row.title+(row.sub_title?` · ${row.sub_title}`:'')}))}]};
    const selected=candidates.find(row=>row.instance_id===input.leave_instance_id);
    C.check(selected,'RELATED_LEAVE_SELECTION_CHANGED','所选原请假单已不在可办理范围，请重新选择。');
    const data=selected.data;
    C.check(C.object(data),'RELATED_LEAVE_DATA_MISSING');
    const refFields=config.relatedFields;
    const start=sourceDay(data[refFields.start]),end=sourceDay(data[refFields.end]);
    const startPeriod=period(data[refFields.startPeriod]),endPeriod=period(data[refFields.endPeriod]);
    C.check(slot(start,startPeriod)<=slot(end,endPeriod),'RELATED_LEAVE_DATE_INVALID');
    const days=C.number(data[refFields.days],{nonnegative:true,code:'RELATED_LEAVE_DAYS_INVALID'});
    C.check(days>0,'RELATED_LEAVE_DAYS_INVALID');
    const year=C.single(data[refFields.year],'RELATED_LEAVE_YEAR_INVALID');
    C.check(/^\d{4}$/.test(year),'RELATED_LEAVE_YEAR_INVALID');
    const serial=C.single(data[refFields.serial],'RELATED_LEAVE_SERIAL_INVALID');
    return {selected,start,end,startPeriod,endPeriod,days,year,serial};
  }

  async function sameStartHistory(ctx,actor,start) {
    const source=config.history;
    const rows=await ctx.query(source.formUuid,{[source.applicant]:actor.userid,
      [source.start]:[start,start+C.DAY-1]},[source.applicant,source.applicant+'_id',source.start]);
    C.check(Array.isArray(rows),'SICK_HISTORY_INVALID');
    for(const row of rows) {
      const ids=Association.applicantIds(row,source.applicant);
      C.check(ids.length===1&&ids[0]===actor.userid,'SICK_HISTORY_IDENTITY_MISMATCH');
      const day=sourceDay(row[source.start]);
      C.check(day===start,'SICK_HISTORY_DATE_MISMATCH');
    }
    return rows.length>0;
  }

  async function prepare(input,ctx) {
    C.inputKeys(input,inputFields);
    const basic=missing(requirements.required.filter(row=>row.field!=='leave_instance_id'),input);
    if(basic.length)return {needsInput:basic};
    const actor=C.identity(ctx),{start,end}=C.inputRange(input);
    const startPeriod=C.text(input.start_period,'INPUT_PERIOD_INVALID'),endPeriod=C.text(input.end_period,'INPUT_PERIOD_INVALID');
    C.check(PERIODS.includes(startPeriod)&&PERIODS.includes(endPeriod),'INPUT_PERIOD_INVALID');
    C.check(slot(start,startPeriod)<=slot(end,endPeriod),'PERIOD_RANGE_INVALID','结束时段不能早于开始时段。');
    const schema=C.assertFields(await ctx.schema(),F);
    for(const [field,formula]of Object.entries(rules.formulas))
      C.check(schema.get(field)?.props.formula===formula,'WORKFLOW_SCHEMA_CHANGED');
    C.option(schema,F.startPeriod,startPeriod,PERIODS);C.option(schema,F.endPeriod,endPeriod,PERIODS);
    const reason=C.optionalText(input.reason,'LEAVE_REASON_INVALID');
    C.check(!rules.reasonMaxLength||reason.length<=rules.reasonMaxLength,'LEAVE_REASON_TOO_LONG');
    C.check(reason||!C.required(schema,F.reason),'LEAVE_REASON_REQUIRED');
    let leaveType;
    if(F.leaveType) {
      const matches=config.options.leaveTypes.filter(value=>C.normalized(value)===C.normalized(input.leave_type));
      C.check(matches.length===1,'INPUT_OPTION_INVALID');leaveType=matches[0];
      C.option(schema,F.leaveType,leaveType,config.options.leaveTypes);
    }
    const roster=C.rosterFields(await ctx.roster(policy.rosterFields),actor);
    const name=C.rosterValue(roster,C.ROSTER.name,'value'),office=C.rosterValue(roster,C.ROSTER.office,'value');
    const contractCompany=C.rosterValue(roster,C.ROSTER.company,'value'),group=C.rosterValue(roster,C.ROSTER.group);
    const status=optionalRoster(roster,C.ROSTER.status),department=C.department(roster,input.department_id);
    C.check(status||!C.required(schema,F.status),'ROSTER_FIELD_MISSING','办理所需的任职资料缺失，请联系 HR。');
    let original;
    if(cancellation) {original=await originalLeave(ctx,input,actor);if(original.needsInput)return original;
      C.check(slot(start,startPeriod)>=slot(original.start,original.startPeriod)
        &&slot(end,endPeriod)<=slot(original.end,original.endPeriod),
      'CANCELLATION_OUTSIDE_ORIGINAL','销假日期和时段不能超出原请假范围。');}
    const officeSource=sources[config.sources.office],companySource=sources[config.sources.company];
    const admin=await C.contacts(ctx,{form:officeSource.formUuid,key:officeSource.officeField,admin:officeSource.administratorsField},office,{required:C.required(schema,F.officeAdmin)});
    const attendance=await C.contacts(ctx,{form:companySource.formUuid,key:companySource.companyField,admin:companySource.annualLeaveAdministratorField},contractCompany,{required:C.required(schema,F.attendanceAdmin)});
    const yearCalendar=C.dateText(start).slice(0,4),yearHK=C.dateText(start-90*C.DAY).slice(0,4);
    const year=original?.year ?? (rules.yearMode==='company'&&!rules.calendarYearCompanies.includes(contractCompany)?yearHK:yearCalendar);
    const balance=config.sources.balance?await quota(ctx,year):{};
    let adjustment=0;
    if(rules.dayMode==='workdays') {
      const calendar=sources[config.sources.calendar];
      adjustment=(await Calendar.queryCalendar(ctx,{form:calendar.formUuid,group:calendar.group,date:calendar.date,kind:calendar.kind},group,start,end)).sum;
    }
    const computed=Calendar.calculateLeave({start,end,startPeriod,endPeriod,mode:rules.dayMode,calendarAdjustment:adjustment});
    C.check(computed.days>0,'NONPOSITIVE_LEAVE','本次假期天数必须大于零，请检查日期和时段。');
    if(balance.remaining!==undefined)C.check(computed.days<=balance.remaining,'INSUFFICIENT_BALANCE','本次请假超过可用余额，请调整日期或联系 HR。');
    if(original)C.check(computed.days<=original.days,'CANCELLATION_EXCEEDS_ORIGINAL','销假天数不能超过原请假天数。');
    const byDays=rules.proofAtDays!==undefined&&computed.days>=rules.proofAtDays;
    const byHistory=rules.sameStartProof&&!byDays?await sameStartHistory(ctx,actor,start):false;
    const proofRequired=rules.attachmentRequired===true||byDays||byHistory;
    const data={
      [F.applicant]:[actor.userid],[F.applicantId]:actor.userid,[F.application]:ctx.todayMs,
      [F.start]:start,[F.startPeriod]:startPeriod,[F.end]:end,[F.endPeriod]:endPeriod,[F.reason]:reason,
      [F.days]:computed.days,[F.workdays]:computed.workdays,[F.officeAdmin]:admin.ids,
      [F.company]:contractCompany,[F.attendanceAdmin]:attendance.ids,[F.status]:status,
      [F.group]:group,[F.office]:office
    };
    if(F.year)data[F.year]=year;
    if(F.calendarAdjustment)data[F.calendarAdjustment]=adjustment;
    if(F.workdayTrigger)data[F.workdayTrigger]=computed.workdays;
    if(F.hongKongYear)data[F.hongKongYear]=yearHK;
    if(F.calendarYear)data[F.calendarYear]=yearCalendar;
    if(F.attendanceEnd)data[F.attendanceEnd]=end+(endPeriod==='下午'?23:11)*3600000;
    if(F.leaveType)data[F.leaveType]=leaveType;
    for(const [field,value]of Object.entries(balance))if(F[field])data[F[field]]=value;
    if(original)Object.assign(data,{[F.association]:[Association.processReference(original.selected)],
      [F.originalStart]:original.start,[F.originalEnd]:original.end,[F.originalDays]:original.days,
      [F.originalSerial]:original.serial});
    const preview={流程:title,申请人:name,申请日期:ctx.today,
      ...(leaveType?{假期类型:leaveType.trim()}:{}),
      ...(original?{原请假单:original.serial,原请假开始:`${C.dateText(original.start)} ${original.startPeriod}`,
        原请假结束:`${C.dateText(original.end)} ${original.endPeriod}`,原请假天数:original.days}:{}),
      开始:`${input.start_date} ${startPeriod}`,结束:`${input.end_date} ${endPeriod}`,
      [cancellation?'销假天数':'请假天数']:computed.days,
      ...(reason?{[cancellation?'销假事由':'请假事由']:reason}:{}),
      ...(rules.dayMode==='calendar'?{计日方式:'自然日（包含周末和节假日）'}:{}),
      ...(balance.remaining!==undefined?{可用余额:balance.remaining,假期年份:year}:{}),
      ...(balance.validUntil!==undefined?{假期有效期:C.dateText(balance.validUntil)}:{})};
    return {formData:data,departmentId:department.id,preview,
      ...(F.attachment?{attachmentField:F.attachment,attachmentRequirements:{[F.attachment]:proofRequired}}:{}),
      verification:{optionalEmptyFields:[...(!admin.ids.length?[F.officeAdmin]:[]),
        ...(!attendance.ids.length?[F.attendanceAdmin]:[]),...(!status?[F.status]:[]),...(!reason?[F.reason]:[])]},
      resolvedInputs:{...input,reason,department_id:department.id,start_period:startPeriod,end_period:endPeriod,
        ...(leaveType?{leave_type:leaveType}:{})}};
  }
  return retainedWorkflow(config,prepare,requirements);
}

module.exports={createLeaveWorkflow};
