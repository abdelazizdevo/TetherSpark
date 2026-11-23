const { packager } = require('@electron/packager');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const appVersion = require('../package.json').version;
const productName = require('../package.json').productName;
if (!/^\d+\.\d+\.\d+$/.test(appVersion)) throw new Error('Invalid app version.');
if (productName !== 'TetherSpark') throw new Error('Unexpected product name.');
const icon = path.join(root, 'src', 'ui', 'assets', 'tetherspark.ico');
if (!fs.existsSync(icon)) throw new Error('Run npm run build:icons before packaging.');
for (const file of ['gnirehtet/gnirehtet.exe', 'gnirehtet/gnirehtet.apk', 'gnirehtet/LICENSE', 'platform-tools/adb.exe', 'platform-tools/NOTICE.txt']) {
  if (!fs.existsSync(path.join(root, 'tools', file))) {
    console.error(`Missing tools/${file}. Run npm run setup before packaging.`);
    process.exit(1);
  }
}
// Reuse a verified local archive when available; otherwise use Electron's normal cache/download.
const version = require('electron/package.json').version;
const archiveName = `electron-v${version}-win32-x64.zip`;
const archive = path.join(root, 'artifacts', archiveName);
let electronZipDir;
if (fs.existsSync(archive)) {
  const expected = require('electron/checksums.json')[archiveName];
  const actual = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (!expected || actual !== expected) throw new Error('Local Electron archive failed checksum verification.');
  electronZipDir = path.dirname(archive);
}
const temporaryDirectory = path.join(root, 'artifacts', 'package-temp');
fs.mkdirSync(temporaryDirectory, { recursive: true });
packager({
  dir: root, out: path.join(root, 'dist', appVersion), name: productName, platform: 'win32', arch: 'x64', icon,
  overwrite: true, asar: { unpackDir: 'tools' }, prune: true,
  electronZipDir,
  tmpdir: temporaryDirectory,
  ignore: [/^\/dist(?:\/|$)/, /^\/branding(?:\/|$)/, /^\/artifacts(?:\/|$)/, /^\/tests(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/\.downloads/, /^\/\.git(?:\/|$)/],
  appCopyright: 'Copyright © 2026 TetherSpark contributors',
}).then(paths => console.log(`Packaged app: ${paths.join(', ')}`)).catch(error => { console.error(error); process.exitCode = 1; });
