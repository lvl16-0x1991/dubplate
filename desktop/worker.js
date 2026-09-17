import { BotCore, validateToken, listGuilds, checkHealth } from '../src/core/BotCore.js';
import { setLogSink, redact, setLogSecret } from '../src/util/log.js';
import { setProcessSink, stopAllProcesses } from '../src/player/processes.js';

let port;
let core;
let stopping = false;
let lifecycle = 0;
const send = (type, payload) => port?.postMessage({ kind: 'event', type, payload });
setLogSink((entry) => send('log', entry));
setProcessSink((entry) => send('process', entry));

async function handle(method, args) {
  if (stopping) throw new Error('The bot is shutting down.');
  switch (method) {
    case 'validateToken': setLogSecret(args); return validateToken(args);
    case 'listGuilds': return listGuilds(args);
    case 'health': return checkHealth(args.config, { skipBinaryChecks: args.skipBinaryChecks });
    case 'startSetup':
    case 'start': {
      const generation = ++lifecycle;
      await core?.dispose();
      if (stopping || generation !== lifecycle) throw new Error('Bot startup was cancelled.');
      const next = new BotCore(args);
      core = next;
      for (const event of ['state', 'health', 'trackStart', 'trackEnd', 'error', 'identity', 'guildConfigured']) next.on(event, (payload) => {
        if (core === next) send(event, payload instanceof Error ? { message: redact(payload.message) } : payload);
      });
      if (method === 'startSetup') await next.startSetup(); else await next.start();
      if (stopping || generation !== lifecycle) throw new Error('Bot startup was cancelled.');
      return next.snapshot();
    }
    case 'chooseGuild': if (!core) throw new Error('Connect your bot first.'); return core.chooseGuild(args);
    case 'listVoiceChannels': if (!core) throw new Error('Connect your bot first.'); return core.snapshot().channels;
    case 'testVoice': {
      if (!core) throw new Error('Connect your bot first.');
      core.configureTools(args.paths);
      return core.testVoice(args.voiceChannelId);
    }
    case 'stop': {
      ++lifecycle;
      const current = core;
      await current?.stop();
      return current?.snapshot() ?? { status: 'stopped' };
    }
    case 'control': if (!core) throw new Error('Start the bot first.'); return core.control(args.action, args.args);
    case 'shutdown': ++lifecycle; stopping = true; await core?.dispose(); await stopAllProcesses(); return true;
    case 'smoke': {
      // Available only to the trusted main-process packaging harness, never IPC.
      const { runWorkerSmoke } = await import('./worker-smoke.js');
      return runWorkerSmoke(args);
    }
    default: throw new Error('Unknown worker request.');
  }
}

process.parentPort.once('message', ({ ports }) => {
  [port] = ports;
  port.on('message', async ({ data }) => {
    if (!Number.isSafeInteger(data?.id) || typeof data.method !== 'string') return;
    try {
      const value = await handle(data.method, data.args);
      port.postMessage({ kind: 'response', id: data.id, ok: true, value });
    } catch (error) { port.postMessage({ kind: 'response', id: data.id, ok: false, error: redact(error.message) }); }
  });
  port.start();
});

async function fatal(error) {
  ++lifecycle; stopping = true;
  send('log', { level: 'error', message: redact(error?.message ?? error), timestamp: new Date().toISOString() });
  await core?.stop().catch(() => {});
  await stopAllProcesses();
  port?.close(); process.exitCode = 1;
}
process.on('uncaughtException', (error) => { void fatal(error); });
process.on('unhandledRejection', (error) => { void fatal(error); });
