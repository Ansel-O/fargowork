'use strict';
const {check,digest,fields}=require('../scripts/lib/common.cjs');
const C=require('../workflows/leave-trip-common.cjs');
const keys=new Set(['expense_reimbursement','trip_expense_reimbursement','external_expense_application','meal_transport']);
const clone=value=>JSON.parse(JSON.stringify(value));
function eligible({workflow,previous,request,saved,state,version,today}) {
  if(!keys.has(workflow)||!previous||!saved?.preparedData||state?.status!=='prepared'
    ||saved.version!==version||previous.version!==version||state.snapshot?.businessDate!==today
    ||saved.draftSha256!==state.draftSha256||saved.revisionId!==previous.revisionId
    ||request.filesProvided||request.materialsProvided||request.materialUploadsProvided
    ||Object.keys(request.input).length!==1||!Object.hasOwn(request.input,'description')) return false;
  return saved.preparedDataSha256===digest(saved.preparedData);
}
function applyDescription({workflow,request,saved,schema}) {
  if(saved.schemaSha256!==digest(schema)) return null;
  const config=require('../config/workflows/finance/'+workflow+'.json'),field=config.fields.description;
  const node=fields(schema)[field];
  if(!node||!Object.hasOwn(saved.preparedData.formData,field)) return null;
  check(typeof request.input.description==='string','INPUT_TEXT_INVALID');
  const value=C.optionalText(request.input.description),limit=Number(node.props.maxLength);
  check(!Number.isFinite(limit)||limit<=0||value.length<=limit,'INPUT_TEXT_INVALID');
  const required=node.props.required===true||node.props.validation?.some(item=>item.type==='required');
  check(!required||value.length>0,'INPUT_TEXT_INVALID');
  const result=clone(saved.preparedData);
  result.formData[field]=value;result.preview.说明=value;
  // Empty optional text may have changed since the previous snapshot.
  const optional=new Set(result.verification?.optionalEmptyFields||[]);
  if(!required&&value==='') optional.add(field);else optional.delete(field);
  result.verification={...result.verification,optionalEmptyFields:[...optional]};
  return result;
}
module.exports={eligible,applyDescription};
