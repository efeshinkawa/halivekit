# Relay authentication v2

Status: implementation and local verification only. Nothing in this document authorizes a Cloudflare deploy, a secret rotation, KV deletion, or a live Home Assistant migration.

## Security goal

New HA LiveKit registrations must not trust the single app secret embedded in every distributed iOS build. A device instead proves that it is connected to an authenticated Home Assistant administrator and receives a random, device-scoped credential. Home Assistant keeps its instance relay secret; iOS never receives that secret in v2.

## Trust flow

1. The iOS app connects to Home Assistant with its existing access token.
2. The app asks the authenticated HA LiveKit pairing API for a short-lived ticket. The request includes the device ID, APNs environment, and a SHA-256 hash of the push-to-start token. A client instance ID is accepted only as a validated migration hint and is never used as the managed tenant authority.
3. Home Assistant selects or creates one persisted canonical instance ID, provisions or verifies its random per-instance relay secret through `/v2/instances/provision`, and requests a ticket through `/v2/pairing-tokens` using that secret.
4. The Worker stores only a hash of the ticket plus its exact instance/device/environment/token-hash scope. The ticket expires after five minutes. Provisioning and ticket issuance do not change the instance's effective v1/v2 authorization state. Instance, ticket, credential generation, and revocation decisions live in an instance-scoped Durable Object transaction; KV is only a bounded-TTL delivery cache.
5. iOS exchanges the ticket and push token through `/v2/register`. Successful ticket consumption atomically promotes the instance to v2 and returns a deterministic random-looking device credential derived with a server-side pepper.
6. iOS stores that credential in the device-only Keychain. Worker KV stores only its SHA-256 hash.
7. `/v2/activity-token`, `/v2/test-start`, registration refresh, and `/v2/unregister` require the device credential and enforce its exact scope.

## Compatibility rules

- Existing `/register`, `/provision-instance`, `/activity-token`, `/test-start`, `/start`, `/update`, and `/end` behavior remains available during migration.
- A v1 call may not overwrite a device record that has already upgraded to v2.
- Only after iOS successfully consumes a ticket does the instance become v2. The embedded v1 app secret may then refresh only legacy device IDs that already exist; it cannot enroll a fresh device ID. An interrupted provision or ticket-issuance attempt leaves fresh v1 fallback enrollment usable.
- iOS prefers v2 for the managed relay and falls back to v1 only while the HA integration or Worker reports that v2 is unavailable.
- Custom relays remain on their existing explicit registration-secret contract unless they implement v2.
- Removing `HA_LIVEKIT_APP_SECRET`, rejecting all v1 registrations, and pruning legacy KV records are operational cutover steps. They must happen only after the Worker, HA integration, and iOS release have been deployed in that order and adoption has been verified.

## Storage and replay limits

- Pairing tickets: five-minute TTL and exact scope. An immediate retry is idempotent only while the same credential generation remains current; rotation, HA revocation, or device unregister makes every older ticket stale.
- Device credentials: never stored in plaintext in long-lived KV; iOS Keychain uses device-only accessibility.
- Instance relay secrets: stored as hashes for every new or rotated record. A plaintext legacy KV record is accepted once to seed the Durable Object and is rewritten as a hash after successful HA authentication.
- Legacy device/activity KV records are upgraded lazily on an authorized read with protocol/generation metadata and bounded retention. A stale KV value never re-authorizes a revoked or superseded generation: every APNs candidate is filtered through the Durable Object immediately before delivery.
- Rate limits, body limits, device/activity quotas, and existing retention TTLs apply to every v2 mutation route.

The Worker configuration creates `RelayAuthState` with the `auth-state-v1` SQLite Durable Object migration. `/health` exposes a `ready` gate that requires KV, Durable Objects, APNs configuration, the legacy app-auth secret while v1 remains enabled, the device-credential pepper, an enabled relay, and the configured distributed rate-limit backend. The managed deployment script performs a Wrangler dry-run and fails if the post-deploy readiness gate is incomplete. It does not delete or bulk-rewrite KV records.

