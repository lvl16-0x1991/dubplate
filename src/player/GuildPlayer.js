import { randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ChannelType } from 'discord.js';
import {
  AudioPlayerStatus, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource, entersState, joinVoiceChannel,
} from '@discordjs/voice';
import { productionBackend, startVoiceTestPipeline } from './ytdlp.js';
import { allowedMentions, safeText } from '../util/format.js';
import { log } from '../util/log.js';
import { callerChannel, requireTrack, UserError } from '../util/validation.js';
import { voiceChannelProblems } from './voiceChecks.js';

export class GuildPlayer extends EventEmitter {
  constructor(guild, config, media = productionBackend, voice = { joinVoiceChannel, entersState }) {
    super();
    this.guild = guild;
    this.config = config;
    this.media = media;
    this.voice = voice;
    this.testing = false;
    this.voiceTest = null;
    this.idleDeadline = null;
    this.aloneDeadline = null;
    this.queue = [];
    this.current = null;
    this.loop = 'off';
    this.volume = config.defaultVolume;
    this.connection = null;
    this.pipeline = null;
    this.resource = null;
    this.offset = 0;
    this.epoch = 0;
    this.playToken = 0;
    this.pending = new Map();
    this.warm = null;
    this.tail = Promise.resolve();
    // The default five missed frames would stop a track after only 100 ms of
    // network jitter. The progress watchdog below owns the 60-second stall limit.
    this.audio = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 3000 } });
    this.audio.on('stateChange', (oldState, newState) => {
      this.emit('changed');
      if (newState.status === AudioPlayerStatus.Idle && oldState.resource) {
        this.background(() => this.finish(oldState.resource.metadata.token, 'ended'), 'Track completion');
      }
    });
    this.audio.on('error', (error) => {
      this.background(() => this.finish(error.resource?.metadata?.token ?? this.playToken, 'failed', error), 'Audio player error');
    });
  }

  get channelId() { return this.connection?.joinConfig.channelId ?? null; }
  get elapsed() { return this.offset + (this.resource?.playbackDuration ?? 0) / 1000; }
  get statusLabel() {
    const state = this.audio.state.status;
    if ([AudioPlayerStatus.Paused, AudioPlayerStatus.AutoPaused].includes(state)) return 'Paused';
    if (state === AudioPlayerStatus.Buffering) return 'Buffering';
    return this.current ? 'Playing' : 'Idle';
  }

  // Only short state changes and connection setup hold this lock. Metadata runs
  // outside it, so /stop can cancel a slow extractor immediately.
  exclusive(operation) {
    const result = this.tail.then(operation).finally(() => this.emit('changed'));
    this.tail = result.catch(() => {});
    return result;
  }

  background(operation, context) {
    void this.exclusive(operation).catch((error) => log.error(`${context} guild=${this.guild.id}`, error));
  }

  async connect(channel) {
    if (this.connection?.state.status === VoiceConnectionStatus.Ready) {
      if (this.channelId === channel.id) return;
      throw new UserError('Disconnect from the current voice channel before choosing a different one.');
    }
    const { missingPermissions, full } = voiceChannelProblems(channel, this.guild);
    if (missingPermissions.length) throw new UserError(`Missing permissions in #${channel.name || channel.id}: ${missingPermissions.join(', ')}.`);
    if (full) throw new UserError(`The voice channel #${channel.name || channel.id} is full. Choose another channel or make room, then try again.`);
    const connection = this.voice.joinVoiceChannel({
      channelId: channel.id, guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator, selfDeaf: true, selfMute: false,
      daveEncryption: true,
    });
    this.connection = connection;
    connection.on('error', (error) => {
      log.error(`Voice connection guild=${this.guild.id}`, error);
      this.background(async () => {
        if (this.connection === connection) await this.reset('voice connection error');
      }, 'Voice error cleanup');
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.handleDisconnect(connection).catch((error) => log.error('Disconnect recovery', error));
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.background(async () => {
        if (this.connection === connection) await this.reset('voice connection destroyed');
      }, 'Destroyed connection cleanup');
    });
    try {
      await this.voice.entersState(connection, VoiceConnectionStatus.Ready, 30000);
      if (this.connection !== connection) throw new Error('Connection was replaced.');
      connection.subscribe(this.audio);
      this.updateAloneTimer();
      this.armIdleTimer();
      log.info(`Joined voice guild=${this.guild.id} channel=${channel.id}`);
    } catch (error) {
      if (this.connection === connection) this.connection = null;
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      log.error(`Could not join voice guild=${this.guild.id}`, error);
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') throw new UserError('Voice connection timed out after 30 seconds. Check View Channel / Connect / Speak permissions on this channel and your network, then try again.');
      throw new UserError('The voice connection failed before it became ready. Check the network and try again; details are in the Activity log.');
    }
  }

  async handleDisconnect(connection) {
    // Discord briefly disconnects during a channel move. The guide's race gives
    // it five seconds to start signalling/reconnecting before treating it as a
    // real departure. A second deadline prevents recovery hanging indefinitely.
    try {
      await Promise.race([
        this.voice.entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        this.voice.entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
      await this.voice.entersState(connection, VoiceConnectionStatus.Ready, 30000);
      if (this.connection === connection) this.updateAloneTimer();
    } catch {
      await this.exclusive(async () => {
        if (this.connection !== connection) return;
        const track = this.current;
        await this.reset('disconnected');
        await this.notify(track, 'Voice connection lost. Join a voice channel and use /play to start again.');
      });
    }
  }

  async enqueueQuery(interaction, query) {
    return this.enqueueRequest(query, () => callerChannel(interaction, this), {
      requesterId: interaction.user.id,
      requesterName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
      textChannelId: interaction.channelId,
    });
  }

  async enqueueDesktop(query, channel) {
    return this.enqueueRequest(query, () => {
      if (channel?.type !== ChannelType.GuildVoice) throw new UserError('Select a regular voice channel.');
      if (this.channelId && this.channelId !== channel.id) throw new UserError('Disconnect before selecting a different voice channel.');
      return channel;
    }, { requesterName: 'Desktop' });
  }

  async enqueueRequest(query, getChannel, requester) {
    if (this.testing) throw new UserError('A voice test is running. Wait for it to finish before adding music.');
    this.media.normalizeQuery(query, this.config);
    const queuedEpoch = this.epoch;
    const request = await this.exclusive(async () => {
      if (this.testing) throw new UserError('A voice test is running. Wait for it to finish before adding music.');
      // A request waiting behind an earlier command must not reconnect after
      // shutdown/stop has cancelled this player's generation.
      if (queuedEpoch !== this.epoch) throw new UserError('Playback was stopped while this request was loading.');
      const channel = getChannel();
      if (this.queue.length >= this.config.maxQueue) throw new UserError('The queue is full. Remove tracks or clear it first.');
      await this.connect(channel);
      const controller = new AbortController();
      this.pending.set(controller, null);
      clearTimeout(this.idleTimer);
      this.idleDeadline = null;
      return { controller, epoch: this.epoch, limit: this.config.maxQueue - this.queue.length };
    });
    try {
      const resolving = this.media.resolve(this.config, query, {
        limit: request.limit, signal: request.controller.signal,
        ...requester,
      });
      this.pending.set(request.controller, resolving);
      const resolved = await resolving;
      return await this.exclusive(async () => {
        if (request.epoch !== this.epoch || request.controller.signal.aborted) throw new UserError('Playback was stopped while this request was loading.');
        getChannel();
        const available = this.config.maxQueue - this.queue.length;
        const tracks = resolved.tracks.slice(0, available);
        if (!tracks.length) throw new UserError('The queue filled up while this request was loading.');
        this.queue.push(...tracks);
        clearTimeout(this.idleTimer);
        this.idleDeadline = null;
        if (!this.current) await this.startNext();
        else this.schedulePrewarm();
        return { count: tracks.length, first: tracks[0], capped: resolved.capped || tracks.length < resolved.tracks.length };
      });
    } catch (error) {
      if (request.controller.signal.aborted || request.epoch !== this.epoch) throw new UserError('Playback was stopped while this request was loading.');
      if (error instanceof UserError) throw error;
      log.error(`yt-dlp resolution guild=${this.guild.id}`, error);
      throw new UserError('Could not resolve that query. Check the URL or try another search. Update yt-dlp from the Health panel; details are in the log.');
    } finally {
      this.pending.delete(request.controller);
      await this.exclusive(() => this.armIdleTimer());
    }
  }

  async startNext() {
    if (this.current || !this.connection) return;
    const track = this.queue.shift();
    if (!track) { this.cancelPrewarm(); this.armIdleTimer(); return; }
    if (this.warm?.track === track) this.cancelPrewarm();
    await this.startTrack(track, 0);
  }

  async startTrack(track, offset, paused = false) {
    if (!this.connection) return;
    clearTimeout(this.idleTimer);
    this.idleDeadline = null;
    this.current = track;
    this.offset = offset;
    const token = ++this.playToken;
    try {
      const failed = (error) => {
        this.background(() => this.finish(token, 'failed', error), 'Pipeline failure');
      };
      this.pipeline = track.isVoiceTest
        ? startVoiceTestPipeline(this.config, this.voiceTest.tone, failed)
        : this.media.startPipeline(this.config, track, offset, failed);
      this.resource = createAudioResource(this.pipeline.stream, {
        inputType: StreamType.Raw, inlineVolume: true, metadata: { token },
      });
      this.resource.volume.setVolume(this.volume);
      this.audio.play(this.resource);
      if (paused) {
        // pause() only works after Buffering. Guard this callback against skips.
        const onPlaying = () => {
          if (this.playToken === token && this.current) this.audio.pause();
        };
        this.audio.once(AudioPlayerStatus.Playing, onPlaying);
        this.pauseWhenReady = onPlaying;
      }
      this.watchProgress(token);
      this.schedulePrewarm();
      log.info(`Track start guild=${this.guild.id} title=${track.title} offset=${offset}s`);
      this.emit('trackStart', { track, offset });
      this.emit('changed');
    } catch (error) {
      // Schedule, don't recursively await: thousands of bad playlist entries
      // must not build up a call stack or hold the control lock indefinitely.
      this.background(() => this.finish(token, 'failed', error), 'Track startup');
    }
  }

  beginVoiceTest(tone) {
    if (this.voiceTest || this.current || this.queue.length || this.pending.size) throw new UserError('Stop playback before running a voice test.');
    this.testing = true;
    let resolveTest;
    let rejectTest;
    const finished = new Promise((resolve, reject) => { resolveTest = resolve; rejectTest = reject; });
    // Attach immediately: connection shutdown can reject before the caller gets the promise.
    void finished.catch(() => {});
    const test = { tone, resolve: resolveTest, reject: rejectTest };
    this.voiceTest = test;
    test.timer = setTimeout(() => {
      test.failure = new UserError('The voice test timed out before audio finished. Check the voice connection and retry.');
      this.background(() => this.reset('voice test timeout'), 'Voice test timeout');
    }, 15000);
    test.timer.unref();
    void this.startTrack({ id: randomUUID(), title: 'Dubplate voice test', requesterName: 'Voice test', duration: 2,
      isLive: false, isVoiceTest: true, url: null, thumbnail: null, uploader: 'Dubplate' }, 0);
    return finished;
  }

  watchProgress(token) {
    clearInterval(this.progressTimer);
    let lastProgress = Date.now();
    let lastDuration = -1;
    this.progressTimer = setInterval(() => {
      if (this.playToken !== token || !this.current) return;
      const elapsed = this.resource?.playbackDuration ?? 0;
      if (this.statusLabel === 'Paused' || elapsed !== lastDuration) {
        lastProgress = Date.now(); lastDuration = elapsed; return;
      }
      if (Date.now() - lastProgress > 60000) {
        this.background(() => this.finish(token, 'failed', new Error('No audio received for 60 seconds.')), 'Playback timeout');
      }
    }, 10000);
    this.progressTimer.unref();
  }

  async disposePipeline() {
    clearInterval(this.progressTimer);
    if (this.pauseWhenReady) this.audio.off(AudioPlayerStatus.Playing, this.pauseWhenReady);
    this.pauseWhenReady = null;
    const pipeline = this.pipeline;
    this.pipeline = null;
    try { await pipeline?.stop(); } finally {
      this.audio.stop(true);
      this.resource?.playStream.destroy();
      this.resource = null;
    }
  }

  async finish(token, reason, error) {
    if (!this.current || token !== this.playToken) return;
    const epoch = this.epoch;
    const track = this.current;
    const pipeline = this.pipeline;
    // Wait briefly for process exit events to distinguish successful EOF from
    // truncated audio. Any error observed here disables looping this bad track.
    if (reason === 'ended' && pipeline) {
      let timer;
      await Promise.race([pipeline.completed, new Promise((resolve) => { timer = setTimeout(resolve, 1500); })]);
      clearTimeout(timer);
      if (epoch !== this.epoch) return;
      error ||= pipeline.failure;
      if (error) reason = 'failed';
    }
    this.current = null;
    ++this.playToken;
    try { await this.disposePipeline(); } catch (cleanupError) { log.error('Track process cleanup', cleanupError); }
    if (epoch !== this.epoch) return;
    log.info(`Track ${reason} guild=${this.guild.id} title=${track.title}`);
    this.emit('trackEnd', { track, reason });
    if (track.isVoiceTest) {
      const test = this.voiceTest;
      this.voiceTest = null;
      this.testing = false;
      clearTimeout(test?.timer);
      if (error) {
        log.error('Voice test playback failed', error);
        log.error(`Voice test stderr: ${pipeline?.stderr || '(no stderr)'}`);
      }
      try { await this.reset('voice test complete'); }
      catch (cleanupError) { test?.reject(new UserError(`Voice test cleanup failed: ${cleanupError.message}`)); return; }
      if (reason === 'ended' && !error) test?.resolve();
      else test?.reject(new UserError(error ? `Voice test playback failed: ${error.message}` : 'The voice test was stopped before completing.'));
      return;
    }
    if (reason === 'failed') {
      log.error(`Track failed guild=${this.guild.id} title=${track.title}`, error);
      log.error(`Playback stderr guild=${this.guild.id}: ${pipeline?.stderr || '(no stderr)'}`);
      this.emit('playbackError', error || new Error('Playback failed.'));
      // A text-channel permissions/network problem must not delay the next song.
      void this.notify(track, `Could not play **${safeText(track.title)}**. Skipping to the next track; update yt-dlp from the Health panel if this keeps happening.`);
    }
    if (reason === 'ended' && this.loop === 'track') await this.startTrack(track, 0);
    else {
      if (reason === 'ended' && this.loop === 'queue') this.queue.push(track);
      await this.startNext();
    }
  }

  async seek(seconds) {
    const track = requireTrack(this);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 2147483647) throw new UserError('Seek must be a whole number of seconds between 0 and 2147483647.');
    if (track.isLive) throw new UserError('Live streams cannot be seeked.');
    if (track.duration !== null && seconds >= track.duration) throw new UserError('Seek must be before the end of the track.');
    const paused = this.statusLabel === 'Paused';
    ++this.playToken;
    await this.disposePipeline();
    await this.startTrack(track, seconds, paused);
  }

  pause() {
    requireTrack(this);
    if (!this.audio.pause()) throw new UserError('Playback is already paused or is still buffering.');
  }

  resume() {
    requireTrack(this);
    if (this.pauseWhenReady) { this.audio.off(AudioPlayerStatus.Playing, this.pauseWhenReady); this.pauseWhenReady = null; }
    if (!this.audio.unpause()) throw new UserError('Playback is not paused, or is still buffering.');
  }

  setVolume(percent) {
    if (!Number.isInteger(percent) || percent < 0 || percent > 150) throw new UserError('Volume must be a whole number between 0 and 150.');
    this.volume = percent / 100;
    this.resource?.volume.setVolume(this.volume);
  }

  remove(position) {
    if (!Number.isInteger(position) || position < 1 || position > this.queue.length) throw new UserError('That queue position does not exist. Use /queue to see positions.');
    const [track] = this.queue.splice(position - 1, 1);
    this.schedulePrewarm();
    return track;
  }

  reorder(from, to) {
    if (![from, to].every((position) => Number.isInteger(position) && position >= 1 && position <= this.queue.length)) {
      throw new UserError('That queue position does not exist.');
    }
    const [track] = this.queue.splice(from - 1, 1);
    this.queue.splice(to - 1, 0, track);
    this.schedulePrewarm();
  }

  setLoop(mode) {
    if (!['off', 'track', 'queue'].includes(mode)) throw new UserError('Loop mode must be off, track or queue.');
    this.loop = mode;
  }

  shuffle() {
    for (let index = this.queue.length - 1; index > 0; index--) {
      const other = randomInt(index + 1);
      [this.queue[index], this.queue[other]] = [this.queue[other], this.queue[index]];
    }
    this.schedulePrewarm();
  }

  clear() {
    const count = this.queue.length;
    this.queue = [];
    this.cancelPrewarm();
    this.armIdleTimer();
    return count;
  }

  cancelPrewarm() {
    const warm = this.warm;
    warm?.controller.abort();
    this.warm = null;
    return warm?.promise;
  }

  schedulePrewarm() {
    const next = this.queue[0];
    if (this.warm?.track === next) return;
    this.cancelPrewarm();
    if (!this.current || !next) return;
    const controller = new AbortController();
    const warm = { track: next, controller };
    this.warm = warm;
    warm.promise = this.media.prewarm(this.config, next, controller.signal).then((metadata) => {
      if (this.warm === warm && !controller.signal.aborted) { Object.assign(next, metadata); this.emit('changed'); }
    }).catch((error) => {
      // Metadata warming is best effort; actual playback always gets a fresh
      // extractor run, so a failed prewarm never removes an otherwise valid song.
      if (!controller.signal.aborted) log.error(`Next-track metadata guild=${this.guild.id}`, error);
    });
  }

  armIdleTimer() {
    if (this.current || this.queue.length || this.pending.size || !this.connection) return;
    clearTimeout(this.idleTimer);
    this.idleDeadline = Date.now() + this.config.idleTimeoutSeconds * 1000;
    this.idleTimer = setTimeout(() => this.background(async () => {
      if (!this.current && !this.queue.length && !this.pending.size) await this.reset('idle timeout');
    }, 'Idle cleanup'), this.config.idleTimeoutSeconds * 1000);
    this.idleTimer.unref();
  }

  updateAloneTimer() {
    if (!this.channelId) { clearTimeout(this.aloneTimer); this.aloneTimer = null; this.aloneDeadline = null; this.emit('changed'); return; }
    const occupied = this.guild.voiceStates.cache.some((state) => state.channelId === this.channelId
      && state.id !== this.guild.client.user.id && !state.member?.user.bot);
    if (occupied) { clearTimeout(this.aloneTimer); this.aloneTimer = null; this.aloneDeadline = null; this.emit('changed'); return; }
    if (this.aloneTimer) return;
    this.aloneDeadline = Date.now() + 30000;
    this.aloneTimer = setTimeout(() => {
      this.aloneTimer = null;
      this.aloneDeadline = null;
      this.background(async () => {
        const hasHuman = this.guild.voiceStates.cache.some((state) => state.channelId === this.channelId
          && state.id !== this.guild.client.user.id && !state.member?.user.bot);
        if (!hasHuman) await this.reset('alone for 30 seconds');
      }, 'Empty channel cleanup');
    }, 30000);
    this.aloneTimer.unref();
    this.emit('changed');
  }

  async notify(track, content) {
    if (!track?.textChannelId) return;
    try {
      const channel = await this.guild.channels.fetch(track.textChannelId);
      if (channel?.isTextBased() && typeof channel.send === 'function') await channel.send({ content, allowedMentions });
    } catch (error) { log.error(`Could not send playback notice guild=${this.guild.id}`, error); }
  }

  async reset(reason = 'stopped') {
    ++this.epoch;
    ++this.playToken;
    const resolving = [...this.pending.values()];
    for (const controller of this.pending.keys()) controller.abort();
    this.pending.clear();
    const warming = this.cancelPrewarm();
    clearTimeout(this.idleTimer);
    clearTimeout(this.aloneTimer);
    this.aloneTimer = null;
    this.idleDeadline = null;
    this.aloneDeadline = null;
    const endedTrack = this.current;
    const voiceTest = this.voiceTest;
    this.voiceTest = null;
    this.testing = false;
    clearTimeout(voiceTest?.timer);
    this.current = null;
    this.queue = [];
    this.loop = 'off';
    this.offset = 0;
    const connection = this.connection;
    this.connection = null;
    try {
      await this.disposePipeline();
    } finally {
      // Wait for cancelled metadata children too, without waiting for interaction
      // continuations (those acquire this player's lock after the lookup settles).
      await Promise.allSettled([...resolving, warming]);
      try { if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy(); }
      finally {
        log.info(`Player disconnected guild=${this.guild.id} reason=${reason}`);
        if (endedTrack) this.emit('trackEnd', { track: endedTrack, reason });
        voiceTest?.reject(voiceTest.failure || new UserError('The voice test was stopped before completing.'));
        this.emit('changed');
      }
    }
  }
}
