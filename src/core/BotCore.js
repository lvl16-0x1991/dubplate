import { EventEmitter } from 'node:events';
import { open, readdir } from 'node:fs/promises';
import { ChannelType, Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
import { GuildPlayer } from '../player/GuildPlayer.js';
import { checkFfmpeg, checkNode, checkYtdlp } from '../player/ytdlp.js';
import { stopAllProcesses } from '../player/processes.js';
import { validateConfig } from '../util/config.js';
import { log, redact, setLogSecret, subscribeLogs } from '../util/log.js';
import { replyError } from '../util/replies.js';
import { checkDave, checkOpus } from '../util/runtime.js';
import { normalizeQuery, requireTrack, UserError } from '../util/validation.js';
import { voiceChannelProblems } from '../player/voiceChecks.js';

function discordRest(token) {
  if (typeof token !== 'string' || !token.trim() || token.length > 512 || /\s/.test(token.trim())) throw new UserError('Enter a valid Discord bot token.');
  setLogSecret(token.trim());
  return new REST({ version: '10', timeout: 15000, retries: 0 }).setToken(token.trim());
}

function discordFailure(error, purpose) {
  if (error.status === 401 || error.code === 50014) return new UserError('The bot token is invalid or has been reset. Copy a new token from Developer Portal → Bot → Reset Token.');
  if (error.status === 403) return new UserError('Discord denied access. Check the bot application and its server permissions.');
  if (error.status === 429) return new UserError('Discord is rate limiting requests. Wait a minute and try again.');
  return new UserError(`Could not ${purpose} with Discord. Check the network connection and try again.`);
}

export async function validateToken(token) {
  const rest = discordRest(token);
  try {
    const [application, bot] = await Promise.all([rest.get(Routes.oauth2CurrentApplication()), rest.get(Routes.user())]);
    if (!bot.bot) throw new UserError('This is not a Discord bot token. Use the token from Developer Portal → Bot.');
    return { applicationId: application.id, botId: bot.id, name: bot.global_name || bot.username,
      avatar: bot.avatar ? `https://cdn.discordapp.com/avatars/${bot.id}/${bot.avatar}.png?size=128` : null };
  } catch (error) { if (error instanceof UserError) throw error; throw discordFailure(error, 'validate the token'); }
}

export async function listGuilds(token) {
  const rest = discordRest(token);
  const guilds = [];
  let after;
  try {
    do {
      const query = new URLSearchParams({ limit: '200', ...(after ? { after } : {}) });
      const page = await rest.get(Routes.userGuilds(), { query });
      guilds.push(...page.map((guild) => ({ id: guild.id, name: guild.name,
        icon: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : null })));
      if (page.length < 200) break;
      after = page.at(-1).id;
    } while (guilds.length < 10000);
    return guilds.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) { throw discordFailure(error, 'list the bot’s servers'); }
}

export async function checkHealth(input, { skipBinaryChecks = [] } = {}) {
  if (!Array.isArray(skipBinaryChecks) || skipBinaryChecks.some((name) => !['ffmpeg', 'ytdlp', 'node'].includes(name))) {
    throw new TypeError('Invalid skipped binary health checks.');
  }
  const config = validateConfig(input || {}, { requireCredentials: false });
  const health = {};
  for (const [name, check] of [['ffmpeg', checkFfmpeg], ['ytdlp', checkYtdlp], ['node', checkNode], ['opus', checkOpus], ['dave', checkDave]]) {
    if (skipBinaryChecks.includes(name)) {
      health[name] = { ok: false, version: null, message: 'This executable has not been verified by the binary manager.' };
      continue;
    }
    try { health[name] = await check(config); }
    catch (error) { health[name] = { ok: false, version: null, message: redact(error.message) }; }
  }
  return health;
}

function trackSnapshot(track) {
  if (!track) return null;
  return { id: track.id ?? null, title: String(track.title || 'Untitled track'), url: track.url || null,
    thumbnail: track.thumbnail || null, uploader: String(track.uploader || ''),
    requesterName: String(track.requesterName || track.requesterId || 'Desktop'),
    duration: track.duration ?? null, isLive: track.isLive === true };
}

function guildSnapshot(guild) {
  return { id: guild.id, name: guild.name,
    icon: guild.iconURL?.({ size: 64 }) || (guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : null) };
}

export class BotCore extends EventEmitter {
  static validateToken = validateToken;
  static listGuilds = listGuilds;
  static checkHealth = checkHealth;

  constructor(config, services = {}) {
    super();
    this.config = validateConfig(config, { requireCredentials: false });
    if (!this.config.token) throw new UserError('DISCORD_TOKEN is missing. Enter a bot token before setup.');
    this.services = { validateToken, createClient: (options) => new Client(options), ...services };
    if (typeof this.services.validateToken !== 'function' || typeof this.services.createClient !== 'function') throw new TypeError('Core services must be functions.');
    this.players = new Map();
    this.client = null;
    this.status = 'stopped';
    this.generation = 0;
    this.health = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.setupMode = false;
    this.identity = null;
    this.gatewayReady = false;
    this.guildPolicyTail = Promise.resolve();
    this.departedGuilds = new Set();
    this.voiceTestPromise = null;
    this.on('error', () => {}); // Error reports are data even without a UI subscriber.
    this.unsubscribeLogs = subscribeLogs((entry) => this.emit('log', entry));
  }

  snapshot() {
    const guild = this.client?.guilds.cache.get(this.config.guildId);
    const player = this.players.get(this.config.guildId);
    const voiceChannel = guild?.channels.cache.get(player?.channelId);
    const channels = guild ? [...guild.channels.cache.values()]
      .filter((channel) => channel.type === ChannelType.GuildVoice)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((channel) => ({ id: channel.id, name: channel.name,
        listeners: guild.voiceStates.cache.filter((state) => state.channelId === channel.id && state.id !== this.client.user.id && !state.member?.user.bot).size,
        ...voiceChannelProblems(channel, guild) })) : [];
    const listeners = player?.channelId && guild ? guild.voiceStates.cache.filter((state) => state.channelId === player.channelId
      && state.id !== this.client.user.id && !state.member?.user.bot).size : 0;
    return {
      status: this.status,
      guild: guild ? guildSnapshot(guild) : { id: this.config.guildId, name: '', icon: null },
      identity: this.identity, setupMode: this.setupMode,
      setupGuilds: this.client ? [...this.client.guilds.cache.values()].map(guildSnapshot).sort((a, b) => a.name.localeCompare(b.name)) : [],
      voice: { channelId: player?.channelId || null, name: voiceChannel?.name || '', listeners,
        idleDeadline: player?.idleDeadline ?? null, aloneDeadline: player?.aloneDeadline ?? null },
      current: trackSnapshot(player?.current), elapsed: player?.current ? player.elapsed : 0,
      playbackStatus: player?.statusLabel || 'Idle', queue: (player?.queue || []).map(trackSnapshot),
      volume: Math.round((player?.volume ?? this.config.defaultVolume) * 100), loop: player?.loop || 'off', channels,
    };
  }

  emitState() { this.emit('state', this.snapshot()); }

  reportError(error, context = 'Bot error') {
    log.error(context, error);
    this.emit('error', { message: redact(error?.message || error || context), context });
  }

  playerFor(guild) {
    if (!this.players.has(guild.id)) {
      const player = new GuildPlayer(guild, this.config);
      player.on('changed', () => this.emitState());
      player.on('trackStart', ({ track, offset }) => { this.emit('trackStart', { track: trackSnapshot(track), offset }); this.emitState(); });
      player.on('trackEnd', ({ track, reason }) => { this.emit('trackEnd', { track: trackSnapshot(track), reason }); this.emitState(); });
      player.on('playbackError', (error) => this.reportError(error, 'Playback failed'));
      this.players.set(guild.id, player);
    }
    return this.players.get(guild.id);
  }

  bindGuildPolicy(client, generation) {
    client.on(Events.GuildCreate, (guild) => {
      if (this.client !== client || generation !== this.generation || !this.gatewayReady) return;
      void this.guildOperation(async () => {
        if (this.client !== client || generation !== this.generation) return;
        if (!client.guilds.cache.has(guild.id)) return;
        if (!this.config.guildId) await this.selectGuild(guild.id);
        else if (guild.id !== this.config.guildId) await this.leaveOtherGuild(guild);
        else { this.emit('guildConfigured', guildSnapshot(guild)); this.emitState(); }
      }).catch((error) => this.reportError(error, 'Single-server policy'));
    });
  }

  guildOperation(operation) {
    const result = this.guildPolicyTail.then(operation);
    this.guildPolicyTail = result.catch(() => {});
    return result;
  }

  async leaveOtherGuild(guild) {
    if (this.departedGuilds.has(guild.id)) return;
    this.departedGuilds.add(guild.id);
    log.info(`Leaving unconfigured server guild=${guild.id} name=${guild.name}`);
    try { await guild.leave(); }
    catch { this.departedGuilds.delete(guild.id); throw new UserError(`Could not leave the unconfigured server ${guild.name}. Check the network; Dubplate only accepts commands in its configured server.`); }
    log.info(`Left unconfigured server guild=${guild.id}`);
    this.emitState();
  }

  async enforceConfiguredGuilds() {
    if (!this.client || !this.config.guildId) { this.emitState(); return; }
    for (const guild of [...this.client.guilds.cache.values()]) if (guild.id !== this.config.guildId) await this.leaveOtherGuild(guild);
    const configured = this.client.guilds.cache.get(this.config.guildId);
    if (configured) this.emit('guildConfigured', guildSnapshot(configured));
    this.emitState();
  }

  async selectGuild(guildId) {
    if (typeof guildId !== 'string' || !/^\d{17,20}$/.test(guildId)) throw new UserError('Choose a valid Discord server.');
    const guild = this.client?.guilds.cache.get(guildId);
    if (!guild) throw new UserError('The bot has not joined that server. Invite it and try again.');
    if (this.voiceTestPromise) throw new UserError('Wait for the voice test to finish before changing servers.');
    if (this.config.guildId && this.config.guildId !== guildId) {
      await this.players.get(this.config.guildId)?.reset('configured server changed');
      this.players.delete(this.config.guildId);
    }
    this.config = validateConfig({ ...this.config, guildId });
    for (const player of this.players.values()) player.config = this.config;
    this.emit('guildConfigured', guildSnapshot(guild));
    await this.enforceConfiguredGuilds();
    log.info(`Configured server guild=${guild.id} name=${guild.name}`);
    return guildSnapshot(guild);
  }

  chooseGuild(guildId) { return this.guildOperation(() => this.selectGuild(guildId)); }
  listVoiceChannels() { return this.snapshot().channels; }

  configureTools(paths) {
    const allowed = new Set(['ffmpegPath', 'ffmpegSha256', 'ytdlpPath', 'ytdlpSha256', 'nodePath', 'nodeSha256', 'voiceTestTonePath']);
    if (!paths || typeof paths !== 'object' || Array.isArray(paths) || Object.keys(paths).some((key) => !allowed.has(key))) throw new UserError('Invalid playback tool configuration.');
    if (this.voiceTestPromise || [...this.players.values()].some((player) => player.current || player.queue.length || player.pending.size)) throw new UserError('Stop playback before running a voice test or changing playback tools.');
    this.config = validateConfig({ ...this.config, ...paths }, { requireCredentials: false });
    for (const player of this.players.values()) player.config = this.config;
  }

  testVoice(channelId) {
    if (this.voiceTestPromise) return Promise.reject(new UserError('A voice test is already running.'));
    const operation = this.runVoiceTest(channelId);
    this.voiceTestPromise = operation.finally(() => { this.voiceTestPromise = null; });
    return this.voiceTestPromise;
  }

  async runVoiceTest(channelId) {
    if (!['running', 'setup'].includes(this.status)) throw new UserError('Connect the bot before running a voice test.');
    const generation = this.generation;
    const guild = this.client?.guilds.cache.get(this.config.guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) throw new UserError('Choose a regular voice channel in the configured server.');
    const player = this.playerFor(guild);
    if (player.current || player.queue.length || player.pending.size || player.testing) throw new UserError('Stop playback before running a voice test.');
    if (!this.config.voiceTestTonePath) throw new UserError('The bundled voice-test tone is unavailable. Reinstall Dubplate.');
    let file;
    try { file = await open(this.config.voiceTestTonePath, 'r'); }
    catch { throw new UserError('The bundled voice-test tone is unavailable. Reinstall Dubplate.'); }
    let tone;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new UserError('The bundled voice-test tone is invalid. Reinstall Dubplate.');
      tone = await file.readFile();
    } finally { await file.close(); }
    const { finished } = await player.exclusive(async () => {
      if (generation !== this.generation) throw new UserError('The voice test was cancelled because the bot stopped.');
      if (player.current || player.queue.length || player.pending.size || player.testing) throw new UserError('Stop playback before running a voice test.');
      if (player.connection && player.channelId !== channelId) await player.reset('voice test channel change');
      player.testing = true;
      try {
        await player.connect(channel);
        if (generation !== this.generation) throw new UserError('The voice test was cancelled because the bot stopped.');
        return { finished: player.beginVoiceTest(tone) };
      } catch (error) { await player.reset('voice test connection failure'); throw error; }
    });
    await finished;
    return { ok: true, channelName: channel.name, message: `The test tone was sent to #${channel.name}. If you heard it, voice playback is working.` };
  }

  bindGatewayStatus(client, generation) {
    let recoveredStatus = 'running';
    const active = () => this.client === client && generation === this.generation
      && ['starting', 'running', 'reconnecting', 'setup'].includes(this.status);
    client.on(Events.ShardReconnecting, () => {
      if (!active()) return;
      if (this.status !== 'reconnecting') recoveredStatus = this.status;
      this.status = 'reconnecting';
      this.emitState();
    });
    const recovered = () => {
      // A fresh IDENTIFY receives READY; a reusable session receives RESUMED.
      // Initial READY must leave startup in control until commands are registered.
      if (!active() || this.status !== 'reconnecting') return;
      this.status = recoveredStatus;
      this.emitState();
      if (this.gatewayReady) void this.guildOperation(() => this.enforceConfiguredGuilds()).catch((error) => this.reportError(error, 'Single-server policy'));
    };
    client.on(Events.ShardReady, recovered);
    client.on(Events.ShardResume, recovered);
    client.on(Events.ShardDisconnect, (event) => {
      if (!active()) return;
      this.reportError(new Error(`Discord disconnected permanently (code ${event?.code ?? 'unknown'}). Check the bot token and application settings, then restart the bot.`), 'Discord gateway disconnected');
      const stopping = this.stop('Discord gateway disconnected');
      const stoppedGeneration = this.generation;
      void stopping.then(() => {
        if (this.generation !== stoppedGeneration || this.status !== 'stopped') return;
        this.status = 'error';
        this.emitState();
      }).catch((error) => this.reportError(error, 'Discord disconnect cleanup'));
    });
  }

  start() { return this.startMode(false); }
  startSetup() { return this.startMode(true); }

  startMode(setupMode) {
    if (!setupMode && !this.config.guildId) return Promise.reject(new UserError('GUILD_ID is missing. Complete server setup before starting playback.'));
    if (this.stopPromise) return this.stopPromise.then(() => this.startMode(setupMode));
    if (this.startPromise) return this.startPromise;
    if (['running', 'reconnecting', 'setup'].includes(this.status)) {
      if (this.setupMode === setupMode) return Promise.resolve(this.snapshot());
      return this.stop('changing setup mode').then(() => this.startMode(setupMode));
    }
    this.setupMode = setupMode;
    this.gatewayReady = false;
    this.departedGuilds.clear();
    this.status = 'starting';
    this.emitState();
    const generation = ++this.generation;
    this.startPromise = this.runStart(generation).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async runStart(generation) {
    const active = () => {
      if (generation !== this.generation) throw new UserError('Bot startup was cancelled.');
    };
    try {
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 22 || (major === 22 && minor < 12)) throw new Error('Node.js 22.12.0 or newer is required.');
      if (!this.setupMode) {
        this.health = await checkHealth(this.config);
        active();
        this.emit('health', this.health);
        const unhealthy = Object.entries(this.health).filter(([, result]) => !result.ok);
        if (unhealthy.length) throw new Error(unhealthy.map(([name, result]) => `${name}: ${result.message}`).join(' '));
      }
      const application = await this.services.validateToken(this.config.token);
      this.identity = application;
      this.emit('identity', application);
      active();
      const commands = new Map();
      for (const filename of (await readdir(new URL('../commands/', import.meta.url))).sort()) {
        if (!filename.endsWith('.js')) continue;
        const command = await import(new URL(`../commands/${filename}`, import.meta.url));
        commands.set(command.data.name, command);
      }
      active();
      const client = this.services.createClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
        allowedMentions: { parse: [], repliedUser: false } });
      this.client = client;
      this.bindGuildPolicy(client, generation);
      const context = { players: this.players, playerFor: (guild) => this.playerFor(guild) };
      client.on(Events.Error, (error) => this.reportError(error, 'Discord client error'));
      client.on(Events.ShardError, (error) => this.reportError(error, 'Discord gateway error'));
      this.bindGatewayStatus(client, generation);
      client.on(Events.VoiceStateUpdate, (oldState, newState) => { this.players.get(newState.guild.id)?.updateAloneTimer(); this.emitState(); });
      for (const event of [Events.ChannelCreate, Events.ChannelUpdate, Events.ChannelDelete, Events.GuildUpdate]) client.on(event, () => this.emitState());
      client.on(Events.GuildDelete, (guild) => {
        this.departedGuilds.delete(guild.id);
        const player = this.players.get(guild.id);
        if (player) player.background(() => player.reset('removed from server'), 'Guild removal');
        if (guild.id === this.config.guildId) this.reportError(new Error('The bot was removed from the configured server.'), 'Server unavailable');
        this.emitState();
      });
      client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
        try {
          if (interaction.isButton() && interaction.customId.startsWith('queue:')) await interaction.deferUpdate();
          else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          if (generation !== this.generation || !['running', 'starting'].includes(this.status)) throw new UserError('The bot is shutting down. Please try again after it restarts.');
          if (!interaction.inGuild() || interaction.guildId !== this.config.guildId) throw new UserError('This bot only accepts commands in its configured server.');
          if (this.voiceTestPromise) throw new UserError('A voice test is running. Wait for the tone to finish before controlling playback.');
          if (interaction.isButton()) {
            if (!interaction.customId.startsWith('queue:')) throw new UserError('This button is no longer available.');
            await commands.get('queue').handleButton(interaction, context);
          } else {
            log.info(`Command user=${interaction.user.id} command=/${interaction.commandName} guild=${interaction.guildId}`);
            const command = commands.get(interaction.commandName);
            if (!command) throw new UserError('Unknown command. Restart the bot to refresh server commands.');
            await command.execute(interaction, context);
          }
        } catch (error) {
          if (!(error instanceof UserError)) this.reportError(error, `Interaction ${interaction.commandName ?? interaction.customId}`);
          await replyError(interaction, error);
        } finally { this.emitState(); }
      });
      const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
      try { await client.login(this.config.token); } catch { throw new Error('Discord login failed. Check the token and internet connection.'); }
      active();
      let timer;
      try {
        await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Discord gateway did not become ready within 30 seconds.')), 30000); })]);
      } finally { clearTimeout(timer); }
      active();
      this.gatewayReady = true;
      await this.guildOperation(() => this.enforceConfiguredGuilds());
      active();
      const guild = client.guilds.cache.get(this.config.guildId);
      if (!guild && !this.setupMode) throw new UserError('The bot has not joined the selected server. Re-run Setup to invite it or choose another server.');
      if (guild) await guild.channels.fetch();
      active();
      if (!this.setupMode) try {
        await discordRest(this.config.token).put(Routes.applicationGuildCommands(application.applicationId, this.config.guildId),
          { body: [...commands.values()].map((command) => command.data.toJSON()) });
      } catch (error) { throw discordFailure(error, 'register commands in the selected server'); }
      active();
      this.status = this.setupMode ? 'setup' : 'running';
      this.stateTimer = setInterval(() => this.emitState(), 1000);
      this.stateTimer.unref();
      this.emitState();
      log.info(this.setupMode ? `Setup connected as ${client.user.tag}; waiting for server selection or invite`
        : `Ready as ${client.user.tag}; registered ${commands.size} commands in guild=${this.config.guildId}`);
      return this.snapshot();
    } catch (error) {
      if (generation === this.generation) {
        this.status = 'error';
        this.reportError(error, 'Startup failed');
        await this.cleanup('startup failure');
        this.emitState();
      }
      throw error;
    }
  }

  async cleanup(reason) {
    this.gatewayReady = false;
    clearInterval(this.stateTimer);
    const results = await Promise.allSettled([...this.players.values()].map((player) => player.reset(reason)));
    for (const result of results) if (result.status === 'rejected') this.reportError(result.reason, 'Player cleanup');
    await stopAllProcesses();
    const client = this.client;
    this.client = null;
    try { await client?.destroy(); } catch (error) { this.reportError(error, 'Discord client shutdown'); }
  }

  stop(reason = 'stopped') {
    if (this.stopPromise) return this.stopPromise;
    ++this.generation;
    this.status = 'stopping';
    this.emitState();
    this.stopPromise = (async () => {
      await this.cleanup(reason);
      await this.startPromise?.catch(() => {});
      await this.cleanup(reason);
      this.players.clear();
      this.status = 'stopped';
      this.emitState();
      return this.snapshot();
    })().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  async dispose() { await this.stop(); this.unsubscribeLogs(); this.removeAllListeners(); }

  async control(action, args = {}) {
    if (this.voiceTestPromise) throw new UserError('A voice test is running. Wait for the tone to finish before controlling playback.');
    if (typeof action !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new UserError('Invalid playback command.');
    if (this.status !== 'running') throw new UserError('Start the bot before controlling playback.');
    if (this.voiceTestPromise && !['stop', 'disconnect'].includes(action)) throw new UserError('A voice test is running. Wait for it to finish before controlling music.');
    const guild = this.client?.guilds.cache.get(this.config.guildId);
    if (!guild) throw new UserError('The configured server is unavailable.');
    const player = this.playerFor(guild);
    if (action === 'add') {
      normalizeQuery(args.query, this.config.allowedHosts);
      if (typeof args.voiceChannelId !== 'string' || !/^\d{17,20}$/.test(args.voiceChannelId)) throw new UserError('Select a voice channel before adding a track.');
      const channel = guild.channels.cache.get(args.voiceChannelId);
      const result = await player.enqueueDesktop(args.query, channel);
      return { count: result.count, first: trackSnapshot(result.first), capped: result.capped };
    }
    return player.exclusive(async () => {
      switch (action) {
        case 'pause': player.pause(); break;
        case 'resume': player.resume(); break;
        case 'skip': requireTrack(player); await player.finish(player.playToken, 'skipped'); break;
        case 'stop': case 'disconnect': await player.reset(action === 'stop' ? 'desktop stop' : 'desktop disconnect'); break;
        case 'seek': await player.seek(args.seconds); break;
        case 'volume': player.setVolume(args.percent); break;
        case 'loop': player.setLoop(args.mode); break;
        case 'remove': player.remove(args.position); break;
        case 'reorder': player.reorder(args.from, args.to); break;
        case 'shuffle': player.shuffle(); break;
        case 'clear': player.clear(); break;
        default: throw new UserError('Unknown playback command.');
      }
      return this.snapshot();
    });
  }
}