## Deployment and rollback safety

- Activity routing has a separate, fail-closed `ACTIVITY_GENERATION_MODE`. `bridge` is always `compatible`; `allowlist` and `all` are always `authoritative`; every staging `all` deployment is authoritative. `/health`, the exact Worker bindings, the artifact tag, and printed receipts must agree on `activity_generation_schema=auth_state_current_generation_v1` and the expected mode. Missing or invalid mode is never inferred.
- Schema-aware Cloudflare version tags use the bounded format `hlk-ag1-m<mode>-t<target>-p<phase>-<full-64hex-artifact>`: `ag1` means `auth_state_current_generation_v1`; mode is `c` compatible or `a` authoritative; target is `p` production or `s` staging; phase is `b` bridge, `l` allowlist, `a` all, or `r` rollback. Every combination retains the complete artifact digest and is at most 81 characters, below Cloudflare's 100-character maximum. The guarded historical pre-schema tags retain their exact old format solely for source recognition and bootstrap recovery. Staging health and synthetic smoke must therefore match `worker_version_tag=hlk-ag1-ma-ts-pa-<STAGING_PROOF_ARTIFACT_SHA256>` exactly.
- The only forward production edges are pre-schema/legacy → compatible bridge and compatible bridge → authoritative allowlist/all. An exact previously guarded pre-schema off-mode bridge may be restored only inside its one compatible-bootstrap transaction if that transaction fails. It is never printed or accepted as a manual rollback receipt. After compatible health and receipt acceptance, the pre-schema version is permanently below the rollback floor. Every manual rollback and every automatic recovery from an authoritative version requires the exact schema-aware compatible bridge receipt; staging recovery uses its isolated exact authoritative staging receipt.
- `V2_PAIRING_MODE=off|allowlist|all` controls only new v2 instance provisioning and pairing-ticket issuance. Missing or invalid values fail closed as `off`.
- `off` leaves every v1 route and all already-issued v2 credential routes available while disabling new v2 tenants/devices. It also keeps one narrow recovery path for an instance that is already effectively v2: Home Assistant must authenticate with the same instance secret and may provision/issue a replacement ticket only for that exact previously authorized device. This repairs a lost KV write or lost registration response without opening general pairing; unknown tenants and devices still receive `501`. `allowlist` accepts only canonical HA instance IDs whose SHA-256 digest appears in `V2_PAIRING_CANARY_INSTANCE_HASHES`. Production allowlist is rejected unless it contains exactly one unique hash (canary); staging may use multiple synthetic hashes. `/health` reports the mode and allowlist count but never the hashes.
- The tracked production configuration defaults to `off`. Rollout configuration is generated in a mode-600 temporary directory; a dry-run never rewrites `wrangler.jsonc` or an iOS configuration file. The verified JavaScript bundle, generated/proof/rollback configs, and secret payload are made read-only. Their exact hashes, file identities, regular-file type, and non-symlink status are captured and rechecked immediately before every Wrangler command that references them; replacement or same-user modification stops the rollout. Generated configuration sets `send_metrics=false`. Wrangler child processes also force the public production Cloudflare API, sanitized logging (`error` normally and `log` only when machine-readable stdout is captured), no error reports/metrics/update check, no dotenv/process-var inference, and discard ambient account, API, CI-name, log-file, and output-file overrides.
- Every remote config is pinned to an explicit 32-hex `EXPECTED_CLOUDFLARE_ACCOUNT_ID`; ambient `CLOUDFLARE_ACCOUNT_ID`/`CF_ACCOUNT_ID` values cannot select the target. Production and staging use different Worker names, KV namespaces, rate-limit namespaces, and Durable Object storage. Local `AUTH_STATE` config must omit `script_name` and `environment`. Exact remote metadata may omit `script_name` or normalize it to the exact current Worker name, but any other script name or any remote `environment` is rejected. Staging additionally requires `APNS_MOCK=true` and `APNS_ENVIRONMENT=sandbox`.
- `.dev.vars.staging` is separate from production `.dev.vars`. Its Apple private-key material is synthetic and mock-only, and its Apple key, app secret, and credential pepper must all differ from production. Never copy the production APNs private key into staging. No secret value or canonical instance ID is printed by the rollout tool.
- Staging declares its three isolated secrets through `secrets.required`. Production additionally declares the historical `RELAY_ENABLED` secret and does not convert it to a plain variable; `--strict` therefore preserves its already health-verified value without a binding conflict or rotation. The rollout does not use `--keep-vars`: behavior-changing plain/JSON vars are replaced by the exact reviewed set, while only explicitly required existing secrets are inherited. Metadata gates require exact secret-binding names with no extras or duplicates. The first production bridge supplies only the new `DEVICE_CREDENTIAL_PEPPER` and requires `--confirm-initial-pepper`; existing APNs, v1 app, and relay-enabled secrets remain inherited. Re-running a bridge omits the secret file, and allowlist/all promotions never upload secrets. Never rotate the pepper after v2 credentials exist.
- Production and staging explicitly set `workers_dev=true` and `preview_urls=false`. The tool reads Cloudflare's authoritative per-Worker subdomain state through the pinned account before mutation and again before accepting a receipt. An inactive `versions upload` is never accepted while preview URLs are enabled, because an `allowlist` or `all` preview could otherwise expose pairing before the guarded 100% activation. Remote commands therefore require a Cloudflare API token, or an API key plus account email, with read access to this state.
- Production configuration explicitly sets `APNS_MOCK=false`; staging requires `APNS_MOCK=true`. Every remote action needs an explicit confirmation flag and pinned account. The health URL must be the root HTTPS origin derived from that account's authoritative workers.dev subdomain and the exact configured Worker name; custom hosts, paths, ports, query strings, fragments, and another Worker's healthy endpoint are rejected before mutation.
- Health polling retries until the full semantic predicate passes, rather than accepting the first HTTP 200 JSON. Every attempt has a hard request timeout and a 16 KiB streamed-body limit, so a stalled or unbounded health endpoint cannot prevent rollback. Wrangler child processes also have a hard execution timeout. Post-deploy health must report the exact Cloudflare Worker version ID and phase-specific artifact tag. The tool also waits until that same version receives 100% of traffic.
- Before any production bridge upload, the tool reruns the local Worker syntax and complete test suites. It then verifies an exact, currently deployed staging `all` version built from the same bundle and requires the operator checkpoint that both staging v1 and v2 synthetic flows passed. Staging accepts only `--phase=all`. A first staging upload is allowed when Cloudflare explicitly reports the Worker absent. The one existing pre-schema staging build may instead bootstrap directly to authoritative only when its complete UUID/artifact-SHA/server-etag receipt, old tag, isolated config, and live health all match exactly. That pre-schema receipt is usable only as the automatic recovery target inside the same failed bootstrap activation; after the authoritative health checkpoint succeeds it is permanently below the rollback floor. Every later staging update requires the complete schema-aware authoritative receipt. Existing staging updates inherit their receipt-validated secrets and omit the secret file, preventing local secret drift from rotating them.
- Exact Cloudflare version metadata is authoritative for production source classification; health only corroborates it. A true pre-v2 source must retain the exact core APNs variables, production KV namespace, compatibility date/flags, and legacy secret bindings while explicitly lacking the v2 migration, `AUTH_STATE`, version metadata, device pepper, and v2-mode bindings. The audited historical production shape may omit safety/retention vars whose bridge values equal the old runtime defaults, may lack the newly introduced rate-limit binding, and may carry `RELAY_ENABLED` as a secret only when the separate live health gate proves relay delivery is enabled. If a legacy rate-limit binding exists it must match the tracked namespace/policy exactly; all unexpected behavior bindings still fail closed. Any v2 evidence forces the receipt-validated existing-bridge path, even if a stale or incorrect health URL appears legacy; this prevents accidental pepper rotation.
- The first production bridge uses an atomic `wrangler deploy` because it creates the SQLite Durable Object namespace. Cloudflare cannot gradually apply this lifecycle migration and cannot roll back across it. Pre-v2 production is never a rollback target.
- The guarded bridge prints three artifact identifiers—exact Cloudflare version UUID, local bundle SHA-256, and Cloudflare's hashed script-content etag—plus the verified `workers_dev=true`/`preview_urls=false` trigger state. Promotions and rollback retrieve that UUID with `versions view`, re-read the live trigger state, and require the exact plain/JSON/secret/resource bindings, compatibility date and flags, Durable Object migration, phase message, cryptographic artifact tag, rate-limit settings, server etag, and version-metadata binding. A recent version with only a copied message does not qualify. Because staging, bridge, allowlist, and all upload the identical frozen module, the production bridge etag must equal the staging receipt etag, and every later production version must equal the bridge etag.
- After the lifecycle migration, bridge re-runs and allowlist/all changes use `wrangler versions upload`, validate the exact new UUID/config/tag/server-etag while it receives no traffic, recheck that the previously validated source still receives exactly 100% immediately before mutation, and only then issue `wrangler versions deploy <UUID>@100%`. Initial lifecycle deploys likewise recheck the exact legacy source or true staging absence immediately before upload. This narrows the dashboard/CI race and avoids the non-versioned observability mutation performed by `wrangler deploy`. Re-running an existing bridge also requires the complete old bridge receipt and restores that exact version on any attempted activation or health-gate failure.
- After any attempted production promotion or post-deploy gate failure, the tool unconditionally issues a later deployment of only the receipt-bound v2-capable bridge, waits for that exact bridge at 100% traffic, and matches its version ID/tag through `/health`. Existing staging updates similarly restore their exact prior staging receipt after an activation/gate failure. For the irreversible first production migration or first staging creation, a failed/timeout response is reconciled only when the exact expected UUID/config/tag/etag, health, and disabled-preview state all become authoritative; then the full receipt is printed. Observing only the old or absent source for a bounded interval is not proof of non-mutation and stops with explicit manual-intervention instructions. Percentage traffic splitting is deliberately not used because pairing is a multi-request transaction.

