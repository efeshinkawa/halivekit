const INSTANCE_KEY = "instance";
const DEVICE_KEY_PREFIX = "device:";
const TICKET_KEY_PREFIX = "ticket:";
const STALE_ACTIVITY_KEY_PREFIX = "activity-stale:";
const CURRENT_ACTIVITY_KEY_PREFIX = "activity-current:";
const ACTIVITY_AUTHORITY_KEY = "activity-authority";
const ENTITY_SET_RESERVATION_KEY_PREFIX = "entity-set-reservation:";
const ENTITY_ROUTE_KEY_PREFIX = "entity-route:";
const ACTIVITY_ROUTE_INDEX_KEY_PREFIX = "activity-route-index:";
const DISPLAY_CLAIM_KEY_PREFIX = "display-claim:";
const MAX_STALE_ACTIVITY_MARKERS = 4096;
const MAX_ACTIVITY_POINTERS_PER_ENVIRONMENT = 2048;
const MAX_ENTITY_SET_RESERVATIONS = 2048;
const MAX_ENTITY_ROUTE_RECORDS = 2048;
const MAX_DISPLAY_CLAIMS = 2048;
const MAX_RETIRED_ACTIVITY_IDENTITIES = 8;
const MAX_ACTIVITY_ROUTE_INDEX_RECORDS = MAX_ENTITY_ROUTE_RECORDS
  * (MAX_RETIRED_ACTIVITY_IDENTITIES + 1);
const MIN_ENTITY_SET_RESERVATION_TTL_MS = 1_000;
const MAX_ENTITY_SET_RESERVATION_TTL_MS = 60_000;
const MAX_ENTITY_SET_HARD_DEADLINE_MS = 2 * 60_000;
export const RELAY_AUTH_STATE_SCHEMA_VERSION = 2;
export const ACTIVITY_REGISTRATION_GENERATION_SCHEMA_VERSION = 1;

export class RelayAuthState {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return response({ ok: false, error: "method_not_allowed" }, 405);
    }

    try {
      const payload = await request.json();
      const action = String(payload.action || "");
      const result = await this.storage.transaction(async (txn) => {
        switch (action) {
          case "health":
            return {
              schema_version: RELAY_AUTH_STATE_SCHEMA_VERSION,
              activity_registration_generation_schema_version:
                ACTIVITY_REGISTRATION_GENERATION_SCHEMA_VERSION,
            };
          case "provision_instance":
            return await provisionInstance(txn, payload);
          case "verify_instance_secret":
            return await verifyInstanceSecret(txn, payload);
          case "verify_pairing_recovery":
            return await verifyPairingRecovery(txn, payload);
          case "issue_ticket":
            return await issueTicket(txn, payload);
          case "consume_ticket":
            return await consumeTicket(txn, payload);
          case "verify_device":
            return await verifyDevice(txn, payload);
          case "legacy_mutation_allowed":
            return await legacyMutationAllowed(txn, payload);
          case "unregister_device":
            return await unregisterDevice(txn, payload);
          case "revoke_device_by_ha":
            return await revokeDeviceByHA(txn, payload);
          case "active_records":
          case "active_v2_devices":
            return await activeRecords(txn, payload);
          case "activity_authority_status":
            return await activityAuthorityStatus(txn);
          case "enable_activity_authority":
            return await enableActivityAuthority(txn, payload);
          case "adopt_legacy_activities":
            return await adoptLegacyActivities(txn, payload);
          case "activate_activity_registration":
            return await activateActivityRegistration(txn, payload);
          case "touch_activity_registration":
            return await touchActivityRegistration(txn, payload);
          case "promote_legacy_activity_registration":
            return await promoteLegacyActivityRegistration(txn, payload);
          case "current_activity_registrations":
            return await currentActivityRegistrations(txn, payload);
          case "mark_activity_stale":
            return await markActivityStale(txn, payload);
          case "begin_entity_set_reservation":
            return await beginEntitySetReservation(txn, payload);
          case "claim_entity_set_reservation":
            return await claimEntitySetReservation(txn, payload);
          case "validate_entity_set_reservation":
            return await validateEntitySetReservation(txn, payload);
          case "commit_entity_set_reservation":
            return await commitEntitySetReservation(txn, payload);
          case "release_entity_set_reservation":
            return await releaseEntitySetReservation(txn, payload);
          case "renew_entity_set_reservation":
            return await renewEntitySetReservation(txn, payload);
          case "mark_entity_set_transport_started":
            return await markEntitySetTransportStarted(txn, payload);
          case "claim_activity_display_names":
            return await claimActivityDisplayNames(txn, payload);
          case "commit_activity_display_names":
            return await commitActivityDisplayNames(txn, payload);
          case "release_activity_display_names":
            return await releaseActivityDisplayNames(txn, payload);
          case "retire_activity_display_claims":
            return await retireActivityDisplayClaims(txn, payload);
          case "clear_activity_route_state":
            return await clearActivityRouteState(txn, payload);
          default:
            throw authError(400, "invalid_auth_action", "The relay auth action is invalid.");
        }
      });
      return response({ ok: true, ...result });
    } catch (error) {
      return response({
        ok: false,
        error: error.code || "auth_state_error",
        message: error.safeMessage || "Relay authorization state could not be updated.",
      }, error.status || 500);
    }
  }
}

async function provisionInstance(txn, payload) {
  requireHash(payload.new_secret_hash, "new_secret_hash");
  const requestedProtocol = payload.requested_protocol === "v2" ? "v2" : "v1";
  let instance = await txn.get(INSTANCE_KEY);
  if (!instance && isHash(payload.legacy_secret_hash)) {
    instance = {
      secret_hash: payload.legacy_secret_hash,
      auth_protocol: payload.legacy_auth_protocol === "v2" ? "v2" : "v1",
      created_at: payload.now,
    };
  }
  const previousAuthProtocol = instance?.auth_protocol;

  const rotated = Boolean(instance);
  if (instance) {
    if (!isHash(payload.current_secret_hash) || !safeEqual(instance.secret_hash, payload.current_secret_hash)) {
      throw authError(
        409,
        "instance_already_provisioned",
        "Existing instances require the current HA relay secret to rotate."
      );
    }
  }

  // Provisioning prepares the HA secret, but does not make the one-way v2
  // transition by itself. The transition is committed atomically with ticket
  // consumption so any interrupted pairing attempt can still use v1.
  const effectiveAuthProtocol = instance?.auth_protocol === "v2" ? "v2" : "v1";
  await txn.put(INSTANCE_KEY, {
    secret_hash: payload.new_secret_hash,
    auth_protocol: effectiveAuthProtocol,
    created_at: instance?.created_at || payload.now,
    upgraded_at: effectiveAuthProtocol === "v2" ? instance?.upgraded_at : undefined,
    rotated_at: rotated ? payload.now : undefined,
    updated_at: payload.now,
  });

  let seededLegacyDevices = 0;
  if (requestedProtocol === "v2" && previousAuthProtocol !== "v2") {
    const maximumDevices = integer(payload.maximum_devices, 32);
    const legacyDevices = Array.isArray(payload.legacy_devices)
      ? payload.legacy_devices.slice(0, maximumDevices)
      : [];
    for (const candidate of legacyDevices) {
      if (!validDeviceID(candidate?.device_id)) continue;
      if (candidate.environment !== "production" && candidate.environment !== "sandbox") continue;
      const key = deviceKey(candidate.environment, candidate.device_id);
      if (await txn.get(key)) continue;
      const proofTimestamp = validTimestamp(candidate?.proof_timestamp)
        ? candidate.proof_timestamp
        : payload.now;
      await txn.put(key, {
        device_id: candidate.device_id,
        environment: candidate.environment,
        status: "legacy",
        auth_protocol: "v1",
        generation: 0,
        created_at: proofTimestamp,
        updated_at: payload.now,
      });
      seededLegacyDevices += 1;
    }
  }
  return {
    rotated,
    auth_protocol: requestedProtocol === "v2" ? "v2" : effectiveAuthProtocol,
    effective_auth_protocol: effectiveAuthProtocol,
    seeded_legacy_devices: seededLegacyDevices,
  };
}

async function verifyInstanceSecret(txn, payload) {
  requireHash(payload.provided_secret_hash, "provided_secret_hash", 401);
  const instance = await loadOrMigrateInstance(txn, payload);
  if (!instance || !safeEqual(instance.secret_hash, payload.provided_secret_hash)) {
    throw authError(401, "unauthorized", "Invalid HA LiveKit relay secret.");
  }
  return { auth_protocol: instance.auth_protocol };
}

async function verifyPairingRecovery(txn, payload) {
  const instance = await verifyInstanceSecret(txn, payload);
  requireScope(payload);
  const device = await txn.get(deviceKey(payload.environment, payload.device_id));
  if (
    instance.auth_protocol !== "v2"
    || device?.status !== "active_v2"
    || device.auth_protocol !== "v2"
  ) {
    throw authError(
      409,
      "pairing_recovery_unavailable",
      "Secure pairing recovery is unavailable for this device."
    );
  }
  return { auth_protocol: "v2", generation: integer(device.generation, 0) };
}

async function issueTicket(txn, payload) {
  const instanceAuthorization = await verifyInstanceSecret(txn, payload);
  requireScope(payload);
  requireHash(payload.ticket_hash, "ticket_hash");
  requireHash(payload.push_token_hash, "push_token_hash");
  requireHash(payload.device_credential_hash, "device_credential_hash");

  const tickets = await txn.list({ prefix: TICKET_KEY_PREFIX });
  for (const [key, ticket] of tickets) {
    if (ticket?.expires_at_ms <= Date.now()) {
      await txn.delete(key);
    }
  }

  const ticketKey = `${TICKET_KEY_PREFIX}${payload.ticket_hash}`;
  if (await txn.get(ticketKey)) {
    throw authError(409, "ticket_collision", "A new pairing ticket is required.");
  }

  const key = deviceKey(payload.environment, payload.device_id);
  let device = await txn.get(key);
  if (payload.restricted_recovery === true) {
    if (
      instanceAuthorization.auth_protocol !== "v2"
      || device?.status !== "active_v2"
      || device.auth_protocol !== "v2"
    ) {
      throw authError(
        409,
        "pairing_recovery_unavailable",
        "Secure pairing recovery is unavailable for this device."
      );
    }
  }

  if (!device) {
    const instance = await txn.get(INSTANCE_KEY);
    device = await reconcileLegacyDevice(txn, instance, payload, {
      deviceID: payload.device_id,
      environment: payload.environment,
      authProtocol: payload.legacy_device_auth_protocol,
      generation: payload.legacy_device_generation,
      proofTimestamp: payload.legacy_device_proof_timestamp,
      failOnQuota: true,
    });
  }

  const previousGeneration = integer(device?.generation, 0);
  const nextGeneration = previousGeneration + 1;
  await txn.put(ticketKey, {
    ticket_hash: payload.ticket_hash,
    device_id: payload.device_id,
    environment: payload.environment,
    push_token_hash: payload.push_token_hash,
    device_credential_hash: payload.device_credential_hash,
    previous_device_credential_hash: device?.status === "active_v2" ? device.credential_hash : null,
    previous_generation: previousGeneration,
    next_generation: nextGeneration,
    expires_at_ms: payload.expires_at_ms,
    consumed_at: null,
    created_at: payload.now,
  });
  return {
    next_generation: nextGeneration,
    auth_protocol: "v2",
    effective_auth_protocol: instanceAuthorization.auth_protocol,
  };
}

async function consumeTicket(txn, payload) {
  requireScope(payload);
  requireHash(payload.ticket_hash, "ticket_hash", 401);
  requireHash(payload.push_token_hash, "push_token_hash", 401);
  requireHash(payload.device_credential_hash, "device_credential_hash", 401);
  const ticketKey = `${TICKET_KEY_PREFIX}${payload.ticket_hash}`;
  const ticket = await txn.get(ticketKey);
  if (!ticket || !ticketMatches(ticket, payload) || ticket.expires_at_ms <= payload.now_ms) {
    throw authError(401, "invalid_pairing_token", "The pairing token is invalid or expired.");
  }
  if (!safeEqual(ticket.push_token_hash, payload.push_token_hash)) {
    throw authError(401, "pairing_scope_mismatch", "The pairing token does not match this push token.");
  }
  if (!safeEqual(ticket.device_credential_hash, payload.device_credential_hash)) {
    throw authError(401, "invalid_pairing_token", "The pairing token could not be verified.");
  }

  const key = deviceKey(payload.environment, payload.device_id);
  const device = await txn.get(key);
  if (ticket.consumed_at) {
    if (
      device?.status === "active_v2"
      && device.generation === ticket.next_generation
      && safeEqual(device.credential_hash, ticket.device_credential_hash)
    ) {
      await promoteInstanceToV2(txn, payload.now);
      return { idempotent: true, generation: device.generation, auth_protocol: "v2" };
    }
    throw authError(409, "stale_pairing_token", "The pairing ticket is no longer current.");
  }

  const currentGeneration = integer(device?.generation, 0);
  const currentCredentialHash = device?.status === "active_v2" ? device.credential_hash : null;
  if (
    currentGeneration !== ticket.previous_generation
    || !nullableEqual(currentCredentialHash, ticket.previous_device_credential_hash)
  ) {
    throw authError(409, "stale_pairing_token", "A newer device credential has already been issued.");
  }

  const maximumDevices = integer(payload.maximum_devices, 32);
  if (device?.status !== "active_v2" && device?.status !== "legacy") {
    const devices = await txn.list({ prefix: `${DEVICE_KEY_PREFIX}${payload.environment}:` });
    const activeCount = [...devices.values()].filter((entry) =>
      entry?.status === "active_v2" || entry?.status === "legacy"
    ).length;
    if (activeCount >= maximumDevices) {
      throw authError(409, "device_quota_exceeded", "The device quota for this Home Assistant instance has been reached.");
    }
  }

  await txn.put(ticketKey, { ...ticket, consumed_at: payload.now });
  await txn.put(key, {
    device_id: payload.device_id,
    environment: payload.environment,
    status: "active_v2",
    auth_protocol: "v2",
    generation: ticket.next_generation,
    credential_hash: ticket.device_credential_hash,
    created_at: device?.created_at || payload.now,
    credential_issued_at: payload.now,
    updated_at: payload.now,
  });
  await promoteInstanceToV2(txn, payload.now);
  return { idempotent: false, generation: ticket.next_generation, auth_protocol: "v2" };
}

async function promoteInstanceToV2(txn, now) {
  const instance = await txn.get(INSTANCE_KEY);
  if (!instance) {
    throw authError(500, "auth_state_error", "Relay authorization state could not be updated.");
  }
  await txn.put(INSTANCE_KEY, {
    ...instance,
    auth_protocol: "v2",
    upgraded_at: instance.auth_protocol === "v2" ? instance.upgraded_at : now,
    updated_at: now,
  });
}

