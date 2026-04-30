'use strict';

/** Parse app_settings JSON / string / number values as boolean (not `Boolean()` on strings). */
function parseSettingBool(raw, defaultVal = false) {
  if (raw === undefined || raw === null) return defaultVal;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0' || s === '') return false;
  }
  return Boolean(raw);
}

module.exports = { parseSettingBool };
