'use strict';

const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const parts = String(pkg.version).split('.');
const last = parts.pop();
const n = parseInt(last, 10);
if (Number.isNaN(n)) throw new Error(`Invalid version: ${pkg.version}`);
parts.push(String(n + 1));
pkg.version = parts.join('.');
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log(`[bump-patch] ${pkg.version}`);
