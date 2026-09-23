import assert from "node:assert/strict";
import test from "node:test";

import worker, { RelayAuthState, startPayload as buildAPNsStartPayload } from "../src/index.js";

const APP_SECRET = "app-secret-for-tests-0123456789abcdef";
let testEnvironmentSequence = 0;

class MemoryKV {
  constructor() {
    this.values = new Map();
    this.putOptions = new Map();
    this.nextPutFailure = null;
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value, options = {}) {
    if (this.nextPutFailure?.predicate(key)) {
      const error = this.nextPutFailure.error;
      this.nextPutFailure = null;
      throw error;
    }
    this.values.set(key, value);
    this.putOptions.set(key, options);
  }

  failNextPut(predicate, error = new Error("Injected KV write failure.")) {
    this.nextPutFailure = { predicate, error };
  }

  async delete(key) {
    this.values.delete(key);
    this.putOptions.delete(key);
  }

  async list({ prefix = "", cursor } = {}) {
    const start = cursor ? Number(cursor) : 0;
    const names = [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
    const page = names.slice(start, start + 1000).map((name) => ({ name }));
    const next = start + page.length;
    return {
      keys: page,
      list_complete: next >= names.length,
      cursor: next >= names.length ? undefined : String(next),
    };
  }
}

class MemoryDurableStorage {
  constructor() {
    this.values = new Map();
    this.queue = Promise.resolve();
  }

  async get(key) {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list({ prefix = "" } = {}) {
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value)])
    );
  }

  async transaction(callback) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => { release = resolve; });
    await previous;
    const snapshot = structuredClone([...this.values.entries()]);
    try {
      return await callback(this);
    } catch (error) {
      this.values = new Map(snapshot);
      throw error;
    } finally {
      release();
    }
  }
}

class MemoryDurableObjectNamespace {
  constructor() {
    this.objects = new Map();
  }

  idFromName(name) {
    return name;
  }

  get(id) {
    if (!this.objects.has(id)) {
      this.objects.set(id, new RelayAuthState({ storage: new MemoryDurableStorage() }));
    }
    const object = this.objects.get(id);
    return {
      fetch(input, init) {
        return object.fetch(input instanceof Request ? input : new Request(input, init));
      },
    };
  }
}

function makeEnv(overrides = {}) {
  testEnvironmentSequence += 1;
  return {
    TOKENS: new MemoryKV(),
    AUTH_STATE: new MemoryDurableObjectNamespace(),
    APNS_MOCK: "true",
    APNS_ENVIRONMENT: "production",
    APPLE_TEAM_ID: "TEAMID1234",
    APPLE_KEY_ID: "KEYID12345",
    APPLE_PRIVATE_KEY: "unused-in-mock-mode",
    APP_BUNDLE_ID: "com.example.HALiveKit",
    HA_LIVEKIT_APP_SECRET: APP_SECRET,
    DEVICE_CREDENTIAL_PEPPER: "test-device-credential-pepper-0123456789abcdef",
    RELAY_ENABLED: "true",
    V2_PAIRING_MODE: "all",
    ACTIVITY_GENERATION_MODE: "authoritative",
    CF_VERSION_METADATA: {
      id: "11111111-2222-4333-8444-555555555555",
      tag: "test-worker-version",
      timestamp: "2026-08-15T00:00:00.000Z",
    },
    TEST_CLIENT_IP: `2001:db8::${testEnvironmentSequence}`,
    ...overrides,
  };
}

async function post(env, path, body, headers = {}, options = {}) {
  const data = body?.data;
  const representsEntitySet = data?.entity_based === true
    && data?.source_service === "set_activity";
  const request = new Request(`https://relay.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": env.TEST_CLIENT_IP,
      ...(representsEntitySet && options.authenticateEntitySet !== false
        ? { "X-HA-LiveKit-Operation": "entity-set-v1" }
        : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const response = await worker.fetch(request, env);
  return {
    status: response.status,
    body: await response.json(),
    headers: Object.fromEntries(response.headers.entries()),
  };
}

async function get(env, path, headers = {}) {
  const response = await worker.fetch(new Request(`https://relay.test${path}`, { headers }), env);
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function authStateAction(state, payload) {
  const response = await state.fetch(new Request("https://auth.test/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }));
  return { status: response.status, body: await response.json() };
}

async function register(env, { instanceID, deviceID, apnsMode = "production" }) {
  const response = await post(
    env,
    "/register",
    {
      device_id: deviceID,
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      push_to_start_token: `push-token-${instanceID}-${deviceID}`,
      apns_mode: apnsMode,
    },
    { "X-HA-LiveKit-App-Secret": APP_SECRET }
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.registered, true);
  assert.equal(response.body.relay_shared_secret, undefined);
  assert.equal(response.body.home_assistant_relay_token, undefined);
  return response.body;
}

function relaySecretFor(instanceID) {
  return `relay-secret-${instanceID.slice(3)}-0123456789abcdef`;
}

async function provisionInstance(env, { instanceID, secret = relaySecretFor(instanceID), currentSecret } = {}) {
  const body = {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    relay_shared_secret: secret,
  };
  if (currentSecret) {
    body.current_relay_shared_secret = currentSecret;
  }

  const response = await post(env, "/provision-instance", body, {
    "X-HA-LiveKit-App-Secret": APP_SECRET,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.provisioned, true);
  assert.equal(response.body.relay_shared_secret, undefined);
  assert.equal(response.body.home_assistant_relay_token, undefined);
  return secret;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function provisionInstanceV2(env, { instanceID, secret = relaySecretFor(instanceID), currentSecret } = {}) {
  const body = {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    relay_shared_secret: secret,
  };
  if (currentSecret) body.current_relay_shared_secret = currentSecret;
  return await post(env, "/v2/instances/provision", body);
}

async function pairAndRegisterV2(env, {
  instanceID,
  deviceID,
  secret = relaySecretFor(instanceID),
  pushToken = `v2-push-token-${instanceID}-${deviceID}`,
} = {}) {
  const provision = await provisionInstanceV2(env, { instanceID, secret });
  assert.equal(provision.status, 200, JSON.stringify(provision.body));

  const pairing = await post(
    env,
    "/v2/pairing-tokens",
    {
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      device_id: deviceID,
      push_to_start_token_hash: await sha256Hex(pushToken),
      apns_mode: "production",
      bundle_id: "com.example.HALiveKit",
      app_version: "2.0",
    },
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(pairing.status, 200, JSON.stringify(pairing.body));
  assert.equal(typeof pairing.body.pairing_token, "string");
  assert.equal(pairing.body.expires_in, 300);

  const registrationBody = {
    pairing_token: pairing.body.pairing_token,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token: pushToken,
    apns_mode: "production",
    bundle_id: "com.example.HALiveKit",
    app_version: "2.0",
  };
  const registration = await post(env, "/v2/register", registrationBody);
  assert.equal(registration.status, 200, JSON.stringify(registration.body));
  assert.equal(registration.body.registered, true);
  assert.equal(typeof registration.body.device_credential, "string");
  assert.ok(registration.body.device_credential.length >= 32);
  return {
    secret,
    pushToken,
    pairingToken: pairing.body.pairing_token,
    deviceCredential: registration.body.device_credential,
    registrationBody,
  };
}

test("Durable Object ticket issuance advertises v2 without prematurely upgrading the instance", async () => {
  const state = new RelayAuthState({ storage: new MemoryDurableStorage() });
  const now = new Date().toISOString();
  const secretHash = await sha256Hex("authoritative-instance-secret");
  const provisionResponse = await state.fetch(new Request("https://auth.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "provision_instance",
      new_secret_hash: secretHash,
      requested_protocol: "v2",
      maximum_devices: 32,
      now,
    }),
  }));
  assert.equal(provisionResponse.status, 200);
  const provisionBody = await provisionResponse.json();
  assert.equal(provisionBody.auth_protocol, "v2");
  assert.equal(provisionBody.effective_auth_protocol, "v1");

  const ticketResponse = await state.fetch(new Request("https://auth.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "issue_ticket",
      provided_secret_hash: secretHash,
      ticket_hash: await sha256Hex("ticket"),
      device_id: "device-authoritative",
      environment: "production",
      push_token_hash: await sha256Hex("push"),
      device_credential_hash: await sha256Hex("credential"),
      expires_at_ms: Date.now() + 300_000,
      now,
    }),
  }));
  assert.equal(ticketResponse.status, 200);
  const ticketBody = await ticketResponse.json();
  assert.equal(ticketBody.auth_protocol, "v2");
  assert.equal(ticketBody.effective_auth_protocol, "v1");
});

test("Durable Object returns every authoritative activity allowed by the Worker quota", async () => {
  const storage = new MemoryDurableStorage();
  const state = new RelayAuthState({ storage });
  const nowMs = Date.now();
  await storage.put("activity-authority", {
    enabled: true,
    schema_version: 1,
    enabled_at_ms: nowMs,
  });
  for (let index = 0; index < 513; index += 1) {
    const activityID = `route-${index}`;
    await storage.put(`activity-current:production:device-cap:${activityID}`, {
      environment: "production",
      device_id: "device-cap",
      activity_id: activityID,
      activity_registration_generation: `ar_${String(index).padStart(22, "a")}`,
      auth_protocol: "v1",
      auth_generation: 0,
      status: "active",
      storage_kind: "generation",
      activation_sequence: 1,
      activated_at_ms: nowMs,
      updated_at_ms: nowMs,
      expires_at_ms: nowMs + 60_000,
    });
  }

  const response = await state.fetch(new Request("https://auth.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "current_activity_registrations",
      environment: "production",
      now_ms: nowMs,
    }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.activities.length, 513);
});

test("Durable Object rejects activation beyond the Worker activity quota ceiling", async () => {
  const storage = new MemoryDurableStorage();
  const state = new RelayAuthState({ storage });
  const nowMs = Date.now();
  await storage.put("activity-authority", {
    enabled: true,
    schema_version: 1,
    enabled_at_ms: nowMs,
  });
  for (let index = 0; index < 2048; index += 1) {
    const activityID = `capacity-${index}`;
    await storage.put(`activity-current:production:device-cap:${activityID}`, {
      environment: "production",
      device_id: "device-cap",
      activity_id: activityID,
      activity_registration_generation: `ar_${String(index).padStart(22, "a")}`,
      auth_protocol: "v1",
      auth_generation: 0,
      status: "active",
      storage_kind: "generation",
      activation_sequence: 1,
      activated_at_ms: nowMs,
      updated_at_ms: nowMs,
      expires_at_ms: nowMs + 60_000,
    });
  }

  const response = await state.fetch(new Request("https://auth.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "activate_activity_registration",
      environment: "production",
      device_id: "device-cap",
      activity_id: "over-capacity",
      activity_registration_generation: "ar_zzzzzzzzzzzzzzzzzzzzzz",
      auth_protocol: "v1",
      auth_generation: 0,
      now_ms: nowMs,
      expires_at_ms: nowMs + 60_000,
    }),
  }));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, "activity_state_capacity_exceeded");
});

for (const replacement of ["stale", "expired"]) {
  test(`Durable Object capacity check rejects activation through a ${replacement} pointer slot`, async () => {
    const storage = new MemoryDurableStorage();
    const state = new RelayAuthState({ storage });
    const nowMs = Date.now();
    await storage.put("activity-authority", {
      enabled: true,
      schema_version: 1,
      enabled_at_ms: nowMs,
    });
    for (let index = 0; index < 2048; index += 1) {
      const activityID = `active-${index}`;
      await storage.put(`activity-current:production:device-cap:${activityID}`, {
        environment: "production",
        device_id: "device-cap",
        activity_id: activityID,
        activity_registration_generation: `ar_${String(index).padStart(22, "b")}`,
        auth_protocol: "v1",
        auth_generation: 0,
        status: "active",
        storage_kind: "generation",
        activation_sequence: 1,
        activated_at_ms: nowMs,
        updated_at_ms: nowMs,
        expires_at_ms: nowMs + 60_000,
      });
    }
    await storage.put("activity-current:production:device-cap:replacement", {
      environment: "production",
      device_id: "device-cap",
      activity_id: "replacement",
      activity_registration_generation: "ar_cccccccccccccccccccccc",
      auth_protocol: "v1",
      auth_generation: 0,
      status: replacement === "stale" ? "stale" : "active",
      storage_kind: "generation",
      activation_sequence: 1,
      activated_at_ms: nowMs - 60_000,
      updated_at_ms: nowMs - 60_000,
      expires_at_ms: replacement === "expired" ? nowMs - 1 : nowMs + 60_000,
    });

    const response = await state.fetch(new Request("https://auth.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "activate_activity_registration",
        environment: "production",
        device_id: "device-cap",
        activity_id: "replacement",
        activity_registration_generation: "ar_dddddddddddddddddddddd",
        auth_protocol: "v1",
        auth_generation: 0,
        now_ms: nowMs,
        expires_at_ms: nowMs + 60_000,
      }),
    }));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, "activity_state_capacity_exceeded");
  });
}

test("health readiness requires strong auth, credential derivation, and rate-limit bindings", async () => {
  const healthy = await get(makeEnv(), "/health");
  assert.equal(healthy.status, 200);
  assert.equal(healthy.body.ok, true);
  assert.equal(healthy.body.ready, true);
  assert.equal(healthy.body.apns_mock, true);
  assert.equal(healthy.body.worker_version_id, "11111111-2222-4333-8444-555555555555");
  assert.equal(healthy.body.worker_version_tag, "test-worker-version");
  assert.equal(healthy.body.strongly_consistent_auth_configured, true);
  assert.equal(healthy.body.strongly_consistent_auth_ready, true);
  assert.equal(healthy.body.auth_state_schema_version, 2);
  assert.equal(healthy.body.activity_registration_generation_schema_version, 1);
  assert.equal(healthy.body.activity_generation_schema, "auth_state_current_generation_v1");
  assert.equal(healthy.body.activity_generation_mode, "authoritative");
  assert.equal(healthy.body.activity_route_authority, "auth_state_current_generation_v1");
  assert.equal(healthy.body.minimum_safe_rollback_auth_state_schema_version, 2);
  assert.equal(healthy.body.pre_schema_rollback_safe, false);
  assert.equal(healthy.body.v2_device_auth_configured, true);
  assert.equal(healthy.body.v2_pairing_mode, "all");
  assert.equal(healthy.body.v2_pairing_enabled, true);
  assert.equal(healthy.body.v2_pairing_allowlist_configured, false);
  assert.equal(healthy.body.v2_pairing_allowlist_count, 0);
  assert.equal(healthy.body.legacy_app_auth_configured, true);
  assert.equal(healthy.body.distributed_rate_limit_ready, true);

  const missingAuth = await get(makeEnv({ AUTH_STATE: undefined }), "/health");
  assert.equal(missingAuth.body.ok, true);
  assert.equal(missingAuth.body.ready, false);
  assert.equal(missingAuth.body.strongly_consistent_auth_configured, false);
  assert.equal(missingAuth.body.strongly_consistent_auth_ready, false);

  const unreachableAuth = await get(makeEnv({
    AUTH_STATE: {
      idFromName() {
        throw new Error("unreachable");
      },
    },
  }), "/health");
  assert.equal(unreachableAuth.body.strongly_consistent_auth_configured, true);
  assert.equal(unreachableAuth.body.strongly_consistent_auth_ready, false);
  assert.equal(unreachableAuth.body.ready, false);

  const missingPepper = await get(makeEnv({ DEVICE_CREDENTIAL_PEPPER: "" }), "/health");
  assert.equal(missingPepper.body.ready, false);
  assert.equal(missingPepper.body.v2_device_auth_configured, false);

  const missingLegacyAppSecret = await get(makeEnv({ HA_LIVEKIT_APP_SECRET: "" }), "/health");
  assert.equal(missingLegacyAppSecret.body.ready, false);
  assert.equal(missingLegacyAppSecret.body.legacy_app_auth_configured, false);

  const missingDistributedLimiter = await get(makeEnv({ RATE_LIMIT_MODE: "binding-required" }), "/health");
  assert.equal(missingDistributedLimiter.body.ready, false);
  assert.equal(missingDistributedLimiter.body.distributed_rate_limit_ready, false);
});

test("activity generation mode is explicit and invalid configuration fails closed", async () => {
  const compatible = await get(makeEnv({ ACTIVITY_GENERATION_MODE: "compatible" }), "/health");
  assert.equal(compatible.body.ready, true);
  assert.equal(compatible.body.activity_generation_schema, "auth_state_current_generation_v1");
  assert.equal(compatible.body.activity_generation_mode, "compatible");
  assert.equal(compatible.body.activity_route_authority, "sticky_per_instance_compatibility_v1");
  assert.equal(compatible.body.pre_schema_rollback_safe, false);

  for (const configuredMode of [undefined, "unexpected"]) {
    const env = makeEnv({ ACTIVITY_GENERATION_MODE: configuredMode });
    const health = await get(env, "/health");
    assert.equal(health.body.ready, false);
    assert.equal(health.body.activity_generation_mode, null);
    const instanceID = configuredMode
      ? "ha_3c1c3c1c3c1c3c1c3c1c3c1c3c1c3c1c"
      : "ha_3c2c3c2c3c2c3c2c3c2c3c2c3c2c3c2c";
    await register(env, { instanceID, deviceID: "device-a" });
    const secret = await provisionInstance(env, { instanceID });
    const start = await post(env, "/start", startPayload(instanceID), {
      "X-HA-LiveKit-Secret": secret,
    });
    assert.equal(start.status, 503, JSON.stringify(start.body));
    assert.equal(start.body.error, "activity_generation_mode_invalid");
  }
});

test("v2 pairing mode fails closed when missing or invalid while v1 remains available", async () => {
  for (const configuredMode of [undefined, "unexpected-mode"]) {
    const env = makeEnv({ V2_PAIRING_MODE: configuredMode });
    const instanceID = configuredMode
      ? "ha_b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"
      : "ha_b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
    const secret = relaySecretFor(instanceID);

    const provision = await provisionInstanceV2(env, { instanceID, secret });
    assert.equal(provision.status, 501);
    assert.equal(provision.body.error, "relay_v2_unavailable");
    const pairing = await post(env, "/v2/pairing-tokens", {
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      device_id: "blocked-device",
      push_to_start_token_hash: await sha256Hex("blocked-push-token-0123456789"),
      apns_mode: "production",
    }, { "X-HA-LiveKit-Secret": secret });
    assert.equal(pairing.status, 501);
    assert.equal(pairing.body.error, "relay_v2_unavailable");
    assert.equal(env.TOKENS.values.size, 0);
    for (const object of env.AUTH_STATE.objects.values()) {
      assert.equal(object.storage.values.size, 0);
    }

    await register(env, { instanceID, deviceID: "legacy-device" });
    const legacySecret = await provisionInstance(env, { instanceID, secret });
    const start = await post(env, "/start", startPayload(instanceID), {
      "X-HA-LiveKit-Secret": legacySecret,
    });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const health = await get(env, "/health");
    assert.equal(health.body.v2_pairing_mode, "off");
    assert.equal(health.body.v2_pairing_enabled, false);
  }
});

test("v2 pairing allowlist accepts only hashed canonical instance identities", async () => {
  const allowedInstanceID = "ha_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
  const rejectedInstanceID = "ha_b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3";
  const allowedHash = await sha256Hex(allowedInstanceID);
  const env = makeEnv({
    V2_PAIRING_MODE: "allowlist",
    V2_PAIRING_CANARY_INSTANCE_HASHES: `invalid, ${allowedHash.toUpperCase()} ${allowedHash}`,
  });

  const rejectedProvision = await provisionInstanceV2(env, {
    instanceID: rejectedInstanceID,
  });
  assert.equal(rejectedProvision.status, 501);
  assert.equal(rejectedProvision.body.error, "relay_v2_unavailable");
  const rejectedPairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: rejectedInstanceID,
    instance_id_version: 2,
    device_id: "rejected-device",
    push_to_start_token_hash: await sha256Hex("rejected-push-token-0123456789"),
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": relaySecretFor(rejectedInstanceID) });
  assert.equal(rejectedPairing.status, 501);
  assert.equal(rejectedPairing.body.error, "relay_v2_unavailable");
  assert.equal(env.TOKENS.values.size, 0);
  assert.equal(env.AUTH_STATE.objects.get(rejectedInstanceID).storage.values.size, 0);

  const allowed = await pairAndRegisterV2(env, {
    instanceID: allowedInstanceID,
    deviceID: "allowed-device",
  });
  assert.equal(typeof allowed.deviceCredential, "string");
  assert.equal(env.AUTH_STATE.objects.get(rejectedInstanceID).storage.values.size, 0);
  assert.equal(await env.TOKENS.get(`secret:${rejectedInstanceID}`), null);

  const health = await get(env, "/health");
  assert.equal(health.body.v2_pairing_mode, "allowlist");
  assert.equal(health.body.v2_pairing_enabled, true);
  assert.equal(health.body.v2_pairing_allowlist_configured, true);
  assert.equal(health.body.v2_pairing_allowlist_count, 1);
  assert.equal(JSON.stringify(health.body).includes(allowedHash), false);
});

test("v2 pairing allowlist with no valid hashes remains closed", async () => {
  const env = makeEnv({
    V2_PAIRING_MODE: "allowlist",
    V2_PAIRING_CANARY_INSTANCE_HASHES: "not-a-hash, still-not-a-hash",
  });
  const instanceID = "ha_b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4";
  const provision = await provisionInstanceV2(env, { instanceID });
  assert.equal(provision.status, 501);
  assert.equal(provision.body.error, "relay_v2_unavailable");

  const health = await get(env, "/health");
  assert.equal(health.body.v2_pairing_mode, "allowlist");
  assert.equal(health.body.v2_pairing_enabled, false);
  assert.equal(health.body.v2_pairing_allowlist_configured, false);
  assert.equal(health.body.v2_pairing_allowlist_count, 0);
});

test("all v2 pairing modes remain behind the endpoint rate limiter", async () => {
  for (const configuredMode of [undefined, "invalid", "off", "allowlist", "all"]) {
    const env = makeEnv({
      V2_PAIRING_MODE: configuredMode,
      RATE_LIMIT_MODE: "binding-required",
      RATE_LIMITER: { async limit() { return { success: false }; } },
    });
    const response = await post(env, "/v2/instances/provision", {});
    assert.equal(response.status, 429);
    assert.equal(response.body.error, "rate_limited");
    assert.equal(env.TOKENS.values.size, 0);
    assert.equal(env.AUTH_STATE.objects.size, 0);
  }
});

test("an interrupted v2 pairing leaves v1 fallback usable until ticket consumption", async () => {
  const env = makeEnv({ V2_PAIRING_MODE: "all" });
  const instanceID = "ha_b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6";
  const secret = relaySecretFor(instanceID);

  const provision = await provisionInstanceV2(env, { instanceID, secret });
  assert.equal(provision.status, 200, JSON.stringify(provision.body));
  assert.equal(provision.body.auth_protocol, "v2");
  assert.equal(
    JSON.parse(await env.TOKENS.get(`secret:${instanceID}`)).auth_protocol,
    "v1"
  );

  env.V2_PAIRING_MODE = "off";
  const blockedPairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "pending-secure-device",
    push_to_start_token_hash: await sha256Hex("pending-secure-push-token-0123456789"),
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": secret });
  assert.equal(blockedPairing.status, 501);

  await register(env, { instanceID, deviceID: "legacy-fallback-device" });
  const legacyDelivery = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(legacyDelivery.status, 200, JSON.stringify(legacyDelivery.body));

  env.V2_PAIRING_MODE = "all";
  const securePushToken = "pending-secure-push-token-0123456789";
  const pairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "pending-secure-device",
    push_to_start_token_hash: await sha256Hex(securePushToken),
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": secret });
  assert.equal(pairing.status, 200, JSON.stringify(pairing.body));
  assert.equal(
    JSON.parse(await env.TOKENS.get(`secret:${instanceID}`)).auth_protocol,
    "v1"
  );
  await register(env, { instanceID, deviceID: "legacy-before-consume" });

  const secureRegistration = await post(env, "/v2/register", {
    pairing_token: pairing.body.pairing_token,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "pending-secure-device",
    push_to_start_token: securePushToken,
    apns_mode: "production",
  });
  assert.equal(secureRegistration.status, 200, JSON.stringify(secureRegistration.body));
  assert.equal(
    JSON.parse(await env.TOKENS.get(`secret:${instanceID}`)).auth_protocol,
    "v2"
  );

  const freshLegacy = await post(env, "/register", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "fresh-legacy-device",
    push_to_start_token: "fresh-legacy-push-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(freshLegacy.status, 409);
  assert.equal(freshLegacy.body.error, "instance_requires_v2");
});

test("turning v2 pairing off preserves issued tickets and existing credential operations", async () => {
  const env = makeEnv({ V2_PAIRING_MODE: "all" });
  const instanceID = "ha_b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5";
  const deviceID = "transition-device";
  const secret = relaySecretFor(instanceID);
  const pushToken = `transition-push-token-${instanceID}`;
  const provision = await provisionInstanceV2(env, { instanceID, secret });
  assert.equal(provision.status, 200, JSON.stringify(provision.body));
  const pairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token_hash: await sha256Hex(pushToken),
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": secret });
  assert.equal(pairing.status, 200, JSON.stringify(pairing.body));

  env.V2_PAIRING_MODE = "off";
  const registration = await post(env, "/v2/register", {
    pairing_token: pairing.body.pairing_token,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token: pushToken,
    apns_mode: "production",
  });
  assert.equal(registration.status, 200, JSON.stringify(registration.body));
  const credential = registration.body.device_credential;
  const credentialHeaders = { "X-HA-LiveKit-Device-Credential": credential };

  const refresh = await post(env, "/v2/register", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token: `${pushToken}-refreshed`,
    apns_mode: "production",
  }, credentialHeaders);
  assert.equal(refresh.status, 200, JSON.stringify(refresh.body));

  const activity = await post(env, "/v2/activity-token", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    activity_id: "transition_activity",
    update_token: "transition-update-token-0123456789",
    apns_mode: "production",
  }, credentialHeaders);
  assert.equal(activity.status, 200, JSON.stringify(activity.body));

  const testStart = await post(env, "/v2/test-start", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    activity_id: "transition_test",
    title: "HA LiveKit",
    state: "Testing",
    apns_mode: "production",
  }, credentialHeaders);
  assert.equal(testStart.status, 200, JSON.stringify(testStart.body));

  const delivery = await post(env, "/start", startPayload(instanceID, {
    activity_id: "transition_delivery",
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(delivery.status, 200, JSON.stringify(delivery.body));

  const inventory = await get(
    env,
    `/v2/devices?home_assistant_instance_id=${instanceID}&apns_mode=production`,
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(inventory.status, 200, JSON.stringify(inventory.body));
  assert.equal(inventory.body.devices.some((device) => device.device_id === deviceID), true);

  const unregister = await post(env, "/v2/unregister", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    apns_mode: "production",
  }, credentialHeaders);
  assert.equal(unregister.status, 200, JSON.stringify(unregister.body));

  const health = await get(env, "/health");
  assert.equal(health.body.v2_pairing_mode, "off");
  assert.equal(health.body.v2_pairing_enabled, false);
});

test("off mode recovers an already-upgraded device after a post-consume KV failure", async () => {
  const env = makeEnv({ V2_PAIRING_MODE: "all" });
  const instanceID = "ha_b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7";
  const deviceID = "response-loss-device";
  const secret = relaySecretFor(instanceID);
  const firstPushToken = "response-loss-push-token-0123456789";
  const provision = await provisionInstanceV2(env, { instanceID, secret });
  assert.equal(provision.status, 200, JSON.stringify(provision.body));
  const pairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token_hash: await sha256Hex(firstPushToken),
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": secret });
  assert.equal(pairing.status, 200, JSON.stringify(pairing.body));

  const deviceStorageKey = `token:production:${instanceID}:device_${deviceID}`;
  env.TOKENS.failNextPut((key) => key === deviceStorageKey);
  const interruptedRegistration = await post(env, "/v2/register", {
    pairing_token: pairing.body.pairing_token,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token: firstPushToken,
    apns_mode: "production",
  });
  assert.equal(interruptedRegistration.status, 500);
  assert.equal(await env.TOKENS.get(deviceStorageKey), null);

  await env.TOKENS.delete(`secret:${instanceID}`);
  env.V2_PAIRING_MODE = "off";
  const recoveryProvision = await provisionInstanceV2(env, {
    instanceID,
    secret,
    currentSecret: secret,
  });
  assert.equal(recoveryProvision.status, 200, JSON.stringify(recoveryProvision.body));

  const recoveryPushToken = "response-loss-recovery-push-0123456789";
  const recoveryPairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token_hash: await sha256Hex(recoveryPushToken),
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": secret });
  assert.equal(recoveryPairing.status, 200, JSON.stringify(recoveryPairing.body));
  const recovered = await post(env, "/v2/register", {
    pairing_token: recoveryPairing.body.pairing_token,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token: recoveryPushToken,
    apns_mode: "production",
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(typeof recovered.body.device_credential, "string");
  assert.equal(JSON.parse(await env.TOKENS.get(deviceStorageKey)).auth_protocol, "v2");

  const unrelatedAllowlistedID = "ha_b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9";
  env.V2_PAIRING_MODE = "allowlist";
  env.V2_PAIRING_CANARY_INSTANCE_HASHES = await sha256Hex(unrelatedAllowlistedID);
  await env.TOKENS.put(`secret:${instanceID}`, JSON.stringify({ malformed: true }));
  const allowlistRecoveryProvision = await provisionInstanceV2(env, {
    instanceID,
    secret,
    currentSecret: secret,
  });
  assert.equal(
    allowlistRecoveryProvision.status,
    200,
    JSON.stringify(allowlistRecoveryProvision.body)
  );
  const allowlistRecoveryPairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token_hash: await sha256Hex("allowlist-recovery-push-0123456789"),
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": secret });
  assert.equal(
    allowlistRecoveryPairing.status,
    200,
    JSON.stringify(allowlistRecoveryPairing.body)
  );

  const newInstanceID = "ha_b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8";
  const blockedNewInstance = await provisionInstanceV2(env, { instanceID: newInstanceID });
  assert.equal(blockedNewInstance.status, 501);
  assert.equal(blockedNewInstance.body.error, "relay_v2_unavailable");
  assert.equal(await env.TOKENS.get(`secret:${newInstanceID}`), null);
});

test("restricted off and excluded-allowlist recovery cannot race an HA revoke", async () => {
  const cases = [
    {
      mode: "off",
      instanceID: "ha_c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
    },
    {
      mode: "allowlist",
      instanceID: "ha_c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4",
    },
  ];

  for (const { mode, instanceID } of cases) {
    const env = makeEnv({ V2_PAIRING_MODE: "all" });
    const deviceID = `${mode}-recovery-race-device`;
    const paired = await pairAndRegisterV2(env, { instanceID, deviceID });
    const authStorage = env.AUTH_STATE.objects.get(instanceID).storage;
    const ticketCountBefore = [...authStorage.values.keys()]
      .filter((key) => key.startsWith("ticket:"))
      .length;
    const pairingRecordCountBefore = [...env.TOKENS.values.keys()]
      .filter((key) => key.startsWith("pairing:"))
      .length;

    env.V2_PAIRING_MODE = mode;
    if (mode === "allowlist") {
      env.V2_PAIRING_CANARY_INSTANCE_HASHES = await sha256Hex(
        "ha_c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5"
      );
    }

    const originalGet = env.AUTH_STATE.get.bind(env.AUTH_STATE);
    const secretHash = await sha256Hex(paired.secret);
    let revokeInjected = false;
    env.AUTH_STATE.get = (id) => {
      const stub = originalGet(id);
      return {
        async fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          const payload = await request.clone().json();
          const response = await stub.fetch(request);
          if (
            !revokeInjected
            && id === instanceID
            && payload.action === "verify_pairing_recovery"
            && response.ok
          ) {
            revokeInjected = true;
            const revoked = await stub.fetch(new Request("https://relay-auth-state.internal/action", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "revoke_device_by_ha",
                provided_secret_hash: secretHash,
                device_id: deviceID,
                environment: "production",
                now: new Date().toISOString(),
              }),
            }));
            assert.equal(revoked.status, 200);
          }
          return response;
        },
      };
    };

    const recoveryPushToken = `${mode}-recovery-race-push-token-0123456789`;
    const recoveryPairing = await post(env, "/v2/pairing-tokens", {
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      device_id: deviceID,
      push_to_start_token_hash: await sha256Hex(recoveryPushToken),
      apns_mode: "production",
      restricted_recovery: false,
    }, { "X-HA-LiveKit-Secret": paired.secret });
    assert.equal(revokeInjected, true);
    assert.equal(recoveryPairing.status, 409);
    assert.equal(recoveryPairing.body.error, "pairing_recovery_unavailable");
    assert.equal(authStorage.values.get(`device:production:${deviceID}`).status, "revoked");
    assert.equal(
      [...authStorage.values.keys()].filter((key) => key.startsWith("ticket:")).length,
      ticketCountBefore
    );
    assert.equal(
      [...env.TOKENS.values.keys()].filter((key) => key.startsWith("pairing:")).length,
      pairingRecordCountBefore
    );
  }
});

