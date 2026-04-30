'use strict';

/** Static executescript bodies aligned with Python migrations.py (v1–v4, v7, v9–v18). */

exports.V1_CREATES = `
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_categories (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2B8A8F',
  icon TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'time'
    CHECK (kind IN ('time','expense','both')),
  billable INTEGER NOT NULL DEFAULT 1,
  default_hourly_cents INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_wcat_user ON work_categories (user_id, sort_order);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  client_name TEXT,
  color TEXT NOT NULL DEFAULT '#5C4D7D',
  default_hourly_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_proj_user ON projects (user_id, sort_order);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE,
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS expense_entries (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  spent_at_utc TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  work_category_id INTEGER,
  project_id INTEGER,
  description TEXT NOT NULL,
  merchant TEXT,
  billable INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE,
  FOREIGN KEY (work_category_id) REFERENCES work_categories (id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_exp_user ON expense_entries (user_id, spent_at_utc);

CREATE TABLE IF NOT EXISTS quick_actions (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  work_category_id INTEGER,
  project_id INTEGER,
  default_description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE,
  FOREIGN KEY (work_category_id) REFERENCES work_categories (id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS time_entry_tags (
  time_entry_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (time_entry_id, tag_id),
  FOREIGN KEY (time_entry_id) REFERENCES rr_time_entries (id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
);
`;

exports.V2 = `
CREATE TABLE IF NOT EXISTS income_entries (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  received_at_utc TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  description TEXT NOT NULL,
  work_category_id INTEGER,
  project_id INTEGER,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_ref_id INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE,
  FOREIGN KEY (work_category_id) REFERENCES work_categories (id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_income_user_time ON income_entries (user_id, received_at_utc);
`;

exports.V3 = `
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  website TEXT,
  tax_id TEXT,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clients_user ON clients (user_id, sort_order);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  client_id INTEGER,
  invoice_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','paid','void')),
  issued_at_utc TEXT NOT NULL,
  due_at_utc TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE SET NULL,
  UNIQUE (user_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices (user_id, issued_at_utc);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  line_total_cents INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invlines_inv ON invoice_lines (invoice_id, sort_order);

CREATE TABLE IF NOT EXISTS schedule_events (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  starts_at_utc TEXT NOT NULL,
  ends_at_utc TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  client_id INTEGER,
  project_id INTEGER,
  location TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','done','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_user ON schedule_events (user_id, starts_at_utc);
`;

exports.V4 = `
CREATE TABLE IF NOT EXISTS stock_products (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sku TEXT,
  description TEXT,
  unit TEXT NOT NULL DEFAULT 'ea',
  qty_on_hand REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  unit_cost_cents INTEGER,
  unit_price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stock_products_user ON stock_products (user_id, archived, name);

CREATE TABLE IF NOT EXISTS supplies (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'ea',
  qty_on_hand REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  vendor TEXT,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_supplies_user ON supplies (user_id, archived, name);
`;

exports.V7 = `
CREATE TABLE IF NOT EXISTS time_entry_audit (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  entry_id INTEGER,
  action TEXT NOT NULL,
  old_start_utc TEXT,
  old_end_utc TEXT,
  new_start_utc TEXT,
  new_end_utc TEXT,
  old_description TEXT,
  new_description TEXT,
  old_work_category_id INTEGER,
  new_work_category_id INTEGER,
  old_project_id INTEGER,
  new_project_id INTEGER,
  meta_json TEXT,
  changed_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_time_entry_audit_user_time ON time_entry_audit (user_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS finalized_ranges (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, start_utc, end_utc),
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_finalized_ranges_user ON finalized_ranges (user_id, start_utc, end_utc);
`;

