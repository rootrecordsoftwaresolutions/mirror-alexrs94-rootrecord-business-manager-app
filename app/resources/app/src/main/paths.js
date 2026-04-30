'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/** Business SQLite + machine_session + backups live here by default (Weather Manager keeps its DB under its app folder). */
const BUSINESS_DATA_DIR = 'business_data';

function usesCustomSqlitePath() {
  return Boolean(String(process.env.SQLITE_PATH || '').trim());
}

/**
 * Legacy profile tree (pre–business_data): %USERPROFILE%\RootRecord\data\rootrecord.db etc.
 * Still used as a one-time migration source. Override: ROOTRECORD_HOME (full tree root).
 *
 * Legacy installs used %LOCALAPPDATA%\RootRecord; see migrateLegacyWindowsRootRecordHomeIfNeeded().
 */
function resolveRootRecordHome() {
  const envHome = String(process.env.ROOTRECORD_HOME || '').trim();
  if (envHome) return path.resolve(envHome);
  if (process.platform === 'win32') {
    const profile = String(process.env.USERPROFILE || '').trim();
    if (profile) return path.join(profile, 'RootRecord');
  }
  return path.join(app.getPath('home'), 'RootRecord');
}

/**
 * Folder for machine_session, backups, and (default) rootrecord.db.
 * Default: …\Business Manager\business_data
 * SQLITE_PATH: auxiliary files stay under profile …\RootRecord\data (DB path is independent).
 */
function resolveBusinessDataRoot() {
  if (usesCustomSqlitePath()) return path.join(resolveRootRecordHome(), 'data');
  return path.join(app.getPath('userData'), BUSINESS_DATA_DIR);
}

/**
 * One-time: copy older LocalAppData RootRecord tree into the user-profile folder when the new location has no DB yet.
 * Skipped if ROOTRECORD_HOME or SQLITE_PATH is set.
 */
function migrateLegacyWindowsRootRecordHomeIfNeeded() {
  if (process.platform !== 'win32') return;
  if (String(process.env.ROOTRECORD_HOME || '').trim()) return;
  if (String(process.env.SQLITE_PATH || '').trim()) return;

  const profile = String(process.env.USERPROFILE || '').trim();
  if (!profile) return;
  const newHome = path.join(profile, 'RootRecord');
  const newDb = path.join(newHome, 'data', 'rootrecord.db');
  if (fs.existsSync(newDb)) return;

  const local = String(process.env.LOCALAPPDATA || '').trim();
  if (!local) return;
  const legacyHome = path.join(local, 'RootRecord');
  const legacyDb = path.join(legacyHome, 'data', 'rootrecord.db');
  if (!fs.existsSync(legacyDb)) return;

  try {
    if (!fs.existsSync(newHome)) {
      fs.cpSync(legacyHome, newHome, { recursive: true });
      return;
    }
    fs.mkdirSync(path.dirname(newDb), { recursive: true });
    fs.copyFileSync(legacyDb, newDb);
    for (const suf of ['-wal', '-shm']) {
      const lp = legacyDb + suf;
      if (fs.existsSync(lp)) fs.copyFileSync(lp, newDb + suf);
    }
    const legacyUsers = path.join(legacyHome, 'users');
    const newUsers = path.join(newHome, 'users');
    if (fs.existsSync(legacyUsers) && !fs.existsSync(newUsers)) {
      fs.cpSync(legacyUsers, newUsers, { recursive: true });
    }
    const legacyMs = path.join(legacyHome, 'data', 'machine_session.json');
    const newMs = path.join(newHome, 'data', 'machine_session.json');
    if (fs.existsSync(legacyMs) && !fs.existsSync(newMs)) {
      fs.copyFileSync(legacyMs, newMs);
    }
  } catch (e) {
    console.error('RootRecord: could not migrate data from LocalAppData to user profile:', e);
  }
}

/**
 * One-time: after legacy profile migration, move …\RootRecord\data\* into …\Business Manager\business_data\
 * when the new folder has no DB yet. Does not remove the old profile copy (safe rollback).
 */
