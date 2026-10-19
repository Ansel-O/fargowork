'use strict';
const C=require('../leave-trip-common.cjs'),H=require('../hr-common.cjs');
const config=require('../../config/workflows/hr/employer_housing.json');
const F=config.fields;
const options=['独立屋','楼宇单位','服务式住宅','酒店公寓'];
async function compose(input,ctx){
  C.inputKeys(input,['housing_type','monthly_rent','start_date','end_date','address','acknowledgment','additional_info','attachments']);
  const s=await H.selfContext(config,ctx),needs=[];
  if(!C.absent(input.housing_type)){C.option(s.fields,F.housingType,input.housing_type,options);s.data[F.housingType]=input.housing_type;}
  if(!C.absent(input.monthly_rent))s.data[F.monthlyRent]=C.number(input.monthly_rent,{code:'HR_RENT_INVALID'});
  const start=C.absent(input.start_date)?undefined:C.date(input.start_date);
  const end=C.absent(input.end_date)?undefined:C.date(input.end_date);
  C.check(start===undefined||end===undefined||end>=start,'DATE_RANGE_INVALID');
  if(start!==undefined||end!==undefined)s.data[F.period]=[start??'',end??''];
  const address=H.text(input,'address',F.address,s,needs,'居所地址');
  const acknowledgment=H.text(input,'acknowledgment',F.acknowledgment,s,needs,'申请人确认');
  const additional=H.text(input,'additional_info',F.additionalInfo,s,needs,'补充内容');
  if(needs.length)return {needsInput:needs};
  await H.hrContact(config,ctx,s);
  return H.result(config,s,{居所类型:input.housing_type||'',每月租金港币:s.data[F.monthlyRent]??'',开始日期:H.dateText(start),结束日期:H.dateText(end),居所地址:address,申请人确认:acknowledgment,补充内容:additional});
}
module.exports=H.retainedWorkflow(config,compose,{required:[],optional:['housing_type','monthly_rent','start_date','end_date','address','acknowledgment','additional_info','attachments']});
