import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { GuildPlayer } from '../src/player/GuildPlayer.js';

function makePlayer() {
  const guild = { id: 'test', client: { user: { id: 'bot' } }, voiceStates: { cache: new Collection() } };
  return new GuildPlayer(guild, { defaultVolume: 0.5, maxQueue: 3, idleTimeoutSeconds: 1 });
}

test('natural completion loops; skip and failure advance without repeating; stale callbacks do nothing', async () => {
  const player = makePlayer();
  const starts = [];
  player.connection = { joinConfig: { channelId: 'voice' } };
  player.startTrack = async (track) => { player.current = track; starts.push(track.title); ++player.playToken; };
  const first = { title: 'first' }, second = { title: 'second' };
  player.current = first;
  player.loop = 'track';
  player.queue = [second];
  await player.finish(0, 'ended');
  assert.equal(player.current, first);
  const oldToken = player.playToken;
  await player.finish(player.playToken, 'skipped');
  assert.equal(player.current, second);
  await player.finish(oldToken, 'failed', new Error('stale callback'));
  assert.equal(player.current, second);
  player.queue = [first];
  await player.finish(player.playToken, 'failed', new Error('expected test failure'));
  assert.equal(player.current, first);
  assert.deepEqual(starts, ['first', 'second', 'first']);
  player.loop = 'queue';
  player.queue = [second];
  await player.finish(player.playToken, 'ended');
  assert.equal(player.current, second);
  assert.deepEqual(player.queue, [first]);
});

test('reset cancels pending resolution and prewarm, kills the pipeline and destroys voice', async () => {
  const player = makePlayer();
  const request = new AbortController();
  const warm = new AbortController();
  const order = [];
  player.pending.set(request, Promise.resolve());
  player.warm = { controller: warm };
  player.current = { title: 'current' };
  player.queue = [{ title: 'next' }];
  player.pipeline = { stop: async () => { order.push('processes'); } };
  player.connection = { state: { status: 'ready' }, destroy: () => order.push('voice') };
  await player.reset('test');
  assert.ok(request.signal.aborted && warm.signal.aborted);
  assert.deepEqual(order, ['processes', 'voice']);
  assert.equal(player.current, null);
  assert.equal(player.connection, null);
  assert.deepEqual(player.queue, []);
  assert.equal(player.epoch, 1);
});

test('elapsed uses consumed audio packets; queue edits preserve the current track', () => {
  const player = makePlayer();
  player.current = { title: 'playing', duration: 30 };
  player.offset = 10;
  player.resource = { playbackDuration: 1250 };
  assert.equal(player.elapsed, 11.25);
  player.queue = [{ title: 'first' }, { title: 'second' }, { title: 'third' }];
  player.schedulePrewarm = () => {};
  assert.equal(player.remove(2).title, 'second');
  assert.throws(() => player.remove(0), /position/);
  player.shuffle();
  assert.deepEqual(player.queue.map((track) => track.title).sort(), ['first', 'third']);
  assert.equal(player.clear(), 2);
  assert.equal(player.current.title, 'playing');
});

test('shutdown during an EOF wait cannot restart a looping track', async () => {
  const player = makePlayer();
  let complete;
  let starts = 0;
  player.current = { title: 'current' };
  player.loop = 'track';
  player.connection = { state: { status: 'ready' }, destroy() {} };
  player.pipeline = { completed: new Promise((resolve) => { complete = resolve; }), stop: async () => {} };
  player.startTrack = async () => { starts++; };
  const finishing = player.finish(player.playToken, 'ended');
  await player.reset('shutdown');
  complete();
  await finishing;
  assert.equal(starts, 0);
  assert.equal(player.current, null);
  assert.equal(player.connection, null);
});

test('an add waiting for the control lock cannot reconnect after stop cancels its generation', async () => {
  const player = makePlayer();
  let unlock;
  let connections = 0;
  player.connect = async () => { connections++; };
  const blocker = player.exclusive(() => new Promise((resolve) => { unlock = resolve; }));
  await Promise.resolve();
  const request = player.enqueueRequest('safe search', () => ({}), { requesterName: 'test' });
  const rejected = assert.rejects(request, /Playback was stopped/);
  await player.reset('shutdown');
  unlock();
  await blocker;
  await rejected;
  assert.equal(connections, 0);
});
