#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const workerDir = resolve(scriptDir, "..");
const baseConfigPath = resolve(workerDir, "wrangler.jsonc");
const productionEnvPath = resolve(workerDir, ".dev.vars");
const stagingEnvPath = resolve(workerDir, ".dev.vars.staging");
const PINNED_WRANGLER_VERSION = "4.110.0";
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const SCRIPT_ETAG_PATTERN = /^[a-z0-9._:-]{16,256}$/i;
const CLOUDFLARE_PUBLIC_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const REMOTE_POLL_ATTEMPTS = 15;
const REMOTE_POLL_DELAY_MS = 2_000;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const HEALTH_RESPONSE_MAX_BYTES = 16 * 1024;
const WRANGLER_COMMAND_TIMEOUT_MS = 120_000;
const AUTH_STATE_SCHEMA_VERSION = 2;
const ACTIVITY_REGISTRATION_GENERATION_SCHEMA_VERSION = 1;
const ACTIVITY_GENERATION_SCHEMA = "auth_state_current_generation_v1";
const ACTIVITY_GENERATION_MODES = new Set(["compatible", "authoritative"]);
const ACTIVITY_ROUTE_AUTHORITIES = Object.freeze({
  compatible: "sticky_per_instance_compatibility_v1",
  authoritative: "auth_state_current_generation_v1",
});
const MINIMUM_SAFE_ROLLBACK_AUTH_STATE_SCHEMA_VERSION = 2;
const ACTIVITY_GENERATION_SCHEMA_TAG = "ag1";
const WORKER_VERSION_TAG_MAX_LENGTH = 100;
const VERSION_TAG_MODE_CODES = Object.freeze({
  compatible: "c",
  authoritative: "a",
});
const VERSION_TAG_TARGET_CODES = Object.freeze({
  production: "p",
  staging: "s",
});
const VERSION_TAG_PHASE_CODES = Object.freeze({
  bridge: "b",
  allowlist: "l",
  all: "a",
  rollback: "r",
});
const localWranglerPath = resolve(
  workerDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler"
);

const STAGING_SECRET_KEYS = [
  "APPLE_PRIVATE_KEY",
  "HA_LIVEKIT_APP_SECRET",
  "DEVICE_CREDENTIAL_PEPPER",
];
const PRODUCTION_REQUIRED_SECRET_KEYS = [
  ...STAGING_SECRET_KEYS,
  // Preserve the historical production binding exactly. Its enabled value is
  // proven by the origin-bound legacy health gate before first migration.
  "RELAY_ENABLED",
];
const LEGACY_OPTIONAL_NEW_VARS = new Set([
  "APNS_MOCK",
  // The production v1 Worker predates these explicit safety/retention vars.
  // Their bridge values equal the runtime defaults used by that Worker.
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
]);
const frozenRemoteFiles = new Map();

async function main() {
  const options = parseOptions(process.argv.slice(2));
  assertPinnedWrangler();

  if (options.phase === "rollback") {
    if (options.dryRun) {
      console.log("Rollback dry-run passed locally; no Cloudflare control-plane command or health request was made.");
      return;
    }
    await rollbackToBridge(options);
    return;
  }

  const envPath = options.target === "staging" ? stagingEnvPath : productionEnvPath;
  const env = loadEnvironment(envPath);
  const productionEnv = loadEnvironment(productionEnvPath, {
    required: false,
    includeProcessEnv: false,
  });
  const baseConfig = parseJSONC(readFileSync(baseConfigPath, "utf8"));
  const rolloutConfig = buildRolloutConfig(baseConfig, options, env);
  const expectedAccountID = expectedCloudflareAccountID(env, {
    required: options.confirmDeploy,
  });
  if (expectedAccountID) {
    pinExpectedCloudflareAccount(rolloutConfig, options.target, expectedAccountID);
  }
  rolloutConfig.main = resolve(workerDir, baseConfig.main);
  assertRolloutInputs(baseConfig, rolloutConfig, options, env, productionEnv);

  const temporary = createTemporaryRolloutFiles(rolloutConfig, options, env);
  try {
    runWrangler(buildDeployArguments(options, temporary, true), { capture: true });
    const artifactSHA256 = freezeVerifiedBundle(temporary, rolloutConfig);
    const deployedTag = versionTag(options.target, options.phase, artifactSHA256);
    const verifiedUploadPreflight = buildDeployArguments(
      options,
      temporary,
      false,
      deployedTag
    );
    verifiedUploadPreflight.push("--dry-run");
    runWrangler(verifiedUploadPreflight, { capture: true });
    freezeSecretFile(temporary);
    console.log(`Local Wrangler preflight passed: target=${options.target}, phase=${options.phase}.`);
    console.log(`Verified bundle SHA-256: ${artifactSHA256}`);

    if (options.dryRun) return;
    if (!options.confirmDeploy) {
      throw new Error(
        "Remote deployment stopped. Re-run with --confirm-deploy after reviewing the dry-run, current deployment IDs, and rollback bridge."
      );
    }
    if (options.target === "production" && options.phase === "all" && !options.confirmAll) {
      throw new Error("Production all-mode requires the additional --confirm-all acknowledgement.");
    }

    if (options.target === "production") runLocalWorkerVerification();

    const workerURL = requiredHealthURL(env);
    const accountAccess = await assertCloudflareAccountAccess(rolloutConfig, options.target);
    assertWorkerHealthOrigin(workerURL, rolloutConfig, options.target, accountAccess);
    assertFrozenRolloutFiles(temporary);
    const versionsBefore = remoteVersions(temporary.configPath, options.target, {
      allowMissingWorker: options.target === "staging",
    });
    const versionIDsBefore = new Set(versionsBefore.keys());
    const bridgeReceipt = await requireBridgeForPromotion(
      baseConfig,
      temporary.configPath,
      options,
      env,
      artifactSHA256
    );
    let stagingReceipt;
    if (options.target === "production" && options.phase === "bridge") {
      stagingReceipt = await verifyStagingCheckpoint(
        baseConfig,
        temporary,
        options,
        env,
        artifactSHA256
      );
    }
    const sourceState = await assertSafePromotionSource(
      baseConfig,
      temporary.configPath,
      workerURL,
      options,
      env,
      artifactSHA256,
      bridgeReceipt,
      versionsBefore
    );
    if (options.target === "production" && options.phase === "bridge") {
      if (sourceState.phase === "legacy" && !options.confirmInitialPepper) {
        throw new Error(
          "The first production bridge requires --confirm-initial-pepper. This acknowledgement is valid only while live health is pre-v2."
        );
      }
      if (new Set(["bridge", "pre-schema-bridge"]).has(sourceState.phase)) {
        temporary.secretsPath = undefined;
      }
    }
    suppressSecretUploadForExistingSource(temporary, options, sourceState);

    const uploadOperation = uploadOperationForSource(sourceState);
    if (sourceState?.phase !== "absent") {
      await assertRemoteWorkerSubdomainInvariant(rolloutConfig, options.target, {
        requirePreviewDisabled: sourceState.phase !== "legacy",
      });
    }
    if (uploadOperation === "version-upload") {
      const exactVersionUploadPreflight = buildDeployArguments(
        options,
        temporary,
        false,
        deployedTag,
        uploadOperation
      );
      exactVersionUploadPreflight.push("--dry-run");
      runWrangler(exactVersionUploadPreflight, { capture: true });
    }

    const expectedScriptEtag = options.target === "production"
      ? expectedProductionScriptEtag(options.phase, stagingReceipt, bridgeReceipt)
      : undefined;
    let deploymentAttempted = false;
    let initialLifecycleAttempted = false;
    try {
      assertFrozenRolloutFiles(temporary);
      const mutationAccountAccess = await assertCloudflareAccountAccess(
        rolloutConfig,
        options.target
      );
      assertWorkerHealthOrigin(
        workerURL,
        rolloutConfig,
        options.target,
        mutationAccountAccess
      );
      if (uploadOperation === "deploy") {
        reassertSourceBeforeMutation(temporary.configPath, options.target, sourceState);
        if (sourceState.phase !== "absent") {
          await assertRemoteWorkerSubdomainInvariant(rolloutConfig, options.target, {
            requirePreviewDisabled: sourceState.phase !== "legacy",
          });
        }
        deploymentAttempted = sourceState?.rollbackReceipt != null;
        initialLifecycleAttempted = !deploymentAttempted;
      }
      if (uploadOperation === "version-upload") {
        await assertRemoteWorkerSubdomainInvariant(rolloutConfig, options.target);
      }
      const uploadOutput = runWrangler(
        buildDeployArguments(
          options,
          temporary,
          false,
          deployedTag,
          uploadOperation
        ),
        { capture: true }
      );
      const deployedVersion = await waitForDeployedVersion(
        temporary.configPath,
        options.target,
        uploadOutput,
        versionIDsBefore,
        {
          target: options.target,
          phase: options.phase,
          tag: deployedTag,
          config: rolloutConfig,
          scriptEtag: expectedScriptEtag,
        }
      );
      if (uploadOperation === "version-upload") {
        await assertRemoteWorkerSubdomainInvariant(rolloutConfig, options.target);
        const activationAccountAccess = await assertCloudflareAccountAccess(
          rolloutConfig,
          options.target
        );
        assertWorkerHealthOrigin(
          workerURL,
          rolloutConfig,
          options.target,
          activationAccountAccess
        );
        reassertSourceBeforeMutation(temporary.configPath, options.target, sourceState);
        deploymentAttempted = true;
        runWrangler(buildVersionActivationArguments({
          target: options.target,
          phase: options.phase,
          configPath: temporary.configPath,
        }, deployedVersion.id), { capture: true });
      }
      await waitForExclusiveDeployment(
        temporary.configPath,
        options.target,
        deployedVersion.id
      );
      await fetchHealthWithRetry(workerURL, (health) => assertHealthyDeployment(
        health,
        options.target,
        options.phase,
        { versionID: deployedVersion.id, versionTag: deployedTag }
      ));
      await assertRemoteWorkerSubdomainInvariant(rolloutConfig, options.target);
      printDeploymentSuccess(options, deployedVersion, artifactSHA256);
    } catch (error) {
      const rollbackReceipt = rollbackReceiptForAttempt(
        options.phase,
        sourceState,
        bridgeReceipt
      );
      const guardedRollbackReceipt = options.target === "staging"
        ? sourceState?.rollbackReceipt
        : rollbackReceipt;
      if (guardedRollbackReceipt && deploymentAttempted) {
        await recoverPromotionAfterFailure({
          failure: error,
          sourceVersionID: sourceState.versionID,
          readStatus: () => remoteDeploymentStatus(temporary.configPath, options.target),
          restore: () => options.target === "production"
            ? restoreBridge(temporary.configPath, guardedRollbackReceipt, workerURL)
            : restoreGuardedVersion(
              temporary.configPath,
              "staging",
              "all",
              guardedRollbackReceipt,
              workerURL
            ),
          targetLabel: options.target,
          recoveryLabel: options.target === "production"
            ? "receipt-bound v2 bridge"
            : "receipt-bound staging checkpoint",
        });
      }
      if (uploadOperation === "deploy" && initialLifecycleAttempted && !guardedRollbackReceipt) {
        const reconciled = await reconcileInitialLifecycleAfterFailure({
          failure: error,
          sourceState,
          readSnapshot: () => readInitialLifecycleSnapshot(
            temporary.configPath,
            options.target,
            sourceState
          ),
          assertExpectedVersion: (version) => assertGuardedVersion(version, {
            id: version.id,
            target: options.target,
            phase: options.phase,
            tag: deployedTag,
            config: rolloutConfig,
            scriptEtag: expectedScriptEtag,
          }),
          assertExpectedHealth: async (version) => {
            const health = await fetchBoundedHealthJSON(`${workerURL}/health`);
            assertHealthyDeployment(health, options.target, options.phase, {
              versionID: version.id,
              versionTag: deployedTag,
            });
            await assertRemoteWorkerSubdomainInvariant(rolloutConfig, options.target);
          },
        });
        console.log(
          `Initial lifecycle deploy was reconciled after Wrangler failed: target=${options.target}, phase=${options.phase}.`
        );
        printDeploymentSuccess(options, reconciled.version, artifactSHA256);
        return;
      }
      throw error;
    }
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
}

export function parseOptions(args) {
  const booleanOptions = new Set([
    "--dry-run",
    "--confirm-deploy",
    "--confirm-initial-pepper",
    "--confirm-all",
    "--confirm-rollback",
    "--confirm-staging-tests",
  ]);
  const valueOptions = new Set([
    "--target",
    "--phase",
    "--bridge-version-id",
    "--bridge-artifact-sha256",
    "--bridge-script-etag",
    "--staging-proof-version-id",
    "--staging-proof-artifact-sha256",
    "--staging-proof-script-etag",
  ]);
  const flags = new Set();
  const values = new Map();
  for (const arg of args) {
    if (booleanOptions.has(arg)) {
      if (flags.has(arg)) throw new Error(`Duplicate rollout option: ${arg}.`);
      flags.add(arg);
      continue;
    }
    const separator = arg.indexOf("=");
    const name = separator === -1 ? arg : arg.slice(0, separator);
    if (booleanOptions.has(name)) {
      throw new Error(`${name} is a boolean flag and must not use =true or =false.`);
    }
    if (!valueOptions.has(name) || separator === -1) {
      throw new Error(`Unknown or malformed rollout option: ${arg}.`);
    }
    const value = arg.slice(separator + 1);
    if (!value) throw new Error(`Rollout option ${name} requires a non-empty value.`);
    if (values.has(name)) throw new Error(`Duplicate rollout option: ${name}.`);
    values.set(name, value);
  }

  const target = values.get("--target") || "production";
  const phase = values.get("--phase") || "bridge";
  if (!new Set(["production", "staging"]).has(target)) {
    throw new Error("--target must be production or staging.");
  }
  if (!new Set(["bridge", "allowlist", "all", "rollback"]).has(phase)) {
    throw new Error("--phase must be bridge, allowlist, all, or rollback.");
  }
  if (phase === "rollback" && target !== "production") {
    throw new Error("Rollback is available only for the production bridge.");
  }
  if (target === "staging" && phase !== "all") {
    throw new Error("Staging rollout supports only --phase=all so every deployment produces a promotion proof receipt.");
  }
  return {
    target,
    phase,
    dryRun: flags.has("--dry-run"),
    confirmDeploy: flags.has("--confirm-deploy"),
    confirmInitialPepper: flags.has("--confirm-initial-pepper"),
    confirmAll: flags.has("--confirm-all"),
    confirmRollback: flags.has("--confirm-rollback"),
    confirmStagingTests: flags.has("--confirm-staging-tests"),
    bridgeVersionID: values.get("--bridge-version-id"),
    bridgeArtifactSHA256: values.get("--bridge-artifact-sha256"),
    bridgeScriptEtag: values.get("--bridge-script-etag"),
    stagingProofVersionID: values.get("--staging-proof-version-id"),
    stagingProofArtifactSHA256: values.get("--staging-proof-artifact-sha256"),
    stagingProofScriptEtag: values.get("--staging-proof-script-etag"),
  };
}

function loadEnvironment(path, { required = true, includeProcessEnv = true } = {}) {
  const fileExists = existsSync(path);
  const env = fileExists ? parseDotEnv(readFileSync(path, "utf8")) : {};
  if (includeProcessEnv) {
    for (const key of [
      "WORKER_HEALTH_URL",
      "STAGING_KV_NAMESPACE_ID",
      "STAGING_RATE_LIMIT_NAMESPACE_ID",
      "V2_PAIRING_CANARY_INSTANCE_HASHES",
      "BRIDGE_VERSION_ID",
      "BRIDGE_ARTIFACT_SHA256",
      "BRIDGE_SCRIPT_ETAG",
      "STAGING_PROOF_VERSION_ID",
      "STAGING_PROOF_ARTIFACT_SHA256",
      "STAGING_PROOF_SCRIPT_ETAG",
      "EXPECTED_CLOUDFLARE_ACCOUNT_ID",
      "ACTIVITY_GENERATION_MODE",
      ...STAGING_SECRET_KEYS,
    ]) {
      if (process.env[key]?.trim()) env[key] = process.env[key];
    }
  }
  if (required && !fileExists && Object.keys(env).length === 0) {
    throw new Error(`Missing rollout environment file or explicit environment values: ${path}`);
  }
  return env;
}

export function parseDotEnv(text) {
  const env = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const match = rawLine.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2] || "";
    if (value.startsWith('"') && !value.endsWith('"')) {
      while (index + 1 < lines.length) {
        index += 1;
        value += `\n${lines[index]}`;
        if (lines[index].endsWith('"')) break;
      }
    }
    env[match[1]] = unquote(value);
  }
  return env;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1);
    return trimmed.startsWith('"')
      ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"')
      : inner;
  }
  return trimmed;
}

