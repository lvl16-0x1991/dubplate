import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { command } from '../util/commands.js';
import { queueEmbed } from '../util/format.js';
import { reply } from '../util/replies.js';
import { UserError } from '../util/validation.js';

export const data = command('queue', 'Show the queue, 10 tracks per page')
  .addIntegerOption((option) => option.setName('page').setDescription('Page number').setMinValue(1));

function payload(player, page, userId) {
  const result = queueEmbed(player, page);
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`queue:${userId}:${Math.max(1, result.page - 1)}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(result.page <= 1),
    new ButtonBuilder().setCustomId(`queue:${userId}:${result.page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(result.page >= result.pages),
  );
  return { embeds: [result.embed], components: [buttons] };
}

export async function execute(interaction, context) {
  await reply(interaction, payload(context.players.get(interaction.guildId), interaction.options.getInteger('page') ?? 1, interaction.user.id));
}

export async function handleButton(interaction, context) {
  const [, userId, rawPage] = interaction.customId.split(':');
  const page = Number(rawPage);
  if (userId !== interaction.user.id || !Number.isSafeInteger(page) || page < 1) throw new UserError('Open your own queue with /queue.');
  await reply(interaction, payload(context.players.get(interaction.guildId), page, userId));
}
