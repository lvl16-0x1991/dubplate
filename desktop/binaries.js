import { randomUUID } from 'node:crypto';
import { access, chmod, copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { capture } from '../src/player/processes.js';
import { downloadBuffer, downloadToFile, extractZipExecutable, hashFile, parsePublishedSha256, parseSha256Manifest, verifyChecksum } from './downloads.js';

export const BINARY_SOURCES = Object.freeze({
  ytdlp: 'https://github.com/yt-dlp/yt-dlp/releases',
  ytdlpReleaseApi: 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest',
  ffmpeg: 'https://www.gyan.dev/ffmpeg/builds/',
  ffmpegReleaseApi: 'https://api.github.com/repos/GyanD/codexffmpeg/releases/latest',
  ffmpegMirror: 'https://github.com/GyanD/codexffmpeg/releases',
});
const FILES = Object.freeze({ ytdlp: 'yt-dlp.exe', ffmpeg: 'ffmpeg.exe' });
const VERSION = /^\d{4}\.\d{2}\.\d{2}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ONE_DAY = 24 * 60 * 60 * 1000;

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

export async function findFfmpegOnPath(pathValue = process.env.PATH || '', platform = process.platform) {
  const executable = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (let directory of pathValue.split(delimiter)) {
    directory = directory.replace(/^"(.*)"$/, '$1');
    // Do not search the current directory via an empty/relative PATH entry.
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, executable);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* Continue searching PATH. */ }
  }
  return null;
}

function message(error) {
  return String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 800);
}

export class BinaryManager {
  constructor({ binDir, nodePath = process.execPath, onProgress = () => {}, onNotice = () => {},
    run = capture, fetchBuffer = downloadBuffer, fetchFile = downloadToFile, findFfmpeg = findFfmpegOnPath } = {}) {
    if (typeof binDir !== 'string' || !isAbsolute(binDir)) throw new Error('Binary directory must be an absolute path.');
    if (typeof nodePath !== 'string' || !isAbsolute(nodePath)) throw new Error('Node runtime must be an absolute path.');
    this.binDir = resolve(binDir);
    this.nodePath = nodePath;
    this.onProgress = onProgress;
    this.onNotice = onNotice;
    this.run = run;
    this.fetchBuffer = fetchBuffer;
    this.fetchFile = fetchFile;
    this.findFfmpeg = findFfmpeg;
    this.metadataPath = join(this.binDir, 'verified-binaries.json');
    this.operations = new Map();
    this.metadataSerial = Promise.resolve();
    this.notices = new Set();
    this.lastCheck = null;
  }

