'use strict';

const fs = require('fs');
const path = require('path');
const {
  defaultRootRecordDbPath,
  ensureDbParentDir,
  migrateLegacyWindowsRootRecordHomeIfNeeded,
  migrateBusinessDataFromProfileRootIfNeeded
} = require('./paths');
const { openDatabase, configurePragmas } = require('./sqliteUtil');
const { ensureBaseSchema, runMigrations } = require('./migrate');
const { bootstrapSession } = require('./bootstrapSession');

let dbInstance = null;
let dbPathUsed = null;
/** Single in-flight open — concurrent initDatabase() calls must share one open (avoids SQLITE_BUSY / half-open state). */
let initPromise = null;

/** Last failed open (logged in main process only). Cleared on success. */
let lastInitFailure = null;

function getLastInitFailure() {
  return lastInitFailure;
}

function unlinkWalAndShm(dbPath) {
  for (const suf of ['-wal', '-shm']) {
    const p = dbPath + suf;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {
      /* ignore */
    }
  }
}

function closeDbHandle(db) {
  return new Promise((resolve) => {
    if (!db) return resolve();
    db.close(() => resolve());
  });
}

function sqlErrMsg(e) {
  return e && e.message ? String(e.message) : String(e);
}

/** Typical after copying only rootrecord.db, stale WAL/SHM, interrupted checkpoint, or damaged journal. */
function isRecoverableSqliteOpenError(msg) {
  const m = String(msg || '');
  return (
    /SQLITE_CORRUPT/i.test(m) ||
    /\bmalformed\b/i.test(m) ||
    /disk image is malformed/i.test(m) ||
    /SQLITE_NOTADB/i.test(m) ||
    /not a database/i.test(m)
  );
}

/** Same-folder copies (e.g. rootrecord.before-*.db) and scheduled backups under data/backups/*. */
function findLatestBackupCandidate(primaryDbPath) {
  const dir = path.dirname(primaryDbPath);
  const primaryName = path.basename(primaryDbPath).toLowerCase();
  const candidates = [];

  function consider(filePath) {
    try {
      if (!fs.existsSync(filePath)) return;
      const st = fs.statSync(filePath);
      if (!st.isFile() || st.size < 2048) return;
      candidates.push({ filePath, mtime: st.mtimeMs });
    } catch (_) {
      /* ignore */
    }
  }

  try {
    const names = fs.readdirSync(dir);
    for (const name of names) {
      if (!/^rootrecord/i.test(name)) continue;
      if (name.toLowerCase() === primaryName) continue;
      if (/\.unreadable\./i.test(name)) continue;
      if (!/\.db$/i.test(name)) continue;
      consider(path.join(dir, name));
    }
  } catch (_) {
    /* ignore */
  }

  const backupsDir = path.join(dir, 'backups');
  try {
    if (fs.existsSync(backupsDir)) {
      for (const name of fs.readdirSync(backupsDir)) {
        if (/\.(sqlite3|db)$/i.test(name)) {
          consider(path.join(backupsDir, name));
        }
      }
    }
  } catch (_) {
    /* ignore */
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].filePath;
}

function moveAsideUnreadablePrimary(dbPath) {
  if (!fs.existsSync(dbPath)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const dest = dbPath.replace(/\.db$/i, `.unreadable.${stamp}.db`);
  fs.renameSync(dbPath, dest);
  console.warn('[database] Renamed unreadable DB to:', dest);
}

async function openMigrateAndBootstrap(dbPath) {
  const db = await openDatabase(dbPath);
  try {
    await configurePragmas(db);
    await ensureBaseSchema(db);
    await runMigrations(db, 1);
    await bootstrapSession(db);
    return db;
  } catch (e) {
    await closeDbHandle(db);
    throw e;
  }
}

/**
 * 1) Open + migrate + bootstrap.
 * 2) On recoverable SQLite errors: strip WAL/SHM and retry (fixes most copy/migration cases).
 * 3) If still failing: restore from newest backup in data/ or data/backups/, then retry once.
 */
async function initWithAutomaticRecovery(dbPath) {
  try {
    return await openMigrateAndBootstrap(dbPath);
  } catch (eFirst) {
    const m1 = sqlErrMsg(eFirst);
    if (!isRecoverableSqliteOpenError(m1)) throw eFirst;

    console.warn('[database] Recoverable SQLite error — clearing WAL/SHM and retrying:', m1);
    unlinkWalAndShm(dbPath);

    try {
      return await openMigrateAndBootstrap(dbPath);
    } catch (eSecond) {
      const m2 = sqlErrMsg(eSecond);
      if (!isRecoverableSqliteOpenError(m2)) throw eSecond;

      const backupPath = findLatestBackupCandidate(dbPath);
      if (!backupPath) {
        console.error('[database] Primary DB still unreadable and no backup candidate found.');
        throw eSecond;
      }

      console.warn('[database] Restoring primary DB from:', backupPath);
      unlinkWalAndShm(dbPath);
      try {
        if (fs.existsSync(dbPath)) moveAsideUnreadablePrimary(dbPath);
      } catch (moveErr) {
        console.error('[database] Could not move aside corrupt file; aborting restore.', moveErr);
        throw eSecond;
      }

      fs.copyFileSync(backupPath, dbPath);
      try {
        fs.chmodSync(dbPath, 0o666);
      } catch (_) {
        /* ignore */
      }
      unlinkWalAndShm(dbPath);

      return await openMigrateAndBootstrap(dbPath);
    }
  }
}

async function initDatabase() {
  if (dbInstance) return { db: dbInstance, dbPath: dbPathUsed };
  if (!initPromise) {
    initPromise = (async () => {
      migrateLegacyWindowsRootRecordHomeIfNeeded();
      migrateBusinessDataFromProfileRootIfNeeded();
      dbPathUsed = defaultRootRecordDbPath();
      ensureDbParentDir(dbPathUsed);
      try {
        if (fs.existsSync(dbPathUsed)) {
          fs.chmodSync(dbPathUsed, 0o666);
        }
      } catch (_) {
        /* ignore */
      }
      const db = await initWithAutomaticRecovery(dbPathUsed);
      dbInstance = db;
      lastInitFailure = null;
      return { db, dbPath: dbPathUsed };
    })().catch((e) => {
      console.error('[database init]', e);
      const pathAtFail = dbPathUsed;
      lastInitFailure = {
        message: e && e.message ? String(e.message) : String(e),
        path: pathAtFail || null
      };
      dbInstance = null;
      dbPathUsed = null;
      throw e;
    });
  }
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

async function closeDatabase() {
  initPromise = null;
  if (!dbInstance) return;
  await new Promise((resolve, reject) => {
    dbInstance.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  dbInstance = null;
  dbPathUsed = null;
}

function getDb() {
  return dbInstance;
}

function getDbPath() {
  return dbPathUsed;
}

module.exports = {
  initDatabase,
  closeDatabase,
  getDb,
  getDbPath,
  getLastInitFailure
};
