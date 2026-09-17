import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const depth = Number(process.argv[2] || 0);
console.log(JSON.stringify({ pid: process.pid, depth }));
if (depth < 2) {
  spawn(process.execPath, [fileURLToPath(import.meta.url), String(depth + 1)], {
    shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
  });
}
setInterval(() => {}, 1000);
