'use strict';

const { get, all, run } = require('./sqliteUtil');
const {
  utcNaiveBoundsForLocalToday,
  utcNaiveBoundsForCalendarDay,
  utcNaiveBoundsForLocalReportRange,
  computeDashboardWindows,
  computeDashboardSegments,
  nowInReportingZone
} = require('./timezone');
const { nowUtcIsoText } = require('./migrate');
const { parseSettingBool } = require('./settingBool');
const licenseService = require('./licenseService');
const syncEngine = require('./syncEngine');
const { rebuildTrackingStateFromSessionEvents } = require('./trackingHandlers');

async function makeCtx(db, userId, activeBusinessIdOverride) {
  async function settingsGet(key, defVal) {
    let row;
    try {
      row = await get(db, 'SELECT value FROM app_settings WHERE key = ?', [key]);
    } catch {
      return defVal;
    }
    if (!row) return defVal;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  const multi = parseSettingBool(await settingsGet('multi_business_enabled', false));
  let bid = activeBusinessIdOverride;
  if (bid === undefined || bid === null) {
    const raw = await settingsGet('active_business_id', 1);
    bid = parseInt(String(raw), 10);
    if (Number.isNaN(bid)) bid = 1;
  }
  /** Single-business mode: all data uses one business context (never Master id 0). */
  if (!multi && bid <= 0) {
    bid = 1;
  }

  function businessFragment(tableAlias) {
    if (!multi) return { sql: '', params: [] };
    if (bid <= 0) return { sql: '', params: [] };
    const col = tableAlias ? `${tableAlias}.business_id` : 'business_id';
    return { sql: ` AND COALESCE(${col}, 1) = ?`, params: [bid] };
  }

  function isMaster() {
    return multi && bid === 0;
  }

  function requireWritable() {
    if (isMaster()) {
      throw new Error('The combined view is read-only. Choose a single business to save changes.');
    }
    return bid;
  }

  return { db, userId, settingsGet, businessFragment, isMaster, requireWritable };
}

function clipInterval(loMs, hiMs, w0Ms, w1Ms) {
  const s = Math.max(loMs, w0Ms);
  const e = Math.min(hiMs, w1Ms);
  if (e <= s) return null;
  return [s, e];
}

function mergedIntervalsSecondsUnion(intervalsMs) {
  if (!intervalsMs.length) return 0;
  const sorted = [...intervalsMs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let acc = 0;
  let curS = sorted[0][0];
  let curE = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curE) curE = Math.max(curE, e);
    else {
      acc += (curE - curS) / 1000;
      curS = s;
      curE = e;
    }
  }
  acc += (curE - curS) / 1000;
  return acc;
}

async function unionTimeSecondsBetween(ctx, startUtc, endUtc) {
  const { db, userId, businessFragment } = ctx;
  const bf = businessFragment('t');
  const rows = await all(
    db,
    `SELECT CASE
         WHEN LOWER(TRIM(COALESCE(t.category, ''))) = 'break' THEN 'Break'
         ELSE COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(t.category), ''), 'Development')
       END AS task_name,
       t.start_utc, t.end_utc, t.category
     FROM rr_time_entries t
     LEFT JOIN work_categories c ON c.id = t.work_category_id
     WHERE t.user_id = ? AND t.start_utc < ? AND t.end_utc > ? ${bf.sql}
     ORDER BY t.start_utc ASC, t.id ASC`,
    [userId, endUtc, startUtc, ...bf.params]
  );
  const w0 = new Date(startUtc).getTime();
  const w1 = new Date(endUtc).getTime();
  const clips = [];
  for (const r of rows) {
    const tname = String(r.task_name || '').trim();
    const lcat = String(r.category || '').trim();
    if (tname.toLowerCase() === 'break' || lcat.toLowerCase() === 'break') continue;
    const sa = new Date(String(r.start_utc)).getTime();
    const eb = new Date(String(r.end_utc)).getTime();
    const cl = clipInterval(sa, eb, w0, w1);
    if (cl) clips.push(cl);
  }
  return mergedIntervalsSecondsUnion(clips);
}

async function summaryBetween(ctx, startUtc, endUtc) {
  const { db, userId, businessFragment } = ctx;
  const incBf = businessFragment('');
  const expBf = businessFragment('');
  const sec = await unionTimeSecondsBetween(ctx, startUtc, endUtc);
  const ir = await get(
    db,
    `SELECT SUM(amount_cents) AS s FROM income_entries
     WHERE user_id = ? AND received_at_utc >= ? AND received_at_utc < ? ${incBf.sql}`,
    [userId, startUtc, endUtc, ...incBf.params]
  );
  const er = await get(
    db,
    `SELECT SUM(amount_cents) AS s FROM expense_entries
     WHERE user_id = ? AND spent_at_utc >= ? AND spent_at_utc < ? ${expBf.sql}`,
    [userId, startUtc, endUtc, ...expBf.params]
  );
  return {
    seconds_worked_approx: sec,
    income_cents: parseInt(ir && ir.s != null ? ir.s : 0, 10) || 0,
    expense_cents: parseInt(er && er.s != null ? er.s : 0, 10) || 0
  };
}

async function summaryToday(ctx) {
  const [ds, de] = await utcNaiveBoundsForLocalToday(ctx.settingsGet);
  return summaryBetween(ctx, ds, de);
}

async function listRegisteredUserIds(db) {
  const rows = await all(db, 'SELECT telegram_user_id FROM rr_users ORDER BY telegram_user_id');
  return rows.map((r) => r.telegram_user_id);
}

