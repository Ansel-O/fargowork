'use strict';

// Pure business arithmetic shared by the workflow and the offline HTML editor.
// This module never resolves company data, currencies, identities or permissions.
const Decimal=require('./decimal-arithmetic.cjs');
const {suggestAllowances}=require('./travel-allowance.cjs');
const absent=value=>value===null||value===undefined||value==='';
const own=(value,key)=>Object.hasOwn(value,key);
const norm=value=>String(value??'').normalize('NFKC').trim().toLocaleLowerCase('en-US');
const check=(condition,code)=>{if(!condition)throw Object.assign(new Error(code),{code});};
function rounded(value,precision=2){return Decimal.number(Decimal.round(Decimal.decimal(value),precision));}
function convertAmount(value,rate,precision){return Decimal.number(Decimal.round(Decimal.multiply(Decimal.decimal(value),Decimal.decimal(rate)),precision));}
function sumAmounts(values,precision){
  check(Array.isArray(values),'DECIMAL_INVALID');
  return Decimal.number(Decimal.round(values.reduce((sum,value)=>Decimal.add(sum,Decimal.decimal(value)),Decimal.decimal(0)),precision));
}
function medicalAmount(value,maximumAmount=1500,precision=2){
  const raw=Decimal.decimal(value),maximum=Decimal.decimal(maximumAmount);
  const difference=Decimal.add(raw,{...maximum,coefficient:-maximum.coefficient});
  const capped=difference.coefficient>0n;
  return {requested:String(value).trim(),value:capped?maximumAmount:Decimal.number(Decimal.round(raw,precision)),capped};
}
function mealAmount(currency,amounts,otherwise){return absent(currency)?null:amounts[currency]??otherwise;}
function paymentAmounts(amounts,rate,precision=2){
  check(Decimal.decimal(rate).coefficient>0n,'PAYMENT_RATE_INVALID');
  const converted=amounts.map(value=>convertAmount(value,rate,precision));
  return {rate:Number(rate),amounts:amounts.map(Number),converted,total:sumAmounts(amounts,precision),hkdTotal:sumAmounts(converted,precision)};
}
function tripCost(item,precision=2){
  return sumAmounts(['airfare','accommodation','local_transport','other_expenses']
    .map(key=>absent(item[key])?0:rounded(item[key],precision)),precision);
}
function day(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
  const ms=Date.parse(value+'T00:00:00+08:00');
  return Number.isFinite(ms)&&new Date(ms+28800000).toISOString().slice(0,10)===value?ms:null;
}

