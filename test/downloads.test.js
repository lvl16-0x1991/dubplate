import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import { downloadBuffer, downloadToFile, extractZipExecutable, parsePublishedSha256, parseSha256Manifest, validateDownloadUrl, verifyChecksum } from '../desktop/downloads.js';

const digest = (data) => createHash('sha256').update(data).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dubplate-download-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function transport(routes, visited = []) {
  return (url, options, callback) => {
    visited.push(url.href);
    assert.equal(options.rejectUnauthorized, true);
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => { if (error) request.emit('error', error); };
    queueMicrotask(() => {
      const route = routes[url.href];
      if (!route) { request.emit('error', new Error(`Unexpected test URL: ${url.href}`)); return; }
      const response = Readable.from(route.chunks || [Buffer.from(route.body || '')]);
      response.statusCode = route.status || 200;
      response.headers = route.headers || {};
      callback(response);
    });
    return request;
  };
}

test('download URLs require exact fixed HTTPS hosts and reject IP, credentials, ports and suffix tricks', () => {
  for (const url of ['https://github.com/a', 'https://api.github.com/a', 'https://objects.githubusercontent.com/a',
    'https://release-assets.githubusercontent.com/a?signature=value', 'https://www.gyan.dev/ffmpeg/builds/a']) {
    assert.doesNotThrow(() => validateDownloadUrl(url));
  }
  for (const url of ['http://github.com/a', 'file:///bin/tool', 'https://github.com.evil.test/a',
    'https://evilgithub.com/a', 'https://sub.github.com/a', 'https://github.com:8443/a',
    'https://user:pass@github.com/a', 'https://127.0.0.1/a', 'https://[::1]/a',
    'https://2130706433/a', 'https://0x7f000001/a', 'https://localhost/a', 'https://github.com/a#fragment']) {
    assert.throws(() => validateDownloadUrl(url), /allowlist|Invalid/);
  }
});

test('every redirect is checked, HTTPS downgrade and non-allowlisted host never reach transport', async () => {
  const start = 'https://github.com/release';
  const target = 'https://release-assets.githubusercontent.com/tool.exe?token=x';
  const visited = [];
  const body = await downloadBuffer(start, { request: transport({
    [start]: { status: 302, headers: { location: target } }, [target]: { body: 'verified bytes' },
  }, visited), maxBytes: 100 });
  assert.equal(body.toString(), 'verified bytes');
  assert.deepEqual(visited, [start, target]);
  for (const location of ['http://github.com/release', 'https://127.0.0.1/tool', 'https://github.com.evil.test/tool']) {
    const denied = [];
    await assert.rejects(downloadBuffer(start, { request: transport({ [start]: { status: 302, headers: { location } } }, denied) }), /allowlist/);
    assert.deepEqual(denied, [start]);
  }
  await assert.rejects(downloadBuffer(start, { request: transport({ [start]: { status: 302, headers: { location: start } } }) }), /redirect limit/);
});

test('downloads enforce announced and streamed size caps, truncation, encodings and response status', async () => {
  const url = 'https://github.com/tool';
  for (const route of [
    { headers: { 'content-length': '1000' }, body: 'x' },
    { chunks: [Buffer.alloc(5), Buffer.alloc(6)] },
    { headers: { 'content-length': '8' }, body: 'short' },
    { headers: { 'content-encoding': 'gzip' }, body: 'compressed' },
    { status: 404, body: 'not found' }, { body: '' },
  ]) {
    await assert.rejects(downloadBuffer(url, { maxBytes: 10, request: transport({ [url]: route }) }), /size limit|truncated|encoding|HTTPS 404/);
  }
});