Cloudflare documents that named environments create distinct Workers and Durable Object storage, that lifecycle migrations require a deployment, and that rollbacks cannot cross a Durable Object lifecycle change:

- <https://developers.cloudflare.com/workers/wrangler/environments/>
- <https://developers.cloudflare.com/durable-objects/reference/environments/>
- <https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/>
- <https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/>
- <https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/>

## Rollout inputs

Before any remote command, create a dedicated staging KV namespace and choose a staging-only rate-limit namespace. Put their IDs, the staging health URL, and staging-only secrets in ignored `.dev.vars.staging`:

```dotenv
WORKER_HEALTH_URL=https://ha-livekit-apns-relay-staging.<account>.workers.dev
EXPECTED_CLOUDFLARE_ACCOUNT_ID=<32-hex-cloudflare-account-id>
STAGING_KV_NAMESPACE_ID=<32-hex-staging-kv-id>
STAGING_RATE_LIMIT_NAMESPACE_ID=<staging-only-numeric-id>
ACTIVITY_GENERATION_MODE=authoritative
APPLE_PRIVATE_KEY=synthetic-staging:<at-least-32-random-mock-only-characters>
HA_LIVEKIT_APP_SECRET=<staging-only-secret>
DEVICE_CREDENTIAL_PEPPER=<staging-only-stable-pepper>
```