async function verifyDevice(txn, payload) {
  requireScope(payload);
  requireHash(payload.provided_credential_hash, "provided_credential_hash", 401);
  const device = await txn.get(deviceKey(payload.environment, payload.device_id));
  if (
    device?.status !== "active_v2"
    || device.auth_protocol !== "v2"
    || !safeEqual(device.credential_hash, payload.provided_credential_hash)
  ) {
    throw authError(401, "device_unauthorized", "Invalid device credential.");
  }
  return { generation: device.generation };
}

async function legacyMutationAllowed(txn, payload) {
  requireScope(payload);
  let instance = await txn.get(INSTANCE_KEY);
  if (!instance && isHash(payload.legacy_instance_secret_hash)) {
    instance = {
      secret_hash: payload.legacy_instance_secret_hash,
      auth_protocol: payload.legacy_instance_auth_protocol === "v2" ? "v2" : "v1",
      created_at: payload.now,
      updated_at: payload.now,
    };
    await txn.put(INSTANCE_KEY, instance);
  }

  const key = deviceKey(payload.environment, payload.device_id);
  let device = await txn.get(key);
  if (device?.status === "active_v2") {
    throw authError(409, "device_requires_v2", "This device has upgraded to device-scoped relay authentication.");
  }
  if (device?.status === "revoked") {
    throw authError(409, "instance_requires_v2", "This instance requires secure device pairing for new registrations.");
  }

  if (instance?.auth_protocol === "v2" && !device) {
    device = await reconcileLegacyDevice(txn, instance, payload, {
      deviceID: payload.device_id,
      environment: payload.environment,
      authProtocol: payload.legacy_device_auth_protocol,
      generation: payload.legacy_device_generation,
      proofTimestamp: payload.legacy_device_proof_timestamp,
      failOnQuota: true,
    });
    if (!device) {
      throw authError(409, "instance_requires_v2", "This instance requires secure device pairing for new registrations.");
    }
  }

  if (!device) {
    const maximumDevices = integer(payload.maximum_devices, 32);
    const devices = await txn.list({ prefix: `${DEVICE_KEY_PREFIX}${payload.environment}:` });
    const activeCount = [...devices.values()].filter((entry) =>
      entry?.status === "active_v2" || entry?.status === "legacy"
    ).length;
    if (activeCount >= maximumDevices) {
      throw authError(409, "device_quota_exceeded", "The device quota for this Home Assistant instance has been reached.");
    }
    await txn.put(key, {
      device_id: payload.device_id,
      environment: payload.environment,
      status: "legacy",
      auth_protocol: "v1",
      generation: 0,
      created_at: payload.now,
      updated_at: payload.now,
    });
  }
  const current = await txn.get(key);
  return {
    auth_protocol: "v1",
    generation: integer(current?.generation, 0),
    legacy_record_proof_timestamp: validTimestamp(current?.created_at)
      ? current.created_at
      : undefined,
  };
}

async function unregisterDevice(txn, payload) {
  await verifyDevice(txn, payload);
  return await markRevoked(txn, payload);
}

async function revokeDeviceByHA(txn, payload) {
  const instance = await verifyInstanceSecret(txn, payload);
  requireScope(payload);
  const revoked = await markRevoked(txn, payload);
  return { ...revoked, auth_protocol: instance.auth_protocol };
}

async function markRevoked(txn, payload) {
  const key = deviceKey(payload.environment, payload.device_id);
  const device = await txn.get(key);
  const generation = integer(device?.generation, 0) + 1;
  await txn.put(key, {
    device_id: payload.device_id,
    environment: payload.environment,
    status: "revoked",
    auth_protocol: "v2",
    generation,
    credential_hash: null,
    created_at: device?.created_at || payload.now,
    revoked_at: payload.now,
    updated_at: payload.now,
  });
  return { generation };
}

async function activeRecords(txn, payload) {
  if (payload.environment !== "production" && payload.environment !== "sandbox") {
    throw authError(400, "invalid_auth_scope", "The relay authorization scope is invalid.");
  }
  const requested = Array.isArray(payload.devices) ? payload.devices.slice(0, 512) : [];
  const instance = await txn.get(INSTANCE_KEY);
  const active = [];
  for (const candidate of requested) {
    const deviceID = validDeviceID(candidate?.device_id) ? candidate.device_id : null;
    if (!deviceID) continue;
    const authProtocol = candidate?.auth_protocol === "v2" ? "v2" : "v1";
    const generation = integer(candidate?.generation, authProtocol === "v1" ? 0 : -1);
    let device = await txn.get(deviceKey(payload.environment, deviceID));
    if (!device && authProtocol === "v1" && instance?.auth_protocol === "v2") {
      device = await reconcileLegacyDevice(txn, instance, payload, {
        deviceID,
        environment: payload.environment,
        authProtocol,
        generation,
        proofTimestamp: candidate?.legacy_record_proof_timestamp,
        failOnQuota: false,
      });
    }
    const isActiveV2 = authProtocol === "v2"
      && device?.status === "active_v2"
      && device.auth_protocol === "v2"
      && device.generation === generation;
    const isActiveLegacy = authProtocol === "v1"
      && generation === 0
      && (
        (device?.status === "legacy" && integer(device.generation, 0) === generation)
        || (!device && instance?.auth_protocol !== "v2")
      );
    if (isActiveV2 || isActiveLegacy) {
      active.push({ device_id: deviceID, generation, auth_protocol: authProtocol });
    }
  }
  return { devices: active };
}

async function activityAuthorityStatus(txn) {
  const authority = await txn.get(ACTIVITY_AUTHORITY_KEY);
  return {
    enabled: authority?.enabled === true,
    schema_version: authority?.enabled === true
      ? ACTIVITY_REGISTRATION_GENERATION_SCHEMA_VERSION
      : null,
    enabled_at_ms: authority?.enabled === true
      ? integer(authority.enabled_at_ms, 0)
      : null,
  };
}

async function enableActivityAuthority(txn, payload) {
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const existing = await txn.get(ACTIVITY_AUTHORITY_KEY);
  if (existing?.enabled === true) return await activityAuthorityStatus(txn);
  await txn.put(ACTIVITY_AUTHORITY_KEY, {
    enabled: true,
    schema_version: ACTIVITY_REGISTRATION_GENERATION_SCHEMA_VERSION,
    enabled_at_ms: nowMs,
  });
  return await activityAuthorityStatus(txn);
}

async function requireActivityAuthority(txn) {
  const authority = await activityAuthorityStatus(txn);
  if (!authority.enabled) {
    throw authError(
      409,
      "activity_authority_not_enabled",
      "Live Activity generation authority has not been enabled for this instance."
    );
  }
  return authority;
}

async function adoptLegacyActivities(txn, payload) {
  await requireActivityAuthority(txn);
  requireEnvironment(payload.environment);
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const candidates = Array.isArray(payload.activities)
    ? payload.activities.slice(0, MAX_ACTIVITY_POINTERS_PER_ENVIRONMENT)
    : [];
  const existingPointers = await txn.list({
    prefix: `${CURRENT_ACTIVITY_KEY_PREFIX}${payload.environment}:`,
  });
  let activeCount = 0;
  for (const [pointerKey, pointer] of existingPointers) {
    if (integer(pointer?.expires_at_ms, 0) <= nowMs) {
      await txn.delete(pointerKey);
    } else if (pointer?.status === "active") {
      activeCount += 1;
    }
  }
  let adopted = 0;
  for (const candidate of candidates) {
    if (!validActivityCandidate(candidate, payload.environment, nowMs)) continue;
    const key = currentActivityKey(payload.environment, candidate.device_id, candidate.activity_id);
    const current = await txn.get(key);
    if (current && integer(current.expires_at_ms, 0) > nowMs) continue;
    if (current) await txn.delete(key);
    const staleKey = staleActivityKey(
      payload.environment,
      candidate.device_id,
      candidate.activity_id,
      candidate.activity_registration_generation
    );
    let stale = await txn.get(staleKey);
    if (stale && integer(stale.expires_at_ms, 0) <= nowMs) {
      await txn.delete(staleKey);
      stale = null;
    }
    const status = staleActivityMarkerMatches(stale, payload.environment, candidate)
      ? "stale"
      : "active";
    if (status === "active" && activeCount >= MAX_ACTIVITY_POINTERS_PER_ENVIRONMENT) {
      throw authError(
        503,
        "activity_state_capacity_exceeded",
        "Live Activity generation state is temporarily at capacity."
      );
    }
    await txn.put(key, activityPointer(payload.environment, candidate, {
      status,
      storageKind: "legacy",
      nowMs,
      sequence: 1,
    }));
    if (status === "active") activeCount += 1;
    adopted += 1;
  }
  return { adopted };
}

async function activateActivityRegistration(txn, payload) {
  await requireActivityAuthority(txn);
  requireEnvironment(payload.environment);
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  if (!validActivityCandidate(payload, payload.environment, nowMs)) {
    throw authError(400, "invalid_activity_registration", "The Live Activity registration is invalid.");
  }
  const routeAuthorization = await authorizeActivityRouteActivation(txn, payload, nowMs);
  if (!routeAuthorization.allowed) {
    return {
      activated: false,
      conflict: true,
      error: routeAuthorization.error,
    };
  }
  const key = currentActivityKey(payload.environment, payload.device_id, payload.activity_id);
  const current = await txn.get(key);
  const currentIsActive = current?.status === "active"
    && integer(current.expires_at_ms, 0) > nowMs;
  if (!currentIsActive) {
    const entries = await txn.list({
      prefix: `${CURRENT_ACTIVITY_KEY_PREFIX}${payload.environment}:`,
    });
    let activeCount = 0;
    for (const [pointerKey, pointer] of entries) {
      if (integer(pointer?.expires_at_ms, 0) <= nowMs) {
        await txn.delete(pointerKey);
      } else if (pointer?.status === "active") {
        activeCount += 1;
      }
    }
    if (activeCount >= MAX_ACTIVITY_POINTERS_PER_ENVIRONMENT) {
      throw authError(
        503,
        "activity_state_capacity_exceeded",
        "Live Activity generation state is temporarily at capacity."
      );
    }
  }
  const sameGeneration = current?.activity_registration_generation
    === payload.activity_registration_generation;
  const sequence = sameGeneration
    ? integer(current.activation_sequence, 1)
    : integer(current?.activation_sequence, 0) + 1;
  const pointer = activityPointer(payload.environment, {
    ...payload,
    ...(routeAuthorization.route
      ? {
        entity_id: routeAuthorization.route.entity_id,
        start_attributes_hash: routeAuthorization.route.start_attributes_hash,
        ...(routeAuthorization.route.display_name_hash
          ? { display_name_hash: routeAuthorization.route.display_name_hash }
          : {}),
        route_epoch: routeAuthorization.route.epoch,
      }
      : routeAuthorization.displayClaim ? {
        entity_id: routeAuthorization.displayClaim.entity_id,
        display_name_hash: routeAuthorization.displayClaim.display_name_hash,
      } : {}),
  }, {
    status: "active",
    storageKind: "generation",
    nowMs,
    sequence,
    activatedAtMs: sameGeneration ? current.activated_at_ms : nowMs,
  });
  await txn.put(key, pointer);
  await commitActivityRouteActivation(
    txn,
    payload,
    pointer,
    routeAuthorization,
    nowMs
  );
  return {
    activated: true,
    activity_registration_generation: pointer.activity_registration_generation,
    activation_sequence: pointer.activation_sequence,
    ...(routeAuthorization.route ? {
      entity_route_managed: true,
      route_epoch: routeAuthorization.route.epoch,
    } : {}),
  };
}

