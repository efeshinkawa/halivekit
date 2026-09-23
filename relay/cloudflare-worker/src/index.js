import {
  ACTIVITY_REGISTRATION_GENERATION_SCHEMA_VERSION,
  RELAY_AUTH_STATE_SCHEMA_VERSION,
  RelayAuthState,
} from "./auth_state.js";

export { RelayAuthState };

const HA_SECRET_HEADER = "X-HA-LiveKit-Secret";
const APP_SECRET_HEADER = "X-HA-LiveKit-App-Secret";
const DEVICE_CREDENTIAL_HEADER = "X-HA-LiveKit-Device-Credential";
const OPERATION_HEADER = "X-HA-LiveKit-Operation";
const ENTITY_SET_OPERATION = "entity-set-v1";
const SWIFT_REFERENCE_DATE_UNIX_OFFSET = 978307200;
const INSTANCE_ID_VERSION = 2;
const INSTANCE_ID_PATTERN = /^ha_[a-f0-9]{32}$/;
const DEFAULT_OR_UNSAFE_INSTANCE_IDS = new Set([
  "ha_980c4bd6a677da0511813adb8c98192e", // sha256("home_assistant")
]);
const ROUTING_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const CANONICAL_ACTIVITY_ID_PATTERN = /^~[A-Za-z0-9_-]{2,127}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;
const DUPLICATE_ACTIVITY_NAME_MESSAGE = "An active Live Activity with this name already exists. Please choose another name.";
const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024;
const DEFAULT_DEVICE_TTL_SECONDS = 180 * 24 * 60 * 60;
const DEFAULT_ACTIVITY_TTL_SECONDS = 48 * 60 * 60;
const DEFAULT_SECRET_TTL_SECONDS = 400 * 24 * 60 * 60;
const DEFAULT_ACTIVITY_STATE_TTL_SECONDS = 12 * 60 * 60;
const DEFAULT_PENDING_START_TTL_SECONDS = 10 * 60;
const ENTITY_SET_RESERVATION_TTL_MS = 20_000;
const ENTITY_SET_HARD_DEADLINE_MS = 2 * 60_000;
const APNS_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_PAIRING_TTL_SECONDS = 5 * 60;
const DEFAULT_MAX_DEVICES_PER_INSTANCE = 32;
const DEFAULT_MAX_ACTIVITIES_PER_INSTANCE = 256;
const DEFAULT_MAX_ACTIVITIES_PER_DEVICE = 32;
const TOKEN_RETENTION_POLICY_VERSION = 1;
const V2_PAIRING_MODES = new Set(["off", "allowlist", "all"]);
const ACTIVITY_GENERATION_MODES = new Set(["compatible", "authoritative"]);
const V2_PAIRING_ENDPOINTS = new Set([
  "/v2/instances/provision",
  "/v2/pairing-tokens",
]);
const RESTRICTED_V2_PAIRING_RECOVERY = Symbol("restricted-v2-pairing-recovery");
const MAX_LOCAL_RATE_BUCKETS = 10_000;
const LOCAL_RATE_WINDOW_MS = 60_000;
const LOCAL_RATE_POLICIES = Object.freeze({
  "/register": { limit: 30, env: "RATE_LIMIT_REGISTER_PER_MINUTE" },
  "/provision-instance": { limit: 20, env: "RATE_LIMIT_PROVISION_PER_MINUTE" },
  "/activity-token": { limit: 60, env: "RATE_LIMIT_ACTIVITY_TOKEN_PER_MINUTE" },
  "/test-start": { limit: 5, env: "RATE_LIMIT_TEST_START_PER_MINUTE" },
  "/start": { limit: 60, env: "RATE_LIMIT_START_PER_MINUTE" },
  "/update": { limit: 240, env: "RATE_LIMIT_UPDATE_PER_MINUTE" },
  "/end": { limit: 60, env: "RATE_LIMIT_END_PER_MINUTE" },
  "/revoke-device": { limit: 20, env: "RATE_LIMIT_REVOKE_PER_MINUTE" },
  "/v2/instances/provision": { limit: 10, env: "RATE_LIMIT_V2_PROVISION_PER_MINUTE" },
  "/v2/pairing-tokens": { limit: 20, env: "RATE_LIMIT_V2_PAIRING_PER_MINUTE" },
  "/v2/register": { limit: 30, env: "RATE_LIMIT_V2_REGISTER_PER_MINUTE" },
  "/v2/activity-token": { limit: 60, env: "RATE_LIMIT_V2_ACTIVITY_TOKEN_PER_MINUTE" },
  "/v2/test-start": { limit: 5, env: "RATE_LIMIT_V2_TEST_START_PER_MINUTE" },
  "/v2/unregister": { limit: 10, env: "RATE_LIMIT_V2_UNREGISTER_PER_MINUTE" },
  "/activity-retire": { limit: 60, env: "RATE_LIMIT_ACTIVITY_RETIRE_PER_MINUTE" },
  "/v2/activity-retire": { limit: 60, env: "RATE_LIMIT_V2_ACTIVITY_RETIRE_PER_MINUTE" },
  "/v2/devices": { limit: 20, env: "RATE_LIMIT_V2_DEVICES_PER_MINUTE" },
});

let cachedAPNsJWT;
const authStateReadinessCache = new WeakMap();
const localRateBuckets = new Map();
let nextLocalRateSweepAt = 0;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = normalizePath(url.pathname);

      if (request.method === "GET" && path === "/health") {
        const readiness = await relayReadiness(env);
        const v2Pairing = v2PairingConfiguration(env);
        const activityGeneration = activityGenerationMode(env);
        return jsonResponse({
          ok: true,
          ready: readiness.ready,
          storage: Boolean(env.TOKENS),
          apns_configured: isAPNsConfigured(env),
          apns_mock: env.APNS_MOCK === "true",
          apns_environment: apnsEnvironment(env),
          relay_enabled: isRelayEnabled(env),
          worker_version_id: stringValue(env.CF_VERSION_METADATA?.id) || null,
          worker_version_tag: stringValue(env.CF_VERSION_METADATA?.tag) || null,
          bundle_id: appBundleID(env) || null,
          missing_apns_env: missingAPNsConfig(env),
          rate_limit_backend: hasRateLimitBinding(env) ? "cloudflare+local" : "local-fallback",
          rate_limit_fail_closed: rateLimitMode(env) === "binding-required",
          strongly_consistent_auth_configured: Boolean(env.AUTH_STATE),
          strongly_consistent_auth_ready: readiness.strongAuthReady,
          auth_state_schema_version: readiness.authStateSchemaVersion,
          activity_registration_generation_schema_version:
            readiness.activityRegistrationGenerationSchemaVersion,
          activity_generation_schema: "auth_state_current_generation_v1",
          activity_generation_mode: activityGeneration,
          activity_route_authority: readiness.strongAuthReady && activityGeneration
            ? activityGeneration === "authoritative"
              ? "auth_state_current_generation_v1"
              : "sticky_per_instance_compatibility_v1"
            : null,
          minimum_safe_rollback_auth_state_schema_version: RELAY_AUTH_STATE_SCHEMA_VERSION,
          pre_schema_rollback_safe: false,
          v2_device_auth_configured: String(env.DEVICE_CREDENTIAL_PEPPER || "").trim().length >= 32,
          v2_pairing_mode: v2Pairing.mode,
          v2_pairing_enabled: v2Pairing.enabled,
          v2_pairing_allowlist_configured: v2Pairing.allowlistCount > 0,
          v2_pairing_allowlist_count: v2Pairing.allowlistCount,
          legacy_app_auth_configured: readiness.legacyAppAuthConfigured,
          distributed_rate_limit_ready: readiness.distributedRateLimitReady,
          legacy_global_secret_present_ignored: Boolean(env.HA_LIVEKIT_SHARED_SECRET),
          auth_protocols: ["v1", "v2"],
          endpoints: [
            "/health", "/register", "/provision-instance", "/activity-token", "/test-start",
            "/start", "/update", "/end", "/revoke-device",
            "/v2/instances/provision", "/v2/pairing-tokens", "/v2/register",
            "/v2/activity-token", "/v2/test-start", "/v2/unregister", "/v2/devices",
            "/activity-retire", "/v2/activity-retire",
          ],
        });
      }

      if (request.method === "GET" && path === "/v2/devices") {
        if (!isRelayEnabled(env)) {
          return jsonResponse({ ok: false, error: "relay_disabled" }, 503);
        }
        await enforceEndpointRateLimit(request, env, path);
        return await handleListDevicesV2(request, env);
      }

      if (request.method !== "POST") {
        return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
      }

      if (isRelayMutationEndpoint(path) && !isRelayEnabled(env)) {
        logRelay("relay-disabled", { endpoint: path, environment: apnsEnvironment(env) });
        return jsonResponse({
          ok: false,
          error: "relay_disabled",
          message: "HA LiveKit APNs relay is temporarily disabled.",
        }, 503);
      }

      if (isActivityGenerationEndpoint(path) && !activityGenerationMode(env)) {
        throw httpError(
          503,
          "activity_generation_mode_invalid",
          "Live Activity generation mode is not configured safely."
        );
      }

      let v2Pairing;
      if (V2_PAIRING_ENDPOINTS.has(path)) {
        v2Pairing = v2PairingConfiguration(env);
      }

      if (isRelayMutationEndpoint(path)) {
        await enforceEndpointRateLimit(request, env, path);
      }

      let v2PairingRequest;
      if (v2Pairing) {
        v2PairingRequest = await requireV2PairingAllowed(request, env, path, v2Pairing);
      }

      if (path === "/register") {
        requireSecret(request, env.HA_LIVEKIT_APP_SECRET, APP_SECRET_HEADER);
        return await handleRegister(request, env);
      }

      if (path === "/provision-instance") {
        requireSecret(request, env.HA_LIVEKIT_APP_SECRET, APP_SECRET_HEADER);
        return await handleProvisionInstance(request, env);
      }

      if (path === "/activity-token") {
        requireSecret(request, env.HA_LIVEKIT_APP_SECRET, APP_SECRET_HEADER);
        return await handleActivityToken(request, env);
      }

      if (path === "/test-start") {
        requireSecret(request, env.HA_LIVEKIT_APP_SECRET, APP_SECRET_HEADER);
        return await handleTestStart(request, env);
      }

      if (path === "/start") {
        return await handleStart(request, env);
      }

      if (path === "/update") {
        return await handleUpdateOrEnd(request, env, "update");
      }

      if (path === "/end") {
        return await handleUpdateOrEnd(request, env, "end");
      }

      if (path === "/revoke-device") {
        return await handleRevokeDevice(request, env);
      }

      if (path === "/v2/instances/provision") {
        return await handleProvisionInstanceV2(request, env, v2PairingRequest);
      }

      if (path === "/v2/pairing-tokens") {
        return await handlePairingTokenV2(request, env, v2PairingRequest);
      }

      if (path === "/v2/register") {
        return await handleRegisterV2(request, env);
      }

      if (path === "/v2/activity-token") {
        return await handleActivityTokenV2(request, env);
      }

      if (path === "/v2/test-start") {
        return await handleTestStartV2(request, env);
      }

      if (path === "/v2/unregister") {
        return await handleUnregisterV2(request, env);
      }

      if (path === "/v2/activity-retire") {
        return await handleActivityRetireV2(request, env);
      }

      if (path === "/activity-retire") {
        requireSecret(request, env.HA_LIVEKIT_APP_SECRET, APP_SECRET_HEADER);
        return await handleActivityRetire(request, env);
      }

      return jsonResponse({ ok: false, error: "not_found" }, 404);
    } catch (error) {
      const status = error.status || 500;
      logRelay("request-error", {
        status,
        code: error.code || "relay_error",
        message: error.message,
      });
      return jsonResponse(
        { ok: false, error: error.code || "relay_error", message: error.message },
        status,
        error.headers
      );
    }
  },
};

async function handleRegister(request, env) {
  const body = await readJSON(request, env);
  validateRegistrationPayload(body);
  requireInstanceIDVersion(body);
  const deviceID = requiredRoutingID(body, "device_id");
  const instanceID = requiredInstanceID(body);
  const environment = requiredMatchingAPNsEnvironment(body, env);
  const token = requiredToken(body, "push_to_start_token");
  ensureStorage(env);
  enforceActorRateLimit(env, "/register", `${instanceID}:${deviceID}`);
  const legacyAuth = await requireLegacyDeviceMutationAllowed(env, environment, instanceID, deviceID);
  const now = new Date().toISOString();

  const record = {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: INSTANCE_ID_VERSION,
    push_to_start_token: token,
    bundle_id: stringValue(body.bundle_id),
    app_version: stringValue(body.app_version),
    apns_environment: environment,
    apns_mode: environment,
    auth_protocol: "v1",
    auth_generation: legacyAuth.generation ?? 0,
    retention_policy_version: TOKEN_RETENTION_POLICY_VERSION,
    friendly_device_name: stringValue(body.friendly_device_name),
    created_at: legacyAuth.legacy_record_proof_timestamp || now,
    updated_at: now,
  };

  await putJSONWithTTL(
    env.TOKENS,
    deviceKey(environment, instanceID, deviceID),
    record,
    deviceTTLSeconds(env)
  );
  logRelay("register", {
    device_id: logID(deviceID),
    home_assistant_instance_id: logInstanceID(instanceID),
    environment,
    bundle_id: record.bundle_id,
  });
  return jsonResponse({
    ok: true,
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: INSTANCE_ID_VERSION,
    token: redactToken(token),
    apns_environment: environment,
    relay_mode: "managed",
    registered: true,
  });
}

async function handleProvisionInstance(request, env) {
  return await provisionInstance(request, env, "v1", "/provision-instance", "provision-instance");
}

async function handleProvisionInstanceV2(request, env, pairingRequest) {
  return await provisionInstance(
    request,
    env,
    "v2",
    "/v2/instances/provision",
    "v2-provision-instance",
    pairingRequest?.body
  );
}

async function provisionInstance(request, env, requestedProtocol, ratePath, logEvent, parsedBody) {
  const body = parsedBody || await readJSON(request, env);
  requireInstanceIDVersion(body);
  const instanceID = requiredInstanceID(body);
  const relaySecret = requiredLimitedString(body, "relay_shared_secret", 512).trim();
  const currentRelaySecret = optionalLimitedString(
    body.current_relay_shared_secret || body.existing_relay_shared_secret,
    "current_relay_shared_secret",
    512
  ) || "";
  ensureStorage(env);
  enforceActorRateLimit(env, ratePath, instanceID);

  if (relaySecret.length < 32) {
    throw httpError(400, "invalid_relay_secret", "relay_shared_secret is too short.");
  }

  const key = instanceRelaySecretKey(instanceID);
  const existing = await getJSON(env.TOKENS, key);
  const environment = apnsEnvironment(env);
  const legacyDevices = (await listJSON(env.TOKENS, devicePrefix(environment, instanceID)))
    .filter((record) => (
      record.auth_protocol !== "v2"
      && recordMatchesScope(record, environment, instanceID, undefined, "device")
    ))
    .slice(0, maxDevicesPerInstance(env))
    .map((record) => ({
      device_id: record.device_id,
      environment,
      proof_timestamp: serverRecordProofTimestamp(record),
    }));
  const now = new Date().toISOString();
  const newSecretHash = await sha256Hex(relaySecret);
  const legacy = await legacyInstanceSnapshot(existing);
  const authoritative = await callAuthState(env, instanceID, {
    action: "provision_instance",
    requested_protocol: requestedProtocol,
    new_secret_hash: newSecretHash,
    current_secret_hash: currentRelaySecret ? await sha256Hex(currentRelaySecret) : undefined,
    legacy_secret_hash: legacy?.secretHash,
    legacy_auth_protocol: legacy?.authProtocol,
    legacy_devices: legacyDevices,
    maximum_devices: maxDevicesPerInstance(env),
    now,
  });
  const rotated = Boolean(authoritative.rotated);
  const authProtocol = authoritative.auth_protocol === "v2" ? "v2" : "v1";
  const effectiveAuthProtocol = authoritative.effective_auth_protocol === "v2"
    ? "v2"
    : authoritative.effective_auth_protocol === "v1"
      ? "v1"
      : authProtocol;

  await putJSONWithTTL(env.TOKENS, key, {
    home_assistant_instance_id: instanceID,
    instance_id_version: INSTANCE_ID_VERSION,
    secret_hash: newSecretHash,
    secret_format: "sha256-v1",
    auth_protocol: effectiveAuthProtocol,
    retention_policy_version: 1,
    created_at: existing?.created_at || now,
    rotated_at: rotated ? now : undefined,
    ttl_refreshed_at: now,
    updated_at: now,
  }, secretTTLSeconds(env));

  logRelay(logEvent, {
    home_assistant_instance_id: logInstanceID(instanceID),
    rotated,
  });
  return jsonResponse({
    ok: true,
    provisioned: true,
    rotated,
    home_assistant_instance_id: instanceID,
    instance_id_version: INSTANCE_ID_VERSION,
    auth_protocol: authProtocol,
    relay_mode: "managed",
  });
}

async function handlePairingTokenV2(request, env, pairingRequest) {
  const body = pairingRequest?.body || await readJSON(request, env);
  const restrictedRecovery = pairingRequest?.authorization === RESTRICTED_V2_PAIRING_RECOVERY;
  validateRegistrationPayload(body);
  requireInstanceIDVersion(body);
  const instanceID = requiredInstanceID(body);
  const deviceID = requiredRoutingID(body, "device_id");
  const environment = requiredMatchingAPNsEnvironment(body, env);
  const pushTokenHash = requiredSHA256(body, "push_to_start_token_hash");
  ensureStorage(env);
  enforceActorRateLimit(env, "/v2/pairing-tokens", `${instanceID}:${deviceID}`);

  const pairingToken = randomBase64URLToken(32);
  const credential = await deriveDeviceCredential(env, pairingToken, instanceID, deviceID, environment);
  const existingDevice = await getJSON(env.TOKENS, deviceKey(environment, instanceID, deviceID));
  const legacyDevice = (
    recordMatchesScope(existingDevice, environment, instanceID, deviceID, "device")
    && existingDevice?.auth_protocol !== "v2"
    && recordAuthGeneration(existingDevice, "v1") === 0
  ) ? existingDevice : null;
  const legacyInstanceRecord = await getJSON(env.TOKENS, instanceRelaySecretKey(instanceID));
  const legacyInstance = await legacyInstanceSnapshot(legacyInstanceRecord);
  const providedSecret = requiredSecretHeaderValue(request, HA_SECRET_HEADER, "HA LiveKit relay secret");
  const now = new Date();
  const ttl = pairingTTLSeconds(env);
  const ticketHash = await sha256Hex(pairingToken);
  const credentialHash = await sha256Hex(credential);
  const ticketAuthorization = await callAuthState(env, instanceID, {
    action: "issue_ticket",
    provided_secret_hash: await sha256Hex(providedSecret),
    legacy_secret_hash: legacyInstance?.secretHash,
    legacy_auth_protocol: legacyInstance?.authProtocol,
    ticket_hash: ticketHash,
    device_id: deviceID,
    environment,
    push_token_hash: pushTokenHash,
    device_credential_hash: credentialHash,
    legacy_device_auth_protocol: legacyDevice ? "v1" : undefined,
    legacy_device_generation: legacyDevice
      ? recordAuthGeneration(legacyDevice, "v1")
      : undefined,
    legacy_device_proof_timestamp: serverRecordProofTimestamp(legacyDevice),
    maximum_devices: maxDevicesPerInstance(env),
    restricted_recovery: restrictedRecovery,
    expires_at_ms: now.getTime() + ttl * 1000,
    now: now.toISOString(),
  });
  if (legacyInstanceRecord) {
    await refreshRelaySecretTTL(
      env,
      instanceID,
      legacyInstanceRecord,
      ticketAuthorization.effective_auth_protocol
    );
  }
  const record = {
    home_assistant_instance_id: instanceID,
    instance_id_version: INSTANCE_ID_VERSION,
    device_id: deviceID,
    apns_environment: environment,
    push_to_start_token_hash: pushTokenHash,
    device_credential_hash: credentialHash,
    bundle_id: stringValue(body.bundle_id),
    app_version: stringValue(body.app_version),
    auth_protocol: "v2",
    retention_policy_version: TOKEN_RETENTION_POLICY_VERSION,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
  };
  await putJSONWithTTL(env.TOKENS, pairingTokenKey(ticketHash), record, ttl);

  logRelay("v2-pairing-token", {
    home_assistant_instance_id: logInstanceID(instanceID),
    device_id: logID(deviceID),
    environment,
  });
  return jsonResponse({
    ok: true,
    pairing_token: pairingToken,
    expires_in: ttl,
    home_assistant_instance_id: instanceID,
    device_id: deviceID,
    apns_environment: environment,
    auth_protocol: "v2",
  });
}