export function normalizeCanaryHashes(value, required, exactlyOne = false) {
  const rawValues = String(value || "")
    .trim()
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (rawValues.some((item) => !HASH_PATTERN.test(item))) {
    throw new Error("V2_PAIRING_CANARY_INSTANCE_HASHES contains a non-SHA-256 value.");
  }
  const hashes = [...new Set(rawValues)];
  if (required && hashes.length === 0) {
    throw new Error("Allowlist mode requires at least one canonical instance SHA-256 hash.");
  }
  if (exactlyOne && hashes.length !== 1) {
    throw new Error("Production allowlist mode requires exactly one canary canonical instance SHA-256 hash.");
  }
  return hashes.join(",");
}

export function buildRolloutConfig(baseConfig, options, env) {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.send_metrics = false;
  config.workers_dev = true;
  config.preview_urls = false;
  const mode = options.phase === "bridge" ? "off" : options.phase;
  const activityGenerationMode = activityGenerationModeForRollout(options);
  const hashes = mode === "allowlist"
    ? normalizeCanaryHashes(
      env.V2_PAIRING_CANARY_INSTANCE_HASHES,
      true,
      options.target === "production"
    )
    : "";

  if (options.target === "production") {
    const productionDO = config.durable_objects?.bindings?.find(
      (item) => item.name === "AUTH_STATE"
    );
    if (
      !productionDO
      || productionDO.script_name != null
      || productionDO.environment != null
    ) {
      throw new Error(
        "Production AUTH_STATE must be self-bound with no external script or environment."
      );
    }
    config.vars = config.vars || {};
    config.secrets = { required: [...PRODUCTION_REQUIRED_SECRET_KEYS] };
    // The live v1 Worker stores this as a secret. Keeping the binding avoids a
    // strict-mode type conflict and, critically, avoids rotating its value.
    delete config.vars.RELAY_ENABLED;
    config.vars.APNS_MOCK = "false";
    config.vars.ACTIVITY_GENERATION_MODE = activityGenerationMode;
    config.vars.V2_PAIRING_MODE = mode;
    config.vars.V2_PAIRING_CANARY_INSTANCE_HASHES = mode === "allowlist" ? hashes : "";
    return config;
  }

  const staging = config.env?.staging;
  if (!staging) throw new Error("wrangler.jsonc is missing env.staging.");
  staging.workers_dev = true;
  staging.preview_urls = false;
  staging.kv_namespaces[0].id = String(env.STAGING_KV_NAMESPACE_ID || "").trim();
  staging.ratelimits[0].namespace_id = String(env.STAGING_RATE_LIMIT_NAMESPACE_ID || "").trim();
  staging.secrets = { required: [...STAGING_SECRET_KEYS] };
  staging.vars.ACTIVITY_GENERATION_MODE = activityGenerationMode;
  staging.vars.V2_PAIRING_MODE = mode;
  staging.vars.V2_PAIRING_CANARY_INSTANCE_HASHES = mode === "allowlist" ? hashes : "";
  return config;
}

export function activityGenerationModeForRollout(options) {
  if (options?.target === "staging") {
    if (options.phase !== "all") {
      throw new Error("Staging activity-generation rollout must use phase all.");
    }
    return "authoritative";
  }
  if (options?.target !== "production") {
    throw new Error("Activity-generation rollout target must be production or staging.");
  }
  if (options.phase === "bridge" || options.phase === "rollback") return "compatible";
  if (options.phase === "allowlist" || options.phase === "all") return "authoritative";
  throw new Error("Activity-generation rollout phase is invalid.");
}

export function expectedCloudflareAccountID(env, { required = true } = {}) {
  const accountID = String(env.EXPECTED_CLOUDFLARE_ACCOUNT_ID || "")
    .trim()
    .toLowerCase();
  if (!accountID && !required) return undefined;
  if (!ACCOUNT_ID_PATTERN.test(accountID)) {
    throw new Error(
      "Remote rollout requires EXPECTED_CLOUDFLARE_ACCOUNT_ID as an explicit 32-hex account ID."
    );
  }
  return accountID;
}

export function pinExpectedCloudflareAccount(config, target, accountID) {
  if (!ACCOUNT_ID_PATTERN.test(String(accountID || ""))) {
    throw new Error("Cannot pin rollout configuration without a valid expected Cloudflare account ID.");
  }
  const pinned = accountID.toLowerCase();
  if (config.account_id != null && String(config.account_id).toLowerCase() !== pinned) {
    throw new Error("Tracked Worker account_id conflicts with EXPECTED_CLOUDFLARE_ACCOUNT_ID.");
  }
  config.account_id = pinned;
  if (target === "staging") {
    const staging = config.env?.staging;
    if (!staging) throw new Error("Cannot pin a missing staging Worker environment.");
    if (staging.account_id != null && String(staging.account_id).toLowerCase() !== pinned) {
      throw new Error("Tracked staging account_id conflicts with EXPECTED_CLOUDFLARE_ACCOUNT_ID.");
    }
    staging.account_id = pinned;
  }
  return config;
}

export function assertRolloutInputs(baseConfig, rolloutConfig, options, env, productionEnv) {
  const targetConfig = options.target === "staging"
    ? rolloutConfig?.env?.staging
    : rolloutConfig;
  if (targetConfig?.workers_dev !== true || targetConfig?.preview_urls !== false) {
    throw new Error("Rollout requires explicit workers_dev=true and preview_urls=false.");
  }
  const expectedActivityGenerationMode = activityGenerationModeForRollout(options);
  if (targetConfig?.vars?.ACTIVITY_GENERATION_MODE !== expectedActivityGenerationMode) {
    throw new Error(
      `Rollout requires ACTIVITY_GENERATION_MODE=${expectedActivityGenerationMode} for ${options.target}/${options.phase}.`
    );
  }
  const requestedActivityGenerationMode = String(env.ACTIVITY_GENERATION_MODE || "").trim();
  if (
    requestedActivityGenerationMode
    && requestedActivityGenerationMode !== expectedActivityGenerationMode
  ) {
    throw new Error(
      `ACTIVITY_GENERATION_MODE=${requestedActivityGenerationMode} cannot target ${options.target}/${options.phase}; expected ${expectedActivityGenerationMode}.`
    );
  }
  if (options.target === "production") {
    if (options.phase === "bridge") {
      assertStrongSecret(env.DEVICE_CREDENTIAL_PEPPER, "DEVICE_CREDENTIAL_PEPPER");
    }
    return;
  }

  assertStagingIsolation(baseConfig, rolloutConfig);
  for (const key of STAGING_SECRET_KEYS) assertStrongSecret(env[key], key);
  for (const key of STAGING_SECRET_KEYS) {
    if (!productionEnv[key]) {
      throw new Error(`Production ${key} must be available locally to prove staging separation.`);
    }
    if (env[key] === productionEnv[key]) {
      throw new Error(`Staging ${key} must differ from production.`);
    }
  }
  if (!String(env.APPLE_PRIVATE_KEY || "").startsWith("synthetic-staging:")) {
    throw new Error(
      "Staging APPLE_PRIVATE_KEY must use synthetic-staging: mock-only material, never a real Apple key."
    );
  }
}

function assertStrongSecret(value, name) {
  if (String(value || "").trim().length < 32) {
    throw new Error(`${name} must contain at least 32 characters.`);
  }
}

export function assertStagingIsolation(baseConfig, rolloutConfig) {
  const productionKV = baseConfig.kv_namespaces?.find((item) => item.binding === "TOKENS")?.id;
  const productionRate = String(
    baseConfig.ratelimits?.find((item) => item.name === "RATE_LIMITER")?.namespace_id || ""
  );
  const staging = rolloutConfig.env?.staging;
  const stagingKV = staging?.kv_namespaces?.find((item) => item.binding === "TOKENS")?.id || "";
  const stagingRate = String(
    staging?.ratelimits?.find((item) => item.name === "RATE_LIMITER")?.namespace_id || ""
  );
  const stagingDO = staging?.durable_objects?.bindings?.find((item) => item.name === "AUTH_STATE");
  const failures = [];
  if (!/^[a-f0-9]{32}$/i.test(stagingKV)) failures.push("a real isolated staging KV namespace ID");
  if (stagingKV === productionKV) failures.push("a staging KV namespace distinct from production");
  if (!/^\d+$/.test(stagingRate) || stagingRate === "0") {
    failures.push("a real staging rate-limit namespace ID");
  }
  if (stagingRate === productionRate) failures.push("a staging rate-limit namespace distinct from production");
  if (
    !stagingDO
    || stagingDO.script_name != null
    || stagingDO.environment != null
  ) {
    failures.push("a self-bound staging AUTH_STATE Durable Object with no external script or environment");
  }
  if (!staging?.name || staging.name === baseConfig.name) failures.push("a distinct staging Worker name");
  if (rolloutConfig?.workers_dev !== true || staging?.workers_dev !== true) {
    failures.push("explicit workers_dev=true");
  }
  if (rolloutConfig?.preview_urls !== false || staging?.preview_urls !== false) {
    failures.push("explicit preview_urls=false");
  }
  if (staging?.vars?.APNS_MOCK !== "true") failures.push("APNS_MOCK=true");
  if (staging?.vars?.APNS_ENVIRONMENT !== "sandbox") failures.push("APNS_ENVIRONMENT=sandbox");
  if (staging?.vars?.RATE_LIMIT_MODE !== "binding-required") failures.push("binding-required rate limiting");
  if (failures.length > 0) {
    throw new Error(`Unsafe staging configuration; required: ${failures.join(", ")}.`);
  }
}