Production `.dev.vars` must contain the production `WORKER_HEALTH_URL` and one stable `DEVICE_CREDENTIAL_PEPPER`. For allowlist mode it must also contain only the SHA-256 digest of canary's canonical `ha_...` identity:

```dotenv
WORKER_HEALTH_URL=https://ha-livekit-apns-relay.<account>.workers.dev
EXPECTED_CLOUDFLARE_ACCOUNT_ID=<32-hex-cloudflare-account-id>
DEVICE_CREDENTIAL_PEPPER=<production-stable-pepper>
ACTIVITY_GENERATION_MODE=compatible
V2_PAIRING_CANARY_INSTANCE_HASHES=<sha256-of-canary-canonical-id>
```

Set `CLOUDFLARE_API_TOKEN` in the operator process (or `CLOUDFLARE_API_KEY` plus `CLOUDFLARE_EMAIL`) so the rollout can perform an authoritative account-level read and verify the exact Worker subdomain/preview state before mutation. An existing interactive Wrangler OAuth login is deliberately not treated as proof for these direct control-plane reads; supply its independently available bearer token through `CLOUDFLARE_API_TOKEN`, or use a scoped Cloudflare API token. This credential is never copied into Worker bindings or printed.

After staging deployment and its documented synthetic tests, keep its complete UUID/artifact-SHA/server-etag/schema/mode proof receipt. After the compatible bridge deployment, keep its equivalent complete receipt. These identifiers and hashes are non-secret operational metadata and may be supplied as flags or stored in the ignored rollout environment files:

