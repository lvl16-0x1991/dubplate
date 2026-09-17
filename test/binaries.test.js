import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { BinaryManager, BINARY_SOURCES } from '../desktop/binaries.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');

async function setup(t) {
  const binDir = await mkdtemp(join(tmpdir(), 'dubplate-binary-test-'));
  t.after(() => rm(binDir, { recursive: true, force: true }));
  const state = { version: '2026.08.19', tamperedDownload: false, failFinal: false, calls: [], requests: [] };
  function bytes() {
    const result = Buffer.alloc(1024 * 1024, 0);
    result.write(`MZ${state.version}\n`);
    return result;
  }
  const manager = new BinaryManager({
    binDir, nodePath: process.execPath, findFfmpeg: async () => null,
    run: async (path) => {
      state.calls.push(path);
      if (path === process.execPath) return 'v24.13.0\n';
      if (state.failFinal && basename(path) === 'yt-dlp.exe') throw new Error('Final version check failed.');
      const data = await readFile(path);
      return data.subarray(2, 12).toString('utf8');
    },
    fetchBuffer: async (url) => {
      state.requests.push(url);
      if (url === BINARY_SOURCES.ytdlpReleaseApi) return Buffer.from(JSON.stringify({
        tag_name: state.version, assets: [{ name: 'yt-dlp.exe', size: bytes().length }, { name: 'SHA2-256SUMS' }],
      }));
      assert.equal(url, `https://github.com/yt-dlp/yt-dlp/releases/download/${state.version}/SHA2-256SUMS`);
      return Buffer.from(`${digest(bytes())}  yt-dlp.exe\n`);
    },
    fetchFile: async (url, destination) => {
      state.requests.push(url);
      const data = bytes();
      if (state.tamperedDownload) data[100] ^= 1;
      await writeFile(destination, data, { flag: 'wx' });
      return { path: destination, bytes: data.length };
    },
  });
  return { manager, state, binDir, bytes };
}

test('managed yt-dlp verifies first use, reuses verified file, and refuses tampering before execution', async (t) => {
  const { manager, state, binDir } = await setup(t);
  const initial = await manager.ensureYtdlp();
  assert.equal(initial.ok, true);
  assert.equal(initial.version, '2026.08.19');
  assert.equal(initial.path, join(binDir, 'yt-dlp.exe'));
  assert.equal(initial.sha256.length, 64);
  const requestCount = state.requests.length;
  assert.equal((await manager.ensureYtdlp()).ok, true);
  assert.equal(state.requests.length, requestCount, 'verified copy is reused without a download');
  await writeFile(initial.path, 'tampered executable');
  state.calls.length = 0;
  const health = await manager.health();
  assert.equal(health.ytdlp.ok, false);
  assert.match(health.ytdlp.message, /checksum mismatch/);
  assert.equal(state.calls.includes(initial.path), false, 'tampered file was never executed');
  await assert.rejects(manager.resolvePaths(), /checksum mismatch/);
  assert.equal(state.calls.includes(initial.path), false);
});

test('tampered managed download is deleted and never executed', async (t) => {
  const { manager, state, binDir } = await setup(t);
  state.tamperedDownload = true;
  await assert.rejects(manager.ensureYtdlp(), /checksum mismatch/);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(await readdir(binDir), []);
});

test('unrecorded file is never executed, and corrupted records require a new verified download', async (t) => {
  const { manager, state, binDir } = await setup(t);
  const path = join(binDir, 'yt-dlp.exe');
  await writeFile(path, 'MZunverified');
  let health = await manager.health();
  assert.equal(health.ytdlp.ok, false);
  assert.equal(state.calls.includes(path), false);
  await writeFile(join(binDir, 'verified-binaries.json'), '{broken');
  state.calls.length = 0;
  health = await manager.health();
  assert.equal(health.ytdlp.ok, false);
  assert.equal(state.calls.includes(path), false);
  assert.equal((await manager.ensureYtdlp()).ok, true);
});

test('an update rolls back verified executable and metadata if final-path version check fails', async (t) => {
  const { manager, state, binDir } = await setup(t);
  const original = await manager.ensureYtdlp();
  const before = await readFile(original.path);
  const record = await readFile(join(binDir, 'verified-binaries.json'), 'utf8');
  state.version = '2026.09.17';
  state.failFinal = true;
  await assert.rejects(manager.updateYtdlp(), /Final version check failed/);
  assert.deepEqual(await readFile(original.path), before);
  assert.equal(await readFile(join(binDir, 'verified-binaries.json'), 'utf8'), record);
  assert.deepEqual((await readdir(binDir)).sort(), ['verified-binaries.json', 'yt-dlp.exe']);
  state.failFinal = false;
  assert.equal((await manager.health()).ytdlp.version, '2026.08.19');
  assert.equal((await manager.updateYtdlp()).version, '2026.09.17');
});

