import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ALLOWED_HOSTS, validateAllowedHosts } from '../src/util/validation.js';
import { CONFIG_LIMITS } from '../src/util/config.js';

export const SCHEMA_VERSION = 1;
export const defaults = Object.freeze({
  schemaVersion: SCHEMA_VERSION, guildId: '', idleTimeoutSeconds: 300,
  maxQueue: 200, defaultVolume: 0.5, ffmpegPath: '', allowedHosts: [...DEFAULT_ALLOWED_HOSTS],
  autoUpdateYtdlp: true, startWithWindows: false, startMinimized: false,
  closeToTray: true, setupComplete: false, identity: null, lastUpdateCheck: null,
  window: { width: 1240, height: 860 },
});
const editable = new Set(['guildId', 'idleTimeoutSeconds', 'maxQueue', 'defaultVolume', 'ffmpegPath',
  'allowedHosts', 'autoUpdateYtdlp', 'startWithWindows', 'startMinimized', 'closeToTray']);

export function validateSettingsPatch(patch) {
  if (!patch || Object.getPrototypeOf(patch) !== Object.prototype) throw new Error('Settings must be an object.');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!editable.has(key)) throw new Error(`Unknown setting: ${key}`);
    if (key in CONFIG_LIMITS) {
      const [min, max] = CONFIG_LIMITS[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
        || (key !== 'defaultVolume' && !Number.isInteger(value))) throw new Error(`${key} must be ${min}–${max}${key === 'defaultVolume' ? '' : ' (whole numbers)'}.`);
      result[key] = value;
    } else if (key === 'allowedHosts') result[key] = validateAllowedHosts(value);
    else if (key === 'guildId') {
      if (typeof value !== 'string' || (value !== '' && !/^\d{17,20}$/.test(value))) throw new Error('Choose a valid Discord server.');
      result[key] = value;
    } else if (key === 'ffmpegPath') {
      if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f]/.test(value)) throw new Error('Choose a valid ffmpeg executable path.');
      result[key] = value.trim();
    } else {
      if (typeof value !== 'boolean') throw new Error(`${key} must be true or false.`);
      result[key] = value;
    }
  }
  return result;
}

export function migrateSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings file must contain an object.');
  if ((raw.schemaVersion ?? 0) > SCHEMA_VERSION) throw new Error('Settings were created by a newer app version.');
  const patch = {};
  for (const key of editable) if (Object.hasOwn(raw, key)) patch[key] = raw[key];
  const settings = { ...structuredClone(defaults), ...validateSettingsPatch(patch) };
  settings.setupComplete = raw.setupComplete === true && Boolean(settings.guildId);
  if (raw.identity && /^\d{17,20}$/.test(raw.identity.applicationId) && /^\d{17,20}$/.test(raw.identity.botId)) {
    settings.identity = { applicationId: raw.identity.applicationId, botId: raw.identity.botId,
      name: String(raw.identity.name || 'Discord bot').slice(0, 100),
      avatar: typeof raw.identity.avatar === 'string' && raw.identity.avatar.startsWith('https://cdn.discordapp.com/') ? raw.identity.avatar : null };
  }
  if (typeof raw.lastUpdateCheck === 'string' && Number.isFinite(Date.parse(raw.lastUpdateCheck))) settings.lastUpdateCheck = raw.lastUpdateCheck;
  if (raw.window && Number.isInteger(raw.window.width) && Number.isInteger(raw.window.height)) {
    settings.window = { width: Math.max(980, Math.min(3000, raw.window.width)), height: Math.max(680, Math.min(2000, raw.window.height)) };
    if (Number.isInteger(raw.window.x) && Number.isInteger(raw.window.y)) Object.assign(settings.window, { x: raw.window.x, y: raw.window.y });
  }
  return settings;
}

export class SettingsStore {
  constructor(directory, notice = () => {}) { this.directory = directory; this.path = join(directory, 'settings.json'); this.notice = notice; this.value = structuredClone(defaults); this.writes = Promise.resolve(); }
  async load() {
    try { this.value = migrateSettings(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) {
      this.value = structuredClone(defaults);
      if (error.code !== 'ENOENT') this.notice('Settings could not be read. Safe defaults were restored; run setup again.');
    }
    return this.snapshot();
  }
  snapshot() { return structuredClone(this.value); }
  async update(patch) { return this.persist({ ...this.value, ...validateSettingsPatch(patch) }); }
  async internal(patch) { return this.persist(migrateSettings({ ...this.value, ...patch })); }
  async persist(value) {
    const next = structuredClone(value);
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, this.path);
      this.value = next;
    });
    await this.writes;
    return this.snapshot();
  }
}
