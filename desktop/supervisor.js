import { utilityProcess, MessageChannelMain } from 'electron';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const lifecycleMethods = new Set(['start', 'startSetup', 'stop', 'shutdown']);

async function terminateTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform !== 'win32') { try { process.kill(-pid, 'SIGKILL'); } catch {} return; }
  await new Promise((resolve) => {
    const child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
    child.once('error', () => { clearTimeout(timer); resolve(); });
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

export class BotSupervisor extends EventEmitter {
  constructor(workerPath, log) { super(); this.workerPath = workerPath; this.log = log; this.pending = new Map(); this.sequence = 0; this.pids = new Set(); this.failures = 0; this.desired = false; this.config = null; this.stopping = false; this.lifecycle = 0; }
  async ensureWorker() {
    if (this.stopping) throw new Error('The bot is shutting down.');
    if (this.child) return this.child;
    const environment = { ...process.env };
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'DISCORD_TOKEN']) delete environment[key];
    const child = utilityProcess.fork(this.workerPath, [], { serviceName: 'Dubplate Bot', stdio: 'pipe', env: environment });
    this.child = child;
    const { port1, port2 } = new MessageChannelMain();
    this.port = port1;
    port1.on('message', ({ data }) => {
      if (data?.kind === 'response') {
        const request = this.pending.get(data.id);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(data.id);
        if (data.ok) request.resolve(data.value); else request.reject(new Error(data.error || 'Bot operation failed.'));
      } else if (data?.kind === 'event') {
        if (data.type === 'process') {
          if (Number.isSafeInteger(data.payload?.pid)) {
            if (data.payload.type === 'spawn') this.pids.add(data.payload.pid); else this.pids.delete(data.payload.pid);
          }
        } else this.emit('event', { type: data.type, payload: data.payload });
      }
    });
    port1.start();
    child.postMessage({ type: 'connect' }, [port2]);
    child.stdout?.on('data', (data) => this.log.write({ level: 'debug', message: data.toString() }));
    child.stderr?.on('data', (data) => this.log.write({ level: 'error', message: data.toString() }));
    child.on('exit', (code) => { void this.onExit(child, code); });
    return child;
  }
  async onExit(child, code) {
    if (this.child !== child) return;
    const lifecycle = this.lifecycle;
    this.child = null; this.port?.close(); this.port = null;
    clearTimeout(this.stableTimer);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('The bot process stopped.')); }
    this.pending.clear();
    const exitedPids = [...this.pids]; this.pids.clear();
    await Promise.allSettled(exitedPids.map(terminateTree));
    // A manual start or stop may have superseded this crash while taskkill ran.
    // Health requests may create an idle worker, so worker presence alone must
    // not suppress recovery of a bot that is still desired.
    if (this.stopping || lifecycle !== this.lifecycle) return;
    this.emit('event', { type: 'supervisor', payload: { status: 'crashed', code, retrying: this.desired } });
    this.log.write({ level: 'error', message: `Bot process exited unexpectedly (${code}).` });
    if (this.desired && this.config) {
      const delay = Math.min(60000, 1000 * 2 ** Math.min(this.failures++, 6));
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        if (this.desired && !this.stopping && lifecycle === this.lifecycle) void this.start(this.config, this.mode).catch((error) => this.log.write({ level: 'error', message: error.message }));
      }, delay);
    }
  }
  async request(method, args, timeoutMs = 100000) {
    const lifecycle = this.lifecycle;
    const child = await this.ensureWorker();
    if (this.stopping) throw new Error('The bot is shutting down.');
    if (lifecycleMethods.has(method) && lifecycle !== this.lifecycle) throw new Error('Bot operation was cancelled.');
    return this.sendRequest(child, method, args, timeoutMs, lifecycle);
  }
  sendRequest(child, method, args, timeoutMs, lifecycle = this.lifecycle) {
    if (this.child !== child || !this.port) return Promise.reject(new Error('The bot process stopped.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A timed-out lifecycle request can still be running in the worker.
        // Retire that worker instead of allowing an unacknowledged startup to
        // finish later; a newer lifecycle request owns its own cancellation.
        // Shutdown has its own bounded process-tree cleanup before killing.
        if (method !== 'shutdown' && lifecycleMethods.has(method) && this.child === child && lifecycle === this.lifecycle) {
          ++this.lifecycle; this.desired = false;
          clearTimeout(this.restartTimer); clearTimeout(this.stableTimer);
          try { child.kill(); } catch (error) { this.log.write({ level: 'warn', message: error.message }); }
        }
        reject(new Error('The bot took too long to respond. Retry or restart it.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.port.postMessage({ id, method, args }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async start(config, mode = 'start') {
    if (this.stopping) throw new Error('The bot is shutting down.');
    const lifecycle = ++this.lifecycle;
    this.desired = true; this.config = config; this.mode = mode;
    clearTimeout(this.restartTimer);
    const state = await this.request(mode, config);
    if (this.stopping || lifecycle !== this.lifecycle || !this.desired) throw new Error('Bot startup was cancelled.');
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => { this.failures = 0; }, 60000); this.stableTimer.unref();
    return state;
  }
  async startSetup(config) { return this.start(config, 'startSetup'); }
  async stop() { ++this.lifecycle; this.desired = false; clearTimeout(this.restartTimer); clearTimeout(this.stableTimer); return !this.stopping && this.child ? this.request('stop') : null; }
  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    ++this.lifecycle; this.stopping = true; this.desired = false; clearTimeout(this.restartTimer); clearTimeout(this.stableTimer);
    const child = this.child;
    this.shutdownPromise = (async () => {
      if (!child) return;
      try { await this.sendRequest(child, 'shutdown', undefined, 15000); } catch (error) { this.log.write({ level: 'warn', message: error.message }); }
      await Promise.allSettled([...this.pids].map(terminateTree)); this.pids.clear();
      if (this.child === child) child.kill();
    })();
    return this.shutdownPromise;
  }
}
