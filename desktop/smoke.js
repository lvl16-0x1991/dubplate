import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runPackagedSmoke({ app, window, supervisor, binaries, settings, setupTools, output }) {
  const request = JSON.parse(await readFile(join(output, 'smoke-request.json'), 'utf8'));
  if (typeof request.origin !== 'string') throw new Error('Smoke fixture origin missing.');
  setupTools.prepare();
  await setupTools.pending;
  if (setupTools.snapshot().status !== 'ready') throw new Error(setupTools.snapshot().message);
  const paths = await binaries.resolvePaths({ ffmpegPath: settings.value.ffmpegPath });
  const worker = await supervisor.request('smoke', { config: { ...settings.snapshot(), ...paths,
    voiceTestTonePath: fileURLToPath(new URL('../build/voice-test.wav', import.meta.url)) }, origin: request.origin });
  if (window.webContents.isLoading()) await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const check = () => {
      if (document.getElementById('setup-tools-status-text')?.textContent === 'Playback tools are ready.') return resolve();
      if (Date.now() > deadline) return reject(new Error('The wizard did not show completed background preparation.'));
      setTimeout(check, 50);
    };
    check();
  })`);
  const renderer = await window.webContents.executeJavaScript(`({
    title: document.title,
    wizardVisible: document.getElementById('setup-dialog')?.open === true,
    hasApi: typeof window.dubplate?.bootstrap === 'function',
    setupSteps: document.querySelectorAll('section.setup-step').length,
    discordInstructions: document.querySelectorAll('.setup-instructions > li').length,
    pasteButton: Boolean(document.getElementById('paste-token')),
    voiceTestButton: Boolean(document.getElementById('setup-test-voice')),
    toolsStatus: document.getElementById('setup-tools-status-text')?.textContent,
    nodeUnavailable: typeof window.require === 'undefined' && typeof window.process === 'undefined',
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content,
    bodyText: document.body.innerText.slice(0, 600)
  })`);
  const preferences = window.webContents.getLastWebPreferences();
  const report = { packaged: app.isPackaged, mainPid: process.pid, worker, renderer, setupTools: setupTools.snapshot(),
    security: { contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox,
      nodeIntegration: preferences.nodeIntegration, webSecurity: preferences.webSecurity },
    processes: app.getAppMetrics().map(({ pid, type, name }) => ({ pid, type, name })) };
  await writeFile(join(output, 'smoke-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(output, 'wizard.png'), (await window.webContents.capturePage()).toPNG());
}
