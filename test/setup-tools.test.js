import test from 'node:test';
import assert from 'node:assert/strict';
import { SetupTools } from '../desktop/setup-tools.js';

const goodHealth = () => Object.fromEntries(['ytdlp', 'ffmpeg', 'node', 'opus', 'dave'].map((name) => [name, { ok: true }]));

test('background preparation returns immediately, deduplicates work and publishes verified readiness', async () => {
  let resolveDownload; let calls = 0; const events = []; const persisted = [];
  const tools = new SetupTools({ binaries: { ensureEssentials: () => { calls++; return new Promise((resolve) => { resolveDownload = resolve; }); } },
    getSettings: () => ({ ffmpegPath: '' }), persistFfmpeg: async (path) => persisted.push(path),
    checkHealth: async () => goodHealth(), publish: (event) => events.push(event) });
  assert.equal(tools.prepare().status, 'preparing'); assert.equal(tools.prepare().status, 'preparing'); assert.equal(calls, 1);
  assert.deepEqual(persisted, []);
  resolveDownload({ ytdlp: { ok: true }, ffmpeg: { ok: true }, ffmpegPath: 'verified-ffmpeg' }); await tools.pending;
  assert.deepEqual(persisted, ['verified-ffmpeg']); assert.equal(tools.snapshot().status, 'ready');
  tools.prepare(); assert.equal(calls, 1); assert.deepEqual(events.map((event) => event.status), ['preparing', 'ready']);
});

test('partial preparation failures retain verified tools and retry without hiding checksum errors', async () => {
  let attempts = 0; const persisted = [];
  const tools = new SetupTools({ binaries: { ensureEssentials: async () => { attempts++; return { ffmpeg: { ok: true }, ffmpegPath: 'verified-ffmpeg', ytdlp: { ok: attempts > 1, message: 'Checksum mismatch.' } }; } },
    getSettings: () => ({ ffmpegPath: '' }), persistFfmpeg: async (path) => persisted.push(path),
    checkHealth: async () => ({ ...goodHealth(), ytdlp: { ok: attempts > 1, message: 'Not verified.' } }), publish: () => {} });
  tools.prepare(); await tools.pending;
  assert.equal(tools.snapshot().status, 'error'); assert.match(tools.snapshot().message, /Checksum mismatch/);
  assert.deepEqual(persisted, ['verified-ffmpeg']);
  tools.prepare(); await tools.pending; assert.equal(attempts, 2); assert.equal(tools.snapshot().status, 'ready');
});
