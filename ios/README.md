# HA LiveKit

HA LiveKit brings Home Assistant entity state to iPhone Live Activities. It can show doors, appliances, lights, vacuums, energy use, climate state, timers and custom automations on the Lock Screen and Dynamic Island.

## Install

Install HA LiveKit from the App Store:

https://go.efeer.im/halivekitapp

## What it does

HA LiveKit connects an iOS app to Home Assistant and listens for HA LiveKit service calls. When an automation starts, updates or ends an activity, the app renders the current entity state as a Live Activity. Foreground updates use the Home Assistant WebSocket connection. Background starts and updates use the HA LiveKit Home Assistant integration plus an APNs relay.

## Features

- Start Live Activities from Home Assistant automations.
- Build activities directly from Home Assistant entities.
- Update active activities when entity state changes.
- End activities from Home Assistant services, Apple Shortcuts or the app.
- Use templates for doors, laundry, dishwashers, vacuums, security, climate, energy and timers.
- Trigger actions from Apple Shortcuts.
- Support foreground WebSocket updates and background APNs updates.
- Use redacted Diagnostics to check REST, WebSocket, entity and background status.

## Requirements

- iPhone with Live Activities support.
- Home Assistant 2025.1 or newer.
- HA LiveKit Home Assistant integration.
- Notifications enabled for the HA LiveKit iOS app.
- A Home Assistant Long-Lived Access Token for the app connection.
- For background updates: a build with APNs relay configuration and a Home Assistant integration configured for HA LiveKit.

## Quick Start

1. Install the HA LiveKit iOS app from the App Store.
2. Open the app and allow notifications.
3. In Home Assistant, create a Long-Lived Access Token from your user profile.
4. In the app, open Settings and enter your Home Assistant URL, such as `https://example.ui.nabu.casa`.
5. Paste the Long-Lived Access Token into the token field and tap Test.
6. Install the HA LiveKit Home Assistant integration.
7. Start your first Live Activity from the app or with `ha_livekit.set_activity`.

## Home Assistant Integration Setup

### Install with HACS

1. Open HACS in Home Assistant.
2. Open Custom repositories.
3. Add this GitHub repository URL.
4. Choose category: Integration.
5. Install HA LiveKit.
6. Restart Home Assistant.
7. Open Settings > Devices & services > Add integration.
8. Search for HA LiveKit and add it.

### Connect the iOS app

1. In Home Assistant, open your user profile.
2. Create a Long-Lived Access Token.
3. Open HA LiveKit on iPhone.
4. Enter your Home Assistant URL, for example `https://example.ui.nabu.casa`.
5. Paste the token into the app and tap Test.
6. Confirm Diagnostics shows REST, WebSocket and Entities as connected.

The token is stored in the iOS Keychain. Diagnostics and copied diagnostic text do not show the full token.

#### Optional: Internal and External URLs

If you need different addresses on your home Wi-Fi and away from home (for example, NAT loopback or a local hostname), open the connection section in Settings and enable the optional Internal and External URL fields. When both are set, HA LiveKit tries the Internal URL first and falls back to the External URL only on connectivity errors. Authentication errors are not hidden. Existing single-URL setups keep working unchanged.

## Automations

Most users should use `ha_livekit.set_activity`.

- It starts the Live Activity if it does not exist.
- It updates the existing Live Activity if it already exists.
- This helps prevent duplicate Live Activities with the same `activity_id`.

Use `ha_livekit.end_activity` when you want to end an activity by ID. Add `entity_id` to `set_activity` when you want HA LiveKit to read the entity state, friendly name, unit and progress automatically. Leave `entity_id` empty for a custom payload.

### Door

```yaml
action: ha_livekit.set_activity
data:
  activity_id: front_door
  entity_id: binary_sensor.front_door
  template: door
```

### Laundry

```yaml
action: ha_livekit.set_activity
data:
  activity_id: washing_machine
  entity_id: sensor.washing_machine_power
  template: laundry
  progress_entity_id: sensor.washing_machine_progress
```

