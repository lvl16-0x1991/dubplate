import { MessageFlags } from 'discord.js';
import { allowedMentions, safeText } from './format.js';
import { log } from './log.js';
import { UserError } from './validation.js';

export function reply(interaction, payload) {
  const options = typeof payload === 'string' ? { content: payload } : payload;
  return interaction.editReply({ ...options, allowedMentions });
}

export async function replyError(interaction, error) {
  const content = error instanceof UserError ? safeText(error.message, 1800)
    : 'Something went wrong. Please try again; the details were logged on the bot host.';
  try {
    if (interaction.deferred || interaction.replied) await reply(interaction, { content, embeds: [], components: [] });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions });
  } catch (sendError) {
    log.error('Could not deliver interaction error (interaction may have expired)', sendError);
  }
}
