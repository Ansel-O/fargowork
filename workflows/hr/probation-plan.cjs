'use strict';
const C=require('../leave-trip-common.cjs'),H=require('../hr-common.cjs');
const config=require('../../config/workflows/hr/probation_plan.json');
const F=config.fields,R=config.roster;
const acknowledgment='本人对于上述试用期限，试用期工作目标均已清楚知晓并认为合理，如试用期考核不合格，视为不符合录用条件，本人愿意承担因不符合录用条件而解除劳动合同的相应结果。';
async function compose(input,ctx){
  C.inputKeys(input,['duties','goals','other','acknowledged']);
  const s=await H.selfContext(config,ctx),needs=[];
  H.putDate(s.data,F.joinDate,H.rosterDate(s.roster,R.joinDate));
  const planned=H.rosterDate(s.roster,R.plannedRegularDate);
  C.check(planned!==undefined||!C.required(s.fields,F.plannedRegularDate),'ROSTER_FIELD_MISSING','计划转正日期缺失，请联系 HR。');
  H.putDate(s.data,F.plannedRegularDate,planned);
  s.data[F.status]=H.rosterValue(s.roster,R.status,{label:true});
  const duties=H.text(input,'duties',F.duties,s,needs,'岗位职责');
  const goals=H.text(input,'goals',F.goals,s,needs,'具体完成目标');
  const other=H.text(input,'other',F.other,s,needs,'其他说明');
  C.check(input.acknowledged===undefined||typeof input.acknowledged==='boolean','HR_INPUT_INVALID');
  if(input.acknowledged!==true)needs.push({field:'acknowledged',message:acknowledgment,choices:[{value:true,label:'本人确认上述声明'}]});
  if(needs.length)return {needsInput:needs};
  C.option(s.fields,F.acknowledgment,'确认',['确认']);s.data[F.acknowledgment]='确认';
  await H.hrContact(config,ctx,s);
  return H.result(config,s,{入职日期:H.dateText(s.data[F.joinDate]),计划转正日期:H.dateText(planned),岗位职责:duties,具体完成目标:goals,其他说明:other,本人确认声明:acknowledgment});
}
module.exports=H.retainedWorkflow(config,compose,{required:['duties','goals','acknowledged'],optional:['other']});
