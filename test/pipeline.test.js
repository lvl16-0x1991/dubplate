import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Collection } from 'discord.js';
import { AudioPlayerStatus, createAudioResource, entersState, StreamType } from '@discordjs/voice';
import { GuildPlayer } from '../src/player/GuildPlayer.js';
import { createLoopbackTestBackend } from '../src/testing/loopback.js';
import { activeProcessIds, stopAllProcesses } from '../src/player/processes.js';

function wave(seconds) {
  const sampleRate = 48000;
  const samples = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) buffer.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 8000), 44 + index * 2);
  return buffer;
}

test('real yt-dlp/ffmpeg raw PCM pipeline encodes Opus once, inline volume works, and seek shortens playback', { timeout: 60000 }, async (t) => {
  const config = { ytdlpPath: process.env.YT_DLP_PATH || 'yt-dlp', ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg' };
  const audio = wave(2);
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length });
    response.end(request.method === 'HEAD' ? undefined : audio);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await stopAllProcesses(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/tone.wav`;
  const backend = createLoopbackTestBackend(new URL(url).origin);
  const result = await backend.resolve(config, url, { limit: 3, requesterId: 'test', textChannelId: 'test' });
  assert.equal(result.tracks.length, 1);
  const packetCounts = [];
  for (const offset of [0, 1]) {
    const failures = [];
    const pipeline = backend.startPipeline(config, result.tracks[0], offset, (error) => failures.push(error));
    assert.ok(pipeline.encoder.child.spawnargs.includes('pcm_s16le'));
    assert.ok(!pipeline.encoder.child.spawnargs.includes('libopus'));
    const resource = createAudioResource(pipeline.stream, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume.setVolume(0.35);
    let packets = 0;
    for await (const packet of resource.playStream) { assert.ok(packet.length > 0); packets++; }
    const exits = await pipeline.completed;
    await pipeline.stop();
    assert.deepEqual(failures, [], pipeline.stderr);
    assert.ok(exits.every((exit) => exit.code === 0), pipeline.stderr);
    packetCounts.push(packets);
  }
  assert.ok(packetCounts[0] >= 90, `expected about 100 packets, got ${packetCounts[0]}`);
  assert.ok(packetCounts[1] >= 40 && packetCounts[1] < packetCounts[0] - 30, `seek packet counts: ${packetCounts}`);
  assert.deepEqual(activeProcessIds(), []);
});

test('pipeline failure reports the extractor exit and both processes are cleaned up', { timeout: 30000 }, async () => {
  const config = { ytdlpPath: process.env.YT_DLP_PATH || 'yt-dlp', ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg' };
  let reported;
  const failure = new Promise((resolve) => { reported = resolve; });
  const pipeline = createLoopbackTestBackend('http://127.0.0.1:1').startPipeline(config, { url: 'http://127.0.0.1:1/missing.wav' }, 0, reported);
  pipeline.stream.resume();
  try {
    const error = await failure;
    assert.match(error.message, /yt-dlp exited|ffmpeg/);
  } finally { await pipeline.stop(); }
  assert.match(pipeline.stderr, /ERROR|Error|refused|Invalid/i);
  assert.deepEqual(activeProcessIds(), []);
});

test('real player advances after failure, pauses, seeks, skips and stops without leftover processes', { timeout: 60000 }, async (t) => {
  const audio = wave(20);
  const server = createServer((request, response) => {
    if (request.url.startsWith('/bad')) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length });
    response.end(request.method === 'HEAD' ? undefined : audio);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const notices = [];
  const guild = {
    id: 'integration', client: { user: { id: 'bot' } }, voiceStates: { cache: new Collection() },
    channels: { fetch: async () => ({ isTextBased: () => true, send: async (message) => notices.push(message) }) },
  };
  const player = new GuildPlayer(guild, {
    ytdlpPath: process.env.YT_DLP_PATH || 'yt-dlp', ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    defaultVolume: 0.5, maxQueue: 5, idleTimeoutSeconds: 300,
  }, createLoopbackTestBackend(base));
  // Test-only transport consumes packets locally; all audio/queue/process code is
  // real. Discord encryption and the network transport require a live bot token.
  let packets = 0;
  const connection = {
    state: { status: 'ready' }, joinConfig: { channelId: 'voice' },
    setSpeaking() {}, prepareAudioPacket() { packets++; }, dispatchAudio() {},
    destroy() { this.state.status = 'destroyed'; subscription.unsubscribe(); },
    onSubscriptionRemoved() {},
  };
  const subscription = player.audio.subscribe(connection);
  player.connection = connection;
  t.after(async () => {
    await player.exclusive(() => player.reset('test cleanup'));
    await stopAllProcesses();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const track = (name) => ({ title: name, url: `${base}/${name}.wav`, duration: 20, textChannelId: 'text' });
  player.queue = [track('bad'), track('good'), track('next')];
  await player.exclusive(() => player.startNext());
  for (let attempt = 0; attempt < 400; attempt++) {
    if (player.current?.url.endsWith('/good.wav') && player.audio.state.status === AudioPlayerStatus.Playing) break;
    await delay(50);
  }
  assert.equal(player.current.title, 'good');
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].allowedMentions.parse, []);
  await delay(250);
  assert.ok(packets > 0);
  await player.exclusive(() => player.pause());
  // pause emits up to five silence packets; resource time must not advance.
  const pausedTime = player.elapsed;
  await delay(250);
  assert.equal(player.elapsed, pausedTime);
  await player.exclusive(() => player.seek(2));
  await entersState(player.audio, AudioPlayerStatus.Paused, 15000);
  assert.ok(player.elapsed >= 2 && player.elapsed < 2.2);
  await player.exclusive(() => player.resume());
  await entersState(player.audio, AudioPlayerStatus.Playing, 3000);
  await player.exclusive(() => player.finish(player.playToken, 'skipped'));
  await entersState(player.audio, AudioPlayerStatus.Playing, 15000);
  assert.equal(player.current.title, 'next');
  await player.exclusive(() => player.reset('stop integration test'));
  await stopAllProcesses();
  assert.equal(player.connection, null);
  assert.deepEqual(activeProcessIds(), []);
});
