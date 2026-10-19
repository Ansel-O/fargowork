'use strict';
const {check} = require('../scripts/lib/common.cjs');

// Parse a local minute with an explicit offset; never use the host timezone.
function localMinute(value, offsetMinutes) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(value), 'LOCAL_MINUTE_INVALID');
  check(Number.isInteger(offsetMinutes) && Math.abs(offsetMinutes) <= 14 * 60, 'TIMEZONE_OFFSET_INVALID');
  const normalized = value.replace(' ', 'T');
  const local = Date.parse(normalized + ':00Z');
  check(Number.isFinite(local) && new Date(local).toISOString().slice(0,16) === normalized, 'LOCAL_MINUTE_INVALID');
  return local - offsetMinutes * 60000;
}
module.exports = {localMinute};
