import { command, control } from '../util/commands.js';
import { reply } from '../util/replies.js';

export const data = command('loop', 'Set the repeat mode')
  .addStringOption((option) => option.setName('mode').setDescription('What to repeat').setRequired(true)
    .addChoices({ name: 'Off', value: 'off' }, { name: 'Current track', value: 'track' }, { name: 'Queue', value: 'queue' }));
export async function execute(interaction, context) {
  const mode = interaction.options.getString('mode', true);
  await control(interaction, context, (player) => player.setLoop(mode));
  await reply(interaction, `Loop mode: ${mode}.`);
}
