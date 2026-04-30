'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { initDatabase, getDb, getDbPath, getLastInitFailure } = require('./main/database');
async function ensureDbOpen() {
  if (getDb()) return true;
  const attempts = 8;
  const gapMs = 150;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      await initDatabase();
      if (getDb()) return true;
    } catch (e) {
      lastErr = e;
      console.error('[ensureDbOpen] attempt', i + 1, '/', attempts, e && e.message ? e.message : e);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  if (lastErr) console.error('[ensureDbOpen] giving up:', lastErr);
  return false;
}
const { resetRootRecordLocalData, CLOUD_DELETE_CONFIRM_PHRASE } = require('./main/resetLocalData');
const { dispatch, listRegisteredUserIds } = require('./main/dataAccess');
const { submitFeedback } = require('./main/feedbackSubmit');
const licenseService = require('./main/licenseService');
const syncEngine = require('./main/syncEngine');
const { setupAutoUpdater } = require('./main/autoUpdate');

/** App userData (license/session): %USERPROFILE%\RootRecord\Business Manager. Business DB + files: …\Business Manager\business_data (override RR_BUSINESS_MANAGER_HOME / ROOTRECORD_HOME; SQLITE_PATH for custom DB file). */
function resolveBusinessManagerHome() {
  const direct = String(process.env.RR_BUSINESS_MANAGER_HOME || '').trim();
  if (direct) return path.resolve(direct);
  const userProfile = String(process.env.USERPROFILE || os.homedir() || '').trim();
  const envHome = String(process.env.ROOTRECORD_HOME || '').trim();
  if (envHome) {
    return path.join(path.resolve(envHome), 'Business Manager');
  }
  if (userProfile) {
    return path.join(userProfile, 'RootRecord', 'Business Manager');
  }
  return path.join(app.getPath('home'), 'RootRecord', 'Business Manager');
}

const managerUserDataDir = resolveBusinessManagerHome();
fs.mkdirSync(managerUserDataDir, { recursive: true });
try {
  app.setPath('userData', managerUserDataDir);
} catch {
  /* ignore */
}

let mainWindow;

function getMainWindow() {
  return mainWindow || null;
}

function resolveAppIconPath() {
  const ico = path.join(__dirname, '..', 'assets', 'favicon.ico');
  if (fs.existsSync(ico)) return ico;
  return undefined;
}

function createWindow() {
  const iconPath = resolveAppIconPath();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: 'RootRecord Business Manager',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function registerIpc() {
  ipcMain.handle('rr-bootstrap', async () => {
    const appVersion = app.getVersion();
    await ensureDbOpen();
    const db = getDb();
    if (!db) {
      const fail = getLastInitFailure();
      console.error('[rr-bootstrap] Could not open database:', fail && fail.message ? fail.message : '(unknown)');
      return { ok: false, appVersion };
    }
    const userIds = await listRegisteredUserIds(db);
    return {
      ok: true,
      dbPath: getDbPath(),
      userIds: userIds.length ? userIds : [1],
      defaultUserId: 1,
      appVersion
    };
  });

  ipcMain.handle('rr-api', async (_evt, { method, payload }) => {
    await ensureDbOpen();
    const db = getDb();
    if (!db) throw new Error('Database not initialized');
    return dispatch(db, method, payload || {});
  });

  ipcMain.handle('shell-open-path', async (_e, targetPath) => {
    const err = await shell.openPath(String(targetPath || ''));
    return { err: err || null };
  });

  ipcMain.handle('shell-open-external', async (_e, url) => {
    const u = String(url || '').trim();
    if (!u) return { ok: false };
    const lower = u.toLowerCase();
    /** https + mailto only (no plain http — reduces downgrade/MITM surface; aligns with Store security expectations). */
    if (!lower.startsWith('https://') && !lower.startsWith('mailto:')) {
      return { ok: false };
    }
    await shell.openExternal(u);
    return { ok: true };
  });

  ipcMain.handle('rr-feedback-submit', async (_evt, payload) => submitFeedback(payload || {}));

  ipcMain.handle('rr-reset-all-local-data', async (_evt, payload) => {
    await resetRootRecordLocalData(payload && payload.confirmPhrase);
    return { ok: true };
  });

  ipcMain.handle('rr-delete-cloud-sync-data', async (_evt, payload) => {
    const phrase = String((payload && payload.confirmPhrase) || '').trim();
    if (phrase !== CLOUD_DELETE_CONFIRM_PHRASE) {
      throw new Error(`You must type "${CLOUD_DELETE_CONFIRM_PHRASE}" exactly.`);
    }
    await ensureDbOpen();
    const db = getDb();
    if (!db) throw new Error('Database not initialized');
    await licenseService.deleteCloudSyncData();
    const userId =
      payload && payload.userId != null && payload.userId !== undefined
        ? parseInt(String(payload.userId), 10) || 1
        : 1;
    await syncEngine.clearLocalSyncAfterCloudDelete(db, userId);
    return { ok: true };
  });

  ipcMain.handle('license-prepare', async (_evt, payload) => {
    try {
      const forceRefresh = Boolean(payload && payload.forceRefresh);
      const result = await licenseService.prepare({ forceRefresh });
      try {
        return JSON.parse(JSON.stringify(result));
      } catch (serErr) {
        console.error('[license-prepare] IPC serialization failed:', serErr);
        return {
          ok: false,
          configured: true,
          authenticated: false,
          message:
            'Sign-in status could not be loaded from this build. Restart the app or reinstall RootRecord.',
          proPaymentLinkBase: licenseService.getProStripePaymentLinkBase()
        };
      }
    } catch (e) {
      console.error('[license-prepare]', e);
      const msg = e && e.message ? String(e.message) : String(e || 'Prepare failed.');
      return {
        ok: false,
        configured: true,
        authenticated: false,
        message: msg,
        proPaymentLinkBase: licenseService.getProStripePaymentLinkBase()
      };
    }
  });
  ipcMain.handle('license-login', async (_evt, payload) => {
    const email = payload && payload.email;
    const password = payload && payload.password;
    return licenseService.login(email, password);
  });
  ipcMain.handle('license-signup', async (_evt, payload) => {
    const email = payload && payload.email;
    const password = payload && payload.password;
    return licenseService.signup(email, password);
  });
  ipcMain.handle('license-logout', async () => licenseService.logout());

  ipcMain.handle('rr-sync-run', async () => {
    await ensureDbOpen();
    const db = getDb();
    if (!db) throw new Error('Database not initialized');
    return syncEngine.syncCycleBestEffort(db, 1);
  });

  ipcMain.handle('rr-sync-reupload-history', async () => {
    await ensureDbOpen();
    const db = getDb();
    if (!db) throw new Error('Database not initialized');
    await syncEngine.clearHistoryBackfilledFlag(db);
    return syncEngine.syncCycleBestEffort(db, 1);
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  const ok = await ensureDbOpen();
  if (!ok) console.error('Database init failed after retries — see logs above.');
  registerIpc();
  createWindow();
  setupAutoUpdater(app, getMainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