async function registerActivity(env, {
  instanceID,
  deviceID,
  activityID,
  displayName,
  entityID,
  state = "Open",
  updateToken = `update-token-${instanceID}-${activityID}-${deviceID}`,
  activityKitID = `kit-${instanceID}-${activityID}-${deviceID}`,
  assertStatus = true,
}) {
  const pendingText = await env.TOKENS.get(
    `pending-start:production:${instanceID}:${activityID}:device_${deviceID}`
  );
  const pending = pendingText ? JSON.parse(pendingText) : null;
  const resolvedDisplayName = displayName
    || pending?.display_name
    || pending?.last_content_state?.displayName
    || "Front Door";
  const resolvedEntityID = entityID
    || pending?.entity_id
    || pending?.last_content_state?.entityId
    || `ha_livekit.${activityID}`;
  const response = await post(
    env,
    "/activity-token",
    {
      device_id: deviceID,
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      activity_id: activityID,
      activity_kit_id: activityKitID,
      update_token: updateToken,
      display_name: resolvedDisplayName,
      content_state: {
        title: resolvedDisplayName,
        subtitle: state,
        displayName: resolvedDisplayName,
        entityId: resolvedEntityID,
        primaryState: state,
        secondaryState: null,
        progress: null,
        value: state,
        unit: null,
        iconName: "dot.radiowaves.left.and.right",
        theme: "homeAssistant",
        displayStyle: "compactStatus",
        lastUpdated: 12345,
      },
      apns_mode: "production",
    },
    { "X-HA-LiveKit-App-Secret": APP_SECRET }
  );
  if (assertStatus) assert.equal(response.status, 200, JSON.stringify(response.body));
  return response;
}

function injectActivityRegistrationBeforeNextAuthAction(
  env,
  action,
  registration,
  staleCompatibilityRecord = null
) {
  const originalGet = env.AUTH_STATE.get.bind(env.AUTH_STATE);
  let injected = false;
  env.AUTH_STATE.get = (id) => {
    const stub = originalGet(id);
    return {
      async fetch(input, init) {
        const request = input instanceof Request ? input : new Request(input, init);
        const payload = await request.clone().json();
        if (!injected && payload.action === action) {
          injected = true;
          await registerActivity(env, { ...registration, assertStatus: false });
          if (staleCompatibilityRecord) {
            await env.TOKENS.put(
              `activity:production:${registration.instanceID}:${registration.activityID}:device_${registration.deviceID}`,
              staleCompatibilityRecord,
              { expirationTtl: 600 }
            );
          }
        }
        return await stub.fetch(request);
      },
    };
  };
  return () => injected;
}

function injectActivityRegistrationBeforeNextStaleMark(
  env,
  registration,
  staleCompatibilityRecord = null
) {
  return injectActivityRegistrationBeforeNextAuthAction(
    env,
    "mark_activity_stale",
    registration,
    staleCompatibilityRecord
  );
}

function injectActivityRegistrationAfterNextStaleMark(env, registration, afterRegistration) {
  const originalGet = env.AUTH_STATE.get.bind(env.AUTH_STATE);
  let injected = false;
  env.AUTH_STATE.get = (id) => {
    const stub = originalGet(id);
    return {
      async fetch(input, init) {
        const request = input instanceof Request ? input : new Request(input, init);
        const payload = await request.clone().json();
        const response = await stub.fetch(request);
        if (!injected && payload.action === "mark_activity_stale") {
          injected = true;
          await registerActivity(env, { ...registration, assertStatus: false });
          if (afterRegistration) await afterRegistration();
        }
        return response;
      },
    };
  };
  return () => injected;
}

function injectActivityRegistrationAfterNextAuthAction(env, action, registration) {
  const originalGet = env.AUTH_STATE.get.bind(env.AUTH_STATE);
  let injected = false;
  env.AUTH_STATE.get = (id) => {
    const stub = originalGet(id);
    return {
      async fetch(input, init) {
        const request = input instanceof Request ? input : new Request(input, init);
        const payload = await request.clone().json();
        const response = await stub.fetch(request);
        if (!injected && payload.action === action) {
          injected = true;
          await registerActivity(env, { ...registration, assertStatus: false });
        }
        return response;
      },
    };
  };
  return () => injected;
}

async function authoritativeActivityLocation(env, instanceID, deviceID, activityID) {
  const pointer = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `activity-current:production:${deviceID}:${activityID}`
  );
  assert.ok(pointer, "expected an authoritative activity pointer");
  const key = `activity-generation:production:${instanceID}:${activityID}:device_${deviceID}:generation_${pointer.activity_registration_generation}`;
  return { pointer, key };
}

async function mutateAuthoritativeActivityRecord(
  env,
  instanceID,
  deviceID,
  activityID,
  mutate
) {
  const location = await authoritativeActivityLocation(env, instanceID, deviceID, activityID);
  const record = JSON.parse(await env.TOKENS.get(location.key));
  mutate(record);
  await env.TOKENS.put(location.key, JSON.stringify(record), { expirationTtl: 600 });
  return { ...location, record };
}

function startPayload(instanceID, overrides = {}) {
  return {
    home_assistant_instance_id: instanceID,
    apns_mode: "production",
    activity_id: "front_door",
    entity_id: "binary_sensor.front_door",
    title: "Front Door",
    state: "Open",
    ...overrides,
  };
}

test("HA entity-control opt-in is encoded into remote start attributes", () => {
  const instanceID = "ha_10101010101010101010101010101010";
  const payload = buildAPNsStartPayload(
    startPayload(instanceID, {
      entity_id: "light.desk",
      allow_entity_control: true,
      entityControlHomeAssistantInstanceId: "ha_attacker_supplied_identity",
    }),
    makeEnv()
  );

  assert.equal(payload.aps.attributes.allowsEntityControl, true);
  assert.equal(payload.aps.attributes.homeAssistantInstanceId, instanceID);
  assert.equal(
    payload.aps.attributes.entityControlHomeAssistantInstanceId,
    instanceID
  );
});

test("remote entity controls are omitted without a valid controllable entity opt-in", () => {
  const instanceID = "ha_20202020202020202020202020202020";
  for (const overrides of [
    { entity_id: "light.desk" },
    { entity_id: "light.desk", allow_entity_control: false },
    { entity_id: "sensor.temperature", allow_entity_control: true },
  ]) {
    const payload = buildAPNsStartPayload(
      startPayload(instanceID, overrides),
      makeEnv()
    );
    assert.equal(payload.aps.attributes.homeAssistantInstanceId, instanceID);
    assert.equal(payload.aps.attributes.allowsEntityControl, undefined);
    assert.equal(
      payload.aps.attributes.entityControlHomeAssistantInstanceId,
      undefined
    );
  }
});

test("remote start always binds its general tenant origin to the canonical request identity", () => {
  const instanceID = "ha_21212121212121212121212121212121";
  const payload = buildAPNsStartPayload(
    startPayload(instanceID, {
      homeAssistantInstanceId: "ha_attacker_supplied_identity",
      allow_entity_control: false,
    }),
    makeEnv()
  );

  assert.equal(payload.aps.attributes.homeAssistantInstanceId, instanceID);
  assert.equal(payload.aps.attributes.allowsEntityControl, undefined);
  assert.equal(
    payload.aps.attributes.entityControlHomeAssistantInstanceId,
    undefined
  );
});

test("relay rejects invalid entity-control field types and unsupported domains", async () => {
  const env = makeEnv();
  const instanceID = "ha_30303030303030303030303030303030";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });

  const invalidType = await post(
    env,
    "/start",
    startPayload(instanceID, {
      entity_id: "light.desk",
      allow_entity_control: "yes",
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(invalidType.status, 400);
  assert.equal(invalidType.body.error, "invalid_field_type");

  const unsupported = await post(
    env,
    "/start",
    startPayload(instanceID, {
      entity_id: "sensor.temperature",
      allow_entity_control: true,
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error, "invalid_entity_control");
});

test("canonical encoded Unicode activity ids route while raw unsafe ids fail closed", async () => {
  const env = makeEnv();
  const instanceID = "ha_31313131313131313131313131313131";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  const canonicalID = `~${Buffer.from("hadibeartık", "utf8").toString("base64url")}`;

  const canonical = await post(
    env,
    "/start",
    startPayload(instanceID, { activity_id: canonicalID }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(canonical.status, 200, JSON.stringify(canonical.body));
  assert.equal(canonical.body.started, 1);
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: canonicalID,
    updateToken: "canonical-update-token-0123456789",
  });
  const update = await post(
    env,
    "/update",
    startPayload(instanceID, { activity_id: canonicalID, state: "Updated" }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.equal(update.body.delivered, 1);
  const end = await post(
    env,
    "/end",
    startPayload(instanceID, { activity_id: canonicalID }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(end.status, 200, JSON.stringify(end.body));
  assert.equal(end.body.delivered, 1);

  const literalCanonicalID = `~${Buffer.from(canonicalID, "utf8").toString("base64url")}`;
  assert.notEqual(literalCanonicalID, canonicalID);
  const literalStart = await post(
    env,
    "/start",
    startPayload(instanceID, { activity_id: literalCanonicalID }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(literalStart.status, 200, JSON.stringify(literalStart.body));
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: literalCanonicalID,
    updateToken: "literal-canonical-update-token-0123456789",
  });
  const literalUpdate = await post(
    env,
    "/update",
    startPayload(instanceID, { activity_id: literalCanonicalID, state: "Literal Updated" }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(literalUpdate.status, 200, JSON.stringify(literalUpdate.body));
  const literalEnd = await post(
    env,
    "/end",
    startPayload(instanceID, { activity_id: literalCanonicalID }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(literalEnd.status, 200, JSON.stringify(literalEnd.body));

  const unsafe = await post(
    env,
    "/start",
    startPayload(instanceID, { activity_id: "hadibeartık" }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(unsafe.status, 400);
  assert.equal(unsafe.body.error, "invalid_routing_id");
});

test("A: two HA instances only match their own registered devices", async () => {
  const env = makeEnv();
  const instanceA = "ha_11111111111111111111111111111111";
  const instanceB = "ha_22222222222222222222222222222222";
  await register(env, { instanceID: instanceA, deviceID: "device-a" });
  await register(env, { instanceID: instanceB, deviceID: "device-b" });
  const secretA = await provisionInstance(env, { instanceID: instanceA });
  const secretB = await provisionInstance(env, { instanceID: instanceB });

  const startA = await post(env, "/start", startPayload(instanceA), { "X-HA-LiveKit-Secret": secretA });
  assert.equal(startA.status, 200);
  assert.equal(startA.body.matched_devices, 1);
  assert.equal(startA.body.attempted, 1);

  const startB = await post(env, "/start", startPayload(instanceB), { "X-HA-LiveKit-Secret": secretB });
  assert.equal(startB.status, 200);
  assert.equal(startB.body.matched_devices, 1);
  assert.equal(startB.body.attempted, 1);
});

test("B: missing instance rejects before matching devices", async () => {
  const env = makeEnv();
  const response = await post(
    env,
    "/start",
    startPayload("ha_11111111111111111111111111111111", { home_assistant_instance_id: undefined }),
    { "X-HA-LiveKit-Secret": "anything" }
  );
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "missing_field");
  assert.equal(response.body.matched_devices, undefined);
});

test("C: wrong relay secret rejects safely", async () => {
  const env = makeEnv();
  const instanceID = "ha_33333333333333333333333333333333";
  await register(env, { instanceID, deviceID: "device-a" });
  await provisionInstance(env, { instanceID });

  const response = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": "wrong-secret",
  });
  assert.equal(response.status, 401);
  assert.equal(response.body.error, "unauthorized");
  assert.equal(response.body.matched_devices, undefined);

  const missing = await post(env, "/start", startPayload(instanceID));
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, "unauthorized");
  assert.equal(missing.body.matched_devices, undefined);
  assert.equal(missing.body.attempted, undefined);
});

test("a Set during the pending-start window is not lost and flushes on registration", async () => {
  const captures = [];
  const instanceID = "ha_95959595959595959595959595959595";
  const deviceID = "device-a";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });

  const first = await post(env, "/start", startPayload(instanceID, {
    activity_id: "pending_flush",
    entity_id: "switch.pending_target",
    state: "Open",
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.started, 1);

  // The phone has not registered the activity token yet; this Set must be
  // accepted as in-progress AND its content retained, not silently dropped.
  const during = await post(env, "/start", startPayload(instanceID, {
    activity_id: "pending_flush",
    entity_id: "switch.pending_target",
    state: "Closed",
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(during.status, 200, JSON.stringify(during.body));
  assert.equal(during.body.reused_pending, 1);
  assert.equal(during.body.delivered, 0);

  const pendingRecord = JSON.parse(await env.TOKENS.get(
    `pending-start:production:${instanceID}:pending_flush:device_${deviceID}`
  ));
  assert.equal(typeof pendingRecord.content_refreshed_at, "string");
  assert.equal(pendingRecord.last_content_state.subtitle, "Closed");
  assert.equal(pendingRecord.last_content_state.entityId, "switch.pending_target");

  // Registration must now deliver the refreshed state to the fresh update token.
  captures.length = 0;
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: "pending_flush",
    entityID: "switch.pending_target",
    updateToken: "pending-flush-update-token-0123456789",
  });
  const flush = captures.find((entry) => (
    entry.event === "update" && entry.token === "pending-flush-update-token-0123456789"
  ));
  assert.ok(flush, JSON.stringify(captures));
  assert.equal(flush.payload.aps["content-state"].subtitle, "Closed");
});

test("a device-reported dismissal retires the ghost route so the next start pushes a fresh activity", async () => {
  const env = makeEnv();
  const instanceID = "ha_4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, { instanceID, deviceID: "device-a", activityID: "front_door" });

  const retireBody = {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "device-a",
    activity_id: "front_door",
    apns_mode: "production",
    activity_state: "dismissed",
  };

  // A dismissed Live Activity keeps an update token APNs still answers 200 for, so
  // the relay reports a successful update while nothing is on screen.
  const ghost = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(ghost.status, 200, JSON.stringify(ghost.body));
  assert.equal(ghost.body.updated_existing, 1);
  assert.equal(ghost.body.started, 0);

  // Retirement is device-authenticated; an unauthenticated caller cannot drop a route.
  const unauthorized = await post(env, "/activity-retire", retireBody);
  assert.equal(unauthorized.status, 401, JSON.stringify(unauthorized.body));

  const retire = await post(env, "/activity-retire", retireBody, {
    "X-HA-LiveKit-App-Secret": APP_SECRET,
  });
  assert.equal(retire.status, 200, JSON.stringify(retire.body));
  assert.equal(retire.body.retired, 1);
  assert.equal(retire.body.retire_reason, "dismissed");

  // The next Set must now create a visible activity through push-to-start.
  const revived = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(revived.status, 200, JSON.stringify(revived.body));
  assert.equal(revived.body.updated_existing, 0);
  assert.equal(revived.body.started, 1);
  assert.equal(revived.body.results[0].event, "start");

  // Retiring an already-retired activity stays idempotent instead of failing the app.
  const again = await post(env, "/activity-retire", retireBody, {
    "X-HA-LiveKit-App-Secret": APP_SECRET,
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.retired, 0);
  assert.equal(again.body.already_retired, true);
});

test("start reuses an existing activity update token instead of creating a duplicate", async () => {
  const env = makeEnv();
  const instanceID = "ha_3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, { instanceID, deviceID: "device-a", activityID: "front_door" });

  const response = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": secret,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.matched_devices, 1);
  assert.equal(response.body.matched_activities, 1);
  assert.equal(response.body.updated_existing, 1);
  assert.equal(response.body.started, 0);
  assert.equal(response.body.results.length, 1);
  assert.equal(response.body.results[0].event, "update");
});

test("legacy same-id entity Set restarts when retained immutable attributes are unavailable", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_3a5a3a5a3a5a3a5a3a5a3a5a3a5a3a5a";
  const deviceID = "device-a";
  const activityID = "legacy-light";
  const entityID = "switch.legacy_light";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, { instanceID, deviceID, activityID, entityID });

  const activityKey = `activity:production:${instanceID}:${activityID}:device_${deviceID}`;
  const legacyRecord = JSON.parse(await env.TOKENS.get(activityKey));
  const originalGeneration = legacyRecord.activity_registration_generation;
  delete legacyRecord.start_attributes;
  delete legacyRecord.entity_id;
  delete legacyRecord.last_content_state;
  delete legacyRecord.activity_registration_generation;
  await env.TOKENS.put(activityKey, JSON.stringify(legacyRecord), { expirationTtl: 600 });
  await env.TOKENS.delete(
    `activity-generation:production:${instanceID}:${activityID}:device_${deviceID}:generation_${originalGeneration}`
  );
  await env.TOKENS.delete(
    `activity-state-generation:production:${instanceID}:${activityID}:device_${deviceID}:generation_${originalGeneration}`
  );
  await env.AUTH_STATE.objects.get(instanceID).storage.delete(
    `activity-current:production:${deviceID}:${activityID}`
  );
  await env.TOKENS.delete(
    `activity-state:production:${instanceID}:${activityID}:device_${deviceID}`
  );
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: activityID,
      entity_id: entityID,
      display_name: "Legacy Light",
      allow_entity_control: false,
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.updated_existing, 0);
  assert.equal(response.body.started, 1);
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  assert.equal(captures[1].payload.aps.attributes.primaryEntityId, entityID);
  const refreshedRecord = JSON.parse(await env.TOKENS.get(activityKey));
  assert.equal(refreshedRecord.entity_id, undefined);
  assert.equal(refreshedRecord.start_attributes, undefined);
  assert.notEqual(
    await env.TOKENS.get(
      `pending-start:production:${instanceID}:${activityID}:device_${deviceID}`
    ),
    null
  );
});

test("legacy same-id controls request restarts before extending verified attributes", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_3a6a3a6a3a6a3a6a3a6a3a6a3a6a3a6a";
  const activityID = "legacy-controls";
  const entityID = "switch.legacy_controls";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID,
    entityID,
  });

  const activityKey = `activity:production:${instanceID}:${activityID}:device_device-a`;
  const legacyRecord = JSON.parse(await env.TOKENS.get(activityKey));
  delete legacyRecord.start_attributes;
  delete legacyRecord.entity_id;
  await env.TOKENS.put(activityKey, JSON.stringify(legacyRecord), { expirationTtl: 600 });
  await env.TOKENS.delete(
    `activity-state:production:${instanceID}:${activityID}:device_device-a`
  );
  captures.length = 0;

  const update = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: activityID,
      entity_id: entityID,
      allow_entity_control: true,
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.equal(update.body.updated_existing, 0);
  assert.equal(update.body.started, 1);
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  assert.equal(captures[1].payload.aps.attributes.allowsEntityControl, true);

  await register(env, { instanceID, deviceID: "device-b" });
  captures.length = 0;
  const extension = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: activityID,
      entity_id: entityID,
      allow_entity_control: true,
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(extension.status, 200, JSON.stringify(extension.body));
  assert.equal(extension.body.started, 1);
  assert.equal(extension.body.reused_persistent_intent, 1);
  assert.deepEqual(captures.map(({ event, deviceID }) => ({ event, deviceID })), [
    { event: "start", deviceID: "device-b" },
  ]);
});

test("authoritative immutable hashes allow a partially retained route to extend safely", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_3a7a3a7a3a7a3a7a3a7a3a7a3a7a3a7a";
  const activityID = "mixed-snapshots";
  const entityID = "switch.mixed_snapshots";
  for (const deviceID of ["device-a", "device-b"]) {
    await register(env, { instanceID, deviceID });
  }
  const secret = await provisionInstance(env, { instanceID });
  const request = startPayload(instanceID, {
    activity_id: activityID,
    entity_id: entityID,
    allow_entity_control: false,
    data: { entity_based: true, source_service: "set_activity" },
  });
  const initial = await post(env, "/start", request, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  for (const deviceID of ["device-a", "device-b"]) {
    await registerActivity(env, { instanceID, deviceID, activityID, entityID });
  }
  const legacyKey = `activity:production:${instanceID}:${activityID}:device_device-b`;
  const legacyRecord = JSON.parse(await env.TOKENS.get(legacyKey));
  delete legacyRecord.start_attributes;
  await env.TOKENS.put(legacyKey, JSON.stringify(legacyRecord), { expirationTtl: 600 });
  await mutateAuthoritativeActivityRecord(
    env,
    instanceID,
    "device-b",
    activityID,
    (record) => { delete record.start_attributes; }
  );
  await register(env, { instanceID, deviceID: "device-c" });
  captures.length = 0;

  const extension = await post(env, "/start", request, {
    "X-HA-LiveKit-Secret": secret,
  });

  assert.equal(extension.status, 200, JSON.stringify(extension.body));
  assert.equal(extension.body.updated_existing, 2);
  assert.equal(extension.body.started, 1);
  assert.deepEqual(captures.map(({ event }) => event), ["update", "update", "start"]);
  assert.notEqual(
    await env.TOKENS.get(
      `pending-start:production:${instanceID}:${activityID}:device_device-c`
    ),
    null
  );
});

test("authoritative immutable hashes allow a stale partially retained device to restart", async () => {
  const captures = [];
  const staleUpdateToken = "stale-mixed-snapshot-update-token-0123456789";
  const env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_STALE_TOKENS: staleUpdateToken,
  });
  const instanceID = "ha_3a8a3a8a3a8a3a8a3a8a3a8a3a8a3a8a";
  const activityID = "mixed-stale";
  const entityID = "switch.mixed_stale";
  for (const deviceID of ["device-a", "device-b"]) {
    await register(env, { instanceID, deviceID });
  }
  const secret = await provisionInstance(env, { instanceID });
  const request = startPayload(instanceID, {
    activity_id: activityID,
    entity_id: entityID,
    allow_entity_control: false,
    data: { entity_based: true, source_service: "set_activity" },
  });
  const initial = await post(env, "/start", request, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID,
    entityID,
  });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-b",
    activityID,
    entityID,
    updateToken: staleUpdateToken,
  });
  const legacyKey = `activity:production:${instanceID}:${activityID}:device_device-b`;
  const legacyRecord = JSON.parse(await env.TOKENS.get(legacyKey));
  delete legacyRecord.start_attributes;
  await env.TOKENS.put(legacyKey, JSON.stringify(legacyRecord), { expirationTtl: 600 });
  await mutateAuthoritativeActivityRecord(
    env,
    instanceID,
    "device-b",
    activityID,
    (record) => { delete record.start_attributes; }
  );
  captures.length = 0;

  const retry = await post(env, "/start", request, {
    "X-HA-LiveKit-Secret": secret,
  });

  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.updated_existing, 1);
  assert.equal(retry.body.started, 1);
  assert.equal(captures.filter((capture) => capture.event === "start").length, 1);
  assert.equal(captures.filter((capture) => capture.event === "update").length, 2);
  assert.notEqual(
    await env.TOKENS.get(
      `pending-start:production:${instanceID}:${activityID}:device_device-b`
    ),
    null
  );
});

