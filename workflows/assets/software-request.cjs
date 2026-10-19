'use strict';
const C=require('../leave-trip-common.cjs');
const A=require('../asset-common.cjs');
const config=require('../../config/workflows/assets/software_request.json');
const {key,title,target,fields:F,policy,options}=config;
const requirements={required:[],optional:['request_type','system_name','involves_amount','user_or_department','remarks'],
  choices:{request_type:options.types,involves_amount:options.involvesAmount},
  attachments:{optional:true,maximumCount:9,maximumMiB:100},
  notes:['各输入遵循原表单可空规则；是否涉及金额不额外产生金额字段。','使用人或部门是普通文字，不用于查询其他员工。']};

async function prepare(input,ctx) {
  C.inputKeys(input,requirements.optional);
  const b=await A.prepareContext(config,ctx),{fields,formData}=b;
  const mapping={request_type:F.type,system_name:F.systemName,involves_amount:F.involvesAmount,user_or_department:F.userOrDepartment,remarks:F.remarks};
  const needsInput=A.requiredInput(fields,mapping,input);
  if(needsInput.length) return {needsInput};
  const values={};
  for(const [key,id] of Object.entries(mapping)) {
    values[key]=A.textInput(input,key,fields,id);
    if(values[key]) formData[id]=values[key];
  }
  if(values.request_type) C.option(fields,F.type,values.request_type,options.types);
  if(values.involves_amount) C.option(fields,F.involvesAmount,values.involves_amount,options.involvesAmount);
  return {formData,departmentId:b.departmentId,verification:b.verification,
    attachmentField:config.attachments.field,resolvedInputs:{...input},
    preview:{流程:title,申请人:b.name,申请日期:ctx.today,需求类别:values.request_type,系统名称:values.system_name,
      是否涉及金额:values.involves_amount,使用人或部门:values.user_or_department,需求备注:values.remarks}};
}
module.exports={key,title,formUuid:target.formUuid,policy,requirements,prepare};