function createTemporaryRolloutFiles(config, options, env) {
  const directory = mkdtempSync(resolve(tmpdir(), "ha-livekit-rollout-"));
  const configPath = resolve(directory, "wrangler.json");
  const bundleDirectory = resolve(directory, "bundle");
  mkdirSync(bundleDirectory, { mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  let secretsPath;
  let secretKeys = [];
  if (options.target === "staging") secretKeys = STAGING_SECRET_KEYS;
  if (options.target === "production" && options.phase === "bridge") {
    secretKeys = ["DEVICE_CREDENTIAL_PEPPER"];
  }
  if (secretKeys.length > 0) {
    secretsPath = resolve(directory, "secrets.json");
    writeFileSync(
      secretsPath,
      `${JSON.stringify(Object.fromEntries(secretKeys.map((key) => [key, env[key]])))}\n`,
      { mode: 0o600 }
    );
  }
  return { directory, configPath, secretsPath, bundleDirectory };
}

export function buildDeployArguments(
  options,
  temporary,
  dryRun,
  tag,
  operation = "deploy"
) {
  if (!new Set(["deploy", "version-upload"]).has(operation)) {
    throw new Error("Unknown Worker upload operation.");
  }
  const args = operation === "version-upload" ? ["versions", "upload"] : ["deploy"];
  if (!dryRun) {
    if (!temporary.verifiedMainPath) {
      throw new Error("Remote deployment requires the immutable verified preflight bundle.");
    }
    args.push(temporary.verifiedMainPath, "--no-bundle");
  }
  args.push(
    "--config", temporary.configPath,
    "--strict",
    "--message", `HA LiveKit relay v2 ${options.target} ${options.phase}`,
  );
  args.push("--env", options.target === "staging" ? "staging" : "");
  if (tag) args.push("--tag", tag);
  if (temporary.secretsPath) args.push("--secrets-file", temporary.secretsPath);
  if (dryRun) args.push("--dry-run", "--outdir", temporary.bundleDirectory);
  return args;
}

export function uploadOperationForSource(sourceState) {
  return new Set(["legacy", "absent"]).has(sourceState?.phase)
    ? "deploy"
    : "version-upload";
}

export function suppressSecretUploadForExistingSource(temporary, options, sourceState) {
  if (
    options.target === "staging"
    && new Set(["staging", "pre-schema-staging"]).has(sourceState?.phase)
  ) {
    temporary.secretsPath = undefined;
  }
  return temporary;
}

export function buildVersionActivationArguments(options, versionID) {
  if (!UUID_PATTERN.test(String(versionID || ""))) {
    throw new Error("A valid exact Worker version ID is required for traffic activation.");
  }
  return [
    "versions", "deploy", `${versionID}@100%`,
    "--config", options.configPath,
    "--env", options.target === "staging" ? "staging" : "",
    "--yes",
    "--message", `HA LiveKit relay v2 activate ${options.target} ${options.phase}`,
  ];
}

function reassertSourceBeforeMutation(configPath, target, sourceState) {
  if (sourceState?.phase === "absent") {
    const versions = remoteVersions(configPath, target, { allowMissingWorker: true });
    assertSourceSnapshotUnchanged(sourceState, {
      workerMissing: versions.workerMissing === true,
    });
    return;
  }
  assertSourceSnapshotUnchanged(sourceState, {
    status: remoteDeploymentStatus(configPath, target),
  });
}

export function assertSourceSnapshotUnchanged(sourceState, { status, workerMissing } = {}) {
  if (sourceState?.phase === "absent") {
    if (workerMissing !== true) {
      throw new Error("Staging Worker appeared after validation; refusing to overwrite it.");
    }
    return;
  }
  if (!UUID_PATTERN.test(String(sourceState?.versionID || ""))) {
    throw new Error("The validated source version is unavailable for the pre-mutation gate.");
  }
  try {
    assertExclusiveDeployment(status, sourceState.versionID);
  } catch (error) {
    throw new Error(`Worker source changed after validation; activation stopped: ${error.message}`);
  }
}

export function freezeVerifiedBundle(temporary, rolloutConfig) {
  const mainCandidates = listFiles(temporary.bundleDirectory)
    .filter((path) => /\.(?:c|m)?js$/i.test(path));
  if (mainCandidates.length !== 1) {
    throw new Error("Wrangler preflight must produce exactly one bundled JavaScript entrypoint.");
  }
  const verifiedMainPath = mainCandidates[0];
  const artifactSHA256 = hashBundleDirectory(temporary.bundleDirectory);
  const frozenConfig = JSON.parse(JSON.stringify(rolloutConfig));
  frozenConfig.main = verifiedMainPath;
  writeFileSync(temporary.configPath, `${JSON.stringify(frozenConfig, null, 2)}\n`, { mode: 0o600 });
  for (const path of listFiles(temporary.bundleDirectory)) chmodSync(path, 0o400);
  chmodSync(temporary.configPath, 0o400);
  temporary.verifiedMainPath = verifiedMainPath;
  temporary.verifiedMainSnapshot = freezeRemoteFile(verifiedMainPath, "verified Worker bundle");
  temporary.configSnapshot = freezeRemoteFile(temporary.configPath, "generated Wrangler config");
  return artifactSHA256;
}

export function freezeSecretFile(temporary) {
  if (!temporary.secretsPath) return undefined;
  chmodSync(temporary.secretsPath, 0o400);
  const snapshot = freezeRemoteFile(temporary.secretsPath, "rollout secrets file");
  const secretSHA256 = snapshot.sha256;
  temporary.secretSnapshot = snapshot;
  temporary.secretSHA256 = secretSHA256;
  return secretSHA256;
}

export function assertFrozenSecretFile(temporary) {
  if (!temporary.secretsPath) return;
  if (!HASH_PATTERN.test(String(temporary.secretSHA256 || ""))) {
    throw new Error("Remote deployment requires a frozen, verified secrets file.");
  }
  const currentSHA256 = createHash("sha256")
    .update(readFileSync(temporary.secretsPath))
    .digest("hex");
  if (currentSHA256 !== temporary.secretSHA256) {
    throw new Error("The rollout secrets file changed after preflight; remote deployment stopped.");
  }
  assertFrozenRemoteFile(temporary.secretSnapshot);
}

export function freezeRemoteFile(path, label = "rollout file") {
  const resolvedPath = resolve(path);
  const stat = lstatSync(resolvedPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`The ${label} must be a regular non-symlink file.`);
  }
  const snapshot = {
    path: resolvedPath,
    label,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    sha256: createHash("sha256").update(readFileSync(resolvedPath)).digest("hex"),
  };
  frozenRemoteFiles.set(resolvedPath, snapshot);
  return snapshot;
}

export function assertFrozenRemoteFile(snapshot) {
  if (!snapshot?.path || !HASH_PATTERN.test(String(snapshot.sha256 || ""))) {
    throw new Error("Remote rollout requires a complete frozen-file snapshot.");
  }
  let stat;
  try {
    stat = lstatSync(snapshot.path);
  } catch {
    throw new Error(`The frozen ${snapshot.label} disappeared after preflight; remote deployment stopped.`);
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.dev !== snapshot.dev
    || stat.ino !== snapshot.ino
    || stat.size !== snapshot.size
  ) {
    throw new Error(`The frozen ${snapshot.label} was replaced after preflight; remote deployment stopped.`);
  }
  const currentSHA256 = createHash("sha256")
    .update(readFileSync(snapshot.path))
    .digest("hex");
  if (currentSHA256 !== snapshot.sha256) {
    throw new Error(`The frozen ${snapshot.label} changed after preflight; remote deployment stopped.`);
  }
}

export function assertFrozenRolloutFiles(temporary) {
  assertFrozenRemoteFile(temporary.verifiedMainSnapshot);
  assertFrozenRemoteFile(temporary.configSnapshot);
  assertFrozenSecretFile(temporary);
}

function freezeGeneratedRemoteConfig(path, label) {
  chmodSync(path, 0o400);
  return freezeRemoteFile(path, label);
}

function assertRegisteredWranglerFiles(args) {
  for (const arg of args) {
    if (typeof arg !== "string" || !arg.startsWith("/")) continue;
    const snapshot = frozenRemoteFiles.get(resolve(arg));
    if (snapshot) assertFrozenRemoteFile(snapshot);
  }
}

export function versionTag(
  target,
  phase,
  artifactSHA256,
  activityGenerationMode = activityGenerationModeForRollout({ target, phase })
) {
  if (!HASH_PATTERN.test(String(artifactSHA256 || ""))) {
    throw new Error("A valid rollout artifact SHA-256 is required for the Worker version tag.");
  }
  if (!ACTIVITY_GENERATION_MODES.has(activityGenerationMode)) {
    throw new Error("A valid activity-generation mode is required for the Worker version tag.");
  }
  const targetCode = VERSION_TAG_TARGET_CODES[target];
  if (!targetCode) {
    throw new Error("A valid rollout target is required for the Worker version tag.");
  }
  const phaseCode = VERSION_TAG_PHASE_CODES[phase];
  if (!phaseCode) {
    throw new Error("A valid rollout phase is required for the Worker version tag.");
  }
  const modeCode = VERSION_TAG_MODE_CODES[activityGenerationMode];
  const tag = `hlk-${ACTIVITY_GENERATION_SCHEMA_TAG}-m${modeCode}-t${targetCode}-p${phaseCode}-${artifactSHA256.toLowerCase()}`;
  if (tag.length > WORKER_VERSION_TAG_MAX_LENGTH) {
    throw new Error("The Worker version tag exceeds Cloudflare's 100-character limit.");
  }
  return tag;
}

function preSchemaVersionTag(target, phase, artifactSHA256) {
  if (!HASH_PATTERN.test(String(artifactSHA256 || ""))) {
    throw new Error("A valid pre-schema artifact SHA-256 is required for the Worker version tag.");
  }
  if (!VERSION_TAG_TARGET_CODES[target]) {
    throw new Error("A valid pre-schema target is required for the Worker version tag.");
  }
  if (!VERSION_TAG_PHASE_CODES[phase]) {
    throw new Error("A valid pre-schema phase is required for the Worker version tag.");
  }
  const targetLabel = target === "production" ? "prod" : "stg";
  const tag = `hlk-v2-${targetLabel}-${phase}-${artifactSHA256.toLowerCase()}`;
  if (tag.length > WORKER_VERSION_TAG_MAX_LENGTH) {
    throw new Error("The pre-schema Worker version tag exceeds Cloudflare's 100-character limit.");
  }
  return tag;
}

function activityGenerationReceipt(activityGenerationMode) {
  if (!ACTIVITY_GENERATION_MODES.has(activityGenerationMode)) {
    throw new Error("A schema-aware receipt requires compatible or authoritative mode.");
  }
  return {
    authStateSchemaVersion: AUTH_STATE_SCHEMA_VERSION,
    activityRegistrationGenerationSchemaVersion:
      ACTIVITY_REGISTRATION_GENERATION_SCHEMA_VERSION,
    activityGenerationSchema: ACTIVITY_GENERATION_SCHEMA,
    activityGenerationMode,
    activityRouteAuthority: ACTIVITY_ROUTE_AUTHORITIES[activityGenerationMode],
    minimumSafeRollbackAuthStateSchemaVersion:
      MINIMUM_SAFE_ROLLBACK_AUTH_STATE_SCHEMA_VERSION,
    preSchemaRollbackSafe: false,
  };
}

export function assertSchemaAwareReceipt(
  receipt,
  expectedMode,
  label = "deployment"
) {
  const expected = activityGenerationReceipt(expectedMode);
  const failures = Object.entries(expected)
    .filter(([field, value]) => receipt?.[field] !== value)
    .map(([field]) => field);
  if (failures.length > 0) {
    throw new Error(
      `The ${label} receipt is not bound to the ${expectedMode} activity-generation schema: ${failures.join(", ")}.`
    );
  }
  return receipt;
}

export function assertSchemaAwareRollbackReceipt(receipt, label = "rollback") {
  try {
    return assertSchemaAwareReceipt(receipt, "compatible", label);
  } catch (error) {
    throw new Error(
      `The ${label} receipt is not a schema-aware compatible rollback floor: ${error.message}`
    );
  }
}

export function assertActivityGenerationTransition(sourceMode, targetMode) {
  const normalizedSource = sourceMode === "pre-schema" ? "legacy" : sourceMode;
  const allowed = (
    (normalizedSource === "legacy" && targetMode === "compatible")
    || (normalizedSource === "compatible"
      && (targetMode === "compatible" || targetMode === "authoritative"))
    || (normalizedSource === "authoritative" && targetMode === "authoritative")
  );
  if (!allowed) {
    throw new Error(
      `Unsafe activity-generation transition ${sourceMode || "unknown"}->${targetMode || "unknown"}; authoritative rollout requires a schema-aware compatible predecessor.`
    );
  }
  return true;
}

export function assertStagingActivityGenerationTransition(sourceMode, targetMode) {
  const allowed = (
    sourceMode === "pre-schema" && targetMode === "authoritative"
  ) || (
    sourceMode === "authoritative" && targetMode === "authoritative"
  );
  if (!allowed) {
    throw new Error(
      `Unsafe staging activity-generation transition ${sourceMode || "unknown"}->${targetMode || "unknown"}; staging permits only its exact pre-schema bootstrap or an authoritative re-deploy.`
    );
  }
  return true;
}

export function expectedProductionScriptEtag(phase, stagingReceipt, bridgeReceipt) {
  const scriptEtag = phase === "bridge"
    ? stagingReceipt?.scriptEtag
    : bridgeReceipt?.scriptEtag;
  if (!SCRIPT_ETAG_PATTERN.test(String(scriptEtag || ""))) {
    throw new Error(
      `Production ${phase} requires the exact predecessor server script etag.`
    );
  }
  return scriptEtag;
}

function hashBundleDirectory(directory) {
  const files = listFiles(directory).filter((path) => /\.(?:c|m)?js$/i.test(path));
  if (files.length === 0) {
    throw new Error("Wrangler dry-run did not produce a bundle to fingerprint.");
  }
  const hash = createHash("sha256");
  for (const path of files) {
    const relative = path.slice(directory.length + 1).replaceAll("\\", "/");
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function assertSafePromotionSource(
  baseConfig,
  configPath,
  workerURL,
  options,
  env,
  artifactSHA256,
  bridgeReceipt,
  versionsBefore
) {
  if (options.target === "staging") {
    if (versionsBefore?.workerMissing === true) {
      return assertStagingSourceSnapshot({ workerMissing: true });
    }
    const schemaAwareReceipt = stagingProofReceiptFrom(options, env);
    const schemaAwareConfig = buildRolloutConfig(
      baseConfig,
      { ...options, target: "staging", phase: "all" },
      env
    );
    const status = remoteDeploymentStatus(configPath, "staging");
    const currentVersionID = exclusiveDeploymentVersionID(status);
    const version = remoteVersion(configPath, "staging", currentVersionID);
    assertExclusiveDeployment(status, schemaAwareReceipt.id);

    let receipt = schemaAwareReceipt;
    let stagingConfig = schemaAwareConfig;
    let preSchema = false;
    try {
      assertGuardedVersion(version, {
        id: receipt.id,
        target: "staging",
        phase: "all",
        tag: receipt.tag,
        config: stagingConfig,
        scriptEtag: receipt.scriptEtag,
      });
    } catch (schemaAwareError) {
      receipt = preSchemaStagingReceiptFrom(options, env);
      stagingConfig = buildPreSchemaStagingConfig(baseConfig, options, env);
      if (!isRecordedPreSchemaStagingVersion(version, {
        ...receipt,
        config: stagingConfig,
      })) {
        throw new Error(
          `The supplied staging receipt matches neither the schema-aware checkpoint nor the exact guarded pre-schema bootstrap source: ${schemaAwareError.message}`
        );
      }
      preSchema = true;
    }
    const health = await fetchHealthWithRetry(
      workerURL,
      (candidate) => validateStagingSourceHealth(candidate, { preSchema, receipt })
    );
    return assertStagingSourceSnapshot({
      workerMissing: false,
      status,
      version,
      receipt,
      config: stagingConfig,
      health,
    });
  }
  if (options.target !== "production") return undefined;
  if (options.phase === "bridge") {
    const status = remoteDeploymentStatus(configPath, "production");
    const versionID = exclusiveDeploymentVersionID(status);
    const version = remoteVersion(configPath, "production", versionID);
    const metadataPhase = classifyProductionSourceVersion(version, baseConfig);
    if (metadataPhase === "legacy") {
      assertLegacyContinuityVersion(version, baseConfig);
      await fetchHealthWithRetry(workerURL, (health) => {
        const healthPhase = assertLegacyOrBridgeHealth(health);
        if (healthPhase !== "legacy") {
          throw new Error("Health reports a bridge while authoritative Worker metadata is legacy.");
        }
        return healthPhase;
      });
      assertActivityGenerationTransition("legacy", "compatible");
      return { phase: "legacy", versionID };
    }

    const receipt = validatedBridgeReceipt(
      baseConfig,
      configPath,
      options,
      env,
      undefined,
      { allowPreSchema: true }
    );
    if (receipt.id !== versionID) {
      throw new Error("The active v2-capable source does not match the supplied bridge receipt.");
    }
    await waitForExclusiveDeployment(configPath, "production", receipt.id);
    await fetchHealthWithRetry(workerURL, (health) => {
      if (receipt.activityGenerationMode === "pre-schema") {
        return assertPreSchemaBridgeHealth(health, {
          versionID: receipt.id,
          versionTag: receipt.tag,
        });
      }
      return assertHealthyDeployment(
        health,
        "production",
        "bridge",
        {
          versionID: receipt.id,
          versionTag: receipt.tag,
          activityGenerationMode: "compatible",
        }
      );
    });
    assertActivityGenerationTransition(
      receipt.activityGenerationMode === "pre-schema"
        ? "pre-schema"
        : receipt.activityGenerationMode,
      "compatible"
    );
    return {
      phase: receipt.activityGenerationMode === "pre-schema"
        ? "pre-schema-bridge"
        : "bridge",
      versionID: receipt.id,
      versionTag: receipt.tag,
      rollbackReceipt: receipt,
    };
  }
  if (options.phase === "allowlist") {
    await waitForExclusiveDeployment(configPath, "production", bridgeReceipt.id);
    await fetchHealthWithRetry(workerURL, (health) => assertHealthyDeployment(
      health,
      "production",
      "bridge",
      {
        versionID: bridgeReceipt.id,
        versionTag: bridgeReceipt.tag,
        activityGenerationMode: "compatible",
      }
    ));
    assertActivityGenerationTransition("compatible", "authoritative");
    return {
      phase: "bridge",
      versionID: bridgeReceipt.id,
      versionTag: bridgeReceipt.tag,
    };
  }

  const status = remoteDeploymentStatus(configPath, "production");
  const currentVersionID = exclusiveDeploymentVersionID(status);
  const currentVersion = remoteVersion(configPath, "production", currentVersionID);
  const allowlistConfig = buildRolloutConfig(
    baseConfig,
    { ...options, phase: "allowlist" },
    env
  );
  const allowlistTag = versionTag("production", "allowlist", artifactSHA256);
  assertGuardedVersion(currentVersion, {
    id: currentVersionID,
    target: "production",
    phase: "allowlist",
    tag: allowlistTag,
    config: allowlistConfig,
    scriptEtag: bridgeReceipt.scriptEtag,
  });
  await fetchHealthWithRetry(workerURL, (health) => assertHealthyDeployment(
    health,
    "production",
    "allowlist",
    {
      versionID: currentVersionID,
      versionTag: allowlistTag,
      activityGenerationMode: "authoritative",
    }
  ));
  assertActivityGenerationTransition("authoritative", "authoritative");
  return {
    phase: "allowlist",
    versionID: currentVersionID,
    versionTag: allowlistTag,
  };
}

export function classifyProductionSourceVersion(version, productionConfig) {
  const bindings = Array.isArray(version?.resources?.bindings) ? version.resources.bindings : [];
  const expectedMigrationTag = productionConfig?.migrations?.at(-1)?.tag;
  const hasV2Evidence = [
    expectedMigrationTag
      && version?.resources?.script_runtime?.migration_tag === expectedMigrationTag,
    bindings.some((item) => item.name === "AUTH_STATE"),
    bindings.some((item) => item.name === "CF_VERSION_METADATA"),
    bindings.some((item) => item.name === "DEVICE_CREDENTIAL_PEPPER"),
    bindings.some((item) => item.name === "ACTIVITY_GENERATION_MODE"),
    bindings.some((item) => item.name === "V2_PAIRING_MODE"),
    bindings.some((item) => item.name === "V2_PAIRING_CANARY_INSTANCE_HASHES"),
  ].some(Boolean);
  return hasV2Evidence ? "bridge" : "legacy";
}

export function assertStagingSourceSnapshot({
  workerMissing,
  status,
  version,
  receipt,
  config,
  health,
}) {
  if (workerMissing) return { phase: "absent" };
  if (!receipt || !config || !version || !health) {
    throw new Error(
      "An existing staging Worker requires its complete previously guarded receipt."
    );
  }
  if (receipt.activityGenerationMode === "pre-schema") {
    assertStagingActivityGenerationTransition("pre-schema", "authoritative");
    assertExclusiveDeployment(status, receipt.id);
    if (!isRecordedPreSchemaStagingVersion(version, { ...receipt, config })) {
      throw new Error(
        "The staging receipt does not match the exact guarded pre-schema bootstrap source."
      );
    }
    assertPreSchemaStagingHealth(health, {
      versionID: receipt.id,
      versionTag: receipt.tag,
    });
    return {
      phase: "pre-schema-staging",
      versionID: receipt.id,
      versionTag: receipt.tag,
      rollbackReceipt: {
        ...receipt,
        version,
        versionConfig: config,
      },
    };
  }
  assertSchemaAwareReceipt(receipt, "authoritative", "staging checkpoint");
  assertStagingActivityGenerationTransition("authoritative", "authoritative");
  assertExclusiveDeployment(status, receipt.id);
  assertGuardedVersion(version, {
    id: receipt.id,
    target: "staging",
    phase: "all",
    tag: receipt.tag,
    config,
    scriptEtag: receipt.scriptEtag,
  });
  assertHealthyDeployment(health, "staging", "all", {
    versionID: receipt.id,
    versionTag: receipt.tag,
  });
  return {
    phase: "staging",
    versionID: receipt.id,
    versionTag: receipt.tag,
    rollbackReceipt: {
      ...receipt,
      version,
      versionConfig: config,
    },
  };
}

export function rollbackReceiptForAttempt(phase, sourceState, bridgeReceipt) {
  const receipt = phase === "bridge" ? sourceState?.rollbackReceipt : bridgeReceipt;
  if (receipt == null) return receipt;
  if (phase === "bridge" && receipt.activityGenerationMode === "pre-schema") {
    return receipt;
  }
  return assertSchemaAwareRollbackReceipt(receipt, "deployment rollback");
}

export function validateStagingSourceHealth(candidate, { preSchema, receipt }) {
  if (preSchema) {
    assertPreSchemaStagingHealth(candidate, {
      versionID: receipt.id,
      versionTag: receipt.tag,
    });
  } else {
    assertHealthyDeployment(candidate, "staging", "all", {
      versionID: receipt.id,
      versionTag: receipt.tag,
    });
  }
  return candidate;
}

function printDeploymentSuccess(options, deployedVersion, artifactSHA256) {
  console.log(`Deployment health gate passed: target=${options.target}, phase=${options.phase}.`);
  console.log(`Deployed version ID: ${deployedVersion.id}`);
  if (options.target === "production" && options.phase === "bridge") {
    const scriptEtag = requireScriptEtag(deployedVersion);
    console.log("Save this complete post-migration bridge receipt; artifact fields and trigger-state fields are required for promotion or rollback review.");
    console.log(`BRIDGE_VERSION_ID=${deployedVersion.id}`);
    console.log(`BRIDGE_ARTIFACT_SHA256=${artifactSHA256}`);
    console.log(`BRIDGE_SCRIPT_ETAG=${scriptEtag}`);
    console.log(`BRIDGE_AUTH_STATE_SCHEMA_VERSION=${AUTH_STATE_SCHEMA_VERSION}`);
    console.log(`BRIDGE_ACTIVITY_REGISTRATION_GENERATION_SCHEMA_VERSION=${ACTIVITY_REGISTRATION_GENERATION_SCHEMA_VERSION}`);
    console.log(`BRIDGE_ACTIVITY_GENERATION_SCHEMA=${ACTIVITY_GENERATION_SCHEMA}`);
    console.log("BRIDGE_ACTIVITY_GENERATION_MODE=compatible");
    console.log(`BRIDGE_ACTIVITY_ROUTE_AUTHORITY=${ACTIVITY_ROUTE_AUTHORITIES.compatible}`);
    console.log(`BRIDGE_MINIMUM_SAFE_ROLLBACK_AUTH_STATE_SCHEMA_VERSION=${MINIMUM_SAFE_ROLLBACK_AUTH_STATE_SCHEMA_VERSION}`);
    console.log("BRIDGE_PRE_SCHEMA_ROLLBACK_SAFE=false");
    console.log("BRIDGE_WORKERS_DEV=true");
    console.log("BRIDGE_PREVIEW_URLS=false");
  }
  if (options.target === "staging" && options.phase === "all") {
    const scriptEtag = requireScriptEtag(deployedVersion);
    console.log("After the documented staging flow checks pass, save this complete staging checkpoint receipt.");
    console.log(`STAGING_PROOF_VERSION_ID=${deployedVersion.id}`);
    console.log(`STAGING_PROOF_ARTIFACT_SHA256=${artifactSHA256}`);
    console.log(`STAGING_PROOF_SCRIPT_ETAG=${scriptEtag}`);
    console.log(`STAGING_PROOF_AUTH_STATE_SCHEMA_VERSION=${AUTH_STATE_SCHEMA_VERSION}`);
    console.log(`STAGING_PROOF_ACTIVITY_REGISTRATION_GENERATION_SCHEMA_VERSION=${ACTIVITY_REGISTRATION_GENERATION_SCHEMA_VERSION}`);
    console.log(`STAGING_PROOF_ACTIVITY_GENERATION_SCHEMA=${ACTIVITY_GENERATION_SCHEMA}`);
    console.log("STAGING_PROOF_ACTIVITY_GENERATION_MODE=authoritative");
    console.log(`STAGING_PROOF_ACTIVITY_ROUTE_AUTHORITY=${ACTIVITY_ROUTE_AUTHORITIES.authoritative}`);
    console.log(`STAGING_PROOF_MINIMUM_SAFE_ROLLBACK_AUTH_STATE_SCHEMA_VERSION=${MINIMUM_SAFE_ROLLBACK_AUTH_STATE_SCHEMA_VERSION}`);
    console.log("STAGING_PROOF_PRE_SCHEMA_ROLLBACK_SAFE=false");
    console.log("STAGING_PROOF_WORKERS_DEV=true");
    console.log("STAGING_PROOF_PREVIEW_URLS=false");
  }
}

function readInitialLifecycleSnapshot(configPath, target, sourceState) {
  if (sourceState?.phase === "absent") {
    const versions = remoteVersions(configPath, target, { allowMissingWorker: true });
    if (versions.workerMissing === true) return { workerMissing: true };
  }
  const status = remoteDeploymentStatus(configPath, target);
  const versionID = exclusiveDeploymentVersionID(status);
  return {
    workerMissing: false,
    status,
    version: remoteVersion(configPath, target, versionID),
  };
}

export async function reconcileInitialLifecycleAfterFailure({
  failure,
  sourceState,
  readSnapshot,
  assertExpectedVersion,
  assertExpectedHealth,
  attempts = REMOTE_POLL_ATTEMPTS,
  delayMs = REMOTE_POLL_DELAY_MS,
  sleep = (duration) => new Promise((resolvePromise) => setTimeout(resolvePromise, duration)),
}) {
  let unchangedObservations = 0;
  let expectedVersionSeen = false;
  let ambiguousStateSeen = false;
  let lastReason = "no deployment state was returned";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const snapshot = await readSnapshot();
      const unchanged = sourceState?.phase === "absent"
        ? snapshot?.workerMissing === true
        : exclusiveDeploymentVersionID(snapshot?.status) === sourceState?.versionID;
      if (unchanged) {
        unchangedObservations += 1;
        lastReason = "the exact pre-deploy source remained active";
      } else {
        const activeVersionID = exclusiveDeploymentVersionID(snapshot?.status);
        if (snapshot?.version?.id !== activeVersionID) {
          throw new Error("active status and exact version metadata disagree");
        }
        try {
          assertExpectedVersion(snapshot.version);
        } catch (error) {
          ambiguousStateSeen = true;
          lastReason = `an unexpected active version was observed (${error.message})`;
          if (attempt + 1 < attempts) await sleep(delayMs);
          continue;
        }
        expectedVersionSeen = true;
        try {
          await assertExpectedHealth(snapshot.version);
          return { reconciled: true, version: snapshot.version };
        } catch (error) {
          lastReason = `the exact uploaded version did not pass health (${error.message})`;
        }
      }
    } catch (error) {
      ambiguousStateSeen = true;
      lastReason = `deployment state was unreadable or ambiguous (${error.message})`;
    }
    if (attempt + 1 < attempts) await sleep(delayMs);
  }

  const originalMessage = failure?.message || "Initial lifecycle Wrangler deploy failed.";
  if (
    unchangedObservations === attempts
    && !expectedVersionSeen
    && !ambiguousStateSeen
  ) {
    throw new Error(
      `${originalMessage} Bounded reconciliation observed only the exact pre-deploy source, but delayed propagation means this is not proof that no mutation was accepted. No pre-v2 rollback exists; manual intervention is required before any further rollout.`
    );
  }
  throw new Error(
    `${originalMessage} Initial lifecycle deployment could not be safely reconciled: ${lastReason}. No pre-v2 rollback exists; manual intervention is required before any further rollout.`
  );
}

export async function recoverPromotionAfterFailure({
  failure,
  sourceVersionID,
  readStatus,
  restore,
  targetLabel = "production",
  recoveryLabel = "receipt-bound v2 bridge",
}) {
  let recoveryReason;
  try {
    const activeVersionID = exclusiveDeploymentVersionID(await readStatus());
    recoveryReason = activeVersionID === sourceVersionID
      ? "the pre-deploy source was still visible, but delayed propagation cannot prove that the failed deployment was not accepted"
      : `active version changed to ${activeVersionID}`;
  } catch (error) {
    recoveryReason = `deployment state was unreadable or ambiguous (${error.message})`;
  }
  try {
    // This later deployment is unconditional: a failed Wrangler process may have
    // submitted a promotion that Cloudflare has not made observable yet.
    await restore();
  } catch (rollbackError) {
    throw new Error(
      `${failure.message} ${recoveryReason}; automatic ${recoveryLabel} rollback failed: ${rollbackError.message}. Manual intervention is required.`
    );
  }
  throw new Error(
    `${failure.message} ${recoveryReason}; ${targetLabel} was restored to the ${recoveryLabel}.`
  );
}

async function requireBridgeForPromotion(
  baseConfig,
  configPath,
  options,
  env,
  artifactSHA256
) {
  if (options.target !== "production" || !["allowlist", "all"].includes(options.phase)) {
    return undefined;
  }
  const receipt = bridgeReceiptFrom(options, env);
  if (receipt.artifactSHA256 !== artifactSHA256) {
    throw new Error(
      "The bridge artifact SHA-256 does not match the locally verified Worker bundle; promotion stopped."
    );
  }
  return validatedBridgeReceipt(baseConfig, configPath, options, env, receipt);
}

function validatedBridgeReceipt(
  baseConfig,
  configPath,
  options,
  env,
  suppliedReceipt,
  { allowPreSchema = false } = {}
) {
  const receipt = suppliedReceipt || bridgeReceiptFrom(options, env);
  assertSchemaAwareRollbackReceipt(receipt, "bridge rollback");
  const bridgeConfig = buildRolloutConfig(
    baseConfig,
    { ...options, phase: "bridge" },
    env
  );
  const version = remoteVersion(configPath, "production", receipt.id);
  if (isRecordedBridgeVersion(version, { ...receipt, config: bridgeConfig })) {
    return { ...receipt, version, versionConfig: bridgeConfig };
  }
  if (allowPreSchema) {
    const preSchemaReceipt = preSchemaBridgeReceiptFrom(options, env);
    const preSchemaConfig = buildPreSchemaBridgeConfig(baseConfig, options, env);
    if (isRecordedPreSchemaBridgeVersion(version, {
      ...preSchemaReceipt,
      config: preSchemaConfig,
    })) {
      return {
        ...preSchemaReceipt,
        version,
        versionConfig: preSchemaConfig,
      };
    }
  }
  throw new Error(
    "The supplied bridge receipt does not match the exact guarded compatible off-mode production version."
  );
}

function buildPreSchemaBridgeConfig(baseConfig, options, env) {
  const config = buildRolloutConfig(
    baseConfig,
    { ...options, target: "production", phase: "bridge" },
    env
  );
  delete config.vars.ACTIVITY_GENERATION_MODE;
  return config;
}

function preSchemaBridgeReceiptFrom(options, env) {
  const receipt = bridgeReceiptFrom(options, env);
  return {
    id: receipt.id,
    artifactSHA256: receipt.artifactSHA256,
    scriptEtag: receipt.scriptEtag,
    activityGenerationSchema: null,
    activityGenerationMode: "pre-schema",
    workersDev: true,
    previewUrls: false,
    tag: preSchemaVersionTag("production", "bridge", receipt.artifactSHA256),
  };
}

function bridgeReceiptFrom(options, env) {
  const id = String(options.bridgeVersionID || env.BRIDGE_VERSION_ID || "").trim();
  const artifactSHA256 = String(
    options.bridgeArtifactSHA256 || env.BRIDGE_ARTIFACT_SHA256 || ""
  ).trim().toLowerCase();
  const scriptEtag = String(options.bridgeScriptEtag || env.BRIDGE_SCRIPT_ETAG || "").trim();
  if (!UUID_PATTERN.test(String(id || ""))) {
    throw new Error("The complete bridge receipt requires a valid BRIDGE_VERSION_ID.");
  }
  if (!HASH_PATTERN.test(artifactSHA256)) {
    throw new Error("The complete bridge receipt requires a valid BRIDGE_ARTIFACT_SHA256.");
  }
  if (!SCRIPT_ETAG_PATTERN.test(String(scriptEtag || ""))) {
    throw new Error("The complete bridge receipt requires a valid BRIDGE_SCRIPT_ETAG.");
  }
  return {
    id,
    artifactSHA256,
    scriptEtag,
    ...activityGenerationReceipt("compatible"),
    workersDev: true,
    previewUrls: false,
    tag: versionTag("production", "bridge", artifactSHA256),
  };
}

export function stagingProofReceiptFrom(options, env, currentArtifactSHA256) {
  const id = String(options.stagingProofVersionID || env.STAGING_PROOF_VERSION_ID || "").trim();
  const artifactSHA256 = String(
    options.stagingProofArtifactSHA256 || env.STAGING_PROOF_ARTIFACT_SHA256 || ""
  ).trim().toLowerCase();
  const scriptEtag = String(
    options.stagingProofScriptEtag || env.STAGING_PROOF_SCRIPT_ETAG || ""
  ).trim();
  if (!UUID_PATTERN.test(id)) {
    throw new Error("The production bridge requires a valid STAGING_PROOF_VERSION_ID.");
  }
  if (!HASH_PATTERN.test(artifactSHA256)) {
    throw new Error("The production bridge requires a valid STAGING_PROOF_ARTIFACT_SHA256.");
  }
  if (!SCRIPT_ETAG_PATTERN.test(scriptEtag)) {
    throw new Error("The production bridge requires a valid STAGING_PROOF_SCRIPT_ETAG.");
  }
  if (currentArtifactSHA256 && artifactSHA256 !== currentArtifactSHA256) {
    throw new Error("The staging proof artifact does not match the locally verified production bundle.");
  }
  return {
    id,
    artifactSHA256,
    scriptEtag,
    ...activityGenerationReceipt("authoritative"),
    workersDev: true,
    previewUrls: false,
    tag: versionTag("staging", "all", artifactSHA256),
  };
}

export function preSchemaStagingReceiptFrom(options, env) {
  const schemaAware = stagingProofReceiptFrom(options, env);
  return {
    id: schemaAware.id,
    artifactSHA256: schemaAware.artifactSHA256,
    scriptEtag: schemaAware.scriptEtag,
    activityGenerationSchema: null,
    activityGenerationMode: "pre-schema",
    workersDev: true,
    previewUrls: false,
    tag: preSchemaVersionTag("staging", "all", schemaAware.artifactSHA256),
  };
}

function buildPreSchemaStagingConfig(baseConfig, options, env) {
  const config = buildRolloutConfig(
    baseConfig,
    { ...options, target: "staging", phase: "all" },
    env
  );
  delete config.env?.staging?.vars?.ACTIVITY_GENERATION_MODE;
  return config;
}

async function verifyStagingCheckpoint(baseConfig, temporary, options, env, artifactSHA256) {
  if (!options.confirmStagingTests) {
    throw new Error(
      "A production bridge upload requires --confirm-staging-tests after both staging v1 and v2 synthetic flows pass."
    );
  }
  const receipt = stagingProofReceiptFrom(options, env, artifactSHA256);
  const stagingEnv = loadEnvironment(stagingEnvPath, {
    required: false,
    includeProcessEnv: false,
  });
  for (const key of [
    "STAGING_KV_NAMESPACE_ID",
    "STAGING_RATE_LIMIT_NAMESPACE_ID",
  ]) {
    if (process.env[key]?.trim()) stagingEnv[key] = process.env[key];
  }
  if (process.env.STAGING_EXPECTED_CLOUDFLARE_ACCOUNT_ID?.trim()) {
    stagingEnv.EXPECTED_CLOUDFLARE_ACCOUNT_ID =
      process.env.STAGING_EXPECTED_CLOUDFLARE_ACCOUNT_ID;
  }
  if (process.env.STAGING_WORKER_HEALTH_URL?.trim()) {
    stagingEnv.WORKER_HEALTH_URL = process.env.STAGING_WORKER_HEALTH_URL;
  }
  const stagingConfig = buildRolloutConfig(
    baseConfig,
    { ...options, target: "staging", phase: "all" },
    stagingEnv
  );
  pinExpectedCloudflareAccount(
    stagingConfig,
    "staging",
    expectedCloudflareAccountID(stagingEnv)
  );
  stagingConfig.main = resolve(workerDir, baseConfig.main);
  assertStagingIsolation(baseConfig, stagingConfig);
  const proofConfigPath = resolve(temporary.directory, "staging-proof-wrangler.json");
  writeFileSync(proofConfigPath, `${JSON.stringify(stagingConfig, null, 2)}\n`, { mode: 0o600 });
  freezeGeneratedRemoteConfig(proofConfigPath, "staging proof Wrangler config");
  const stagingWorkerURL = requiredHealthURL(stagingEnv);
  const stagingAccountAccess = await assertCloudflareAccountAccess(
    stagingConfig,
    "staging"
  );
  assertWorkerHealthOrigin(
    stagingWorkerURL,
    stagingConfig,
    "staging",
    stagingAccountAccess
  );
  const version = remoteVersion(proofConfigPath, "staging", receipt.id);
  assertGuardedVersion(version, {
    id: receipt.id,
    target: "staging",
    phase: "all",
    tag: receipt.tag,
    config: stagingConfig,
    scriptEtag: receipt.scriptEtag,
  });
  await waitForExclusiveDeployment(proofConfigPath, "staging", receipt.id);
  await fetchHealthWithRetry(stagingWorkerURL, (health) => assertHealthyDeployment(
    health,
    "staging",
    "all",
    { versionID: receipt.id, versionTag: receipt.tag }
  ));
  await assertRemoteWorkerSubdomainInvariant(stagingConfig, "staging");
  console.log(`Staging checkpoint receipt verified: version=${receipt.id}.`);
  return { ...receipt, version, versionConfig: stagingConfig };
}

async function rollbackToBridge(options) {
  if (!options.confirmRollback) {
    throw new Error("Rollback stopped. Re-run with --confirm-rollback after verifying the complete bridge receipt.");
  }
  const env = loadEnvironment(productionEnvPath);
  const accountID = expectedCloudflareAccountID(env);
  const receipt = bridgeReceiptFrom(options, env);
  const baseConfig = parseJSONC(readFileSync(baseConfigPath, "utf8"));
  const bridgeConfig = buildRolloutConfig(baseConfig, { ...options, phase: "bridge" }, env);
  pinExpectedCloudflareAccount(bridgeConfig, "production", accountID);
  bridgeConfig.main = resolve(workerDir, baseConfig.main);
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "ha-livekit-rollback-"));
  const rollbackConfigPath = resolve(temporaryDirectory, "wrangler.json");
  try {
    writeFileSync(rollbackConfigPath, `${JSON.stringify(bridgeConfig, null, 2)}\n`, { mode: 0o600 });
    freezeGeneratedRemoteConfig(rollbackConfigPath, "rollback Wrangler config");
    const version = remoteVersion(rollbackConfigPath, "production", receipt.id);
    if (!isRecordedBridgeVersion(version, { ...receipt, config: bridgeConfig })) {
      throw new Error("The supplied bridge receipt does not match the exact guarded off-mode version.");
    }
    await restoreBridge(
      rollbackConfigPath,
      { ...receipt, version, versionConfig: bridgeConfig },
      requiredHealthURL(env)
    );
    console.log(`Production restored to bridge version ${receipt.id}.`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function restoreBridge(configPath, bridgeReceipt, workerURL) {
  await restoreGuardedVersion(
    configPath,
    "production",
    "bridge",
    bridgeReceipt,
    workerURL
  );
}

async function restoreGuardedVersion(configPath, target, phase, receipt, workerURL) {
  if (target === "staging" && receipt.activityGenerationMode !== "pre-schema") {
    assertSchemaAwareReceipt(receipt, "authoritative", `${target} ${phase} rollback`);
  } else if (receipt.activityGenerationMode !== "pre-schema") {
    assertSchemaAwareRollbackReceipt(receipt, `${target} ${phase} rollback`);
  }
  const remote = remoteVersion(configPath, target, receipt.id);
  if (receipt.activityGenerationMode === "pre-schema") {
    const exactPreSchemaSource = target === "staging"
      ? isRecordedPreSchemaStagingVersion(remote, {
        ...receipt,
        config: receipt.versionConfig,
      })
      : isRecordedPreSchemaBridgeVersion(remote, {
        ...receipt,
        config: receipt.versionConfig,
      });
    if (!exactPreSchemaSource) {
      throw new Error(
        `The automatic recovery target is not the exact guarded pre-schema ${target} source.`
      );
    }
  } else {
    assertGuardedVersion(remote, {
      id: receipt.id,
      target,
      phase,
      tag: receipt.tag,
      config: receipt.versionConfig,
      scriptEtag: receipt.scriptEtag,
    });
  }
  const accountAccess = await assertCloudflareAccountAccess(
    receipt.versionConfig,
    target
  );
  assertWorkerHealthOrigin(
    workerURL,
    receipt.versionConfig,
    target,
    accountAccess
  );
  runWrangler([
    "versions", "deploy", `${receipt.id}@100%`,
    "--config", configPath,
    "--env", target === "staging" ? "staging" : "",
    "--yes",
    "--message", `HA LiveKit relay v2 rollback to ${target} ${phase}`,
  ], { capture: true });
  await waitForExclusiveDeployment(configPath, target, receipt.id);
  await fetchHealthWithRetry(workerURL, (health) => {
    if (target === "production" && receipt.activityGenerationMode === "pre-schema") {
      return assertPreSchemaBridgeHealth(health, {
        versionID: receipt.id,
        versionTag: receipt.tag,
      });
    }
    if (target === "staging" && receipt.activityGenerationMode === "pre-schema") {
      return assertPreSchemaStagingHealth(health, {
        versionID: receipt.id,
        versionTag: receipt.tag,
      });
    }
    return assertHealthyDeployment(
      health,
      target,
      phase,
      {
        versionID: receipt.id,
        versionTag: receipt.tag,
        activityGenerationMode: receipt.activityGenerationMode,
      }
    );
  });
  await assertRemoteWorkerSubdomainInvariant(receipt.versionConfig, target);
}

function requiredHealthURL(env) {
  const workerURL = String(env.WORKER_HEALTH_URL || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(workerURL)) {
    throw new Error("WORKER_HEALTH_URL must be an explicit HTTPS URL before remote deployment.");
  }
  return workerURL;
}

function cloudflareReadHeaders(environment = process.env) {
  const token = String(
    environment.CLOUDFLARE_API_TOKEN || environment.CF_API_TOKEN || ""
  ).trim();
  if (token) return { authorization: `Bearer ${token}` };
  const apiKey = String(
    environment.CLOUDFLARE_API_KEY || environment.CF_API_KEY || ""
  ).trim();
  const email = String(
    environment.CLOUDFLARE_EMAIL || environment.CF_API_EMAIL || ""
  ).trim();
  if (apiKey && email) {
    return {
      "x-auth-key": apiKey,
      "x-auth-email": email,
    };
  }
  throw new Error(
    "Remote rollout requires an explicit Cloudflare API token (or API key plus email) to verify Worker subdomain and preview state."
  );
}

function targetWorkerConfig(config, target) {
  return target === "staging" ? config?.env?.staging : config;
}

export function assertWorkerHealthOrigin(
  workerURL,
  config,
  target,
  accountAccess
) {
  const targetConfig = targetWorkerConfig(config, target);
  const workerName = String(targetConfig?.name || "").trim().toLowerCase();
  const accountSubdomain = String(accountAccess?.subdomain || "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9-]+$/.test(workerName) || !/^[a-z0-9-]+$/.test(accountSubdomain)) {
    throw new Error("Cannot bind relay health to the exact Cloudflare Worker origin.");
  }
  let actual;
  try {
    actual = new URL(workerURL);
  } catch {
    throw new Error("WORKER_HEALTH_URL must be the exact Worker HTTPS origin.");
  }
  const expectedOrigin = `https://${workerName}.${accountSubdomain}.workers.dev`;
  if (
    actual.protocol !== "https:"
    || actual.username
    || actual.password
    || actual.port
    || actual.pathname !== "/"
    || actual.search
    || actual.hash
    || actual.origin.toLowerCase() !== expectedOrigin
  ) {
    throw new Error(
      `WORKER_HEALTH_URL must match the exact pinned Worker origin ${expectedOrigin}.`
    );
  }
  return expectedOrigin;
}

export async function assertCloudflareAccountAccess(
  config,
  target,
  {
    fetchImpl = fetch,
    authHeaders = cloudflareReadHeaders(),
  } = {}
) {
  const targetConfig = targetWorkerConfig(config, target);
  const accountID = String(targetConfig?.account_id || config?.account_id || "").toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(accountID)) {
    throw new Error("Cannot verify Cloudflare access without the exact pinned account ID.");
  }
  const url = `${CLOUDFLARE_PUBLIC_API_BASE_URL}/accounts/${accountID}/workers/subdomain`;
  const payload = await fetchBoundedHealthJSON(url, { fetchImpl, headers: authHeaders });
  if (
    payload?.success !== true
    || typeof payload?.result?.subdomain !== "string"
    || payload.result.subdomain.trim() === ""
  ) {
    throw new Error("Cloudflare account-level Worker read did not validate the pinned rollout account.");
  }
  return payload.result;
}

async function assertRemoteWorkerSubdomainInvariant(
  config,
  target,
  { requirePreviewDisabled = true } = {}
) {
  const targetConfig = targetWorkerConfig(config, target);
  const accountID = String(targetConfig?.account_id || config?.account_id || "").toLowerCase();
  const workerName = String(targetConfig?.name || "");
  if (!ACCOUNT_ID_PATTERN.test(accountID) || !workerName) {
    throw new Error("Cannot verify Worker subdomain state without the pinned account and exact Worker name.");
  }
  const url = `${CLOUDFLARE_PUBLIC_API_BASE_URL}/accounts/${accountID}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`;
  const payload = await fetchBoundedHealthJSON(url, {
    headers: cloudflareReadHeaders(),
  });
  if (payload?.success !== true || !payload?.result) {
    throw new Error("Cloudflare did not return authoritative Worker subdomain state.");
  }
  assertWorkerSubdomainState(payload.result, {
    workersDev: targetConfig.workers_dev,
    previewUrls: targetConfig.preview_urls,
    checkPreview: requirePreviewDisabled,
  });
  return payload.result;
}

export function assertWorkerSubdomainState(
  state,
  { workersDev = true, previewUrls = false, checkPreview = true } = {}
) {
  const failures = [];
  if (state?.enabled !== workersDev) failures.push(`workers_dev=${workersDev}`);
  if (checkPreview && state?.previews_enabled !== previewUrls) {
    failures.push(`preview_urls=${previewUrls}`);
  }
  if (failures.length > 0) {
    throw new Error(`Unsafe Worker subdomain state; required: ${failures.join(", ")}.`);
  }
}

async function fetchHealthWithRetry(workerURL, assertExpected) {
  return pollUntilExpected(
    () => fetchBoundedHealthJSON(`${workerURL}/health`),
    assertExpected,
    { label: "Relay health check" }
  );
}

export async function fetchBoundedHealthJSON(
  url,
  {
    fetchImpl = fetch,
    timeoutMs = HEALTH_REQUEST_TIMEOUT_MS,
    maxBytes = HEALTH_RESPONSE_MAX_BYTES,
    headers = {},
  } = {}
) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", ...headers },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`Relay health response exceeds ${maxBytes} bytes.`);
    }

    const chunks = [];
    let totalBytes = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          controller.abort();
          throw new Error(`Relay health response exceeds ${maxBytes} bytes.`);
        }
        chunks.push(value);
      }
    } else {
      const bytes = new TextEncoder().encode(await response.text());
      totalBytes = bytes.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`Relay health response exceeds ${maxBytes} bytes.`);
      }
      chunks.push(bytes);
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new Error("Relay health response was not valid JSON.");
    }
  } catch (error) {
    if (timedOut) {
      throw new Error(`Relay health request timed out after ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function pollUntilExpected(
  load,
  assertExpected,
  {
    attempts = REMOTE_POLL_ATTEMPTS,
    delayMs = REMOTE_POLL_DELAY_MS,
    sleep = (duration) => new Promise((resolvePromise) => setTimeout(resolvePromise, duration)),
    label = "Remote state check",
  } = {}
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await load();
      const result = assertExpected(value);
      return result === undefined ? value : result;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(delayMs);
    }
  }
  throw new Error(`${label} did not reach the expected state: ${lastError?.message || "unknown error"}.`);
}

export function assertHealthyDeployment(health, target, phase, expectedVersion = {}) {
  const expectedMode = phase === "bridge" ? "off" : phase;
  const expectedActivityGenerationMode = expectedVersion.activityGenerationMode
    || activityGenerationModeForRollout({ target, phase });
  if (!ACTIVITY_GENERATION_MODES.has(expectedActivityGenerationMode)) {
    throw new Error("Relay health gate requires an exact activity-generation mode.");
  }
  const checks = {
    ok: health?.ok === true,
    ready: health?.ready === true,
    storage: health?.storage === true,
    apns_configured: health?.apns_configured === true,
    relay_enabled: health?.relay_enabled === true,
    strongly_consistent_auth_ready: health?.strongly_consistent_auth_ready === true,
    auth_state_schema_version:
      health?.auth_state_schema_version === AUTH_STATE_SCHEMA_VERSION,
    activity_registration_generation_schema_version:
      health?.activity_registration_generation_schema_version
        === ACTIVITY_REGISTRATION_GENERATION_SCHEMA_VERSION,
    activity_generation_schema:
      health?.activity_generation_schema === ACTIVITY_GENERATION_SCHEMA,
    activity_generation_mode:
      health?.activity_generation_mode === expectedActivityGenerationMode,
    activity_route_authority:
      health?.activity_route_authority
        === ACTIVITY_ROUTE_AUTHORITIES[expectedActivityGenerationMode],
    minimum_safe_rollback_auth_state_schema_version:
      health?.minimum_safe_rollback_auth_state_schema_version
        === MINIMUM_SAFE_ROLLBACK_AUTH_STATE_SCHEMA_VERSION,
    pre_schema_rollback_safe:
      health?.pre_schema_rollback_safe === false,
    v2_device_auth_configured: health?.v2_device_auth_configured === true,
    legacy_app_auth_configured: health?.legacy_app_auth_configured === true,
    distributed_rate_limit_ready: health?.distributed_rate_limit_ready === true,
    v2_pairing_mode: health?.v2_pairing_mode === expectedMode,
    apns_environment: health?.apns_environment === (target === "staging" ? "sandbox" : "production"),
    apns_mock: health?.apns_mock === (target === "staging"),
  };
  if (expectedVersion.versionID) {
    checks.worker_version_id = health?.worker_version_id === expectedVersion.versionID;
  }
  if (expectedVersion.versionTag) {
    checks.worker_version_tag = health?.worker_version_tag === expectedVersion.versionTag;
  }
  if (expectedMode === "off") checks.v2_pairing_disabled = health?.v2_pairing_enabled === false;
  if (expectedMode === "allowlist") {
    checks.v2_pairing_enabled = health?.v2_pairing_enabled === true;
    checks.v2_pairing_allowlist_configured = health?.v2_pairing_allowlist_configured === true;
    if (target === "production") {
      checks.v2_pairing_allowlist_count = health?.v2_pairing_allowlist_count === 1;
    }
  }
  if (expectedMode === "all") checks.v2_pairing_enabled = health?.v2_pairing_enabled === true;
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failures.length > 0) {
    throw new Error(`Relay failed the ${target}/${phase} health gate: ${failures.join(", ")}.`);
  }
}

export function assertLegacyOrBridgeHealth(health) {
  if (health?.v2_pairing_mode === "off") {
    if (health?.activity_generation_mode == null) {
      assertPreSchemaBridgeHealth(health);
      return "pre-schema-bridge";
    }
    if (health.activity_generation_mode !== "compatible") {
      throw new Error(
        "An off-mode production bridge must use compatible activity generation."
      );
    }
    assertHealthyDeployment(health, "production", "bridge", {
      activityGenerationMode: "compatible",
    });
    return "compatible";
  }
  if (health?.v2_pairing_mode != null) {
    throw new Error("Current production is not the legacy relay or an off-mode bridge.");
  }
  const endpoints = Array.isArray(health?.endpoints) ? new Set(health.endpoints) : new Set();
  const checks = {
    ok: health?.ok === true,
    storage: health?.storage === true,
    apns_configured: health?.apns_configured === true,
    relay_enabled: health?.relay_enabled === true,
    apns_environment: health?.apns_environment === "production",
    activity_generation_schema_absent: health?.activity_generation_schema == null,
    activity_generation_mode_absent: health?.activity_generation_mode == null,
    v1_register: endpoints.has("/register"),
    v1_start: endpoints.has("/start"),
    v1_update: endpoints.has("/update"),
    v1_end: endpoints.has("/end"),
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failures.length > 0) {
    throw new Error(`Current production relay failed the pre-bridge gate: ${failures.join(", ")}.`);
  }
  return "legacy";
}

export function assertPreSchemaBridgeHealth(health, expectedVersion = {}) {
  const checks = {
    ok: health?.ok === true,
    ready: health?.ready === true,
    storage: health?.storage === true,
    apns_configured: health?.apns_configured === true,
    relay_enabled: health?.relay_enabled === true,
    strongly_consistent_auth_ready: health?.strongly_consistent_auth_ready === true,
    v2_device_auth_configured: health?.v2_device_auth_configured === true,
    legacy_app_auth_configured: health?.legacy_app_auth_configured === true,
    distributed_rate_limit_ready: health?.distributed_rate_limit_ready === true,
    v2_pairing_mode: health?.v2_pairing_mode === "off",
    v2_pairing_disabled: health?.v2_pairing_enabled === false,
    apns_environment: health?.apns_environment === "production",
    apns_mock: health?.apns_mock === false,
    activity_generation_schema_absent: health?.activity_generation_schema == null,
    activity_generation_mode_absent: health?.activity_generation_mode == null,
  };
  if (expectedVersion.versionID) {
    checks.worker_version_id = health?.worker_version_id === expectedVersion.versionID;
  }
  if (expectedVersion.versionTag) {
    checks.worker_version_tag = health?.worker_version_tag === expectedVersion.versionTag;
  }
  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failures.length > 0) {
    throw new Error(`Current pre-schema bridge failed its exact health gate: ${failures.join(", ")}.`);
  }
  return "pre-schema-bridge";
}

export function assertPreSchemaStagingHealth(health, expectedVersion = {}) {
  const checks = {
    ok: health?.ok === true,
    ready: health?.ready === true,
    storage: health?.storage === true,
    apns_configured: health?.apns_configured === true,
    relay_enabled: health?.relay_enabled === true,
    strongly_consistent_auth_ready: health?.strongly_consistent_auth_ready === true,
    v2_device_auth_configured: health?.v2_device_auth_configured === true,
    legacy_app_auth_configured: health?.legacy_app_auth_configured === true,
    distributed_rate_limit_ready: health?.distributed_rate_limit_ready === true,
    v2_pairing_mode: health?.v2_pairing_mode === "all",
    v2_pairing_enabled: health?.v2_pairing_enabled === true,
    apns_environment: health?.apns_environment === "sandbox",
    apns_mock: health?.apns_mock === true,
    activity_generation_schema_absent: health?.activity_generation_schema == null,
    activity_generation_mode_absent: health?.activity_generation_mode == null,
    activity_route_authority_absent: health?.activity_route_authority == null,
  };
  if (expectedVersion.versionID) {
    checks.worker_version_id = health?.worker_version_id === expectedVersion.versionID;
  }
  if (expectedVersion.versionTag) {
    checks.worker_version_tag = health?.worker_version_tag === expectedVersion.versionTag;
  }
  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failures.length > 0) {
    throw new Error(
      `Current pre-schema staging source failed its exact health gate: ${failures.join(", ")}.`
    );
  }
  return "pre-schema-staging";
}

function remoteVersions(configPath, target, { allowMissingWorker = false } = {}) {
  const args = ["versions", "list", "--config", configPath, "--json"];
  args.push("--env", target === "staging" ? "staging" : "");
  let output;
  try {
    output = runWrangler(args, { capture: true });
  } catch (error) {
    if (
      allowMissingWorker
      && /(worker|service).*(not found|does not exist)|\b1009[02]\b/i.test(error.message)
    ) {
      const missing = new Map();
      missing.workerMissing = true;
      return missing;
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Wrangler returned non-JSON version metadata.");
  }
  const versions = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(versions)) {
    throw new Error("Wrangler version metadata did not contain a version list.");
  }
  const result = new Map(
    versions
      .filter((version) => UUID_PATTERN.test(String(version?.id || "")))
      .map((version) => [version.id, version])
  );
  result.workerMissing = false;
  return result;
}

function remoteVersion(configPath, target, versionID) {
  const args = ["versions", "view", versionID, "--config", configPath, "--json"];
  args.push("--env", target === "staging" ? "staging" : "");
  const version = parseWranglerJSON(
    runWrangler(args, { capture: true }),
    "exact Worker version metadata"
  );
  if (version?.id !== versionID) {
    throw new Error("Wrangler returned metadata for a different Worker version ID.");
  }
  return version;
}

function remoteDeploymentStatus(configPath, target) {
  const args = ["deployments", "status", "--config", configPath, "--json"];
  args.push("--env", target === "staging" ? "staging" : "");
  return parseWranglerJSON(
    runWrangler(args, { capture: true }),
    "current Worker deployment status"
  );
}

function parseWranglerJSON(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Wrangler returned non-JSON ${label}.`);
  }
}

