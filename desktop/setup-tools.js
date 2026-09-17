// Download work intentionally lives outside the main IPC mutation queue so the
// owner can enter a token and invite the bot while verified tools are arriving.
export class SetupTools {
  constructor({ binaries, getSettings, persistFfmpeg, checkHealth, publish }) {
    Object.assign(this, { binaries, getSettings, persistFfmpeg, checkHealth, publish });
    this.value = { status: 'idle', health: {}, message: '' };
    this.pending = null;
  }
  snapshot() { return structuredClone(this.value); }
  update(value) { this.value = { ...this.value, ...value }; this.publish(this.snapshot()); }
  prepare() {
    if (this.pending || this.value.status === 'ready') return this.snapshot();
    this.update({ status: 'preparing', message: 'Preparing playback tools in the background.' });
    this.pending = this.run().catch((error) => this.update({ status: 'error', message: error.message }))
      .finally(() => { this.pending = null; });
    return this.snapshot();
  }
  async run() {
    const tools = await this.binaries.ensureEssentials({ ffmpegPath: this.getSettings().ffmpegPath });
    if (tools.ffmpeg?.ok && tools.ffmpegPath) await this.persistFfmpeg(tools.ffmpegPath);
    const health = await this.checkHealth();
    const failed = ['ytdlp', 'ffmpeg', 'node', 'opus', 'dave'].filter((name) => !health[name]?.ok);
    this.update({ status: failed.length ? 'error' : 'ready', health,
      message: failed.length ? failed.map((name) => `${name}: ${tools[name]?.message || health[name]?.message || 'Check failed.'}`).join(' ') : 'Playback tools are ready.' });
  }
  async recheck() {
    if (this.pending) await this.pending;
    const health = await this.checkHealth();
    const failed = ['ytdlp', 'ffmpeg', 'node', 'opus', 'dave'].filter((name) => !health[name]?.ok);
    this.update({ health, status: failed.length ? 'error' : 'ready', message: failed.length ? 'Some playback tools still need attention.' : 'Playback tools are ready.' });
    return this.snapshot();
  }
}
