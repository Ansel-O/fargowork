'use strict';

// Workflows supply bounded sources and field mappings. This module never loads
// a workflow, company configuration, identity, or a model recommendation.
const {matchingRows,distinctValues}=require('./scoped-catalog.cjs');
const {buildRecommendationContext}=require('./account-recommendation.cjs');
const absent=value=>value===undefined||value===null||value==='';
const normalized=value=>String(value).normalize('NFKC').trim().toLocaleLowerCase('en-US');
function check(condition,code,message) {
  if(!condition) throw Object.assign(new Error(message||code),{code});
}

// Existing PAYMENT codes remain stable for callers and support routing.
function choice(needs,field,label,value,choices,required=true) {
  if(!choices.length) {
    check(!required,'PAYMENT_SOURCE_MISSING','办理所需的财务资料缺失，请联系 Finance。');
    check(absent(value),'PAYMENT_SOURCE_MISSING');return '';
  }
  if(value===undefined&&choices.length===1) return choices[0];
  if(!absent(value)) {
    check(typeof value==='string','PAYMENT_INPUT_INVALID');
    const found=choices.find(v=>normalized(v)===normalized(value));if(found) return found;
  }
  if(!required&&value==='') return '';
  needs.push({field,message:`请选择${label}。`,choices});return '';
}

// Read complete pairs, never a Cartesian product of independent columns.
async function accountPairs(ctx,source) {
  const field=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
    &&!['__proto__','prototype','constructor'].includes(value);
  check(ctx&&typeof ctx.query==='function'&&source&&typeof source==='object'&&!Array.isArray(source)
    &&typeof source.formUuid==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(source.formUuid)
    &&field(source.categoryField)&&field(source.accountField)&&source.categoryField!==source.accountField,
    'PAYMENT_SOURCE_INVALID');
  const rows=await matchingRows(ctx,source.formUuid,{},[source.categoryField,source.accountField]);
  const pairs=[];
  for(const row of rows) {
    if(absent(row[source.categoryField])||absent(row[source.accountField])) continue;
    check(typeof row[source.categoryField]==='string'&&typeof row[source.accountField]==='string','PAYMENT_SOURCE_INVALID');
    const category=row[source.categoryField].trim(),account=row[source.accountField].trim();
    if(category&&account) pairs.push({category,account});
  }
  check(pairs.length,'PAYMENT_SOURCE_MISSING','费用类别与会计科目资料缺失，请联系 Finance。');
  return pairs;
}

function canonicalConstraints(pairs,categoryInput,accountInput) {
  const category=pairs.find(pair=>normalized(pair.category)===normalized(categoryInput))?.category??categoryInput;
  const matching=pairs.filter(pair=>pair.category===category),scoped=matching.length?matching:pairs;
  const account=scoped.find(pair=>normalized(pair.account)===normalized(accountInput))?.account??accountInput;
  return {explicitCategory:category,explicitAccount:account};
}

function recommendation(item,index,pairs,fixedCategory) {
  const explicit=canonicalConstraints(pairs,fixedCategory??item.expense_category,item.account);
  return buildRecommendationContext({scope:fixedCategory===undefined?'general':'project',description:item.description,
    pairs,categoryInputKey:fixedCategory===undefined?`items[${index}].expense_category`:'project_expense_category',
    accountInputKey:`items[${index}].account`,...explicit,
    ...(fixedCategory===undefined?{}:{fixedCategory:explicit.explicitCategory,explicitCategory:undefined})});
}

// Collect every line's unresolved classification before returning to the agent.
function accountSelections(input,pairs,needs,projectCategory) {
  return input.items.map((item,index)=>{
    const before=needs.length,prefix=`items[${index}].`;
    const category=projectCategory??choice(needs,prefix+'expense_category','本行费用类别',item.expense_category,
      [...new Set(pairs.map(pair=>pair.category))]);
    let account='';
    if(needs.length===before) account=choice(needs,prefix+'account','本行会计科目',item.account,
      [...new Set(pairs.filter(pair=>normalized(pair.category)===normalized(category)).map(pair=>pair.account))]);
    if(needs.length>before) {
      const context=recommendation(item,index,pairs,projectCategory),need=needs.at(-1);
      need.recommendationContext=context;
      need.resolver='agent_recommendation';
      need.message=context.conflicts.length
        ?`第 ${index+1} 行的明确分类与合法配对冲突，请 Agent 先澄清相关业务事实，不能静默覆盖员工输入。`
        :`请 Agent 结合第 ${index+1} 行用途，从 recommendationContext.allowedPairs 的完整配对中建议并回填类别与科目；不要把目录交给员工自行选择。用途不足时集中补问必要事实。`;
    }
    return {category,account};
  });
}

// A selected parent scopes the next level; unresolved parents stop only this
// chain. Each caller controls whether its actual form field is required.
async function businessLines({ctx,source,input,departmentId,steps,needs,prefix=''}) {
  const filters={[source.departmentField]:departmentId},result={};
  for(const {inputKey,field,sourceField,label,required} of steps) {
    const rows=await matchingRows(ctx,source.formUuid,filters,[sourceField]),before=needs.length;
    const value=choice(needs,prefix+inputKey,label,input[inputKey],distinctValues(rows,sourceField),required);
    result[field]=value;filters[sourceField]=value;
    if(needs.length>before) return result;
  }
  return result;
}

module.exports={choice,accountPairs,canonicalConstraints,recommendation,accountSelections,businessLines};
