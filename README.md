# Dubplate

Dubplate is a self-hosted Discord music bot for Windows. Install one desktop app, connect your bot with the guided setup, and play music together from Discord or the built-in player. Your bot runs on your PC, your token stays encrypted in your Windows account, and everyday use needs no terminal, `.env` editing, or Task Scheduler.

> **What you need**
>
> Windows 10 or 11 on an x64 PC, a Discord account, and **Manage Server** permission in the server where you want music. A normal home internet connection is recommended. Keep the PC on and Dubplate running while you listen; the bot goes offline when either stops.

## A look around

Screenshot placeholders are reserved below. See the [screenshot instructions](docs/images/README.md) before adding the final images.

| Setup wizard | Player | Settings |
| --- | --- | --- |
| ![Dubplate setup wizard — screenshot to be added](docs/images/setup-wizard.png) | ![Dubplate player — screenshot to be added](docs/images/player.png) | ![Dubplate settings — screenshot to be added](docs/images/settings.png) |

## What you get

- A five-step setup with token validation, automatic server detection, and a real voice-connection test. Playback tools prepare in the background.
- One private Discord server per app instance, with slash commands and desktop controls sharing the same live player.
- Search, supported links, playlists, a reorderable queue, seek, pause, skip, loop, and volume from 0–150%.
- Artwork, requesters, voice-channel listeners, and automatic disconnect countdowns.
- A tray menu, optional Windows autostart, and recovery when the bot process crashes.
- Managed yt-dlp updates, FFmpeg installation, and visible Opus/DAVE health checks.
- Searchable live logs, rotating files, encrypted tokens, and an editable media-host allowlist.
- A small headless entry point for Linux and existing server deployments.

Users are responsible for complying with the terms of service of the services they play content from.

## Install on Windows

1. Download **`Dubplate-Setup-0.1.0.exe`** from this repository's **Releases** page. Choose the Windows x64 installer.
2. Run the installer. Dubplate installs for your Windows account without administrator rights and adds a Start menu shortcut.
3. Open **Dubplate** and follow setup. Internet access is needed for Discord and initial playback-tool downloads.

The default installer is **unsigned**. Windows SmartScreen may warn that the publisher is unknown or the app has insufficient reputation. Review the release source and published checksum before deciding whether to install; an unsigned installer does not provide a verified publisher identity. Maintainers can optionally configure [Azure signing](docs/signing.md) for signed releases. Signing is not required to build or use Dubplate.

Dubplate bundles its JavaScript runtime. You do not need to install Node.js, Python, FFmpeg, or yt-dlp yourself. FFmpeg and yt-dlp are downloaded when needed rather than included in the repository or installer.

## First-time setup

1. **Create your bot.** Use **Open Developer Portal**, choose **New Application**, open the **Bot** tab, then choose **Reset Token** and copy it. Those are the only Discord setup steps needed to continue.
2. **Connect your bot.** Click **Paste** or paste into the masked field. Dubplate checks the format, validates with Discord, and shows the bot's name and avatar. The token is encrypted using Windows DPAPI through Electron `safeStorage`, then cleared from the field. Your clipboard is read only when you click Paste. If secure storage is unavailable, the app refuses to store the token.
3. **Add to your server.** Click **Add to my server** and authorize the bot in Discord. Dubplate detects the new server through the live Discord connection, selects it, and shows its name and icon. If the bot is already there, expand **Already added the bot?** and choose the server. No IDs or permission numbers need to be entered.
4. **Test voice.** Join a regular voice channel in Discord, choose it in the app, and click **Test connection**. If exactly one channel has people in it, Dubplate selects it for you. The bot connects, plays a short original test tone, and leaves. Permission, full-channel, and connection-timeout failures explain what needs changing. A successful test unlocks the final step.
5. **Finish.** Choose **Start with Windows** and **Start minimized to tray**, then select **Start listening**.

Playback tools download and verify in the background while you set up Discord. A small progress indicator shows the status. If a download fails, the app offers **Retry download** and a native file picker for an existing tool; managed yt-dlp still has to match its official published checksum. The voice test waits until the tools are ready. You can run the same test later in **Health**.

**Use a dedicated Discord application:** Dubplate replaces that application's slash-command list in the selected server whenever the bot starts. Sharing the application with another bot will overwrite that bot's guild commands.

The generated invite requests `bot` and `applications.commands` scopes with permission integer `3165184`: View Channels, Send Messages, Embed Links, Connect, and Speak. Channel overrides still apply. Stage channels are not supported, and privileged gateway intents are unnecessary.

