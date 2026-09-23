# HA LiveKit 2.1.1

- iOS app: `2.1.1` (`25`)
- iOS widget: `2.1.1` (`25`)
- Home Assistant integration: `2.1.1`
- Release date: 2026-08-14

## New

- Settings now includes a **Help** card that opens an email draft addressed to `support@efeer.im`.
- **Send Logs** is optional, defaults to off, and is never persisted or synced.
- When enabled, current-session support events are attached as an in-memory text file for the user to review before sending.

## Privacy and safety

- Support exports use fixed event categories and outcomes instead of raw log messages.
- Names, entity/activity/device identifiers, URLs, IP addresses, credentials, server responses, raw error details, locale, and timestamps are excluded.
- Only HTTP status codes and bounded repetition counts can be carried over from an event.
- If Apple Mail is not configured, logs are not placed in a `mailto:` URL; the app asks the user to configure Mail or turn **Send Logs** off.
- HA LiveKit does not persist or sync the attachment. A draft explicitly saved or sent by the user may be stored or synced by the configured Mail service.
- Existing local Diagnostics behavior, credentials, relay configuration, bundle identifiers, and entitlements are unchanged.

## Upgrade behavior

- The app and widget move together from `2.1 (24)` to `2.1.1 (25)`.
- Existing 2.1 users do not see the old 2.1 What's New tour again for this patch release.

## Validation

- Debug and Release simulator builds passed with the local Xcode 27 beta toolchain, including the app and widget targets.
- Home Assistant security and release-alignment suite passed: 74/74 tests.
- Managed relay suite passed: 43/43 tests.
- All 15 localization files passed plist validation, exact 628-key parity, and placeholder parity.
- A deterministic Swift sanitizer harness confirmed that names, private URLs/IPs, entity IDs, email addresses, credentials, raw error text, and injected mail headers do not appear in support summaries while HTTP status codes remain available.
- The release archive still requires the repository's pinned Xcode Cloud 26.5 workflow before TestFlight or App Store submission.
