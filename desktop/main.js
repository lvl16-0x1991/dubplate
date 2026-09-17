import { app, BrowserWindow, Tray, Menu, ipcMain, safeStorage, shell, dialog, clipboard, Notification, screen, session } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile, lstat, open, unlink, rm, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { parse as parseEnv } from 'dotenv';
import { SettingsStore, defaults, validateSettingsPatch } from './settings.js';
import { SecretStore } from './secrets.js';
import { LogStore } from './logs.js';
import { BinaryManager } from './binaries.js';
import { BotSupervisor } from './supervisor.js';
import { SetupTools } from './setup-tools.js';
import { capture, stopAllProcesses } from '../src/player/processes.js';
import { allowedExternalUrl, validateIpcArgs, validateSender, validateTokenShape } from './ipc-validation.js';

const directory = dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(join(directory, 'renderer/index.html')).href;
const appId = 'io.github.nevskiyinnity.dubplate';
app.setName('Dubplate');
app.setAppUserModelId(appId);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-features', 'MediaRouter,OptimizationHints,AutofillServerCommunication');
const smokeDirectory = process.argv.find((argument) => argument.startsWith('--smoke-dir='))?.slice(12);
if (smokeDirectory) app.setPath('userData', resolve(smokeDirectory));

let window;
let focusRequested = false;
let tray;
let quitting = false;
let token = null;
let settings;
let secrets;
let logs;
let binaries;
let supervisor;
let setupTools;
let toolSelectionPending = false;
let resettingData = false;
let discoveryActive = false;
let voiceTestPassedGuild = null;
let importedEnv;
let binaryProgress = null;
let health = {};
let state = { status: 'stopped', current: null, queue: [], elapsed: 0, volume: 50, loop: 'off', channels: [], voice: {} };
const notices = [];
const toastTimes = new Map();
let failedTracks = [];
let operations = Promise.resolve();
const mutate = (operation) => { const result = operations.then(operation); operations = result.catch(() => {}); return result; };

function broadcast(event) {
  if (window && !window.isDestroyed()) window.webContents.send('dubplate:event', event);
}
function notice(message) { const clean = logs ? logs.redact(message) : String(message); notices.push(clean); if (notices.length > 20) notices.shift(); broadcast({ type: 'notice', payload: clean }); }
function toast(key, title, body) {
  if (Date.now() - (toastTimes.get(key) ?? 0) < 60000 || !Notification.isSupported()) return;
  toastTimes.set(key, Date.now()); new Notification({ title, body, icon: join(directory, '../build/icon.png') }).show();
}

function showWindow() { if (!settings) { focusRequested = true; return; } if (!window || window.isDestroyed()) createWindow(); window.show(); if (window.isMinimized()) window.restore(); window.focus(); }
function updateTray() {
  if (!tray) return;
  const title = state.current?.title ? String(state.current.title).slice(0, 70).replace(/[\x00-\x1f]/g, ' ') : 'Nothing playing';
  tray.setToolTip(`Dubplate — ${title}`);
  const action = (name) => { void mutate(() => supervisor.request('control', { action: name, args: {} })).catch((error) => notice(error.message)); };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Dubplate', click: showWindow }, { label: title, enabled: false }, { type: 'separator' },
    { label: state.playbackStatus === 'Paused' ? 'Resume' : 'Pause', enabled: Boolean(state.current), click: () => action(state.playbackStatus === 'Paused' ? 'resume' : 'pause') },
    { label: 'Skip', enabled: Boolean(state.current), click: () => action('skip') },
    { label: 'Restart bot', enabled: Boolean(token && settings.value.guildId), click: () => { void mutate(restartBot).catch((error) => notice(error.message)); } },
    { type: 'separator' }, { label: 'Quit', click: () => { void quit(); } },
  ]));
}

