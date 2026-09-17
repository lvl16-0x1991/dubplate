import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

// Deliberately exact hostnames, with no settings override. Each redirect is
// checked afresh, including GitHub's signed release-asset redirect.
export const DOWNLOAD_HOSTS = Object.freeze([
  'api.github.com', 'github.com', 'objects.githubusercontent.com',
  'release-assets.githubusercontent.com', 'www.gyan.dev',
]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SHA256 = /^[a-f0-9]{64}$/i;

export function validateDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid binary download URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !DOWNLOAD_HOSTS.includes(url.hostname) || url.hash) {
    throw new Error('Binary download URL is not on the fixed HTTPS host allowlist.');
  }
  return url;
}

function responseFor(url, { signal, idleTimeoutMs, request }) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      signal, agent: false, rejectUnauthorized: true,
      headers: { 'User-Agent': 'Dubplate-Desktop', Accept: '*/*', 'Accept-Encoding': 'identity' },
    }, resolve);
    req.once('error', reject);
    req.setTimeout(idleTimeoutMs, () => req.destroy(new Error('Binary download stalled.')));
  });
}

// request is injectable for deterministic tests without opening listening sockets.
export async function openDownload(value, {
  maxBytes = 256 * 1024 * 1024, timeoutMs = 300_000, idleTimeoutMs = 25_000,
  signal, request = https.get,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 * 1024 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000 ||
      !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 60_000) {
    throw new Error('Invalid download size or timeout limit.');
  }
  const abort = new AbortController();
  const onAbort = () => abort.abort(signal.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort.abort(new Error('Binary download timed out.')), timeoutMs);
  timer.unref();
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
  try {
    let url = validateDownloadUrl(value);
    for (let hop = 0; hop <= 5; hop++) {
      const response = await responseFor(url, { signal: abort.signal, idleTimeoutMs, request });
      if (REDIRECTS.has(response.statusCode)) {
        const location = response.headers.location;
        response.destroy();
        if (hop === 5 || typeof location !== 'string' || location.length > 16384) {
          throw new Error('Binary download exceeded its redirect limit or had an invalid redirect.');
        }
        url = validateDownloadUrl(new URL(location, url));
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        throw new Error(`Binary download failed: HTTPS ${response.statusCode}.`);
      }
      const encoding = response.headers['content-encoding'];
      const length = response.headers['content-length'];
      const total = length === undefined ? null : Number(length);
      if ((encoding && encoding !== 'identity') || (total !== null &&
          (!/^\d+$/.test(length) || !Number.isSafeInteger(total) || total > maxBytes))) {
        response.destroy();
        throw new Error('Binary download has an unsupported encoding or exceeds the size limit.');
      }
      // Keep the overall timeout alive until the caller has consumed the stream.
      response.once('close', cleanup);
      response.once('end', cleanup);
      response.once('error', cleanup);
      return { response, total, maxBytes, cleanup };
    }
    throw new Error('Binary download redirect failed.');
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function downloadBuffer(url, options = {}) {
  const { response, total, maxBytes, cleanup } = await openDownload(url, options);
  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of response) {
      received += chunk.length;
      if (received > maxBytes) throw new Error('Binary download exceeded the size limit.');
      chunks.push(chunk);
      options.onProgress?.({ received, total });
    }
    if (received === 0 || (total !== null && received !== total)) throw new Error('Binary download was empty or truncated.');
    return Buffer.concat(chunks);
  } finally { response.destroy(); cleanup(); }
}

export async function downloadToFile(url, destination, options = {}) {
  // Exclusive creation prevents an unexpected pre-existing file being replaced.
  const handle = await open(destination, 'wx', 0o600);
  let received = 0;
  let transfer;
  try {
    transfer = await openDownload(url, options);
    for await (const chunk of transfer.response) {
      received += chunk.length;
      if (received > transfer.maxBytes) throw new Error('Binary download exceeded the size limit.');
      options.onProgress?.({ received, total: transfer.total });
      await handle.writeFile(chunk);
    }
    if (received === 0 || (transfer.total !== null && received !== transfer.total)) {
      throw new Error('Binary download was empty or truncated.');
    }
    await handle.sync();
    return { path: destination, bytes: received };
  } catch (error) {
    await handle.close();
    await rm(destination, { force: true });
    throw error;
  } finally {
    transfer?.response.destroy();
    transfer?.cleanup();
    await handle.close();
  }
}

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyChecksum(path, expected) {
  if (typeof expected !== 'string' || !SHA256.test(expected)) throw new Error('Invalid published SHA-256 checksum.');
  const actual = await hashFile(path);
  if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new Error('SHA-256 checksum mismatch. The file is incomplete, changed, or untrusted; it will not run.');
  }
  return actual;
}

export function parseSha256Manifest(text, filename) {
  if (typeof text !== 'string' || text.length > 1024 * 1024 || typeof filename !== 'string' || /[/\\\r\n]/.test(filename)) {
    throw new Error('Invalid checksum manifest.');
  }
  const matches = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})[ \t]+\*?([^\r\n]+)$/i.exec(line.trim());
    if (match?.[2] === filename) matches.push(match[1].toLowerCase());
  }
  if (matches.length !== 1) throw new Error(`Published checksum manifest does not uniquely identify ${filename}.`);
  return matches[0];
}

