import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { log } from '../util/log.js';

const active = new Set();
let processSink = () => {};
export function setProcessSink(callback) {
  if (typeof callback !== 'function') throw new TypeError('Process sink must be a function.');
  processSink = callback;
}
function publishProcess(event) { try { processSink(event); } catch { /* Supervision must not interrupt cleanup. */ } }
const delay = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); });

export function spawnManaged(executable, args) {
  // Linux processes get their own process group. On Windows, taskkill /T also
  // kills grandchildren (notably the worker inside yt-dlp's packaged .exe).
  const environment = { ...process.env };
  // Downloaders and codecs need executable paths, not Discord credentials or
  // inherited Node preload scripts. The bot token remains in the bot process.
  for (const key of ['DISCORD_TOKEN', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete environment[key];
  const child = spawn(executable, args, {
    shell: false, windowsHide: true, detached: process.platform !== 'win32',
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.pid) publishProcess({ type: 'spawn', pid: child.pid });
  let stderr = '';
  let spawnError;
  let stopPromise;
  let closed = false;
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-6000); });
  child.on('error', (error) => { spawnError = error; });
  const done = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      closed = true;
      active.delete(managed);
      if (child.pid) publishProcess({ type: 'exit', pid: child.pid });
      resolve({ code, signal, error: spawnError, stderr });
    });
  });

  async function killTree() {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      if (closed) return;
      const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      await new Promise((resolve) => {
        const timeout = setTimeout(() => { killer.kill(); resolve(); }, 5000);
        killer.once('error', (error) => { log.error('Windows process-tree cleanup failed', error); clearTimeout(timeout); resolve(); });
        killer.once('close', () => { clearTimeout(timeout); resolve(); });
      });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') log.error('Process-group cleanup failed', error);
      }
    }
  }

  const managed = {
    child, done,
    get stderr() { return stderr; },
    get closed() { return closed; },
    stop() {
      if (!stopPromise) stopPromise = (async () => {
        // Kill the tree BEFORE closing pipes: closing stdin first can let a parent
        // exit before Windows has enumerated its descendants.
        await killTree();
        if (!closed) child.kill('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        await Promise.race([done, delay(5000)]);
        if (!closed) throw new Error(`Process ${child.pid} did not terminate after cleanup.`);
      })();
      return stopPromise;
    },
  };
  active.add(managed);
  return managed;
}

export function activeProcessIds() {
  return [...active].map((item) => item.child.pid).filter(Boolean);
}

export async function stopAllProcesses() {
  const results = await Promise.allSettled([...active].map((process) => process.stop()));
  for (const result of results) if (result.status === 'rejected') log.error('Child process cleanup', result.reason);
}

export async function capture(executable, args, { signal, timeoutMs = 45000, maxBytes = 32 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  const managed = spawnManaged(executable, args);
  managed.child.stdin.end();
  const chunks = [];
  let bytes = 0;
  let failure;
  const abort = (error) => {
    failure ||= error;
    void managed.stop().catch((stopError) => log.error('Capture cleanup', stopError));
  };
  const onAbort = () => abort(signal.reason || new Error('Operation cancelled.'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort(new Error(`Process timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
  managed.child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) abort(new Error('Metadata output exceeded the size limit.'));
    else chunks.push(chunk);
  });
  try {
    const result = await managed.done;
    if (failure) throw failure;
    if (result.error) throw new Error(`Cannot execute ${executable}: ${result.error.code || result.error.message}. Check PATH or the executable path in Settings.`);
    if (result.code !== 0) throw new Error(`Process exited ${result.code ?? result.signal}. ${result.stderr.slice(-2500)}`);
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await managed.stop();
  }
}
