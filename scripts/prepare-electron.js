import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Electron 44 supplies an explicit installer rather than a dependency lifecycle
// hook. A headless --omit=dev installation intentionally has no Electron package.
const installer = fileURLToPath(new URL('../node_modules/electron/install.js', import.meta.url));
try { await access(installer); }
catch (error) { if (error.code === 'ENOENT') process.exit(0); throw error; }
const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [installer], { shell: false, windowsHide: true, stdio: 'inherit' });
  child.once('error', reject); child.once('close', resolve);
});
process.exitCode = code ?? 1;
