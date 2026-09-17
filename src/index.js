import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { config as dotenv } from 'dotenv';
import { BotCore } from './core/BotCore.js';
import { loadConfig } from './util/config.js';
import { log, setLogSink } from './util/log.js';

export function installHeadlessErrorHandlers(target = process, logger = log) {
  const rejection = (error) => logger.error('Unhandled rejection; process remains running', error);
  const exception = (error) => logger.error('Uncaught exception; process remains running', error);
  target.on('unhandledRejection', rejection);
  target.on('uncaughtException', exception);
  return () => {
    target.off('unhandledRejection', rejection);
    target.off('uncaughtException', exception);
  };
}

async function main() {
  dotenv({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
  setLogSink(({ timestamp, level, message }) => {
    const output = `${timestamp} ${level.toUpperCase()} ${message}`;
    if (level === 'error' || level === 'warn') console.error(output);
    else console.log(output);
  });

  let bot;
  let shuttingDown = false;
  async function shutdown(reason, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutting down: ${reason}`);
    await bot?.dispose();
    // Native DAVE/Opus must release handles naturally; forced process.exit can abort.
    process.exitCode = code;
  }
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  installHeadlessErrorHandlers();

  try {
    bot = new BotCore(loadConfig(process.env));
    await bot.start();
  } catch (error) {
    log.error('Startup failed', error);
    await shutdown('startup failure', 1);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