export function exclusiveDeploymentVersionID(status) {
  const versions = status?.versions;
  if (!Array.isArray(versions) || versions.length !== 1) {
    throw new Error("The Worker must have exactly one version receiving traffic.");
  }
  const versionID = versions[0]?.version_id;
  if (!UUID_PATTERN.test(String(versionID || "")) || Number(versions[0]?.percentage) !== 100) {
    throw new Error("The expected Worker version is not receiving 100% of traffic.");
  }
  return versionID;
}

export function assertExclusiveDeployment(status, expectedVersionID) {
  const activeVersionID = exclusiveDeploymentVersionID(status);
  if (activeVersionID !== expectedVersionID) {
    throw new Error("A different Worker version is receiving production traffic.");
  }
}

async function waitForExclusiveDeployment(configPath, target, expectedVersionID) {
  await pollUntilExpected(
    () => remoteDeploymentStatus(configPath, target),
    (status) => assertExclusiveDeployment(status, expectedVersionID),
    { label: `${target} deployment propagation` }
  );
}

async function waitForDeployedVersion(configPath, target, output, before, expected) {
  const outputIDs = (String(output || "").match(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi) || [])
    .filter((value) => UUID_PATTERN.test(value));
  return pollUntilExpected(
    () => {
      const after = remoteVersions(configPath, target);
      const candidates = new Set([
        ...outputIDs,
        ...[...after.keys()].filter((id) => !before.has(id)),
      ]);
      const matches = [];
      for (const versionID of candidates) {
        try {
          const version = remoteVersion(configPath, target, versionID);
          assertGuardedVersion(version, { ...expected, id: versionID });
          matches.push(version);
        } catch {
          // Version-list and exact-version APIs can propagate at different speeds.
        }
      }
      if (matches.length > 1) {
        throw new Error("Multiple new versions match this rollout artifact; refusing an ambiguous receipt.");
      }
      if (matches.length !== 1) {
        throw new Error("The exact newly deployed Worker version is not visible yet.");
      }
      return matches[0];
    },
    (version) => version,
    { label: "Worker version propagation" }
  );
}

