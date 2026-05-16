# HA LiveKit

HA LiveKit connects Home Assistant with the HA LiveKit iOS app so your smart home can start, update, and end iPhone Live Activities.

Use it for doors, laundry, lights, vacuums, energy usage, climate status, timers, and other Home Assistant entities.

## What it does

HA LiveKit lets Home Assistant automations create Live Activities on your iPhone Lock Screen and Dynamic Island.

You can start the same kind of Live Activity from:

- the HA LiveKit iOS app
- Home Assistant automations
- Apple Shortcuts

Entity-based activities can automatically use the entity’s friendly name, current state, unit, progress value, and template.

## Features

- Start Live Activities from Home Assistant automations.
- Create entity-aware activities for doors, lights, laundry, vacuums, climate, energy, and more.
- Update or end an existing Live Activity by activity ID.
- Use Apple Shortcuts through the HA LiveKit iOS app.
- Supports Dynamic Island and Lock Screen Live Activities.
- Includes diagnostics for connection and activity delivery.
- Supports advanced custom payloads when needed.

## Requirements

- Home Assistant
- HACS
- HA LiveKit iOS app
- iPhone with Live Activities support
- Notifications and Live Activities enabled on the iPhone

Join the TestFlight beta:

https://testflight.apple.com/join/MXPvm4Wk

## Installation with HACS

1. Open **HACS** in Home Assistant.
2. Go to **Custom repositories**.
3. Add this repository URL:

   `https://github.com/efeshinkawa/halivekit`

4. Choose category: **Integration**.
5. Install **HA LiveKit**.
6. Restart Home Assistant.
7. Go to **Settings → Devices & services → Add Integration**.
8. Search for **HA LiveKit** and add it.

## Connect the iOS app

1. In Home Assistant, open your user profile.
2. Create a **Long-Lived Access Token**.
3. Open the HA LiveKit iOS app.
4. Enter your Home Assistant URL and token.
5. Save the connection and test it from the app.

Keep your Long-Lived Access Token private. Do not paste it into automations, GitHub issues, screenshots, or public logs.

## Home Assistant actions

HA LiveKit adds these Home Assistant actions:

- `ha_livekit.start_entity_activity`
- `ha_livekit.update_entity_activity`
- `ha_livekit.end_activity`
- `ha_livekit.start_activity`
- `ha_livekit.update_activity`

For most users, the entity-based actions are the easiest way to create Live Activities.

## Basic usage

### Start an entity Live Activity

```yaml
action: ha_livekit.start_entity_activity
data:
  activity_id: front_door
  entity_id: binary_sensor.front_door
  template: door
```

This reads the entity’s friendly name and current state automatically.

### Update the same activity

```yaml
action: ha_livekit.update_entity_activity
data:
  activity_id: front_door
  entity_id: binary_sensor.front_door
  template: door
```

### End the activity

```yaml
action: ha_livekit.end_activity
data:
  activity_id: front_door
  reason: closed
```

## Automation examples

### Door opened

```yaml
alias: "Live Activity - Front Door Opened"
trigger:
  - platform: state
    entity_id: binary_sensor.front_door
    to: "on"
action:
  - action: ha_livekit.start_entity_activity
    data:
      activity_id: front_door
      entity_id: binary_sensor.front_door
      template: door
```

### Door state updated

```yaml
alias: "Live Activity - Front Door Updated"
trigger:
  - platform: state
    entity_id: binary_sensor.front_door
action:
  - action: ha_livekit.update_entity_activity
    data:
      activity_id: front_door
      entity_id: binary_sensor.front_door
      template: door
```

### Door closed and activity ended

```yaml
alias: "Live Activity - Front Door Closed"
trigger:
  - platform: state
    entity_id: binary_sensor.front_door
    to: "off"
    for: "00:00:10"
action:
  - action: ha_livekit.end_activity
    data:
      activity_id: front_door
      reason: closed
```

### Washing machine started

