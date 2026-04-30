'use strict';

/**
 * Writes electron-updater style latest.yml next to a Windows setup .exe.
 * Usage: node scripts/write-latest-yml.cjs <path-to-setup.exe>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha512File(filePath) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('base64');
}

function main() {
  const exePath = process.argv[2];
  if (!exePath) {
    console.error('Usage: node scripts/write-latest-yml.cjs <setup.exe>');
    process.exit(1);
  }
  const resolved = path.resolve(exePath);
  if (!fs.existsSync(resolved)) {
    console.error('File not found:', resolved);
    process.exit(1);
  }
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  const version = pkg.version;
  const base = path.basename(resolved);
  const sha512 = sha512File(resolved);
  const releaseDate = new Date().toISOString();

  const body =
    `version: ${version}\n` +
    `files:\n` +
    `  - url: ${base}\n` +
    `    sha512: ${sha512}\n` +
    `path: ${base}\n` +
    `sha512: ${sha512}\n` +
    `releaseDate: '${releaseDate}'\n`;

  const outYml = path.join(path.dirname(resolved), 'latest.yml');
  fs.writeFileSync(outYml, body, 'utf8');
  console.log('Wrote', outYml);
}

main();
