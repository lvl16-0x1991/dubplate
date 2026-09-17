import { isIP } from 'node:net';
import { ChannelType } from 'discord.js';

export class UserError extends Error {}

export const DEFAULT_ALLOWED_HOSTS = Object.freeze(['youtube.com', 'youtu.be', 'music.youtube.com', 'soundcloud.com', 'bandcamp.com']);

export function validateAllowedHosts(hosts = DEFAULT_ALLOWED_HOSTS) {
  if (!Array.isArray(hosts) || !hosts.length || hosts.length > 100) throw new UserError('The host allowlist must contain 1–100 domain names.');
  return [...new Set(hosts.map((value) => {
    if (typeof value !== 'string' || value.length > 253) throw new UserError('Allowlist entries must be domain names.');
    const host = value.trim().toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
      || isIP(host) || /(?:^|\.)(?:localhost|local|invalid|test)$/.test(host)) {
      throw new UserError(`Invalid allowlisted domain: ${host}. Enter a public hostname without a scheme, path, port or wildcard.`);
    }
    // WHATWG URL canonicalization recognizes decimal, hexadecimal and shortened IPv4.
    const canonical = new URL(`https://${host}`).hostname;
    if (isIP(canonical) || canonical !== host) throw new UserError(`Invalid allowlisted domain: ${host}.`);
    return host;
  }))];
}

export function requireAllowedUrl(input, allowedHosts = DEFAULT_ALLOWED_HOSTS) {
  if (typeof input !== 'string' || !/^https?:\/\/[^/?#\\]+/i.test(input.trim()) || input.includes('\\')) throw new UserError('Enter a valid HTTP(S) URL.');
  const authority = input.trim().match(/^https?:\/\/([^/?#\\]+)/i)[1];
  if (authority.includes('@')) throw new UserError('URLs containing a username or password are not allowed.');
  const url = requireWebUrl(input);
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.username || parsed.password) throw new UserError('URLs containing a username or password are not allowed.');
  if (parsed.port) throw new UserError('URLs must use the default HTTP or HTTPS port.');
  if (isIP(hostname.replace(/^\[|\]$/g, '')) || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new UserError('IP addresses and localhost are not allowed.');
  }
  const hosts = validateAllowedHosts(allowedHosts);
  if (!hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
    throw new UserError(`The host ${hostname} is not in the allowed music hosts. Update the host allowlist in Settings if this source is trusted.`);
  }
  return parsed.href;
}

export function httpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

export function normalizeQuery(input, allowedHosts = DEFAULT_ALLOWED_HOSTS) {
  if (typeof input !== 'string' || !input.trim()) throw new UserError('Enter a search phrase or an HTTP(S) URL.');
  if (input.length > 500) throw new UserError('Queries must be 500 characters or fewer.');
  const query = input.trim();
  // Prefix EVERY non-web input, including local paths, file: URLs and option-like input.
  // None of those strings can become an extractor option or a local-file input.
  const url = httpUrl(query);
  if (url) return requireAllowedUrl(query, allowedHosts);
  if (/^https?:/i.test(query)) throw new UserError('Enter a valid HTTP(S) URL.');
  return `ytsearch1:${query}`;
}

export function requireWebUrl(input) {
  const result = httpUrl(input);
  if (!result) throw new UserError('This track did not provide a playable HTTP(S) URL.');
  return result;
}

export function callerChannel(interaction, player) {
  if (!interaction.guild) throw new UserError('Use this command in the configured server.');
  const state = interaction.guild.voiceStates.cache.get(interaction.user.id);
  const channel = state?.channel;
  if (!channel) throw new UserError('Join a voice channel first.');
  if (channel.type === ChannelType.GuildStageVoice) throw new UserError('Use a regular voice channel; stage channels are not supported.');
  if (player?.channelId && player.channelId !== channel.id) {
    throw new UserError('Join the same voice channel as the bot to control playback.');
  }
  return channel;
}

export function requireTrack(player) {
  if (!player?.current) throw new UserError('Nothing is playing.');
  return player.current;
}