test("stale update token with no remaining device fails instead of reporting empty success", async () => {
  const instanceID = "ha_3a4a3a4a3a4a3a4a3a4a3a4a3a4a3a4a";
  const deviceID = "device-a";
  const staleToken = "stale-update-token-with-no-device-0123456789";
  const env = makeEnv({ APNS_MOCK_STALE_TOKENS: staleToken });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: "front_door",
    updateToken: staleToken,
  });
  await env.TOKENS.delete(`token:production:${instanceID}:device_${deviceID}`);

  const response = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": secret,
  });

  assert.equal(response.status, 502, JSON.stringify(response.body));
  assert.equal(response.body.error, "no_delivery_attempts");
  assert.equal(response.body.attempted, 0);
  assert.equal(response.body.delivered, 0);
  assert.notEqual(
    await env.TOKENS.get(`activity:production:${instanceID}:front_door:device_${deviceID}`),
    null
  );
  const pointer = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `activity-current:production:${deviceID}:front_door`
  );
  assert.equal(pointer.status, "stale");
});

test("activity token callbacks receive distinct registration generations even when APNs reuses the token", async () => {
  const instanceID = "ha_3d1d3d1d3d1d3d1d3d1d3d1d3d1d3d1d";
  const deviceID = "device-a";
  const activityID = "same-token-new-generation";
  const updateToken = "same-token-new-generation-0123456789";
  const env = makeEnv();
  await register(env, { instanceID, deviceID });

  await registerActivity(env, { instanceID, deviceID, activityID, updateToken });
  const key = `activity:production:${instanceID}:${activityID}:device_${deviceID}`;
  const first = JSON.parse(await env.TOKENS.get(key));
  assert.match(first.activity_registration_generation, /^ar_[A-Za-z0-9_-]{22,64}$/);

  await registerActivity(env, { instanceID, deviceID, activityID, updateToken });
  const second = JSON.parse(await env.TOKENS.get(key));
  assert.match(second.activity_registration_generation, /^ar_[A-Za-z0-9_-]{22,64}$/);
  assert.notEqual(second.activity_registration_generation, first.activity_registration_generation);
  assert.equal(
    (await env.AUTH_STATE.objects.get(instanceID).storage.get("activity-authority")).enabled,
    true
  );
});

test("compatible mode keeps untouched instances on legacy fixed storage", async () => {
  const captures = [];
  const instanceID = "ha_3cec3cec3cec3cec3cec3cec3cec3cec";
  const deviceID = "device-a";
  const activityID = "compatible-legacy-route";
  const updateToken = "compatible-legacy-update-token-012345";
  const env = makeEnv({
    ACTIVITY_GENERATION_MODE: "compatible",
    APNS_MOCK_REQUESTS: captures,
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, { instanceID, deviceID, activityID, updateToken });

  const fixedKey = `activity:production:${instanceID}:${activityID}:device_${deviceID}`;
  const fixed = JSON.parse(await env.TOKENS.get(fixedKey));
  assert.equal(fixed.activity_registration_generation, undefined);
  assert.equal(
    [...env.TOKENS.values.keys()].some((key) => key.startsWith("activity-generation:")),
    false
  );
  assert.equal(
    await env.AUTH_STATE.objects.get(instanceID).storage.get("activity-authority"),
    undefined
  );

  captures.length = 0;
  const update = await post(
    env,
    "/update",
    startPayload(instanceID, { activity_id: activityID, state: "Compatible" }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.deepEqual(captures.map(({ token, event }) => ({ token, event })), [
    { token: updateToken, event: "update" },
  ]);
  assert.equal(
    await env.AUTH_STATE.objects.get(instanceID).storage.get("activity-authority"),
    undefined
  );
});

for (const scenario of [
  {
    endpoint: "/start",
    instanceID: "ha_3c0a3c0a3c0a3c0a3c0a3c0a3c0a3c0a",
    expectedStatus: 200,
    expectedEvents: ["update", "start"],
  },
  {
    endpoint: "/update",
    instanceID: "ha_3c0b3c0b3c0b3c0b3c0b3c0b3c0b3c0b",
    expectedStatus: 502,
    expectedEvents: ["update"],
  },
  {
    endpoint: "/end",
    instanceID: "ha_3c0c3c0c3c0c3c0c3c0c3c0c3c0c3c0c",
    expectedStatus: 200,
    expectedEvents: ["end"],
  },
]) {
  test(`compatible untouched ${scenario.endpoint} handles APNs 410 without generation authority`, async () => {
    const captures = [];
    const deviceID = "device-a";
    const activityID = `compatible-stale-${scenario.endpoint.slice(1)}`;
    const staleToken = `compatible-stale-${scenario.endpoint.slice(1)}-token-012345`;
    const env = makeEnv({
      ACTIVITY_GENERATION_MODE: "compatible",
      APNS_MOCK_REQUESTS: captures,
      APNS_MOCK_STALE_TOKENS: staleToken,
    });
    await register(env, { instanceID: scenario.instanceID, deviceID });
    const secret = await provisionInstance(env, { instanceID: scenario.instanceID });
    await registerActivity(env, {
      instanceID: scenario.instanceID,
      deviceID,
      activityID,
      updateToken: staleToken,
    });
    captures.length = 0;

    const response = await post(
      env,
      scenario.endpoint,
      startPayload(scenario.instanceID, { activity_id: activityID, state: "Stale" }),
      { "X-HA-LiveKit-Secret": secret }
    );

    assert.equal(response.status, scenario.expectedStatus, JSON.stringify(response.body));
    assert.deepEqual(captures.map(({ event }) => event), scenario.expectedEvents);
    assert.equal(
      await env.AUTH_STATE.objects.get(scenario.instanceID).storage.get("activity-authority"),
      undefined
    );
    assert.equal(
      await env.TOKENS.get(
        `activity:production:${scenario.instanceID}:${activityID}:device_${deviceID}`
      ),
      null
    );
  });
}

test("compatible rollback continues generation authority after an authoritative callback", async () => {
  const captures = [];
  const instanceID = "ha_3cfc3cfc3cfc3cfc3cfc3cfc3cfc3cfc";
  const deviceID = "device-a";
  const activityID = "sticky-authority-route";
  const firstToken = "sticky-authority-first-token-012345";
  const secondToken = "sticky-authority-second-token-012345";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    updateToken: firstToken,
  });
  const fixedKey = `activity:production:${instanceID}:${activityID}:device_${deviceID}`;
  const delayedFirstMirror = await env.TOKENS.get(fixedKey);

  env.ACTIVITY_GENERATION_MODE = "compatible";
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    updateToken: secondToken,
  });
  await env.TOKENS.put(fixedKey, delayedFirstMirror, { expirationTtl: 600 });
  captures.length = 0;

  const update = await post(
    env,
    "/update",
    startPayload(instanceID, { activity_id: activityID, state: "Sticky" }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.deepEqual(captures.map(({ token, event }) => ({ token, event })), [
    { token: secondToken, event: "update" },
  ]);
  assert.equal(
    (await env.AUTH_STATE.objects.get(instanceID).storage.get("activity-authority")).enabled,
    true
  );
});

test("authoritative enable is sticky before the first generation KV write", async () => {
  const captures = [];
  const instanceID = "ha_3cbc3cbc3cbc3cbc3cbc3cbc3cbc3cbc";
  const deviceID = "device-a";
  const activityID = "authority-before-write";
  const legacyToken = "authority-before-write-legacy-token";
  const env = makeEnv({
    ACTIVITY_GENERATION_MODE: "compatible",
    APNS_MOCK_REQUESTS: captures,
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    updateToken: legacyToken,
  });

  env.ACTIVITY_GENERATION_MODE = "authoritative";
  env.TOKENS.failNextPut(
    (key) => key.startsWith("activity-generation:"),
    new Error("Injected generation write failure.")
  );
  const failed = await post(
    env,
    "/activity-token",
    {
      device_id: deviceID,
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      activity_id: activityID,
      update_token: "authority-before-write-new-token",
      apns_mode: "production",
    },
    { "X-HA-LiveKit-App-Secret": APP_SECRET }
  );
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  assert.equal(
    (await env.AUTH_STATE.objects.get(instanceID).storage.get("activity-authority")).enabled,
    true
  );

  env.ACTIVITY_GENERATION_MODE = "compatible";
  captures.length = 0;
  const update = await post(
    env,
    "/update",
    startPayload(instanceID, { activity_id: activityID, state: "Recovered" }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.deepEqual(captures.map(({ token, event }) => ({ token, event })), [
    { token: legacyToken, event: "update" },
  ]);
});

test("an out-of-order compatibility mirror never overrides the authoritative generation", async () => {
  const captures = [];
  const instanceID = "ha_3d8d3d8d3d8d3d8d3d8d3d8d3d8d3d8d";
  const deviceID = "device-a";
  const activityID = "out-of-order-mirror";
  const firstToken = "out-of-order-first-token-012345";
  const secondToken = "out-of-order-second-token-012345";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    updateToken: firstToken,
  });
  const mirrorKey = `activity:production:${instanceID}:${activityID}:device_${deviceID}`;
  const delayedFirstMirror = await env.TOKENS.get(mirrorKey);

  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    updateToken: secondToken,
  });
  const authStorage = env.AUTH_STATE.objects.get(instanceID).storage;
  const current = await authStorage.get(
    `activity-current:production:${deviceID}:${activityID}`
  );
  await env.TOKENS.put(mirrorKey, delayedFirstMirror, { expirationTtl: 600 });
  captures.length = 0;

  const response = await post(
    env,
    "/update",
    startPayload(instanceID, { activity_id: activityID, state: "Authoritative" }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(captures.map(({ token, event }) => ({ token, event })), [
    { token: secondToken, event: "update" },
  ]);
  const authoritative = JSON.parse(await env.TOKENS.get(
    `activity-generation:production:${instanceID}:${activityID}:device_${deviceID}:generation_${current.activity_registration_generation}`
  ));
  assert.equal(authoritative.update_token, secondToken);
  assert.equal(JSON.parse(await env.TOKENS.get(mirrorKey)).update_token, firstToken);
});

for (const endpoint of ["/start", "/update"]) {
  test(`${endpoint} successful delivery cannot write back over a concurrent token callback`, async () => {
    const captures = [];
    const instanceID = endpoint === "/start"
      ? "ha_3d9d3d9d3d9d3d9d3d9d3d9d3d9d3d9d"
      : "ha_3dad3dad3dad3dad3dad3dad3dad3dad";
    const deviceID = "device-a";
    const activityID = endpoint === "/start" ? "start-writeback-race" : "update-writeback-race";
    const firstToken = `first-${activityID}-token-012345`;
    const secondToken = `second-${activityID}-token-012345`;
    const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
    await register(env, { instanceID, deviceID });
    const secret = await provisionInstance(env, { instanceID });
    await registerActivity(env, {
      instanceID,
      deviceID,
      activityID,
      updateToken: firstToken,
    });
    const injected = injectActivityRegistrationBeforeNextAuthAction(
      env,
      "touch_activity_registration",
      { instanceID, deviceID, activityID, updateToken: secondToken }
    );
    captures.length = 0;

    const response = await post(
      env,
      endpoint,
      startPayload(instanceID, { activity_id: activityID, state: "Racing Update" }),
      { "X-HA-LiveKit-Secret": secret }
    );

    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error, "activity_update_retry_required");
    assert.equal(injected(), true);
    assert.deepEqual(captures.map(({ token, event }) => ({ token, event })), [
      { token: firstToken, event: "update" },
    ]);
    const current = await env.AUTH_STATE.objects.get(instanceID).storage.get(
      `activity-current:production:${deviceID}:${activityID}`
    );
    const authoritative = JSON.parse(await env.TOKENS.get(
      `activity-generation:production:${instanceID}:${activityID}:device_${deviceID}:generation_${current.activity_registration_generation}`
    ));
    assert.equal(authoritative.update_token, secondToken);
  });
}

for (const endpoint of ["/start", "/update"]) {
  test(`${endpoint} APNs 410 cannot retire a concurrent token callback`, async () => {
    const captures = [];
    const instanceID = endpoint === "/start"
      ? "ha_3dbd3dbd3dbd3dbd3dbd3dbd3dbd3dbd"
      : "ha_3dcd3dcd3dcd3dcd3dcd3dcd3dcd3dcd";
    const deviceID = "device-a";
    const activityID = endpoint === "/start" ? "start-stale-race" : "update-stale-race";
    const staleToken = `stale-${activityID}-token-012345`;
    const freshToken = `fresh-${activityID}-token-012345`;
    const env = makeEnv({
      APNS_MOCK_REQUESTS: captures,
      APNS_MOCK_STALE_TOKENS: staleToken,
    });
    await register(env, { instanceID, deviceID });
    const secret = await provisionInstance(env, { instanceID });
    await registerActivity(env, {
      instanceID,
      deviceID,
      activityID,
      updateToken: staleToken,
    });
    const injected = injectActivityRegistrationBeforeNextStaleMark(env, {
      instanceID,
      deviceID,
      activityID,
      updateToken: freshToken,
    });
    captures.length = 0;

    const response = await post(
      env,
      endpoint,
      startPayload(instanceID, { activity_id: activityID, state: "Stale Update" }),
      { "X-HA-LiveKit-Secret": secret }
    );

    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error, "activity_update_retry_required");
    assert.equal(injected(), true);
    assert.deepEqual(captures.map(({ token, event }) => ({ token, event })), [
      { token: staleToken, event: "update" },
    ]);
    const current = await env.AUTH_STATE.objects.get(instanceID).storage.get(
      `activity-current:production:${deviceID}:${activityID}`
    );
    assert.equal(current.status, "active");
    const authoritative = JSON.parse(await env.TOKENS.get(
      `activity-generation:production:${instanceID}:${activityID}:device_${deviceID}:generation_${current.activity_registration_generation}`
    ));
    assert.equal(authoritative.update_token, freshToken);
  });
}

test("legacy activity generation reconciliation never migrates or rewrites the shared KV record", async () => {
  const captures = [];
  const instanceID = "ha_3d2d3d2d3d2d3d2d3d2d3d2d3d2d3d2d";
  const deviceID = "device-a";
  const activityID = "legacy-read-only-route";
  const entityID = "switch.legacy_read_only";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, { instanceID, deviceID, activityID, entityID });
  const key = `activity:production:${instanceID}:${activityID}:device_${deviceID}`;
  const legacy = JSON.parse(await env.TOKENS.get(key));
  delete legacy.activity_registration_generation;
  delete legacy.auth_protocol;
  delete legacy.auth_generation;
  delete legacy.retention_policy_version;
  await env.TOKENS.put(key, JSON.stringify(legacy), { expirationTtl: 600 });
  const before = await env.TOKENS.get(key);
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "legacy-read-only-replacement",
      entity_id: entityID,
      display_name: "Front Door",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  assert.equal(await env.TOKENS.get(key), before);
});

test("a successful legacy update promotes the exact adopted route before its fixed source expires", async () => {
  const captures = [];
  const instanceID = "ha_3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d";
  const deviceID = "device-a";
  const activityID = "legacy-after-expired-pointer";
  const updateToken = "legacy-after-expired-pointer-token";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, { instanceID, deviceID, activityID, updateToken });

  const key = `activity:production:${instanceID}:${activityID}:device_${deviceID}`;
  const legacy = JSON.parse(await env.TOKENS.get(key));
  delete legacy.activity_registration_generation;
  await env.TOKENS.put(key, JSON.stringify(legacy), { expirationTtl: 600 });
  const pointerKey = `activity-current:production:${deviceID}:${activityID}`;
  const authStorage = env.AUTH_STATE.objects.get(instanceID).storage;
  const expired = await authStorage.get(pointerKey);
  await authStorage.put(pointerKey, { ...expired, expires_at_ms: Date.now() - 1 });
  captures.length = 0;

  const response = await post(
    env,
    "/update",
    startPayload(instanceID, { activity_id: activityID, state: "Updated" }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(captures.map(({ token, event }) => ({ token, event })), [
    { token: updateToken, event: "update" },
  ]);
  const adopted = await authStorage.get(pointerKey);
  assert.equal(adopted.status, "active");
  assert.equal(adopted.storage_kind, "generation");
  assert.match(adopted.activity_registration_generation, /^legacy_[a-f0-9]{64}$/);

  await env.TOKENS.delete(key);
  await env.TOKENS.delete(
    `activity-state:production:${instanceID}:${activityID}:device_${deviceID}`
  );
  captures.length = 0;
  const afterFixedExpiry = await post(
    env,
    "/update",
    startPayload(instanceID, { activity_id: activityID, state: "Still Active" }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(afterFixedExpiry.status, 200, JSON.stringify(afterFixedExpiry.body));
  assert.deepEqual(captures.map(({ token, event }) => ({ token, event })), [
    { token: updateToken, event: "update" },
  ]);

  captures.length = 0;
  const ended = await post(
    env,
    "/end",
    startPayload(instanceID, { activity_id: activityID }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.deepEqual(captures.map(({ token, event }) => ({ token, event })), [
    { token: updateToken, event: "end" },
  ]);
});

test("legacy promotion fails closed when a fresh callback wins the exact pointer race", async () => {
  const captures = [];
  const instanceID = "ha_3d0f3d0f3d0f3d0f3d0f3d0f3d0f3d0f";
  const deviceID = "device-a";
  const activityID = "legacy-promotion-race";
  const legacyToken = "legacy-promotion-race-old-token-012345";
  const freshToken = "legacy-promotion-race-new-token-012345";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    updateToken: legacyToken,
  });
  const fixedKey = `activity:production:${instanceID}:${activityID}:device_${deviceID}`;
  const legacy = JSON.parse(await env.TOKENS.get(fixedKey));
  delete legacy.activity_registration_generation;
  await env.TOKENS.put(fixedKey, JSON.stringify(legacy), { expirationTtl: 600 });
  const pointerKey = `activity-current:production:${deviceID}:${activityID}`;
  const authStorage = env.AUTH_STATE.objects.get(instanceID).storage;
  const expired = await authStorage.get(pointerKey);
  await authStorage.put(pointerKey, { ...expired, expires_at_ms: Date.now() - 1 });
  const injected = injectActivityRegistrationBeforeNextAuthAction(
    env,
    "promote_legacy_activity_registration",
    { instanceID, deviceID, activityID, updateToken: freshToken }
  );
  captures.length = 0;

  const response = await post(
    env,
    "/update",
    startPayload(instanceID, { activity_id: activityID, state: "Racing" }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, "activity_update_retry_required");
  assert.equal(injected(), true);
  assert.deepEqual(captures.map(({ token, event }) => ({ token, event })), [
    { token: legacyToken, event: "update" },
  ]);
  const current = await authStorage.get(pointerKey);
  assert.match(current.activity_registration_generation, /^ar_[A-Za-z0-9_-]{22,64}$/);
  const authoritative = JSON.parse(await env.TOKENS.get(
    `activity-generation:production:${instanceID}:${activityID}:device_${deviceID}:generation_${current.activity_registration_generation}`
  ));
  assert.equal(authoritative.update_token, freshToken);
});

test("authoritative update refreshes display metadata only on the exact generation", async () => {
  const captures = [];
  const instanceID = "ha_3d0e3d0e3d0e3d0e3d0e3d0e3d0e3d0e";
  const deviceID = "device-a";
  const activityID = "display-metadata-route";
  const entityID = "switch.display_metadata";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID,
    displayName: "Old Name",
  });
  const mirrorKey = `activity:production:${instanceID}:${activityID}:device_${deviceID}`;
  const originalMirror = JSON.parse(await env.TOKENS.get(mirrorKey));
  const originalAttributes = originalMirror.start_attributes;
  captures.length = 0;

  const update = await post(
    env,
    "/update",
    startPayload(instanceID, {
      activity_id: activityID,
      entity_id: entityID,
      display_name: "New Name",
      title: "New Name",
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(update.status, 200, JSON.stringify(update.body));

  const location = await authoritativeActivityLocation(env, instanceID, deviceID, activityID);
  const authoritative = JSON.parse(await env.TOKENS.get(location.key));
  assert.equal(authoritative.display_name, "New Name");
  assert.equal(authoritative.display_name_key, "new name");
  assert.equal(authoritative.entity_id, entityID);
  assert.deepEqual(authoritative.start_attributes, originalAttributes);
  const unchangedMirror = JSON.parse(await env.TOKENS.get(mirrorKey));
  assert.equal(unchangedMirror.display_name, "Old Name");

  captures.length = 0;
  const newNameConflict = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "new-name-conflict",
      entity_id: "switch.other_new",
      display_name: "New Name",
      title: "New Name",
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(newNameConflict.status, 409, JSON.stringify(newNameConflict.body));
  assert.equal(newNameConflict.body.error, "duplicate_activity_name");
  assert.equal(captures.length, 0);

  const oldNameAvailable = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "old-name-available",
      entity_id: "switch.other_old",
      display_name: "Old Name",
      title: "Old Name",
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(oldNameAvailable.status, 200, JSON.stringify(oldNameAvailable.body));
});

test("authoritative updates cannot rewrite immutable entity binding", async () => {
  const captures = [];
  const instanceID = "ha_3d1e3d1e3d1e3d1e3d1e3d1e3d1e3d1e";
  const deviceID = "device-a";
  const activityID = "immutable-entity-route";
  const originalEntityID = "switch.original_binding";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: originalEntityID,
    displayName: "Bound Entity",
  });
  const immutableAttributes = buildAPNsStartPayload(
    startPayload(instanceID, {
      activity_id: activityID,
      entity_id: originalEntityID,
      display_name: "Bound Entity",
    }),
    env
  ).aps.attributes;
  await mutateAuthoritativeActivityRecord(
    env,
    instanceID,
    deviceID,
    activityID,
    (record) => { record.start_attributes = immutableAttributes; }
  );

  const mismatched = await post(
    env,
    "/update",
    startPayload(instanceID, {
      activity_id: activityID,
      entity_id: "switch.untrusted_rebind",
      display_name: "Bound Entity",
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(mismatched.status, 200, JSON.stringify(mismatched.body));
  let location = await authoritativeActivityLocation(env, instanceID, deviceID, activityID);
  let authoritative = JSON.parse(await env.TOKENS.get(location.key));
  assert.equal(authoritative.entity_id, originalEntityID);
  assert.deepEqual(authoritative.start_attributes, immutableAttributes);

  const omittedPayload = startPayload(instanceID, {
    activity_id: activityID,
    display_name: "Bound Entity",
  });
  delete omittedPayload.entity_id;
  const omitted = await post(
    env,
    "/update",
    omittedPayload,
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(omitted.status, 200, JSON.stringify(omitted.body));
  location = await authoritativeActivityLocation(env, instanceID, deviceID, activityID);
  authoritative = JSON.parse(await env.TOKENS.get(location.key));
  assert.equal(authoritative.entity_id, originalEntityID);
  assert.deepEqual(authoritative.start_attributes, immutableAttributes);

  captures.length = 0;
  const changedID = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "immutable-entity-new-id",
      entity_id: originalEntityID,
      display_name: "Bound Entity",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(changedID.status, 200, JSON.stringify(changedID.body));
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
});

test("an expired pointer never promotes a generation compatibility mirror to authority", async () => {
  const captures = [];
  const instanceID = "ha_3ddd3ddd3ddd3ddd3ddd3ddd3ddd3ddd";
  const deviceID = "device-a";
  const activityID = "expired-generation-mirror";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, { instanceID, deviceID, activityID });
  const pointerKey = `activity-current:production:${deviceID}:${activityID}`;
  const authStorage = env.AUTH_STATE.objects.get(instanceID).storage;
  const expired = await authStorage.get(pointerKey);
  await authStorage.put(pointerKey, { ...expired, expires_at_ms: Date.now() - 1 });
  captures.length = 0;

  const response = await post(
    env,
    "/update",
    startPayload(instanceID, { activity_id: activityID, state: "Must Not Resurrect" }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 404, JSON.stringify(response.body));
  assert.equal(response.body.error, "no_activity_tokens");
  assert.equal(captures.length, 0);
  assert.equal(await authStorage.get(pointerKey), undefined);
});

test("end marks an exact all-410 activity generation and unblocks a changed entity id", async () => {
  const captures = [];
  const instanceID = "ha_3d4d3d4d3d4d3d4d3d4d3d4d3d4d3d4d";
  const deviceID = "device-a";
  const activityID = "stale-old-route";
  const staleToken = "stale-end-token-0123456789";
  const env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_STALE_TOKENS: staleToken,
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "switch.aisle_lamp_anahtar_1",
    displayName: "Giriş Lambası",
    updateToken: staleToken,
  });
  captures.length = 0;

  const response = await post(
    env,
    "/end",
    startPayload(instanceID, { activity_id: activityID }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action, "end");
  assert.equal(response.body.matched_activities, 1);
  assert.equal(response.body.attempted, 1);
  assert.equal(response.body.delivered, 0);
  assert.equal(response.body.cleaned_stale_activities, 1);
  assert.equal(response.body.stale_cleanup_satisfied, true);
  assert.equal(response.body.results[0].status, 410);
  assert.deepEqual(captures.map(({ event }) => event), ["end"]);
  assert.notEqual(
    await env.TOKENS.get(`activity:production:${instanceID}:${activityID}:device_${deviceID}`),
    null
  );
  assert.notEqual(
    await env.TOKENS.get(`activity-state:production:${instanceID}:${activityID}:device_${deviceID}`),
    null
  );
  const tombstones = [...env.AUTH_STATE.objects.get(instanceID).storage.values.keys()].filter((key) => (
    key.startsWith("activity-stale:production:")
  ));
  assert.equal(tombstones.length, 1);

  captures.length = 0;
  const changed = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "replacement-route",
      entity_id: "switch.aisle_lamp_anahtar_1",
      display_name: "Giriş Lambası",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(captures.map(({ event }) => event), ["start"]);
});

test("entity-backed Set automatically neutralizes a stale changed-id route", async () => {
  const captures = [];
  const instanceID = "ha_3e4e3e4e3e4e3e4e3e4e3e4e3e4e3e4e";
  const deviceID = "device-a";
  const oldActivityID = "denemeeeeeeeeeeeeeee";
  const requestedActivityID = "hadibeartikkk";
  const staleToken = "stale-changed-route-token-0123456789";
  const env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_STALE_TOKENS: staleToken,
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: oldActivityID,
    displayName: "Giriş Lambası",
    entityID: "switch.aisle_lamp_anahtar_1",
    updateToken: staleToken,
  });
  captures.length = 0;

  const request = startPayload(instanceID, {
    activity_id: requestedActivityID,
    entity_id: "switch.aisle_lamp_anahtar_1",
    display_name: "Giriş Lambası",
    allow_entity_control: true,
    data: { entity_based: true, source_service: "set_activity" },
  });
  const reconciled = await post(
    env,
    "/start",
    request,
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  assert.equal(reconciled.body.started, 1);
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  assert.equal(captures[1].payload.aps.attributes.primaryEntityId, "switch.aisle_lamp_anahtar_1");
  assert.equal(captures[1].payload.aps.attributes.allowsEntityControl, true);
  assert.notEqual(
    await env.TOKENS.get(`activity:production:${instanceID}:${oldActivityID}:device_${deviceID}`),
    null
  );
  assert.notEqual(
    await env.TOKENS.get(`pending-start:production:${instanceID}:${requestedActivityID}:device_${deviceID}`),
    null
  );
});

test("end never deletes or reports success over a concurrent T1-to-T2 token refresh", async () => {
  const captures = [];
  const instanceID = "ha_3e5e3e5e3e5e3e5e3e5e3e5e3e5e3e5e";
  const deviceID = "device-a";
  const oldActivityID = "old-racing-route";
  const staleToken = "stale-racing-route-token-0123456789";
  const freshToken = "fresh-racing-route-token-0123456789";
  const env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_STALE_TOKENS: staleToken,
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: oldActivityID,
    displayName: "Giriş Lambası",
    entityID: "switch.aisle_lamp_anahtar_1",
    updateToken: staleToken,
  });

  const activityKey = `activity:production:${instanceID}:${oldActivityID}:device_${deviceID}`;
  const staleCompatibilityRecord = await env.TOKENS.get(activityKey);
  const injected = injectActivityRegistrationBeforeNextStaleMark(env, {
    instanceID,
    deviceID,
    activityID: oldActivityID,
    displayName: "Giriş Lambası",
    entityID: "switch.aisle_lamp_anahtar_1",
    updateToken: freshToken,
  }, staleCompatibilityRecord);
  captures.length = 0;

  const response = await post(
    env,
    "/end",
    startPayload(instanceID, { activity_id: oldActivityID }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, "activity_end_retry_required");
  assert.equal(injected(), true);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].event, "end");
  const staleMirror = JSON.parse(await env.TOKENS.get(activityKey));
  assert.equal(staleMirror.update_token, staleToken);
  const authValues = env.AUTH_STATE.objects.get(instanceID).storage.values;
  const current = authValues.get(`activity-current:production:${deviceID}:${oldActivityID}`);
  assert.equal(current.status, "active");
  const authoritative = JSON.parse(await env.TOKENS.get(
    `activity-generation:production:${instanceID}:${oldActivityID}:device_${deviceID}:generation_${current.activity_registration_generation}`
  ));
  assert.equal(authoritative.update_token, freshToken);
  const tombstones = [...authValues.keys()].filter((key) => (
    key.startsWith("activity-stale:production:")
  ));
  assert.equal(tombstones.length, 0);

  captures.length = 0;
  const changed = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "new-racing-route",
      entity_id: "switch.aisle_lamp_anahtar_1",
      display_name: "Giriş Lambası",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  assert.notEqual(
    await env.TOKENS.get(`pending-start:production:${instanceID}:new-racing-route:device_${deviceID}`),
    null
  );
});

test("successful APNs End cannot neutralize a concurrent fresh activity generation", async () => {
  const captures = [];
  const instanceID = "ha_3e8e3e8e3e8e3e8e3e8e3e8e3e8e3e8e";
  const deviceID = "device-a";
  const activityID = "successful-end-racing-route";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "switch.aisle_lamp_anahtar_1",
  });

  const activityKey = `activity:production:${instanceID}:${activityID}:device_${deviceID}`;
  const injected = injectActivityRegistrationBeforeNextStaleMark(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "switch.aisle_lamp_anahtar_1",
    updateToken: "fresh-after-successful-end-0123456789",
  });
  captures.length = 0;

  const response = await post(
    env,
    "/end",
    startPayload(instanceID, { activity_id: activityID }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, "activity_end_retry_required");
  assert.equal(injected(), true);
  assert.deepEqual(captures.map(({ event }) => event), ["end"]);
  const retained = JSON.parse(await env.TOKENS.get(activityKey));
  assert.equal(retained.update_token, "fresh-after-successful-end-0123456789");
});

