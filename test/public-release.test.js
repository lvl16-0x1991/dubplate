import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (name) => readFile(join(root, name), 'utf8');

test('public source excludes private app data, credentials, generated installers and downloaded executables', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.length > 20);
  const forbidden = files.filter((file) => {
    const normalized = file.replaceAll('\\', '/');
    const leaf = normalized.split('/').at(-1);
    return (leaf.startsWith('.env') && leaf !== '.env.example') ||
      /(?:^|\/)(?:node_modules|dist|userData|userdata|appData|app-data|logs|verification)(?:\/|$)/i.test(normalized) ||
      /^build\/runtime\//i.test(normalized) ||
      /^(?:settings|secrets|verified-binaries)\.json$/i.test(leaf) ||
      /\.(?:exe|dll|node|msi|zip|7z|dmp|log)$/i.test(leaf);
  });
  assert.deepEqual(forbidden, [], 'private/generated files must stay outside the public source');
});

test('desktop dependencies are exact, installer selects source files and bundles only the Node runtime', async () => {
  const pkg = JSON.parse(await read('package.json'));
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must use an exact dependency version`);
  }
  const config = await read('electron-builder.yml');
  const resources = config.split(/^extraResources:\s*$/m)[1]?.split(/^\S/m)[0];
  assert.ok(resources, 'extraResources must explicitly enumerate the bundled runtime');
  assert.match(resources, /from: build\/runtime/);
  assert.match(resources, /- node\.exe/);
  assert.match(resources, /- runtime\.json/);
  assert.doesNotMatch(resources, /yt-dlp|ffmpeg|userData|secrets|\.env/);
  assert.match(config, /perMachine: false/);
  assert.match(config, /allowElevation: false/);
  assert.match(config, /'!\*\*\/\.env\*'/);
});

test('release and CI workflows pin actions, isolate optional signing secrets and publish installer plus checksum', async () => {
  const ci = await read('.github/workflows/ci.yml');
  const release = await read('.github/workflows/release.yml');
  for (const source of [ci, release]) {
    const actions = [...source.matchAll(/^\s*uses:\s*(\S+)/gm)].map((match) => match[1]);
    assert.ok(actions.length > 0);
    for (const action of actions) assert.match(action, /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/, `Action ${action} must be pinned to its full SHA`);
    assert.doesNotMatch(source, /pull_request_target|write-all/);
    assert.match(source, /npm ci/);
    assert.match(source, /npm run check/);
    assert.match(source, /npm test/);
    assert.match(source, /npm run scan:secrets/);
  }
  assert.doesNotMatch(ci, /secrets\./, 'CI must not need any repository secrets');
  const build = release.split(/^  build:/m)[1]?.split(/^  sign:/m)[0];
  const signing = release.split(/^  sign:/m)[1]?.split(/^  publish:/m)[0];
  const publishing = release.split(/^  publish:/m)[1];
  assert.ok(build && signing && publishing, 'build, optional signing and publication use separate jobs');
  assert.doesNotMatch(build, /secrets\./, 'npm and build tools must not receive signing secrets');
  assert.doesNotMatch(publishing, /secrets\./, 'publishing uses only the automatic GitHub token');
  const expectedSecrets = ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_SIGNING_ACCOUNT_NAME', 'AZURE_SIGNING_CERTIFICATE_PROFILE', 'AZURE_SIGNING_ENDPOINT', 'AZURE_TENANT_ID'];
  assert.deepEqual([...new Set([...signing.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]))].sort(), expectedSecrets);
  assert.match(signing, /if: steps\.signing\.outputs\.enabled == 'true'/);
  assert.doesNotMatch(signing, /continue-on-error|id-token: write|contents: write/);
  assert.match(signing, /exclude-azure-cli-credential: true/);
  assert.match(signing, /Get-AuthenticodeSignature/);
  assert.match(signing, /TimeStamperCertificate/);
  assert.ok(signing.indexOf('Sign installer with Azure Artifact Signing') < signing.indexOf('Verify signed installer and timestamp'));
  assert.ok(signing.indexOf('Verify signed installer and timestamp') < signing.indexOf('Create installer checksum'));
  assert.match(publishing, /needs: sign/);
  assert.match(ci, /windows-latest, ubuntu-latest/);
  assert.match(release, /tags: \['v\*'\]/);
  assert.match(release, /npm run dist/);
  assert.match(release, /Get-FileHash.*-Algorithm SHA256/);
  assert.match(release, /contents: read/);
  assert.match(release, /contents: write/);
  const uploads = release.split(/name: Preserve only installer and checksum/)[1]?.split(/^  publish:/m)[0];
  assert.ok(uploads);
  assert.match(uploads, /dist\/Dubplate-Setup-\*\.exe/);
  assert.match(uploads, /dist\/SHA256SUMS/);
  assert.doesNotMatch(uploads, /dist\/\*\*|path:\s*dist\s*$/m);
  assert.match(release, /release\/Dubplate-Setup-\*\.exe/);
  assert.match(release, /release\/SHA256SUMS/);
});

test('actual signing gate supports no secrets, partial configuration, complete configuration and fail-closed validation', async (t) => {
  const source = (await read('.github/workflows/release.yml')).replaceAll('\r\n', '\n');
  const section = source.split('      - name: Choose optional signing mode')[1]?.split('      - name: Select the single installer')[0];
  assert.ok(section);
  const run = section.split('        run: |\n')[1];
  assert.ok(run, 'the signing gate must remain a testable Node script');
  const script = run.split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const directory = await mkdtemp(join(tmpdir(), 'dubplate-signing-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configured = {
    AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    AZURE_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
    AZURE_CLIENT_SECRET: 'dummy-test-client-secret-value',
    AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
    AZURE_SIGNING_ACCOUNT_NAME: 'test-signing-account',
    AZURE_SIGNING_CERTIFICATE_PROFILE: 'test-public-trust-profile',
  };
  const baseEnv = { ...process.env };
  for (const key of Object.keys(configured)) delete baseEnv[key];
  let number = 0;
  async function gate(values) {
    const output = join(directory, `output-${++number}.txt`);
    const summary = join(directory, `summary-${number}.txt`);
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...baseEnv, ...values, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8', maxBuffer: 65536 });
    return { ...result, output: await readFile(output, 'utf8').catch(() => ''), summary: await readFile(summary, 'utf8').catch(() => '') };
  }
  const absent = await gate({});
  assert.equal(absent.status, 0); assert.equal(absent.output.trim(), 'enabled=false'); assert.match(absent.summary, /unsigned.*not set/);
  const partial = await gate({ AZURE_CLIENT_SECRET: configured['AZURE_CLIENT_SECRET'] });
  assert.equal(partial.status, 0); assert.equal(partial.output.trim(), 'enabled=false'); assert.match(partial.summary, /incomplete/);
  const enabled = await gate(configured);
  assert.equal(enabled.status, 0); assert.equal(enabled.output.trim(), 'enabled=true'); assert.match(enabled.summary, /failure will stop/);
  for (const values of [
    { ...configured, AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net.evil.example/' },
    { ...configured, AZURE_SIGNING_ENDPOINT: 'http://eus.codesigning.azure.net/' },
    { ...configured, AZURE_CLIENT_ID: 'not-a-guid' },
  ]) {
    const invalid = await gate(values);
    assert.notEqual(invalid.status, 0); assert.equal(invalid.output, '', 'invalid fully configured signing must not fall back to unsigned');
  }
  for (const result of [absent, partial, enabled]) assert.ok(!(result.stdout + result.stderr + result.summary).includes(configured.AZURE_CLIENT_SECRET));
});
