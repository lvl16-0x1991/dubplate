import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { capture, spawnManaged } from './processes.js';
import { httpUrl, normalizeQuery, requireAllowedUrl, UserError } from '../util/validation.js';
import { log } from '../util/log.js';
import { verifyExecutable } from '../util/integrity.js';

function commonArgs(config) {
  verifyExecutable(config.nodePath || process.execPath, config.nodeSha256);
  return ['--ignore-config', '--no-warnings', '--socket-timeout', '15', '--retries', '2', '--extractor-retries', '2',
    '--no-js-runtimes', '--js-runtimes', `node:${config.nodePath || process.execPath}`];
}

async function checkedCapture(config, name, args, options) {
  verifyExecutable(config[`${name}Path`], config[`${name}Sha256`]);
  return capture(config[`${name}Path`], args, options);
}

export async function checkFfmpeg(config) {
  const version = (await checkedCapture(config, 'ffmpeg', ['-version'], { timeoutMs: 10000 })).split(/\r?\n/)[0];
  const encoders = await checkedCapture(config, 'ffmpeg', ['-hide_banner', '-encoders'], { timeoutMs: 10000 });
  const formats = await checkedCapture(config, 'ffmpeg', ['-hide_banner', '-formats'], { timeoutMs: 10000 });
  if (!/\bpcm_s16le\b/.test(encoders) || !/^\s*[D ]E\s+s16le\b/m.test(formats)) {
    throw new Error('ffmpeg must support pcm_s16le encoding and the s16le output format. Choose a complete ffmpeg build.');
  }
  log.info(`Detected ${version}; raw PCM output supported`);
  return { ok: true, version, message: '48 kHz stereo signed 16-bit PCM output available.' };
}

export async function checkYtdlp(config) {
  const version = (await checkedCapture(config, 'ytdlp', ['--version'], { timeoutMs: 10000 })).trim();
  log.info(`Detected yt-dlp ${version}`);
  return { ok: true, version, message: 'Executable verified and version check passed.' };
}

export async function checkNode(config) {
  const path = config.nodePath || process.execPath;
  verifyExecutable(path, config.nodeSha256);
  const version = (await capture(path, ['--version'], { timeoutMs: 10000 })).trim();
  if (!/^v(?:2[2-9]|[3-9]\d)\./.test(version)) throw new Error('The yt-dlp JavaScript runtime must be Node.js 22 or newer.');
  return { ok: true, version, message: `yt-dlp JavaScript runtime: ${path}` };
}

export async function checkBinaries(config) {
  return { ffmpeg: await checkFfmpeg(config), ytdlp: await checkYtdlp(config), node: await checkNode(config) };
}

function entryUrl(entry, fallback) {
  const direct = [entry.webpage_url, entry.original_url, entry.url].find((value) => httpUrl(value));
  if (direct) return direct;
  if (/youtube/i.test(entry.ie_key || entry.extractor_key || entry.extractor || '') && /^[\w-]{11}$/.test(entry.id ?? '')) {
    return `https://www.youtube.com/watch?v=${entry.id}`;
  }
  return httpUrl(fallback);
}

const productionUrlPolicy = (input, config) => requireAllowedUrl(input, config.allowedHosts);

function metadataTracks(data, { fallback, limit = 200, requesterId, requesterName, textChannelId, config = {} } = {}, urlPolicy) {
  const entries = Array.isArray(data.entries) ? data.entries.flatMap((entry) => entry?.entries ?? [entry]) : [data];
  return entries.filter(Boolean).map((entry) => {
    const candidate = entryUrl(entry, entries.length === 1 && !data.entries ? fallback : undefined);
    if (!candidate) return null;
    let url;
    try { url = urlPolicy(candidate, config); } catch { return null; }
    const thumbnail = httpUrl(entry.thumbnail ?? entry.thumbnails?.at(-1)?.url);
    return {
      id: randomUUID(), url, title: String(entry.title || entry.fulltitle || 'Untitled track').slice(0, 1000),
      thumbnail: thumbnail?.startsWith('https:') ? thumbnail : null,
      uploader: String(entry.uploader || entry.channel || entry.creator || '').slice(0, 500),
      duration: typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration > 0 ? entry.duration : null,
      isLive: entry.is_live === true, requesterId, requesterName: String(requesterName || requesterId || 'Desktop').slice(0, 100), textChannelId,
    };
  }).filter(Boolean).slice(0, limit);
}

export function tracksFromMetadata(data, options) {
  return metadataTracks(data, options, productionUrlPolicy);
}

