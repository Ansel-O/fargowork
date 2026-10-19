'use strict';
const C=require('../leave-trip-common.cjs');
const A=require('../asset-common.cjs');
const config=require('../../config/workflows/assets/hardware_request.json');
const sources=require('../../config/sources.json');
const Decimal=require('../../shared/decimal-arithmetic.cjs');
const {key,title,target,fields:F,policy}=config;
const requirements={required:['items'], optional:['currency','remarks'],
  item:{required:[],optional:['name','model','purpose','quantity','unit_price'],minimumRows:1,maximumRows:50},
  attachments:{optional:true,maximumCount:9,maximumMiB:100},
  notes:['币种使用公司汇率表的候选。','数量乘单价得到行金额，行金额合计为总额；不另加取整规则。','办公场所和 IT 联系人由原表联动自动取得。']};

async function prepare(input,ctx) {
  C.inputKeys(input,['items','currency','remarks']);
  if (C.absent(input.items) || Array.isArray(input.items) && input.items.length===0)
    return {needsInput:[{field:'items',message:'请提供电脑硬件需求明细。'}]};
  C.check(Array.isArray(input.items) && input.items.length<=50,'ASSET_ITEMS_INVALID');
  const b=await A.prepareContext(config,ctx),{fields,formData}=b;
  const table=fields.get(F.items).props;
  C.check(input.items.length>=(table.minItems??1) && input.items.length<=(table.maxItems??50),'ASSET_ITEMS_INVALID');
  const itemFields={name:F.name,model:F.model,purpose:F.purpose,quantity:F.quantity,unit_price:F.price};
  const needsInput=A.requiredInput(fields,{currency:F.currency,remarks:F.remarks},input);
  const rows=[],previewRows=[];
  let totalDecimal=Decimal.decimal(0);
  input.items.forEach((item,index)=>{
    C.inputKeys(item,Object.keys(itemFields));
    needsInput.push(...A.requiredInput(fields,itemFields,item).map(x=>({...x,field:`items[${index}].${x.field}`})));
    const row={},visible={};
    for(const [key,id,label] of [['name',F.name,'名称'],['model',F.model,'建议型号'],['purpose',F.purpose,'用途说明']]) {
      const value=A.textInput(item,key,fields,id);if(value) row[id]=value;visible[label]=value;
    }
    for(const [key,id,label] of [['quantity',F.quantity,'数量'],['unit_price',F.price,'单价']]) {
      if(!C.absent(item[key])) { row[id]=A.numberInput(item[key]);visible[label]=row[id]; }
      else visible[label]='';
    }
    if(Object.hasOwn(row,F.quantity) && Object.hasOwn(row,F.price)) {
      const amount=Decimal.multiply(Decimal.decimal(row[F.quantity]),Decimal.decimal(row[F.price]));
      try { row[F.amount]=Decimal.number(amount); }
      catch { C.fail('ASSET_AMOUNT_INVALID','金额超出可准确表示的范围，请核对。'); }
      totalDecimal=Decimal.add(totalDecimal,amount);visible['金额']=row[F.amount];
    } else visible['金额']='';
    rows.push(row);previewRows.push(visible);
  });
  if(needsInput.length) return {needsInput};
  let total;
  try { total=Decimal.number(totalDecimal); }
  catch { C.fail('ASSET_AMOUNT_INVALID','合计金额超出可准确表示的范围，请核对。'); }
  let currency='';
  if(!C.absent(input.currency)) {
    const source=sources[config.sources.currencies];
    const data=await ctx.query(source.formUuid,null,[source.currencyField]);
    C.check(Array.isArray(data),'ASSET_CURRENCY_SOURCE_INVALID');
    const choices=[...new Set(data.flatMap(row=>C.values(row[source.currencyField])))];
    C.check(choices.length,'ASSET_CURRENCY_SOURCE_EMPTY','币种目录暂不可用，请联系 Finance。');
    currency=choices.find(v=>C.normalized(v)===C.normalized(C.text(input.currency))) || '';
    if(!currency) return {needsInput:[{field:'currency',message:'请选择公司汇率表中的币种。',choices}]};
    formData[F.currency]=currency;
  }
  const remarks=A.textInput(input,'remarks',fields,F.remarks);
  if(remarks) formData[F.remarks]=remarks;
  formData[F.items]=rows;formData[F.total]=total;
  return {formData,departmentId:b.departmentId,verification:b.verification,
    attachmentField:config.attachments.field,
    resolvedInputs:{...input,...(currency?{currency}:{})},
    preview:{流程:title,申请人:b.name,申请日期:ctx.today,币种:currency,硬件明细:previewRows,总额:total,需求备注:remarks}};
}
module.exports={key,title,formUuid:target.formUuid,policy,requirements,prepare};
