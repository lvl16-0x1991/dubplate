# Contributing

Use a current supported Node release, clone the repository, and run `npm ci`. The project uses plain JavaScript and Electron; there is no renderer bundler. Windows is the desktop target, while the headless core and unit tests also run on Linux.

Before opening a pull request, run:

```text
npm run check
npm test
npm run scan:secrets
```

The audio integration tests require ffmpeg and yt-dlp on PATH (or `FFMPEG_PATH` and `YT_DLP_PATH`). They use a local test fixture and need no Discord token. `npm run prepare:runtime` downloads the checksum-verified Node runtime for desktop development; `npm start` launches Dubplate and `npm run dist` builds the Windows NSIS installer. Never commit generated runtime files, installers, downloaded media tools, `.env`, app settings, tokens, or logs.

Keep changes focused, describe the user-visible behavior, and explain how you tested it. Preserve the playback core, process cleanup, URL restrictions, strict IPC validation, token protection, and sandboxed renderer. Add a regression test when fixing a security or playback bug. Update the threat model when changing a trust boundary or network access.

Dependency versions are exact; update the lockfile with dependency changes. GitHub Actions must remain pinned to full commit hashes. A release tag must equal `v` followed by the version in `package.json`; the release workflow builds the installer and publishes its SHA-256 checksum without requiring credentials. Optional [Azure Artifact Signing](docs/signing.md) runs in a separate job only when all required repository secrets are present.

Report security issues through the private process in [SECURITY.md](SECURITY.md), rather than a public pull request or issue.