async function touchActivityRegistration(txn, payload) {
  await requireActivityAuthority(txn);
  requireEnvironment(payload.environment);
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const expiresAtMs = requiredTimestampMilliseconds(payload.expires_at_ms, "expires_at_ms");
  if (
    !validDeviceID(payload.device_id)
    || !validActivityID(payload.activity_id)
    || !validActivityRegistrationGeneration(payload.activity_registration_generation)
    || expiresAtMs <= nowMs
    || expiresAtMs > nowMs + 30 * 24 * 60 * 60 * 1000
  ) {
    throw authError(400, "invalid_activity_registration", "The Live Activity registration is invalid.");
  }
  const key = currentActivityKey(payload.environment, payload.device_id, payload.activity_id);
  const current = await txn.get(key);
  if (
    current?.status !== "active"
    || current.activity_registration_generation !== payload.activity_registration_generation
  ) {
    return { touched: false, conflict: true, reason: "activity_generation_changed" };
  }
  let reservation = null;
  let rawDisplayClaim = null;
  let managedRouteKey = null;
  let managedRoute = null;
  let managedDisplayClaim = null;
  if (payload.reservation_key) {
    reservation = await exactEntitySetReservation(txn, payload, nowMs, {
      phases: ["begun", "claimed"],
    });
    if (!reservation || !reservationSnapshotContains(reservation, current)) {
      return {
        touched: false,
        conflict: true,
        reservation_conflict: true,
        reason: "reservation_snapshot_changed",
      };
    }
    const route = await txn.get(entityRouteKey(
      payload.environment,
      payload.device_id,
      reservation.entity_id
    ));
    const routeConflictReason = route?.epoch !== reservation.version
      ? "entity_route_epoch_changed"
      : route.canonical_activity_id !== payload.activity_id
        ? "entity_route_activity_changed"
        : route.start_attributes_hash !== (payload.start_attributes_hash || null)
          ? "entity_route_attributes_changed"
          : (route.display_name_hash || null) !== (payload.display_name_hash || null)
            ? "entity_route_display_changed" : null;
    if (routeConflictReason) return {
      touched: false,
      conflict: true,
      reservation_conflict: true,
      reason: routeConflictReason,
    };
  } else if (current.route_epoch !== undefined && current.route_epoch !== null) {
    if (
      !validEntitySetEpoch(current.route_epoch)
      || !validEntityID(current.entity_id)
      || (validEntityID(payload.entity_id) && payload.entity_id !== current.entity_id)
      || (
        validDisplayNameHash(payload.display_name_hash)
        && payload.display_name_hash !== (current.display_name_hash || null)
      )
    ) {
      return {
        touched: false,
        conflict: true,
        reason: "entity_route_metadata_changed",
      };
    }
    managedRouteKey = entityRouteKey(
      payload.environment,
      payload.device_id,
      current.entity_id
    );
    managedRoute = await txn.get(managedRouteKey);
    if (
      managedRoute?.epoch !== current.route_epoch
      || managedRoute.environment !== payload.environment
      || managedRoute.device_id !== payload.device_id
      || managedRoute.entity_id !== current.entity_id
      || managedRoute.canonical_activity_id !== payload.activity_id
      || managedRoute.state !== "active"
      || managedRoute.operation_key
      || managedRoute.operation_owner_nonce
      || managedRoute.active_activity_registration_generation
        !== current.activity_registration_generation
      || (
        managedRoute.active_activity_kit_id
        && managedRoute.active_activity_kit_id !== current.activity_kit_id
      )
      || managedRoute.start_attributes_hash !== (current.start_attributes_hash || null)
      || (managedRoute.display_name_hash || null) !== (current.display_name_hash || null)
    ) {
      return {
        touched: false,
        conflict: true,
        reason: "entity_route_changed",
      };
    }
    if (validDisplayNameHash(current.display_name_hash)) {
      managedDisplayClaim = await txn.get(displayClaimKey(
        payload.environment,
        payload.device_id,
        current.display_name_hash
      ));
      if (
        managedDisplayClaim?.state !== "committed"
        || managedDisplayClaim.operation_owner_nonce
        || managedDisplayClaim.route_epoch !== current.route_epoch
        || managedDisplayClaim.entity_id !== current.entity_id
        || managedDisplayClaim.activity_id !== payload.activity_id
        || (
          managedDisplayClaim.active_activity_registration_generation
          && managedDisplayClaim.active_activity_registration_generation
            !== current.activity_registration_generation
        )
        || (
          managedDisplayClaim.active_activity_kit_id
          && managedDisplayClaim.active_activity_kit_id !== current.activity_kit_id
        )
      ) {
        return {
          touched: false,
          conflict: true,
          reason: "activity_display_claim_changed",
        };
      }
    }
  } else if (
    validEntityID(payload.entity_id)
    && validDisplayNameHash(payload.display_name_hash)
    && (
      (current.entity_id || null) !== payload.entity_id
      || (current.display_name_hash || null) !== payload.display_name_hash
    )
  ) {
    rawDisplayClaim = await txn.get(displayClaimKey(
      payload.environment,
      payload.device_id,
      payload.display_name_hash
    ));
    const ownsProvisionalClaim = rawDisplayClaim?.state === "provisional"
      && validDisplayClaimOwnerNonce(payload.display_claim_owner_nonce)
      && rawDisplayClaim.claim_owner_nonce === payload.display_claim_owner_nonce;
    const ownsCommittedClaim = rawDisplayClaim?.state === "committed"
      && !rawDisplayClaim.claim_owner_nonce;
    if (
      !rawDisplayClaim
      || integer(rawDisplayClaim.expires_at_ms, 0) <= nowMs
      || rawDisplayClaim.entity_id !== payload.entity_id
      || rawDisplayClaim.activity_id !== payload.activity_id
      || (!ownsProvisionalClaim && !ownsCommittedClaim)
    ) {
      return {
        touched: false,
        conflict: true,
        reason: "activity_display_claim_changed",
      };
    }
  }
  const nextPointer = {
    ...current,
    ...(reservation ? {
      entity_id: reservation.entity_id,
      start_attributes_hash: payload.start_attributes_hash,
      ...(validDisplayNameHash(payload.display_name_hash)
        ? { display_name_hash: payload.display_name_hash }
        : {}),
      route_epoch: reservation.version,
    } : {}),
    ...(!reservation
      && validDisplayNameHash(payload.display_name_hash)
      && (!current.entity_id || current.entity_id === payload.entity_id)
      ? {
        ...(validEntityID(payload.entity_id) ? { entity_id: payload.entity_id } : {}),
        display_name_hash: payload.display_name_hash,
      }
      : {}),
    updated_at_ms: nowMs,
    expires_at_ms: Math.max(current.expires_at_ms, expiresAtMs),
  };
  await txn.put(key, nextPointer);
  if (managedRoute) {
    const nextRoute = {
      ...managedRoute,
      updated_at_ms: nowMs,
      expires_at_ms: Math.max(
        integer(managedRoute.expires_at_ms, 0),
        integer(nextPointer.expires_at_ms, 0)
      ),
    };
    await putEntityRouteAndIndexes(txn, managedRouteKey, nextRoute);
    if (managedDisplayClaim) {
      await txn.put(displayClaimKey(
        payload.environment,
        payload.device_id,
        current.display_name_hash
      ), {
        ...managedDisplayClaim,
        active_activity_registration_generation:
          current.activity_registration_generation,
        ...(current.activity_kit_id
          ? { active_activity_kit_id: current.activity_kit_id }
          : {}),
        updated_at_ms: nowMs,
        expires_at_ms: Math.max(
          integer(managedDisplayClaim.expires_at_ms, 0),
          integer(nextPointer.expires_at_ms, 0)
        ),
      });
    }
  }
  if (!reservation && rawDisplayClaim) {
    if (current.display_name_hash && current.display_name_hash !== payload.display_name_hash) {
      const oldClaimKey = displayClaimKey(
        payload.environment,
        payload.device_id,
        current.display_name_hash
      );
      const oldClaim = await txn.get(oldClaimKey);
      if (
        oldClaim?.entity_id === (current.entity_id || payload.entity_id)
        && oldClaim.activity_id === payload.activity_id
        && (
          !oldClaim.active_activity_registration_generation
          || oldClaim.active_activity_registration_generation
            === current.activity_registration_generation
        )
      ) await txn.delete(oldClaimKey);
    }
    await txn.put(displayClaimKey(
      payload.environment,
      payload.device_id,
      payload.display_name_hash
    ), {
      ...rawDisplayClaim,
      entity_id: payload.entity_id,
      activity_id: payload.activity_id,
      active_activity_registration_generation: current.activity_registration_generation,
      ...(current.activity_kit_id
        ? { active_activity_kit_id: current.activity_kit_id }
        : {}),
      updated_at_ms: nowMs,
      expires_at_ms: Math.max(
        integer(rawDisplayClaim.expires_at_ms, 0),
        integer(nextPointer.expires_at_ms, 0)
      ),
    });
  }
  if (reservation) {
    const nextEntry = normalizeEntitySetSnapshot([nextPointer])[0];
    await txn.put(payload.reservation_key, {
      ...reservation,
      activity_snapshot: normalizeEntitySetSnapshot([
        ...reservation.activity_snapshot.filter((entry) => !(
          entry.device_id === nextEntry.device_id
          && entry.activity_id === nextEntry.activity_id
        )),
        nextEntry,
      ]),
      updated_at_ms: nowMs,
    });
  }
  return { touched: true, conflict: false };
}

async function promoteLegacyActivityRegistration(txn, payload) {
  await requireActivityAuthority(txn);
  requireEnvironment(payload.environment);
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const expiresAtMs = requiredTimestampMilliseconds(payload.expires_at_ms, "expires_at_ms");
  if (
    !validDeviceID(payload.device_id)
    || !validActivityID(payload.activity_id)
    || !/^legacy_[a-f0-9]{64}$/.test(payload.activity_registration_generation || "")
    || expiresAtMs <= nowMs
    || expiresAtMs > nowMs + 30 * 24 * 60 * 60 * 1000
  ) {
    throw authError(400, "invalid_activity_registration", "The Live Activity registration is invalid.");
  }
  const key = currentActivityKey(payload.environment, payload.device_id, payload.activity_id);
  const current = await txn.get(key);
  if (
    current?.status !== "active"
    || integer(current.expires_at_ms, 0) <= nowMs
    || current.activity_registration_generation !== payload.activity_registration_generation
    || !["legacy", "generation"].includes(current.storage_kind)
  ) {
    return { promoted: false, conflict: true };
  }
  const transitioned = current.storage_kind === "legacy";
  await txn.put(key, {
    ...current,
    storage_kind: "generation",
    updated_at_ms: nowMs,
    expires_at_ms: Math.max(current.expires_at_ms, expiresAtMs),
  });
  return { promoted: true, conflict: false, transitioned };
}

async function currentActivityRegistrations(txn, payload) {
  const authority = await activityAuthorityStatus(txn);
  if (!authority.enabled) return { authority_enabled: false, activities: [] };
  requireEnvironment(payload.environment);
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const requestedDeviceID = payload.device_id === undefined
    ? null
    : validDeviceID(payload.device_id) ? payload.device_id : null;
  const requestedActivityID = payload.activity_id === undefined
    ? null
    : validActivityID(payload.activity_id) ? payload.activity_id : null;
  if (payload.device_id !== undefined && !requestedDeviceID) {
    throw authError(400, "invalid_activity_scope", "The Live Activity scope is invalid.");
  }
  if (payload.activity_id !== undefined && !requestedActivityID) {
    throw authError(400, "invalid_activity_scope", "The Live Activity scope is invalid.");
  }

  let pointerEntries;
  if (requestedDeviceID && requestedActivityID) {
    const key = currentActivityKey(
      payload.environment,
      requestedDeviceID,
      requestedActivityID
    );
    const pointer = await txn.get(key);
    pointerEntries = pointer ? [[key, pointer]] : [];
  } else {
    const entries = await txn.list({ prefix: `${CURRENT_ACTIVITY_KEY_PREFIX}${payload.environment}:` });
    pointerEntries = [...entries.entries()];
  }
  const activities = [];
  for (const [key, pointer] of pointerEntries) {
    if (integer(pointer?.expires_at_ms, 0) <= nowMs) {
      await txn.delete(key);
      continue;
    }
    if (
      pointer.status === "active"
      && (!requestedDeviceID || pointer.device_id === requestedDeviceID)
      && (!requestedActivityID || pointer.activity_id === requestedActivityID)
    ) {
      activities.push(pointer);
    }
  }
  if (activities.length > MAX_ACTIVITY_POINTERS_PER_ENVIRONMENT) {
    throw authError(
      503,
      "activity_state_capacity_exceeded",
      "Live Activity generation state is temporarily at capacity."
    );
  }
  return { authority_enabled: true, activities };
}

function validActivityCandidate(candidate, environment, nowMs) {
  return validDeviceID(candidate?.device_id)
    && validActivityID(candidate?.activity_id)
    && validActivityRegistrationGeneration(candidate?.activity_registration_generation)
    && (candidate.auth_protocol === "v2" || candidate.auth_protocol === "v1")
    && integer(candidate.auth_generation, -1) >= 0
    && requiredCandidateExpiry(candidate.expires_at_ms, nowMs)
    && (!candidate.environment || candidate.environment === environment);
}

function requiredCandidateExpiry(value, nowMs) {
  const expiresAtMs = Number(value);
  return Number.isInteger(expiresAtMs)
    && expiresAtMs > nowMs
    && expiresAtMs <= nowMs + 30 * 24 * 60 * 60 * 1000;
}

function activityPointer(environment, candidate, {
  status,
  storageKind,
  nowMs,
  sequence,
  activatedAtMs = nowMs,
}) {
  return {
    environment,
    device_id: candidate.device_id,
    activity_id: candidate.activity_id,
    activity_registration_generation: candidate.activity_registration_generation,
    ...(validEntityID(candidate.entity_id) ? { entity_id: candidate.entity_id } : {}),
    ...(validStartAttributesHash(candidate.start_attributes_hash)
      ? { start_attributes_hash: candidate.start_attributes_hash }
      : {}),
    ...(validDisplayNameHash(candidate.display_name_hash)
      ? { display_name_hash: candidate.display_name_hash }
      : {}),
    ...(validActivityKitID(candidate.activity_kit_id)
      ? { activity_kit_id: candidate.activity_kit_id }
      : {}),
    ...(validEntitySetEpoch(candidate.route_epoch)
      ? { route_epoch: candidate.route_epoch }
      : {}),
    auth_protocol: candidate.auth_protocol,
    auth_generation: integer(candidate.auth_generation, 0),
    status,
    storage_kind: storageKind,
    activation_sequence: sequence,
    activated_at_ms: activatedAtMs,
    updated_at_ms: nowMs,
    expires_at_ms: candidate.expires_at_ms,
  };
}

async function markActivityStale(txn, payload) {
  await requireActivityAuthority(txn);
  requireEnvironment(payload.environment);
  if (!validDeviceID(payload.device_id) || !validActivityID(payload.activity_id)) {
    throw authError(400, "invalid_activity_scope", "The Live Activity scope is invalid.");
  }
  if (!validActivityRegistrationGeneration(payload.activity_registration_generation)) {
    throw authError(400, "invalid_activity_generation", "The Live Activity registration generation is invalid.");
  }
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const expiresAtMs = requiredTimestampMilliseconds(payload.expires_at_ms, "expires_at_ms");
  if (expiresAtMs <= nowMs || expiresAtMs > nowMs + 30 * 24 * 60 * 60 * 1000) {
    throw authError(400, "invalid_activity_expiry", "The Live Activity stale marker expiry is invalid.");
  }

  const pointerKey = currentActivityKey(payload.environment, payload.device_id, payload.activity_id);
  const current = await txn.get(pointerKey);
  const reservation = payload.reservation_key
    ? await exactEntitySetReservation(txn, payload, nowMs, { phases: ["begun", "claimed"] })
    : null;
  if (payload.reservation_key && !reservation) {
    return { marked: false, conflict: true, reservation_conflict: true };
  }
  if (
    !current
    || current.activity_registration_generation !== payload.activity_registration_generation
  ) {
    return {
      marked: false,
      conflict: true,
      current_activity_registration_generation: current?.activity_registration_generation || null,
    };
  }
  if (current.status === "stale") {
    const owned = Boolean(
      reservation
      && current.stale_owner_nonce === reservation.owner_nonce
      && current.stale_reservation_version === reservation.version
    );
    return {
      marked: owned,
      already_stale: true,
      owned,
      conflict: !owned,
      activity_registration_generation: current.activity_registration_generation,
    };
  }
  if (current.status !== "active") {
    return { marked: false, conflict: true };
  }
  if (reservation && !reservationSnapshotContains(reservation, current)) {
    return { marked: false, conflict: true, reservation_conflict: true };
  }

  const key = staleActivityKey(
    payload.environment,
    payload.device_id,
    payload.activity_id,
    payload.activity_registration_generation
  );
  const existing = await txn.get(key);
  if (!existing) {
    const markers = await txn.list({ prefix: STALE_ACTIVITY_KEY_PREFIX });
    let retained = 0;
    for (const [markerKey, marker] of markers) {
      if (integer(marker?.expires_at_ms, 0) <= nowMs) {
        await txn.delete(markerKey);
      } else {
        retained += 1;
      }
    }
    if (retained >= MAX_STALE_ACTIVITY_MARKERS) {
      throw authError(503, "activity_state_capacity_exceeded", "Live Activity generation state is temporarily at capacity.");
    }
  }

  const marker = {
    environment: payload.environment,
    device_id: payload.device_id,
    activity_id: payload.activity_id,
    activity_registration_generation: payload.activity_registration_generation,
    created_at_ms: existing?.created_at_ms || nowMs,
    expires_at_ms: Math.max(integer(existing?.expires_at_ms, 0), expiresAtMs),
  };
  await txn.put(key, marker);
  await txn.put(pointerKey, {
    ...current,
    status: "stale",
    stale_at_ms: current.stale_at_ms || nowMs,
    ...(reservation ? {
      stale_owner_nonce: reservation.owner_nonce,
      stale_reservation_version: reservation.version,
    } : {}),
    updated_at_ms: nowMs,
  });
  if (reservation) {
    const routeKey = entityRouteKey(
      reservation.environment,
      current.device_id,
      reservation.entity_id
    );
    const route = await txn.get(routeKey);
    if (
      route?.epoch === reservation.version
      && route.operation_owner_nonce === reservation.owner_nonce
      && route.canonical_activity_id === current.activity_id
      && route.active_activity_registration_generation
        === current.activity_registration_generation
    ) {
      const nextRoute = {
        ...route,
        state: "starting",
        retired_activity_identities: boundedRetiredActivityIdentities([
          ...(Array.isArray(route.retired_activity_identities)
            ? route.retired_activity_identities
            : []),
          retiredActivityIdentity(current),
        ]),
        updated_at_ms: nowMs,
        expires_at_ms: Math.max(
          nowMs + 1_000,
          integer(reservation.intent_expires_at_ms, nowMs + 1_000)
        ),
      };
      delete nextRoute.active_activity_registration_generation;
      delete nextRoute.active_activity_kit_id;
      await putEntityRouteAndIndexes(txn, routeKey, nextRoute);
    }
  }
  return {
    marked: true,
    activity_registration_generation: marker.activity_registration_generation,
    expires_at_ms: marker.expires_at_ms,
  };
}

