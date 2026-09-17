const { contextBridge, ipcRenderer } = require('electron');

function call(method, args) {
  return ipcRenderer.invoke(`dubplate:${method}`, args).then((reply) => {
    if (!reply?.ok) throw new Error(reply?.error || 'The app could not complete this request.');
    return reply.value;
  });
}

contextBridge.exposeInMainWorld('dubplate', Object.freeze({
  bootstrap: () => call('bootstrap'),
  saveSettings: (patch) => call('saveSettings', patch),
  validateToken: (token) => call('validateToken', token),
  pasteToken: () => {
    if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Click Paste to read the clipboard.'));
    return call('pasteToken');
  },
  prepareSetup: () => call('prepareSetup'),
  beginGuildDiscovery: () => call('beginGuildDiscovery'),
  listVoiceChannels: () => call('listVoiceChannels'),
  testVoice: (args) => call('testVoice', args),
  replaceToken: (token) => call('replaceToken', token),
  listGuilds: () => call('listGuilds'),
  selectGuild: (guildId) => call('selectGuild', guildId),
  startBot: () => call('startBot'),
  stopBot: () => call('stopBot'),
  restartBot: () => call('restartBot'),
  control: (action, args = {}) => call('control', { action, args }),
  healthCheck: () => call('healthCheck'),
  updateYtdlp: () => call('updateYtdlp'),
  installFfmpeg: () => call('installFfmpeg'),
  chooseFfmpeg: () => call('chooseFfmpeg'),
  chooseYtdlp: () => call('chooseYtdlp'),
  importEnv: () => call('importEnv'),
  deleteImportedEnv: () => call('deleteImportedEnv'),
  openExternal: (key) => call('openExternal', key),
  copyInvite: () => call('copyInvite'),
  copyLogs: (text) => call('copyLogs', text),
  openLogFolder: () => call('openLogFolder'),
  resetData: () => call('resetData'),
  finishSetup: (options) => call('finishSetup', options),
  rerunSetup: () => call('rerunSetup'),
  onEvent: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Expected an event callback.');
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('dubplate:event', listener);
    return () => ipcRenderer.removeListener('dubplate:event', listener);
  },
}));
