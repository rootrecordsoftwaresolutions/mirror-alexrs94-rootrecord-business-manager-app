'use strict';

const { BrowserWindow, dialog } = require('electron');

/**
 * True when the app is running from a Microsoft Store / MSIX-style install (under WindowsApps).
 * Do not use GitHub — that would conflict with Store-only update policy for that channel.
 */
function isMicrosoftStoreLayoutInstall(app) {
  if (process.platform !== 'win32' || !app || !app.isPackaged) return false;
  try {
    const exe = app.getPath('exe') || '';
    return /\\WindowsApps\\/i.test(exe) || /\/WindowsApps\//i.test(exe);
  } catch {
    return false;
  }
}

/**
 * GitHub Releases updates via electron-updater.
 *
 * Packaged apps include `resources/app-update.yml` → provider **github**, **RootRecord/rootrecord-business-manager-download**.
 * Releases must ship **Signed** `Root Record Business Manager-Setup-{version}.exe` + matching `latest.yml` (see `npm run build:installer:signed` +
 * `Publish Release to GitHub.bat` / `scripts/publish-github-release.ps1`). Checksum in `latest.yml` must match the uploaded EXE.
 *
 * Runs only when packaged; skipped in dev / --no-update-check / Store layout / RR_DISABLE_AUTO_UPDATE.
 */
function setupAutoUpdater(app, getMainWindow) {
  if (!app.isPackaged) return;
  if (process.argv.includes('--no-update-check')) return;
  /** Store-only / enterprise builds that must update via Partner Center (not GitHub): set RR_DISABLE_AUTO_UPDATE=1 when launching. */
  if (String(process.env.RR_DISABLE_AUTO_UPDATE || '').trim() === '1') return;
  /** Microsoft Store installs update via the Store; electron-updater would bypass that channel. */
  if (isMicrosoftStoreLayoutInstall(app)) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }

  autoUpdater.autoDownload = false;

  autoUpdater.on('error', (err) => {
    console.warn('[autoUpdater]', err && err.message ? err.message : err);
  });

  autoUpdater.on('update-available', async (info) => {
    const ver = info && info.version ? String(info.version) : 'newer';
    const parent = getMainWindow && getMainWindow() ? getMainWindow() : BrowserWindow.getFocusedWindow();
    const { response } = await dialog.showMessageBox(parent || undefined, {
      type: 'info',
      title: 'Update available',
      message: `RootRecord Business Manager ${ver} is available.`,
      detail: 'Download and install when you are ready.',
      buttons: ['Download', 'Not now'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 0) {
      try {
        await autoUpdater.downloadUpdate();
      } catch (e) {
        dialog.showErrorBox('Update failed', e && e.message ? e.message : String(e));
      }
    }
  });

  autoUpdater.on('update-downloaded', async () => {
    const parent = getMainWindow && getMainWindow() ? getMainWindow() : BrowserWindow.getFocusedWindow();
    const { response } = await dialog.showMessageBox(parent || undefined, {
      type: 'info',
      title: 'Update ready',
      message: 'Restart now to finish installing the update?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 6000);
}

module.exports = { setupAutoUpdater };