async function beginEntitySetReservation(txn, payload) {
  await requireActivityAuthority(txn);
  const scope = requireEntitySetReservationScope(payload, { requireExpiry: true });
  const snapshot = normalizeEntitySetSnapshot(payload.activity_snapshot);
  const canonicalActivityID = validActivityID(payload.canonical_activity_id)
    ? payload.canonical_activity_id
    : null;
  const startAttributesHash = validStartAttributesHash(payload.start_attributes_hash)
    ? payload.start_attributes_hash
    : null;
  const displayNameHash = payload.display_name_hash === null
    || payload.display_name_hash === undefined
    ? null
    : validDisplayNameHash(payload.display_name_hash) ? payload.display_name_hash : undefined;
  const operationEpoch = validEntitySetEpoch(payload.operation_epoch)
    ? payload.operation_epoch
    : null;
  const routeExpiresAtMs = requiredTimestampMilliseconds(
    payload.route_expires_at_ms,
    "route_expires_at_ms"
  );
  const intentExpiresAtMs = requiredTimestampMilliseconds(
    payload.intent_expires_at_ms,
    "intent_expires_at_ms"
  );
  const hardDeadlineMs = requiredTimestampMilliseconds(
    payload.hard_deadline_ms,
    "hard_deadline_ms"
  );
  const intentDeviceIDs = normalizeDeviceIDs(payload.intent_device_ids);
  if (
    !canonicalActivityID
    || !startAttributesHash
    || displayNameHash === undefined
    || !operationEpoch
    || intentDeviceIDs.length === 0
    || (scope.deviceID && intentDeviceIDs.some((deviceID) => deviceID !== scope.deviceID))
    || snapshot.some((entry) => !intentDeviceIDs.includes(entry.device_id))
    || routeExpiresAtMs <= scope.nowMs
    || routeExpiresAtMs > scope.nowMs + 30 * 24 * 60 * 60 * 1000
    || intentExpiresAtMs <= scope.nowMs
    || intentExpiresAtMs > routeExpiresAtMs
    || hardDeadlineMs < scope.expiresAtMs
    || hardDeadlineMs > scope.nowMs + MAX_ENTITY_SET_HARD_DEADLINE_MS
  ) {
    throw authError(400, "invalid_entity_set_reservation", "The entity Set route intent is invalid.");
  }
  if (snapshot.some((entry) => (
    entry.entity_id !== scope.entityID
    || (scope.deviceID && entry.device_id !== scope.deviceID)
  ))) {
    throw authError(400, "invalid_activity_snapshot", "The Live Activity snapshot scope is invalid.");
  }
  const routeStateCounts = await pruneEntityRouteState(txn, scope.nowMs);
  const entries = await txn.list({ prefix: ENTITY_SET_RESERVATION_KEY_PREFIX });
  let retained = 0;
  for (const [key, candidate] of entries) {
    if (integer(candidate?.expires_at_ms, 0) <= scope.nowMs) {
      await txn.delete(key);
      continue;
    }
    retained += 1;
    if (entitySetReservationsOverlap(candidate, scope)) {
      return {
        acquired: false,
        conflict: true,
        retry_after_ms: Math.max(1, integer(candidate.expires_at_ms, scope.nowMs) - scope.nowMs),
      };
    }
  }
  if (retained >= MAX_ENTITY_SET_RESERVATIONS) {
    throw authError(
      503,
      "activity_state_capacity_exceeded",
      "Live Activity entity reconciliation is temporarily at capacity."
    );
  }

  const current = await exactCurrentActivitySnapshot(txn, scope, snapshot, {
    annotateMissingMetadata: true,
  });
  if (!current.matches) {
    return { acquired: false, conflict: true, reason: "activity_snapshot_changed" };
  }

  if (!await displayNameAvailableForEntitySet(txn, {
    environment: scope.environment,
    entityID: scope.entityID,
    activityID: canonicalActivityID,
    deviceIDs: intentDeviceIDs,
    displayNameHash,
    nowMs: scope.nowMs,
    allowSameEntityActivityChange: true,
  })) {
    return { acquired: false, conflict: true, reason: "duplicate_activity_name" };
  }

  const existingRoutes = new Map();
  for (const targetDeviceID of intentDeviceIDs) {
    const route = await txn.get(entityRouteKey(
      scope.environment,
      targetDeviceID,
      scope.entityID
    ));
    if (
      route?.state === "uncertain"
      && integer(route.expires_at_ms, 0) > scope.nowMs
    ) {
      return {
        acquired: false,
        conflict: true,
        reason: "prior_delivery_uncertain",
        retry_after_ms: Math.max(1, route.expires_at_ms - scope.nowMs),
      };
    }
    existingRoutes.set(targetDeviceID, route);
  }

  // A committed Start intent remains authoritative after its short-lived KV
  // pending record disappears. Never replace its epoch or send a second APNs
  // Start. Mixed or changed intents are deliberately fail-closed because they
  // cannot be reconciled without knowing whether the first delivery arrived.
  const startingRoutes = intentDeviceIDs.filter((targetDeviceID) => (
    existingRoutes.get(targetDeviceID)?.state === "starting"
  ));
  let operationDeviceIDs = intentDeviceIDs;
  if (startingRoutes.length > 0) {
    const startingDeviceSet = new Set(startingRoutes);
    const exactPersistentIntent = current.snapshot.every((entry) => (
      !startingDeviceSet.has(entry.device_id)
    )) && startingRoutes.every((targetDeviceID) => {
        const route = existingRoutes.get(targetDeviceID);
        return route?.canonical_activity_id === canonicalActivityID
          && route.start_attributes_hash === startAttributesHash
          && (route.display_name_hash || null) === displayNameHash;
      });
    if (!exactPersistentIntent) {
      return {
        acquired: false,
        conflict: true,
        reason: "entity_route_starting_conflict",
        retry_after_ms: Math.max(1, Math.min(...startingRoutes.map((targetDeviceID) => (
          integer(existingRoutes.get(targetDeviceID)?.expires_at_ms, scope.nowMs)
            - scope.nowMs
        )))),
      };
    }
    operationDeviceIDs = intentDeviceIDs.filter((targetDeviceID) => (
      !startingDeviceSet.has(targetDeviceID)
    ));
    if (operationDeviceIDs.length === 0) {
      return {
        acquired: false,
        conflict: false,
        reason: "entity_route_already_starting",
        matched_devices: startingRoutes.length,
        retry_after_ms: Math.max(1, Math.min(...startingRoutes.map((targetDeviceID) => (
          integer(existingRoutes.get(targetDeviceID)?.expires_at_ms, scope.nowMs)
            - scope.nowMs
        )))),
      };
    }
  }

  // Retired route identities are security tombstones: dropping one before the
  // route TTL would let a delayed ActivityKit callback revive an obsolete
  // activity. Compute the complete prospective history before any reservation,
  // route, claim, or APNs side effect and reject churn that cannot be retained.
  const routePlans = new Map();
  for (const targetDeviceID of operationDeviceIDs) {
    const existingRoute = existingRoutes.get(targetDeviceID);
    const exactCanonical = current.snapshot.find((entry) => (
      entry.device_id === targetDeviceID
      && entry.activity_id === canonicalActivityID
      && entry.start_attributes_hash === startAttributesHash
    ));
    const existingActiveIdentity = validActivityID(existingRoute?.canonical_activity_id)
      && validActivityRegistrationGeneration(
        existingRoute?.active_activity_registration_generation
      )
      && (
        !exactCanonical
        || exactCanonical.activity_registration_generation
          !== existingRoute.active_activity_registration_generation
        || (
          existingRoute.active_activity_kit_id
          && exactCanonical.activity_kit_id !== existingRoute.active_activity_kit_id
        )
      )
      ? {
        activity_id: existingRoute.canonical_activity_id,
        activity_registration_generation:
          existingRoute.active_activity_registration_generation,
        ...(validActivityKitID(existingRoute.active_activity_kit_id)
          ? { activity_kit_id: existingRoute.active_activity_kit_id }
          : {}),
      }
      : null;
    const existingEndedIdentity = existingRoute?.state === "ended"
      && validActivityID(existingRoute.canonical_activity_id)
      && validActivityRegistrationGeneration(
        existingRoute.ended_activity_registration_generation
      )
      ? {
        activity_id: existingRoute.canonical_activity_id,
        activity_registration_generation:
          existingRoute.ended_activity_registration_generation,
        ...(validActivityKitID(existingRoute.ended_activity_kit_id)
          ? { activity_kit_id: existingRoute.ended_activity_kit_id }
          : {}),
      }
      : null;
    const retired = uniqueRetiredActivityIdentities([
      ...(Array.isArray(existingRoute?.retired_activity_identities)
        ? existingRoute.retired_activity_identities
        : []),
      ...(existingActiveIdentity ? [existingActiveIdentity] : []),
      ...(existingEndedIdentity ? [existingEndedIdentity] : []),
      ...current.snapshot
        .filter((entry) => (
          entry.device_id === targetDeviceID
          && (!exactCanonical || entitySetSnapshotIdentity(entry)
            !== entitySetSnapshotIdentity(exactCanonical))
        ))
        .map(retiredActivityIdentity),
    ]);
    const retiredActivityIDs = uniqueRetiredActivityIDs([
      ...(Array.isArray(existingRoute?.retired_activity_ids)
        ? existingRoute.retired_activity_ids
        : []),
      ...(existingRoute?.canonical_activity_id
        && existingRoute.canonical_activity_id !== canonicalActivityID
        ? [existingRoute.canonical_activity_id]
        : []),
      ...retired,
    ], canonicalActivityID);
    let plannedRetired = retired;
    let plannedRetiredActivityIDs = retiredActivityIDs;
    if (
      retired.length > MAX_RETIRED_ACTIVITY_IDENTITIES
      || retiredActivityIDs.length > MAX_RETIRED_ACTIVITY_IDENTITIES
    ) {
      // The hard capacity stop protects an ACTIVE route: dropping a tombstone
      // there could let a delayed ActivityKit callback revive an obsolete
      // activity that was never explicitly finished. Once the authorized HA
      // caller has properly ended the route (the recovery the capacity error
      // message documents), the ended generations are already marked stale in
      // this Durable Object, so the newest tombstones stay and only the oldest
      // are trimmed. Storage stays bounded and an active route still fails
      // closed exactly as before.
      if (existingRoute?.state !== "ended") {
        return {
          acquired: false,
          conflict: true,
          reason: "entity_route_history_capacity",
          retry_after_ms: Math.max(
            1,
            integer(existingRoute?.expires_at_ms, routeExpiresAtMs) - scope.nowMs
          ),
        };
      }
      plannedRetired = retired.slice(-MAX_RETIRED_ACTIVITY_IDENTITIES);
      plannedRetiredActivityIDs = retiredActivityIDs.slice(-MAX_RETIRED_ACTIVITY_IDENTITIES);
    }
    routePlans.set(targetDeviceID, {
      exactCanonical,
      retired: plannedRetired,
      retiredActivityIDs: plannedRetiredActivityIDs,
    });
  }

  const newRouteCount = operationDeviceIDs.filter((targetDeviceID) => (
    !existingRoutes.get(targetDeviceID)
  )).length;
  let newClaimCount = 0;
  if (displayNameHash) {
    for (const targetDeviceID of operationDeviceIDs) {
      if (!await txn.get(displayClaimKey(
        scope.environment,
        targetDeviceID,
        displayNameHash
      ))) newClaimCount += 1;
    }
  }
  let newRouteIndexCount = 0;
  for (const targetDeviceID of operationDeviceIDs) {
    const indexedActivityIDs = new Set([
      canonicalActivityID,
      ...activityIDsForEntityRoute(existingRoutes.get(targetDeviceID)),
      ...current.snapshot
        .filter((entry) => entry.device_id === targetDeviceID)
        .map((entry) => entry.activity_id),
    ]);
    for (const indexedActivityID of indexedActivityIDs) {
      const index = await txn.get(activityRouteIndexKey(
        scope.environment,
        targetDeviceID,
        indexedActivityID
      ));
      if (
        index
        && integer(index.expires_at_ms, 0) > scope.nowMs
        && index.entity_id !== scope.entityID
      ) {
        return { acquired: false, conflict: true, reason: "activity_route_claimed" };
      }
      if (!index || integer(index.expires_at_ms, 0) <= scope.nowMs) {
        newRouteIndexCount += 1;
      }
    }
  }
  if (
    routeStateCounts.routeCount + newRouteCount > MAX_ENTITY_ROUTE_RECORDS
    || routeStateCounts.routeIndexCount + newRouteIndexCount
      > MAX_ACTIVITY_ROUTE_INDEX_RECORDS
    || routeStateCounts.claimCount + newClaimCount > MAX_DISPLAY_CLAIMS
  ) {
    throw authError(
      503,
      "activity_state_capacity_exceeded",
      "Live Activity route state is temporarily at capacity."
    );
  }

  const key = entitySetReservationKey(scope.environment, scope.entityID, scope.deviceID);
  const reservation = {
    environment: scope.environment,
    entity_id: scope.entityID,
    device_id: scope.deviceID,
    owner_nonce: scope.ownerNonce,
    version: operationEpoch,
    phase: "begun",
    canonical_activity_id: canonicalActivityID,
    start_attributes_hash: startAttributesHash,
    display_name_hash: displayNameHash,
    intent_device_ids: operationDeviceIDs,
    reused_starting_device_ids: startingRoutes,
    activity_snapshot: current.snapshot.filter((entry) => (
      operationDeviceIDs.includes(entry.device_id)
    )),
    created_at_ms: scope.nowMs,
    updated_at_ms: scope.nowMs,
    expires_at_ms: scope.expiresAtMs,
    hard_deadline_ms: hardDeadlineMs,
    route_expires_at_ms: routeExpiresAtMs,
    intent_expires_at_ms: intentExpiresAtMs,
  };
  await txn.put(key, reservation);
  for (const targetDeviceID of operationDeviceIDs) {
    const routeKey = entityRouteKey(scope.environment, targetDeviceID, scope.entityID);
    const existingRoute = existingRoutes.get(targetDeviceID);
    const { exactCanonical, retired, retiredActivityIDs } = routePlans.get(targetDeviceID);
    const carriesPreviousDisplayName = Boolean(existingRoute) && (
      Object.prototype.hasOwnProperty.call(existingRoute, "previous_display_name_hash")
      || (existingRoute.display_name_hash || null) !== displayNameHash
    );
    await putEntityRouteAndIndexes(txn, routeKey, {
      environment: scope.environment,
      device_id: targetDeviceID,
      entity_id: scope.entityID,
      epoch: operationEpoch,
      canonical_activity_id: canonicalActivityID,
      start_attributes_hash: startAttributesHash,
      display_name_hash: displayNameHash,
      ...(carriesPreviousDisplayName
        ? {
          previous_display_name_hash:
            Object.prototype.hasOwnProperty.call(existingRoute, "previous_display_name_hash")
              ? existingRoute.previous_display_name_hash
              : existingRoute.display_name_hash || null,
        }
        : {}),
      state: exactCanonical ? "active" : "starting",
      ...(exactCanonical?.activity_registration_generation
        ? { active_activity_registration_generation: exactCanonical.activity_registration_generation }
        : {}),
      ...(exactCanonical?.activity_kit_id
        ? { active_activity_kit_id: exactCanonical.activity_kit_id }
        : {}),
      retired_activity_identities: retired,
      retired_activity_ids: retiredActivityIDs,
      operation_key: key,
      operation_owner_nonce: scope.ownerNonce,
      created_at_ms: scope.nowMs,
      updated_at_ms: scope.nowMs,
      expires_at_ms: exactCanonical ? routeExpiresAtMs : intentExpiresAtMs,
    });
    if (displayNameHash) {
      await txn.put(displayClaimKey(scope.environment, targetDeviceID, displayNameHash), {
        environment: scope.environment,
        device_id: targetDeviceID,
        display_name_hash: displayNameHash,
        entity_id: scope.entityID,
        activity_id: canonicalActivityID,
        route_epoch: operationEpoch,
        operation_owner_nonce: scope.ownerNonce,
        state: "provisional",
        created_at_ms: scope.nowMs,
        updated_at_ms: scope.nowMs,
        expires_at_ms: exactCanonical ? routeExpiresAtMs : intentExpiresAtMs,
      });
    }
  }
  return {
    acquired: true,
    reservation_key: key,
    owner_nonce: reservation.owner_nonce,
    version: operationEpoch,
    expires_at_ms: reservation.expires_at_ms,
    reused_starting_device_ids: startingRoutes,
  };
}

