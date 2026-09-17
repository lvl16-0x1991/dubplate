import { EmbedBuilder } from 'discord.js';
import { command } from '../util/commands.js';
import { nowPlayingText } from '../util/format.js';
import { reply } from '../util/replies.js';

export const data = command('nowplaying', 'Show the current track and playback position');
export async function execute(interaction, context) {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Now playing')
    .setDescription(nowPlayingText(context.players.get(interaction.guildId)));
  await reply(interaction, { embeds: [embed] });
}
