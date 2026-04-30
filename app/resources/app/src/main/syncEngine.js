'use strict';

/**
 * Cloud sync (D1 USER_DATA_DB via Worker): sync_outbox → POST /v1/sync/push, GET /v1/sync/pull.
 * Mirrors classic Python sync_engine behavior (time_entry + session_activity with stable UUIDs).
 */

const crypto = require('crypto');
const licenseService = require('./licenseService');
const { run, get, all } = require('./sqliteUtil');
const { nowUtcIsoText } = require('./migrate');

const SYNC_LAST_PULL_MS_KEY = 'sync_last_pull_ms';
/** Tie-break cursor for GET /v1/sync/pull (pairs with sync_last_pull_ms); empty string = start of slice at since_ms. */
const SYNC_LAST_PULL_AFTER_ID_KEY = 'sync_last_pull_after_id';
const SYNC_SQLITE_HISTORY_BACKFILLED_KEY = 'sync_sqlite_history_backfilled_v2';
const BF_TE = 'bf-te-';
const BF_SE = 'bf-se-';
const MAX_BATCH = 50;
const MAX_PULL = 200;
/** Must match Worker `LIMIT` on GET /v1/sync/pull (keep multi-page pulls in sync). */
const SERVER_PULL_LIMIT = 200;

let _syncDebounce = null;

async function settingsGet(db, key, defaultVal) {
  try {
    const row = await get(db, 'SELECT value FROM app_settings WHERE key = ?', [key]);
    if (!row || row.value === undefined || row.value === null) return defaultVal;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  } catch {
    return defaultVal;
  }
}

async function settingsSet(db, key, value) {
  await run(
    db,
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)]
  );
}

function sessionBearer() {
  const s = licenseService.loadSession();
  const t = s && s.access_token ? String(s.access_token).trim() : '';
  return t || null;
}

