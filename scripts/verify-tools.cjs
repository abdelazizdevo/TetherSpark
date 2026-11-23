const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { MeterBridge } = require('../src/meter.cjs');

async function main() {
  const root = path.resolve(__dirname, '..', 'tools');
  const adb = path.join(root, 'platform-tools', 'adb.exe');
  const version = execFileSync(adb, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.match(version, /Android Debug Bridge version/); console.log(version.trim());
  let measured = {};
  const bridge = new MeterBridge(bytes => { measured = bytes; }, { port: 0 });
  let child;
  let client;
  try {
    const backendPort = await bridge.start();
    child = spawn(path.join(root, 'gnirehtet', 'gnirehtet.exe'), ['relay', '-p', String(backendPort)], { windowsHide: true });
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Relay readiness timed out: ${output}`)), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Relay exited early (${code}): ${output}`)); });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
        output += data.toString();
        if (/Relay server started/.test(output)) { clearTimeout(timer); resolve(); }
      });
    });
    // A local protocol handshake checks the real relay through the byte counter.
    // It neither starts an Android app nor sends traffic to the internet.
    await new Promise((resolve, reject) => {
      client = net.connect(bridge.port, '127.0.0.1');
      client.setTimeout(5000, () => client.destroy(new Error('Relay handshake timed out')));
      client.once('error', reject);
      client.once('data', data => { assert(data.length > 0); client.destroy(); resolve(); });
    });
    await bridge.stop();
    assert(measured.bytesDown > 0);
    console.log(`Real Gnirehtet relay handshake passed through the meter (${measured.bytesDown} bytes received).`);
  } finally {
    client?.destroy(); await bridge.stop();
    if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
