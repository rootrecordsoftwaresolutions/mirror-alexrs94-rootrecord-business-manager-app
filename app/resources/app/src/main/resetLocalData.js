'use strict';

/**
 * Destroys local business data (SQLite, machine_session, users/, backups under business_data/),
 * clears queued feedback, then recreates an empty database.
 * License / account files in the app userData root are never removed.
 *
 * SQLITE_PATH: removes the given DB files and legacy-profile …\RootRecord\data + users (same as pre–business_data behavior).
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { defaultRootRecordDbPath, resolveBusinessDataRoot, resolveRootRecordHome } = require('./paths');
const { closeDatabase, initDatabase } = require('./database');

const CONFIRM_PHRASE = 'DELETE ALL DATA';

/** Cloud sync queue only (must differ from CONFIRM_PHRASE so users do not confuse local vs cloud erase). */
const CLOUD_DELETE_CONFIRM_PHRASE = 'DELETE CLOUD DATA';

function unlinkQuiet(p) {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {
    /* ignore */
  }
}

async function resetRootRecordLocalData(confirmationText) {
  if (String(confirmationText || '').trim() !== CONFIRM_PHRASE) {
    throw new Error(`You must type "${CONFIRM_PHRASE}" exactly to erase everything.`);
  }

  await closeDatabase();

  const rawSqlite = String(process.env.SQLITE_PATH || '').trim();
  if (rawSqlite) {
    const dbPath = path.resolve(rawSqlite);
    unlinkQuiet(dbPath);
    unlinkQuiet(`${dbPath}-wal`);
    unlinkQuiet(`${dbPath}-shm`);
    unlinkQuiet(path.join(resolveRootRecordHome(), 'data', 'machine_session.json'));
    const usersDir = path.join(resolveRootRecordHome(), 'users');
    try {
      if (fs.existsSync(usersDir)) fs.rmSync(usersDir, { recursive: true, force: true });
    } catch (e) {
      throw new Error(`Could not remove user data folder: ${e.message}`);
    }
    const backupsDir = path.join(resolveRootRecordHome(), 'data', 'backups');
    try {
      if (fs.existsSync(backupsDir)) fs.rmSync(backupsDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  } else {
    const businessRoot = resolveBusinessDataRoot();
    try {
      if (fs.existsSync(businessRoot)) {
        fs.rmSync(businessRoot, { recursive: true, force: true });
      }
    } catch (e) {
      throw new Error(`Could not remove business data folder: ${e.message}`);
    }
    const dbPath = defaultRootRecordDbPath();
    unlinkQuiet(dbPath);
    unlinkQuiet(`${dbPath}-wal`);
    unlinkQuiet(`${dbPath}-shm`);
  }

  const feedbackQueue = path.join(app.getPath('userData'), 'pending-feedback.jsonl');
  unlinkQuiet(feedbackQueue);

  await initDatabase();
}

module.exports = {
  resetRootRecordLocalData,
  CONFIRM_PHRASE,
  CLOUD_DELETE_CONFIRM_PHRASE
};
