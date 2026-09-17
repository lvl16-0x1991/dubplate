import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { loadConfig } from '../src/util/config.js';
import { callerChannel, httpUrl, normalizeQuery } from '../src/util/validation.js';
import { duration, queueEmbed, safeText } from '../src/util/format.js';
import { tracksFromMetadata } from '../src/player/ytdlp.js';
import { checkVoiceDependencies } from '../src/util/runtime.js';
import { redact, setLogSecret } from '../src/util/log.js';

test('only HTTP(S) URLs bypass search; paths and option-like input cannot become executable options', () => {
  for (const input of ['--exec=calc', 'file:///C:/secret.txt', 'C:\\music\\song.mp3', '/etc/passwd', 'ftp://example.com/audio', 'ytsearch100:hello']) {
    assert.equal(normalizeQuery(input), `ytsearch1:${input}`);
  }
  assert.equal(normalizeQuery(' hello '), 'ytsearch1:hello');
  assert.equal(normalizeQuery('https://soundcloud.com/song'), 'https://soundcloud.com/song');
  assert.equal(httpUrl('file:///etc/passwd'), null);
  assert.throws(() => normalizeQuery('a'.repeat(501)), /500/);
  assert.throws(() => normalizeQuery('  '), /Enter a search/);
});

test('configuration rejects missing credentials and invalid numeric limits', () => {
  assert.throws(() => loadConfig({}), /DISCORD_TOKEN is missing/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'secret' }), /GUILD_ID is missing/);
  const env = { DISCORD_TOKEN: 'secret', GUILD_ID: '123456789012345678' };
  assert.equal(loadConfig(env).defaultVolume, 0.5);
  assert.throws(() => loadConfig({ ...env, MAX_QUEUE: '1.5' }), /MAX_QUEUE/);
  assert.throws(() => loadConfig({ ...env, DEFAULT_VOLUME: '2' }), /DEFAULT_VOLUME/);
  assert.equal(redact('oops secret failed'), 'oops [REDACTED] failed');
  setLogSecret('');
});

test('metadata retains playlist order, caps entries, and rejects non-web playback URLs', () => {
  const data = { entries: [
    { title: 'first', id: 'abcdefghijk', ie_key: 'Youtube', url: 'abcdefghijk', duration: 120 },
    { title: 'unsafe', url: 'file:///etc/passwd' },
    { title: 'second', url: 'https://soundcloud.com/a/b' },
    { title: 'third', webpage_url: 'https://example.com/song' },
  ] };
  const tracks = tracksFromMetadata(data, { limit: 2, requesterId: '123' });
  assert.deepEqual(tracks.map((track) => track.title), ['first', 'second']);
  assert.equal(tracks[0].url, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(tracks[1].duration, null);
  assert.equal(tracks[0].requesterId, '123');
});

test('titles neutralize formatting, mentions and controls; queue pages remain bounded', () => {
  const title = safeText('**@everyone** <@123>\n`code`');
  assert.ok(!title.includes('@everyone'));
  assert.ok(!title.includes('<@'));
  assert.ok(!title.includes('\n'));
  assert.ok(title.includes('\\*'));
  assert.ok(safeText('*'.repeat(300)).length <= 180);
  assert.equal(duration(3661), '1:01:01');
  assert.equal(duration(null), 'unknown/live');
  const player = { queue: Array.from({ length: 23 }, (_, index) => ({ title: `song ${index + 1}`, duration: 90 })), volume: 0.5, loop: 'off' };
  const result = queueEmbed(player, 3);
  assert.equal(result.pages, 3);
  assert.match(result.embed.toJSON().description, /21\. song 21/);
  assert.doesNotMatch(result.embed.toJSON().description, /20\. song 20/);
  assert.equal(queueEmbed(player, 90).page, 3);
});

test('control requires voice presence and the current bot channel', () => {
  const cache = new Map();
  const interaction = { guild: { voiceStates: { cache } }, user: { id: 'u' } };
  assert.throws(() => callerChannel(interaction), /Join a voice channel/);
  const channel = { id: 'a', type: ChannelType.GuildVoice };
  cache.set('u', { channel });
  assert.equal(callerChannel(interaction, { channelId: 'a' }), channel);
  assert.throws(() => callerChannel(interaction, { channelId: 'b' }), /same voice channel/);
});

test('installed Opus codec and native DAVE library load and work', async () => {
  await checkVoiceDependencies();
});
