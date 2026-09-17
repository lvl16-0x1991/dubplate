import { setLogSecret } from './log.js';
import { DEFAULT_ALLOWED_HOSTS, validateAllowedHosts } from './validation.js';

export const CONFIG_LIMITS = Object.freeze({ idleTimeoutSeconds: [1, 86400], maxQueue: [1, 10000], defaultVolume: [0, 1.5] });

export function validateConfig(input, { requireCredentials = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Bot configuration must be an object.');
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (token) setLogSecret(token);
  const guildId = typeof input.guildId === 'string' ? input.guildId.trim() : '';
  if (requireCredentials && !token) throw new Error('DISCORD_TOKEN is missing. Enter your bot token in Setup or configure the headless environment.');
  if (requireCredentials && !guildId) throw new Error('GUILD_ID is missing. Choose a server in Setup or configure the headless environment.');
  if (guildId && !/^\d{17,20}$/.test(guildId)) throw new Error('GUILD_ID must be a Discord server ID (17–20 digits).');
  const config = { token, guildId, idleTimeoutSeconds: 300, maxQueue: 200, defaultVolume: 0.5 };
  for (const [name, [min, max]] of Object.entries(CONFIG_LIMITS)) {
    const value = input[name] ?? config[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (name !== 'defaultVolume' && !Number.isInteger(value))) {
      throw new Error(`${name} must be ${name === 'defaultVolume' ? 'a number' : 'an integer'} between ${min} and ${max}.`);
    }
    config[name] = value;
  }
  for (const [name, fallback] of Object.entries({ ffmpegPath: 'ffmpeg', ytdlpPath: 'yt-dlp', nodePath: process.execPath })) {
    const value = input[name] ?? fallback;
    if (typeof value !== 'string' || !value.trim() || value.length > 32767 || /[\u0000-\u001f]/.test(value)) throw new Error(`${name} must be an executable path without control characters.`);
    config[name] = value.trim();
  }
  for (const name of ['ytdlpSha256', 'ffmpegSha256', 'nodeSha256']) {
    if (input[name] !== undefined && input[name] !== null && input[name] !== '') {
      if (typeof input[name] !== 'string' || !/^[a-f0-9]{64}$/i.test(input[name])) throw new Error(`${name} must be a SHA256 checksum.`);
      config[name] = input[name].toLowerCase();
    }
  }
  if (input.voiceTestTonePath !== undefined) {
    if (typeof input.voiceTestTonePath !== 'string' || !input.voiceTestTonePath.trim() || /[\u0000-\u001f]/.test(input.voiceTestTonePath)) throw new Error('voiceTestTonePath must be a valid bundled asset path.');
    config.voiceTestTonePath = input.voiceTestTonePath.trim();
  }
  config.allowedHosts = Object.freeze(validateAllowedHosts(input.allowedHosts ?? DEFAULT_ALLOWED_HOSTS));
  return Object.freeze(config);
}

function number(env, name, fallback, min, max, integer = false) {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  }
  return value;
}

export function loadConfig(env = {}) {
  const token = env.DISCORD_TOKEN?.trim();
  setLogSecret(token);
  if (!token) throw new Error('DISCORD_TOKEN is missing. Copy .env.example to .env and set your bot token.');
  const guildId = env.GUILD_ID?.trim();
  if (!guildId) throw new Error('GUILD_ID is missing. Set your server ID in .env.');
  if (!/^\d{17,20}$/.test(guildId)) throw new Error('GUILD_ID must be a Discord server ID (17–20 digits).');
  return validateConfig({
    token,
    guildId,
    ffmpegPath: env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ytdlpPath: env.YT_DLP_PATH?.trim() || 'yt-dlp',
    nodePath: env.NODE_RUNTIME_PATH?.trim() || process.execPath,
    allowedHosts: env.ALLOWED_HOSTS?.trim() ? env.ALLOWED_HOSTS.split(',').map((host) => host.trim()) : DEFAULT_ALLOWED_HOSTS,
    idleTimeoutSeconds: number(env, 'IDLE_TIMEOUT_SECONDS', 300, 1, 86400, true),
    maxQueue: number(env, 'MAX_QUEUE', 200, 1, 10000, true),
    defaultVolume: number(env, 'DEFAULT_VOLUME', 0.5, 0, 1.5),
  });
}