test("end tombstone does not hide a same-token concurrent entity rebind", async () => {
  const instanceID = "ha_3e6e3e6e3e6e3e6e3e6e3e6e3e6e3e6e";
  const deviceID = "device-a";
  const activityID = "same-token-rebound-route";
  const staleToken = "same-token-rebound-0123456789";
  const env = makeEnv({ APNS_MOCK_STALE_TOKENS: staleToken });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    displayName: "Giriş Lambası",
    entityID: "switch.original_entity",
    updateToken: staleToken,
  });

  const activityKey = `activity:production:${instanceID}:${activityID}:device_${deviceID}`;
  const injected = injectActivityRegistrationBeforeNextStaleMark(env, {
    instanceID,
    deviceID,
    activityID,
    displayName: "Giriş Lambası",
    entityID: "switch.rebound_entity",
    updateToken: staleToken,
  });

  const response = await post(
    env,
    "/end",
    startPayload(instanceID, { activity_id: activityID }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, "activity_end_retry_required");
  assert.equal(injected(), true);
  const retained = JSON.parse(await env.TOKENS.get(activityKey));
  assert.equal(retained.update_token, staleToken);
  assert.equal(retained.entity_id, "switch.rebound_entity");
});

test("end tombstone does not hide a same-token same-entity generation refresh", async () => {
  const instanceID = "ha_3e7e3e7e3e7e3e7e3e7e3e7e3e7e3e7e";
  const deviceID = "device-a";
  const activityID = "same-token-refreshed-route";
  const staleToken = "same-token-refreshed-0123456789";
  const env = makeEnv({ APNS_MOCK_STALE_TOKENS: staleToken });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    displayName: "Giriş Lambası",
    entityID: "switch.aisle_lamp_anahtar_1",
    updateToken: staleToken,
  });

  const activityKey = `activity:production:${instanceID}:${activityID}:device_${deviceID}`;
  const original = JSON.parse(await env.TOKENS.get(activityKey));
  const injected = injectActivityRegistrationBeforeNextStaleMark(env, {
    instanceID,
    deviceID,
    activityID,
    displayName: "Giriş Lambası",
    entityID: "switch.aisle_lamp_anahtar_1",
    updateToken: staleToken,
  });

  const response = await post(
    env,
    "/end",
    startPayload(instanceID, { activity_id: activityID }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, "activity_end_retry_required");
  assert.equal(injected(), true);
  const retained = JSON.parse(await env.TOKENS.get(activityKey));
  assert.equal(retained.update_token, staleToken);
  assert.notEqual(
    retained.activity_registration_generation,
    original.activity_registration_generation
  );
});

test("entity-backed Set ends a live changed-id route before starting the canonical route", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: "denemeeeeeeeeeeeeeee",
    displayName: "Giriş Lambası",
    entityID: "switch.aisle_lamp_anahtar_1",
    state: "Stored Old State",
  });
  const stateKey = `activity-state:production:${instanceID}:denemeeeeeeeeeeeeeee:device_device-a`;
  const stateBefore = await env.TOKENS.get(stateKey);
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "hadibeartikkk",
      entity_id: "switch.aisle_lamp_anahtar_1",
      display_name: "Giriş Lambası",
      state: "Requested New State",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  assert.equal(await env.TOKENS.get(stateKey), stateBefore);
  assert.notEqual(
    await env.TOKENS.get(`activity:production:${instanceID}:denemeeeeeeeeeeeeeee:device_device-a`),
    null
  );
  assert.notEqual(
    await env.TOKENS.get(`pending-start:production:${instanceID}:hadibeartikkk:device_device-a`),
    null
  );
});

test("entity-backed Set reconciles one active advanced route into the requested canonical id", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_61616161616161616161616161616161";
  const deviceID = "device-a";
  const oldActivityID = "advanced-route";
  const requestedActivityID = "canonical-route";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: oldActivityID,
    displayName: "Kitchen Light",
    entityID: "switch.kitchen_light",
  });
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: requestedActivityID,
      entity_id: "switch.kitchen_light",
      display_name: "Kitchen Light",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.started, 1);
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  const oldPointer = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `activity-current:production:${deviceID}:${oldActivityID}`
  );
  assert.equal(oldPointer.status, "stale");
  assert.notEqual(
    await env.TOKENS.get(
      `pending-start:production:${instanceID}:${requestedActivityID}:device_${deviceID}`
    ),
    null
  );
});

test("entity-backed Set keeps the requested route and ends only same-entity extras", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_62626262626262626262626262626262";
  const deviceID = "device-a";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  for (const activityID of ["canonical-route", "extra-route-a", "extra-route-b"]) {
    await registerActivity(env, {
      instanceID,
      deviceID,
      activityID,
      displayName: "Kitchen Light",
      entityID: "switch.kitchen_light",
    });
  }
  const requestedPayload = startPayload(instanceID, {
    activity_id: "canonical-route",
    entity_id: "switch.kitchen_light",
    display_name: "Kitchen Light",
    data: { entity_based: true, source_service: "set_activity" },
  });
  const canonicalAttributes = buildAPNsStartPayload(requestedPayload, env).aps.attributes;
  await mutateAuthoritativeActivityRecord(
    env,
    instanceID,
    deviceID,
    "canonical-route",
    (record) => { record.start_attributes = canonicalAttributes; }
  );
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    requestedPayload,
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.updated_existing, 1);
  assert.equal(response.body.started, 0);
  assert.equal(captures.filter(({ event }) => event === "end").length, 2);
  assert.equal(captures.filter(({ event }) => event === "update").length, 1);
  const current = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `activity-current:production:${deviceID}:canonical-route`
  );
  assert.equal(current.status, "active");
  for (const activityID of ["extra-route-a", "extra-route-b"]) {
    const pointer = await env.AUTH_STATE.objects.get(instanceID).storage.get(
      `activity-current:production:${deviceID}:${activityID}`
    );
    assert.equal(pointer.status, "stale");
  }
});

test("entity-backed Set reconciliation remains scoped to the requested device", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_63636363636363636363636363636363";
  for (const deviceID of ["device-a", "device-b"]) {
    await register(env, { instanceID, deviceID });
    await registerActivity(env, {
      instanceID,
      deviceID,
      activityID: "advanced-route",
      displayName: "Kitchen Light",
      entityID: "switch.kitchen_light",
    });
  }
  const secret = await provisionInstance(env, { instanceID });
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "canonical-route",
      device_id: "device-a",
      entity_id: "switch.kitchen_light",
      display_name: "Kitchen Light",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(captures.map(({ event, deviceID }) => ({ event, deviceID })), [
    { event: "end", deviceID: "device-a" },
    { event: "start", deviceID: "device-a" },
  ]);
  const otherDevice = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    "activity-current:production:device-b:advanced-route"
  );
  assert.equal(otherDevice.status, "active");
});

test("entity-backed Set fails closed when automatic reconciliation End is rejected", async () => {
  const captures = [];
  const failedToken = "failed-reconciliation-token-0123456789";
  const env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_FAILURE_TOKENS: failedToken,
  });
  const instanceID = "ha_64646464646464646464646464646464";
  const deviceID = "device-a";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: "advanced-route",
    displayName: "Kitchen Light",
    entityID: "switch.kitchen_light",
    updateToken: failedToken,
  });
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "canonical-route",
      entity_id: "switch.kitchen_light",
      display_name: "Kitchen Light",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 502, JSON.stringify(response.body));
  assert.equal(response.body.error, "entity_activity_reconciliation_failed");
  assert.deepEqual(captures.map(({ event }) => event), ["end"]);
  assert.equal(
    await env.TOKENS.get(
      `pending-start:production:${instanceID}:canonical-route:device_${deviceID}`
    ),
    null
  );
  const pointer = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `activity-current:production:${deviceID}:advanced-route`
  );
  assert.equal(pointer.status, "active");
});

test("entity-backed Set rejects an obsolete concurrent callback and safely continues", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_65656565656565656565656565656565";
  const deviceID = "device-a";
  const oldActivityID = "advanced-route";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: oldActivityID,
    entityID: "switch.kitchen_light",
  });
  const injected = injectActivityRegistrationBeforeNextStaleMark(env, {
    instanceID,
    deviceID,
    activityID: oldActivityID,
    entityID: "switch.kitchen_light",
    updateToken: "fresh-reconciliation-token-0123456789",
  });
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "canonical-route",
      entity_id: "switch.kitchen_light",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(injected(), true);
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  assert.notEqual(
    await env.TOKENS.get(
      `pending-start:production:${instanceID}:canonical-route:device_${deviceID}`
    ),
    null
  );
});

test("entity-backed Set rejects an obsolete post-stale callback and safely continues", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_72727272727272727272727272727272";
  const deviceID = "device-a";
  const oldActivityID = "advanced-route";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: oldActivityID,
    entityID: "switch.kitchen_light",
  });
  const injected = injectActivityRegistrationAfterNextStaleMark(env, {
    instanceID,
    deviceID,
    activityID: oldActivityID,
    entityID: "switch.kitchen_light",
    updateToken: "post-mark-fresh-token-0123456789",
  });
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "canonical-route",
      entity_id: "switch.kitchen_light",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(injected(), true);
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  assert.notEqual(
    await env.TOKENS.get(
      `pending-start:production:${instanceID}:canonical-route:device_${deviceID}`
    ),
    null
  );
});

test("a rejected obsolete callback cannot restore post-reconciliation generation state", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_73737373737373737373737373737373";
  const deviceID = "device-a";
  const oldActivityID = "advanced-route";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: oldActivityID,
    entityID: "switch.kitchen_light",
  });
  const injected = injectActivityRegistrationAfterNextStaleMark(
    env,
    {
      instanceID,
      deviceID,
      activityID: oldActivityID,
      entityID: "switch.kitchen_light",
      updateToken: "missing-post-mark-token-0123456789",
    },
    async () => {
      const location = await authoritativeActivityLocation(
        env,
        instanceID,
        deviceID,
        oldActivityID
      );
      await env.TOKENS.delete(location.key);
    }
  );
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "canonical-route",
      entity_id: "switch.kitchen_light",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(injected(), true);
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  assert.notEqual(
    await env.TOKENS.get(
      `pending-start:production:${instanceID}:canonical-route:device_${deviceID}`
    ),
    null
  );
});

test("compatible v1 mode keeps changed-id Set strict without physical cleanup", async () => {
  const captures = [];
  const env = makeEnv({
    ACTIVITY_GENERATION_MODE: "compatible",
    APNS_MOCK_REQUESTS: captures,
  });
  const instanceID = "ha_74747474747474747474747474747474";
  const deviceID = "device-a";
  const oldActivityID = "legacy-route";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: oldActivityID,
    entityID: "switch.kitchen_light",
  });
  const oldKey = `activity:production:${instanceID}:${oldActivityID}:device_${deviceID}`;
  const before = await env.TOKENS.get(oldKey);
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "canonical-route",
      entity_id: "switch.kitchen_light",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, "entity_activity_id_changed");
  assert.equal(captures.length, 0);
  assert.equal(await env.TOKENS.get(oldKey), before);
});

test("entity-backed Set checks conflicting pending starts before reconciliation side effects", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_66666666666666666666666666666666";
  const deviceID = "device-a";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const pending = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "pending-route",
      entity_id: "switch.kitchen_light",
      display_name: "Kitchen Light",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: "advanced-route",
    displayName: "Kitchen Light",
    entityID: "switch.kitchen_light",
    assertStatus: false,
  });
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "canonical-route",
      entity_id: "switch.kitchen_light",
      display_name: "Kitchen Light",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, "pending_entity_activity_id_changed");
  assert.equal(captures.length, 0);
  assert.notEqual(
    await env.TOKENS.get(
      `pending-start:production:${instanceID}:pending-route:device_${deviceID}`
    ),
    null
  );
});

test("entity-backed Set safely restarts the requested route when immutable attributes change", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_67676767676767676767676767676767";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const initial = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: activityID,
      entity_id: "switch.kitchen_light",
      allow_entity_control: false,
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "switch.kitchen_light",
  });
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: activityID,
      entity_id: "switch.kitchen_light",
      allow_entity_control: true,
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.started, 1);
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  assert.equal(captures[1].payload.aps.attributes.allowsEntityControl, true);
});

test("raw Start remains strict and never invokes entity Set reconciliation", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_68686868686868686868686868686868";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: "advanced-route",
    displayName: "Kitchen Light",
    entityID: "switch.kitchen_light",
  });
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "raw-route",
      entity_id: "switch.kitchen_light",
      display_name: "Kitchen Light",
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, "duplicate_activity_name");
  assert.equal(captures.length, 0);
});

test("entity-backed Set reconciliation is canonical-instance scoped and URL agnostic", async () => {
  for (const [index, homeAssistantURL] of [
    "https://example.ui.nabu.casa",
    "https://ha.example.test",
    "http://localhost:8123",
  ].entries()) {
    const captures = [];
    const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
    const suffix = String(69 + index).padStart(2, "0");
    const instanceID = `ha_${suffix.repeat(16)}`;
    await register(env, { instanceID, deviceID: "device-a" });
    const secret = await provisionInstance(env, { instanceID });
    await registerActivity(env, {
      instanceID,
      deviceID: "device-a",
      activityID: "advanced-route",
      entityID: "switch.kitchen_light",
    });
    captures.length = 0;

    const response = await post(
      env,
      "/start",
      startPayload(instanceID, {
        activity_id: "canonical-route",
        entity_id: "switch.kitchen_light",
        home_assistant_url: homeAssistantURL,
        data: { entity_based: true, source_service: "set_activity" },
      }),
      { "X-HA-LiveKit-Secret": secret }
    );

    assert.equal(response.status, 200, JSON.stringify({ homeAssistantURL, body: response.body }));
    assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  }
});

test("entity-backed Set reconciles multi-device activity-id churn before delivery", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c";
  for (const deviceID of ["device-a", "device-b"]) {
    await register(env, { instanceID, deviceID });
  }
  const secret = await provisionInstance(env, { instanceID });
  const entityData = { entity_based: true, source_service: "set_activity" };
  const original = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "canonical-light",
      entity_id: "switch.aisle_lamp_anahtar_1",
      display_name: "Giriş Lambası",
      allow_entity_control: true,
      data: entityData,
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(original.status, 200, JSON.stringify(original.body));
  for (const deviceID of ["device-a", "device-b"]) {
    await registerActivity(env, {
      instanceID,
      deviceID,
      activityID: "canonical-light",
      displayName: "Giriş Lambası",
      entityID: "switch.aisle_lamp_anahtar_1",
    });
  }
  await register(env, { instanceID, deviceID: "device-c" });
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "changed-id",
      entity_id: "switch.aisle_lamp_anahtar_1",
      display_name: "Giriş Lambası",
      allow_entity_control: true,
      data: entityData,
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(captures.filter(({ event }) => event === "end").length, 2);
  assert.equal(captures.filter(({ event }) => event === "start").length, 3);
  assert.notEqual(
    await env.TOKENS.get(`pending-start:production:${instanceID}:changed-id:device_device-c`),
    null
  );
});

test("entity-backed Set reconciles mixed 200 and 410 changed-id routes", async () => {
  const captures = [];
  const instanceID = "ha_3a5a3a5a3a5a3a5a3a5a3a5a3a5a3a5a";
  const oldActivityID = "old-mixed-route";
  const requestedActivityID = "new-mixed-route";
  const staleToken = "stale-mixed-route-token-0123456789";
  const env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_STALE_TOKENS: staleToken,
  });
  for (const deviceID of ["device-a", "device-b"]) {
    await register(env, { instanceID, deviceID });
  }
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: oldActivityID,
    displayName: "Giriş Lambası",
    entityID: "switch.aisle_lamp_anahtar_1",
    updateToken: staleToken,
  });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-b",
    activityID: oldActivityID,
    displayName: "Giriş Lambası",
    entityID: "switch.aisle_lamp_anahtar_1",
    updateToken: "live-mixed-route-token-0123456789",
  });
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: requestedActivityID,
      entity_id: "switch.aisle_lamp_anahtar_1",
      display_name: "Giriş Lambası",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(captures.filter(({ event }) => event === "end").length, 2);
  assert.equal(captures.filter(({ event }) => event === "start").length, 2);
  assert.notEqual(
    await env.TOKENS.get(`activity:production:${instanceID}:${oldActivityID}:device_device-a`),
    null
  );
  assert.notEqual(
    await env.TOKENS.get(`activity:production:${instanceID}:${oldActivityID}:device_device-b`),
    null
  );
  assert.notEqual(
    await env.TOKENS.get(`pending-start:production:${instanceID}:${requestedActivityID}:device_device-a`),
    null
  );
  assert.notEqual(
    await env.TOKENS.get(`pending-start:production:${instanceID}:${requestedActivityID}:device_device-b`),
    null
  );
});

test("entity-backed Set reconciles from authenticated route metadata when retained state expired", async () => {
  const captures = [];
  const instanceID = "ha_3a6a3a6a3a6a3a6a3a6a3a6a3a6a3a6a";
  const deviceID = "device-a";
  const oldActivityID = "old-route-without-state";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: oldActivityID,
    displayName: "Giriş Lambası",
    entityID: "switch.aisle_lamp_anahtar_1",
  });
  await env.TOKENS.delete(
    `activity-state:production:${instanceID}:${oldActivityID}:device_${deviceID}`
  );
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "new-route-without-state",
      entity_id: "switch.aisle_lamp_anahtar_1",
      display_name: "Giriş Lambası",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  assert.notEqual(
    await env.TOKENS.get(`activity:production:${instanceID}:${oldActivityID}:device_${deviceID}`),
    null
  );
});

test("end tombstone and replacement start remain scoped to the requested device", async () => {
  const captures = [];
  const instanceID = "ha_3a7a3a7a3a7a3a7a3a7a3a7a3a7a3a7a";
  const oldActivityID = "device-scoped-old";
  const requestedActivityID = "device-scoped-new";
  const staleToken = "stale-device-a-route-token-0123456789";
  const env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_STALE_TOKENS: staleToken,
  });
  for (const deviceID of ["device-a", "device-b"]) {
    await register(env, { instanceID, deviceID });
  }
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: oldActivityID,
    displayName: "Giriş Lambası",
    entityID: "switch.aisle_lamp_anahtar_1",
    updateToken: staleToken,
  });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-b",
    activityID: oldActivityID,
    displayName: "Giriş Lambası",
    entityID: "switch.aisle_lamp_anahtar_1",
    updateToken: "live-device-b-route-token-0123456789",
  });
  captures.length = 0;

  const ended = await post(
    env,
    "/end",
    startPayload(instanceID, {
      activity_id: oldActivityID,
      device_id: "device-a",
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.deepEqual(captures.map(({ event, deviceID }) => ({ event, deviceID })), [
    { event: "end", deviceID: "device-a" },
  ]);

  captures.length = 0;
  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: requestedActivityID,
      device_id: "device-a",
      entity_id: "switch.aisle_lamp_anahtar_1",
      display_name: "Giriş Lambası",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(captures.map(({ event, deviceID }) => ({ event, deviceID })), [
    { event: "start", deviceID: "device-a" },
  ]);
  assert.notEqual(
    await env.TOKENS.get(`activity:production:${instanceID}:${oldActivityID}:device_device-a`),
    null
  );
  assert.notEqual(
    await env.TOKENS.get(`activity:production:${instanceID}:${oldActivityID}:device_device-b`),
    null
  );
  assert.notEqual(
    await env.TOKENS.get(`pending-start:production:${instanceID}:${requestedActivityID}:device_device-a`),
    null
  );
  assert.equal(
    await env.TOKENS.get(`pending-start:production:${instanceID}:${requestedActivityID}:device_device-b`),
    null
  );
});

test("entity-backed Set extends one stable activity route to a new device with verified attributes", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_3b4b3b4b3b4b3b4b3b4b3b4b3b4b3b4b";
  const entityData = { entity_based: true, source_service: "set_activity" };
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  const first = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "stable-light",
      entity_id: "switch.aisle_lamp_anahtar_1",
      display_name: "Giriş Lambası",
      allow_entity_control: true,
      data: entityData,
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: "stable-light",
    displayName: "Giriş Lambası",
    entityID: "switch.aisle_lamp_anahtar_1",
  });
  await register(env, { instanceID, deviceID: "device-b" });
  captures.length = 0;

  const second = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "stable-light",
      entity_id: "switch.aisle_lamp_anahtar_1",
      display_name: "Giriş Lambası",
      allow_entity_control: true,
      data: entityData,
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.updated_existing, 1);
  assert.equal(second.body.started, 1);
  assert.equal(second.body.immutable_attributes_verified, true);
  const newDeviceStart = captures.find((entry) => (
    entry.event === "start" && entry.deviceID === "device-b"
  ));
  assert.equal(newDeviceStart.payload.aps.attributes.activityId, "stable-light");
  assert.equal(newDeviceStart.payload.aps.attributes.primaryEntityId, "switch.aisle_lamp_anahtar_1");
  assert.equal(newDeviceStart.payload.aps.attributes.allowsEntityControl, true);
  const pending = JSON.parse(await env.TOKENS.get(
    `pending-start:production:${instanceID}:stable-light:device_device-b`
  ));
  assert.deepEqual(pending.start_attributes, newDeviceStart.payload.aps.attributes);
});

test("entity-backed Set reconciles different existing ids across devices into one canonical id", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d";
  for (const deviceID of ["device-a", "device-b"]) {
    await register(env, { instanceID, deviceID });
  }
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: "first",
    entityID: "switch.same_entity",
  });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-b",
    activityID: "second",
    entityID: "switch.same_entity",
  });

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "third",
      entity_id: "switch.same_entity",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(captures.filter(({ event }) => event === "end").length, 2);
  assert.equal(captures.filter(({ event }) => event === "start").length, 2);
});

test("entity-backed Set recovery remains scoped to the requested instance and device", async () => {
  const env = makeEnv();
  const instanceA = "ha_3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e";
  const instanceB = "ha_3f3e3f3e3f3e3f3e3f3e3f3e3f3e3f3e";
  await register(env, { instanceID: instanceA, deviceID: "device-a" });
  await register(env, { instanceID: instanceA, deviceID: "device-b" });
  await register(env, { instanceID: instanceB, deviceID: "device-a" });
  const secretA = await provisionInstance(env, { instanceID: instanceA });
  await provisionInstance(env, { instanceID: instanceB });
  await registerActivity(env, {
    instanceID: instanceA,
    deviceID: "device-b",
    activityID: "other-device-id",
    entityID: "switch.same_entity",
  });
  await registerActivity(env, {
    instanceID: instanceB,
    deviceID: "device-a",
    activityID: "other-instance-id",
    entityID: "switch.same_entity",
  });

  const response = await post(
    env,
    "/start",
    startPayload(instanceA, {
      activity_id: "requested-id",
      device_id: "device-a",
      entity_id: "switch.same_entity",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secretA }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.started, 1);
  assert.deepEqual(response.body.reused_entity_activity_ids, []);
  assert.notEqual(
    await env.TOKENS.get(`pending-start:production:${instanceA}:requested-id:device_device-a`),
    null
  );
});

test("entity-backed Set safely restarts detectable immutable control changes", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  const entityData = { entity_based: true, source_service: "set_activity" };
  const first = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "first",
      entity_id: "switch.same_entity",
      allow_entity_control: false,
      data: entityData,
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(first.status, 200);
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: "first",
    entityID: "switch.same_entity",
  });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: "first",
    entityID: "switch.same_entity",
    updateToken: "rotated-update-token",
  });
  const retained = JSON.parse(await env.TOKENS.get(
    `activity:production:${instanceID}:first:device_device-a`
  ));
  assert.equal(retained.start_attributes.allowsEntityControl, undefined);
  assert.equal(retained.start_attributes.activityId, "first");
  captures.length = 0;

  const second = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "first",
      entity_id: "switch.same_entity",
      allow_entity_control: true,
      data: entityData,
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  assert.equal(captures[1].payload.aps.attributes.allowsEntityControl, true);
});

test("entity-backed Set rejects an active requested id bound to another controllable entity", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  const first = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "shared-id",
      entity_id: "switch.first_entity",
      display_name: "First Switch",
      allow_entity_control: true,
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: "shared-id",
    displayName: "First Switch",
    entityID: "switch.first_entity",
  });
  captures.length = 0;

  const second = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "shared-id",
      entity_id: "switch.second_entity",
      display_name: "Second Switch",
      allow_entity_control: true,
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.error, "activity_restart_required");
  assert.match(second.body.message, /end.*restart/i);
  assert.equal(captures.length, 0);
});