async function handleRegisterV2(request, env) {
  const body = await readJSON(request, env);
  validateRegistrationPayload(body);
  requireInstanceIDVersion(body);
  const deviceID = requiredRoutingID(body, "device_id");
  const instanceID = requiredInstanceID(body);
  const environment = requiredMatchingAPNsEnvironment(body, env);
  const token = requiredToken(body, "push_to_start_token");
  ensureStorage(env);
  enforceActorRateLimit(env, "/v2/register", `${instanceID}:${deviceID}`);
  const storageKey = deviceKey(environment, instanceID, deviceID);
  const existing = await getJSON(env.TOKENS, storageKey);

  const pairingToken = optionalLimitedString(body.pairing_token, "pairing_token", 512);
  let credential;
  let credentialHash;
  let authGeneration;
  let upgraded = false;
  if (pairingToken) {
    const ticketHash = await sha256Hex(pairingToken);
    const pairingKey = pairingTokenKey(ticketHash);
    const pushTokenHash = await sha256Hex(token);
    credential = await deriveDeviceCredential(env, pairingToken, instanceID, deviceID, environment);
    credentialHash = await sha256Hex(credential);
    const consumed = await callAuthState(env, instanceID, {
      action: "consume_ticket",
      ticket_hash: ticketHash,
      device_id: deviceID,
      environment,
      push_token_hash: pushTokenHash,
      device_credential_hash: credentialHash,
      maximum_devices: maxDevicesPerInstance(env),
      now_ms: Date.now(),
      now: new Date().toISOString(),
    });
    authGeneration = consumed.generation;
    const instanceAuthRecord = await getJSON(env.TOKENS, instanceRelaySecretKey(instanceID));
    if (instanceAuthRecord) {
      await refreshRelaySecretTTL(env, instanceID, instanceAuthRecord, consumed.auth_protocol);
    }
    const pairing = await getJSON(env.TOKENS, pairingKey);
    if (pairing) {
      const remaining = Math.max(
        60,
        Math.ceil((Date.parse(pairing.expires_at || "") - Date.now()) / 1000) || pairingTTLSeconds(env)
      );
      await putJSONWithTTL(env.TOKENS, pairingKey, {
        ...pairing,
        consumed_at: pairing.consumed_at || new Date().toISOString(),
      }, Math.min(pairingTTLSeconds(env), remaining));
    }
    upgraded = true;
  } else {
    const authenticated = await requireDeviceCredential(request, env, instanceID, deviceID, environment);
    credentialHash = authenticated.device_credential_hash;
    authGeneration = authenticated.auth_generation;
  }

  const now = new Date().toISOString();
  const credentialChanged = existing?.device_credential_hash !== credentialHash;
  const record = {
    ...existing,
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: INSTANCE_ID_VERSION,
    push_to_start_token: token,
    device_credential_hash: credentialHash,
    credential_format: "sha256-v1",
    auth_protocol: "v2",
    auth_generation: authGeneration,
    retention_policy_version: TOKEN_RETENTION_POLICY_VERSION,
    bundle_id: stringValue(body.bundle_id) || existing?.bundle_id,
    app_version: stringValue(body.app_version) || existing?.app_version,
    apns_environment: environment,
    apns_mode: environment,
    friendly_device_name: stringValue(body.friendly_device_name) || existing?.friendly_device_name,
    upgraded_at: existing?.upgraded_at || (upgraded ? now : undefined),
    credential_issued_at: credentialChanged ? now : existing?.credential_issued_at,
    updated_at: now,
  };
  await putJSONWithTTL(env.TOKENS, storageKey, record, deviceTTLSeconds(env));

  logRelay("v2-register", {
    device_id: logID(deviceID),
    home_assistant_instance_id: logInstanceID(instanceID),
    environment,
    upgraded,
  });
  return jsonResponse({
    ok: true,
    registered: true,
    refreshed: !upgraded,
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: INSTANCE_ID_VERSION,
    device_credential: credential,
    token: redactToken(token),
    apns_environment: environment,
    auth_protocol: "v2",
  });
}

async function handleActivityTokenV2(request, env) {
  const body = await readJSON(request, env);
  const scope = activityTokenScope(body, env);
  ensureStorage(env);
  const auth = await requireDeviceCredential(request, env, scope.instanceID, scope.deviceID, scope.environment);
  scope.authGeneration = auth.auth_generation;
  enforceActorRateLimit(
    env,
    "/v2/activity-token",
    `${scope.instanceID}:${scope.deviceID}:${scope.activityID}`
  );
  return await storeActivityToken(body, env, scope, "v2");
}

async function handleTestStartV2(request, env) {
  ensureAPNs(env);
  ensureStorage(env);
  const body = await readJSON(request, env);
  validateLiveActivityPayload(body);
  requireInstanceIDVersion(body);
  requiredActivityRoutingID(body);
  const instanceID = requiredInstanceID(body);
  const environment = requiredMatchingAPNsEnvironment(body, env);
  const deviceID = requiredRoutingID(body, "device_id");
  await requireDeviceCredential(request, env, instanceID, deviceID, environment);
  enforceActorRateLimit(env, "/v2/test-start", `${instanceID}:${deviceID}`);
  return await sendTestStart(body, env, instanceID, environment, deviceID, "v2-test-start-request");
}

async function handleUnregisterV2(request, env) {
  ensureStorage(env);
  const body = await readJSON(request, env);
  requireInstanceIDVersion(body);
  const deviceID = requiredRoutingID(body, "device_id");
  const instanceID = requiredInstanceID(body);
  const environment = requiredMatchingAPNsEnvironment(body, env);
  enforceActorRateLimit(env, "/v2/unregister", `${instanceID}:${deviceID}`);
  const provided = requiredSecretHeaderValue(request, DEVICE_CREDENTIAL_HEADER, "device credential");
  const revoked = await callAuthState(env, instanceID, {
    action: "unregister_device",
    device_id: deviceID,
    environment,
    provided_credential_hash: await sha256Hex(provided),
    now: new Date().toISOString(),
  });

  const deleted = await deleteDeviceRecords(env, environment, instanceID, deviceID);
  logRelay("v2-unregister", {
    device_id: logID(deviceID),
    home_assistant_instance_id: logInstanceID(instanceID),
    environment,
    deleted_records: deleted.total,
  });
  return jsonResponse({
    ok: true,
    unregistered: true,
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    apns_environment: environment,
    deleted,
    auth_generation: revoked.generation,
    auth_protocol: "v2",
  });
}

async function handleActivityRetireV2(request, env) {
  ensureStorage(env);
  const body = await readJSON(request, env);
  const scope = activityRetireScope(body, env);
  await requireDeviceCredential(request, env, scope.instanceID, scope.deviceID, scope.environment);
  enforceActorRateLimit(
    env,
    "/v2/activity-retire",
    `${scope.instanceID}:${scope.deviceID}:${scope.activityID}`
  );
  return await retireActivityRoute(env, scope, "v2");
}

async function handleActivityRetire(request, env) {
  ensureStorage(env);
  const body = await readJSON(request, env);
  const scope = activityRetireScope(body, env);
  await requireLegacyDeviceMutationAllowed(env, scope.environment, scope.instanceID, scope.deviceID);
  enforceActorRateLimit(
    env,
    "/activity-retire",
    `${scope.instanceID}:${scope.deviceID}:${scope.activityID}`
  );
  return await retireActivityRoute(env, scope, "v1");
}

function activityRetireScope(body, env) {
  requireInstanceIDVersion(body);
  return {
    deviceID: requiredRoutingID(body, "device_id"),
    instanceID: requiredInstanceID(body),
    environment: requiredMatchingAPNsEnvironment(body, env),
    activityID: requiredActivityRoutingID(body),
    reason: normalizedRetireReason(body.activity_state),
  };
}

function normalizedRetireReason(value) {
  const normalized = stringValue(value)?.toLowerCase();
  return normalized === "dismissed" || normalized === "ended" ? normalized : "ended";
}

// A Live Activity that the user dismissed, or that the app ended locally, keeps an
// update token APNs still accepts with HTTP 200. Delivery therefore looks successful
// while nothing is displayed. Only the device observes that terminal state, so it
// reports the retirement here and the route is neutralized exactly like /end does.
async function retireActivityRoute(env, scope, authProtocol) {
  const { deviceID, instanceID, environment, activityID, reason } = scope;
  const activities = await resolveActivityRecords(
    env,
    environment,
    instanceID,
    activityID,
    deviceID
  );
  logRelay("activity-retire-request", {
    activity_id: activityID,
    home_assistant_instance_id: logInstanceID(instanceID),
    device_id: logID(deviceID),
    environment,
    auth_protocol: authProtocol,
    retire_reason: reason,
    matched_activities: activities.length,
  });

  if (activities.length === 0) {
    return jsonResponse({
      ok: true,
      retired: 0,
      matched_activities: 0,
      already_retired: true,
      activity_id: activityID,
      retire_reason: reason,
      auth_protocol: authProtocol,
    });
  }

  // The route must be cleared while it still points at this exact generation: that
  // is what releases the entity route and its display-name claim. Marking the
  // generation stale first would break the exact match and silently leave the name
  // claimed, so the next Set for the same name would be rejected as a duplicate.
  const routeClears = await Promise.all(activities.map((activity) => (
    clearActivityRouteState(env, environment, instanceID, activity)
  )));

  // Clearing the route only releases the display name when the route still points at
  // this exact generation, which is not guaranteed for an activity the device is
  // retiring. Release the name by exact identity as well, so the next Set may reuse it.
  const claimRetirements = await Promise.all(activities.map(async (activity) => {
    try {
      const released = await callAuthState(env, instanceID, {
        action: "retire_activity_display_claims",
        environment,
        device_id: activity.device_id,
        activity_id: activityID,
      });
      return released?.retired_display_claims || 0;
    } catch (error) {
      logRelay("activity-display-claim-retire-failed", {
        home_assistant_instance_id: logInstanceID(instanceID),
        error: error.code || "auth_state_unavailable",
      });
      return 0;
    }
  }));

  const neutralizations = await Promise.all(activities.map((activity) => (
    markActivityGenerationStale(env, environment, instanceID, activity)
  )));
  if (neutralizations.some((result) => !result.marked)) {
    return jsonResponse({
      ok: false,
      error: "activity_retire_retry_required",
      message: "A newer Live Activity registration appeared while the retirement was running. Retry to target the current registration safely.",
      activity_id: activityID,
    }, 409);
  }
  // Retirement is the device asserting the activity no longer exists. Marking the
  // generation stale alone leaves stored records and the compatibility mirror
  // readable, and the duplicate-display-name inventory would then reject the next
  // Set for the same name. Sweep every stored record for the retired devices.
  const retiredDeviceIDs = [...new Set(activities.map((activity) => activity.device_id))];
  const sweepPrefixes = [
    activityPrefix(environment, instanceID, activityID),
    activityStatePrefix(environment, instanceID, activityID),
    `activity-generation:${environment}:${instanceID}:${activityID}:device_`,
  ];
  const sweeps = (await Promise.all(
    sweepPrefixes.map((prefix) => listJSONEntries(env.TOKENS, prefix))
  )).flat();
  await Promise.all([
    ...retiredDeviceIDs.map((retiredDeviceID) => deleteKV(
      env.TOKENS,
      pendingStartKey(environment, instanceID, activityID, retiredDeviceID)
    )),
    ...sweeps
      .filter(({ key }) => retiredDeviceIDs.some((retiredDeviceID) => (
        key.includes(`device_${retiredDeviceID}`)
      )))
      .map(({ key }) => deleteKV(env.TOKENS, key)),
  ]);

  const remaining = await resolveActivityRecords(
    env,
    environment,
    instanceID,
    activityID,
    deviceID
  );
  const retiredDevices = new Set(activities.map((activity) => activity.device_id));
  if (remaining.some((activity) => retiredDevices.has(activity.device_id))) {
    return jsonResponse({
      ok: false,
      error: "activity_retire_retry_required",
      message: "A newer Live Activity registration appeared while the retirement was running. Retry to target the current registration safely.",
      activity_id: activityID,
    }, 409);
  }

  return jsonResponse({
    ok: true,
    retired: activities.length,
    matched_activities: activities.length,
    activity_id: activityID,
    retire_reason: reason,
    auth_protocol: authProtocol,
    cleared_routes: routeClears.filter((result) => result?.cleared).length,
    retired_display_claims: claimRetirements.reduce((total, count) => total + count, 0),
  });
}

async function handleActivityToken(request, env) {
  const body = await readJSON(request, env);
  const scope = activityTokenScope(body, env);
  ensureStorage(env);
  const auth = await requireLegacyDeviceMutationAllowed(env, scope.environment, scope.instanceID, scope.deviceID);
  scope.authGeneration = auth.generation ?? 0;
  enforceActorRateLimit(env, "/activity-token", `${scope.instanceID}:${scope.deviceID}:${scope.activityID}`);
  return await storeActivityToken(body, env, scope, "v1");
}

function activityTokenScope(body, env) {
  validateActivityTokenPayload(body);
  requireInstanceIDVersion(body);
  return {
    deviceID: requiredRoutingID(body, "device_id"),
    instanceID: requiredInstanceID(body),
    environment: requiredMatchingAPNsEnvironment(body, env),
    activityID: requiredActivityRoutingID(body),
    token: requiredToken(body, "update_token"),
  };
}

async function storeActivityToken(body, env, scope, authProtocol) {
  const { deviceID, instanceID, environment, activityID, token } = scope;
  const authorityEnabled = await ensureActivityGenerationAuthority(env, instanceID);
  const activityRegistrationGeneration = authorityEnabled
    ? newActivityRegistrationGeneration()
    : null;
  await enforceActivityQuota(env, environment, instanceID, deviceID, activityID);
  const storageKey = activityKey(environment, instanceID, activityID, deviceID);
  const existing = await getJSON(env.TOKENS, storageKey);
  const pending = await getJSON(env.TOKENS, pendingStartKey(environment, instanceID, activityID, deviceID));
  const nowMs = Date.now();
  const authoritativeCurrent = authorityEnabled
    ? await callAuthState(env, instanceID, {
      action: "current_activity_registrations",
      environment,
      device_id: deviceID,
      activity_id: activityID,
      now_ms: nowMs,
    })
    : null;
  const authoritativePointer = authoritativeCurrent?.activities?.[0] || null;
  const existingIsAuthoritative = Boolean(
    existing
    && authoritativePointer
    && authoritativePointer.status === "active"
    && existing.activity_registration_generation
      === authoritativePointer.activity_registration_generation
  );
  const contentState = contentStateFromRegisteredActivity(body) || normalizeStoredContentState(pending?.last_content_state);
  const metadata = activityMetadataFromState(contentState, stringValue(body.display_name) || pending?.display_name);
  const displayNameHash = metadata.display_name_key
    ? await sha256Hex(metadata.display_name_key)
    : null;
  const pendingStartAttributes = normalizeStoredStartAttributes(pending?.start_attributes, {
    activityID,
    instanceID,
    entityID: contentState?.entityId,
  });
  const existingStartAttributes = existingIsAuthoritative
    ? normalizeStoredStartAttributes(existing?.start_attributes, {
      activityID,
      instanceID,
      entityID: contentState?.entityId,
    })
    : null;
  const retainedStartAttributes = pendingStartAttributes || existingStartAttributes;
  const retainedStartAttributesHash = retainedStartAttributes
    ? await sha256Hex(JSON.stringify(retainedStartAttributes))
    : null;
  const now = new Date(nowMs).toISOString();
  let activationRouteEpoch = null;

  const record = {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: INSTANCE_ID_VERSION,
    activity_id: activityID,
    activity_kit_id: stringValue(body.activity_kit_id),
    update_token: token,
    bundle_id: stringValue(body.bundle_id),
    app_version: stringValue(body.app_version),
    apns_environment: environment,
    apns_mode: environment,
    auth_protocol: authProtocol,
    auth_generation: scope.authGeneration ?? 0,
    ...(activityRegistrationGeneration
      ? { activity_registration_generation: activityRegistrationGeneration }
      : {}),
    retention_policy_version: TOKEN_RETENTION_POLICY_VERSION,
    ...metadata,
    ...(retainedStartAttributes ? { start_attributes: retainedStartAttributes } : {}),
    created_at: serverRecordProofTimestamp(existing) || now,
    updated_at: now,
  };

  const ttlSeconds = activityTTLSeconds(env);
  if (authorityEnabled) {
    await putJSONWithTTL(
      env.TOKENS,
      activityGenerationKey(
        environment,
        instanceID,
        activityID,
        deviceID,
        activityRegistrationGeneration
      ),
      record,
      ttlSeconds
    );
    if (contentState) {
      await putActivityGenerationState(
        env,
        environment,
        instanceID,
        activityID,
        deviceID,
        activityRegistrationGeneration,
        contentState
      );
    }
    let activation;
    try {
      activation = await callAuthState(env, instanceID, {
        action: "activate_activity_registration",
        environment,
        device_id: deviceID,
        activity_id: activityID,
        activity_registration_generation: activityRegistrationGeneration,
        auth_protocol: authProtocol,
        auth_generation: scope.authGeneration ?? 0,
        ...(contentState?.entityId ? { entity_id: contentState.entityId } : {}),
        ...(retainedStartAttributesHash
          ? { start_attributes_hash: retainedStartAttributesHash }
          : {}),
        ...(displayNameHash ? { display_name_hash: displayNameHash } : {}),
        ...(record.activity_kit_id ? { activity_kit_id: record.activity_kit_id } : {}),
        ...(stringValue(pending?.route_epoch)
          ? { route_epoch: pending.route_epoch }
          : {}),
        now_ms: nowMs,
        expires_at_ms: nowMs + ttlSeconds * 1000,
      });
    } catch (error) {
      // The Durable Object transaction may have committed even when its
      // response was lost. Retain the exact generation payload so an
      // authoritative pointer can always be resolved; only an explicit
      // activated:false response below is safe to delete.
      throw error;
    }
    if (activation?.activated !== true) {
      await Promise.all([
        deleteKV(env.TOKENS, activityGenerationKey(
          environment,
          instanceID,
          activityID,
          deviceID,
          activityRegistrationGeneration
        )),
        deleteKV(env.TOKENS, activityGenerationStateKey(
          environment,
          instanceID,
          activityID,
          deviceID,
          activityRegistrationGeneration
        )),
      ]);
      throw httpError(
        409,
        activation?.error || "obsolete_activity_registration",
        "This Live Activity registration no longer owns the entity route."
      );
    }
    activationRouteEpoch = stringValue(activation.route_epoch) || null;
  }
  await putJSONWithTTL(env.TOKENS, storageKey, record, ttlSeconds);
  if (contentState) {
    await putActivityState(
      env,
      environment,
      instanceID,
      activityID,
      deviceID,
      contentState
    );
  }
  const acceptedPending = !pending
    || !pending.route_epoch
    || pending.route_epoch === activationRouteEpoch;
  if (acceptedPending) {
    await deleteKV(env.TOKENS, pendingStartKey(environment, instanceID, activityID, deviceID));
  }
  // A pending record that was refreshed by a Set during the registration window
  // carries newer content than the just-started activity is showing. The update
  // token is now in hand, so deliver that newest state once. A failure here is
  // non-fatal: the record already stores the refreshed state and the next Set
  // updates normally.
  if (acceptedPending && pending?.content_refreshed_at) {
    const refreshedState = normalizeStoredContentState(pending.last_content_state);
    if (refreshedState) {
      try {
        const flush = await sendAPNs(
          env,
          token,
          updateOrEndPayload({}, "update", refreshedState),
          "update",
          deviceID
        );
        logRelay("pending-content-flush", {
          activity_id: activityID,
          device_id: logID(deviceID),
          home_assistant_instance_id: logInstanceID(instanceID),
          environment,
          delivered: flush.ok === true,
        });
      } catch (error) {
        logRelay("pending-content-flush-failed", {
          activity_id: activityID,
          device_id: logID(deviceID),
          home_assistant_instance_id: logInstanceID(instanceID),
          environment,
          error: error.code || "apns_error",
        });
      }
    }
  }
  logRelay("activity-token", {
    activity_id: activityID,
    device_id: logID(deviceID),
    home_assistant_instance_id: logInstanceID(instanceID),
    environment,
    bundle_id: record.bundle_id,
  });
  return jsonResponse({
    ok: true,
    activity_id: activityID,
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    token: redactToken(token),
    apns_environment: apnsEnvironment(env),
    auth_protocol: authProtocol,
  });
}

