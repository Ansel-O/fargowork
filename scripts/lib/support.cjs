'use strict';

// Only actual blocking errors reach this map. Optional empty data is silent.
const HR = new Set(['ROSTER_FIELD_MISSING','DEPARTMENT_MEMBERSHIP_MISSING',
  'MAIN_DEPARTMENT_NOT_ASSIGNED','CONTACTS_NOT_FOUND','DEPARTMENT_MANAGER_MISSING',
  'ANNUAL_BALANCE_NOT_UNIQUE','ANNUAL_BALANCE_INVALID','LEAVE_BALANCE_NOT_UNIQUE','LEAVE_BALANCE_INVALID','WORK_CALENDAR_KIND_INVALID',
  'PROCUREMENT_PROFILE_INCOMPLETE','PROCUREMENT_REQUIRED_CONTACT_MISSING',
  'FW-PAY-PROFILE','FW-PAY-MANAGER-REQUIRED']);
const FINANCE = new Set(['FW-PAY-STRUCTURE-MISSING','FW-PAY-STRUCTURE-AMBIGUOUS',
  'FW-PAY-CONTACTS','FW-PAY-CONTACTS-REQUIRED','FW-PAY-CURRENCY','FW-PAY-RATE',
  'FW-PAY-RATE-AMBIGUOUS','FW-PAY-COMPANY','FW-PAY-SUPPLIER-AMBIGUOUS',
  'FW-PAY-EMPTY-CATALOG','FW-PAY-EMPTY-ACCOUNT-CATALOG','PROCUREMENT_CURRENCY_SOURCE_EMPTY',
  'PROCUREMENT_CURRENCY_SOURCE_AMBIGUOUS','PROCUREMENT_RATE_NOT_UNIQUE','PROCUREMENT_RATE_INVALID',
  'ASSET_CURRENCY_SOURCE_EMPTY','ASSET_CURRENCY_SOURCE_INVALID',
  'MEAL_SOURCE_MISSING','MEAL_CURRENCY_AMBIGUOUS','MEAL_RATE_INVALID',
  'PAYMENT_SOURCE_INVALID','PAYMENT_RATE_INVALID','PAYMENT_CONTACT_MISSING','PAYMENT_PROJECT_DEPARTMENT_AMBIGUOUS',
  'RECOMMENDATION_FIXED_CATEGORY_INVALID','REIMBURSEMENT_CURRENCY_AMBIGUOUS','REIMBURSEMENT_RATE_INVALID',
  'TRAVEL_ALLOWANCE_SOURCE_INVALID','TRAVEL_ALLOWANCE_CURRENCY_UNSUPPORTED','MEDICAL_CURRENCY_CONFLICT']);
