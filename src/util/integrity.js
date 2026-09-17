import { createHash, timingSafeEqual } from 'node:crypto';
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

// Managed executables are checked before each launch, including version probes.
// This also detects a replaced file after a successful download or app startup.
export function verifyExecutable(path, expected) {
  if (!expected) return;
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error('The managed executable checksum is invalid.');
  const descriptor = openSync(path, 'r');
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error('The managed executable is not a regular file.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    if (!timingSafeEqual(hash.digest(), Buffer.from(expected, 'hex'))) {
      throw new Error('Managed executable checksum verification failed. Download it again from the Health panel.');
    }
  } finally { closeSync(descriptor); }
}