test('verified good file passes, byte tampering and truncation fail SHA-256', async (t) => {
  const directory = await fixture(t);
  const file = join(directory, 'tool.exe');
  const good = Buffer.from('publisher executable payload\0\xff');
  await writeFile(file, good);
  assert.equal(await verifyChecksum(file, digest(good)), digest(good));
  const modified = Buffer.from(good); modified[3] ^= 1;
  await writeFile(file, modified);
  await assert.rejects(verifyChecksum(file, digest(good)), /checksum mismatch/);
  await writeFile(file, good.subarray(0, good.length - 1));
  await assert.rejects(verifyChecksum(file, digest(good)), /checksum mismatch/);
  await assert.rejects(verifyChecksum(file, 'not a hash'), /Invalid published/);
});

test('published manifests identify one exact file and reject duplicate or missing names', () => {
  const sha = digest('bytes');
  assert.equal(parseSha256Manifest(`${sha}  yt-dlp.exe\n${digest('other')} *yt-dlp\n`, 'yt-dlp.exe'), sha);
  assert.equal(parsePublishedSha256(`${sha.toUpperCase()}\n`, 'ffmpeg.zip'), sha);
  assert.equal(parsePublishedSha256(`${sha} *ffmpeg.zip\n`, 'ffmpeg.zip'), sha);
  assert.throws(() => parseSha256Manifest(`${sha} yt-dlp.exe.evil\n`, 'yt-dlp.exe'), /uniquely/);
  assert.throws(() => parseSha256Manifest(`${sha} yt-dlp.exe\n${sha} yt-dlp.exe\n`, 'yt-dlp.exe'), /uniquely/);
});

test('file downloads create exclusively and remove failed partial downloads', async (t) => {
  const directory = await fixture(t);
  const file = join(directory, 'tool.exe');
  const url = 'https://github.com/tool';
  const result = await downloadToFile(url, file, { request: transport({ [url]: { body: 'complete' } }), maxBytes: 20 });
  assert.equal(result.bytes, 8);
  assert.equal(await readFile(file, 'utf8'), 'complete');
  await assert.rejects(downloadToFile(url, file), /EEXIST/);
  assert.equal(await readFile(file, 'utf8'), 'complete');
  const failed = join(directory, 'partial.exe');
  await assert.rejects(downloadToFile(url, failed, { request: transport({ [url]: { body: 'too many bytes' } }), maxBytes: 3 }), /size limit/);
  await assert.rejects(readFile(failed), /ENOENT/);
});

export function makeZip(name, data, { symlink = false, badCrc = false } = {}) {
  const nameBytes = Buffer.from(name);
  const compressed = deflateRawSync(data);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  crc = ((crc ^ 0xffffffff) >>> 0) + (badCrc ? 1 : 0);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc >>> 0, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
  if (symlink) central.writeUInt32LE((0xa1ff << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(local.length + nameBytes.length + compressed.length, 16);
  return Buffer.concat([local, nameBytes, compressed, central, nameBytes, end]);
}

test('bounded ZIP extraction writes only the requested executable and rejects traversal, symlinks and corruption', async (t) => {
  const directory = await fixture(t);
  const zip = join(directory, 'download.zip');
  const output = join(directory, 'ffmpeg.exe');
  const data = Buffer.from('MZ verified executable fixture');
  await writeFile(zip, makeZip('ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe', data));
  await extractZipExecutable(zip, output);
  assert.deepEqual(await readFile(output), data);
  await rm(output);
  for (const [name, options] of [['../../bin/ffmpeg.exe', {}], ['/bin/ffmpeg.exe', {}],
    ['c:/bin/ffmpeg.exe', {}], ['build\\bin\\ffmpeg.exe', {}],
    ['build/bin/ffmpeg.exe', { symlink: true }], ['build/bin/ffmpeg.exe', { badCrc: true }]]) {
    await writeFile(zip, makeZip(name, data, options));
    await assert.rejects(extractZipExecutable(zip, output), /unsafe|CRC/);
    await assert.rejects(readFile(output), /ENOENT/);
  }
  await writeFile(zip, makeZip('build/bin/ffmpeg.exe', data).subarray(0, -2));
  await assert.rejects(extractZipExecutable(zip, output), /truncated/);
});
