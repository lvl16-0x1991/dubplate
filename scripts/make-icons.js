import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../build/', import.meta.url));
function crc(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); } return (value ^ 0xffffffff) >>> 0; }
function chunk(name, data) { const buffer = Buffer.alloc(data.length + 12); buffer.writeUInt32BE(data.length); buffer.write(name, 4); data.copy(buffer, 8); buffer.writeUInt32BE(crc(buffer.subarray(4, -4)), buffer.length - 4); return buffer; }
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + .5) * 256 / size, v = (y + .5) * 256 / size;
    const cornerX = Math.max(56 - u, 0, u - 200), cornerY = Math.max(56 - v, 0, v - 200);
    const visible = cornerX * cornerX + cornerY * cornerY <= 56 * 56;
    const note = ((u - 89) / 25) ** 2 + ((v - 174) / 20) ** 2 <= 1 || ((u - 157) / 25) ** 2 + ((v - 155) / 20) ** 2 <= 1
      || (u >= 95 && u <= 113 && v >= 78 && v <= 174) || (u >= 163 && u <= 181 && v >= 64 && v <= 155)
      || (u >= 95 && u <= 181 && Math.abs(v - (78 - (u - 104) * 14 / 68)) <= 9);
    const index = y * (size * 4 + 1) + 1 + x * 4;
    raw.set(note ? [180, 160, 255, 255] : [23, 23, 31, visible ? 255 : 0], index);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
await mkdir(root, { recursive: true });
await writeFile(new URL('../build/icon.png', import.meta.url), png(256));
const sizes = [16, 32, 48, 64, 128, 256]; const images = sizes.map(png); const ico = Buffer.alloc(6 + sizes.length * 16);
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(sizes.length, 4); let offset = ico.length;
for (const [index, size] of sizes.entries()) { const at = 6 + index * 16; ico[at] = size % 256; ico[at + 1] = size % 256; ico.writeUInt16LE(1, at + 4); ico.writeUInt16LE(32, at + 6); ico.writeUInt32LE(images[index].length, at + 8); ico.writeUInt32LE(offset, at + 12); offset += images[index].length; }
await writeFile(new URL('../build/icon.ico', import.meta.url), Buffer.concat([ico, ...images]));
console.log('Generated original Dubplate PNG and ICO assets.');
