import { PermissionFlagsBits } from 'discord.js';

export function voiceChannelProblems(channel, guild) {
  const permissions = channel.permissionsFor(guild.members.me);
  const required = [[PermissionFlagsBits.ViewChannel, 'View Channel'], [PermissionFlagsBits.Connect, 'Connect'], [PermissionFlagsBits.Speak, 'Speak']];
  const missingPermissions = required.filter(([flag]) => !permissions?.has(flag)).map(([, name]) => name);
  const memberCount = channel.members?.size ?? guild.voiceStates.cache.filter((state) => state.channelId === channel.id).size;
  const alreadyPresent = guild.voiceStates.cache.get(guild.client.user.id)?.channelId === channel.id;
  const full = Boolean(channel.userLimit > 0 && memberCount >= channel.userLimit && !alreadyPresent && !permissions?.has(PermissionFlagsBits.MoveMembers));
  return { missingPermissions, full };
}
