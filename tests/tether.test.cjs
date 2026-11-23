const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Tether, parseDevices, validateSettings } = require('../src/tether.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tetherdesk-test-'));
const settings = { adb: path.join(directory, 'adb.exe'), gnirehtet: path.join(directory, 'gnirehtet.exe'), apk: path.join(directory, 'gnirehtet.apk'), dns: '1.1.1.1,8.8.8.8' };
for (const key of ['adb', 'gnirehtet', 'apk']) fs.writeFileSync(settings[key], 'fixture');
after(() => {
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('tetherdesk-test-')) throw new Error('Invalid test directory.');
  fs.rmSync(directory, { recursive: true, force: true });
});

function harness({ status = 'device', failStart = false, failStop = false, relayError = false, approvalTimeout } = {}) {
  const calls = [];
  let relay;
  const tether = new Tether({ settings, approvalTimeout,
    bridgeFactory: () => ({ start: async () => 31417, stop: async () => {} }),
    execute: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === 'devices') return { stdout: `List of devices attached\nUSB123 ${status} product:foo model:Pixel_8 transport_id:1\n` };
      if (failStart && args[0] === 'start') throw new Error('Android install failed');
      if (failStop && args[0] === 'stop') throw new Error('Device offline');
      return { stdout: 'Success' };
    },
    launch: (file, args, options) => {
      calls.push({ file, args, options });
      relay = new EventEmitter();
      relay.stdout = new PassThrough(); relay.stderr = new PassThrough(); relay.exitCode = null;
      relay.kill = () => { relay.exitCode = 0; queueMicrotask(() => relay.emit('exit', 0)); };
      queueMicrotask(() => {
        if (relayError) { relay.exitCode = 3; relay.emit('exit', 3); }
        else relay.stdout.write('INFO Relay: Relay server started\n');
      });
      return relay;
    },
  });
  return { tether, calls, relay: () => relay };
}