export function isRecordedBridgeVersion(version, expected = {}) {
  try {
    if (!expected.tag || !expected.scriptEtag || !expected.config || !expected.id) return false;
    assertSchemaAwareRollbackReceipt(expected, "bridge rollback");
    assertGuardedVersion(version, {
      id: expected.id,
      target: "production",
      phase: "bridge",
      tag: expected.tag,
      config: expected.config,
      scriptEtag: expected.scriptEtag,
    });
    return true;
  } catch {
    return false;
  }
}

export function isRecordedPreSchemaBridgeVersion(version, expected = {}) {
  try {
    if (
      expected.activityGenerationMode !== "pre-schema"
      || expected.activityGenerationSchema !== null
      || !expected.tag
      || !expected.scriptEtag
      || !expected.config
      || !expected.id
    ) return false;
    const targetVars = expected.config?.vars || {};
    if (Object.hasOwn(targetVars, "ACTIVITY_GENERATION_MODE")) return false;
    assertGuardedVersion(version, {
      id: expected.id,
      target: "production",
      phase: "bridge",
      tag: expected.tag,
      config: expected.config,
      scriptEtag: expected.scriptEtag,
    });
    return true;
  } catch {
    return false;
  }
}

export function isRecordedPreSchemaStagingVersion(version, expected = {}) {
  try {
    if (
      expected.activityGenerationMode !== "pre-schema"
      || expected.activityGenerationSchema !== null
      || !expected.tag
      || !expected.scriptEtag
      || !expected.config
      || !expected.id
    ) return false;
    const targetVars = expected.config?.env?.staging?.vars || {};
    if (Object.hasOwn(targetVars, "ACTIVITY_GENERATION_MODE")) return false;
    assertGuardedVersion(version, {
      id: expected.id,
      target: "staging",
      phase: "all",
      tag: expected.tag,
      config: expected.config,
      scriptEtag: expected.scriptEtag,
    });
    return true;
  } catch {
    return false;
  }
}