async function claimEntitySetReservation(txn, payload) {
  await requireActivityAuthority(txn);
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const reservation = await exactEntitySetReservation(txn, payload, nowMs, {
    phases: ["begun", "claimed"],
  });
  if (!reservation) return { claimed: false, conflict: true, reason: "reservation_lost" };
  const intentDeviceIDs = new Set(reservation.intent_device_ids || []);
  const nextSnapshot = normalizeEntitySetSnapshot(payload.activity_snapshot).filter((entry) => (
    intentDeviceIDs.has(entry.device_id)
  ));
  const scope = reservationScope(reservation, nowMs);
  const current = await exactCurrentActivitySnapshot(txn, scope, nextSnapshot, {
    annotateMissingMetadata: false,
  });
  if (!current.matches) {
    return { claimed: false, conflict: true, reason: "activity_snapshot_changed" };
  }

  const previousByIdentity = new Map(
    reservation.activity_snapshot.map((entry) => [entitySetSnapshotIdentity(entry), entry])
  );
  for (const entry of current.snapshot) {
    if (!previousByIdentity.has(entitySetSnapshotIdentity(entry))) {
      return { claimed: false, conflict: true, reason: "activity_generation_added" };
    }
  }
  const nextIdentities = new Set(current.snapshot.map(entitySetSnapshotIdentity));
  for (const entry of reservation.activity_snapshot) {
    if (nextIdentities.has(entitySetSnapshotIdentity(entry))) continue;
    const pointer = await txn.get(currentActivityKey(
      reservation.environment,
      entry.device_id,
      entry.activity_id
    ));
    if (
      pointer?.status !== "stale"
      || pointer.activity_registration_generation !== entry.activity_registration_generation
      || pointer.stale_owner_nonce !== reservation.owner_nonce
      || pointer.stale_reservation_version !== reservation.version
    ) {
      return { claimed: false, conflict: true, reason: "activity_generation_raced" };
    }
  }

  await txn.put(payload.reservation_key, {
    ...reservation,
    phase: "claimed",
    activity_snapshot: current.snapshot,
    updated_at_ms: nowMs,
  });
  return { claimed: true, version: reservation.version };
}

async function validateEntitySetReservation(txn, payload) {
  await requireActivityAuthority(txn);
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const reservation = await exactEntitySetReservation(txn, payload, nowMs, {
    phases: ["claimed"],
  });
  if (!reservation) return { valid: false, conflict: true, reason: "reservation_lost" };
  const current = await exactCurrentActivitySnapshot(
    txn,
    reservationScope(reservation, nowMs),
    reservation.activity_snapshot,
    { annotateMissingMetadata: false }
  );
  return current.matches
    ? { valid: true, version: reservation.version }
    : { valid: false, conflict: true, reason: "activity_snapshot_changed" };
}

async function commitEntitySetReservation(txn, payload) {
  const validated = await validateEntitySetReservation(txn, payload);
  if (!validated.valid) return { committed: false, ...validated };
  const reservation = await txn.get(payload.reservation_key);
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  await finalizeEntityRouteOperation(txn, reservation, nowMs, { outcome: "commit" });
  await txn.delete(payload.reservation_key);
  return { committed: true, version: validated.version };
}

async function releaseEntitySetReservation(txn, payload) {
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const reservation = await exactEntitySetReservation(txn, payload, nowMs, {
    phases: ["begun", "claimed"],
    allowExpired: true,
  });
  if (!reservation) return { released: false };
  let deviceOutcomes = null;
  if (payload.device_outcomes !== undefined) {
    if (!Array.isArray(payload.device_outcomes) || payload.device_outcomes.length > 256) {
      throw authError(400, "invalid_entity_set_reservation", "The entity Set device outcomes are invalid.");
    }
    deviceOutcomes = new Map();
    const intentDeviceIDs = new Set(reservation.intent_device_ids || []);
    for (const entry of payload.device_outcomes) {
      if (
        !validDeviceID(entry?.device_id)
        || !intentDeviceIDs.has(entry.device_id)
        || !["commit", "uncertain", "abort"].includes(entry.outcome)
        || deviceOutcomes.has(entry.device_id)
      ) {
        throw authError(400, "invalid_entity_set_reservation", "The entity Set device outcomes are invalid.");
      }
      deviceOutcomes.set(entry.device_id, entry.outcome);
    }
  }
  const leaseExpired = integer(reservation.expires_at_ms, 0) <= nowMs;
  await finalizeEntityRouteOperation(txn, reservation, nowMs, {
    outcome: payload.uncertain === true
      || (leaseExpired && reservation.transport_started === true)
      ? "uncertain"
      : "abort",
    deviceOutcomes,
  });
  await txn.delete(payload.reservation_key);
  return { released: true, version: reservation.version };
}

async function renewEntitySetReservation(txn, payload) {
  await requireActivityAuthority(txn);
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const expiresAtMs = requiredTimestampMilliseconds(payload.expires_at_ms, "expires_at_ms");
  const reservation = await exactEntitySetReservation(txn, payload, nowMs, {
    phases: ["begun", "claimed"],
  });
  if (
    !reservation
    || expiresAtMs < nowMs + MIN_ENTITY_SET_RESERVATION_TTL_MS
    || expiresAtMs > nowMs + MAX_ENTITY_SET_RESERVATION_TTL_MS
    || expiresAtMs > integer(reservation.hard_deadline_ms, 0)
  ) return { renewed: false, conflict: true, reason: "reservation_lost" };
  const current = await exactCurrentActivitySnapshot(
    txn,
    reservationScope(reservation, nowMs),
    reservation.activity_snapshot,
    { annotateMissingMetadata: false }
  );
  if (!current.matches) {
    return { renewed: false, conflict: true, reason: "activity_snapshot_changed" };
  }
  await txn.put(payload.reservation_key, {
    ...reservation,
    expires_at_ms: expiresAtMs,
    updated_at_ms: nowMs,
  });
  return { renewed: true, expires_at_ms: expiresAtMs };
}

async function markEntitySetTransportStarted(txn, payload) {
  await requireActivityAuthority(txn);
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const reservation = await exactEntitySetReservation(txn, payload, nowMs, {
    phases: ["begun", "claimed"],
  });
  if (!reservation) {
    return { marked: false, conflict: true, reason: "reservation_lost" };
  }
  const requestedDeviceID = payload.device_id === undefined
    ? null
    : validDeviceID(payload.device_id) ? payload.device_id : undefined;
  if (
    requestedDeviceID === undefined
    || (requestedDeviceID && !(reservation.intent_device_ids || []).includes(requestedDeviceID))
  ) {
    return { marked: false, conflict: true, reason: "reservation_device_changed" };
  }
  const startedDeviceIDs = new Set(
    Array.isArray(reservation.transport_started_device_ids)
      ? reservation.transport_started_device_ids
      : []
  );
  const devicesToMark = requestedDeviceID
    ? [requestedDeviceID]
    : reservation.intent_device_ids || [];
  const alreadyMarked = devicesToMark.every((deviceID) => startedDeviceIDs.has(deviceID));
  if (reservation.transport_started === true && alreadyMarked) {
    return { marked: true, already_marked: true, version: reservation.version };
  }
  for (const deviceID of devicesToMark) startedDeviceIDs.add(deviceID);
  await txn.put(payload.reservation_key, {
    ...reservation,
    transport_started: true,
    transport_started_device_ids: [...startedDeviceIDs].sort(),
    transport_started_at_ms: nowMs,
    updated_at_ms: nowMs,
  });
  return { marked: true, version: reservation.version };
}

async function finalizeEntityRouteOperation(
  txn,
  reservation,
  nowMs,
  { outcome, deviceOutcomes = null }
) {
  if (!reservation) return;
  const hasScopedTransportState = Array.isArray(
    reservation.transport_started_device_ids
  );
  const transportStartedDeviceIDs = new Set(
    hasScopedTransportState ? reservation.transport_started_device_ids : []
  );
  for (const deviceID of reservation.intent_device_ids || []) {
    const deviceOutcome = outcome === "commit"
      ? "commit"
      : deviceOutcomes?.get(deviceID)
        || (
          outcome === "uncertain"
            ? hasScopedTransportState
              ? transportStartedDeviceIDs.has(deviceID) ? "uncertain" : "abort"
              : "uncertain"
            : outcome
        );
    const routeKey = entityRouteKey(reservation.environment, deviceID, reservation.entity_id);
    const route = await txn.get(routeKey);
    if (
      route?.epoch === reservation.version
      && route.operation_owner_nonce === reservation.owner_nonce
    ) {
      const routeState = route.state === "active"
        ? "active"
        : deviceOutcome === "commit" ? "starting"
          : deviceOutcome === "uncertain" ? "uncertain" : "aborted";
      const deviceTransportStarted = hasScopedTransportState
        ? transportStartedDeviceIDs.has(deviceID)
        : reservation.transport_started === true;
      const preservesRetiredTombstones = deviceTransportStarted
        && (
          (Array.isArray(route.retired_activity_identities)
            && route.retired_activity_identities.length > 0)
          || (Array.isArray(route.retired_activity_ids)
            && route.retired_activity_ids.length > 0)
        );
      const nextRoute = {
        ...route,
        state: routeState,
        updated_at_ms: nowMs,
        expires_at_ms: routeState === "active"
          || deviceOutcome === "commit"
          || deviceOutcome === "uncertain"
          || preservesRetiredTombstones
          ? Math.max(integer(route.expires_at_ms, 0), integer(reservation.route_expires_at_ms, 0))
          : Math.max(nowMs + 1_000, integer(reservation.intent_expires_at_ms, nowMs + 1_000)),
      };
      if (deviceOutcome === "commit") delete nextRoute.previous_display_name_hash;
      delete nextRoute.operation_key;
      delete nextRoute.operation_owner_nonce;
      await putEntityRouteAndIndexes(txn, routeKey, nextRoute);
      if (deviceOutcome === "commit" && route.previous_display_name_hash) {
        const oldClaimKey = displayClaimKey(
          reservation.environment,
          deviceID,
          route.previous_display_name_hash
        );
        const oldClaim = await txn.get(oldClaimKey);
        if (
          oldClaim?.entity_id === reservation.entity_id
          && oldClaim.activity_id === route.canonical_activity_id
        ) await txn.delete(oldClaimKey);
      }
    }
    if (!reservation.display_name_hash) continue;
    const claimKey = displayClaimKey(
      reservation.environment,
      deviceID,
      reservation.display_name_hash
    );
    const claim = await txn.get(claimKey);
    if (
      claim?.route_epoch === reservation.version
      && claim.operation_owner_nonce === reservation.owner_nonce
    ) {
      if (deviceOutcome === "abort" && route?.state !== "active") {
        await txn.delete(claimKey);
      } else {
        const nextClaim = {
          ...claim,
          state: route?.state === "active" || deviceOutcome !== "uncertain"
            ? "committed"
            : "uncertain",
          updated_at_ms: nowMs,
          expires_at_ms: route?.state === "active"
            || deviceOutcome === "commit"
            || deviceOutcome === "uncertain"
            ? Math.max(integer(claim.expires_at_ms, 0), integer(reservation.route_expires_at_ms, 0))
            : Math.max(nowMs + 1_000, integer(reservation.intent_expires_at_ms, nowMs + 1_000)),
        };
        delete nextClaim.operation_owner_nonce;
        await txn.put(claimKey, nextClaim);
      }
    }
  }
}

