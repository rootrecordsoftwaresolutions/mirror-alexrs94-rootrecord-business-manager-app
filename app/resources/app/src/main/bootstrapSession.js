'use strict';

const crypto = require('crypto');
const os = require('os');
const { run } = require('./sqliteUtil');
const { nowUtcIsoText } = require('./migrate');
const { ensureUserLayout } = require('./paths');
const sessionStore = require('./sessionStore');
const { parseIsoUtcToStorage } = require('./sqlTime');
const syncEngine = require('./syncEngine');

async function bootstrapSession(db) {
  const username = process.env.USERNAME || os.userInfo().username || 'user';
  const now = nowUtcIsoText();
  await run(
    db,
    `INSERT INTO rr_users (telegram_user_id, username, first_name, created_at, updated_at)
     VALUES (1, ?, NULL, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET username = excluded.username, updated_at = excluded.updated_at`,
    [username, now, now]
  );

  ensureUserLayout(1);

  let started = sessionStore.getMachineSessionStartedAt();
  if (!started) {
    started = new Date().toISOString();
    sessionStore.initMachineSession(started);
  }

  let mid = sessionStore.getMachineSessionDbId();
  if (mid == null) {
    const startedNorm = parseIsoUtcToStorage(started.endsWith('Z') ? started : `${started}Z`);
    const r = await run(db, 'INSERT INTO rr_machine_sessions (started_at_utc, created_at) VALUES (?, ?)', [
      startedNorm,
      now
    ]);
    mid = r.lastID;
    sessionStore.setMachineSessionDbId(mid);
  }

  const ev = await run(
    db,
    'INSERT INTO rr_session_events (user_id, event_type, detail, created_at_utc, client_event_uuid) VALUES (?, ?, ?, ?, ?)',
    [1, 'desktop_start', 'session start', now, crypto.randomUUID()]
  );
  try {
    await syncEngine.enqueueSessionEventSnapshot(db, 1, ev.lastID);
    syncEngine.scheduleSync(db, 1);
  } catch (e) {
    console.error('[bootstrapSession] sync enqueue (non-fatal)', e);
  }

  if (!sessionStore.loadUserState(1)) {
    sessionStore.resetUserForNewMachineSession(1, started);
  }
}

module.exports = { bootstrapSession };
