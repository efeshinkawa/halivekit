# Security policy

## Reporting a vulnerability

Please report security problems privately by email to `support@efeer.im` with "Security" in the subject line. Do not open a public GitHub issue for a vulnerability.

Include the affected component (`custom_components/ha_livekit`, `ios/`, or `relay/cloudflare-worker`), the version, and the steps to reproduce. Never include real Home Assistant tokens, relay credentials, push tokens, or private URLs. Use placeholders instead.

## Scope

- The Home Assistant integration in `custom_components/ha_livekit/`
- The iOS app and widget in `ios/`
- The managed APNs relay in `relay/cloudflare-worker/`

## How secrets are handled

- This repository contains no credentials. The APNs signing key and the device credential pepper are stored only as Cloudflare Worker secrets. The iOS build receives its relay configuration from CI (Xcode Cloud).
- The legacy v1 app registration key is compiled into every App Store build, so it is treated as public, not as a secret. New devices pair through the v2 flow below, and the v1 routes that accept this key are being retired.
- Files that may hold credentials (`.dev.vars*`, `LocalSecrets.xcconfig`, `*.p8`, `.env*`) are ignored by git.
- Devices authenticate to the relay with per-device credentials issued through an authenticated Home Assistant pairing flow. See [docs/RELAY_AUTH_V2.md](docs/RELAY_AUTH_V2.md).
