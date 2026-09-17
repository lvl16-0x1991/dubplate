import { command, control } from '../util/commands.js';
import { reply } from '../util/replies.js';

export const data = command('clear', 'Clear upcoming tracks, keeping the current track');
export async function execute(interaction, context) {
  const count = await control(interaction, context, (player) => player.clear());
  await reply(interaction, `Cleared ${count} queued track${count === 1 ? '' : 's'}.`);
}
