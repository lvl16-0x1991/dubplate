import { command, control } from '../util/commands.js';
import { requireTrack } from '../util/validation.js';
import { reply } from '../util/replies.js';
import { safeText } from '../util/format.js';

export const data = command('skip', 'Skip the current track, including when looping');
export async function execute(interaction, context) {
  const title = await control(interaction, context, async (player) => {
    const track = requireTrack(player);
    await player.finish(player.playToken, 'skipped');
    return track.title;
  });
  await reply(interaction, `Skipped **${safeText(title)}**.`);
}
