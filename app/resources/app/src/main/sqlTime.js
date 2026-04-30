'use strict';

/** Match db.parse_iso_utc_to_storage — store UTC-naive ISO text in DB columns. */
function parseIsoUtcToStorage(s) {
  const raw = String(s || '').trim();
  if (!raw) throw new Error('Empty ISO timestamp');
  let t = raw.endsWith('Z') ? raw.slice(0, -1) + '+00:00' : raw;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ISO: ${s}`);
  return d.toISOString().replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
}

function nowIsoZ() {
  return new Date().toISOString();
}

module.exports = {
  parseIsoUtcToStorage,
  nowIsoZ
};