test("entity-backed Set rejects a pending requested id bound to another entity", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  const first = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "shared-id",
      entity_id: "switch.first_entity",
      display_name: "First Switch",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(first.status, 200, JSON.stringify(first.body));
  captures.length = 0;

  const second = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "shared-id",
      entity_id: "switch.second_entity",
      display_name: "Second Switch",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.error, "activity_restart_required");
  assert.equal(captures.length, 0);
});

test("entity-backed Set rejects a requested id conflict after resolving another effective id", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: "effective-id",
    displayName: "Target Switch",
    entityID: "switch.target_entity",
  });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: "requested-id",
    displayName: "Other Switch",
    entityID: "switch.other_entity",
  });
  captures.length = 0;

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "requested-id",
      entity_id: "switch.target_entity",
      display_name: "Target Switch",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, "activity_restart_required");
  assert.equal(captures.length, 0);
});

test("raw starts cannot use same-entity Set recovery to bypass duplicate protection", async () => {
  const env = makeEnv();
  const instanceID = "ha_40404040404040404040404040404040";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: "first",
    displayName: "Same Name",
    entityID: "switch.same_entity",
  });

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "second",
      entity_id: "switch.same_entity",
      display_name: "Same Name",
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 409);
  assert.equal(response.body.error, "duplicate_activity_name");
});

test("near-miss entity metadata cannot enable Set recovery", async () => {
  const variants = [
    { entity_based: false, source_service: "set_activity" },
    { entity_based: 1, source_service: "set_activity" },
    { entity_based: true, source_service: " set_activity" },
    { entity_based: true, source_service: "SET_ACTIVITY" },
    { entity_based: true, source_service: "start_entity_activity" },
  ];
  for (let index = 0; index < variants.length; index += 1) {
    const env = makeEnv();
    const instanceID = `ha_${String(index + 50).repeat(32).slice(0, 32)}`;
    await register(env, { instanceID, deviceID: "device-a" });
    const secret = await provisionInstance(env, { instanceID });
    await registerActivity(env, {
      instanceID,
      deviceID: "device-a",
      activityID: "first",
      displayName: "Same Name",
      entityID: "switch.same_entity",
    });

    const response = await post(
      env,
      "/start",
      startPayload(instanceID, {
        activity_id: "second",
        entity_id: "switch.same_entity",
        display_name: "Same Name",
        data: variants[index],
      }),
      { "X-HA-LiveKit-Secret": secret }
    );

    assert.equal(response.status, 409, JSON.stringify({ variant: variants[index], body: response.body }));
    assert.equal(response.body.error, "duplicate_activity_name");
  }
});

test("entity-backed Set reconciles multiple same-entity activities into one canonical route", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_41414141414141414141414141414141";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  for (const [activityID, displayName] of [["first", "First"], ["second", "Second"]]) {
    await registerActivity(env, {
      instanceID,
      deviceID: "device-a",
      activityID,
      displayName,
      entityID: "switch.same_entity",
    });
  }

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "third",
      entity_id: "switch.same_entity",
      display_name: "Third",
      data: { entity_based: true, source_service: "set_activity" },
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(captures.filter(({ event }) => event === "end").length, 2);
  assert.equal(captures.filter(({ event }) => event === "start").length, 1);
});

test("entity Set duplicate-name preflight performs no reconciliation side effects", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_81818181818181818181818181818181";
  const deviceID = "device-a";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: "old-target-route",
    displayName: "Shared Name",
    entityID: "switch.target",
  });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: "other-entity-route",
    displayName: "Shared Name",
    entityID: "switch.other",
  });
  captures.length = 0;

  const response = await post(env, "/start", startPayload(instanceID, {
    activity_id: "canonical-route",
    entity_id: "switch.target",
    display_name: "Shared Name",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, "duplicate_activity_name");
  assert.equal(captures.length, 0);
  const storage = env.AUTH_STATE.objects.get(instanceID).storage;
  assert.equal(
    (await storage.get(`activity-current:production:${deviceID}:old-target-route`)).status,
    "active"
  );
  assert.equal(
    (await storage.get(`activity-current:production:${deviceID}:other-entity-route`)).status,
    "active"
  );
  assert.equal(
    [...storage.values.keys()].some((key) => key.startsWith("entity-set-reservation:")),
    false
  );
});

test("raw Start cannot spoof reserved Set markers without the authenticated operation header", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_82828282828282828282828282828282";
  const deviceID = "device-a";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: "old-route",
    displayName: "Spoof Target",
    entityID: "switch.target",
  });
  captures.length = 0;

  const response = await post(env, "/start", startPayload(instanceID, {
    activity_id: "spoofed-route",
    entity_id: "switch.target",
    display_name: "Spoof Target",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret }, { authenticateEntitySet: false });

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, "duplicate_activity_name");
  assert.equal(captures.length, 0);
  const pointer = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `activity-current:production:${deviceID}:old-route`
  );
  assert.equal(pointer.status, "active");
});

test("entity Set fence rejects a delayed old-route callback without aborting the safe Set", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_83838383838383838383838383838383";
  const deviceID = "device-a";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: "old-route",
    displayName: "Old Display",
    entityID: "switch.target",
  });
  const injected = injectActivityRegistrationAfterNextAuthAction(
    env,
    "claim_entity_set_reservation",
    {
      instanceID,
      deviceID,
      activityID: "old-route",
      displayName: "Delayed Different Display",
      entityID: "switch.target",
      updateToken: "delayed-old-route-token-0123456789",
    }
  );
  captures.length = 0;

  const response = await post(env, "/start", startPayload(instanceID, {
    activity_id: "canonical-route",
    entity_id: "switch.target",
    display_name: "Canonical Display",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(injected(), true);
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
});

test("entity Set fence rejects a late same-id old-controls callback without aborting safe Set", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_84848484848484848484848484848484";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const initial = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    allow_entity_control: false,
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "switch.target",
  });
  const injected = injectActivityRegistrationAfterNextAuthAction(
    env,
    "claim_entity_set_reservation",
    {
      instanceID,
      deviceID,
      activityID,
      entityID: "switch.target",
      updateToken: "late-old-controls-token-0123456789",
    }
  );
  captures.length = 0;

  const response = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    allow_entity_control: true,
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(injected(), true);
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
});

test("concurrent entity Set calls serialize to at most one canonical start", async () => {
  const captures = [];
  let releaseFirstStart;
  let announceFirstStart;
  const firstStartReached = new Promise((resolve) => { announceFirstStart = resolve; });
  const firstStartGate = new Promise((resolve) => { releaseFirstStart = resolve; });
  let held = false;
  const env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_BEFORE_SEND: async ({ event }) => {
      if (event !== "start" || held) return;
      held = true;
      announceFirstStart();
      await firstStartGate;
    },
  });
  const instanceID = "ha_85858585858585858585858585858585";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  const payload = startPayload(instanceID, {
    activity_id: "canonical-route",
    entity_id: "switch.target",
    data: { entity_based: true, source_service: "set_activity" },
  });

  const firstPromise = post(env, "/start", payload, { "X-HA-LiveKit-Secret": secret });
  await firstStartReached;
  const second = await post(env, "/start", payload, { "X-HA-LiveKit-Secret": secret });
  releaseFirstStart();
  const first = await firstPromise;

  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.error, "entity_activity_reconciliation_retry_required");
  assert.equal(captures.filter(({ event }) => event === "start").length, 1);
});

test("entity Set accepts its exact canonical callback during APNs Start and commits active route", async () => {
  const captures = [];
  const instanceID = "ha_87878787878787878787878787878787";
  const deviceID = "device-a";
  let callbackResponse;
  let injected = false;
  let env;
  env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_BEFORE_SEND: async ({ event }) => {
      if (event !== "start" || injected) return;
      injected = true;
      callbackResponse = await registerActivity(env, {
        instanceID,
        deviceID,
        activityID: "canonical-route",
        activityKitID: "kit-canonical-new",
        updateToken: "canonical-callback-token-0123456789",
        assertStatus: false,
      });
    },
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });

  const response = await post(env, "/start", startPayload(instanceID, {
    activity_id: "canonical-route",
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });

  assert.equal(callbackResponse.status, 200, JSON.stringify(callbackResponse.body));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(captures.filter(({ event }) => event === "start").length, 1);
  assert.equal(
    await env.TOKENS.get(
      `pending-start:production:${instanceID}:canonical-route:device_${deviceID}`
    ),
    null
  );
  const storage = env.AUTH_STATE.objects.get(instanceID).storage;
  const route = await storage.get(
    `entity-route:production:${deviceID}:switch.target`
  );
  const pointer = await storage.get(
    `activity-current:production:${deviceID}:canonical-route`
  );
  assert.equal(route.state, "active");
  assert.equal(route.active_activity_kit_id, "kit-canonical-new");
  assert.equal(pointer.activity_kit_id, "kit-canonical-new");
  assert.equal(
    [...storage.values.keys()].some((key) => key.startsWith("entity-set-reservation:")),
    false
  );
});

test("entity route rejects a delayed old-id callback during canonical Start", async () => {
  const captures = [];
  const instanceID = "ha_88888888888888888888888888888888";
  const deviceID = "device-a";
  const oldKit = "kit-old-route";
  let obsoleteResponse;
  let injected = false;
  let env;
  env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_BEFORE_SEND: async ({ event }) => {
      if (event !== "start" || injected) return;
      injected = true;
      obsoleteResponse = await registerActivity(env, {
        instanceID,
        deviceID,
        activityID: "old-route",
        entityID: "switch.target",
        displayName: "Old Target",
        activityKitID: oldKit,
        updateToken: "obsolete-old-route-token-0123456789",
        assertStatus: false,
      });
    },
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: "old-route",
    entityID: "switch.target",
    displayName: "Old Target",
    activityKitID: oldKit,
  });
  captures.length = 0;

  const response = await post(env, "/start", startPayload(instanceID, {
    activity_id: "canonical-route",
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });

  assert.equal(obsoleteResponse.status, 409, JSON.stringify(obsoleteResponse.body));
  assert.equal(obsoleteResponse.body.error, "obsolete_entity_activity_route");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
  const oldPointer = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `activity-current:production:${deviceID}:old-route`
  );
  assert.equal(oldPointer.status, "stale");
});

test("same-id immutable restart rejects the retired ActivityKit callback", async () => {
  const captures = [];
  const instanceID = "ha_89898989898989898989898989898989";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const oldKit = "kit-controls-old";
  let obsoleteResponse;
  let injectOldCallback = false;
  let injected = false;
  let env;
  env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_BEFORE_SEND: async ({ event }) => {
      if (event !== "start" || !injectOldCallback || injected) return;
      injected = true;
      obsoleteResponse = await registerActivity(env, {
        instanceID,
        deviceID,
        activityID,
        entityID: "switch.target",
        activityKitID: oldKit,
        updateToken: "obsolete-controls-token-0123456789",
        assertStatus: false,
      });
    },
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const initial = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    allow_entity_control: false,
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "switch.target",
    activityKitID: oldKit,
  });
  captures.length = 0;
  injectOldCallback = true;

  const restarted = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    allow_entity_control: true,
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });

  assert.equal(obsoleteResponse.status, 409, JSON.stringify(obsoleteResponse.body));
  assert.equal(obsoleteResponse.body.error, "obsolete_activity_registration");
  assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);
});

test("entity Set accepts the replacement callback after canonical update token returns 410", async () => {
  const captures = [];
  const instanceID = "ha_8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const staleUpdateToken = "stale-canonical-update-token-0123456789";
  let injectReplacement = false;
  let injected = false;
  let replacementResponse;
  let env;
  env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_STALE_TOKENS: staleUpdateToken,
    APNS_MOCK_BEFORE_SEND: async ({ event }) => {
      if (event !== "start" || !injectReplacement || injected) return;
      injected = true;
      replacementResponse = await registerActivity(env, {
        instanceID,
        deviceID,
        activityID,
        entityID: "switch.target",
        activityKitID: "kit-canonical-replacement",
        updateToken: "replacement-update-token-0123456789",
        assertStatus: false,
      });
    },
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const payload = startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    data: { entity_based: true, source_service: "set_activity" },
  });

  const initial = await post(env, "/start", payload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "switch.target",
    activityKitID: "kit-canonical-stale",
    updateToken: staleUpdateToken,
  });
  captures.length = 0;
  injectReplacement = true;

  const replaced = await post(env, "/start", payload, {
    "X-HA-LiveKit-Secret": secret,
  });

  assert.equal(replacementResponse.status, 200, JSON.stringify(replacementResponse.body));
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.deepEqual(captures.map(({ event }) => event), ["update", "start"]);
  const storage = env.AUTH_STATE.objects.get(instanceID).storage;
  const route = await storage.get(
    `entity-route:production:${deviceID}:switch.target`
  );
  const pointer = await storage.get(
    `activity-current:production:${deviceID}:${activityID}`
  );
  assert.equal(route.state, "active");
  assert.equal(route.active_activity_kit_id, "kit-canonical-replacement");
  assert.equal(pointer.status, "active");
  assert.equal(pointer.activity_kit_id, "kit-canonical-replacement");
});

test("display claim rejects a different-entity callback racing after Set preflight", async () => {
  const captures = [];
  const instanceID = "ha_8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a";
  const deviceID = "device-a";
  let conflictingResponse;
  let injected = false;
  let env;
  env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_BEFORE_SEND: async ({ event }) => {
      if (event !== "start" || injected) return;
      injected = true;
      conflictingResponse = await registerActivity(env, {
        instanceID,
        deviceID,
        activityID: "other-route",
        entityID: "switch.other",
        displayName: "Shared Name",
        activityKitID: "kit-other-route",
        updateToken: "other-display-token-0123456789",
        assertStatus: false,
      });
    },
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });

  const response = await post(env, "/start", startPayload(instanceID, {
    activity_id: "canonical-route",
    entity_id: "switch.target",
    display_name: "Shared Name",
    title: "Shared Name",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });

  assert.equal(conflictingResponse.status, 409, JSON.stringify(conflictingResponse.body));
  assert.equal(conflictingResponse.body.error, "duplicate_activity_name");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(captures.filter(({ event }) => event === "start").length, 1);
  assert.equal(
    await env.AUTH_STATE.objects.get(instanceID).storage.get(
      `activity-current:production:${deviceID}:other-route`
    ),
    undefined
  );
});

test("ambiguous APNs transport failure cleans owned pending and never reports reused success", async () => {
  const captures = [];
  const instanceID = "ha_8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b";
  const deviceID = "device-a";
  const env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_THROW_AFTER_TRANSPORT: "true",
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const payload = startPayload(instanceID, {
    activity_id: "canonical-route",
    entity_id: "switch.target",
    data: { entity_based: true, source_service: "set_activity" },
  });

  const failed = await post(env, "/start", payload, { "X-HA-LiveKit-Secret": secret });
  assert.equal(failed.status, 502, JSON.stringify(failed.body));
  assert.equal(
    await env.TOKENS.get(
      `pending-start:production:${instanceID}:canonical-route:device_${deviceID}`
    ),
    null
  );
  assert.equal(captures.length, 0);
  env.APNS_MOCK_THROW_AFTER_TRANSPORT = "false";
  const retry = await post(env, "/start", payload, { "X-HA-LiveKit-Secret": secret });
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  assert.equal(retry.body.error, "entity_activity_reconciliation_retry_required");
  assert.equal(retry.body.reused_pending, undefined);
  const route = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `entity-route:production:${deviceID}:switch.target`
  );
  assert.equal(route.state, "uncertain");
});

test("committed entity route rejects obsolete callbacks and leaves canonical generation active", async () => {
  const captures = [];
  const instanceID = "ha_8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c";
  const deviceID = "device-a";
  let expectedResponse;
  let injected = false;
  let env;
  env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_BEFORE_SEND: async ({ event }) => {
      if (event !== "start" || injected) return;
      injected = true;
      expectedResponse = await registerActivity(env, {
        instanceID,
        deviceID,
        activityID: "canonical-route",
        activityKitID: "kit-canonical-committed",
        updateToken: "committed-canonical-token-0123456789",
        assertStatus: false,
      });
    },
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const started = await post(env, "/start", startPayload(instanceID, {
    activity_id: "canonical-route",
    entity_id: "switch.target",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(expectedResponse.status, 200, JSON.stringify(expectedResponse.body));

  const storage = env.AUTH_STATE.objects.get(instanceID).storage;
  const before = await storage.get(
    `activity-current:production:${deviceID}:canonical-route`
  );
  const obsoleteDifferentID = await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: "old-route",
    entityID: "switch.target",
    displayName: "Front Door",
    activityKitID: "kit-obsolete-different-id",
    updateToken: "obsolete-different-id-token-0123456789",
    assertStatus: false,
  });
  const obsoleteSameID = await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: "canonical-route",
    entityID: "switch.target",
    displayName: "Front Door",
    activityKitID: "kit-obsolete-same-id",
    updateToken: "obsolete-same-id-token-0123456789",
    assertStatus: false,
  });

  assert.equal(obsoleteDifferentID.status, 409, JSON.stringify(obsoleteDifferentID.body));
  assert.equal(obsoleteSameID.status, 409, JSON.stringify(obsoleteSameID.body));
  const after = await storage.get(
    `activity-current:production:${deviceID}:canonical-route`
  );
  assert.equal(after.activity_registration_generation, before.activity_registration_generation);
  assert.equal(after.activity_kit_id, "kit-canonical-committed");
  assert.equal(
    [...storage.values.keys()].some((key) => key.startsWith("entity-set-version:")),
    false
  );
});

test("metadata-less callback cannot revive a retired activity id behind a canonical route", async () => {
  const captures = [];
  const instanceID = "ha_8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e";
  const deviceID = "device-a";
  const oldActivityID = "old-route";
  const oldActivityKitID = "kit-retired-metadata-less";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: oldActivityID,
    entityID: "switch.target",
    displayName: "Old Target",
    activityKitID: oldActivityKitID,
  });

  const setResponse = await post(env, "/start", startPayload(instanceID, {
    activity_id: "canonical-route",
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(setResponse.status, 200, JSON.stringify(setResponse.body));

  const obsolete = await post(env, "/activity-token", {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    activity_id: oldActivityID,
    activity_kit_id: oldActivityKitID,
    update_token: "metadata-less-retired-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });

  assert.equal(obsolete.status, 409, JSON.stringify(obsolete.body));
  assert.equal(obsolete.body.error, "obsolete_entity_activity_route");
  const pointer = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `activity-current:production:${deviceID}:${oldActivityID}`
  );
  assert.equal(pointer.status, "stale");
});

test("metadata-less canonical callback remains valid after pending expiry when ActivityKit id is new", async () => {
  const captures = [];
  const instanceID = "ha_92929292929292929292929292929292";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const beforeStartMs = Date.now();
  const setPayload = startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  });
  const started = await post(env, "/start", setPayload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await env.TOKENS.delete(
    `pending-start:production:${instanceID}:${activityID}:device_${deviceID}`
  );

  const realDateNow = Date.now;
  Date.now = () => beforeStartMs + (11 * 60 * 1000);
  let callback;
  try {
    callback = await post(env, "/activity-token", {
      device_id: deviceID,
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      activity_id: activityID,
      activity_kit_id: "kit-canonical-after-pending",
      update_token: "canonical-after-pending-token-0123456789",
      apns_mode: "production",
    }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  } finally {
    Date.now = realDateNow;
  }

  assert.equal(callback.status, 200, JSON.stringify(callback.body));
  const route = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `entity-route:production:${deviceID}:switch.target`
  );
  assert.equal(route.state, "active");
  assert.equal(route.active_activity_kit_id, "kit-canonical-after-pending");

  captures.length = 0;
  const repeated = await post(env, "/start", setPayload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.deepEqual(captures.map(({ event }) => event), ["update"]);
});

test("real iOS callback shape inherits missing immutable attributes after pending expiry", async () => {
  const instanceID = "ha_98989898989898989898989898989898";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const env = makeEnv();
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const started = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await env.TOKENS.delete(
    `pending-start:production:${instanceID}:${activityID}:device_${deviceID}`
  );

  const callback = await post(env, "/activity-token", {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    activity_id: activityID,
    activity_kit_id: "kit-real-ios-shape",
    update_token: "real-ios-shape-token-0123456789",
    content_state: {
      title: "Canonical Target",
      subtitle: "On",
      displayName: "Canonical Target",
      entityId: "switch.target",
      primaryState: "On",
      secondaryState: null,
      progress: null,
      value: "On",
      unit: null,
      iconName: "lightbulb",
      theme: "homeAssistant",
      displayStyle: "compactStatus",
      lastUpdated: 12345,
    },
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });

  assert.equal(callback.status, 200, JSON.stringify(callback.body));
  const route = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `entity-route:production:${deviceID}:switch.target`
  );
  assert.equal(route.state, "active");
  assert.equal(route.active_activity_kit_id, "kit-real-ios-shape");
});

test("lost activation response retains the generation payload referenced by the committed pointer", async () => {
  const captures = [];
  const instanceID = "ha_9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c";
  const deviceID = "device-a";
  const activityID = "response-loss-route";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const originalGet = env.AUTH_STATE.get.bind(env.AUTH_STATE);
  let lostActivationResponse = false;
  env.AUTH_STATE.get = (id) => {
    const stub = originalGet(id);
    return {
      async fetch(input, init) {
        const request = input instanceof Request ? input : new Request(input, init);
        const action = (await request.clone().json()).action;
        const response = await stub.fetch(request);
        if (!lostActivationResponse && action === "activate_activity_registration") {
          lostActivationResponse = true;
          throw new Error("Injected lost activation response.");
        }
        return response;
      },
    };
  };

  const callback = await post(env, "/activity-token", {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    activity_id: activityID,
    activity_kit_id: "kit-response-loss",
    update_token: "activation-response-loss-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(callback.status, 503, JSON.stringify(callback.body));
  assert.equal(lostActivationResponse, true);
  const pointer = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `activity-current:production:${deviceID}:${activityID}`
  );
  assert.ok(pointer);
  const generationKey = `activity-generation:production:${instanceID}:${activityID}:device_${deviceID}:generation_${pointer.activity_registration_generation}`;
  assert.notEqual(await env.TOKENS.get(generationKey), null);

  captures.length = 0;
  const update = await post(env, "/update", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Response Loss Route",
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.deepEqual(captures.map(({ event }) => event), ["update"]);
});

test("metadata-less active canonical callback may rotate its token for the exact ActivityKit id", async () => {
  const instanceID = "ha_95959595959595959595959595959595";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const activityKitID = "kit-canonical-current";
  const env = makeEnv();
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const started = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "switch.target",
    displayName: "Canonical Target",
    activityKitID,
  });
  const storage = env.AUTH_STATE.objects.get(instanceID).storage;
  const pointerKey = `activity-current:production:${deviceID}:${activityID}`;
  const before = await storage.get(pointerKey);

  const rotated = await post(env, "/activity-token", {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    activity_id: activityID,
    activity_kit_id: activityKitID,
    update_token: "rotated-current-kit-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });

  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  const after = await storage.get(pointerKey);
  assert.notEqual(
    after.activity_registration_generation,
    before.activity_registration_generation
  );
  const route = await storage.get(`entity-route:production:${deviceID}:switch.target`);
  assert.equal(route.state, "active");
  assert.equal(route.active_activity_kit_id, activityKitID);
  assert.equal(
    route.active_activity_registration_generation,
    after.activity_registration_generation
  );
});

test("raw updates extend the active entity route fence with the activity registration", async () => {
  const captures = [];
  const instanceID = "ha_97979797979797979797979797979797";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const activityKitID = "kit-current-after-route-refresh";
  const env = makeEnv({
    ACTIVITY_TTL_SECONDS: "600",
    APNS_MOCK_REQUESTS: captures,
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const realDateNow = Date.now;
  const startedAtMs = realDateNow();
  try {
    Date.now = () => startedAtMs;
    const started = await post(env, "/start", startPayload(instanceID, {
      activity_id: activityID,
      entity_id: "switch.target",
      display_name: "Canonical Target",
      data: { entity_based: true, source_service: "set_activity" },
    }), { "X-HA-LiveKit-Secret": secret });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    await registerActivity(env, {
      instanceID,
      deviceID,
      activityID,
      entityID: "switch.target",
      displayName: "Canonical Target",
      activityKitID,
    });
    const storage = env.AUTH_STATE.objects.get(instanceID).storage;
    const routeKey = `entity-route:production:${deviceID}:switch.target`;
    const originalRoute = await storage.get(routeKey);

    Date.now = () => startedAtMs + 9 * 60_000;
    captures.length = 0;
    const update = await post(env, "/update", startPayload(instanceID, {
      activity_id: activityID,
      entity_id: "switch.target",
      display_name: "Canonical Target",
      state: "Refreshed",
    }), { "X-HA-LiveKit-Secret": secret });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.deepEqual(captures.map(({ event }) => event), ["update"]);
    const refreshedRoute = await storage.get(routeKey);
    assert.ok(refreshedRoute.expires_at_ms > originalRoute.expires_at_ms);

    Date.now = () => startedAtMs + 11 * 60_000;
    const obsolete = await post(env, "/activity-token", {
      device_id: deviceID,
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      activity_id: activityID,
      activity_kit_id: "kit-obsolete-after-original-expiry",
      update_token: "obsolete-after-original-expiry-token-0123456789",
      apns_mode: "production",
    }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
    assert.equal(obsolete.status, 409, JSON.stringify(obsolete.body));

    const rotation = await post(env, "/activity-token", {
      device_id: deviceID,
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      activity_id: activityID,
      activity_kit_id: activityKitID,
      update_token: "current-after-original-expiry-token-0123456789",
      apns_mode: "production",
    }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
    assert.equal(rotation.status, 200, JSON.stringify(rotation.body));
  } finally {
    Date.now = realDateNow;
  }
});

test("persistent starting route suppresses a duplicate Set after pending KV disappears", async () => {
  const captures = [];
  const instanceID = "ha_94949494949494949494949494949494";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const payload = startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  });
  const first = await post(env, "/start", payload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const storage = env.AUTH_STATE.objects.get(instanceID).storage;
  const routeKey = `entity-route:production:${deviceID}:switch.target`;
  const originalRoute = await storage.get(routeKey);
  await env.TOKENS.delete(
    `pending-start:production:${instanceID}:${activityID}:device_${deviceID}`
  );
  captures.length = 0;

  const repeated = await post(env, "/start", payload, {
    "X-HA-LiveKit-Secret": secret,
  });

  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.started, 0);
  assert.equal(repeated.body.attempted, 0);
  assert.equal(repeated.body.reused_persistent_intent, 1);
  assert.equal(captures.length, 0);
  const unchangedRoute = await storage.get(routeKey);
  assert.equal(unchangedRoute.epoch, originalRoute.epoch);
  assert.equal(unchangedRoute.state, "starting");
});

test("broadcast Set updates active devices without restarting an exact persistent starting device", async () => {
  const captures = [];
  const instanceID = "ha_99999999999999999999999999999999";
  const activityID = "canonical-route";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID: "device-a" });
  await register(env, { instanceID, deviceID: "device-b" });
  const secret = await provisionInstance(env, { instanceID });
  const initialPayload = startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    state: "Off",
    data: { entity_based: true, source_service: "set_activity" },
  });
  const first = await post(env, "/start", initialPayload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(captures.filter(({ event }) => event === "start").length, 2);
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID,
    entityID: "switch.target",
    displayName: "Canonical Target",
    state: "Off",
  });
  await env.TOKENS.delete(
    `pending-start:production:${instanceID}:${activityID}:device_device-b`
  );
  const storage = env.AUTH_STATE.objects.get(instanceID).storage;
  const routeBKey = "entity-route:production:device-b:switch.target";
  const routeBBefore = await storage.get(routeBKey);
  captures.length = 0;

  const repeated = await post(env, "/start", {
    ...initialPayload,
    state: "On",
  }, { "X-HA-LiveKit-Secret": secret });

  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.reused_persistent_intent, 1);
  assert.deepEqual(captures.map(({ event, deviceID }) => ({ event, deviceID })), [
    { event: "update", deviceID: "device-a" },
  ]);
  const routeBAfter = await storage.get(routeBKey);
  assert.equal(routeBAfter.epoch, routeBBefore.epoch);
  assert.equal(routeBAfter.state, "starting");
});