function supportForError(code) {
  if(code==='REIMBURSEMENT_CURRENCY_MISSING')
    return {contact:'Finance',nextAction:'check_reimbursement_currency',message:'暂时未能取得这家公司的收款币种。请财务核对维护记录和读取权限；保留材料，核对后继续。'};
  if(code==='DETAIL_EDITOR_REVISION_CONFLICT')
    return {nextAction:'refresh_editor',message:'这份草稿后来有过修改。请打开最新明细，再应用本次修改，避免覆盖已改内容。'};
  if(code==='DETAIL_EDITOR_RENDER_FAILED')
    return {contact:'IT',nextAction:'restore_detail_editor',message:'草稿已保留，但本次 HTML 明细未能生成。请维护者修复后重新打开当前明细；不要把旧页面当作本次内容，也不要宣称已经展示或确认。'};
  if(/^DETAIL_EDITOR_/.test(code))
    return {nextAction:'check_detail_edit',message:'这次修改有内容需要核对。保留修改文件，请在当前明细的有效选项内调整，或直接在聊天中说明要改哪里。'};
  if(code==='PAYMENT_COMPANY_NOT_FOUND')
    return {contact:'IT',nextAction:'check_payment_company_mapping',message:'当前账号暂时未能取得本次申请的支付公司。请维护者核对读取权限和匹配条件；保留已整理的材料，暂停提交，核对后继续办理。'};
  if(code==='PAYMENT_SOURCE_MISSING')
    return {contact:'IT',nextAction:'check_finance_source',message:'暂时未能核对本次申请所需的财务资料。请维护者核查原因；保留已整理的材料，暂停提交，核对后继续办理。'};
  if(code==='WORKFLOW_CLIENT_UPDATE_REQUIRED')
    return {nextAction:'update_client',message:'当前版本不满足该流程的最低客户端或规则兼容要求。保留材料和草稿，更新完整 FargoWork 包后继续；不能手改版本号放行。'};
  if(code==='PROCESS_DRAFT_EXPIRED')
    return {nextAction:'refresh_draft',message:'草稿的 24 小时有效期已结束，输入和材料已保留。请刷新公司资料，核对变化后继续。'};
  if(['DRAFT_REFRESH_REQUIRED','DRAFT_SOURCE_REFRESH_REQUIRED','DRAFT_SOURCE_SNAPSHOT_CHANGED','DRAFT_SOURCE_SNAPSHOT_INVALID'].includes(code))
    return {nextAction:'refresh_draft',message:'这份草稿需要刷新公司资料才能继续。保留输入、材料和已有上传结果，刷新后只核对发生变化的内容。'};
  if(/^DIRECTORY_/.test(code))
    return {contact:'IT',nextAction:'restore_directory_check',message:'流程目录暂时不能核对或已停用。保留草稿并暂停提交，请联系维护者核实目录与读取权限。'};
  if(/^PAYMENT_HISTORY_/.test(code))
    return {nextAction:'check_payment_history',message:'请核对本人收款户名和历史候选，或自行提供本次收款资料；不扩大历史查询范围。'};
  if(/^PERSONAL_/.test(code))
    return {nextAction:'continue_without_personal',message:'个人偏好未能保存或读取。按正常流程继续询问和取数，不用修改公司规则。'};
  if (code === 'WORKFLOW_DELEGATION_NOT_ALLOWED')
    return {nextAction:'select_claimant',message:'当前账号不能代选该报销人。请使用本人资料办理，或由公司已授权的人员处理代办。'};
  if (['WORKFLOW_SUBJECT_INVALID','EMPLOYEE_SELECTION_REQUIRED'].includes(code))
    return {nextAction:'select_claimant',message:'请按姓名和部门重新明确选择本次报销人，保留其他已整理的明细。'};
  if (code === 'RELATED_SELECTION_INVALID')
    return {nextAction:'select_related_process',message:'请从当前可关联候选中重新选择本次单据，保留其他已整理的明细。'};
  if (code === 'BANK_CHANGE_INPUT_INVALID')
    return {nextAction:'revise_bank_details',message:'请按原文核对要变更的收款资料，银行卡号必须保持完整文字，不能转成数字。'};
  if (code === 'BANK_ACCOUNT_SOURCE_INVALID')
    return {contact:'HR',message:'现有收款账号的保存格式异常，无法确保数字完整，请联系 HR 核查后再办理。'};
  if (code === 'BANK_CHANGE_ROUTING_MISSING')
    return {contact:'Finance',message:'办理变更所需的合同公司或出纳配置缺失，请联系 Finance 核查。'};
  if (['DETAIL_REVIEW_REQUIRED','DETAIL_EXPLICIT_CONFIRMATION_REQUIRED','DETAIL_FACTS_CHANGED_REVIEW_REQUIRED'].includes(code))
    return {nextAction:'review_then_wait_for_user',message:'请展示本流程当前明细及材料范围，等待员工确认后再补齐申请。明细变化需要重新确认。'};
  if (code === 'DETAIL_REVIEW_INCOMPLETE')
    return {nextAction:'complete_detail_review',message:'请先补齐明细，明确哪些材料纳入本次申请，再请员工确认。'};
  if (['DETAIL_MATERIALS_INVALID','DETAIL_MATERIAL_PATH_INVALID','DETAIL_MATERIAL_FILE_MISSING',
    'DETAIL_MATERIAL_ROLE_INVALID','DETAIL_MATERIAL_UPLOADS_INVALID','DETAIL_MATERIAL_UPLOAD_SCOPE_INVALID'].includes(code))
    return {nextAction:'check_detail_materials',message:'请核对材料文件、对应明细及纳入范围，保留员工已修改的内容后重新展示。'};
  if (HR.has(code)) return {contact:'HR', message:'办理所需的组织或假勤资料不完整，请联系 HR 核查后继续。'};
  if (FINANCE.has(code)) return {contact:'Finance', message:'办理所需的财务基础资料不完整或无法确定，请联系 Finance 核查后继续。'};
  if (['PROCESS_PREVIEW_REQUIRED','PROCESS_EXPLICIT_CONFIRMATION_REQUIRED'].includes(code))
    return {nextAction:'preview_then_wait_for_user',message:'请先展示本次业务预览，等待员工明确确认后再提交。'};
  if (['BUSINESS_FACTS_CHANGED_REPREPARE','DRAFT_VERSION_CHANGED'].includes(code))
    return {nextAction:'prepare_then_preview',message:'草稿需要更新。重新准备并展示业务预览，等员工确认后再提交。'};
  if (code === 'OPENYIDA_LOGIN_REQUIRED') return {nextAction:'official_login',message:'请使用官方 OpenYida 完成登录后继续。'};
  if (code === 'OPENYIDA_REFRESH_REQUIRED') return {nextAction:'official_refresh',message:'请先使用官方 OpenYida 刷新登录状态；未能恢复时再由本人登录。'};
  if (['ASSET_TEXT_INVALID','ASSET_NUMBER_INVALID','ASSET_AMOUNT_INVALID','ASSET_ITEMS_INVALID',
    'MEAL_INPUT_INVALID','MEAL_INPUT_CONFLICT','PAYMENT_INPUT_INVALID','PAYMENT_INPUT_CONFLICT','PAYMENT_RELATION_CONFLICT','PAYMENT_ACCOUNT_SOURCE_MISMATCH',
    'REIMBURSEMENT_INPUT_INVALID','REIMBURSEMENT_INPUT_CONFLICT','FINANCE_DETAILS_INPUT_INVALID','FINANCE_DETAILS_INPUT_CONFLICT',
    'TRIP_REIMBURSEMENT_INPUT_INVALID','TRIP_REIMBURSEMENT_INPUT_CONFLICT','MEDICAL_INPUT_INVALID','MEDICAL_PAYMENT_COMPANY_INVALID',
    'TRAVEL_ALLOWANCE_DATE_INVALID','TRAVEL_ALLOWANCE_REGION_INVALID','TRAVEL_ALLOWANCE_ROW_INVALID','TRAVEL_ALLOWANCE_ROWS_INVALID',
    'LOCAL_MINUTE_INVALID','DECIMAL_INVALID','DECIMAL_NOT_REPRESENTABLE'].includes(code))
    return {nextAction:'revise_input',message:'请检查需求文字、明细行数和数值，按表单限制调整后重新预览。'};
  if (/OUTCOME_UNKNOWN|SUBMISSION_UNKNOWN|ALREADY_SENT/.test(code))
    return {contact:'IT',nextAction:'check_existing_result',message:'操作结果需要核查，请联系 IT 确认原记录，不要重复提交或重新上传。'};
  if (['INSUFFICIENT_BALANCE','NONPOSITIVE_LEAVE'].includes(code))
    return {nextAction:'revise_input',message:'当前请假日期或时段计算出的天数无效或超过余额，请调整后重新预览。'};
  if (['CANCELLATION_OUTSIDE_ORIGINAL','CANCELLATION_EXCEEDS_ORIGINAL'].includes(code))
    return {nextAction:'revise_input',message:'销假日期、时段和天数不能超过原请假范围，请调整后重新预览。'};
  if (['RELATED_LEAVE_NOT_FOUND','RELATED_LEAVE_SELECTION_CHANGED'].includes(code))
    return {contact:'HR',nextAction:'select_original_leave',message:'请核对本人原请假单是否已结束且审批通过，重新选择；仍找不到时联系 HR。'};
  if (['LEAVE_REASON_INVALID','LEAVE_REASON_TOO_LONG','LEAVE_REASON_REQUIRED'].includes(code))
    return {nextAction:'revise_input',message:'请检查事由是否符合表单的文字要求，调整后重新预览。'};
  if (/^ATTACHMENT_(FILE_NOT_FOUND|FILE_TOO_LARGE|COUNT_EXCEEDED|TYPE_NOT_ALLOWED_BY_FORM|EXTENSION_NOT_SUPPORTED|LOCAL_ABSOLUTE_PATH_REQUIRED|INPUT_INVALID|DUPLICATE)$/.test(code))
    return {nextAction:'check_files',message:'请检查所选文件及流程支持的格式、大小和数量，再准备草稿。'};
  return {contact:'IT',message:'办理暂时遇到问题，请联系 IT 核查。保留现有材料，不要重复提交。'};
}
module.exports = {supportForError};
