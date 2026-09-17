import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// This external development fixture is NOT packaged. The app itself never
// listens on a port; the packaging test invokes this separate Node process.
const destination = resolve(process.argv[2]);
const samples = 48000 * 2;
const bytes = Buffer.alloc(44 + samples * 2);
bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
for (let sample = 0; sample < samples; sample++) bytes.writeInt16LE(Math.round(Math.sin(sample * Math.PI * 2 * 440 / 48000) * 7000), 44 + sample * 2);
const server = createServer((request, response) => {
  if (request.url !== '/tone.wav') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length });
  response.end(request.method === 'HEAD' ? undefined : bytes);
});
server.listen(0, '127.0.0.1', async () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(destination, 'smoke-request.json'), JSON.stringify({ origin, fixturePid: process.pid }));
  console.log(`External audio fixture ready: ${origin} pid=${process.pid}`);
});
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
process.on('SIGINT', () => { server.closeAllConnections(); server.close(); });