test("raw Start cannot reuse a Set pending intent to claim a different display name", async () => {
  const captures = [];
  const instanceID = "ha_97979797979797979797979797979797";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const setResponse = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(setResponse.status, 200, JSON.stringify(setResponse.body));
  captures.length = 0;

  const raw = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.other",
    display_name: "Polluting Name",
    title: "Polluting Name",
  }), { "X-HA-LiveKit-Secret": secret });

  assert.equal(raw.status, 409, JSON.stringify(raw.body));
  assert.equal(raw.body.error, "pending_activity_intent_conflict");
  assert.equal(captures.length, 0);
  const pollutingHash = await sha256Hex("polluting name");
  const pollutingClaim = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `display-claim:production:${deviceID}:${pollutingHash}`
  );
  assert.equal(pollutingClaim, undefined);
});

test("successful APNs Start survives a reservation commit failure without double delivery", async () => {
  const captures = [];
  const instanceID = "ha_9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const originalGet = env.AUTH_STATE.get.bind(env.AUTH_STATE);
  let failedCommit = false;
  env.AUTH_STATE.get = (id) => {
    const stub = originalGet(id);
    return {
      async fetch(input, init) {
        const request = input instanceof Request ? input : new Request(input, init);
        const action = (await request.clone().json()).action;
        if (!failedCommit && action === "commit_entity_set_reservation") {
          failedCommit = true;
          return new Response(JSON.stringify({ ok: true, committed: false }), {
            headers: { "content-type": "application/json" },
          });
        }
        return await stub.fetch(request);
      },
    };
  };
  const payload = startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  });

  const first = await post(env, "/start", payload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(first.status, 409, JSON.stringify(first.body));
  assert.equal(failedCommit, true);
  assert.equal(captures.filter(({ event }) => event === "start").length, 1);
  const routeKey = `entity-route:production:${deviceID}:switch.target`;
  const routeAfterFailure = await env.AUTH_STATE.objects.get(instanceID).storage.get(routeKey);
  assert.equal(routeAfterFailure.state, "starting");

  captures.length = 0;
  const retry = await post(env, "/start", payload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.started, 0);
  assert.equal(retry.body.reused_persistent_intent, 1);
  assert.equal(captures.length, 0);

  const callback = await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "switch.target",
    displayName: "Canonical Target",
    activityKitID: "kit-after-commit-failure",
  });
  assert.equal(callback.status, 200, JSON.stringify(callback.body));
  const activeRoute = await env.AUTH_STATE.objects.get(instanceID).storage.get(routeKey);
  assert.equal(activeRoute.state, "active");
  assert.equal(activeRoute.active_activity_kit_id, "kit-after-commit-failure");
});

test("lost begin response expires as pre-transport abort and can retry safely", async () => {
  const captures = [];
  const instanceID = "ha_9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const originalGet = env.AUTH_STATE.get.bind(env.AUTH_STATE);
  let lostBeginResponse = false;
  env.AUTH_STATE.get = (id) => {
    const stub = originalGet(id);
    return {
      async fetch(input, init) {
        const request = input instanceof Request ? input : new Request(input, init);
        const action = (await request.clone().json()).action;
        const response = await stub.fetch(request);
        if (!lostBeginResponse && action === "begin_entity_set_reservation") {
          lostBeginResponse = true;
          throw new Error("Injected lost begin response.");
        }
        return response;
      },
    };
  };
  const payload = startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  });
  const first = await post(env, "/start", payload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(first.status, 503, JSON.stringify(first.body));
  assert.equal(lostBeginResponse, true);
  assert.equal(captures.length, 0);

  const realDateNow = Date.now;
  const retryAt = realDateNow() + 21_000;
  Date.now = () => retryAt;
  let retry;
  try {
    retry = await post(env, "/start", payload, {
      "X-HA-LiveKit-Secret": secret,
    });
  } finally {
    Date.now = realDateNow;
  }
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual(captures.map(({ event }) => event), ["start"]);
  const route = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `entity-route:production:${deviceID}:switch.target`
  );
  assert.equal(route.state, "starting");
});

test("Set fails before APNs when a same-id restart has no verifiable ActivityKit identity", async () => {
  const captures = [];
  const instanceID = "ha_96969696969696969696969696969696";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const legacy = await post(env, "/activity-token", {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    activity_id: activityID,
    update_token: "unknown-immutable-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  captures.length = 0;

  const response = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, "activity_restart_identity_required");
  assert.equal(captures.length, 0);
  const pointer = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `activity-current:production:${deviceID}:${activityID}`
  );
  assert.equal(pointer.status, "active");
  assert.equal(
    await env.TOKENS.get(
      `pending-start:production:${instanceID}:${activityID}:device_${deviceID}`
    ),
    null
  );
  assert.equal(
    await env.AUTH_STATE.objects.get(instanceID).storage.get(
      `entity-route:production:${deviceID}:switch.target`
    ),
    undefined
  );
});

test("same-id immutable restart ignores stale fixed attributes after pending expiry", async () => {
  const captures = [];
  const instanceID = "ha_9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const oldActivityKitID = "kit-controls-off";
  const newActivityKitID = "kit-controls-on";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const initial = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "light.target",
    display_name: "Canonical Target",
    allow_entity_control: false,
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "light.target",
    displayName: "Canonical Target",
    activityKitID: oldActivityKitID,
  });

  captures.length = 0;
  const replacement = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "light.target",
    display_name: "Canonical Target",
    allow_entity_control: true,
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
  assert.deepEqual(captures.map(({ event }) => event), ["end", "start"]);

  const missingKit = await post(env, "/activity-token", {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    activity_id: activityID,
    update_token: "missing-kit-during-replacement-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(missingKit.status, 409, JSON.stringify(missingKit.body));
  const stillStarting = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `entity-route:production:${deviceID}:light.target`
  );
  assert.equal(stillStarting.state, "starting");

  await env.TOKENS.delete(
    `pending-start:production:${instanceID}:${activityID}:device_${deviceID}`
  );

  const callback = await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "light.target",
    displayName: "Canonical Target",
    activityKitID: newActivityKitID,
    assertStatus: false,
  });
  assert.equal(callback.status, 200, JSON.stringify(callback.body));

  const delayed = await post(env, "/activity-token", {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    activity_id: activityID,
    activity_kit_id: oldActivityKitID,
    update_token: "delayed-controls-off-token-0123456789",
    content_state: {
      title: "Canonical Target",
      subtitle: "Off",
      displayName: "Canonical Target",
      entityId: "light.target",
      primaryState: "Off",
      secondaryState: null,
      progress: null,
      value: "Off",
      unit: null,
      iconName: "lightbulb",
      theme: "homeAssistant",
      displayStyle: "compactStatus",
      lastUpdated: 12345,
    },
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(delayed.status, 409, JSON.stringify(delayed.body));
});

