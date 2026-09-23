# HA LiveKit 2.0.0

Status: release candidate draft. Do not publish until every required release gate below passes.

- iOS app: `2.0.0` (`24`)
- iOS widget: `2.0.0` (`24`)
- Home Assistant integration: `2.0.0`
- Code baseline: `8f110da` (unreleased HA LiveKit `1.1.4` metadata)
- Live App Store migration baseline: HA LiveKit `1.1.3`
- Release date: TBD

HA LiveKit 2.0 is the largest security, reliability, and interface update so far. This document is the durable release ledger for the iOS app, Home Assistant integration, and managed relay. It records both the completed implementation and the final V2 release scope that must be verified before publication.

## Important: update Home Assistant first

HA LiveKit 2.0 requires the HA LiveKit `2.0.0` Home Assistant integration for secure relay pairing and relay device management.

For end users:

1. Update HA LiveKit in HACS.
2. Restart Home Assistant.
3. Confirm that the integration loads successfully.
4. Update or reopen the iOS app.

For managed-service operators, the required rollout order is Worker, Home Assistant integration, then iOS. Keep legacy v1 compatibility enabled during adoption. Disabling v1, rotating secrets, or deleting legacy records requires a separate approved migration.

## User-facing highlights

- A cleaner, adaptive four-tab interface: Home, Create, Health, and Settings.
- Redesigned Dashboard, onboarding, connection, and settings experiences.
- Live Lock Screen and Dynamic Island previews in the Activity Builder.
- Expanded Quick Presets with a compact Show More flow.
- Safe Home Assistant automation YAML generation, review, copy, and sharing.
- A dedicated Debug Logs screen instead of long logs inside Health Center.
- Debug log messages remain legible in dark mode, and pushed diagnostic screens no longer keep the floating tab bar over their content.
- A redesigned Health Center with connection, notification, ActivityKit, and relay status.
- Health checklist rows adapt long titles, details, and statuses to compact phone widths without squeezing text into narrow columns.
- Health Center content is constrained to the device viewport and scrolls vertically only; accessibility text sizes stack title and status without widening the page.
- Administrator-only relay device inventory and explicit device revocation.
- Important Notices for compatibility, reliability, and required-update information.
- A signed, strictly validated built-in compatibility notice remains available when the public notice feed is offline or not yet published.
- An update banner with Remind Me Later and Update actions.
- The Update action opens the official HA LiveKit App Store page.
- Update notices clearly state when the HACS integration must also be updated and Home Assistant restarted.
- The native Icon Composer app icon is retained for modern iOS appearance modes.
- Fifteen supported app languages with synchronized localization keys.

## Activity Builder

- Preview the selected Home Assistant entity as both a Lock Screen Live Activity and Dynamic Island presentation before starting it.
- Start from purpose-built presets and reveal additional presets only when requested.
- Fine-tune titles, subtitles, state presentation, icons, colors, progress, and activity behavior.
- Generate YAML that matches the current preview without embedding a Home Assistant access token, relay secret, APNs token, or device credential.
- Review, copy, or share the generated YAML from a dedicated sheet.

## Health Center and diagnostics

- Connection, REST, WebSocket, entity refresh, notification, ActivityKit, and managed-relay state are grouped into a cleaner operational view.
- Debug Logs open on a separate screen so long diagnostic output no longer overwhelms Health Center.
- Every launch starts the dedicated Debug Logs screen with a harmless redacted session entry, so a quiet or newly launched app never presents an apparently blank log page.
- Relay device inventory is available only through an authenticated Home Assistant administrator.
- Device inventory contains only safe metadata such as device ID, friendly name, protocol generation, app version, and update time.
- Tokens, credential hashes, relay secrets, APNs tokens, and Home Assistant access tokens are never shown in device inventory.
- Revoking another relay device requires an explicit destructive confirmation.
- Diagnostic copy and display paths redact bearer tokens, secrets, private URLs, instance identifiers, token-shaped values, and local filesystem paths.

## Important Notices and update guidance

- Important Notices are reserved for compatibility changes, reliability incidents, required upgrades, and other operational information; they are not a marketing channel.
- A notice can explain that a newer iOS version is available and offer Remind Me Later or Update.
- Update opens the official App Store listing: `https://apps.apple.com/us/app/ha-livekit/id6769399254`.
- A required compatibility notice must clearly instruct the user to update the HA LiveKit integration in HACS and restart Home Assistant.
- Notice payloads and UI must never include a Home Assistant token, relay secret, APNs token, device credential, private key, or raw diagnostic body.
- Dismissal and reminder state is local to the app. A notice must not silently alter Home Assistant, HACS, relay, notification, or security settings.
- The signed app bundle contains the same strict `notices/v1.json` bootstrap used for the V2 HACS compatibility warning. A valid remote feed may replace it; a failed or invalid remote response can never erase it.

