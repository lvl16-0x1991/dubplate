import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { SetupTools } from '../desktop/setup-tools.js';

const oldGuild = { id: '123456789012345678', name: 'Previous server' };
const newGuild = { id: '234567890123456789', name: 'Current server' };
const health = () => Object.fromEntries(['ffmpeg', 'ytdlp', 'node', 'opus', 'dave'].map((name) => [name, { ok: true }]));
const deferred = () => { let resolvePromise; const promise = new Promise((done) => { resolvePromise = done; }); return { promise, resolve: resolvePromise }; };

async function mainHarness(overrides = {}) {
  const source = await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
  const handlers = new Map();
  const settings = {
    value: { guildId: oldGuild.id, ffmpegPath: '', identity: { botId: '345678901234567890' } },
    snapshot() { return structuredClone(this.value); },
    async update(patch) { Object.assign(this.value, patch); return this.snapshot(); },
    async internal(patch) { Object.assign(this.value, patch); return this.snapshot(); },
  };
  const supervisor = Object.assign(new EventEmitter(), {
    desired: true, config: settings.snapshot(),
    async stop() { this.desired = false; },
    async startSetup(config) {
      this.config = config; this.desired = true;
      this.activeCoreConfig = structuredClone(config);
      return { status: 'setup', guild: { id: config.guildId }, setupGuilds: [] };
    },
  });
  const context = createContext({
    app: { setName() {}, setAppUserModelId() {}, commandLine: { appendSwitch() {} },
      requestSingleInstanceLock: () => false, quit() {}, getVersion: () => '0.0.0', setLoginItemSettings() {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    validateSender() {}, validateIpcArgs: (_method, args) => args,
    fileURLToPath, pathToFileURL, dirname, join, resolve, structuredClone, setTimeout, clearTimeout,
    process: { argv: [], platform: process.platform },
    dialog: overrides.dialog,
    ...overrides.context,
  });
  // Run the actual main entry point with Electron's shell mocked. No window,
  // socket, filesystem mutation or utility process is created by this harness.
  runInContext(source.replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../desktop/main.js', import.meta.url).href)) + `
    globalThis.harness = {
      inject(value) {
        token = value.token; settings = value.settings; supervisor = value.supervisor;
        secrets = value.secrets; logs = value.logs; binaries = value.binaries;
        setupTools = value.setupTools; state = value.state;
      },
      register: registerIpc,
      idle: () => operations,
      tokenConfigured: () => Boolean(token),
      mutate,
    };`, context);
  const logs = { addSecret() {}, write() {}, redact: (value) => value };
  const binaries = overrides.binaries || {};
  const setupTools = overrides.makeSetupTools?.({ settings, binaries, mutate: context.harness.mutate }) || { snapshot: () => ({ status: 'ready' }) };
  context.harness.inject({ token: 'previous-placeholder', settings, supervisor, logs, binaries, setupTools,
    secrets: { available: () => true, set: async () => {} },
    state: { status: 'running', guild: oldGuild, setupGuilds: [oldGuild] } });
  const listener = source.slice(source.indexOf("    supervisor.on('event', (event) => {"), source.indexOf('    session.defaultSession.setPermissionRequestHandler'));
  runInContext(listener, context);
  context.harness.register();
  return { settings, supervisor, setupTools, idle: context.harness.idle, mutate: context.harness.mutate,
    tokenConfigured: context.harness.tokenConfigured,
    invoke: (method, args) => handlers.get(`dubplate:${method}`)({}, args) };
}

test('an old bot guild event queued during token validation cannot restore its server afterward', async () => {
  const validation = deferred(); const validating = deferred();
  const fixture = await mainHarness();
  fixture.supervisor.request = async () => { validating.resolve(); return validation.promise; };
  const replacement = fixture.invoke('replaceToken', 'new-placeholder');
  await validating.promise;
  fixture.supervisor.emit('event', { type: 'guildConfigured', payload: oldGuild });
  validation.resolve({ botId: '456789012345678901', applicationId: '567890123456789012', name: 'New bot' });
  assert.equal((await replacement).ok, true);
  await fixture.idle();
  assert.equal(fixture.settings.value.guildId, '', 'old bot event must not overwrite the new bot settings');
  assert.equal(fixture.supervisor.config.guildId, '');
  assert.equal(fixture.supervisor.activeCoreConfig.guildId, '');
});

test('guild persistence also checks the configuration instance before its queued write', async () => {
  const fixture = await mainHarness();
  const blocked = deferred(); const entered = deferred();
  const operation = fixture.mutate(async () => { entered.resolve(); await blocked.promise; });
  await entered.promise;
  fixture.supervisor.emit('event', { type: 'guildConfigured', payload: newGuild });
  fixture.supervisor.config = { guildId: oldGuild.id };
  blocked.resolve(); await operation; await fixture.idle();
  assert.equal(fixture.settings.value.guildId, oldGuild.id);
  assert.equal(fixture.supervisor.config.guildId, oldGuild.id);
});

test('a guild event owned by the active bot still persists the selection', async () => {
  const fixture = await mainHarness();
  fixture.supervisor.emit('event', { type: 'guildConfigured', payload: newGuild });
  await fixture.idle();
  assert.equal(fixture.settings.value.guildId, newGuild.id);
  assert.equal(fixture.supervisor.config.guildId, newGuild.id);
});

test('tool preparation cannot enter a circular wait while the native ffmpeg picker is active', async () => {
  const selected = deferred(); const selecting = deferred();
  const fixture = await mainHarness({
    dialog: { showOpenDialog: () => { selecting.resolve(); return selected.promise; } },
    binaries: { health: async () => health(), ensureEssentials: async () => ({ ffmpeg: { ok: true }, ffmpegPath: 'downloaded-ffmpeg' }) },
    makeSetupTools: ({ settings, binaries, mutate }) => new SetupTools({ binaries, getSettings: () => settings.value,
      persistFfmpeg: (path) => mutate(() => settings.update({ ffmpegPath: path })), checkHealth: async () => health(), publish() {} }),
  });
  const pick = fixture.invoke('chooseFfmpeg');
  await selecting.promise;
  const preparation = await fixture.invoke('prepareSetup');
  assert.equal(preparation.ok, false, 'preparation must wait until file selection and its recheck finish');
  assert.match(preparation.error, /selection.*finish/i);
  selected.resolve({ canceled: false, filePaths: ['chosen-ffmpeg'] });
  assert.equal((await pick).ok, true);
  assert.equal(fixture.settings.value.ffmpegPath, 'chosen-ffmpeg');
  assert.equal(fixture.setupTools.snapshot().status, 'ready');
});

test('reset is refused before shutdown while background preparation could still persist files', async () => {
  let confirmations = 0; let shutdowns = 0;
  const fixture = await mainHarness({
    dialog: { showMessageBox: async () => { confirmations++; return { response: 0 }; } },
    makeSetupTools: () => ({ pending: Promise.resolve(), snapshot: () => ({ status: 'preparing' }) }),
  });
  fixture.supervisor.shutdown = async () => { shutdowns++; };
  const result = await fixture.invoke('resetData');
  assert.equal(result.ok, false);
  assert.match(result.error, /preparation.*finish.*reset/i);
  assert.equal(confirmations, 0);
  assert.equal(shutdowns, 0);
});

test('new background preparation cannot start while a reset confirmation is open', async () => {
  const confirmed = deferred(); const confirming = deferred();
  const fixture = await mainHarness({
    dialog: { showMessageBox: () => { confirming.resolve(); return confirmed.promise; } },
    makeSetupTools: () => ({ pending: null, prepare: () => ({ status: 'preparing' }), snapshot: () => ({ status: 'idle' }) }),
  });
  const reset = fixture.invoke('resetData');
  await confirming.promise;
  const preparation = await fixture.invoke('prepareSetup');
  assert.equal(preparation.ok, false);
  assert.match(preparation.error, /reset/i);
  confirmed.resolve({ response: 0 });
  assert.equal((await reset).value, false);
  assert.equal((await fixture.invoke('prepareSetup')).ok, true, 'cancelling reset releases the preparation guard');
});

async function importFixture(missingGuild = false) {
  const fixture = await mainHarness({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['old-project'] }) },
    context: { createHash, lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 50 }),
      readFile: async () => Buffer.from('legacy configuration fixture'),
      parseEnv: () => ({ DISCORD_TOKEN: 'imported-placeholder', GUILD_ID: newGuild.id, IDLE_TIMEOUT_SECONDS: '123' }),
      validateSettingsPatch: (patch) => patch },
  });
  fixture.supervisor.request = async (method, args) => {
    if (method === 'validateToken') return { botId: '456789012345678901', applicationId: '567890123456789012', name: 'Imported bot' };
    assert.equal(method, 'chooseGuild');
    assert.equal(args, newGuild.id);
    if (missingGuild) throw new Error('The bot has not joined that server. Invite it and try again.');
    fixture.supervisor.activeCoreConfig.guildId = args;
    fixture.supervisor.config.guildId = args;
    return newGuild;
  };
  return fixture;
}

test('legacy import applies its guild and playback settings to the active setup core', async () => {
  const fixture = await importFixture();
  const result = await fixture.invoke('importEnv');
  assert.equal(result.ok, true, result.error);
  assert.equal(fixture.settings.value.guildId, newGuild.id);
  assert.equal(fixture.supervisor.activeCoreConfig.guildId, newGuild.id);
  assert.equal(fixture.supervisor.activeCoreConfig.idleTimeoutSeconds, 123);
});

test('an imported server no longer joined leaves the validated token saved and no false selection', async () => {
  const fixture = await importFixture(true);
  const result = await fixture.invoke('importEnv');
  assert.equal(result.ok, false);
  assert.match(result.error, /has not joined/);
  assert.equal(fixture.tokenConfigured(), true);
  assert.equal(fixture.settings.value.guildId, '');
  assert.equal(fixture.supervisor.activeCoreConfig.guildId, '');
});
