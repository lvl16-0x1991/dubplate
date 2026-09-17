import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, Collection, Events } from 'discord.js';
import { BotCore, checkHealth, validateToken } from '../src/core/BotCore.js';
import { validateConfig } from '../src/util/config.js';
import { execute as loopCommand } from '../src/commands/loop.js';
import { execute as volumeCommand } from '../src/commands/volume.js';
import { log, redact, setLogSecret, setLogSink } from '../src/util/log.js';

const config = { token: 'a-private-test-token', guildId: '123456789012345678' };
function runningCore() {
  const core = new BotCore(config);
  const channel = { id: '234567890123456789', name: 'Listening room', type: ChannelType.GuildVoice, position: 1,
    permissionsFor: () => ({ has: () => true }), isVoiceBased: () => true, isStageVoice: () => false };
  const guild = { id: config.guildId, name: 'Test server', members: { me: {} },
    voiceStates: { cache: new Collection([['human', { id: 'human', channelId: channel.id, channel, member: { user: { bot: false } } }]]) },
    channels: { cache: new Collection([[channel.id, channel]]) } };
  core.client = Object.assign(new EventEmitter(), { guilds: { cache: new Collection([[guild.id, guild]]) }, user: { id: 'bot' }, destroy: async () => {} });
  guild.client = core.client;
  core.status = 'running';
  return { core, guild, channel, player: core.playerFor(guild) };
}

test('core config and snapshots are explicit, bounded, and do not expose credentials', async () => {
  const { core, guild, channel, player } = runningCore();
  player.connection = { joinConfig: { channelId: channel.id }, state: { status: 'ready' }, destroy() {} };
  player.queue = [{ id: 'a', title: '<b>untrusted</b>', url: 'https://youtu.be/abcdefghijk', duration: 90, requesterName: 'Alice' }];
  const snapshot = core.snapshot();
  assert.equal(snapshot.guild.name, guild.name);
  assert.equal(snapshot.voice.listeners, 1);
  assert.equal(snapshot.voice.name, channel.name);
  assert.equal(snapshot.volume, 50);
  assert.deepEqual(snapshot.channels, [{ id: channel.id, name: channel.name, listeners: 1, missingPermissions: [], full: false }]);
  assert.equal(snapshot.queue[0].title, '<b>untrusted</b>');
  assert.ok(!JSON.stringify(snapshot).includes(config.token));
  snapshot.queue[0].title = 'mutated';
  assert.equal(player.queue[0].title, '<b>untrusted</b>');
  assert.throws(() => validateConfig({ ...config, maxQueue: 1.5 }), /maxQueue/);
  assert.throws(() => validateConfig({ ...config, defaultVolume: 2 }), /defaultVolume/);
  assert.throws(() => validateConfig({ ...config, allowedHosts: ['localhost'] }), /domain/);
  assert.equal('testUrlPolicy' in validateConfig({ ...config, testUrlPolicy: true }), false);
  await core.dispose();
});

test('desktop queue edits and Discord commands emit the same full state snapshots', async () => {
  const { core, guild, player } = runningCore();
  const states = [];
  core.on('state', (state) => states.push(state));
  player.queue = ['first', 'second', 'third'].map((title) => ({ title, duration: 20 }));
  await core.control('reorder', { from: 1, to: 3 });
  assert.deepEqual(states.at(-1).queue.map((track) => track.title), ['second', 'third', 'first']);
  await core.control('remove', { position: 2 });
  assert.deepEqual(core.snapshot().queue.map((track) => track.title), ['second', 'first']);
  const interaction = { guild, user: { id: 'human' }, options: { getString: () => 'queue', getInteger: () => 125 }, editReply: async () => {} };
  const context = { playerFor: (value) => core.playerFor(value) };
  await loopCommand(interaction, context);
  assert.equal(states.at(-1).loop, 'queue');
  await volumeCommand(interaction, context);
  assert.equal(states.at(-1).volume, 125);
  await core.control('clear');
  assert.deepEqual(states.at(-1).queue, []);
  await core.dispose();
});

test('desktop core repeats validation and never lets add bypass the URL policy', async () => {
  const { core, channel, player } = runningCore();
  let enqueued = false;
  player.enqueueDesktop = async () => { enqueued = true; };
  await assert.rejects(core.control('add', { query: 'http://127.0.0.1/', voiceChannelId: channel.id }), /IP addresses/);
  await assert.rejects(core.control('add', { query: 'safe search', voiceChannelId: '../path' }), /Select a voice channel/);
  assert.equal(enqueued, false);
  for (const args of [{ percent: -1 }, { percent: 151 }, { percent: 0.1 }, { percent: '50' }]) await assert.rejects(core.control('volume', args), /Volume/);
  await assert.rejects(core.control('loop', { mode: 'all' }), /Loop mode/);
  await assert.rejects(core.control('reorder', { from: 0, to: 1 }), /position/);
  await assert.rejects(core.control('shell', { command: 'calc' }), /Unknown/);
  await core.stop();
  await assert.rejects(core.control('clear'), /Start the bot/);
  await core.dispose();
});

