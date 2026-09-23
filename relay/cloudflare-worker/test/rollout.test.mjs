import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  assertCloudflareAccountAccess,
  assertActivityGenerationTransition,
  assertFrozenSecretFile,
  assertFrozenRemoteFile,
  assertFrozenRolloutFiles,
  assertHealthyDeployment,
  assertPreSchemaBridgeHealth,
  assertPreSchemaStagingHealth,
  assertExclusiveDeployment,
  assertGuardedVersion,
  assertLegacyContinuityVersion,
  assertLegacyOrBridgeHealth,
  assertRolloutInputs,
  assertSchemaAwareRollbackReceipt,
  assertSchemaAwareReceipt,
  assertSourceSnapshotUnchanged,
  assertStagingSourceSnapshot,
  assertStagingActivityGenerationTransition,
  assertStagingIsolation,
  assertWorkerHealthOrigin,
  assertWorkerSubdomainState,
  buildDeployArguments,
  buildRolloutConfig,
  buildVersionActivationArguments,
  classifyProductionSourceVersion,
  expectedCloudflareAccountID,
  expectedProductionScriptEtag,
  exclusiveDeploymentVersionID,
  fetchBoundedHealthJSON,
  freezeSecretFile,
  freezeRemoteFile,
  freezeVerifiedBundle,
  isRecordedBridgeVersion,
  isRecordedPreSchemaBridgeVersion,
  isRecordedPreSchemaStagingVersion,
  normalizeCanaryHashes,
  parseOptions,
  pinExpectedCloudflareAccount,
  pollUntilExpected,
  recoverPromotionAfterFailure,
  reconcileInitialLifecycleAfterFailure,
  rollbackReceiptForAttempt,
  runBoundedSubprocess,
  stagingProofReceiptFrom,
  preSchemaStagingReceiptFrom,
  suppressSecretUploadForExistingSource,
  uploadOperationForSource,
  validateStagingSourceHealth,
  versionTag,
  wranglerChildEnvironment,
} from "../scripts/deploy.mjs";

const baseConfig = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
);

function options(target, phase) {
  return {
    target,
    phase,
    dryRun: true,
    confirmDeploy: false,
    confirmInitialPepper: false,
    confirmAll: false,
    confirmRollback: false,
    confirmStagingTests: false,
  };
}

