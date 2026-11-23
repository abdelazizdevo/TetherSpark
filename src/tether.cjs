const { EventEmitter } = require('node:events');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { existsSync } = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { MeterBridge } = require('./meter.cjs');

function parseDevices(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const [serial, status, ...fields] = line.trim().split(/\s+/);
    if (!serial || !['device', 'offline', 'unauthorized', 'no'].includes(status)) return [];
    if (serial.startsWith('emulator-') || serial.includes(':') || serial.includes('._tcp')) return [];
    const model = fields.find(field => field.startsWith('model:'))?.slice(6).replaceAll('_', ' ');
    return [{ serial, status: status === 'no' ? 'no permissions' : status, name: model || 'Android device' }];
  });
}

function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid settings.');
  const result = {};
  for (const key of ['adb', 'gnirehtet', 'apk']) {
    if (typeof input[key] !== 'string' || !path.isAbsolute(input[key]) || !existsSync(input[key])) {
      throw new Error(`Choose an existing ${key} file.`);
    }
    if (!input[key].toLowerCase().endsWith(key === 'apk' ? '.apk' : '.exe')) {
      throw new Error(`${key} must be a ${key === 'apk' ? '.apk' : '.exe'} file.`);
    }
    result[key] = input[key];
  }
  const dns = String(input.dns || '1.1.1.1,8.8.8.8').trim();
  if (!dns.split(',').every(ip => net.isIPv4(ip))) throw new Error('DNS must be comma-separated IPv4 addresses.');
  result.dns = dns;
  return result;
}

class Tether extends EventEmitter {
  constructor({ settings, execute = promisify(execFile), launch = spawn, approvalTimeout = 120000,
    bridgeFactory = onBytes => new MeterBridge(onBytes) } = {}) {
    super();
    this.settings = settings || {};
    this.execute = execute;
    this.launch = launch;
    this.approvalTimeout = approvalTimeout;
    this.bridgeFactory = bridgeFactory;
    this.state = { phase: 'idle', serial: null, since: null, waitingUntil: null, bytesUp: 0, bytesDown: 0, message: 'Ready when you are.' };
    this.logs = [];
    this.child = null;
    this.busy = false;
    this.teardown = Promise.resolve();
  }

