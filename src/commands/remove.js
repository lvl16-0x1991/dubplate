import { command, control } from '../util/commands.js';
import { reply } from '../util/replies.js';
import { safeText } from '../util/format.js';

export const data = command('remove', 'Remove a queued track by its position')
  .addIntegerOption((option) => option.setName('position').setDescription('Position from /queue (1-based)').setRequired(true).setMinValue(1));
export async function execute(interaction, context) {
  const track = await control(interaction, context, (player) => player.remove(interaction.options.getInteger('position', true)));
  await reply(interaction, `Removed **${safeText(track.title)}**.`);
}