test("a persisted no-kit tombstone permits only the exact active ActivityKit rotation", async () => {
  const instanceID = "ha_9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const currentActivityKitID = "kit-current-with-legacy-tombstone";
  const env = makeEnv();
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const started = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "switch.target",
    displayName: "Canonical Target",
    activityKitID: currentActivityKitID,
  });
  const storage = env.AUTH_STATE.objects.get(instanceID).storage;
  const routeKey = `entity-route:production:${deviceID}:switch.target`;
  const route = await storage.get(routeKey);
  await storage.put(routeKey, {
    ...route,
    retired_activity_identities: [{
      activity_id: activityID,
      activity_registration_generation: "ar_aaaaaaaaaaaaaaaaaaaaaa",
    }],
  });

  const rotation = await post(env, "/activity-token", {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    activity_id: activityID,
    activity_kit_id: currentActivityKitID,
    update_token: "current-kit-with-no-kit-tombstone-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(rotation.status, 200, JSON.stringify(rotation.body));

  const ambiguous = await post(env, "/activity-token", {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    activity_id: activityID,
    activity_kit_id: "arbitrary-old-kit",
    update_token: "no-kit-delayed-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(ambiguous.status, 409, JSON.stringify(ambiguous.body));
  assert.equal(ambiguous.body.error, "ambiguous_activity_registration");
  const unchangedRoute = await storage.get(routeKey);
  assert.equal(unchangedRoute.state, "active");
  assert.equal(unchangedRoute.active_activity_kit_id, currentActivityKitID);
});

test("replacement retains the old active identity when End route cleanup response fails", async () => {
  const captures = [];
  const instanceID = "ha_9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const oldActivityKitID = "kit-before-route-clear-loss";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const initial = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "switch.target",
    displayName: "Canonical Target",
    activityKitID: oldActivityKitID,
  });
  const originalGet = env.AUTH_STATE.get.bind(env.AUTH_STATE);
  let lostClearResponse = false;
  env.AUTH_STATE.get = (id) => {
    const stub = originalGet(id);
    return {
      async fetch(input, init) {
        const request = input instanceof Request ? input : new Request(input, init);
        const action = (await request.clone().json()).action;
        if (!lostClearResponse && action === "clear_activity_route_state") {
          lostClearResponse = true;
          throw new Error("Injected route-clear response loss.");
        }
        return await stub.fetch(request);
      },
    };
  };
  const ended = await post(env, "/end", startPayload(instanceID, {
    activity_id: activityID,
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal(lostClearResponse, true);
  captures.length = 0;

  const replacement = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    allow_entity_control: true,
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
  assert.deepEqual(captures.map(({ event }) => event), ["start"]);
  await env.TOKENS.delete(
    `pending-start:production:${instanceID}:${activityID}:device_${deviceID}`
  );

  const obsolete = await post(env, "/activity-token", {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    activity_id: activityID,
    activity_kit_id: oldActivityKitID,
    update_token: "delayed-after-clear-loss-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(obsolete.status, 409, JSON.stringify(obsolete.body));
  assert.ok([
    "obsolete_activity_registration",
    "ambiguous_activity_registration",
  ].includes(obsolete.body.error));
  const route = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `entity-route:production:${deviceID}:switch.target`
  );
  assert.ok(route.retired_activity_identities.some((identity) => (
    identity.activity_kit_id === oldActivityKitID
  )));
});

test("successful End retains an ActivityKit tombstone without blocking a genuinely new raw kit", async () => {
  const captures = [];
  const instanceID = "ha_9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const endedActivityKitID = "kit-ended-route";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const started = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "switch.target",
    displayName: "Canonical Target",
    activityKitID: endedActivityKitID,
  });

  const ended = await post(env, "/end", startPayload(instanceID, {
    activity_id: activityID,
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  const storage = env.AUTH_STATE.objects.get(instanceID).storage;
  const routeKey = `entity-route:production:${deviceID}:switch.target`;
  const endedRoute = await storage.get(routeKey);
  assert.equal(endedRoute.state, "ended");

  const delayed = await post(env, "/activity-token", {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    activity_id: activityID,
    activity_kit_id: endedActivityKitID,
    update_token: "delayed-ended-kit-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(delayed.status, 409, JSON.stringify(delayed.body));

  const genuinelyNew = await post(env, "/activity-token", {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    activity_id: activityID,
    activity_kit_id: "kit-genuinely-new-raw-route",
    update_token: "genuinely-new-raw-kit-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(genuinelyNew.status, 200, JSON.stringify(genuinelyNew.body));
  const rawPointer = await storage.get(
    `activity-current:production:${deviceID}:${activityID}`
  );
  assert.equal(rawPointer.status, "active");
  assert.equal(rawPointer.activity_kit_id, "kit-genuinely-new-raw-route");
});

test("a properly ended route trims its oldest tombstones instead of blocking new IDs", async () => {
  const instanceID = "ha_94949494949494949494949494949494";
  const deviceID = "device-a";
  const env = makeEnv();
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });

  for (let index = 0; index <= 8; index += 1) {
    const activityID = `ended-route-${index}`;
    const response = await post(env, "/start", startPayload(instanceID, {
      activity_id: activityID,
      entity_id: "switch.ended_target",
      display_name: `Ended Route ${index}`,
      data: { entity_based: true, source_service: "set_activity" },
    }), { "X-HA-LiveKit-Secret": secret });
    assert.equal(response.status, 200, JSON.stringify({ index, body: response.body }));
    await registerActivity(env, {
      instanceID,
      deviceID,
      activityID,
      entityID: "switch.ended_target",
      displayName: `Ended Route ${index}`,
      activityKitID: `kit-ended-route-${index}`,
    });
  }

  // The documented recovery: the authorized HA caller ends the current activity.
  const end = await post(env, "/end", {
    home_assistant_instance_id: instanceID,
    activity_id: "ended-route-8",
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": secret });
  assert.equal(end.status, 200, JSON.stringify(end.body));

  // The next Set with a new ID must now trim the oldest tombstones and proceed.
  const revived = await post(env, "/start", startPayload(instanceID, {
    activity_id: "ended-route-9",
    entity_id: "switch.ended_target",
    display_name: "Ended Route 9",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(revived.status, 200, JSON.stringify(revived.body));
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: "ended-route-9",
    entityID: "switch.ended_target",
    displayName: "Ended Route 9",
    activityKitID: "kit-ended-route-9",
  });

  // With the route active again, unfinished churn still fails closed.
  const blocked = await post(env, "/start", startPayload(instanceID, {
    activity_id: "ended-route-10",
    entity_id: "switch.ended_target",
    display_name: "Ended Route 10",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.error, "entity_route_history_capacity");
});

test("entity route history cap rejects alias churn before any live tombstone is evicted", async () => {
  const captures = [];
  const instanceID = "ha_93939393939393939393939393939393";
  const deviceID = "device-a";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });

  for (let index = 0; index <= 8; index += 1) {
    const activityID = `route-${index}`;
    const response = await post(env, "/start", startPayload(instanceID, {
      activity_id: activityID,
      entity_id: "switch.target",
      display_name: `Route ${index}`,
      data: { entity_based: true, source_service: "set_activity" },
    }), { "X-HA-LiveKit-Secret": secret });
    assert.equal(response.status, 200, JSON.stringify({ index, body: response.body }));
    await registerActivity(env, {
      instanceID,
      deviceID,
      activityID,
      entityID: "switch.target",
      displayName: `Route ${index}`,
      activityKitID: `kit-route-${index}`,
    });
  }
  captures.length = 0;

  const overflow = await post(env, "/start", startPayload(instanceID, {
    activity_id: "route-9",
    entity_id: "switch.target",
    display_name: "Route 9",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(overflow.status, 409, JSON.stringify(overflow.body));
  assert.equal(overflow.body.error, "entity_route_history_capacity");
  assert.equal(captures.length, 0);

  const obsolete = await post(env, "/activity-token", {
    device_id: deviceID,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    activity_id: "route-0",
    activity_kit_id: "kit-route-0",
    update_token: "oldest-retired-alias-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(obsolete.status, 409, JSON.stringify(obsolete.body));
  assert.equal(obsolete.body.error, "obsolete_entity_activity_route");
  const pointer = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `activity-current:production:${deviceID}:route-8`
  );
  assert.equal(pointer.status, "active");
});

test("raw active rename cannot race a Set display-name claim", async () => {
  const captures = [];
  const instanceID = "ha_8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f";
  const deviceID = "device-a";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: "raw-route",
    entityID: "switch.other",
    displayName: "Other Name",
  });
  captures.length = 0;

  let injected = false;
  let rawResponse;
  const originalGet = env.AUTH_STATE.get.bind(env.AUTH_STATE);
  env.AUTH_STATE.get = (id) => {
    const stub = originalGet(id);
    return {
      async fetch(input, init) {
        const request = input instanceof Request ? input : new Request(input, init);
        const payload = await request.clone().json();
        const response = await stub.fetch(request);
        if (!injected && payload.action === "claim_entity_set_reservation") {
          injected = true;
          rawResponse = await post(env, "/start", startPayload(instanceID, {
            activity_id: "raw-route",
            entity_id: "switch.other",
            display_name: "Shared Name",
            title: "Shared Name",
          }), { "X-HA-LiveKit-Secret": secret });
        }
        return response;
      },
    };
  };

  const setResponse = await post(env, "/start", startPayload(instanceID, {
    activity_id: "canonical-route",
    entity_id: "switch.target",
    display_name: "Shared Name",
    title: "Shared Name",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });

  assert.equal(injected, true);
  assert.equal(rawResponse.status, 409, JSON.stringify(rawResponse.body));
  assert.equal(rawResponse.body.error, "activity_display_claim_retry_required");
  assert.equal(setResponse.status, 200, JSON.stringify(setResponse.body));
  assert.deepEqual(captures.map(({ event }) => event), ["start"]);
});

test("committed starting route retains retired callback fence for the activity TTL", async () => {
  const instanceID = "ha_90909090909090909090909090909090";
  const deviceID = "device-a";
  const oldActivityID = "old-route";
  const oldActivityKitID = "kit-retired-long-fence";
  const env = makeEnv();
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID: oldActivityID,
    entityID: "switch.target",
    displayName: "Old Target",
    activityKitID: oldActivityKitID,
  });
  const beforeSetMs = Date.now();

  const setResponse = await post(env, "/start", startPayload(instanceID, {
    activity_id: "canonical-route",
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(setResponse.status, 200, JSON.stringify(setResponse.body));
  const route = await env.AUTH_STATE.objects.get(instanceID).storage.get(
    `entity-route:production:${deviceID}:switch.target`
  );
  assert.equal(route.state, "starting");
  assert.ok(
    route.expires_at_ms >= beforeSetMs + (47 * 60 * 60 * 1000),
    JSON.stringify(route)
  );

  await env.TOKENS.delete(
    `pending-start:production:${instanceID}:canonical-route:device_${deviceID}`
  );
  const realDateNow = Date.now;
  Date.now = () => beforeSetMs + (11 * 60 * 1000);
  let obsolete;
  try {
    obsolete = await registerActivity(env, {
      instanceID,
      deviceID,
      activityID: oldActivityID,
      entityID: "switch.target",
      displayName: "Old Target",
      activityKitID: oldActivityKitID,
      updateToken: "expired-intent-retired-token-0123456789",
      assertStatus: false,
    });
  } finally {
    Date.now = realDateNow;
  }
  assert.equal(obsolete.status, 409, JSON.stringify(obsolete.body));
  assert.equal(obsolete.body.error, "obsolete_entity_activity_route");
});

test("raw ambiguous Start delivery blocks retry without a second APNs send", async () => {
  let sends = 0;
  const instanceID = "ha_91919191919191919191919191919191";
  const deviceID = "device-a";
  const env = makeEnv({
    APNS_MOCK_THROW_AFTER_TRANSPORT: "true",
    APNS_MOCK_BEFORE_SEND: async ({ event }) => {
      if (event === "start") sends += 1;
    },
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const payload = startPayload(instanceID, {
    activity_id: "raw-route",
    entity_id: "switch.raw",
    display_name: "Raw Route",
  });

  const failed = await post(env, "/start", payload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(failed.status, 502, JSON.stringify(failed.body));
  assert.equal(sends, 1);

  env.APNS_MOCK_THROW_AFTER_TRANSPORT = "false";
  const retry = await post(env, "/start", payload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  assert.equal(retry.body.error, "activity_delivery_uncertain");
  assert.equal(sends, 1);
});

test("entity Set releases its fence after APNs failure so a retry can proceed", async () => {
  const captures = [];
  const instanceID = "ha_86868686868686868686868686868686";
  const deviceID = "device-a";
  const pushToken = `push-token-${instanceID}-${deviceID}`;
  const env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_FAILURE_TOKENS: pushToken,
  });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const payload = startPayload(instanceID, {
    activity_id: "canonical-route",
    entity_id: "switch.target",
    data: { entity_based: true, source_service: "set_activity" },
  });

  const failed = await post(env, "/start", payload, { "X-HA-LiveKit-Secret": secret });
  assert.equal(failed.status, 502, JSON.stringify(failed.body));
  env.APNS_MOCK_FAILURE_TOKENS = "";
  const retried = await post(env, "/start", payload, { "X-HA-LiveKit-Secret": secret });

  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(
    [...env.AUTH_STATE.objects.get(instanceID).storage.values.keys()]
      .some((key) => key.startsWith("entity-set-reservation:")),
    false
  );
});

test("broadcast Set retries only the device with a definitive APNs Start failure", async () => {
  const captures = [];
  const instanceID = "ha_89898989898989898989898989898989";
  const activityID = "canonical-route";
  const failedDeviceID = "device-b";
  const failedPushToken = `push-token-${instanceID}-${failedDeviceID}`;
  const env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_FAILURE_TOKENS: failedPushToken,
  });
  await register(env, { instanceID, deviceID: "device-a" });
  await register(env, { instanceID, deviceID: failedDeviceID });
  const secret = await provisionInstance(env, { instanceID });
  const payload = startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Canonical Target",
    data: { entity_based: true, source_service: "set_activity" },
  });

  const partial = await post(env, "/start", payload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(partial.status, 207, JSON.stringify(partial.body));
  assert.deepEqual(captures.map(({ deviceID, event }) => ({ deviceID, event })), [
    { deviceID: "device-a", event: "start" },
    { deviceID: failedDeviceID, event: "start" },
  ]);
  const storage = env.AUTH_STATE.objects.get(instanceID).storage;
  assert.equal(
    (await storage.get("entity-route:production:device-a:switch.target")).state,
    "starting"
  );
  assert.equal(
    (await storage.get(`entity-route:production:${failedDeviceID}:switch.target`)).state,
    "aborted"
  );

  env.APNS_MOCK_FAILURE_TOKENS = "";
  captures.length = 0;
  const retried = await post(env, "/start", payload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.deepEqual(captures.map(({ deviceID, event }) => ({ deviceID, event })), [
    { deviceID: failedDeviceID, event: "start" },
  ]);
});

test("a failed entity Set rename releases the old display claim after a successful retry", async () => {
  const captures = [];
  const instanceID = "ha_8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a";
  const deviceID = "device-a";
  const activityID = "canonical-route";
  const updateToken = "display-rename-update-token-0123456789";
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const initial = await post(env, "/start", startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Display A",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  await registerActivity(env, {
    instanceID,
    deviceID,
    activityID,
    entityID: "switch.target",
    displayName: "Display A",
    updateToken,
  });
  const displayAHash = await sha256Hex("display a");
  const displayAClaimKey = `display-claim:production:${deviceID}:${displayAHash}`;
  assert.notEqual(
    await env.AUTH_STATE.objects.get(instanceID).storage.get(displayAClaimKey),
    undefined
  );

  const renamedPayload = startPayload(instanceID, {
    activity_id: activityID,
    entity_id: "switch.target",
    display_name: "Display B",
    data: { entity_based: true, source_service: "set_activity" },
  });
  env.APNS_MOCK_FAILURE_TOKENS = updateToken;
  captures.length = 0;
  const failed = await post(env, "/start", renamedPayload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(failed.status, 502, JSON.stringify(failed.body));
  assert.deepEqual(captures.map(({ event }) => event), ["update"]);
  assert.notEqual(
    await env.AUTH_STATE.objects.get(instanceID).storage.get(displayAClaimKey),
    undefined
  );

  env.APNS_MOCK_FAILURE_TOKENS = "";
  captures.length = 0;
  const retried = await post(env, "/start", renamedPayload, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.deepEqual(captures.map(({ event }) => event), ["update"]);

  assert.equal(
    await env.AUTH_STATE.objects.get(instanceID).storage.get(displayAClaimKey),
    undefined
  );

  captures.length = 0;
  const reuse = await post(env, "/start", startPayload(instanceID, {
    activity_id: "other-route",
    entity_id: "switch.other",
    display_name: "Display A",
    data: { entity_based: true, source_service: "set_activity" },
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(reuse.status, 200, JSON.stringify(reuse.body));
  assert.deepEqual(captures.map(({ event }) => event), ["start"]);
});

test("Durable Object entity Set reservations expire and release only by exact owner", async () => {
  const storage = new MemoryDurableStorage();
  const state = new RelayAuthState({ storage });
  const nowMs = Date.now();
  await storage.put("activity-authority", {
    enabled: true,
    schema_version: 1,
    enabled_at_ms: nowMs,
  });
  const base = {
    action: "begin_entity_set_reservation",
    environment: "production",
    entity_id: "switch.target",
    device_id: "device-a",
    activity_snapshot: [],
    canonical_activity_id: "canonical-route",
    start_attributes_hash: "a".repeat(64),
    display_name_hash: null,
    intent_device_ids: ["device-a"],
    hard_deadline_ms: nowMs + 60_000,
    intent_expires_at_ms: nowMs + 30_000,
    route_expires_at_ms: nowMs + 60_000,
  };
  const first = await authStateAction(state, {
    ...base,
    owner_nonce: "es_aaaaaaaaaaaaaaaaaaaaaa",
    operation_epoch: "set_aaaaaaaaaaaaaaaaaaaaaa",
    now_ms: nowMs,
    expires_at_ms: nowMs + 1_000,
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.acquired, true);
  const busy = await authStateAction(state, {
    ...base,
    owner_nonce: "es_bbbbbbbbbbbbbbbbbbbbbb",
    operation_epoch: "set_bbbbbbbbbbbbbbbbbbbbbb",
    now_ms: nowMs + 500,
    expires_at_ms: nowMs + 1_500,
  });
  assert.equal(busy.body.acquired, false);
  const expiredRelease = await authStateAction(state, {
    action: "release_entity_set_reservation",
    reservation_key: first.body.reservation_key,
    owner_nonce: "es_aaaaaaaaaaaaaaaaaaaaaa",
    reservation_version: first.body.version,
    now_ms: nowMs + 1_001,
  });
  assert.equal(expiredRelease.body.released, true);
  const abortedRoute = await storage.get(
    "entity-route:production:device-a:switch.target"
  );
  assert.equal(abortedRoute.state, "aborted");
  const retryAfterPretransportExpiry = await authStateAction(state, {
    ...base,
    owner_nonce: "es_ffffffffffffffffffffff",
    operation_epoch: "set_ffffffffffffffffffffff",
    now_ms: nowMs + 1_002,
    expires_at_ms: nowMs + 2_002,
  });
  assert.equal(retryAfterPretransportExpiry.body.acquired, true);
  const wrongRelease = await authStateAction(state, {
    action: "release_entity_set_reservation",
    reservation_key: retryAfterPretransportExpiry.body.reservation_key,
    owner_nonce: "es_dddddddddddddddddddddd",
    reservation_version: retryAfterPretransportExpiry.body.version,
    now_ms: nowMs + 1_003,
  });
  assert.equal(wrongRelease.body.released, false);
  const exactRelease = await authStateAction(state, {
    action: "release_entity_set_reservation",
    reservation_key: retryAfterPretransportExpiry.body.reservation_key,
    owner_nonce: "es_ffffffffffffffffffffff",
    reservation_version: retryAfterPretransportExpiry.body.version,
    now_ms: nowMs + 1_004,
  });
  assert.equal(exactRelease.body.released, true);
});

test("reservation-owned stale marking is idempotent but rejects other owners", async () => {
  const storage = new MemoryDurableStorage();
  const state = new RelayAuthState({ storage });
  const nowMs = Date.now();
  const generation = "ar_eeeeeeeeeeeeeeeeeeeeee";
  await storage.put("activity-authority", {
    enabled: true,
    schema_version: 1,
    enabled_at_ms: nowMs,
  });
  await storage.put("activity-current:production:device-a:old-route", {
    environment: "production",
    device_id: "device-a",
    activity_id: "old-route",
    activity_registration_generation: generation,
    entity_id: "switch.target",
    auth_protocol: "v1",
    auth_generation: 0,
    status: "active",
    storage_kind: "generation",
    activation_sequence: 1,
    activated_at_ms: nowMs,
    updated_at_ms: nowMs,
    expires_at_ms: nowMs + 60_000,
  });
  const snapshot = [{
    device_id: "device-a",
    activity_id: "old-route",
    activity_registration_generation: generation,
    entity_id: "switch.target",
    start_attributes_hash: null,
  }];
  const reservation = await authStateAction(state, {
    action: "begin_entity_set_reservation",
    environment: "production",
    entity_id: "switch.target",
    device_id: "device-a",
    owner_nonce: "es_eeeeeeeeeeeeeeeeeeeeee",
    operation_epoch: "set_eeeeeeeeeeeeeeeeeeeeee",
    canonical_activity_id: "canonical-route",
    start_attributes_hash: "a".repeat(64),
    display_name_hash: null,
    intent_device_ids: ["device-a"],
    activity_snapshot: snapshot,
    now_ms: nowMs,
    expires_at_ms: nowMs + 10_000,
    hard_deadline_ms: nowMs + 60_000,
    intent_expires_at_ms: nowMs + 30_000,
    route_expires_at_ms: nowMs + 60_000,
  });
  assert.equal(reservation.body.acquired, true);
  const stalePayload = {
    action: "mark_activity_stale",
    environment: "production",
    device_id: "device-a",
    activity_id: "old-route",
    activity_registration_generation: generation,
    reservation_key: reservation.body.reservation_key,
    owner_nonce: "es_eeeeeeeeeeeeeeeeeeeeee",
    reservation_version: reservation.body.version,
    now_ms: nowMs + 1,
    expires_at_ms: nowMs + 60_000,
  };
  const first = await authStateAction(state, stalePayload);
  const repeated = await authStateAction(state, { ...stalePayload, now_ms: nowMs + 2 });
  const unowned = await authStateAction(state, {
    ...stalePayload,
    reservation_key: undefined,
    owner_nonce: undefined,
    reservation_version: undefined,
    now_ms: nowMs + 3,
  });
  assert.equal(first.body.marked, true);
  assert.equal(repeated.body.marked, true);
  assert.equal(repeated.body.already_stale, true);
  assert.equal(repeated.body.owned, true);
  assert.equal(unowned.body.marked, false);
  assert.equal(unowned.body.conflict, true);
});

test("duplicate starts while an activity token is pending do not send another start push", async () => {
  const env = makeEnv();
  const instanceID = "ha_3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });

  const first = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.started, 1);
  assert.equal(first.body.results[0].event, "start");

  const second = await post(env, "/start", startPayload(instanceID, { state: "Still Open" }), {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.reused_pending, 1);
  assert.equal(second.body.attempted, 0);
  assert.equal(second.body.started, 0);
});

test("duplicate display names on a different active activity are rejected", async () => {
  const env = makeEnv();
  const instanceID = "ha_3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: "front_door",
    displayName: "deneme",
  });

  const response = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "garage",
      entity_id: "binary_sensor.garage",
      title: "Garage",
      display_name: "deneme",
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 409);
  assert.equal(response.body.error, "duplicate_activity_name");
  assert.equal(response.body.message, "An active Live Activity with this name already exists. Please choose another name.");
  assert.equal(response.body.active_conflicts, 1);
});

test("duplicate lookup never probes APNs and authenticated End enables stale-name reuse", async () => {
  const captures = [];
  const instanceID = "ha_3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d";
  const staleToken = `update-token-${instanceID}-front_door-device-a`;
  const env = makeEnv({
    APNS_MOCK_REQUESTS: captures,
    APNS_MOCK_STALE_TOKENS: staleToken,
  });
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, {
    instanceID,
    deviceID: "device-a",
    activityID: "front_door",
    displayName: "deneme",
    updateToken: staleToken,
  });

  captures.length = 0;
  const request = startPayload(instanceID, {
    activity_id: "garage",
    entity_id: "binary_sensor.garage",
    title: "Garage",
    display_name: "deneme",
  });
  const response = await post(
    env,
    "/start",
    request,
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, "duplicate_activity_name");
  assert.equal(captures.length, 0);

  const ended = await post(
    env,
    "/end",
    startPayload(instanceID, { activity_id: "front_door" }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.deepEqual(captures.map(({ event }) => event), ["end"]);

  captures.length = 0;
  const retry = await post(env, "/start", request, {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.started, 1);
  assert.deepEqual(captures.map(({ event }) => event), ["start"]);
});

test("pending starts reserve display names for different activity ids", async () => {
  const env = makeEnv();
  const instanceID = "ha_3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });

  const first = await post(
    env,
    "/start",
    startPayload(instanceID, { display_name: "deneme" }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.started, 1);

  const second = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "garage",
      entity_id: "binary_sensor.garage",
      title: "Garage",
      display_name: "deneme",
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "duplicate_activity_name");
  assert.equal(second.body.pending_conflicts, 1);
});

test("entity-backed Set rejects same-entity pending activity-id churn", async () => {
  const env = makeEnv();
  const instanceID = "ha_42424242424242424242424242424242";
  await register(env, { instanceID, deviceID: "device-a" });
  const secret = await provisionInstance(env, { instanceID });
  const entityData = { entity_based: true, source_service: "set_activity" };

  const first = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "first",
      entity_id: "switch.same_entity",
      display_name: "Same Name",
      data: entityData,
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.started, 1);

  const second = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "second",
      entity_id: "switch.same_entity",
      display_name: "Same Name",
      data: entityData,
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.error, "pending_entity_activity_id_changed");
  assert.deepEqual(second.body.existing_activity_ids, ["first"]);
  assert.match(second.body.message, /open.*wait.*end|wait.*expire/i);
});

test("pending-only End remains fail-closed until pending generations ship in phase 2", async () => {
  const captures = [];
  const env = makeEnv({ APNS_MOCK_REQUESTS: captures });
  const instanceID = "ha_46424242424242424242424242424242";
  const deviceID = "device-a";
  const oldActivityID = "pending-old";
  const newActivityID = "pending-new";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  const entityData = { entity_based: true, source_service: "set_activity" };

  const first = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: oldActivityID,
      entity_id: "switch.same_entity",
      display_name: "Same Name",
      data: entityData,
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const pendingKey = `pending-start:production:${instanceID}:${oldActivityID}:device_${deviceID}`;
  assert.notEqual(await env.TOKENS.get(pendingKey), null);
  captures.length = 0;

  const ended = await post(
    env,
    "/end",
    startPayload(instanceID, { activity_id: oldActivityID }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(ended.status, 404, JSON.stringify(ended.body));
  assert.equal(ended.body.error, "no_activity_tokens");
  assert.equal(captures.length, 0);
  assert.notEqual(await env.TOKENS.get(pendingKey), null);
  assert.equal(
    [...env.TOKENS.values.keys()].some((key) => (
      key.startsWith(`stale-pending:production:${instanceID}:`)
    )),
    false
  );

  captures.length = 0;
  const replacement = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: newActivityID,
      entity_id: "switch.same_entity",
      display_name: "Same Name",
      data: entityData,
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(replacement.status, 409, JSON.stringify(replacement.body));
  assert.equal(replacement.body.error, "pending_entity_activity_id_changed");
  assert.equal(captures.length, 0);
});

test("pending entity-id churn detection remains scoped to the requested device", async () => {
  const env = makeEnv();
  const instanceID = "ha_45424242424242424242424242424242";
  await register(env, { instanceID, deviceID: "device-a" });
  await register(env, { instanceID, deviceID: "device-b" });
  const secret = await provisionInstance(env, { instanceID });
  const entityData = { entity_based: true, source_service: "set_activity" };

  const pending = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "device-b-pending",
      device_id: "device-b",
      entity_id: "switch.same_entity",
      data: entityData,
    }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(pending.status, 200, JSON.stringify(pending.body));

  const scoped = await post(
    env,
    "/start",
    startPayload(instanceID, {
      activity_id: "device-a-new",
      device_id: "device-a",
      entity_id: "switch.same_entity",
      data: entityData,
    }),
    { "X-HA-LiveKit-Secret": secret }
  );

  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.equal(scoped.body.started, 1);
  assert.notEqual(
    await env.TOKENS.get(
      `pending-start:production:${instanceID}:device-a-new:device_device-a`
    ),
    null
  );
});

test("entity-backed Set accepts matching active and pending routes but rejects disagreement", async () => {
  const entityData = { entity_based: true, source_service: "set_activity" };

  const matchingEnv = makeEnv();
  const matchingInstance = "ha_43434343434343434343434343434343";
  await register(matchingEnv, { instanceID: matchingInstance, deviceID: "device-a" });
  const matchingSecret = await provisionInstance(matchingEnv, { instanceID: matchingInstance });
  await registerActivity(matchingEnv, {
    instanceID: matchingInstance,
    deviceID: "device-a",
    activityID: "first",
    displayName: "Same Name",
    entityID: "switch.same_entity",
  });
  const matchingRequest = startPayload(matchingInstance, {
    activity_id: "first",
    entity_id: "switch.same_entity",
    display_name: "Same Name",
    data: entityData,
  });
  const matchingAttributes = buildAPNsStartPayload(
    matchingRequest,
    matchingEnv
  ).aps.attributes;
  await mutateAuthoritativeActivityRecord(
    matchingEnv,
    matchingInstance,
    "device-a",
    "first",
    (record) => { record.start_attributes = matchingAttributes; }
  );
  await register(matchingEnv, { instanceID: matchingInstance, deviceID: "device-b" });
  const pending = await post(
    matchingEnv,
    "/start",
    startPayload(matchingInstance, {
      activity_id: "first",
      entity_id: "switch.same_entity",
      display_name: "Same Name",
    }),
    { "X-HA-LiveKit-Secret": matchingSecret }
  );
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  const matching = await post(
    matchingEnv,
    "/start",
    matchingRequest,
    { "X-HA-LiveKit-Secret": matchingSecret }
  );
  assert.equal(matching.status, 200, JSON.stringify(matching.body));
  assert.equal(matching.body.updated_existing, 1);
  assert.equal(matching.body.reused_pending, 1);
  assert.deepEqual(matching.body.reused_entity_activity_ids, []);

  const conflictingEnv = makeEnv();
  const conflictingInstance = "ha_44434343434343434343434343434343";
  await register(conflictingEnv, { instanceID: conflictingInstance, deviceID: "device-a" });
  await register(conflictingEnv, { instanceID: conflictingInstance, deviceID: "device-b" });
  const conflictingSecret = await provisionInstance(conflictingEnv, { instanceID: conflictingInstance });
  await registerActivity(conflictingEnv, {
    instanceID: conflictingInstance,
    deviceID: "device-a",
    activityID: "first",
    displayName: "Same Name",
    entityID: "switch.same_entity",
  });
  const secondPending = await post(
    conflictingEnv,
    "/start",
    startPayload(conflictingInstance, {
      activity_id: "second",
      device_id: "device-b",
      entity_id: "switch.same_entity",
      display_name: "Same Name",
    }),
    { "X-HA-LiveKit-Secret": conflictingSecret }
  );
  assert.equal(secondPending.status, 200, JSON.stringify(secondPending.body));
  const conflicting = await post(
    conflictingEnv,
    "/start",
    startPayload(conflictingInstance, {
      activity_id: "third",
      entity_id: "switch.same_entity",
      display_name: "Same Name",
      data: entityData,
    }),
    { "X-HA-LiveKit-Secret": conflictingSecret }
  );
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.body.error, "pending_entity_activity_id_changed");
});

test("D: missing device_id broadcasts only inside exact HA instance", async () => {
  const env = makeEnv();
  const instanceA = "ha_44444444444444444444444444444444";
  const instanceB = "ha_55555555555555555555555555555555";
  await register(env, { instanceID: instanceA, deviceID: "device-a1" });
  await register(env, { instanceID: instanceA, deviceID: "device-a2" });
  await register(env, { instanceID: instanceB, deviceID: "device-b1" });
  const secretA = await provisionInstance(env, { instanceID: instanceA });

  const response = await post(env, "/start", startPayload(instanceA), {
    "X-HA-LiveKit-Secret": secretA,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.matched_devices, 2);
  assert.equal(response.body.attempted, 2);
});

test("E: old/global KV records are ignored", async () => {
  const env = makeEnv();
  const instanceID = "ha_66666666666666666666666666666666";
  await register(env, { instanceID, deviceID: "device-current" });
  const secret = await provisionInstance(env, { instanceID });
  await env.TOKENS.put(
    `instance:${instanceID}:device:legacy-device`,
    JSON.stringify({
      device_id: "legacy-device",
      home_assistant_instance_id: instanceID,
      push_to_start_token: "legacy-token",
      apns_mode: "production",
    })
  );

  const response = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.matched_devices, 1);
  assert.equal(response.body.attempted, 1);
});

test("F: production and sandbox token scopes do not mix", async () => {
  const env = makeEnv();
  const instanceID = "ha_77777777777777777777777777777777";
  await register(env, { instanceID, deviceID: "device-production" });
  const secret = await provisionInstance(env, { instanceID });
  await env.TOKENS.put(
    `token:sandbox:${instanceID}:device_device-sandbox`,
    JSON.stringify({
      device_id: "device-sandbox",
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      push_to_start_token: "sandbox-token",
      apns_environment: "sandbox",
      apns_mode: "sandbox",
    })
  );

  const response = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.matched_devices, 1);
  assert.equal(response.body.attempted, 1);

  const mismatch = await post(
    env,
    "/start",
    startPayload(instanceID, { apns_mode: "sandbox" }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error, "apns_environment_mismatch");
});

test("update and end are scoped by instance, activity, and environment", async () => {
  const env = makeEnv();
  const instanceA = "ha_88888888888888888888888888888888";
  const instanceB = "ha_99999999999999999999999999999999";
  await register(env, { instanceID: instanceA, deviceID: "device-a" });
  await register(env, { instanceID: instanceB, deviceID: "device-b" });
  const secretA = await provisionInstance(env, { instanceID: instanceA });
  await registerActivity(env, { instanceID: instanceA, deviceID: "device-a", activityID: "front_door" });
  await registerActivity(env, { instanceID: instanceB, deviceID: "device-b", activityID: "front_door" });

  const update = await post(
    env,
    "/update",
    startPayload(instanceA, { state: "Closed" }),
    { "X-HA-LiveKit-Secret": secretA }
  );
  assert.equal(update.status, 200);
  assert.equal(update.body.matched_activities, 1);
  assert.equal(update.body.attempted, 1);

  const end = await post(
    env,
    "/end",
    {
      home_assistant_instance_id: instanceA,
      apns_mode: "production",
      activity_id: "front_door",
    },
    { "X-HA-LiveKit-Secret": secretA }
  );
  assert.equal(end.status, 200);
  assert.equal(end.body.matched_activities, 1);
  assert.equal(end.body.attempted, 1);
});

test("RELAY_ENABLED=false disables mutation endpoints", async () => {
  const env = makeEnv({ RELAY_ENABLED: "false" });
  const response = await post(
    env,
    "/start",
    startPayload("ha_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    { "X-HA-LiveKit-Secret": "anything" }
  );
  assert.equal(response.status, 503);
  assert.equal(response.body.error, "relay_disabled");
});

test("existing instance registration never returns or recovers the HA relay secret", async () => {
  const env = makeEnv();
  const instanceID = "ha_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const victimSecret = await provisionInstance(env, {
    instanceID,
    secret: "victim-relay-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  await register(env, { instanceID, deviceID: "victim-device" });

  const attackerRegistration = await register(env, { instanceID, deviceID: "attacker-device" });
  assert.equal(attackerRegistration.relay_shared_secret, undefined);
  assert.equal(attackerRegistration.home_assistant_relay_token, undefined);

  const recoveredOrGuessed = attackerRegistration.relay_shared_secret
    || attackerRegistration.home_assistant_relay_token
    || "attacker-guessed-secret";
  const attackerStart = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": recoveredOrGuessed,
  });
  assert.equal(attackerStart.status, 401);
  assert.equal(attackerStart.body.error, "unauthorized");
  assert.equal(attackerStart.body.matched_devices, undefined);
  assert.equal(attackerStart.body.attempted, undefined);

  const legitimateStart = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": victimSecret,
  });
  assert.equal(legitimateStart.status, 200);
  assert.equal(legitimateStart.body.matched_devices, 2);
  assert.equal(legitimateStart.body.attempted, 2);
});

test("provisioning an existing instance requires the current HA relay secret", async () => {
  const env = makeEnv();
  const instanceID = "ha_cccccccccccccccccccccccccccccccc";
  const originalSecret = await provisionInstance(env, {
    instanceID,
    secret: "original-relay-secret-cccccccccccccccccccccccccccc",
  });
  await register(env, { instanceID, deviceID: "device-a" });

  const rejected = await post(
    env,
    "/provision-instance",
    {
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      relay_shared_secret: "attacker-rotated-secret-cccccccccccccccccccccc",
    },
    { "X-HA-LiveKit-App-Secret": APP_SECRET }
  );
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error, "instance_already_provisioned");

  const attackerStart = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": "attacker-rotated-secret-cccccccccccccccccccccc",
  });
  assert.equal(attackerStart.status, 401);
  assert.equal(attackerStart.body.attempted, undefined);

  const rotatedSecret = await provisionInstance(env, {
    instanceID,
    secret: "rotated-relay-secret-cccccccccccccccccccccccccc",
    currentSecret: originalSecret,
  });
  const oldSecretStart = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": originalSecret,
  });
  assert.equal(oldSecretStart.status, 401);

  const rotatedStart = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": rotatedSecret,
  });
  assert.equal(rotatedStart.status, 200);
  assert.equal(rotatedStart.body.matched_devices, 1);
});

test("oversized JSON bodies are rejected with 413 before parsing", async () => {
  const env = makeEnv({ MAX_REQUEST_BODY_BYTES: "1024" });
  const request = new Request("https://relay.test/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": env.TEST_CLIENT_IP,
      "X-HA-LiveKit-App-Secret": APP_SECRET,
    },
    body: JSON.stringify({ padding: "x".repeat(2048) }),
  });

  const response = await worker.fetch(request, env);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "payload_too_large");
});

test("field length and token format validation reject malformed registration input", async () => {
  const env = makeEnv();
  const instanceID = "ha_dddddddddddddddddddddddddddddddd";
  const tooLong = await post(
    env,
    "/register",
    {
      device_id: "d".repeat(129),
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      push_to_start_token: "valid-token-1234567890",
      apns_mode: "production",
    },
    { "X-HA-LiveKit-App-Secret": APP_SECRET }
  );
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error, "field_too_long");

  const invalidToken = await post(
    env,
    "/register",
    {
      device_id: "device-a",
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      push_to_start_token: "token with spaces is invalid",
      apns_mode: "production",
    },
    { "X-HA-LiveKit-App-Secret": APP_SECRET }
  );
  assert.equal(invalidToken.status, 400);
  assert.equal(invalidToken.body.error, "invalid_token_format");
});

test("local endpoint rate limiting returns 429 with retry guidance", async () => {
  const env = makeEnv({ RATE_LIMIT_REGISTER_PER_MINUTE: "2" });
  const instanceID = "ha_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  for (const deviceID of ["device-a", "device-b"]) {
    await register(env, { instanceID, deviceID });
  }
  const limited = await post(
    env,
    "/register",
    {
      device_id: "device-c",
      home_assistant_instance_id: instanceID,
      instance_id_version: 2,
      push_to_start_token: "valid-token-device-c",
      apns_mode: "production",
    },
    { "X-HA-LiveKit-App-Secret": APP_SECRET }
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.ok(Number(limited.headers["retry-after"]) >= 1);
});

test("production rate-limit mode fails closed when its Cloudflare binding is unavailable", async () => {
  const env = makeEnv({ RATE_LIMIT_MODE: "binding-required" });
  const response = await post(env, "/register", {}, {
    "X-HA-LiveKit-App-Secret": APP_SECRET,
  });
  assert.equal(response.status, 503);
  assert.equal(response.body.error, "rate_limit_unavailable");
});

test("Cloudflare rate-limit binding denial is enforced", async () => {
  const env = makeEnv({
    RATE_LIMIT_MODE: "binding-required",
    RATE_LIMITER: { async limit() { return { success: false }; } },
  });
  const response = await post(env, "/register", {}, {
    "X-HA-LiveKit-App-Secret": APP_SECRET,
  });
  assert.equal(response.status, 429);
  assert.equal(response.body.error, "rate_limited");
});

test("device and activity quotas reject new records without blocking refreshes", async () => {
  const deviceEnv = makeEnv({ MAX_DEVICES_PER_INSTANCE: "1" });
  const deviceInstance = "ha_f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
  await register(deviceEnv, { instanceID: deviceInstance, deviceID: "device-a" });
  await register(deviceEnv, { instanceID: deviceInstance, deviceID: "device-a" });
  const secondDevice = await post(
    deviceEnv,
    "/register",
    {
      device_id: "device-b",
      home_assistant_instance_id: deviceInstance,
      instance_id_version: 2,
      push_to_start_token: "valid-token-device-b",
      apns_mode: "production",
    },
    { "X-HA-LiveKit-App-Secret": APP_SECRET }
  );
  assert.equal(secondDevice.status, 409);
  assert.equal(secondDevice.body.error, "device_quota_exceeded");

  const activityEnv = makeEnv({ MAX_ACTIVITIES_PER_DEVICE: "1" });
  const activityInstance = "ha_f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1";
  await register(activityEnv, { instanceID: activityInstance, deviceID: "device-a" });
  await registerActivity(activityEnv, {
    instanceID: activityInstance,
    deviceID: "device-a",
    activityID: "activity-a",
  });
  await registerActivity(activityEnv, {
    instanceID: activityInstance,
    deviceID: "device-a",
    activityID: "activity-a",
  });
  const secondActivity = await post(
    activityEnv,
    "/activity-token",
    {
      device_id: "device-a",
      home_assistant_instance_id: activityInstance,
      instance_id_version: 2,
      activity_id: "activity-b",
      update_token: "valid-update-token-activity-b",
      apns_mode: "production",
    },
    { "X-HA-LiveKit-App-Secret": APP_SECRET }
  );
  assert.equal(secondActivity.status, 409);
  assert.equal(secondActivity.body.error, "activity_quota_exceeded");
});

test("device, activity, secret, and retained-state records receive bounded TTLs", async () => {
  const env = makeEnv({
    DEVICE_TTL_SECONDS: "600",
    ACTIVITY_TTL_SECONDS: "1200",
    ACTIVITY_STATE_TTL_SECONDS: "300",
    SECRET_TTL_SECONDS: "86400",
  });
  const instanceID = "ha_f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2";
  const deviceID = "device-a";
  const activityID = "front_door";
  await register(env, { instanceID, deviceID });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, { instanceID, deviceID, activityID });

  const deviceKey = `token:production:${instanceID}:device_${deviceID}`;
  const secretKey = `secret:${instanceID}`;
  const activityKey = `activity:production:${instanceID}:${activityID}:device_${deviceID}`;
  const stateKey = `activity-state:production:${instanceID}:${activityID}:device_${deviceID}`;
  const { pointer, key: generationActivityKey } = await authoritativeActivityLocation(
    env,
    instanceID,
    deviceID,
    activityID
  );
  const generationStateKey = `activity-state-generation:production:${instanceID}:${activityID}:device_${deviceID}:generation_${pointer.activity_registration_generation}`;
  assert.equal(env.TOKENS.putOptions.get(deviceKey).expirationTtl, 600);
  assert.equal(env.TOKENS.putOptions.get(secretKey).expirationTtl, 86400);
  assert.equal(env.TOKENS.putOptions.get(activityKey).expirationTtl, 1200);
  assert.equal(env.TOKENS.putOptions.get(stateKey).expirationTtl, 300);
  assert.equal(env.TOKENS.putOptions.get(generationActivityKey).expirationTtl, 1200);
  assert.equal(env.TOKENS.putOptions.get(generationStateKey).expirationTtl, 300);

  const activityRecord = JSON.parse(await env.TOKENS.get(activityKey));
  assert.equal(activityRecord.last_content_state, undefined);
  const retainedState = JSON.parse(await env.TOKENS.get(stateKey));
  assert.equal(retainedState.content_state.primaryState, "Open");

  await env.TOKENS.put(activityKey, JSON.stringify({
    ...activityRecord,
    last_content_state: retainedState.content_state,
  }));
  const update = await post(
    env,
    "/update",
    startPayload(instanceID, { state: "Closed" }),
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(update.status, 200);
  assert.equal(
    JSON.parse(await env.TOKENS.get(generationActivityKey)).last_content_state,
    undefined
  );
  assert.equal(
    JSON.parse(await env.TOKENS.get(generationStateKey)).content_state.primaryState,
    "Closed"
  );
  assert.notEqual(JSON.parse(await env.TOKENS.get(activityKey)).last_content_state, undefined);
});

test("authorized use migrates plaintext legacy instance secrets and old token TTL metadata", async () => {
  const env = makeEnv({ SECRET_TTL_SECONDS: "86400", DEVICE_TTL_SECONDS: "600" });
  const instanceID = "ha_f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4";
  const deviceID = "legacy-device";
  const secret = "legacy-plaintext-relay-secret-f4f4f4f4f4f4f4f4";
  const secretKey = `secret:${instanceID}`;
  const deviceKey = `token:production:${instanceID}:device_${deviceID}`;
  await env.TOKENS.put(secretKey, JSON.stringify({
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    secret,
    created_at: "2025-01-01T00:00:00.000Z",
  }));
  await env.TOKENS.put(deviceKey, JSON.stringify({
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token: "legacy-push-token-0123456789",
    apns_environment: "production",
  }));

  const start = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(start.status, 200, JSON.stringify(start.body));

  const migratedSecret = JSON.parse(await env.TOKENS.get(secretKey));
  assert.equal(migratedSecret.secret, undefined);
  assert.equal(migratedSecret.secret_hash, await sha256Hex(secret));
  assert.equal(migratedSecret.secret_format, "sha256-v1");
  assert.equal(env.TOKENS.putOptions.get(secretKey).expirationTtl, 86400);

  const migratedDevice = JSON.parse(await env.TOKENS.get(deviceKey));
  assert.equal(migratedDevice.auth_protocol, "v1");
  assert.equal(migratedDevice.auth_generation, 0);
  assert.equal(migratedDevice.retention_policy_version, 1);
  assert.equal(env.TOKENS.putOptions.get(deviceKey).expirationTtl, 600);
});

test("HA-authenticated revoke-device removes only the requested device scope", async () => {
  const env = makeEnv();
  const instanceID = "ha_f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3";
  await register(env, { instanceID, deviceID: "device-a" });
  await register(env, { instanceID, deviceID: "device-b" });
  const secret = await provisionInstance(env, { instanceID });
  await registerActivity(env, { instanceID, deviceID: "device-a", activityID: "front_door" });
  await registerActivity(env, { instanceID, deviceID: "device-b", activityID: "front_door" });

  const rejected = await post(
    env,
    "/revoke-device",
    {
      home_assistant_instance_id: instanceID,
      device_id: "device-a",
      apns_mode: "production",
    },
    { "X-HA-LiveKit-Secret": "wrong-secret" }
  );
  assert.equal(rejected.status, 401);

  const revoked = await post(
    env,
    "/revoke-device",
    {
      home_assistant_instance_id: instanceID,
      device_id: "device-a",
      apns_mode: "production",
    },
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, true);
  assert.equal(revoked.body.deleted.device, 1);
  assert.equal(revoked.body.deleted.activities, 1);
  assert.equal(revoked.body.deleted.retained_states, 1);
  assert.equal(await env.TOKENS.get(`token:production:${instanceID}:device_device-a`), null);
  assert.notEqual(await env.TOKENS.get(`token:production:${instanceID}:device_device-b`), null);
  assert.notEqual(
    await env.TOKENS.get(`activity:production:${instanceID}:front_door:device_device-b`),
    null
  );
});

test("HA-authenticated device inventory exposes only revocable metadata", async () => {
  const env = makeEnv();
  const instanceID = "ha_f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5";
  await register(env, { instanceID, deviceID: "legacy-phone" });
  const secret = relaySecretFor(instanceID);
  await pairAndRegisterV2(env, {
    instanceID,
    deviceID: "secure-phone",
    secret,
  });

  const unauthorized = await get(
    env,
    `/v2/devices?home_assistant_instance_id=${instanceID}&apns_mode=production`,
    { "X-HA-LiveKit-Secret": "wrong-secret" }
  );
  assert.equal(unauthorized.status, 401);

  const inventory = await get(
    env,
    `/v2/devices?home_assistant_instance_id=${instanceID}&apns_mode=production`,
    { "X-HA-LiveKit-Secret": secret }
  );
  assert.equal(inventory.status, 200, JSON.stringify(inventory.body));
  assert.deepEqual(
    inventory.body.devices.map((device) => device.device_id),
    ["legacy-phone", "secure-phone"]
  );
  assert.deepEqual(
    inventory.body.devices.map((device) => device.auth_protocol),
    ["v1", "v2"]
  );
  for (const device of inventory.body.devices) {
    assert.equal(device.push_to_start_token, undefined);
    assert.equal(device.device_credential_hash, undefined);
    assert.equal(device.token, undefined);
  }
});

test("legacy app secret cannot delete device registrations", async () => {
  const env = makeEnv();
  const response = await post(
    env,
    "/unregister",
    {
      home_assistant_instance_id: "ha_f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4",
      instance_id_version: 2,
      device_id: "device-a",
      apns_mode: "production",
    },
    { "X-HA-LiveKit-App-Secret": APP_SECRET }
  );
  assert.equal(response.status, 404);
  assert.equal(response.body.error, "not_found");
});

test("v2 instance provisioning stores only a hash and preserves HA authentication", async () => {
  const env = makeEnv();
  const instanceID = "ha_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
  const secret = relaySecretFor(instanceID);
  const first = await provisionInstanceV2(env, { instanceID, secret });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.auth_protocol, "v2");

  const record = JSON.parse(await env.TOKENS.get(`secret:${instanceID}`));
  assert.equal(record.secret, undefined);
  assert.equal(record.secret_hash, await sha256Hex(secret));
  assert.equal(record.auth_protocol, "v1");

  const wrongRotation = await provisionInstanceV2(env, {
    instanceID,
    secret: `${secret}-rotated`,
    currentSecret: "wrong-secret-012345678901234567890123456789",
  });
  assert.equal(wrongRotation.status, 409);

  const rotatedSecret = `${secret}-rotated`;
  const rotation = await provisionInstanceV2(env, {
    instanceID,
    secret: rotatedSecret,
    currentSecret: secret,
  });
  assert.equal(rotation.status, 200, JSON.stringify(rotation.body));
  assert.equal(rotation.body.rotated, true);

  const rejectedOld = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": secret,
  });
  assert.equal(rejectedOld.status, 401);
  const authenticatedNew = await post(env, "/start", startPayload(instanceID), {
    "X-HA-LiveKit-Secret": rotatedSecret,
  });
  assert.equal(authenticatedNew.status, 404);
  assert.equal(authenticatedNew.body.error, "no_registered_devices");
});

