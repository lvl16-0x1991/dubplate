import { SlashCommandBuilder } from 'discord.js';
import { callerChannel } from './validation.js';

export function command(name, description) {
  return new SlashCommandBuilder().setName(name).setDescription(description);
}

export async function control(interaction, context, operation) {
  const player = context.playerFor(interaction.guild);
  return player.exclusive(async () => {
    callerChannel(interaction, player);
    return operation(player);
  });
}
