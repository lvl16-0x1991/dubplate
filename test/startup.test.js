import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function startup(overrides) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], {
    shell: false, windowsHide: true,
    env: { ...process.env, DISCORD_TOKEN: '', GUILD_ID: '', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, output };
}

test('startup fails clearly for missing credentials and missing binaries without stack traces', { timeout: 15000 }, async () => {
  for (const [env, expected] of [
    [{}, /DISCORD_TOKEN is missing/],
    [{ DISCORD_TOKEN: 'dummy-test-secret' }, /GUILD_ID is missing/],
    [{ DISCORD_TOKEN: 'dummy-test-secret', GUILD_ID: '123456789012345678', FFMPEG_PATH: 'nonexistent-ffmpeg-928723' }, /Cannot execute.*Check PATH/],
    [{ DISCORD_TOKEN: 'dummy-test-secret', GUILD_ID: '123456789012345678', FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg', YT_DLP_PATH: 'nonexistent-ytdlp-928723' }, /Cannot execute.*Check PATH/],
  ]) {
    const result = await startup(env);
    assert.equal(result.code, 1);
    assert.match(result.output, expected);
    assert.doesNotMatch(result.output, /dummy-test-secret|\n\s+at |Assertion failed/);
  }
});

test('headless global error handlers redact errors and keep subsequent work alive', { timeout: 10000 }, async () => {
  const entryUrl = new URL('../src/index.js', import.meta.url).href;
  const logUrl = new URL('../src/util/log.js', import.meta.url).href;
  const source = `
    import { installHeadlessErrorHandlers } from ${JSON.stringify(entryUrl)};
    import { setLogSink, setLogSecret } from ${JSON.stringify(logUrl)};
    setLogSecret('private-handler-test-token');
    setLogSink((entry) => process.stdout.write(JSON.stringify(entry) + '\\n'));
    installHeadlessErrorHandlers();
    setTimeout(() => { throw new Error('private-handler-test-token'); }, 0);
    setTimeout(() => { void Promise.reject(new Error('private-handler-test-token')); }, 20);
    setTimeout(() => { process.stdout.write('subsequent work completed\\n'); }, 80);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, output);
  assert.match(output, /Uncaught exception; process remains running: \[REDACTED\]/);
  assert.match(output, /Unhandled rejection; process remains running: \[REDACTED\]/);
  assert.match(output, /subsequent work completed/);
  assert.doesNotMatch(output, /private-handler-test-token|Shutting down|Startup failed/);
});
