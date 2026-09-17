import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { defaults, migrateSettings, SettingsStore, validateSettingsPatch } from '../desktop/settings.js';
import { validateControl, validateIpcArgs, validateSender, allowedExternalUrl } from '../desktop/ipc-validation.js';
import { SecretStore } from '../desktop/secrets.js';
import { createRedactor, LogStore } from '../desktop/logs.js';

test('settings validate all numeric bounds and refuse executable/unknown or secret fields', () => {
  assert.equal(validateSettingsPatch({ maxQueue: 200, defaultVolume: 1.5 }).maxQueue, 200);
  for (const patch of [{ idleTimeoutSeconds: 0 }, { maxQueue: 1.2 }, { defaultVolume: NaN }, { defaultVolume: 1.6 }, { token: 'x' }, { schemaVersion: 0 }, { closeToTray: 1 }, { allowedHosts: ['localhost'] }]) assert.throws(() => validateSettingsPatch(patch));
  assert.throws(() => validateSettingsPatch(Object.create(null)));
  assert.deepEqual(validateSettingsPatch({ allowedHosts: ['youtube.com', 'music.youtube.com'] }).allowedHosts, ['youtube.com', 'music.youtube.com']);
});

test('settings migration strips plaintext token and corrupt settings visibly fall back', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dubplate-settings-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const migrated = migrateSettings({ maxQueue: 30, token: 'never-persist-this', schemaVersion: 0 });
  assert.equal(migrated.schemaVersion, 1); assert.equal(migrated.maxQueue, 30); assert.equal(migrated.token, undefined);
  assert.throws(() => migrateSettings({ schemaVersion: 999 }));
  await writeFile(join(directory, 'settings.json'), '{broken');
  const notices = []; const store = new SettingsStore(directory, (notice) => notices.push(notice));
  await store.load(); assert.equal(store.value.maxQueue, defaults.maxQueue); assert.equal(notices.length, 1);
  await assert.rejects(store.update({ maxQueue: -1 }));
  await store.update({ defaultVolume: 0.7 });
  assert.equal(JSON.parse(await readFile(store.path, 'utf8')).defaultVolume, 0.7);
});

test('IPC rejects untrusted frames, arbitrary methods and malformed control payloads', () => {
  const frame = { url: 'file:///app/index.html' };
  const contents = { id: 7, mainFrame: frame, isDestroyed: () => false };
  assert.doesNotThrow(() => validateSender({ sender: { id: 7 }, senderFrame: frame }, contents, frame.url));
  for (const event of [{ sender: { id: 8 }, senderFrame: frame }, { sender: { id: 7 }, senderFrame: { url: frame.url } }, { sender: { id: 7 }, senderFrame: null }]) assert.throws(() => validateSender(event, contents, frame.url));
  for (const request of [{ action: 'spawn', args: {} }, { action: 'volume', args: { percent: 151 } }, { action: 'seek', args: { seconds: -1 } }, { action: 'add', args: { query: 'x'.repeat(501) } }, { action: 'stop', args: { pid: 1 } }]) assert.throws(() => validateControl(request));
  assert.throws(() => validateIpcArgs('readFile', 'anything'));
  assert.throws(() => validateIpcArgs('bootstrap', { token: 'x' }));
  assert.throws(() => validateIpcArgs('saveSettings', { token: 'x' }));
  assert.equal(validateIpcArgs('control', { action: 'volume', args: { percent: 100 } }).args.percent, 100);
  assert.throws(() => allowedExternalUrl('https://evil.example/'));
  assert.throws(() => allowedExternalUrl('invite', { applicationId: '1&redirect_uri=https://evil.example' }));
  assert.match(allowedExternalUrl('invite', { applicationId: '123456789012345678' }), /permissions=3165184$/);
});