async function handleStart(request, env) {
  ensureAPNs(env);
  ensureStorage(env);
  const body = await readJSON(request, env);
  validateLiveActivityPayload(body);
  const requestedActivityID = requiredActivityRoutingID(body);
  const instanceID = requiredInstanceID(body);
  const environment = requiredMatchingAPNsEnvironment(body, env);
  const deviceID = optionalRoutingID(body, "device_id");
  await requireHARelaySecret(request, env, instanceID);
  enforceActorRateLimit(env, "/start", `${instanceID}:${deviceID || "broadcast"}`);

  const initialState = contentStateFromHA(body);
  const authenticatedOperation = request.headers.get(OPERATION_HEADER) === ENTITY_SET_OPERATION;
  const entitySetRequest = isEntityBackedSetRequest(
    body,
    initialState,
    authenticatedOperation
  );
  const duplicateConflict = await duplicateDisplayNameConflict(env, {
    environment,
    instanceID,
    activityID: requestedActivityID,
    deviceID,
    requestedState: initialState,
    ignoredEntityID: entitySetRequest ? initialState.entityId : null,
  });
  if (duplicateConflict) {
    logRelay("duplicate-display-name-reject", {
      activity_id: requestedActivityID,
      home_assistant_instance_id: logInstanceID(instanceID),
      device_id: deviceID ? logID(deviceID) : "instance-broadcast",
      active_conflicts: duplicateConflict.activeConflicts,
      pending_conflicts: duplicateConflict.pendingConflicts,
      cleaned_stale_activities: duplicateConflict.cleanedStaleActivities,
    });
    return jsonResponse({
      ok: false,
      error: "duplicate_activity_name",
      message: DUPLICATE_ACTIVITY_NAME_MESSAGE,
      active_conflicts: duplicateConflict.activeConflicts,
      pending_conflicts: duplicateConflict.pendingConflicts,
      cleaned_stale_activities: duplicateConflict.cleanedStaleActivities,
    }, 409);
  }

  let reservation = null;
  let reservationCommitted = false;
  let reservationUncertain = false;
  let reservationDeviceOutcomes = null;
  let displayClaim = null;
  let displayClaimCommitted = false;
  let displayClaimUncertain = false;
  const ownedPendingStarts = [];
  try {
    let entityRoute = await resolveEntityBackedSetRoute(env, {
      body,
      environment,
      instanceID,
      requestedActivityID,
      deviceID,
      requestedState: initialState,
      authenticatedOperation,
      planOnly: entitySetRequest,
    });
    let routeError = entityRouteErrorResponse(entityRoute, requestedActivityID);
    if (routeError) return routeError;

    const devices = await resolveDeviceRecords(env, environment, instanceID, deviceID);
    let activities = await resolveActivityRecords(
      env,
      environment,
      instanceID,
      requestedActivityID,
      deviceID
    );
    const preflightUncoveredDeviceExists = devices.some((device) => (
      !entityRoute.coveredDeviceIDs.includes(device.device_id)
    ));
    if (
      entityRoute.hasExistingRoute
      && !entityRoute.attributesVerified
      && preflightUncoveredDeviceExists
    ) {
      return activityRestartRequiredResponse(entityRoute.activityID);
    }
    if (devices.length === 0 && activities.length === 0) {
      throw httpError(404, "no_registered_devices", "No registered push-to-start tokens matched this request.");
    }

    if (entitySetRequest && await ensureActivityGenerationAuthority(env, instanceID)) {
      const initialSnapshot = await entitySetActivitySnapshot(
        env,
        environment,
        instanceID,
        deviceID,
        initialState.entityId,
        requestedActivityID
      );
      const reservationStartAttributes = entityRoute.startAttributes || attributesFromHA(body);
      const reservationDisplayNameKey = normalizedDisplayNameKey(
        displayNameFromState(initialState)
      );
      const reservationResult = await beginEntitySetReservation(env, {
        environment,
        instanceID,
        deviceID,
        entityID: initialState.entityId,
        activitySnapshot: initialSnapshot,
        canonicalActivityID: requestedActivityID,
        startAttributesHash: await sha256Hex(JSON.stringify(reservationStartAttributes)),
        displayNameHash: reservationDisplayNameKey
          ? await sha256Hex(reservationDisplayNameKey)
          : null,
        intentDeviceIDs: [...new Set([
          ...devices.map((device) => device.device_id),
          ...initialSnapshot.map((activity) => activity.device_id),
        ])],
      });
      if (reservationResult?.alreadyStarting) {
        return jsonResponse({
          ok: true,
          action: "start",
          matched_devices: devices.length,
          matched_activities: activities.length,
          updated_existing: 0,
          started: 0,
          reused_pending: 0,
          reused_persistent_intent: reservationResult.matchedDevices,
          delivered: 0,
          attempted: 0,
          reused_entity_activity_ids: [],
          immutable_attributes_verified: true,
          delivery_state: "awaiting_activity_registration",
        });
      }
      reservation = reservationResult;
      if (!reservation) return entitySetReservationRetryResponse(requestedActivityID);

      // Re-plan only after the fence is held. This prevents a stale plan from
      // choosing which exact registration generations may be ended.
      entityRoute = await resolveEntityBackedSetRoute(env, {
        body,
        environment,
        instanceID,
        requestedActivityID,
        deviceID,
        requestedState: initialState,
        authenticatedOperation,
        planOnly: true,
      });
      routeError = entityRouteErrorResponse(entityRoute, requestedActivityID);
      if (routeError) return routeError;

      const fencedDuplicate = await duplicateDisplayNameConflict(env, {
        environment,
        instanceID,
        activityID: requestedActivityID,
        deviceID,
        requestedState: initialState,
        ignoredEntityID: initialState.entityId,
      });
      if (fencedDuplicate) {
        return duplicateDisplayNameConflictResponse(fencedDuplicate);
      }

      if (entityRoute.reconciliationRequired) {
        const reconciliation = await reconcileEntityBackedSetActivities(env, {
          body,
          environment,
          instanceID,
          requestedActivityID,
          requestedState: initialState,
          activities: entityRoute.reconciliationTargets,
          reservation,
        });
        if (reconciliation.error) {
          return entityRouteErrorResponse({ ...entityRoute, ...reconciliation }, requestedActivityID);
        }
        entityRoute = await resolveEntityBackedSetRoute(env, {
          body,
          environment,
          instanceID,
          requestedActivityID,
          deviceID,
          requestedState: initialState,
          reconciliationAttempted: true,
          authenticatedOperation,
          planOnly: true,
        });
        routeError = entityRouteErrorResponse(entityRoute, requestedActivityID);
        if (routeError) return routeError;
      }

      if (!await claimEntitySetReservation(env, instanceID, reservation, await entitySetActivitySnapshot(
        env,
        environment,
        instanceID,
        deviceID,
        initialState.entityId,
        requestedActivityID
      ))) {
        return entitySetReservationRetryResponse(requestedActivityID);
      }
      activities = await resolveActivityRecords(
        env,
        environment,
        instanceID,
        requestedActivityID,
        deviceID
      );
    }

    const activityID = entityRoute.activityID;
    const requestedState = initialState;
    const uncoveredDeviceExists = devices.some((device) => (
      !entityRoute.coveredDeviceIDs.includes(device.device_id)
    ));
    if (
      entityRoute.hasExistingRoute
      && !entityRoute.attributesVerified
      && uncoveredDeviceExists
    ) {
      return activityRestartRequiredResponse(activityID);
    }
    if (!reservation) {
      const pendingIntentConflict = await rawStartPendingIntentConflict(env, {
        environment,
        instanceID,
        activityID,
        devices,
        body,
        requestedState,
      });
      if (pendingIntentConflict) {
        return jsonResponse({
          ok: false,
          error: "pending_activity_intent_conflict",
          message: "A pending Live Activity Start already owns this activity ID with different entity, display-name, or immutable attributes.",
          activity_id: activityID,
        }, 409);
      }
    }
    logRelay("start-request", {
      activity_id: activityID,
      home_assistant_instance_id: logInstanceID(instanceID),
      device_id: deviceID ? logID(deviceID) : "instance-broadcast",
      environment,
      matched_devices: devices.length,
      matched_activities: activities.length,
    });

    if (reservation && !await validateEntitySetReservation(env, instanceID, reservation)) {
      return entitySetReservationRetryResponse(requestedActivityID);
    }
    if (
      !reservation
      && requestedState.entityId
      && await ensureActivityGenerationAuthority(env, instanceID)
    ) {
      const displayNameKey = normalizedDisplayNameKey(displayNameFromState(requestedState));
      const claimDeviceIDs = [...new Set([
        ...devices.map((device) => device.device_id),
        ...activities.map((activity) => activity.device_id),
      ])];
      const authoritativeEntityIDs = [...new Set((await Promise.all(
        activities.map((activity) => entityIDForActivityRecord(
          env,
          environment,
          instanceID,
          activity
        ))
      )).filter(validHomeAssistantEntityID))];
      if (authoritativeEntityIDs.length > 1) {
        return activityUpdateRetryResponse(activityID);
      }
      const claimEntityID = authoritativeEntityIDs[0] || requestedState.entityId;
      if (displayNameKey && claimDeviceIDs.length > 0) {
        displayClaim = await claimActivityDisplayNames(env, instanceID, {
          environment,
          entityID: claimEntityID,
          activityID,
          displayNameHash: await sha256Hex(displayNameKey),
          deviceIDs: claimDeviceIDs,
        });
        if (!displayClaim.claimed) {
          return activityDisplayClaimConflictResponse(displayClaim);
        }
      }
    }
    const updatePayload = updateOrEndPayload(body, "update", requestedState);
    const updateResults = await Promise.all(
      activities.map(async (activity) => ({
        activity,
        result: await sendAPNs(
          env,
          activity.update_token,
          updatePayload,
          "update",
          activity.device_id,
          reservation ? { beforeTransport: () => prepareEntitySetTransport(
            env,
            instanceID,
            reservation,
            activity.device_id
          ) } : undefined
        ),
      }))
    );
    const staleActivityResults = updateResults.filter(({ result }) => isStaleAPNsActivity(result));
    const staleNeutralizations = await Promise.all(staleActivityResults.map(({ activity }) => (
      markActivityGenerationStale(
        env,
        environment,
        instanceID,
        activity,
        reservation
      )
    )));
    if (staleNeutralizations.some((result) => !result.marked)) {
      return activityUpdateRetryResponse(activityID);
    }
    if (staleActivityResults.length > 0) {
      const staleDevices = new Set(staleActivityResults.map(({ activity }) => activity.device_id));
      const remaining = await resolveActivityRecords(
        env,
        environment,
        instanceID,
        activityID,
        deviceID
      );
      if (remaining.some((activity) => staleDevices.has(activity.device_id))) {
        return activityUpdateRetryResponse(activityID);
      }
      if (reservation && !await claimEntitySetReservation(
        env,
        instanceID,
        reservation,
        await entitySetActivitySnapshot(
          env,
          environment,
          instanceID,
          deviceID,
          initialState.entityId,
          requestedActivityID
        )
      )) {
        return entitySetReservationRetryResponse(requestedActivityID);
      }
    }
    const persistedUpdates = await Promise.all(
      updateResults
        .filter(({ result }) => result.ok)
        .map(({ activity }) => persistActivityGenerationUpdate(
          env,
          environment,
          instanceID,
          activity,
          requestedState,
          reservation,
          displayClaim
        ))
    );
    if (persistedUpdates.some((persisted) => !persisted)) {
      if (displayClaim) displayClaimUncertain = true;
      return activityUpdateRetryResponse(activityID);
    }

    const updateDeviceIDs = new Set(
      updateResults
        .filter(({ result }) => !isStaleAPNsActivity(result))
        .map(({ activity }) => activity.device_id)
    );
    const retryStartDeviceIDs = new Set(staleActivityResults.map(({ activity }) => activity.device_id));
    const persistentStartingDeviceIDs = new Set(
      reservation?.reusedStartingDeviceIDs || []
    );
    const startCandidates = devices.filter((device) => (
      !updateDeviceIDs.has(device.device_id)
      && !persistentStartingDeviceIDs.has(device.device_id)
    ));
    const pendingDevices = [];
    const startDevices = [];
    for (const device of startCandidates) {
      const pendingKey = pendingStartKey(environment, instanceID, activityID, device.device_id);
      const pending = await getJSON(env.TOKENS, pendingKey);
      if (pending && !retryStartDeviceIDs.has(device.device_id)) {
        if (
          reservation
          && pending.request_owner_nonce
          && pending.delivery_state !== "sent"
        ) {
          return entitySetReservationRetryResponse(requestedActivityID);
        }
        pendingDevices.push(device);
        continue;
      }
      startDevices.push(device);
    }

    if (
      entityRoute.hasExistingRoute
      && !entityRoute.attributesVerified
      && startDevices.length > 0
    ) {
      return activityRestartRequiredResponse(activityID);
    }
    if (reservation && !await validateEntitySetReservation(env, instanceID, reservation)) {
      return entitySetReservationRetryResponse(requestedActivityID);
    }

    const effectiveStartAttributes = entityRoute.startAttributes || attributesFromHA(body);
    const pendingOwnerNonce = reservation?.ownerNonce || `ps_${randomBase64URLToken(18)}`;
    await Promise.all(
      startDevices.map(async (device) => {
        const key = pendingStartKey(environment, instanceID, activityID, device.device_id);
        ownedPendingStarts.push({ key, ownerNonce: pendingOwnerNonce });
        await env.TOKENS.put(
          key,
          JSON.stringify({
          device_id: device.device_id,
          home_assistant_instance_id: instanceID,
          instance_id_version: INSTANCE_ID_VERSION,
          activity_id: activityID,
          apns_environment: environment,
          auth_protocol: device.auth_protocol || "v1",
          auth_generation: device.auth_generation ?? 0,
          retention_policy_version: TOKEN_RETENTION_POLICY_VERSION,
          request_owner_nonce: pendingOwnerNonce,
          delivery_state: "prepared",
          ...(reservation ? { route_epoch: reservation.version } : {}),
          ...activityMetadataFromState(requestedState),
          start_attributes: effectiveStartAttributes,
          last_content_state: requestedState,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          }),
          { expirationTtl: pendingStartTTLSeconds(env) }
        );
      })
    );

    const startPayloadBody = startPayload(body, env, requestedState, effectiveStartAttributes);
    const startResults = await Promise.all(
      startDevices.map(async (device) => ({
        device,
        result: await sendAPNs(
          env,
          device.push_to_start_token,
          startPayloadBody,
          "start",
          device.device_id,
          { beforeTransport: async () => {
            if (reservation) {
              await prepareEntitySetTransport(
                env,
                instanceID,
                reservation,
                device.device_id
              );
            }
            await markOwnedPendingStartSent(
              env,
              pendingStartKey(environment, instanceID, activityID, device.device_id),
              pendingOwnerNonce
            );
          } }
        ),
      }))
    );
    await Promise.all(startResults.map(async ({ device, result }) => {
      const key = pendingStartKey(environment, instanceID, activityID, device.device_id);
      if (!result.ok) {
        await deleteOwnedPendingStart(env, key, pendingOwnerNonce);
      }
    }));
    reservationUncertain = Boolean(reservation && [...updateResults, ...startResults].some(
      ({ result }) => result.ok || result.delivery_uncertain === true
    ));
    if (reservation) {
      const outcomes = new Map();
      for (const { activity, result } of updateResults) {
        outcomes.set(
          activity.device_id,
          result.ok ? "commit" : result.delivery_uncertain === true ? "uncertain" : "abort"
        );
      }
      for (const { device, result } of startResults) {
        outcomes.set(
          device.device_id,
          result.ok ? "commit" : result.delivery_uncertain === true ? "uncertain" : "abort"
        );
      }
      reservationDeviceOutcomes = [...outcomes].map(([outcomeDeviceID, outcome]) => ({
        device_id: outcomeDeviceID,
        outcome,
      }));
    }
    displayClaimUncertain = Boolean(
      displayClaim
      && [...updateResults, ...startResults].some(({ result }) => (
        result.ok || result.delivery_uncertain === true
      ))
    );

    // A Set that lands while the start is still pending used to be accepted and
    // silently dropped: the pending record kept its original content, and the
    // eventual token registration rendered that stale state. Refresh only the
    // content/display fields of each reused pending record so no Set is lost.
    // Entity binding, start attributes, auth fields, owner nonce and delivery
    // state are retained byte-for-byte, and a changed entity binding skips the
    // refresh entirely.
    if (pendingDevices.length > 0) {
      const pendingTTL = pendingStartTTLSeconds(env);
      await Promise.all(pendingDevices.map(async (device) => {
        const key = pendingStartKey(environment, instanceID, activityID, device.device_id);
        const record = await getJSON(env.TOKENS, key);
        if (!record || record.activity_id !== activityID) return;
        const oldEntityID = normalizeStoredContentState(record.last_content_state)?.entityId;
        if (oldEntityID && requestedState.entityId && oldEntityID !== requestedState.entityId) return;
        const createdAtMs = Date.parse(record.created_at || "") || Date.now();
        const remaining = Math.floor((createdAtMs + pendingTTL * 1000 - Date.now()) / 1000);
        if (remaining < 60) return;
        await env.TOKENS.put(key, JSON.stringify({
          ...record,
          last_content_state: {
            ...requestedState,
            ...(oldEntityID ? { entityId: oldEntityID } : {}),
          },
          content_refreshed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }), { expirationTtl: remaining });
      }));
    }

    const results = [
      ...updateResults
        .filter(({ result }) => !isStaleAPNsActivity(result))
        .map(({ result }) => result),
      ...startResults.map(({ result }) => result),
    ];
    const response = results.length === 0 && pendingDevices.length > 0
      ? jsonResponse({
        ok: true,
        action: "start",
        matched_devices: devices.length,
        matched_activities: activities.length,
        updated_existing: 0,
        started: 0,
        reused_pending: pendingDevices.length,
        reused_persistent_intent: persistentStartingDeviceIDs.size,
        delivered: 0,
        attempted: 0,
        reused_entity_activity_ids: entityRoute.reusedActivityIDs,
        immutable_attributes_verified: entityRoute.attributesVerified,
        ...(entityRoute.legacyUnknownRoute ? {
          immutable_attributes_status: "legacy_unknown_preserved",
          immutable_attributes_applied: false,
        } : {}),
      })
      : relayResultsResponse("start", results, {
        matched_devices: devices.length,
        matched_activities: activities.length,
        updated_existing: updateResults.length - staleActivityResults.length,
        started: startResults.length,
        reused_pending: pendingDevices.length,
        reused_persistent_intent: persistentStartingDeviceIDs.size,
        reused_entity_activity_ids: entityRoute.reusedActivityIDs,
        immutable_attributes_verified: entityRoute.attributesVerified,
        ...(entityRoute.legacyUnknownRoute ? {
          immutable_attributes_status: "legacy_unknown_preserved",
          immutable_attributes_applied: false,
        } : {}),
      });

    if (reservation && startResults.some(({ result }) => result.reservation_conflict)) {
      return entitySetReservationRetryResponse(requestedActivityID);
    }
    if (reservation && startResults.some(({ result }) => !result.ok)) {
      return response;
    }
    if (reservation && results.some((result) => !result.ok)) {
      return response;
    }

    if (displayClaim) {
      if (results.some((result) => !result.ok)) {
        displayClaimUncertain = displayClaimUncertain
          || results.some((result) => result.delivery_uncertain === true);
        return response;
      }
      displayClaimCommitted = await commitActivityDisplayNames(
        env,
        instanceID,
        displayClaim
      );
      if (!displayClaimCommitted) {
        return jsonResponse({
          ok: false,
          error: "activity_display_claim_retry_required",
          message: "The Live Activity display name changed while Start was running. Retry Start safely.",
        }, 409);
      }
    }

    if (reservation) {
      reservationCommitted = await commitEntitySetReservation(env, instanceID, reservation);
      if (!reservationCommitted) {
        return entitySetReservationRetryResponse(requestedActivityID);
      }
    }
    return response;
  } finally {
    await Promise.all(ownedPendingStarts.map(({ key, ownerNonce }) => (
      deleteOwnedPendingStart(env, key, ownerNonce, { preparedOnly: true })
    )));
    if (reservation && !reservationCommitted) {
      await releaseEntitySetReservation(env, instanceID, reservation, {
        uncertain: reservationUncertain,
        deviceOutcomes: reservationDeviceOutcomes,
      });
    }
    if (displayClaim?.claimed && !displayClaimCommitted) {
      await releaseActivityDisplayNames(env, instanceID, displayClaim, {
        uncertain: displayClaimUncertain,
      });
    }
  }
}

async function rawStartPendingIntentConflict(env, {
  environment,
  instanceID,
  activityID,
  devices,
  body,
  requestedState,
}) {
  const requestedEntityID = requestedState?.entityId || null;
  const requestedDisplayNameKey = normalizedDisplayNameKey(
    displayNameFromState(requestedState)
  );
  const requestedAttributes = attributesFromHA(body);
  for (const device of devices) {
    const pending = await getJSON(
      env.TOKENS,
      pendingStartKey(environment, instanceID, activityID, device.device_id)
    );
    if (!pending) continue;
    const pendingState = normalizeStoredContentState(pending.last_content_state);
    const pendingEntityID = entityIDFromRecord(pending);
    const pendingDisplayNameKey = normalizedDisplayNameKey(
      stringValue(pending.display_name) || displayNameFromState(pendingState)
    );
    const pendingAttributes = normalizeStoredStartAttributes(pending.start_attributes, {
      activityID,
      instanceID,
      entityID: pendingEntityID || undefined,
    });
    if (
      pendingEntityID !== requestedEntityID
      || pendingDisplayNameKey !== requestedDisplayNameKey
      || !pendingAttributes
      || !sameStartAttributes(pendingAttributes, requestedAttributes)
    ) return true;
  }
  return false;
}

function entityRouteErrorResponse(entityRoute, requestedActivityID) {
  if (!entityRoute?.error) return null;
  if (entityRoute.error === "ambiguous_entity_activity") {
    return jsonResponse({
      ok: false,
      error: entityRoute.error,
      message: "Multiple activity IDs already represent this entity. End the extra activities before retrying.",
      activity_ids: entityRoute.activityIDs,
    }, 409);
  }
  if (entityRoute.error === "immutable_activity_attributes_changed") {
    return jsonResponse({
      ok: false,
      error: entityRoute.error,
      message: "Live Activity controls and other start attributes cannot change in place; end and restart the activity.",
      activity_id: entityRoute.activityID,
    }, 409);
  }
  if (entityRoute.error === "activity_restart_identity_required") {
    return jsonResponse({
      ok: false,
      error: entityRoute.error,
      message: "The existing Live Activity has no verifiable ActivityKit identity, so an automatic same-ID restart would be unsafe. End the old activity and retry, or choose a new activity ID.",
      activity_id: entityRoute.activityID,
    }, 409);
  }
  if (entityRoute.error === "activity_restart_required") {
    return activityRestartRequiredResponse(entityRoute.activityID);
  }
  if (entityRoute.error === "entity_activity_id_changed") {
    return jsonResponse({
      ok: false,
      error: entityRoute.error,
      message: "This entity already has a Live Activity under a different activity ID. End the existing activity, then restart the entity with the new ID.",
      requested_activity_id: requestedActivityID,
      existing_activity_ids: entityRoute.activityIDs,
    }, 409);
  }
  if (entityRoute.error === "pending_entity_activity_id_changed") {
    return jsonResponse({
      ok: false,
      error: entityRoute.error,
      message: "A previous start for this entity is still pending. Open HA LiveKit on the target iPhone and wait for registration, then end the previous activity ID and retry; otherwise wait for the pending request to expire.",
      requested_activity_id: requestedActivityID,
      existing_activity_ids: entityRoute.activityIDs,
    }, 409);
  }
  if (
    entityRoute.error === "entity_activity_reconciliation_failed"
    || entityRoute.error === "entity_activity_reconciliation_retry_required"
  ) {
    return jsonResponse({
      ok: false,
      error: entityRoute.error,
      message: entityRoute.message,
      requested_activity_id: requestedActivityID,
      existing_activity_ids: entityRoute.activityIDs,
      attempted: entityRoute.attempted,
      failed: entityRoute.failed,
      results: entityRoute.results,
    }, entityRoute.status || 409);
  }
  return jsonResponse({ ok: false, error: entityRoute.error }, 409);
}

