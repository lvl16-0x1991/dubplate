import { command, control } from '../util/commands.js';
import { reply } from '../util/replies.js';
import { duration } from '../util/format.js';

export const data = command('seek', 'Restart the current track at a time in seconds')
  .addIntegerOption((option) => option.setName('seconds').setDescription('Absolute position in seconds').setRequired(true).setMinValue(0).setMaxValue(2147483647));
export async function execute(interaction, context) {
  const seconds = interaction.options.getInteger('seconds', true);
  await control(interaction, context, (player) => player.seek(seconds));
  await reply(interaction, `Seeking to ${duration(seconds)}. Large seeks may take a moment to buffer.`);
}