test('device parsing includes unauthorized USB phones and excludes network devices/emulators', () => {
  const result = parseDevices('List of devices attached\r\nUSB123 device model:Pixel_8 transport_id:1\r\nLOCKED unauthorized\nGONE offline\nemulator-5554 device\n192.168.1.3:5555 device\nadb-foo._adb-tls-connect._tcp device\n* daemon started successfully\n');
  assert.deepEqual(result.map(device => [device.serial, device.status]), [['USB123', 'device'], ['LOCKED', 'unauthorized'], ['GONE', 'offline']]);
  assert.equal(result[0].name, 'Pixel 8');
});
test('settings reject nonexistent paths, wrong extensions, and malformed DNS', () => {
  assert.deepEqual(validateSettings(settings), settings);
  assert.throws(() => validateSettings({ ...settings, adb: 'adb.exe' }), /existing adb/);
  assert.throws(() => validateSettings({ ...settings, apk: settings.adb }), /\.apk/);
  for (const dns of ['1.2.3.999', '1.1.1.1;calc.exe', 'localhost', '::1', '1.1.1.1,']) {
    assert.throws(() => validateSettings({ ...settings, dns }), /IPv4/);
  }
});
test('unauthorized phone cannot start any relay', async () => {
  const { tether, calls } = harness({ status: 'unauthorized' });
  await assert.rejects(tether.connect('USB123'), /authorize/);
  assert.equal(tether.state.phase, 'error');
  assert.equal(calls.length, 1);
});
test('selected device receives explicit serial; connection waits for real client log', async () => {
  const { tether, calls, relay } = harness();
  await tether.connect('USB123');
  assert.equal(tether.state.phase, 'waiting');
  assert.equal(tether.state.since, null);
  assert(tether.state.waitingUntil > Date.now() && tether.state.waitingUntil <= Date.now() + 120000);
  assert.deepEqual(calls.find(call => call.args[0] === 'relay').args, ['relay', '-p', '31417']);
  const start = calls.find(call => call.args[0] === 'start');
  assert.deepEqual(start.args, ['start', 'USB123', '-d', settings.dns]);
  assert.equal(start.options.env.ADB, settings.adb);
  assert.equal(start.options.env.GNIREHTET_APK, settings.apk);
  assert.equal(calls.find(call => call.args[0] === 'relay').options.timeout, undefined);
  relay().stdout.write('INFO RelayServer: Client #0 con');
  assert.equal(tether.state.phase, 'waiting');
  relay().stdout.write('nected\n');
  assert.equal(tether.state.phase, 'connected');
  assert.equal(typeof tether.state.since, 'number');
  assert.equal(tether.state.waitingUntil, null);
  await tether.disconnect();
  assert.equal(tether.state.phase, 'idle');
  assert.equal(tether.child, null);
  assert.equal(relay().exitCode, 0);
  assert(calls.some(call => call.args[0] === 'stop' && call.args[1] === 'USB123'));
  assert(calls.some(call => JSON.stringify(call.args) === JSON.stringify(['-s', 'USB123', 'reverse', '--remove', 'localabstract:gnirehtet'])));
});
test('failed Android startup stops relay and cleans up selected phone', async () => {
  const { tether, calls, relay } = harness({ failStart: true });
  await assert.rejects(tether.connect('USB123'), /install failed/);
  assert.equal(tether.state.phase, 'error');
  assert.equal(tether.child, null);
  assert.equal(relay().exitCode, 0);
  assert(calls.some(call => call.args[0] === 'stop'));
});
test('relay failing before readiness never starts Android client', async () => {
  const { tether, calls } = harness({ relayError: true });
  await assert.rejects(tether.connect('USB123'), /Relay could not start/);
  assert.equal(tether.state.phase, 'error');
  assert(!calls.some(call => call.args[0] === 'start'));
});
test('concurrent connect is rejected and unplugged phone does not keep relay alive', async () => {
  const { tether, relay } = harness({ failStop: true });
  const connecting = tether.connect('USB123');
  await assert.rejects(tether.connect('USB123'), /Disconnect/);
  await connecting;
  await tether.disconnect();
  assert.equal(relay().exitCode, 0);
  assert.equal(tether.state.phase, 'error');
  assert.match(tether.state.message, /Turn it off on the phone/);
});
test('missing VPN approval times out and tears down the relay', async () => {
  const { tether, relay } = harness({ approvalTimeout: 15 });
  await tether.connect('USB123');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(tether.child, null);
  assert.equal(relay().exitCode, 0);
  assert.match(tether.state.message, /No Android connection/);
});
test('client disconnect clears connected state and uptime', async () => {
  const { tether, relay } = harness();
  await tether.connect('USB123');
  relay().stdout.write('INFO RelayServer: Client #0 connected\n');
  relay().stdout.write('INFO RelayServer: Client #0 disconnected\n');
  assert.equal(tether.state.phase, 'waiting');
  assert.equal(tether.state.since, null);
  await tether.disconnect();
});
test('serial is checked against actual device enumeration before launching', async () => {
  const { tether } = harness();
  await assert.rejects(tether.connect('-s'), /Select/);
  await assert.rejects(tether.connect('OTHER'), /authorize/);
  assert.equal(tether.child, null);
});
test('activity buffer is bounded', () => {
  const { tether } = harness();
  for (let i = 0; i < 350; i++) tether.log(`event ${i}`);
  assert.equal(tether.logs.length, 300);
  assert.equal(tether.logs[0].message, 'event 50');
});
test('unexpected relay exit cleans up before a retry starts another session', async () => {
  const { tether, relay, calls } = harness();
  await tether.connect('USB123');
  const first = relay();
  first.exitCode = 3;
  first.emit('exit', 3);
  assert.equal(tether.state.phase, 'error');
  await tether.connect('USB123');
  const commands = calls.map(call => call.args[0]);
  const stop = commands.indexOf('stop');
  const lastRelay = commands.lastIndexOf('relay');
  assert(stop > 0 && lastRelay > stop);
  const cleanup = calls.findIndex(call => call.args[2] === 'reverse');
  assert(cleanup > stop && lastRelay > cleanup);
  await tether.disconnect();
});
test('device details report Android version and companion presence from the selected phone', async () => {
  const calls = [];
  const tether = new Tether({ settings, execute: async (_file, args) => {
    calls.push(args);
    if (args[0] === 'devices') return { stdout: 'USB123 device model:Pixel_8\nLOCKED unauthorized\n' };
    return { stdout: args.includes('getprop') ? '15\n' : 'package:/data/app/gnirehtet/base.apk\n' };
  } });
  assert.deepEqual(await tether.deviceDetails('USB123'), { serial: 'USB123', android: '15', companion: true });
  assert(calls.filter(args => args[0] === '-s').every(args => args[1] === 'USB123'));
  const count = calls.length;
  assert.equal(await tether.deviceDetails('LOCKED'), null);
  assert.equal(calls.length, count + 1);
});
test('clearing activity removes the export buffer and notifies the UI', () => {
  const { tether } = harness(); let cleared = false;
  tether.log('Old event'); tether.on('logs-cleared', () => { cleared = true; });
  tether.clearLogs(); assert.deepEqual(tether.snapshot().logs, []); assert(cleared);
});
