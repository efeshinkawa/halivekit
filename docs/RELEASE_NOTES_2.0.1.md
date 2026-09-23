# HA LiveKit 2.0.1

- iOS app: `2.0.1` (`25`)
- iOS widget: `2.0.1` (`25`)
- Home Assistant integration: `2.0.1`
- Release date: 2026-07-18

## Fixed

- Start Custom Live Activity and Start Entity Live Activity now run as dedicated Live Activity intents.
- iPhone Shortcuts and personal automations can start a Live Activity without bringing the HA LiveKit interface to the foreground.
- Local ActivityKit creation remains immediate; this patch does not route Shortcut starts through Home Assistant, the relay, or APNs.

## Compatibility

- Requires iOS 17 or newer.
- The Home Assistant integration has no runtime behavior change in 2.0.1.
- HA LiveKit integration 2.0.0 remains compatible with the iOS 2.0.1 app.

## Automated validation

- Xcode 27 Debug and Release simulator builds passed for the app and widget; all four products resolved to `2.0.1` (`25`).
- Home Assistant security tests passed: 63/63.
- Managed Worker tests passed: 40/40; dependency audits reported zero known vulnerabilities.
- All 15 localization property lists passed validation with 586 matching keys.
- The public HACS repository matches all 28 mapped private release files and passed Python, secret, and forbidden-directory checks.
- `git diff --check` passed in both repositories.

## Post-push acceptance

- Confirm the Xcode Cloud archive and distribution action complete for 2.0.1.
- Run a final physical-device Shortcut automation check with the app both backgrounded and terminated before App Store submission.
