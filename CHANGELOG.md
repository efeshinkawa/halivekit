# HA LiveKit Changelog

## 2.1.2 — Reliable Repeated Background Starts

### Home Assistant integration

- Shows one real **On/Off controls** switch in the Home Assistant action editor while keeping the runtime field optional for existing YAML automations.
- Lets entity-backed `set_activity` calls omit `activity_id` and derives the same stable ID on every call, preventing accidental duplicate Live Activities; custom calls without an entity still require an explicit ID.
- Reports a relay start that is still waiting for the iPhone activity token as an actionable delivery error instead of a false success.

### Companion iOS app

- Ignores the foreground WebSocket duplicate while the app is inactive or backgrounded, preventing the delayed `Target is not foreground` alert.
- Restarts per-activity token observation after Home Assistant identity restore or switching connections, so repeated background start, update, and end requests can recover reliably.

### Compatibility

- Existing YAML automations, explicit activity IDs, v1 relay registrations, and current Live Activities remain compatible.
- Action controls remain opt-in and disabled by default.
- Use HA LiveKit iOS 2.1.1 with HACS integration 2.1.2, restart Home Assistant, and reopen the iOS app once after updating.

## 2.1.1 — Background Delivery and Home Assistant Controls

### Home Assistant integration

- Adds `allow_entity_control` to `start_activity`, `set_activity`, and `start_entity_activity` so automations can explicitly enable authenticated On/Off controls.
- Supports controls for `light`, `switch`, and `input_boolean` entities and rejects unsupported domains.
- Reports enabled-relay delivery failures as actionable Home Assistant service errors instead of silently succeeding while the app is backgrounded or terminated.
- Preserves foreground-only behavior when relay delivery is intentionally disabled.

### Compatibility

- Use HA LiveKit iOS 2.1 build 24 or newer.
- Restart Home Assistant after updating the integration.
- End and start a new Live Activity after changing `allow_entity_control`, because ActivityKit control permission is immutable for an existing activity.
- Background action controls require a compatible managed-relay deployment; foreground delivery remains available independently.

## 2.1.0 — Live Activity Controls

### Companion iOS app

- Adds optional **On** and **Off** buttons to Live Activities created from `light`, `switch`, and `input_boolean` entities.
- Runs controls directly from the Lock Screen and expanded Dynamic Island without presenting the app interface.
- Requires local device authentication and binds every command to the approved Live Activity, entity, and Home Assistant instance.
- Uses the selected entity's Home Assistant or SF Symbol mapping for custom activities.
- Removes the redundant zero-brightness progress bar from control-enabled Dynamic Island layouts.

### Home Assistant integration

- Aligns the integration manifest and status version with the HA LiveKit 2.1 app release.
- Restores transparent integration branding and refreshes the HACS installation entry point.
- Keeps Home Assistant services, payloads, and the relay protocol unchanged.

### Compatibility

- Action buttons are opt-in and disabled by default.
- HA LiveKit 2.1 and HACS integration 2.1.0 are the same coordinated release line.
- No backend, relay protocol, entitlement, or bundle identifier changes are required.
- Existing Live Activities remain compatible because the new control attributes are optional.

## 2.0.1 — Background Shortcuts

### Companion iOS app

- Start Custom Live Activity and Start Entity Live Activity now use Apple's dedicated Live Activity intent contract.
- Shortcuts and personal automations can start a Live Activity without presenting the HA LiveKit app interface.
- Live Activities are still created immediately on the device through ActivityKit; the Home Assistant, relay, and APNs payload contracts are unchanged.

### Home Assistant integration

- No Home Assistant runtime behavior changed in this patch; the integration version is aligned with the 2.0.1 companion release.
- HA LiveKit integration 2.0.0 remains compatible with the iOS 2.0.1 app.

## 2.0.0 — What’s New

HA LiveKit 2.0 is a coordinated Home Assistant, managed-relay, and iOS upgrade focused on security, reliability, diagnostics, and a cleaner Live Activity workflow.

### Before updating

1. Update HA LiveKit to 2.0.0 in HACS.
2. Restart Home Assistant.
3. Install or reopen HA LiveKit 2.0 on the iPhone.

Home Assistant 2025.1 or newer is required. Keep temporary v1 relay compatibility enabled during rollout. Existing foreground Home Assistant updates continue to work while both sides are being upgraded.

### Home Assistant integration

- Adds the 2.0 compatibility and status contract used by the iOS Health Center.
- Adds administrator-approved, short-lived relay pairing tickets for Relay Auth v2.
- Adds administrator-only relay device inventory and explicit device revocation.
- Adds safe managed-relay provisioning and recovery without exposing relay credentials.
- Improves `set_activity`, entity-aware activity payloads, progress mapping, and backward-compatible start/update/end services.
- Strengthens service authorization, entity permission checks, activity ownership, payload size/depth validation, webhook signing, replay protection, and error propagation.
- Publishes a strictly validated Important Notices feed for required compatibility and reliability information.

### Secure relay and privacy

- Replaces shared authorization for upgraded devices with device-scoped credentials.
- Stores credential hashes instead of plaintext device credentials and prevents stale records from restoring revoked access.
- Adds strongly consistent credential generations, revocation tombstones, quotas, redirect rejection, bounded network responses, and APNs environment validation.
- Keeps v1 compatibility available during adoption; disabling v1 or rotating relay credentials remains a separate migration.
- Never exposes Home Assistant tokens, APNs tokens, relay secrets, device credentials, private keys, request headers, or raw network bodies in notices, inventory, or copied diagnostics.

### Companion iOS 2.0

- Introduces a cleaner Home, Create, Health, and Settings interface.
- Adds live Lock Screen and Dynamic Island previews to the Activity Builder.
- Expands Quick Presets with a compact Show More flow.
- Adds safe Home Assistant automation YAML generation, review, copy, and sharing.
- Moves redacted Debug Logs to a dedicated page with protected copy support.
- Adds a redesigned Health Center for connection, notification, ActivityKit, integration, relay, and device status.
- Adds Important Notices plus an update banner with Remind Later and Update actions.
- Clearly requires the matching HACS integration update and Home Assistant restart when compatibility changes.
- Improves Home Assistant URL resolution, connection persistence, Keychain isolation, entity caching, iCloud preferences, Shortcuts, background recovery, and relay diagnostics.
- Adds responsive compact-width and Dynamic Type layouts, vertical-only Health scrolling, dark-mode fixes, and floating tab-bar clearance.
- Includes 15 synchronized app languages and a native Icon Composer app icon for modern iOS appearances.

### Validation

- 63 Home Assistant security regression tests passed.
- 40 managed Worker tests passed.
- Worker dependency audit reported zero known vulnerabilities.
- Debug and Release iOS app/widget simulator builds passed.
- All 15 iOS localization tables passed key-parity and property-list validation.

For the safest migration, update the compatible managed Worker first while v1 remains enabled, then publish and restart the HACS integration, and finally install the iOS 2.0 TestFlight or App Store build.
