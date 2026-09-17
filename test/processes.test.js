import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { activeProcessIds, capture, spawnManaged, stopAllProcesses } from '../src/player/processes.js';

test('cleanup kills the managed parent, child and grandchild on this OS', { timeout: 15000 }, async (t) => {
  t.after(stopAllProcesses);
  const managed = spawnManaged(process.execPath, [fileURLToPath(new URL('./fixtures/process-tree.js', import.meta.url))]);
  let output = '';
  managed.child.stdout.on('data', (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100 && output.trim().split('\n').length < 3; attempt++) await delay(50);
  const pids = output.trim().split('\n').map((line) => JSON.parse(line).pid);
  assert.equal(pids.length, 3, 'fixture should create three processes');
  pids.forEach((pid) => assert.doesNotThrow(() => process.kill(pid, 0)));
  await Promise.all([managed.stop(), managed.stop()]);
  // Reaping adopted descendants can take a short time on Linux.
  for (let attempt = 0; attempt < 30; attempt++) {
    if (pids.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } })) break;
    await delay(100);
  }
  pids.forEach((pid) => assert.throws(() => process.kill(pid, 0), /ESRCH/));
  assert.deepEqual(activeProcessIds(), []);
});

test('capture handles timeout, spawn failure, output bounds and cancellation without leaked processes', { timeout: 30000 }, async () => {
  await assert.rejects(capture('executable-that-does-not-exist-239872', ['--version']), /Cannot execute/);
  await assert.rejects(capture(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { timeoutMs: 200 }), /timed out/);
  await assert.rejects(capture(process.execPath, ['-e', 'console.log("x".repeat(10000))'], { maxBytes: 20 }), /size limit/);
  const controller = new AbortController();
  const pending = capture(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { signal: controller.signal });
  controller.abort(new Error('request cancelled'));
  await assert.rejects(pending, /request cancelled/);
  assert.deepEqual(activeProcessIds(), []);
});