function pcmPipeline(config, source, offset, onFailure, downloader = null) {
  verifyExecutable(config.ffmpegPath, config.ffmpegSha256);
  const encoder = spawnManaged(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-ss', String(offset),
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-ar', '48000', '-ac', '2',
    '-c:a', 'pcm_s16le', '-f', 's16le', '-flush_packets', '1', 'pipe:1',
  ]);
  const managedProcesses = [...(downloader ? [['yt-dlp', downloader]] : []), ['ffmpeg', encoder]];
  let stopping = false;
  let failure = null;
  let stopPromise;
  function fail(error) {
    if (stopping || failure) return;
    failure = error;
    onFailure(error);
  }
  // Both music and the bundled test tone use this PCM/volume/Opus path.
  downloader?.child.stdin.end();
  source.pipe(encoder.child.stdin);
  source.on('error', (error) => fail(new Error(`Audio source: ${error.message}`)));
  for (const [name, managed] of managedProcesses) {
    managed.child.on('error', (error) => fail(new Error(`${name}: ${error.message}`)));
    managed.child.stdout.on('error', (error) => fail(new Error(`${name} output: ${error.message}`)));
    managed.child.stdin.on('error', (error) => fail(new Error(`${name} input: ${error.message}`)));
    managed.child.on('exit', (code, signal) => { if (code !== 0) fail(new Error(`${name} exited ${code ?? signal}`)); });
  }
  return {
    stream: encoder.child.stdout, downloader, encoder,
    completed: Promise.all(managedProcesses.map(([, process]) => process.done)),
    get failure() { return failure; },
    get stderr() { return managedProcesses.map(([name, process]) => `${name}: ${process.stderr}`).join('\n'); },
    stop() {
      if (!stopPromise) {
        stopping = true;
        stopPromise = (async () => {
          const results = await Promise.allSettled(managedProcesses.map(([, process]) => process.stop()));
          source.unpipe(encoder.child.stdin);
          source.destroy();
          for (const result of results) if (result.status === 'rejected') throw result.reason;
        })();
      }
      return stopPromise;
    },
  };
}

export function startVoiceTestPipeline(config, tone, onFailure) {
  if (!Buffer.isBuffer(tone) || tone.length < 44 || tone.length > 2 * 1024 * 1024
    || tone.toString('ascii', 0, 4) !== 'RIFF' || tone.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The bundled voice-test tone is missing or invalid. Reinstall Dubplate.');
  }
  return pcmPipeline(config, Readable.from(tone), 0, onFailure);
}

// A function dependency for isolated fixtures; never a setting received over IPC.
export function createMediaBackend(urlPolicy = productionUrlPolicy) {
  if (typeof urlPolicy !== 'function') throw new TypeError('URL policy must be a function.');
  function normalize(input, config) {
    if (typeof input !== 'string' || !input.trim() || input.length > 500) return normalizeQuery(input, config.allowedHosts);
    return httpUrl(input.trim()) ? urlPolicy(input.trim(), config) : normalizeQuery(input, config.allowedHosts);
  }
  async function metadata(config, input, { limit = 1, signal, single = false } = {}) {
    // Internal callers must pass the same boundary before spawning yt-dlp.
    if (!input.startsWith('ytsearch1:')) input = urlPolicy(input, config);
    const args = [...commonArgs(config), '--dump-single-json', '--flat-playlist', '--skip-download',
      '--playlist-end', String(limit), ...(single ? ['--no-playlist'] : []), '--', input];
    const raw = await checkedCapture(config, 'ytdlp', args, { signal, timeoutMs: single ? 25000 : 60000 });
    try { return JSON.parse(raw); } catch { throw new Error('yt-dlp did not return valid metadata JSON. Update yt-dlp from the Health panel.'); }
  }
  async function resolve(config, query, { limit = 200, signal, requesterId, requesterName, textChannelId } = {}) {
    const input = normalize(query, config);
    const data = await metadata(config, input, { limit, signal });
    const tracks = metadataTracks(data, { fallback: httpUrl(input), limit, requesterId, requesterName, textChannelId, config }, urlPolicy);
    if (!tracks.length) throw new UserError('No playable tracks from allowed hosts were found. Check the query or URL, or update yt-dlp from the Health panel.');
    return { tracks, capped: tracks.length >= limit, title: String(data.title || '') };
  }
  async function prewarm(config, track, signal) {
    const data = await metadata(config, urlPolicy(track.url, config), { signal, single: true });
    const fresh = metadataTracks(data, { fallback: track.url, limit: 1, config }, urlPolicy)[0];
    if (!fresh) throw new Error('No metadata from an allowed host found for the next track.');
    return { title: fresh.title, duration: fresh.duration, isLive: fresh.isLive, thumbnail: fresh.thumbnail, uploader: fresh.uploader };
  }
  function startPipeline(config, track, offset, onFailure) {
    const url = urlPolicy(track.url, config);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid playback offset.');
    const downloadArgs = [...commonArgs(config), '-f', 'bestaudio/best', '-o', '-', '--no-playlist', '--quiet', '--downloader', 'native',
      ...(/[\\/]/.test(config.ffmpegPath) ? ['--ffmpeg-location', config.ffmpegPath] : []), '--', url];
    // Check both before either starts, so verification failure leaves no orphan.
    verifyExecutable(config.ytdlpPath, config.ytdlpSha256);
    verifyExecutable(config.ffmpegPath, config.ffmpegSha256);
    const downloader = spawnManaged(config.ytdlpPath, downloadArgs);
    return pcmPipeline(config, downloader.child.stdout, offset, onFailure, downloader);
  }
  return Object.freeze({ normalizeQuery: normalize, resolve, prewarm, startPipeline });
}

export const productionBackend = createMediaBackend();
export const { resolve, prewarm, startPipeline } = productionBackend;