test('setup IPC accepts channel IDs only and shape-checks tokens before network validation', () => {
  const shaped = 'A'.repeat(24) + '.' + 'b'.repeat(6) + '.' + 'C'.repeat(38);
  assert.equal(validateIpcArgs('validateToken', shaped), shaped);
  for (const token of ['a client secret', 'x'.repeat(70), 'https://discord.com', `${shaped}\n`]) assert.throws(() => validateIpcArgs('validateToken', token));
  assert.deepEqual(validateIpcArgs('testVoice', { voiceChannelId: '123456789012345678' }), { voiceChannelId: '123456789012345678' });
  for (const request of [{ voiceChannelId: '1' }, { voiceChannelId: '123456789012345678', path: 'C:/private.wav' }, { voiceChannelId: '123456789012345678', ffmpegPath: 'anything' }]) assert.throws(() => validateIpcArgs('testVoice', request));
  for (const method of ['prepareSetup', 'pasteToken', 'beginGuildDiscovery', 'listVoiceChannels', 'chooseYtdlp']) assert.throws(() => validateIpcArgs(method, { arbitrary: true }));
});

test('preload refuses clipboard access without an active user gesture', async () => {
  let api; const calls = []; const navigator = { userActivation: { isActive: false } };
  const electron = { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { invoke: async (channel) => { calls.push(channel); return { ok: true, value: 'clipboard fixture' }; } } };
  runInNewContext(await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8'), { navigator, require: () => electron });
  assert.deepEqual(calls, []);
  await assert.rejects(api.pasteToken(), /Click Paste/); assert.deepEqual(calls, []);
  navigator.userActivation.isActive = true;
  assert.equal(await api.pasteToken(), 'clipboard fixture'); assert.deepEqual(calls, ['dubplate:pasteToken']);
});

test('secrets refuse unavailable secure storage and persist only encrypted bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dubplate-secret-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const unavailable = new SecretStore(directory, { isEncryptionAvailable: () => false });
  await assert.rejects(unavailable.set('sensitive-test-value'), /refuses/);
  const codec = { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('opaque-dpapi-fixture'), decryptString: () => 'sensitive-test-value' };
  const store = new SecretStore(directory, codec); await store.set('sensitive-test-value');
  const disk = await readFile(store.path, 'utf8'); assert.ok(!disk.includes('sensitive-test-value')); assert.equal(await store.get(), 'sensitive-test-value');
  assert.equal(new SecretStore(directory, { ...codec, getSelectedStorageBackend: () => 'basic_text' }).available(), false);
});

test('redaction covers exact tokens, Discord token shapes and authorization fields', () => {
  const redact = createRedactor(); redact.add('known-sensitive-value');
  assert.equal(redact('known-sensitive-value'), '[REDACTED]');
  assert.equal(redact(`prefix ${'A'.repeat(24)}.${'b'.repeat(6)}.${'C'.repeat(30)} suffix`), 'prefix [REDACTED] suffix');
  assert.equal(redact('Authorization: Bot exposed-value'), 'Authorization: [REDACTED]');
  assert.ok(!redact('DISCORD_TOKEN=exposed-value').includes('exposed-value'));
});

test('persisted rotating logs stay capped and redact before ring/events/files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dubplate-logs-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const events = []; const logs = new LogStore(directory, (event) => events.push(event)); logs.maxSize = 250; logs.maxFiles = 3; logs.addSecret('secret-for-log-test');
  for (let index = 0; index < 10; index++) logs.write({ level: 'info', message: `secret-for-log-test line ${index}` });
  await logs.flush();
  assert.ok(logs.snapshot().every((entry) => !entry.message.includes('secret-for-log-test')));
  assert.ok(events.every((event) => !JSON.stringify(event).includes('secret-for-log-test')));
  const files = await readdir(directory); assert.ok(files.length <= 3);
  for (const file of files) { const path = join(directory, file); assert.ok((await stat(path)).size <= 250); assert.ok(!(await readFile(path, 'utf8')).includes('secret-for-log-test')); }
});