test("v2 pairing and registration create a device-scoped hashed credential", async () => {
  const env = makeEnv();
  const instanceID = "ha_a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2";
  const deviceID = "device-v2";
  const result = await pairAndRegisterV2(env, { instanceID, deviceID });

  const deviceKey = `token:production:${instanceID}:device_${deviceID}`;
  const device = JSON.parse(await env.TOKENS.get(deviceKey));
  assert.equal(device.auth_protocol, "v2");
  assert.equal(device.device_credential, undefined);
  assert.equal(device.device_credential_hash, await sha256Hex(result.deviceCredential));
  assert.equal(device.push_to_start_token, result.pushToken);
  assert.equal(env.TOKENS.putOptions.get(deviceKey).expirationTtl, 180 * 24 * 60 * 60);

  const pairingKey = `pairing:v2:${await sha256Hex(result.pairingToken)}`;
  const pairing = JSON.parse(await env.TOKENS.get(pairingKey));
  assert.ok(pairing.consumed_at);
  assert.equal(pairing.pairing_token, undefined);
  assert.equal(env.TOKENS.putOptions.get(pairingKey).expirationTtl, 300);

  const replay = await post(env, "/v2/register", result.registrationBody);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.device_credential, result.deviceCredential);
});

test("v2 pairing tokens are bound to instance, device, environment, and push token", async () => {
  const env = makeEnv();
  const instanceID = "ha_a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3";
  const result = await pairAndRegisterV2(env, { instanceID, deviceID: "device-a" });

  const wrongDevice = await post(env, "/v2/register", {
    ...result.registrationBody,
    device_id: "device-b",
  });
  assert.equal(wrongDevice.status, 401);

  const wrongPush = await post(env, "/v2/register", {
    ...result.registrationBody,
    push_to_start_token: "different-valid-push-token-012345",
  });
  assert.equal(wrongPush.status, 401);

  const pairingKey = `pairing:v2:${await sha256Hex(result.pairingToken)}`;
  const pairing = JSON.parse(await env.TOKENS.get(pairingKey));
  pairing.expires_at = new Date(Date.now() - 1000).toISOString();
  await env.TOKENS.put(pairingKey, JSON.stringify(pairing), { expirationTtl: 300 });
  const authTicketKey = `ticket:${await sha256Hex(result.pairingToken)}`;
  const authStorage = env.AUTH_STATE.objects.get(instanceID).storage;
  const authTicket = authStorage.values.get(authTicketKey);
  authStorage.values.set(authTicketKey, { ...authTicket, expires_at_ms: Date.now() - 1000 });
  const expired = await post(env, "/v2/register", result.registrationBody);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error, "invalid_pairing_token");
});

test("an older pairing token cannot roll back a newer device credential", async () => {
  const env = makeEnv();
  const instanceID = "ha_a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8";
  const deviceID = "device-v2";
  const first = await pairAndRegisterV2(env, { instanceID, deviceID });
  const secondPush = `${first.pushToken}-second`;
  const secondPairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token_hash: await sha256Hex(secondPush),
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": first.secret });
  assert.equal(secondPairing.status, 200, JSON.stringify(secondPairing.body));
  const secondRegistration = await post(env, "/v2/register", {
    pairing_token: secondPairing.body.pairing_token,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token: secondPush,
    apns_mode: "production",
  });
  assert.equal(secondRegistration.status, 200, JSON.stringify(secondRegistration.body));
  assert.notEqual(secondRegistration.body.device_credential, first.deviceCredential);

  const staleReplay = await post(env, "/v2/register", first.registrationBody);
  assert.equal(staleReplay.status, 409);
  assert.equal(staleReplay.body.error, "stale_pairing_token");

  const device = JSON.parse(
    await env.TOKENS.get(`token:production:${instanceID}:device_${deviceID}`)
  );
  assert.equal(
    device.device_credential_hash,
    await sha256Hex(secondRegistration.body.device_credential)
  );
});

test("v2 device credential authenticates refresh, activity token, and test start", async () => {
  const env = makeEnv();
  const instanceID = "ha_a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4";
  const deviceID = "device-v2";
  const result = await pairAndRegisterV2(env, { instanceID, deviceID });
  const headers = { "X-HA-LiveKit-Device-Credential": result.deviceCredential };

  const refreshedToken = `${result.pushToken}-refreshed`;
  const refresh = await post(env, "/v2/register", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token: refreshedToken,
    apns_mode: "production",
  }, headers);
  assert.equal(refresh.status, 200, JSON.stringify(refresh.body));
  assert.equal(refresh.body.refreshed, true);
  assert.equal(refresh.body.device_credential, undefined);

  const activity = await post(env, "/v2/activity-token", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    activity_id: "front_door",
    update_token: "valid-v2-update-token-0123456789",
    apns_mode: "production",
  }, headers);
  assert.equal(activity.status, 200, JSON.stringify(activity.body));
  assert.equal(activity.body.auth_protocol, "v2");

  const testStart = await post(env, "/v2/test-start", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    activity_id: "background_test",
    title: "HA LiveKit",
    state: "Testing",
    apns_mode: "production",
  }, headers);
  assert.equal(testStart.status, 200, JSON.stringify(testStart.body));

  const wrongCredential = await post(env, "/v2/activity-token", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    activity_id: "garage",
    update_token: "valid-v2-update-token-9876543210",
    apns_mode: "production",
  }, { "X-HA-LiveKit-Device-Credential": "wrong-device-credential-0123456789012345" });
  assert.equal(wrongCredential.status, 401);
  assert.equal(wrongCredential.body.error, "device_unauthorized");
});

test("legacy app secret cannot downgrade or mutate an upgraded v2 device", async () => {
  const env = makeEnv();
  const instanceID = "ha_a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5";
  const deviceID = "device-v2";
  await pairAndRegisterV2(env, { instanceID, deviceID });

  const legacyRegister = await post(env, "/register", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token: "attacker-push-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(legacyRegister.status, 409);
  assert.equal(legacyRegister.body.error, "device_requires_v2");

  const legacyActivity = await post(env, "/activity-token", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    activity_id: "front_door",
    update_token: "attacker-update-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(legacyActivity.status, 409);
  assert.equal(legacyActivity.body.error, "device_requires_v2");

  const legacyTest = await post(env, "/test-start", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    activity_id: "background_test",
    title: "HA LiveKit",
    state: "Testing",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(legacyTest.status, 409);
  assert.equal(legacyTest.body.error, "device_requires_v2");
});

test("paired v2 instances allow existing legacy refresh but reject fresh v1 device enrollment", async () => {
  const env = makeEnv();
  const instanceID = "ha_a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9";
  await register(env, { instanceID, deviceID: "legacy-existing" });
  const secret = relaySecretFor(instanceID);
  const provision = await provisionInstanceV2(env, { instanceID, secret });
  assert.equal(provision.status, 200, JSON.stringify(provision.body));
  const securePushToken = "secure-pairing-push-token-0123456789";
  const pairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "secure-pairing-device",
    push_to_start_token_hash: await sha256Hex(securePushToken),
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": secret });
  assert.equal(pairing.status, 200, JSON.stringify(pairing.body));
  const secureRegistration = await post(env, "/v2/register", {
    pairing_token: pairing.body.pairing_token,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "secure-pairing-device",
    push_to_start_token: securePushToken,
    apns_mode: "production",
  });
  assert.equal(secureRegistration.status, 200, JSON.stringify(secureRegistration.body));

  const refresh = await post(env, "/register", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "legacy-existing",
    push_to_start_token: "legacy-refresh-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(refresh.status, 200, JSON.stringify(refresh.body));

  const injected = await post(env, "/register", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "attacker-fresh-device",
    push_to_start_token: "attacker-fresh-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(injected.status, 409);
  assert.equal(injected.body.error, "instance_requires_v2");
  assert.equal(
    await env.TOKENS.get(`token:production:${instanceID}:device_attacker-fresh-device`),
    null
  );

  await env.TOKENS.put(`token:production:${instanceID}:device_attacker-cache-device`, JSON.stringify({
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "attacker-cache-device",
    push_to_start_token: "attacker-cache-token-0123456789",
    apns_environment: "production",
    auth_protocol: "v1",
    auth_generation: 0,
  }), { expirationTtl: 600 });
  const staleCacheStart = await post(env, "/start", startPayload(instanceID, {
    device_id: "attacker-cache-device",
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(staleCacheStart.status, 404);
  assert.equal(staleCacheStart.body.error, "no_registered_devices");

  const staleCacheMutation = await post(env, "/test-start", {
    ...startPayload(instanceID, { device_id: "attacker-cache-device" }),
    instance_id_version: 2,
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(staleCacheMutation.status, 409);
  assert.equal(staleCacheMutation.body.error, "instance_requires_v2");
});

test("a pre-v2 device omitted from the provision snapshot is lazily reconciled without admitting post-v2 devices", async () => {
  const env = makeEnv();
  const instanceID = "ha_c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
  const legacyDeviceID = "snapshot-missed-legacy-device";
  const secureDeviceID = "snapshot-transition-device";
  const secret = relaySecretFor(instanceID);
  const legacyKey = `token:production:${instanceID}:device_${legacyDeviceID}`;
  const legacyUpdatedAt = new Date(Date.now() - 60_000).toISOString();

  await provisionInstance(env, { instanceID, secret });
  await env.TOKENS.put(legacyKey, JSON.stringify({
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: legacyDeviceID,
    push_to_start_token: "snapshot-missed-push-token-0123456789",
    apns_environment: "production",
    auth_protocol: "v1",
    auth_generation: 0,
    updated_at: legacyUpdatedAt,
  }), { expirationTtl: 600 });

  const originalList = env.TOKENS.list;
  env.TOKENS.list = async function listWithoutMissedLegacy(options = {}) {
    const page = await originalList.call(this, options);
    if (options.prefix !== `token:production:${instanceID}:device_`) return page;
    return {
      ...page,
      keys: page.keys.filter(({ name }) => name !== legacyKey),
    };
  };
  let v2Provision;
  try {
    v2Provision = await provisionInstanceV2(env, {
      instanceID,
      secret,
      currentSecret: secret,
    });
  } finally {
    env.TOKENS.list = originalList;
  }
  assert.equal(v2Provision.status, 200, JSON.stringify(v2Provision.body));

  const authStorage = env.AUTH_STATE.objects.get(instanceID).storage;
  const legacyStateKey = `device:production:${legacyDeviceID}`;
  assert.equal(authStorage.values.has(legacyStateKey), false);

  const securePushToken = "snapshot-transition-push-token-0123456789";
  const pairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: secureDeviceID,
    push_to_start_token_hash: await sha256Hex(securePushToken),
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": secret });
  assert.equal(pairing.status, 200, JSON.stringify(pairing.body));
  const secureRegistration = await post(env, "/v2/register", {
    pairing_token: pairing.body.pairing_token,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: secureDeviceID,
    push_to_start_token: securePushToken,
    apns_mode: "production",
  });
  assert.equal(secureRegistration.status, 200, JSON.stringify(secureRegistration.body));

  const transition = authStorage.values.get("instance").upgraded_at;
  assert.equal(typeof transition, "string");
  assert.ok(Date.parse(legacyUpdatedAt) <= Date.parse(transition));
  assert.equal(authStorage.values.has(legacyStateKey), false);

  const legacyDelivery = await post(env, "/start", startPayload(instanceID, {
    device_id: legacyDeviceID,
    activity_id: "snapshot_missed_delivery",
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(legacyDelivery.status, 200, JSON.stringify(legacyDelivery.body));
  assert.equal(legacyDelivery.body.matched_devices, 1);
  assert.equal(authStorage.values.get(legacyStateKey).status, "legacy");
  assert.equal(authStorage.values.get(legacyStateKey).created_at, legacyUpdatedAt);

  const legacyRefresh = await post(env, "/register", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: legacyDeviceID,
    push_to_start_token: "snapshot-missed-refreshed-token-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(legacyRefresh.status, 200, JSON.stringify(legacyRefresh.body));
  const refreshedLegacyRecord = JSON.parse(await env.TOKENS.get(legacyKey));
  assert.equal(refreshedLegacyRecord.created_at, legacyUpdatedAt);
  assert.notEqual(refreshedLegacyRecord.updated_at, legacyUpdatedAt);

  const freshDeviceID = "post-transition-attacker-device";
  const clientForgedTimestamp = "2000-01-01T00:00:00.000Z";
  const freshRegistration = await post(env, "/register", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: freshDeviceID,
    push_to_start_token: "post-transition-attacker-token-0123456789",
    apns_mode: "production",
    created_at: clientForgedTimestamp,
    updated_at: clientForgedTimestamp,
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(freshRegistration.status, 409);
  assert.equal(freshRegistration.body.error, "instance_requires_v2");
  assert.equal(authStorage.values.has(`device:production:${freshDeviceID}`), false);
  assert.equal(
    await env.TOKENS.get(`token:production:${instanceID}:device_${freshDeviceID}`),
    null
  );

  const lateVisibleDeviceID = "post-transition-late-cache-device";
  const lateVisibleKey = `token:production:${instanceID}:device_${lateVisibleDeviceID}`;
  const postTransitionTimestamp = new Date(Date.parse(transition) + 1_000).toISOString();
  await env.TOKENS.put(lateVisibleKey, JSON.stringify({
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: lateVisibleDeviceID,
    push_to_start_token: "post-transition-late-cache-token-0123456789",
    apns_environment: "production",
    auth_protocol: "v1",
    auth_generation: 0,
    updated_at: postTransitionTimestamp,
  }), { expirationTtl: 600 });
  const lateVisibleDelivery = await post(env, "/start", startPayload(instanceID, {
    device_id: lateVisibleDeviceID,
    activity_id: "post_transition_late_cache",
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(lateVisibleDelivery.status, 404);
  assert.equal(lateVisibleDelivery.body.error, "no_registered_devices");
  assert.equal(authStorage.values.has(`device:production:${lateVisibleDeviceID}`), false);

  const secureKey = `token:production:${instanceID}:device_${secureDeviceID}`;
  await env.TOKENS.put(secureKey, JSON.stringify({
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: secureDeviceID,
    push_to_start_token: "stale-v1-copy-of-secure-device-0123456789",
    apns_environment: "production",
    auth_protocol: "v1",
    auth_generation: 0,
    updated_at: legacyUpdatedAt,
  }), { expirationTtl: 600 });
  const activeV2Wins = await post(env, "/start", startPayload(instanceID, {
    device_id: secureDeviceID,
    activity_id: "active_v2_tombstone_wins",
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(activeV2Wins.status, 404);
  assert.equal(activeV2Wins.body.error, "no_registered_devices");
  assert.equal(authStorage.values.get(`device:production:${secureDeviceID}`).status, "active_v2");

  const revokeLegacy = await post(env, "/revoke-device", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: legacyDeviceID,
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": secret });
  assert.equal(revokeLegacy.status, 200, JSON.stringify(revokeLegacy.body));
  await env.TOKENS.put(legacyKey, JSON.stringify(refreshedLegacyRecord), { expirationTtl: 600 });
  const revokedTombstoneWins = await post(env, "/start", startPayload(instanceID, {
    device_id: legacyDeviceID,
    activity_id: "revoked_tombstone_wins",
  }), { "X-HA-LiveKit-Secret": secret });
  assert.equal(revokedTombstoneWins.status, 404);
  assert.equal(revokedTombstoneWins.body.error, "no_registered_devices");
  assert.equal(authStorage.values.get(legacyStateKey).status, "revoked");
});

test("issue_ticket cannot materialize a late legacy record past the authoritative device quota", async () => {
  const env = makeEnv({ MAX_DEVICES_PER_INSTANCE: "1" });
  const instanceID = "ha_c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2";
  const secureDeviceID = "quota-secure-device";
  const lateLegacyDeviceID = "quota-late-legacy-device";
  const paired = await pairAndRegisterV2(env, {
    instanceID,
    deviceID: secureDeviceID,
  });
  const authStorage = env.AUTH_STATE.objects.get(instanceID).storage;
  const transition = authStorage.values.get("instance").upgraded_at;
  const legacyKey = `token:production:${instanceID}:device_${lateLegacyDeviceID}`;
  await env.TOKENS.put(legacyKey, JSON.stringify({
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: lateLegacyDeviceID,
    push_to_start_token: "quota-late-legacy-push-token-0123456789",
    apns_environment: "production",
    auth_protocol: "v1",
    auth_generation: 0,
    updated_at: new Date(Date.parse(transition) - 1_000).toISOString(),
  }), { expirationTtl: 600 });

  const pairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: lateLegacyDeviceID,
    push_to_start_token_hash: await sha256Hex("quota-late-legacy-push-token-0123456789"),
    apns_mode: "production",
    restricted_recovery: true,
  }, { "X-HA-LiveKit-Secret": paired.secret });
  assert.equal(pairing.status, 409);
  assert.equal(pairing.body.error, "device_quota_exceeded");
  assert.equal(
    [...authStorage.values.values()].filter((record) => record?.status === "active_v2").length,
    1
  );
  assert.equal(authStorage.values.has(`device:production:${lateLegacyDeviceID}`), false);

  const delivery = await post(env, "/start", startPayload(instanceID, {
    device_id: lateLegacyDeviceID,
    activity_id: "quota_late_legacy",
  }), { "X-HA-LiveKit-Secret": paired.secret });
  assert.equal(delivery.status, 404);
  assert.equal(delivery.body.error, "no_registered_devices");

  const refresh = await post(env, "/register", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: lateLegacyDeviceID,
    push_to_start_token: "quota-late-legacy-refresh-0123456789",
    apns_mode: "production",
  }, { "X-HA-LiveKit-App-Secret": APP_SECRET });
  assert.equal(refresh.status, 409);
  assert.equal(refresh.body.error, "device_quota_exceeded");
  assert.equal(authStorage.values.has(`device:production:${lateLegacyDeviceID}`), false);
});

test("concurrent pairing tickets serialize so only one credential becomes current", async () => {
  const env = makeEnv();
  const instanceID = "ha_abababababababababababababababab";
  const deviceID = "concurrent-device";
  const secret = relaySecretFor(instanceID);
  assert.equal((await provisionInstanceV2(env, { instanceID, secret })).status, 200);
  const pushes = ["concurrent-push-token-one-012345", "concurrent-push-token-two-012345"];
  const pushHashes = await Promise.all(pushes.map((pushToken) => sha256Hex(pushToken)));
  const pairings = await Promise.all(pushes.map((_, index) => post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token_hash: pushHashes[index],
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": secret })));
  assert.deepEqual(pairings.map((entry) => entry.status), [200, 200]);

  const registrations = await Promise.all(pairings.map((pairing, index) => post(env, "/v2/register", {
    pairing_token: pairing.body.pairing_token,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token: pushes[index],
    apns_mode: "production",
  })));
  assert.equal(registrations.filter((entry) => entry.status === 200).length, 1);
  assert.equal(registrations.filter((entry) => entry.body.error === "stale_pairing_token").length, 1);
});

test("v2 unregister requires the exact device credential and deletes only that scope", async () => {
  const env = makeEnv();
  const instanceID = "ha_a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6";
  const first = await pairAndRegisterV2(env, { instanceID, deviceID: "device-a" });
  const secret = first.secret;

  const secondPush = `v2-push-token-${instanceID}-device-b`;
  const pairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "device-b",
    push_to_start_token_hash: await sha256Hex(secondPush),
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": secret });
  const secondRegistration = await post(env, "/v2/register", {
    pairing_token: pairing.body.pairing_token,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "device-b",
    push_to_start_token: secondPush,
    apns_mode: "production",
  });
  assert.equal(secondRegistration.status, 200, JSON.stringify(secondRegistration.body));

  const rejected = await post(env, "/v2/unregister", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "device-a",
    apns_mode: "production",
  }, { "X-HA-LiveKit-Device-Credential": secondRegistration.body.device_credential });
  assert.equal(rejected.status, 401);

  const removed = await post(env, "/v2/unregister", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "device-a",
    apns_mode: "production",
  }, { "X-HA-LiveKit-Device-Credential": first.deviceCredential });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(await env.TOKENS.get(`token:production:${instanceID}:device_device-a`), null);
  assert.notEqual(await env.TOKENS.get(`token:production:${instanceID}:device_device-b`), null);

  const replayAfterUnregister = await post(env, "/v2/register", first.registrationBody);
  assert.equal(replayAfterUnregister.status, 409);
  assert.equal(replayAfterUnregister.body.error, "stale_pairing_token");
  assert.equal(await env.TOKENS.get(`token:production:${instanceID}:device_device-a`), null);
});

test("stale KV device records cannot restore APNs delivery after v1 revoke or v2 unregister", async () => {
  const legacyEnv = makeEnv();
  const legacyInstanceID = "ha_acacacacacacacacacacacacacacacac";
  const legacyDeviceID = "legacy-device";
  await register(legacyEnv, { instanceID: legacyInstanceID, deviceID: legacyDeviceID });
  const legacySecret = await provisionInstance(legacyEnv, { instanceID: legacyInstanceID });
  const legacyKey = `token:production:${legacyInstanceID}:device_${legacyDeviceID}`;
  const staleLegacyRecord = await legacyEnv.TOKENS.get(legacyKey);
  const legacyRevoke = await post(legacyEnv, "/revoke-device", {
    home_assistant_instance_id: legacyInstanceID,
    instance_id_version: 2,
    device_id: legacyDeviceID,
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": legacySecret });
  assert.equal(legacyRevoke.status, 200, JSON.stringify(legacyRevoke.body));
  await legacyEnv.TOKENS.put(legacyKey, staleLegacyRecord, { expirationTtl: 600 });
  const legacyStart = await post(legacyEnv, "/start", startPayload(legacyInstanceID), {
    "X-HA-LiveKit-Secret": legacySecret,
  });
  assert.equal(legacyStart.status, 404);
  assert.equal(legacyStart.body.error, "no_registered_devices");

  const v2Env = makeEnv();
  const v2InstanceID = "ha_adadadadadadadadadadadadadadadad";
  const v2DeviceID = "v2-device";
  const paired = await pairAndRegisterV2(v2Env, { instanceID: v2InstanceID, deviceID: v2DeviceID });
  const v2Key = `token:production:${v2InstanceID}:device_${v2DeviceID}`;
  const staleV2Record = await v2Env.TOKENS.get(v2Key);
  const unregister = await post(v2Env, "/v2/unregister", {
    home_assistant_instance_id: v2InstanceID,
    instance_id_version: 2,
    device_id: v2DeviceID,
    apns_mode: "production",
  }, { "X-HA-LiveKit-Device-Credential": paired.deviceCredential });
  assert.equal(unregister.status, 200, JSON.stringify(unregister.body));
  assert.ok(unregister.body.auth_generation > 1);
  await v2Env.TOKENS.put(v2Key, staleV2Record, { expirationTtl: 600 });
  const v2Start = await post(v2Env, "/start", startPayload(v2InstanceID), {
    "X-HA-LiveKit-Secret": paired.secret,
  });
  assert.equal(v2Start.status, 404);
  assert.equal(v2Start.body.error, "no_registered_devices");
});

test("HA revocation invalidates an already-issued pairing ticket before KV cleanup", async () => {
  const env = makeEnv();
  const instanceID = "ha_aeaeaeaeaeaeaeaeaeaeaeaeaeaeaeae";
  const deviceID = "ticket-replay-device";
  const paired = await pairAndRegisterV2(env, { instanceID, deviceID });
  const nextPushToken = `${paired.pushToken}-next`;
  const pendingPairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token_hash: await sha256Hex(nextPushToken),
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": paired.secret });
  assert.equal(pendingPairing.status, 200, JSON.stringify(pendingPairing.body));

  const revoked = await post(env, "/revoke-device", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": paired.secret });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const replay = await post(env, "/v2/register", {
    pairing_token: pendingPairing.body.pairing_token,
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: deviceID,
    push_to_start_token: nextPushToken,
    apns_mode: "production",
  });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error, "stale_pairing_token");
  assert.equal(await env.TOKENS.get(`token:production:${instanceID}:device_${deviceID}`), null);
});

test("v2 pairing fails closed when the server credential pepper is missing", async () => {
  const env = makeEnv({ DEVICE_CREDENTIAL_PEPPER: "" });
  const instanceID = "ha_a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7";
  const secret = relaySecretFor(instanceID);
  const provision = await provisionInstanceV2(env, { instanceID, secret });
  assert.equal(provision.status, 200);
  const pairing = await post(env, "/v2/pairing-tokens", {
    home_assistant_instance_id: instanceID,
    instance_id_version: 2,
    device_id: "device-a",
    push_to_start_token_hash: await sha256Hex("valid-v2-push-token-0123456789"),
    apns_mode: "production",
  }, { "X-HA-LiveKit-Secret": secret });
  assert.equal(pairing.status, 500);
  assert.equal(pairing.body.error, "device_credential_pepper_not_configured");
});
