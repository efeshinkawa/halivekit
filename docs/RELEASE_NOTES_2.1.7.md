# HA LiveKit 2.1.4 → 2.1.7 coordinated patch wave

The iOS marketing version remains 2.1.1. This wave coordinates the managed
relay, the Home Assistant integration (HACS 2.1.4 → 2.1.7), and a TestFlight
build so that background Live Activities behave predictably with one stable
Activity ID.

## What was fixed

- **Idempotent Set** (relay + HACS 2.1.4): repeating Set with the same
  Activity ID updates the same activity; no more renamed-ID workarounds.
- **Ghost routes** (relay + iOS): a Live Activity the user dismissed keeps an
  update token APNs still answers HTTP 200 for, so delivery looked successful
  while nothing was on screen. The device now reports terminal ActivityKit
  states to the new authenticated /activity-retire endpoints, and on every
  launch the app reconciles: any registered route whose activity no longer
  exists is retired at the relay.
- **Pending-start window** (relay): Sets that land while the iPhone is still
  registering a just-started activity are no longer lost; the newest content is
  stored and flushed to the device the moment registration completes.
- **Route-history capacity** (relay + HACS 2.1.5): a properly ended route now
  trims its oldest tombstones instead of blocking new Activity IDs, and the
  integration explains the rule (keep one stable ID) instead of a generic 409.
- **False errors** (HACS 2.1.6/2.1.7): a Set accepted as in-progress and an End
  whose activity is already gone are idempotent successes, not errors.

## Known iOS behavior (not a bug)

Dismissing a Live Activity by swiping it away on the lock screen makes iOS
temporarily suppress push-to-start for the app - Apple treats the swipe as a
user-intent signal. Ending the activity from the app, or letting Home
Assistant end it, does not trigger this suppression. Use one stable Activity
ID and prefer End Live Activity over lock-screen dismissal during testing.

## Verification

- Relay: 204/204 tests; staging synthetic flows 19/19 including ghost-route
  reproduction, retire, pending-content flush, and v1/v2 auth flows.
- Home Assistant: 117/117 including idempotent-end and in-flight-start
  regressions.
- Production rollout followed the staged receipts flow (staging all ->
  compatible bridge -> allowlist -> all) with health-gated promotions.
