#!/bin/sh
# ci_post_clone.sh — Xcode Cloud post-clone step for HA LiveKit.
#
# Regenerates the gitignored Config/LocalSecrets.xcconfig from Xcode Cloud
# secret environment variables, because that file is intentionally NOT in git.
# The app's Info.plist bakes these values in at build time:
#   $(HALIVEKIT_MANAGED_RELAY_URL), $(HALIVEKIT_MANAGED_RELAY_APP_KEY),
#   $(HALIVEKIT_RELAY_ENVIRONMENT)
#
# Required Xcode Cloud environment variables (mark as Secret in the workflow):
#   HALIVEKIT_MANAGED_RELAY_URL       e.g. https://your-relay.example.workers.dev
#   HALIVEKIT_MANAGED_RELAY_APP_KEY   the relay app registration secret
#   HALIVEKIT_RELAY_ENVIRONMENT       optional; defaults to "production"
#
# Notes:
# - Secret values are NEVER echoed to the build log.
# - xcconfig treats "//" as a comment, so any "//" in a value is written using
#   the empty-substitution escape "/$()/" (which expands back to "//"),
#   matching the existing local Config/LocalSecrets.xcconfig format.

set -eu

# HA LiveKit 2.1 is intentionally released with Xcode 26.5. Fail before
# credentials are materialized or compilation starts if the server-side
# workflow drifts to a different Xcode image.
REQUIRED_XCODE_VERSION="26.5"
ACTUAL_XCODE_VERSION="$(/usr/bin/xcodebuild -version | /usr/bin/awk 'NR == 1 { print $2 }')"
if [ "${ACTUAL_XCODE_VERSION}" != "${REQUIRED_XCODE_VERSION}" ]; then
  echo "ci_post_clone: ERROR - Xcode ${REQUIRED_XCODE_VERSION} is required; workflow selected Xcode ${ACTUAL_XCODE_VERSION}." >&2
  exit 1
fi
echo "ci_post_clone: verified Xcode ${ACTUAL_XCODE_VERSION}."

# --- locate the cloned repository root (Xcode Cloud provides these) ---
REPO_ROOT="${CI_PRIMARY_REPOSITORY_PATH:-${CI_WORKSPACE:-}}"
if [ -z "${REPO_ROOT}" ]; then
  # Fallback: this script lives in <repo>/ci_scripts/, so the repo root is its parent.
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

DEST="${REPO_ROOT}/ios/HA LiveKit/Config/LocalSecrets.xcconfig"

# --- validate required secrets (report NAMES only, never values) ---
missing=""
[ -n "${HALIVEKIT_MANAGED_RELAY_URL:-}" ]     || missing="${missing} HALIVEKIT_MANAGED_RELAY_URL"
[ -n "${HALIVEKIT_MANAGED_RELAY_APP_KEY:-}" ] || missing="${missing} HALIVEKIT_MANAGED_RELAY_APP_KEY"
if [ -n "${missing}" ]; then
  echo "ci_post_clone: ERROR - missing required secret environment variable(s):${missing}" >&2
  echo "ci_post_clone: add them as secret environment variables to the Xcode Cloud workflow." >&2
  exit 1
fi

RELAY_ENV="${HALIVEKIT_RELAY_ENVIRONMENT:-production}"

# --- escape "//" as "/$()/" so xcconfig does not treat the rest of the line
#     as a comment; safe no-op for values that contain no "//" ---
escape_xcconfig() {
  printf '%s' "$1" | sed 's#//#/$()/#g'
}

URL_ESCAPED="$(escape_xcconfig "${HALIVEKIT_MANAGED_RELAY_URL}")"
KEY_ESCAPED="$(escape_xcconfig "${HALIVEKIT_MANAGED_RELAY_APP_KEY}")"
ENV_ESCAPED="$(escape_xcconfig "${RELAY_ENV}")"

# --- write the xcconfig (no secret value is printed) ---
mkdir -p "$(dirname "${DEST}")"
{
  printf '%s\n' "// Gitignored local managed relay overrides."
  printf '%s\n' "HALIVEKIT_MANAGED_RELAY_URL = ${URL_ESCAPED}"
  printf '%s\n' "HALIVEKIT_MANAGED_RELAY_APP_KEY = ${KEY_ESCAPED}"
  printf '%s\n' "HALIVEKIT_RELAY_ENVIRONMENT = ${ENV_ESCAPED}"
} > "${DEST}"

echo "ci_post_clone: wrote ios/HA LiveKit/Config/LocalSecrets.xcconfig (3 settings; values redacted)."
