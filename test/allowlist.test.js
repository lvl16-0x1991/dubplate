import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ALLOWED_HOSTS, normalizeQuery, requireAllowedUrl, validateAllowedHosts } from '../src/util/validation.js';
import { prewarm, resolve, startPipeline, tracksFromMetadata } from '../src/player/ytdlp.js';
import { activeProcessIds } from '../src/player/processes.js';
import { createLoopbackTestBackend } from '../src/testing/loopback.js';

const rejected = [
  'http://127.0.0.1/song', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/',
  'http://[::1]/', 'http://[fd00::123]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/',
  'http://localhost/', 'http://sub.localhost/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/',
  'https://youtube.com.evil.tld/', 'https://evilyoutube.com/', 'https://youtube.com.evil.tld./',
  'https://youtube.com@127.0.0.1/', 'https://127.0.0.1@youtube.com/', 'https://evil:password@youtube.com/',
  'https://@youtube.com/', 'https://youtube.com:444/', 'https://youtube.com:80/', 'http://youtube.com:443/',
  'https://youtube.com./', 'https://youtube.com\\@evil.example/', 'file:///etc/passwd', 'https:youtube.com',
];

test('host policy rejects private addresses, encoded IPs, userinfo, ports and hostname suffix tricks', () => {
  for (const input of rejected) assert.throws(() => requireAllowedUrl(input), undefined, input);
  for (const input of rejected.filter((value) => /^https?:\/\//.test(value))) assert.throws(() => normalizeQuery(input), undefined, input);
});

test('host policy accepts exact allowed domains and real subdomains using the default port', () => {
  for (const input of [
    'https://youtube.com/watch?v=abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk',
    'https://music.youtube.com/', 'https://m.youtube.com/', 'https://youtu.be/abcdefghijk',
    'https://soundcloud.com/artist/track', 'https://artist.bandcamp.com/track/song',
    'HTTPS://WWW.YOUTUBE.COM:443/watch?v=abcdefghijk', 'http://youtube.com:80/',
  ]) assert.equal(requireAllowedUrl(input), new URL(input).href);
  assert.deepEqual(validateAllowedHosts(['YOUTUBE.com', 'youtube.com', ' example.org ']), ['youtube.com', 'example.org']);
  assert.equal(requireAllowedUrl('https://media.example.org/song', ['example.org']), 'https://media.example.org/song');
  assert.throws(() => requireAllowedUrl('https://example.org/song'), /allowed music hosts/);
  assert.equal(DEFAULT_ALLOWED_HOSTS.length, 5);
});

test('editable host list rejects URL syntax, wildcards, local names and address encodings', () => {
  for (const host of ['localhost', 'foo.localhost', 'test.local', '127.0.0.1', '2130706433', '0x7f000001', '[::1]',
    '*.youtube.com', '.youtube.com', 'youtube.com.', 'https://youtube.com', 'youtube.com:443', 'user@youtube.com',
    'youtube.com/path', '-bad.example', 'bad-.example']) assert.throws(() => validateAllowedHosts([host]), undefined, host);
  for (const value of [[], null, 'youtube.com', Array(101).fill('youtube.com')]) assert.throws(() => validateAllowedHosts(value));
});

test('all production extraction paths reject an unsafe URL before any child process exists', async () => {
  const config = { ytdlpPath: 'must-never-be-launched', ffmpegPath: 'must-never-be-launched' };
  for (const url of rejected.filter((value) => /^https?:\/\//.test(value))) {
    await assert.rejects(resolve(config, url, { limit: 1 }), (error) => !error.message.includes('Cannot execute'));
    await assert.rejects(prewarm(config, { url }), (error) => !error.message.includes('Cannot execute'));
    assert.throws(() => startPipeline(config, { url }, 0, () => {}), (error) => !error.message.includes('Cannot execute'));
    assert.deepEqual(activeProcessIds(), []);
  }
});

test('extractor metadata cannot sneak disallowed URLs into the queue or select an unsafe fallback', () => {
  const tracks = tracksFromMetadata({ entries: [
    { title: 'valid', webpage_url: 'https://artist.bandcamp.com/track/song', uploader: 'artist', thumbnail: 'https://example.org/image.jpg' },
    ...rejected.map((url) => ({ title: 'unsafe', webpage_url: url })),
  ] }, { limit: 200, requesterName: 'listener' });
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].title, 'valid');
  assert.equal(tracks[0].uploader, 'artist');
  assert.equal(tracks[0].requesterName, 'listener');
  assert.deepEqual(tracksFromMetadata({ title: 'unknown' }, { fallback: 'http://127.0.0.1/' }), []);
});

test('test adapter only accepts its exact loopback fixture and is not a serializable configuration bypass', () => {
  const backend = createLoopbackTestBackend('http://127.0.0.1:34567');
  assert.equal(backend.normalizeQuery('http://127.0.0.1:34567/tone.wav', {}), 'http://127.0.0.1:34567/tone.wav');
  for (const url of ['http://127.0.0.1:34568/tone.wav', 'http://10.0.0.1:34567/tone.wav', 'http://user@127.0.0.1:34567/tone.wav']) {
    assert.throws(() => backend.normalizeQuery(url, {}), /outside/);
  }
  assert.throws(() => createLoopbackTestBackend('http://10.0.0.1:1234'));
  assert.throws(() => startPipeline({ allowedHosts: ['127.0.0.1'], testUrlPolicy: true }, { url: 'http://127.0.0.1:34567/tone.wav' }, 0, () => {}));
});