  snapshot() { return { ...this.state, logs: [...this.logs] }; }
  update(changes) { Object.assign(this.state, changes); this.emit('state', this.snapshot()); }
  log(message, level = 'info') {
    const entry = { time: new Date().toISOString(), level, message: String(message).slice(0, 2000) };
    this.logs.push(entry);
    if (this.logs.length > 300) this.logs.shift();
    this.emit('log', entry);
  }
  clearLogs() { this.logs = []; this.emit('logs-cleared'); }
  async deviceDetails(serial) {
    const device = (await this.devices()).find(item => item.serial === serial && item.status === 'device');
    if (!device) return null;
    const results = await Promise.allSettled([
      this.execute(this.settings.adb, ['-s', serial, 'shell', 'getprop', 'ro.build.version.release'], this.options()),
      this.execute(this.settings.adb, ['-s', serial, 'shell', 'pm', 'path', 'com.genymobile.gnirehtet'], this.options()),
    ]);
    return { serial,
      android: results[0].status === 'fulfilled' && /^[\d.]+$/.test(results[0].value.stdout.trim()) ? results[0].value.stdout.trim() : null,
      companion: results[1].status === 'fulfilled' ? results[1].value.stdout.includes('package:') : null };
  }
  options() {
    return { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
      env: { ...process.env, ADB: this.settings.adb, GNIREHTET_APK: this.settings.apk } };
  }
  async devices() {
    if (!this.settings.adb || !existsSync(this.settings.adb)) return [];
    const { stdout } = await this.execute(this.settings.adb, ['devices', '-l'], this.options());
    return parseDevices(stdout);
  }
  async connect(serial) {
    if (this.busy || this.child) throw new Error('Disconnect the current session first.');
    this.settings = validateSettings(this.settings);
    if (typeof serial !== 'string' || !serial || serial.startsWith('-')) throw new Error('Select a USB device.');
    this.busy = true;
    try {
      await this.teardown;
      const devices = await this.devices();
      const device = devices.find(item => item.serial === serial);
      if (!device || device.status !== 'device') throw new Error('Connect and authorize this phone before sharing.');
      this.update({ phase: 'starting', serial, since: null, waitingUntil: null, bytesUp: 0, bytesDown: 0, message: 'Preparing the Android connection…' });
      this.log(`Starting a session for ${device.name} (${serial}).`);
      this.bridge = this.bridgeFactory(bytes => this.update(bytes));
      const backendPort = await this.bridge.start();
      // Separate commands let us observe startup failures and stop the exact phone.
      const child = this.launch(this.settings.gnirehtet, ['relay', '-p', String(backendPort)], { ...this.options(), timeout: undefined });
      this.child = child;
      child.once('error', error => {
        if (this.child !== child) return;
        this.child = null;
        clearTimeout(this.timer);
        this.log(error.message, 'error');
        this.update({ phase: 'error', message: `Could not start relay: ${error.message}`, since: null });
      });
      const buffers = { stdout: '', stderr: '' };
      for (const stream of ['stdout', 'stderr']) {
        child[stream]?.on('data', data => {
          buffers[stream] += data.toString();
          const lines = buffers[stream].split(/\r?\n/);
          buffers[stream] = lines.pop().slice(-4000);
          for (const line of lines) this.relayLine(child, line);
        });
      }
      child.once('exit', code => {
        if (this.child !== child) return;
        this.child = null;
        clearTimeout(this.timer);
        this.log(`Relay exited (${code}).`, 'error');
        this.update({ phase: 'error', since: null, message: 'The relay stopped. Review the activity log and reconnect.' });
        // Best effort cleanup even when the relay crashes.
        if (!this.busy) this.teardown = (async () => {
          await this.stopRelay();
          await this.cleanupPhone(serial);
        })().catch(error => this.log(error.message, 'warning'));
      });
      // Wait for the relay's own ready message before launching the phone client.
      await this.waitForRelay(child);
      await this.execute(this.settings.gnirehtet, ['start', serial, '-d', this.settings.dns],
        { ...this.options(), timeout: 90000 });
      if (this.child !== child) throw new Error('Relay stopped during setup.');
      if (this.state.phase !== 'connected') {
        this.update({ phase: 'waiting', waitingUntil: Date.now() + this.approvalTimeout, message: 'Unlock your phone and approve the VPN connection.' });
        this.timer = setTimeout(() => {
          if (this.child === child && this.state.phase === 'waiting') {
            this.disconnect('No Android connection received. Approve the VPN request, then try again.').catch(error => this.log(error.message, 'error'));
          }
        }, this.approvalTimeout);
      }
    } catch (error) {
      await this.stopRelay();
      if (this.state.serial) await this.cleanupPhone(this.state.serial).catch(err => this.log(err.message, 'warning'));
      this.log(error.message, 'error');
      this.update({ phase: 'error', since: null, serial: null, waitingUntil: null, message: error.message });
      throw error;
    } finally { this.busy = false; }
    return this.snapshot();
  }
  waitForRelay(child) {
    if (this.relayReady === child) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timeout);
        this.removeListener('relay-ready', ready);
        child.removeListener('exit', exited);
        child.removeListener('error', failed);
        error ? reject(error) : resolve();
      };
      const ready = source => { if (source === child) finish(); };
      const exited = () => finish(new Error('Relay could not start. Check whether port 31416 is already in use.'));
      const failed = error => finish(error);
      const timeout = setTimeout(() => finish(new Error('Relay startup timed out.')), 10000);
      this.on('relay-ready', ready);
      child.once('exit', exited);
      child.once('error', failed);
    });
  }
  relayLine(child, line) {
    if (!line.trim() || this.child !== child) return;
    this.log(line, /\bERROR\b/.test(line) ? 'error' : 'info');
    if (/Relay server started/.test(line)) {
      this.relayReady = child;
      this.emit('relay-ready', child);
    }
    if (/Client #\d+ connected/.test(line)) {
      clearTimeout(this.timer);
      this.update({ phase: 'connected', waitingUntil: null, since: this.state.since || Date.now(), message: 'Android tunnel connected. Your PC is relaying traffic.' });
    } else if (/Client #\d+ disconnected/.test(line)) {
      this.update({ phase: 'waiting', since: null, waitingUntil: null, message: 'Android tunnel interrupted. Check the USB cable and reconnect.' });
    }
  }
  async cleanupPhone(serial) {
    const { adb, gnirehtet } = this.settings;
    const options = this.options();
    let stopError;
    try { await this.execute(gnirehtet, ['stop', serial], options); }
    catch (error) { stopError = error; }
    try { await this.execute(adb, ['-s', serial, 'reverse', '--remove', 'localabstract:gnirehtet'], options); }
    catch (error) { this.log(`Tunnel cleanup: ${error.message}`, 'warning'); }
    if (stopError) throw new Error(`Could not stop the Android VPN: ${stopError.message}. Turn it off on the phone.`);
  }
  async stopRelay() {
    clearTimeout(this.timer);
    const bridge = this.bridge;
    this.bridge = null;
    if (bridge) await bridge.stop();
    const child = this.child;
    this.child = null;
    this.relayReady = null;
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      child.kill();
    });
  }
  async disconnect(message = 'Disconnected. Ready for your next session.') {
    if (this.busy) throw new Error('Connection setup is still running. Please wait.');
    this.busy = true;
    const serial = this.state.serial;
    this.update({ phase: 'stopping', message: 'Stopping the connection…' });
    try {
      await this.teardown;
      // Stop the relay immediately even if the phone is no longer reachable.
      await this.stopRelay();
      if (serial) await this.cleanupPhone(serial);
      this.log(message);
      this.update({ phase: 'idle', serial: null, since: null, waitingUntil: null, message });
    } catch (error) {
      this.log(error.message, 'warning');
      this.update({ phase: 'error', serial: null, since: null, waitingUntil: null, message: error.message });
    } finally { this.busy = false; }
    return this.snapshot();
  }
}

module.exports = { Tether, parseDevices, validateSettings };
