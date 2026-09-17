import { command, control } from '../util/commands.js';
import { reply } from '../util/replies.js';

export const data = command('stop', 'Stop playback, cancel loading requests, clear the queue and disconnect');
export async function execute(interaction, context) {
  await control(interaction, context, (player) => player.reset('stop command'));
  await reply(interaction, 'Stopped, cleared the queue and disconnected.');
}