async function authorizeActivityRouteActivation(txn, payload, nowMs) {
  await pruneEntityRouteState(txn, nowMs);
  const entityID = validEntityID(payload.entity_id) ? payload.entity_id : null;
  let displayNameHash = validDisplayNameHash(payload.display_name_hash)
    ? payload.display_name_hash
    : null;
  const activityKitID = validActivityKitID(payload.activity_kit_id)
    ? payload.activity_kit_id
    : null;
  const suppliedRouteEpoch = validEntitySetEpoch(payload.route_epoch)
    ? payload.route_epoch
    : null;
  let route = null;
  let displayClaim = null;
  let routeIndex = await txn.get(activityRouteIndexKey(
    payload.environment,
    payload.device_id,
    payload.activity_id
  ));

  if (routeIndex && integer(routeIndex.expires_at_ms, 0) <= nowMs) {
    await txn.delete(activityRouteIndexKey(
      payload.environment,
      payload.device_id,
      payload.activity_id
    ));
    routeIndex = null;
  }
  if (routeIndex) {
    const indexedRoute = await txn.get(entityRouteKey(
      payload.environment,
      payload.device_id,
      routeIndex.entity_id
    ));
    if (
      !indexedRoute
      || indexedRoute.epoch !== routeIndex.route_epoch
      || integer(indexedRoute.expires_at_ms, 0) <= nowMs
    ) {
      await txn.delete(activityRouteIndexKey(
        payload.environment,
        payload.device_id,
        payload.activity_id
      ));
      routeIndex = null;
    } else {
      route = indexedRoute;
    }
  }

  if (routeIndex?.route_kind === "retired") {
    return { allowed: false, error: "obsolete_entity_activity_route" };
  }
  if (route && entityID && route.entity_id !== entityID) {
    return { allowed: false, error: "obsolete_entity_activity_route" };
  }

  if (!route && entityID) {
    route = await txn.get(entityRouteKey(payload.environment, payload.device_id, entityID));
    if (route && integer(route.expires_at_ms, 0) <= nowMs) {
      await deleteEntityRouteAndIndexes(
        txn,
        entityRouteKey(payload.environment, payload.device_id, entityID),
        route
      );
      route = null;
    }
  }

  if (route) {
    if (route.state === "ended") {
      if (route.canonical_activity_id !== payload.activity_id) {
        return { allowed: false, error: "obsolete_entity_activity_route" };
      }
      if (
        route.ended_activity_registration_generation
          === payload.activity_registration_generation
        || (
          validActivityKitID(route.ended_activity_kit_id)
          && route.ended_activity_kit_id === activityKitID
        )
      ) {
        return { allowed: false, error: "obsolete_activity_registration" };
      }
      if (!validActivityKitID(route.ended_activity_kit_id) || !activityKitID) {
        return { allowed: false, error: "ambiguous_activity_registration" };
      }
      // A different immutable ActivityKit identity is a genuinely new raw
      // registration. Keep the ended tombstone, but do not bind this raw
      // callback to the prior entity Set route.
      return { allowed: true, route: null, displayClaim: null };
    }
    if (suppliedRouteEpoch && suppliedRouteEpoch !== route.epoch) {
      return { allowed: false, error: "obsolete_activity_registration" };
    }
    const indexedCanonical = routeIndex?.route_kind === "canonical"
      && route.canonical_activity_id === payload.activity_id;
    const exactRouteCorrelatedCallback = indexedCanonical
      && Boolean(activityKitID)
      && (!entityID || entityID === route.entity_id)
      && (!payload.start_attributes_hash
        || payload.start_attributes_hash === route.start_attributes_hash)
      && (!displayNameHash || displayNameHash === (route.display_name_hash || null))
      && (
        (route.state === "active"
          && Boolean(route.active_activity_kit_id)
          && route.active_activity_kit_id === activityKitID)
        || (
          (route.state === "starting" || route.state === "uncertain")
          && (!suppliedRouteEpoch || suppliedRouteEpoch === route.epoch)
        )
      );
    if (!entityID && !exactRouteCorrelatedCallback) {
      return { allowed: false, error: "ambiguous_activity_registration" };
    }
    if (route.canonical_activity_id !== payload.activity_id) {
      return { allowed: false, error: "obsolete_entity_activity_route" };
    }
    if (
      !exactRouteCorrelatedCallback
      && route.start_attributes_hash !== (payload.start_attributes_hash || null)
    ) {
      return { allowed: false, error: "entity_activity_attributes_changed" };
    }
    if (!exactRouteCorrelatedCallback && (route.display_name_hash || null) !== displayNameHash) {
      return { allowed: false, error: "entity_activity_display_name_changed" };
    }
    displayNameHash = route.display_name_hash || null;
    const retired = Array.isArray(route.retired_activity_identities)
      ? route.retired_activity_identities
      : [];
    for (const identity of retired) {
      if (identity?.activity_id !== payload.activity_id) continue;
      if (
        identity.activity_registration_generation
        === payload.activity_registration_generation
      ) {
        return { allowed: false, error: "obsolete_activity_registration" };
      }
      if (identity.activity_kit_id) {
        if (!activityKitID) {
          return { allowed: false, error: "ambiguous_activity_registration" };
        }
        if (identity.activity_kit_id === activityKitID) {
          return { allowed: false, error: "obsolete_activity_registration" };
        }
      } else if (
        !(
          route.state === "active"
          && Boolean(route.active_activity_kit_id)
          && route.active_activity_kit_id === activityKitID
        )
        && suppliedRouteEpoch !== route.epoch
      ) {
        // A retired same-ID registration without ActivityKit's immutable ID
        // cannot be distinguished from an old callback by a newly supplied ID.
        // Only the exact pending route epoch or the already-active, exact
        // ActivityKit identity proves the intended replacement. A merely
        // starting route cannot authenticate an arbitrary new ActivityKit ID.
        return { allowed: false, error: "ambiguous_activity_registration" };
      }
    }
    if (route.state === "active") {
      if (
        route.active_activity_kit_id
        ? route.active_activity_kit_id !== activityKitID
        : route.active_activity_registration_generation
          !== payload.activity_registration_generation
      ) {
        return { allowed: false, error: "obsolete_activity_registration" };
      }
    }
  }

  if (displayNameHash) {
    const claim = await txn.get(displayClaimKey(
      payload.environment,
      payload.device_id,
      displayNameHash
    ));
    if (
      claim
      && integer(claim.expires_at_ms, 0) > nowMs
      && claim.activity_id !== payload.activity_id
    ) {
      return { allowed: false, error: "duplicate_activity_name" };
    }
    if (claim && integer(claim.expires_at_ms, 0) > nowMs) displayClaim = claim;
  }
  return { allowed: true, route, displayClaim };
}

async function commitActivityRouteActivation(
  txn,
  payload,
  pointer,
  authorization,
  nowMs
) {
  const route = authorization.route;
  if (route) {
    const routeKey = entityRouteKey(
      payload.environment,
      payload.device_id,
      route.entity_id
    );
    const currentRoute = await txn.get(routeKey);
    if (currentRoute?.epoch !== route.epoch) {
      throw authError(
        409,
        "entity_activity_route_changed",
        "The Live Activity route changed while it was registering."
      );
    }
    const nextRoute = {
      ...currentRoute,
      state: "active",
      active_activity_registration_generation: pointer.activity_registration_generation,
      ...(validActivityKitID(payload.activity_kit_id)
        ? { active_activity_kit_id: payload.activity_kit_id }
        : {}),
      updated_at_ms: nowMs,
      expires_at_ms: Math.max(
        integer(currentRoute.expires_at_ms, 0),
        integer(pointer.expires_at_ms, 0)
      ),
    };
    await putEntityRouteAndIndexes(txn, routeKey, nextRoute);

    if (currentRoute.operation_key && currentRoute.operation_owner_nonce) {
      const reservation = await txn.get(currentRoute.operation_key);
      if (
        reservation?.version === currentRoute.epoch
        && reservation.owner_nonce === currentRoute.operation_owner_nonce
        && integer(reservation.expires_at_ms, 0) > nowMs
      ) {
        const nextEntry = normalizeEntitySetSnapshot([pointer])[0];
        const nextSnapshot = reservation.activity_snapshot.filter((entry) => !(
          entry.device_id === pointer.device_id
          && entry.activity_id === pointer.activity_id
        ));
        nextSnapshot.push(nextEntry);
        await txn.put(currentRoute.operation_key, {
          ...reservation,
          activity_snapshot: normalizeEntitySetSnapshot(nextSnapshot),
          updated_at_ms: nowMs,
        });
      }
    }
  }

  if (validDisplayNameHash(pointer.display_name_hash) && validEntityID(pointer.entity_id)) {
    const claimKey = displayClaimKey(
      payload.environment,
      payload.device_id,
      pointer.display_name_hash
    );
    const claim = await txn.get(claimKey);
    if (
      (claim || route)
      && (
        !claim
        || (
        claim.entity_id === pointer.entity_id
        && claim.activity_id === payload.activity_id
        )
      )
    ) {
      await txn.put(claimKey, {
        ...(claim || {}),
        environment: payload.environment,
        device_id: payload.device_id,
        display_name_hash: pointer.display_name_hash,
        entity_id: pointer.entity_id,
        activity_id: payload.activity_id,
        ...(route ? { route_epoch: route.epoch } : {}),
        active_activity_registration_generation: pointer.activity_registration_generation,
        ...(validActivityKitID(payload.activity_kit_id)
          ? { active_activity_kit_id: payload.activity_kit_id }
          : {}),
        state: claim?.state === "provisional" ? "provisional" : "committed",
        created_at_ms: integer(claim?.created_at_ms, nowMs),
        updated_at_ms: nowMs,
        expires_at_ms: Math.max(
          integer(claim?.expires_at_ms, 0),
          integer(pointer.expires_at_ms, 0)
        ),
      });
    }
  }
}

async function claimActivityDisplayNames(txn, payload) {
  await requireActivityAuthority(txn);
  requireEnvironment(payload.environment);
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const expiresAtMs = requiredTimestampMilliseconds(payload.expires_at_ms, "expires_at_ms");
  const ownerNonce = validDisplayClaimOwnerNonce(payload.owner_nonce)
    ? payload.owner_nonce
    : null;
  const entityID = validEntityID(payload.entity_id) ? payload.entity_id : null;
  const activityID = validActivityID(payload.activity_id) ? payload.activity_id : null;
  const displayNameHash = validDisplayNameHash(payload.display_name_hash)
    ? payload.display_name_hash
    : null;
  const deviceIDs = normalizeDeviceIDs(payload.device_ids);
  if (
    !ownerNonce
    || !entityID
    || !activityID
    || !displayNameHash
    || deviceIDs.length === 0
    || expiresAtMs <= nowMs
    || expiresAtMs > nowMs + 30 * 24 * 60 * 60 * 1000
  ) {
    throw authError(400, "invalid_display_claim", "The Live Activity display-name claim is invalid.");
  }
  const routeStateCounts = await pruneEntityRouteState(txn, nowMs);
  const existingClaims = await txn.list({ prefix: DISPLAY_CLAIM_KEY_PREFIX });
  for (const deviceID of deviceIDs) {
    const pointer = await txn.get(currentActivityKey(
      payload.environment,
      deviceID,
      activityID
    ));
    if (
      pointer?.status === "active"
      && integer(pointer.expires_at_ms, 0) > nowMs
      && pointer.route_epoch
      && (pointer.display_name_hash || null) !== displayNameHash
    ) {
      return {
        claimed: false,
        conflict: true,
        reason: "entity_route_managed",
      };
    }
    for (const [, existingActivityClaim] of existingClaims) {
      if (
        existingActivityClaim?.environment !== payload.environment
        || existingActivityClaim.device_id !== deviceID
        || existingActivityClaim.activity_id !== activityID
        || integer(existingActivityClaim.expires_at_ms, 0) <= nowMs
        || existingActivityClaim.state === "aborted"
        || existingActivityClaim.display_name_hash === displayNameHash
      ) continue;
      if (existingActivityClaim.state === "uncertain") {
        return {
          claimed: false,
          conflict: true,
          reason: "prior_delivery_uncertain",
          retry_after_ms: Math.max(
            1,
            integer(existingActivityClaim.expires_at_ms, nowMs) - nowMs
          ),
        };
      }
      if (existingActivityClaim.state === "provisional") {
        return {
          claimed: false,
          conflict: true,
          reason: "display_claim_busy",
          retry_after_ms: Math.max(
            1,
            integer(existingActivityClaim.expires_at_ms, nowMs) - nowMs
          ),
        };
      }
      if (validEntitySetEpoch(existingActivityClaim.route_epoch)) {
        return {
          claimed: false,
          conflict: true,
          reason: "entity_route_managed",
        };
      }
    }
    const existing = await txn.get(displayClaimKey(
      payload.environment,
      deviceID,
      displayNameHash
    ));
    if (
      existing
      && integer(existing.expires_at_ms, 0) > nowMs
      && existing.state === "uncertain"
    ) {
      return {
        claimed: false,
        conflict: true,
        reason: "prior_delivery_uncertain",
        retry_after_ms: Math.max(1, integer(existing.expires_at_ms, nowMs) - nowMs),
      };
    }
    if (
      existing
      && integer(existing.expires_at_ms, 0) > nowMs
      && existing.state === "provisional"
      && existing.claim_owner_nonce !== ownerNonce
    ) {
      return {
        claimed: false,
        conflict: true,
        reason: "display_claim_busy",
        retry_after_ms: Math.max(1, integer(existing.expires_at_ms, nowMs) - nowMs),
      };
    }
  }
  if (!await displayNameAvailableForEntitySet(txn, {
    environment: payload.environment,
    entityID,
    activityID,
    deviceIDs,
    displayNameHash,
    nowMs,
    allowSameEntityActivityChange: false,
  })) {
    return { claimed: false, conflict: true, reason: "duplicate_activity_name" };
  }
  let newClaimCount = 0;
  for (const deviceID of deviceIDs) {
    if (!await txn.get(displayClaimKey(payload.environment, deviceID, displayNameHash))) {
      newClaimCount += 1;
    }
  }
  if (routeStateCounts.claimCount + newClaimCount > MAX_DISPLAY_CLAIMS) {
    throw authError(
      503,
      "activity_state_capacity_exceeded",
      "Live Activity display-name state is temporarily at capacity."
    );
  }
  const ownedKeys = [];
  for (const deviceID of deviceIDs) {
    const key = displayClaimKey(payload.environment, deviceID, displayNameHash);
    const existing = await txn.get(key);
    if (
      existing
      && integer(existing.expires_at_ms, 0) > nowMs
      && existing.entity_id === entityID
      && existing.activity_id === activityID
      && existing.state !== "aborted"
    ) continue;
    await txn.put(key, {
      environment: payload.environment,
      device_id: deviceID,
      display_name_hash: displayNameHash,
      entity_id: entityID,
      activity_id: activityID,
      claim_owner_nonce: ownerNonce,
      state: "provisional",
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
      expires_at_ms: expiresAtMs,
    });
    ownedKeys.push(key);
  }
  return { claimed: true, owner_nonce: ownerNonce, owned_keys: ownedKeys };
}