async function listWorkCategories(ctx, includeArchived) {
  const extra = includeArchived ? '' : ' AND archived = 0';
  return all(
    ctx.db,
    `SELECT id, name, color, icon, kind, billable, default_hourly_cents, sort_order, archived
     FROM work_categories WHERE user_id = ?${extra} ORDER BY sort_order, name`,
    [ctx.userId]
  );
}

async function listProjects(ctx, includeArchived) {
  const extra = includeArchived ? '' : ' AND archived = 0';
  const bf = ctx.businessFragment('');
  return all(
    ctx.db,
    `SELECT id, name, client_name, color, default_hourly_cents, currency, archived, sort_order
     FROM projects WHERE user_id = ?${bf.sql}${extra} ORDER BY sort_order, name`,
    [ctx.userId, ...bf.params]
  );
}

async function listTags(ctx) {
  return all(ctx.db, 'SELECT id, name FROM tags WHERE user_id = ? ORDER BY name', [ctx.userId]);
}

async function recentTimeEntries(ctx, limit = 15) {
  return all(
    ctx.db,
    `SELECT t.id, t.start_utc, t.end_utc, t.category, t.description, t.amount_cents, t.currency,
            t.work_category_id, t.project_id, c.name AS cat_name
     FROM rr_time_entries t
     LEFT JOIN work_categories c ON c.id = t.work_category_id
     WHERE t.user_id = ?
     ORDER BY t.start_utc DESC, t.id DESC
     LIMIT ?`,
    [ctx.userId, limit]
  );
}

async function listTimeEntriesBetween(ctx, startUtc, endUtc) {
  const bf = ctx.businessFragment('t');
  return all(
    ctx.db,
    `SELECT t.id, t.start_utc, t.end_utc, t.description, t.category, t.work_category_id, t.project_id,
            t.billable, t.hourly_rate_cents, t.amount_cents, t.client_uuid,
            c.name AS category_name, p.name AS project_name
     FROM rr_time_entries t
     LEFT JOIN work_categories c ON c.id = t.work_category_id
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.user_id = ? AND t.start_utc < ? AND t.end_utc > ? ${bf.sql}
     ORDER BY t.start_utc ASC, t.id ASC`,
    [ctx.userId, endUtc, startUtc, ...bf.params]
  );
}

async function listIncomeBetween(ctx, startUtc, endUtc) {
  const bf = ctx.businessFragment('');
  return all(
    ctx.db,
    `SELECT id, received_at_utc, amount_cents, currency, description, work_category_id, project_id, source_type, notes
     FROM income_entries
     WHERE user_id = ? AND received_at_utc >= ? AND received_at_utc < ? ${bf.sql}
     ORDER BY received_at_utc ASC`,
    [ctx.userId, startUtc, endUtc, ...bf.params]
  );
}

async function listExpensesBetween(ctx, startUtc, endUtc) {
  const bf = ctx.businessFragment('');
  return all(
    ctx.db,
    `SELECT id, spent_at_utc, amount_cents, currency, description, merchant, billable, notes,
            work_category_id, project_id, funding_source
     FROM expense_entries
     WHERE user_id = ? AND spent_at_utc >= ? AND spent_at_utc < ? ${bf.sql}
     ORDER BY spent_at_utc ASC`,
    [ctx.userId, startUtc, endUtc, ...bf.params]
  );
}

async function listClients(ctx, includeArchived) {
  const bf = ctx.businessFragment('');
  let q =
    'SELECT id, display_name, company, email, phone, address, website, tax_id, notes, archived FROM clients WHERE user_id = ?' +
    bf.sql;
  const params = [ctx.userId, ...bf.params];
  if (!includeArchived) q += ' AND archived = 0';
  q += ' ORDER BY sort_order, display_name';
  return all(ctx.db, q, params);
}

async function listInvoices(ctx, limit = 100) {
  const bf = ctx.businessFragment('i');
  return all(
    ctx.db,
    `SELECT i.id, i.client_id, i.invoice_number, i.status, i.issued_at_utc, i.due_at_utc, i.currency,
            i.subtotal_cents, i.tax_cents, i.total_cents, i.notes,
            c.display_name AS client_name
     FROM invoices i
     LEFT JOIN clients c ON c.id = i.client_id
     WHERE i.user_id = ? ${bf.sql}
     ORDER BY i.issued_at_utc DESC, i.id DESC
     LIMIT ?`,
    [ctx.userId, ...bf.params, limit]
  );
}

async function listDebts(ctx, days = 365) {
  const row = await get(ctx.db, "SELECT datetime('now', ?) AS s", [`-${days} days`]);
  const since = String(row.s).replace(' ', 'T');
  const bf = ctx.businessFragment('');
  return all(
    ctx.db,
    `SELECT id, created_at_utc, due_at_utc, amount_cents, currency, creditor, description, status, debt_type, account_ref
     FROM debt_entries
     WHERE user_id = ? AND created_at_utc >= ? ${bf.sql}
     ORDER BY created_at_utc DESC`,
    [ctx.userId, since, ...bf.params]
  );
}

async function listScheduleUpcoming(ctx, days = 21) {
  const nowS = nowUtcIsoText();
  const endRow = await get(ctx.db, "SELECT datetime('now', ?) AS s", [`+${days} days`]);
  const end = String(endRow.s).replace(' ', 'T');
  const bf = ctx.businessFragment('e');
  return all(
    ctx.db,
    `SELECT e.id, e.title, e.starts_at_utc, e.ends_at_utc, e.all_day, e.client_id, e.project_id,
            e.location, e.notes, e.status,
            c.display_name AS client_name, p.name AS project_name
     FROM schedule_events e
     LEFT JOIN clients c ON c.id = e.client_id
     LEFT JOIN projects p ON p.id = e.project_id
     WHERE e.user_id = ? AND e.starts_at_utc >= ? AND e.starts_at_utc < ? ${bf.sql}
     ORDER BY e.starts_at_utc ASC`,
    [ctx.userId, nowS, end, ...bf.params]
  );
}

