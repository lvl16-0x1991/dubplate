import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Client, Guild, StageChannel, TextChannel, VoiceChannel } from 'discord.js';
import { GuildPlayer } from '../src/player/GuildPlayer.js';
import { callerChannel, normalizeQuery, UserError } from '../src/util/validation.js';

function channels(t) {
  const client = new Client({ intents: [] });
  t.after(() => client.destroy());
  const guild = new Guild(client, { id: '123456789012345678', name: 'Channel regression' });
  const voice = new VoiceChannel(guild, { id: '234567890123456789', name: 'Music', type: ChannelType.GuildVoice, bitrate: 64000, user_limit: 0 }, client);
  const stage = new StageChannel(guild, { id: '345678901234567890', name: 'Stage', type: ChannelType.GuildStageVoice, bitrate: 64000, user_limit: 0 }, client);
  const text = new TextChannel(guild, { id: '456789012345678901', name: 'chat', type: ChannelType.GuildText }, client);
  return { guild, voice, stage, text };
}

test('Discord controls accept a real voice channel and enforce the current bot channel', (t) => {
  const { guild, voice } = channels(t);
  const interaction = { guild, user: { id: 'human' } };
  guild.voiceStates.cache.set('human', { channel: voice });
  assert.equal(callerChannel(interaction, { channelId: voice.id }), voice);
  assert.throws(() => callerChannel(interaction, { channelId: 'another-channel' }), /same voice channel/);
});

test('Discord controls reject real stage channels with an actionable message', (t) => {
  const { guild, stage } = channels(t);
  guild.voiceStates.cache.set('human', { channel: stage });
  assert.throws(() => callerChannel({ guild, user: { id: 'human' } }),
    (error) => error instanceof UserError && /stage channels are not supported/.test(error.message));
});

test('desktop playback queues a track for a real Discord voice channel', async (t) => {
  const { guild, voice } = channels(t);
  const track = { title: 'Queued track', url: 'https://youtu.be/abcdefghijk' };
  const player = new GuildPlayer(guild, { defaultVolume: 0.5, maxQueue: 3, idleTimeoutSeconds: 300 }, {
    normalizeQuery,
    resolve: async () => ({ tracks: [track], capped: false }),
    prewarm: async () => ({}),
  });
  t.after(() => player.reset());
  player.connection = { state: { status: 'ready' }, joinConfig: { channelId: voice.id }, destroy() {} };
  player.current = { title: 'Already playing' };
  const result = await player.enqueueDesktop('next song', voice);
  assert.equal(result.count, 1);
  assert.equal(player.current.title, 'Already playing');
  assert.deepEqual(player.queue, [track]);
});

test('desktop playback rejects stage text and missing channels before resolving music', async (t) => {
  const { guild, stage, text } = channels(t);
  let resolutions = 0;
  const player = new GuildPlayer(guild, { defaultVolume: 0.5, maxQueue: 3 }, {
    normalizeQuery,
    resolve: async () => { resolutions++; return { tracks: [] }; },
  });
  t.after(() => player.reset());
  for (const channel of [stage, text, null]) {
    await assert.rejects(player.enqueueDesktop('next song', channel),
      (error) => error instanceof UserError && /regular voice channel/.test(error.message));
  }
  assert.equal(resolutions, 0);
  assert.equal(player.connection, null);
  assert.deepEqual(player.queue, []);
});
