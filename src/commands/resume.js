import { command, control } from '../util/commands.js';
import { reply } from '../util/replies.js';

export const data = command('resume', 'Resume paused playback');
export async function execute(interaction, context) {
  await control(interaction, context, (player) => player.resume());
  await reply(interaction, 'Resumed.');
}
