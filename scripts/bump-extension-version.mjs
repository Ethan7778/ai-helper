import { readFileSync, writeFileSync } from 'node:fs';

const paths = ['package.json', 'package-lock.json', 'extension/manifest.json'];
const [pkg, lock, manifest] = paths.map(path => JSON.parse(readFileSync(path, 'utf8')));
if (pkg.version !== manifest.version || pkg.version !== lock.version || pkg.version !== lock.packages[''].version) {
  throw new Error('Package, lockfile, and manifest versions must match before bumping.');
}
const parts = manifest.version.split('.').map(Number);
if (parts.length !== 3 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 65535) || parts[2] === 65535) {
  throw new Error('Expected a three-part Chrome version with room to increase the patch version.');
}
parts[2]++;
const version = parts.join('.');
pkg.version = manifest.version = lock.version = lock.packages[''].version = version;
[pkg, lock, manifest].forEach((value, i) => writeFileSync(paths[i], `${JSON.stringify(value, null, 2)}\n`));
console.log(`Extension version updated to ${version}. Commit these files with your changes and push to main.`);