## Security and privacy

- Added Relay Authentication v2 with short-lived, replay-resistant pairing tickets.
- Replaced shared app authorization for upgraded devices with device-scoped credentials.
- Long-lived relay credentials are stored with device-only Keychain accessibility.
- Worker storage keeps hashes instead of plaintext device credentials.
- Added strongly consistent credential generation, revocation, and tombstone checks through an instance-scoped Durable Object.
- Prevented stale KV records from reauthorizing revoked or superseded device generations.
- Added strict request-size, response-size, redirect, method, quota, retention, and rate-limit boundaries.
- Added administrator-only Home Assistant pairing and relay-device APIs.
- Hardened Home Assistant webhook, service, target, and activity-payload validation.
- Restricted activity delivery to the exact Home Assistant instance, device, credential generation, and APNs environment.
- Home Assistant owns the canonical managed instance identity; the iOS app never receives the Home Assistant relay secret in v2.
- Pairing requests and relay responses are scope-checked before any local credential or configuration is accepted.
- Diagnostics and logs redact bearer tokens, secrets, private URLs, instance identifiers, and token-shaped values.
- Debug Logs and Important Notices must never contain API tokens, APNs tokens, relay secrets, private keys, or raw credentials.
- Deployment performs a local Wrangler dry run and a post-deploy readiness check before writing local iOS relay configuration.
- Deployment no longer invents, silently uploads, or rotates relay secrets.
- Approved secret upload uses one atomic Worker deployment rather than intermediate secret-only deployments.

## Reliability

- Isolated REST, WebSocket, relay, and cache work by the active Home Assistant connection generation.
- Prevented stale requests and old WebSocket callbacks from mutating a newly selected Home Assistant connection.
- Scoped every WebSocket receive, send, reconnect, and close operation to its exact socket and connection ID.
- Added durable pending revocation handling so logout or connection changes cannot silently lose device cleanup.
- Added single-flight relay credential recovery after authorization failure.
- Scoped the entity cache per Home Assistant tenant.
- Added a seven-day cache lifetime and a 16 MiB safety limit.
- Moved cache serialization and writes off the main actor.
- Preserved connection state across diagnostics and Demo Mode transitions.
- Improved background ActivityKit registration, update, unregister, and pending-token lifecycle handling.
- Added bounded streaming responses and explicit redirect rejection in iOS and Home Assistant network clients.
- Added actionable compatibility behavior when the installed HACS integration is too old to expose v2 pairing or relay-device APIs.

## Compatibility and migration

- Requires iOS 17 or newer.
- Requires Home Assistant 2025.1 or newer.
- Managed relay rollout order is Worker, Home Assistant integration, then iOS.
- Existing v1 devices remain temporarily available during the migration window.
- Once an instance has provisioned Relay Auth v2, v1 cannot enroll a new device ID for that instance.
- A v1 request cannot overwrite a device that has already upgraded to v2.
- Custom relay configurations retain their existing explicit registration-secret contract unless they independently implement v2.
- Operators should review legacy relay devices and revoke unknown entries before v1 is disabled.
- `DEVICE_CREDENTIAL_PEPPER` must not be rotated during a normal release because changing it invalidates every v2 device credential.
- Legacy plaintext instance-secret migration is intentionally one-way. After v2 traffic begins, do not roll back to a Worker that only understands plaintext legacy relay records.
- Retain a tested rollback build that understands Durable Object generations, tombstones, legacy hashes, and v2 records.

## Verification snapshot

Completed again for build `24` on 2026-07-13:

- Cloudflare Worker checks passed.
- Cloudflare Worker tests: 40/40 passed.
- Worker dependency audit: zero known vulnerabilities.
- Home Assistant security tests: 63/63 passed.
- Home Assistant Python compilation passed.
- iOS app and widget Debug and Release simulator builds passed for arm64 and x86_64 with the iOS 27 SDK.
- Production and development Worker dry runs passed without changing the live deployment.
- Fifteen iOS localization tables each contained 584 matching keys with no duplicates and passed `plutil` validation.
- A temporary public-repository sync contained `pairing.py`, `security.py`, and `notices/v1.json`, and the copied integration compiled successfully.
- The supplied Quick Presets, inline Debug Logs, and relay-error references were compared against fresh simulator captures of the collapsed/expanded presets, Health Center, and dedicated redacted Debug Logs page.
- The native `AppIcon.icon` package compiled successfully and its generated Home Screen icon was visually reviewed.
- Sandbox builds now fail closed against the production-only managed relay before push registration, activity-token registration, or test-start can send an APNs token or device credential; production builds retain the existing v2-first/v1-compatible path.
- Build `24` constrains Health Center to the horizontal viewport while preserving vertical scrolling and Dynamic Type wrapping.

