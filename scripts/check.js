import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function find(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? find(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat().filter((file) => /\.(?:js|cjs|mjs)$/.test(file));
}
const files = (await Promise.all(['src', 'desktop', 'scripts', 'test'].map((directory) => find(join(root, directory))))).flat();
for (const file of files) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], { shell: false, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) process.exit(1);
}
console.log(`Syntax OK: ${files.length} JavaScript files.`);