function migrateBusinessDataFromProfileRootIfNeeded() {
  if (String(process.env.SQLITE_PATH || '').trim()) return;

  const destRoot = resolveBusinessDataRoot();
  const destDb = path.join(destRoot, 'rootrecord.db');
  if (fs.existsSync(destDb)) return;

  const oldDb = path.join(resolveRootRecordHome(), 'data', 'rootrecord.db');
  if (!fs.existsSync(oldDb)) return;

  try {
    fs.mkdirSync(destRoot, { recursive: true });
    fs.copyFileSync(oldDb, destDb);
    for (const suf of ['-wal', '-shm']) {
      const lp = oldDb + suf;
      if (fs.existsSync(lp)) fs.copyFileSync(lp, destDb + suf);
    }
    const oldMs = path.join(resolveRootRecordHome(), 'data', 'machine_session.json');
    const newMs = path.join(destRoot, 'machine_session.json');
    if (fs.existsSync(oldMs) && !fs.existsSync(newMs)) {
      fs.copyFileSync(oldMs, newMs);
    }
    const oldUsers = path.join(resolveRootRecordHome(), 'users');
    const newUsers = path.join(destRoot, 'users');
    if (fs.existsSync(oldUsers) && !fs.existsSync(newUsers)) {
      fs.cpSync(oldUsers, newUsers, { recursive: true });
    }
    const oldBackups = path.join(resolveRootRecordHome(), 'data', 'backups');
    const newBackups = path.join(destRoot, 'backups');
    if (fs.existsSync(oldBackups) && !fs.existsSync(newBackups)) {
      fs.cpSync(oldBackups, newBackups, { recursive: true });
    }
    for (const name of fs.readdirSync(path.join(resolveRootRecordHome(), 'data'))) {
      if (!/^rootrecord/i.test(name)) continue;
      if (name.toLowerCase() === 'rootrecord.db') continue;
      if (!/\.db$/i.test(name)) continue;
      const src = path.join(resolveRootRecordHome(), 'data', name);
      const dst = path.join(destRoot, name);
      if (fs.existsSync(src) && !fs.existsSync(dst) && fs.statSync(src).isFile()) {
        fs.copyFileSync(src, dst);
      }
    }
    console.info('RootRecord: migrated business data to', destRoot);
  } catch (e) {
    console.error('RootRecord: could not migrate business data into business_data:', e);
  }
}

function defaultRootRecordDbPath() {
  const raw = String(process.env.SQLITE_PATH || '').trim();
  if (raw) return path.resolve(raw);
  return path.join(resolveBusinessDataRoot(), 'rootrecord.db');
}

function ensureDbParentDir(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

function dataDir() {
  return resolveBusinessDataRoot();
}

function machineSessionPath() {
  return path.join(dataDir(), 'machine_session.json');
}

function userRoot(userId) {
  if (usesCustomSqlitePath()) return path.join(resolveRootRecordHome(), 'users', String(userId));
  return path.join(dataDir(), 'users', String(userId));
}

function stateJsonPath(userId) {
  return path.join(userRoot(userId), 'state.json');
}

const RECORD_SUBDIRS = ['sheets', 'docs', 'receipts', 'reports', 'media'];

function ensureUserLayout(userId) {
  const root = userRoot(userId);
  for (const name of RECORD_SUBDIRS) {
    fs.mkdirSync(path.join(root, 'records', name), { recursive: true });
  }
  return root;
}

module.exports = {
  resolveRootRecordHome,
  resolveBusinessDataRoot,
  BUSINESS_DATA_DIR,
  defaultRootRecordDbPath,
  ensureDbParentDir,
  migrateLegacyWindowsRootRecordHomeIfNeeded,
  migrateBusinessDataFromProfileRootIfNeeded,
  dataDir,
  machineSessionPath,
  userRoot,
  stateJsonPath,
  ensureUserLayout
};