**Moving from the old bot:** expand the import option on the first setup screen, or use **Settings → Import old .env**. Choose its folder to import the token, server, idle timeout, queue limit, and default volume. After successful import, Dubplate offers to delete the old plaintext file. Deletion cannot guarantee removal from SSDs, backups, or synced copies.

### Optional hardening

To prevent other people from inviting your bot, open **Installation** in the Developer Portal and set **Install Link** to **None**, then turn **Public Bot** off on the **Bot** tab. Leave **Requires OAuth2 Code Grant** off. These are optional privacy settings, separate from the setup steps above.

## Daily use

Join a voice channel in the selected server. In Dubplate, choose that channel, search for a track or paste a supported link, and select **Add to queue**. You can also use `/play` in Discord. Searches use YouTube; links are limited to configured media hosts.

Seek with the progress bar, change volume, pause/resume, skip, or select a loop mode. Drag queue rows to reorder them, or use their keyboard-accessible up/down buttons. **Clear queue** removes upcoming tracks. **Stop** cancels playback, clears the queue, and leaves voice. **Disconnect** also ends the current voice session.

Desktop changes appear in Discord's player state, and slash-command changes appear in the app. Dubplate leaves voice after the configured idle timeout (five minutes by default), or after being alone without human listeners for 30 seconds. The queue is held in memory and is lost when the bot restarts.

| Discord command | Action |
| --- | --- |
| `/play query:` | Search or queue a supported media URL or playlist. |
| `/pause`, `/resume` | Pause or resume playback. |
| `/skip` | Move to the next track, including when looping. |
| `/stop` | Clear pending work and the queue, stop playback, and disconnect. |
| `/nowplaying` | Show the current track and playback time. |
| `/queue [page:]` | Browse the queue. |
| `/remove position:` | Remove a track using its displayed queue position. |
| `/clear`, `/shuffle` | Clear or shuffle upcoming tracks. |
| `/seek seconds:` | Seek to an absolute time; live streams cannot be seeked. |
| `/volume percent:` | Set volume from 0–150%. |
| `/loop mode:` | Loop off, the current track, or the queue. |

Closing the window keeps Dubplate in the tray by default. Use the tray to show the window, pause/resume, skip, restart, or **Quit**. Quit leaves voice and stops playback processes. Change close-to-tray behavior in Settings. Autostart uses Windows login settings; it does not create a scheduled task.

## Settings, tools, and data

Settings includes the server, idle timeout (1–86,400 seconds), maximum queue (1–10,000), default volume (0–150%), FFmpeg path, allowed hosts, and desktop behavior. Saving settings restarts a running bot. Token replacement and setup are available under **Account & data**.

By default, links may target `youtube.com`, `youtu.be`, `music.youtube.com`, `soundcloud.com`, and `bandcamp.com`, including their subdomains. Domain matching rejects lookalike suffixes, IP literals, URL user information, and non-default ports. Adding a host permits Discord users to request media from it and its subdomains; only add providers you trust. Current yt-dlp has no redirect-host allowlist option, so provider redirects and extractor requests remain a residual risk. See the [threat model](docs/threat-model.md).

