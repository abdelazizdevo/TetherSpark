const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const executable = process.env.TETHERDESK_EXECUTABLE || (process.argv.includes('--packaged') ? path.join(root, 'dist', require('../package.json').version, 'TetherSpark-win32-x64', 'TetherSpark.exe') : undefined);
  const output = path.join(root, 'artifacts');
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'smoke-profile-'));
  const environment = { ...process.env, TETHERDESK_SMOKE_DIR: profile };
  delete environment.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ executablePath: executable, args: executable ? [] : [root], env: environment, timeout: 30000 });
  const errors = [];
  const prefix = executable ? 'packaged-' : '';
  async function capture(name) {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.invalidate());
    // Let Material color transitions and local font loading finish before capturing.
    await new Promise(resolve => setTimeout(resolve, 350));
    const base64 = await application.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: false, stayAwake: true });
      if (image.isEmpty()) throw new Error('Empty window capture.');
      return image.toPNG().toString('base64');
    });
    await fs.writeFile(path.join(output, `${prefix}${name}.png`), Buffer.from(base64, 'base64'));
  }
  try {
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    assert.equal(await page.title(), 'TetherSpark');
    assert.equal(await application.evaluate(({ app }) => app.getName()), 'TetherSpark');
    assert(await page.getByRole('button', { name: 'TetherSpark home' }).isVisible());
    assert(await page.locator('.titlebar-brand').textContent() === 'TetherSpark');
    assert.equal(await page.evaluate(() => document.body.innerText.includes('TetherDesk')), false);
    await page.waitForFunction(() => [...document.querySelectorAll('img')].every(image => image.complete && image.naturalWidth > 0));
    if (executable) {
      const expectedIcon = await fs.readFile(path.join(root, 'src', 'ui', 'assets', 'tetherspark-icon-256.png'));
      const executableBytes = await fs.readFile(executable);
      assert(executableBytes.includes(expectedIcon), 'The executable must embed the approved TetherSpark icon.');
      const fileIcon = await application.evaluate(async ({ app }, filename) => (await app.getFileIcon(filename, { size: 'large' })).toPNG().toString('base64'), executable);
      await fs.writeFile(path.join(output, 'windows-exe-icon.png'), Buffer.from(fileIcon, 'base64'));
    }
    await page.getByRole('heading', { name: 'Reverse Tether.' }).waitFor();
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
    for (const action of ['connect', 'windowAction', 'clearLogs', 'deviceDetails']) assert.equal(await page.evaluate(key => typeof window.tetherdesk[key], action), 'function');
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await capture('connection-light');
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()), '#141318');
    await capture('connection-dark');
    for (const [name, value] of [['Dusty Rose', 'rose'], ['Forest Sage', 'sage'], ['Ochre Gold', 'gold'], ['Ocean Teal', 'teal'], ['Periwinkle', 'periwinkle']]) {
      await page.getByRole('button', { name: `${name} accent`, exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.accent), value);
    }
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.evaluate(() => localStorage.getItem('tetherdesk-accent')), 'periwinkle');
    await page.getByRole('button', { name: 'Setup & settings', exact: true }).click();
    await page.getByRole('heading', { name: 'Setup & settings.' }).waitFor();
    assert.match(await page.locator('#adb-path').inputValue(), /adb\.exe$/);
    if (executable) for (const key of ['adb', 'gnirehtet', 'apk']) {
      const file = await page.locator(`#${key}-path`).inputValue(); assert.match(file, /app\.asar\.unpacked/); await fs.access(file);
    }
    await page.locator('#dns-primary').fill('1.1.1.1'); await page.locator('#dns-secondary-input').fill('8.8.8.8');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.waitForFunction(() => document.querySelector('#settings-status').textContent.startsWith('Saved') || !document.querySelector('#banner').hidden);
    if (await page.locator('#banner').isVisible()) throw new Error(await page.locator('#banner-text').textContent());
    await capture('settings-dark');
    await page.getByRole('button', { name: 'Devices & ADB', exact: true }).click();
    await page.getByRole('heading', { name: 'Your USB neighborhood' }).waitFor();
    await page.getByRole('button', { name: 'Scan devices' }).click();
    await page.waitForFunction(() => !document.querySelector('#refresh-devices').disabled);
    await capture('devices-dark');
    await page.getByRole('button', { name: 'Troubleshooting', exact: true }).click();
    await page.getByRole('button', { name: 'Run checks' }).click();
    await page.waitForFunction(() => document.querySelector('#diagnostic-summary').textContent.startsWith('Checked at'));
    await page.locator('#diagnostic-cable summary').click();
    assert(await page.locator('#diagnostic-cable').getAttribute('open') !== null);
    await capture('troubleshooting-dark');
    await page.getByRole('button', { name: 'Setup & settings', exact: true }).click();
    assert(await page.locator('#view-setup').isVisible());
    await page.getByRole('button', { name: 'Go back' }).click();
    assert(await page.locator('#view-troubleshooting').isVisible());

    // Simulated IPC fixtures exercise states without installing or starting anything on a phone.
    await application.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler('devices:list');
      ipcMain.handle('devices:list', () => ({ ok: true, value: [{ serial: 'TEST-SERIAL', name: 'Android test device', status: 'unauthorized' }] }));
      ipcMain.removeHandler('devices:details');
      ipcMain.handle('devices:details', () => ({ ok: true, value: { serial: 'TEST-SERIAL', android: '15', companion: true } }));
      const web = BrowserWindow.getAllWindows()[0].webContents;
      for (const [level, message] of [['info', 'Fixture information'], ['warning', 'Fixture authorization warning'], ['error', 'Fixture port conflict']]) web.send('session:log', { time: new Date().toISOString(), level, message });
    });
    await page.getByRole('button', { name: /Activity log/ }).first().click();
    await page.getByRole('button', { name: 'Error', exact: true }).click();
    assert.equal(await page.locator('#logs .log-entry').count(), 1);
    await page.getByRole('button', { name: /All/ }).click();
    await page.locator('#log-search').fill('authorization warning');
    assert.equal(await page.locator('#logs .log-entry').count(), 1);
    await page.locator('#log-search').fill('');
    await capture('activity-dark');
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#logs .log-entry').length === 0);
    await page.getByRole('button', { name: 'Connection', exact: true }).click();
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#status-card').dataset.state === 'unauthorized');
    assert(await page.locator('#connect').isDisabled());
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('devices:list'); ipcMain.handle('devices:list', () => ({ ok: true, value: [{ serial: 'TEST-SERIAL', name: 'Android test device', status: 'device' }] }));
    });
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#status-card').dataset.state === 'ready');
    assert(await page.locator('#connect').isEnabled());
    assert.match(await page.locator('#device-select').textContent(), /Android 15/);
    const sendState = value => application.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('session:state', { logs: [], bytesUp: 0, bytesDown: 0, serial: 'TEST-SERIAL', ...state }), value);
    await sendState({ phase: 'waiting', since: null, waitingUntil: Date.now() + 120000, message: 'Unlock your phone and approve the VPN connection.' });
    await page.waitForFunction(() => document.querySelector('#status-card').dataset.state === 'waiting_vpn');
    assert.match(await page.locator('#vpn-countdown').textContent(), /0[12]:[0-5][0-9]/);
    await capture('simulated-waiting-dark');
    await sendState({ phase: 'connected', since: Date.now() - 93000, waitingUntil: null, bytesUp: 1048576, bytesDown: 2097152 });
    await page.waitForFunction(() => document.querySelector('#status-card').dataset.state === 'connected');
    assert.equal(await page.locator('#tunnel-toggle').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#session-bytes').textContent(), '3.0 MB');
    await capture('simulated-connected-dark');
    await sendState({ phase: 'error', since: null, message: 'Port 31416 is already in use.' });
    await page.waitForFunction(() => document.querySelector('#status-card').dataset.state === 'error');
    await page.getByRole('button', { name: 'Open Activity log' }).click();
    assert(await page.locator('#view-activity').isVisible());
    await page.getByRole('button', { name: 'Auto', exact: true }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('tetherdesk-theme')), 'auto');
    assert.deepEqual(errors, []);
    console.log('UI checks passed: five views; theme/accent persistence; settings; back navigation; logs; diagnostics; simulated unauthorized/ready/VPN/connected/error states; renderer isolation.');
  } finally {
    await application.close();
    if (path.dirname(profile) !== output || !path.basename(profile).startsWith('smoke-profile-')) throw new Error('Invalid smoke profile directory.');
    await fs.rm(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