export function assertGuardedVersion(version, expected) {
  const expectedMessage = `HA LiveKit relay v2 ${expected.target} ${expected.phase}`;
  const failures = [];
  if (version?.id !== expected.id) failures.push("version ID");
  if (version?.metadata?.source !== "wrangler") failures.push("upload source");
  if (version?.annotations?.["workers/message"] !== expectedMessage) failures.push("phase message");
  if (version?.annotations?.["workers/tag"] !== expected.tag) failures.push("artifact tag");
  const scriptEtag = version?.resources?.script?.etag;
  if (!SCRIPT_ETAG_PATTERN.test(String(scriptEtag || ""))) failures.push("script etag");
  if (expected.scriptEtag && scriptEtag !== expected.scriptEtag) failures.push("receipt script etag");

  const environmentConfig = expected.target === "staging"
    ? expected.config?.env?.staging
    : expected.config;
  if (!environmentConfig) failures.push("environment config");
  const bindings = Array.isArray(version?.resources?.bindings) ? version.resources.bindings : [];
  failures.push(...plainJSONBindingFailures(bindings, environmentConfig?.vars || {}));
  failures.push(...secretBindingFailures(
    bindings,
    environmentConfig?.secrets?.required || []
  ));
  const expectedKV = environmentConfig?.kv_namespaces?.find((item) => item.binding === "TOKENS")?.id;
  const remoteKV = bindings.find((item) => item.name === "TOKENS" && item.type === "kv_namespace");
  if (!remoteKV || remoteKV.namespace_id !== expectedKV) failures.push("TOKENS namespace");
  const expectedRate = String(
    environmentConfig?.ratelimits?.find((item) => item.name === "RATE_LIMITER")?.namespace_id || ""
  );
  const expectedRateSimple = environmentConfig?.ratelimits?.find(
    (item) => item.name === "RATE_LIMITER"
  )?.simple;
  const remoteRate = bindings.find((item) => item.name === "RATE_LIMITER" && item.type === "ratelimit");
  if (!remoteRate || String(remoteRate.namespace_id) !== expectedRate) {
    failures.push("RATE_LIMITER namespace");
  }
  if (Number(remoteRate?.simple?.limit) !== Number(expectedRateSimple?.limit)) {
    failures.push("RATE_LIMITER limit");
  }
  if (Number(remoteRate?.simple?.period) !== Number(expectedRateSimple?.period)) {
    failures.push("RATE_LIMITER period");
  }
  const remoteDO = bindings.find(
    (item) => item.name === "AUTH_STATE" && item.type === "durable_object_namespace"
  );
  if (!remoteDO || remoteDO.class_name !== "RelayAuthState") failures.push("AUTH_STATE binding");
  const expectedWorkerName = expected.target === "staging"
    ? expected.config?.env?.staging?.name
    : expected.config?.name;
  if (!expectedWorkerName) failures.push(`${expected.target} Worker name`);
  if (
    remoteDO?.environment != null
    || (remoteDO?.script_name != null && remoteDO.script_name !== expectedWorkerName)
  ) {
    failures.push(`self-bound ${expected.target} AUTH_STATE scope`);
  }
  const metadataBinding = bindings.find(
    (item) => item.name === "CF_VERSION_METADATA" && item.type === "version_metadata"
  );
  if (!metadataBinding) failures.push("CF_VERSION_METADATA binding");
  if (
    version?.resources?.script_runtime?.compatibility_date
    !== expected.config?.compatibility_date
  ) failures.push("compatibility date");
  if (!compatibilityFlagsMatch(
    version?.resources?.script_runtime?.compatibility_flags,
    environmentConfig?.compatibility_flags ?? expected.config?.compatibility_flags
  )) failures.push("compatibility flags");
  const expectedMigrationTag = expected.config?.migrations?.at(-1)?.tag;
  if (
    expectedMigrationTag
    && version?.resources?.script_runtime?.migration_tag !== expectedMigrationTag
  ) failures.push("Durable Object migration tag");
  if (failures.length > 0) {
    throw new Error(`Worker version metadata mismatch: ${failures.join(", ")}.`);
  }
}

