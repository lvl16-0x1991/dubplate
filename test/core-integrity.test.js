import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyExecutable } from '../src/util/integrity.js';
import { checkYtdlp, prewarm, resolve, startPipeline } from '../src/player/ytdlp.js';
import { activeProcessIds, capture, setProcessSink } from '../src/player/processes.js';

test('managed executable checksums accept intact files and reject tampered or truncated files', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'music-integrity-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'download.bin');
  const content = Buffer.from('verified published executable bytes');
  const digest = createHash('sha256').update(content).digest('hex');
  await writeFile(path, content);
  assert.doesNotThrow(() => verifyExecutable(path, digest));
  await writeFile(path, Buffer.from('tampered published executable bytes'));
  assert.throws(() => verifyExecutable(path, digest), /checksum verification failed/);
  await writeFile(path, content.subarray(0, 4));
  assert.throws(() => verifyExecutable(path, digest), /checksum verification failed/);
  assert.throws(() => verifyExecutable(path, 'not-a-hash'), /checksum is invalid/);
});

test('every extraction launch and health probe verifies managed files before spawning', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'music-spawn-integrity-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'tampered.exe');
  await writeFile(path, 'tampered');
  const config = { ytdlpPath: path, ytdlpSha256: '0'.repeat(64), ffmpegPath: path };
  const track = { url: 'https://youtu.be/abcdefghijk' };
  await assert.rejects(checkYtdlp(config), /checksum verification failed/);
  await assert.rejects(resolve(config, 'test search'), /checksum verification failed/);
  await assert.rejects(prewarm(config, track), /checksum verification failed/);
  assert.throws(() => startPipeline(config, track, 0, () => {}), /checksum verification failed/);
  const nodeConfig = { ...config, nodePath: path, nodeSha256: '0'.repeat(64) };
  await assert.rejects(resolve(nodeConfig, 'test search'), /checksum verification failed/);
  assert.deepEqual(activeProcessIds(), []);
});

test('managed children strip inherited bot tokens and publish process IDs for crash cleanup', async () => {
  const previous = process.env.DISCORD_TOKEN;
  const events = [];
  process.env.DISCORD_TOKEN = ['never', 'give', 'this', 'to', 'a', 'downloader'].join('-');
  setProcessSink((event) => events.push(event));
  try {
    const output = await capture(process.execPath, ['-e', 'process.stdout.write(process.env.DISCORD_TOKEN || "absent")']);
    assert.equal(output, 'absent');
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'spawn');
    assert.equal(events[1].type, 'exit');
    assert.equal(events[0].pid, events[1].pid);
  } finally {
    if (previous === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = previous;
    setProcessSink(() => {});
  }
});
