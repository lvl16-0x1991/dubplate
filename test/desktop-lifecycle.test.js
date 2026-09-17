import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { Collection, Events } from 'discord.js';
import { BotCore, checkHealth, listGuilds, validateToken } from '../src/core/BotCore.js';
import { redact, setLogSecret, setLogSink } from '../src/util/log.js';
import { setProcessSink, stopAllProcesses } from '../src/player/processes.js';

// Execute the production handlers without requiring Electron in Node's test
// runner. Only imports are replaced; lifecycle and IPC code run unchanged.
const source = async (file) => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const workerSource = await source('../desktop/worker.js');
const supervisorSource = (await source('../desktop/supervisor.js')).replace('export class BotSupervisor', 'class BotSupervisor');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function workerFixture(t) {
  const processEvents = new EventEmitter();
  processEvents.parentPort = new EventEmitter();
  const port = new EventEmitter();
  const pending = new Map();
  const instances = [];
  const liveClients = new Set();
  const gates = new Map();
  let id = 0;
  port.start = () => {};
  port.close = () => {};
  port.postMessage = (message) => {
    if (message.kind !== 'response') return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.ok) request.resolve(message.value); else request.reject(new Error(message.error));
  };
  function createCore(config) {
    const timing = gates.get(config.token) || {};
    const client = Object.assign(new EventEmitter(), {
      guilds: { cache: new Collection() }, user: { id: '456789012345678901', tag: config.token },
      login: async () => { liveClients.add(client); queueMicrotask(() => client.emit(Events.ClientReady)); },
      destroy: async () => { await timing.destroy?.promise; liveClients.delete(client); },
    });
    const core = new BotCore(config, {
      validateToken: async () => { await timing.validate?.promise; return { applicationId: '567890123456789012', botId: client.user.id, name: config.token, avatar: null }; },
      createClient: () => client,
    });
    instances.push(core);
    return core;
  }
  runInNewContext(workerSource, {
    BotCore: createCore, checkHealth, listGuilds, validateToken, redact, setLogSecret, setLogSink,
    setProcessSink, stopAllProcesses, process: processEvents, Error,
  }, { filename: 'desktop/worker.js' });
  processEvents.parentPort.emit('message', { ports: [port] });
  t.after(async () => {
    for (const timing of gates.values()) { timing.destroy?.resolve(); timing.validate?.resolve(); }
    await Promise.allSettled(instances.map((core) => core.dispose()));
    setLogSink(() => {}); setProcessSink(() => {});
  });
  return {
    instances, liveClients, gates,
    request(method, args) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        port.emit('message', { data: { id: requestId, method, args } });
      });
    },
  };
}

function supervisorFixture() {
  const timers = [];
  const children = [];
  const killers = [];
  const requests = [];
  let respond = true;
  class Port extends EventEmitter {
    start() {}
    close() {}
    postMessage(message) {
      requests.push({ port: this, message });
      if (respond) queueMicrotask(() => this.reply(message, { status: message.method === 'stop' ? 'stopped' : 'running' }));
    }
    reply(message, value) { this.emit('message', { data: { kind: 'response', id: message.id, ok: true, value } }); }
  }
  const context = {
    EventEmitter, Error, process: { env: {}, platform: 'win32' }, join: (...parts) => parts.join('/'),
    utilityProcess: { fork() {
      const child = new EventEmitter();
      child.postMessage = () => {};
      child.kill = () => { child.killed = true; child.emit('exit', 1); };
      children.push(child); return child;
    } },
    MessageChannelMain: class { constructor() { this.port1 = new Port(); this.port2 = {}; } },
    spawn: () => { const killer = new EventEmitter(); killer.kill = () => {}; killers.push(killer); return killer; },
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
  };
  runInNewContext(`${supervisorSource}\nthis.Supervisor = BotSupervisor;`, context, { filename: 'desktop/supervisor.js' });
  const supervisor = new context.Supervisor('worker.js', { write() {} });
  return { supervisor, children, killers, requests, timers,
    setRespond(value) { respond = value; },
    fire(ms) {
      const timer = timers.find((entry) => entry.ms === ms && !entry.cleared);
      assert.ok(timer, `Expected an active ${ms}ms timer`);
      timer.cleared = true; timer.fn();
    },
  };
}

test('a stop cancels a replacement start that is still disposing the previous core', async (t) => {
  const worker = workerFixture(t);
  const destroy = deferred(); worker.gates.set('old', { destroy });
  await worker.request('startSetup', { token: 'old' });
  const starting = worker.request('startSetup', { token: 'replacement' });
  const result = Promise.allSettled([starting, worker.request('stop')]);
  destroy.resolve();
  const [start, stop] = await result;
  assert.equal(stop.status, 'fulfilled');
  assert.equal(stop.value.status, 'stopped');
  assert.equal(start.status, 'rejected');
  assert.equal(worker.liveClients.size, 0);
});

test('overlapping replacements create only the most recently requested core', async (t) => {
  const worker = workerFixture(t);
  const destroy = deferred(); worker.gates.set('old', { destroy });
  await worker.request('startSetup', { token: 'old' });
  const result = Promise.allSettled([
    worker.request('startSetup', { token: 'superseded' }),
    worker.request('startSetup', { token: 'latest' }),
  ]);
  destroy.resolve();
  const [first, latest] = await result;
  assert.equal(first.status, 'rejected');
  assert.equal(latest.status, 'fulfilled');
  assert.equal(latest.value.identity.name, 'latest');
  assert.equal(worker.liveClients.size, 1);
  await worker.request('stop');
  assert.equal(worker.liveClients.size, 0);
});

