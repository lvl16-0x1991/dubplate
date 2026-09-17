import { getCiphers } from 'node:crypto';
import { log } from './log.js';

export async function checkOpus() {
  const { default: OpusScript } = await import('opusscript');
  const codec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  try {
    const encoded = codec.encode(Buffer.alloc(960 * 2 * 2), 960);
    if (!codec.decode(encoded).length) throw new Error('Opus codec self-test failed.');
  } finally { codec.delete(); }
  return { ok: true, version: 'opusscript 0.1.1', message: 'PCM encode/decode self-test passed.' };
}

export async function checkDave() {
  if (!getCiphers().includes('aes-256-gcm')) throw new Error('This Node.js build lacks AES-256-GCM. Install the official Node.js 22.12+ Windows/Linux build.');
  const davey = await import('@snazzah/davey');
  const version = davey.DAVE_PROTOCOL_VERSION;
  if (version < 1) throw new Error('DAVE encryption is unavailable. Run npm ci with optional dependencies enabled.');
  const session = new davey.DAVESession(version, '123456789012345678', '234567890123456789');
  try { if (!session.getSerializedKeyPackage().length) throw new Error('DAVE native key package self-test failed.'); }
  finally { session.reset(); }
  return { ok: true, version: `0.1.12 (protocol ${version})`, message: 'Native DAVE key package self-test passed; AES-256-GCM available.' };
}

export async function checkVoiceDependencies() {
  const opus = await checkOpus();
  const dave = await checkDave();
  log.info(`Voice dependencies ready: Opus, native AES-256-GCM, DAVE ${dave.version}`);
  return { opus, dave };
}