function duplicateDisplayNameConflictResponse(conflict) {
  return jsonResponse({
    ok: false,
    error: "duplicate_activity_name",
    message: DUPLICATE_ACTIVITY_NAME_MESSAGE,
    active_conflicts: conflict.activeConflicts,
    pending_conflicts: conflict.pendingConflicts,
    cleaned_stale_activities: conflict.cleanedStaleActivities,
  }, 409);
}

function activityDisplayClaimConflictResponse(claim) {
  if (claim?.reason === "prior_delivery_uncertain") {
    return jsonResponse({
      ok: false,
      error: "activity_delivery_uncertain",
      message: "A previous Live Activity delivery may still be in flight. Wait for its callback or retry after the uncertainty window expires.",
      ...(claim.retryAfterMs ? { retry_after_ms: claim.retryAfterMs } : {}),
    }, 409);
  }
  if (
    claim?.reason === "display_claim_busy"
    || claim?.reason === "entity_route_managed"
  ) {
    return jsonResponse({
      ok: false,
      error: "activity_display_claim_retry_required",
      message: "Another Live Activity display-name operation is still running. Retry shortly.",
      ...(claim.retryAfterMs ? { retry_after_ms: claim.retryAfterMs } : {}),
    }, 409);
  }
  return duplicateDisplayNameConflictResponse({
    activeConflicts: 1,
    pendingConflicts: 0,
    cleanedStaleActivities: 0,
  });
}

function activityUpdateRetryResponse(activityID) {
  return jsonResponse({
    ok: false,
    error: "activity_update_retry_required",
    message: "A newer Live Activity registration appeared while the existing registration was being checked. Retry the update safely.",
    activity_id: activityID,
  }, 409);
}

function entitySetReservationRetryResponse(activityID) {
  return jsonResponse({
    ok: false,
    error: "entity_activity_reconciliation_retry_required",
    message: "Another Set operation or Live Activity registration changed this entity. Retry Set safely.",
    requested_activity_id: activityID,
  }, 409);
}

