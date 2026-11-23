const api = window.tetherdesk;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const routes = {
  connection: { title: 'Reverse Tether', label: 'Connection', eyebrow: 'YOUR CONNECTION, REIMAGINED', subtitle: 'Ready to share PC internet over USB' },
  devices: { title: 'Devices & ADB', label: 'Devices & ADB', eyebrow: 'GET TO KNOW YOUR CONNECTION', subtitle: 'A good connection starts with a little introduction.' },
  activity: { title: 'Activity log', label: 'Activity log', eyebrow: 'BEHIND THE CONNECTION', subtitle: 'Every little event, all in one place.' },
  setup: { title: 'Setup & settings', label: 'Setup & settings', eyebrow: 'MAKE YOURSELF AT HOME', subtitle: 'Your tools, your resolvers, your way of connecting.' },
  troubleshooting: { title: 'Troubleshooting', label: 'Troubleshooting', eyebrow: 'A LITTLE HELP GOES A LONG WAY', subtitle: 'A few thoughtful checks, and we’ll get you moving.' },
};
let route = 'connection';
const history = [];
let settings = {};
let ready = false;
let devices = [];
let selectedSerial = '';
let session = { phase: 'idle', serial: null, since: null, waitingUntil: null, bytesUp: 0, bytesDown: 0 };
let refreshing = false;
let pending = false;
let logs = [];
let level = 'all';
let lastDeviceError = '';
let tools = { files: {}, adbVersion: null };
const detailCache = new Map();
const active = () => ['starting', 'waiting', 'connected', 'stopping'].includes(session.phase);
const selected = () => devices.find(device => device.serial === (active() ? session.serial : selectedSerial));
const pref = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
function storePref(key, value) { try { localStorage.setItem(key, value); } catch { /* Ephemeral preferences still work. */ } }
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let themeMode = pref('tetherdesk-theme', 'auto');
if (!['light', 'dark', 'auto'].includes(themeMode)) themeMode = 'auto';
let accent = pref('tetherdesk-accent', 'periwinkle');
if (!['periwinkle', 'rose', 'sage', 'gold', 'teal'].includes(accent)) accent = 'periwinkle';

