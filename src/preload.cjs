const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (channel, ...args) => {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('tetherdesk', {
  getSettings: () => invoke('settings:get'), saveSettings: value => invoke('settings:save', value),
  chooseFile: kind => invoke('file:choose', kind), devices: () => invoke('devices:list'),
  deviceDetails: serial => invoke('devices:details', serial), toolStatus: () => invoke('tools:status'),
  diagnosePort: () => invoke('diagnostics:port'), windowAction: action => invoke('window:action', action),
  session: () => invoke('session:get'), connect: serial => invoke('session:connect', serial),
  disconnect: () => invoke('session:disconnect'), openLink: key => invoke('link:open', key),
  exportLogs: () => invoke('logs:export'),
  clearLogs: () => invoke('logs:clear'), onLogsCleared: callback => subscribe('session:logs-cleared', callback),
  onMaximized: callback => subscribe('window:maximized', callback),
  onState: callback => subscribe('session:state', callback), onLog: callback => subscribe('session:log', callback),
});