async function commitActivityDisplayNames(txn, payload) {
  return await finalizeActivityDisplayNames(txn, payload, "commit");
}

// A Live Activity the device reports as dismissed or ended no longer owns its
// display name. The owning claim is keyed by nonce, which the retiring device does
// not hold, so it is released by exact identity instead: only claims recorded for
// this environment, device and activity are dropped. Any other activity's claim is
// left untouched, so retirement can never free a name it does not own.
async function retireActivityDisplayClaims(txn, payload) {
  await requireActivityAuthority(txn);
  requireEnvironment(payload.environment);
  if (!validDeviceID(payload.device_id) || !validActivityID(payload.activity_id)) {
    throw authError(400, "invalid_display_claim", "The Live Activity display-name claim is invalid.");
  }
  const claims = await txn.list({ prefix: DISPLAY_CLAIM_KEY_PREFIX });
  let retired = 0;
  for (const [key, claim] of claims) {
    if (
      claim?.environment !== payload.environment
      || claim.device_id !== payload.device_id
      || claim.activity_id !== payload.activity_id
    ) continue;
    await txn.delete(key);
    retired += 1;
  }
  return { retired_display_claims: retired };
}

async function releaseActivityDisplayNames(txn, payload) {
  return await finalizeActivityDisplayNames(
    txn,
    payload,
    payload.uncertain === true ? "uncertain" : "abort"
  );
}

async function finalizeActivityDisplayNames(txn, payload, outcome) {
  await requireActivityAuthority(txn);
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  if (!validDisplayClaimOwnerNonce(payload.owner_nonce) || !Array.isArray(payload.claim_keys)) {
    throw authError(400, "invalid_display_claim", "The Live Activity display-name claim is invalid.");
  }
  let finalized = 0;
  for (const key of payload.claim_keys.slice(0, 256)) {
    if (typeof key !== "string" || !key.startsWith(DISPLAY_CLAIM_KEY_PREFIX)) continue;
    const claim = await txn.get(key);
    if (claim?.claim_owner_nonce !== payload.owner_nonce) continue;
    if (outcome === "abort") {
      await txn.delete(key);
    } else {
      const next = {
        ...claim,
        state: outcome === "uncertain" ? "uncertain" : "committed",
        updated_at_ms: nowMs,
      };
      delete next.claim_owner_nonce;
      await txn.put(key, next);
    }
    finalized += 1;
  }
  return { finalized };
}

async function clearActivityRouteState(txn, payload) {
  await requireActivityAuthority(txn);
  requireEnvironment(payload.environment);
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const expiresAtMs = payload.expires_at_ms === undefined
    ? null
    : requiredTimestampMilliseconds(payload.expires_at_ms, "expires_at_ms");
  if (
    !validDeviceID(payload.device_id)
    || !validActivityID(payload.activity_id)
    || !validEntityID(payload.entity_id)
    || !validActivityRegistrationGeneration(payload.activity_registration_generation)
    || (expiresAtMs !== null && (
      expiresAtMs <= nowMs
      || expiresAtMs > nowMs + 30 * 24 * 60 * 60 * 1000
    ))
  ) {
    throw authError(400, "invalid_activity_route", "The Live Activity route is invalid.");
  }
  const routeKey = entityRouteKey(payload.environment, payload.device_id, payload.entity_id);
  const route = await txn.get(routeKey);
  const exactRoute = Boolean(
    route
    && route.canonical_activity_id === payload.activity_id
    && route.active_activity_registration_generation
      === payload.activity_registration_generation
    && (
      !route.active_activity_kit_id
      || route.active_activity_kit_id === payload.activity_kit_id
    )
  );
  if (exactRoute) {
    const endedRoute = {
      ...route,
      state: "ended",
      ended_activity_registration_generation:
        route.active_activity_registration_generation,
      ...(validActivityKitID(route.active_activity_kit_id)
        ? { ended_activity_kit_id: route.active_activity_kit_id }
        : {}),
      updated_at_ms: nowMs,
      expires_at_ms: Math.max(
        integer(route.expires_at_ms, 0),
        expiresAtMs || 0,
        nowMs + 1_000
      ),
    };
    delete endedRoute.active_activity_registration_generation;
    delete endedRoute.active_activity_kit_id;
    delete endedRoute.operation_key;
    delete endedRoute.operation_owner_nonce;
    await putEntityRouteAndIndexes(txn, routeKey, endedRoute);
  }
  if (exactRoute && route.display_name_hash) {
    const claimKey = displayClaimKey(
      payload.environment,
      payload.device_id,
      route.display_name_hash
    );
    const claim = await txn.get(claimKey);
    if (
      claim?.entity_id === payload.entity_id
      && claim.activity_id === payload.activity_id
      && (!claim.route_epoch || claim.route_epoch === route.epoch)
    ) await txn.delete(claimKey);
  }
  let rawClaimCleared = false;
  if (validDisplayNameHash(payload.display_name_hash)) {
    const rawClaimKey = displayClaimKey(
      payload.environment,
      payload.device_id,
      payload.display_name_hash
    );
    const rawClaim = await txn.get(rawClaimKey);
    if (
      rawClaim?.entity_id === payload.entity_id
      && rawClaim.activity_id === payload.activity_id
      && rawClaim.active_activity_registration_generation
        === payload.activity_registration_generation
      && (
        !rawClaim.active_activity_kit_id
        || rawClaim.active_activity_kit_id === payload.activity_kit_id
      )
    ) {
      await txn.delete(rawClaimKey);
      rawClaimCleared = true;
    }
  }
  return {
    cleared: exactRoute || rawClaimCleared,
    conflict: !exactRoute && !rawClaimCleared,
    ...(exactRoute || rawClaimCleared ? { cleared_at_ms: nowMs } : {}),
  };
}

async function displayNameAvailableForEntitySet(txn, {
  environment,
  entityID,
  activityID,
  deviceIDs,
  displayNameHash,
  nowMs,
  allowSameEntityActivityChange,
}) {
  if (!displayNameHash) return true;
  for (const deviceID of deviceIDs) {
    const claim = await txn.get(displayClaimKey(environment, deviceID, displayNameHash));
    if (
      claim
      && integer(claim.expires_at_ms, 0) > nowMs
      && claim.state !== "aborted"
      && (
        claim.state === "uncertain"
        ||
        claim.entity_id !== entityID
        || (!allowSameEntityActivityChange && claim.activity_id !== activityID)
      )
    ) return false;
  }
  const pointers = await txn.list({ prefix: `${CURRENT_ACTIVITY_KEY_PREFIX}${environment}:` });
  const targetDevices = new Set(deviceIDs);
  for (const [, pointer] of pointers) {
    if (
      pointer?.status !== "active"
      || integer(pointer.expires_at_ms, 0) <= nowMs
      || !targetDevices.has(pointer.device_id)
      || pointer.display_name_hash !== displayNameHash
    ) continue;
    if (
      (pointer.entity_id && pointer.entity_id !== entityID)
      || (
        !allowSameEntityActivityChange
        && pointer.activity_id !== activityID
      )
    ) return false;
  }
  return true;
}

async function pruneEntityRouteState(txn, nowMs) {
  const reservations = await txn.list({ prefix: ENTITY_SET_RESERVATION_KEY_PREFIX });
  let reservationCount = 0;
  for (const [key, reservation] of reservations) {
    if (integer(reservation?.expires_at_ms, 0) <= nowMs) {
      await finalizeEntityRouteOperation(txn, reservation, nowMs, {
        outcome: reservation.transport_started === true ? "uncertain" : "abort",
      });
      await txn.delete(key);
    } else {
      reservationCount += 1;
    }
  }
  const routes = await txn.list({ prefix: ENTITY_ROUTE_KEY_PREFIX });
  let routeCount = 0;
  for (const [key, route] of routes) {
    if (integer(route?.expires_at_ms, 0) <= nowMs) {
      await deleteEntityRouteAndIndexes(txn, key, route);
    }
    else routeCount += 1;
  }
  const routeIndexes = await txn.list({ prefix: ACTIVITY_ROUTE_INDEX_KEY_PREFIX });
  let routeIndexCount = 0;
  for (const [key, index] of routeIndexes) {
    if (integer(index?.expires_at_ms, 0) <= nowMs) {
      await txn.delete(key);
      continue;
    }
    const route = validEntityID(index?.entity_id)
      ? await txn.get(entityRouteKey(index.environment, index.device_id, index.entity_id))
      : null;
    if (
      !route
      || route.epoch !== index.route_epoch
      || integer(route.expires_at_ms, 0) <= nowMs
    ) {
      await txn.delete(key);
      continue;
    }
    routeIndexCount += 1;
  }
  const claims = await txn.list({ prefix: DISPLAY_CLAIM_KEY_PREFIX });
  let claimCount = 0;
  for (const [key, claim] of claims) {
    if (integer(claim?.expires_at_ms, 0) <= nowMs) await txn.delete(key);
    else claimCount += 1;
  }
  return { reservationCount, routeCount, routeIndexCount, claimCount };
}

function retiredActivityIdentity(entry) {
  return {
    activity_id: entry.activity_id,
    activity_registration_generation: entry.activity_registration_generation,
    ...(validActivityKitID(entry.activity_kit_id)
      ? { activity_kit_id: entry.activity_kit_id }
      : {}),
  };
}

function boundedRetiredActivityIdentities(entries) {
  return uniqueRetiredActivityIdentities(entries).slice(-MAX_RETIRED_ACTIVITY_IDENTITIES);
}

function uniqueRetiredActivityIdentities(entries) {
  const unique = new Map();
  for (const entry of entries) {
    if (!validActivityID(entry?.activity_id)) continue;
    if (!validActivityRegistrationGeneration(entry?.activity_registration_generation)) continue;
    const normalized = retiredActivityIdentity(entry);
    const identity = [
      normalized.activity_id,
      normalized.activity_registration_generation,
      normalized.activity_kit_id || "",
    ].join("\n");
    unique.delete(identity);
    unique.set(identity, normalized);
  }
  return [...unique.values()];
}

function boundedRetiredActivityIDs(entries, canonicalActivityID = null) {
  return uniqueRetiredActivityIDs(entries, canonicalActivityID)
    .slice(-MAX_RETIRED_ACTIVITY_IDENTITIES);
}

function uniqueRetiredActivityIDs(entries, canonicalActivityID = null) {
  const unique = new Set();
  for (const entry of entries) {
    const activityID = typeof entry === "string" ? entry : entry?.activity_id;
    if (!validActivityID(activityID) || activityID === canonicalActivityID) continue;
    unique.delete(activityID);
    unique.add(activityID);
  }
  return [...unique];
}

function normalizeDeviceIDs(value) {
  if (!Array.isArray(value) || value.length > 256) return [];
  const result = [...new Set(value)];
  return result.every(validDeviceID) ? result : [];
}

function entityRouteKey(environment, deviceID, entityID) {
  return `${ENTITY_ROUTE_KEY_PREFIX}${environment}:${deviceID}:${encodeURIComponent(entityID)}`;
}

function activityRouteIndexKey(environment, deviceID, activityID) {
  return `${ACTIVITY_ROUTE_INDEX_KEY_PREFIX}${environment}:${deviceID}:${activityID}`;
}

function activityIDsForEntityRoute(route) {
  if (!route) return [];
  return [...new Set([
    route.canonical_activity_id,
    ...(Array.isArray(route.retired_activity_ids) ? route.retired_activity_ids : []),
    ...(Array.isArray(route.retired_activity_identities)
      ? route.retired_activity_identities.map((identity) => identity?.activity_id)
      : []),
  ].filter(validActivityID))];
}

async function putEntityRouteAndIndexes(txn, key, route) {
  const previous = await txn.get(key);
  await txn.put(key, route);
  const nextActivityIDs = new Set(activityIDsForEntityRoute(route));
  for (const activityID of nextActivityIDs) {
    await txn.put(activityRouteIndexKey(route.environment, route.device_id, activityID), {
      environment: route.environment,
      device_id: route.device_id,
      activity_id: activityID,
      entity_id: route.entity_id,
      route_epoch: route.epoch,
      route_kind: activityID === route.canonical_activity_id ? "canonical" : "retired",
      created_at_ms: integer(route.created_at_ms, route.updated_at_ms),
      updated_at_ms: route.updated_at_ms,
      expires_at_ms: route.expires_at_ms,
    });
  }
  for (const activityID of activityIDsForEntityRoute(previous)) {
    if (nextActivityIDs.has(activityID)) continue;
    const indexKey = activityRouteIndexKey(
      previous.environment,
      previous.device_id,
      activityID
    );
    const index = await txn.get(indexKey);
    if (
      index?.entity_id === previous.entity_id
      && index.route_epoch === previous.epoch
    ) await txn.delete(indexKey);
  }
}

async function deleteEntityRouteAndIndexes(txn, key, route) {
  await txn.delete(key);
  for (const activityID of activityIDsForEntityRoute(route)) {
    const indexKey = activityRouteIndexKey(route.environment, route.device_id, activityID);
    const index = await txn.get(indexKey);
    if (
      index?.entity_id === route.entity_id
      && index.route_epoch === route.epoch
    ) await txn.delete(indexKey);
  }
}

function displayClaimKey(environment, deviceID, displayNameHash) {
  return `${DISPLAY_CLAIM_KEY_PREFIX}${environment}:${deviceID}:${displayNameHash}`;
}

function requireEntitySetReservationScope(payload, { requireExpiry = false } = {}) {
  requireEnvironment(payload.environment);
  const entityID = validEntityID(payload.entity_id) ? payload.entity_id : null;
  const deviceID = payload.device_id === undefined || payload.device_id === null
    ? null
    : validDeviceID(payload.device_id) ? payload.device_id : undefined;
  const ownerNonce = validEntitySetOwnerNonce(payload.owner_nonce) ? payload.owner_nonce : null;
  const nowMs = requiredTimestampMilliseconds(payload.now_ms, "now_ms");
  const expiresAtMs = requireExpiry
    ? requiredTimestampMilliseconds(payload.expires_at_ms, "expires_at_ms")
    : null;
  if (!entityID || deviceID === undefined || !ownerNonce) {
    throw authError(400, "invalid_entity_set_reservation", "The entity Set reservation is invalid.");
  }
  if (
    requireExpiry
    && (
      expiresAtMs < nowMs + MIN_ENTITY_SET_RESERVATION_TTL_MS
      || expiresAtMs > nowMs + MAX_ENTITY_SET_RESERVATION_TTL_MS
    )
  ) {
    throw authError(400, "invalid_entity_set_reservation", "The entity Set reservation expiry is invalid.");
  }
  return {
    environment: payload.environment,
    entityID,
    deviceID,
    ownerNonce,
    nowMs,
    expiresAtMs,
  };
}

