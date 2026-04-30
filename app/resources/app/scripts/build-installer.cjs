'use strict';

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..');
const pkgPath = path.join(appDir, 'package.json');

function readPkg() {
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}

function runNode(scriptRel, args = []) {
  const r = spawnSync(process.execPath, [path.join(__dirname, scriptRel), ...args], {
    cwd: appDir,
    stdio: 'inherit',
    shell: false
  });
  if (r.status !== 0) process.exit(r.status || 1);
}

function findIscc() {
  const env = process.env.INNO_SETUP && String(process.env.INNO_SETUP).trim();
  if (env && fs.existsSync(env)) return env;
  const candidates = [
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function main() {
  const pkg = readPkg();
  const version = pkg.version;

  runNode('build-windows.cjs');

  const iscc = findIscc();
  if (!iscc) {
    console.error(
      '[build-installer] Inno Setup 6 not found. Set INNO_SETUP to ISCC.exe or install Inno Setup 6.'
    );
    process.exit(1);
  }

  const iss = path.join(appDir, 'build', 'installer.iss');
  if (!fs.existsSync(iss)) {
    console.error('[build-installer] Missing', iss);
    process.exit(1);
  }

  const outDir = path.join(appDir, 'build', 'output');
  fs.mkdirSync(outDir, { recursive: true });

  execFileSync(iscc, [`/DAppVersion=${version}`, iss], {
    stdio: 'inherit',
    cwd: path.join(appDir, 'build')
  });

  const unsignedName = `Unsigned-Root Record Business Manager-Setup-${version}.exe`;
  const unsignedPath = path.join(outDir, unsignedName);

  if (!fs.existsSync(unsignedPath)) {
    console.warn('[build-installer] Expected unsigned installer not found:', unsignedPath);
    process.exit(1);
  }

  runNode('write-latest-yml.cjs', [unsignedPath]);

  console.log(`[build-installer] Done. Version ${version}`);
  console.log(
    '[build-installer] Authenticode: run sibling build/sign_release_azure.ps1 (see docs/RELEASE.md) when you need a signed installer name.'
  );
}

main();
