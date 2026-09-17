import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../desktop/renderer/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');
const preload = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');

test('renderer page enforces local scripts/styles and refuses inline executable content', () => {
  const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1];
  assert.ok(csp, 'Every renderer document must declare CSP.');
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: https:", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(directive));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [, attributes, body] of scripts) { assert.match(attributes, /\bsrc="[a-z0-9./_-]+\.js"/i); assert.equal(body.trim(), ''); }
  assert.doesNotMatch(html, /\s(?:on[a-z]+|style)\s*=/i);
  assert.doesNotMatch(html, /<style\b|javascript:|<iframe\b|<webview\b/i);
  assert.doesNotMatch(script, /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML\s*\(|document\.write\s*\(|\beval\s*\(|new\s+Function\b/);
});

test('renderer has no Node, storage, network or generic IPC escape hatch', () => {
  assert.doesNotMatch(script, /\brequire\s*\(|\bimport\s*\(|\bipcRenderer\b|\bremote\b|localStorage|sessionStorage|indexedDB|document\.cookie|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|window\.open\s*\(/);
  assert.doesNotMatch(script, /api\s*\[/, 'Only named, explicit preload methods may be invoked.');
  const usedMethods = [...new Set([...script.matchAll(/\bapi\.([A-Za-z]+)\s*\(/g)].map((match) => match[1]))];
  for (const method of usedMethods) assert.match(preload, new RegExp(`\\b${method}:`), `Renderer method ${method} must be exposed by the preload.`);
  assert.ok(usedMethods.includes('control'));
  assert.ok(usedMethods.includes('bootstrap'));
  assert.ok(usedMethods.includes('copyLogs'));
});

test('token fields are masked and executable path is chosen through the trusted picker', () => {
  for (const id of ['setup-token', 'replacement-token']) {
    const input = html.match(new RegExp(`<input[^>]+id="${id}"[^>]*>`))?.[0];
    assert.ok(input); assert.match(input, /type="password"/); assert.match(input, /autocomplete="new-password"/);
    assert.doesNotMatch(input, /\bvalue=/);
  }
  const executable = html.match(/<input[^>]+id="setting-ffmpeg"[^>]*>/)?.[0];
  assert.match(executable, /\breadonly\b/);
  assert.match(script, /api\.chooseFfmpeg\(/);
  assert.match(script, /input\.value = '';/, 'Successful setup token submission clears the field.');
  assert.match(script, /\$\('replacement-token'\)\.value = '';/);
});

test('renderer static element references resolve and queue supports keyboard movement', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Element IDs must be unique.');
  for (const [, id] of script.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(id), `Missing element: ${id}`);
  for (const [, id] of script.matchAll(/\bon\('([^']+)'/g)) assert.ok(ids.includes(id), `Missing event target: ${id}`);
  assert.match(script, /queueButton\('arrow-up'/); assert.match(script, /queueButton\('arrow-down'/);
  assert.match(script, /setAttribute\('aria-label'/);
  assert.match(html, /<dialog[^>]+id="setup-dialog"[^>]+aria-labelledby=/);
  assert.match(html, /<dialog[^>]+id="confirm-dialog"[^>]+aria-labelledby=/);
});

test('first-run setup keeps hardening optional and clipboard access behind the Paste action', () => {
  const firstStep = html.match(/<section class="setup-step" data-step="0">([\s\S]*?)<\/section>/)?.[1];
  const instructions = firstStep?.match(/<ol class="instructions setup-instructions">([\s\S]*?)<\/ol>/)?.[1];
  assert.ok(instructions);
  assert.equal([...instructions.matchAll(/<li>/g)].length, 3);
  assert.doesNotMatch(instructions, /Public Bot|Install Link/);
  assert.doesNotMatch(firstStep, /Install Link|Public Bot/, 'optional hardening belongs in the README');
  assert.equal([...html.matchAll(/<section class="setup-step"/g)].length, 5);
  assert.equal([...script.matchAll(/api\.pasteToken\(/g)].length, 1);
  assert.match(script, /on\('paste-token', 'click',[^\n]+api\.pasteToken\(/);
  assert.doesNotMatch(script, /navigator\.clipboard|clipboard\.read/);
  assert.match(preload, /userActivation\?\.isActive/);
});

test('setup uses gateway events, background tool recovery and an explicit voice test', () => {
  for (const method of ['prepareSetup', 'beginGuildDiscovery', 'listVoiceChannels', 'testVoice', 'chooseYtdlp']) assert.match(script, new RegExp(`api\\.${method}\\(`));
  for (const event of ['setupTools', 'guildDiscovery', 'voiceTest']) assert.match(script, new RegExp(`case '${event}'`));
  assert.doesNotMatch(script, /guildPoll|setInterval\([^\n]*fetchGuilds/);
  assert.match(html, /id="setup-tools-recovery"[^>]+hidden/);
  assert.match(html, /id="setup-test-voice"/);
  assert.match(html, /id="health-test-voice"/);
  assert.match(script, /model\.voicePassedKey === model\.settings\.guildId/);
  assert.match(script, /await api\.testVoice\(\{ voiceChannelId: channelId \}\)/);
});
