'use strict';

const crypto = require('crypto');
const { run, get, all } = require('./sqliteUtil');
const { nowUtcIsoText } = require('./migrate');
const { parseIsoUtcToStorage } = require('./sqlTime');
const sessionStore = require('./sessionStore');
const { parseSettingBool } = require('./settingBool');
const syncEngine = require('./syncEngine');

async function businessIdForNewEntry(ctx) {
  const multi = parseSettingBool(await ctx.settingsGet('multi_business_enabled', false));
  if (!multi) return null;
  const raw = await ctx.settingsGet('active_business_id', 1);
  const bid = parseInt(String(raw), 10);
  return bid > 0 ? bid : null;
}

async function getMachineSessionId(db) {
  let mid = sessionStore.getMachineSessionDbId();
  return mid ?? null;
}

async function insertSessionEventDb(ctx, eventType, detail) {
  const now = nowUtcIsoText();
  const clientEventUuid = crypto.randomUUID();
  const r = await run(
    ctx.db,
    'INSERT INTO rr_session_events (user_id, event_type, detail, created_at_utc, client_event_uuid) VALUES (?, ?, ?, ?, ?)',
    [ctx.userId, String(eventType), String(detail || '').slice(0, 5000), now, clientEventUuid]
  );
  await syncEngine.enqueueSessionEventSnapshot(ctx.db, ctx.userId, r.lastID);
  syncEngine.scheduleSync(ctx.db, ctx.userId);
}

async function getWorkCategoryById(ctx, cid) {
  if (!cid) return null;
  const row = await get(ctx.db, 'SELECT id, billable, default_hourly_cents FROM work_categories WHERE id = ? AND user_id = ?', [
    cid,
    ctx.userId
  ]);
  return row;
}

async function getWorkCategoryIdByName(ctx, name) {
  const row = await get(
    ctx.db,
    'SELECT id FROM work_categories WHERE user_id = ? AND name = ? AND archived = 0',
    [ctx.userId, name]
  );
  return row ? row.id : null;
}

async function getProjectRow(ctx, pid) {
  if (!pid) return null;
  return get(ctx.db, 'SELECT id, name, default_hourly_cents, currency FROM projects WHERE id = ? AND user_id = ?', [
    pid,
    ctx.userId
  ]);
}

async function effectiveHourlyCents(ctx, workCategoryId, projectId, overrideCents) {
  if (overrideCents != null) return overrideCents > 0 ? overrideCents : null;
  if (projectId) {
    const p = await getProjectRow(ctx, projectId);
    if (p && p.default_hourly_cents) return parseInt(p.default_hourly_cents, 10);
  }
  if (workCategoryId) {
    const c = await getWorkCategoryById(ctx, workCategoryId);
    if (c && c.default_hourly_cents) return parseInt(c.default_hourly_cents, 10);
  }
  let d = await ctx.settingsGet('default_hourly_cents', 0);
  try {
    d = parseInt(String(d), 10);
  } catch {
    d = 0;
  }
  return d > 0 ? d : null;
}

function computeAmountCents(startIso, endIso, hourlyRateCents, billable) {
  if (!billable || hourlyRateCents == null || hourlyRateCents <= 0) return null;
  const a = new Date(startIso.endsWith('Z') ? startIso : `${startIso}Z`).getTime();
  const b = new Date(endIso.endsWith('Z') ? endIso : `${endIso}Z`).getTime();
  const hours = Math.max(0, (b - a) / 3600000);
  return Math.round(hours * hourlyRateCents);
}

async function primaryTaskCategoryId(ctx) {
  return (
    (await getWorkCategoryIdByName(ctx, 'Development')) ||
    (await getWorkCategoryIdByName(ctx, 'Work')) ||
    (await getWorkCategoryIdByName(ctx, 'Action'))
  );
}