```yaml
alias: "Live Activity - Washing Machine Started"
trigger:
  - platform: numeric_state
    entity_id: sensor.washing_machine_power
    above: 5
action:
  - action: ha_livekit.start_entity_activity
    data:
      activity_id: washing_machine
      entity_id: sensor.washing_machine_power
      template: laundry
      progress_entity_id: sensor.washing_machine_progress
```

### Washing machine progress updated

```yaml
alias: "Live Activity - Washing Machine Progress"
trigger:
  - platform: state
    entity_id:
      - sensor.washing_machine_power
      - sensor.washing_machine_progress
action:
  - action: ha_livekit.update_entity_activity
    data:
      activity_id: washing_machine
      entity_id: sensor.washing_machine_power
      template: laundry
      progress_entity_id: sensor.washing_machine_progress
```

### Light turned on

```yaml
alias: "Live Activity - Light On"
trigger:
  - platform: state
    entity_id: light.living_room
    to: "on"
action:
  - action: ha_livekit.start_entity_activity
    data:
      activity_id: living_room_light
      entity_id: light.living_room
      template: light
```

### Vacuum started

```yaml
alias: "Live Activity - Vacuum Started"
trigger:
  - platform: state
    entity_id: vacuum.roborock
    to: "cleaning"
action:
  - action: ha_livekit.start_entity_activity
    data:
      activity_id: vacuum
      entity_id: vacuum.roborock
      template: vacuum
```

More examples are available in [`examples/automations.yaml`](examples/automations.yaml).

## Apple Shortcuts

The HA LiveKit iOS app also provides Apple Shortcuts actions.

You can use Shortcuts to:

- start an entity Live Activity
- update an entity Live Activity
- end an entity Live Activity
- create custom Live Activities

This makes it possible to trigger the same Live Activity from the app, from Home Assistant, or from Shortcuts.

## Advanced custom actions

Entity-based actions are recommended for most automations. Use custom actions only when you want full control over the Live Activity text and payload.

### Start a custom Live Activity

```yaml
action: ha_livekit.start_activity
data:
  activity_id: custom_status
  title: "Custom Status"
  subtitle: "Started from Home Assistant"
  state: "Running"
  template: progress
```

### Update a custom Live Activity

```yaml
action: ha_livekit.update_activity
data:
  activity_id: custom_status
  title: "Custom Status"
  subtitle: "Updated from Home Assistant"
  state: "Done"
  progress: 1
```

## Troubleshooting

### The integration does not show up in Home Assistant

- Confirm the repository was added to HACS as category **Integration**.
- Restart Home Assistant after installing.
- Check that `custom_components/ha_livekit` exists in your Home Assistant config directory.

### Actions do not appear

- Restart Home Assistant.
- Go to **Developer Tools → Actions** and search for `ha_livekit`.
- Reinstall the integration from HACS if the folder is incomplete.

### The app connects, but automations do not trigger Live Activities

- Open the HA LiveKit iOS app and test the Home Assistant connection.
- Make sure the HA LiveKit integration is installed and added in Home Assistant.
- Restart Home Assistant after updating the integration.
- Check the HA LiveKit diagnostic sensor in Home Assistant.

### Background updates do not arrive

- Make sure notifications are allowed for HA LiveKit.
- Make sure Live Activities are enabled on the iPhone.
- Open the HA LiveKit app once after installing or updating.
- Start one Live Activity from inside the app before relying on background updates.
- Check the Diagnostics tab in the iOS app.

### Icons or logos look stale

- Refresh HACS.
- Clear your browser cache.
- Restart Home Assistant.
- Reinstall the integration if Home Assistant still shows an old cached icon.

## Privacy and security

Keep these private:

- Home Assistant Long-Lived Access Tokens
- relay credentials
- diagnostic logs that may include connection details
- screenshots showing private URLs or tokens

HA LiveKit diagnostics are designed to avoid exposing full tokens or secrets, but you should still review logs before sharing them publicly.

## Maintainers

The iOS app can support background delivery through a managed APNs relay. Most users do not need to configure relay settings manually.

Maintainers should keep APNs keys, relay credentials, Home Assistant tokens, and local configuration files out of public repositories.