function createWindow() {
  const saved = settings.value.window;
  const bounds = { width: saved.width, height: saved.height };
  if (Number.isInteger(saved.x) && Number.isInteger(saved.y)) {
    const display = screen.getDisplayMatching({ x: saved.x, y: saved.y, width: saved.width, height: saved.height }).workArea;
    bounds.x = Math.max(display.x, Math.min(saved.x, display.x + display.width - 400));
    bounds.y = Math.max(display.y, Math.min(saved.y, display.y + display.height - 200));
  }
  window = new BrowserWindow({ ...bounds, minWidth: 980, minHeight: 680, show: false,
    title: 'Dubplate', backgroundColor: '#111116', autoHideMenuBar: true, icon: join(directory, '../build/icon.png'),
    webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: !app.isPackaged, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  let saveTimer;
  const saveBounds = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (!window?.isDestroyed() && !window.isMinimized() && !window.isMaximized()) void mutate(() => settings.internal({ window: window.getBounds() })).catch(() => {}); }, 500); };
  window.on('resize', saveBounds); window.on('move', saveBounds);
  window.on('close', (event) => { if (!quitting && settings.value.closeToTray) { event.preventDefault(); window.hide(); } else if (!quitting) { event.preventDefault(); void quit(); } });
  window.on('closed', () => { clearTimeout(saveTimer); window = null; });
  window.once('ready-to-show', () => { if (focusRequested || (!process.argv.includes('--hidden') && !settings.value.startMinimized)) { window.show(); window.focus(); focusRequested = false; } });
  void window.loadFile(join(directory, 'renderer/index.html'));
}

async function refreshHealth() {
  const binary = await binaries.health({ ffmpegPath: settings.value.ffmpegPath });
  const coreHealth = await supervisor.request('health', { config: {
    ...settings.snapshot(), ytdlpPath: binary.ytdlp?.path || 'yt-dlp',
    ffmpegPath: binary.ffmpeg?.path || 'ffmpeg', nodePath: binaries.nodePath,
    ytdlpSha256: binary.ytdlp?.sha256, ffmpegSha256: binary.ffmpeg?.sha256,
    nodeSha256: binary.node?.sha256,
  }, skipBinaryChecks: ['ytdlp', 'ffmpeg', 'node'].filter((name) => !binary[name]?.ok)
  }).catch((error) => ({ opus: { ok: false, message: error.message }, dave: { ok: false, message: error.message } }));
  health = { ...coreHealth, ...binary, appVersion: app.getVersion(), lastUpdateCheck: settings.value.lastUpdateCheck };
  for (const key of ['ytdlp', 'ffmpeg', 'node']) if (binary[key]?.ok && coreHealth[key]?.ok === false) health[key] = { ...binary[key], ...coreHealth[key] };
  broadcast({ type: 'health', payload: health }); return health;
}
async function botConfig() {
  if (!token) throw new Error('Configure a bot token in Setup or Settings first.');
  if (!settings.value.guildId) throw new Error('Choose a Discord server in Setup first.');
  return { ...settings.snapshot(), ...await binaries.resolvePaths({ ffmpegPath: settings.value.ffmpegPath }), token,
    voiceTestTonePath: join(directory, '../build/voice-test.wav') };
}
async function startBot() { const result = await supervisor.start(await botConfig()); state = result; broadcast({ type: 'state', payload: state }); updateTray(); return result; }
async function restartBot() { await supervisor.stop(); return startBot(); }
function discoverySnapshot() {
  const guilds = state.setupGuilds || [];
  const selectedGuild = guilds.find((guild) => guild.id === state.guild?.id) || null;
  return { status: selectedGuild ? 'selected' : state.status === 'setup' ? 'waiting' : state.status,
    guilds, selectedGuild };
}
async function beginGuildDiscovery() {
  if (!token) throw new Error('Validate your bot token first.');
  discoveryActive = true;
  if (!supervisor.desired || !['setup', 'running', 'reconnecting'].includes(state.status)) {
    state = await supervisor.startSetup({ ...settings.snapshot(), token, voiceTestTonePath: join(directory, '../build/voice-test.wav') });
  }
  const result = discoverySnapshot(); broadcast({ type: 'guildDiscovery', payload: result }); return result;
}
async function restartActive() {
  if (supervisor.mode === 'startSetup') { await supervisor.stop(); return beginGuildDiscovery(); }
  return restartBot();
}
async function rememberGuild(guild) {
  if (!guild?.id) return;
  if (settings.value.guildId !== guild.id) voiceTestPassedGuild = null;
  await settings.update({ guildId: guild.id });
  if (supervisor.config) supervisor.config.guildId = guild.id;
  broadcast({ type: 'settings', payload: { ...settings.snapshot(), tokenConfigured: Boolean(token) } });
  broadcast({ type: 'guildDiscovery', payload: { ...discoverySnapshot(), selectedGuild: guild } });
}
function queueGuildSelection(guild) {
  const ownerToken = token;
  const ownerConfig = supervisor.config;
  if (!guild?.id || !ownerToken || !ownerConfig) return;
  // Update restart configuration immediately, but only persist while the event
  // still belongs to this bot instance after earlier app mutations finish.
  ownerConfig.guildId = guild.id;
  void mutate(async () => {
    if (token !== ownerToken || supervisor.config !== ownerConfig) return;
    await rememberGuild(guild);
  }).catch((error) => notice(error.message));
}
async function selectPlaybackTool(operation) {
  if (setupTools.pending) throw new Error('Playback tools are still being prepared. Wait before choosing a file.');
  toolSelectionPending = true;
  try { return await operation(); }
  finally { toolSelectionPending = false; }
}
async function saveToken(candidate, { discover = true } = {}) {
  if (!secrets.available()) throw new Error('Windows secure storage is unavailable. Dubplate will not store your token as plaintext.');
  logs.addSecret(candidate);
  const identity = await supervisor.request('validateToken', candidate, 30000);
  await supervisor.stop(); await secrets.set(candidate); token = candidate;
  const changedBot = settings.value.identity?.botId !== identity.botId;
  await settings.internal({ identity, ...(changedBot ? { guildId: '', setupComplete: false } : {}) });
  voiceTestPassedGuild = null;
  broadcast({ type: 'settings', payload: { ...settings.snapshot(), tokenConfigured: true } });
  if (discover) await beginGuildDiscovery();
  updateTray(); return identity;
}

