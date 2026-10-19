'use strict';

// Dates are local midnight milliseconds in the existing +08:00 business clock.
// Balance limits and workflow-specific minimum durations belong to the caller.
const DAY = 86400000;
const OFFSET = 8 * 3600000;
function check(ok, code, message) {
  if (!ok) throw Object.assign(new Error(message || code), {code});
}
function absent(value) { return value === undefined || value === null || value === ''; }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function values(value) {
  if (absent(value)) return [];
  if (Array.isArray(value)) return value.flatMap(values);
  if (object(value)) return ['label','name','value','key'].flatMap(key => absent(value[key]) ? [] : values(value[key]));
  check(typeof value === 'string' || typeof value === 'number', 'SOURCE_VALUE_INVALID');
  return [String(value).trim()].filter(Boolean);
}
function exact(value, wanted) {
  const normalized = item => String(item).normalize('NFKC').trim().toLocaleLowerCase('en-US');
  return values(value).some(item => normalized(item) === normalized(wanted));
}
function sourceDate(value) {
  const code = 'WORK_CALENDAR_INVALID';
  if (object(value)) value = value.value ?? value.key;
  if (Array.isArray(value)) { check(value.length === 1, code); value = value[0]; }
  // Preserve the existing calendar source coercion and validation contract.
  if (object(value)) value = value.value ?? value.key;
  if (Array.isArray(value)) { check(value.length === 1, code); value = value[0]; }
  check((typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)), code, '数值缺失或无效。');
  const result = Number(value);
  check(Number.isSafeInteger(result) && result >= 1e12, code, '资料来源日期无效，请联系管理员。');
  return result;
}
function weekdayCount(start, end) {
  const inclusive = (end - start) / DAY + 1;
  let days = Math.floor(inclusive / 7) * 5;
  for (let i = 0; i < inclusive % 7; i++) {
    const weekday = new Date(start + i * DAY + OFFSET).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days++;
  }
  return days;
}

function calculateLeave({start, end, startPeriod, endPeriod, mode, calendarAdjustment = 0}) {
  check(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end > 0 &&
    Number.isFinite(new Date(start).getTime()) && Number.isFinite(new Date(end).getTime()), 'DATE_INVALID', '日期无效。');
  check(end >= start, 'DATE_RANGE_INVALID', '结束日期不能早于开始日期。');
  check(Number.isInteger((end - start) / DAY), 'DATE_INVALID', '日期无效。');
  check(mode === 'workdays' || mode === 'calendar', 'LEAVE_CALENDAR_MODE_INVALID');
  for (const period of [startPeriod, endPeriod]) check(absent(period) || ['上午','下午'].includes(period), 'INPUT_PERIOD_INVALID', '请选择上午或下午。');
  check(!(start === end && startPeriod === '下午' && endPeriod === '上午'), 'PERIOD_RANGE_INVALID', '结束时段不能早于开始时段。');
  const workdays = weekdayCount(start, end);
  const baseDays = mode === 'calendar' ? (end - start) / DAY + 1 : workdays;
  const adjustment = mode === 'calendar' ? 0 : calendarAdjustment;
  check(typeof adjustment === 'number' && Number.isFinite(adjustment), 'WORK_CALENDAR_INVALID');
  const halfDayDeduction = (startPeriod === '下午' ? 0.5 : 0) + (endPeriod === '上午' ? 0.5 : 0);
  return {baseDays, workdays, calendarAdjustment:adjustment, halfDayDeduction, days:baseDays - adjustment - halfDayDeduction};
}

// Source identifiers come from fixed workflow configuration; ctx enforces its
// existing source/column allowlist. Natural-day callers do not call this helper.
async function queryCalendar(ctx, source, group, start, end) {
  const rows = await ctx.query(source.form, {[source.group]:group, [source.date]:[start,end]}, [source.group,source.date,source.kind]);
  check(Array.isArray(rows), 'WORK_CALENDAR_INVALID');
  let sum = 0;
  const adjustments = [];
  for (const row of rows) {
    check(exact(row[source.group], group), 'WORK_CALENDAR_SCOPE_MISMATCH');
    const day = sourceDate(row[source.date]);
    check(day >= start && day <= end, 'WORK_CALENDAR_SCOPE_MISMATCH');
    const kinds = values(row[source.kind]);
    const rest = kinds.some(x => ['休息日','1','+1'].includes(x));
    const makeup = kinds.some(x => ['调配工作日','調配工作日','-1'].includes(x));
    check(rest !== makeup, 'WORK_CALENDAR_KIND_INVALID', '节假日调整数据无效，请联系 HR。');
    const value = rest ? 1 : -1;
    sum += value;
    adjustments.push({date:new Date(day + OFFSET).toISOString().slice(0,10), kind:rest ? '休息日' : '调配工作日', adjustment:value});
  }
  return {sum, adjustments};
}

module.exports = {calculateLeave, queryCalendar};
