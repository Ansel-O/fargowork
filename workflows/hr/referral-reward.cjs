'use strict';
const C=require('../leave-trip-common.cjs'),H=require('../hr-common.cjs');
const {resolveEmployee}=require('../../shared/employee-selection.cjs');
const {queryDepartmentDetails,departmentManagerAt}=require('../../shared/department-details.cjs');
const config=require('../../config/workflows/hr/referral_reward.json');
const company=require('../../config/company.json');
const F=config.fields,R=config.roster;

async function compose(input,ctx){
  C.inputKeys(input,['candidate_name','candidate_selection','include_onboarding','onboarding_instance_id','reward_amount']);
  const actor=C.identity(ctx),fields=H.assertSchema(config,await ctx.schema());
  const own=C.rosterFields(await ctx.roster(config.applicantRosterFields),actor);
  const department=C.department(own),name=H.rosterValue(own,R.name)||actor.name||'本人';
  const candidate=await resolveEmployee(input,ctx,{workflowKey:config.key,appType:company.appType,
    nameField:'candidate_name',selectionField:'candidate_selection',defaultToSelf:false,
    messages:{namePrompt:'请提供推荐候选人的姓名。',choose:'请按姓名和部门确认候选人。',
      changed:'候选人或部门资料已变化，请重新选择。',noMatch:'没有找到该候选人，请核对姓名。'}});
  if(candidate.needsInput)return candidate;
  const roster=C.rosterFields(await ctx.rosterForSelectedEmployee(candidate.userId),{userid:candidate.userId,corp_id:actor.corp_id});
  const candidateDepartment=H.rosterValue(roster,R.mainDepartment,{id:true});
  C.check(/^\d+$/.test(candidateDepartment),'ROSTER_FIELD_MISSING','候选人主部门资料缺失，请联系 HR。');
  const details=await queryDepartmentDetails(ctx,{connector:'departmentDetails',departmentId:candidateDepartment});
  const manager=departmentManagerAt(details,config.rules.departmentManagerIndex);
  const reportManager=H.rosterValue(roster,R.reportManagerId,{id:true});
  const regular=H.rosterDate(roster,R.regularDate);
  const level=H.rosterValue(roster,R.positionLevel,{label:true});
  const reward=C.absent(input.reward_amount)?config.rules.rewardByLevel[level]??config.rules.defaultReward
    :C.number(input.reward_amount,{code:'HR_REWARD_INVALID'});
  const data={[F.applicant]:[actor.userid],[F.applicationDate]:ctx.todayMs,[F.candidate]:[candidate.userId],
    [F.candidateId]:candidate.userId,[F.contractCompany]:H.rosterValue(roster,R.contractCompany),
    [F.positionLevel]:level,[F.status]:H.rosterValue(roster,R.status,{label:true}),
    [F.candidateDepartment]:[candidateDepartment],[F.reportManagerId]:reportManager,
    [F.departmentManager]:manager?[manager]:[],[F.reward]:reward,[F.relatedOnboarding]:[]};
  H.putDate(data,F.regularDate,regular);
  const related=await H.relatedSelection(ctx,{include:input.include_onboarding,instanceId:input.onboarding_instance_id,
    source:config.policy.relatedSources.referral_onboarding,alias:'referral_onboarding',actor,
    field:'onboarding_instance_id',label:'入职人和入职部门'});
  if(related.needsInput)return related;
  data[F.relatedOnboarding]=related.reference;
  for(const field of [F.regularDate,F.reportManagerId,F.departmentManager])
    C.check(!C.required(fields,field)||(!C.absent(data[field])&&(!Array.isArray(data[field])||data[field].length)),
      'ROSTER_FIELD_MISSING','候选人办理所需资料缺失，请联系 HR。');
  const state={data,departmentId:department.id,name};
  return H.result(config,state,{候选人:candidate.name,入职公司:data[F.contractCompany],候选人转正日期:H.dateText(regular),
    候选人状态:data[F.status],岗位职级:level,奖励金额港币:reward,
    关联入职人:related.title,关联入职部门:related.subtitle});
}
module.exports=H.retainedWorkflow(config,compose,{required:['candidate_name'],optional:['candidate_selection','include_onboarding','onboarding_instance_id','reward_amount']});
