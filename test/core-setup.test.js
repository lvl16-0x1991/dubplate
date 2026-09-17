import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection, Events } from 'discord.js';
import { BotCore } from '../src/core/BotCore.js';
import { activeProcessIds, setProcessSink } from '../src/player/processes.js';

const firstId = '123456789012345678';
const secondId = '234567890123456789';
const thirdId = '345678901234567890';
function setupCore(guildIds = [], configured = '') {
  const client = Object.assign(new EventEmitter(), {
    guilds: { cache: new Collection() }, user: { id: '456789012345678901', tag: 'test-bot' },
    login: async () => { queueMicrotask(() => client.emit(Events.ClientReady)); }, destroy: async () => {},
  });
  const left = [];
  function guild(id) {
    const value = { id, name: `Server ${id.slice(0, 3)}`, icon: 'example-icon', client,
      channels: { cache: new Collection(), fetch: async () => {} }, voiceStates: { cache: new Collection() }, members: { me: {} },
      leave: async () => { left.push(id); client.guilds.cache.delete(id); client.emit(Events.GuildDelete, value); } };
    client.guilds.cache.set(id, value);
    return value;
  }
  guildIds.forEach(guild);
  const identity = { applicationId: '567890123456789012', botId: client.user.id, name: 'Test bot', avatar: null };
  const core = new BotCore({ token: 'setup-test-token', guildId: configured,
    ffmpegPath: 'uninstalled-ffmpeg', ytdlpPath: 'uninstalled-ytdlp', nodePath: 'uninstalled-node' },
  { validateToken: async () => identity, createClient: () => client });
  return { core, client, guild, left, identity };
}

test('setup validates identity and connects Gateway before tools or a guild are configured', async () => {
  const { core, identity } = setupCore();
  const processes = [];
  const identities = [];
  setProcessSink((event) => processes.push(event));
  core.on('identity', (value) => identities.push(value));
  try {
    const state = await core.startSetup();
    assert.equal(state.status, 'setup');
    assert.deepEqual(state.identity, identity);
    assert.deepEqual(identities, [identity]);
    assert.deepEqual(state.setupGuilds, []);
    assert.deepEqual(processes, []);
    assert.deepEqual(activeProcessIds(), []);
    await assert.rejects(core.start(), /GUILD_ID is missing/);
  } finally { setProcessSink(() => {}); await core.dispose(); }
});

test('first newly joined guild is adopted and later guilds are left, including simultaneous joins', async () => {
  const { core, client, guild, left } = setupCore();
  const selections = [];
  core.on('guildConfigured', (value) => selections.push(value));
  try {
    await core.startSetup();
    client.emit(Events.GuildCreate, guild(firstId));
    client.emit(Events.GuildCreate, guild(secondId));
    await core.guildPolicyTail;
    assert.equal(core.config.guildId, firstId);
    assert.deepEqual(left, [secondId]);
    assert.deepEqual([...client.guilds.cache.keys()], [firstId]);
    assert.equal(selections[0].id, firstId);
    assert.match(selections[0].icon, /^https:\/\/cdn\.discordapp\.com\/icons\//);
    client.emit(Events.GuildCreate, guild(thirdId));
    await core.guildPolicyTail;
    assert.deepEqual(left, [secondId, thirdId]);
  } finally { await core.dispose(); }
});

test('existing guilds remain a deliberate fallback until selection, then all others are left', async () => {
  const { core, client, left } = setupCore([firstId, secondId]);
  try {
    await core.startSetup();
    assert.equal(core.config.guildId, '');
    assert.equal(core.snapshot().setupGuilds.length, 2);
    assert.deepEqual(left, []);
    await assert.rejects(core.chooseGuild(thirdId), /has not joined/);
    const selected = await core.chooseGuild(secondId);
    assert.equal(selected.id, secondId);
    assert.equal(core.snapshot().guild.id, secondId);
    assert.deepEqual(left, [firstId]);
    assert.deepEqual([...client.guilds.cache.keys()], [secondId]);
  } finally { await core.dispose(); }
});

test('startup guild events stay in the fallback list and delayed guild removal is not repeated', async () => {
  const { core, client, guild, left } = setupCore([firstId]);
  client.login = async () => { client.emit(Events.GuildCreate, client.guilds.cache.get(firstId)); queueMicrotask(() => client.emit(Events.ClientReady)); };
  try {
    await core.startSetup(); assert.equal(core.config.guildId, '');
    const added = guild(secondId); const unwanted = guild(thirdId);
    unwanted.leave = async () => { left.push(thirdId); }; // Discord's cache removal arrives later.
    client.emit(Events.GuildCreate, added); client.emit(Events.GuildCreate, unwanted);
    await core.guildPolicyTail;
    assert.equal(core.config.guildId, secondId);
    assert.equal(left.filter((id) => id === thirdId).length, 1);
  } finally { await core.dispose(); }
});

test('configured guild policy is enforced on ready and after reconnect without replacing the selection', async () => {
  const { core, client, guild, left } = setupCore([firstId, secondId], firstId);
  try {
    await core.startSetup();
    assert.deepEqual(left, [secondId]);
    guild(thirdId);
    client.emit(Events.ShardReconnecting, 0);
    client.emit(Events.ShardReady, 0);
    await core.guildPolicyTail;
    assert.deepEqual(left, [secondId, thirdId]);
    assert.equal(core.status, 'setup');
    assert.equal(core.config.guildId, firstId);
    await core.stop();
    client.emit(Events.GuildCreate, guild(secondId));
    await core.guildPolicyTail;
    assert.deepEqual(left, [secondId, thirdId]);
  } finally { await core.dispose(); }
});

test('tool configuration cannot change identity, server or URL policy and refuses active playback', async () => {
  const { core } = setupCore([firstId], firstId);
  try {
    await core.startSetup();
    for (const patch of [{ token: 'other-token' }, { guildId: secondId }, { allowedHosts: ['example.org'] }, { testUrlPolicy: true }]) {
      assert.throws(() => core.configureTools(patch), /Invalid playback tool/);
    }
    core.configureTools({ ffmpegPath: 'chosen-ffmpeg', voiceTestTonePath: 'bundled-tone.wav' });
    assert.equal(core.config.ffmpegPath, 'chosen-ffmpeg');
    const player = core.playerFor(core.client.guilds.cache.get(firstId));
    player.current = { title: 'playing' };
    assert.throws(() => core.configureTools({ ffmpegPath: 'another-ffmpeg' }), /Stop playback/);
  } finally { await core.dispose(); }
});