async function entitySetActivitySnapshot(
  env,
  environment,
  instanceID,
  deviceID,
  entityID,
  requestedActivityID
) {
  const activities = await resolveActivityRecordsForInstance(
    env,
    environment,
    instanceID,
    deviceID
  );
  const snapshot = [];
  for (const activity of activities) {
    const activityEntityID = await entityIDForActivityRecord(
      env,
      environment,
      instanceID,
      activity
    );
    if (
      activityEntityID !== entityID
      && !(
        !activityEntityID
        && activity.activity_id === requestedActivityID
      )
    ) continue;
    if (!isActivityRegistrationGeneration(activity.activity_registration_generation)) {
      throw httpError(
        409,
        "entity_activity_reconciliation_retry_required",
        "The current Live Activity generation cannot be fenced safely. Retry Set."
      );
    }
    const startAttributes = objectValue(activity.start_attributes);
    const displayNameKey = stringValue(activity.display_name_key)
      || normalizedDisplayNameKey(activity.display_name);
    const authoritativeDisplayNameHash = stringValue(
      activity.authoritative_display_name_hash
    );
    snapshot.push({
      device_id: activity.device_id,
      activity_id: activity.activity_id,
      activity_registration_generation: activity.activity_registration_generation,
      entity_id: entityID,
      start_attributes_hash: Object.keys(startAttributes).length > 0
        ? await sha256Hex(JSON.stringify(startAttributes))
        : stringValue(activity.authoritative_start_attributes_hash) || null,
      display_name_hash: displayNameKey
        ? await sha256Hex(displayNameKey)
        : authoritativeDisplayNameHash || null,
      activity_kit_id: stringValue(activity.activity_kit_id) || null,
    });
  }
  return snapshot.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function beginEntitySetReservation(env, {
  environment,
  instanceID,
  deviceID,
  entityID,
  activitySnapshot,
  canonicalActivityID,
  startAttributesHash,
  displayNameHash,
  intentDeviceIDs,
}) {
  const nowMs = Date.now();
  const ownerNonce = `es_${randomBase64URLToken(18)}`;
  const operationEpoch = `set_${randomBase64URLToken(18)}`;
  const result = await callAuthState(env, instanceID, {
    action: "begin_entity_set_reservation",
    environment,
    entity_id: entityID,
    ...(deviceID ? { device_id: deviceID } : {}),
    owner_nonce: ownerNonce,
    operation_epoch: operationEpoch,
    canonical_activity_id: canonicalActivityID,
    start_attributes_hash: startAttributesHash,
    display_name_hash: displayNameHash || null,
    intent_device_ids: intentDeviceIDs,
    activity_snapshot: activitySnapshot,
    now_ms: nowMs,
    expires_at_ms: nowMs + ENTITY_SET_RESERVATION_TTL_MS,
    hard_deadline_ms: nowMs + ENTITY_SET_HARD_DEADLINE_MS,
    intent_expires_at_ms: nowMs + pendingStartTTLSeconds(env) * 1000,
    route_expires_at_ms: nowMs + activityTTLSeconds(env) * 1000,
  });
  if (!result.acquired) {
    if (result.reason === "entity_route_already_starting") {
      return {
        alreadyStarting: true,
        matchedDevices: Number.isInteger(result.matched_devices)
          ? result.matched_devices
          : intentDeviceIDs.length,
      };
    }
    if (result.reason === "entity_route_history_capacity") {
      throw httpError(
        409,
        "entity_route_history_capacity",
        "This entity has reached its safe Live Activity route-history limit. End the current Live Activity or wait for its route retention window before changing the Activity ID again."
      );
    }
    if (result.reason === "entity_route_starting_conflict") {
      throw httpError(
        409,
        "entity_route_starting_conflict",
        "A previous Live Activity Start for this entity may still be registering. End it or wait for registration before changing the Set intent."
      );
    }
    return null;
  }
  return {
    reservationKey: result.reservation_key,
    ownerNonce,
    version: result.version,
    expiresAtMs: result.expires_at_ms,
    hardDeadlineMs: nowMs + ENTITY_SET_HARD_DEADLINE_MS,
    startAttributesHash,
    displayNameHash: displayNameHash || null,
    reusedStartingDeviceIDs: Array.isArray(result.reused_starting_device_ids)
      ? result.reused_starting_device_ids
      : [],
  };
}

function entitySetReservationAuth(reservation) {
  return {
    reservation_key: reservation.reservationKey,
    owner_nonce: reservation.ownerNonce,
    reservation_version: reservation.version,
  };
}

async function claimEntitySetReservation(env, instanceID, reservation, activitySnapshot) {
  const result = await callAuthState(env, instanceID, {
    action: "claim_entity_set_reservation",
    ...entitySetReservationAuth(reservation),
    activity_snapshot: activitySnapshot,
    now_ms: Date.now(),
  });
  return result.claimed === true;
}

async function validateEntitySetReservation(env, instanceID, reservation) {
  const result = await callAuthState(env, instanceID, {
    action: "validate_entity_set_reservation",
    ...entitySetReservationAuth(reservation),
    now_ms: Date.now(),
  });
  return result.valid === true;
}

async function renewEntitySetReservation(env, instanceID, reservation) {
  const nowMs = Date.now();
  const result = await callAuthState(env, instanceID, {
    action: "renew_entity_set_reservation",
    ...entitySetReservationAuth(reservation),
    now_ms: nowMs,
    expires_at_ms: Math.min(
      nowMs + ENTITY_SET_RESERVATION_TTL_MS,
      reservation.hardDeadlineMs
    ),
  });
  if (result.renewed !== true) {
    const error = httpError(
      409,
      "entity_activity_reconciliation_retry_required",
      "The entity Set route changed before APNs delivery."
    );
    error.apnsTransportNotStarted = true;
    throw error;
  }
  reservation.expiresAtMs = result.expires_at_ms;
  return true;
}

async function prepareEntitySetTransport(env, instanceID, reservation, deviceID) {
  await renewEntitySetReservation(env, instanceID, reservation);
  const result = await callAuthState(env, instanceID, {
    action: "mark_entity_set_transport_started",
    ...entitySetReservationAuth(reservation),
    device_id: deviceID,
    now_ms: Date.now(),
  });
  if (result.marked !== true) {
    const error = httpError(
      409,
      "entity_activity_reconciliation_retry_required",
      "The entity Set route changed before APNs delivery."
    );
    error.apnsTransportNotStarted = true;
    throw error;
  }
}

async function commitEntitySetReservation(env, instanceID, reservation) {
  const result = await callAuthState(env, instanceID, {
    action: "commit_entity_set_reservation",
    ...entitySetReservationAuth(reservation),
    now_ms: Date.now(),
  });
  return result.committed === true;
}

async function releaseEntitySetReservation(
  env,
  instanceID,
  reservation,
  { uncertain = false, deviceOutcomes = null } = {}
) {
  try {
    await callAuthState(env, instanceID, {
      action: "release_entity_set_reservation",
      ...entitySetReservationAuth(reservation),
      uncertain,
      ...(Array.isArray(deviceOutcomes) ? { device_outcomes: deviceOutcomes } : {}),
      now_ms: Date.now(),
    });
  } catch (error) {
    logRelay("entity-set-reservation-release-failed", {
      home_assistant_instance_id: logInstanceID(instanceID),
      error: error.code || "auth_state_unavailable",
    });
  }
}

async function claimActivityDisplayNames(env, instanceID, {
  environment,
  entityID,
  activityID,
  displayNameHash,
  deviceIDs,
}) {
  const nowMs = Date.now();
  const ownerNonce = `dc_${randomBase64URLToken(18)}`;
  const result = await callAuthState(env, instanceID, {
    action: "claim_activity_display_names",
    environment,
    entity_id: entityID,
    activity_id: activityID,
    display_name_hash: displayNameHash,
    device_ids: deviceIDs,
    owner_nonce: ownerNonce,
    now_ms: nowMs,
    expires_at_ms: nowMs + pendingStartTTLSeconds(env) * 1000,
  });
  if (result.claimed !== true) {
    return {
      claimed: false,
      reason: stringValue(result.reason) || "duplicate_activity_name",
      retryAfterMs: Number.isInteger(result.retry_after_ms)
        ? result.retry_after_ms
        : null,
    };
  }
  return {
    claimed: true,
    ownerNonce,
    claimKeys: Array.isArray(result.owned_keys) ? result.owned_keys : [],
    entityID,
    activityID,
    displayNameHash,
  };
}

async function commitActivityDisplayNames(env, instanceID, claim) {
  const result = await callAuthState(env, instanceID, {
    action: "commit_activity_display_names",
    owner_nonce: claim.ownerNonce,
    claim_keys: claim.claimKeys,
    now_ms: Date.now(),
  });
  return result.finalized === claim.claimKeys.length;
}

async function releaseActivityDisplayNames(
  env,
  instanceID,
  claim,
  { uncertain = false } = {}
) {
  try {
    await callAuthState(env, instanceID, {
      action: "release_activity_display_names",
      owner_nonce: claim.ownerNonce,
      claim_keys: claim.claimKeys,
      uncertain,
      now_ms: Date.now(),
    });
  } catch (error) {
    logRelay("activity-display-claim-release-failed", {
      home_assistant_instance_id: logInstanceID(instanceID),
      error: error.code || "auth_state_unavailable",
    });
  }
}

function activityRestartRequiredResponse(activityID) {
  return jsonResponse({
    ok: false,
    error: "activity_restart_required",
    message: "The existing Live Activity's immutable start attributes cannot be safely reused. End and restart it before changing controls, entity binding, or starting it on another device.",
    activity_id: activityID,
  }, 409);
}

async function handleTestStart(request, env) {
  ensureAPNs(env);
  ensureStorage(env);
  const body = await readJSON(request, env);
  validateLiveActivityPayload(body);
  requireInstanceIDVersion(body);
  requiredActivityRoutingID(body);
  const instanceID = requiredInstanceID(body);
  const environment = requiredMatchingAPNsEnvironment(body, env);
  const deviceID = requiredRoutingID(body, "device_id");
  await requireLegacyDeviceMutationAllowed(env, environment, instanceID, deviceID);
  enforceActorRateLimit(env, "/test-start", `${instanceID}:${deviceID}`);

  return await sendTestStart(body, env, instanceID, environment, deviceID, "test-start-request");
}

async function sendTestStart(body, env, instanceID, environment, deviceID, logEvent) {
  const devices = await resolveDeviceRecords(env, environment, instanceID, deviceID);
  logRelay(logEvent, {
    activity_id: stringValue(body.activity_id),
    home_assistant_instance_id: logInstanceID(instanceID),
    device_id: logID(deviceID),
    environment,
    matched_devices: devices.length,
  });
  if (devices.length === 0) {
    throw httpError(404, "no_registered_devices", "No registered push-to-start token matched this test request.");
  }

  const payload = startPayload(body, env);
  const results = await Promise.all(
    devices.map((device) => sendAPNs(env, device.push_to_start_token, payload, "start", device.device_id))
  );

  return relayResultsResponse("test-start", results, { matched_devices: devices.length });
}

async function handleUpdateOrEnd(request, env, event) {
  ensureAPNs(env);
  ensureStorage(env);
  const body = await readJSON(request, env);
  validateLiveActivityPayload(body);
  const activityID = requiredActivityRoutingID(body);
  const instanceID = requiredInstanceID(body);
  const environment = requiredMatchingAPNsEnvironment(body, env);
  const deviceID = optionalRoutingID(body, "device_id");
  await requireHARelaySecret(request, env, instanceID);
  enforceActorRateLimit(env, `/${event}`, `${instanceID}:${deviceID || "broadcast"}:${activityID}`);

  const activities = await resolveActivityRecords(env, environment, instanceID, activityID, deviceID);
  logRelay(`${event}-request`, {
    activity_id: activityID,
    home_assistant_instance_id: logInstanceID(instanceID),
    device_id: deviceID ? logID(deviceID) : "instance-broadcast",
    environment,
    matched_activities: activities.length,
  });
  if (activities.length === 0) {
    throw httpError(404, "no_activity_tokens", "No registered Live Activity update tokens matched this request.");
  }

  const state = contentStateFromHA(body);
  let displayClaim = null;
  let displayClaimCommitted = false;
  let displayClaimUncertain = false;
  if (
    event === "update"
    && state.entityId
    && await ensureActivityGenerationAuthority(env, instanceID)
  ) {
    const displayNameKey = normalizedDisplayNameKey(displayNameFromState(state));
    if (displayNameKey) {
      const authoritativeEntityIDs = [...new Set((await Promise.all(
        activities.map((activity) => entityIDForActivityRecord(
          env,
          environment,
          instanceID,
          activity
        ))
      )).filter(validHomeAssistantEntityID))];
      if (authoritativeEntityIDs.length > 1) {
        return activityUpdateRetryResponse(activityID);
      }
      displayClaim = await claimActivityDisplayNames(env, instanceID, {
        environment,
        entityID: authoritativeEntityIDs[0] || state.entityId,
        activityID,
        displayNameHash: await sha256Hex(displayNameKey),
        deviceIDs: [...new Set(activities.map((activity) => activity.device_id))],
      });
      if (!displayClaim.claimed) {
        return activityDisplayClaimConflictResponse(displayClaim);
      }
    }
  }

  try {
    const payload = updateOrEndPayload(body, event, state);
    const activityResults = await Promise.all(
      activities.map(async (activity) => ({
        activity,
        result: await sendAPNs(env, activity.update_token, payload, event, activity.device_id),
      }))
    );
    const results = activityResults.map(({ result }) => result);
    displayClaimUncertain = Boolean(
      displayClaim
      && results.some((result) => result.ok || result.delivery_uncertain === true)
    );

    let updateGenerationConflict = false;
    if (event === "update") {
      await Promise.all(
        activityResults.map(async ({ activity, result }) => {
          if (isStaleAPNsActivity(result)) {
            const neutralized = await markActivityGenerationStale(
              env,
              environment,
              instanceID,
              activity
            );
            if (!neutralized.marked) updateGenerationConflict = true;
            return;
          }
          if (result.ok) {
            const persisted = await persistActivityGenerationUpdate(
              env,
              environment,
              instanceID,
              activity,
              state,
              null,
              displayClaim
            );
            if (!persisted) updateGenerationConflict = true;
          }
        })
      );
      if (updateGenerationConflict) {
        return jsonResponse({
          ok: false,
          error: "activity_update_retry_required",
          message: "A newer Live Activity registration appeared while the update was being delivered. Retry the update safely.",
          activity_id: activityID,
          attempted: results.length,
          results,
        }, 409);
      }
      if (displayClaim && results.every((result) => result.ok)) {
        displayClaimCommitted = await commitActivityDisplayNames(
          env,
          instanceID,
          displayClaim
        );
        if (!displayClaimCommitted) {
          return jsonResponse({
            ok: false,
            error: "activity_display_claim_retry_required",
            message: "The Live Activity display name changed while Update was running. Retry Update safely.",
          }, 409);
        }
      }
    }

    if (event === "end") {
    const neutralized = activityResults.filter(({ result }) => (
      result.ok || result.status === 410
    ));
    const neutralizationResults = await Promise.all(neutralized.map(({ activity }) => (
      markActivityGenerationStale(env, environment, instanceID, activity)
    )));

    if (neutralizationResults.some((result) => !result.marked)) {
      return jsonResponse({
        ok: false,
        error: "activity_end_retry_required",
        message: "A newer Live Activity registration appeared while End was running. Retry End to target the current registration safely.",
        activity_id: activityID,
        attempted: results.length,
        results,
      }, 409);
    }

    await Promise.all(neutralized.map(({ activity }) => (
      clearActivityRouteState(env, environment, instanceID, activity)
    )));

    if (neutralized.length > 0) {
      const neutralizedDevices = new Set(neutralized.map(({ activity }) => activity.device_id));
      const remaining = await resolveActivityRecords(
        env,
        environment,
        instanceID,
        activityID,
        deviceID
      );
      const concurrent = remaining.filter((activity) => neutralizedDevices.has(activity.device_id));
      if (concurrent.length > 0) {
        return jsonResponse({
          ok: false,
          error: "activity_end_retry_required",
          message: "A newer Live Activity registration appeared while End was running. Retry End to target the current registration safely.",
          activity_id: activityID,
          concurrent_registrations: concurrent.length,
          attempted: results.length,
          results,
        }, 409);
      }
    }

    if (results.length > 0 && results.every((result) => result.ok || result.status === 410)) {
      const delivered = results.filter((result) => result.ok).length;
      const cleanedStaleActivities = results.filter((result) => result.status === 410).length;
      return jsonResponse({
        ok: true,
        action: event,
        matched_activities: activities.length,
        delivered,
        attempted: results.length,
        neutralized_activities: neutralized.length,
        cleaned_stale_activities: cleanedStaleActivities,
        stale_cleanup_satisfied: cleanedStaleActivities > 0,
        results,
      });
    }
    }

    return relayResultsResponse(event, results, { matched_activities: activities.length });
  } finally {
    if (displayClaim?.claimed && !displayClaimCommitted) {
      await releaseActivityDisplayNames(env, instanceID, displayClaim, {
        uncertain: displayClaimUncertain,
      });
    }
  }
}

async function handleRevokeDevice(request, env) {
  ensureStorage(env);
  const body = await readJSON(request, env);
  const deviceID = requiredRoutingID(body, "device_id");
  const instanceID = requiredInstanceID(body);
  const environment = requiredMatchingAPNsEnvironment(body, env);
  enforceActorRateLimit(env, "/revoke-device", `${instanceID}:${deviceID}`);
  const provided = requiredSecretHeaderValue(request, HA_SECRET_HEADER, "HA LiveKit relay secret");
  const legacyInstanceRecord = await getJSON(env.TOKENS, instanceRelaySecretKey(instanceID));
  const legacyInstance = await legacyInstanceSnapshot(legacyInstanceRecord);
  const revoked = await callAuthState(env, instanceID, {
    action: "revoke_device_by_ha",
    device_id: deviceID,
    environment,
    provided_secret_hash: await sha256Hex(provided),
    legacy_secret_hash: legacyInstance?.secretHash,
    legacy_auth_protocol: legacyInstance?.authProtocol,
    now: new Date().toISOString(),
  });
  if (legacyInstanceRecord) {
    await refreshRelaySecretTTL(env, instanceID, legacyInstanceRecord, revoked.auth_protocol);
  }

  const deleted = await deleteDeviceRecords(env, environment, instanceID, deviceID);
  logRelay("revoke-device", {
    device_id: logID(deviceID),
    home_assistant_instance_id: logInstanceID(instanceID),
    environment,
    deleted_records: deleted.total,
  });
  return jsonResponse({
    ok: true,
    revoked: true,
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    apns_environment: environment,
    deleted,
    auth_generation: revoked.generation,
  });
}

async function handleListDevicesV2(request, env) {
  ensureStorage(env);
  const url = new URL(request.url);
  const instanceID = requiredInstanceID({
    home_assistant_instance_id: url.searchParams.get("home_assistant_instance_id"),
  });
  const environment = requiredMatchingAPNsEnvironment({
    apns_mode: url.searchParams.get("apns_mode"),
  }, env);
  enforceActorRateLimit(env, "/v2/devices", instanceID);
  await requireHARelaySecret(request, env, instanceID);
  const records = await resolveDeviceRecords(env, environment, instanceID);
  const devices = records
    .map((record) => ({
      device_id: record.device_id,
      friendly_device_name: stringValue(record.friendly_device_name) || null,
      auth_protocol: record.auth_protocol === "v2" ? "v2" : "v1",
      auth_generation: recordAuthGeneration(
        record,
        record.auth_protocol === "v2" ? "v2" : "v1"
      ),
      app_version: stringValue(record.app_version) || null,
      updated_at: stringValue(record.updated_at) || null,
    }))
    .sort((left, right) => left.device_id.localeCompare(right.device_id));
  return jsonResponse({
    ok: true,
    home_assistant_instance_id: instanceID,
    apns_environment: environment,
    devices,
  });
}

export function startPayload(
  body,
  env,
  state = contentStateFromHA(body),
  startAttributes = attributesFromHA(body)
) {
  const aps = {
    timestamp: unixTimestamp(),
    event: "start",
    "content-state": state,
    "attributes-type": env.APNS_ATTRIBUTES_TYPE || "HALiveActivityAttributes",
    attributes: startAttributes,
    alert: {
      title: state.title,
      body: state.subtitle || state.primaryState,
    },
  };

  if (env.APNS_INCLUDE_INPUT_PUSH_TOKEN !== "false") {
    aps["input-push-token"] = 1;
  }

  return { aps };
}

function updateOrEndPayload(body, event, state = contentStateFromHA(body)) {
  return {
    aps: {
      timestamp: unixTimestamp(),
      event,
      "content-state": state,
    },
  };
}

function attributesFromHA(body) {
  const data = objectValue(body.data);
  const activityID = requiredString(body, "activity_id");
  const entityID = stringValue(body.entity_id) || `ha_livekit.${activityID}`;
  const homeAssistantInstanceID = requiredInstanceID(body);
  const allowsEntityControl = body.allow_entity_control === true
    && supportsEntityControl(entityID);

  return {
    activityId: activityID,
    primaryEntityId: entityID,
    secondaryEntityId: stringValue(data.secondary_entity_id) || stringValue(data.secondaryEntityId) || null,
    template: normalizeTemplate(stringValue(body.template)),
    homeAssistantInstanceId: homeAssistantInstanceID,
    ...(allowsEntityControl ? {
      allowsEntityControl: true,
      entityControlHomeAssistantInstanceId: homeAssistantInstanceID,
    } : {}),
  };
}

function normalizeStoredStartAttributes(value, { activityID, instanceID, entityID } = {}) {
  const attributes = objectValue(value);
  if (Object.keys(attributes).length === 0) return null;

  const storedActivityID = stringValue(attributes.activityId);
  const primaryEntityID = stringValue(attributes.primaryEntityId);
  const storedInstanceID = stringValue(attributes.homeAssistantInstanceId);
  const secondaryEntityID = attributes.secondaryEntityId === null
    ? null
    : stringValue(attributes.secondaryEntityId);
  if (
    !storedActivityID
    || (!ROUTING_ID_PATTERN.test(storedActivityID) && !isCanonicalActivityRoutingID(storedActivityID))
    || !primaryEntityID
    || !storedInstanceID
    || (activityID && storedActivityID !== activityID)
    || (instanceID && storedInstanceID !== instanceID)
    || (entityID && primaryEntityID !== entityID)
    || (attributes.secondaryEntityId !== null
      && attributes.secondaryEntityId !== undefined
      && !secondaryEntityID)
  ) {
    return null;
  }

  const allowsEntityControl = attributes.allowsEntityControl === true;
  if (
    allowsEntityControl
    && (
      !supportsEntityControl(primaryEntityID)
      || attributes.entityControlHomeAssistantInstanceId !== storedInstanceID
    )
  ) {
    return null;
  }
  if (
    !allowsEntityControl
    && attributes.entityControlHomeAssistantInstanceId !== undefined
  ) {
    return null;
  }

  return {
    activityId: storedActivityID,
    primaryEntityId: primaryEntityID,
    secondaryEntityId: secondaryEntityID || null,
    template: normalizeTemplate(stringValue(attributes.template)),
    homeAssistantInstanceId: storedInstanceID,
    ...(allowsEntityControl ? {
      allowsEntityControl: true,
      entityControlHomeAssistantInstanceId: storedInstanceID,
    } : {}),
  };
}

function contentStateFromHA(body) {
  const data = objectValue(body.data);
  const activityID = requiredString(body, "activity_id");
  const entityID = stringValue(body.entity_id) || `ha_livekit.${activityID}`;
  const title = stringValue(body.title) || stringValue(body.display_name) || activityID;
  const primaryState = stringValue(body.state) || stringValue(body.subtitle) || "unknown";

  return {
    title,
    subtitle: stringValue(body.subtitle) || primaryState,
    displayName: stringValue(body.display_name) || stringValue(body.displayName) || title,
    entityId: entityID,
    primaryState,
    secondaryState: stringValue(data.secondary_state) || stringValue(data.secondaryState) || null,
    progress: numberOrNull(body.progress),
    value: stringValue(data.value) || stringValue(body.state) || null,
    unit: stringValue(data.unit) || null,
    iconName: stringValue(data.icon_name) || stringValue(data.iconName) || "dot.radiowaves.left.and.right",
    theme: normalizeTheme(stringValue(data.theme)),
    displayStyle: normalizeDisplayStyle(stringValue(data.display_style) || stringValue(data.displayStyle), stringValue(body.template)),
    lastUpdated: swiftDateNow(),
  };
}

function contentStateFromRegisteredActivity(body) {
  return normalizeStoredContentState(
    body.content_state
      || body.contentState
      || body["content-state"]
  );
}

function normalizeStoredContentState(value) {
  const state = objectValue(value);
  if (Object.keys(state).length === 0) return null;

  const title = stringValue(state.title);
  const primaryState = stringValue(state.primaryState) || stringValue(state.primary_state);
  const entityID = stringValue(state.entityId) || stringValue(state.entity_id);
  if (!title || !primaryState || !entityID) return null;

  return {
    title,
    subtitle: stringValue(state.subtitle) || primaryState,
    displayName: stringValue(state.displayName) || stringValue(state.display_name) || title,
    entityId: entityID,
    primaryState,
    secondaryState: stringValue(state.secondaryState) || stringValue(state.secondary_state) || null,
    progress: numberOrNull(state.progress),
    value: stringValue(state.value) || null,
    unit: stringValue(state.unit) || null,
    iconName: stringValue(state.iconName) || stringValue(state.icon_name) || "dot.radiowaves.left.and.right",
    theme: normalizeTheme(stringValue(state.theme)),
    displayStyle: normalizeDisplayStyle(stringValue(state.displayStyle) || stringValue(state.display_style)),
    lastUpdated: numberOrNull(state.lastUpdated ?? state.last_updated) ?? swiftDateNow(),
  };
}

function activityMetadataFromState(state, fallbackDisplayName) {
  const normalizedState = normalizeStoredContentState(state);
  const displayName = displayNameFromState(normalizedState) || stringValue(fallbackDisplayName);
  const displayNameKey = normalizedDisplayNameKey(displayName);
  const metadata = {};
  if (normalizedState?.entityId) metadata.entity_id = normalizedState.entityId;
  if (displayName) metadata.display_name = displayName;
  if (displayNameKey) metadata.display_name_key = displayNameKey;
  return metadata;
}

function refreshedActivityRecord(activity, state, updatedAt) {
  const { last_content_state: _legacyState, ...retainedActivity } = activity;
  const displayName = displayNameFromState(normalizeStoredContentState(state));
  const displayNameKey = normalizedDisplayNameKey(displayName);
  return {
    ...retainedActivity,
    ...(displayName ? { display_name: displayName } : {}),
    ...(displayNameKey ? { display_name_key: displayNameKey } : {}),
    updated_at: updatedAt,
  };
}

function displayNameFromState(state) {
  return stringValue(state?.displayName) || stringValue(state?.title);
}

function normalizedDisplayNameKey(value) {
  return String(value || "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isEntityBackedSetRequest(body, requestedState, authenticatedOperation = false) {
  const data = objectValue(body.data);
  const entityID = stringValue(body.entity_id);
  return authenticatedOperation
    && data.entity_based === true
    && data.source_service === "set_activity"
    && Boolean(entityID)
    && entityID === requestedState?.entityId;
}

async function resolveEntityBackedSetRoute(env, {
  body,
  environment,
  instanceID,
  requestedActivityID,
  deviceID,
  requestedState,
  reconciliationAttempted = false,
  authenticatedOperation = false,
  planOnly = false,
  reservation = null,
}) {
  const unchanged = {
    activityID: requestedActivityID,
    reusedActivityIDs: [],
    coveredDeviceIDs: [],
    hasExistingRoute: false,
    startAttributes: null,
    attributesVerified: false,
    legacyUnknownRoute: false,
  };
  if (!isEntityBackedSetRequest(body, requestedState, authenticatedOperation)) return unchanged;

  const entityID = requestedState.entityId;
  const [activities, pendingStarts] = await Promise.all([
    resolveActivityRecordsForInstance(env, environment, instanceID, deviceID),
    resolvePendingStartRecordsForInstance(env, environment, instanceID, deviceID),
  ]);
  const scopedRecords = [];
  for (const activity of activities) {
    scopedRecords.push({
      record: activity,
      kind: "active",
      entityID: await entityIDForActivityRecord(env, environment, instanceID, activity),
    });
  }
  scopedRecords.push(...pendingStarts.map((pending) => ({
    record: pending,
    kind: "pending",
    entityID: entityIDFromRecord(pending),
  })));

  const requestedIDRecords = scopedRecords.filter(({ record }) => (
    record.activity_id === requestedActivityID
  ));
  if (requestedIDRecords.some((candidate) => (
    candidate.entityID && candidate.entityID !== entityID
  ))) {
    return {
      ...unchanged,
      activityID: requestedActivityID,
      error: "activity_restart_required",
    };
  }

  const candidates = scopedRecords.filter((candidate) => (
    candidate.entityID === entityID
    || (
      !candidate.entityID
      && candidate.record.activity_id === requestedActivityID
    )
  ));
  const pendingConflicts = candidates.filter((candidate) => (
    candidate.kind === "pending"
    && candidate.record.activity_id !== requestedActivityID
  ));
  if (pendingConflicts.length > 0) {
    return {
      ...unchanged,
      error: "pending_entity_activity_id_changed",
      activityIDs: uniqueActivityIDs(pendingConflicts),
    };
  }

  const requestedCandidates = candidates.filter((candidate) => (
    candidate.record.activity_id === requestedActivityID
  ));
  const requestedPending = requestedCandidates.filter((candidate) => candidate.kind === "pending");
  const requestedActive = requestedCandidates.filter((candidate) => candidate.kind === "active");
  const extraActive = candidates.filter((candidate) => (
    candidate.kind === "active"
    && candidate.record.activity_id !== requestedActivityID
  ));

  const requestedAttributes = attributesFromHA(body);
  const requestedAttributesHash = await sha256Hex(JSON.stringify(requestedAttributes));
  const snapshots = [];
  let requestedAttributeError = null;
  for (const { record } of requestedCandidates) {
    const rawSnapshot = objectValue(record.start_attributes);
    if (Object.keys(rawSnapshot).length === 0) {
      const authoritativeHash = stringValue(record.authoritative_start_attributes_hash);
      if (authoritativeHash === requestedAttributesHash) {
        snapshots.push(requestedAttributes);
      } else {
        // Missing immutable attributes are not proof that an in-place Update
        // is safe. Active registrations are reconciled with an exact End+Start;
        // pending registrations fail before APNs because they cannot be ended.
        requestedAttributeError = authoritativeHash
          ? "immutable_activity_attributes_changed"
          : "activity_restart_required";
      }
      continue;
    }
    const snapshot = normalizeStoredStartAttributes(rawSnapshot, {
      activityID: requestedActivityID,
      instanceID,
      entityID,
    });
    if (!snapshot) {
      requestedAttributeError = "activity_restart_required";
      break;
    }
    snapshots.push(snapshot);
  }
  const startAttributes = snapshots[0] || null;
  if (snapshots.some((attributes) => !sameStartAttributes(attributes, startAttributes))) {
    requestedAttributeError = "activity_restart_required";
  }
  if (startAttributes && !sameStartAttributes(startAttributes, requestedAttributes)) {
    requestedAttributeError = "immutable_activity_attributes_changed";
  }

  if (requestedAttributeError && requestedPending.length > 0) {
    return {
      ...unchanged,
      activityID: requestedActivityID,
      error: requestedAttributeError,
    };
  }
  if (
    requestedAttributeError
    && requestedActive.some(({ record }) => !stringValue(record.activity_kit_id))
  ) {
    return {
      ...unchanged,
      activityID: requestedActivityID,
      error: "activity_restart_identity_required",
    };
  }

  const reconciliationTargets = [
    ...extraActive,
    ...(requestedAttributeError ? requestedActive : []),
  ].map((candidate) => candidate.record);

  if (reconciliationTargets.length > 0) {
    const activityIDs = uniqueActivityIDs(candidates);
    const authorityEnabled = await ensureActivityGenerationAuthority(env, instanceID);
    const exactGenerationTargets = authorityEnabled
      && reconciliationTargets.every((activity) => (
        Boolean(activity.activity_registration_generation)
      ));

    if (!exactGenerationTargets) {
      if (requestedAttributeError) {
        return {
          ...unchanged,
          activityID: requestedActivityID,
          error: requestedAttributeError,
        };
      }
      return legacyEntityRouteConflict(unchanged, activityIDs, requestedActivityID);
    }

    if (reconciliationAttempted) {
      return entityActivityReconciliationRetryRequired(
        unchanged,
        requestedActivityID,
        activityIDs
      );
    }

    if (planOnly) {
      return {
        ...unchanged,
        activityID: requestedActivityID,
        reconciliationRequired: true,
        reconciliationTargets,
        activityIDs,
        requestedAttributeError,
      };
    }

    if (!reservation) {
      return entityActivityReconciliationRetryRequired(
        unchanged,
        requestedActivityID,
        activityIDs
      );
    }

    const reconciliation = await reconcileEntityBackedSetActivities(env, {
      body,
      environment,
      instanceID,
      requestedActivityID,
      requestedState,
      activities: reconciliationTargets,
      reservation,
    });
    if (reconciliation.error) {
      return { ...unchanged, ...reconciliation };
    }

    const resolved = await resolveEntityBackedSetRoute(env, {
      body,
      environment,
      instanceID,
      requestedActivityID,
      deviceID,
      requestedState,
      reconciliationAttempted: true,
      authenticatedOperation,
      reservation,
    });
    if (resolved.error) {
      if (resolved.error === "pending_entity_activity_id_changed") return resolved;
      return entityActivityReconciliationRetryRequired(
        unchanged,
        requestedActivityID,
        resolved.activityIDs || activityIDs,
        reconciliation
      );
    }
    return {
      ...resolved,
      reconciledActivityIDs: uniqueActivityIDs(
        reconciliationTargets.map((record) => ({ record }))
      ),
      reconciledActivities: reconciliation.neutralizedActivities,
    };
  }

  if (requestedCandidates.length === 0) return unchanged;

  return {
    activityID: requestedActivityID,
    reusedActivityIDs: [],
    coveredDeviceIDs: [...new Set(
      requestedCandidates.map((candidate) => candidate.record.device_id)
    )],
    hasExistingRoute: true,
    startAttributes,
    attributesVerified: snapshots.length === requestedCandidates.length,
    legacyUnknownRoute: snapshots.length < requestedCandidates.length,
  };
}

function uniqueActivityIDs(candidates) {
  return [...new Set(candidates.map((candidate) => (
    candidate.record?.activity_id || candidate.activity_id
  )))].filter(Boolean).sort();
}

function legacyEntityRouteConflict(unchanged, activityIDs, requestedActivityID) {
  if (activityIDs.length > 1) {
    return { ...unchanged, error: "ambiguous_entity_activity", activityIDs };
  }
  return {
    ...unchanged,
    error: "entity_activity_id_changed",
    activityIDs: activityIDs.length > 0 ? activityIDs : [requestedActivityID],
  };
}

function entityActivityReconciliationRetryRequired(
  unchanged,
  requestedActivityID,
  activityIDs,
  reconciliation = {}
) {
  return {
    ...unchanged,
    error: "entity_activity_reconciliation_retry_required",
    status: 409,
    message: "A Live Activity registration changed while Set was reconciling the entity. Retry Set to target the current registration safely.",
    requestedActivityID,
    activityIDs: [...new Set(activityIDs || [])].sort(),
    attempted: reconciliation.attempted,
    results: reconciliation.results,
  };
}

async function reconcileEntityBackedSetActivities(env, {
  body,
  environment,
  instanceID,
  requestedActivityID,
  requestedState,
  activities,
  reservation,
}) {
  const payload = updateOrEndPayload(body, "end", requestedState);
  const activityResults = await Promise.all(activities.map(async (activity) => ({
    activity,
    result: await sendAPNs(
      env,
      activity.update_token,
      payload,
      "end",
      activity.device_id,
      {
        beforeTransport: () => prepareEntitySetTransport(
          env,
          instanceID,
          reservation,
          activity.device_id
        ),
      }
    ),
  })));
  const neutralizable = activityResults.filter(({ result }) => (
    result.ok || result.status === 410
  ));
  const neutralizations = await Promise.all(neutralizable.map(async ({ activity }) => ({
    activity,
    marked: await markActivityGenerationStale(
      env,
      environment,
      instanceID,
      activity,
      reservation
    ),
  })));
  const results = activityResults.map(({ result }) => result);

  if (neutralizations.some(({ marked }) => !marked.marked)) {
    return {
      error: "entity_activity_reconciliation_retry_required",
      status: 409,
      message: "A Live Activity registration changed while Set was reconciling the entity. Retry Set to target the current registration safely.",
      requestedActivityID,
      attempted: results.length,
      results,
    };
  }

  const failed = activityResults.filter(({ result }) => (
    !result.ok && result.status !== 410
  ));
  if (failed.length > 0) {
    return {
      error: "entity_activity_reconciliation_failed",
      status: 502,
      message: "Set could not safely end every conflicting Live Activity, so the requested activity was not started.",
      requestedActivityID,
      attempted: results.length,
      failed: failed.length,
      results,
    };
  }

  logRelay("entity-set-reconciled", {
    activity_id: requestedActivityID,
    home_assistant_instance_id: logInstanceID(instanceID),
    environment,
    neutralized_activities: neutralizable.length,
  });
  return {
    attempted: results.length,
    neutralizedActivities: neutralizable.length,
    results,
  };
}

async function entityIDForActivityRecord(env, environment, instanceID, activity) {
  const direct = entityIDFromRecord(activity);
  if (direct) return direct;
  let retainedState = String(activity.activity_registration_generation || "").startsWith("ar_")
    ? await getJSON(
      env.TOKENS,
      activityGenerationStateKey(
        environment,
        instanceID,
        activity.activity_id,
        activity.device_id,
        activity.activity_registration_generation
      )
    )
    : null;
  if (!retainedState) {
    retainedState = await getJSON(
      env.TOKENS,
      activityStateKey(environment, instanceID, activity.activity_id, activity.device_id)
    );
  }
  return normalizeStoredContentState(retainedState?.content_state)?.entityId;
}

function entityIDFromRecord(record) {
  return stringValue(record?.entity_id)
    || stringValue(record?.authoritative_entity_id)
    || normalizeStoredContentState(record?.last_content_state)?.entityId
    || stringValue(objectValue(record?.start_attributes).primaryEntityId);
}

function sameStartAttributes(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function duplicateDisplayNameConflict(env, {
  environment,
  instanceID,
  activityID,
  deviceID,
  requestedState,
  ignoredEntityID = null,
}) {
  const displayNameKey = normalizedDisplayNameKey(displayNameFromState(requestedState));
  if (!displayNameKey) return null;

  const [activityRecords, pendingRecords] = await Promise.all([
    resolveActivityRecordsForInstance(env, environment, instanceID, deviceID),
    resolvePendingStartRecordsForInstance(env, environment, instanceID, deviceID),
  ]);

  const activityConflicts = [];
  for (const record of activityRecords) {
    if (record.activity_id === activityID || record.display_name_key !== displayNameKey) continue;
    const entityID = ignoredEntityID
      ? await entityIDForActivityRecord(env, environment, instanceID, record)
      : null;
    if (ignoredEntityID && entityID === ignoredEntityID) continue;
    activityConflicts.push(record);
  }
  const pendingConflicts = pendingRecords.filter((record) => (
    record.activity_id !== activityID
    && record.display_name_key === displayNameKey
    && (!ignoredEntityID || entityIDFromRecord(record) !== ignoredEntityID)
  ));

  if (activityConflicts.length === 0 && pendingConflicts.length === 0) {
    return null;
  }

  return {
    activeConflicts: activityConflicts.length,
    pendingConflicts: pendingConflicts.length,
    cleanedStaleActivities: 0,
  };
}

async function resolveDeviceRecords(env, environment, instanceID, deviceID) {
  if (deviceID) {
    const record = await getJSON(env.TOKENS, deviceKey(environment, instanceID, deviceID));
    const records = recordMatchesScope(record, environment, instanceID, deviceID, "device") ? [record] : [];
    const authoritative = await filterAuthoritativeRecords(env, environment, instanceID, records);
    return await migrateResolvedRecords(env, environment, instanceID, authoritative, "device");
  }

  const records = await listJSON(env.TOKENS, devicePrefix(environment, instanceID));
  const scoped = records.filter((record) => recordMatchesScope(record, environment, instanceID, undefined, "device"));
  const authoritative = await filterAuthoritativeRecords(env, environment, instanceID, scoped);
  return await migrateResolvedRecords(env, environment, instanceID, authoritative, "device");
}

async function resolveActivityRecords(env, environment, instanceID, activityID, deviceID) {
  if (deviceID) {
    const record = await getJSON(env.TOKENS, activityKey(environment, instanceID, activityID, deviceID));
    const records = recordMatchesScope(record, environment, instanceID, deviceID, "activity", activityID) ? [record] : [];
    const authoritative = await filterAuthoritativeRecords(env, environment, instanceID, records);
    const normalized = await migrateResolvedRecords(env, environment, instanceID, authoritative, "activity");
    return await resolveCurrentActivityRegistrations(env, environment, instanceID, {
      deviceID,
      activityID,
      legacyRecords: normalized,
    });
  }

  const records = await listJSON(env.TOKENS, activityPrefix(environment, instanceID, activityID));
  const scoped = records.filter((record) => recordMatchesScope(record, environment, instanceID, undefined, "activity", activityID));
  const authoritative = await filterAuthoritativeRecords(env, environment, instanceID, scoped);
  const normalized = await migrateResolvedRecords(env, environment, instanceID, authoritative, "activity");
  return await resolveCurrentActivityRegistrations(env, environment, instanceID, {
    activityID,
    legacyRecords: normalized,
  });
}

async function resolveActivityRecordsForInstance(env, environment, instanceID, deviceID) {
  const records = await listJSON(env.TOKENS, activityInstancePrefix(environment, instanceID));
  const scoped = records.filter((record) => recordMatchesScope(record, environment, instanceID, deviceID, "activity"));
  const authoritative = await filterAuthoritativeRecords(env, environment, instanceID, scoped);
  const normalized = await migrateResolvedRecords(env, environment, instanceID, authoritative, "activity");
  return await resolveCurrentActivityRegistrations(env, environment, instanceID, {
    deviceID,
    legacyRecords: normalized,
  });
}

async function resolveCurrentActivityRegistrations(env, environment, instanceID, {
  deviceID,
  activityID,
  legacyRecords,
}) {
  const authorityEnabled = await ensureActivityGenerationAuthority(env, instanceID);
  if (!authorityEnabled) {
    return legacyRecords;
  }
  const nowMs = Date.now();
  // A fixed-key record carrying a random `ar_` generation is only a
  // compatibility mirror. It must never recreate authority after its DO
  // pointer expires or disappears. Only true pre-generation records (and
  // deterministic legacy generations) are eligible for lazy adoption.
  const legacySources = legacyRecords.filter((record) => (
    !String(record?.activity_registration_generation || "").startsWith("ar_")
  ));
  const describedLegacy = await Promise.all(legacySources.map(async (record) => {
    const startAttributes = objectValue(record.start_attributes);
    return {
      ...record,
      activity_registration_generation: await activityRegistrationGenerationForRecord(
        environment,
        instanceID,
        record
      ),
      ...(entityIDFromRecord(record) ? { entity_id: entityIDFromRecord(record) } : {}),
      ...(Object.keys(startAttributes).length > 0
        ? { start_attributes_hash: await sha256Hex(JSON.stringify(startAttributes)) }
        : {}),
    };
  }));
  if (describedLegacy.length > 0) {
    await callAuthState(env, instanceID, {
      action: "adopt_legacy_activities",
      environment,
      activities: describedLegacy.map((record) => ({
        device_id: record.device_id,
        activity_id: record.activity_id,
        activity_registration_generation: record.activity_registration_generation,
        ...(record.entity_id ? { entity_id: record.entity_id } : {}),
        ...(record.start_attributes_hash
          ? { start_attributes_hash: record.start_attributes_hash }
          : {}),
        auth_protocol: record.auth_protocol === "v2" ? "v2" : "v1",
        auth_generation: recordAuthGeneration(
          record,
          record.auth_protocol === "v2" ? "v2" : "v1"
        ),
        expires_at_ms: legacyActivityExpiryMilliseconds(record, env, nowMs),
      })),
      now_ms: nowMs,
    });
  }

  const result = await callAuthState(env, instanceID, {
    action: "current_activity_registrations",
    environment,
    ...(deviceID ? { device_id: deviceID } : {}),
    ...(activityID ? { activity_id: activityID } : {}),
    now_ms: nowMs,
  });
  const legacyByGeneration = new Map(describedLegacy.map((record) => (
    [activityGenerationIdentity(record), record]
  )));
  const loaded = await Promise.all((result.activities || []).map(async (pointer) => {
    let record;
    if (pointer.storage_kind === "legacy") {
      record = legacyByGeneration.get(activityGenerationIdentity(pointer));
      if (!record) {
        const candidate = await getJSON(
          env.TOKENS,
          activityKey(environment, instanceID, pointer.activity_id, pointer.device_id)
        );
        if (recordMatchesScope(
          candidate,
          environment,
          instanceID,
          pointer.device_id,
          "activity",
          pointer.activity_id
        )) {
          const generation = await activityRegistrationGenerationForRecord(
            environment,
            instanceID,
            candidate
          );
          if (generation === pointer.activity_registration_generation) {
            record = { ...candidate, activity_registration_generation: generation };
          }
        }
      }
    } else {
      record = await getJSON(env.TOKENS, activityGenerationKey(
        environment,
        instanceID,
        pointer.activity_id,
        pointer.device_id,
        pointer.activity_registration_generation
      ));
    }
    if (
      !recordMatchesScope(
        record,
        environment,
        instanceID,
        pointer.device_id,
        "activity",
        pointer.activity_id
      )
      || record.activity_registration_generation !== pointer.activity_registration_generation
    ) {
      throw httpError(
        503,
        "activity_payload_unavailable",
        "The authoritative Live Activity registration is not yet available. Retry shortly."
      );
    }
    return {
      ...record,
      ...(pointer.entity_id ? { authoritative_entity_id: pointer.entity_id } : {}),
      ...(pointer.start_attributes_hash
        ? { authoritative_start_attributes_hash: pointer.start_attributes_hash }
        : {}),
      ...(pointer.display_name_hash
        ? { authoritative_display_name_hash: pointer.display_name_hash }
        : {}),
    };
  }));
  return await filterAuthoritativeRecords(env, environment, instanceID, loaded);
}

function activityGenerationIdentity(record) {
  return `${record.device_id}\n${record.activity_id}\n${record.activity_registration_generation}`;
}

function legacyActivityExpiryMilliseconds(record, env, nowMs) {
  const observed = Date.parse(record?.updated_at || record?.created_at || "");
  const fullTTL = activityTTLSeconds(env) * 1000;
  if (!Number.isFinite(observed)) return nowMs + fullTTL;
  return Math.min(nowMs + fullTTL, Math.max(nowMs + 60_000, observed + fullTTL));
}

async function markActivityGenerationStale(
  env,
  environment,
  instanceID,
  activity,
  reservation = null
) {
  if (!activity.activity_registration_generation) {
    await Promise.all([
      deleteKV(
        env.TOKENS,
        activityKey(environment, instanceID, activity.activity_id, activity.device_id)
      ),
      deleteKV(
        env.TOKENS,
        activityStateKey(environment, instanceID, activity.activity_id, activity.device_id)
      ),
    ]);
    return { marked: true, legacy: true };
  }
  const generation = await activityRegistrationGenerationForRecord(environment, instanceID, activity);
  const nowMs = Date.now();
  return await callAuthState(env, instanceID, {
    action: "mark_activity_stale",
    environment,
    device_id: activity.device_id,
    activity_id: activity.activity_id,
    activity_registration_generation: generation,
    ...(reservation ? entitySetReservationAuth(reservation) : {}),
    now_ms: nowMs,
    expires_at_ms: nowMs + activityTTLSeconds(env) * 1000,
  });
}

async function clearActivityRouteState(env, environment, instanceID, activity) {
  const entityID = entityIDFromRecord(activity);
  if (
    !entityID
    || !isActivityRegistrationGeneration(activity.activity_registration_generation)
  ) return { cleared: false };
  try {
    const nowMs = Date.now();
    return await callAuthState(env, instanceID, {
      action: "clear_activity_route_state",
      environment,
      device_id: activity.device_id,
      activity_id: activity.activity_id,
      entity_id: entityID,
      activity_registration_generation: activity.activity_registration_generation,
      ...(stringValue(activity.activity_kit_id)
        ? { activity_kit_id: activity.activity_kit_id }
        : {}),
      ...(stringValue(activity.display_name_key) ? {
        display_name_hash: await sha256Hex(activity.display_name_key),
      } : {}),
      now_ms: nowMs,
      expires_at_ms: nowMs + activityTTLSeconds(env) * 1000,
    });
  } catch (error) {
    logRelay("activity-route-clear-failed", {
      home_assistant_instance_id: logInstanceID(instanceID),
      device_id: logID(activity.device_id),
      activity_id: activity.activity_id,
      error: error.code || "auth_state_unavailable",
    });
    return { cleared: false };
  }
}

async function persistActivityGenerationUpdate(
  env,
  environment,
  instanceID,
  activity,
  contentState,
  reservation = null,
  displayClaim = null
) {
  const nowMs = Date.now();
  const ttlSeconds = activityTTLSeconds(env);
  const refreshed = refreshedActivityRecord(activity, contentState, new Date(nowMs).toISOString());
  if (!activity.activity_registration_generation) {
    await Promise.all([
      putJSONWithTTL(
        env.TOKENS,
        activityKey(environment, instanceID, activity.activity_id, activity.device_id),
        refreshed,
        ttlSeconds
      ),
      putActivityState(
        env,
        environment,
        instanceID,
        activity.activity_id,
        activity.device_id,
        contentState
      ),
    ]);
    return true;
  }
  if (String(activity.activity_registration_generation).startsWith("legacy_")) {
    if (reservation) {
      await Promise.all([
        putJSONWithTTL(
          env.TOKENS,
          activityGenerationKey(
            environment,
            instanceID,
            activity.activity_id,
            activity.device_id,
            activity.activity_registration_generation
          ),
          refreshed,
          ttlSeconds
        ),
        putActivityGenerationState(
          env,
          environment,
          instanceID,
          activity.activity_id,
          activity.device_id,
          activity.activity_registration_generation,
          contentState
        ),
      ]);
      const promoted = await callAuthState(env, instanceID, {
        action: "promote_legacy_activity_registration",
        environment,
        device_id: activity.device_id,
        activity_id: activity.activity_id,
        activity_registration_generation: activity.activity_registration_generation,
        now_ms: nowMs,
        expires_at_ms: nowMs + ttlSeconds * 1000,
      });
      return promoted.promoted === true;
    }
    const promoted = await callAuthState(env, instanceID, {
      action: "promote_legacy_activity_registration",
      environment,
      device_id: activity.device_id,
      activity_id: activity.activity_id,
      activity_registration_generation: activity.activity_registration_generation,
      now_ms: nowMs,
      expires_at_ms: nowMs + ttlSeconds * 1000,
    });
    if (promoted.promoted !== true) return false;
  }
  const touched = await callAuthState(env, instanceID, {
    action: "touch_activity_registration",
    environment,
    device_id: activity.device_id,
    activity_id: activity.activity_id,
    activity_registration_generation: activity.activity_registration_generation,
    ...(contentState?.entityId ? { entity_id: contentState.entityId } : {}),
    ...(normalizedDisplayNameKey(displayNameFromState(contentState)) ? {
      display_name_hash: await sha256Hex(normalizedDisplayNameKey(
        displayNameFromState(contentState)
      )),
    } : {}),
    ...(reservation ? entitySetReservationAuth(reservation) : {}),
    ...(reservation ? {
      entity_id: contentState.entityId,
      start_attributes_hash: reservation.startAttributesHash,
      display_name_hash: reservation.displayNameHash,
    } : {}),
    ...(!reservation && displayClaim?.claimed ? {
      display_claim_owner_nonce: displayClaim.ownerNonce,
      entity_id: displayClaim.entityID,
      display_name_hash: displayClaim.displayNameHash,
    } : {}),
    now_ms: nowMs,
    expires_at_ms: nowMs + ttlSeconds * 1000,
  });
  if (!touched.touched) {
    logRelay("activity-generation-touch-conflict", {
      home_assistant_instance_id: logInstanceID(instanceID),
      device_id: logID(activity.device_id),
      activity_id: activity.activity_id,
      reason: touched.reason || "unknown",
    });
    return false;
  }
  await Promise.all([
    putJSONWithTTL(
      env.TOKENS,
      activityGenerationKey(
        environment,
        instanceID,
        activity.activity_id,
        activity.device_id,
        activity.activity_registration_generation
      ),
      refreshed,
      ttlSeconds
    ),
    putActivityGenerationState(
      env,
      environment,
      instanceID,
      activity.activity_id,
      activity.device_id,
      activity.activity_registration_generation,
      contentState
    ),
  ]);
  return true;
}

async function filterAuthoritativeRecords(env, environment, instanceID, records) {
  if (records.length === 0) return records;
  const candidateMap = new Map();
  for (const record of records) {
    const authProtocol = record.auth_protocol === "v2" ? "v2" : "v1";
    const generation = recordAuthGeneration(record, authProtocol);
    const key = `${record.device_id}:${authProtocol}:${generation}`;
    const candidate = {
      device_id: record.device_id,
      auth_protocol: authProtocol,
      generation,
    };
    if (authProtocol === "v1") {
      candidate.legacy_record_proof_timestamp = serverRecordProofTimestamp(record);
    }
    const existing = candidateMap.get(key);
    if (!existing) {
      candidateMap.set(key, candidate);
      continue;
    }
    const candidateProof = Date.parse(candidate.legacy_record_proof_timestamp || "");
    const existingProof = Date.parse(existing.legacy_record_proof_timestamp || "");
    if (Number.isFinite(candidateProof) && (!Number.isFinite(existingProof) || candidateProof < existingProof)) {
      candidateMap.set(key, candidate);
    }
  }
  const candidates = [...candidateMap.values()];
  const result = await callAuthState(env, instanceID, {
    action: "active_records",
    environment,
    devices: candidates,
    maximum_devices: maxDevicesPerInstance(env),
    now: new Date().toISOString(),
  });
  const active = new Set((result.devices || []).map((entry) => (
    `${entry.device_id}:${entry.auth_protocol}:${entry.generation}`
  )));
  return records.filter((record) => {
    const authProtocol = record.auth_protocol === "v2" ? "v2" : "v1";
    const generation = recordAuthGeneration(record, authProtocol);
    return active.has(`${record.device_id}:${authProtocol}:${generation}`);
  });
}

async function resolvePendingStartRecordsForInstance(env, environment, instanceID, deviceID) {
  const records = await listJSON(env.TOKENS, pendingStartInstancePrefix(environment, instanceID));
  const scoped = records.filter((record) => pendingRecordMatchesScope(record, environment, instanceID, deviceID));
  return await filterAuthoritativeRecords(env, environment, instanceID, scoped);
}

function recordAuthGeneration(record, authProtocol) {
  const generation = Number(record.auth_generation);
  if (Number.isInteger(generation) && generation >= 0) return generation;
  return authProtocol === "v1" ? 0 : -1;
}

function serverRecordProofTimestamp(record) {
  for (const key of ["created_at", "updated_at"]) {
    const value = typeof record?.[key] === "string" ? record[key].trim() : "";
    if (value && value.length <= 64 && Number.isFinite(Date.parse(value))) {
      return value;
    }
  }
  return undefined;
}

async function migrateResolvedRecords(env, environment, instanceID, records, kind) {
  return await Promise.all(records.map(async (record) => {
    const authProtocol = record.auth_protocol === "v2" ? "v2" : "v1";
    const authGeneration = recordAuthGeneration(record, authProtocol);
    if (
      record.retention_policy_version === TOKEN_RETENTION_POLICY_VERSION
      && record.auth_protocol === authProtocol
      && record.auth_generation === authGeneration
    ) {
      return record;
    }

    const normalized = {
      ...record,
      auth_protocol: authProtocol,
      auth_generation: authGeneration,
      retention_policy_version: TOKEN_RETENTION_POLICY_VERSION,
    };
    if (kind === "activity") {
      return normalized;
    }
    const now = new Date().toISOString();
    const migrated = {
      ...normalized,
      migrated_at: record.migrated_at || now,
    };
    await putJSONWithTTL(
      env.TOKENS,
      deviceKey(environment, instanceID, record.device_id),
      migrated,
      deviceTTLSeconds(env)
    );
    return migrated;
  }));
}

function recordMatchesScope(record, environment, instanceID, deviceID, kind, activityID) {
  if (!record) return false;
  if (record.instance_id_version !== INSTANCE_ID_VERSION) return false;
  if (record.home_assistant_instance_id !== instanceID) return false;
  if (normalizeAPNsMode(record.apns_environment || record.apns_mode) !== environment) return false;
  if (deviceID && record.device_id !== deviceID) return false;
  if (activityID && record.activity_id !== activityID) return false;
  if (kind === "device") return Boolean(record.push_to_start_token);
  if (kind === "activity") return Boolean(record.update_token);
  return false;
}

function pendingRecordMatchesScope(record, environment, instanceID, deviceID) {
  if (!record) return false;
  if (record.instance_id_version !== INSTANCE_ID_VERSION) return false;
  if (record.home_assistant_instance_id !== instanceID) return false;
  if (normalizeAPNsMode(record.apns_environment || record.apns_mode) !== environment) return false;
  if (deviceID && record.device_id !== deviceID) return false;
  return Boolean(record.activity_id);
}

function isStaleAPNsActivity(result) {
  return result.status === 410 || result.reason === "Unregistered";
}

function normalizeAPNsMode(value) {
  const normalized = stringValue(value)?.toLowerCase();
  if (normalized === "production" || normalized === "sandbox") return normalized;
  return null;
}

async function requireHARelaySecret(request, env, instanceID) {
  const provided = requiredSecretHeaderValue(request, HA_SECRET_HEADER, "HA LiveKit relay secret");
  const authRecord = await getJSON(env.TOKENS, instanceRelaySecretKey(instanceID));
  const legacy = await legacyInstanceSnapshot(authRecord);
  try {
    const authoritative = await callAuthState(env, instanceID, {
      action: "verify_instance_secret",
      provided_secret_hash: await sha256Hex(provided),
      legacy_secret_hash: legacy?.secretHash,
      legacy_auth_protocol: legacy?.authProtocol,
      now: new Date().toISOString(),
    });
    if (authRecord) {
      await refreshRelaySecretTTL(env, instanceID, authRecord, authoritative.auth_protocol);
    }
    return;
  } catch (error) {
    logRelay("reject", {
      reason: "invalid_secret",
      home_assistant_instance_id: logInstanceID(instanceID),
    });
    throw error;
  }
}

async function requireDeviceCredential(request, env, instanceID, deviceID, environment) {
  const provided = requiredSecretHeaderValue(request, DEVICE_CREDENTIAL_HEADER, "device credential");
  const providedHash = await sha256Hex(provided);
  const result = await callAuthState(env, instanceID, {
    action: "verify_device",
    device_id: deviceID,
    environment,
    provided_credential_hash: providedHash,
  });
  return { device_credential_hash: providedHash, auth_generation: result.generation };
}

async function requireLegacyDeviceMutationAllowed(env, environment, instanceID, deviceID) {
  const [record, instanceRecord] = await Promise.all([
    getJSON(env.TOKENS, deviceKey(environment, instanceID, deviceID)),
    getJSON(env.TOKENS, instanceRelaySecretKey(instanceID)),
  ]);
  const scopedLegacyRecord = (
    recordMatchesScope(record, environment, instanceID, deviceID, "device")
    && record?.auth_protocol !== "v2"
    && recordAuthGeneration(record, "v1") === 0
  ) ? record : null;
  const legacyInstance = await legacyInstanceSnapshot(instanceRecord);
  return await callAuthState(env, instanceID, {
    action: "legacy_mutation_allowed",
    device_id: deviceID,
    environment,
    legacy_device_exists: Boolean(scopedLegacyRecord),
    legacy_device_auth_protocol: scopedLegacyRecord ? "v1" : undefined,
    legacy_device_generation: scopedLegacyRecord
      ? recordAuthGeneration(scopedLegacyRecord, "v1")
      : undefined,
    legacy_device_proof_timestamp: serverRecordProofTimestamp(scopedLegacyRecord),
    legacy_instance_secret_hash: legacyInstance?.secretHash,
    legacy_instance_auth_protocol: legacyInstance?.authProtocol,
    maximum_devices: maxDevicesPerInstance(env),
    now: new Date().toISOString(),
  });
}

async function deriveDeviceCredential(env, pairingToken, instanceID, deviceID, environment) {
  const pepper = requiredDeviceCredentialPepper(env);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const message = `ha-livekit-device-v2\n${pairingToken}\n${instanceID}\n${deviceID}\n${environment}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64URLBytes(new Uint8Array(signature));
}

function requiredDeviceCredentialPepper(env) {
  const value = String(env.DEVICE_CREDENTIAL_PEPPER || "").trim();
  if (value.length < 32) {
    throw httpError(
      500,
      "device_credential_pepper_not_configured",
      "Device credential derivation is not configured on the relay."
    );
  }
  return value;
}

function randomBase64URLToken(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64URLBytes(bytes);
}

function newActivityRegistrationGeneration() {
  return `ar_${randomBase64URLToken(18)}`;
}

function isActivityRegistrationGeneration(value) {
  return typeof value === "string" && (
    /^ar_[A-Za-z0-9_-]{22,64}$/.test(value)
    || /^legacy_[a-f0-9]{64}$/.test(value)
  );
}

async function activityRegistrationGenerationForRecord(environment, instanceID, record) {
  if (isActivityRegistrationGeneration(record?.activity_registration_generation)) {
    return record.activity_registration_generation;
  }
  const tokenHash = await sha256Hex(record?.update_token || "");
  const legacyIdentity = JSON.stringify([
    "ha-livekit-legacy-activity-generation-v1",
    environment,
    instanceID,
    stringValue(record?.device_id) || "",
    stringValue(record?.activity_id) || "",
    tokenHash,
    stringValue(record?.activity_kit_id) || "",
    stringValue(record?.bundle_id) || "",
    serverRecordProofTimestamp(record) || "",
  ]);
  return `legacy_${await sha256Hex(legacyIdentity)}`;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function legacyInstanceSnapshot(record) {
  if (!record || record.instance_id_version !== INSTANCE_ID_VERSION) return null;
  if (typeof record.secret_hash === "string" && /^[a-f0-9]{64}$/.test(record.secret_hash)) {
    return {
      secretHash: record.secret_hash,
      authProtocol: record.auth_protocol === "v2" ? "v2" : "v1",
    };
  }
  if (typeof record.secret === "string" && record.secret.length >= 32) {
    return { secretHash: await sha256Hex(record.secret), authProtocol: "v1" };
  }
  return null;
}

function requiredSecretHeaderValue(request, header, label) {
  const provided = request.headers.get(header);
  const errorCode = header === DEVICE_CREDENTIAL_HEADER ? "device_unauthorized" : "unauthorized";
  if (!provided || provided.length > 512) {
    throw httpError(401, errorCode, `Missing ${label}.`);
  }
  return provided;
}

async function callAuthState(env, instanceID, payload) {
  if (!env.AUTH_STATE) {
    throw httpError(
      503,
      "auth_state_unavailable",
      "Strongly consistent relay authorization is unavailable."
    );
  }

  let response;
  try {
    const id = env.AUTH_STATE.idFromName(instanceID);
    const stub = env.AUTH_STATE.get(id);
    response = await stub.fetch("https://relay-auth-state.internal/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw httpError(
      503,
      "auth_state_unavailable",
      "Strongly consistent relay authorization is unavailable."
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw httpError(503, "auth_state_unavailable", "Relay authorization returned an invalid response.");
  }
  if (!response.ok || !body?.ok) {
    throw httpError(
      response.status >= 400 ? response.status : 503,
      body?.error || "auth_state_unavailable",
      body?.message || "Relay authorization was rejected."
    );
  }
  return body;
}

function maxDevicesPerInstance(env) {
  return boundedInteger(env.MAX_DEVICES_PER_INSTANCE, DEFAULT_MAX_DEVICES_PER_INSTANCE, 1, 256);
}

async function refreshRelaySecretTTL(env, instanceID, authRecord, authoritativeAuthProtocol) {
  const ttlSeconds = secretTTLSeconds(env);
  const refreshIntervalMs = Math.min(30 * 24 * 60 * 60 * 1000, (ttlSeconds * 1000) / 4);
  const lastRefresh = Date.parse(authRecord.ttl_refreshed_at || "");
  const legacy = await legacyInstanceSnapshot(authRecord);
  const containsPlaintextSecret = typeof authRecord.secret === "string";
  const desiredAuthProtocol = authoritativeAuthProtocol === "v2" ? "v2" : legacy?.authProtocol;
  if (
    !containsPlaintextSecret
    && authRecord.retention_policy_version === 1
    && authRecord.auth_protocol === desiredAuthProtocol
    && Number.isFinite(lastRefresh)
    && Date.now() - lastRefresh < refreshIntervalMs
  ) {
    return;
  }
  if (!legacy) return;
  const now = new Date().toISOString();
  const refreshed = {
    ...authRecord,
    secret_hash: legacy.secretHash,
    secret_format: "sha256-v1",
    auth_protocol: desiredAuthProtocol,
    retention_policy_version: 1,
    ttl_refreshed_at: now,
    updated_at: now,
  };
  delete refreshed.secret;
  await putJSONWithTTL(env.TOKENS, instanceRelaySecretKey(instanceID), refreshed, ttlSeconds);
}

async function sendAPNs(env, token, payload, event, deviceID, options = {}) {
  let transportStarted = false;
  try {
    return await sendAPNsTransport(env, token, payload, event, deviceID, options, () => {
      transportStarted = true;
    });
  } catch (error) {
    const result = {
      ok: false,
      status: 0,
      apns_id: null,
      reason: error?.name === "AbortError" ? "APNsTimeout" : "APNsTransportError",
      event,
      device_id: logID(deviceID),
      delivery_uncertain: transportStarted && error?.apnsTransportNotStarted !== true,
      ...(error?.code === "entity_activity_reconciliation_retry_required"
        ? { reservation_conflict: true }
        : {}),
    };
    logRelay("apns-response", {
      apns_event: event,
      device_id: logID(deviceID),
      status: result.status,
      reason: result.reason,
      delivery_uncertain: result.delivery_uncertain,
      environment: apnsEnvironment(env),
    });
    return result;
  }
}

async function sendAPNsTransport(
  env,
  token,
  payload,
  event,
  deviceID,
  options,
  markTransportStarted
) {
  if (env.APNS_MOCK === "true") {
    if (typeof env.APNS_MOCK_BEFORE_SEND === "function") {
      await env.APNS_MOCK_BEFORE_SEND({ token, payload, event, deviceID });
    }
    if (typeof options.beforeTransport === "function") {
      await options.beforeTransport();
    }
    markTransportStarted();
    if (env.APNS_MOCK_THROW_AFTER_TRANSPORT === "true") {
      throw new Error("Injected APNs transport failure.");
    }
    if (Array.isArray(env.APNS_MOCK_REQUESTS)) {
      env.APNS_MOCK_REQUESTS.push({ token, payload, event, deviceID });
    }
    const staleTokens = new Set(
      String(env.APNS_MOCK_STALE_TOKENS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    );
    if (staleTokens.has(token)) {
      const staleResult = {
        ok: false,
        status: 410,
        apns_id: "mock-apns-id",
        reason: "Unregistered",
        event,
        device_id: logID(deviceID),
      };
      logRelay("apns-response", {
        apns_event: event,
        device_id: logID(deviceID),
        status: staleResult.status,
        apns_id: staleResult.apns_id,
        reason: staleResult.reason,
        environment: apnsEnvironment(env),
        mock: true,
      });
      return staleResult;
    }
    const failureTokens = new Set(
      String(env.APNS_MOCK_FAILURE_TOKENS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    );
    if (failureTokens.has(token)) {
      const failureResult = {
        ok: false,
        status: 500,
        apns_id: "mock-apns-id",
        reason: "InternalServerError",
        event,
        device_id: logID(deviceID),
      };
      logRelay("apns-response", {
        apns_event: event,
        device_id: logID(deviceID),
        status: failureResult.status,
        apns_id: failureResult.apns_id,
        reason: failureResult.reason,
        environment: apnsEnvironment(env),
        mock: true,
      });
      return failureResult;
    }

    const result = {
      ok: true,
      status: 200,
      apns_id: "mock-apns-id",
      reason: null,
      event,
      device_id: logID(deviceID),
    };
    logRelay("apns-response", {
      apns_event: event,
      device_id: logID(deviceID),
      status: result.status,
      apns_id: result.apns_id,
      environment: apnsEnvironment(env),
      mock: true,
    });
    return result;
  }

  const jwt = await apnsJWT(env);
  if (typeof options.beforeTransport === "function") {
    await options.beforeTransport();
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APNS_REQUEST_TIMEOUT_MS);
  let response;
  try {
    markTransportStarted();
    response = await fetch(`${apnsBaseURL(env)}/3/device/${token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-push-type": "liveactivity",
        "apns-topic": apnsTopic(env),
        "apns-priority": env.APNS_PRIORITY || (event === "start" ? "10" : "5"),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  const result = {
    ok: response.ok,
    status: response.status,
    apns_id: response.headers.get("apns-id"),
    reason: responseText ? safeJSON(responseText)?.reason || responseText : null,
    event,
    device_id: logID(deviceID),
  };
  logRelay("apns-response", {
    apns_event: event,
    device_id: logID(deviceID),
    status: result.status,
    apns_id: result.apns_id,
    reason: result.reason,
    environment: apnsEnvironment(env),
    topic: apnsTopic(env),
    possible_environment_mismatch: result.reason === "BadDeviceToken" ? "BadDeviceToken from APNs; verify token environment and reinstall/register the TestFlight app." : undefined,
  });
  return result;
}

async function apnsJWT(env) {
  const now = unixTimestamp();
  const teamID = apnsTeamID(env);
  const keyID = apnsKeyID(env);
  const cacheKey = `${teamID}:${keyID}`;
  if (cachedAPNsJWT && cachedAPNsJWT.cacheKey === cacheKey && cachedAPNsJWT.expiresAt > now + 60) {
    return cachedAPNsJWT.token;
  }

  const header = base64URLJSON({ alg: "ES256", kid: keyID });
  const claims = base64URLJSON({ iss: teamID, iat: now });
  const unsignedToken = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(apnsPrivateKey(env)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsignedToken)
  );

  const token = `${unsignedToken}.${base64URLBytes(new Uint8Array(signature))}`;
  cachedAPNsJWT = { cacheKey, token, expiresAt: now + 50 * 60 };
  return token;
}

function relayResultsResponse(action, results, metadata = {}) {
  const delivered = results.filter((result) => result.ok).length;
  if (results.length === 0) {
    return jsonResponse({
      ok: false,
      error: "no_delivery_attempts",
      message: "No active APNs delivery target remained after stale registrations were removed.",
      action,
      ...metadata,
      delivered: 0,
      attempted: 0,
      results: [],
    }, 502);
  }
  const status = delivered === results.length ? 200 : delivered > 0 ? 207 : 502;
  return jsonResponse({
    ok: delivered > 0 && delivered === results.length,
    action,
    ...metadata,
    delivered,
    attempted: results.length,
    results,
  }, status);
}

async function readJSON(request, env) {
  const maxBytes = maxRequestBodyBytes(env);
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw payloadTooLarge(maxBytes);
  }

  const text = await readLimitedBodyText(request, maxBytes);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw httpError(400, "invalid_json", "Request body must be valid JSON.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "payload_must_be_object", "Request body must be a JSON object.");
  }
  validateJSONShape(value);
  return value;
}

async function readLimitedBodyText(request, maxBytes) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      try {
        await reader.cancel("request_body_too_large");
      } catch {
        // The response is still a deterministic 413 if stream cancellation is unavailable.
      }
      throw payloadTooLarge(maxBytes);
    }
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw httpError(400, "invalid_encoding", "Request body must be valid UTF-8 JSON.");
  }
}