exports.V9 = `
CREATE TABLE IF NOT EXISTS rr_plugin_settings (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);
CREATE INDEX IF NOT EXISTS idx_plugin_settings_plugin ON rr_plugin_settings (plugin_id);

CREATE TABLE IF NOT EXISTS rr_power_snapshots (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  device_id TEXT,
  polled_at TEXT NOT NULL,
  battery_pct REAL,
  input_watts REAL,
  output_watts REAL,
  state_text TEXT,
  runtime_minutes REAL,
  poll_ok INTEGER NOT NULL DEFAULT 1,
  error_text TEXT,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_power_snapshots_user_time ON rr_power_snapshots (user_id, polled_at DESC);

CREATE TABLE IF NOT EXISTS rr_power_alerts (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  snapshot_id INTEGER,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id) REFERENCES rr_power_snapshots (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_power_alerts_user_time ON rr_power_alerts (user_id, created_at DESC);
`;

exports.V10 = `
CREATE TABLE IF NOT EXISTS usgs_quake_events (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_time_utc TEXT NOT NULL,
  magnitude REAL,
  place TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  depth_km REAL,
  detail_url TEXT,
  raw_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usgs_events_time ON usgs_quake_events (event_time_utc DESC);

CREATE TABLE IF NOT EXISTS usgs_quake_alerts (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  alerted_at TEXT NOT NULL,
  distance_miles REAL NOT NULL,
  rule_snapshot_json TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (event_id) REFERENCES usgs_quake_events (event_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_usgs_alerts_time ON usgs_quake_alerts (alerted_at DESC);
`;

exports.V11 = `
CREATE TABLE IF NOT EXISTS rr_power_buckets (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT '',
  bucket_start_utc TEXT NOT NULL,
  bucket_end_utc TEXT NOT NULL,
  avg_battery_pct REAL,
  avg_ac_input_watts REAL,
  avg_dc_input_watts REAL,
  avg_output_watts REAL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, provider, device_id, bucket_start_utc),
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_power_buckets_user_time
  ON rr_power_buckets (user_id, bucket_start_utc DESC);
`;

exports.V12_CREATES = `
CREATE TABLE IF NOT EXISTS business_profiles (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  legal_name TEXT,
  owner TEXT,
  tax_id TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  address TEXT,
  timezone TEXT,
  invoice_notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, name),
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_business_profiles_user ON business_profiles (user_id, archived, name);
`;

exports.V13 = `
CREATE TABLE IF NOT EXISTS debt_entries (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  business_id INTEGER,
  created_at_utc TEXT NOT NULL,
  due_at_utc TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  creditor TEXT,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS idx_debt_entries_user_time ON debt_entries (user_id, created_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_debt_entries_user_business ON debt_entries (user_id, business_id, status);
`;

exports.V14 = `
CREATE TABLE IF NOT EXISTS scheduled_expenses (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  business_id INTEGER,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  frequency TEXT NOT NULL DEFAULT 'monthly',
  next_due_utc TEXT NOT NULL,
  project_id INTEGER,
  work_category_id INTEGER,
  merchant TEXT,
  billable INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  last_run_utc TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_exp_user_due ON scheduled_expenses (user_id, business_id, active, next_due_utc);
`;

exports.V15 = `
CREATE TABLE IF NOT EXISTS resource_entries (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  business_id INTEGER,
  at_utc TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  source_type TEXT NOT NULL DEFAULT 'owner_contribution',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resource_entries_user_time ON resource_entries (user_id, at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_resource_entries_user_business ON resource_entries (user_id, business_id);
`;

exports.V16 = `
CREATE TABLE IF NOT EXISTS available_funds_accounts (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  business_id INTEGER,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'cash',
  currency TEXT NOT NULL DEFAULT 'USD',
  current_balance_cents INTEGER NOT NULL DEFAULT 0,
  credit_limit_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avail_funds_user_business
  ON available_funds_accounts (user_id, business_id, archived, account_type);
CREATE INDEX IF NOT EXISTS idx_avail_funds_user_name
  ON available_funds_accounts (user_id, account_name);
`;

exports.V17 = `
CREATE TABLE IF NOT EXISTS sync_outbox (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  client_mutation_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  payload_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  last_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES rr_users (telegram_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending
  ON sync_outbox (status, created_at_utc);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_user
  ON sync_outbox (user_id, status);
`;

exports.V18 = `
CREATE TABLE IF NOT EXISTS sync_applied_remote (
  client_mutation_id TEXT NOT NULL PRIMARY KEY,
  applied_at_utc TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'applied'
);
`;
