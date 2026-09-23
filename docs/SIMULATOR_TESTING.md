# Simulator Testing

This guide tests HA LiveKit in Xcode with either Demo Mode or a real Home Assistant instance.

## Before You Run

1. For Demo Mode, no Home Assistant URL or token is required.
2. For real Home Assistant testing, make sure your Mac can open your Home Assistant URL in Safari.
3. In Home Assistant, open your user profile and create a Long-Lived Access Token.
4. Open `ios/HA LiveKit/Config/BundleIdentifiers.xcconfig`.
5. Set a unique simulator-safe bundle ID:

```xcconfig
HALIVEKIT_BUNDLE_ID = com.yourname.HALiveKit
```

`HALIVEKIT_DEVELOPMENT_TEAM` can stay empty for simulator testing.

## Run In Xcode

1. Open `ios/HA LiveKit/HA LiveKit.xcodeproj`.
2. Select the `HA LiveKit` scheme.
3. Select an iPhone simulator with iOS 17 or newer.
4. Press Run.
5. On first launch, skip the setup guide or tap `Try Demo Home`.
6. In Demo Mode, use Dashboard > Demo Scenarios to start local Live Activities.
7. For real Home Assistant, enter a Home Assistant URL:
   - `homeassistant.local:8123`
   - `http://homeassistant.local:8123`
   - `https://your-domain.example`
   - Nabu Casa remote URL
8. Paste the Long-Lived Access Token.
9. Tap `Connect Home Assistant`.

If REST succeeds, the app opens Dashboard. If WebSocket fails, the app still opens Dashboard and shows a warning while retrying in the background.

## Real MVP Checklist

1. Confirm Dashboard shows the normalized Home Assistant host, or `Demo Mode` when using the demo home.
2. Open `Diagnostics`.
3. Confirm `REST status` is `Connected`.
4. Confirm WebSocket is `Connected` or read the WebSocket warning/error.
5. Open `New Live Activity`.
6. Search for an entity, for example a `sensor`, `binary_sensor`, `light`, `switch` or `vacuum`.
7. Start a Live Activity.
8. Keep the app foregrounded.
9. Change the entity state in Home Assistant.
10. Confirm the activity card updates in Dashboard.
11. Use Home Assistant Developer Tools > Services to call `ha_livekit.start_activity`, `ha_livekit.update_activity` and `ha_livekit.end_activity`.
12. Confirm service-driven requests appear in Diagnostics as `ha_livekit_activity_request` events.

## Demo Mode Checklist

1. Confirm first launch guide appears.
2. Tap `Try Demo Home`.
3. Confirm Dashboard shows `Demo Mode`.
4. Confirm demo entities appear in `New Live Activity`.
5. Run `Door opened`, `Laundry running`, `Vacuum cleaning`, `Climate heating/cooling` and `Energy spike` from Dashboard.
6. Confirm a local Live Activity starts or updates without APNs relay settings.
7. Open Settings and tap `Connect Home Assistant` to leave Demo Mode.

## Diagnostics

Use the Diagnostics tab when connection fails:

- `REST status`: verifies token and `/api/config`.
- `WebSocket status`: verifies `/api/websocket` auth and event subscriptions.
- `Last REST error`: shows invalid token, timeout, reachability or TLS/ATS errors.
- `Last WebSocket error`: shows auth, timeout or disconnect details.
- `Subscribed event types`: should include `state_changed` and `ha_livekit_activity_request`.
- `Copy diagnostics`: copies a token-free report for debugging.

The token is never shown in Diagnostics or debug logs.

## Simulator Limitations

- REST fetch, WebSocket updates, entity selection and ActivityKit start calls can be tested in the simulator.
- Lock Screen, StandBy and Dynamic Island behavior may not match a physical iPhone.
- iOS may pause foreground WebSocket work when the app backgrounds. V2 needs APNs push-to-update for reliable background updates.
- If Xcode reports a signing or embed issue after a successful build, check the README troubleshooting section.