async function importEnvironment() {
  const selection = await dialog.showOpenDialog(window, { title: 'Choose the old bot folder containing .env', properties: ['openDirectory'] });
  if (selection.canceled) return { imported: false, canDelete: false };
  const path = join(selection.filePaths[0], '.env');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('Choose a regular .env file smaller than 64 KiB.');
  const bytes = await readFile(path); const parsed = parseEnv(bytes);
  const patch = {};
  for (const [old, name] of [['GUILD_ID', 'guildId'], ['IDLE_TIMEOUT_SECONDS', 'idleTimeoutSeconds'], ['MAX_QUEUE', 'maxQueue'], ['DEFAULT_VOLUME', 'defaultVolume']]) {
    if (parsed[old]?.trim()) patch[name] = name === 'guildId' ? parsed[old].trim() : Number(parsed[old]);
  }
  validateSettingsPatch(patch);
  if (parsed.DISCORD_TOKEN?.trim()) await saveToken(parsed.DISCORD_TOKEN.trim(), { discover: false });
  const importedGuildId = patch.guildId;
  delete patch.guildId;
  // Select imported membership through the connected core before treating the
  // guild as configured. An old selection must not make setup leave this guild.
  if (importedGuildId) {
    await supervisor.stop();
    await settings.internal({ guildId: '', setupComplete: false });
  }
  await settings.update(patch);
  broadcast({ type: 'settings', payload: { ...settings.snapshot(), tokenConfigured: Boolean(token) } });
  if (token) await beginGuildDiscovery();
  if (importedGuildId) {
    if (!token) throw new Error('The imported server needs a validated bot token. Import a DISCORD_TOKEN or connect your bot first.');
    await rememberGuild(await supervisor.request('chooseGuild', importedGuildId));
  }
  importedEnv = { path, hash: createHash('sha256').update(bytes).digest('hex') };
  broadcast({ type: 'settings', payload: { ...settings.snapshot(), tokenConfigured: Boolean(token) } });
  return { imported: true, canDelete: true };
}
async function deleteEnvironment() {
  if (!importedEnv) throw new Error('Import an old .env file first.');
  const answer = await dialog.showMessageBox(window, { type: 'warning', buttons: ['Keep file', 'Overwrite and delete'], defaultId: 0, cancelId: 0,
    message: 'Delete the imported .env file?', detail: 'Dubplate will overwrite and delete this file. SSD wear leveling, backups and cloud sync can retain copies, so secure erasure cannot be guaranteed. Reset the Discord token if the old file may have been shared.' });
  if (answer.response !== 1) return false;
  const info = await lstat(importedEnv.path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('The imported file changed; it was not deleted.');
  const handle = await open(importedEnv.path, 'r+');
  try {
    const bytes = await handle.readFile();
    if (createHash('sha256').update(bytes).digest('hex') !== importedEnv.hash) throw new Error('The imported file changed; it was not deleted.');
    await handle.write(randomBytes(bytes.length), 0, bytes.length, 0); await handle.sync(); await handle.truncate(0);
  } finally { await handle.close(); }
  await unlink(importedEnv.path); importedEnv = null; return true;
}

function configureAutostart() { if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: settings.value.startWithWindows, path: process.execPath, args: ['--hidden'] }); }
async function resetData() {
  if (setupTools.pending) throw new Error('Wait for playback tool preparation to finish before resetting app data.');
  resettingData = true;
  try {
  const answer = await dialog.showMessageBox(window, { type: 'warning', buttons: ['Cancel', 'Reset app data'], defaultId: 0, cancelId: 0,
    message: 'Reset Dubplate and restart setup?', detail: 'This removes your saved token, settings, downloaded tools and logs. Your Discord application is not deleted.' });
  if (answer.response !== 1) return false;
  await supervisor.shutdown(); await logs.flush();
  app.setLoginItemSettings({ openAtLogin: false });
  for (const name of ['settings.json', 'secrets.json', 'logs', 'bin']) await rm(join(app.getPath('userData'), name), { force: true, recursive: true });
  await session.defaultSession.clearStorageData(); await session.defaultSession.clearCache();
  token = null; app.relaunch({ args: process.argv.slice(1).filter((argument) => !argument.startsWith('--smoke-')) });
  await quit(); return true;
  } finally { resettingData = false; }
}

