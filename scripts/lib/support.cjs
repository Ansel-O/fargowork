'use strict';

// Only actual blocking errors reach this map. Optional empty data is silent.
const HR = new Set(['ROSTER_FIELD_MISSING','DEPARTMENT_MEMBERSHIP_MISSING',
  'MAIN_DEPARTMENT_NOT_ASSIGNED','CONTACTS_NOT_FOUND','DEPARTMENT_MANAGER_MISSING',
  'ANNUAL_BALANCE_NOT_UNIQUE','ANNUAL_BALANCE_INVALID','WORK_CALENDAR_KIND_INVALID',
  'PROCUREMENT_PROFILE_INCOMPLETE','PROCUREMENT_REQUIRED_CONTACT_MISSING',
  'FW-PAY-PROFILE','FW-PAY-MANAGER-REQUIRED']);
const FINANCE = new Set(['FW-PAY-STRUCTURE-MISSING','FW-PAY-STRUCTURE-AMBIGUOUS',
  'FW-PAY-CONTACTS','FW-PAY-CONTACTS-REQUIRED','FW-PAY-CURRENCY','FW-PAY-RATE',
  'FW-PAY-RATE-AMBIGUOUS','FW-PAY-COMPANY','FW-PAY-SUPPLIER-AMBIGUOUS',
  'FW-PAY-EMPTY-CATALOG','FW-PAY-EMPTY-ACCOUNT-CATALOG','PROCUREMENT_CURRENCY_SOURCE_EMPTY',
  'PROCUREMENT_CURRENCY_SOURCE_AMBIGUOUS','PROCUREMENT_RATE_NOT_UNIQUE','PROCUREMENT_RATE_INVALID']);
function supportForError(code) {
  if (HR.has(code)) return {contact:'HR', message:'办理所需的组织或假勤资料不完整，请联系 HR 核查后继续。'};
  if (FINANCE.has(code)) return {contact:'Finance', message:'办理所需的财务基础资料不完整或无法确定，请联系 Finance 核查后继续。'};
  if (['PROCESS_PREVIEW_REQUIRED','PROCESS_EXPLICIT_CONFIRMATION_REQUIRED'].includes(code))
    return {nextAction:'preview_then_wait_for_user',message:'请先展示本次业务预览，等待员工明确确认后再提交。'};
  if (['BUSINESS_FACTS_CHANGED_REPREPARE','PROCESS_DRAFT_EXPIRED','DRAFT_VERSION_CHANGED'].includes(code))
    return {nextAction:'prepare_then_preview',message:'草稿需要更新。重新准备并展示业务预览，等员工确认后再提交。'};
  if (code === 'OPENYIDA_LOGIN_REQUIRED') return {nextAction:'official_login',message:'请使用官方 OpenYida 完成登录后继续。'};
  if (code === 'OPENYIDA_REFRESH_REQUIRED') return {nextAction:'official_refresh',message:'请先使用官方 OpenYida 刷新登录状态；未能恢复时再由本人登录。'};
  if (/OUTCOME_UNKNOWN|SUBMISSION_UNKNOWN|ALREADY_SENT/.test(code))
    return {contact:'IT',nextAction:'check_existing_result',message:'操作结果需要核查，请联系 IT 确认原记录，不要重复提交或重新上传。'};
  if (['INSUFFICIENT_BALANCE','NONPOSITIVE_LEAVE'].includes(code))
    return {nextAction:'revise_input',message:'当前请假日期或时段不符合余额和工作日规则，请调整后重新预览。'};
  if (/^ATTACHMENT_(FILE_NOT_FOUND|FILE_TOO_LARGE|COUNT_EXCEEDED|TYPE_NOT_ALLOWED_BY_FORM|EXTENSION_NOT_SUPPORTED|LOCAL_ABSOLUTE_PATH_REQUIRED|INPUT_INVALID|DUPLICATE)$/.test(code))
    return {nextAction:'check_files',message:'请检查所选文件及流程支持的格式、大小和数量，再准备草稿。'};
  return {contact:'IT',message:'操作遇到技术或配置问题，请将错误码提供给 IT 核查。不要修改内部字段或重复提交。'};
}
module.exports = {supportForError};
