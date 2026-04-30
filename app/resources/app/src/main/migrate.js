'use strict';

const crypto = require('crypto');
const { run, get, all, exec } = require('./sqliteUtil');
const sql = require('./migrateSql');

const STD_TIME_CATEGORIES = [
  ['Evaluation', '#E67700', '', 1, null, 0],
  ['Development', '#339af0', '', 1, null, 1],
  ['Break', '#868E96', '', 0, null, 2],
  ['Admin', '#7950F2', '', 0, null, 3],
  ['Research', '#1f6aa5', '', 1, null, 4],
  ['Marketing', '#fd7e14', '', 1, null, 5],
  ['Meetings', '#9775fa', '', 1, null, 6],
  ['Travel', '#15aabf', '', 1, null, 7],
  ['Sales', '#40c057', '', 1, null, 8],
  ['Customer support', '#4c6ef5', '', 1, null, 9],
  ['Operations', '#495057', '', 1, null, 10],
  ['Planning', '#e64980', '', 1, null, 11],
  ['Documentation', '#12b886', '', 1, null, 12],
  ['Finance', '#fab005', '', 1, null, 13],
  ['Training', '#cc5de8', '', 1, null, 14],
  ['Design', '#ff6b6b', '', 1, null, 15],
  ['Product', '#2f9e44', '', 1, null, 16]
];

const FACTORY_APP_SETTINGS_DEFAULTS = {
  currency_default: 'USD',
  theme: 'system',
  prompt_interval_sec: 900,
  prompt_first_delay_sec: 120,
  show_money_in_dashboard: true,
  currency_safe_summaries_enabled: false,
  help_bubbles_enabled: true,
  auto_post_scheduled_expenses_enabled: true,
  auto_create_debt_for_credit_expenses_enabled: true,
  show_process_status_banner_enabled: true,
  notify_on_debt_settlement_enabled: true,
  prompt_popup_topmost: false,
  evaluation_label: 'Evaluation until you log your first task.',
  default_hourly_cents: 0,
  prompt_no_response_action: 'none',
  prompt_no_response_timeout_sec: 45,
  auto_backup_enabled: false,
  auto_backup_interval_hours: 24,
  last_backup_utc: '',
  cloud_backup_enabled: false,
  cloud_backup_api_base_url: '',
  cloud_backup_vault_token: '',
  cloud_backup_last_upload_utc: '',
  cloud_backup_last_source_mtime_ns: '0',
  cloud_backup_last_object_key: '',
  cloud_backup_last_error: '',
  startup_clocked_in_prompt_enabled: true,
  minimize_to_hidden_icons_enabled: false,
  start_on_login_enabled: false,
  multi_business_enabled: false,
  active_business_id: 1,
  /** Dashboard/report calendar boundaries; `system` = OS regional time (see Program Settings). */
  business_timezone: 'system',
  last_app_closed_utc: '',
  trial_welcome_popup_shown: false
};

const FACTORY_QUICK_ACTION_SEEDS = [
  ['Code', 'Development work'],
  ['Review', 'Code review and feedback'],
  ['Meeting', 'Team/client meeting']
];

const BASE_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS rr_users (
      telegram_user_id INTEGER NOT NULL PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  'CREATE INDEX IF NOT EXISTS idx_rr_users_updated ON rr_users (updated_at)',
  `CREATE TABLE IF NOT EXISTS rr_machine_sessions (
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      started_at_utc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  'CREATE INDEX IF NOT EXISTS idx_machine_started ON rr_machine_sessions (started_at_utc)',
  `CREATE TABLE IF NOT EXISTS rr_time_entries (
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      machine_session_id INTEGER,
      start_utc TEXT NOT NULL,
      end_utc TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('evaluation', 'work')),
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE,
      FOREIGN KEY (machine_session_id) REFERENCES rr_machine_sessions (id) ON DELETE SET NULL
    )`,
  'CREATE INDEX IF NOT EXISTS idx_time_user_start ON rr_time_entries (user_id, start_utc)',
  'CREATE INDEX IF NOT EXISTS idx_time_category ON rr_time_entries (category)',
  `CREATE TABLE IF NOT EXISTS rr_session_events (
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      detail TEXT,
      created_at_utc TEXT NOT NULL,
      client_event_uuid TEXT,
      FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE
    )`,
  'CREATE INDEX IF NOT EXISTS idx_ev_user_time ON rr_session_events (user_id, created_at_utc)',
  'CREATE INDEX IF NOT EXISTS idx_ev_event_type ON rr_session_events (event_type)',
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rr_session_events_user_client_uuid
     ON rr_session_events (user_id, client_event_uuid)
     WHERE client_event_uuid IS NOT NULL AND length(trim(client_event_uuid)) > 0`
];

