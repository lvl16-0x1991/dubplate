# Security policy

Security fixes are supported on the latest released version of Dubplate. Update before reporting a problem that a newer release may already fix.

Please report suspected vulnerabilities privately through this repository’s **Security → Advisories → Report a vulnerability** form. Include the affected version, operating system, reproduction steps, expected behavior, and impact. Use a minimal example without a real Discord token, personal server details, or unredacted logs. Do not open a public issue containing exploitation details or credentials.

If private vulnerability reporting is unavailable, open an issue asking the maintainer to enable GitHub private vulnerability reporting; describe only that you need a private reporting channel. Do not post the vulnerability itself while that channel is being arranged.

The maintainer will investigate privately and coordinate a fix and disclosure with the reporter. There is no guaranteed response time or bug bounty. If a Discord token has been exposed, reset it immediately in the Discord Developer Portal and replace it in Dubplate.

Read the [threat model](docs/threat-model.md) for the security boundaries, tested controls, and remaining risks. SHA-256 checksums detect changed downloads; they do not establish publisher identity or independent auditing. Installers are unsigned by default; maintainers may enable [Azure Artifact Signing](docs/signing.md) for the outer Setup executable.