export function assertLegacyContinuityVersion(version, productionConfig) {
  const bindings = Array.isArray(version?.resources?.bindings) ? version.resources.bindings : [];
  const legacyVariables = Object.fromEntries(
    Object.entries(productionConfig?.vars || {}).filter(
      ([name]) => !new Set([
        "ACTIVITY_GENERATION_MODE",
        "V2_PAIRING_MODE",
        "V2_PAIRING_CANARY_INSTANCE_HASHES",
      ]).has(name)
    )
  );
  const failures = plainJSONBindingFailures(
    bindings,
    legacyVariables,
    { optionalNames: LEGACY_OPTIONAL_NEW_VARS }
  );
  const legacyBindingTypes = new Set([
    "plain_text",
    "json",
    "secret_text",
    "kv_namespace",
    "ratelimit",
  ]);
  for (const binding of bindings) {
    if (!legacyBindingTypes.has(binding.type)) {
      failures.push(`unexpected binding ${binding.name || "<unnamed>"}`);
    }
  }
  const expectedKV = productionConfig?.kv_namespaces?.find(
    (item) => item.binding === "TOKENS"
  )?.id;
  const remoteKVs = bindings.filter((item) => item.type === "kv_namespace");
  const remoteKV = remoteKVs.find((item) => item.name === "TOKENS");
  if (
    remoteKVs.length !== 1
    || !remoteKV
    || remoteKV.namespace_id !== expectedKV
  ) failures.push("TOKENS namespace");

  const expectedRate = productionConfig?.ratelimits?.find(
    (item) => item.name === "RATE_LIMITER"
  );
  const remoteRates = bindings.filter((item) => item.type === "ratelimit");
  const remoteRate = remoteRates.find((item) => item.name === "RATE_LIMITER");
  if (remoteRates.length > 1 || (remoteRates.length === 1 && !remoteRate)) {
    failures.push("unexpected rate-limit binding");
  }
  // The historical v1 deployment had no distributed rate-limit binding. If
  // one is present, it must match the tracked production policy exactly.
  if (remoteRate) {
    if (String(remoteRate.namespace_id) !== String(expectedRate?.namespace_id || "")) {
      failures.push("RATE_LIMITER namespace");
    }
    if (Number(remoteRate.simple?.limit) !== Number(expectedRate?.simple?.limit)) {
      failures.push("RATE_LIMITER limit");
    }
    if (Number(remoteRate.simple?.period) !== Number(expectedRate?.simple?.period)) {
      failures.push("RATE_LIMITER period");
    }
  }

  const remoteDO = bindings.find(
    (item) => item.name === "AUTH_STATE" && item.type === "durable_object_namespace"
  );
  if (remoteDO) failures.push("unexpected AUTH_STATE binding");
  if (bindings.some((item) => item.name === "CF_VERSION_METADATA")) {
    failures.push("unexpected CF_VERSION_METADATA binding");
  }
  if (bindings.some((item) => item.name === "DEVICE_CREDENTIAL_PEPPER")) {
    failures.push("unexpected DEVICE_CREDENTIAL_PEPPER secret");
  }
  if (version?.resources?.script_runtime?.migration_tag != null) {
    failures.push("unexpected Durable Object migration tag");
  }

  const relayEnabledIsPlain = bindings.some(
    (item) => item.name === "RELAY_ENABLED"
      && item.type === "plain_text"
      && item.text === "true"
  );
  failures.push(...secretBindingFailures(bindings, [
    "APPLE_PRIVATE_KEY",
    "HA_LIVEKIT_APP_SECRET",
    // The live v1 deployment stored RELAY_ENABLED as a secret. Metadata cannot
    // reveal its value, so the separate legacy health gate must prove it true.
    ...(relayEnabledIsPlain ? [] : ["RELAY_ENABLED"]),
  ]));
  if (
    version?.resources?.script_runtime?.compatibility_date
    !== productionConfig?.compatibility_date
  ) failures.push("compatibility date");
  if (!compatibilityFlagsMatch(
    version?.resources?.script_runtime?.compatibility_flags,
    productionConfig?.compatibility_flags
  )) failures.push("compatibility flags");
  if (failures.length > 0) {
    throw new Error(
      `Legacy production continuity metadata mismatch: ${failures.join(", ")}.`
    );
  }
}

