import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from '../scripts/scan-secrets.js';

test('secret scan finds realistic token/key shapes without disclosing values', () => {
  const github = 'ghp_' + 'a1B2'.repeat(10);
  const discord = 'A'.repeat(24) + '.' + 'B'.repeat(6) + '.' + 'cD1'.repeat(10);
  const key = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';
  for (const value of [github, discord, key]) { const findings = scanText(value, 'source.js'); assert.equal(findings.length, 1); assert.ok(!JSON.stringify(findings).includes(value)); }
  assert.equal(scanText('', '.env').length, 1);
  assert.equal(scanText('DISCORD_TOKEN=', '.env.example').length, 0);
  assert.equal(scanText('DISCORD_TOKEN=dummy-token-for-startup-verification', 'test/startup.test.js').length, 0);
});
