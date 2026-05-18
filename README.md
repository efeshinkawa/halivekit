# HA LiveKit

HA LiveKit connects Home Assistant automations to the HA LiveKit iOS app so your home can start, update, and end iPhone Live Activities.

## What it does

Use Home Assistant services to create Live Activities for doors, laundry, lights, vacuums, energy usage, climate status, timers, and other entities. The iOS app listens for Home Assistant events while open and can also support background updates when the app has configured its relay connection.

## Features

- Start Live Activities from any Home Assistant automation.
- Use entity-aware services that read friendly names, states, units, and progress values automatically.
- Update or end an existing Live Activity by activity ID.
- Works with Apple Shortcuts through the HA LiveKit iOS app.
- Includes diagnostics sensors for recent relay attempts and activity requests.
- Supports custom payloads for advanced users.

## Requirements

- Home Assistant.
- HACS.
- The HA LiveKit iOS app or TestFlight beta.
- An iPhone that supports Live Activities.

## Installation with HACS

1. Open HACS in Home Assistant.
2. Go to Custom repositories.
3. Add this repository URL:

   `https://github.com/efeshinkawa/halivekit`

4. Choose category: Integration.
5. Install HA LiveKit.
6. Restart Home Assistant.
7. Go to Settings -> Devices & services -> Add Integration.
8. Search for HA LiveKit and add it.

## Connect the iOS app

1. In Home Assistant, open your user profile.
2. Create a Long-Lived Access Token.
3. Open the HA LiveKit iOS app.
4. Enter your Home Assistant URL and token.
5. Save the connection and test it from the app.

Keep your Long-Lived Access Token private. Do not paste it into automations, GitHub issues, screenshots, or public logs.

## Automations

Most users should use:

```yaml
action: ha_livekit.set_activity
data:
  activity_id: front_door
  entity_id: binary_sensor.front_door
  template: door
```

`set_activity` starts the Live Activity if it does not exist. If the same `activity_id` is already active, it updates the existing Live Activity instead of creating a duplicate. Add `entity_id` for automatic Home Assistant state, friendly name, unit, and progress mapping.

Door:

```yaml
action: ha_livekit.set_activity
data:
  activity_id: front_door
  entity_id: binary_sensor.front_door
  template: door
```

Laundry:

```yaml
action: ha_livekit.set_activity
data:
  activity_id: washing_machine
  entity_id: sensor.washing_machine_power
  template: laundry
  progress_entity_id: sensor.washing_machine_progress
```

Custom:

```yaml
action: ha_livekit.set_activity
data:
  activity_id: custom_status
  title: "Custom Status"
  subtitle: "Started from Home Assistant"
  state: "Running"
  template: progress
```

More examples are in [`examples/automations.yaml`](examples/automations.yaml), including door, washing machine, light, vacuum, energy, and climate automations.

Advanced explicit actions remain available for existing automations:

- `ha_livekit.start_activity`
- `ha_livekit.update_activity`
- `ha_livekit.start_entity_activity`
- `ha_livekit.update_entity_activity`
- `ha_livekit.end_activity`

## Apple Shortcuts

The HA LiveKit iOS app also provides Apple Shortcuts actions. You can start or update entity Live Activities from Shortcuts, or combine Shortcuts with Home Assistant automations for personal workflows.

## Troubleshooting

If the integration does not show up in Home Assistant:

- Confirm the repository was added to HACS as category Integration.
- Restart Home Assistant after installing.
- Check that `custom_components/ha_livekit` exists in your Home Assistant config directory.

If services do not appear:

- Restart Home Assistant.
- Open Developer Tools -> Services and search for `ha_livekit`.
- Reinstall the integration from HACS if the folder is incomplete.

If background updates do not arrive:

- Open the HA LiveKit iOS app and test the Home Assistant connection.
- Make sure Live Activities are enabled on the iPhone.
- Start one activity from inside the app before relying on background updates.
- Check the HA LiveKit diagnostic sensor in Home Assistant.

If icons or logos look stale:

- Refresh HACS.
- Clear your browser cache.
- Restart Home Assistant.

## Advanced

Use `ha_livekit.start_activity` and `ha_livekit.update_activity` when you want to send a custom payload instead of letting the integration build one from an entity.

The iOS app configures relay details for background delivery, including a per-home instance ID and per-instance relay credential. Reopen the iOS app after updating so the integration receives the new scoped relay identity; keep relay credentials and Home Assistant tokens private.