function applyTheme() {
  document.documentElement.dataset.theme = themeMode === 'auto' ? (systemTheme.matches ? 'dark' : 'light') : themeMode;
  document.documentElement.dataset.accent = accent;
  $$('[data-theme-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeMode === themeMode)));
  $$('button[data-accent]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.accent === accent)));
}
$$('[data-theme-mode]').forEach(button => button.addEventListener('click', () => {
  themeMode = button.dataset.themeMode; storePref('tetherdesk-theme', themeMode); applyTheme();
}));
$$('button[data-accent]').forEach(button => button.addEventListener('click', () => {
  accent = button.dataset.accent; storePref('tetherdesk-accent', accent); applyTheme();
}));
systemTheme.addEventListener('change', applyTheme);
applyTheme();

// A smooth radial wave with exactly twelve petals, reused throughout the shell.
const flower = Array.from({ length: 241 }, (_, index) => {
  const angle = index / 240 * Math.PI * 2 - Math.PI / 2;
  const radius = 45 + 4 * Math.cos(12 * angle);
  return `${index ? 'L' : 'M'}${(50 + Math.cos(angle) * radius).toFixed(2)} ${(50 + Math.sin(angle) * radius).toFixed(2)}`;
}).join(' ') + 'Z';
$('#flower-path').setAttribute('d', flower);
$$('svg').forEach(svg => svg.setAttribute('aria-hidden', 'true'));

function showError(error) { $('#banner-text').textContent = error.message || String(error); $('#banner').hidden = false; }
function clearError() { $('#banner').hidden = true; }
$('#dismiss-banner').addEventListener('click', clearError);
function showView(next, push = true) {
  if (!routes[next]) return;
  if (push && route !== next) history.push(route);
  route = next;
  $$('.view').forEach(view => { view.hidden = view.id !== `view-${next}`; });
  $$('[data-view]').forEach(button => {
    const current = button.dataset.view === next;
    button.classList.toggle('active', current);
    current ? button.setAttribute('aria-current', 'page') : button.removeAttribute('aria-current');
  });
  $('#breadcrumb').textContent = routes[next].label;
  $('#page-title').replaceChildren(document.createTextNode(routes[next].title));
  const dot = document.createElement('span'); dot.className = 'title-dot'; dot.textContent = '.';
  $('#page-title').append(dot);
  $('#page-eyebrow').textContent = routes[next].eyebrow;
  $('#page-subtitle').textContent = routes[next].subtitle;
  $('#back').disabled = !history.length;
  $('#main-content').scrollTop = 0;
  if (next === 'connection') renderDashboard();
}
$$('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
$$('[data-route]').forEach(button => button.addEventListener('click', () => showView(button.dataset.route)));
$('#back').addEventListener('click', () => { const previous = history.pop(); if (previous) showView(previous, false); });
$('#open-setup').addEventListener('click', () => showView('setup'));
$$('[data-link]').forEach(button => button.addEventListener('click', () => api.openLink(button.dataset.link).catch(showError)));
$$('[data-window]').forEach(button => button.addEventListener('click', () => api.windowAction(button.dataset.window).catch(showError)));
api.onMaximized(value => { document.body.classList.toggle('maximized', value); $('#maximize').setAttribute('aria-label', value ? 'Restore window' : 'Maximize window'); });

function stateKind() {
  if (session.phase === 'error') return 'error';
  if (session.phase === 'connected') return 'connected';
  if (session.phase === 'waiting') return 'waiting_vpn';
  if (['starting', 'stopping'].includes(session.phase)) return 'starting';
  if (selected()?.status === 'unauthorized') return 'unauthorized';
  if (selected()?.status === 'offline') return 'error';
  return selected()?.status === 'device' && ready ? 'ready' : 'no_device';
}
function renderControls() {
  const locked = pending || ['starting', 'stopping'].includes(session.phase);
  const canStart = ready && selected()?.status === 'device';
  const disabled = locked || (!active() && !canStart);
  $('#connect').disabled = disabled;
  $('#tunnel-toggle').disabled = disabled;
  $('#tunnel-toggle').setAttribute('aria-checked', String(session.phase === 'connected'));
  $('#connect').replaceChildren(document.createTextNode(session.phase === 'starting' ? 'Preparing…' : session.phase === 'stopping' ? 'Stopping…' : active() ? 'Stop sharing' : 'Start sharing'));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', active() ? '#i-close' : '#i-arrow'); svg.append(use); $('#connect').append(svg);
  $('#device-select').disabled = active() || pending;
  $('#settings-form').querySelectorAll('button,input').forEach(element => { element.disabled = active() || pending; });
}
function renderDashboard() {
  const kind = stateKind();
  const device = selected();
  const text = {
    no_device: ['No device detected', ready ? 'Plug in your Android with a data-capable USB cable to get started.' : 'Choose your desktop tools in Setup & settings, then plug in your Android.', 'STANDBY', 'usb', 'Waiting for your Android', ready ? 'devices' : 'setup', 'Let’s get connected'],
    unauthorized: ['A little trust first.', 'Unlock your phone and accept the “Allow USB debugging” prompt for this computer.', 'AUTHORIZE', 'warning', 'Waiting for USB authorization', 'devices', 'View device setup'],
    ready: ['Ready to connect', 'Your Android is authorized. Start sharing and we’ll make the link.', 'READY', 'shield', 'Your USB link is ready', 'devices', 'View your Android'],
    waiting_vpn: [session.waitingUntil ? 'Approve VPN on phone' : 'Connection interrupted', session.message, 'WAITING', 'clock', 'Waiting for the Android tunnel', 'troubleshooting', 'Need a little help?'],
    starting: [session.phase === 'stopping' ? 'Wrapping things up.' : 'Making the connection.', session.message || 'Preparing your Android companion and USB tunnel.', 'WORKING', 'clock', 'One moment, we’re on it', 'activity', 'Follow the activity'],
    connected: ['Tunnel connected', 'Your PC is sharing its internet. Go on, give your phone something to explore.', 'CONNECTED', 'check', `Connected at ${new Date(session.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'activity', 'See your session'],
    error: ['Let’s fix the link.', session.phase === 'error' ? session.message : 'Your Android is offline. Reconnect the cable and unlock the phone.', 'ATTENTION', 'warning', 'A little attention needed', 'activity', 'Open Activity log'],
  }[kind];
  $('#status-card').dataset.state = kind;
  $('#connection-title').textContent = text[0]; $('#connection-message').textContent = text[1]; $('#status-pill').textContent = text[2];
  $('#status-icon use').setAttribute('href', `#i-${text[3]}`); $('#status-label').textContent = text[4];
  $('#status-action').dataset.route = text[5];
  $('#status-action').firstChild.textContent = `${text[6]} `;
  $('#vpn-countdown').hidden = kind !== 'waiting_vpn' || !session.waitingUntil;
  $('#usb-value').textContent = device?.status === 'device' ? 'USB · Authorized' : device?.status === 'unauthorized' ? 'Authorization needed' : device?.status === 'offline' ? 'Device offline' : 'Awaiting device';
  $('#usb-note').textContent = device ? device.name : 'A data cable makes the difference';
  const dns = (settings.dns || '1.1.1.1,8.8.8.8').split(',');
  $('#dns-value').textContent = dns[0]; $('#dns-secondary').textContent = dns[1] ? `${dns[1]} SECONDARY` : 'PRIMARY RESOLVER';
  if (route === 'connection') $('#page-subtitle').textContent = kind === 'connected' ? 'Your PC and Android, happily connected over USB.' : kind === 'waiting_vpn' ? 'One quick approval on your phone, and you’re in.' : 'Ready to share PC internet over USB';
  tick(); renderControls();
}
function renderSession(value) { session = value; renderDashboard(); }
function tick() {
  const seconds = session.since ? Math.max(0, Math.floor((Date.now() - session.since) / 1000)) : 0;
  $('#session-time').textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
  const bytes = (session.bytesUp || 0) + (session.bytesDown || 0);
  $('#session-bytes').textContent = bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  if (session.waitingUntil) {
    const remaining = Math.max(0, Math.ceil((session.waitingUntil - Date.now()) / 1000));
    $('#vpn-countdown').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  }
}
async function toggleSession() {
  const stopping = active(); pending = true; clearError(); renderControls();
  try { renderSession(await (stopping ? api.disconnect() : api.connect(selectedSerial))); }
  catch (error) { showError(error); }
  finally { pending = false; renderControls(); }
}
$('#connect').addEventListener('click', toggleSession);
$('#tunnel-toggle').addEventListener('click', toggleSession);

function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', className); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
function node(tag, className, text) { const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element; }
function renderDevices() {
  const select = $('#device-select');
  select.replaceChildren();
  if (!devices.length) select.append(new Option('No USB device detected', ''));
  if (!devices.some(device => device.serial === selectedSerial)) selectedSerial = devices.find(device => device.status === 'device')?.serial || devices[0]?.serial || '';
  for (const device of devices) {
    const details = detailCache.get(device.serial)?.data;
    const android = details?.android ? ` · Android ${details.android}` : '';
    select.append(new Option(`${device.name}${android} · ${device.serial}`, device.serial));
  }
  select.value = active() ? session.serial : selectedSerial;
  const list = $('#device-list'); list.replaceChildren();
  if (!devices.length) {
    const empty = node('article', 'card empty-devices'); const badge = node('span', 'round-icon'); badge.append(icon('usb'));
    empty.append(badge, node('h3', '', 'Your Android hasn’t arrived yet.'), node('p', '', 'Plug in a USB data cable, unlock your phone, and enable USB debugging.')); list.append(empty);
  }
  for (const device of devices) {
    const row = node('article', 'card device-row'); const badge = node('span', 'round-icon'); badge.append(icon('phone'));
    const description = node('div', ''); description.append(node('h3', '', device.name));
    const details = detailCache.get(device.serial)?.data;
    description.append(node('p', 'mono', `${device.serial}${details?.android ? ` · Android ${details.android}` : ''}`));
    const chip = node('span', `chip ${device.status}`, device.status === 'device' ? 'Authorized' : device.status === 'unauthorized' ? 'Authorize on phone' : device.status);
    const choose = node('button', 'button surface-button', selectedSerial === device.serial ? 'Selected' : 'Select');
    choose.disabled = active() || pending || selectedSerial === device.serial;
    choose.addEventListener('click', () => { selectedSerial = device.serial; renderDevices(); loadDetails().catch(showError); });
    row.append(badge, description, chip, choose); list.append(row);
  }
  const details = detailCache.get(selectedSerial)?.data;
  $('#companion-status').textContent = selected()?.status !== 'device' ? 'Authorize a phone to check' : details?.companion === true ? 'Installed' : details?.companion === false ? 'Will auto-install on start' : details ? 'Status unavailable' : 'Checking companion…';
  $('#companion-status').classList.toggle('device', details?.companion === true);
  renderDashboard();
}
async function loadDetails() {
  const device = selected();
  if (device?.status !== 'device') return;
  if (Date.now() - (detailCache.get(device.serial)?.at || 0) < 15000) return;
  const data = await api.deviceDetails(device.serial);
  detailCache.set(device.serial, { at: Date.now(), data }); renderDevices();
}
async function refresh() {
  if (refreshing) return;
  refreshing = true; $('#refresh').disabled = true; $('#refresh-devices').disabled = true;
  try {
    devices = await api.devices();
    if (lastDeviceError && $('#banner-text').textContent === lastDeviceError) clearError();
    lastDeviceError = ''; renderDevices(); await loadDetails();
  } catch (error) {
    devices = []; renderDevices();
    if (error.message !== lastDeviceError) showError(error);
    lastDeviceError = error.message;
  } finally { refreshing = false; $('#refresh').disabled = false; $('#refresh-devices').disabled = false; }
}
$('#device-select').addEventListener('change', event => { selectedSerial = event.target.value; renderDevices(); loadDetails().catch(showError); });
$('#refresh').addEventListener('click', refresh); $('#refresh-devices').addEventListener('click', refresh);

async function refreshTools() {
  tools = await api.toolStatus();
  $('#adb-summary').textContent = tools.adbVersion ? `ADB v${tools.adbVersion}` : 'ADB not ready';
  $$('[data-verified]').forEach(badge => { const valid = tools.files[badge.dataset.verified]; badge.classList.toggle('verified', valid); badge.textContent = valid ? '✓ Verified' : 'Not found'; });
}
$$('[data-choose]').forEach(button => button.addEventListener('click', async () => {
  try {
    const key = button.dataset.choose; const file = await api.chooseFile(key);
    if (file) { $(`#${key}-path`).value = file; const badge = $(`[data-verified="${key}"]`); badge.classList.remove('verified'); badge.textContent = 'Selected · save to verify'; }
  } catch (error) { showError(error); }
}));
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault(); clearError(); pending = true; renderControls();
  try {
    const dns = [$('#dns-primary').value.trim(), $('#dns-secondary-input').value.trim()].filter(Boolean).join(',');
    settings = await api.saveSettings({ adb: $('#adb-path').value, gnirehtet: $('#gnirehtet-path').value, apk: $('#apk-path').value, dns });
    ready = true; $('#setup-callout').hidden = true; $('#setup-dot').hidden = true;
    $('#settings-status').textContent = 'Saved. Your tools are ready to connect.';
    await refreshTools(); detailCache.clear(); await refresh();
  } catch (error) { showError(error); }
  finally { pending = false; renderDashboard(); }
});

function renderLogs() {
  const container = $('#logs');
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  const query = $('#log-search').value.trim().toLowerCase();
  const filtered = logs.filter(log => (level === 'all' || log.level === level) && `${log.time} ${log.message}`.toLowerCase().includes(query));
  container.replaceChildren();
  if (!filtered.length) container.append(node('p', 'empty-log', logs.length ? 'No events match this filter.' : 'A quiet start. Your connection events will appear here.'));
  for (const entry of filtered) {
    const row = node('div', `log-entry ${entry.level}`);
    row.append(node('span', 'log-time', new Date(entry.time).toLocaleTimeString([], { hour12: false })), node('span', 'log-level', entry.level === 'warning' ? 'WARN' : entry.level), node('span', 'log-message', entry.message));
    container.append(row);
  }
  $('#log-count').textContent = logs.length; $('#log-summary').textContent = `${filtered.length} shown · ${logs.length} events in this session`;
  const errors = logs.filter(entry => entry.level === 'error').length;
  $('#error-count').hidden = !errors; $('#error-count').textContent = errors;
  if (atBottom) container.scrollTop = container.scrollHeight;
}
function appendLog(entry) { logs.push(entry); if (logs.length > 300) logs.shift(); renderLogs(); }
$$('[data-level]').forEach(button => button.addEventListener('click', () => {
  level = button.dataset.level; $$('[data-level]').forEach(item => item.setAttribute('aria-pressed', String(item === button))); renderLogs();
}));
$('#log-search').addEventListener('input', renderLogs);
$('#clear-logs').addEventListener('click', () => api.clearLogs().catch(showError));
$('#export-logs').addEventListener('click', () => api.exportLogs().catch(showError));
api.onLogsCleared(() => { logs = []; renderLogs(); });
api.onLog(appendLog); api.onState(renderSession);

function diagnostic(key, result, text, label) {
  const card = $(`#diagnostic-${key}`); card.dataset.result = result;
  card.querySelector(`[data-diagnostic="${key}"]`).textContent = text;
  card.querySelector('.diagnostic-result').textContent = label || (result === 'pass' ? 'LOOKS GOOD' : result === 'warn' ? 'CHECK THIS' : 'MANUAL');
}
$('#run-diagnostics').addEventListener('click', async () => {
  $('#run-diagnostics').disabled = true;
  $('#diagnostic-summary').textContent = 'Taking a fresh look at your USB connection…';
  try {
    await refresh(); const port = await api.diagnosePort();
    diagnostic('cable', devices.length ? 'pass' : 'warn', devices.length ? `${devices.length} USB ${devices.length === 1 ? 'device detected' : 'devices detected'}.` : 'No USB device detected. Try a data cable and another USB port.');
    const authorized = devices.some(device => device.status === 'device');
    diagnostic('auth', authorized ? 'pass' : 'warn', authorized ? 'An Android device has authorized this computer.' : 'Unlock your phone and accept the USB debugging prompt.');
    diagnostic('vpn', session.phase === 'connected' ? 'pass' : 'warn', session.phase === 'connected' ? 'Android’s VPN is connected to the relay.' : session.phase === 'waiting' ? 'Approve the VPN request on your phone before the countdown ends.' : 'Start sharing to request the Android VPN connection.');
    diagnostic('port', port.occupied && !port.owned ? 'warn' : 'pass', port.owned ? 'Port 31416 is in use by this TetherSpark session.' : port.occupied ? 'Port 31416 is occupied by another local service.' : 'Port 31416 is available.');
    $('#diagnostic-summary').textContent = `Checked at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Open a card for the next step. PC internet and firewall checks are manual.`;
  } catch (error) { showError(error); $('#diagnostic-summary').textContent = 'A check could not finish. Review the notification above.'; }
  finally { $('#run-diagnostics').disabled = false; }
});
$('#confirm-internet').addEventListener('click', () => diagnostic('internet', 'pass', 'PC internet checked by you. Verify the phone’s USB path next.', 'MARKED CHECKED'));

async function init() {
  try {
    const config = await api.getSettings(); settings = config.settings; ready = config.ready;
    for (const key of ['adb', 'gnirehtet', 'apk']) $(`#${key}-path`).value = settings[key] || '';
    const dns = (settings.dns || '1.1.1.1,8.8.8.8').split(','); $('#dns-primary').value = dns[0]; $('#dns-secondary-input').value = dns[1] || '';
    $('#version').textContent = `TETHERSPARK ${config.version}`;
    $('#setup-callout').hidden = ready; $('#setup-dot').hidden = ready;
    $('#settings-status').textContent = ready ? 'All tools are ready on this PC.' : 'Choose all three tools to finish setup.';
    const initial = await api.session(); logs = initial.logs; renderLogs(); renderSession(initial);
    await Promise.allSettled([refreshTools(), refresh()]).then(results => { for (const result of results) if (result.status === 'rejected') showError(result.reason); });
    document.documentElement.dataset.ready = 'true';
  } catch (error) { showError(error); }
}
setInterval(refresh, 5000); setInterval(tick, 1000);
renderLogs(); init();
