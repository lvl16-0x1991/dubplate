import { command } from '../util/commands.js';
import { reply } from '../util/replies.js';
import { safeText } from '../util/format.js';

export const data = command('play', 'Queue a search, track URL, or playlist URL')
  .addStringOption((option) => option.setName('query').setDescription('Search phrase or HTTP(S) URL').setRequired(true).setMaxLength(500));

export async function execute(interaction, context) {
  // The router has already deferred immediately, before validation or I/O.
  const result = await context.playerFor(interaction.guild).enqueueQuery(interaction, interaction.options.getString('query', true));
  await reply(interaction, `Added ${result.count} track${result.count === 1 ? '' : 's'}${result.count === 1 ? `: **${safeText(result.first.title)}**` : '.'}${result.capped ? ' This request reached the available queue capacity.' : ''}`);
}