function validateJSONShape(value, depth = 0, state = { fields: 0, items: 0 }) {
  if (depth > 8) {
    throw httpError(400, "payload_too_deep", "Request JSON nesting exceeds the supported depth.");
  }
  if (typeof value === "string") {
    if (value.length > 2048) {
      throw httpError(400, "field_too_long", "A request string exceeds the supported length.");
    }
    return;
  }
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    state.items += value.length;
    if (value.length > 32 || state.items > 128) {
      throw httpError(400, "too_many_items", "Request arrays contain too many items.");
    }
    for (const item of value) validateJSONShape(item, depth + 1, state);
    return;
  }

  const entries = Object.entries(value);
  state.fields += entries.length;
  if (entries.length > 64 || state.fields > 192) {
    throw httpError(400, "too_many_fields", "Request JSON contains too many fields.");
  }
  for (const [key, child] of entries) {
    if (key.length > 128) {
      throw httpError(400, "field_name_too_long", "A request field name exceeds the supported length.");
    }
    validateJSONShape(child, depth + 1, state);
  }
}

function payloadTooLarge(maxBytes) {
  return httpError(
    413,
    "payload_too_large",
    `Request body exceeds the ${maxBytes}-byte limit.`
  );
}

async function getJSON(kv, key) {
  const text = await kv.get(key);
  return text ? safeJSON(text) : null;
}

