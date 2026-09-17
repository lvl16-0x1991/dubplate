import { EmbedBuilder, escapeMarkdown } from 'discord.js';

export const allowedMentions = Object.freeze({ parse: [], repliedUser: false });

export function safeText(value, maxLength = 180) {
  const cleaned = String(value ?? 'Unknown title')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replaceAll('@', '@\u200b').replaceAll('<', '‹').replaceAll('>', '›');
  const escaped = escapeMarkdown(cleaned);
  return escaped.length > maxLength ? `${escaped.slice(0, maxLength - 1).replace(/\\+$/, '')}…` : escaped;
}

export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown/live';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export function nowPlayingText(player) {
  if (!player?.current) return 'Nothing is playing.';
  return `**${safeText(player.current.title)}**\n${duration(player.elapsed)} / ${duration(player.current.duration)} · ${player.statusLabel}`;
}

export function queueEmbed(player, requestedPage = 1) {
  const queue = player?.queue ?? [];
  const pages = Math.max(1, Math.ceil(queue.length / 10));
  const page = Math.min(Math.max(1, requestedPage), pages);
  const rows = queue.slice((page - 1) * 10, page * 10)
    .map((track, index) => `${(page - 1) * 10 + index + 1}. ${safeText(track.title)} — ${duration(track.duration)}`);
  return {
    page,
    pages,
    embed: new EmbedBuilder().setColor(0x5865f2).setTitle('Music queue')
      .setDescription(`${nowPlayingText(player)}\n\n${rows.join('\n') || 'The queue is empty.'}`)
      .setFooter({ text: `Page ${page}/${pages} · ${queue.length} queued · Loop: ${player?.loop ?? 'off'} · Volume: ${Math.round((player?.volume ?? 0.5) * 100)}%` }),
  };
}