**Health** shows the app, yt-dlp, FFmpeg, Node.js, Opus, and DAVE status. **Update yt-dlp** downloads the official executable from the [yt-dlp GitHub releases](https://github.com/yt-dlp/yt-dlp/releases), checks the published `SHA2-256SUMS` checksum, and replaces the previous copy only after verification. Daily update checking is on by default. Managed FFmpeg uses the [Gyan.dev Windows essentials build](https://www.gyan.dev/ffmpeg/builds/) and its publisher's [GitHub distribution](https://github.com/GyanD/codexffmpeg/releases), with the published SHA-256 checksum. Failed updates preserve the last working version.

The development baseline uses yt-dlp **2026.08.19** and FFmpeg **9.0.1**; managed updates can select newer releases. Dubplate does not automatically update the desktop app itself. Install a newer app release when available.

App data lives in `%APPDATA%\Dubplate`: settings JSON, the encrypted credential, downloaded tools under `bin`, and logs under `logs`. **Activity → Open log folder** opens the location directly. Logs redact known tokens, are capped at 1 MiB per file and 28 files, and retain at most seven days. Review logs before sharing them because track names and server context can still be personal information.

**Reset app data** stops the bot and removes its saved data after confirmation. The Windows uninstaller also offers to remove app data. Keeping it preserves setup for a reinstall on the same Windows account.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Token is rejected | Use the **Bot** token, not an application ID or client secret. If reset in Discord, use **Replace token** in Settings. Check the validation message. |
| Server has not appeared | Complete **Add to my server** in Discord. The live connection detects the join automatically. If the bot was already present, expand **Already added the bot?** and refresh that list. |
| Voice test reports missing permissions | Allow View Channels, Connect, and Speak for the bot in that specific channel, then retry. |
| Voice test reports a full channel | Choose another channel or free a space in the selected channel. |
| Voice connection times out | Retry on a normal home connection; a VPN, firewall, or managed network may block Discord voice traffic. |
| Bot cannot join or is silent | Use a regular voice channel, verify View Channels / Connect / Speak permissions, and check volume and Health. |
| Slash commands are missing | Restart after choosing the server. Check permission to use application commands. Registration errors appear in Activity. |
| A source fails or YouTube reports an error | Update yt-dlp and retry. Source-site changes, restrictions, unavailable tracks, or network failures can still prevent playback. |
| Link is blocked | Inspect its domain and the allowed-host list. An unrelated domain is blocked even when the URL contains an allowed site's name. |
| Download or checksum check fails | Check connectivity and retry through Health. Dubplate will not run an unverified managed download. |
| FFmpeg is missing | Install it in Health or choose a trusted existing `ffmpeg.exe` with Browse. Pasting an arbitrary executable path is deliberately unavailable. |
| Opus or DAVE check fails | Reinstall the current release and inspect Activity. These components ship with the app; keep packaged application files together. |
| Bot stops after everyone leaves | The 30-second empty-channel timer is intentional. Rejoin voice and add a track. |
| Settings were restored to defaults | The file was corrupt, unreadable, or incompatible. The app shows a notice and lets you run setup again. |
| App seems closed but music continues | Closing normally hides the window in the tray. Choose **Show** there, or **Quit** to shut down. |

Report bugs with the app version, Windows version, reproduction steps, and redacted logs. Report vulnerabilities privately through GitHub security advisories as described in [SECURITY.md](SECURITY.md). Never attach a token or old `.env` file.

## For developers

Use **Node.js 24.21.0 or newer** and npm. Electron is pinned to **44.4.1** and electron-builder to **26.15.3**; the lockfile records exact dependency versions. The UI is local HTML/CSS/JavaScript. Electron main owns lifecycle, storage, binary downloads, and validated IPC; an Electron `utilityProcess` owns the bot core and audio. There is no HTTP server or local listening API. The renderer is sandboxed with context isolation and no Node integration.

```powershell
npm ci
npm run prepare:runtime
npm start
```

`prepare:runtime` obtains official Windows x64 **Node.js 24.21.0** and checks it against the release's `SHASUMS256.txt`. The packaged binary is `resources/runtime/node.exe`; development uses `build/runtime/node.exe`. Dubplate explicitly supplies this path to yt-dlp's Node JavaScript-runtime option, so YouTube extraction does not rely on PATH or Electron being a Node CLI. Runtime preparation is also part of the packaging scripts.

```powershell
npm run check
npm test
npm run scan:secrets
npm run dist
```

The Windows x64 NSIS installer is **`dist/Dubplate-Setup-0.1.0.exe`**. Packaging keeps native DAVE binaries outside ASAR as needed. FFmpeg decodes to 48 kHz stereo signed 16-bit PCM over a pipe; the voice library applies inline volume and encodes Opus once. The pipe-only FFmpeg protocol whitelist, playback watchdog, seek support, and process-tree cleanup are retained.

Tests cover playback behavior, host allowlisting, settings validation/migration, IPC validation, checksums, redaction, and renderer security. The default CI and release build need no Discord tokens or repository secrets. Optional Azure signing uses separately configured credentials; see [Windows signing](docs/signing.md). Passing tests do not establish live Discord playback: authenticated slash commands, audible remote voice output, live DAVE negotiation, and source-site availability need a real bot/server. Release verification notes should identify which installer and packaged smoke checks were actually run.

For headless Windows or Linux, install compatible FFmpeg and yt-dlp locally, copy `.env.example` to `.env`, fill `DISCORD_TOKEN` and `GUILD_ID`, then run:

```text
npm run headless
```

Headless configuration supports `FFMPEG_PATH`, `YT_DLP_PATH`, `NODE_RUNTIME_PATH`, `IDLE_TIMEOUT_SECONDS`, `MAX_QUEUE`, `DEFAULT_VOLUME` (0–1.5), and comma-separated `ALLOWED_HOSTS`. It uses the same validation and playback core. Headless `.env` credentials are plaintext, separate from the desktop encrypted store; keep the file private and outside version control. Use Ctrl+C for graceful shutdown.

Dubplate is licensed under the [MIT License](LICENSE), copyright Ilia Zharnikov. Third-party tools and dependencies retain their own licenses. This project is not affiliated with Discord or the media services it can play.