async function listJSON(kv, prefix) {
  const entries = await listJSONEntries(kv, prefix);
  return entries.map(({ record }) => record);
}

async function listJSONEntries(kv, prefix) {
  const entries = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const key of page.keys) {
      const record = await getJSON(kv, key.name);
      if (record) entries.push({ key: key.name, record });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return entries;
}

async function deleteKV(kv, key) {
  if (typeof kv.delete === "function") {
    await kv.delete(key);
  }
}

async function deleteOwnedPendingStart(env, key, ownerNonce, { preparedOnly = false } = {}) {
  const pending = await getJSON(env.TOKENS, key);
  if (!pending || pending.request_owner_nonce !== ownerNonce) return false;
  if (preparedOnly && pending.delivery_state !== "prepared") return false;
  await deleteKV(env.TOKENS, key);
  return true;
}

async function markOwnedPendingStartSent(env, key, ownerNonce) {
  const pending = await getJSON(env.TOKENS, key);
  if (
    !pending
    || pending.request_owner_nonce !== ownerNonce
    || pending.delivery_state !== "prepared"
  ) return false;
  await putJSONWithTTL(env.TOKENS, key, {
    ...pending,
    delivery_state: "sent",
    updated_at: new Date().toISOString(),
  }, pendingStartTTLSeconds(env));
  return true;
}

async function putJSONWithTTL(kv, key, value, expirationTtl) {
  await kv.put(key, JSON.stringify(value), { expirationTtl });
}

async function putActivityState(env, environment, instanceID, activityID, deviceID, contentState) {
  const normalized = normalizeStoredContentState(contentState);
  if (!normalized) return;
  await putJSONWithTTL(
    env.TOKENS,
    activityStateKey(environment, instanceID, activityID, deviceID),
    {
      home_assistant_instance_id: instanceID,
      instance_id_version: INSTANCE_ID_VERSION,
      activity_id: activityID,
      device_id: deviceID,
      apns_environment: environment,
      content_state: normalized,
      retention_policy_version: TOKEN_RETENTION_POLICY_VERSION,
      updated_at: new Date().toISOString(),
    },
    activityStateTTLSeconds(env)
  );
}

async function putActivityGenerationState(
  env,
  environment,
  instanceID,
  activityID,
  deviceID,
  activityRegistrationGeneration,
  contentState
) {
  const normalized = normalizeStoredContentState(contentState);
  if (!normalized) return;
  await putJSONWithTTL(
    env.TOKENS,
    activityGenerationStateKey(
      environment,
      instanceID,
      activityID,
      deviceID,
      activityRegistrationGeneration
    ),
    {
      home_assistant_instance_id: instanceID,
      instance_id_version: INSTANCE_ID_VERSION,
      activity_id: activityID,
      device_id: deviceID,
      activity_registration_generation: activityRegistrationGeneration,
      apns_environment: environment,
      content_state: normalized,
      retention_policy_version: TOKEN_RETENTION_POLICY_VERSION,
      updated_at: new Date().toISOString(),
    },
    activityStateTTLSeconds(env)
  );
}

async function enforceDeviceQuota(env, environment, instanceID, deviceID) {
  const key = deviceKey(environment, instanceID, deviceID);
  if (await env.TOKENS.get(key)) return;
  const records = await listJSON(env.TOKENS, devicePrefix(environment, instanceID));
  const count = records.filter((record) => (
    recordMatchesScope(record, environment, instanceID, undefined, "device")
  )).length;
  const limit = boundedInteger(env.MAX_DEVICES_PER_INSTANCE, DEFAULT_MAX_DEVICES_PER_INSTANCE, 1, 256);
  if (count >= limit) {
    throw httpError(409, "device_quota_exceeded", "The device quota for this Home Assistant instance has been reached.");
  }
}

async function enforceActivityQuota(env, environment, instanceID, deviceID, activityID) {
  const key = activityKey(environment, instanceID, activityID, deviceID);
  if (await env.TOKENS.get(key)) return;
  const records = await resolveActivityRecordsForInstance(env, environment, instanceID);
  const instanceLimit = boundedInteger(
    env.MAX_ACTIVITIES_PER_INSTANCE,
    DEFAULT_MAX_ACTIVITIES_PER_INSTANCE,
    1,
    2048
  );
  if (records.length >= instanceLimit) {
    throw httpError(409, "activity_quota_exceeded", "The activity quota for this Home Assistant instance has been reached.");
  }
  const deviceCount = records.filter((record) => record.device_id === deviceID).length;
  const deviceLimit = boundedInteger(
    env.MAX_ACTIVITIES_PER_DEVICE,
    DEFAULT_MAX_ACTIVITIES_PER_DEVICE,
    1,
    256
  );
  if (deviceCount >= deviceLimit) {
    throw httpError(409, "activity_quota_exceeded", "The activity quota for this device has been reached.");
  }
}

async function deleteDeviceRecords(env, environment, instanceID, deviceID) {
  const suffix = `:device_${deviceID}`;
  const [deviceRecord, activities, pending, states] = await Promise.all([
    getJSON(env.TOKENS, deviceKey(environment, instanceID, deviceID)),
    listJSONEntries(env.TOKENS, activityInstancePrefix(environment, instanceID)),
    listJSONEntries(env.TOKENS, pendingStartInstancePrefix(environment, instanceID)),
    listJSONEntries(env.TOKENS, activityStateInstancePrefix(environment, instanceID)),
  ]);
  const activityKeys = activities
    .filter(({ key, record }) => key.endsWith(suffix) && recordMatchesScope(
      record,
      environment,
      instanceID,
      deviceID,
      "activity"
    ))
    .map(({ key }) => key);
  const pendingKeys = pending
    .filter(({ key, record }) => key.endsWith(suffix) && pendingRecordMatchesScope(
      record,
      environment,
      instanceID,
      deviceID
    ))
    .map(({ key }) => key);
  const stateKeys = states
    .filter(({ key, record }) => (
      key.endsWith(suffix)
      && record.home_assistant_instance_id === instanceID
      && record.device_id === deviceID
      && normalizeAPNsMode(record.apns_environment) === environment
    ))
    .map(({ key }) => key);
  const keys = [
    deviceKey(environment, instanceID, deviceID),
    ...activityKeys,
    ...pendingKeys,
    ...stateKeys,
  ];
  await Promise.all(keys.map((key) => deleteKV(env.TOKENS, key)));
  return {
    device: deviceRecord ? 1 : 0,
    activities: activityKeys.length,
    pending_starts: pendingKeys.length,
    retained_states: stateKeys.length,
    total: (deviceRecord ? 1 : 0) + activityKeys.length + pendingKeys.length + stateKeys.length,
  };
}

async function enforceEndpointRateLimit(request, env, path) {
  const policy = LOCAL_RATE_POLICIES[path];
  if (!policy) return;
  const actor = clientNetworkActor(request);
  consumeLocalRateLimit(
    `endpoint:${path}:${actor}`,
    boundedInteger(env[policy.env], policy.limit, 1, 10_000)
  );

  if (!hasRateLimitBinding(env)) {
    if (rateLimitMode(env) === "binding-required") {
      throw httpError(503, "rate_limit_unavailable", "Distributed rate limiting is unavailable; mutation requests are fail-closed.");
    }
    return;
  }

  let result;
  try {
    result = await env.RATE_LIMITER.limit({ key: `${path}:${actor}` });
  } catch (error) {
    logRelay("rate-limit-binding-error", { endpoint: path, message: error?.message || "unknown" });
    if (rateLimitMode(env) === "binding-required") {
      throw httpError(503, "rate_limit_unavailable", "Distributed rate limiting is temporarily unavailable.");
    }
    return;
  }
  if (!result?.success) throw rateLimitExceeded();
}

function enforceActorRateLimit(env, path, actor) {
  const policy = LOCAL_RATE_POLICIES[path];
  if (!policy) return;
  consumeLocalRateLimit(
    `actor:${path}:${actor}`,
    boundedInteger(env[policy.env], policy.limit, 1, 10_000)
  );
}

function consumeLocalRateLimit(key, limit) {
  const now = Date.now();
  if (now >= nextLocalRateSweepAt) {
    for (const [bucketKey, bucket] of localRateBuckets) {
      if (bucket.resetAt <= now) localRateBuckets.delete(bucketKey);
    }
    nextLocalRateSweepAt = now + LOCAL_RATE_WINDOW_MS;
  }

  let bucket = localRateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (!bucket && localRateBuckets.size >= MAX_LOCAL_RATE_BUCKETS) {
      throw httpError(503, "rate_limit_capacity_reached", "The local rate limiter is at capacity; mutation requests are fail-closed.");
    }
    bucket = { count: 0, resetAt: now + LOCAL_RATE_WINDOW_MS };
    localRateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw rateLimitExceeded(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
  }
}

function rateLimitExceeded(retryAfter = 60) {
  const error = httpError(429, "rate_limited", "Too many requests. Please retry later.");
  error.headers = { "retry-after": String(retryAfter) };
  return error;
}

function clientNetworkActor(request) {
  const raw = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]
    || "unknown";
  const value = String(raw).trim();
  return /^[A-Fa-f0-9:.]{1,64}$/.test(value) ? value : "unknown";
}

function hasRateLimitBinding(env) {
  return typeof env.RATE_LIMITER?.limit === "function";
}

function rateLimitMode(env) {
  const value = String(env.RATE_LIMIT_MODE || "local-fallback").trim().toLowerCase();
  return value === "local" || value === "local-fallback" ? "local-fallback" : "binding-required";
}

function requireSecret(request, expected, headerName) {
  if (!expected) {
    throw httpError(500, "secret_not_configured", `${headerName} is not configured on the relay.`);
  }

  const provided = request.headers.get(headerName);
  if (!provided || provided.length > 512 || !constantTimeEqual(provided, expected)) {
    throw httpError(401, "unauthorized", "Invalid HA LiveKit relay secret.");
  }
}

function ensureStorage(env) {
  if (!env.TOKENS) {
    throw httpError(500, "storage_not_configured", "Cloudflare KV binding TOKENS is not configured.");
  }
}

function ensureAPNs(env) {
  if (!isAPNsConfigured(env)) {
    throw httpError(500, "apns_not_configured", "APNs environment variables are incomplete.");
  }
}

function isAPNsConfigured(env) {
  return Boolean(apnsTeamID(env) && apnsKeyID(env) && apnsPrivateKey(env) && appBundleID(env));
}

function missingAPNsConfig(env) {
  const missing = [];
  if (!apnsTeamID(env)) missing.push("APPLE_TEAM_ID");
  if (!apnsKeyID(env)) missing.push("APPLE_KEY_ID");
  if (!apnsPrivateKey(env)) missing.push("APPLE_PRIVATE_KEY");
  if (!appBundleID(env)) missing.push("APP_BUNDLE_ID");
  return missing;
}

function apnsEnvironment(env) {
  return env.APNS_ENVIRONMENT === "production" ? "production" : "sandbox";
}

function apnsBaseURL(env) {
  return apnsEnvironment(env) === "production"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
}

function apnsTeamID(env) {
  return env.APPLE_TEAM_ID || env.APNS_TEAM_ID;
}

function apnsKeyID(env) {
  return env.APPLE_KEY_ID || env.APNS_KEY_ID;
}

function apnsPrivateKey(env) {
  return env.APPLE_PRIVATE_KEY || env.APNS_PRIVATE_KEY;
}

function appBundleID(env) {
  return env.APP_BUNDLE_ID || env.APNS_BUNDLE_ID;
}

