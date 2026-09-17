import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class SecretStore {
  constructor(directory, safeStorage) { this.directory = directory; this.path = join(directory, 'secrets.json'); this.safeStorage = safeStorage; }
  available() { return this.safeStorage.isEncryptionAvailable() && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
  async get() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (!this.available()) throw new Error('Windows secure storage is unavailable. Your bot token cannot be decrypted.');
      if (value.version !== 1 || typeof value.tokenCiphertext !== 'string') throw new Error('Saved token is damaged. Replace it in Settings.');
      return this.safeStorage.decryptString(Buffer.from(value.tokenCiphertext, 'base64'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async set(token) {
    if (!this.available()) throw new Error('Secure storage is unavailable. Dubplate refuses to store a plaintext token. Sign in to Windows normally and retry.');
    const encrypted = this.safeStorage.encryptString(token);
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, tokenCiphertext: encrypted.toString('base64') }), { mode: 0o600 });
    await rename(temporary, this.path);
  }
  async clear() { await unlink(this.path).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}
