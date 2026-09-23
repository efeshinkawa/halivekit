# HA LiveKit 2.1

- iOS app: `2.1` (`24`)
- iOS widget: `2.1` (`24`)
- Home Assistant integration: `2.1.1`
- Release date: 2026-08-11

## New

- Live Activity creation now offers optional, secure **On** and **Off** buttons.
- Supported Home Assistant domains are `light`, `switch`, and `input_boolean`.
- Controls work from the Lock Screen and expanded Dynamic Island without presenting the app interface.
- Each command requires local device authentication and is bound to the exact Live Activity, primary entity, and Home Assistant instance that the user approved.

## Polish

- Control-enabled Dynamic Island layouts no longer show a redundant brightness progress bar, leaving the full 44-point actions comfortably inside the expanded presentation.
- Custom activities now prefer the selected entity's Home Assistant/SF Symbol mapping, so lights and switches no longer fall back to the generic sliders icon.
- A control-enabled Dynamic Island preview now covers the off/zero-brightness layout that exposed this regression.

## Safety and compatibility

- Action buttons are opt-in and disabled by default.
- Demo mode, missing credentials, invalid activity bindings, changed entities, and changed Home Assistant instances fail closed before any service call.
- Existing Live Activities remain decodable because the new immutable attributes are optional.
- Home Assistant integration 2.1.1 exposes entity-control opt-in to automations and reports failed relay delivery instead of silently succeeding.
- The app remains on the 2.1 release line; no entitlement or bundle identifier changes are required.

## Release validation

- Build 24 completed the pinned Xcode Cloud archive and is valid for internal TestFlight testing.
- Home Assistant security and release-alignment suite passed: 72/72 tests.
- Integration manifest, runtime constant, and iOS marketing version alignment passed.
- Managed relay suite passed: 43/43 tests.
- All 15 localization files passed plist validation, exact 616-key parity, and format-placeholder parity.
- Xcode Cloud is hard-pinned by CI preflight to Xcode `26.5`; the release archive must complete before TestFlight acceptance.

## TestFlight focus

- Create an activity for a light, switch, or input boolean and explicitly enable action buttons.
- Verify **On** and **Off** from the Lock Screen and expanded Dynamic Island while the app interface is closed.
- Verify a light that is off uses its lightbulb icon and does not show a redundant zero-brightness progress bar above the controls.
- Verify local authentication, disconnected behavior, and rejection after changing the configured Home Assistant instance.
