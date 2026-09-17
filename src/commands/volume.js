import { command, control } from '../util/commands.js';
import { reply } from '../util/replies.js';

export const data = command('volume', 'Set playback volume (0–150%)')
  .addIntegerOption((option) => option.setName('percent').setDescription('Volume percentage').setRequired(true).setMinValue(0).setMaxValue(150));
export async function execute(interaction, context) {
  const percent = interaction.options.getInteger('percent', true);
  await control(interaction, context, (player) => player.setVolume(percent));
  await reply(interaction, `Volume: ${percent}%.`);
}