The managed Worker, public HACS repository, public notice feed, and App Store listing were not modified. The notice-feed URL still returns HTTP 404 until the public repository is synced and published; dynamic remote notices remain a release blocker, while the signed built-in V2 compatibility notice now works without it. Local verification is not authorization to deploy.

## Required release gates

- [x] Worker static check passes.
- [x] Worker tests pass.
- [x] Worker dependency audit reports no known vulnerability requiring release action.
- [x] Home Assistant compilation and security tests pass.
- [x] HACS public-repository sync includes every required integration module, including `pairing.py` and `security.py`.
- [ ] The public `notices/v1.json` feed is published, returns HTTP 200, passes the strict schema validator, and contains no token- or credential-shaped data.
- [x] The signed app bundle contains a byte-identical, strictly validated `notices/v1.json` bootstrap and preserves it when the remote feed is unavailable.
- [ ] Fresh HACS `2.0.0` installation succeeds on Home Assistant 2025.1 or newer.
- [ ] Upgrade from the currently published HACS integration to `2.0.0` succeeds after restart.
- [ ] Managed Worker is deployed and healthy with v1 compatibility still enabled.
- [ ] iOS app and widget build `24` archive successfully with an Apple-approved release Xcode toolchain.
- [x] The app target contains a valid `PrivacyInfo.xcprivacy` declaring the app-only UserDefaults required reason.
- [ ] Upgrade from the live App Store `1.1.3` build preserves saved connection and Keychain state.
- [ ] Quick Presets Show More, YAML review/copy/share, dedicated Debug Logs, Important Notices, and update-banner flows pass manual UAT.
- [x] Debug Logs, copied diagnostics, relay inventory, and notice payloads pass a no-secret review.
- [ ] The App Store Update action opens the official listing.
- [ ] The update banner clearly requires a HACS integration update and Home Assistant restart when compatibility requires it.
- [ ] Icon Composer output is reviewed at Home Screen, Settings, Spotlight, notification, dark, tinted, and accessibility appearances on supported iOS versions.
- [ ] A physical-device Live Activity pass covers Lock Screen and Dynamic Island behavior.
- [x] Final localization key parity and `plutil` validation pass for all fifteen app languages.
- [x] Final `git diff --check` passes and the release worktree contains no unintended files.

## Change ledger

The V2 work began from `8f110da`, which set the app marketing version to `1.1.4`.

- `e5252d4` — Harden relay request and storage boundaries.
- `f810e0c` — Enforce Home Assistant activity trust boundaries.
- `40f89f8` — Preserve iOS connection state across diagnostics and Demo Mode.
- `b62630b` — Add Relay Auth v2 authorization and device controls.
- `1a86a87` — Isolate iOS relay credentials by connection.
- `b71228b` — Modernize the Activity Builder and Health experience.
- `eeb7fb1` — Prepare the Home Assistant 2.0 status contract, notice feed, HACS metadata, and safe public-repository sync.
- `36ae7e6` — Complete Quick Presets, dedicated redacted Debug Logs, HACS compatibility guidance, Important Notices, update banner, localization, and iOS 2.0 metadata.
- `759fb63` — Keep Debug Logs visibly populated on quiet launches, add a validated built-in Important Notices fallback, correct per-notice unread behavior, add the privacy manifest, and advance the candidate to build `22`.
- `9a902d9` — Restore dark-mode Debug Logs text, make Health Checklist rows adapt to compact widths, keep the floating tab bar clear of diagnostics, and distinguish a sandbox Debug build from the unchanged production relay before any new pairing, registration, APNs-token, or device-credential mutation is sent. Recorded credential revocation cleanup remains intentionally scoped to its original relay and environment.
- `c50b199` — Constrain Health Center to vertical-only scrolling, remove intrinsic-width checklist overflow, support accessibility text sizes, and advance the candidate to build `24`.

## Rollout

1. Deploy and verify the compatible managed Worker while v1 remains enabled.
2. Publish and verify Home Assistant integration `2.0.0`.
3. Release iOS `2.0.0` (`24`) only after the integration is available.
4. Measure v2 adoption and remediate unknown legacy devices.
5. Disable v1 only through a separately approved migration after the adoption target and rollback plan are reviewed.

## App Store: What's New

HA LiveKit 2.0 is our biggest update yet.

- A cleaner Home, Create, Health, and Settings experience.
- Live Lock Screen and Dynamic Island previews.
- More Quick Presets and safe Home Assistant YAML generation.
- A dedicated, redacted Debug Logs screen.
- Important Notices and update reminders.
- Secure Relay Auth v2 and administrator device controls.
- Major connection, caching, and background reliability improvements.
- Native Icon Composer support for modern iOS appearance modes.

Important: Update the HA LiveKit integration in HACS and restart Home Assistant for full 2.0 compatibility. Your Home Assistant token, relay secrets, and APNs tokens are never included in diagnostics or notices.