test('daily update checks cache results and do not replace binaries', async (t) => {
  const { manager, state, binDir } = await setup(t);
  const initial = await manager.ensureYtdlp();
  state.version = '2026.09.17';
  const result = await manager.checkForUpdates();
  assert.equal(result.updateAvailable, true);
  assert.equal(result.installedVersion, '2026.08.19');
  assert.equal(result.latestVersion, '2026.09.17');
  assert.ok(Date.parse(result.lastCheck));
  const requestCount = state.requests.length;
  assert.deepEqual(await manager.checkForUpdates(), result);
  assert.equal(state.requests.length, requestCount);
  assert.equal(digest(await readFile(join(binDir, 'yt-dlp.exe'))), initial.sha256);
});

test('remote release metadata cannot provide arbitrary asset download URLs', async (t) => {
  const { manager, state } = await setup(t);
  state.version = '../evil';
  await assert.rejects(manager.ensureYtdlp(), /metadata was invalid/);
  assert.deepEqual(state.requests, [BINARY_SOURCES.ytdlpReleaseApi]);
  assert.deepEqual(state.calls, []);
});

test('bundled Node is verified before its version probe and a missing or tampered runtime never executes', async (t) => {
  const { binDir } = await setup(t);
  const nodePath = join(binDir, 'node.exe');
  const bytes = Buffer.from('MZ bundled Node fixture');
  await writeFile(nodePath, bytes);
  const calls = [];
  const manager = new BinaryManager({ binDir, nodePath, findFfmpeg: async () => null,
    run: async (path) => { calls.push(path); return 'v24.21.0'; } });
  assert.equal((await manager.health()).node.ok, false);
  assert.deepEqual(calls, []);
  await writeFile(join(binDir, 'runtime.json'), JSON.stringify({ version: '24.21.0', sha256: digest(bytes) }));
  const healthy = (await manager.health()).node;
  assert.equal(healthy.ok, true);
  assert.equal(healthy.sha256, digest(bytes));
  assert.deepEqual(calls, [nodePath]);
  calls.length = 0;
  await writeFile(nodePath, 'MZ changed Node');
  const unhealthy = (await manager.health()).node;
  assert.equal(unhealthy.ok, false);
  assert.match(unhealthy.message, /checksum mismatch/);
  assert.deepEqual(calls, []);
});

test('ffmpeg publisher checksum disagreement fails before fetching or executing the ZIP', async (t) => {
  const { binDir } = await setup(t);
  const calls = [];
  const manager = new BinaryManager({ binDir, nodePath: process.execPath,
    run: async () => { calls.push('run'); }, fetchFile: async () => { calls.push('download'); },
    fetchBuffer: async (url) => {
      if (url === BINARY_SOURCES.ffmpegReleaseApi) return Buffer.from(JSON.stringify({ tag_name: '9.0.1', assets: [
        { name: 'ffmpeg-9.0.1-essentials_build.zip', size: 10000000, digest: `sha256:${digest('GitHub published archive')}` },
      ] }));
      return Buffer.from(digest('different publisher archive'));
    },
  });
  await assert.rejects(manager.installFfmpeg(), /checksum disagrees/);
  assert.deepEqual(calls, []);
});

test('manual yt-dlp selection is copied and verified before execution; the selected original stays unchanged', async (t) => {
  const { manager, state, binDir, bytes } = await setup(t);
  const selected = join(binDir, 'selected.exe');
  const original = bytes();
  await writeFile(selected, original);
  const result = await manager.importYtdlp(selected);
  assert.equal(result.ok, true);
  assert.equal(result.version, '2026.08.19');
  assert.deepEqual(await readFile(selected), original);
  assert.equal(state.calls.includes(selected), false, 'the user-selected path is never executed');
  assert.equal(state.requests.some((url) => url.endsWith('/yt-dlp.exe')), false, 'manual import downloads checksums only');
  assert.deepEqual(await readFile(result.path), original);
});

test('manual yt-dlp restores a saved verified release offline and refuses an unknown file without executing it', async (t) => {
  const { manager, state, binDir, bytes } = await setup(t);
  const installed = await manager.ensureYtdlp();
  const selected = join(binDir, 'selected.exe');
  await writeFile(selected, bytes());
  await writeFile(installed.path, 'damaged installed file');
  manager.fetchBuffer = async () => { throw new Error('Offline'); };
  assert.equal((await manager.importYtdlp(selected)).ok, true);
  assert.equal((await manager.health()).ytdlp.ok, true);
  state.calls.length = 0;
  await writeFile(selected, 'unknown executable');
  await assert.rejects(manager.importYtdlp(selected), /Cannot verify.*official release checksum/);
  assert.deepEqual(state.calls, []);
  assert.ok(!(await readdir(binDir)).some((name) => name.startsWith('.import-')));
});