function secretBindingFailures(bindings, expectedSecretNames) {
  const expected = new Set(expectedSecretNames);
  const actual = bindings.filter((item) => item.type === "secret_text");
  const failures = [];
  for (const binding of actual) {
    if (!expected.has(binding.name)) failures.push(`unexpected secret ${binding.name}`);
  }
  for (const name of expected) {
    const matches = actual.filter((item) => item.name === name);
    if (matches.length === 0) failures.push(`secret ${name}`);
    if (matches.length > 1) failures.push(`duplicate secret ${name}`);
  }
  return failures;
}

function compatibilityFlagsMatch(actual, expected) {
  const normalize = (value) => {
    if (value == null) return [];
    if (!Array.isArray(value) || value.some((flag) => typeof flag !== "string")) return undefined;
    return [...value].sort();
  };
  const normalizedActual = normalize(actual);
  const normalizedExpected = normalize(expected);
  return normalizedActual !== undefined
    && normalizedExpected !== undefined
    && isDeepStrictEqual(normalizedActual, normalizedExpected);
}

function plainJSONBindingFailures(
  bindings,
  expectedVariables,
  { optionalNames = new Set() } = {}
) {
  const actual = bindings.filter(
    (item) => item.type === "plain_text" || item.type === "json"
  );
  const expectedNames = new Set(Object.keys(expectedVariables));
  const actualNames = new Set(actual.map((item) => item.name));
  const failures = [];
  for (const binding of actual) {
    if (!expectedNames.has(binding.name)) {
      failures.push(`unexpected binding ${binding.name}`);
    }
  }
  for (const [name, value] of Object.entries(expectedVariables)) {
    const matches = actual.filter((item) => item.name === name);
    if (matches.length === 0) {
      if (!optionalNames.has(name)) failures.push(`missing binding ${name}`);
      continue;
    }
    if (matches.length !== 1 || !variableBindingMatches(matches[0], value)) {
      failures.push(`binding ${name}`);
    }
  }
  if (actualNames.size !== actual.length) failures.push("duplicate plain/json binding names");
  return failures;
}

function variableBindingMatches(binding, expectedValue) {
  if (typeof expectedValue === "string") {
    return binding.type === "plain_text" && binding.text === expectedValue;
  }
  return binding.type === "json" && isDeepStrictEqual(binding.json, expectedValue);
}

function requireScriptEtag(version) {
  const etag = version?.resources?.script?.etag;
  if (!SCRIPT_ETAG_PATTERN.test(String(etag || ""))) {
    throw new Error("The exact deployed version did not include a usable server script etag.");
  }
  return etag;
}

function runLocalWorkerVerification() {
  for (const script of ["check", "test"]) {
    const executable = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(executable, ["run", script], {
      cwd: workerDir,
      encoding: "utf8",
      env: wranglerChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: WRANGLER_COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.error?.code === "ETIMEDOUT") {
      throw new Error(`Local Worker ${script} gate timed out.`);
    }
    if (result.error) {
      throw new Error(`Local Worker ${script} gate failed to run: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      throw new Error(`Local Worker ${script} gate failed.\n${output}`);
    }
  }
  console.log("Local Worker syntax and test gates passed.");
}

function runWrangler(args, { capture = false } = {}) {
  assertRegisteredWranglerFiles(args);
  return runBoundedSubprocess(localWranglerPath, args, {
    cwd: workerDir,
    env: wranglerChildEnvironment(process.env, { captureOutput: capture }),
    capture,
    timeoutMs: WRANGLER_COMMAND_TIMEOUT_MS,
    label: "Wrangler command",
  });
}

export function runBoundedSubprocess(
  executable,
  args,
  {
    cwd = workerDir,
    env = process.env,
    capture = true,
    timeoutMs = WRANGLER_COMMAND_TIMEOUT_MS,
    label = "Subprocess",
  } = {}
) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${label} timed out after ${timeoutMs} ms.`);
  }
  if (result.error) {
    throw new Error(`${label} failed to start or complete: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const message = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(message || `${label} failed.`);
  }
  return result.stdout || result.stderr || "";
}

export function wranglerChildEnvironment(
  baseEnvironment = process.env,
  { captureOutput = false } = {}
) {
  const environment = { ...baseEnvironment };
  for (const key of [
    "CLOUDFLARE_ACCOUNT_ID",
    "CF_ACCOUNT_ID",
    "CLOUDFLARE_API_BASE_URL",
    "CF_API_BASE_URL",
    "WRANGLER_API_ENVIRONMENT",
    "CLOUDFLARE_COMPLIANCE_REGION",
    "CLOUDFLARE_ENV",
    "WRANGLER_CI_OVERRIDE_NAME",
    "WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST",
    "WRANGLER_CI_MATCH_TAG",
    "WRANGLER_CI_GENERATE_PREVIEW_ALIAS",
    "WORKERS_CI_BRANCH",
    "WRANGLER_AUTH_DOMAIN",
    "WRANGLER_AUTH_URL",
    "WRANGLER_TOKEN_URL",
    "WRANGLER_REVOKE_URL",
    "WRANGLER_CLIENT_ID",
    "WRANGLER_BUILD_CONDITIONS",
    "WRANGLER_BUILD_PLATFORM",
    "WRANGLER_LOG_PATH",
    "WRANGLER_WRITE_LOGS",
    "WRANGLER_OUTPUT_FILE_DIRECTORY",
    "WRANGLER_OUTPUT_FILE_PATH",
    "WRANGLER_TRACE_ID",
    "APPLE_PRIVATE_KEY",
    "HA_LIVEKIT_APP_SECRET",
    "HA_LIVEKIT_SHARED_SECRET",
    "DEVICE_CREDENTIAL_PEPPER",
    "APPLE_TEAM_ID",
    "APPLE_KEY_ID",
    "APP_BUNDLE_ID",
    "APNS_ENVIRONMENT",
    "WORKER_HEALTH_URL",
    "STAGING_WORKER_HEALTH_URL",
    "STAGING_KV_NAMESPACE_ID",
    "STAGING_RATE_LIMIT_NAMESPACE_ID",
    "EXPECTED_CLOUDFLARE_ACCOUNT_ID",
    "STAGING_EXPECTED_CLOUDFLARE_ACCOUNT_ID",
    "V2_PAIRING_CANARY_INSTANCE_HASHES",
    "BRIDGE_VERSION_ID",
    "BRIDGE_ARTIFACT_SHA256",
    "BRIDGE_SCRIPT_ETAG",
    "STAGING_PROOF_VERSION_ID",
    "STAGING_PROOF_ARTIFACT_SHA256",
    "STAGING_PROOF_SCRIPT_ETAG",
  ]) {
    delete environment[key];
  }
  return Object.assign(environment, {
    CLOUDFLARE_API_BASE_URL: CLOUDFLARE_PUBLIC_API_BASE_URL,
    CLOUDFLARE_COMPLIANCE_REGION: "public",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_API_ENVIRONMENT: "production",
    WRANGLER_HIDE_BANNER: "true",
    // Wrangler 4.110 suppresses even successful --json stdout at the error
    // level. Captured metadata/deploy commands therefore need the normal log
    // level, while sanitization and output-path restrictions remain enforced.
    WRANGLER_LOG: captureOutput ? "log" : "error",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_SEND_METRICS: "false",
  });
}

function assertPinnedWrangler() {
  if (!existsSync(localWranglerPath)) {
    throw new Error("Pinned Wrangler is not installed. Run npm ci before rollout.");
  }
  const output = runBoundedSubprocess(localWranglerPath, ["--version"], {
    cwd: workerDir,
    env: { ...wranglerChildEnvironment(), WRANGLER_LOG: "log" },
    timeoutMs: 10_000,
    label: "Pinned Wrangler version check",
  });
  const version = output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (version !== PINNED_WRANGLER_VERSION) {
    throw new Error(`Expected Wrangler ${PINNED_WRANGLER_VERSION}; found ${version || "unknown"}.`);
  }
}

function parseJSONC(text) {
  return JSON.parse(
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