export function parsePublishedSha256(text, filename) {
  const trimmed = text.trim();
  return SHA256.test(trimmed) ? trimmed.toLowerCase() : parseSha256Manifest(text, filename);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

// Only the verified publisher archive reaches this parser. It extracts one
// regular executable to a caller-owned path, never any archive-supplied path.
export async function extractZipExecutable(archive, destination, executable = 'ffmpeg.exe') {
  if (!/^[a-z0-9-]+\.exe$/i.test(executable)) throw new Error('Invalid archive executable name.');
  const file = await open(archive, 'r');
  let created = false;
  try {
    const { size } = await file.stat();
    if (size < 22 || size > 256 * 1024 * 1024) throw new Error('ZIP archive has an invalid size.');
    const tail = Buffer.alloc(Math.min(size, 65557));
    await file.read(tail, 0, tail.length, size - tail.length);
    let end = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
        end = offset; break;
      }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error('Unsupported or truncated ZIP archive.');
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 0 || count === 65535 || count > 10000 || count !== tail.readUInt16LE(end + 8) ||
        directorySize > 4 * 1024 * 1024 || directoryOffset + directorySize !== size - tail.length + end) {
      throw new Error('Unsupported ZIP directory or size limits exceeded.');
    }
    const directory = Buffer.alloc(directorySize);
    await file.read(directory, 0, directory.length, directoryOffset);
    const names = new Set();
    let selected;
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory entry.');
      const nameSize = directory.readUInt16LE(cursor + 28);
      const entrySize = 46 + nameSize + directory.readUInt16LE(cursor + 30) + directory.readUInt16LE(cursor + 32);
      if (cursor + entrySize > directory.length) throw new Error('Truncated ZIP directory entry.');
      const nameBytes = directory.subarray(cursor + 46, cursor + 46 + nameSize);
      const name = nameBytes.toString('utf8');
      const parts = name.split('/');
      const mode = directory.readUInt32LE(cursor + 38) >>> 16;
      if (!name || name.includes('\\') || name.includes('\0') || name.includes(':') || name.startsWith('/') ||
          parts.some((part) => part === '..' || part === '.') || names.has(name.toLowerCase()) ||
          (mode & 0xf000) === 0xa000) throw new Error('ZIP archive contains an unsafe, duplicate, or symbolic-link path.');
      names.add(name.toLowerCase());
      if (name.toLowerCase().endsWith(`/bin/${executable.toLowerCase()}`) || name.toLowerCase() === `bin/${executable.toLowerCase()}`) {
        if (selected) throw new Error('ZIP contains multiple matching executables.');
        selected = {
          nameBytes, flags: directory.readUInt16LE(cursor + 8), method: directory.readUInt16LE(cursor + 10),
          crc: directory.readUInt32LE(cursor + 16), compressed: directory.readUInt32LE(cursor + 20),
          size: directory.readUInt32LE(cursor + 24), offset: directory.readUInt32LE(cursor + 42),
        };
      }
      cursor += entrySize;
    }
    if (cursor !== directory.length || !selected || selected.flags & 1 || ![0, 8].includes(selected.method) ||
        selected.size === 0 || selected.size > 384 * 1024 * 1024 || selected.compressed === 0 ||
        selected.offset + 30 > directoryOffset) throw new Error('ZIP executable is missing, encrypted, or exceeds supported limits.');
    const local = Buffer.alloc(30);
    await file.read(local, 0, local.length, selected.offset);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== selected.flags ||
        local.readUInt16LE(8) !== selected.method || local.readUInt16LE(26) !== selected.nameBytes.length) {
      throw new Error('ZIP local header disagrees with its directory.');
    }
    const localName = Buffer.alloc(selected.nameBytes.length);
    await file.read(localName, 0, localName.length, selected.offset + 30);
    const dataStart = selected.offset + 30 + localName.length + local.readUInt16LE(28);
    if (!localName.equals(selected.nameBytes) || dataStart + selected.compressed > directoryOffset) throw new Error('ZIP executable data is truncated.');
    let written = 0;
    let crc = 0xffffffff;
    const output = await open(destination, 'wx', 0o700);
    created = true;
    try {
      const input = createReadStream(archive, { start: dataStart, end: dataStart + selected.compressed - 1 });
      const streams = [input];
      if (selected.method === 8) streams.push(createInflateRaw());
      streams.push(async (source) => {
        for await (const chunk of source) {
          written += chunk.length;
          if (written > selected.size) throw new Error('ZIP expanded beyond its published size.');
          for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
          await output.writeFile(chunk);
        }
      });
      await pipeline(...streams);
      if (written !== selected.size || ((crc ^ 0xffffffff) >>> 0) !== selected.crc) throw new Error('ZIP executable failed its size or CRC check.');
      await output.sync();
    } finally { await output.close(); }
    return destination;
  } catch (error) {
    if (created) await rm(destination, { force: true });
    throw error;
  } finally { await file.close(); }
}
