'use strict';

// The editable file is a view of a local draft. It carries no exchange rates,
// source snapshot, native form fields or permission decisions. Import produces
// only the existing editor's whitelisted edit envelope.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {check}=require('../scripts/lib/common.cjs');
const {sumAmounts,rounded}=require('./finance-calculations.cjs');
const supported=new Set(['expense_reimbursement','trip_expense_reimbursement','external_expense_application','external_expense_request','meal_transport']);
const own=(value,key)=>Object.hasOwn(value,key);
const idPattern=/^row-[a-f0-9-]{16,64}$/;
const message='明细格式有变化，请保留原文件的表头和明细标记，或口述需要修改的内容。';
const mainSection='申请信息',applicationSection='主表与收款资料',materialSection='材料范围';
const reserved=/汇率|(?:兑|兑换).*率|^rate$|^hkdRate$/i;
const commonKeys=new Set(['payment_company','reimbursement_currency','currency','claimant_user_id','is_project','project_name','project_expense_category']);
const helperKeys=new Set(['claimant_query','bank_history_action','bank_history_query','bank_history_choice']);
const expenseColumns=[['expense_category','费用类别'],['account','会计科目'],['description','内容详情'],
  ['amount','原币金额'],['original_currency','原币种'],['reimbursedAmount','报销金额'],['remarks','备注']];
const paymentColumns=[['expense_category','费用类别'],['account','会计科目'],['description','付款内容'],
  ['amount','本次付款金额'],['remarks','备注']];
const mealColumns=[['start_time','开始时间'],['end_time','结束时间'],['reason','加班事由'],
  ['mealAmount','餐费补贴'],['transport_amount','交通费'],['remarks','备注']];
const payment=workflow=>['external_expense_application','external_expense_request'].includes(workflow);
const meal=workflow=>workflow==='meal_transport';
const tripOrder=['departure','destination','region','start_date','end_date','days','trip_instance_id',
  'allowanceCurrency','allowanceStandard','allowanceDays','allowance_amount','allocation',
  'original_currency','airfare','accommodation','local_transport','other_expenses','reimbursedAmount','remarks',
  'account','classification_reason'];
const derivedLabels={days:'行程天数',allowanceCurrency:'差旅津贴币种',allowanceStandard:'每日差旅津贴标准',
  allowanceDays:'差旅津贴建议天数',reimbursedAmount:'报销金额',allocation:'津贴计天说明（供核对）'};
