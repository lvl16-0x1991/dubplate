import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rules = [
  ['private-key', /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{40,255})\b/g],
  ['discord-token', /\b(?:mfa\.[A-Za-z0-9_-]{60,}|[A-Za-z0-9_-]{23,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,110})\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['credential-assignment', /(?:DISCORD_TOKEN|GITHUB_TOKEN|API_KEY|CLIENT_SECRET|PASSWORD)\s*[=:]\s*["']?([A-Za-z0-9_+\/.=-]{24,})/gi],
];
export function scanText(text, path = '') {
  const findings = [];
  if (/(?:^|\/)(?:\.env|id_ed25519|id_rsa)$/.test(path)) findings.push({ rule: 'sensitive-file', line: 1 });
  if (text.includes('\0')) return findings;
  for (const [name, regex] of rules) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const value = match[1] || match[0];
      // Explicit human-readable documentation/test fixtures, never a whole-file exclusion.
      if (/^(?:dummy[-_]|test[-_]|example[-_]|placeholder|your[-_]|secret-for-|sensitive-test-)/i.test(value)) continue;
      findings.push({ rule: name, line: text.slice(0, match.index).split('\n').length });
    }
  }
  return findings;
}
function git(args) {
  const result = spawnSync('git', args, { shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}
async function scan() {
  const args = process.argv.slice(2); const staged = args.includes('--staged'); const history = args.includes('--history');
  const ref = args.find((argument) => argument.startsWith('--ref='))?.slice(6);
  if (ref && !/^[A-Za-z0-9_./-]+$/.test(ref)) throw new Error('Invalid history ref.');
  const entries = [];
  if (history) {
    const commits = git(['rev-list', ref || '--all']).trim().split('\n').filter(Boolean);
    const seen = new Set();
    for (const commit of commits) for (const line of git(['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean)) {
      const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(line); if (!match) continue;
      const [, blob, path] = match; const key = `${blob}:${path}`; if (seen.has(key)) continue; seen.add(key);
      entries.push({ source: `${commit.slice(0, 10)}:${path}`, path, text: git(['cat-file', 'blob', blob]) });
    }
  } else if (staged) {
    for (const line of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
      const match = /^\d+ ([0-9a-f]+) \d\t(.+)$/s.exec(line); if (!match) continue;
      entries.push({ source: match[2], path: match[2], text: git(['cat-file', 'blob', match[1]]) });
    }
  } else {
    for (const path of git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
      const text = await readFile(path, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
      entries.push({ source: path, path, text });
    }
  }
  const findings = entries.flatMap((entry) => scanText(entry.text, entry.path).map((finding) => ({ ...finding, source: entry.source })));
  for (const finding of findings) console.error(`${finding.source}:${finding.line}: ${finding.rule} (value redacted)`);
  console.log(`Secret scan: ${entries.length} file versions, ${findings.length} findings (${history ? 'history' : staged ? 'staged tree' : 'working tree'}).`);
  if (findings.length) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await scan();