function nowUtcIsoText() {
  return new Date().toISOString().replace(/Z$/, '');
}

async function hasColumn(db, table, col) {
  const rows = await all(db, `PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === col);
}

async function ensureBaseSchema(db) {
  for (const stmt of BASE_TABLE_DDL) {
    await run(db, stmt);
  }
}

async function migrateV1Alters(db) {
  const alters = [
    ['rr_time_entries', 'work_category_id', 'INTEGER'],
    ['rr_time_entries', 'project_id', 'INTEGER'],
    ['rr_time_entries', 'notes', 'TEXT'],
    ['rr_time_entries', 'billable', 'INTEGER NOT NULL DEFAULT 1'],
    ['rr_time_entries', 'hourly_rate_cents', 'INTEGER'],
    ['rr_time_entries', 'amount_cents', 'INTEGER'],
    ['rr_time_entries', 'currency', "TEXT NOT NULL DEFAULT 'USD'"]
  ];
  for (const [table, col, decl] of alters) {
    if (!(await hasColumn(db, table, col))) {
      await run(db, `ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    }
  }
}

async function migrateV5(db) {
  const rows = await all(db, "SELECT DISTINCT user_id FROM work_categories WHERE name = 'Work' AND archived = 0");
  for (const { user_id: uid } of rows) {
    const ex = await get(
      db,
      "SELECT 1 FROM work_categories WHERE user_id = ? AND name = 'Action' AND archived = 0",
      [uid]
    );
    if (ex) continue;
    await run(db, "UPDATE work_categories SET name = 'Action' WHERE user_id = ? AND name = 'Work' AND archived = 0", [
      uid
    ]);
  }
  const users = await all(db, 'SELECT telegram_user_id FROM rr_users');
  for (const { telegram_user_id: uid } of users) {
    for (const [name, color, icon, billable, rate, so] of STD_TIME_CATEGORIES) {
      await run(
        db,
        `INSERT OR IGNORE INTO work_categories
          (user_id, name, color, icon, kind, billable, default_hourly_cents, sort_order, archived)
         VALUES (?, ?, ?, ?, 'time', ?, ?, ?, 0)`,
        [uid, name, color, icon, billable, rate, so]
      );
    }
  }
}

async function migrateV6(db) {
  await run(
    db,
    `UPDATE work_categories SET billable = 1 WHERE archived = 0 AND LOWER(TRIM(name)) = 'evaluation'`
  );
}

async function migrateV8(db) {
  const users = await all(db, 'SELECT telegram_user_id FROM rr_users');
  for (const { telegram_user_id: uid } of users) {
    let row = await get(
      db,
      "SELECT id FROM work_categories WHERE user_id = ? AND LOWER(TRIM(name)) = 'development' AND archived = 0",
      [uid]
    );
    let devId;
    if (row) {
      devId = row.id;
    } else {
      await run(
        db,
        `INSERT INTO work_categories
          (user_id, name, color, icon, kind, billable, default_hourly_cents, sort_order, archived)
         VALUES (?, 'Development', '#339af0', '', 'time', 1, NULL, 1, 0)`,
        [uid]
      );
      const lr = await get(db, 'SELECT last_insert_rowid() AS id');
      devId = lr.id;
    }
    const actions = await all(
      db,
      "SELECT id FROM work_categories WHERE user_id = ? AND LOWER(TRIM(name)) = 'action'",
      [uid]
    );
    for (const { id: aid } of actions) {
      await run(db, 'UPDATE rr_time_entries SET work_category_id = ? WHERE user_id = ? AND work_category_id = ?', [
        devId,
        uid,
        aid
      ]);
      await run(db, 'UPDATE quick_actions SET work_category_id = ? WHERE user_id = ? AND work_category_id = ?', [
        devId,
        uid,
        aid
      ]);
      await run(db, 'UPDATE work_categories SET archived = 1 WHERE id = ?', [aid]);
    }
  }
}

