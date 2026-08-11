"""Constants for HA LiveKit."""

from __future__ import annotations

from homeassistant.const import Platform

DOMAIN = "ha_livekit"
VERSION = "2.1.1"

CONF_SHARED_SECRET = "shared_secret"
CONF_PUSH_ENDPOINT_URL = "push_endpoint_url"
CONF_RELAY_ENABLED = "relay_enabled"
CONF_RELAY_MODE = "relay_mode"
CONF_RELAY_URL = "relay_url"
CONF_RELAY_SHARED_SECRET = "relay_shared_secret"
CONF_RELAY_APP_REGISTRATION_SECRET = "relay_app_registration_secret"
CONF_RELAY_ENVIRONMENT = "relay_environment"
CONF_HOME_ASSISTANT_INSTANCE_ID = "home_assistant_instance_id"
CONF_PENDING_MANAGED_RELAY_INSTANCE_ID = "pending_managed_relay_instance_id"
CONF_PENDING_MANAGED_RELAY_SHARED_SECRET = "pending_managed_relay_shared_secret"
CONF_DEVICE_ID = "device_id"
CONF_ALLOW_LEGACY_WEBHOOK_SECRET = "allow_legacy_webhook_secret"

UNSAFE_HOME_ASSISTANT_INSTANCE_IDS = frozenset(
    {"ha_980c4bd6a677da0511813adb8c98192e"}
)

RELAY_MODE_MANAGED = "managed"
RELAY_MODE_CUSTOM = "custom"
RELAY_ENVIRONMENT_SANDBOX = "sandbox"
RELAY_ENVIRONMENT_PRODUCTION = "production"

MANAGED_RELAY_URL = "https://ha-livekit-apns-relay.erimefe-it.workers.dev"
MANAGED_RELAY_SHARED_SECRET = ""

WEBHOOK_ID = "ha_livekit_update"
WEBHOOK_PATH = f"/api/webhook/{WEBHOOK_ID}"

HEADER_SIGNATURE = "X-HA-LiveKit-Signature"
HEADER_SECRET = "X-HA-LiveKit-Secret"
HEADER_TIMESTAMP = "X-HA-LiveKit-Timestamp"
HEADER_NONCE = "X-HA-LiveKit-Nonce"

WEBHOOK_MAX_CLOCK_SKEW_SECONDS = 300
WEBHOOK_REPLAY_CACHE_TTL_SECONDS = 600
WEBHOOK_REPLAY_CACHE_MAX_ENTRIES = 4096

EVENT_ACTIVITY_REQUEST = "ha_livekit_activity_request"

SERVICE_START_ACTIVITY = "start_activity"
SERVICE_UPDATE_ACTIVITY = "update_activity"
SERVICE_SET_ACTIVITY = "set_activity"
SERVICE_END_ACTIVITY = "end_activity"
SERVICE_START_ENTITY_ACTIVITY = "start_entity_activity"
SERVICE_UPDATE_ENTITY_ACTIVITY = "update_entity_activity"
SERVICE_CONFIGURE_MANAGED_RELAY = "configure_managed_relay"

ATTR_DEVICE_ID = "device_id"
ATTR_ACTIVITY_ID = "activity_id"
ATTR_TITLE = "title"
ATTR_DISPLAY_NAME = "display_name"
ATTR_SUBTITLE = "subtitle"
ATTR_ENTITY_ID = "entity_id"
ATTR_TEMPLATE = "template"
ATTR_DATA = "data"
ATTR_STATE = "state"
ATTR_PROGRESS = "progress"
ATTR_PROGRESS_ENTITY_ID = "progress_entity_id"
ATTR_ICON_NAME = "icon_name"
ATTR_ALLOW_ENTITY_CONTROL = "allow_entity_control"
ATTR_REASON = "reason"
ATTR_END_WHEN = "end_when"

ACTION_START = "start"
ACTION_UPDATE = "update"
ACTION_END = "end"

PLATFORMS = [Platform.SENSOR]
