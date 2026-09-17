import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { BotCore } from '../src/core/BotCore.js';
import { GuildPlayer } from '../src/player/GuildPlayer.js';
import { voiceChannelProblems } from '../src/player/voiceChecks.js';
import { startVoiceTestPipeline } from '../src/player/ytdlp.js';
import { activeProcessIds, setProcessSink, stopAllProcesses } from '../src/player/processes.js';

const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
function fixture(permissions = required) {
  const channel = { id: '234567890123456789', name: 'Listening room', type: ChannelType.GuildVoice, position: 0,
    userLimit: 0, members: new Collection(), permissionsFor: () => new PermissionsBitField(permissions),
    isVoiceBased: () => true, isStageVoice: () => false };
  const guild = { id: '123456789012345678', name: 'Test server', icon: null, members: { me: {} },
    voiceStates: { cache: new Collection([['human', { id: 'human', channelId: channel.id, member: { user: { bot: false } } }]]) },
    channels: { cache: new Collection([[channel.id, channel]]) }, client: { user: { id: 'bot' } } };
  return { guild, channel };
}
function wave() {
  const samples = 48000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(3000 * Math.sin(index * 2 * Math.PI * 523.25 / 48000)), 44 + index * 2);
  return bytes;
}

test('voice checks report exact effective missing permissions and distinguish full channels', async () => {
  const { guild, channel } = fixture([PermissionFlagsBits.ViewChannel]);
  const player = new GuildPlayer(guild, { defaultVolume: 0.5, maxQueue: 20, idleTimeoutSeconds: 300 });
  assert.deepEqual(voiceChannelProblems(channel, guild).missingPermissions, ['Connect', 'Speak']);
  await assert.rejects(player.connect(channel), /Missing permissions in #Listening room: Connect, Speak\./);
  channel.permissionsFor = () => new PermissionsBitField(required);
  channel.userLimit = 1;
  channel.members.set('human', {});
  await assert.rejects(player.connect(channel), /channel #Listening room is full/);
  channel.permissionsFor = () => new PermissionsBitField([...required, PermissionFlagsBits.MoveMembers]);
  assert.equal(voiceChannelProblems(channel, guild).full, false);
  channel.permissionsFor = () => new PermissionsBitField([PermissionFlagsBits.Administrator]);
  assert.deepEqual(voiceChannelProblems(channel, guild), { missingPermissions: [], full: false });
  await player.reset();
});

test('voice timeout is distinct from permission/full errors and destroys the attempted connection', async () => {
  const { guild, channel } = fixture();
  let destroyed = 0;
  const connection = Object.assign(new EventEmitter(), { state: { status: 'connecting' }, joinConfig: { channelId: channel.id },
    destroy: () => { connection.state.status = 'destroyed'; destroyed++; } });
  const player = new GuildPlayer(guild, { defaultVolume: 0.5 }, undefined, {
    joinVoiceChannel: () => connection,
    entersState: async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError', code: 'ABORT_ERR' }); },
  });
  await assert.rejects(player.connect(channel), /timed out after 30 seconds/);
  assert.equal(destroyed, 1);
  assert.equal(player.connection, null);
  await player.reset();
});

test('bundled-tone voice test uses real PCM and voice Opus, completes, and disconnects without downloader or HTTP', { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dubplate-tone-'));
  const tonePath = join(directory, 'voice-test.wav');
  await writeFile(tonePath, wave());
  const { guild, channel } = fixture();
  const core = new BotCore({ token: 'voice-test-token', guildId: guild.id,
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', ytdlpPath: 'must-not-execute', voiceTestTonePath: tonePath });
  const client = Object.assign(new EventEmitter(), { guilds: { cache: new Collection([[guild.id, guild]]) }, user: { id: 'bot' }, destroy: async () => {} });
  core.client = client; guild.client = client; core.status = 'setup'; core.setupMode = true;
  const player = core.playerFor(guild);
  let packets = 0;
  let disconnected = 0;
  const processes = [];
  setProcessSink((event) => processes.push(event));
  player.connect = async () => {
    const connection = { state: { status: 'ready' }, joinConfig: { channelId: channel.id }, setSpeaking() {},
      prepareAudioPacket() { packets++; }, dispatchAudio() {}, onSubscriptionRemoved() {},
      destroy() { this.state.status = 'destroyed'; subscription.unsubscribe(); disconnected++; } };
    const subscription = player.audio.subscribe(connection);
    player.connection = connection;
  };
  t.after(async () => { setProcessSink(() => {}); await core.dispose(); await stopAllProcesses(); await rm(directory, { recursive: true, force: true }); });
  const playingTone = core.testVoice(channel.id);
  await assert.rejects(core.control('add', { query: 'a song' }), /voice test is running/);
  const result = await playingTone;
  assert.equal(result.ok, true);
  assert.equal(result.channelName, channel.name);
  assert.ok(packets >= 45, `expected a second of Opus frames, got ${packets}`);
  assert.equal(disconnected, 1);
  assert.equal(player.connection, null);
  assert.equal(player.current, null);
  assert.equal(player.testing, false);
  assert.deepEqual(activeProcessIds(), []);
  assert.equal(processes.filter((event) => event.type === 'spawn').length, 1, 'only ffmpeg starts; yt-dlp is never involved');
  assert.equal(core.listVoiceChannels()[0].listeners, 1);
});

test('voice tests reject arbitrary audio inputs and refuse to interrupt music', async () => {
  assert.throws(() => startVoiceTestPipeline({}, Buffer.from('not a wave'), () => {}), /tone is missing or invalid/);
  const { guild } = fixture();
  const core = new BotCore({ token: 'voice-test-token', guildId: guild.id });
  core.client = { guilds: { cache: new Collection([[guild.id, guild]]) }, user: { id: 'bot' }, destroy: async () => {} };
  guild.client = core.client; core.status = 'running';
  const player = core.playerFor(guild);
  player.current = { title: 'Keep playing' };
  await assert.rejects(core.testVoice('234567890123456789'), /Stop playback/);
  assert.equal(player.current.title, 'Keep playing');
  await assert.rejects(core.testVoice('999999999999999999'), /regular voice channel/);
  await core.dispose();
});
