'use strict';

const {check} = require('../scripts/lib/common.cjs');
const object = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function optionalText(value) {
  if (value === undefined || value === null || value === '') return undefined;
  check(typeof value === 'string', 'RECOMMENDATION_INPUT_INVALID');
  return value.trim() ? value : undefined;
}

// Carries already-authorized catalog pairs to the conversational agent. This
// tool neither queries a catalog nor ranks, recommends, or selects a pair.
function buildRecommendationContext(options) {
  check(object(options), 'RECOMMENDATION_INPUT_INVALID');
  const {scope, description, pairs, categoryInputKey, accountInputKey} = options;
  check(nonempty(scope) && typeof description === 'string'
    && nonempty(categoryInputKey) && nonempty(accountInputKey), 'RECOMMENDATION_INPUT_INVALID');
  check(Array.isArray(pairs), 'RECOMMENDATION_PAIRS_INVALID');

  const explicitCategory = optionalText(options.explicitCategory);
  const explicitAccount = optionalText(options.explicitAccount);
  const fixedCategory = optionalText(options.fixedCategory);
  const unique = new Map();
  for (const pair of pairs) {
    check(object(pair) && Object.keys(pair).length === 2
      && nonempty(pair.category) && nonempty(pair.account), 'RECOMMENDATION_PAIRS_INVALID');
    const key = JSON.stringify([pair.category, pair.account]);
    if (!unique.has(key)) unique.set(key, {category: pair.category, account: pair.account});
  }

  let allowedPairs = [...unique.values()];
  if (fixedCategory !== undefined) {
    allowedPairs = allowedPairs.filter(pair => pair.category === fixedCategory);
    check(allowedPairs.length > 0, 'RECOMMENDATION_FIXED_CATEGORY_INVALID');
  }
  const conflicts = [];
  if (explicitCategory !== undefined) {
    const matching = allowedPairs.filter(pair => pair.category === explicitCategory);
    if (matching.length) allowedPairs = matching;
    else conflicts.push('category');
  }
  if (explicitAccount !== undefined && !allowedPairs.some(pair => pair.account === explicitAccount)) {
    conflicts.push('account');
  }

  const context = {scope, description, categoryInputKey, accountInputKey, allowedPairs};
  if (explicitCategory !== undefined) context.explicitCategory = explicitCategory;
  if (explicitAccount !== undefined) context.explicitAccount = explicitAccount;
  if (fixedCategory !== undefined) context.fixedCategory = fixedCategory;
  context.conflicts = conflicts;
  // A complete legal draft still carries its scoped catalog. These are
  // conversational candidates, never extra values to write into a form row.
  const selectedCategory = fixedCategory ?? explicitCategory;
  const current = conflicts.length ? undefined : allowedPairs.find(pair =>
    pair.category === selectedCategory && pair.account === explicitAccount);
  context.currentSelection = current ? {...current} : null;
  context.alternativePairs = current ? allowedPairs.filter(pair =>
    pair.category !== current.category || pair.account !== current.account).map(pair => ({...pair})) : [];
  context.instructions = [
    '仅从 allowedPairs 的完整类别与科目配对中给出建议，不跨配对拼接、不编造目录项；候选顺序不代表推荐顺序。',
    '已有明确输入出现冲突时，询问相关业务事实或请员工澄清，不能用建议静默覆盖明确输入。',
    '用途足够明确时，Agent 必须从合法配对中主动建议一组类别与科目，按 categoryInputKey / accountInputKey 回填当前明细草稿，并附简短依据；保留员工已有合法明确选择。不能仅返回目录、让员工自行查目录，或把分类推迟到最终预览。',
    '草稿每行实际值只能有一组类别与科目。currentSelection 是当前合法选择；alternativePairs 仅是其范围内尚未排序的合法候选，不代表都适合本次用途。结合用途有合理备选时，在表外按行号单独提示另一组科目及简短理由，询问是否替换；供应商主表分类单独标明，不混入费用明细。无合理备选不凑数量、不重复推销员工已明确选择。',
    '员工接受推荐，或对已展示草稿明确指定替换某行且其余保持时，校验并简短回显后继续，不重问未改行。此选择只覆盖员工看到并指定的明细变更，不授权最终提交；来源、金额、材料或其他行发生额外变化时仍需核对实际变化，最终完整申请另等新的提交确认。',
    '项目类别是主表共用值，备选仅限当前固定项目类别。员工显式改共同类别时重新核对全部受影响行，不能声称只改了一行；固定科目不开放选择。备选、评分或说明不能作为额外科目值混入业务输入或提交数据。',
    '只有用途等关键业务事实不足或明确输入冲突时允许不推荐，此时说明具体缺项并集中补问；已知用途不能跳过建议，待补行也应保留在当前明细草稿中。',
    '不要生成概率评分；建议不是员工确认，即使只有一个合法配对也不代表获得提交授权。'
  ];
  return context;
}

module.exports = {buildRecommendationContext};