```dotenv
STAGING_PROOF_VERSION_ID=<staging-all-version-uuid>
STAGING_PROOF_ARTIFACT_SHA256=<printed-staging-bundle-sha256>
STAGING_PROOF_SCRIPT_ETAG=<printed-staging-cloudflare-script-etag>
STAGING_PROOF_ACTIVITY_GENERATION_SCHEMA=auth_state_current_generation_v1
STAGING_PROOF_ACTIVITY_GENERATION_MODE=authoritative
STAGING_PROOF_WORKERS_DEV=true
STAGING_PROOF_PREVIEW_URLS=false
BRIDGE_VERSION_ID=<production-bridge-version-uuid>
BRIDGE_ARTIFACT_SHA256=<printed-bundle-sha256>
BRIDGE_SCRIPT_ETAG=<printed-cloudflare-script-etag>
BRIDGE_ACTIVITY_GENERATION_SCHEMA=auth_state_current_generation_v1
BRIDGE_ACTIVITY_GENERATION_MODE=compatible
BRIDGE_WORKERS_DEV=true
BRIDGE_PREVIEW_URLS=false
```

Obtain the canonical value from the canary home's HA LiveKit config entry (`pending_managed_relay_instance_id` or `home_assistant_instance_id`) on the Home Assistant host and pipe it directly into a SHA-256 tool. Do not paste the full value into Git, shell history, an issue, or this file. A masked value such as `ha_xxxxxx...xxxxx` is not sufficient.

## Guarded commands

Run the local checks first. The first form of each rollout command is local-only:

```sh
cd relay/cloudflare-worker
npm run check
npm test

ACTIVITY_GENERATION_MODE=authoritative npm run rollout:staging -- --dry-run
ACTIVITY_GENERATION_MODE=authoritative npm run rollout:staging -- --confirm-deploy

ACTIVITY_GENERATION_MODE=compatible npm run deploy -- --dry-run
ACTIVITY_GENERATION_MODE=compatible npm run deploy -- --confirm-deploy --confirm-initial-pepper \
  --confirm-staging-tests \
  --staging-proof-version-id=<staging-all-version-uuid> \
  --staging-proof-artifact-sha256=<staging-artifact-sha256> \
  --staging-proof-script-etag=<staging-script-etag>
```

The receipt file is intentionally not loaded automatically. In the current one-time bootstrap, first audit that it contains only the expected receipt assignments, load those non-secret values into the operator process, and provide an explicit Cloudflare bearer credential without putting it on the command line:

```sh
set -a
. ./.dev.vars.receipts
set +a
read -r -s CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN

ACTIVITY_GENERATION_MODE=authoritative npm run rollout:staging -- --confirm-deploy
```