test('shutdown cancels a pending replacement instead of creating a core afterward', async (t) => {
  const worker = workerFixture(t);
  const destroy = deferred(); worker.gates.set('old', { destroy });
  await worker.request('startSetup', { token: 'old' });
  const result = Promise.allSettled([
    worker.request('startSetup', { token: 'replacement' }), worker.request('shutdown'),
  ]);
  destroy.resolve();
  const [start, shutdown] = await result;
  assert.equal(shutdown.status, 'fulfilled');
  assert.equal(start.status, 'rejected');
  assert.equal(worker.liveClients.size, 0);
});

test('health and controls stay responsive while startup is waiting on Discord', async (t) => {
  const worker = workerFixture(t);
  const validate = deferred(); worker.gates.set('connecting', { validate });
  const starting = worker.request('startSetup', { token: 'connecting' });
  const rejectedStart = assert.rejects(starting, /cancelled/);
  await nextTurn();
  const health = await worker.request('health', { config: {}, skipBinaryChecks: ['ffmpeg', 'ytdlp', 'node'] });
  assert.equal(health.node.ok, false);
  await assert.rejects(worker.request('control', { action: 'pause', args: {} }), /Start the bot/);
  const stopped = worker.request('stop');
  validate.resolve();
  assert.equal((await stopped).status, 'stopped');
  await rejectedStart;
});

test('crash cleanup cannot report or restart a manually replaced worker', async () => {
  const fixture = supervisorFixture(); const { supervisor } = fixture;
  const events = []; supervisor.on('event', (event) => events.push(event));
  await supervisor.start({ name: 'old' }); supervisor.pids.add(12345);
  const exiting = supervisor.onExit(supervisor.child, 1);
  await supervisor.start({ name: 'replacement' });
  fixture.killers[0].emit('close'); await exiting;
  assert.equal(events.some((event) => event.type === 'supervisor'), false);
  assert.equal(fixture.timers.some((timer) => !timer.cleared && timer.ms === 1000), false);
  assert.equal(fixture.requests.filter(({ message }) => message.method === 'start').length, 2);
});

test('a stop during crash cleanup invalidates the pending recovery', async () => {
  const fixture = supervisorFixture(); const { supervisor } = fixture;
  const events = []; supervisor.on('event', (event) => events.push(event));
  await supervisor.start({}); supervisor.pids.add(12345);
  const exiting = supervisor.onExit(supervisor.child, 1);
  await supervisor.stop(); fixture.killers[0].emit('close'); await exiting;
  assert.equal(events.some((event) => event.type === 'supervisor'), false);
  assert.equal(fixture.timers.some((timer) => !timer.cleared && timer.ms === 1000), false);
});

test('a health request during crash cleanup does not suppress automatic recovery', async () => {
  const fixture = supervisorFixture(); const { supervisor } = fixture;
  await supervisor.start({}); supervisor.pids.add(12345);
  const exiting = supervisor.onExit(supervisor.child, 1);
  await supervisor.request('health', {});
  fixture.killers[0].emit('close'); await exiting;
  fixture.fire(1000); await nextTurn();
  assert.equal(fixture.requests.filter(({ message }) => message.method === 'start').length, 2);
});

test('shutdown permanently rejects later requests without spawning a worker', async () => {
  const fixture = supervisorFixture(); const { supervisor } = fixture;
  await supervisor.start({}); await supervisor.shutdown();
  await assert.rejects(supervisor.request('health', {}), /shutting down/);
  await assert.rejects(supervisor.start({}), /shutting down/);
  assert.equal(fixture.children.length, 1);
  assert.equal(supervisor.desired, false);
});

test('a request waiting for worker creation cannot overtake shutdown', async () => {
  const fixture = supervisorFixture(); const { supervisor } = fixture;
  const reading = assert.rejects(supervisor.request('health', {}), /shutting down|stopped/);
  await supervisor.shutdown(); await reading;
  assert.equal(fixture.requests.some(({ message }) => message.method === 'health'), false);
});

test('startup timeout retires the worker so a late startup cannot remain running', async () => {
  const fixture = supervisorFixture(); const { supervisor } = fixture;
  fixture.setRespond(false);
  const starting = assert.rejects(supervisor.start({}), /too long/);
  await nextTurn(); fixture.fire(100000); await starting;
  assert.equal(fixture.children[0].killed, true);
  assert.equal(supervisor.desired, false);
  assert.equal(supervisor.pending.size, 0);
});

test('shutdown timeout finishes process-tree cleanup before retiring the worker', async () => {
  const fixture = supervisorFixture(); const { supervisor } = fixture;
  await supervisor.start({}); supervisor.pids.add(12345);
  fixture.setRespond(false);
  const shuttingDown = supervisor.shutdown();
  fixture.fire(15000); await nextTurn();
  assert.notEqual(fixture.children[0].killed, true);
  assert.equal(fixture.killers.length, 1);
  fixture.killers[0].emit('close'); await shuttingDown;
  assert.equal(fixture.children[0].killed, true);
});

test('a late startup response cannot override a later stop', async () => {
  const fixture = supervisorFixture(); const { supervisor } = fixture;
  fixture.setRespond(false);
  const starting = assert.rejects(supervisor.start({}), /cancelled/);
  await nextTurn();
  fixture.setRespond(true); await supervisor.stop();
  const request = fixture.requests.find(({ message }) => message.method === 'start');
  request.port.reply(request.message, { status: 'running' }); await starting;
  assert.equal(supervisor.desired, false);
  assert.equal(fixture.timers.some((timer) => !timer.cleared && timer.ms === 60000), false);
});