test('manual yt-dlp checksum mismatch fails before execution and final verification failures roll back', async (t) => {
  const { manager, state, binDir, bytes } = await setup(t);
  const initial = await manager.ensureYtdlp();
  const previous = await readFile(initial.path);
  const selected = join(binDir, 'selected.exe');
  await writeFile(selected, 'wrong release');
  state.calls.length = 0;
  await assert.rejects(manager.importYtdlp(selected), /does not match/);
  assert.deepEqual(state.calls, []);
  state.version = '2026.09.17';
  await writeFile(selected, bytes());
  state.failFinal = true;
  await assert.rejects(manager.importYtdlp(selected), /Final version check failed/);
  assert.deepEqual(await readFile(initial.path), previous);
});

function storedZip(name, data) {
  const filename = Buffer.from(name);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}

test('essential tools download concurrently and serialized installs preserve both verification records', { timeout: 10000 }, async (t) => {
  const { binDir, bytes } = await setup(t);
  const yt = bytes();
  const ff = Buffer.alloc(1024 * 1024, 7);
  const zip = storedZip('ffmpeg-9.0.1/bin/ffmpeg.exe', ff);
  const started = [];
  let releaseDownloads;
  const barrier = new Promise((resolve) => { releaseDownloads = resolve; });
  const timeout = setTimeout(() => releaseDownloads(), 2000);
  t.after(() => clearTimeout(timeout));
  const manager = new BinaryManager({ binDir, nodePath: process.execPath, findFfmpeg: async () => null,
    run: async (path) => path === process.execPath ? 'v24.21.0' : basename(path).includes('ffmpeg') ? 'ffmpeg version 9.0.1-test' : '2026.08.19',
    fetchBuffer: async (url) => {
      if (url === BINARY_SOURCES.ytdlpReleaseApi) return Buffer.from(JSON.stringify({ tag_name: '2026.08.19', assets: [{ name: 'yt-dlp.exe', size: yt.length }, { name: 'SHA2-256SUMS' }] }));
      if (url === BINARY_SOURCES.ffmpegReleaseApi) return Buffer.from(JSON.stringify({ tag_name: '9.0.1', assets: [{ name: 'ffmpeg-9.0.1-essentials_build.zip', size: zip.length, digest: `sha256:${digest(zip)}` }] }));
      return Buffer.from(url.endsWith('SHA2-256SUMS') ? `${digest(yt)}  yt-dlp.exe\n` : digest(zip));
    },
    fetchFile: async (url, path) => {
      const kind = url.endsWith('.zip') ? 'ffmpeg' : 'ytdlp';
      started.push(kind);
      if (started.length === 2) releaseDownloads();
      await barrier;
      assert.equal(started.length, 2, 'both downloads must begin before either completes');
      const data = kind === 'ffmpeg' ? zip : yt;
      await writeFile(path, data, { flag: 'wx' });
      return { bytes: data.length, path };
    },
  });
  const [result] = await Promise.all([manager.ensureEssentials(), manager.checkForUpdates()]);
  assert.equal(result.ytdlp.ok, true, result.ytdlp.message);
  assert.equal(result.ffmpeg.ok, true, result.ffmpeg.message);
  assert.equal(result.ffmpegPath, join(binDir, 'ffmpeg.exe'));
  const records = JSON.parse(await readFile(join(binDir, 'verified-binaries.json'), 'utf8'));
  assert.equal(records.ytdlp.sha256, digest(yt));
  assert.equal(records.ffmpeg.sha256, digest(ff));
  assert.ok(records.updateCheck.lastCheck);
  assert.equal((await manager.ensureEssentials()).ffmpeg.ok, true);
  assert.equal(started.length, 2, 'successful tools are reused on subsequent preparation');
});

test('essential preparation reports partial failure and retry preserves the already working tool', async (t) => {
  const { manager, binDir } = await setup(t);
  const ffmpegPath = join(binDir, 'existing-ffmpeg.exe');
  await writeFile(ffmpegPath, 'existing trusted local ffmpeg');
  manager.findFfmpeg = async () => ffmpegPath;
  const run = manager.run;
  manager.run = async (path, ...args) => path === ffmpegPath ? 'ffmpeg version 9.0.1' : run(path, ...args);
  const fetch = manager.fetchBuffer;
  manager.fetchBuffer = async () => { throw new Error('GitHub is unavailable'); };
  const partial = await manager.ensureEssentials();
  assert.equal(partial.ytdlp.ok, false);
  assert.match(partial.ytdlp.message, /GitHub is unavailable/);
  assert.equal(partial.ffmpeg.ok, true);
  assert.equal(partial.ffmpegPath, ffmpegPath);
  manager.fetchBuffer = fetch;
  const retried = await manager.ensureEssentials();
  assert.equal(retried.ytdlp.ok, true);
  assert.equal(retried.ffmpegPath, ffmpegPath);
});
