# Development Notes

## Phase 1 MVP

- Build and run the iOS app on iOS 17+.
- Enter a Home Assistant URL and Long-Lived Access Token.
- Fetch states through REST.
- Choose an entity and start a local ActivityKit Live Activity.
- Keep the app foregrounded to receive WebSocket state updates and HA LiveKit service events.
- Use the Dashboard activity card refresh button to trigger a manual update.
- Use Developer Tools > Events to listen for `ha_livekit_activity_request` while testing HA services.

## Phase 2 Relay

The current iOS app requests local Live Activities with `pushType: nil`. To support true background updates:

1. Request the Live Activity with `pushType: .token`.
2. Observe the activity push token stream in `LiveActivityManager`.
3. Register `device_id`, `activity_id` and the token with a trusted server.
4. Have Home Assistant call `ha_livekit.update_activity`.
5. Let the custom integration forward the signed payload to the trusted server through `push_endpoint_url`.
6. The trusted server sends the update to APNs using the Live Activity push token.

## Security Checklist

- Home Assistant Long-Lived Access Token is stored only in Keychain.
- Debug logs redact bearer/access-token style values defensively.
- Webhook calls require HMAC or shared secret verification.
- Do not expose `/api/webhook/ha_livekit_update` publicly without HTTPS and HMAC.
- Do not put APNs signing keys in Home Assistant automations.
- Rotate the integration shared secret after testing.

## App Store Checklist

- Replace `HALIVEKIT_BUNDLE_ID` in `ios/HA LiveKit/Config/BundleIdentifiers.xcconfig`.
- Add real app icon assets.
- Test Live Activities on physical Dynamic Island and non-Dynamic Island devices.
- Keep Local Network usage text specific and truthful.
- Use only public ActivityKit, WidgetKit, SwiftUI and Home Assistant APIs.
