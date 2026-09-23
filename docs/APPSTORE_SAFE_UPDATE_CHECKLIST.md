# App Store Safe Update Checklist

Date: 2026-05-22
Branch: `codex/appstore-safe-localization-feedback`

This checklist tracks the safety pass for the post-1.0 update. It is intentionally conservative: items that need a real device, an installed App Store 1.0 build, or a live Home Assistant instance are marked for manual verification instead of being guessed from code review.

## Automated And Static Checks Completed

- `npm run check` in `relay/cloudflare-worker`: passed.
- `npm test` in `relay/cloudflare-worker`: passed, including duplicate-name active conflict, pending conflict, and stale APNs cleanup cases.
- `python3 -m unittest tests/ha_livekit_security_test.py`: passed, including duplicate relay rejection surfacing to the Home Assistant service caller.
- `plutil -lint ios/HA LiveKit/HA LiveKit/*.lproj/Localizable.strings`: passed for English, Turkish, Italian, German, French, and Dutch.
- `xcodebuild -project "ios/HA LiveKit/HA LiveKit.xcodeproj" -scheme "HA LiveKit" -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.5' CODE_SIGNING_ALLOWED=NO build`: passed.
- `git diff --check`: passed.

## Manual Release Checklist

- [ ] App launches cleanly after upgrade from existing settings.
- [x] README shows App Store link near the top.
- [x] TestFlight is moved to the bottom.
- [ ] App works in English.
- [ ] App works in Turkish.
- [ ] App works in Italian.
- [ ] App works in German.
- [ ] App works in French.
- [ ] App works in Dutch.
- [ ] No missing localization keys are visible in normal flows.
- [ ] Help section opens an email draft addressed to `support@efeer.im`.
- [x] Send Logs defaults to off and is not persisted or synced.
- [x] With logs off, the draft includes only app version/build and a no-diagnostics note.
- [ ] With logs on, the draft includes the in-memory privacy-protected text attachment.
- [x] The support attachment contains no timestamps, names, identifiers, URLs, IP addresses, credentials, server responses, or raw error details.
- [ ] Home Assistant URL/token can be entered.
- [ ] Test connection does not clear the draft token.
- [ ] Saved token remains redacted.
- [ ] Existing saved connection still loads.
- [ ] Demo mode still works.
- [ ] Relay diagnostics still work.
- [ ] Starting a Live Activity with a new name works.
- [ ] Starting a second active Live Activity with the same name is rejected with a clear localized error.
- [ ] Ending/deleting the first activity allows the same name to be used again.
- [x] Home Assistant does not show success when the updated relay rejects a duplicate activity name.
- [x] Logs added in this update do not expose Home Assistant tokens, APNs secrets, relay secrets, or raw device tokens.

## Notes For Manual Pass

- Duplicate-name rejection is enforced locally by ActivityKit state in the app and remotely by the relay when relay activity metadata is available.
- The relay deletes stale activity-token registry entries when APNs reports an activity token as unregistered during duplicate-name reconciliation or update/end handling.
- Existing Home Assistant service payloads are preserved. New relay metadata fields are additive and are ignored by older relay builds.
- Existing relay-outage tolerance is preserved. Home Assistant services only raise for the explicit `duplicate_activity_name` relay response, not for generic relay failures.