async function enqueueMutation(db, userId, entityType, entityKey, op, payload, clientMutationId = null) {
  const cmid = ((clientMutationId && String(clientMutationId).trim()) || crypto.randomUUID()).slice(0, 120);
  const payloadJson = JSON.stringify(payload);
  const r = await run(
    db,
    `INSERT OR IGNORE INTO sync_outbox (
      client_mutation_id, user_id, entity_type, entity_key, op, payload_json, created_at_utc, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [cmid, userId, entityType.slice(0, 120), entityKey.slice(0, 500), op, payloadJson, nowUtcIsoText()]
  );
  if (!r.changes) return null;
  return cmid;
}

function timeEntryPayloadFromRow(row) {
  const tagIds = Array.isArray(row.tag_ids) ? row.tag_ids : [];
  return {
    client_uuid: String(row.client_uuid || '').trim(),
    machine_session_id: row.machine_session_id,
    start_utc: String(row.start_utc || ''),
    end_utc: String(row.end_utc || ''),
    category: String(row.category || 'work'),
    description: String(row.description || ''),
    created_at: String(row.created_at || ''),
    work_category_id: row.work_category_id,
    project_id: row.project_id,
    notes: row.notes,
    billable: row.billable,
    hourly_rate_cents: row.hourly_rate_cents,
    amount_cents: row.amount_cents,
    currency: String(row.currency || 'USD'),
    business_id: row.business_id,
    tag_ids: tagIds
  };
}

async function fetchTimeEntryForSync(db, userId, entryId) {
  const row = await get(
    db,
    `SELECT id, user_id, machine_session_id, start_utc, end_utc, category, description, created_at,
            work_category_id, project_id, notes, billable, hourly_rate_cents, amount_cents, currency,
            business_id, client_uuid
     FROM rr_time_entries WHERE id = ? AND user_id = ?`,
    [entryId, userId]
  );
  if (!row) return null;
  const tags = await all(db, 'SELECT tag_id FROM time_entry_tags WHERE time_entry_id = ? ORDER BY tag_id', [entryId]);
  row.tag_ids = tags.map((t) => t.tag_id);
  return row;
}

async function enqueueTimeEntrySnapshot(db, userId, entryId) {
  const row = await fetchTimeEntryForSync(db, userId, entryId);
  if (!row) return;
  const payload = timeEntryPayloadFromRow(row);
  const cu = String(payload.client_uuid || '').trim();
  if (!cu) return;
  await enqueueMutation(db, userId, 'time_entry', `time_entry:${cu}`, 'upsert', payload);
}

async function enqueueTimeEntryDelete(db, userId, clientUuid) {
  const cu = String(clientUuid || '').trim();
  if (!cu) return;
  await enqueueMutation(db, userId, 'time_entry', `time_entry:${cu}`, 'delete', { client_uuid: cu });
}

function sessionEventPayloadFromRow(row) {
  return {
    client_event_uuid: String(row.client_event_uuid || '').trim(),
    event_type: String(row.event_type || ''),
    detail: String(row.detail || ''),
    created_at_utc: String(row.created_at_utc || '')
  };
}

async function fetchSessionEventForSync(db, userId, eventRowId) {
  return get(
    db,
    `SELECT id, user_id, event_type, detail, created_at_utc, client_event_uuid
     FROM rr_session_events WHERE id = ? AND user_id = ?`,
    [eventRowId, userId]
  );
}

async function enqueueSessionEventSnapshot(db, userId, eventRowId) {
  const row = await fetchSessionEventForSync(db, userId, eventRowId);
  if (!row) return;
  const payload = sessionEventPayloadFromRow(row);
  const cu = payload.client_event_uuid;
  if (!cu) return;
  await enqueueMutation(db, userId, 'session_activity', `session:${cu}`, 'upsert', payload);
}

async function enqueueSessionEventDelete(db, userId, clientEventUuid) {
  const cu = String(clientEventUuid || '').trim();
  if (!cu) return;
  await enqueueMutation(db, userId, 'session_activity', `session:${cu}`, 'delete', { client_event_uuid: cu });
}

async function pendingOutboxCount(db) {
  const row = await get(db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'pending'");
  return row && row.n ? parseInt(row.n, 10) : 0;
}

async function flushSyncOutbox(db) {
  const bearer = sessionBearer();
  const baseUrl = licenseService.getLicenseApiBaseUrl();
  if (!bearer || !baseUrl) return 0;

  let deviceId;
  try {
    deviceId = licenseService.loadOrCreateDeviceId();
  } catch {
    return 0;
  }

  const rows = await all(
    db,
    `SELECT id, client_mutation_id, user_id, entity_type, entity_key, op, payload_json
     FROM sync_outbox WHERE status = 'pending' ORDER BY id LIMIT ?`,
    [MAX_BATCH]
  );
  if (!rows.length) return 0;

  const events = rows.map((r) => {
    let payload = {};
    try {
      payload = JSON.parse(r.payload_json);
    } catch {
      payload = {};
    }
    return {
      client_mutation_id: r.client_mutation_id,
      entity_type: r.entity_type,
      entity_key: r.entity_key,
      op: r.op === 'delete' ? 'delete' : 'upsert',
      payload
    };
  });

  const rowIds = rows.map((r) => r.id);
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/sync/push`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`
      },
      body: JSON.stringify({ device_id: deviceId, events })
    });
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    const ph = rowIds.map(() => '?').join(',');
    await run(
      db,
      `UPDATE sync_outbox SET status = 'failed', last_error = ?, attempt_count = attempt_count + 1 WHERE id IN (${ph})`,
      [msg, ...rowIds]
    );
    return 0;
  }

  if (res.status === 401) {
    console.warn('[sync] push rejected (401) — session may be expired; outbox rows stay pending');
    return 0;
  }

  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  if (!res.ok) {
    const msg = String(body.error?.message || body.message || res.status).slice(0, 500);
    const ph = rowIds.map(() => '?').join(',');
    await run(
      db,
      `UPDATE sync_outbox SET status = 'failed', last_error = ?, attempt_count = attempt_count + 1 WHERE id IN (${ph})`,
      [msg, ...rowIds]
    );
    return 0;
  }

  const accepted = Number(body.accepted != null ? body.accepted : events.length);
  const ph = rowIds.map(() => '?').join(',');
  await run(db, `UPDATE sync_outbox SET status = 'sent', last_error = NULL, attempt_count = attempt_count + 1 WHERE id IN (${ph})`, rowIds);

  return Math.min(accepted, events.length);
}

async function flushSyncOutboxUntilEmpty(db, maxRounds = 100000) {
  let total = 0;
  for (let i = 0; i < maxRounds; i++) {
    const n = await flushSyncOutbox(db);
    total += n;
    if (n === 0) break;
  }
  return total;
}

async function isMutationApplied(db, cmid) {
  const row = await get(db, 'SELECT 1 FROM sync_applied_remote WHERE client_mutation_id = ?', [String(cmid).slice(0, 200)]);
  return Boolean(row);
}

async function markMutationApplied(db, cmid, reason) {
  await run(
    db,
    `INSERT OR IGNORE INTO sync_applied_remote (client_mutation_id, applied_at_utc, reason) VALUES (?, ?, ?)`,
    [String(cmid).slice(0, 200), nowUtcIsoText(), String(reason || 'applied').slice(0, 80)]
  );
}

async function upsertSessionEventFromRemote(db, userId, payload) {
  const cu = String(payload.client_event_uuid || '').trim();
  if (!cu) return false;
  const et = String(payload.event_type || 'activity').slice(0, 200);
  const detail = String(payload.detail || '').slice(0, 5000);
  const catRaw = String(payload.created_at_utc || '').trim();
  const when = catRaw || nowUtcIsoText();
  const ex = await get(db, 'SELECT id FROM rr_session_events WHERE user_id = ? AND client_event_uuid = ?', [userId, cu]);
  if (ex) {
    await run(
      db,
      `UPDATE rr_session_events SET event_type = ?, detail = ?, created_at_utc = ? WHERE id = ? AND user_id = ?`,
      [et, detail, when, ex.id, userId]
    );
  } else {
    await run(
      db,
      `INSERT INTO rr_session_events (user_id, event_type, detail, created_at_utc, client_event_uuid)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, et, detail, when, cu]
    );
  }
  return true;
}