const supports=workflow=>supported.has(workflow);
function escape(value){
  return String(value??'').replace(/\r\n?/g,'\n').replace(/&/g,'&amp;').replace(/\\/g,'&#92;')
    .replace(/\|/g,'&#124;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/`/g,'&#96;')
    .replace(/\*/g,'&#42;').replace(/_/g,'&#95;').replace(/\n/g,'<br>')
    .replace(/^ +| +$/g,spaces=>'&#32;'.repeat(spaces.length));
}
function unescape(value){
  return value.replace(/<br\s*\/?\s*>/gi,'\n').replace(/&#(\d+);/g,(_,number)=>String.fromCodePoint(Number(number)))
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&');
}
function text(value){
  if(value===null||value===undefined)return '';
  if(Array.isArray(value))return value.map(text).join('、');
  if(typeof value==='object')return Object.entries(value).filter(([key])=>!reserved.test(key))
    .map(([key,item])=>`${key}：${text(item)||'未填写'}`).join('；');
  return String(value);
}
function number(value){return value===null||value===undefined||value===''?'':Number.isFinite(Number(value))?rounded(value,2).toFixed(2):String(value);}
function table(headers,rows){return ['| '+headers.map(escape).join(' | ')+' |','| '+headers.map(()=>'---').join(' | ')+' |',
  ...rows.map(row=>'| '+row.map(escape).join(' | ')+' |')].join('\n');}
function fieldDisplay(field){
  if(field.type==='boolean')return field.value===null?'待确认':field.value?'是':'否';
  const value=field.value;
  if(field.type==='select')return field.choices?.find(choice=>choice.value===value)?.label??value??'';
  if(field.type==='datetime-local'&&typeof value==='string')return value.replace('T',' ');
  return value??'';
}
function visibleFields(document,application=false){
  return document.mainFields.filter(field=>{
    const common=commonKeys.has(field.key);
    return (application?!common:common)
    &&(!helperKeys.has(field.key)||field.present)
    &&(!field.project||document.baseInput.is_project===true);
  });
}
function main(document){
  const fields=visibleFields(document),rows=fields.map(field=>[field.label,fieldDisplay(field)]);
  const claimant=document.summary.find(item=>item.label==='报销人');
  if(claimant&&!fields.some(field=>field.key==='claimant_user_id'))rows.unshift(['报销人',text(claimant.value)]);
  if(document.workflow==='trip_expense_reimbursement'&&document.baseInput.is_project===false){
    const {rules}=require('../config/workflows/finance/trip_expense_reimbursement.json');
    rows.push(['费用类别',rules.fixedCategory],['会计科目',rules.fixedAccount+'（非项目固定）']);
  }
  return '## '+mainSection+'\n\n'+table(['字段','填写内容'],rows);
}
function readonly(row,key){return row.readonly.find(field=>field.key===key)?.value;}
function rowField(row,key){return row.fields.find(field=>field.key===key);}
function rowValue(row,key){const field=rowField(row,key);return field?fieldDisplay(field):readonly(row,
  key==='expense_category'?'category':key);}
function reimbursementCurrency(document){return document.mainFields.find(field=>['reimbursement_currency','currency'].includes(field.key))?.value
  ??document.calculationContext?.currency??'';}
function allowanceAmount(row){const field=rowField(row,'allowance_amount');
  return field?.present?field.value:field?.display??readonly(row,'allowanceAmount');}
function allowanceCurrency(document,row){return readonly(row,'allowanceCurrency')
  ??document.calculationContext?.allowanceCurrencyByReceipt?.[reimbursementCurrency(document)]
  ??document.calculationContext?.otherAllowanceCurrency??'';}
function expenseDetails(document,columns=expenseColumns){
  const headers=columns.map(([key,label])=>key==='reimbursedAmount'?`${label}（${reimbursementCurrency(document)}）`:label);
  const rows=document.rows.map(row=>columns.map(([key])=>['amount','reimbursedAmount','mealAmount','transport_amount'].includes(key)
    ?number(rowValue(row,key)):rowValue(row,key)));
  if(meal(document.workflow)){headers.unshift('序号');rows.forEach((row,index)=>row.unshift(index+1));}
  const lines=table(headers,rows).split('\n');
  if(!meal(document.workflow))document.rows.forEach((row,index)=>{lines[index+2]=lines[index+2].replace(/^\| /,`| <!-- fargowork-row:${row.id} -->`);});
  let result=lines.join('\n');
  // Project allocation belongs to the same row; the canonical seven columns
  // (or payment's five) remain readable; presentation invents no form field.
  if(document.baseInput.is_project===true)result+='\n\n'+document.rows.map((row,index)=>{
    const fields=row.fields.filter(field=>field.project);
    return fields.length?`### 第 ${index+1} 笔项目归属\n\n<!-- fargowork-project:${row.id} -->\n\n`+
      table(['字段','填写内容'],fields.map(field=>[field.label,fieldDisplay(field)])):'';
  }).filter(Boolean).join('\n\n');
  return result;
}
function allocation(document,row,index){
  const days=readonly(row,'allowanceDays');
  const notes=document.notes.filter(item=>/津贴分配说明|餐补分配说明/.test(item.label)
    &&new RegExp('^第\\s*'+(index+1)+'\\s*行').test(item.text)).map(item=>item.text);
  let result=days===null||days===undefined?'待补齐日期或地区后计算。':
    `按实际行程顺序，仅计算前行尚未覆盖的日期；本行建议${days}天。`;
  if(notes.length)result+=' '+notes.join(' ');
  const field=rowField(row,'allowance_amount');
  if(field?.present)result+=' 本行采用你填写的差旅津贴金额'+(field.value===null||field.value===''?'（已清空）':'')+'。';
  return result;
}
function tripDetails(document){return document.rows.map((row,index)=>{
  const currency=rowValue(row,'original_currency')||'',allowanceUnit=allowanceCurrency(document,row);
  const rows=tripOrder.flatMap(key=>{
    const field=rowField(row,key),derived=derivedLabels[key];
    if(!field&&!derived)return [];
    let value=key==='allowance_amount'?allowanceAmount(row):key==='allocation'?allocation(document,row,index):rowValue(row,key);
    const label=key==='allowance_amount'?'差旅津贴金额':field?.label??derived;
    if(['airfare','accommodation','local_transport','other_expenses'].includes(key))value=value===null||value===undefined||value===''?'':`${number(value)} ${currency}`;
    if(key==='allowance_amount')value=value===null||value===undefined||value===''?'':`${number(value)} ${allowanceUnit}`;
    if(key==='allowanceStandard')value=value===null||value===undefined?'':`${number(value)} ${allowanceUnit}/天`;
    if(['days','allowanceDays'].includes(key))value=value===null||value===undefined?'':`${value}天`;
    if(key==='allowanceCurrency')value=allowanceUnit;
    if(key==='reimbursedAmount')value=value===null||value===undefined?'':`${number(value)} ${reimbursementCurrency(document)}`;
    return [[label,value??'']];
  });
  return `<!-- fargowork-row:${row.id} -->\n\n## 明细 ${index+1}｜${escape(rowValue(row,'departure'))} → ${escape(rowValue(row,'destination'))}｜${escape(currency)}\n\n`+
    table(['字段','填写内容'],rows);
}).join('\n\n');}
function candidates(document){
  const contexts=document.workflow==='external_expense_request'?document.recommendationContexts.filter(context=>
    context.scope!=='supplier'&&context.accountInputKey!=='supplier_account'):document.recommendationContexts;
  const allowed=contexts.flatMap(context=>context.catalogPairs??context.allowedPairs??[]),groups=new Map();
  const selected=document.rows.map(row=>({category:document.baseInput.is_project===true
    ?document.mainFields.find(field=>field.key==='project_expense_category')?.value??document.baseInput.project_expense_category
    :rowValue(row,'expense_category'),account:rowValue(row,'account')}));
  for(const pair of [...selected,...document.recommendations]){
    if(!allowed.some(item=>item.category===pair.category&&item.account===pair.account))continue;
    if(!groups.has(pair.category))groups.set(pair.category,new Set());groups.get(pair.category).add(pair.account);
  }
  if(!groups.size)return document.workflow==='trip_expense_reimbursement'?'':'当前没有另外筛选的科目候选；需要调整可口述用途，由 Agent 从公司目录提供建议。';
  return [...groups].map(([category,accounts])=>`- **${escape(category)}：** ${[...accounts].map(escape).join('、')}。`).join('\n');
}
function totals(document){
  const currency=reimbursementCurrency(document),allowanceUnit=document.summary.find(item=>item.label==='差旅津贴币种')?.value
    ??(document.rows[0]?allowanceCurrency(document,document.rows[0]):null);
  const rows=document.summary.filter(item=>!reserved.test(item.label)&&/金额|总额|合计/.test(item.label)
    &&(!(payment(document.workflow)||meal(document.workflow)||document.workflow==='trip_expense_reimbursement')||!/港币|HKD/i.test(item.label))
    &&(item.value===null||['string','number'].includes(typeof item.value))).map(item=>{
      const unit=/港币/.test(item.label)?'HKD':/差旅津贴/.test(item.label)?allowanceUnit:
        /报销|付款|餐补|餐费|交通费|本次申请合计/.test(item.label)?currency:null;
      const value=item.value===null||item.value===''?'待补齐':Number.isFinite(Number(item.value))
        ?number(item.value)+(unit?' '+unit:''):text(item.value);
      return [item.label,value];
    });
  let result=rows.length?'## 本次金额\n\n'+table(['项目','金额'],rows):'';
  if(document.workflow==='expense_reimbursement'){
    const groups=new Map();
    for(const row of document.rows){const unit=rowValue(row,'original_currency');if(!unit)continue;
      if(!groups.has(unit))groups.set(unit,[]);groups.get(unit).push(rowValue(row,'amount'));
    }
    const precision=document.calculationContext?.precision??2;
    const subtotals=[...groups].map(([unit,amounts])=>unit+' '+(amounts.some(value=>value===null||value===undefined||value==='')
      ?'待补齐':number(sumAmounts(amounts.map(value=>rounded(value,precision)),precision))));
    if(subtotals.length)result+='\n\n原币分别合计：'+subtotals.map(escape).join('；')+'。';
  }
  return result;
}
function application(document){
  if(document.stage!=='application')return '';
  const fields=visibleFields(document,true),rows=fields.map(field=>[field.label,fieldDisplay(field)]);
  const visibleLabels=new Set([...visibleFields(document),...fields].map(field=>field.label));
  for(const item of document.summary)if((!visibleLabels.has(item.label)||item.value!==null&&typeof item.value==='object')
    &&!reserved.test(item.label)&&!(/金额|总额|合计|津贴分配说明|餐补分配说明/.test(item.label)))
    rows.push([visibleLabels.has(item.label)?item.label+'（已选详情）':item.label,text(item.value)]);
  const attachmentLabels=new Set(meal(document.workflow)?document.materialRoles.map(role=>role.label):[]);
  const notes=document.notes.filter(item=>!reserved.test(item.label)&&!/津贴分配说明|餐补分配说明/.test(item.label)
    &&!(meal(document.workflow)&&(attachmentLabels.has(item.label)||item.label==='附件来源')));
  return '## '+applicationSection+'\n\n'+table(['字段','填写内容'],rows)
    +(notes.length?'\n\n'+table(['项目','内容'],notes.map(item=>[item.label,item.text])):'')
    +(meal(document.workflow)?'\n\n'+document.materialRoles.map(role=>{
      const files=document.notes.filter(item=>item.label===role.label);
      return '### '+escape(role.label)+'（最终提交附件）\n\n'+(files.length?files.map(item=>'- '+escape(item.text)).join('\n'):'尚未选择最终附件。');
    }).join('\n\n'):'');
}
const statusLabels={included:'纳入',excluded:'不纳入',unresolved:'待确认'};
function materials(document){
  if(!document.materials.length)return '';
  const lines=table(['材料','状态','对应明细','说明'],document.materials.map(material=>[material.name,
    statusLabels[material.status],material.rowIds.map(id=>document.rows.findIndex(row=>row.id===id)+1).join('、'),material.note])).split('\n');
  document.materials.forEach((material,index)=>{lines[index+2]=lines[index+2].replace(/^\| /,`| <!-- fargowork-material:${material.id} -->`);});
  return '## '+materialSection+'\n\n'+lines.join('\n');
}
function render(document){
  check(supports(document?.workflow),'DETAIL_MARKDOWN_WORKFLOW_UNSUPPORTED');
  const template=fs.readFileSync(path.join(__dirname,'../assets',meal(document.workflow)?'finance-meal-details.md':payment(document.workflow)?'finance-payment-details.md'
    :document.workflow==='expense_reimbursement'?'finance-expense-details.md':'finance-trip-details.md'),'utf8');
  const binding='<!-- fargowork-md:'+JSON.stringify({schemaVersion:1,workflow:document.workflow,draftId:document.draftId,
    baseRevision:document.baseRevision}).replace(/</g,'\\u003c').replace(/>/g,'\\u003e')+' -->';
  const recommendations=candidates(document),values={stageTitle:document.stage==='application'?'完整申请':'明细',binding,
    main:main(document),details:meal(document.workflow)?expenseDetails(document,mealColumns):payment(document.workflow)?expenseDetails(document,paymentColumns)
      :document.workflow==='expense_reimbursement'?expenseDetails(document):tripDetails(document),
    totals:totals(document),candidates:document.workflow==='trip_expense_reimbursement'&&recommendations
      ?'## 按类别分组的科目候选\n\n'+recommendations:recommendations,
    application:application(document),materials:meal(document.workflow)?'':materials(document),confirmation:document.demo
      ?'修改后保存并告诉 Agent；完整申请在对话核对，明确确认后提交。':meal(document.workflow)
      ?document.stage==='application'?'请核对完整申请，明确确认后提交。':''
      :document.stage==='application'
      ?'这是完整申请核对阶段。请核对主表、明细、收款资料及附件；明确确认提交后才会提交。'
      :'这是明细确认阶段。明细确认后再补齐主表、收款资料及附件；完整申请仍需另行确认提交。'};
  const rendered=template.replace(/\{\{(\w+)\}\}/g,(_,key)=>values[key]??'').replace(/\n{4,}/g,'\n\n\n');
  return document.demo?rendered.replace(/^# /,'# Demo · '):rendered;
}
function editFromApplied(document,applied){
  const allowed=new Set(document.mainFields.map(field=>field.key)),rowAllowed=new Set(document.rowFields.map(field=>field.key));
  return {schemaVersion:1,workflow:document.workflow,draftId:document.draftId,baseRevision:document.baseRevision,
    main:Object.fromEntries(Object.entries(applied.input).filter(([key])=>allowed.has(key))),
    rows:(applied.input.items||[]).map((values,index)=>({id:applied.rowIds[index],
      values:Object.fromEntries(Object.entries(values).filter(([key])=>rowAllowed.has(key)))})),
    materials:applied.materials.map(material=>({id:material.id,status:material.status,note:material.note??'',
      rowIds:(material.itemIndexes||[]).map(index=>applied.rowIds[index]),...(own(material,'role')?{role:material.role}:{})}))};
}
// The hidden envelope preserves explicit zero/empty edits and auto-derived
// allowance intent across HTML -> MD -> Agent. It has the same whitelist as
// ordinary edits; it is validated again on read and never grants authority.
function renderEdited(document,applied){
  const Editor=require('./finance-detail-editor.cjs'),edit=editFromApplied(document,applied);
  const validated=Editor.applyEdit({document,edit,currentRevision:document.baseRevision});
  const rendered=render(Editor.documentFromApplied(document,validated));
  return rendered+'\n<!-- fargowork-saved-edit:'+JSON.stringify(edit).replace(/</g,'\\u003c').replace(/>/g,'\\u003e')+' -->\n';
}
function splitCells(line){
  const source=line.trim().replace(/^\|/,'').replace(/\|$/,''),cells=[];let value='';
  for(let index=0;index<source.length;index++){
    if(source[index]==='\\'&&source[index+1]==='|'){value+='|';index++;}
    else if(source[index]==='|'){cells.push(value.trim());value='';}else value+=source[index];
  }
  cells.push(value.trim());return cells;
}
function tables(markdown){
  const lines=markdown.replace(/\r\n?/g,'\n').split('\n'),result=[];let heading='',rowId=null,projectId=null;
  for(let index=0;index<lines.length;index++){
    const marker=lines[index].match(/^\s*<!-- fargowork-(row|project):([^ ]+) -->\s*$/);
    if(marker){if(marker[1]==='row')rowId=marker[2];else projectId=marker[2];continue;}
    if(/^#{1,6}\s/.test(lines[index]))heading=lines[index].replace(/^#+\s*/,'').trim();
    if(!/^\s*\|/.test(lines[index])||!/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(lines[index+1]||''))continue;
    const headers=splitCells(lines[index]).map(unescape),rows=[];index+=2;
    while(index<lines.length&&/^\s*\|/.test(lines[index])){
      const cells=splitCells(lines[index]);check(cells.length===headers.length,'DETAIL_MARKDOWN_FORMAT_INVALID',message);
      const identity=cells[0].match(/^<!-- fargowork-(row|material):([^ ]+) -->/);
      if(identity)cells[0]=cells[0].slice(identity[0].length);
      rows.push({cells:cells.map(unescape),...(identity?{kind:identity[1],id:identity[2]}:{})});index++;
    }
    index--;result.push({heading,headers,rows,rowId,projectId});rowId=null;projectId=null;
  }
  return result;
}
function mapFields(table){
  check(table?.headers.length===2,'DETAIL_MARKDOWN_FORMAT_INVALID',message);
  const result=new Map();for(const {cells}of table.rows){const label=cells[0].replace(/^\*\*|\*\*$/g,'');
    check(!result.has(label),'DETAIL_MARKDOWN_FORMAT_INVALID',message);result.set(label,cells[1]);}return result;
}
function parseValue(field,value,{currency,currencies=[]}={}){
  if(field.type==='boolean'){
    check(['是','否','true','false','待确认',''].includes(value),'DETAIL_EDITOR_VALUE_INVALID');
    return value==='待确认'||value===''?null:value==='是'||value==='true';
  }
  if(field.type==='select')return field.choices?.find(choice=>String(choice.value)===value||choice.label===value)?.value??value;
  if(field.type==='datetime-local')return value.replace(' ','T');
  if(field.type==='number'){
    let number=value.trim();for(const unit of [currency,...currencies].filter(Boolean))if(number.endsWith(' '+unit)){
      number=number.slice(0,-unit.length-1).trim();break;}
    number=number.replace(/,/g,'');check(number===''||/^-?\d+(?:\.\d+)?$/.test(number),'DETAIL_EDITOR_VALUE_INVALID');return number;
  }
  return value;
}
function normalized(field,value,options){
  const parsed=parseValue(field,value,options);return field.type==='number'&&parsed!==''?Number(parsed):parsed;
}
function setChanged(target,field,value,baseline,options){
  const displayed=field.type==='number'?number(baseline):String(baseline??'');
  if(normalized(field,value,options)===normalized(field,displayed,options))return;
  target[field.key]=parseValue(field,value,options);
}
function binding(document,markdown){
  const matches=[...markdown.matchAll(/<!-- fargowork-md:([^\r\n]*?) -->/g)];
  check(matches.length===1,'DETAIL_MARKDOWN_TARGET_MISMATCH');let value;
  try{value=JSON.parse(matches[0][1]);}catch{check(false,'DETAIL_MARKDOWN_TARGET_MISMATCH');}
  check(value.schemaVersion===1&&value.workflow===document.workflow&&value.draftId===document.draftId,
    'DETAIL_MARKDOWN_TARGET_MISMATCH');
  check(value.baseRevision===document.baseRevision,'DETAIL_EDITOR_REVISION_CONFLICT','草稿已更新，请打开新版明细再修改。');
}
function friendlyId(value,entries,code){
  check(/^\d+$/.test(value)&&Number(value)>=1&&Number(value)<=entries.length,code,
    '编号不属于当前草稿，请保留已有编号；新增明细的序号留空，保存后由 Agent 分配。');
  return entries[Number(value)-1].id;
}
function parsePlain(document,markdown){
  check(supports(document?.workflow)&&typeof markdown==='string'&&markdown.length<=3000000,'DETAIL_MARKDOWN_FORMAT_INVALID');
  binding(document,markdown);const all=tables(markdown),main={},rows=[],baseById=new Map(document.rows.map(row=>[row.id,row]));
  let friendlyRows=false;
  for(const [section,fields]of [[mainSection,visibleFields(document)],[applicationSection,visibleFields(document,true)]]){
    if(section===applicationSection&&document.stage!=='application')continue;
    const table=all.find(table=>table.heading===section);check(table,'DETAIL_MARKDOWN_FORMAT_INVALID',message);
    const values=mapFields(table);for(const field of fields){check(values.has(field.label),'DETAIL_MARKDOWN_FORMAT_INVALID',message);
      setChanged(main,field,values.get(field.label),fieldDisplay(field));}
  }
  if(document.workflow==='expense_reimbursement'||payment(document.workflow)||meal(document.workflow)){
    const table=all.find(table=>table.heading=== (meal(document.workflow)?'加班明细':payment(document.workflow)?'付款明细':'费用明细'));
    check(table,'DETAIL_MARKDOWN_FORMAT_INVALID',message);
    const columns=meal(document.workflow)?mealColumns:payment(document.workflow)?paymentColumns:expenseColumns;
    friendlyRows=meal(document.workflow)&&table.headers.includes('序号');
    const indexes=new Map(columns.filter(([key])=>!['reimbursedAmount','mealAmount'].includes(key)).map(([key,label])=>[key,table.headers.indexOf(label)]));
    check([...indexes.values()].every(index=>index>=0),'DETAIL_MARKDOWN_FORMAT_INVALID',message);
    for(const entry of table.rows){const number=friendlyRows?entry.cells[table.headers.indexOf('序号')]:null;
      const id=friendlyRows?(number===''?'row-'+crypto.randomUUID():friendlyId(number,document.rows,'DETAIL_EDITOR_ROWS_INVALID'))
        :entry.id||'row-'+crypto.randomUUID(),base=baseById.get(id),values={};
      check(!entry.id||idPattern.test(id),'DETAIL_EDITOR_ROWS_INVALID');
      for(const [key,index]of indexes){const field=base?rowField(base,key):document.rowFields.find(field=>field.key===key);
        if(!field)continue;const current=base?rowValue(base,key):'';
        setChanged(values,field,entry.cells[index],current);}
      const projectTable=all.find(table=>table.projectId===id);
      if(projectTable){const projectFields=mapFields(projectTable);for(const field of base?.fields.filter(field=>field.project)||[])
        if(projectFields.has(field.label))setChanged(values,field,projectFields.get(field.label),fieldDisplay(field));}
      rows.push({id,values});}
  }else if(document.workflow==='trip_expense_reimbursement'){
    for(const table of all.filter(table=>/^明细\s+\d+[｜|]/.test(table.heading))){
      const id=table.rowId||'row-'+crypto.randomUUID(),base=baseById.get(id),values={},map=mapFields(table);
      check(!table.rowId||idPattern.test(id),'DETAIL_EDITOR_ROWS_INVALID');
      const currency=map.get('原币种')??(base?rowValue(base,'original_currency'):'');
      const allowanceUnit=base?allowanceCurrency(document,base):'';
      for(const field of base?.fields||document.rowFields){
        if(!map.has(field.label))continue;
        const current=field.key==='allowance_amount'?base?allowanceAmount(base):'':base?rowValue(base,field.key):'';
        const options={currency:field.key==='allowance_amount'?allowanceUnit:currency,
          currencies:base?[rowValue(base,'original_currency')]:[]};
        setChanged(values,field,map.get(field.label),current,options);}
      rows.push({id,values});
    }
  }
  check(rows.length<=document.maxRows&&new Set(rows.map(row=>row.id)).size===rows.length,'DETAIL_EDITOR_ROWS_INVALID');
  // The material text is editable, but paths and native references never come
  // from the file. Unchanged links stay bound to stable IDs across reordering.
  const mealHeadings=meal(document.workflow)?[...document.materialRoles.map(role=>role.label+'（来源材料）'),'待明确用途（来源材料）']:[];
  const materialHeaders=meal(document.workflow)?['材料','用途','状态','对应明细','说明']:['材料','状态','对应明细','说明'];
  const materialTables=all.filter(table=>(meal(document.workflow)?mealHeadings.includes(table.heading):table.heading===materialSection)
    &&materialHeaders.every(label=>table.headers.includes(label)));
  const materialRows=materialTables.flatMap(table=>table.rows.map(row=>({...row,headers:table.headers})));
  const materialById=new Map(document.materials.map(material=>[material.id,material]));
  const materials=[];
  if(meal(document.workflow)&&materialTables.length===0){
    // The concise employee view omits the source ledger. Keep the existing
    // role/status/stable row bindings verbatim; applyEdit still rejects a
    // deletion whose material scope has not been explicitly resolved.
    materials.push(...document.materials.map(material=>({id:material.id,status:material.status,rowIds:[...material.rowIds],
      note:material.note,...(own(material,'role')?{role:material.role}:{})})));
  }else if(document.materials.length){check(materialRows.length===document.materials.length,'DETAIL_EDITOR_MATERIAL_INVALID');
    for(const entry of materialRows){const id=meal(document.workflow)&&entry.headers.includes('材料编号')
      ?friendlyId(entry.cells[entry.headers.indexOf('材料编号')],document.materials,'DETAIL_EDITOR_MATERIAL_INVALID'):entry.id;
      const base=materialById.get(id);check(base,'DETAIL_EDITOR_MATERIAL_INVALID');
      let name,status,links,note,role=base.role;
      if(meal(document.workflow)){
        check(['材料','用途','状态','对应明细','说明'].every(label=>entry.headers.includes(label)),'DETAIL_EDITOR_MATERIAL_INVALID');
        [name,status,links,note]=['材料','状态','对应明细','说明'].map(label=>entry.cells[entry.headers.indexOf(label)]);
        const value=entry.cells[entry.headers.indexOf('用途')];
        role=value==='待确认'||value===''?null:document.materialRoles.find(candidate=>candidate.role===value||candidate.label===value)?.role;
        check(role!==undefined,'DETAIL_EDITOR_MATERIAL_INVALID');
      }else [name,status,links,note]=entry.cells;
      check(name===base.name,'DETAIL_EDITOR_MATERIAL_INVALID');
      const previous=base.rowIds.map(id=>document.rows.findIndex(row=>row.id===id)+1).join('、');
      const rowIds=friendlyRows?(links.trim()===''?[]:links.split(/[、,，\s]+/).map(number=>{
        const id=friendlyId(number,document.rows,'DETAIL_EDITOR_MATERIAL_INVALID');
        check(rows.some(row=>row.id===id),'DETAIL_EDITOR_MATERIAL_INVALID','这份材料仍关联已删除的明细，请明确调整对应明细或排除材料。');return id;
      })):links===previous?[...base.rowIds]:links.trim()===''?[]:links.split(/[、,，\s]+/).map(number=>{
        check(/^\d+$/.test(number)&&Number(number)>0&&Number(number)<=rows.length,'DETAIL_EDITOR_MATERIAL_INVALID');return rows[Number(number)-1].id;});
      const state=Object.entries(statusLabels).find(([,label])=>label===status)?.[0]??status;
      materials.push({id:base.id,status:state,rowIds,note,...(meal(document.workflow)||own(base,'role')?{role}:{})});}
  }
  if(meal(document.workflow)){
    const order=new Map(document.materials.map((material,index)=>[material.id,index]));
    materials.sort((left,right)=>order.get(left.id)-order.get(right.id));
  }
  return {schemaVersion:1,workflow:document.workflow,draftId:document.draftId,baseRevision:document.baseRevision,main,rows,materials};
}
function parse(document,markdown){
  check(typeof markdown==='string'&&markdown.length<=3000000,'DETAIL_MARKDOWN_FORMAT_INVALID');
  const saved=[...markdown.matchAll(/<!-- fargowork-saved-edit:([^\r\n]*?) -->/g)];
  if(!saved.length)return parsePlain(document,markdown);
  check(saved.length===1,'DETAIL_MARKDOWN_FORMAT_INVALID');let edit;
  try{edit=JSON.parse(saved[0][1]);}catch{check(false,'DETAIL_MARKDOWN_FORMAT_INVALID');}
  const Editor=require('./finance-detail-editor.cjs');
  const applied=Editor.applyEdit({document,edit,currentRevision:document.baseRevision});
  const view=Editor.documentFromApplied(document,applied),changes=parsePlain(view,markdown.replace(saved[0][0],''));
  const updated=Editor.applyEdit({document:view,edit:changes,currentRevision:document.baseRevision});
  return editFromApplied(document,updated);
}
module.exports={supports,render,renderEdited,parse,editFromApplied};
