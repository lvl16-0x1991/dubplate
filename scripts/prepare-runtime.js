import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// This verified Node runtime is the ONLY executable included with the app.
// yt-dlp and ffmpeg are downloaded by the installed app, never bundled.
const version = '24.21.0';
const destination = fileURLToPath(new URL('../build/runtime/', import.meta.url));
const executableUrl = `https://nodejs.org/dist/v${version}/win-x64/node.exe`;
const checksumUrl = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
async function download(url, maximum) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['nodejs.org', 'raw.githubusercontent.com'].includes(parsed.hostname)) throw new Error('Runtime source blocked.');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}`);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length > maximum) throw new Error('Runtime download exceeds size limit.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
await mkdir(destination, { recursive: true });
const sums = (await download(checksumUrl, 1024 * 1024)).toString('utf8');
const sha256 = sums.split(/\r?\n/).find((line) => line.trim().endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error('Official Node checksum is missing.');
const path = join(destination, 'node.exe');
const previous = await readFile(path).catch(() => null);
if (!previous || createHash('sha256').update(previous).digest('hex') !== sha256) {
  const bytes = await download(executableUrl, 150 * 1024 * 1024);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Official Node checksum did not match.');
  await writeFile(`${path}.tmp`, bytes); await rename(`${path}.tmp`, path);
}
await writeFile(join(destination, 'runtime.json'), JSON.stringify({ version, sha256, source: executableUrl }, null, 2));
await writeFile(join(destination, 'LICENSE.txt'), await download(`https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`, 2 * 1024 * 1024));
console.log(`Verified bundled Node ${version} (${sha256}).`);