function runDeployCLI(args) {
  return spawnSync(process.execPath, [
    new URL("../scripts/deploy.mjs", import.meta.url).pathname,
    ...args,
  ], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
}

function healthy(overrides = {}) {
  return {
    ok: true,
    ready: true,
    storage: true,
    apns_configured: true,
    apns_environment: "production",
    apns_mock: false,
    relay_enabled: true,
    strongly_consistent_auth_ready: true,
    auth_state_schema_version: 2,
    activity_registration_generation_schema_version: 1,
    activity_generation_schema: "auth_state_current_generation_v1",
    activity_generation_mode: "compatible",
    activity_route_authority: "sticky_per_instance_compatibility_v1",
    minimum_safe_rollback_auth_state_schema_version: 2,
    pre_schema_rollback_safe: false,
    v2_device_auth_configured: true,
    legacy_app_auth_configured: true,
    distributed_rate_limit_ready: true,
    v2_pairing_mode: "off",
    v2_pairing_enabled: false,
    v2_pairing_allowlist_configured: false,
    v2_pairing_allowlist_count: 0,
    ...overrides,
  };
}

function authoritativeHealthy(overrides = {}) {
  return healthy({
    activity_generation_mode: "authoritative",
    activity_route_authority: "auth_state_current_generation_v1",
    pre_schema_rollback_safe: false,
    ...overrides,
  });
}

function remoteVersion(config, {
  id = "123e4567-e89b-42d3-a456-426614174000",
  target = "production",
  phase = "bridge",
  artifact = "a".repeat(64),
  etag = "e".repeat(64),
} = {}) {
  const environment = target === "staging" ? config.env.staging : config;
  const activityGenerationMode = environment.vars.ACTIVITY_GENERATION_MODE;
  const bindings = Object.entries(environment.vars).map(([name, text]) => ({
    name,
    type: "plain_text",
    text,
  }));
  bindings.push({
    name: "TOKENS",
    type: "kv_namespace",
    namespace_id: environment.kv_namespaces[0].id,
  });
  bindings.push({
    name: "RATE_LIMITER",
    type: "ratelimit",
    namespace_id: String(environment.ratelimits[0].namespace_id),
    simple: structuredClone(environment.ratelimits[0].simple),
  });
  bindings.push({
    name: "AUTH_STATE",
    type: "durable_object_namespace",
    class_name: "RelayAuthState",
  });
  bindings.push({ name: "CF_VERSION_METADATA", type: "version_metadata" });
  for (const name of environment.secrets?.required || []) {
    bindings.push({ name, type: "secret_text" });
  }
  return {
    id,
    metadata: { source: "wrangler" },
    annotations: {
      "workers/message": `HA LiveKit relay v2 ${target} ${phase}`,
      "workers/tag": activityGenerationMode == null
        ? `hlk-v2-${target === "production" ? "prod" : "stg"}-${phase}-${artifact}`
        : versionTag(target, phase, artifact, activityGenerationMode),
    },
    resources: {
      script: { etag },
      script_runtime: {
        compatibility_date: config.compatibility_date,
        compatibility_flags: structuredClone(config.compatibility_flags || []),
        migration_tag: config.migrations.at(-1).tag,
      },
      bindings,
    },
  };
}

test("rollout options default to the production bridge and reject unsafe values", () => {
  assert.deepEqual(parseOptions(["--dry-run"]), {
    target: "production",
    phase: "bridge",
    dryRun: true,
    confirmDeploy: false,
    confirmInitialPepper: false,
    confirmAll: false,
    confirmRollback: false,
    confirmStagingTests: false,
    bridgeVersionID: undefined,
    bridgeArtifactSHA256: undefined,
    bridgeScriptEtag: undefined,
    stagingProofVersionID: undefined,
    stagingProofArtifactSHA256: undefined,
    stagingProofScriptEtag: undefined,
  });
  assert.throws(() => parseOptions(["--target=other"]), /production or staging/);
  assert.throws(
    () => parseOptions(["--target=staging", "--phase=rollback"]),
    /only for the production/
  );
  assert.throws(
    () => parseOptions(["--target=staging", "--phase=bridge"]),
    /Staging rollout supports only --phase=all/
  );
  assert.throws(
    () => parseOptions(["--target=staging", "--phase=allowlist"]),
    /Staging rollout supports only --phase=all/
  );
  assert.throws(() => parseOptions(["--dry-run=true"]), /boolean flag/);
  assert.throws(() => parseOptions(["--unknown"]), /Unknown or malformed/);
  assert.throws(() => parseOptions(["--target="]), /non-empty/);
  assert.throws(() => parseOptions(["--dry-run", "--dry-run"]), /Duplicate/);
  assert.throws(
    () => parseOptions(["--bridge-version-id=a", "--bridge-version-id=b"]),
    /Duplicate/
  );
});

test("allowlist hashes are normalized without storing a canonical instance ID", () => {
  const hash = "A".repeat(64);
  assert.equal(normalizeCanaryHashes(`${hash}, ${hash}`, true), "a".repeat(64));
  assert.throws(() => normalizeCanaryHashes("ha_not_a_hash", true), /non-SHA-256/);
  assert.throws(() => normalizeCanaryHashes("", true), /at least one/);
  assert.throws(
    () => normalizeCanaryHashes(`${"a".repeat(64)},${"b".repeat(64)}`, true, true),
    /exactly one canary/
  );
});

test("production rollout config is generated in memory and fails closed by default", () => {
  const original = JSON.stringify(baseConfig);
  const bridge = buildRolloutConfig(baseConfig, options("production", "bridge"), {});
  assert.equal(bridge.vars.ACTIVITY_GENERATION_MODE, "compatible");
  assert.equal(bridge.vars.V2_PAIRING_MODE, "off");
  assert.equal(bridge.vars.V2_PAIRING_CANARY_INSTANCE_HASHES, "");
  assert.equal(bridge.send_metrics, false);
  assert.equal(bridge.workers_dev, true);
  assert.equal(bridge.preview_urls, false);
  assert.deepEqual(bridge.secrets.required, [
    "APPLE_PRIVATE_KEY",
    "HA_LIVEKIT_APP_SECRET",
    "DEVICE_CREDENTIAL_PEPPER",
    "RELAY_ENABLED",
  ]);
  assert.equal(bridge.vars.RELAY_ENABLED, undefined);

  const hash = "b".repeat(64);
  const allowlist = buildRolloutConfig(baseConfig, options("production", "allowlist"), {
    V2_PAIRING_CANARY_INSTANCE_HASHES: hash,
  });
  assert.equal(allowlist.vars.V2_PAIRING_MODE, "allowlist");
  assert.equal(allowlist.vars.ACTIVITY_GENERATION_MODE, "authoritative");
  assert.equal(allowlist.vars.V2_PAIRING_CANARY_INSTANCE_HASHES, hash);
  assert.equal(allowlist.vars.APNS_MOCK, "false");
  assert.throws(() => buildRolloutConfig(baseConfig, options("production", "allowlist"), {
    V2_PAIRING_CANARY_INSTANCE_HASHES: `${"a".repeat(64)},${"b".repeat(64)}`,
  }), /exactly one canary/);
  assert.doesNotThrow(() => buildRolloutConfig(baseConfig, options("production", "bridge"), {
    V2_PAIRING_CANARY_INSTANCE_HASHES: "stale-not-a-hash",
  }));
  assert.doesNotThrow(() => buildRolloutConfig(baseConfig, options("production", "all"), {
    V2_PAIRING_CANARY_INSTANCE_HASHES: "stale-not-a-hash",
  }));
  const externalProductionDO = structuredClone(baseConfig);
  externalProductionDO.durable_objects.bindings[0].environment = "staging";
  assert.throws(
    () => buildRolloutConfig(externalProductionDO, options("production", "bridge"), {}),
    /Production AUTH_STATE must be self-bound/
  );
  assert.equal(JSON.stringify(baseConfig), original);
});

test("activity-generation modes are phase-bound and environment mismatches fail before rollout", () => {
  const bridge = buildRolloutConfig(baseConfig, options("production", "bridge"), {});
  const allowlist = buildRolloutConfig(baseConfig, options("production", "allowlist"), {
    V2_PAIRING_CANARY_INSTANCE_HASHES: "a".repeat(64),
  });
  const staging = buildRolloutConfig(baseConfig, options("staging", "all"), {
    STAGING_KV_NAMESPACE_ID: "b".repeat(32),
    STAGING_RATE_LIMIT_NAMESPACE_ID: "694211",
  });
  assert.equal(bridge.vars.ACTIVITY_GENERATION_MODE, "compatible");
  assert.equal(allowlist.vars.ACTIVITY_GENERATION_MODE, "authoritative");
  assert.equal(staging.env.staging.vars.ACTIVITY_GENERATION_MODE, "authoritative");

  assert.doesNotThrow(() => assertRolloutInputs(
    baseConfig,
    bridge,
    options("production", "bridge"),
    {
      DEVICE_CREDENTIAL_PEPPER: "p".repeat(32),
      ACTIVITY_GENERATION_MODE: "compatible",
    },
    {}
  ));
  assert.throws(() => assertRolloutInputs(
    baseConfig,
    bridge,
    options("production", "bridge"),
    {
      DEVICE_CREDENTIAL_PEPPER: "p".repeat(32),
      ACTIVITY_GENERATION_MODE: "authoritative",
    },
    {}
  ), /cannot target production\/bridge/);
});

test("every remote config is pinned to an explicit expected Cloudflare account", () => {
  const accountID = "a".repeat(32);
  assert.equal(expectedCloudflareAccountID({
    EXPECTED_CLOUDFLARE_ACCOUNT_ID: accountID.toUpperCase(),
  }), accountID);
  assert.equal(expectedCloudflareAccountID({}, { required: false }), undefined);
  assert.throws(() => expectedCloudflareAccountID({}), /explicit 32-hex account ID/);
  assert.throws(() => expectedCloudflareAccountID({
    EXPECTED_CLOUDFLARE_ACCOUNT_ID: "not-an-account",
  }), /explicit 32-hex account ID/);

  const production = buildRolloutConfig(baseConfig, options("production", "bridge"), {});
  pinExpectedCloudflareAccount(production, "production", accountID);
  assert.equal(production.account_id, accountID);

  const staging = buildRolloutConfig(baseConfig, options("staging", "all"), {
    STAGING_KV_NAMESPACE_ID: "b".repeat(32),
    STAGING_RATE_LIMIT_NAMESPACE_ID: "694211",
  });
  pinExpectedCloudflareAccount(staging, "staging", accountID);
  assert.equal(staging.account_id, accountID);
  assert.equal(staging.env.staging.account_id, accountID);

  const conflicting = structuredClone(baseConfig);
  conflicting.account_id = "c".repeat(32);
  assert.throws(
    () => pinExpectedCloudflareAccount(conflicting, "production", accountID),
    /conflicts/
  );
});

test("confirmed remote flows prove direct API access to the exact pinned account", async () => {
  const accountID = "a".repeat(32);
  const production = buildRolloutConfig(baseConfig, options("production", "bridge"), {});
  pinExpectedCloudflareAccount(production, "production", accountID);
  let requestedURL;
  const result = await assertCloudflareAccountAccess(production, "production", {
    authHeaders: { authorization: "Bearer test-only" },
    fetchImpl: async (url) => {
      requestedURL = url;
      return new Response(JSON.stringify({
        success: true,
        result: { subdomain: "account-subdomain" },
      }), { headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(result.subdomain, "account-subdomain");
  assert.match(requestedURL, new RegExp(`/accounts/${accountID}/workers/subdomain$`));

  await assert.rejects(assertCloudflareAccountAccess(production, "production", {
    authHeaders: { authorization: "Bearer test-only" },
    fetchImpl: async () => new Response(JSON.stringify({ success: false }), {
      headers: { "content-type": "application/json" },
    }),
  }), /account-level Worker read did not validate/);
});

test("health checks are bound to the exact pinned Worker origin", () => {
  const production = buildRolloutConfig(baseConfig, options("production", "bridge"), {});
  const accountAccess = { subdomain: "account-subdomain" };
  assert.equal(
    assertWorkerHealthOrigin(
      "https://ha-livekit-apns-relay.account-subdomain.workers.dev",
      production,
      "production",
      accountAccess
    ),
    "https://ha-livekit-apns-relay.account-subdomain.workers.dev"
  );
  for (const unsafeURL of [
    "https://another-worker.account-subdomain.workers.dev",
    "https://ha-livekit-apns-relay.other-account.workers.dev",
    "https://ha-livekit-apns-relay.account-subdomain.workers.dev/health",
    "https://ha-livekit-apns-relay.account-subdomain.workers.dev:8443",
    "https://custom.example.com",
  ]) {
    assert.throws(
      () => assertWorkerHealthOrigin(
        unsafeURL,
        production,
        "production",
        accountAccess
      ),
      /exact pinned Worker origin/
    );
  }
});

test("remote upload is pinned to the immutable verified preflight bundle", (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "ha-livekit-rollout-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundleDirectory = resolve(directory, "bundle");
  const sourcePath = resolve(directory, "live-source.js");
  const verifiedMainPath = resolve(bundleDirectory, "index.js");
  const configPath = resolve(directory, "wrangler.json");
  mkdirSync(bundleDirectory);
  writeFileSync(sourcePath, "export default 'before';\n");
  writeFileSync(verifiedMainPath, "export default 'verified';\n");
  writeFileSync(configPath, "{}\n");
  const rolloutConfig = { ...structuredClone(baseConfig), main: sourcePath };
  const temporary = { directory, bundleDirectory, configPath };

  const artifact = freezeVerifiedBundle(temporary, rolloutConfig);
  const verifiedBytes = readFileSync(verifiedMainPath, "utf8");
  writeFileSync(sourcePath, "export default 'changed-after-preflight';\n");
  const args = buildDeployArguments(
    options("production", "bridge"),
    temporary,
    false,
    versionTag("production", "bridge", artifact)
  );

  assert.equal(args[0], "deploy");
  assert.equal(args[1], verifiedMainPath);
  assert.ok(args.includes("--no-bundle"));
  assert.ok(!args.includes("--keep-vars"));
  assert.equal(readFileSync(verifiedMainPath, "utf8"), verifiedBytes);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).main, verifiedMainPath);
  assert.equal(statSync(verifiedMainPath).mode & 0o222, 0);
  assert.notEqual(args[1], sourcePath);
  assert.doesNotThrow(() => assertFrozenRolloutFiles(temporary));

  chmodSync(configPath, 0o600);
  writeFileSync(configPath, `${JSON.stringify({ main: sourcePath })}\n`);
  assert.throws(
    () => assertFrozenRolloutFiles(temporary),
    /generated Wrangler config.*after preflight/
  );
});

test("frozen remote files reject same-user content replacement and symlink swaps", (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "ha-livekit-frozen-file-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const contentPath = resolve(directory, "bundle.js");
  const replacementPath = resolve(directory, "config.json");
  writeFileSync(contentPath, "verified bytes\n", { mode: 0o400 });
  writeFileSync(replacementPath, "{\"verified\":true}\n", { mode: 0o400 });
  const contentSnapshot = freezeRemoteFile(contentPath, "verified test bundle");
  const replacementSnapshot = freezeRemoteFile(replacementPath, "verified test config");
  assert.doesNotThrow(() => assertFrozenRemoteFile(contentSnapshot));
  assert.doesNotThrow(() => assertFrozenRemoteFile(replacementSnapshot));

  chmodSync(contentPath, 0o600);
  writeFileSync(contentPath, "tampered bytes\n");
  assert.throws(() => assertFrozenRemoteFile(contentSnapshot), /after preflight/);

  rmSync(replacementPath);
  writeFileSync(replacementPath, "{\"verified\":true}\n", { mode: 0o400 });
  assert.throws(() => assertFrozenRemoteFile(replacementSnapshot), /replaced after preflight/);
});

test("the secret payload is frozen and rehashed immediately before remote upload", (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "ha-livekit-secret-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const secretsPath = resolve(directory, "secrets.json");
  writeFileSync(secretsPath, '{"SECRET":"initial-value"}\n', { mode: 0o600 });
  const temporary = { secretsPath };

  const digest = freezeSecretFile(temporary);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(statSync(secretsPath).mode & 0o222, 0);
  assert.doesNotThrow(() => assertFrozenSecretFile(temporary));

  // Simulate a same-user TOCTOU attempt; the pre-spawn hash gate must stop it.
  chmodSync(secretsPath, 0o600);
  writeFileSync(secretsPath, '{"SECRET":"changed-after-preflight"}\n');
  assert.throws(() => assertFrozenSecretFile(temporary), /changed after preflight/);
});

test("staging requires separate KV, rate limit, Worker, Durable Object, and mock APNs", () => {
  const staging = buildRolloutConfig(baseConfig, options("staging", "all"), {
    STAGING_KV_NAMESPACE_ID: "a".repeat(32),
    STAGING_RATE_LIMIT_NAMESPACE_ID: "694211",
  });
  assert.doesNotThrow(() => assertStagingIsolation(baseConfig, staging));
  assert.equal(staging.env.staging.vars.APNS_MOCK, "true");
  assert.equal(staging.env.staging.vars.APNS_ENVIRONMENT, "sandbox");
  assert.equal(staging.env.staging.vars.V2_PAIRING_MODE, "all");
  assert.equal(staging.env.staging.workers_dev, true);
  assert.equal(staging.env.staging.preview_urls, false);
  assert.deepEqual(staging.env.staging.secrets.required, [
    "APPLE_PRIVATE_KEY",
    "HA_LIVEKIT_APP_SECRET",
    "DEVICE_CREDENTIAL_PEPPER",
  ]);
  assert.equal(staging.send_metrics, false);

  const sharedKV = buildRolloutConfig(baseConfig, options("staging", "all"), {
    STAGING_KV_NAMESPACE_ID: baseConfig.kv_namespaces[0].id,
    STAGING_RATE_LIMIT_NAMESPACE_ID: "694211",
  });
  assert.throws(() => assertStagingIsolation(baseConfig, sharedKV), /distinct from production/);

  const realAPNs = structuredClone(staging);
  realAPNs.env.staging.vars.APNS_MOCK = "false";
  assert.throws(() => assertStagingIsolation(baseConfig, realAPNs), /APNS_MOCK=true/);

  const unrelatedDO = structuredClone(staging);
  unrelatedDO.env.staging.durable_objects.bindings[0].script_name = "unrelated-worker";
  assert.throws(
    () => assertStagingIsolation(baseConfig, unrelatedDO),
    /self-bound staging AUTH_STATE/
  );
  const exactStagingDO = structuredClone(staging);
  exactStagingDO.env.staging.durable_objects.bindings[0].script_name = staging.env.staging.name;
  assert.throws(() => assertStagingIsolation(baseConfig, exactStagingDO), /self-bound staging AUTH_STATE/);
  const productionEnvironmentDO = structuredClone(staging);
  productionEnvironmentDO.env.staging.durable_objects.bindings[0].environment = "production";
  assert.throws(
    () => assertStagingIsolation(baseConfig, productionEnvironmentDO),
    /self-bound staging AUTH_STATE/
  );

  const stagingVersion = remoteVersion(staging, {
    target: "staging",
    phase: "all",
  });
  assert.doesNotThrow(() => assertGuardedVersion(stagingVersion, {
    id: stagingVersion.id,
    target: "staging",
    phase: "all",
    tag: stagingVersion.annotations["workers/tag"],
    config: staging,
  }));
  stagingVersion.resources.bindings.find(
    (item) => item.name === "AUTH_STATE"
  ).script_name = staging.env.staging.name;
  assert.doesNotThrow(() => assertGuardedVersion(stagingVersion, {
    id: stagingVersion.id,
    target: "staging",
    phase: "all",
    tag: stagingVersion.annotations["workers/tag"],
    config: staging,
  }));
  stagingVersion.resources.bindings.find(
    (item) => item.name === "AUTH_STATE"
  ).script_name = "unrelated-worker";
  assert.throws(() => assertGuardedVersion(stagingVersion, {
    id: stagingVersion.id,
    target: "staging",
    phase: "all",
    tag: stagingVersion.annotations["workers/tag"],
    config: staging,
  }), /self-bound staging AUTH_STATE scope/);
  stagingVersion.resources.bindings.find(
    (item) => item.name === "AUTH_STATE"
  ).script_name = staging.env.staging.name;
  stagingVersion.resources.bindings.find((item) => item.name === "AUTH_STATE").environment = "production";
  assert.throws(() => assertGuardedVersion(stagingVersion, {
    id: stagingVersion.id,
    target: "staging",
    phase: "all",
    tag: stagingVersion.annotations["workers/tag"],
    config: staging,
  }), /self-bound staging AUTH_STATE scope/);
});

test("workers.dev is explicit while version preview URLs stay disabled", () => {
  assert.doesNotThrow(() => assertWorkerSubdomainState({
    enabled: true,
    previews_enabled: false,
  }));
  assert.throws(() => assertWorkerSubdomainState({
    enabled: false,
    previews_enabled: false,
  }), /workers_dev=true/);
  assert.throws(() => assertWorkerSubdomainState({
    enabled: true,
    previews_enabled: true,
  }), /preview_urls=false/);
  assert.doesNotThrow(() => assertWorkerSubdomainState({
    enabled: true,
    previews_enabled: true,
  }, { workersDev: true, previewUrls: false, checkPreview: false }));
});

test("staging secrets are strong, synthetic, and distinct from every production secret", () => {
  const staging = buildRolloutConfig(baseConfig, options("staging", "all"), {
    STAGING_KV_NAMESPACE_ID: "a".repeat(32),
    STAGING_RATE_LIMIT_NAMESPACE_ID: "694211",
  });
  const productionSecrets = {
    APPLE_PRIVATE_KEY: `prod-${"a".repeat(40)}`,
    HA_LIVEKIT_APP_SECRET: `prod-${"b".repeat(40)}`,
    DEVICE_CREDENTIAL_PEPPER: `prod-${"c".repeat(40)}`,
  };
  const stagingSecrets = {
    APPLE_PRIVATE_KEY: `synthetic-staging:${"d".repeat(40)}`,
    HA_LIVEKIT_APP_SECRET: `staging-${"e".repeat(40)}`,
    DEVICE_CREDENTIAL_PEPPER: `staging-${"f".repeat(40)}`,
  };
  assert.doesNotThrow(() => assertRolloutInputs(
    baseConfig,
    staging,
    options("staging", "all"),
    stagingSecrets,
    productionSecrets
  ));
  assert.throws(() => assertRolloutInputs(
    baseConfig,
    staging,
    options("staging", "all"),
    { ...stagingSecrets, APPLE_PRIVATE_KEY: productionSecrets.APPLE_PRIVATE_KEY },
    productionSecrets
  ), /Staging APPLE_PRIVATE_KEY must differ/);
  assert.throws(() => assertRolloutInputs(
    baseConfig,
    staging,
    options("staging", "all"),
    { ...stagingSecrets, APPLE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----${"z".repeat(40)}` },
    productionSecrets
  ), /synthetic-staging: mock-only material/);
  assert.throws(() => assertRolloutInputs(
    baseConfig,
    staging,
    options("staging", "all"),
    stagingSecrets,
    { ...productionSecrets, APPLE_PRIVATE_KEY: undefined }
  ), /Production APPLE_PRIVATE_KEY must be available/);
});

test("health gates bind the requested mode and prohibit real APNs in staging", () => {
  assert.doesNotThrow(() => assertHealthyDeployment(healthy(), "production", "bridge"));
  assert.doesNotThrow(() => assertHealthyDeployment(authoritativeHealthy({
    apns_environment: "sandbox",
    apns_mock: true,
    v2_pairing_mode: "all",
    v2_pairing_enabled: true,
  }), "staging", "all"));
  assert.throws(() => assertHealthyDeployment(authoritativeHealthy({
    apns_environment: "sandbox",
    apns_mock: false,
    v2_pairing_mode: "all",
    v2_pairing_enabled: true,
  }), "staging", "all"), /apns_mock/);
  assert.throws(() => assertHealthyDeployment(authoritativeHealthy({
    v2_pairing_mode: "allowlist",
    v2_pairing_enabled: true,
    v2_pairing_allowlist_configured: false,
  }), "production", "allowlist"), /allowlist_configured/);
  const exactTag = versionTag("production", "allowlist", "c".repeat(64));
  assert.doesNotThrow(() => assertHealthyDeployment(authoritativeHealthy({
    v2_pairing_mode: "allowlist",
    v2_pairing_enabled: true,
    v2_pairing_allowlist_configured: true,
    v2_pairing_allowlist_count: 1,
    worker_version_id: "123e4567-e89b-42d3-a456-426614174000",
    worker_version_tag: exactTag,
  }), "production", "allowlist", {
    versionID: "123e4567-e89b-42d3-a456-426614174000",
    versionTag: exactTag,
  }));
  assert.throws(() => assertHealthyDeployment(authoritativeHealthy({
    v2_pairing_mode: "allowlist",
    v2_pairing_enabled: true,
    v2_pairing_allowlist_configured: true,
    v2_pairing_allowlist_count: 2,
  }), "production", "allowlist"), /allowlist_count/);
});

test("health gates require the exact authoritative activity-generation schema contract", () => {
  for (const [field, unsafeValue] of [
    ["auth_state_schema_version", 1],
    ["activity_registration_generation_schema_version", 0],
    ["activity_generation_schema", "kv_best_effort_v0"],
    ["activity_generation_mode", "unknown"],
    ["activity_route_authority", "kv_best_effort"],
    ["minimum_safe_rollback_auth_state_schema_version", 1],
    ["pre_schema_rollback_safe", true],
  ]) {
    const missing = healthy();
    delete missing[field];
    assert.throws(
      () => assertHealthyDeployment(missing, "production", "bridge"),
      new RegExp(field)
    );
    assert.throws(
      () => assertHealthyDeployment(healthy({ [field]: unsafeValue }), "production", "bridge"),
      new RegExp(field)
    );
  }
});

test("health polling retries a semantically stale 200 response", async () => {
  let calls = 0;
  const result = await pollUntilExpected(
    async () => ({ ready: ++calls >= 2 }),
    (value) => {
      if (!value.ready) throw new Error("not propagated");
      return value;
    },
    { attempts: 3, delayMs: 0, sleep: async () => {} }
  );
  assert.equal(calls, 2);
  assert.equal(result.ready, true);
});

test("health requests time out and reject oversized declared or streamed bodies", async () => {
  let stalledCalls = 0;
  await assert.rejects(pollUntilExpected(
    () => fetchBoundedHealthJSON("https://health.invalid/health", {
      timeoutMs: 10,
      fetchImpl: async (_url, { signal }) => {
        stalledCalls += 1;
        return new Response(new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => {
              controller.error(new Error("aborted stalled health stream"));
            }, { once: true });
          },
        }), { headers: { "content-type": "application/json" } });
      },
    }),
    (health) => health,
    { attempts: 2, delayMs: 0, sleep: async () => {}, label: "bounded health" }
  ), /timed out after 10 ms/);
  assert.equal(stalledCalls, 2);

  await assert.rejects(fetchBoundedHealthJSON("https://health.invalid/health", {
    maxBytes: 8,
    fetchImpl: async () => new Response("{}", {
      headers: { "content-length": "9" },
    }),
  }), /exceeds 8 bytes/);

  await assert.rejects(fetchBoundedHealthJSON("https://health.invalid/health", {
    maxBytes: 8,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
        controller.close();
      },
    })),
  }), /exceeds 8 bytes/);

  let fetchOptions;
  assert.deepEqual(await fetchBoundedHealthJSON("https://health.invalid/health", {
    fetchImpl: async (_url, options) => {
      fetchOptions = options;
      return new Response('{"ok":true}');
    },
  }), { ok: true });
  assert.equal(fetchOptions.redirect, "error");
});

test("legacy and pre-schema sources may enter compatible but cannot jump to authoritative", () => {
  const legacyHealth = {
    ok: true,
    storage: true,
    apns_configured: true,
    apns_environment: "production",
    relay_enabled: true,
    endpoints: ["/health", "/register", "/start", "/update", "/end"],
  };
  assert.equal(assertLegacyOrBridgeHealth(legacyHealth), "legacy");
  assert.equal(assertActivityGenerationTransition("legacy", "compatible"), true);
  assert.throws(
    () => assertActivityGenerationTransition("legacy", "authoritative"),
    /schema-aware compatible predecessor/
  );

  const preSchemaBridgeHealth = healthy();
  delete preSchemaBridgeHealth.activity_generation_schema;
  delete preSchemaBridgeHealth.activity_generation_mode;
  delete preSchemaBridgeHealth.activity_route_authority;
  assert.equal(assertPreSchemaBridgeHealth(preSchemaBridgeHealth), "pre-schema-bridge");
  assert.equal(assertLegacyOrBridgeHealth(preSchemaBridgeHealth), "pre-schema-bridge");
  assert.equal(assertActivityGenerationTransition("pre-schema", "compatible"), true);
  assert.throws(
    () => assertActivityGenerationTransition("pre-schema", "authoritative"),
    /schema-aware compatible predecessor/
  );
  assert.equal(assertActivityGenerationTransition("compatible", "authoritative"), true);
  assert.equal(assertActivityGenerationTransition("authoritative", "authoritative"), true);
  assert.throws(
    () => assertActivityGenerationTransition("authoritative", "compatible"),
    /Unsafe activity-generation transition/
  );

  assert.throws(() => assertLegacyOrBridgeHealth({
    ok: true,
    storage: true,
    apns_configured: true,
    apns_environment: "production",
    relay_enabled: true,
    endpoints: ["/health", "/register", "/start"],
  }), /v1_update/);
  assert.throws(() => assertLegacyOrBridgeHealth(healthy({
    v2_pairing_mode: "allowlist",
    v2_pairing_enabled: true,
    v2_pairing_allowlist_configured: true,
  })), /not the legacy relay or an off-mode bridge/);
});

test("the irreversible first bridge requires exact legacy continuity resources", () => {
  const bridgeConfig = buildRolloutConfig(baseConfig, options("production", "bridge"), {});
  const legacy = remoteVersion(bridgeConfig);
  const optional = new Set([
    "APNS_MOCK",
    "ACTIVITY_GENERATION_MODE",
    "V2_PAIRING_MODE",
    "V2_PAIRING_CANARY_INSTANCE_HASHES",
    "CF_VERSION_METADATA",
    "DEVICE_CREDENTIAL_PEPPER",
    "AUTH_STATE",
  ]);
  legacy.resources.bindings = legacy.resources.bindings.filter(
    (item) => !optional.has(item.name)
  );
  delete legacy.resources.script_runtime.migration_tag;
  assert.equal(classifyProductionSourceVersion(legacy, baseConfig), "legacy");
  assert.doesNotThrow(() => assertLegacyContinuityVersion(legacy, baseConfig));

  const generationModeWithoutSchema = structuredClone(legacy);
  generationModeWithoutSchema.resources.bindings.push({
    name: "ACTIVITY_GENERATION_MODE",
    type: "plain_text",
    text: "authoritative",
  });
  assert.equal(classifyProductionSourceVersion(generationModeWithoutSchema, baseConfig), "bridge");
  assert.throws(
    () => assertLegacyContinuityVersion(generationModeWithoutSchema, baseConfig),
    /unexpected binding ACTIVITY_GENERATION_MODE/
  );

  const historicalLegacy = structuredClone(legacy);
  const historicalMissingBindings = new Set([
    "APNS_MOCK",
    "RELAY_ENABLED",
    "RATE_LIMIT_MODE",
    "MAX_REQUEST_BODY_BYTES",
    "MAX_DEVICES_PER_INSTANCE",
    "MAX_ACTIVITIES_PER_INSTANCE",
    "MAX_ACTIVITIES_PER_DEVICE",
    "DEVICE_TTL_SECONDS",
    "ACTIVITY_TTL_SECONDS",
    "ACTIVITY_STATE_TTL_SECONDS",
    "SECRET_TTL_SECONDS",
    "PAIRING_TTL_SECONDS",
    "RATE_LIMITER",
  ]);
  historicalLegacy.resources.bindings = historicalLegacy.resources.bindings.filter(
    (item) => !historicalMissingBindings.has(item.name)
  );
  historicalLegacy.resources.bindings.push({
    name: "RELAY_ENABLED",
    type: "secret_text",
  });
  assert.doesNotThrow(() => assertLegacyContinuityVersion(historicalLegacy, baseConfig));

  for (const unexpectedBinding of [
    { name: "UNEXPECTED_SERVICE", type: "service", service: "another-worker" },
    { name: "UNEXPECTED_DB", type: "d1", id: "database-id" },
    { name: "UNEXPECTED_KV", type: "kv_namespace", namespace_id: "e".repeat(32) },
  ]) {
    const drifted = structuredClone(historicalLegacy);
    drifted.resources.bindings.push(unexpectedBinding);
    assert.throws(
      () => assertLegacyContinuityVersion(drifted, baseConfig),
      /unexpected binding|TOKENS namespace/
    );
  }
  const duplicateTokens = structuredClone(historicalLegacy);
  duplicateTokens.resources.bindings.push(structuredClone(
    historicalLegacy.resources.bindings.find((item) => item.name === "TOKENS")
  ));
  assert.throws(
    () => assertLegacyContinuityVersion(duplicateTokens, baseConfig),
    /TOKENS namespace/
  );

  const wrongKV = structuredClone(legacy);
  wrongKV.resources.bindings.find((item) => item.name === "TOKENS").namespace_id = "f".repeat(32);
  assert.throws(() => assertLegacyContinuityVersion(wrongKV, baseConfig), /TOKENS namespace/);

  const wrongRate = structuredClone(legacy);
  wrongRate.resources.bindings.find((item) => item.name === "RATE_LIMITER").simple.limit += 1;
  assert.throws(() => assertLegacyContinuityVersion(wrongRate, baseConfig), /RATE_LIMITER limit/);
  const wrongPeriod = structuredClone(legacy);
  wrongPeriod.resources.bindings.find((item) => item.name === "RATE_LIMITER").simple.period = 10;
  assert.throws(() => assertLegacyContinuityVersion(wrongPeriod, baseConfig), /RATE_LIMITER period/);

  const externalDO = structuredClone(legacy);
  externalDO.resources.bindings.push({
    name: "AUTH_STATE",
    type: "durable_object_namespace",
    class_name: "RelayAuthState",
    script_name: "other-worker",
  });
  assert.equal(classifyProductionSourceVersion(externalDO, baseConfig), "bridge");
  assert.throws(
    () => assertLegacyContinuityVersion(externalDO, baseConfig),
    /unexpected AUTH_STATE/
  );
  const normalizedSelfDO = structuredClone(legacy);
  normalizedSelfDO.resources.bindings.push({
    name: "AUTH_STATE",
    type: "durable_object_namespace",
    class_name: "RelayAuthState",
    script_name: baseConfig.name,
  });
  assert.equal(classifyProductionSourceVersion(normalizedSelfDO, baseConfig), "bridge");
  assert.throws(
    () => assertLegacyContinuityVersion(normalizedSelfDO, baseConfig),
    /unexpected AUTH_STATE/
  );

  for (const v2Evidence of [
    { name: "CF_VERSION_METADATA", type: "version_metadata" },
    { name: "DEVICE_CREDENTIAL_PEPPER", type: "secret_text" },
    { name: "V2_PAIRING_MODE", type: "plain_text", text: "off" },
  ]) {
    const staleHealthBridge = structuredClone(legacy);
    staleHealthBridge.resources.bindings.push(v2Evidence);
    assert.equal(classifyProductionSourceVersion(staleHealthBridge, baseConfig), "bridge");
    assert.throws(
      () => assertLegacyContinuityVersion(staleHealthBridge, baseConfig),
      /unexpected/
    );
  }
  const migratedBridge = structuredClone(legacy);
  migratedBridge.resources.script_runtime.migration_tag = baseConfig.migrations.at(-1).tag;
  assert.equal(classifyProductionSourceVersion(migratedBridge, baseConfig), "bridge");
  assert.throws(
    () => assertLegacyContinuityVersion(migratedBridge, baseConfig),
    /unexpected Durable Object migration tag/
  );

  const extraBehaviorVar = structuredClone(legacy);
  extraBehaviorVar.resources.bindings.push({
    name: "APNS_PRIORITY",
    type: "plain_text",
    text: "5",
  });
  assert.throws(
    () => assertLegacyContinuityVersion(extraBehaviorVar, baseConfig),
    /unexpected binding APNS_PRIORITY/
  );
  const missingExistingVar = structuredClone(legacy);
  missingExistingVar.resources.bindings = missingExistingVar.resources.bindings.filter(
    (item) => item.name !== "RELAY_ENABLED"
  );
  assert.throws(
    () => assertLegacyContinuityVersion(missingExistingVar, baseConfig),
    /secret RELAY_ENABLED/
  );
  const missingSecret = structuredClone(legacy);
  missingSecret.resources.bindings = missingSecret.resources.bindings.filter(
    (item) => item.name !== "APPLE_PRIVATE_KEY"
  );
  assert.throws(
    () => assertLegacyContinuityVersion(missingSecret, baseConfig),
    /secret APPLE_PRIVATE_KEY/
  );
  const extraSecret = structuredClone(legacy);
  extraSecret.resources.bindings.push({
    name: "APNS_PRIVATE_KEY",
    type: "secret_text",
  });
  assert.throws(
    () => assertLegacyContinuityVersion(extraSecret, baseConfig),
    /unexpected secret APNS_PRIVATE_KEY/
  );
  const duplicateSecret = structuredClone(legacy);
  duplicateSecret.resources.bindings.push({
    name: "APPLE_PRIVATE_KEY",
    type: "secret_text",
  });
  assert.throws(
    () => assertLegacyContinuityVersion(duplicateSecret, baseConfig),
    /duplicate secret APPLE_PRIVATE_KEY/
  );
  const extraCompatibilityFlag = structuredClone(legacy);
  extraCompatibilityFlag.resources.script_runtime.compatibility_flags = ["nodejs_compat"];
  assert.throws(
    () => assertLegacyContinuityVersion(extraCompatibilityFlag, baseConfig),
    /compatibility flags/
  );
});

test("bridge receipt is bound to exact ID, artifact tag, server etag, and off-mode config", () => {
  const bridgeConfig = buildRolloutConfig(baseConfig, options("production", "bridge"), {});
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const artifactSHA256 = "a".repeat(64);
  const scriptEtag = "e".repeat(64);
  const version = remoteVersion(bridgeConfig, { id, artifact: artifactSHA256, etag: scriptEtag });
  const expected = {
    id,
    artifactSHA256,
    scriptEtag,
    authStateSchemaVersion: 2,
    activityRegistrationGenerationSchemaVersion: 1,
    activityGenerationSchema: "auth_state_current_generation_v1",
    activityGenerationMode: "compatible",
    activityRouteAuthority: "sticky_per_instance_compatibility_v1",
    minimumSafeRollbackAuthStateSchemaVersion: 2,
    preSchemaRollbackSafe: false,
    tag: versionTag("production", "bridge", artifactSHA256),
    config: bridgeConfig,
  };
  assert.equal(isRecordedBridgeVersion(version, expected), true);

  const preSchemaTag = structuredClone(version);
  preSchemaTag.annotations["workers/tag"] = `hlk-v2-prod-bridge-${artifactSHA256}`;
  assert.equal(isRecordedBridgeVersion(preSchemaTag, expected), false);

  const preSchemaConfig = structuredClone(bridgeConfig);
  delete preSchemaConfig.vars.ACTIVITY_GENERATION_MODE;
  const exactPreSchema = remoteVersion(preSchemaConfig, {
    id,
    artifact: artifactSHA256,
    etag: scriptEtag,
  });
  assert.equal(isRecordedPreSchemaBridgeVersion(exactPreSchema, {
    id,
    artifactSHA256,
    scriptEtag,
    activityGenerationSchema: null,
    activityGenerationMode: "pre-schema",
    tag: `hlk-v2-prod-bridge-${artifactSHA256}`,
    config: preSchemaConfig,
  }), true);
  assert.equal(isRecordedBridgeVersion(exactPreSchema, expected), false);

  const forgedMessageOnly = structuredClone(version);
  forgedMessageOnly.annotations["workers/tag"] = "operator-supplied-message-only";
  assert.equal(isRecordedBridgeVersion(forgedMessageOnly, expected), false);
  const wrongCode = structuredClone(version);
  wrongCode.resources.script.etag = "f".repeat(64);
  assert.equal(isRecordedBridgeVersion(wrongCode, expected), false);
  const pairingEnabled = structuredClone(version);
  pairingEnabled.resources.bindings.find((item) => item.name === "V2_PAIRING_MODE").text = "all";
  assert.equal(isRecordedBridgeVersion(pairingEnabled, expected), false);
  const externalProductionDO = structuredClone(version);
  externalProductionDO.resources.bindings.find(
    (item) => item.name === "AUTH_STATE"
  ).script_name = "another-production-worker";
  assert.equal(isRecordedBridgeVersion(externalProductionDO, expected), false);
  assert.throws(() => assertGuardedVersion(externalProductionDO, {
    id,
    target: "production",
    phase: "bridge",
    tag: expected.tag,
    config: bridgeConfig,
    scriptEtag,
  }), /self-bound production AUTH_STATE scope/);
  const normalizedSelfDO = structuredClone(version);
  normalizedSelfDO.resources.bindings.find(
    (item) => item.name === "AUTH_STATE"
  ).script_name = bridgeConfig.name;
  assert.equal(isRecordedBridgeVersion(normalizedSelfDO, expected), true);
  const wrongRateLimit = structuredClone(version);
  wrongRateLimit.resources.bindings.find(
    (item) => item.name === "RATE_LIMITER"
  ).simple.limit += 1;
  assert.equal(isRecordedBridgeVersion(wrongRateLimit, expected), false);
  const wrongRatePeriod = structuredClone(version);
  wrongRatePeriod.resources.bindings.find(
    (item) => item.name === "RATE_LIMITER"
  ).simple.period = 10;
  assert.equal(isRecordedBridgeVersion(wrongRatePeriod, expected), false);
  const extraPlainBinding = structuredClone(version);
  extraPlainBinding.resources.bindings.push({
    name: "APNS_PRIORITY",
    type: "plain_text",
    text: "5",
  });
  assert.equal(isRecordedBridgeVersion(extraPlainBinding, expected), false);
  const extraSecretBinding = structuredClone(version);
  extraSecretBinding.resources.bindings.push({
    name: "APNS_PRIVATE_KEY",
    type: "secret_text",
  });
  assert.equal(isRecordedBridgeVersion(extraSecretBinding, expected), false);
  const extraCompatibilityFlag = structuredClone(version);
  extraCompatibilityFlag.resources.script_runtime.compatibility_flags = ["nodejs_compat"];
  assert.equal(isRecordedBridgeVersion(extraCompatibilityFlag, expected), false);
  const flaggedBaseConfig = structuredClone(baseConfig);
  flaggedBaseConfig.compatibility_flags = ["nodejs_compat"];
  const flaggedBridgeConfig = buildRolloutConfig(
    flaggedBaseConfig,
    options("production", "bridge"),
    {}
  );
  const missingCompatibilityFlag = remoteVersion(flaggedBridgeConfig, {
    id,
    artifact: artifactSHA256,
    etag: scriptEtag,
  });
  delete missingCompatibilityFlag.resources.script_runtime.compatibility_flags;
  assert.throws(() => assertGuardedVersion(missingCompatibilityFlag, {
    id,
    target: "production",
    phase: "bridge",
    tag: expected.tag,
    config: flaggedBridgeConfig,
    scriptEtag,
  }), /compatibility flags/);
  assert.equal(isRecordedBridgeVersion(undefined, expected), false);
  assert.doesNotThrow(() => assertGuardedVersion(version, {
    id,
    target: "production",
    phase: "bridge",
    tag: expected.tag,
    config: bridgeConfig,
    scriptEtag,
  }));
});

test("deployment status must route 100 percent to the exact version", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const status = { versions: [{ version_id: id, percentage: 100 }] };
  assert.equal(exclusiveDeploymentVersionID(status), id);
  assert.doesNotThrow(() => assertExclusiveDeployment(status, id));
  assert.throws(() => assertExclusiveDeployment(status, "223e4567-e89b-42d3-a456-426614174000"), /different/);
  assert.throws(() => exclusiveDeploymentVersionID({ versions: [
    { version_id: id, percentage: 50 },
    { version_id: "223e4567-e89b-42d3-a456-426614174000", percentage: 50 },
  ] }), /exactly one/);
});

test("a deploy that mutates traffic and then throws restores the bridge", async () => {
  const sourceVersionID = "123e4567-e89b-42d3-a456-426614174000";
  const mutatedVersionID = "223e4567-e89b-42d3-a456-426614174000";
  let activeVersionID = sourceVersionID;
  let restored = false;
  try {
    activeVersionID = mutatedVersionID;
    throw new Error("wrangler returned nonzero after mutation");
  } catch (failure) {
    await assert.rejects(
      recoverPromotionAfterFailure({
        failure,
        sourceVersionID,
        readStatus: async () => ({
          versions: [{ version_id: activeVersionID, percentage: 100 }],
        }),
        restore: async () => {
          restored = true;
          activeVersionID = sourceVersionID;
        },
        attempts: 1,
        delayMs: 0,
        sleep: async () => {},
      }),
      /restored to the receipt-bound v2 bridge/
    );
  }
  assert.equal(restored, true);
  assert.equal(activeVersionID, sourceVersionID);
});

test("ambiguous post-failure deployment state fails safe through bridge restore", async () => {
  let restored = false;
  await assert.rejects(
    recoverPromotionAfterFailure({
      failure: new Error("wrangler failed"),
      sourceVersionID: "123e4567-e89b-42d3-a456-426614174000",
      readStatus: async () => {
        throw new Error("Cloudflare status unavailable");
      },
      restore: async () => { restored = true; },
      attempts: 1,
      delayMs: 0,
      sleep: async () => {},
    }),
    /unreadable or ambiguous.*restored to the receipt-bound v2 bridge/
  );
  assert.equal(restored, true);
});

test("an unchanged source observation still performs a later unconditional bridge restore", async () => {
  const sourceVersionID = "123e4567-e89b-42d3-a456-426614174000";
  let restored = false;
  await assert.rejects(
    recoverPromotionAfterFailure({
      failure: new Error("wrangler failed after submitting the deployment"),
      sourceVersionID,
      readStatus: async () => ({
        versions: [{ version_id: sourceVersionID, percentage: 100 }],
      }),
      restore: async () => { restored = true; },
    }),
    /delayed propagation cannot prove.*restored to the receipt-bound v2 bridge/
  );
  assert.equal(restored, true);
});

test("first lifecycle mutate-then-timeout reconciles the exact healthy version and preserves its receipt", async () => {
  const sourceVersionID = "123e4567-e89b-42d3-a456-426614174000";
  const deployedVersion = {
    id: "223e4567-e89b-42d3-a456-426614174000",
    exact: true,
  };
  let healthChecked = false;
  const result = await reconcileInitialLifecycleAfterFailure({
    failure: new Error("Wrangler timed out after upload"),
    sourceState: { phase: "legacy", versionID: sourceVersionID },
    readSnapshot: async () => ({
      status: { versions: [{ version_id: deployedVersion.id, percentage: 100 }] },
      version: deployedVersion,
    }),
    assertExpectedVersion: (version) => assert.equal(version.exact, true),
    assertExpectedHealth: async () => { healthChecked = true; },
    attempts: 1,
    delayMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.version, deployedVersion);
  assert.equal(healthChecked, true);
});

test("first lifecycle unchanged observations still require manual intervention", async () => {
  const sourceVersionID = "123e4567-e89b-42d3-a456-426614174000";
  await assert.rejects(reconcileInitialLifecycleAfterFailure({
    failure: new Error("Wrangler failed before upload"),
    sourceState: { phase: "legacy", versionID: sourceVersionID },
    readSnapshot: async () => ({
      status: { versions: [{ version_id: sourceVersionID, percentage: 100 }] },
    }),
    assertExpectedVersion: () => assert.fail("unchanged source is not a receipt"),
    assertExpectedHealth: async () => assert.fail("unchanged source has no new health gate"),
    attempts: 2,
    delayMs: 0,
    sleep: async () => {},
  }), /not proof that no mutation was accepted.*manual intervention is required/);
});

test("first lifecycle ambiguous state fails closed with explicit manual intervention", async () => {
  const unexpectedVersionID = "323e4567-e89b-42d3-a456-426614174000";
  await assert.rejects(reconcileInitialLifecycleAfterFailure({
    failure: new Error("Wrangler failed after request submission"),
    sourceState: { phase: "absent" },
    readSnapshot: async () => ({
      workerMissing: false,
      status: { versions: [{ version_id: unexpectedVersionID, percentage: 100 }] },
      version: { id: unexpectedVersionID, exact: false },
    }),
    assertExpectedVersion: () => { throw new Error("artifact metadata mismatch"); },
    assertExpectedHealth: async () => {},
    attempts: 1,
    delayMs: 0,
    sleep: async () => {},
  }), /manual intervention is required/);
});

test("existing staging activation failure unconditionally restores its receipt-bound checkpoint", async () => {
  const sourceVersionID = "123e4567-e89b-42d3-a456-426614174000";
  let restored = false;
  await assert.rejects(recoverPromotionAfterFailure({
    failure: new Error("staging activation timed out"),
    sourceVersionID,
    readStatus: async () => ({
      versions: [{
        version_id: "223e4567-e89b-42d3-a456-426614174000",
        percentage: 100,
      }],
    }),
    restore: async () => { restored = true; },
    targetLabel: "staging",
    recoveryLabel: "receipt-bound staging checkpoint",
  }), /staging was restored to the receipt-bound staging checkpoint/);
  assert.equal(restored, true);
});

test("an existing bridge re-run retains its exact rollback receipt through health failure", async () => {
  const preSchemaBridge = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    artifactSHA256: "a".repeat(64),
    scriptEtag: "e".repeat(64),
  };
  assert.throws(
    () => rollbackReceiptForAttempt("bridge", {
      phase: "bridge",
      versionID: preSchemaBridge.id,
      rollbackReceipt: preSchemaBridge,
    }, undefined),
    /schema-aware.*rollback/i
  );
  const bootstrapOnlyPreSchema = {
    ...preSchemaBridge,
    activityGenerationSchema: null,
    activityGenerationMode: "pre-schema",
  };
  assert.equal(
    rollbackReceiptForAttempt("bridge", {
      phase: "pre-schema-bridge",
      versionID: bootstrapOnlyPreSchema.id,
      rollbackReceipt: bootstrapOnlyPreSchema,
    }, undefined),
    bootstrapOnlyPreSchema
  );
  assert.throws(
    () => rollbackReceiptForAttempt("allowlist", undefined, bootstrapOnlyPreSchema),
    /schema-aware compatible rollback floor/
  );

  const oldBridge = {
    ...preSchemaBridge,
    authStateSchemaVersion: 2,
    activityRegistrationGenerationSchemaVersion: 1,
    activityGenerationSchema: "auth_state_current_generation_v1",
    activityGenerationMode: "compatible",
    activityRouteAuthority: "sticky_per_instance_compatibility_v1",
    minimumSafeRollbackAuthStateSchemaVersion: 2,
    preSchemaRollbackSafe: false,
  };
  const sourceState = {
    phase: "bridge",
    versionID: oldBridge.id,
    rollbackReceipt: oldBridge,
  };
  assert.equal(
    rollbackReceiptForAttempt("bridge", sourceState, undefined),
    oldBridge
  );

  let restoredReceipt;
  await assert.rejects(recoverPromotionAfterFailure({
    failure: new Error("new bridge health gate failed"),
    sourceVersionID: oldBridge.id,
    readStatus: async () => ({
      versions: [{
        version_id: "223e4567-e89b-42d3-a456-426614174000",
        percentage: 100,
      }],
    }),
    restore: async () => { restoredReceipt = oldBridge; },
  }), /restored to the receipt-bound v2 bridge/);
  assert.equal(restoredReceipt, oldBridge);
  assert.equal(
    rollbackReceiptForAttempt("bridge", { phase: "legacy" }, undefined),
    undefined
  );
});

test("rollback receipts require the exact schema floor before recovery", () => {
  const safeReceipt = {
    authStateSchemaVersion: 2,
    activityRegistrationGenerationSchemaVersion: 1,
    activityGenerationSchema: "auth_state_current_generation_v1",
    activityGenerationMode: "compatible",
    activityRouteAuthority: "sticky_per_instance_compatibility_v1",
    minimumSafeRollbackAuthStateSchemaVersion: 2,
    preSchemaRollbackSafe: false,
  };
  assert.equal(assertSchemaAwareRollbackReceipt(safeReceipt), safeReceipt);
  assert.equal(assertSchemaAwareReceipt(safeReceipt, "compatible"), safeReceipt);
  assert.throws(
    () => assertSchemaAwareReceipt(safeReceipt, "authoritative"),
    /authoritative activity-generation schema/
  );

  for (const [field, unsafeValue] of [
    ["authStateSchemaVersion", 1],
    ["activityRegistrationGenerationSchemaVersion", 0],
    ["activityGenerationSchema", "kv_best_effort_v0"],
    ["activityGenerationMode", "authoritative"],
    ["activityRouteAuthority", "kv_best_effort"],
    ["minimumSafeRollbackAuthStateSchemaVersion", 1],
    ["preSchemaRollbackSafe", true],
  ]) {
    const missing = { ...safeReceipt };
    delete missing[field];
    assert.throws(
      () => assertSchemaAwareRollbackReceipt(missing),
      new RegExp(field)
    );
    assert.throws(
      () => assertSchemaAwareRollbackReceipt({ ...safeReceipt, [field]: unsafeValue }),
      new RegExp(field)
    );
  }
});

test("post-migration uploads cannot mutate traffic or observability before exact validation", () => {
  assert.equal(uploadOperationForSource({ phase: "legacy" }), "deploy");
  assert.equal(uploadOperationForSource({ phase: "absent" }), "deploy");
  assert.equal(uploadOperationForSource({ phase: "pre-schema-bridge" }), "version-upload");
  assert.equal(uploadOperationForSource({ phase: "bridge" }), "version-upload");
  assert.equal(uploadOperationForSource({ phase: "allowlist" }), "version-upload");
  assert.equal(uploadOperationForSource({ phase: "staging" }), "version-upload");

  const temporary = {
    configPath: "/private/tmp/guarded-wrangler.json",
    verifiedMainPath: "/private/tmp/verified/index.js",
  };
  const upload = buildDeployArguments(
    options("production", "allowlist"),
    temporary,
    false,
    versionTag("production", "allowlist", "a".repeat(64)),
    "version-upload"
  );
  assert.deepEqual(upload.slice(0, 2), ["versions", "upload"]);
  assert.ok(upload.includes("--no-bundle"));
  assert.ok(!upload.includes("--keep-vars"));
  assert.ok(!upload.includes("versions deploy"));

  const activate = buildVersionActivationArguments({
    target: "production",
    phase: "allowlist",
    configPath: temporary.configPath,
  }, "123e4567-e89b-42d3-a456-426614174000");
  assert.deepEqual(activate.slice(0, 3), [
    "versions",
    "deploy",
    "123e4567-e89b-42d3-a456-426614174000@100%",
  ]);
  assert.throws(() => buildVersionActivationArguments({
    target: "production",
    phase: "allowlist",
    configPath: temporary.configPath,
  }, "latest"), /valid exact Worker version ID/);

  const existingStaging = {
    configPath: temporary.configPath,
    verifiedMainPath: temporary.verifiedMainPath,
    secretsPath: "/private/tmp/staging-secrets.json",
  };
  suppressSecretUploadForExistingSource(
    existingStaging,
    options("staging", "all"),
    { phase: "staging" }
  );
  const stagingUpload = buildDeployArguments(
    options("staging", "all"),
    existingStaging,
    false,
    versionTag("staging", "all", "a".repeat(64)),
    "version-upload"
  );
  assert.ok(!stagingUpload.includes("--secrets-file"));

  const absentStaging = {
    configPath: temporary.configPath,
    verifiedMainPath: temporary.verifiedMainPath,
    secretsPath: "/private/tmp/staging-secrets.json",
  };
  suppressSecretUploadForExistingSource(
    absentStaging,
    options("staging", "all"),
    { phase: "absent" }
  );
  assert.ok(buildDeployArguments(
    options("staging", "all"),
    absentStaging,
    false,
    versionTag("staging", "all", "a".repeat(64))
  ).includes("--secrets-file"));
});

test("a concurrent deployment aborts before activation or first lifecycle mutation", () => {
  const sourceVersionID = "123e4567-e89b-42d3-a456-426614174000";
  const sourceState = { phase: "bridge", versionID: sourceVersionID };
  assert.doesNotThrow(() => assertSourceSnapshotUnchanged(sourceState, {
    status: { versions: [{ version_id: sourceVersionID, percentage: 100 }] },
  }));
  assert.throws(() => assertSourceSnapshotUnchanged(sourceState, {
    status: {
      versions: [{
        version_id: "223e4567-e89b-42d3-a456-426614174000",
        percentage: 100,
      }],
    },
  }), /source changed after validation/);
  assert.doesNotThrow(() => assertSourceSnapshotUnchanged(
    { phase: "absent" },
    { workerMissing: true }
  ));
  assert.throws(() => assertSourceSnapshotUnchanged(
    { phase: "absent" },
    { workerMissing: false }
  ), /appeared after validation/);
});

test("version tags are stable per exact artifact and phase", () => {
  const artifact = "a".repeat(64);
  assert.equal(versionTag("production", "bridge", artifact), versionTag("production", "bridge", artifact));
  assert.equal(
    versionTag("production", "bridge", artifact),
    `hlk-ag1-mc-tp-pb-${artifact}`
  );
  assert.notEqual(versionTag("production", "bridge", artifact), versionTag("production", "allowlist", artifact));
  assert.notEqual(versionTag("production", "bridge", artifact), versionTag("staging", "all", artifact));
  assert.notEqual(
    versionTag("production", "bridge", artifact, "compatible"),
    versionTag("production", "bridge", artifact, "authoritative")
  );
});

test("every schema-aware version tag preserves the full artifact within Cloudflare's limit", () => {
  const artifact = "b".repeat(64);
  const tags = new Set();
  for (const target of ["production", "staging"]) {
    for (const phase of ["bridge", "allowlist", "all", "rollback"]) {
      for (const mode of ["compatible", "authoritative"]) {
        const tag = versionTag(target, phase, artifact, mode);
        assert.ok(tag.length <= 100, `${tag.length}: ${target}/${phase}/${mode}`);
        assert.match(tag, /^hlk-ag1-m[ca]-t[ps]-p[blar]-[a-f0-9]{64}$/);
        assert.equal(tag.slice(-64), artifact);
        tags.add(tag);
      }
    }
  }
  assert.equal(tags.size, 16);
  assert.throws(() => versionTag("other", "all", artifact, "authoritative"), /target/);
  assert.throws(() => versionTag("production", "other", artifact, "authoritative"), /phase/);
});

test("every production phase is bound to the exact predecessor script etag", () => {
  const stagingReceipt = { scriptEtag: "s".repeat(64) };
  const bridgeReceipt = { scriptEtag: "b".repeat(64) };
  assert.equal(
    expectedProductionScriptEtag("bridge", stagingReceipt, bridgeReceipt),
    stagingReceipt.scriptEtag
  );
  assert.equal(
    expectedProductionScriptEtag("allowlist", stagingReceipt, bridgeReceipt),
    bridgeReceipt.scriptEtag
  );
  assert.equal(
    expectedProductionScriptEtag("all", stagingReceipt, bridgeReceipt),
    bridgeReceipt.scriptEtag
  );
  assert.throws(
    () => expectedProductionScriptEtag("all", stagingReceipt, undefined),
    /exact predecessor server script etag/
  );

  const allowlistConfig = buildRolloutConfig(baseConfig, options("production", "allowlist"), {
    V2_PAIRING_CANARY_INSTANCE_HASHES: "c".repeat(64),
  });
  const version = remoteVersion(allowlistConfig, {
    phase: "allowlist",
    artifact: "a".repeat(64),
    etag: bridgeReceipt.scriptEtag,
  });
  assert.doesNotThrow(() => assertGuardedVersion(version, {
    id: version.id,
    target: "production",
    phase: "allowlist",
    tag: version.annotations["workers/tag"],
    config: allowlistConfig,
    scriptEtag: bridgeReceipt.scriptEtag,
  }));
  version.resources.script.etag = "f".repeat(64);
  assert.throws(() => assertGuardedVersion(version, {
    id: version.id,
    target: "production",
    phase: "allowlist",
    tag: version.annotations["workers/tag"],
    config: allowlistConfig,
    scriptEtag: bridgeReceipt.scriptEtag,
  }), /receipt script etag/);
});

test("staging proof receipt requires exact local artifact and server script etag", () => {
  const artifactSHA256 = "a".repeat(64);
  const receipt = stagingProofReceiptFrom({
    stagingProofVersionID: "123e4567-e89b-42d3-a456-426614174000",
    stagingProofArtifactSHA256: artifactSHA256,
    stagingProofScriptEtag: "e".repeat(64),
  }, {}, artifactSHA256);
  assert.equal(receipt.artifactSHA256, artifactSHA256);
  assert.equal(receipt.scriptEtag, "e".repeat(64));
  assert.deepEqual({
    authStateSchemaVersion: receipt.authStateSchemaVersion,
    activityRegistrationGenerationSchemaVersion:
      receipt.activityRegistrationGenerationSchemaVersion,
    activityGenerationSchema: receipt.activityGenerationSchema,
    activityGenerationMode: receipt.activityGenerationMode,
    activityRouteAuthority: receipt.activityRouteAuthority,
    minimumSafeRollbackAuthStateSchemaVersion:
      receipt.minimumSafeRollbackAuthStateSchemaVersion,
    preSchemaRollbackSafe: receipt.preSchemaRollbackSafe,
  }, {
    authStateSchemaVersion: 2,
    activityRegistrationGenerationSchemaVersion: 1,
    activityGenerationSchema: "auth_state_current_generation_v1",
    activityGenerationMode: "authoritative",
    activityRouteAuthority: "auth_state_current_generation_v1",
    minimumSafeRollbackAuthStateSchemaVersion: 2,
    preSchemaRollbackSafe: false,
  });
  assert.throws(() => stagingProofReceiptFrom({
    stagingProofVersionID: receipt.id,
    stagingProofArtifactSHA256: "b".repeat(64),
    stagingProofScriptEtag: receipt.scriptEtag,
  }, {}, artifactSHA256), /does not match the locally verified/);
  assert.throws(() => stagingProofReceiptFrom({
    stagingProofVersionID: receipt.id,
    stagingProofArtifactSHA256: artifactSHA256,
    stagingProofScriptEtag: "not-an-etag",
  }, {}, artifactSHA256), /STAGING_PROOF_SCRIPT_ETAG/);
});

test("staging creation permits only true absence; an existing name needs an exact managed receipt", () => {
  assert.deepEqual(
    assertStagingSourceSnapshot({ workerMissing: true }),
    { phase: "absent" }
  );

  const config = buildRolloutConfig(baseConfig, options("staging", "all"), {
    STAGING_KV_NAMESPACE_ID: "a".repeat(32),
    STAGING_RATE_LIMIT_NAMESPACE_ID: "694211",
  });
  const artifactSHA256 = "b".repeat(64);
  const receipt = stagingProofReceiptFrom({
    stagingProofVersionID: "123e4567-e89b-42d3-a456-426614174000",
    stagingProofArtifactSHA256: artifactSHA256,
    stagingProofScriptEtag: "e".repeat(64),
  }, {});
  const version = remoteVersion(config, {
    id: receipt.id,
    target: "staging",
    phase: "all",
    artifact: artifactSHA256,
    etag: receipt.scriptEtag,
  });
  const status = { versions: [{ version_id: receipt.id, percentage: 100 }] };
  const health = authoritativeHealthy({
    apns_environment: "sandbox",
    apns_mock: true,
    v2_pairing_mode: "all",
    v2_pairing_enabled: true,
    worker_version_id: receipt.id,
    worker_version_tag: receipt.tag,
  });
  const stagingSource = assertStagingSourceSnapshot({
    workerMissing: false,
    status,
    version,
    receipt,
    config,
    health,
  });
  assert.deepEqual({
    phase: stagingSource.phase,
    versionID: stagingSource.versionID,
    versionTag: stagingSource.versionTag,
  }, {
    phase: "staging",
    versionID: receipt.id,
    versionTag: receipt.tag,
  });
  assert.deepEqual(stagingSource.rollbackReceipt, {
    ...receipt,
    version,
    versionConfig: config,
  });

  const unrelated = structuredClone(version);
  unrelated.resources.script.etag = "f".repeat(64);
  assert.throws(() => assertStagingSourceSnapshot({
    workerMissing: false,
    status,
    version: unrelated,
    receipt,
    config,
    health,
  }), /receipt script etag/);
  assert.throws(() => assertStagingSourceSnapshot({
    workerMissing: false,
    status,
  }), /complete previously guarded receipt/);
});

test("exact pre-schema staging health JSON survives validation into its one-way bootstrap snapshot", () => {
  const config = buildRolloutConfig(baseConfig, options("staging", "all"), {
    STAGING_KV_NAMESPACE_ID: "a".repeat(32),
    STAGING_RATE_LIMIT_NAMESPACE_ID: "694211",
  });
  delete config.env.staging.vars.ACTIVITY_GENERATION_MODE;
  const artifactSHA256 = "c".repeat(64);
  const receipt = preSchemaStagingReceiptFrom({
    stagingProofVersionID: "123e4567-e89b-42d3-a456-426614174000",
    stagingProofArtifactSHA256: artifactSHA256,
    stagingProofScriptEtag: "e".repeat(64),
  }, {});
  const version = remoteVersion(config, {
    id: receipt.id,
    target: "staging",
    phase: "all",
    artifact: artifactSHA256,
    etag: receipt.scriptEtag,
  });
  const status = { versions: [{ version_id: receipt.id, percentage: 100 }] };
  const health = {
    ...authoritativeHealthy({
      apns_environment: "sandbox",
      apns_mock: true,
      v2_pairing_mode: "all",
      v2_pairing_enabled: true,
      worker_version_id: receipt.id,
      worker_version_tag: receipt.tag,
    }),
    activity_generation_schema: null,
    activity_generation_mode: null,
    activity_route_authority: null,
  };

  assert.equal(isRecordedPreSchemaStagingVersion(version, {
    ...receipt,
    config,
  }), true);
  const preservedHealth = validateStagingSourceHealth(health, {
    preSchema: true,
    receipt,
  });
  assert.strictEqual(preservedHealth, health);
  const source = assertStagingSourceSnapshot({
    workerMissing: false,
    status,
    version,
    receipt,
    config,
    health: preservedHealth,
  });
  assert.equal(source.phase, "pre-schema-staging");
  assert.equal(source.rollbackReceipt.activityGenerationMode, "pre-schema");
  assert.equal(uploadOperationForSource(source), "version-upload");

  const temporary = { secretsPath: "/tmp/must-not-upload-secrets.json" };
  suppressSecretUploadForExistingSource(temporary, options("staging", "all"), source);
  assert.equal(temporary.secretsPath, undefined);
});

test("pre-schema staging exception does not weaken the production transition floor", () => {
  assert.equal(assertStagingActivityGenerationTransition("pre-schema", "authoritative"), true);
  assert.equal(assertStagingActivityGenerationTransition("authoritative", "authoritative"), true);
  assert.throws(
    () => assertStagingActivityGenerationTransition("pre-schema", "compatible"),
    /Unsafe staging activity-generation transition/
  );
  assert.throws(
    () => assertActivityGenerationTransition("pre-schema", "authoritative"),
    /requires a schema-aware compatible predecessor/
  );
});

test("rollback dry-run exits before any Cloudflare control-plane lookup or mutation", () => {
  const result = runDeployCLI([
    "--target=production",
    "--phase=rollback",
    "--dry-run",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no Cloudflare control-plane command or health request was made/);
});

test("Wrangler subprocesses disable metrics and banner update checks", () => {
  const environment = wranglerChildEnvironment({
    WRANGLER_SEND_METRICS: "true",
    WRANGLER_HIDE_BANNER: "false",
    WRANGLER_SEND_ERROR_REPORTS: "true",
    WRANGLER_LOG: "debug",
    WRANGLER_LOG_SANITIZE: "false",
    WRANGLER_LOG_PATH: "/tmp/leak.log",
    WRANGLER_WRITE_LOGS: "true",
    WRANGLER_OUTPUT_FILE_PATH: "/tmp/leak.json",
    WRANGLER_OUTPUT_FILE_DIRECTORY: "/tmp/leaks",
    WRANGLER_CI_OVERRIDE_NAME: "attacker-worker",
    WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST: "attacker.invalid",
    WRANGLER_API_ENVIRONMENT: "staging",
    CLOUDFLARE_API_BASE_URL: "https://attacker.invalid/client/v4",
    CF_API_BASE_URL: "https://attacker.invalid/deprecated",
    CLOUDFLARE_ACCOUNT_ID: "f".repeat(32),
    CF_ACCOUNT_ID: "e".repeat(32),
    CLOUDFLARE_ENV: "attacker",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    CLOUDFLARE_API_TOKEN: "preserved-auth-token",
    APPLE_PRIVATE_KEY: "must-not-reach-child",
    HA_LIVEKIT_APP_SECRET: "must-not-reach-child",
    DEVICE_CREDENTIAL_PEPPER: "must-not-reach-child",
    V2_PAIRING_CANARY_INSTANCE_HASHES: "must-not-reach-child",
    BRIDGE_SCRIPT_ETAG: "must-not-reach-child",
    EXPECTED_CLOUDFLARE_ACCOUNT_ID: "must-not-reach-child",
    SAFE_SENTINEL: "preserved",
  });
  assert.equal(environment.WRANGLER_SEND_METRICS, "false");
  assert.equal(environment.WRANGLER_HIDE_BANNER, "true");
  assert.equal(environment.WRANGLER_SEND_ERROR_REPORTS, "false");
  assert.equal(environment.WRANGLER_LOG, "error");
  assert.equal(environment.WRANGLER_LOG_SANITIZE, "true");
  assert.equal(environment.WRANGLER_API_ENVIRONMENT, "production");
  assert.equal(environment.CLOUDFLARE_API_BASE_URL, "https://api.cloudflare.com/client/v4");
  assert.equal(environment.CLOUDFLARE_COMPLIANCE_REGION, "public");
  assert.equal(environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, "false");
  assert.equal(environment.CLOUDFLARE_INCLUDE_PROCESS_ENV, "false");
  assert.equal(environment.CLOUDFLARE_ACCOUNT_ID, undefined);
  assert.equal(environment.CF_ACCOUNT_ID, undefined);
  assert.equal(environment.CF_API_BASE_URL, undefined);
  assert.equal(environment.WRANGLER_CI_OVERRIDE_NAME, undefined);
  assert.equal(environment.WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST, undefined);
  assert.equal(environment.CLOUDFLARE_ENV, undefined);
  assert.equal(environment.WRANGLER_LOG_PATH, undefined);

  const capturedEnvironment = wranglerChildEnvironment(
    { WRANGLER_LOG: "debug", WRANGLER_LOG_SANITIZE: "false" },
    { captureOutput: true }
  );
  assert.equal(capturedEnvironment.WRANGLER_LOG, "log");
  assert.equal(capturedEnvironment.WRANGLER_LOG_SANITIZE, "true");
  assert.equal(environment.WRANGLER_WRITE_LOGS, undefined);
  assert.equal(environment.WRANGLER_OUTPUT_FILE_PATH, undefined);
  assert.equal(environment.WRANGLER_OUTPUT_FILE_DIRECTORY, undefined);
  assert.equal(environment.CLOUDFLARE_API_TOKEN, "preserved-auth-token");
  assert.equal(environment.APPLE_PRIVATE_KEY, undefined);
  assert.equal(environment.HA_LIVEKIT_APP_SECRET, undefined);
  assert.equal(environment.DEVICE_CREDENTIAL_PEPPER, undefined);
  assert.equal(environment.V2_PAIRING_CANARY_INSTANCE_HASHES, undefined);
  assert.equal(environment.BRIDGE_SCRIPT_ETAG, undefined);
  assert.equal(environment.EXPECTED_CLOUDFLARE_ACCOUNT_ID, undefined);
  assert.equal(environment.SAFE_SENTINEL, "preserved");
});

test("captured Wrangler commands preserve machine-readable stdout", () => {
  const executable = resolve(
    new URL("..", import.meta.url).pathname,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler"
  );
  const output = runBoundedSubprocess(executable, ["--version"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: wranglerChildEnvironment(
      { PATH: process.env.PATH },
      { captureOutput: true }
    ),
    timeoutMs: 10_000,
    label: "Captured Wrangler regression",
  });
  assert.match(output, /4\.110\.0/);
});

test("a hung remote command is killed within a fixed bound so recovery can run", () => {
  const startedAt = Date.now();
  assert.throws(() => runBoundedSubprocess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: process.env,
      timeoutMs: 50,
      label: "Hung test child",
    }
  ), /Hung test child timed out after 50 ms/);
  assert.ok(Date.now() - startedAt < 2_000);
});

test("alternate and unknown rollback/deploy arguments fail before remote work", () => {
  const cases = [
    {
      args: ["--phase=rollback", "--dry-run=true", "--confirm-rollback"],
      error: /--dry-run is a boolean flag/,
    },
    {
      args: ["--phase=rollback", "--dry-run", "--confirm-rollback", "--unknown"],
      error: /Unknown or malformed rollout option/,
    },
    {
      args: [
        "--target=production",
        "--phase=bridge",
        "--dry-run=false",
        "--confirm-deploy",
        "--confirm-initial-pepper",
        "--confirm-staging-tests",
      ],
      error: /--dry-run is a boolean flag/,
    },
    {
      args: [
        "--target=production",
        "--phase=bridge",
        "--confirm-deploy",
        "--confirm-initial-pepper",
        "--confirm-staging-tests",
        "--definitely-unknown",
      ],
      error: /Unknown or malformed rollout option/,
    },
    {
      args: [
        "--target=staging",
        "--phase=bridge",
        "--confirm-deploy",
      ],
      error: /Staging rollout supports only --phase=all/,
    },
  ];
  for (const scenario of cases) {
    const result = runDeployCLI(scenario.args);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, scenario.error);
    assert.doesNotMatch(result.stdout, /Local Wrangler preflight|Deployment health gate|Production restored/);
  }
});
