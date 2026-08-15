# HA LiveKit

<p align="center"><img src="https://raw.githubusercontent.com/efeshinkawa/halivekit/157a26442f64e4ba907423e517bb3c1ad44322ee/logo.png" alt="HA LiveKit logo" width="160"></p>

<p align="center">
  <a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=efeshinkawa&amp;repository=halivekit&amp;category=integration"><img src="https://my.home-assistant.io/badges/hacs_repository.svg" alt="Open your Home Assistant instance and open a repository inside the Home Assistant Community Store."></a>
</p>

HA LiveKit connects Home Assistant automations to the HA LiveKit iOS app so your home can start, update, and end iPhone Live Activities.

**App Store:** [Download HA LiveKit](https://go.efeer.im/halivekitapp)

**Current versions:** iOS app **2.1.1** · HACS integration **2.1.2** (same 2.1 release line)

Read the complete [HA LiveKit changelog](CHANGELOG.md).

## What's new in 2.1

HA LiveKit 2.1 adds optional, secure **On** and **Off** controls for `light`, `switch`, and `input_boolean` Live Activities. Controls work from the Lock Screen and expanded Dynamic Island, are opt-in, and require local device authentication.

The coordinated HACS 2.1.2 and latest iOS 2.1.1 build make repeated background starts recover reliably. The integration also replaces the confusing optional-field checkbox plus boolean with one real control switch and derives a stable activity ID when an entity-backed `set_activity` call leaves it empty.

## What it does

Use Home Assistant services to create Live Activities for doors, laundry, lights, vacuums, energy usage, climate status, timers, and other entities. The iOS app listens for Home Assistant events while open and can also support background updates when the app has configured its relay connection.

## Features

- Start Live Activities from any Home Assistant automation.
- Control supported lights, switches, and input booleans from the Lock Screen or expanded Dynamic Island.
- Use entity-aware services that read friendly names, states, units, and progress values automatically.
- Update or end an existing Live Activity by activity ID.
- Works with Apple Shortcuts through the HA LiveKit iOS app.
- Includes diagnostics sensors for recent relay attempts and activity requests.
- Supports custom payloads for advanced users.

## Requirements

- Home Assistant 2025.1 or newer.
- HACS.
- The HA LiveKit iOS app; version 2.1 is required for Live Activity action buttons.
- An iPhone that supports Live Activities.

## Version alignment

Keep the iOS app and HACS integration on the same 2.1 release line. Update HA LiveKit to 2.1.2 in HACS, restart Home Assistant, and reopen the iOS app. Patch versions may differ within the compatible 2.1 release line.

## Installation with HACS

Use the **Add to HACS** button at the top of this page. It opens this repository in HACS and asks you to add it as a custom Integration. After the repository opens, choose **Download**; the button does not install the integration automatically.

If the button cannot open your Home Assistant instance, add the repository manually:

1. Open HACS in Home Assistant.
2. Open Custom repositories.
3. Add this repository URL:

   `https://github.com/efeshinkawa/halivekit`

4. Choose category: Integration.
5. Install or update HA LiveKit.
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

### Optional: Internal and External URLs

If your Home Assistant uses different addresses on your home Wi-Fi and away from home, open the connection section in iOS Settings and enable the optional Internal and External URL fields. HA LiveKit tries the Internal URL first and falls back to the External URL only for connectivity failures. Authentication errors are never hidden, and existing single-URL setups continue to work.

## Automations

Most users should use `ha_livekit.set_activity`.

- It starts the Live Activity if it does not exist.
- It updates the existing Live Activity if it already exists.
- When an entity is selected, `activity_id` may be left empty and HA LiveKit derives a stable ID so repeated calls update the same activity.
- For custom calls without an entity, provide an explicit `activity_id`.
- If two entities in different domains share the same object ID, provide distinct explicit IDs for them (for example, `light_desk` and `switch_desk`).

Use `ha_livekit.end_activity` when you want to end an activity by ID.

Add `entity_id` for automatic Home Assistant state, friendly name, unit, and progress mapping. Leave `entity_id` empty for a custom payload.

Door:

```yaml
action: ha_livekit.set_activity
data:
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

End:

```yaml
action: ha_livekit.end_activity
data:
  activity_id: front_door
```

More examples are in [`examples/automations.yaml`](examples/automations.yaml).

Advanced / backward compatibility actions remain available for existing automations:

- `ha_livekit.start_activity`
- `ha_livekit.update_activity`
- `ha_livekit.start_entity_activity`
- `ha_livekit.update_entity_activity`

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

Existing automations can keep using the explicit start and update actions:

- `ha_livekit.start_activity`
- `ha_livekit.update_activity`
- `ha_livekit.start_entity_activity`
- `ha_livekit.update_entity_activity`

Most users should use `ha_livekit.set_activity` for new automations. The iOS app handles background setup for you; you normally do not need to add relay setup actions manually. Reopen the iOS app once after updating, then restart Home Assistant after updating the integration.

## Privacy and security

Privacy Policy: [PRIVACY.md](PRIVACY.md)