async function migrateV12(db) {
  await exec(db, sql.V12_CREATES);
  const tables = [
    'rr_time_entries',
    'income_entries',
    'expense_entries',
    'clients',
    'invoices',
    'projects',
    'schedule_events',
    'stock_products',
    'supplies',
    'quick_actions'
  ];
  for (const t of tables) {
    if (!(await hasColumn(db, t, 'business_id'))) {
      await run(db, `ALTER TABLE ${t} ADD COLUMN business_id INTEGER`);
    }
    await run(db, `CREATE INDEX IF NOT EXISTS idx_${t}_user_business ON ${t} (user_id, business_id)`);
  }
  const now = nowUtcIsoText();
  const users = await all(db, 'SELECT telegram_user_id FROM rr_users');
  for (const { telegram_user_id: uid } of users) {
    let name = 'Default Business';
    const rowName = await get(db, "SELECT value FROM app_settings WHERE key = 'business_name'");
    if (rowName && rowName.value) {
      try {
        const v = JSON.parse(rowName.value);
        if (String(v || '').trim()) name = String(v).trim();
      } catch {
        /* ignore */
      }
    }
    await run(
      db,
      `INSERT OR IGNORE INTO business_profiles (id, user_id, name, created_at, updated_at) VALUES (1, ?, ?, ?, ?)`,
      [uid, name, now, now]
    );
    for (const t of tables) {
      await run(db, `UPDATE ${t} SET business_id = 1 WHERE user_id = ? AND (business_id IS NULL OR business_id = 0)`, [
        uid
      ]);
    }
  }
  await run(db, "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('multi_business_enabled', ?)", [
    JSON.stringify(false)
  ]);
  await run(db, "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('active_business_id', ?)", [JSON.stringify(1)]);
}

async function migrateV13(db) {
  await exec(db, sql.V13);
  await run(db, 'UPDATE debt_entries SET business_id = 1 WHERE business_id IS NULL OR business_id = 0');
}

async function migrateV14(db) {
  if (!(await hasColumn(db, 'debt_entries', 'debt_type'))) {
    await run(db, "ALTER TABLE debt_entries ADD COLUMN debt_type TEXT NOT NULL DEFAULT 'loan'");
  }
  if (!(await hasColumn(db, 'debt_entries', 'account_ref'))) {
    await run(db, "ALTER TABLE debt_entries ADD COLUMN account_ref TEXT NOT NULL DEFAULT ''");
  }
  await exec(db, sql.V14);
  await run(db, 'UPDATE scheduled_expenses SET business_id = 1 WHERE business_id IS NULL OR business_id = 0');
}

async function migrateV15(db) {
  if (!(await hasColumn(db, 'expense_entries', 'funding_source'))) {
    await run(db, "ALTER TABLE expense_entries ADD COLUMN funding_source TEXT NOT NULL DEFAULT 'cash'");
  }
  await exec(db, sql.V15);
  await run(db, 'UPDATE resource_entries SET business_id = 1 WHERE business_id IS NULL OR business_id = 0');
}

async function migrateV16(db) {
  await exec(db, sql.V16);
  await run(
    db,
    'UPDATE available_funds_accounts SET business_id = 1 WHERE business_id IS NULL OR business_id = 0'
  );
}

async function migrateV19(db) {
  if (!(await hasColumn(db, 'rr_time_entries', 'client_uuid'))) {
    await run(db, 'ALTER TABLE rr_time_entries ADD COLUMN client_uuid TEXT');
  }
  await run(
    db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_rr_time_entries_user_client_uuid
      ON rr_time_entries (user_id, client_uuid)
      WHERE client_uuid IS NOT NULL AND length(trim(client_uuid)) > 0`
  );
  const rows = await all(
    db,
    "SELECT id FROM rr_time_entries WHERE client_uuid IS NULL OR trim(client_uuid) = ''"
  );
  for (const { id } of rows) {
    await run(db, 'UPDATE rr_time_entries SET client_uuid = ? WHERE id = ?', [crypto.randomUUID(), id]);
  }
}

async function migrateV20(db) {
  if (!(await hasColumn(db, 'rr_session_events', 'client_event_uuid'))) {
    await run(db, 'ALTER TABLE rr_session_events ADD COLUMN client_event_uuid TEXT');
  }
  await run(
    db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_rr_session_events_user_client_uuid
      ON rr_session_events (user_id, client_event_uuid)
      WHERE client_event_uuid IS NOT NULL AND length(trim(client_event_uuid)) > 0`
  );
  const rows = await all(
    db,
    "SELECT id FROM rr_session_events WHERE client_event_uuid IS NULL OR trim(client_event_uuid) = ''"
  );
  for (const { id } of rows) {
    await run(db, 'UPDATE rr_session_events SET client_event_uuid = ? WHERE id = ?', [crypto.randomUUID(), id]);
  }
}

async function migrateV11(db) {
  await exec(db, sql.V11);
  if (!(await hasColumn(db, 'rr_power_snapshots', 'ac_input_watts'))) {
    await run(db, 'ALTER TABLE rr_power_snapshots ADD COLUMN ac_input_watts REAL');
  }
  if (!(await hasColumn(db, 'rr_power_snapshots', 'dc_input_watts'))) {
    await run(db, 'ALTER TABLE rr_power_snapshots ADD COLUMN dc_input_watts REAL');
  }
}

