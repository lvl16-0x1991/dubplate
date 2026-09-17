import { validateSettingsPatch } from './settings.js';

const noArgs = new Set(['bootstrap', 'listGuilds', 'startBot', 'stopBot', 'restartBot', 'healthCheck', 'updateYtdlp', 'installFfmpeg', 'chooseFfmpeg', 'chooseYtdlp', 'importEnv', 'deleteImportedEnv', 'copyInvite', 'openLogFolder', 'resetData', 'rerunSetup', 'prepareSetup', 'pasteToken', 'beginGuildDiscovery', 'listVoiceChannels']);
const emptyActions = new Set(['pause', 'resume', 'skip', 'stop', 'disconnect', 'shuffle', 'clear']);
function object(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Invalid request arguments.');
}
function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}
function id(value) { if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) throw new Error('Invalid Discord ID.'); return value; }

export function validateTokenShape(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,160}$/.test(value)) {
    throw new Error('This does not look like a bot token. In the Developer Portal, open Bot and choose Reset Token, then copy the token.');
  }
  return value;
}

export function validateControl(value) {
  object(value, ['action', 'args']);
  const { action, args = {} } = value;
  if (typeof action !== 'string') throw new Error('Invalid player action.');
  if (emptyActions.has(action)) { object(args, []); return { action, args }; }
  if (action === 'add') {
    object(args, ['query', 'voiceChannelId']);
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 500 || args.query.includes('\0')) throw new Error('Enter a query of 1–500 characters.');
    if (args.voiceChannelId) id(args.voiceChannelId);
  } else if (action === 'seek') { object(args, ['seconds']); integer(args.seconds, 0, 2147483647, 'Seek'); }
  else if (action === 'volume') { object(args, ['percent']); integer(args.percent, 0, 150, 'Volume'); }
  else if (action === 'loop') { object(args, ['mode']); if (!['off', 'track', 'queue'].includes(args.mode)) throw new Error('Invalid loop mode.'); }
  else if (action === 'remove') { object(args, ['position']); integer(args.position, 1, 10000, 'Position'); }
  else if (action === 'reorder') { object(args, ['from', 'to']); integer(args.from, 1, 10000, 'From'); integer(args.to, 1, 10000, 'To'); }
  else throw new Error('Unknown player action.');
  return { action, args };
}

export function validateIpcArgs(method, args) {
  if (noArgs.has(method)) { if (args !== undefined && args !== null) throw new Error('This request takes no arguments.'); return undefined; }
  if (method === 'saveSettings') return validateSettingsPatch(args);
  if (method === 'validateToken' || method === 'replaceToken') {
    return validateTokenShape(args);
  }
  if (method === 'selectGuild') return id(args);
  if (method === 'testVoice') { object(args, ['voiceChannelId']); return { voiceChannelId: id(args.voiceChannelId) }; }
  if (method === 'control') return validateControl(args);
  if (method === 'finishSetup') { object(args, ['startWithWindows', 'startMinimized']); return validateSettingsPatch(args); }
  if (method === 'openExternal') { if (!['portal', 'invite', 'ytdlp', 'ffmpeg'].includes(args)) throw new Error('This external link is not allowed.'); return args; }
  if (method === 'copyLogs') { if (typeof args !== 'string' || args.length > 2 * 1024 * 1024) throw new Error('Log selection is too large.'); return args; }
  throw new Error('Unknown IPC method.');
}

export function validateSender(event, webContents, pageUrl) {
  if (!webContents || webContents.isDestroyed() || event.sender.id !== webContents.id
    || !event.senderFrame || event.senderFrame !== webContents.mainFrame
    || event.senderFrame.url !== pageUrl) throw new Error('Untrusted IPC sender.');
}

export function allowedExternalUrl(key, identity) {
  const links = { portal: 'https://discord.com/developers/applications', ytdlp: 'https://github.com/yt-dlp/yt-dlp/releases', ffmpeg: 'https://www.gyan.dev/ffmpeg/builds/' };
  if (key === 'invite') {
    id(identity?.applicationId);
    links.invite = `https://discord.com/oauth2/authorize?client_id=${identity.applicationId}&scope=bot%20applications.commands&permissions=3165184`;
  }
  const raw = links[key];
  if (!raw) throw new Error('Unknown external link.');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['discord.com', 'github.com', 'www.gyan.dev'].includes(url.hostname)) throw new Error('External link blocked.');
  return raw;
}
