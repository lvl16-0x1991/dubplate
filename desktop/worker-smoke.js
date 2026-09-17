import { createAudioResource, StreamType } from '@discordjs/voice';
import { createLoopbackTestBackend } from '../src/testing/loopback.js';
import { activeProcessIds, stopAllProcesses } from '../src/player/processes.js';
import { checkHealth } from '../src/core/BotCore.js';
import { readFile } from 'node:fs/promises';
import { startVoiceTestPipeline } from '../src/player/ytdlp.js';

export async function runWorkerSmoke({ config, origin }) {
  const health = await checkHealth(config);
  for (const [name, result] of Object.entries(health)) if (!result.ok) throw new Error(`${name}: ${result.message}`);
  const backend = createLoopbackTestBackend(origin);
  const resolution = await backend.resolve(config, `${origin}/tone.wav`, { limit: 1 });
  let failure;
  const pipeline = backend.startPipeline(config, resolution.tracks[0], 0, (error) => { failure = error; });
  const resource = createAudioResource(pipeline.stream, { inputType: StreamType.Raw, inlineVolume: true });
  resource.volume.setVolume(0.5);
  let packets = 0;
  const timeout = setTimeout(() => { failure = new Error('Smoke audio timed out.'); void pipeline.stop(); }, 30000);
  try {
    for await (const packet of resource.playStream) if (packet.length) packets++;
    await pipeline.completed;
    if (failure) throw failure;
    if (packets < 40) throw new Error(`Expected at least 40 Opus packets from PCM, got ${packets}.`);
  } finally { clearTimeout(timeout); await pipeline.stop(); resource.playStream.destroy(); await stopAllProcesses(); }
  const tone = await readFile(config.voiceTestTonePath);
  let toneFailure;
  const tonePipeline = startVoiceTestPipeline(config, tone, (error) => { toneFailure = error; });
  const toneResource = createAudioResource(tonePipeline.stream, { inputType: StreamType.Raw, inlineVolume: true });
  toneResource.volume.setVolume(0.5);
  let tonePackets = 0;
  try {
    for await (const packet of toneResource.playStream) if (packet.length) tonePackets++;
    await tonePipeline.completed;
    if (toneFailure) throw toneFailure;
    if (tonePackets < 90) throw new Error(`Bundled tone produced too few Opus packets: ${tonePackets}.`);
  } finally { await tonePipeline.stop(); toneResource.playStream.destroy(); await stopAllProcesses(); }
  return { health, packets, tonePackets, toneBytes: tone.length, remainingProcesses: activeProcessIds(), pid: process.pid, electron: process.versions.electron, node: process.versions.node };
}