function registerIpc() {
  const handlers = {
    bootstrap: () => ({ settings: settings.snapshot(), tokenConfigured: Boolean(token), identity: settings.value.identity,
      setupComplete: settings.value.setupComplete, state, health, logs: logs.snapshot(), notices: [...notices], appVersion: app.getVersion(),
      inviteUrl: settings.value.identity ? allowedExternalUrl('invite', settings.value.identity) : null, binaryProgress,
      setupTools: setupTools.snapshot(), guildDiscovery: discoverySnapshot() }),
    saveSettings: async (patch) => {
      if ('ffmpegPath' in patch && patch.ffmpegPath !== settings.value.ffmpegPath) throw new Error('Use Browse to authorize a different ffmpeg executable.');
      if ('guildId' in patch && patch.guildId !== settings.value.guildId) throw new Error('Choose your server through Setup.');
      const wasRunning = supervisor.desired;
      const next = await settings.update(patch); configureAutostart();
      broadcast({ type: 'settings', payload: { ...next, tokenConfigured: Boolean(token) } });
      if (wasRunning) await restartActive(); return next;
    },
    prepareSetup: () => {
      if (resettingData) throw new Error('Wait for the app data reset to finish before preparing playback tools.');
      if (toolSelectionPending) throw new Error('Wait for playback tool selection to finish before retrying preparation.');
      return setupTools.prepare();
    },
    pasteToken: () => validateTokenShape(clipboard.readText().trim()),
    beginGuildDiscovery,
    validateToken: saveToken, replaceToken: saveToken,
    listGuilds: async () => (await beginGuildDiscovery()).guilds,
    selectGuild: async (id) => {
      await beginGuildDiscovery();
      const guild = await supervisor.request('chooseGuild', id);
      await rememberGuild(guild); return guild;
    },
    listVoiceChannels: async () => { await beginGuildDiscovery(); return supervisor.request('listVoiceChannels'); },
    testVoice: async ({ voiceChannelId }) => {
      if (!settings.value.guildId) throw new Error('Add the bot to your server first.');
      if (setupTools.pending) throw new Error('Playback tools are still being prepared. Try again when they are ready.');
      await beginGuildDiscovery();
      const paths = { ...await binaries.resolvePaths({ ffmpegPath: settings.value.ffmpegPath }), voiceTestTonePath: join(directory, '../build/voice-test.wav') };
      broadcast({ type: 'voiceTest', payload: { status: 'testing', message: 'Joining your channel and playing the test tone…' } });
      try {
        const result = await supervisor.request('testVoice', { voiceChannelId, paths }, 60000);
        voiceTestPassedGuild = settings.value.guildId;
        broadcast({ type: 'voiceTest', payload: { status: 'success', ...result } }); return result;
      } catch (error) { voiceTestPassedGuild = null; broadcast({ type: 'voiceTest', payload: { status: 'error', message: error.message } }); throw error; }
    },
    startBot, stopBot: () => supervisor.stop(), restartBot,
    control: ({ action, args }) => supervisor.request('control', { action, args }),
    healthCheck: refreshHealth,
    updateYtdlp: async () => { if (setupTools.pending) throw new Error('Playback tools are still being prepared. Wait for preparation to finish.'); const running = supervisor.desired; await supervisor.stop(); try { return await binaries.updateYtdlp(); } finally { await refreshHealth(); if (running) await restartActive(); } },
    installFfmpeg: async () => { if (setupTools.pending) throw new Error('Playback tools are still being prepared. Wait for preparation to finish.'); const running = supervisor.desired; await supervisor.stop(); try { const path = await binaries.installFfmpeg(); await settings.update({ ffmpegPath: path }); broadcast({ type: 'settings', payload: { ...settings.snapshot(), tokenConfigured: Boolean(token) } }); return path; } finally { await refreshHealth(); if (running) await restartActive(); } },
    chooseFfmpeg: () => selectPlaybackTool(async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Select ffmpeg.exe', properties: ['openFile'], filters: [{ name: 'ffmpeg executable', extensions: ['exe'] }] });
      if (result.canceled) return null;
      const checked = await binaries.health({ ffmpegPath: result.filePaths[0] });
      if (!checked.ffmpeg.ok) throw new Error(checked.ffmpeg.message);
      await settings.update({ ffmpegPath: result.filePaths[0] }); broadcast({ type: 'settings', payload: { ...settings.snapshot(), tokenConfigured: Boolean(token) } }); await setupTools.recheck(); return result.filePaths[0];
    }),
    chooseYtdlp: () => selectPlaybackTool(async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Select an official yt-dlp.exe release', properties: ['openFile'], filters: [{ name: 'yt-dlp executable', extensions: ['exe'] }] });
      if (result.canceled) return null;
      const imported = await binaries.importYtdlp(result.filePaths[0]); await setupTools.recheck(); return imported.path;
    }),
    importEnv: importEnvironment, deleteImportedEnv: deleteEnvironment,
    openExternal: (key) => shell.openExternal(allowedExternalUrl(key, settings.value.identity)),
    copyInvite: () => { const url = allowedExternalUrl('invite', settings.value.identity); clipboard.writeText(url); return true; },
    copyLogs: (text) => { clipboard.writeText(logs.redact(text)); return true; },
    openLogFolder: async () => { await mkdir(logs.directory, { recursive: true }); const error = await shell.openPath(logs.directory); if (error) throw new Error(error); return true; },
    resetData,
    finishSetup: async (options) => {
      if (voiceTestPassedGuild !== settings.value.guildId) throw new Error('Run the voice test successfully before finishing setup.');
      await settings.update(options); configureAutostart(); await startBot(); await settings.internal({ setupComplete: true });
      broadcast({ type: 'settings', payload: { ...settings.snapshot(), tokenConfigured: Boolean(token) } }); return true;
    },
    rerunSetup: async () => { voiceTestPassedGuild = null; await settings.internal({ setupComplete: false }); setupTools.prepare(); return true; },
  };
  for (const [method, handler] of Object.entries(handlers)) ipcMain.handle(`dubplate:${method}`, async (event, args) => {
    try {
      validateSender(event, window?.webContents, pageUrl);
      const validated = validateIpcArgs(method, args);
      // Reads and long lookups do not block controls. State-changing app actions
      // serialize separately from bot controls, which have their own core lock.
      const concurrent = ['bootstrap', 'prepareSetup', 'pasteToken', 'healthCheck', 'control', 'copyLogs', 'copyInvite', 'openExternal', 'openLogFolder'].includes(method);
      const value = await (concurrent ? handler(validated) : mutate(() => handler(validated)));
      return { ok: true, value };
    } catch (error) {
      const message = logs.redact(error.message);
      logs.write({ level: 'warn', message: `${method}: ${message}` }); return { ok: false, error: message };
    }
  });
}