### Custom

```yaml
action: ha_livekit.set_activity
data:
  activity_id: custom_status
  title: "Custom Status"
  subtitle: "Started from Home Assistant"
  state: "Running"
  template: progress
```

### End

```yaml
action: ha_livekit.end_activity
data:
  activity_id: front_door
```

### Advanced / backward compatibility

These explicit start and update actions remain supported for existing automations:

- `ha_livekit.start_activity`
- `ha_livekit.update_activity`
- `ha_livekit.start_entity_activity`
- `ha_livekit.update_entity_activity`

## Apple Shortcuts

The iOS app exposes these actions to Apple Shortcuts:

- Start Entity Live Activity
- Update Entity Live Activity
- End Entity Live Activity

Example shortcut flows:

- Start a door Live Activity for `binary_sensor.front_door`.
- Update a washing machine activity from `sensor.washing_machine_power`.
- End an activity named `front_door` or `washing_machine`.

Shortcuts use the same activity IDs as Home Assistant services, so an activity started by Home Assistant can be ended from Shortcuts, and the reverse is also supported.

## Troubleshooting

### App connects but automations do not trigger

- Confirm Diagnostics shows WebSocket as Connected.
- Confirm the HA LiveKit integration is installed and added in Home Assistant.
- Confirm the automation uses `ha_livekit.set_activity` or one of the advanced explicit actions.
- If a `device_id` is set in the automation, confirm it matches the app's Client Device ID in Settings.
- Open the app once after connecting so it can subscribe to Home Assistant events.

### Live Activities are not visible

- Confirm the iPhone supports Live Activities.
- Confirm Live Activities are enabled for HA LiveKit in iOS Settings.
- Start an activity from the app first to verify local ActivityKit support.
- Check that `activity_id` is stable and not accidentally ended by another automation.

### Notifications denied

- Open iOS Settings > Notifications > HA LiveKit.
- Enable notifications.
- Reopen HA LiveKit and check Diagnostics.

### Background updates are not working

- Confirm notifications are enabled.
- Confirm Diagnostics shows the background push token as received.
- Confirm Relay is Ready in Diagnostics.
- Tap Test Background Updates in Diagnostics.
- Foreground Home Assistant updates can still work when background APNs setup needs attention.

### Home Assistant integration is not showing

- Confirm the custom repository was added to HACS as category Integration.
- Restart Home Assistant after installing the integration.
- Open Settings > Devices & services > Add integration and search for HA LiveKit.
- Clear the browser cache if Home Assistant still shows an old integration list.

### Logos or icons look stale

- Restart Home Assistant.
- Clear the browser cache for the Home Assistant frontend.
- If using HACS, reinstall or update the integration and restart Home Assistant again.

## Advanced / Maintainers

Background Live Activities require an APNs relay because iOS background starts and updates are delivered through ActivityKit push notifications. The relay stores push-to-start and activity update tokens under the exact APNs environment, Home Assistant instance ID and device ID, then sends ActivityKit APNs requests only for the verified Home Assistant instance that owns the relay credential.

The included Cloudflare Worker is one possible relay implementation. A production relay needs Apple Developer APNs credentials, a Team ID, a Key ID, the app bundle ID, and a server-side app registration secret such as `HA_LIVEKIT_APP_SECRET`. Home Assistant relay credentials are generated per instance and must not be replaced with a global shared secret. Keep `.p8` keys, local secret files, relay secrets and Home Assistant tokens out of Git.

Use Diagnostics for operational status. It redacts tokens, secrets, private URLs, raw REST bodies and large entity payloads before display or copy.

## TestFlight / Beta Builds

The App Store version is the normal installation path for most users. TestFlight builds are secondary beta builds for trying upcoming changes before they are released. Use TestFlight only if the developer has shared an active beta invite and you are comfortable testing pre-release behavior.
