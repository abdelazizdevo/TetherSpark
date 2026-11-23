const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Tether, validateSettings } = require('./tether.cjs');
const net = require('node:net');

let window;
let tether;
let quitting = false;
let operation = Promise.resolve();
// Keep the existing profile so the branding update retains settings and preferences.
app.setPath('userData', path.join(app.getPath('appData'), 'tetherdesk'));
app.setName('TetherSpark');
if (process.platform === 'win32') app.setAppUserModelId('com.tetherspark.desktop');
const smokeDirectory = process.env.TETHERDESK_SMOKE_DIR;
if (smokeDirectory) {
  app.setPath('userData', path.resolve(smokeDirectory));
  app.disableHardwareAcceleration();
}
const page = pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href;
const allowedLinks = {
  adb: 'https://developer.android.com/tools/releases/platform-tools',
  gnirehtet: 'https://github.com/Genymobile/gnirehtet/releases/tag/v2.5.1',
  debugging: 'https://developer.android.com/studio/run/device',
};

function defaults() {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'tools') : path.join(app.getAppPath(), 'tools');
  return { adb: path.join(root, 'platform-tools', 'adb.exe'),
    gnirehtet: path.join(root, 'gnirehtet', 'gnirehtet.exe'),
    apk: path.join(root, 'gnirehtet', 'gnirehtet.apk'), dns: '1.1.1.1,8.8.8.8' };
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== page) throw new Error('Untrusted request.');
    try { return { ok: true, value: await callback(...args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    const configFile = path.join(app.getPath('userData'), 'settings.json');
    let settings = defaults();
    try { settings = { ...settings, ...JSON.parse(await fs.readFile(configFile, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') console.warn('Could not read settings:', error.message); }
    tether = new Tether({ settings });
    handle('settings:get', () => {
      let ready = true;
      try { validateSettings(tether.settings); } catch { ready = false; }
      return { settings: tether.settings, ready, version: app.getVersion() };
    });
    handle('settings:save', async input => {
      if (tether.busy || tether.child) throw new Error('Disconnect before changing settings.');
      const next = validateSettings(input);
      await fs.mkdir(path.dirname(configFile), { recursive: true });
      await fs.writeFile(`${configFile}.tmp`, JSON.stringify(next, null, 2));
      await fs.rename(`${configFile}.tmp`, configFile);
      tether.settings = next;
      tether.log('Tool paths and DNS settings saved.');
      return next;
    });
    handle('file:choose', async kind => {
      if (!['adb', 'gnirehtet', 'apk'].includes(kind)) throw new Error('Unknown file type.');
      const result = await dialog.showOpenDialog(window, {
        title: `Choose ${kind === 'apk' ? 'gnirehtet.apk' : `${kind}.exe`}`,
        properties: ['openFile'], filters: [{ name: kind, extensions: [kind === 'apk' ? 'apk' : 'exe'] }],
      });
      return result.canceled ? null : result.filePaths[0];
    });
    handle('devices:list', () => tether.devices());
    handle('devices:details', serial => tether.deviceDetails(serial));
    handle('tools:status', async () => {
      const files = {};
      for (const key of ['adb', 'gnirehtet', 'apk']) {
        try { await fs.access(tether.settings[key]); files[key] = true; } catch { files[key] = false; }
      }
      let adbVersion = null;
      if (files.adb) {
        try {
          const { stdout } = await tether.execute(tether.settings.adb, ['version'], tether.options());
          adbVersion = stdout.match(/^Version ([\d.]+)/m)?.[1] || null;
        } catch { /* Settings view reports the missing/unusable tool. */ }
      }
      return { files, adbVersion };
    });
    handle('diagnostics:port', async () => {
      if (tether.child) return { occupied: true, owned: true };
      return new Promise(resolve => {
        const socket = net.connect(31416, '127.0.0.1');
        const finish = occupied => { socket.destroy(); resolve({ occupied, owned: false }); };
        socket.setTimeout(1000, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
      });
    });
    handle('session:get', () => tether.snapshot());
    handle('session:connect', serial => { operation = tether.connect(serial); return operation; });
    handle('session:disconnect', () => { operation = tether.disconnect(); return operation; });
    handle('logs:clear', () => { tether.clearLogs(); return true; });
    handle('window:action', action => {
      if (action === 'minimize') window.minimize();
      else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
      else if (action === 'close') window.close();
      else throw new Error('Unknown window action.');
    });
    handle('link:open', key => {
      if (!Object.hasOwn(allowedLinks, key)) throw new Error('Unknown link.');
      return shell.openExternal(allowedLinks[key]);
    });
    handle('logs:export', async () => {
      const { canceled, filePath } = await dialog.showSaveDialog(window, {
        defaultPath: 'tetherspark-activity.log', filters: [{ name: 'Log file', extensions: ['log'] }],
      });
      if (canceled) return false;
      await fs.writeFile(filePath, tether.logs.map(log => `${log.time} [${log.level}] ${log.message}`).join('\n'));
      return true;
    });
    window = new BrowserWindow({
      width: 1360, height: 920, minWidth: 1080, minHeight: 740, title: 'TetherSpark',
      icon: path.join(__dirname, 'ui', 'assets', 'tetherspark.ico'),
      frame: false, transparent: true, roundedCorners: true, hasShadow: true,
      backgroundColor: '#00000000', autoHideMenuBar: true, show: !smokeDirectory,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: Boolean(smokeDirectory) },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_content, _permission, callback) => callback(false));
    for (const channel of ['state', 'log']) {
      tether.on(channel, value => { if (window && !window.isDestroyed()) window.webContents.send(`session:${channel}`, value); });
    }
    tether.on('logs-cleared', () => { if (!window.isDestroyed()) window.webContents.send('session:logs-cleared'); });
    for (const event of ['maximize', 'unmaximize']) window.on(event, () => {
      if (!window.isDestroyed()) window.webContents.send('window:maximized', window.isMaximized());
    });
    await window.loadURL(page);
  });
  app.on('before-quit', event => {
    if (quitting || !tether) return;
    event.preventDefault();
    quitting = true;
    operation.catch(() => {}).then(() => tether.disconnect()).catch(() => {}).finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
}
