import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Original three-note confirmation sound, synthesized here without samples.
// A short fade at both ends of each note avoids clicks; keep the level modest.
const rate = 48000;
const seconds = 2.1;
const samples = Math.round(rate * seconds);
const data = Buffer.alloc(44 + samples * 4);
data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 4, 28); data.writeUInt16LE(4, 32);
data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 4, 40);
const notes = [440, 554.365, 659.255];
for (let sample = 0; sample < samples; sample++) {
  const time = sample / rate;
  const note = Math.min(2, Math.floor(time / 0.7));
  const local = time - note * 0.7;
  const envelope = Math.max(0, Math.min(1, local / 0.03, (0.62 - local) / 0.12));
  const amplitude = Math.round(5000 * envelope * Math.sin(2 * Math.PI * notes[note] * local));
  data.writeInt16LE(amplitude, 44 + sample * 4); data.writeInt16LE(amplitude, 46 + sample * 4);
}
const destination = new URL('../build/voice-test.wav', import.meta.url);
await mkdir(fileURLToPath(new URL('../build/', import.meta.url)), { recursive: true });
await writeFile(destination, data);
console.log(`Generated original 2.1-second stereo test tone (${data.length} bytes).`);
