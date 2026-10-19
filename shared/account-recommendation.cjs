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
  context.instructions = [
    '仅从 allowedPairs 的完整类别与科目配对中给出建议，不跨配对拼接、不编造目录项；候选顺序不代表推荐顺序。',
    '已有明确输入出现冲突时，询问相关业务事实或请员工澄清，不能用建议静默覆盖明确输入。',
    '用途足够明确时，Agent 必须从合法配对中主动建议类别与科目，按 categoryInputKey / accountInputKey 回填当前明细草稿，并附简短依据；不能仅返回目录、让员工自行查目录，或把分类推迟到最终预览。',
    '只有用途等关键业务事实不足或明确输入冲突时允许不推荐，此时说明具体缺项并集中补问；已知用途不能跳过建议，待补行也应保留在当前明细草稿中。',
    '不要生成概率评分；建议不是员工确认，即使只有一个合法配对也不代表获得提交授权。'
  ];
  return context;
}

module.exports = {buildRecommendationContext};