function apnsTopic(env) {
  return env.APNS_TOPIC || `${appBundleID(env)}.push-type.liveactivity`;
}

function normalizePath(pathname) {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function normalizeTemplate(value) {
  const normalized = normalizeIdentifier(value || "custom");
  const templates = {
    custom: "custom",
    progress: "progress",
    washingmachine: "washingMachine",
    washing_machine: "washingMachine",
    laundry: "washingMachine",
    dishwasher: "dishwasher",
    vacuum: "vacuum",
    security: "security",
    door: "security",
    doorsecurity: "security",
    door_security: "security",
    climate: "climate",
    energy: "energy",
    plug: "energy",
    timer: "timer",
  };
  return templates[normalized] || "custom";
}

function normalizeDisplayStyle(value, template) {
  const normalized = normalizeIdentifier(value || "");
  const styles = {
    compactstatus: "compactStatus",
    compact_status: "compactStatus",
    progress: "progress",
    timer: "timer",
    security: "security",
    energy: "energy",
    vacuum: "vacuum",
    climate: "climate",
    doorwindow: "doorWindow",
    door_window: "doorWindow",
  };
  if (styles[normalized]) return styles[normalized];

  const templateStyle = {
    progress: "progress",
    washingMachine: "progress",
    dishwasher: "progress",
    vacuum: "vacuum",
    security: "security",
    climate: "climate",
    energy: "energy",
    timer: "timer",
  };
  return templateStyle[normalizeTemplate(template)] || "compactStatus";
}

function normalizeTheme(value) {
  const normalized = normalizeIdentifier(value || "homeAssistant");
  const themes = {
    homeassistant: "homeAssistant",
    home_assistant: "homeAssistant",
    ocean: "ocean",
    mint: "mint",
    amber: "amber",
    rose: "rose",
    graphite: "graphite",
  };
  return themes[normalized] || "homeAssistant";
}

function normalizeIdentifier(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function supportsEntityControl(entityID) {
  return /^(?:light|switch|input_boolean)\.[a-z0-9_]{1,200}$/.test(entityID || "");
}

function validHomeAssistantEntityID(entityID) {
  return typeof entityID === "string"
    && entityID.length <= 255
    && /^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityID);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validateRegistrationPayload(body) {
  validateTextFields(body, {
    device_id: 128,
    home_assistant_instance_id: 35,
    push_to_start_token: 512,
    bundle_id: 255,
    app_version: 64,
    friendly_device_name: 128,
    apns_mode: 16,
    apns_environment: 16,
    relay_environment: 16,
    pairing_token: 512,
    push_to_start_token_hash: 64,
  });
}

function validateActivityTokenPayload(body) {
  validateTextFields(body, {
    device_id: 128,
    home_assistant_instance_id: 35,
    activity_id: 128,
    activity_kit_id: 128,
    update_token: 512,
    display_name: 256,
    bundle_id: 255,
    app_version: 64,
    apns_mode: 16,
    apns_environment: 16,
    relay_environment: 16,
  });
  const state = body.content_state || body.contentState || body["content-state"];
  if (state !== undefined && (!state || typeof state !== "object" || Array.isArray(state))) {
    throw httpError(400, "invalid_field_type", "content_state must be a JSON object.");
  }
}

function validateLiveActivityPayload(body) {
  validateTextFields(body, {
    device_id: 128,
    home_assistant_instance_id: 35,
    activity_id: 128,
    entity_id: 255,
    title: 256,
    subtitle: 512,
    display_name: 256,
    displayName: 256,
    state: 512,
    template: 64,
    apns_mode: 16,
    apns_environment: 16,
    relay_environment: 16,
  });
  if (body.data !== undefined && (!body.data || typeof body.data !== "object" || Array.isArray(body.data))) {
    throw httpError(400, "invalid_field_type", "data must be a JSON object.");
  }
  if (body.allow_entity_control !== undefined && typeof body.allow_entity_control !== "boolean") {
    throw httpError(400, "invalid_field_type", "allow_entity_control must be a boolean.");
  }
  if (body.allow_entity_control === true && !supportsEntityControl(stringValue(body.entity_id))) {
    throw httpError(
      400,
      "invalid_entity_control",
      "Live Activity controls require a light, switch, or input_boolean entity."
    );
  }
  validateTextFields(objectValue(body.data), {
    secondary_entity_id: 255,
    secondaryEntityId: 255,
    secondary_state: 512,
    secondaryState: 512,
    value: 512,
    unit: 64,
    icon_name: 128,
    iconName: 128,
    theme: 32,
    display_style: 64,
    displayStyle: 64,
  });
}

function validateTextFields(object, limits) {
  for (const [key, maxLength] of Object.entries(limits)) {
    const value = object[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw httpError(400, "invalid_field_type", `${key} must be a string.`);
    }
    if (value.trim().length > maxLength) {
      throw httpError(400, "field_too_long", `${key} exceeds the ${maxLength}-character limit.`);
    }
  }
}

function optionalLimitedString(value, key, maxLength) {
  const normalized = stringValue(value);
  if (!normalized) return undefined;
  if (normalized.length > maxLength) {
    throw httpError(400, "field_too_long", `${key} exceeds the ${maxLength}-character limit.`);
  }
  return normalized;
}

function requiredLimitedString(body, key, maxLength) {
  const value = requiredString(body, key);
  if (value.length > maxLength) {
    throw httpError(400, "field_too_long", `${key} exceeds the ${maxLength}-character limit.`);
  }
  return value;
}

function requiredToken(body, key) {
  const value = requiredLimitedString(body, key, 512);
  if (!TOKEN_PATTERN.test(value)) {
    throw httpError(400, "invalid_token_format", `${key} has an invalid format.`);
  }
  return value;
}

function requiredSHA256(body, key) {
  const value = requiredLimitedString(body, key, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw httpError(400, "invalid_hash", `${key} must be a SHA-256 hex digest.`);
  }
  return value;
}

function requiredString(body, key) {
  const value = stringValue(body[key]);
  if (!value) {
    logRelay("reject", { reason: "missing_field", field: key });
    throw httpError(400, "missing_field", `${key} is required.`);
  }
  return value;
}

function requiredInstanceID(body) {
  const instanceID = requiredString(body, "home_assistant_instance_id");
  if (!INSTANCE_ID_PATTERN.test(instanceID) || DEFAULT_OR_UNSAFE_INSTANCE_IDS.has(instanceID)) {
    logRelay("reject", {
      reason: "invalid_instance_id",
      home_assistant_instance_id: logInstanceID(instanceID),
    });
    throw httpError(400, "invalid_instance_id", "home_assistant_instance_id is invalid or unsafe.");
  }
  return instanceID;
}

function requireInstanceIDVersion(body) {
  const version = Number(body.instance_id_version ?? body.home_assistant_instance_id_version);
  if (version !== INSTANCE_ID_VERSION) {
    logRelay("reject", { reason: "unsupported_instance_id_version", version: Number.isFinite(version) ? version : null });
    throw httpError(
      400,
      "unsupported_instance_id_version",
      "A v2 Home Assistant instance identity is required."
    );
  }
}

function requiredRoutingID(body, key) {
  const value = requiredString(body, key);
  if (!ROUTING_ID_PATTERN.test(value)) {
    logRelay("reject", { reason: "invalid_routing_id", field: key });
    throw httpError(400, "invalid_routing_id", `${key} contains unsupported characters.`);
  }
  return value;
}

function requiredActivityRoutingID(body) {
  const value = requiredString(body, "activity_id");
  if (!ROUTING_ID_PATTERN.test(value) && !isCanonicalActivityRoutingID(value)) {
    logRelay("reject", { reason: "invalid_routing_id", field: "activity_id" });
    throw httpError(400, "invalid_routing_id", "activity_id contains unsupported characters.");
  }
  return value;
}

function isCanonicalActivityRoutingID(value) {
  if (!CANONICAL_ACTIVITY_ID_PATTERN.test(value)) return false;
  const encoded = value.slice(1);
  try {
    const standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!decoded || ROUTING_ID_PATTERN.test(decoded)) return false;
    const binary = String.fromCharCode(...new TextEncoder().encode(decoded));
    const canonical = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return value === `~${canonical}`;
  } catch {
    return false;
  }
}

function optionalRoutingID(body, key) {
  const value = stringValue(body[key]);
  if (!value) return undefined;
  if (!ROUTING_ID_PATTERN.test(value)) {
    logRelay("reject", { reason: "invalid_routing_id", field: key });
    throw httpError(400, "invalid_routing_id", `${key} contains unsupported characters.`);
  }
  return value;
}

function requiredMatchingAPNsEnvironment(body, env) {
  const requested = normalizeAPNsMode(body.apns_mode || body.apns_environment || body.relay_environment);
  const expected = apnsEnvironment(env);
  if (!requested) {
    logRelay("reject", { reason: "missing_apns_environment", environment: expected });
    throw httpError(400, "missing_apns_environment", "APNs environment is required.");
  }
  if (requested !== expected) {
    logRelay("reject", {
      reason: "apns_environment_mismatch",
      requested_environment: requested,
      environment: expected,
    });
    throw httpError(400, "apns_environment_mismatch", "APNs environment does not match this relay.");
  }
  return expected;
}

function isRelayEnabled(env) {
  return String(env.RELAY_ENABLED ?? "false").trim().toLowerCase() === "true";
}

function v2PairingConfiguration(env) {
  const configuredMode = String(env.V2_PAIRING_MODE || "").trim().toLowerCase();
  const mode = V2_PAIRING_MODES.has(configuredMode) ? configuredMode : "off";
  const allowedInstanceHashes = new Set(
    String(env.V2_PAIRING_CANARY_INSTANCE_HASHES || "")
      .trim()
      .toLowerCase()
      .split(/[\s,]+/)
      .filter((value) => /^[a-f0-9]{64}$/.test(value))
  );
  return {
    mode,
    allowedInstanceHashes,
    allowlistCount: allowedInstanceHashes.size,
    enabled: mode === "all" || (mode === "allowlist" && allowedInstanceHashes.size > 0),
  };
}

function activityGenerationMode(env) {
  const configuredMode = String(env.ACTIVITY_GENERATION_MODE || "").trim().toLowerCase();
  return ACTIVITY_GENERATION_MODES.has(configuredMode) ? configuredMode : null;
}

async function ensureActivityGenerationAuthority(env, instanceID) {
  const mode = activityGenerationMode(env);
  if (!mode) {
    throw httpError(
      503,
      "activity_generation_mode_invalid",
      "Live Activity generation mode is not configured safely."
    );
  }
  const result = await callAuthState(env, instanceID, {
    action: mode === "authoritative"
      ? "enable_activity_authority"
      : "activity_authority_status",
    ...(mode === "authoritative" ? { now_ms: Date.now() } : {}),
  });
  return result.enabled === true;
}

async function requireV2PairingAllowed(request, env, path, pairing) {
  const body = await readJSON(request, env);
  if (pairing.mode === "off") {
    const recovered = await v2PairingRecoveryAllowed(request, env, path, body);
    if (recovered) {
      logRelay("v2-pairing-recovery", {
        endpoint: path,
        mode: pairing.mode,
        home_assistant_instance_id: logInstanceID(requiredInstanceID(body)),
      });
      return { body, authorization: RESTRICTED_V2_PAIRING_RECOVERY };
    }
    throwV2PairingUnavailable(path, pairing.mode);
  }
  if (pairing.mode === "allowlist") {
    requireInstanceIDVersion(body);
    const instanceID = requiredInstanceID(body);
    const instanceHash = await sha256Hex(instanceID);
    if (!pairing.allowedInstanceHashes.has(instanceHash)) {
      const recovered = await v2PairingRecoveryAllowed(request, env, path, body);
      if (recovered) {
        logRelay("v2-pairing-recovery", {
          endpoint: path,
          mode: pairing.mode,
          home_assistant_instance_id: logInstanceID(instanceID),
        });
        return { body, authorization: RESTRICTED_V2_PAIRING_RECOVERY };
      }
      throwV2PairingUnavailable(path, pairing.mode, instanceID);
    }
  }
  return { body };
}

async function v2PairingRecoveryAllowed(request, env, path, body) {
  try {
    requireInstanceIDVersion(body);
    const instanceID = requiredInstanceID(body);
    ensureStorage(env);
    const authRecord = await getJSON(env.TOKENS, instanceRelaySecretKey(instanceID));
    const legacy = authRecord ? await legacyInstanceSnapshot(authRecord) : null;

    if (path === "/v2/instances/provision") {
      const relaySecret = requiredLimitedString(body, "relay_shared_secret", 512).trim();
      if (relaySecret.length < 32) return false;
      const result = await callAuthState(env, instanceID, {
        action: "verify_instance_secret",
        provided_secret_hash: await sha256Hex(relaySecret),
        legacy_secret_hash: legacy?.secretHash,
        legacy_auth_protocol: legacy?.authProtocol,
        now: new Date().toISOString(),
      });
      return result.auth_protocol === "v2";
    }

    if (path === "/v2/pairing-tokens") {
      validateRegistrationPayload(body);
      const deviceID = requiredRoutingID(body, "device_id");
      const environment = requiredMatchingAPNsEnvironment(body, env);
      const providedSecret = requiredSecretHeaderValue(
        request,
        HA_SECRET_HEADER,
        "HA LiveKit relay secret"
      );
      const result = await callAuthState(env, instanceID, {
        action: "verify_pairing_recovery",
        provided_secret_hash: await sha256Hex(providedSecret),
        legacy_secret_hash: legacy?.secretHash,
        legacy_auth_protocol: legacy?.authProtocol,
        device_id: deviceID,
        environment,
        now: new Date().toISOString(),
      });
      return result.auth_protocol === "v2";
    }
  } catch (error) {
    if (!Number.isInteger(error?.status) || error.status >= 500) throw error;
    return false;
  }
  return false;
}

function throwV2PairingUnavailable(path, mode, instanceID) {
  logRelay("v2-pairing-unavailable", {
    endpoint: path,
    mode,
    home_assistant_instance_id: instanceID ? logInstanceID(instanceID) : undefined,
  });
  throw httpError(
    501,
    "relay_v2_unavailable",
    "Secure relay pairing is not available for this Home Assistant instance."
  );
}

async function relayReadiness(env) {
  const distributedRateLimitReady = rateLimitMode(env) !== "binding-required" || hasRateLimitBinding(env);
  const authState = await probeAuthStateReadiness(env);
  const strongAuthReady = authState.ready;
  const activityGenerationReady = Boolean(activityGenerationMode(env));
  const legacyAppAuthConfigured = String(env.HA_LIVEKIT_APP_SECRET || "").trim().length >= 32;
  const ready = Boolean(
    env.TOKENS
    && strongAuthReady
    && isAPNsConfigured(env)
    && isRelayEnabled(env)
    && legacyAppAuthConfigured
    && String(env.DEVICE_CREDENTIAL_PEPPER || "").trim().length >= 32
    && distributedRateLimitReady
    && activityGenerationReady
  );
  return {
    ready,
    distributedRateLimitReady,
    strongAuthReady,
    legacyAppAuthConfigured,
    authStateSchemaVersion: authState.schemaVersion,
    activityRegistrationGenerationSchemaVersion:
      authState.activityRegistrationGenerationSchemaVersion,
  };
}

async function probeAuthStateReadiness(env) {
  if (!env.AUTH_STATE) {
    return {
      ready: false,
      schemaVersion: null,
      activityRegistrationGenerationSchemaVersion: null,
      expiresAt: 0,
    };
  }
  const now = Date.now();
  const cached = authStateReadinessCache.get(env.AUTH_STATE);
  if (cached && cached.expiresAt > now) {
    return cached;
  }
  let ready = false;
  let schemaVersion = null;
  let activityRegistrationGenerationSchemaVersion = null;
  try {
    const result = await callAuthState(env, "relay-auth-health-v1", { action: "health" });
    schemaVersion = Number.isInteger(result.schema_version) ? result.schema_version : null;
    activityRegistrationGenerationSchemaVersion = Number.isInteger(
      result.activity_registration_generation_schema_version
    ) ? result.activity_registration_generation_schema_version : null;
    ready = schemaVersion === RELAY_AUTH_STATE_SCHEMA_VERSION
      && activityRegistrationGenerationSchemaVersion
        === ACTIVITY_REGISTRATION_GENERATION_SCHEMA_VERSION;
  } catch {
    ready = false;
  }
  const observed = {
    ready,
    schemaVersion,
    activityRegistrationGenerationSchemaVersion,
    expiresAt: now + 60_000,
  };
  authStateReadinessCache.set(env.AUTH_STATE, observed);
  return observed;
}

function isRelayMutationEndpoint(path) {
  return [
    "/register",
    "/provision-instance",
    "/activity-token",
    "/test-start",
    "/start",
    "/update",
    "/end",
    "/revoke-device",
    "/v2/instances/provision",
    "/v2/pairing-tokens",
    "/v2/register",
    "/v2/activity-token",
    "/v2/test-start",
    "/v2/unregister",
  ].includes(path);
}

function isActivityGenerationEndpoint(path) {
  return [
    "/activity-token",
    "/test-start",
    "/start",
    "/update",
    "/end",
    "/v2/activity-token",
    "/v2/test-start",
  ].includes(path);
}

function maxRequestBodyBytes(env) {
  return boundedInteger(env.MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_REQUEST_BODY_BYTES, 1024, 128 * 1024);
}

function deviceTTLSeconds(env) {
  return boundedInteger(env.DEVICE_TTL_SECONDS, DEFAULT_DEVICE_TTL_SECONDS, 60, 5 * 365 * 24 * 60 * 60);
}

function activityTTLSeconds(env) {
  return boundedInteger(env.ACTIVITY_TTL_SECONDS, DEFAULT_ACTIVITY_TTL_SECONDS, 60, 30 * 24 * 60 * 60);
}

function secretTTLSeconds(env) {
  return boundedInteger(env.SECRET_TTL_SECONDS, DEFAULT_SECRET_TTL_SECONDS, 24 * 60 * 60, 10 * 365 * 24 * 60 * 60);
}

function activityStateTTLSeconds(env) {
  return boundedInteger(
    env.ACTIVITY_STATE_TTL_SECONDS,
    DEFAULT_ACTIVITY_STATE_TTL_SECONDS,
    60,
    Math.min(activityTTLSeconds(env), 7 * 24 * 60 * 60)
  );
}

function pendingStartTTLSeconds(env) {
  return boundedInteger(env.PENDING_START_TTL_SECONDS, DEFAULT_PENDING_START_TTL_SECONDS, 60, 60 * 60);
}

function pairingTTLSeconds(env) {
  return boundedInteger(env.PAIRING_TTL_SECONDS, DEFAULT_PAIRING_TTL_SECONDS, 60, 15 * 60);
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return Math.min(max, Math.max(min, fallback));
  }
  return parsed;
}

function deviceKey(environment, instanceID, deviceID) {
  return `${devicePrefix(environment, instanceID)}${deviceID}`;
}

function devicePrefix(environment, instanceID) {
  return `token:${environment}:${instanceID}:device_`;
}

function activityKey(environment, instanceID, activityID, deviceID) {
  return `${activityPrefix(environment, instanceID, activityID)}${deviceID}`;
}

function activityGenerationKey(
  environment,
  instanceID,
  activityID,
  deviceID,
  activityRegistrationGeneration
) {
  return `activity-generation:${environment}:${instanceID}:${activityID}:device_${deviceID}:generation_${activityRegistrationGeneration}`;
}

function activityGenerationStateKey(
  environment,
  instanceID,
  activityID,
  deviceID,
  activityRegistrationGeneration
) {
  return `activity-state-generation:${environment}:${instanceID}:${activityID}:device_${deviceID}:generation_${activityRegistrationGeneration}`;
}

function activityStateKey(environment, instanceID, activityID, deviceID) {
  return `${activityStatePrefix(environment, instanceID, activityID)}${deviceID}`;
}

function activityStateInstancePrefix(environment, instanceID) {
  return `activity-state:${environment}:${instanceID}:`;
}

function activityStatePrefix(environment, instanceID, activityID) {
  return `${activityStateInstancePrefix(environment, instanceID)}${activityID}:device_`;
}

function activityInstancePrefix(environment, instanceID) {
  return `activity:${environment}:${instanceID}:`;
}

function activityPrefix(environment, instanceID, activityID) {
  return `activity:${environment}:${instanceID}:${activityID}:device_`;
}

function pendingStartKey(environment, instanceID, activityID, deviceID) {
  return `${pendingStartPrefix(environment, instanceID, activityID)}${deviceID}`;
}

function pendingStartInstancePrefix(environment, instanceID) {
  return `pending-start:${environment}:${instanceID}:`;
}

function pendingStartPrefix(environment, instanceID, activityID) {
  return `pending-start:${environment}:${instanceID}:${activityID}:device_`;
}

function instanceRelaySecretKey(instanceID) {
  return `secret:${instanceID}`;
}

function pairingTokenKey(tokenHash) {
  return `pairing:v2:${tokenHash}`;
}

function unixTimestamp() {
  return Math.floor(Date.now() / 1000);
}

function swiftDateNow() {
  return Number((Date.now() / 1000 - SWIFT_REFERENCE_DATE_UNIX_OFFSET).toFixed(3));
}

function pemToArrayBuffer(pem) {
  const base64 = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function base64URLJSON(value) {
  return base64URLBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64URLBytes(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(left, right) {
  const maxLength = Math.max(left.length, right.length);
  let mismatch = left.length === right.length ? 0 : 1;
  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function redactToken(token) {
  return token.length <= 12 ? "<redacted>" : `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function logInstanceID(instanceID) {
  if (!instanceID) return null;
  return instanceID.length <= 14 ? "<redacted-instance>" : `${instanceID.slice(0, 11)}...`;
}

function logID(value) {
  if (!value) return null;
  return value.length <= 12 ? "<redacted-id>" : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function logRelay(event, details) {
  console.log(JSON.stringify({
    component: "ha-livekit-apns-relay",
    event,
    ...details,
  }));
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