async function listStockProducts(ctx, includeArchived) {
  const extra = includeArchived ? '' : ' AND archived = 0';
  const bf = ctx.businessFragment('');
  return all(
    ctx.db,
    `SELECT id, name, sku, description, qty_on_hand, reorder_level, unit, unit_cost_cents, currency, unit_price_cents, notes, archived
     FROM stock_products WHERE user_id = ?${bf.sql}${extra} ORDER BY archived ASC, name`,
    [ctx.userId, ...bf.params]
  );
}

async function listSupplies(ctx, includeArchived) {
  const extra = includeArchived ? '' : ' AND archived = 0';
  const bf = ctx.businessFragment('');
  return all(
    ctx.db,
    `SELECT id, name, category, qty_on_hand, reorder_level, unit, vendor, notes, archived
     FROM supplies WHERE user_id = ?${bf.sql}${extra} ORDER BY archived ASC, name`,
    [ctx.userId, ...bf.params]
  );
}

async function listSessionEventsBetween(ctx, startUtc, endUtc) {
  return all(
    ctx.db,
    `SELECT id, event_type, detail, created_at_utc, client_event_uuid
     FROM rr_session_events
     WHERE user_id = ? AND created_at_utc >= ? AND created_at_utc < ?
     ORDER BY created_at_utc ASC, id ASC`,
    [ctx.userId, startUtc, endUtc]
  );
}

function ensureSessionEventsWritable(ctx) {
  if (ctx.isMaster()) {
    throw new Error('The combined view is read-only. Choose a single business to edit the work log.');
  }
}