async function seedDefaults(db, userId, includeStarterContent) {
  const now = nowUtcIsoText();
  await run(
    db,
    `INSERT OR IGNORE INTO rr_users (telegram_user_id, username, first_name, created_at, updated_at)
     VALUES (?, NULL, NULL, ?, ?)`,
    [userId, now, now]
  );
  const row = await get(
    db,
    'SELECT COUNT(*) AS n FROM work_categories WHERE user_id = ? AND archived = 0',
    [userId]
  );
  const n = row ? row.n : 0;
  if (includeStarterContent && n === 0) {
    for (const [name, color, icon, billable, rate, so] of STD_TIME_CATEGORIES) {
      await run(
        db,
        `INSERT OR IGNORE INTO work_categories
          (user_id, name, color, icon, kind, billable, default_hourly_cents, sort_order, archived)
         VALUES (?, ?, ?, ?, 'time', ?, ?, ?, 0)`,
        [userId, name, color, icon, billable, rate, so]
      );
    }
  }
  if (includeStarterContent) {
    const qn = await get(db, 'SELECT COUNT(*) AS n FROM quick_actions WHERE user_id = ?', [userId]);
    if (qn && qn.n === 0) {
      for (const [label, desc] of FACTORY_QUICK_ACTION_SEEDS) {
        await run(
          db,
          `INSERT INTO quick_actions (user_id, label, work_category_id, project_id, default_description, sort_order)
           VALUES (?, ?, NULL, NULL, ?, 999)`,
          [userId, label, desc]
        );
      }
    }
  }
  for (const [key, val] of Object.entries(FACTORY_APP_SETTINGS_DEFAULTS)) {
    await run(db, 'INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', [key, JSON.stringify(val)]);
  }
}

async function markVersion(db, version) {
  await run(db, 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [version, nowUtcIsoText()]);
}

async function runMigrations(db, localUserId = 1) {
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER NOT NULL PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`
  );
  const doneRows = await all(db, 'SELECT version FROM schema_migrations');
  const done = new Set(doneRows.map((r) => r.version));

  if (!done.has(1)) {
    await exec(db, sql.V1_CREATES);
    await migrateV1Alters(db);
    await markVersion(db, 1);
  }
  if (!done.has(2)) {
    await exec(db, sql.V2);
    await markVersion(db, 2);
  }
  if (!done.has(3)) {
    await exec(db, sql.V3);
    if (!(await hasColumn(db, 'projects', 'client_id'))) {
      await run(db, 'ALTER TABLE projects ADD COLUMN client_id INTEGER');
    }
    await markVersion(db, 3);
  }
  if (!done.has(4)) {
    await exec(db, sql.V4);
    await markVersion(db, 4);
  }
  if (!done.has(5)) {
    await migrateV5(db);
    await markVersion(db, 5);
  }
  if (!done.has(6)) {
    await migrateV6(db);
    await markVersion(db, 6);
  }
  if (!done.has(7)) {
    await exec(db, sql.V7);
    await markVersion(db, 7);
  }
  if (!done.has(8)) {
    await migrateV8(db);
    await markVersion(db, 8);
  }
  if (!done.has(9)) {
    await exec(db, sql.V9);
    await markVersion(db, 9);
  }
  if (!done.has(10)) {
    await exec(db, sql.V10);
    await markVersion(db, 10);
  }
  if (!done.has(11)) {
    await migrateV11(db);
    await markVersion(db, 11);
  }
  if (!done.has(12)) {
    await migrateV12(db);
    await markVersion(db, 12);
  }
  if (!done.has(13)) {
    await migrateV13(db);
    await markVersion(db, 13);
  }
  if (!done.has(14)) {
    await migrateV14(db);
    await markVersion(db, 14);
  }
  if (!done.has(15)) {
    await migrateV15(db);
    await markVersion(db, 15);
  }
  if (!done.has(16)) {
    await migrateV16(db);
    await markVersion(db, 16);
  }
  if (!done.has(17)) {
    await exec(db, sql.V17);
    await markVersion(db, 17);
  }
  if (!done.has(18)) {
    await exec(db, sql.V18);
    await markVersion(db, 18);
  }
  if (!done.has(19)) {
    await migrateV19(db);
    await markVersion(db, 19);
  }
  if (!done.has(20)) {
    await migrateV20(db);
    await markVersion(db, 20);
  }

  await seedDefaults(db, localUserId, true);
}

module.exports = {
  ensureBaseSchema,
  runMigrations,
  nowUtcIsoText,
  hasColumn
};
