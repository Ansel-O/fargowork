'use strict';
const C=require('../leave-trip-common.cjs'),H=require('../hr-common.cjs');
const {initialValues}=require('../../shared/initial-values.cjs');
const config=require('../../config/workflows/hr/probation_confirmation.json');
const F=config.fields,R=config.roster;
async function compose(input,ctx){
  C.inputKeys(input,['self_review','achievements','weaknesses','improvements','actual_regular_date','include_plan','plan_instance_id','attachments']);
  const s=await H.selfContext(config,ctx),needs=[];
  H.putDate(s.data,F.joinDate,H.rosterDate(s.roster,R.joinDate));
  const planned=H.rosterDate(s.roster,R.plannedRegularDate);
  H.putDate(s.data,F.plannedRegularDate,planned);
  s.data[F.status]=H.rosterValue(s.roster,R.status,{label:true});
  s.data[F.positionLevel]=H.rosterValue(s.roster,R.positionLevel,{label:true});
  const defaults=initialValues(ctx.workflowState?.dates,['actual_regular_date']);
  const actual=defaults.resolve(input,'actual_regular_date',`${s.actor.userid}:${planned??''}`,()=>H.dateText(planned));
  if(actual)s.data[F.actualRegularDate]=C.date(actual);
  const texts={};
  for(const [inputKey,field,label]of [['self_review','selfReview','试用期自我评价'],['achievements','achievements','主要工作业绩'],['weaknesses','weaknesses','目前存在的不足'],['improvements','improvements','如何在本岗位做得更好']])
    texts[label]=H.text(input,inputKey,F[field],s,needs,label);
  if(needs.length)return {needsInput:needs,workflowState:{dates:defaults.snapshot()}};
  const related=await H.relatedSelection(ctx,{include:input.include_plan,instanceId:input.plan_instance_id,
    source:config.policy.relatedSources.probation_plan,alias:'probation_plan',actor:s.actor,
    field:'plan_instance_id',label:'相关试用期计划'});
  if(related.needsInput)return {...related,workflowState:{dates:defaults.snapshot()}};
  s.data[F.relatedPlan]=related.reference;
  await H.hrContact(config,ctx,s);
  return H.result(config,s,{入职日期:H.dateText(s.data[F.joinDate]),计划转正日期:H.dateText(planned),实际转正日期:actual,...texts,相关试用期计划:related.title},
    {workflowState:{dates:defaults.snapshot()}});
}
module.exports=H.retainedWorkflow(config,compose,{required:['self_review'],optional:['achievements','weaknesses','improvements','actual_regular_date','include_plan','plan_instance_id','attachments']});