async function deleteSessionEventByClientUuidForSync(db, userId, clientEventUuid) {
  const cu = String(clientEventUuid || '').trim();
  if (!cu) return false;
  const r = await run(db, 'DELETE FROM rr_session_events WHERE user_id = ? AND client_event_uuid = ?', [userId, cu]);
  return r.changes > 0;
}

async function deleteTimeEntryByClientUuidForSync(db, userId, clientUuid) {
  const cu = String(clientUuid || '').trim();
  if (!cu) return false;
  const r = await run(db, 'DELETE FROM rr_time_entries WHERE user_id = ? AND client_uuid = ?', [userId, cu]);
  return r.changes > 0;
}

async function upsertTimeEntryFromRemotePayload(db, userId, payload) {
  const clientUuid = String(payload.client_uuid || '').trim();
  if (!clientUuid) return false;
  const startUtc = String(payload.start_utc || '').trim();
  const endUtc = String(payload.end_utc || '').trim();
  if (!startUtc || !endUtc) return false;

  let category = String(payload.category || 'work').toLowerCase();
  if (category !== 'evaluation' && category !== 'work') category = 'work';

  const existing = await get(db, 'SELECT id FROM rr_time_entries WHERE user_id = ? AND client_uuid = ?', [
    userId,
    clientUuid
  ]);

  const common = [
    payload.machine_session_id ?? null,
    startUtc,
    endUtc,
    category,
    String(payload.description || ''),
    String(payload.created_at || '').trim() || nowUtcIsoText(),
    payload.work_category_id ?? null,
    payload.project_id ?? null,
    payload.notes ?? null,
    payload.billable != null ? payload.billable : 1,
    payload.hourly_rate_cents ?? null,
    payload.amount_cents ?? null,
    String(payload.currency || 'USD'),
    payload.business_id ?? null
  ];

  async function applyTags(entryId) {
    await run(db, 'DELETE FROM time_entry_tags WHERE time_entry_id = ?', [entryId]);
    const tagIds = Array.isArray(payload.tag_ids) ? payload.tag_ids : [];
    for (const tid of tagIds) {
      const t = parseInt(tid, 10);
      if (Number.isFinite(t)) {
        await run(db, 'INSERT OR IGNORE INTO time_entry_tags (time_entry_id, tag_id) VALUES (?, ?)', [entryId, t]);
      }
    }
  }

  if (existing) {
    await run(
      db,
      `UPDATE rr_time_entries SET
        machine_session_id = ?, start_utc = ?, end_utc = ?, category = ?, description = ?, created_at = ?,
        work_category_id = ?, project_id = ?, notes = ?, billable = ?, hourly_rate_cents = ?, amount_cents = ?,
        currency = ?, business_id = ?
       WHERE id = ? AND user_id = ?`,
      [...common, existing.id, userId]
    );
    await applyTags(existing.id);
  } else {
    const r = await run(
      db,
      `INSERT INTO rr_time_entries
        (user_id, machine_session_id, start_utc, end_utc, category, description, created_at,
         work_category_id, project_id, notes, billable, hourly_rate_cents, amount_cents, currency, business_id, client_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, ...common, clientUuid]
    );
    await applyTags(r.lastID);
  }
  return true;
}

async function applyPulledEvents(db, events, localUserId) {
  const licenseServiceInner = require('./licenseService');
  let myDevice = '';
  try {
    myDevice = licenseServiceInner.loadOrCreateDeviceId();
  } catch {
    myDevice = '';
  }

  let applied = 0;
  const list = Array.isArray(events) ? events.slice(0, MAX_PULL) : [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    let cmid = raw.client_mutation_id;
    if (typeof cmid !== 'string' || !cmid.trim()) continue;
    cmid = cmid.trim().slice(0, 200);

    if (await isMutationApplied(db, cmid)) continue;

    const dev = raw.device_id;
    if (typeof dev === 'string' && dev.trim() && dev.trim() === myDevice) {
      await markMutationApplied(db, cmid, 'same_device');
      continue;
    }

    const entity = String(raw.entity_type || '');
    const op = String(raw.op || 'upsert');
    let payload = raw.payload;
    if (!payload || typeof payload !== 'object') payload = {};

    try {
      if (entity === 'session_activity' && op === 'delete') {
        const cu = String(payload.client_event_uuid || '').trim();
        if (!cu) {
          await markMutationApplied(db, cmid, 'skipped_bad_payload');
          continue;
        }
        await deleteSessionEventByClientUuidForSync(db, localUserId, cu);
        await markMutationApplied(db, cmid, 'applied');
        applied += 1;
      } else if (entity === 'session_activity' && op !== 'delete') {
        const cu = String(payload.client_event_uuid || '').trim();
        if (cu) {
          const ok = await upsertSessionEventFromRemote(db, localUserId, payload);
          if (!ok) {
            await markMutationApplied(db, cmid, 'skipped_apply_failed');
            continue;
          }
        } else {
          const et = String(payload.event_type || 'activity');
          const detail = String(payload.detail || '').slice(0, 5000);
          const catRaw = payload.created_at_utc;
          const catS = catRaw != null ? String(catRaw).trim() : null;
          await run(
            db,
            `INSERT INTO rr_session_events (user_id, event_type, detail, created_at_utc, client_event_uuid)
             VALUES (?, ?, ?, ?, ?)`,
            [localUserId, et, detail, catS || nowUtcIsoText(), crypto.randomUUID()]
          );
        }
        await markMutationApplied(db, cmid, 'applied');
        applied += 1;
      } else if (entity === 'time_entry' && op === 'delete') {
        const cu = String(payload.client_uuid || '').trim();
        if (!cu) {
          await markMutationApplied(db, cmid, 'skipped_bad_payload');
          continue;
        }
        await deleteTimeEntryByClientUuidForSync(db, localUserId, cu);
        await markMutationApplied(db, cmid, 'applied');
        applied += 1;
      } else if (entity === 'time_entry' && op !== 'delete') {
        const ok = await upsertTimeEntryFromRemotePayload(db, localUserId, payload);
        if (!ok) {
          await markMutationApplied(db, cmid, 'skipped_apply_failed');
          continue;
        }
        await markMutationApplied(db, cmid, 'applied');
        applied += 1;
      } else {
        await markMutationApplied(db, cmid, 'skipped_unsupported');
      }
    } catch {
      await markMutationApplied(db, cmid, 'skipped_apply_failed');
    }
  }

  return applied;
}

async function pullRemoteChanges(db, localUserId) {
  const bearer = sessionBearer();
  const baseUrl = licenseService.getLicenseApiBaseUrl();
  if (!bearer || !baseUrl) return { received: 0, applied: 0 };

  let sinceMs = 0;
  try {
    const raw = await settingsGet(db, SYNC_LAST_PULL_MS_KEY, '0');
    sinceMs = parseInt(String(raw || '0').trim(), 10) || 0;
  } catch {
    sinceMs = 0;
  }

  let afterId = '';
  try {
    const aid = await settingsGet(db, SYNC_LAST_PULL_AFTER_ID_KEY, '');
    afterId = String(aid || '').trim().slice(0, 128);
  } catch {
    afterId = '';
  }

  let totalReceived = 0;
  let totalApplied = 0;

  for (;;) {
    const params = new URLSearchParams();
    params.set('since_ms', String(sinceMs));
    if (afterId) params.set('after_id', afterId);

    const url = `${baseUrl.replace(/\/+$/, '')}/v1/sync/pull?${params.toString()}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${bearer}` }
      });
    } catch {
      break;
    }

    if (res.status === 401) {
      console.warn('[sync] pull rejected (401) — session may be expired');
      break;
    }

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (!res.ok) break;

    const evs = Array.isArray(data.events) ? data.events : [];
    totalReceived += evs.length;
    totalApplied += await applyPulledEvents(db, evs, localUserId);

    if (evs.length === 0) break;

    const last = evs[evs.length - 1];
    const ct = typeof last.created_at === 'number' ? last.created_at : sinceMs;
    const lid = typeof last.id === 'string' ? last.id.trim().slice(0, 128) : '';

    sinceMs = ct;
    afterId = lid;
    await settingsSet(db, SYNC_LAST_PULL_MS_KEY, String(sinceMs));
    await settingsSet(db, SYNC_LAST_PULL_AFTER_ID_KEY, afterId);

    if (evs.length < SERVER_PULL_LIMIT) break;
    if (!lid) break;
  }

  return { received: totalReceived, applied: totalApplied };
}

async function backfillSyncOutboxFromTables(db, userId) {
  const uid = parseInt(userId, 10) || 1;
  let nTime = 0;
  let nSess = 0;

  const timeRows = await all(
    db,
    `SELECT id FROM rr_time_entries
     WHERE user_id = ? AND client_uuid IS NOT NULL AND trim(client_uuid) != ''
     ORDER BY id`,
    [uid]
  );
  for (const { id } of timeRows) {
    const row = await fetchTimeEntryForSync(db, uid, id);
    if (!row) continue;
    const cu = String(row.client_uuid || '').trim();
    if (!cu) continue;
    const cmid = `${BF_TE}${cu}`.slice(0, 120);
    const payload = timeEntryPayloadFromRow(row);
    const ins = await enqueueMutation(db, uid, 'time_entry', `time_entry:${cu}`, 'upsert', payload, cmid);
    if (ins) nTime += 1;
  }

  const sessRows = await all(
    db,
    `SELECT client_event_uuid, event_type, detail, created_at_utc FROM rr_session_events
     WHERE user_id = ? AND client_event_uuid IS NOT NULL AND trim(client_event_uuid) != ''
     ORDER BY id`,
    [uid]
  );
  for (const r of sessRows) {
    const cu = String(r.client_event_uuid || '').trim();
    if (!cu) continue;
    const cmid = `${BF_SE}${cu}`.slice(0, 120);
    const payload = {
      client_event_uuid: cu,
      event_type: String(r.event_type || '').slice(0, 200),
      detail: String(r.detail || '').slice(0, 4000),
      created_at_utc: String(r.created_at_utc || '').trim()
    };
    const ins = await enqueueMutation(db, uid, 'session_activity', `session:${cu}`, 'upsert', payload, cmid);
    if (ins) nSess += 1;
  }

  return { nTime, nSess };
}

function localDbPathForSyncStatus() {
  try {
    return require('./database').getDbPath();
  } catch {
    return null;
  }
}

async function syncCycleBestEffort(db, localUserId = 1) {
  const uid = parseInt(localUserId, 10) || 1;
  const bearer = sessionBearer();
  const baseUrl = licenseService.getLicenseApiBaseUrl();
  const hasSessionToken = Boolean(bearer);
  const hasApiBaseUrl = Boolean(String(baseUrl || '').trim());
  const syncConfigured = Boolean(bearer && baseUrl);
  const localDbPath = localDbPathForSyncStatus();

  let nOut = 0;

  const done = await settingsGet(db, SYNC_SQLITE_HISTORY_BACKFILLED_KEY, false);
  if (!done) {
    let bfOk = true;
    try {
      await backfillSyncOutboxFromTables(db, uid);
    } catch {
      bfOk = false;
    }
    nOut = await flushSyncOutboxUntilEmpty(db);
    const pend = await pendingOutboxCount(db);
    if (bfOk && pend === 0) {
      await settingsSet(db, SYNC_SQLITE_HISTORY_BACKFILLED_KEY, true);
    }
  } else {
    nOut = await flushSyncOutbox(db);
  }

  const pull = await pullRemoteChanges(db, uid);
  const pendingOutbox = await pendingOutboxCount(db);
  const failedRow = await get(
    db,
    `SELECT last_error FROM sync_outbox
     WHERE status = 'failed' AND ifnull(trim(last_error), '') != ''
     ORDER BY id DESC LIMIT 1`
  );
  const lastSyncError = failedRow && failedRow.last_error ? String(failedRow.last_error).slice(0, 240) : null;

  return {
    pushed: nOut,
    pulled: pull.received,
    applied: pull.applied,
    syncConfigured,
    hasSessionToken,
    hasApiBaseUrl,
    localDbPath,
    pendingOutbox,
    lastSyncError
  };
}

function scheduleSync(db, userId = 1) {
  if (_syncDebounce) clearTimeout(_syncDebounce);
  _syncDebounce = setTimeout(() => {
    _syncDebounce = null;
    syncCycleBestEffort(db, userId).catch(() => {});
  }, 900);
}

async function clearHistoryBackfilledFlag(db) {
  await settingsSet(db, SYNC_SQLITE_HISTORY_BACKFILLED_KEY, false);
}

/**
 * After cloud queue is wiped, reset pull cursors and local sync metadata so this device can re-push from SQLite
 * and accept fresh events from other devices without stale apply-dedupe blocking merges.
 */
async function clearLocalSyncAfterCloudDelete(db, localUserId) {
  const uid = parseInt(localUserId, 10) || 1;
  await settingsSet(db, SYNC_LAST_PULL_MS_KEY, '0');
  await settingsSet(db, SYNC_LAST_PULL_AFTER_ID_KEY, '');
  await settingsSet(db, SYNC_SQLITE_HISTORY_BACKFILLED_KEY, false);
  await run(db, 'DELETE FROM sync_applied_remote');
  await run(db, 'DELETE FROM sync_outbox WHERE user_id = ?', [uid]);
}

module.exports = {
  enqueueMutation,
  enqueueTimeEntrySnapshot,
  enqueueTimeEntryDelete,
  enqueueSessionEventSnapshot,
  enqueueSessionEventDelete,
  syncCycleBestEffort,
  scheduleSync,
  clearHistoryBackfilledFlag,
  clearLocalSyncAfterCloudDelete,
  fetchTimeEntryForSync,
  SYNC_SQLITE_HISTORY_BACKFILLED_KEY
};
