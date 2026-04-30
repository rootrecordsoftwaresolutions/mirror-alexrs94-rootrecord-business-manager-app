'use strict';

const path = require('path');
const fs = require('fs');
const packager = require('electron-packager');

const rimraf = (dir) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
};

async function main() {
  const appDir = path.join(__dirname, '..');
  const pkg = require(path.join(appDir, 'package.json'));
  const outRoot = path.join(appDir, 'dist');
  const targetName = 'RootRecordBusinessManager-win32-x64';
  const targetDir = path.join(outRoot, targetName);

  rimraf(targetDir);

  await packager({
    dir: appDir,
    name: 'RootRecordBusinessManager',
    platform: 'win32',
    arch: 'x64',
    overwrite: true,
    out: outRoot,
    appVersion: pkg.version,
    appCopyright: 'Copyright Root Record',
    ignore: [
      /^\/dist(\/|$)/i,
      /^\/build\/output(\/|$)/i,
      /^\/\.git(\/|$)/i,
      /^\/\.cursor(\/|$)/i,
      /^\/.github(\/|$)/i,
      /^\/docs(\/|$)/i,
      /\.md$/i,
      /\.bat$/i
    ],
    win32metadata: {
      CompanyName: 'Root Record',
      FileDescription: 'RootRecord Business Manager',
      ProductName: 'Root Record Business Manager',
      OriginalFilename: 'RootRecordBusinessManager.exe'
    }
  });

  const produced = path.join(outRoot, targetName);
  if (!fs.existsSync(produced)) {
    throw new Error(`Packager did not produce expected folder: ${produced}`);
  }
  console.log(`Packaged: ${produced}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
