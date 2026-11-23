const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');

async function download(url, destination) {
  console.log(`Downloading ${new URL(url).hostname}${new URL(url).pathname}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 150 * 1024 * 1024) throw new Error('Unexpectedly large download.');
  await fs.writeFile(destination, buffer);
  return createHash('sha256').update(buffer).digest('hex');
}
async function extract(archive, destination) {
  await fs.mkdir(destination, { recursive: true });
  await execute('tar.exe', ['-xf', archive, '-C', destination], { windowsHide: true, timeout: 120000 });
}
async function locate(directory, name) {
  for (const file of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, file.name);
    if (file.isFile() && file.name === name) return full;
    if (file.isDirectory()) { const result = await locate(full, name); if (result) return result; }
  }
}
async function main() {
  if (process.platform !== 'win32') throw new Error('This setup script targets Windows x64.');
  const staging = await fs.mkdtemp(path.join(root, '.downloads-'));
  const hashes = {};
  // Preserve an existing installation until both archives download and extract.
  try {
    for (const [name, url] of [
      ['gnirehtet', 'https://github.com/Genymobile/gnirehtet/releases/download/v2.5.1/gnirehtet-rust-win64-v2.5.1.zip'],
      ['platform-tools', 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'],
    ]) {
      const archive = path.join(staging, `${name}.zip`);
      hashes[name] = { url, sha256: await download(url, archive) };
      await extract(archive, path.join(staging, name));
    }
    const relay = await locate(path.join(staging, 'gnirehtet'), 'gnirehtet.exe');
    const adb = await locate(path.join(staging, 'platform-tools'), 'adb.exe');
    const apk = await locate(path.join(staging, 'gnirehtet'), 'gnirehtet.apk');
    if (!relay || !adb || !apk) throw new Error('Downloaded archives are missing required files.');
    await fs.mkdir(path.join(root, 'tools'), { recursive: true });
    await fs.cp(path.dirname(relay), path.join(root, 'tools', 'gnirehtet'), { recursive: true });
    await fs.cp(path.dirname(adb), path.join(root, 'tools', 'platform-tools'), { recursive: true });
    // Keep upstream licenses alongside redistributed executables and APK.
    const license = await fetch('https://raw.githubusercontent.com/Genymobile/gnirehtet/v2.5.1/LICENSE', { signal: AbortSignal.timeout(30000) });
    if (!license.ok) throw new Error('Could not download the Gnirehtet license.');
    await fs.writeFile(path.join(root, 'tools', 'gnirehtet', 'LICENSE'), await license.text());
    await fs.writeFile(path.join(root, 'tools', 'downloads.json'), JSON.stringify(hashes, null, 2));
    console.log('Desktop tools are ready. Run npm start to open TetherSpark.');
  } finally {
    // mkdtemp creates this exact directory under the verified project root.
    if (path.dirname(staging) !== root || !path.basename(staging).startsWith('.downloads-')) throw new Error('Invalid staging directory.');
    await fs.rm(staging, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