test('core forwards structured redacted logs and errors and stops idempotently', async () => {
  const core = new BotCore(config);
  const entries = [];
  const errors = [];
  core.on('log', (entry) => entries.push(entry));
  core.on('error', (entry) => errors.push(entry));
  setLogSink(() => {});
  log.info(`Testing ${config.token}\nnext line`);
  core.reportError(new Error(config.token), 'failure');
  assert.deepEqual(Object.keys(entries[0]), ['timestamp', 'level', 'message']);
  assert.equal(entries[0].level, 'info');
  assert.equal(entries[0].message, 'Testing [REDACTED] next line');
  assert.equal(errors[0].message, '[REDACTED]');
  const first = core.stop();
  assert.equal(core.stop(), first);
  await first;
  assert.equal(core.snapshot().status, 'stopped');
  await core.dispose();
  setLogSecret('old-secret'); setLogSecret('new-secret');
  assert.equal(redact('old-secret new-secret Authorization: Bot accidental-token'), '[REDACTED] [REDACTED] Authorization: Bot [REDACTED]');
  setLogSecret('');
});

test('setup validation rejects malformed tokens without a request and health works without credentials', { timeout: 15000 }, async () => {
  await assert.rejects(validateToken(''), /valid Discord/);
  await assert.rejects(validateToken('token\nheader'), /valid Discord/);
  const health = await checkHealth({ ffmpegPath: 'missing-ffmpeg-health', ytdlpPath: 'missing-ytdlp-health', nodePath: process.execPath });
  assert.equal(health.ffmpeg.ok, false);
  assert.equal(health.ytdlp.ok, false);
  assert.equal(health.node.ok, true);
  assert.equal(health.opus.ok, true);
  assert.equal(health.dave.ok, true);
  assert.match(health.dave.message, /self-test passed/);
});

test('health can inspect native modules without executing unavailable or unverified binaries', async () => {
  const health = await checkHealth({ ffmpegPath: process.execPath, ytdlpPath: process.execPath, nodePath: process.execPath },
    { skipBinaryChecks: ['ffmpeg', 'ytdlp', 'node'] });
  for (const name of ['ffmpeg', 'ytdlp', 'node']) {
    assert.equal(health[name].ok, false);
    assert.match(health[name].message, /not been verified/);
  }
  assert.equal(health.opus.ok, true);
  assert.equal(health.dave.ok, true);
  await assert.rejects(checkHealth({}, { skipBinaryChecks: ['dave'] }), /Invalid skipped/);
});

test('gateway resumes and fresh READY sessions both restore controls, but initial READY does not bypass startup', async () => {
  const { core } = runningCore();
  const client = core.client;
  core.bindGatewayStatus(client, core.generation);
  core.status = 'starting';
  client.emit(Events.ShardReady, 0);
  assert.equal(core.status, 'starting');
  client.emit(Events.ShardReconnecting, 0);
  client.emit(Events.ShardReady, 0);
  assert.equal(core.status, 'starting');
  core.status = 'running';
  for (const event of [Events.ShardResume, Events.ShardReady]) {
    client.emit(Events.ShardReconnecting, 0);
    assert.equal(core.snapshot().status, 'reconnecting');
    await assert.rejects(core.control('volume', { percent: 60 }), /Start the bot/);
    client.emit(event, 0);
    assert.equal(core.snapshot().status, 'running');
    await core.control('volume', { percent: 60 });
    assert.equal(core.snapshot().volume, 60);
  }
  await core.stop();
  client.emit(Events.ShardReady, 0);
  client.emit(Events.ShardResume, 0);
  client.emit(Events.ShardReconnecting, 0);
  assert.equal(core.status, 'stopped');
  await core.dispose();
});

test('unrecoverable gateway disconnect cleans up playback and exposes an error state', async () => {
  const { core, player, channel } = runningCore();
  const client = core.client;
  const cleanup = [];
  const errors = [];
  core.on('error', (error) => errors.push(error));
  core.bindGatewayStatus(client, core.generation);
  player.current = { title: 'current' };
  player.queue = [{ title: 'queued' }];
  player.pipeline = { stop: async () => cleanup.push('pipeline') };
  player.connection = { state: { status: 'ready' }, joinConfig: { channelId: channel.id }, destroy: () => cleanup.push('voice') };
  client.destroy = async () => cleanup.push('gateway');
  client.emit(Events.ShardDisconnect, { code: 4004 }, 0);
  await core.stopPromise;
  assert.equal(core.status, 'error');
  assert.equal(core.client, null);
  assert.equal(core.snapshot().current, null);
  assert.deepEqual(core.snapshot().queue, []);
  assert.deepEqual(cleanup, ['pipeline', 'voice', 'gateway']);
  assert.match(errors[0].message, /disconnected permanently.*4004/);
  client.emit(Events.ShardReady, 0);
  assert.equal(core.status, 'error');
  await core.dispose();
});