async function insertRichTimeEntry(ctx, opts) {
  const start = parseIsoUtcToStorage(opts.start_iso);
  const end = parseIsoUtcToStorage(opts.end_iso);
  const created = nowUtcIsoText();
  const clientUuid = opts.client_uuid || crypto.randomUUID();
  const bid = opts.business_id !== undefined ? opts.business_id : await businessIdForNewEntry(ctx);
  const r = await run(
    ctx.db,
    `INSERT INTO rr_time_entries
      (user_id, machine_session_id, start_utc, end_utc, category, description, created_at,
       work_category_id, project_id, notes, billable, hourly_rate_cents, amount_cents, currency,
       business_id, client_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.userId,
      opts.machine_session_id ?? null,
      start,
      end,
      opts.legacy_category || 'work',
      String(opts.description || ''),
      created,
      opts.work_category_id ?? null,
      opts.project_id ?? null,
      opts.notes ?? null,
      opts.billable != null ? opts.billable : 1,
      opts.hourly_rate_cents ?? null,
      opts.amount_cents ?? null,
      String(opts.currency || 'USD'),
      bid,
      clientUuid
    ]
  );
  const eid = r.lastID;
  if (opts.tag_ids && opts.tag_ids.length) {
    for (const tid of opts.tag_ids) {
      await run(ctx.db, 'INSERT OR IGNORE INTO time_entry_tags (time_entry_id, tag_id) VALUES (?, ?)', [eid, tid]);
    }
  }
  await syncEngine.enqueueTimeEntrySnapshot(ctx.db, ctx.userId, eid);
  syncEngine.scheduleSync(ctx.db, ctx.userId);
  return eid;
}

async function closeAndLogWork(ctx, state, endUtc) {
  if (!(state.current_work_start_utc && state.current_work_description)) return state;
  const mid = await getMachineSessionId(ctx.db);
  const wcId = state.current_work_category_id || (await primaryTaskCategoryId(ctx));
  const pid = state.current_project_id;
  const cat = await getWorkCategoryById(ctx, wcId);
  const billable = cat ? parseInt(cat.billable, 10) : 1;
  const rate = await effectiveHourlyCents(ctx, wcId, pid, null);
  const amt = computeAmountCents(state.current_work_start_utc, endUtc, rate, Boolean(billable));
  await insertRichTimeEntry(ctx, {
    start_iso: state.current_work_start_utc,
    end_iso: endUtc,
    legacy_category: 'work',
    description: state.current_work_description,
    machine_session_id: mid,
    work_category_id: wcId,
    project_id: pid,
    notes: null,
    billable,
    hourly_rate_cents: rate,
    amount_cents: amt,
    currency: 'USD',
    tag_ids: state.current_tag_ids || []
  });
  return {
    evaluation_active: state.evaluation_active,
    evaluation_start_utc: state.evaluation_start_utc,
    current_work_start_utc: null,
    current_work_description: null,
    current_work_category_id: null,
    current_project_id: null,
    current_tag_ids: null,
    current_mode: state.current_mode,
    last_task_description: state.last_task_description || state.current_work_description,
    last_prompt_auto_fill_utc: state.last_prompt_auto_fill_utc
  };
}

async function ensureTagsFromList(ctx, csv) {
  const raw = String(csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = [];
  for (const name of raw) {
    let row = await get(ctx.db, 'SELECT id FROM tags WHERE user_id = ? AND name = ?', [ctx.userId, name]);
    if (!row) {
      await run(ctx.db, 'INSERT INTO tags (user_id, name) VALUES (?, ?)', [ctx.userId, name]);
      row = await get(ctx.db, 'SELECT id FROM tags WHERE user_id = ? AND name = ?', [ctx.userId, name]);
    }
    if (row) ids.push(row.id);
  }
  return ids.length ? ids : null;
}

async function handleActivityText(ctx, text, workCategoryId, projectId, tagCsv) {
  const tagIds = await ensureTagsFromList(ctx, tagCsv);
  let state = sessionStore.loadUserState(ctx.userId);
  if (!state) {
    state = sessionStore.resetUserForNewMachineSession(ctx.userId, sessionStore.getMachineSessionStartedAt() || new Date().toISOString());
  }
  const endUtc = new Date().toISOString();
  const desc = String(text || '').trim();
  if (!desc) return 'Enter a non-empty description of what you are doing.';

  if (state.evaluation_active) {
    const evalStart = state.evaluation_start_utc || sessionStore.getMachineSessionStartedAt() || endUtc;
    const evId = await getWorkCategoryIdByName(ctx, 'Evaluation');
    const ec = await getWorkCategoryById(ctx, evId);
    const bilEv = ec ? parseInt(ec.billable, 10) : 0;
    const rateEv = await effectiveHourlyCents(ctx, evId, null, null);
    const amtEv = computeAmountCents(evalStart, endUtc, rateEv, Boolean(bilEv));
    await insertRichTimeEntry(ctx, {
      start_iso: evalStart,
      end_iso: endUtc,
      legacy_category: 'evaluation',
      description: 'Planning / reviewing objectives (pre-work)',
      machine_session_id: await getMachineSessionId(ctx.db),
      work_category_id: evId,
      project_id: null,
      notes: null,
      billable: bilEv,
      hourly_rate_cents: rateEv,
      amount_cents: amtEv,
      currency: 'USD',
      tag_ids: tagIds
    });
    const wc = workCategoryId || (await primaryTaskCategoryId(ctx));
    const newState = {
      evaluation_active: false,
      evaluation_start_utc: null,
      current_work_start_utc: endUtc,
      current_work_description: desc,
      current_work_category_id: wc,
      current_project_id: projectId,
      current_tag_ids: tagIds,
      current_mode: 'working',
      last_task_description: desc,
      last_prompt_auto_fill_utc: state.last_prompt_auto_fill_utc
    };
    sessionStore.saveUserState(ctx.userId, newState);
    await insertSessionEventDb(ctx, 'first_entry', 'Evaluation closed; task block started');
    return 'Logged evaluation time, then started on this task:\n' + desc + '\n\nLog again when you switch to something else.';
  }

  state = await closeAndLogWork(ctx, state, endUtc);
  const wc = workCategoryId || (await primaryTaskCategoryId(ctx));
  const newState = {
    evaluation_active: false,
    evaluation_start_utc: null,
    current_work_start_utc: endUtc,
    current_work_description: desc,
    current_work_category_id: wc,
    current_project_id: projectId,
    current_tag_ids: tagIds,
    current_mode: 'working',
    last_task_description: desc,
    last_prompt_auto_fill_utc: state.last_prompt_auto_fill_utc
  };
  sessionStore.saveUserState(ctx.userId, newState);
  await insertSessionEventDb(ctx, 'activity_update', desc.slice(0, 500));
  return 'Updated. Previous block closed; now tracking:\n' + desc;
}

/**
 * Recompute machine-session JSON (`sessionStore`) from rr_session_events so the Time & Tracking
 * panel matches the DB after edits/deletes (e.g. removing an erroneous clock_out restores “working”).
 */
async function rebuildTrackingStateFromSessionEvents(ctx) {
  const rows = await all(
    ctx.db,
    `SELECT event_type, detail, created_at_utc FROM rr_session_events
     WHERE user_id = ? ORDER BY created_at_utc ASC, id ASC`,
    [ctx.userId]
  );
  const breakId = await getWorkCategoryIdByName(ctx, 'Break');
  const primaryId = await primaryTaskCategoryId(ctx);

  let mode = 'off';
  let current_work_start_utc = null;
  let current_work_description = null;
  let current_work_category_id = null;
  let current_project_id = null;
  let last_task_description = null;

  for (const r of rows) {
    const et = String(r.event_type || '').trim().toLowerCase();
    const detail = String(r.detail || '').trim();
    const t = r.created_at_utc;

    if (et === 'clock_in') {
      mode = 'working';
      current_work_start_utc = t;
      current_work_description = detail || 'Working';
      current_work_category_id = primaryId;
      current_project_id = null;
    } else if (et === 'clock_out') {
      mode = 'off';
      current_work_start_utc = null;
      current_work_description = null;
      current_work_category_id = null;
      current_project_id = null;
    } else if (et === 'break_in') {
      mode = 'on_break';
      current_work_start_utc = t;
      current_work_description = detail || 'Break';
      current_work_category_id = breakId;
      current_project_id = null;
    } else if (et === 'break_out') {
      mode = 'working';
      current_work_start_utc = t;
      current_work_description = detail || last_task_description || 'Working';
      current_work_category_id = primaryId;
      current_project_id = null;
    } else if (et === 'activity_update') {
      mode = 'working';
      current_work_start_utc = t;
      current_work_description = detail || last_task_description || 'Working';
      current_work_category_id = primaryId;
      current_project_id = null;
    } else if (et === 'first_entry') {
      mode = 'working';
      current_work_start_utc = t;
      current_work_description = last_task_description || 'Working';
      current_work_category_id = primaryId;
      current_project_id = null;
    }
    if (current_work_description) last_task_description = current_work_description;
  }

  const prev = sessionStore.loadUserState(ctx.userId);
  sessionStore.saveUserState(ctx.userId, {
    evaluation_active: false,
    evaluation_start_utc: null,
    current_work_start_utc,
    current_work_description,
    current_work_category_id,
    current_project_id,
    current_tag_ids: prev && prev.current_tag_ids ? prev.current_tag_ids : null,
    current_mode: mode === 'working' ? 'working' : mode === 'on_break' ? 'on_break' : 'off',
    last_task_description: last_task_description || (prev && prev.last_task_description),
    last_prompt_auto_fill_utc: prev ? prev.last_prompt_auto_fill_utc : null
  });
}

module.exports = {
  rebuildTrackingStateFromSessionEvents,
  trackingStateGet: (ctx) => sessionStore.loadUserState(ctx.userId),
  logActivity: async (ctx, p) => ({
    message: await handleActivityText(ctx, p.description, p.work_category_id ?? null, p.project_id ?? null, p.tags_csv || '')
  }),
  clockIn: async (ctx, p) => {
    let state = sessionStore.loadUserState(ctx.userId);
    if (!state) state = sessionStore.resetUserForNewMachineSession(ctx.userId, sessionStore.getMachineSessionStartedAt() || new Date().toISOString());
    const now = new Date().toISOString();
    state = await closeAndLogWork(ctx, state, now);
    const desc = String(p.description || '').trim() || 'Working';
    sessionStore.saveUserState(ctx.userId, {
      evaluation_active: false,
      evaluation_start_utc: null,
      current_work_start_utc: now,
      current_work_description: desc,
      current_work_category_id: p.work_category_id ?? null,
      current_project_id: p.project_id ?? null,
      current_tag_ids: (await ensureTagsFromList(ctx, p.tags_csv || '')) || null,
      current_mode: 'working',
      last_task_description: desc,
      last_prompt_auto_fill_utc: state.last_prompt_auto_fill_utc
    });
    await insertSessionEventDb(ctx, 'clock_in', desc.slice(0, 500));
    return { message: 'Clocked in.' };
  },
  clockOut: async (ctx) => {
    let state = sessionStore.loadUserState(ctx.userId);
    if (!state) state = sessionStore.resetUserForNewMachineSession(ctx.userId, sessionStore.getMachineSessionStartedAt() || new Date().toISOString());
    const now = new Date().toISOString();
    state = await closeAndLogWork(ctx, state, now);
    sessionStore.saveUserState(ctx.userId, {
      evaluation_active: false,
      evaluation_start_utc: null,
      current_work_start_utc: null,
      current_work_description: null,
      current_work_category_id: null,
      current_project_id: null,
      current_tag_ids: null,
      current_mode: 'off',
      last_task_description: state.last_task_description,
      last_prompt_auto_fill_utc: state.last_prompt_auto_fill_utc
    });
    await insertSessionEventDb(ctx, 'clock_out', '');
    return { message: 'Clocked out.' };
  },
  breakIn: async (ctx, p) => {
    let state = sessionStore.loadUserState(ctx.userId);
    if (!state) state = sessionStore.resetUserForNewMachineSession(ctx.userId, sessionStore.getMachineSessionStartedAt() || new Date().toISOString());
    const now = new Date().toISOString();
    state = await closeAndLogWork(ctx, state, now);
    const breakId = await getWorkCategoryIdByName(ctx, 'Break');
    const desc = String(p.description || 'Break');
    sessionStore.saveUserState(ctx.userId, {
      evaluation_active: false,
      evaluation_start_utc: null,
      current_work_start_utc: now,
      current_work_description: desc,
      current_work_category_id: breakId,
      current_project_id: null,
      current_tag_ids: null,
      current_mode: 'on_break',
      last_task_description: state.last_task_description,
      last_prompt_auto_fill_utc: state.last_prompt_auto_fill_utc
    });
    await insertSessionEventDb(ctx, 'break_in', desc.slice(0, 500));
    return { message: 'Break started.' };
  },
  breakOut: async (ctx, p) => {
    let state = sessionStore.loadUserState(ctx.userId);
    if (!state) state = sessionStore.resetUserForNewMachineSession(ctx.userId, sessionStore.getMachineSessionStartedAt() || new Date().toISOString());
    const now = new Date().toISOString();
    state = await closeAndLogWork(ctx, state, now);
    const actionId = p.work_category_id || (await primaryTaskCategoryId(ctx));
    const resume = String(p.resume_description || state.last_task_description || 'Working').trim();
    sessionStore.saveUserState(ctx.userId, {
      evaluation_active: false,
      evaluation_start_utc: null,
      current_work_start_utc: now,
      current_work_description: resume,
      current_work_category_id: actionId,
      current_project_id: p.project_id ?? null,
      current_tag_ids: null,
      current_mode: 'working',
      last_task_description: resume,
      last_prompt_auto_fill_utc: state.last_prompt_auto_fill_utc
    });
    await insertSessionEventDb(ctx, 'break_out', resume.slice(0, 500));
    return { message: 'Break ended — timer running again.' };
  },
  upsertWorkCategory: async (ctx, p) => {
    ctx.requireWritable();
    const name = String(p.name || '').trim();
    if (!name) throw new Error('Category name required');
    await run(
      ctx.db,
      `INSERT INTO work_categories (user_id, name, color, icon, kind, billable, default_hourly_cents, sort_order, archived)
       VALUES (?, ?, ?, ?, 'time', ?, ?, ?, 0)
       ON CONFLICT(user_id, name) DO UPDATE SET
         color = excluded.color,
         icon = excluded.icon,
         billable = excluded.billable,
         default_hourly_cents = excluded.default_hourly_cents,
         sort_order = excluded.sort_order,
         archived = 0`,
      [
        ctx.userId,
        name,
        p.color || '#2B8A8F',
        p.icon || '',
        p.billable != null ? p.billable : 1,
        p.default_hourly_cents ?? null,
        p.sort_order != null ? p.sort_order : 999
      ]
    );
    const row = await get(ctx.db, 'SELECT id FROM work_categories WHERE user_id = ? AND name = ?', [ctx.userId, name]);
    return { id: row.id };
  },
  insertProject: async (ctx, p) => {
    const bid = ctx.requireWritable();
    const name = String(p.name || '').trim();
    if (!name) throw new Error('Project name required');
    const r = await run(
      ctx.db,
      `INSERT INTO projects (user_id, business_id, name, client_name, color, default_hourly_cents, currency, archived, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 999)`,
      [
        ctx.userId,
        bid,
        name,
        p.client_name ?? null,
        p.color || '#5C4D7D',
        p.default_hourly_cents ?? null,
        String(p.currency || 'USD')
      ]
    );
    return { id: r.lastID };
  },
  updateProject: async (ctx, p) => {
    const bid = ctx.requireWritable();
    const id = parseInt(p.project_id, 10);
    if (!Number.isFinite(id)) throw new Error('Invalid project id.');
    const name = String(p.name || '').trim();
    if (!name) throw new Error('Project name required.');
    await run(
      ctx.db,
      `UPDATE projects SET name=?, client_name=?, color=?, default_hourly_cents=?, currency=?
       WHERE id=? AND user_id=? AND COALESCE(business_id,1)=?`,
      [
        name,
        p.client_name ?? null,
        p.color || '#5C4D7D',
        p.default_hourly_cents ?? null,
        String(p.currency || 'USD'),
        id,
        ctx.userId,
        bid
      ]
    );
    return { ok: true };
  },
  archiveProject: async (ctx, p) => {
    ctx.requireWritable();
    await run(ctx.db, 'UPDATE projects SET archived=1 WHERE id=? AND user_id=?', [p.project_id, ctx.userId]);
    return { ok: true };
  },
  updateWorkCategoryById: async (ctx, p) => {
    ctx.requireWritable();
    const id = parseInt(p.category_id, 10);
    if (!Number.isFinite(id)) throw new Error('Invalid category id.');
    const name = String(p.name || '').trim();
    if (!name) throw new Error('Category name required.');
    await run(
      ctx.db,
      `UPDATE work_categories SET name=?, color=?, billable=?, default_hourly_cents=? WHERE id=? AND user_id=?`,
      [
        name,
        p.color || '#2B8A8F',
        p.billable != null ? p.billable : 1,
        p.default_hourly_cents ?? null,
        id,
        ctx.userId
      ]
    );
    return { ok: true };
  },
  archiveWorkCategory: async (ctx, p) => {
    ctx.requireWritable();
    await run(ctx.db, 'UPDATE work_categories SET archived=1 WHERE id=? AND user_id=?', [p.category_id, ctx.userId]);
    return { ok: true };
  },
  insertManualTimeEntry: async (ctx, p) => {
    ctx.requireWritable();
    const mid = await getMachineSessionId(ctx.db);
    const wc = p.work_category_id ?? (await primaryTaskCategoryId(ctx));
    const cat = await getWorkCategoryById(ctx, wc);
    const billable = cat ? parseInt(cat.billable, 10) : 1;
    const rate = await effectiveHourlyCents(ctx, wc, p.project_id ?? null, p.hourly_override_cents ?? null);
    const amt = computeAmountCents(p.start_iso, p.end_iso, rate, Boolean(billable));
    const tagIds = p.tag_ids || (await ensureTagsFromList(ctx, p.tags_csv || ''));
    const id = await insertRichTimeEntry(ctx, {
      start_iso: p.start_iso,
      end_iso: p.end_iso,
      legacy_category: String(p.legacy_category || 'work'),
      description: String(p.description || ''),
      machine_session_id: mid,
      work_category_id: wc,
      project_id: p.project_id ?? null,
      notes: p.notes ?? null,
      billable,
      hourly_rate_cents: rate,
      amount_cents: amt,
      currency: String(p.currency || 'USD'),
      tag_ids: tagIds
    });
    return { id };
  },
  deleteTimeEntry: async (ctx, p) => {
    ctx.requireWritable();
    const row = await get(ctx.db, 'SELECT client_uuid FROM rr_time_entries WHERE id = ? AND user_id = ?', [
      p.entry_id,
      ctx.userId
    ]);
    const cu = row ? String(row.client_uuid || '').trim() : '';
    const r = await run(ctx.db, 'DELETE FROM rr_time_entries WHERE id = ? AND user_id = ?', [p.entry_id, ctx.userId]);
    if (r.changes > 0 && cu) {
      await syncEngine.enqueueTimeEntryDelete(ctx.db, ctx.userId, cu);
      syncEngine.scheduleSync(ctx.db, ctx.userId);
    }
    return { ok: r.changes > 0 };
  },
  updateTimeEntry: async (ctx, p) => {
    ctx.requireWritable();
    const start = parseIsoUtcToStorage(p.start_utc);
    const end = parseIsoUtcToStorage(p.end_utc);
    const wc = p.work_category_id ?? null;
    let legacyCat = 'work';
    if (wc) {
      const crow = await get(ctx.db, 'SELECT name FROM work_categories WHERE id = ? AND user_id = ?', [
        wc,
        ctx.userId
      ]);
      if (crow && String(crow.name || '').toLowerCase().trim() === 'evaluation') {
        legacyCat = 'evaluation';
      }
    }
    const r = await run(
      ctx.db,
      `UPDATE rr_time_entries SET start_utc=?, end_utc=?, description=?, work_category_id=?, project_id=?, category=?
       WHERE id = ? AND user_id = ?`,
      [
        start,
        end,
        String(p.description || ''),
        wc,
        p.project_id ?? null,
        legacyCat,
        p.entry_id,
        ctx.userId
      ]
    );
    if (r.changes > 0) {
      await syncEngine.enqueueTimeEntrySnapshot(ctx.db, ctx.userId, p.entry_id);
      syncEngine.scheduleSync(ctx.db, ctx.userId);
    }
    return { ok: r.changes > 0 };
  },
  saveQuickAction: async (ctx, p) => {
    ctx.requireWritable();
    const now = nowUtcIsoText();
    if (p.id) {
      await run(
        ctx.db,
        `UPDATE quick_actions SET label=?, work_category_id=?, project_id=?, default_description=?, sort_order=?
         WHERE id = ? AND user_id = ?`,
        [
          String(p.label || ''),
          p.work_category_id ?? null,
          p.project_id ?? null,
          p.default_description ?? '',
          p.sort_order ?? 0,
          p.id,
          ctx.userId
        ]
      );
      return { id: p.id };
    }
    const r = await run(
      ctx.db,
      `INSERT INTO quick_actions (user_id, label, work_category_id, project_id, default_description, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        ctx.userId,
        String(p.label || ''),
        p.work_category_id ?? null,
        p.project_id ?? null,
        String(p.default_description || ''),
        p.sort_order ?? 999
      ]
    );
    return { id: r.lastID };
  },
  deleteQuickAction: async (ctx, p) => {
    ctx.requireWritable();
    await run(ctx.db, 'DELETE FROM quick_actions WHERE id = ? AND user_id = ?', [p.id, ctx.userId]);
    return { ok: true };
  }
};