  #notice(text) {
    if (this.notices.has(text)) return;
    this.notices.add(text);
    this.onNotice(text);
  }

  #operation(kind, fn) {
    const previous = this.operations.get(kind) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.operations.set(kind, next);
    return next;
  }

  #metadataOperation(fn) {
    const next = this.metadataSerial.catch(() => {}).then(fn);
    this.metadataSerial = next;
    return next;
  }

  #progress(binary, phase, detail = {}) {
    this.onProgress({ binary, phase, ...detail });
  }

  async #metadata() {
    try {
      const info = await stat(this.metadataPath);
      if (info.size > 32768) throw new Error('Verification record is too large.');
      const data = JSON.parse(await readFile(this.metadataPath, 'utf8'));
      if (!data || data.schemaVersion !== 1 || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid verification record.');
      for (const kind of Object.keys(FILES)) {
        const record = data[kind];
        if (record !== undefined && (!record || record.file !== FILES[kind] || !SHA256.test(record.sha256) ||
            typeof record.version !== 'string' || record.version.length > 120 || typeof record.source !== 'string')) {
          throw new Error('Invalid verification record.');
        }
      }
      return data;
    } catch (error) {
      if (error.code !== 'ENOENT') this.#notice('Binary verification records could not be read. Managed files must be downloaded and verified again.');
      return { schemaVersion: 1 };
    }
  }

  async #saveMetadata(data) {
    await mkdir(this.binDir, { recursive: true });
    const temporary = join(this.binDir, `.verification-${randomUUID()}.json`);
    try {
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, this.metadataPath);
    } finally { await rm(temporary, { force: true }); }
  }

  async #verified(kind, metadata) {
    const record = (metadata || await this.#metadata())[kind];
    if (!record) throw new Error(`${kind === 'ytdlp' ? 'yt-dlp' : 'ffmpeg'} has not been downloaded and verified yet.`);
    const path = join(this.binDir, FILES[kind]);
    await verifyChecksum(path, record.sha256);
    return { ...record, path };
  }

  async #version(kind, path) {
    const args = kind === 'ytdlp' ? ['--ignore-config', '--version'] : kind === 'ffmpeg' ? ['-hide_banner', '-version'] : ['--version'];
    const output = await this.run(path, args, { timeoutMs: 25000, maxBytes: 128 * 1024 });
    const first = output.trim().split(/\r?\n/)[0] || '';
    if (kind === 'ytdlp' && !VERSION.test(first)) throw new Error('yt-dlp returned an invalid version.');
    if (kind === 'node' && !/^v\d+\.\d+\.\d+(?:-\S+)?$/.test(first)) throw new Error('The configured Node runtime did not report a Node version.');
    if (kind === 'ffmpeg') {
      const version = /^ffmpeg version ([^ ]+)/.exec(first)?.[1];
      if (!version) throw new Error('The selected file did not report an ffmpeg version.');
      return version.slice(0, 120);
    }
    return first;
  }

  async #ytdlpHealth() {
    try {
      const record = await this.#verified('ytdlp');
      const version = await this.#version('ytdlp', record.path);
      if (version !== record.version) throw new Error('yt-dlp version differs from its verified release.');
      return { ok: true, version, path: record.path, sha256: record.sha256, message: 'Official release verified with SHA-256.', source: BINARY_SOURCES.ytdlp };
    } catch (error) { return { ok: false, version: null, message: message(error), source: BINARY_SOURCES.ytdlp }; }
  }

  async #ffmpegHealth(ffmpegPath) {
    try {
      let path;
      let record;
      const managedPath = join(this.binDir, FILES.ffmpeg);
      if (ffmpegPath && ffmpegPath !== 'ffmpeg') {
        if (typeof ffmpegPath !== 'string' || !isAbsolute(ffmpegPath)) throw new Error('Select an absolute ffmpeg executable path.');
        path = resolve(ffmpegPath);
        if (path.toLowerCase() === managedPath.toLowerCase()) record = await this.#verified('ffmpeg');
      } else {
        path = await this.findFfmpeg();
        // A managed bin directory may itself be on PATH, so still verify it.
        if (!path || path.toLowerCase() === managedPath.toLowerCase()) {
          record = await this.#verified('ffmpeg');
          path = record.path;
        }
      }
      const version = await this.#version('ffmpeg', path);
      return { ok: true, version, path, sha256: record?.sha256, managed: Boolean(record),
        source: record ? BINARY_SOURCES.ffmpeg : 'Selected executable / system PATH',
        message: record ? 'Gyan release archive verified with the official release SHA-256.' : 'Available on this computer.' };
    } catch (error) { return { ok: false, version: null, message: message(error), source: BINARY_SOURCES.ffmpeg }; }
  }

  async #nodeHealth() {
    try {
      let sha256;
      let expectedVersion;
      const manifestPath = join(dirname(this.nodePath), 'runtime.json');
      if (await isFile(manifestPath)) {
        const manifestInfo = await stat(manifestPath);
        if (manifestInfo.size > 4096) throw new Error('Bundled Node verification record exceeds its size limit.');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (!manifest || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !SHA256.test(manifest.sha256)) {
          throw new Error('Bundled Node verification record is invalid.');
        }
        sha256 = await verifyChecksum(this.nodePath, manifest.sha256);
        expectedVersion = `v${manifest.version}`;
      } else if (this.nodePath !== process.execPath || process.versions.electron) {
        throw new Error('Bundled Node verification record is missing. Reinstall Dubplate to restore it.');
      }
      const version = await this.#version('node', this.nodePath);
      if (expectedVersion && version !== expectedVersion) throw new Error('Bundled Node version differs from its verification record.');
      return { ok: true, version, path: this.nodePath, sha256,
        message: sha256 ? 'Bundled Node runtime verified with SHA-256.' : 'Development Node runtime is available.' };
    } catch (error) { return { ok: false, version: null, message: message(error) }; }
  }

  async health({ ffmpegPath } = {}) {
    const [ytdlp, ffmpeg, node] = await Promise.all([
      this.#ytdlpHealth(), this.#ffmpegHealth(ffmpegPath),
      this.#nodeHealth(),
    ]);
    return { ytdlp, ffmpeg, node, lastCheck: this.lastCheck };
  }

  async resolvePaths(options = {}) {
    const result = await this.health(options);
    for (const kind of ['ytdlp', 'ffmpeg', 'node']) if (!result[kind].ok) throw new Error(`${kind}: ${result[kind].message}`);
    return { ytdlpPath: result.ytdlp.path, ytdlpSha256: result.ytdlp.sha256,
      ffmpegPath: result.ffmpeg.path, ffmpegSha256: result.ffmpeg.sha256, nodePath: this.nodePath, nodeSha256: result.node.sha256 };
  }

  async #latestRelease() {
    const buffer = await this.fetchBuffer(BINARY_SOURCES.ytdlpReleaseApi, { maxBytes: 2 * 1024 * 1024, timeoutMs: 30000 });
    const release = JSON.parse(buffer.toString('utf8'));
    if (!release || !VERSION.test(release.tag_name) || release.draft || release.prerelease || !Array.isArray(release.assets)) {
      throw new Error('Official yt-dlp release metadata was invalid.');
    }
    const executable = release.assets.find((asset) => asset.name === FILES.ytdlp);
    const checksum = release.assets.find((asset) => asset.name === 'SHA2-256SUMS');
    if (!executable || !checksum || !Number.isSafeInteger(executable.size) || executable.size < 1000000 || executable.size > 64 * 1024 * 1024) {
      throw new Error('Official release is missing expected yt-dlp assets.');
    }
    // Construct canonical URLs from the validated release tag. Do not consume
    // arbitrary asset URLs embedded in a remote JSON document.
    const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${release.tag_name}`;
    return { version: release.tag_name, size: executable.size, url: `${base}/yt-dlp.exe`, sums: `${base}/SHA2-256SUMS` };
  }

  async #latestFfmpeg() {
    const buffer = await this.fetchBuffer(BINARY_SOURCES.ffmpegReleaseApi, { maxBytes: 2 * 1024 * 1024, timeoutMs: 30000 });
    const release = JSON.parse(buffer.toString('utf8'));
    if (!release || !/^\d+\.\d+(?:\.\d+)?$/.test(release.tag_name) || release.draft || release.prerelease || !Array.isArray(release.assets)) {
      throw new Error('Official Gyan ffmpeg release metadata was invalid.');
    }
    const filename = `ffmpeg-${release.tag_name}-essentials_build.zip`;
    const asset = release.assets.find((item) => item.name === filename);
    if (!asset || !Number.isSafeInteger(asset.size) || asset.size < 1000000 || asset.size > 256 * 1024 * 1024 ||
        typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
      throw new Error('Official Gyan ffmpeg release is missing its ZIP asset or SHA-256 digest.');
    }
    const sha256 = asset.digest.slice(7);
    const publisherChecksum = `https://www.gyan.dev/ffmpeg/builds/packages/${filename}.sha256`;
    let publisher;
    try { publisher = await this.fetchBuffer(publisherChecksum, { maxBytes: 65536, timeoutMs: 15000 }); }
    catch {
      // Gyan occasionally returns 503/Retry-After for direct downloads. The
      // publisher's GitHub release also publishes the asset SHA-256, so an
      // unavailable mirror never turns checksum verification off.
      this.#notice('Gyan’s checksum mirror is unavailable. ffmpeg will be verified with the SHA-256 published by its official GitHub release.');
    }
    if (publisher && parsePublishedSha256(publisher.toString('utf8'), filename) !== sha256) {
      throw new Error('Gyan publisher checksum disagrees with the official GitHub release digest.');
    }
    return { version: release.tag_name, filename, sha256, size: asset.size, publisherChecksum,
      url: `https://github.com/GyanD/codexffmpeg/releases/download/${release.tag_name}/${filename}` };
  }

  async #replaceVerified(kind, staged, record) {
    // Downloads may overlap, but the final executable/verification-record
    // transaction must read and update the latest shared metadata serially.
    return this.#metadataOperation(async () => {
    const current = join(this.binDir, FILES[kind]);
    const backup = join(this.binDir, `.backup-${kind}-${randomUUID()}.exe`);
    const metadata = await this.#metadata();
    let backedUp = false;
    let replaced = false;
    try {
      if (metadata[kind] && await isFile(current)) {
        try {
          await verifyChecksum(current, metadata[kind].sha256);
          await copyFile(current, backup, constants.COPYFILE_EXCL);
          backedUp = true;
        } catch (error) {
          if (error.code && error.code !== 'ENOENT') throw error;
          this.#notice(`The old managed ${kind} failed verification and cannot be used as a rollback copy.`);
        }
      }
      await verifyChecksum(staged, record.sha256);
      await chmod(staged, 0o700);
      await rename(staged, current);
      replaced = true;
      // Verify again at the final path and run the executable only afterward.
      await verifyChecksum(current, record.sha256);
      const version = await this.#version(kind, current);
      if (version !== record.version) throw new Error('Installed binary version differs from the verified download.');
      await this.#saveMetadata({ ...metadata, [kind]: { ...record, file: FILES[kind], installedAt: new Date().toISOString() } });
      return { ok: true, version, path: current, sha256: record.sha256, message: 'Downloaded and verified successfully.' };
    } catch (error) {
      if (replaced) {
        if (backedUp) {
          await verifyChecksum(backup, metadata[kind].sha256);
          await rename(backup, current);
          await verifyChecksum(current, metadata[kind].sha256);
        } else {
          await rm(current, { force: true });
        }
      }
      throw error;
    } finally { await rm(backup, { force: true }); }
    });
  }

  async #downloadYtdlp() {
    await mkdir(this.binDir, { recursive: true });
    const temporary = join(this.binDir, `.download-ytdlp-${randomUUID()}.exe`);
    try {
      this.#progress('ytdlp', 'checking');
      const release = await this.#latestRelease();
      const sums = await this.fetchBuffer(release.sums, { maxBytes: 1024 * 1024, timeoutMs: 30000 });
      const sha256 = parseSha256Manifest(sums.toString('utf8'), FILES.ytdlp);
      this.#progress('ytdlp', 'downloading', { version: release.version });
      const download = await this.fetchFile(release.url, temporary, {
        maxBytes: 64 * 1024 * 1024, timeoutMs: 180000,
        onProgress: (progress) => this.#progress('ytdlp', 'downloading', progress),
      });
      if (download.bytes !== release.size) throw new Error('yt-dlp download size differs from its release metadata.');
      this.#progress('ytdlp', 'verifying');
      await verifyChecksum(temporary, sha256);
      await chmod(temporary, 0o700);
      const version = await this.#version('ytdlp', temporary);
      if (version !== release.version) throw new Error('yt-dlp download does not report the expected release version.');
      const installed = await this.#replaceVerified('ytdlp', temporary, { version, sha256, source: release.url });
      this.#progress('ytdlp', 'complete', { version });
      return installed;
    } catch (error) {
      this.#progress('ytdlp', 'error', { message: message(error) });
      throw error;
    } finally { await rm(temporary, { force: true }); }
  }

  ensureYtdlp() {
    return this.#operation('ytdlp', async () => {
      const current = await this.#ytdlpHealth();
      return current.ok ? current : this.#downloadYtdlp();
    });
  }

  updateYtdlp() { return this.#operation('ytdlp', () => this.#downloadYtdlp()); }

  importYtdlp(filePath) {
    return this.#operation('ytdlp', async () => {
      if (typeof filePath !== 'string' || !isAbsolute(filePath)) throw new Error('Select an absolute yt-dlp executable path.');
      await mkdir(this.binDir, { recursive: true });
      const staged = join(this.binDir, `.import-ytdlp-${randomUUID()}.exe`);
      try {
        this.#progress('ytdlp', 'importing');
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 64 * 1024 * 1024) {
          throw new Error('Select a regular yt-dlp executable smaller than 64 MiB.');
        }
        await copyFile(filePath, staged, constants.COPYFILE_EXCL);
        if ((await stat(staged)).size > 64 * 1024 * 1024) throw new Error('Selected yt-dlp executable exceeds the size limit.');
        this.#progress('ytdlp', 'verifying');
        const actual = await hashFile(staged);
        const saved = (await this.#metadata()).ytdlp;
        let record;
        if (saved && VERSION.test(saved.version) && actual === saved.sha256 &&
            saved.source === `https://github.com/yt-dlp/yt-dlp/releases/download/${saved.version}/yt-dlp.exe`) {
          // An already verified release can be restored even during an outage.
          record = { version: saved.version, sha256: saved.sha256, source: saved.source };
        } else {
          let release;
          let sums;
          try {
            release = await this.#latestRelease();
            sums = await this.fetchBuffer(release.sums, { maxBytes: 1024 * 1024, timeoutMs: 30000 });
          } catch (error) {
            throw new Error(`Cannot verify the selected yt-dlp file without its official release checksum. Connect to GitHub and retry. ${message(error)}`);
          }
          const sha256 = parseSha256Manifest(sums.toString('utf8'), FILES.ytdlp);
          if (actual !== sha256) throw new Error('Selected yt-dlp does not match the latest official release or a saved verified release. Download the official yt-dlp.exe and try again.');
          record = { version: release.version, sha256, source: release.url };
        }
        await verifyChecksum(staged, record.sha256);
        await chmod(staged, 0o700);
        if (await this.#version('ytdlp', staged) !== record.version) throw new Error('Selected yt-dlp does not report the verified release version.');
        const result = await this.#replaceVerified('ytdlp', staged, record);
        this.#progress('ytdlp', 'complete', { version: result.version });
        return result;
      } catch (error) {
        this.#progress('ytdlp', 'error', { message: message(error) });
        throw error;
      } finally { await rm(staged, { force: true }); }
    });
  }

  async ensureEssentials({ ffmpegPath } = {}) {
    const outcomes = await Promise.allSettled([
      this.ensureYtdlp(),
      (async () => {
        const existing = await this.#ffmpegHealth(ffmpegPath);
        if (existing.ok) return existing;
        const path = await this.installFfmpeg();
        const installed = await this.#ffmpegHealth(path);
        if (!installed.ok) throw new Error(installed.message);
        return installed;
      })(),
    ]);
    const [ytdlp, ffmpeg] = outcomes.map((result) => result.status === 'fulfilled' ? result.value :
      { ok: false, version: null, message: message(result.reason) });
    return { ytdlp, ffmpeg, ffmpegPath: ffmpeg.ok ? ffmpeg.path : undefined };
  }

  installFfmpeg() {
    return this.#operation('ffmpeg', async () => {
      await mkdir(this.binDir, { recursive: true });
      const archive = join(this.binDir, `.download-ffmpeg-${randomUUID()}.zip`);
      const executable = join(this.binDir, `.download-ffmpeg-${randomUUID()}.exe`);
      try {
        this.#progress('ffmpeg', 'checking', { source: BINARY_SOURCES.ffmpeg });
        const release = await this.#latestFfmpeg();
        const archiveSha256 = release.sha256;
        const download = await this.fetchFile(release.url, archive, {
          maxBytes: 256 * 1024 * 1024, timeoutMs: 600000,
          onProgress: (progress) => this.#progress('ffmpeg', 'downloading', progress),
        });
        if (download.bytes !== release.size) throw new Error('ffmpeg download size differs from its release metadata.');
        this.#progress('ffmpeg', 'verifying');
        await verifyChecksum(archive, archiveSha256);
        this.#progress('ffmpeg', 'extracting');
        await extractZipExecutable(archive, executable);
        const sha256 = await hashFile(executable);
        await verifyChecksum(executable, sha256);
        const version = await this.#version('ffmpeg', executable);
        if (!version.startsWith(`${release.version}-`) && version !== release.version) throw new Error('ffmpeg download does not report the expected release version.');
        const installed = await this.#replaceVerified('ffmpeg', executable, { version, sha256, archiveSha256, source: release.url, publisherChecksum: release.publisherChecksum });
        this.#progress('ffmpeg', 'complete', { version });
        return installed.path;
      } catch (error) {
        this.#progress('ffmpeg', 'error', { message: message(error) });
        throw error;
      } finally {
        await rm(archive, { force: true });
        await rm(executable, { force: true });
      }
    });
  }

  async checkForUpdates({ force = false } = {}) {
    const metadata = await this.#metadata();
    const previous = metadata.updateCheck;
    if (!force && previous && typeof previous.lastCheck === 'string' &&
        VERSION.test(previous.latestVersion) && Date.now() - Date.parse(previous.lastCheck) < ONE_DAY) {
      this.lastCheck = previous.lastCheck;
      return { ...previous, installedVersion: metadata.ytdlp?.version || null,
        updateAvailable: previous.latestVersion !== metadata.ytdlp?.version };
    }
    return this.#operation('updates', async () => {
      const release = await this.#latestRelease();
      return this.#metadataOperation(async () => {
      const current = await this.#metadata();
      this.lastCheck = new Date().toISOString();
      const result = { lastCheck: this.lastCheck, latestVersion: release.version,
        installedVersion: current.ytdlp?.version || null, updateAvailable: release.version !== current.ytdlp?.version };
      await this.#saveMetadata({ ...current, updateCheck: { lastCheck: result.lastCheck, latestVersion: result.latestVersion } });
      return result;
      });
    });
  }
}
