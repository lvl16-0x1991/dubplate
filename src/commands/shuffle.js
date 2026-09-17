import { command, control } from '../util/commands.js';
import { reply } from '../util/replies.js';

export const data = command('shuffle', 'Shuffle the upcoming tracks');
export async function execute(interaction, context) {
  await control(interaction, context, (player) => player.shuffle());
  await reply(interaction, 'Shuffled the queue.');
}