async function quit() {
  if (quitting) return;
  quitting = true;
  await supervisor?.shutdown(); await stopAllProcesses(); await logs?.flush();
  tray?.destroy(); app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', (event) => { if (!quitting) { event.preventDefault(); void quit(); } });
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    settings = new SettingsStore(app.getPath('userData'), notice); await settings.load();
    logs = new LogStore(join(app.getPath('userData'), 'logs'), broadcast);
    secrets = new SecretStore(app.getPath('userData'), safeStorage);
    try { token = await secrets.get(); if (token) logs.addSecret(token); } catch (error) { notice(error.message); }
    const nodePath = app.isPackaged ? join(process.resourcesPath, 'runtime/node.exe') : join(directory, '../build/runtime/node.exe');
    binaries = new BinaryManager({ binDir: join(app.getPath('userData'), 'bin'), nodePath,
      ...(smokeDirectory ? { findFfmpeg: async () => null } : {}),
      run: (file, args, options) => { if (quitting) throw new Error('The app is shutting down.'); return capture(file, args, options); },
      onNotice: notice, onProgress: (progress) => { binaryProgress = progress; broadcast({ type: 'binaryProgress', payload: progress }); } });
    supervisor = new BotSupervisor(join(directory, 'worker.js'), logs);
    setupTools = new SetupTools({ binaries, getSettings: () => settings.value,
      persistFfmpeg: (path) => mutate(async () => { await settings.update({ ffmpegPath: path }); broadcast({ type: 'settings', payload: { ...settings.snapshot(), tokenConfigured: Boolean(token) } }); }),
      checkHealth: refreshHealth, publish: (payload) => broadcast({ type: 'setupTools', payload }) });
    supervisor.on('event', (event) => {
      if (event.type === 'log') { logs.write(event.payload); return; }
      if (event.type === 'state') { state = event.payload; updateTray(); if (discoveryActive) broadcast({ type: 'guildDiscovery', payload: discoverySnapshot() }); }
      if (event.type === 'guildConfigured') queueGuildSelection(event.payload);
      if (event.type === 'health') health = { ...health, ...event.payload };
      if (event.type === 'supervisor') { state = { ...state, status: 'error' }; toast('crash', 'Dubplate is recovering', 'The bot process stopped. Dubplate will restart it automatically when it was running.'); }
      if (event.type === 'trackEnd' && event.payload?.reason === 'failed') {
        failedTracks = failedTracks.filter((time) => time > Date.now() - 60000); failedTracks.push(Date.now());
        if (failedTracks.length >= 3) toast('playback', 'Tracks could not play', 'Open Dubplate Health and update yt-dlp, or inspect the playback log.');
      }
      broadcast(event);
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const local = url.protocol === 'file:' || url.protocol === 'data:';
      const thumbnailHosts = ['i.ytimg.com', 'yt3.ggpht.com', 'i1.sndcdn.com', 'i2.sndcdn.com', 'i.scdn.co', 'f4.bcbits.com', 'cdn.discordapp.com'];
      callback({ cancel: !local && !(details.resourceType === 'image' && url.protocol === 'https:' && thumbnailHosts.includes(url.hostname) && !url.username && !url.password) });
    });
    registerIpc(); createWindow();
    tray = new Tray(join(directory, '../build/icon.png')); tray.on('double-click', showWindow); updateTray();
    logs.write({ level: 'info', message: `Dubplate ${app.getVersion()} started. Bot runs in an isolated utility process.` });
    await refreshHealth();
    if (smokeDirectory) {
      const { runPackagedSmoke } = await import('./smoke.js');
      await runPackagedSmoke({ app, window, supervisor, binaries, settings, setupTools, output: smokeDirectory });
    } else if (settings.value.setupComplete && token) await mutate(startBot).catch((error) => notice(error.message));
    const check = async () => {
      if (!settings.value.autoUpdateYtdlp || quitting) return;
      try {
        const update = await binaries.checkForUpdates(); await mutate(() => settings.internal({ lastUpdateCheck: update.lastCheck }));
        if (update.updateAvailable) notice(`yt-dlp ${update.latestVersion} is available. Update it in Health.`);
        health.lastUpdateCheck = update.lastCheck; broadcast({ type: 'health', payload: health });
      } catch (error) { logs.write({ level: 'warn', message: `Daily update check: ${error.message}` }); }
    };
    if (!smokeDirectory) { const first = setTimeout(() => { void check(); }, 10000); first.unref(); const daily = setInterval(() => { void check(); }, 86400000); daily.unref(); }
  }).catch(async (error) => {
    notice(error.message); logs?.write({ level: 'error', message: error.message });
    if (smokeDirectory) { await mkdir(smokeDirectory, { recursive: true }); await writeFile(join(smokeDirectory, 'error.txt'), String(error.stack || error)); }
    else dialog.showErrorBox('Dubplate could not start', logs?.redact(error.message) || 'Startup failed.');
  });
}