That command accepts either true Worker absence or the exact guarded pre-schema staging receipt. It never accepts a merely similar same-named Worker. To upload a later staging build, prove ownership of the current managed staging Worker with its new complete schema-aware receipt; the upload remains inactive until its exact metadata passes:

```sh
ACTIVITY_GENERATION_MODE=authoritative npm run rollout:staging -- --confirm-deploy \
  --staging-proof-version-id=<current-staging-version-uuid> \
  --staging-proof-artifact-sha256=<current-staging-artifact-sha256> \
  --staging-proof-script-etag=<current-staging-script-etag>
```

The production bridge prints `BRIDGE_VERSION_ID`, `BRIDGE_ARTIFACT_SHA256`, `BRIDGE_SCRIPT_ETAG`, and the verified workers.dev/preview state. Save the complete output. After real v1 start/update/end verification, promote only canary:

```sh
ACTIVITY_GENERATION_MODE=authoritative npm run rollout:allowlist -- --dry-run \
  --bridge-version-id=<bridge-uuid> \
  --bridge-artifact-sha256=<bridge-artifact-sha256> \
  --bridge-script-etag=<bridge-script-etag>
ACTIVITY_GENERATION_MODE=authoritative npm run rollout:allowlist -- --confirm-deploy \
  --bridge-version-id=<bridge-uuid> \
  --bridge-artifact-sha256=<bridge-artifact-sha256> \
  --bridge-script-etag=<bridge-script-etag>
```

If production is already on an off-mode bridge and the bridge code must be re-uploaded, provide both the current bridge receipt (the rollback target) and the newly verified staging receipt. Do not pass `--confirm-initial-pepper`; no secret file is uploaded on this path:

```sh
ACTIVITY_GENERATION_MODE=compatible npm run deploy -- --confirm-deploy --confirm-staging-tests \
  --bridge-version-id=<current-bridge-uuid> \
  --bridge-artifact-sha256=<current-bridge-artifact-sha256> \
  --bridge-script-etag=<current-bridge-script-etag> \
  --staging-proof-version-id=<new-staging-version-uuid> \
  --staging-proof-artifact-sha256=<new-staging-artifact-sha256> \
  --staging-proof-script-etag=<new-staging-script-etag>
```

Only after canary secure pairing, background start/update/end, and action buttons pass may all mode be promoted:

```sh
ACTIVITY_GENERATION_MODE=authoritative npm run rollout:all -- --dry-run \
  --bridge-version-id=<bridge-uuid> \
  --bridge-artifact-sha256=<bridge-artifact-sha256> \
  --bridge-script-etag=<bridge-script-etag>
ACTIVITY_GENERATION_MODE=authoritative npm run rollout:all -- --confirm-deploy --confirm-all \
  --bridge-version-id=<bridge-uuid> \
  --bridge-artifact-sha256=<bridge-artifact-sha256> \
  --bridge-script-etag=<bridge-script-etag>
```

The only approved rollback is the recorded post-migration bridge:

```sh
ACTIVITY_GENERATION_MODE=compatible npm run rollout:rollback -- --dry-run
ACTIVITY_GENERATION_MODE=compatible npm run rollout:rollback -- --confirm-rollback \
  --bridge-version-id=<bridge-uuid> \
  --bridge-artifact-sha256=<bridge-artifact-sha256> \
  --bridge-script-etag=<bridge-script-etag>
```

Rollback `--dry-run` is deliberately local-only: apart from checking the pinned local Wrangler binary with telemetry/update checks disabled, it performs no Cloudflare control-plane lookup or mutation and no health request.

## Legacy-device remediation

Provisioning v2 seeds pre-existing v1 device IDs as legacy so released clients keep working. This preserves availability but also preserves any device ID that was maliciously enrolled before cutover. Operators must therefore treat the legacy population as unverified. The Worker exposes HA-secret-authenticated `/v2/devices` and `/revoke-device` controls; Home Assistant wraps them in administrator-only `/api/ha_livekit/relay/devices` GET/POST operations, and the iOS Health Center shows the resulting inventory with an explicit revoke confirmation. Inventory responses contain only friendly name, device ID, protocol, generation, app version and update time—never push tokens, hashes or credentials. Keep the remediation window time-bounded and revoke unknown legacy entries before disabling v1.

