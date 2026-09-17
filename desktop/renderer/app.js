'use strict';

(() => {
  const api = window.dubplate;
  const $ = (id) => document.getElementById(id);
  const model = {
    settings: {}, state: {}, health: {}, identity: null, logs: [], notices: [],
    tokenConfigured: false, setupComplete: false, appVersion: '', guilds: [],
    page: 'listen', setupStep: 0, setupWasComplete: false, logsPaused: false,
    stateReceivedAt: Date.now(), queueSignature: '', channelSignature: '',
    healthSignature: '', logScheduled: false, tokenPending: false,
    setupTools: { status: 'preparing' }, selectedGuild: null, voiceChannels: [],
    voiceTestPending: false, voicePassedKey: '', voiceTestSurface: 'setup',
  };
  let guildRequest = false;
  let voiceChannelRequest = false;
  let prepareRequest = false;
  let discoveryRequest = false;
  let tokenDebounce = null;
  let toastTimeout = null;
  let draggedPosition = null;
  let logSnapshot = [];
  let settingsDirty = false;
  let confirmAction = null;
  let unsubscribe = null;
  const busyButtons = new WeakSet();
  const names = { ytdlp: 'yt-dlp', ffmpeg: 'FFmpeg', opus: 'Opus', dave: 'DAVE', node: 'Node.js', app: 'Dubplate' };
  const pageNames = {
    listen: ['LET THE GOOD TRACKS PLAY', 'Listen together.'],
    logs: ['A WINDOW INTO YOUR BOT', 'Activity.'],
    health: ['KEEP THE MUSIC MOVING', 'System health.'],
    settings: ['A FEW PERSONAL TOUCHES', 'Your setup.'],
  };
  const stepTitles = ['Meet your new bot.', 'Make the connection.', 'Bring your bot along.', 'Check the connection.', 'Good music starts here.'];

  function text(id, value) { const element = $(id); const next = String(value ?? ''); if (element.textContent !== next) element.textContent = next; }
  function show(id, visible = true) { $(id).hidden = !visible; }
  function error(id, value) { text(id, value); show(id, Boolean(value)); }
  function messageOf(value) { return typeof value === 'string' ? value : value?.message || 'Something went wrong. Please try again.'; }
  function finite(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
  function duration(value) {
    const seconds = Math.max(0, Math.floor(finite(value)));
    const h = Math.floor(seconds / 3600); const m = Math.floor(seconds / 60) % 60; const s = seconds % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `icons.svg#${name}`); svg.append(use); return svg;
  }
  function setIcon(button, name) { const use = button.querySelector('use'); if (use) use.setAttribute('href', `icons.svg#${name}`); }
  function make(tag, className, content) {
    const node = document.createElement(tag); if (className) node.className = className;
    if (content !== undefined) node.textContent = String(content); return node;
  }
  function safeImage(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
  }
  function updateImage(img, placeholder, value, container) {
    const url = safeImage(value); const previous = img.dataset.source || '';
    if (url !== previous) {
      img.dataset.source = url;
      delete img.dataset.failedSource;
      if (url) img.src = url; else img.removeAttribute('src');
    }
    const visible = Boolean(url) && img.dataset.failedSource !== url;
    img.hidden = !visible;
    if (placeholder) placeholder.hidden = visible;
    if (container) container.classList.toggle('has-image', visible);
  }
  function toast(message) {
    text('toast', message); show('toast'); clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => show('toast', false), 4500);
  }
  function disable(id, disabled) { if (!busyButtons.has($(id))) $(id).disabled = Boolean(disabled); }
  async function task(button, operation, errorId = 'global-error', successMessage) {
    if (button && busyButtons.has(button)) return;
    if (errorId) error(errorId, '');
    if (button) { busyButtons.add(button); button.disabled = true; button.classList.add('busy'); button.setAttribute('aria-busy', 'true'); }
    try {
      const result = await operation();
      if (successMessage) toast(successMessage);
      return result;
    } catch (failure) {
      error(errorId || 'global-error', messageOf(failure));
      return undefined;
    } finally {
      if (button) { busyButtons.delete(button); button.disabled = false; button.classList.remove('busy'); button.removeAttribute('aria-busy'); }
      renderPlayer(); renderSetupNavigation();
    }
  }
  function useControl(action, args = {}, button, successMessage) {
    return task(button, () => api.control(action, args), 'global-error', successMessage);
  }
  function isRunning() { return ['ready', 'connected', 'running', 'online'].includes(String(model.state.status).toLowerCase()); }
  function isStarting() { return ['starting', 'connecting', 'reconnecting', 'restarting'].includes(String(model.state.status).toLowerCase()); }
  function playback() { return String(model.state.playbackStatus || '').toLowerCase(); }
  function activeElapsed() {
    const base = finite(model.state.elapsed);
    const elapsed = base + (playback() === 'playing' ? Math.max(0, Date.now() - model.stateReceivedAt) / 1000 : 0);
    return model.state.current?.duration ? Math.min(elapsed, model.state.current.duration) : elapsed;
  }
  function updateClocks() {
    const track = model.state.current; const elapsed = track ? activeElapsed() : 0;
    if (document.activeElement !== $('seek')) $('seek').value = String(elapsed);
    text('elapsed', duration(elapsed));
    const voice = model.state.voice || {};
    const countdowns = [['Idle disconnect', voice.idleDeadline], ['Alone disconnect', voice.aloneDeadline]];
    const pending = countdowns.filter(([, deadline]) => deadline).map(([label, deadline]) => {
      const timestamp = typeof deadline === 'number' ? deadline : Date.parse(deadline);
      return Number.isFinite(timestamp) ? `${label} ${duration(Math.max(0, timestamp - Date.now()) / 1000)}` : '';
    });
    text('countdown', pending.filter(Boolean).join(' · '));
  }
  function renderPlayer() {
    const state = model.state; const track = state.current; const ready = isRunning(); const starting = isStarting();
    const stopped = !ready && !starting;
    const status = String(state.status || 'stopped');
    text('connection-status', ({ ready: 'Connected', running: 'Connected', online: 'Connected', connected: 'Connected', setup: 'Setup connected', stopped: 'Bot stopped', starting: 'Starting…', connecting: 'Connecting…', reconnecting: 'Reconnecting…', restarting: 'Restarting…', stopping: 'Stopping…', crashed: 'Bot interrupted', error: 'Needs attention' })[status.toLowerCase()] || status);
    text('connection-server', state.guild?.name || model.guilds.find((guild) => guild.id === model.settings.guildId)?.name || 'No server selected');
    $('connection-dot').className = `status-dot${ready ? ' online' : starting ? ' connecting' : ['error', 'crashed'].includes(status) ? ' error' : ''}`;
    text('track-title', track?.title || 'A good place to press play.');
    text('track-uploader', track?.uploader || (track ? 'Unknown artist' : 'Add a track and give your server a soundtrack.'));
    text('track-requester', track ? `Requested by ${track.requesterName || 'a server member'}` : stopped ? 'Start your bot, then search below or use /play in Discord.' : 'Search below, or use /play in Discord.');
    text('playback-label', track ? (playback() === 'paused' || playback() === 'autopaused' ? 'TAKING A BREATHER' : playback() === 'buffering' ? 'GETTING THE TRACK READY' : 'NOW PLAYING') : stopped ? 'YOUR BOT IS RESTING' : 'READY WHEN YOU ARE');
    updateImage($('track-art'), $('art-placeholder'), track?.thumbnail, $('artwork'));
    $('track-title').title = track?.title || '';
    text('duration', track?.isLive ? 'LIVE' : duration(track?.duration));
    $('seek').max = String(Math.max(1, finite(track?.duration, 100)));
    disable('seek', !track || track.isLive || !track.duration || !ready);
    const paused = ['paused', 'autopaused'].includes(playback());
    setIcon($('play-pause'), paused ? 'play' : track ? 'pause' : 'play');
    $('play-pause').setAttribute('aria-label', paused ? 'Resume playback' : 'Pause playback');
    $('play-pause').title = paused ? 'Resume playback' : 'Pause playback';
    ['play-pause', 'skip-track', 'stop-track'].forEach((id) => disable(id, !track || !ready));
    if (document.activeElement !== $('volume')) $('volume').value = String(finite(state.volume, finite(model.settings.defaultVolume, 0.5) * 100));
    text('volume-value', `${$('volume').value}%`);
    disable('volume', !ready); disable('loop-mode', !ready);
    if (document.activeElement !== $('loop-mode')) $('loop-mode').value = ['off', 'track', 'queue'].includes(state.loop) ? state.loop : 'off';
    text('loop-tag', state.loop === 'track' ? 'TRACK ON REPEAT' : 'QUEUE ON REPEAT'); show('loop-tag', Boolean(state.loop && state.loop !== 'off'));
    const voice = state.voice || {};
    text('voice-name', voice.name || (voice.channelId ? 'Voice channel connected' : 'No voice channel connected'));
    text('voice-description', voice.channelId ? `${finite(voice.listeners)} ${finite(voice.listeners) === 1 ? 'listener' : 'listeners'} in the room` : ready ? 'Choose a channel when adding your first track.' : 'Your bot will be ready when you start it.');
    disable('disconnect', !voice.channelId || !ready);
    disable('start-bot', !stopped || !model.tokenConfigured || !model.settings.guildId);
    disable('stop-bot', stopped || status === 'stopping');
    disable('restart-bot', starting || !model.tokenConfigured || !model.settings.guildId);
    disable('add-submit', !ready); disable('voice-channel', !ready || Boolean(voice.channelId));
    const channels = Array.isArray(state.channels) ? state.channels : [];
    const channelSignature = JSON.stringify(channels);
    if (channelSignature !== model.channelSignature) {
      model.channelSignature = channelSignature;
      const chosen = $('voice-channel').value;
      const fragment = document.createDocumentFragment(); const blank = make('option', '', channels.length ? 'Choose voice channel' : 'No voice channels available'); blank.value = ''; fragment.append(blank);
      for (const channel of channels) { const option = make('option', '', channel.name); option.value = channel.id; fragment.append(option); }
      $('voice-channel').replaceChildren(fragment);
      if (channels.some((channel) => channel.id === chosen)) $('voice-channel').value = chosen;
      else if (channels.length === 1) $('voice-channel').value = channels[0].id;
    }
    if (voice.channelId) {
      if (![...$('voice-channel').options].some((option) => option.value === voice.channelId)) { const option = make('option', '', voice.name || 'Current voice channel'); option.value = voice.channelId; $('voice-channel').append(option); }
      $('voice-channel').value = voice.channelId;
    }
    renderQueue(); updateClocks();
  }
  function queueButton(name, label, action, disabled = false) {
    const button = make('button', 'icon-button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.disabled = disabled; button.append(icon(name)); button.addEventListener('click', () => action(button)); return button;
  }
  function renderQueue() {
    const queue = Array.isArray(model.state.queue) ? model.state.queue : [];
    text('queue-count', queue.length);
    text('queue-summary', queue.length ? `${queue.length} ${queue.length === 1 ? 'track' : 'tracks'} · ${duration(queue.reduce((sum, item) => sum + finite(item.duration), 0))} of good company` : 'Make some room for your favorites.');
    disable('shuffle-queue', queue.length < 2 || !isRunning()); disable('clear-queue', !queue.length || !isRunning());
    show('queue-empty', !queue.length); show('queue-table-wrap', Boolean(queue.length));
    const signature = JSON.stringify([isRunning(), queue]);
    if (signature === model.queueSignature) return;
    model.queueSignature = signature;
    const focusedAction = document.activeElement?.dataset?.queueAction;
    const fragment = document.createDocumentFragment();
    queue.forEach((track, index) => {
      const position = index + 1; const row = make('tr'); row.draggable = isRunning(); row.dataset.position = String(position);
      row.append(make('td', 'queue-position', position));
      const trackCell = make('td'); const trackBox = make('div', 'queue-track'); const imageUrl = safeImage(track.thumbnail);
      if (imageUrl) { const img = make('img', 'queue-thumb'); img.src = imageUrl; img.alt = ''; img.loading = 'lazy'; img.addEventListener('error', () => img.removeAttribute('src'), { once: true }); trackBox.append(img); }
      else { const placeholder = make('span', 'queue-thumb queue-thumb-placeholder'); placeholder.append(icon('music')); trackBox.append(placeholder); }
      const detail = make('div', 'queue-track-text'); const title = make('strong', '', track.title || 'Untitled track'); title.title = track.title || ''; detail.append(title, make('small', '', track.uploader || 'Unknown artist')); trackBox.append(detail); trackCell.append(trackBox); row.append(trackCell);
      row.append(make('td', 'queue-requester', track.requesterName || 'Server member'), make('td', '', track.isLive ? 'LIVE' : duration(track.duration)));
      const actionsCell = make('td'); const actions = make('div', 'queue-actions');
      const up = queueButton('arrow-up', `Move track ${position} up`, (button) => useControl('reorder', { from: position, to: position - 1 }, button), index === 0 || !isRunning()); up.dataset.queueAction = `${position}-up`;
      const down = queueButton('arrow-down', `Move track ${position} down`, (button) => useControl('reorder', { from: position, to: position + 1 }, button), index === queue.length - 1 || !isRunning()); down.dataset.queueAction = `${position}-down`;
      const remove = queueButton('close', `Remove track ${position}: ${track.title || 'Untitled track'}`, (button) => useControl('remove', { position }, button), !isRunning()); remove.dataset.queueAction = `${position}-remove`;
      actions.append(up, down, remove); actionsCell.append(actions); row.append(actionsCell);
      row.addEventListener('dragstart', (event) => { draggedPosition = position; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(position)); row.classList.add('dragging'); });
      row.addEventListener('dragover', (event) => { if (draggedPosition !== null) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over'); } });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (event) => { event.preventDefault(); row.classList.remove('drag-over'); if (draggedPosition !== null && draggedPosition !== position) void useControl('reorder', { from: draggedPosition, to: position }); draggedPosition = null; });
      row.addEventListener('dragend', () => { draggedPosition = null; document.querySelectorAll('.dragging,.drag-over').forEach((node) => node.classList.remove('dragging', 'drag-over')); });
      fragment.append(row);
    });
    $('queue-body').replaceChildren(fragment);
    if (focusedAction) { const matching = [...$('queue-body').querySelectorAll('button')].find((button) => button.dataset.queueAction === focusedAction && !button.disabled); matching?.focus({ preventScroll: true }); }
  }
  function healthEntries() { return ['ytdlp', 'ffmpeg', 'opus', 'dave', 'node'].map((key) => [key, model.health[key] || {}]); }
  function renderHealth() {
    const entries = [...healthEntries(), ['app', { ok: true, version: model.appVersion || model.health.appVersion || 'Desktop', message: 'Windows desktop application' }]];
    const signature = JSON.stringify(entries);
    if (signature !== model.healthSignature) {
      model.healthSignature = signature;
      const cards = document.createDocumentFragment();
      for (const [key, value] of entries) {
        const status = value.ok === true ? 'ok' : value.ok === false ? 'failed' : '';
        const title = value.ok === true ? 'Ready' : value.ok === false ? 'Needs attention' : 'Not checked';
        const card = make('div', 'health-card'); const badge = make('span', `health-icon ${status}`); badge.append(icon(value.ok ? 'check' : value.ok === false ? 'warning' : 'tools'));
        const detail = make('div', 'health-detail'); const heading = make('h3', '', names[key]); heading.append(make('span', `health-status ${status}`, title)); detail.append(heading, make('p', 'health-version', value.version || (value.ok ? 'Available' : 'Awaiting check')), make('p', 'health-message', value.message || (key === 'ytdlp' ? 'Official verified release' : ''))); card.append(badge, detail); cards.append(card);
      }
      $('health-grid').replaceChildren(cards);
    }
    const last = model.health.lastUpdateCheck || model.settings.lastUpdateCheck;
    text('last-update-check', last ? `Last yt-dlp update check: ${new Date(last).toLocaleString()}` : 'No update check recorded.');
    text('sidebar-version', `Dubplate ${model.appVersion || model.health.appVersion || 'Desktop'}`);
    renderSetupNavigation();
  }
  function renderBinaryProgress(progress) {
    const phase = progress?.phase || progress?.status || 'working';
    const active = Boolean(progress && !['complete', 'idle', 'done'].includes(phase));
    for (const prefix of ['', 'setup-']) {
      show(`${prefix}binary-progress`, active);
      const bar = $(`${prefix}binary-progress-bar`);
      const percent = progress?.percent ?? (progress?.total ? (progress.received || progress.downloaded || 0) / progress.total * 100 : undefined);
      if (Number.isFinite(percent)) bar.value = Math.min(100, Math.max(0, percent)); else bar.removeAttribute('value');
      text(`${prefix}binary-progress-text`, progress?.message || `${progress?.name || names[progress?.binary] || progress?.binary || 'Playback tool'}: ${phase}${Number.isFinite(percent) ? ` (${Math.round(percent)}%)` : '…'}`);
    }
  }
  function renderNotices() {
    const fragment = document.createDocumentFragment();
    model.notices.slice(-5).forEach((notice, index) => {
      const row = make('div', 'notice'); row.append(make('span', '', typeof notice === 'string' ? notice : notice.message || notice.text || 'An app setting needs your attention.'));
      const dismiss = queueButton('close', 'Dismiss notice', () => { model.notices.splice(Math.max(0, model.notices.length - 5) + index, 1); renderNotices(); }); row.append(dismiss); fragment.append(row);
    });
    $('global-notices').replaceChildren(fragment);
  }
  function logParts(entry) {
    if (typeof entry === 'string') return { time: '', level: 'info', message: entry };
    const rawTime = entry.timestamp || entry.time || entry.date;
    const parsedTime = rawTime ? new Date(rawTime) : null;
    return { time: parsedTime && Number.isFinite(parsedTime.getTime()) ? parsedTime.toLocaleTimeString([], { hour12: false }) : '', level: String(entry.level || 'info').toLowerCase(), message: String(entry.message ?? entry.text ?? '') };
  }
  function matchingLogs() {
    const source = model.logsPaused ? logSnapshot : model.logs;
    const level = $('log-level').value; const query = $('log-search').value.trim().toLowerCase();
    return source.map(logParts).filter((entry) => (level === 'all' || entry.level === level || (level === 'warn' && entry.level === 'warning')) && (!query || `${entry.message} ${entry.level}`.toLowerCase().includes(query)));
  }
  function renderLogs() {
    if (model.page !== 'logs') return;
    const view = $('log-view'); const wasBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 40;
    const entries = matchingLogs(); const fragment = document.createDocumentFragment();
    for (const entry of entries.slice(-1000)) { const row = make('div', 'log-entry'); row.append(make('time', '', entry.time), make('span', `log-level ${['info', 'warn', 'warning', 'error', 'debug'].includes(entry.level) ? entry.level : 'info'}`, entry.level), make('span', 'log-message', entry.message)); fragment.append(row); }
    if (!entries.length) fragment.append(make('p', 'log-empty', model.logs.length ? 'No activity matches these filters.' : 'All quiet. Activity will appear here when your bot starts.'));
    view.replaceChildren(fragment);
    if (wasBottom && !model.logsPaused) view.scrollTop = view.scrollHeight;
    text('log-status', `${Math.min(entries.length, 1000)} visible entries${entries.length > 1000 ? ' · showing the most recent 1,000' : ''} · ${model.logsPaused ? 'tail paused' : 'following live activity'}`);
  }
  function scheduleLogs() {
    text('log-count', model.logs.length > 999 ? '999+' : model.logs.length);
    if (model.logScheduled || model.logsPaused) return;
    model.logScheduled = true; setTimeout(() => { model.logScheduled = false; renderLogs(); }, 120);
  }
  function setPage(page) {
    if (!pageNames[page]) return;
    model.page = page;
    for (const name of Object.keys(pageNames)) show(`page-${name}`, page === name);
    document.querySelectorAll('[data-page]').forEach((button) => { const active = button.dataset.page === page; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
    text('page-eyebrow', pageNames[page][0]); text('page-title', pageNames[page][1]);
    if (page === 'logs') renderLogs();
    if (page === 'health' && model.tokenConfigured && model.settings.guildId) void fetchVoiceChannels();
    if (page === 'settings' && !settingsDirty) fillSettings();
  }
  function fillSettings() {
    const settings = model.settings;
    $('setting-idle').value = String(settings.idleTimeoutSeconds ?? 300);
    $('setting-queue').value = String(settings.maxQueue ?? 200);
    $('setting-volume').value = String(Math.round((settings.defaultVolume ?? 0.5) * 100));
    $('setting-ffmpeg').value = settings.ffmpegPath || '';
    $('setting-ytdlp').value = settings.ytdlpPath || model.health.ytdlp?.path || 'Managed by Dubplate';
    $('setting-hosts').value = (settings.allowedHosts || ['youtube.com', 'youtu.be', 'music.youtube.com', 'soundcloud.com', 'bandcamp.com']).join('\n');
    $('setting-autoupdate').checked = settings.autoUpdateYtdlp !== false;
    $('setting-autostart').checked = Boolean(settings.startWithWindows);
    $('setting-minimized').checked = Boolean(settings.startMinimized);
    $('setting-tray').checked = settings.closeToTray !== false;
    $('setup-autostart').checked = Boolean(settings.startWithWindows);
    $('setup-minimized').checked = Boolean(settings.startMinimized);
    $('ack-hosts').checked = false; show('host-warning', false);
    renderGuilds(); renderIdentity();
  }
  function hostsFromInput() { return $('setting-hosts').value.split(/[\n,]/).map((host) => host.trim().toLowerCase()).filter(Boolean); }
  function newHosts() { const saved = new Set(model.settings.allowedHosts || ['youtube.com', 'youtu.be', 'music.youtube.com', 'soundcloud.com', 'bandcamp.com']); return hostsFromInput().filter((host) => !saved.has(host)); }
  function fieldError(name, message) {
    text(`error-${name}`, message); const ids = { idleTimeoutSeconds: 'setting-idle', maxQueue: 'setting-queue', defaultVolume: 'setting-volume', ffmpegPath: 'setting-ffmpeg', allowedHosts: 'setting-hosts' };
    const input = $(ids[name]); if (message) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', `error-${name}`); } else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
  }
  async function saveSettings(event) {
    event.preventDefault(); error('settings-error', ''); error('settings-success', ''); let valid = true;
    const patch = {};
    const numeric = [['idleTimeoutSeconds', 'setting-idle', 1, 86400, true], ['maxQueue', 'setting-queue', 1, 10000, true], ['defaultVolume', 'setting-volume', 0, 150, false]];
    for (const [key, id, min, max, integer] of numeric) {
      const raw = $(id).value.trim(); const number = Number(raw);
      const fail = !raw || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number));
      fieldError(key, fail ? `Enter ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.` : '');
      if (fail) valid = false; else patch[key] = key === 'defaultVolume' ? number / 100 : number;
    }
    const hosts = hostsFromInput();
    const invalidHost = hosts.find((host) => host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) || /(?:^|\.)(?:localhost|local|invalid|test)$/.test(host));
    const hostError = !hosts.length ? 'Add at least one trusted media domain.' : invalidHost ? `Use a domain name only: ${invalidHost}` : hosts.length > 100 ? 'Use 100 or fewer domains.' : newHosts().length && !$('ack-hosts').checked ? 'Acknowledge the warning before adding new hosts.' : '';
    fieldError('allowedHosts', hostError); if (hostError) valid = false;
    const path = $('setting-ffmpeg').value.trim(); fieldError('ffmpegPath', path.length > 1024 || /[\u0000-\u001f]/.test(path) ? 'Choose a valid local path, up to 1,024 characters.' : ''); if (path.length > 1024 || /[\u0000-\u001f]/.test(path)) valid = false;
    if (!valid) { $('settings-form').querySelector('[aria-invalid=true]')?.focus(); return; }
    Object.assign(patch, { allowedHosts: [...new Set(hosts)], autoUpdateYtdlp: $('setting-autoupdate').checked, startWithWindows: $('setting-autostart').checked, startMinimized: $('setting-minimized').checked, closeToTray: $('setting-tray').checked });
    const guildId = $('setting-guild').value; if (guildId) patch.guildId = guildId;
    await task($('save-settings'), async () => {
      const saved = await api.saveSettings(patch); model.settings = saved?.settings || { ...model.settings, ...patch, ...(saved && !saved.settings ? saved : {}) }; settingsDirty = false; fillSettings(); error('settings-success', 'Settings saved. Playback defaults are applied when the bot starts.');
    }, 'settings-error');
  }
  function renderIdentity() {
    text('token-status', model.tokenConfigured ? 'Configured · encrypted for this Windows account' : 'No token configured');
    show('setup-identity', model.tokenConfigured);
    text('bot-name', model.identity?.name || 'Your Discord bot');
    updateImage($('bot-avatar'), $('bot-avatar-placeholder'), model.identity?.avatar);
    if (model.tokenConfigured) $('setup-token').placeholder = 'Token configured. Paste another to replace it.';
    renderSetupNavigation();
  }
  async function validateSetupToken(event) {
    if (event) event.preventDefault(); clearTimeout(tokenDebounce);
    if (model.tokenPending) return;
    const input = $('setup-token');
    if (!input.value.trim()) { if (!model.tokenConfigured) error('setup-token-error', 'Paste the token from the Bot page in the Discord Developer Portal.'); return; }
    if (!checkTokenShape(true)) return;
    model.tokenPending = true;
    renderSetupNavigation();
    text('token-shape-help', 'Connecting securely to Discord…');
    await task($('validate-token'), async () => {
      const identity = await api.validateToken(input.value.trim());
      input.value = ''; input.removeAttribute('aria-invalid'); model.identity = identity; model.tokenConfigured = true; model.selectedGuild = null; model.voicePassedKey = ''; renderIdentity(); text('token-shape-help', 'Connected. Your token has been encrypted and cleared.');
    }, 'setup-token-error');
    model.tokenPending = false; renderSetupNavigation();
  }
  function checkTokenShape(report = false) {
    const input = $('setup-token');
    const candidate = input.value.trim();
    const valid = /^[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,160}$/.test(candidate);
    if (!valid && report && candidate) {
      input.setAttribute('aria-invalid', 'true');
      error('setup-token-error', 'That does not look like a bot token. Copy the full token from Discord → Bot → Reset Token; it has three parts separated by periods.');
    } else input.removeAttribute('aria-invalid');
    return valid;
  }
  function tokenInputChanged() {
    clearTimeout(tokenDebounce); error('setup-token-error', ''); renderSetupNavigation();
    text('token-shape-help', 'We only read your clipboard when you click Paste.');
    const valid = checkTokenShape(false);
    if (valid) { text('token-shape-help', 'Token format looks right. Connecting to Discord…'); tokenDebounce = setTimeout(() => void validateSetupToken(), 900); }
  }
  async function replaceToken(event) {
    event.preventDefault();
    if (!$('replacement-token').value.trim()) { error('replace-token-error', 'Paste the replacement bot token.'); return; }
    await task($('replace-token-submit'), async () => {
      model.identity = await api.replaceToken($('replacement-token').value.trim()); $('replacement-token').value = ''; model.tokenConfigured = true; show('replace-token-form', false); renderIdentity(); toast('Token validated and replaced.');
    }, 'replace-token-error');
  }
  function renderGuilds() {
    const signature = JSON.stringify([model.guilds, model.settings.guildId, model.selectedGuild?.name, model.state.guild?.name]);
    for (const id of ['setup-guild', 'setting-guild']) {
      const select = $(id); const chosen = select.value || model.settings.guildId;
      if (select.dataset.guildSignature === signature) continue;
      select.dataset.guildSignature = signature;
      const fragment = document.createDocumentFragment(); const blank = make('option', '', model.guilds.length ? 'Select your server' : 'No joined servers yet'); blank.value = ''; fragment.append(blank);
      for (const guild of model.guilds) { const option = make('option', '', guild.name); option.value = guild.id; fragment.append(option); }
      if (model.settings.guildId && !model.guilds.some((guild) => guild.id === model.settings.guildId)) { const option = make('option', '', model.selectedGuild?.name || model.state.guild?.name || 'Configured server'); option.value = model.settings.guildId; fragment.append(option); }
      select.replaceChildren(fragment);
      if ([...select.options].some((option) => option.value === chosen)) select.value = chosen;
    }
    text('guild-help', model.guilds.length ? 'Choose a server the bot has already joined.' : 'No servers yet. Use Add to my server above.');
    renderSelectedGuild(); renderSetupNavigation();
  }
  function renderSelectedGuild() {
    const guild = model.selectedGuild;
    show('setup-server', Boolean(guild?.id));
    show('guild-waiting', !guild?.id);
    text('server-name', guild?.name || 'Your server');
    updateImage($('server-icon'), $('server-icon-placeholder'), guild?.icon);
    disable('use-existing-guild', !$('setup-guild').value);
  }
  function applyGuildDiscovery(data) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.guilds)) model.guilds = data.guilds;
    if (data.selectedGuild?.id) {
      const changed = model.settings.guildId !== data.selectedGuild.id;
      model.selectedGuild = data.selectedGuild; model.settings.guildId = data.selectedGuild.id;
      if (changed) { model.voicePassedKey = ''; model.voiceChannels = []; renderVoiceChannels(); }
      if (!model.guilds.some((guild) => guild.id === data.selectedGuild.id)) model.guilds.push(data.selectedGuild);
      error('guild-error', '');
    }
    if (data.status === 'error') error('guild-error', data.message || 'Discord could not be reached. Check your connection and try again.');
    text('guild-discovery-status', data.message || 'Waiting for Discord. Finish adding the bot in your browser.');
    renderGuilds(); renderPlayer();
  }
  async function startGuildDiscovery() {
    if (discoveryRequest || !model.tokenConfigured) return;
    discoveryRequest = true;
    try { applyGuildDiscovery(await api.beginGuildDiscovery()); }
    catch (failure) { error('guild-error', messageOf(failure)); }
    finally { discoveryRequest = false; renderSetupNavigation(); }
  }
  async function fetchGuilds(button) {
    if (guildRequest || !model.tokenConfigured) return;
    guildRequest = true;
    await task(button, async () => { const result = await api.listGuilds(); model.guilds = Array.isArray(result) ? result : result.guilds || []; renderGuilds(); }, model.setupStep === 2 && $('setup-dialog').open ? 'guild-error' : 'global-error');
    guildRequest = false;
  }
  async function useExistingGuild() {
    const guildId = $('setup-guild').value;
    if (!guildId) { error('guild-error', 'Choose a joined server first.'); return; }
    await task($('use-existing-guild'), async () => {
      const selected = await api.selectGuild(guildId);
      const guild = selected?.selectedGuild || (selected?.id ? selected : model.guilds.find((item) => item.id === guildId));
      if (guild) applyGuildDiscovery({ selectedGuild: guild });
      else await startGuildDiscovery();
    }, 'guild-error');
  }
  function renderSetupTools() {
    const tools = model.setupTools || {};
    const ready = tools.status === 'ready';
    const failed = tools.status === 'error' || tools.status === 'failed';
    $('setup-tools-status').className = 'setup-tools-status' + (ready ? ' ready' : failed ? ' failed' : '');
    setIcon($('setup-tools-status'), ready ? 'check' : failed ? 'warning' : 'download');
    text('setup-tools-status-text', ready ? 'Playback tools are ready.' : failed ? 'Playback tools need a quick fix.' : 'Preparing playback tools in the background…');
    show('setup-tools-recovery', failed);
    text('setup-tools-error', tools.message || 'A download could not finish. Retry, or choose a trusted copy of the missing tool.');
    if (ready || failed) show('setup-binary-progress', false);
    renderVoiceControls(); renderSetupNavigation();
  }
  function applySetupTools(value) {
    if (!value || typeof value !== 'object') return;
    model.setupTools = value;
    if (value.health) { model.health = value.health; renderHealth(); }
    renderSetupTools();
  }
  async function prepareSetup(button) {
    if (prepareRequest) return;
    prepareRequest = true;
    model.setupTools = { status: 'preparing' }; renderSetupTools();
    await task(button, async () => {
      try {
        const result = await api.prepareSetup();
        if (result && !(result.status === 'preparing' && ['ready', 'error', 'failed'].includes(model.setupTools.status))) applySetupTools(result);
      }
      catch (failure) { applySetupTools({ status: 'error', message: messageOf(failure) }); }
    }, 'setup-error');
    prepareRequest = false;
  }
  function renderVoiceChannels() {
    const channels = model.voiceChannels;
    const signature = JSON.stringify([model.settings.guildId, channels]);
    const occupied = channels.filter((channel) => Number(channel.listeners ?? channel.members ?? channel.memberCount ?? 0) > 0);
    for (const prefix of ['setup', 'health']) {
      const select = $(prefix + '-voice-channel');
      if (select.dataset.channelSignature === signature) continue;
      select.dataset.channelSignature = signature;
      const selected = select.value;
      const fragment = document.createDocumentFragment(); const blank = make('option', '', channels.length ? 'Choose your voice channel' : 'No voice channels found'); blank.value = ''; fragment.append(blank);
      for (const channel of channels) {
        const listeners = Number(channel.listeners ?? channel.members ?? channel.memberCount ?? 0);
        const option = make('option', '', channel.name + (listeners ? ' · ' + listeners + ' listening' : ''));
        option.value = channel.id; fragment.append(option);
      }
      select.replaceChildren(fragment);
      if (channels.some((channel) => channel.id === selected)) select.value = selected;
      else if (occupied.length === 1) select.value = occupied[0].id;
      else if (channels.length === 1) select.value = channels[0].id;
    }
    text('setup-voice-help', occupied.length === 1 ? 'Selected the channel with people in it. Make sure you are there too.' : channels.length ? 'Join one of these channels in Discord, then select it here.' : 'Join a server with a regular voice channel, then refresh.');
    renderVoiceControls(); renderSetupNavigation();
  }
  function renderVoiceControls() {
    for (const prefix of ['setup', 'health']) {
      const hasChannel = Boolean($(prefix + '-voice-channel').value);
      disable(prefix + '-test-voice', !hasChannel || !model.tokenConfigured || !model.settings.guildId || model.voiceTestPending || (prefix === 'setup' && model.setupTools.status !== 'ready'));
      disable('refresh-' + prefix + '-voice', voiceChannelRequest || model.voiceTestPending || !model.tokenConfigured || !model.settings.guildId);
    }
  }
  async function fetchVoiceChannels(button) {
    if (voiceChannelRequest || !model.tokenConfigured || !model.settings.guildId) return;
    voiceChannelRequest = true; renderVoiceControls();
    const prefix = $('setup-dialog').open ? 'setup' : 'health';
    await task(button, async () => {
      const result = await api.listVoiceChannels();
      model.voiceChannels = Array.isArray(result) ? result : result?.channels || [];
      renderVoiceChannels();
    }, prefix + '-voice-error');
    voiceChannelRequest = false; renderVoiceControls();
  }
  function applyVoiceTestProgress(result) {
    if (!result || typeof result !== 'object') return;
    const prefix = model.voiceTestSurface;
    const status = result.status || result.phase || '';
    const active = !['success', 'complete', 'passed', 'error', 'failed', 'idle'].includes(status);
    show(prefix + '-voice-progress', active);
    text(prefix + '-voice-progress-text', result.message || 'Connecting to voice…');
    if (['error', 'failed'].includes(status)) error(prefix + '-voice-error', result.message || 'Voice test failed. Check the channel permissions and try again.');
  }
  async function testVoice(prefix) {
    if (model.voiceTestPending) return;
    const channelId = $(prefix + '-voice-channel').value;
    if (!channelId) { error(prefix + '-voice-error', 'Join a voice channel in Discord, then choose it here.'); return; }
    model.voiceTestPending = true; model.voiceTestSurface = prefix; model.voicePassedKey = '';
    error(prefix + '-voice-result', ''); error(prefix + '-voice-error', '');
    show(prefix + '-voice-progress'); text(prefix + '-voice-progress-text', 'Connecting, playing a short tone, then leaving…');
    renderVoiceControls(); renderSetupNavigation();
    await task($(prefix + '-test-voice'), async () => {
      const result = await api.testVoice({ voiceChannelId: channelId });
      if (result?.ok !== true) throw new Error(result?.message || 'The voice test did not confirm a connection. Please try again.');
      model.voicePassedKey = model.settings.guildId + ':' + channelId;
      error(prefix + '-voice-result', result?.message || 'Connection test passed. The test tone was sent and the bot left the channel.');
    }, prefix + '-voice-error');
    model.voiceTestPending = false; show(prefix + '-voice-progress', false); renderVoiceControls(); renderSetupNavigation();
  }
  function renderSetupNavigation() {
    if (!$('setup-dialog').open) return;
    disable('setup-back', model.setupStep === 0 || model.voiceTestPending);
    disable('paste-token', model.tokenPending); disable('setup-token', model.tokenPending);
    let canAdvance = true;
    if (model.setupStep === 1) canAdvance = model.tokenConfigured && !model.tokenPending && !$('setup-token').value.trim();
    if (model.setupStep === 2) canAdvance = Boolean(model.selectedGuild?.id);
    if (model.setupStep === 3) canAdvance = model.voicePassedKey === model.settings.guildId + ':' + $('setup-voice-channel').value && model.setupTools.status === 'ready' && !model.voiceTestPending;
    if (model.setupStep === 4) canAdvance = model.tokenConfigured && Boolean(model.selectedGuild?.id) && Boolean(model.voicePassedKey) && model.setupTools.status === 'ready';
    disable('setup-next', !canAdvance);
    const button = $('setup-next');
    if (!busyButtons.has(button)) button.replaceChildren(document.createTextNode(model.setupStep === 4 ? 'Start listening' : 'Continue'), icon('arrow'));
    document.querySelectorAll('#setup-step-list [data-step]').forEach((item) => { const step = Number(item.dataset.step); item.classList.toggle('current', step === model.setupStep); item.classList.toggle('complete', step < model.setupStep); if (step === model.setupStep) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current'); });
  }
  function setSetupStep(step) {
    model.setupStep = Math.max(0, Math.min(4, step)); error('setup-error', '');
    document.querySelectorAll('.setup-step').forEach((section) => { section.hidden = Number(section.dataset.step) !== model.setupStep; });
    text('setup-title', stepTitles[model.setupStep]); text('setup-step-counter', 'STEP ' + String(model.setupStep + 1).padStart(2, '0') + ' OF 05');
    renderSetupNavigation();
    if (model.setupStep === 1) $('setup-token').focus();
    if (model.setupStep === 2) void startGuildDiscovery();
    if (model.setupStep === 3) void fetchVoiceChannels($('refresh-setup-voice'));
    document.querySelector('.setup-main')?.scrollTo(0, 0);
  }
  function openSetup() {
    model.setupWasComplete = model.setupComplete; model.voicePassedKey = ''; show('close-setup', model.setupWasComplete);
    if (!$('setup-dialog').open) $('setup-dialog').showModal();
    setSetupStep(0); void prepareSetup();
  }
  async function advanceSetup() {
    if (model.setupStep === 4) {
      await task($('setup-next'), async () => {
        await api.finishSetup({ startWithWindows: $('setup-autostart').checked, startMinimized: $('setup-minimized').checked });
        model.setupComplete = true; $('setup-dialog').close(); fillSettings(); setPage('listen'); toast('Your bot is ready. Add your first track.');
      }, 'setup-error'); return;
    }
    setSetupStep(model.setupStep + 1);
  }
  async function checkHealth(button) {
    await task(button, async () => { const health = await api.healthCheck(); if (health) { model.health = health.health || health; renderHealth(); } }, $('setup-dialog').open ? 'setup-error' : 'global-error');
  }
  async function binaryOperation(operation, button) {
    await task(button, async () => { await operation(); await checkHealth(); }, $('setup-dialog').open ? 'setup-error' : 'global-error');
  }
  async function chooseFfmpeg(button) {
    await task(button, async () => {
      const selected = await api.chooseFfmpeg();
      const path = typeof selected === 'string' ? selected : selected?.path || selected?.ffmpegPath;
      if (path) { model.settings.ffmpegPath = path; $('setting-ffmpeg').value = path; }
      if (selected?.settings) model.settings = selected.settings;
      if (selected) { await checkHealth(); if ($('setup-dialog').open) await prepareSetup(); }
    }, $('setup-dialog').open ? 'setup-error' : 'global-error');
  }
  async function importEnv(button, target) {
    await task(button, async () => {
      const result = await api.importEnv(); if (!result?.imported) return;
      const latest = await api.bootstrap(); applyBootstrap(latest, false);
      const box = $(target); box.replaceChildren(make('p', '', 'Configuration imported. Your token is now stored with Windows encryption.'));
      if (result.canDelete) {
        box.append(make('p', '', 'The original .env still contains a plaintext token. Remove it when you no longer need it. Overwriting cannot guarantee erasure from SSDs, backups or synced copies.'));
        const remove = make('button', 'button subtle compact', 'Delete the imported .env'); remove.type = 'button';
        remove.addEventListener('click', () => { void task(remove, async () => { await api.deleteImportedEnv(); box.replaceChildren(make('p', '', 'Imported configuration saved. The original .env was deleted.')); }, $('setup-dialog').open ? 'setup-error' : 'global-error'); }); box.append(remove);
      }
      box.hidden = false; toast('Previous configuration imported.');
    }, $('setup-dialog').open ? 'setup-error' : 'global-error');
  }
  function applyBootstrap(data, initial = true) {
    model.settings = data.settings || model.settings;
    model.state = data.state || model.state; model.stateReceivedAt = Date.now();
    model.health = data.health || model.health; model.logs = Array.isArray(data.logs) ? data.logs.slice(-2000) : model.logs;
    model.notices = Array.isArray(data.notices) ? data.notices : [];
    model.identity = data.identity || model.identity; model.tokenConfigured = Boolean(data.tokenConfigured);
    model.setupComplete = Boolean(data.setupComplete); model.appVersion = data.appVersion || '';
    if (Array.isArray(data.guilds)) model.guilds = data.guilds;
    if (data.setupTools) model.setupTools = data.setupTools;
    if (data.guildDiscovery) applyGuildDiscovery(data.guildDiscovery);
    fillSettings(); renderPlayer(); renderHealth(); renderNotices(); scheduleLogs(); renderBinaryProgress(data.binaryProgress);
    renderSetupTools(); renderVoiceChannels();
    if (initial && !model.setupComplete) openSetup();
  }
  function handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    const payload = event.payload;
    switch (event.type) {
      case 'state': model.state = payload || {}; model.stateReceivedAt = Date.now(); renderPlayer(); break;
      case 'health': model.health = payload || {}; renderHealth(); break;
      case 'log': if (payload) { model.logs.push(payload); if (model.logs.length > 2000) model.logs.splice(0, model.logs.length - 2000); scheduleLogs(); } break;
      case 'notice': if (payload) { model.notices.push(payload); renderNotices(); } break;
      case 'binaryProgress': renderBinaryProgress(payload); break;
      case 'setupTools': applySetupTools(payload); break;
      case 'guildDiscovery': applyGuildDiscovery(payload); break;
      case 'voiceTest': applyVoiceTestProgress(payload); break;
      case 'error': error('global-error', messageOf(payload)); break;
      case 'settings': model.settings = payload?.settings || payload || {}; if (!settingsDirty) fillSettings(); renderPlayer(); break;
      case 'supervisor': if (payload?.status) { model.state = { ...model.state, status: payload.status }; renderPlayer(); } if (payload?.message) toast(payload.message); break;
      default: break;
    }
  }
  function on(id, event, listener) { $(id).addEventListener(event, listener); }
  document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => setPage(button.dataset.page)));
  on('track-art', 'error', () => { $('track-art').dataset.failedSource = $('track-art').dataset.source; show('track-art', false); show('art-placeholder'); $('artwork').classList.remove('has-image'); });
  on('bot-avatar', 'error', () => { $('bot-avatar').dataset.failedSource = $('bot-avatar').dataset.source; show('bot-avatar', false); show('bot-avatar-placeholder'); });
  on('server-icon', 'error', () => { $('server-icon').dataset.failedSource = $('server-icon').dataset.source; show('server-icon', false); show('server-icon-placeholder'); });
  on('play-pause', 'click', () => useControl(['paused', 'autopaused'].includes(playback()) ? 'resume' : 'pause', {}, $('play-pause')));
  on('skip-track', 'click', () => useControl('skip', {}, $('skip-track')));
  on('stop-track', 'click', () => useControl('stop', {}, $('stop-track')));
  on('disconnect', 'click', () => useControl('disconnect', {}, $('disconnect')));
  on('seek', 'input', () => text('elapsed', duration($('seek').value)));
  on('seek', 'change', () => useControl('seek', { seconds: Number($('seek').value) }));
  on('volume', 'input', () => text('volume-value', `${$('volume').value}%`));
  on('volume', 'change', () => useControl('volume', { percent: Number($('volume').value) }));
  on('loop-mode', 'change', () => useControl('loop', { mode: $('loop-mode').value }));
  on('shuffle-queue', 'click', () => useControl('shuffle', {}, $('shuffle-queue'), 'Queue shuffled.'));
  on('clear-queue', 'click', () => useControl('clear', {}, $('clear-queue')));
  on('start-bot', 'click', () => task($('start-bot'), () => api.startBot()));
  on('stop-bot', 'click', () => task($('stop-bot'), () => api.stopBot()));
  on('restart-bot', 'click', () => task($('restart-bot'), () => api.restartBot()));
  on('add-form', 'submit', async (event) => {
    event.preventDefault();
    const query = $('add-query').value.trim(); const voiceChannelId = model.state.voice?.channelId || $('voice-channel').value;
    if (!query) { error('add-error', 'Enter a search phrase or a supported media URL.'); return; }
    if (!voiceChannelId) { error('add-error', 'Choose a voice channel for your bot first.'); return; }
    const original = $('add-query').value;
    await task($('add-submit'), async () => { await api.control('add', { query, voiceChannelId }); if ($('add-query').value === original) $('add-query').value = ''; toast('Track request added.'); }, 'add-error');
  });
  on('log-level', 'change', renderLogs); on('log-search', 'input', renderLogs);
  on('pause-logs', 'click', () => { model.logsPaused = !model.logsPaused; if (model.logsPaused) logSnapshot = model.logs.slice(); text('pause-logs', model.logsPaused ? 'Resume tail' : 'Pause tail'); $('pause-logs').setAttribute('aria-pressed', String(model.logsPaused)); show('logs-paused', model.logsPaused); renderLogs(); });
  on('copy-logs', 'click', () => {
    const selection = matchingLogs().slice(-1000).map((entry) => `${entry.time} [${entry.level.toUpperCase()}] ${entry.message}`).join('\n');
    void task($('copy-logs'), () => api.copyLogs(selection.slice(-1900000)), 'global-error', selection.length > 1900000 ? 'Recent matching logs copied (large selections are capped). Open the log folder for complete files.' : 'Visible logs copied.');
  });
  on('open-log-folder', 'click', () => task($('open-log-folder'), () => api.openLogFolder()));
  on('refresh-health', 'click', () => checkHealth($('refresh-health')));
  on('update-ytdlp', 'click', () => binaryOperation(() => api.updateYtdlp(), $('update-ytdlp')));
  on('install-ffmpeg', 'click', () => binaryOperation(() => api.installFfmpeg(), $('install-ffmpeg')));
  on('choose-ffmpeg-health', 'click', () => chooseFfmpeg($('choose-ffmpeg-health')));
  on('view-ffmpeg-source', 'click', () => task($('view-ffmpeg-source'), () => api.openExternal('ffmpeg')));
  on('refresh-health-voice', 'click', () => fetchVoiceChannels($('refresh-health-voice')));
  on('health-test-voice', 'click', () => testVoice('health'));
  on('health-voice-channel', 'change', renderVoiceControls);
  on('settings-form', 'submit', saveSettings);
  on('settings-form', 'input', () => { settingsDirty = true; error('settings-success', ''); });
  on('setting-hosts', 'input', () => { show('host-warning', newHosts().length > 0); $('ack-hosts').checked = false; });
  on('choose-ffmpeg-settings', 'click', () => chooseFfmpeg($('choose-ffmpeg-settings')));
  on('refresh-settings-guilds', 'click', () => fetchGuilds($('refresh-settings-guilds')));
  on('show-replace-token', 'click', () => { show('replace-token-form'); $('replacement-token').focus(); });
  on('replace-token-form', 'submit', replaceToken);
  on('replacement-token', 'input', () => error('replace-token-error', ''));
  on('rerun-setup', 'click', () => task($('rerun-setup'), async () => { await api.rerunSetup(); openSetup(); }));
  on('import-env-settings', 'click', () => importEnv($('import-env-settings'), 'import-result-settings'));
  on('import-env-setup', 'click', () => importEnv($('import-env-setup'), 'import-result-setup'));
  on('reset-data', 'click', () => { confirmAction = async () => { await api.resetData(); const current = await api.bootstrap(); settingsDirty = false; applyBootstrap(current, true); toast('App data reset. You can set up a new bot.'); }; $('confirm-dialog').showModal(); $('confirm-cancel').focus(); });
  on('confirm-cancel', 'click', () => { confirmAction = null; $('confirm-dialog').close(); });
  on('confirm-accept', 'click', async () => { const action = confirmAction; if (!action) return; await task($('confirm-accept'), async () => { $('confirm-dialog').close(); confirmAction = null; await action(); }); });
  on('open-portal', 'click', () => task($('open-portal'), () => api.openExternal('portal'), 'setup-error'));
  on('setup-token-form', 'submit', validateSetupToken);
  on('setup-token', 'input', tokenInputChanged);
  on('paste-token', 'click', () => task($('paste-token'), async () => { $('setup-token').value = await api.pasteToken(); tokenInputChanged(); $('setup-token').focus(); }, 'setup-token-error'));
  on('open-invite', 'click', () => task($('open-invite'), () => api.openExternal('invite'), 'setup-error'));
  on('refresh-guilds', 'click', () => fetchGuilds($('refresh-guilds')));
  on('setup-guild', 'change', renderSelectedGuild);
  on('use-existing-guild', 'click', useExistingGuild);
  on('setup-tools-retry', 'click', () => prepareSetup($('setup-tools-retry')));
  on('setup-choose-ffmpeg', 'click', () => chooseFfmpeg($('setup-choose-ffmpeg')));
  on('setup-choose-ytdlp', 'click', () => task($('setup-choose-ytdlp'), async () => { const chosen = await api.chooseYtdlp(); if (chosen) await prepareSetup(); }, 'setup-error'));
  on('refresh-setup-voice', 'click', () => fetchVoiceChannels($('refresh-setup-voice')));
  on('setup-test-voice', 'click', () => testVoice('setup'));
  on('setup-voice-channel', 'change', () => { model.voicePassedKey = ''; error('setup-voice-result', ''); error('setup-voice-error', ''); renderVoiceControls(); renderSetupNavigation(); });
  on('setup-back', 'click', () => setSetupStep(model.setupStep - 1));
  on('setup-next', 'click', advanceSetup);
  on('close-setup', 'click', () => { clearTimeout(tokenDebounce); $('setup-token').value = ''; $('setup-dialog').close(); });
  on('setup-dialog', 'cancel', (event) => { if (!model.setupWasComplete) event.preventDefault(); else { clearTimeout(tokenDebounce); $('setup-token').value = ''; } });
  window.addEventListener('beforeunload', () => { unsubscribe?.(); clearTimeout(tokenDebounce); $('setup-token').value = ''; $('replacement-token').value = ''; });
  setInterval(updateClocks, 1000);
  async function start() {
    if (!api) { error('global-error', 'Dubplate could not connect to its desktop bridge. Close and reopen the application.'); text('connection-status', 'Desktop bridge unavailable'); return; }
    try { unsubscribe = api.onEvent(handleEvent); applyBootstrap(await api.bootstrap()); }
    catch (failure) { error('global-error', `Dubplate could not load: ${messageOf(failure)}`); text('connection-status', 'Needs attention'); }
  }
  void start();
})();
