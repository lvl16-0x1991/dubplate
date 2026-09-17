import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export function createRedactor() {
  const secrets = new Set();
  const redact = (input) => {
    let text = String(input ?? '');
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[REDACTED]');
    return text.replace(/(?:mfa\.[\w-]{40,}|[\w-]{23,30}\.[\w-]{6}\.[\w-]{25,110})/g, '[REDACTED]')
      .replace(/((?:authorization|discord_token|access_token|token)\s*[=:]\s*)(?:Bot\s+|Bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
  };
  redact.add = (value) => { if (typeof value === 'string' && value) secrets.add(value); };
  return redact;
}

export class LogStore {
  constructor(directory, emit = () => {}) { this.directory = directory; this.emit = emit; this.redact = createRedactor(); this.ring = []; this.pending = Promise.resolve(); this.counter = 0; this.maxSize = 1024 * 1024; this.maxFiles = 28; }
  addSecret(token) { this.redact.add(token); }
  write(entry) {
    const clean = { timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
      level: ['info', 'warn', 'error', 'debug'].includes(String(entry.level).toLowerCase()) ? String(entry.level).toLowerCase() : 'info',
      message: this.redact(entry.message ?? entry).slice(0, 12000) };
    this.ring.push(clean);
    if (this.ring.length > 1500) this.ring.shift();
    this.emit({ type: 'log', payload: clean });
    this.pending = this.pending.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      const line = `${JSON.stringify(clean)}\n`;
      let filename = join(this.directory, `${new Date().toISOString().slice(0, 10)}-${this.counter}.log`);
      while ((await stat(filename).catch(() => ({ size: 0 }))).size + Buffer.byteLength(line) > this.maxSize) {
        filename = join(this.directory, `${new Date().toISOString().slice(0, 10)}-${++this.counter}.log`);
      }
      await appendFile(filename, line, { mode: 0o600 });
      await this.prune();
    }).catch(() => { this.emit({ type: 'notice', payload: 'Log files could not be written. The live log remains available.' }); });
    return clean;
  }
  async prune() {
    const files = [];
    for (const name of await readdir(this.directory)) if (/^\d{4}-\d{2}-\d{2}-\d+\.log$/.test(name)) {
      const path = join(this.directory, name); const info = await stat(path); files.push({ path, time: info.mtimeMs });
    }
    files.sort((a, b) => b.time - a.time);
    for (const [index, file] of files.entries()) if (index >= this.maxFiles || file.time < Date.now() - 7 * 86400000) await unlink(file.path);
  }
  snapshot() { return this.ring.map((entry) => ({ ...entry })); }
  async flush() { await this.pending; }
}