Provisioning, ticket issuance, and ticket consumption are separate calls. Before the first two calls, Home Assistant persists newly generated managed identity material in dedicated pending fields that the active coordinator does not consume. The Worker keeps the instance's effective authorization on v1 through provision and issuance; one-way v2 promotion occurs atomically only when iOS consumes the ticket through `/v2/register`. A timeout before consumption therefore remains recoverable through v1 fallback, retry, or HA restart. Relay mode, URL, APNs environment, active instance ID, and active shared secret are changed only after both relay responses pass exact v2 scope/type validation. A failed managed pairing consequently cannot replace an already working custom relay configuration.

## Home Assistant control-plane boundary

- `/api/ha_livekit/relay/pair` uses Home Assistant authentication and rejects every non-administrator before reading or forwarding its request body.
- HA owns the canonical managed instance ID. Multiple devices and an app reinstall receive the same persisted ID; the known deterministic legacy ID is rejected and replaced with a fresh random ID and secret.
- Pairing request bodies are streamed with an 8 KiB hard limit. Relay responses are streamed with a 32 KiB hard limit, redirects are disabled and explicitly rejected, and only exact 2xx v2 responses with matching instance/device/environment scope are accepted.
- Safe failure responses may include only HA's validated or freshly generated canonical instance ID so the app can retry or perform an explicit compatibility migration. They never echo the client candidate or expose the HA relay secret.
- HA does not use an in-memory replay cache as the ticket authority. Ticket consumption, generation ordering, unregister tombstones, and post-restart replay rejection are enforced by the Worker's strongly consistent authorization object. An authenticated administrator may request another short-lived ticket; issuing one does not by itself register or authorize a device.

## App Attest boundary

App Attest is defense in depth, not the root tenant authorization mechanism. Apple requires a server challenge, full attestation-chain and nonce validation, app identity checks, assertion counters, and a fallback for unsupported devices. A partial verifier would create false confidence, so v2 ships only after the HA-authenticated pairing flow is complete; App Attest is a separate audited gate before the legacy app secret is finally removed.

Primary references:

- Apple: <https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity>
- Apple: <https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server>
- Home Assistant authenticated REST permissions: <https://developers.home-assistant.io/docs/auth_permissions/>
- Cloudflare Web Crypto: <https://developers.cloudflare.com/workers/runtime-apis/web-crypto/>

## Required rollout order

1. Run Worker and HA regression suites, review the exact diff, and complete the required iCloud backup. A failed backup stops publication.
2. Deploy the isolated mock-APNs staging environment in authoritative activity-generation mode, test both v1 and v2 synthetic flows, and retain its complete all-mode UUID/artifact-SHA/server-etag/schema/mode plus disabled-preview receipt as the production checkpoint.
3. Deploy production bridge mode (`off`) in compatible activity-generation mode, retain the complete UUID/artifact-SHA/server-etag/schema/mode plus disabled-preview receipt, and verify released v1 devices still perform background start/update/end. This compatible receipt becomes the permanent production rollback floor.
4. Deploy `allowlist` with exactly one hash and authoritative activity-generation mode: the canary home's canonical identity digest. Reopen the app, complete secure pairing, then test background start/update/end and entity action buttons with the app terminated.
5. Deploy `all` only after the canary checks pass. Continue to keep v1 endpoints and existing registrations intact.
6. On any regression, disable new pairing by restoring only the recorded v2-capable bridge. Never return to the pre-migration Worker.
7. Disabling v1, rotating any secret, deleting KV, or adding a multi-home picker remains a separate future change. iOS/HACS version `2.1` is not changed by this rollout.
