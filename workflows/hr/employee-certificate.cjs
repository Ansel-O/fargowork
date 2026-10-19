'use strict';
const C=require('../leave-trip-common.cjs'),H=require('../hr-common.cjs');
const config=require('../../config/workflows/hr/employee_certificate.json');
const F=config.fields;
async function compose(input,ctx){
  C.inputKeys(input,['reason','use_date','attachments']);
  const s=await H.selfContext(config,ctx),needs=[];
  const reason=H.text(input,'reason',F.reason,s,needs,'原因说明');
  const useDate=C.absent(input.use_date)?undefined:C.date(input.use_date);
  H.putDate(s.data,F.useDate,useDate);
  if(needs.length)return {needsInput:needs};
  await H.hrContact(config,ctx,s);
  return H.result(config,s,{原因说明:reason,材料使用日期:H.dateText(useDate)});
}
module.exports=H.retainedWorkflow(config,compose,{required:['reason'],optional:['use_date','attachments']});