// Context contains only rates/standards already obtained for this draft.
// A changed scope or uncached pair produces an unresolved value, never an
// implicit same-currency rate, guessed reciprocal or internet-market fallback.
function calculateEditor(context,main,items){
  const {workflow,precision=2}=context,rows=items.map(()=>({})),summary={},missing=[];
  const currency=main.reimbursement_currency??main.currency??context.currency;
  const sameCompany=main.payment_company===undefined||norm(main.payment_company)===norm(context.company);
  const sameSubject=main.claimant_user_id===undefined||main.claimant_user_id===context.claimant;
  const allowedScope=sameCompany&&sameSubject;
  const note=text=>{if(!missing.includes(text))missing.push(text);};
  const rate=(from,to)=>{
    const values=allowedScope?(context.rates||[]).filter(entry=>norm(entry.from)===norm(from)&&norm(entry.to)===norm(to)).map(entry=>entry.rate):[];
    const distinct=[...new Set(values)];
    if(!from||!to||distinct.length!==1||!(Number(distinct[0])>0)){note('该币种或业务范围尚无已取得的汇率，请交回 Agent 补取公司资料。');return null;}
    return distinct[0];
  };
  const total=key=>rows.some(row=>row[key]===null||row[key]===undefined)?null:sumAmounts(rows.map(row=>row[key]),precision);
  if(workflow==='default_bank_change')return {rows,summary,missing};
  if(workflow==='medical_checkup_reimbursement'){
    const result=absent(main.amount)?null:medicalAmount(main.amount,context.maximumAmount,precision);
    summary.报销金额=result?.value??null;summary.金额调整说明=result?.capped?`原金额${result.requested}元，超过体检报销上限，已调整为${context.maximumAmount}元。`:'未超出体检报销上限';
    return {rows,summary,missing};
  }
  const allowanceCurrency=currency?(context.allowanceCurrencyByReceipt?.[currency]??context.otherAllowanceCurrency):null;
  const known=[];
  for(const [index,item]of items.entries()){
    const row=rows[index];
    if(workflow==='trip_expense_reimbursement'||workflow==='expense_reimbursement'){
      row.rate=rate(item.original_currency,currency);
      const amount=workflow==='trip_expense_reimbursement'?tripCost(item,precision):absent(item.amount)?null:rounded(item.amount,precision);
      row.reimbursedAmount=amount===null||row.rate===null?null:convertAmount(amount,row.rate,precision);
      if(context.includeHkd){row.hkdRate=rate(currency,'HKD');row.hkdAmount=row.reimbursedAmount===null||row.hkdRate===null?null:convertAmount(row.reimbursedAmount,row.hkdRate,precision);}
      if(workflow==='trip_expense_reimbursement'){
        const start=day(item.start_date),end=day(item.end_date||item.start_date);
        row.days=start===null||end===null||end<start?null:(end-start)/86400000+1;
        row.allowanceCurrency=allowanceCurrency;row.allowanceDays=null;row.allowanceAmount=null;row.allowanceStandard=null;
        const standards=allowedScope?(context.standards||[]).filter(value=>norm(value.region)===norm(item.region)&&norm(value.currency)===norm(allowanceCurrency)).map(value=>value.standard):[];
        const distinct=[...new Set(standards)];
        row.allowanceStandard=distinct.length===1?distinct[0]:null;
        if(row.days===null){note('请填写完整、有效的开始日期和结束日期。');continue;}
        known.push({index,entry:{start,end,region:item.region,standard:row.allowanceStandard,
          segmentKey:JSON.stringify([item.trip_instance_id??null,...[item.departure,item.destination,item.region].map(norm),start,end]),
          ...(own(item,'allowance_amount')?{amount:item.allowance_amount}:{})}});
      }
    }else if(workflow==='meal_transport'){
      row.mealAmount=mealAmount(currency,context.mealAmounts,context.otherCurrencyMealAmount);
      row.transportAmount=absent(item.transport_amount)?0:rounded(item.transport_amount,precision);
      if(context.includeHkd){const exchange=rate(currency,'HKD');row.mealHkd=exchange===null?null:convertAmount(row.mealAmount,exchange,precision);row.transportHkd=exchange===null?null:convertAmount(row.transportAmount,exchange,precision);}
    }else{
      const amount=absent(item.amount)?null:rounded(item.amount,precision);
      const exchange=rate(currency,'HKD');row.amount=amount;
      row.hkdAmount=amount===null||exchange===null?null:convertAmount(amount,exchange,precision);
      row.amount_hkd=row.hkdAmount;
    }
  }
  if(workflow==='trip_expense_reimbursement'){
    const planned=suggestAllowances(known.map(value=>value.entry),{precision});
    planned.rows.forEach((value,index)=>{
      const row=rows[known[index].index];row.allowanceDays=value.eligibleDays;
      row.allowanceAmount=absent(value.amount)?null:rounded(value.amount,precision);
      row.allowanceExplicit=value.explicit;
      if(row.allowanceAmount===null&&!value.explicit)note('该地区尚无已取得的差旅津贴标准，请交回 Agent 补取公司资料。');
      if(context.includeHkd){const exchange=rate(allowanceCurrency,'HKD');
        row.allowanceHkdAmount=exchange===null||row.allowanceAmount===null&&!value.explicit
          ?null:convertAmount(row.allowanceAmount??0,exchange,precision);}
    });
    if(planned.conflicts.length)note('同一行程存在多行手填差旅津贴，请核对是否重复申领。');
    summary.差旅津贴币种=allowanceCurrency;summary.差旅津贴总额=rows.some(row=>row.allowanceDays===null||row.allowanceAmount===null&&!row.allowanceExplicit)?null:sumAmounts(rows.map(row=>row.allowanceAmount??0),precision);
    if(context.includeHkd)summary.差旅津贴港币总额=total('allowanceHkdAmount');
  }
  if(['trip_expense_reimbursement','expense_reimbursement'].includes(workflow)){
    summary.报销总额=total('reimbursedAmount');if(context.includeHkd)summary.报销港币总额=total('hkdAmount');
    if(workflow==='trip_expense_reimbursement'&&currency===allowanceCurrency)
      summary.本次申请合计=summary.报销总额===null||summary.差旅津贴总额===null?null:sumAmounts([summary.报销总额,summary.差旅津贴总额],precision);
  }else if(workflow==='meal_transport'){
    summary.餐补总额=total('mealAmount');summary.交通费总额=total('transportAmount');
    if(context.includeHkd){summary.餐补港币总额=total('mealHkd');summary.交通费港币总额=total('transportHkd');}
  }else{
    summary.付款总额=items.some(item=>absent(item.amount))?null:sumAmounts(rows.map(row=>row.amount),precision);
    summary.支付港币总额=total('hkdAmount');
  }
  return {rows,summary,missing};
}
module.exports={rounded,convertAmount,sumAmounts,medicalAmount,mealAmount,paymentAmounts,tripCost,calculateEditor};