async function updateSessionEvent(ctx, payload) {
  ensureSessionEventsWritable(ctx);
  const id = parseInt(payload.id, 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid entry id.');
  const eventType = String(payload.event_type ?? '').trim();
  if (!eventType) throw new Error('Event type is required.');
  const detail = payload.detail != null ? String(payload.detail).slice(0, 5000) : '';
  const createdAt = String(payload.created_at_utc ?? '').trim();
  if (!createdAt) throw new Error('Time is required.');
  const r = await run(
    ctx.db,
    `UPDATE rr_session_events SET event_type = ?, detail = ?, created_at_utc = ? WHERE id = ? AND user_id = ?`,
    [eventType, detail, createdAt, id, ctx.userId]
  );
  if (!r.changes) throw new Error('Entry not found or could not be updated.');
  await syncEngine.enqueueSessionEventSnapshot(ctx.db, ctx.userId, id);
  syncEngine.scheduleSync(ctx.db, ctx.userId);
  await rebuildTrackingStateFromSessionEvents(ctx);
  return true;
}

async function deleteSessionEvent(ctx, payload) {
  ensureSessionEventsWritable(ctx);
  const id = parseInt(payload.id, 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid entry id.');
  const prev = await get(ctx.db, 'SELECT client_event_uuid FROM rr_session_events WHERE id = ? AND user_id = ?', [
    id,
    ctx.userId
  ]);
  const cu = prev ? String(prev.client_event_uuid || '').trim() : '';
  const r = await run(ctx.db, `DELETE FROM rr_session_events WHERE id = ? AND user_id = ?`, [id, ctx.userId]);
  if (!r.changes) throw new Error('Entry not found or could not be deleted.');
  if (cu) {
    await syncEngine.enqueueSessionEventDelete(ctx.db, ctx.userId, cu);
    syncEngine.scheduleSync(ctx.db, ctx.userId);
  }
  await rebuildTrackingStateFromSessionEvents(ctx);
  return true;
}

async function deleteSessionEvents(ctx, payload) {
  ensureSessionEventsWritable(ctx);
  const ids = Array.isArray(payload.ids)
    ? payload.ids.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (!ids.length) throw new Error('No entries selected.');
  const placeholders = ids.map(() => '?').join(',');
  const prevRows = await all(
    ctx.db,
    `SELECT id, client_event_uuid FROM rr_session_events WHERE user_id = ? AND id IN (${placeholders})`,
    [ctx.userId, ...ids]
  );
  await run(ctx.db, `DELETE FROM rr_session_events WHERE user_id = ? AND id IN (${placeholders})`, [
    ctx.userId,
    ...ids
  ]);
  for (const pr of prevRows) {
    const cu = String(pr.client_event_uuid || '').trim();
    if (cu) await syncEngine.enqueueSessionEventDelete(ctx.db, ctx.userId, cu);
  }
  syncEngine.scheduleSync(ctx.db, ctx.userId);
  await rebuildTrackingStateFromSessionEvents(ctx);
  return true;
}

async function bulkUpdateSessionEvents(ctx, payload) {
  ensureSessionEventsWritable(ctx);
  const ids = Array.isArray(payload.ids)
    ? payload.ids.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (!ids.length) throw new Error('No entries selected.');
  const hasType = Object.prototype.hasOwnProperty.call(payload, 'event_type');
  const hasDetail = Object.prototype.hasOwnProperty.call(payload, 'detail');
  if (!hasType && !hasDetail) throw new Error('Provide at least one of event type or detail to update.');
  const placeholders = ids.map(() => '?').join(',');
  if (hasType && hasDetail) {
    const eventType = String(payload.event_type ?? '').trim();
    if (!eventType) throw new Error('Event type cannot be empty.');
    const detail = String(payload.detail ?? '').slice(0, 5000);
    await run(
      ctx.db,
      `UPDATE rr_session_events SET event_type = ?, detail = ? WHERE user_id = ? AND id IN (${placeholders})`,
      [eventType, detail, ctx.userId, ...ids]
    );
    for (const sid of ids) {
      await syncEngine.enqueueSessionEventSnapshot(ctx.db, ctx.userId, sid);
    }
    syncEngine.scheduleSync(ctx.db, ctx.userId);
    await rebuildTrackingStateFromSessionEvents(ctx);
    return true;
  }
  if (hasType) {
    const eventType = String(payload.event_type ?? '').trim();
    if (!eventType) throw new Error('Event type cannot be empty.');
    await run(
      ctx.db,
      `UPDATE rr_session_events SET event_type = ? WHERE user_id = ? AND id IN (${placeholders})`,
      [eventType, ctx.userId, ...ids]
    );
    for (const sid of ids) {
      await syncEngine.enqueueSessionEventSnapshot(ctx.db, ctx.userId, sid);
    }
    syncEngine.scheduleSync(ctx.db, ctx.userId);
    await rebuildTrackingStateFromSessionEvents(ctx);
    return true;
  }
  const detail = String(payload.detail ?? '').slice(0, 5000);
  await run(
    ctx.db,
    `UPDATE rr_session_events SET detail = ? WHERE user_id = ? AND id IN (${placeholders})`,
    [detail, ctx.userId, ...ids]
  );
  for (const sid of ids) {
    await syncEngine.enqueueSessionEventSnapshot(ctx.db, ctx.userId, sid);
  }
  syncEngine.scheduleSync(ctx.db, ctx.userId);
  await rebuildTrackingStateFromSessionEvents(ctx);
  return true;
}

async function listQuickActions(ctx) {
  return all(
    ctx.db,
    `SELECT id, label, work_category_id, project_id, default_description, sort_order
     FROM quick_actions WHERE user_id = ? ORDER BY sort_order, id`,
    [ctx.userId]
  );
}

async function listBusinessProfiles(ctx, includeArchived) {
  let q =
    'SELECT id, user_id, name, legal_name, owner, tax_id, email, phone, website, address, timezone, invoice_notes, archived, created_at, updated_at FROM business_profiles WHERE user_id = ?';
  const params = [ctx.userId];
  if (!includeArchived) q += ' AND archived = 0';
  q += ' ORDER BY name';
  const rows = await all(ctx.db, q, params);
  const multi = parseSettingBool(await ctx.settingsGet('multi_business_enabled', false));
  if (!multi) {
    return rows;
  }
  return [{ id: 0, name: 'All businesses (combined)', archived: 0 }, ...rows];
}

function optSettingStr(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

async function fetchBusinessProfile(ctx, profileId) {
  const pid = parseInt(String(profileId), 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return get(
    ctx.db,
    `SELECT id, user_id, name, legal_name, owner, tax_id, email, phone, website, address, timezone, invoice_notes, archived, created_at, updated_at
     FROM business_profiles WHERE id = ? AND user_id = ?`,
    [pid, ctx.userId]
  );
}

async function saveBusinessProfile(ctx, payload) {
  const id = parseInt(String(payload.id), 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid business');
  const exists = await get(ctx.db, 'SELECT id FROM business_profiles WHERE id = ? AND user_id = ?', [id, ctx.userId]);
  if (!exists) throw new Error('Business not found');
  const name = optSettingStr(payload.name);
  if (!name) throw new Error('Business name is required');
  const archived = Boolean(payload.archived) ? 1 : 0;
  const now = nowUtcIsoText();
  try {
    await run(
      ctx.db,
      `UPDATE business_profiles SET
        name = ?, legal_name = ?, owner = ?, tax_id = ?, email = ?, phone = ?, website = ?, address = ?,
        timezone = ?, invoice_notes = ?, archived = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [
        name,
        optSettingStr(payload.legal_name),
        optSettingStr(payload.owner),
        optSettingStr(payload.tax_id),
        optSettingStr(payload.email),
        optSettingStr(payload.phone),
        optSettingStr(payload.website),
        optSettingStr(payload.address),
        optSettingStr(payload.timezone),
        optSettingStr(payload.invoice_notes),
        archived,
        now,
        id,
        ctx.userId
      ]
    );
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    if (msg.includes('UNIQUE')) throw new Error('That business name is already in use.');
    throw e;
  }
  return true;
}

async function createBusinessProfile(ctx, payload) {
  const name = optSettingStr(payload.name);
  if (!name) throw new Error('Business name is required');
  if (!licenseService.proFeaturesUnlocked()) {
    const row = await get(
      ctx.db,
      `SELECT COUNT(*) AS c FROM business_profiles WHERE user_id = ? AND archived = 0`,
      [ctx.userId]
    );
    const n = parseInt(row && row.c, 10) || 0;
    if (n >= 1) {
      throw new Error('Pro subscription required to add another business.');
    }
  }
  const now = nowUtcIsoText();
  try {
    const r = await run(
      ctx.db,
      `INSERT INTO business_profiles (user_id, name, legal_name, owner, tax_id, email, phone, website, address, timezone, invoice_notes, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx.userId,
        name,
        optSettingStr(payload.legal_name),
        optSettingStr(payload.owner),
        optSettingStr(payload.tax_id),
        optSettingStr(payload.email),
        optSettingStr(payload.phone),
        optSettingStr(payload.website),
        optSettingStr(payload.address),
        optSettingStr(payload.timezone),
        optSettingStr(payload.invoice_notes),
        0,
        now,
        now
      ]
    );
    return { id: r.lastID };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    if (msg.includes('UNIQUE')) throw new Error('That business name is already in use.');
    throw e;
  }
}

async function moneyTotalsByCurrencyBetween(ctx, startUtc, endUtc) {
  const bf = ctx.businessFragment('');
  const incRows = await all(
    ctx.db,
    `SELECT UPPER(COALESCE(currency, 'USD')) AS ccy, COALESCE(SUM(amount_cents), 0) AS amt
     FROM income_entries
     WHERE user_id = ? AND received_at_utc >= ? AND received_at_utc < ? ${bf.sql}
     GROUP BY UPPER(COALESCE(currency, 'USD'))`,
    [ctx.userId, startUtc, endUtc, ...bf.params]
  );
  const expRows = await all(
    ctx.db,
    `SELECT UPPER(COALESCE(currency, 'USD')) AS ccy, COALESCE(SUM(amount_cents), 0) AS amt
     FROM expense_entries
     WHERE user_id = ? AND spent_at_utc >= ? AND spent_at_utc < ? ${bf.sql}
     GROUP BY UPPER(COALESCE(currency, 'USD'))`,
    [ctx.userId, startUtc, endUtc, ...bf.params]
  );
  const out = {};
  for (const { ccy, amt } of incRows) {
    const k = String(ccy || 'USD');
    out[k] = out[k] || { income_cents: 0, expense_cents: 0, net_cents: 0 };
    out[k].income_cents += parseInt(amt, 10) || 0;
  }
  for (const { ccy, amt } of expRows) {
    const k = String(ccy || 'USD');
    out[k] = out[k] || { income_cents: 0, expense_cents: 0, net_cents: 0 };
    out[k].expense_cents += parseInt(amt, 10) || 0;
  }
  for (const k of Object.keys(out)) {
    out[k].net_cents = out[k].income_cents - out[k].expense_cents;
  }
  return out;
}

async function ledgerNetTotals(ctx) {
  return moneyTotalsByCurrencyBetween(ctx, '1970-01-01T00:00:00', '2100-12-31T23:59:59');
}

async function dailyProjectBreakdown(ctx, startUtc, endUtc) {
  const { db, userId, businessFragment } = ctx;
  const bf = businessFragment('t');
  const rows = await all(
    db,
    `SELECT COALESCE(NULLIF(TRIM(p.name), ''), '(Unassigned)') AS project_name,
       t.start_utc, t.end_utc,
       CASE
         WHEN LOWER(TRIM(COALESCE(t.category, ''))) = 'break' THEN 'Break'
         ELSE COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(t.category), ''), 'Development')
       END AS task_name
     FROM rr_time_entries t
     LEFT JOIN projects p ON p.id = t.project_id
     LEFT JOIN work_categories c ON c.id = t.work_category_id
     WHERE t.user_id = ? AND t.start_utc < ? AND t.end_utc > ? ${bf.sql}
     ORDER BY t.start_utc ASC, t.id ASC`,
    [userId, endUtc, startUtc, ...bf.params]
  );
  const w0 = new Date(startUtc).getTime();
  const w1 = new Date(endUtc).getTime();
  const byProj = {};
  const allClips = [];
  for (const r of rows) {
    const tname = String(r.task_name || '').trim();
    if (tname.toLowerCase() === 'break') continue;
    const sa = new Date(String(r.start_utc)).getTime();
    const eb = new Date(String(r.end_utc)).getTime();
    const cl = clipInterval(sa, eb, w0, w1);
    if (!cl) continue;
    allClips.push(cl);
    const pname = String(r.project_name || '(Unassigned)');
    if (!byProj[pname]) byProj[pname] = [];
    byProj[pname].push(cl);
  }
  const globalSec = mergedIntervalsSecondsUnion(allClips);
  const out = [];
  for (const [projName, clips] of Object.entries(byProj)) {
    const catSec = mergedIntervalsSecondsUnion(clips);
    const pct = globalSec > 0 ? (catSec / globalSec) * 100 : 0;
    out.push({ task_name: projName, seconds_total: catSec, percent_of_day: pct });
  }
  out.sort((a, b) => b.seconds_total - a.seconds_total);
  return out;
}

async function dailyTaskBreakdown(ctx, startUtc, endUtc) {
  const { db, userId, businessFragment } = ctx;
  const bf = businessFragment('t');
  const rows = await all(
    db,
    `SELECT CASE
         WHEN LOWER(TRIM(COALESCE(t.category, ''))) = 'break' THEN 'Break'
         ELSE COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(t.category), ''), 'Development')
       END AS task_name,
       t.start_utc, t.end_utc, t.category
     FROM rr_time_entries t
     LEFT JOIN work_categories c ON c.id = t.work_category_id
     WHERE t.user_id = ? AND t.start_utc < ? AND t.end_utc > ? ${bf.sql}
     ORDER BY t.start_utc ASC, t.id ASC`,
    [userId, endUtc, startUtc, ...bf.params]
  );
  const w0 = new Date(startUtc).getTime();
  const w1 = new Date(endUtc).getTime();
  const byTask = {};
  const allClips = [];
  for (const r of rows) {
    const tname = String(r.task_name || '').trim();
    const lcat = String(r.category || '').trim();
    if (tname.toLowerCase() === 'break' || lcat.toLowerCase() === 'break') continue;
    const sa = new Date(String(r.start_utc)).getTime();
    const eb = new Date(String(r.end_utc)).getTime();
    const cl = clipInterval(sa, eb, w0, w1);
    if (!cl) continue;
    allClips.push(cl);
    if (!byTask[tname]) byTask[tname] = [];
    byTask[tname].push(cl);
  }
  const globalSec = mergedIntervalsSecondsUnion(allClips);
  const out = [];
  for (const [taskName, clips] of Object.entries(byTask)) {
    const catSec = mergedIntervalsSecondsUnion(clips);
    const pct = globalSec > 0 ? (catSec / globalSec) * 100 : 0;
    out.push({ task_name: taskName, seconds_total: catSec, percent_of_day: pct });
  }
  out.sort((a, b) => b.seconds_total - a.seconds_total);
  return out;
}

async function listAvailableFundsAccounts(ctx, includeArchived = false) {
  const bf = ctx.businessFragment('');
  const clause = includeArchived ? '' : ' AND archived = 0';
  return all(
    ctx.db,
    `SELECT id, account_name, account_type, currency, current_balance_cents, credit_limit_cents, notes, archived, updated_at
     FROM available_funds_accounts WHERE user_id = ?${bf.sql}${clause}
     ORDER BY archived ASC, account_type ASC, account_name COLLATE NOCASE ASC`,
    [ctx.userId, ...bf.params]
  );
}

async function listResourceEntries(ctx, days = 365) {
  const row = await get(ctx.db, "SELECT datetime('now', ?) AS s", [`-${days} days`]);
  const since = String(row.s).replace(' ', 'T');
  const bf = ctx.businessFragment('');
  return all(
    ctx.db,
    `SELECT id, at_utc, amount_cents, currency, source_type, description
     FROM resource_entries WHERE user_id = ? AND at_utc >= ? ${bf.sql}
     ORDER BY at_utc DESC`,
    [ctx.userId, since, ...bf.params]
  );
}

async function listScheduledExpenses(ctx, includeInactive = false) {
  const bf = ctx.businessFragment('');
  const activeClause = includeInactive ? '' : ' AND active = 1';
  return all(
    ctx.db,
    `SELECT id, description, amount_cents, currency, frequency, next_due_utc, merchant, notes, active,
            project_id, work_category_id
     FROM scheduled_expenses WHERE user_id = ?${bf.sql}${activeClause}
     ORDER BY next_due_utc ASC`,
    [ctx.userId, ...bf.params]
  );
}

async function availableFundsTotalsByCurrency(ctx) {
  const rows = await listAvailableFundsAccounts(ctx, false);
  const out = {};
  for (const r of rows) {
    const cur = String(r.currency || 'USD');
    const acType = String(r.account_type || 'cash').trim().toLowerCase();
    const bal = parseInt(r.current_balance_cents, 10) || 0;
    const lim = parseInt(r.credit_limit_cents, 10) || 0;
    const bucket = (out[cur] = out[cur] || {
      available_cents: 0,
      balance_cents: 0,
      credit_limit_cents: 0,
      used_credit_cents: 0
    });
    bucket.balance_cents += bal;
    if (['credit_card', 'loan_line', 'line_of_credit'].includes(acType)) {
      const used = Math.max(0, bal);
      const avail = Math.max(0, lim - used);
      bucket.available_cents += avail;
      bucket.credit_limit_cents += Math.max(0, lim);
      bucket.used_credit_cents += used;
    } else {
      bucket.available_cents += bal;
    }
  }
  return out;
}

async function buildDashboardSummary(ctx, p) {
  const scale = (p && p.scale) || 'Daily';
  const customDay = (p && p.customDay) || null;
  const win = await computeDashboardWindows(ctx.settingsGet, scale, customDay);
  const { segments: dashSegments } = await computeDashboardSegments(ctx.settingsGet, scale, customDay);
  let segIdx =
    p && p.segmentIndex != null && p.segmentIndex !== ''
      ? parseInt(String(p.segmentIndex), 10)
      : 0;
  if (!Number.isFinite(segIdx) || segIdx < 0) segIdx = 0;
  if (segIdx >= dashSegments.length) segIdx = 0;
  const seg = dashSegments[segIdx];

  const sum = await summaryBetween(ctx, seg.startUtc, seg.endUtc);
  const prevSum = await summaryBetween(ctx, seg.prevStartUtc, seg.prevEndUtc);
  const breakdownMode = (p && p.breakdownMode) === 'Project' ? 'Project' : 'Category';
  const breakdown =
    breakdownMode === 'Project'
      ? await dailyProjectBreakdown(ctx, seg.startUtc, seg.endUtc)
      : await dailyTaskBreakdown(ctx, seg.startUtc, seg.endUtc);
  const moneyByCcy = await moneyTotalsByCurrencyBetween(ctx, seg.startUtc, seg.endUtc);
  let funds = null;
  if (p && p.includeAvailableFunds) {
    funds = await availableFundsTotalsByCurrency(ctx);
  }

  const segments = dashSegments.map((s, i) => ({
    label: s.label,
    detail: s.detail || '',
    index: i
  }));

  return {
    window: win,
    segments,
    segmentIndex: segIdx,
    summary: sum,
    previousSummary: prevSum,
    breakdownMode,
    breakdown,
    moneyByCurrency: moneyByCcy,
    availableFundsTotals: funds,
    comparePrevLabel: dashSegments.length > 1 ? seg.prevLabel || win.prevLabel : win.prevLabel,
    activeUtcRange: {
      startUtc: seg.startUtc,
      endUtc: seg.endUtc,
      prevStartUtc: seg.prevStartUtc,
      prevEndUtc: seg.prevEndUtc
    },
    periodCardLabel:
      dashSegments.length > 1
        ? seg.label === 'Combined'
          ? win.label
          : `${win.label} · ${seg.label}`
        : win.label
  };
}

async function settingSet(ctx, key, value) {
  /** App settings are global (no business_id); allow changes even on Master so users can switch profile or adjust prefs. */
  if (key === 'multi_business_enabled' && parseSettingBool(value) && !licenseService.proFeaturesUnlocked()) {
    throw new Error('Multiple businesses require a Pro subscription.');
  }
  await run(ctx.db, 'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    JSON.stringify(value)
  ]);
  return true;
}

async function insertIncome(ctx, payload) {
  const bid = ctx.requireWritable();
  const now = nowUtcIsoText();
  const r = await run(
    ctx.db,
    `INSERT INTO income_entries
      (user_id, business_id, received_at_utc, amount_cents, currency, description, work_category_id,
       project_id, source_type, source_ref_id, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.userId,
      bid,
      payload.received_at_utc,
      parseInt(payload.amount_cents, 10),
      String(payload.currency || 'USD'),
      String(payload.description || ''),
      payload.work_category_id ?? null,
      payload.project_id ?? null,
      String(payload.source_type || 'manual'),
      payload.source_ref_id ?? null,
      payload.notes ?? null,
      now,
      now
    ]
  );
  return r.lastID;
}

async function insertExpense(ctx, payload) {
  const bid = ctx.requireWritable();
  const now = nowUtcIsoText();
  const r = await run(
    ctx.db,
    `INSERT INTO expense_entries
      (user_id, business_id, spent_at_utc, amount_cents, currency, work_category_id, project_id,
       description, merchant, billable, notes, created_at, funding_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.userId,
      bid,
      payload.spent_at_utc,
      parseInt(payload.amount_cents, 10),
      String(payload.currency || 'USD'),
      payload.work_category_id ?? null,
      payload.project_id ?? null,
      String(payload.description || ''),
      payload.merchant ?? null,
      payload.billable != null ? payload.billable : 1,
      payload.notes ?? null,
      now,
      String(payload.funding_source || 'cash')
    ]
  );
  return r.lastID;
}

async function assertFinanceEntryEditable(ctx, table, id) {
  const bid = ctx.requireWritable();
  const row = await get(ctx.db, `SELECT business_id FROM ${table} WHERE id = ? AND user_id = ?`, [id, ctx.userId]);
  if (!row) throw new Error('Entry not found.');
  const multi = parseSettingBool(await ctx.settingsGet('multi_business_enabled', false));
  if (!multi) return;
  const raw = row.business_id;
  const rBid = raw != null && raw !== '' ? parseInt(String(raw), 10) : NaN;
  const effective = Number.isFinite(rBid) && rBid > 0 ? rBid : 1;
  if (effective !== bid) {
    throw new Error('That entry belongs to another business. Switch the business in your profile to edit it.');
  }
}

async function updateIncome(ctx, p) {
  const id = parseInt(p.id, 10);
  if (!Number.isFinite(id)) throw new Error('Invalid income id.');
  await assertFinanceEntryEditable(ctx, 'income_entries', id);
  const now = nowUtcIsoText();
  await run(
    ctx.db,
    `UPDATE income_entries SET received_at_utc=?, amount_cents=?, currency=?, description=?, updated_at=?
     WHERE id=? AND user_id=?`,
    [
      String(p.received_at_utc),
      parseInt(p.amount_cents, 10),
      String(p.currency || 'USD'),
      String(p.description || ''),
      now,
      id,
      ctx.userId
    ]
  );
  return { ok: true };
}

async function deleteIncome(ctx, p) {
  const id = parseInt(p.id, 10);
  if (!Number.isFinite(id)) throw new Error('Invalid income id.');
  await assertFinanceEntryEditable(ctx, 'income_entries', id);
  await run(ctx.db, 'DELETE FROM income_entries WHERE id=? AND user_id=?', [id, ctx.userId]);
  return { ok: true };
}

async function updateExpense(ctx, p) {
  const id = parseInt(p.id, 10);
  if (!Number.isFinite(id)) throw new Error('Invalid expense id.');
  await assertFinanceEntryEditable(ctx, 'expense_entries', id);
  await run(
    ctx.db,
    `UPDATE expense_entries SET spent_at_utc=?, amount_cents=?, currency=?, description=?, funding_source=?
     WHERE id=? AND user_id=?`,
    [
      String(p.spent_at_utc),
      parseInt(p.amount_cents, 10),
      String(p.currency || 'USD'),
      String(p.description || ''),
      String(p.funding_source || 'cash'),
      id,
      ctx.userId
    ]
  );
  return { ok: true };
}

async function deleteExpense(ctx, p) {
  const id = parseInt(p.id, 10);
  if (!Number.isFinite(id)) throw new Error('Invalid expense id.');
  await assertFinanceEntryEditable(ctx, 'expense_entries', id);
  await run(ctx.db, 'DELETE FROM expense_entries WHERE id=? AND user_id=?', [id, ctx.userId]);
  return { ok: true };
}

const handlers = {
  settingGet: (ctx, p) => ctx.settingsGet(p.key, p.default),
  todayUtcBounds: async (ctx) => {
    const [startUtc, endUtc] = await utcNaiveBoundsForLocalToday(ctx.settingsGet);
    const n = await nowInReportingZone(ctx.settingsGet);
    return {
      startUtc,
      endUtc,
      reportingYear: n.year,
      reportingMonth: n.month,
      reportingDay: n.day
    };
  },
  calendarDayBounds: async (ctx, p) => {
    const [startUtc, endUtc] = await utcNaiveBoundsForCalendarDay(ctx.settingsGet, p.year, p.month, p.day);
    return { startUtc, endUtc };
  },
  localReportRangeBounds: async (ctx, p) => {
    const [startUtc, endUtc] = await utcNaiveBoundsForLocalReportRange(
      ctx.settingsGet,
      p.sy,
      p.sm,
      p.sd,
      p.ey,
      p.em,
      p.ed
    );
    return { startUtc, endUtc };
  },
  summaryToday: (ctx) => summaryToday(ctx),
  summaryBetween: (ctx, p) => summaryBetween(ctx, p.startUtc, p.endUtc),
  summaryForLocalDay: async (ctx, p) => {
    const [ds, de] = await utcNaiveBoundsForCalendarDay(ctx.settingsGet, p.year, p.month, p.day);
    const s = await summaryBetween(ctx, ds, de);
    return { ...s, _bounds: [ds, de] };
  },
  listWorkCategories: (ctx, p) => listWorkCategories(ctx, Boolean(p && p.includeArchived)),
  listProjects: (ctx, p) => listProjects(ctx, Boolean(p && p.includeArchived)),
  listTags: (ctx) => listTags(ctx),
  recentTimeEntries: (ctx, p) => recentTimeEntries(ctx, (p && p.limit) || 15),
  listTimeEntriesBetween: (ctx, p) => listTimeEntriesBetween(ctx, p.startUtc, p.endUtc),
  listIncomeBetween: (ctx, p) => listIncomeBetween(ctx, p.startUtc, p.endUtc),
  listExpensesBetween: (ctx, p) => listExpensesBetween(ctx, p.startUtc, p.endUtc),
  listClients: (ctx, p) => listClients(ctx, Boolean(p && p.includeArchived)),
  listInvoices: (ctx, p) => listInvoices(ctx, (p && p.limit) || 100),
  listDebts: (ctx, p) => listDebts(ctx, (p && p.days) || 365),
  listScheduleUpcoming: (ctx, p) => listScheduleUpcoming(ctx, (p && p.days) || 21),
  listStockProducts: (ctx, p) => listStockProducts(ctx, Boolean(p && p.includeArchived)),
  listSupplies: (ctx, p) => listSupplies(ctx, Boolean(p && p.includeArchived)),
  listSessionEventsBetween: (ctx, p) => listSessionEventsBetween(ctx, p.startUtc, p.endUtc),
  updateSessionEvent: (ctx, p) => updateSessionEvent(ctx, p || {}),
  deleteSessionEvent: (ctx, p) => deleteSessionEvent(ctx, p || {}),
  deleteSessionEvents: (ctx, p) => deleteSessionEvents(ctx, p || {}),
  bulkUpdateSessionEvents: (ctx, p) => bulkUpdateSessionEvents(ctx, p || {}),
  listQuickActions: (ctx) => listQuickActions(ctx),
  listBusinessProfiles: (ctx, p) => listBusinessProfiles(ctx, Boolean(p && p.includeArchived)),
  getBusinessProfile: (ctx, p) =>
    fetchBusinessProfile(ctx, p && (p.id != null ? p.id : p.businessId)),
  saveBusinessProfile: (ctx, p) => saveBusinessProfile(ctx, p || {}),
  createBusinessProfile: (ctx, p) => createBusinessProfile(ctx, p || {}),
  dailyTaskBreakdown: (ctx, p) => {
    if (!licenseService.proFeaturesUnlocked()) {
      throw new Error('Reports require a Pro subscription.');
    }
    return dailyTaskBreakdown(ctx, p.startUtc, p.endUtc);
  },
  dailyProjectBreakdown: (ctx, p) => dailyProjectBreakdown(ctx, p.startUtc, p.endUtc),
  getDashboardSummary: (ctx, p) => buildDashboardSummary(ctx, p),
  listAvailableFundsAccounts: (ctx, p) => listAvailableFundsAccounts(ctx, Boolean(p && p.includeArchived)),
  listResourceEntries: (ctx, p) => listResourceEntries(ctx, (p && p.days) || 365),
  listScheduledExpenses: (ctx, p) => listScheduledExpenses(ctx, Boolean(p && p.includeInactive)),
  availableFundsTotalsByCurrency: (ctx) => availableFundsTotalsByCurrency(ctx),
  ledgerNetTotals: (ctx) => ledgerNetTotals(ctx),
  moneyTotalsByCurrencyBetween: (ctx, p) => moneyTotalsByCurrencyBetween(ctx, p.startUtc, p.endUtc),
  settingSet: (ctx, p) => settingSet(ctx, p.key, p.value),
  insertIncome: (ctx, p) => insertIncome(ctx, p),
  insertExpense: (ctx, p) => insertExpense(ctx, p),
  updateIncome: (ctx, p) => updateIncome(ctx, p),
  deleteIncome: (ctx, p) => deleteIncome(ctx, p),
  updateExpense: (ctx, p) => updateExpense(ctx, p),
  deleteExpense: (ctx, p) => deleteExpense(ctx, p)
};

Object.assign(handlers, require('./trackingHandlers'), require('./suiteHandlers'));

async function dispatch(db, method, payload) {
  const fn = handlers[method];
  if (!fn) throw new Error(`Unknown API method: ${method}`);
  const userId = (payload && payload.userId) || 1;
  const act = payload && Object.prototype.hasOwnProperty.call(payload, 'activeBusinessId') ? payload.activeBusinessId : undefined;
  const ctx = await makeCtx(db, userId, act);
  return fn(ctx, payload || {});
}

module.exports = {
  dispatch,
  listRegisteredUserIds,
  makeCtx
};
