'use strict';

// Fixed source bindings and reimbursement currency are supplied by a workflow.
// This read-only tool keeps incomplete rows visible; the conversational agent
// supplies semantic classification, and this module validates legal choices.
const Finance=require('./finance-catalog.cjs');
const Decimal=require('./decimal-arithmetic.cjs');
const {buildRecommendationContext}=require('./account-recommendation.cjs');
const {matchingRows,distinctValues}=require('./scoped-catalog.cjs');
const {createRateResolver,convertAmount}=require('./exchange-rates.cjs');
const absent=value=>value===undefined||value===null||value==='';
const normalized=value=>value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
const object=value=>value!==null&&typeof value==='object'
  &&Object.getPrototypeOf(value)===Object.prototype;
const field=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
  &&!['__proto__','prototype','constructor'].includes(value);
const itemKeys=['expense_category','account','description','amount','original_currency','remarks','classification_reason',
  'project_department_name','business_structure','business_line','business_subline'];
function check(condition,code,message) {
  if(!condition) throw Object.assign(new Error(message||code),{code});
}
function sourceFields(source,keys) {
  check(object(source)&&typeof source.formUuid==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(source.formUuid)
    &&keys.every(key=>field(source[key]))&&new Set(keys.map(key=>source[key])).size===keys.length,
    'FINANCE_DETAILS_SOURCE_INVALID');
}
const text=value=>absent(value)?'':value.trim();

async function prepareFinanceDetails({ctx,items,accountSource,pairs,originalCurrencySource,rateSource,
  reimbursementCurrency,precision,ratePrecision,fixedCategory,rateErrorCode,rateErrorMessage,resolveRate,deferClassification=false}={}) {
  check(ctx&&typeof ctx.query==='function'&&Array.isArray(items),'FINANCE_DETAILS_INPUT_INVALID');
  Decimal.round(Decimal.decimal(0),precision);
  Decimal.round(Decimal.decimal(0),ratePrecision);
  check(reimbursementCurrency===null||reimbursementCurrency===undefined
    ||typeof reimbursementCurrency==='string'&&reimbursementCurrency.trim(), 'FINANCE_DETAILS_INPUT_INVALID');
  check(fixedCategory===undefined||typeof fixedCategory==='string'&&fixedCategory.trim(), 'FINANCE_DETAILS_INPUT_INVALID');
  check(resolveRate===undefined||typeof resolveRate==='function','FINANCE_DETAILS_INPUT_INVALID');
  check(typeof deferClassification==='boolean','FINANCE_DETAILS_INPUT_INVALID');
  if(!deferClassification&&pairs===undefined) sourceFields(accountSource,['categoryField','accountField']);
  sourceFields(originalCurrencySource,['currencyField']);
  sourceFields(rateSource,['currencyField','targetCurrencyField','rateField']);

  // Validate every row and configuration before issuing any directory query.
  const normalizedItems=items.map(item=>{
    check(object(item)&&Object.keys(item).every(key=>itemKeys.includes(key)), 'FINANCE_DETAILS_INPUT_INVALID');
    for(const [key,value] of Object.entries(item)) {
      if(key==='amount') check(absent(value)||typeof value==='string'||typeof value==='number'&&Number.isFinite(value),
        'FINANCE_DETAILS_INPUT_INVALID');
      else check(absent(value)||typeof value==='string','FINANCE_DETAILS_INPUT_INVALID');
    }
    check(absent(item.classification_reason)||item.classification_reason.length<=300,'FINANCE_DETAILS_INPUT_INVALID');
    check(fixedCategory===undefined||absent(item.expense_category)
      ||normalized(item.expense_category)===normalized(fixedCategory),'FINANCE_DETAILS_INPUT_CONFLICT');
    const amount=absent(item.amount)?null:Decimal.number(Decimal.round(Decimal.decimal(item.amount),precision));
    return {...item,description:text(item.description),amount,
      ...(item.expense_category===null?{expense_category:undefined}:{}),
      ...(item.account===null?{account:undefined}:{}),
      ...(item.original_currency===null?{original_currency:undefined}:{})};
  });
  const suppliedPairs=deferClassification||pairs===undefined?undefined:buildRecommendationContext({scope:'validation',description:'',pairs,
    categoryInputKey:'expense_category',accountInputKey:'account'}).allowedPairs;
  const rate=resolveRate??createRateResolver({ctx,source:rateSource,ratePrecision,
    ...(rateErrorCode===undefined?{}:{errorCode:rateErrorCode}),
    ...(rateErrorMessage===undefined?{}:{errorMessage:rateErrorMessage})});
  const allowedPairs=deferClassification?[]:suppliedPairs??await Finance.accountPairs(ctx,accountSource);
  check(deferClassification||allowedPairs.length,'PAYMENT_SOURCE_MISSING','费用类别与会计科目资料缺失，请联系 Finance。');
  const category=fixedCategory===undefined?undefined
    :Finance.canonicalConstraints(allowedPairs,fixedCategory).explicitCategory;
  if(category!==undefined) check(allowedPairs.some(pair=>pair.category===category),'RECOMMENDATION_FIXED_CATEGORY_INVALID');
  // A workflow may still be resolving a project/category scope. Conversion is
  // independent; the caller supplies that scope's pending questions.
  const needsInput=[],recommendationContexts=[],selections=deferClassification?normalizedItems.map(()=>({}))
    :Finance.accountSelections({items:normalizedItems},allowedPairs,needsInput,category,recommendationContexts);
  const currencies=distinctValues(await matchingRows(ctx,originalCurrencySource.formUuid,{},
    [originalCurrencySource.currencyField]),originalCurrencySource.currencyField);
  const rows=[];
  for(const [index,item] of normalizedItems.entries()) {
    const prefix=`items[${index}].`;
    if(!item.description) needsInput.push({field:prefix+'description',message:`请补充第 ${index+1} 行费用的实际用途或内容。`});
    if(item.amount===null) needsInput.push({field:prefix+'amount',message:`请补充第 ${index+1} 行原币金额。`});
    const originalCurrency=Finance.choice(needsInput,prefix+'original_currency','本行原币种',item.original_currency,currencies);
    const exchange=originalCurrency&&reimbursementCurrency?await rate(originalCurrency,reimbursementCurrency):null;
    rows.push({category:selections[index].category||text(item.expense_category),
      account:selections[index].account||text(item.account),description:item.description,amount:item.amount,
      originalCurrency:originalCurrency||text(item.original_currency),rate:exchange,
      reimbursedAmount:item.amount===null||exchange===null?null:convertAmount(item.amount,exchange,precision),
      remarks:text(item.remarks),classificationReason:text(item.classification_reason)});
  }
  return {rows,needsInput,recommendationContexts};
}

module.exports={prepareFinanceDetails};