function reservationScope(reservation, nowMs) {
  return {
    environment: reservation.environment,
    entityID: reservation.entity_id,
    deviceID: reservation.device_id ?? null,
    intentDeviceIDs: normalizeDeviceIDs(reservation.intent_device_ids),
    ownerNonce: reservation.owner_nonce,
    nowMs,
  };
}

async function exactEntitySetReservation(
  txn,
  payload,
  nowMs,
  { phases, deleteExpired = false, allowExpired = false }
) {
  if (
    typeof payload.reservation_key !== "string"
    || !payload.reservation_key.startsWith(ENTITY_SET_RESERVATION_KEY_PREFIX)
    || !validEntitySetOwnerNonce(payload.owner_nonce)
    || !(
      validEntitySetEpoch(payload.reservation_version)
      || Number.isInteger(payload.reservation_version)
    )
  ) return null;
  const reservation = await txn.get(payload.reservation_key);
  if (!reservation) return null;
  if (integer(reservation.expires_at_ms, 0) <= nowMs) {
    if (allowExpired) {
      if (
        reservation.owner_nonce !== payload.owner_nonce
        || reservation.version !== payload.reservation_version
        || !phases.includes(reservation.phase)
      ) return null;
      return reservation;
    }
    if (deleteExpired) await txn.delete(payload.reservation_key);
    return null;
  }
  if (
    reservation.owner_nonce !== payload.owner_nonce
    || reservation.version !== payload.reservation_version
    || !phases.includes(reservation.phase)
  ) return null;
  return reservation;
}

function normalizeEntitySetSnapshot(value) {
  if (!Array.isArray(value) || value.length > MAX_ACTIVITY_POINTERS_PER_ENVIRONMENT) {
    throw authError(400, "invalid_activity_snapshot", "The Live Activity snapshot is invalid.");
  }
  const seen = new Set();
  const normalized = value.map((candidate) => {
    if (
      !validDeviceID(candidate?.device_id)
      || !validActivityID(candidate?.activity_id)
      || !validActivityRegistrationGeneration(candidate?.activity_registration_generation)
      || !validEntityID(candidate?.entity_id)
      || !(
        candidate?.start_attributes_hash === null
        || candidate?.start_attributes_hash === undefined
        || validStartAttributesHash(candidate.start_attributes_hash)
      )
      || !(
        candidate?.display_name_hash === null
        || candidate?.display_name_hash === undefined
        || validDisplayNameHash(candidate.display_name_hash)
      )
      || !(
        candidate?.activity_kit_id === null
        || candidate?.activity_kit_id === undefined
        || validActivityKitID(candidate.activity_kit_id)
      )
    ) {
      throw authError(400, "invalid_activity_snapshot", "The Live Activity snapshot is invalid.");
    }
    const entry = {
      device_id: candidate.device_id,
      activity_id: candidate.activity_id,
      activity_registration_generation: candidate.activity_registration_generation,
      entity_id: candidate.entity_id,
      start_attributes_hash: candidate.start_attributes_hash || null,
      display_name_hash: candidate.display_name_hash || null,
      activity_kit_id: candidate.activity_kit_id || null,
    };
    const pointerIdentity = `${entry.device_id}\n${entry.activity_id}`;
    if (seen.has(pointerIdentity)) {
      throw authError(400, "invalid_activity_snapshot", "The Live Activity snapshot contains duplicates.");
    }
    seen.add(pointerIdentity);
    return entry;
  });
  return normalized.sort((left, right) => entitySetSnapshotIdentity(left).localeCompare(
    entitySetSnapshotIdentity(right)
  ));
}

async function exactCurrentActivitySnapshot(
  txn,
  scope,
  expectedSnapshot,
  { annotateMissingMetadata }
) {
  const expected = normalizeEntitySetSnapshot(expectedSnapshot);
  if (expected.some((entry) => (
    entry.entity_id !== scope.entityID
    || (scope.deviceID && entry.device_id !== scope.deviceID)
    || (scope.intentDeviceIDs?.length > 0
      && !scope.intentDeviceIDs.includes(entry.device_id))
  ))) return { matches: false, snapshot: [] };
  const expectedByPointer = new Map(expected.map((entry) => [
    `${entry.device_id}\n${entry.activity_id}`,
    entry,
  ]));
  const entries = await txn.list({
    prefix: `${CURRENT_ACTIVITY_KEY_PREFIX}${scope.environment}:`,
  });
  const snapshot = [];
  for (const [key, pointer] of entries) {
    if (
      pointer?.status !== "active"
      || integer(pointer.expires_at_ms, 0) <= scope.nowMs
      || (scope.deviceID && pointer.device_id !== scope.deviceID)
      || (scope.intentDeviceIDs?.length > 0
        && !scope.intentDeviceIDs.includes(pointer.device_id))
    ) continue;
    const expectedEntry = expectedByPointer.get(`${pointer.device_id}\n${pointer.activity_id}`);
    if (pointer.entity_id && pointer.entity_id !== scope.entityID) continue;
    // Pre-fence pointers may not yet carry the entity metadata introduced with
    // reservations. Only a trusted Worker snapshot may adopt such a pointer.
    // Unknown unrelated pointers are not part of this entity-scoped fence.
    if (!pointer.entity_id && !expectedEntry) continue;
    if (
      !expectedEntry
      || pointer.activity_registration_generation
        !== expectedEntry.activity_registration_generation
      || (annotateMissingMetadata
        ? Boolean(pointer.entity_id && pointer.entity_id !== expectedEntry.entity_id)
        : pointer.entity_id !== expectedEntry.entity_id)
      || (annotateMissingMetadata
        ? Boolean(
          pointer.start_attributes_hash
          && pointer.start_attributes_hash !== expectedEntry.start_attributes_hash
        )
        : (pointer.start_attributes_hash || null) !== expectedEntry.start_attributes_hash)
      || (annotateMissingMetadata
        ? Boolean(
          pointer.display_name_hash
          && pointer.display_name_hash !== expectedEntry.display_name_hash
        )
        : (pointer.display_name_hash || null) !== expectedEntry.display_name_hash)
      || (annotateMissingMetadata
        ? Boolean(
          pointer.activity_kit_id
          && pointer.activity_kit_id !== expectedEntry.activity_kit_id
        )
        : (pointer.activity_kit_id || null) !== expectedEntry.activity_kit_id)
    ) return { matches: false, snapshot: [] };

    if (
      annotateMissingMetadata
      && (
        !pointer.entity_id
        || (!pointer.start_attributes_hash && expectedEntry.start_attributes_hash)
        || (!pointer.display_name_hash && expectedEntry.display_name_hash)
        || (!pointer.activity_kit_id && expectedEntry.activity_kit_id)
      )
    ) {
      await txn.put(key, {
        ...pointer,
        entity_id: pointer.entity_id || expectedEntry.entity_id,
        ...(pointer.start_attributes_hash || !expectedEntry.start_attributes_hash
          ? {}
          : { start_attributes_hash: expectedEntry.start_attributes_hash }),
        ...(pointer.display_name_hash || !expectedEntry.display_name_hash
          ? {}
          : { display_name_hash: expectedEntry.display_name_hash }),
        ...(pointer.activity_kit_id || !expectedEntry.activity_kit_id
          ? {}
          : { activity_kit_id: expectedEntry.activity_kit_id }),
      });
    }
    snapshot.push(expectedEntry);
  }
  if (snapshot.length !== expected.length) return { matches: false, snapshot: [] };
  return {
    matches: true,
    snapshot: normalizeEntitySetSnapshot(snapshot),
  };
}

function reservationSnapshotContains(reservation, pointer) {
  return reservation.activity_snapshot.some((entry) => (
    entry.device_id === pointer.device_id
    && entry.activity_id === pointer.activity_id
    && entry.activity_registration_generation === pointer.activity_registration_generation
    && (!pointer.entity_id || entry.entity_id === pointer.entity_id)
    && (!pointer.start_attributes_hash
      || entry.start_attributes_hash === pointer.start_attributes_hash)
    && (!pointer.display_name_hash
      || entry.display_name_hash === pointer.display_name_hash)
    && (!pointer.activity_kit_id || entry.activity_kit_id === pointer.activity_kit_id)
  ));
}

function entitySetReservationsOverlap(candidate, requested) {
  return candidate?.environment === requested.environment
    && candidate.entity_id === requested.entityID
    && (
      !candidate.device_id
      || !requested.deviceID
      || candidate.device_id === requested.deviceID
    );
}

function entitySetSnapshotIdentity(entry) {
  return [
    entry.device_id,
    entry.activity_id,
    entry.activity_registration_generation,
    entry.entity_id,
    entry.start_attributes_hash || "",
    entry.display_name_hash || "",
    entry.activity_kit_id || "",
  ].join("\n");
}

function entitySetReservationKey(environment, entityID, deviceID) {
  return `${ENTITY_SET_RESERVATION_KEY_PREFIX}${environment}:${deviceID || "broadcast"}:${encodeURIComponent(entityID)}`;
}

async function reconcileLegacyDevice(txn, instance, payload, candidate) {
  if (
    instance?.auth_protocol !== "v2"
    || candidate.authProtocol !== "v1"
    || integer(candidate.generation, -1) !== 0
  ) {
    return null;
  }

  const transitionMs = timestampMilliseconds(instance.upgraded_at);
  const proofMs = timestampMilliseconds(candidate.proofTimestamp);
  if (transitionMs === null || proofMs === null || proofMs > transitionMs) {
    return null;
  }

  const key = deviceKey(candidate.environment, candidate.deviceID);
  const existing = await txn.get(key);
  if (existing) return existing;

  const maximumDevices = integer(payload.maximum_devices, 32);
  const devices = await txn.list({ prefix: `${DEVICE_KEY_PREFIX}${candidate.environment}:` });
  const activeCount = [...devices.values()].filter((entry) =>
    entry?.status === "active_v2" || entry?.status === "legacy"
  ).length;
  if (activeCount >= maximumDevices) {
    if (candidate.failOnQuota) {
      throw authError(409, "device_quota_exceeded", "The device quota for this Home Assistant instance has been reached.");
    }
    return null;
  }

  const reconciledAt = validTimestamp(payload.now) ? payload.now : instance.upgraded_at;
  const reconciled = {
    device_id: candidate.deviceID,
    environment: candidate.environment,
    status: "legacy",
    auth_protocol: "v1",
    generation: 0,
    created_at: candidate.proofTimestamp,
    reconciled_at: reconciledAt,
    updated_at: reconciledAt,
  };
  await txn.put(key, reconciled);
  return reconciled;
}

async function loadOrMigrateInstance(txn, payload) {
  let instance = await txn.get(INSTANCE_KEY);
  if (instance) return instance;
  if (!isHash(payload.legacy_secret_hash)) return null;
  if (!safeEqual(payload.legacy_secret_hash, payload.provided_secret_hash)) return null;
  instance = {
    secret_hash: payload.legacy_secret_hash,
    auth_protocol: payload.legacy_auth_protocol === "v2" ? "v2" : "v1",
    created_at: payload.now,
    updated_at: payload.now,
  };
  await txn.put(INSTANCE_KEY, instance);
  return instance;
}

function ticketMatches(ticket, payload) {
  return ticket.device_id === payload.device_id && ticket.environment === payload.environment;
}

function deviceKey(environment, deviceID) {
  return `${DEVICE_KEY_PREFIX}${environment}:${deviceID}`;
}

function staleActivityKey(environment, deviceID, activityID, generation) {
  return `${STALE_ACTIVITY_KEY_PREFIX}${environment}:${deviceID}:${activityID}:${generation}`;
}

function currentActivityKey(environment, deviceID, activityID) {
  return `${CURRENT_ACTIVITY_KEY_PREFIX}${environment}:${deviceID}:${activityID}`;
}

function staleActivityMarkerMatches(marker, environment, candidate) {
  return marker?.environment === environment
    && marker.device_id === candidate.device_id
    && marker.activity_id === candidate.activity_id
    && marker.activity_registration_generation === candidate.activity_registration_generation;
}

function requireScope(payload) {
  if (
    !validDeviceID(payload.device_id)
    || (payload.environment !== "production" && payload.environment !== "sandbox")
  ) {
    throw authError(400, "invalid_auth_scope", "The relay authorization scope is invalid.");
  }
}

function requireEnvironment(environment) {
  if (environment !== "production" && environment !== "sandbox") {
    throw authError(400, "invalid_auth_scope", "The relay authorization scope is invalid.");
  }
}

function validDeviceID(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function validActivityID(value) {
  return typeof value === "string" && (
    /^[A-Za-z0-9._-]{1,128}$/.test(value)
    || /^~[A-Za-z0-9_-]{2,127}$/.test(value)
  );
}

function validActivityRegistrationGeneration(value) {
  return typeof value === "string" && (
    /^ar_[A-Za-z0-9_-]{22,64}$/.test(value)
    || /^legacy_[a-f0-9]{64}$/.test(value)
  );
}

function validEntityID(value) {
  return typeof value === "string"
    && value.length <= 255
    && /^[a-z0-9_]+\.[a-z0-9_]+$/.test(value);
}

function validStartAttributesHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validDisplayNameHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validActivityKitID(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 256
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function validEntitySetEpoch(value) {
  return typeof value === "string" && /^set_[A-Za-z0-9_-]{16,64}$/.test(value);
}

function validEntitySetOwnerNonce(value) {
  return typeof value === "string" && /^es_[A-Za-z0-9_-]{16,64}$/.test(value);
}

function validDisplayClaimOwnerNonce(value) {
  return typeof value === "string" && /^dc_[A-Za-z0-9_-]{16,64}$/.test(value);
}

function requireHash(value, field, status = 400) {
  if (!isHash(value)) {
    throw authError(status, "invalid_auth_hash", `${field} is invalid.`);
  }
}

function isHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function nullableEqual(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return safeEqual(left, right);
}

function safeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index % Math.max(a.length, 1)) || 0)
      ^ (b.charCodeAt(index % Math.max(b.length, 1)) || 0);
  }
  return diff === 0;
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function timestampMilliseconds(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredTimestampMilliseconds(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw authError(400, "invalid_auth_timestamp", `${field} is invalid.`);
  }
  return parsed;
}

function validTimestamp(value) {
  return timestampMilliseconds(value) !== null;
}

function authError(status, code, safeMessage) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  error.safeMessage = safeMessage;
  return error;
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
