# Optional Windows installer signing

Dubplate builds and releases without any signing credentials. By default, `npm run dist` and the GitHub release workflow produce an unsigned installer. Windows SmartScreen may warn about an unknown publisher or insufficient reputation.

The release workflow can optionally sign the finished Setup executable with **Microsoft Azure Artifact Signing**. It uses the official [Azure Artifact Signing action](https://github.com/Azure/artifact-signing-action), pinned to version 2.0.0 at commit `c7ab2a863ab5f9a846ddb8265964877ef296ee82`. A signature identifies the publisher and protects the signed file against modification; it does not guarantee that SmartScreen will never display a warning.

## Configure Azure

1. Create an Artifact Signing account in a supported Azure region and complete the required identity validation. Use a **Public Trust** certificate profile suitable for distributing Windows software. Check Microsoft's current availability, eligibility, and pricing before provisioning the service.
2. Create a dedicated Microsoft Entra app registration and service principal for this repository's release signing. Create a client secret and record its **value**, tenant ID, and application/client ID.
3. Grant that service principal the **Artifact Signing Certificate Profile Signer** role on the intended certificate profile. Avoid granting broader subscription or resource-management permissions for signing.
4. Record the account's regional endpoint, signing-account name, and certificate-profile name. The endpoint must match the account's region; an example is `https://eus.codesigning.azure.net/`.

See the [Microsoft Artifact Signing documentation](https://learn.microsoft.com/azure/artifact-signing/) and [supported roles](https://learn.microsoft.com/azure/artifact-signing/concept-resources-roles#supported-roles) for the Azure setup. No Azure resources, identity validation, or paid service configuration are created by this repository.

## Add GitHub Actions secrets

In the repository, open **Settings → Secrets and variables → Actions → New repository secret**. Set these exact names:

| Secret | Value |
| --- | --- |
| `AZURE_TENANT_ID` | Microsoft Entra tenant/directory ID, as a GUID. |
| `AZURE_CLIENT_ID` | App registration application/client ID, as a GUID. |
| `AZURE_CLIENT_SECRET` | The app registration's client-secret value. |
| `AZURE_SIGNING_ENDPOINT` | HTTPS regional endpoint, such as `https://eus.codesigning.azure.net/`. |
| `AZURE_SIGNING_ACCOUNT_NAME` | Artifact Signing account name. |
| `AZURE_SIGNING_CERTIFICATE_PROFILE` | Public Trust certificate-profile name. |

Keep credentials in GitHub secrets. Do not add them to `.env.example`, source files, workflow literals, screenshots, or release attachments. Rotate the client secret before it expires. Remove all six secrets to return the workflow to unsigned releases.

The checked-in integration uses service-principal credentials. It excludes other Azure credential providers, including interactive login and Azure CLI fallback. Microsoft's action also supports OIDC; that requires a separate federated-identity configuration and corresponding workflow changes.

## What happens on release

Push a reviewed version tag matching `v` plus the version in `package.json`. The existing workflow then runs three jobs:

1. **Build:** install locked dependencies, run checks/tests and the secret scan, build the unsigned per-user NSIS installer, and upload that one executable. This job receives no Azure credentials.
2. **Sign and checksum:** download the installer in a separate Windows job. When all six secrets are present, validate their basic shape, sign the single Setup executable with SHA-256 and an RFC 3161 timestamp, then require a valid Authenticode signature and timestamp. Calculate `SHA256SUMS` from the final bytes after signing.
3. **Publish:** download the final artifacts and publish only `Dubplate-Setup-<version>.exe` and `SHA256SUMS`. This job uses GitHub's automatic token and receives no Azure credentials.

With no secrets, signing is skipped and the unsigned installer is checksummed and published. An incomplete configuration also produces an unsigned installer; the workflow summary lists the missing **secret names**, never their values. When all secrets are present, an invalid endpoint or ID, authentication failure, signing failure, or failed signature/timestamp verification stops the release. There is no fallback to an unsigned artifact after an enabled signing attempt fails.

Only the outer Setup executable is signed by this optional job. The executable files inside the installer and the generated uninstaller retain their existing signatures or unsigned state. Local `npm run dist` remains unsigned; setting Azure environment variables locally does not invoke the GitHub signing action.

## Verify a downloaded release

On Windows, inspect the installer's **Properties → Digital Signatures**, or use PowerShell:

```powershell
Get-AuthenticodeSignature -LiteralPath '.\Dubplate-Setup-0.1.0.exe' |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
Get-FileHash -LiteralPath '.\Dubplate-Setup-0.1.0.exe' -Algorithm SHA256
```

For a signed release, the signature status should be **Valid**, with the intended publisher and a timestamp. Compare the file hash with the release's `SHA256SUMS`. An unsigned release reports **NotSigned**; its checksum still detects a mismatch with the published artifact, but it does not establish a verified publisher identity.

## Troubleshooting and verification limits

If the workflow unexpectedly publishes unsigned, check its signing summary and all six repository-secret names. For authorization failures, check the service-principal secret's expiry and the certificate-profile signer role. For account/profile failures, confirm the regional endpoint, account name, profile name, and completed identity validation. Signing and timestamp services must be reachable from the Windows runner.

Automated tests execute the actual workflow gate with absent, incomplete, complete, and invalid fixture configuration, and check that secret values do not appear in its output. The workflow also checks the resulting signature and timestamp before publication. Azure provisioning, authenticated signing, and a signed public release require a real configured account and have not been verified by those local tests.
