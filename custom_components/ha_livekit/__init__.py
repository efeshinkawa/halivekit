"""HA LiveKit custom integration."""

from __future__ import annotations

import json
import logging
import re
import secrets
from typing import Any
from urllib.parse import urlsplit

from aiohttp import ClientTimeout
import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError, Unauthorized, UnknownUser
import homeassistant.helpers.config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession

try:
    from homeassistant.auth.permissions.const import POLICY_READ
except ImportError:  # pragma: no cover - compatibility with older HA import path.
    from homeassistant.permissions.const import POLICY_READ

from .const import (
    ACTION_END,
    ACTION_START,
    ACTION_UPDATE,
    ATTR_ACTIVITY_ID,
    ATTR_DATA,
    ATTR_DEVICE_ID,
    ATTR_DISPLAY_NAME,
    ATTR_END_WHEN,
    ATTR_ENTITY_ID,
    ATTR_ICON_NAME,
    ATTR_PROGRESS,
    ATTR_PROGRESS_ENTITY_ID,
    ATTR_REASON,
    ATTR_STATE,
    ATTR_SUBTITLE,
    ATTR_TEMPLATE,
    ATTR_TITLE,
    CONF_RELAY_ENABLED,
    CONF_RELAY_APP_REGISTRATION_SECRET,
    CONF_RELAY_ENVIRONMENT,
    CONF_RELAY_MODE,
    CONF_RELAY_SHARED_SECRET,
    CONF_RELAY_URL,
    CONF_HOME_ASSISTANT_INSTANCE_ID,
    DOMAIN,
    MANAGED_RELAY_URL,
    PLATFORMS,
    RELAY_ENVIRONMENT_PRODUCTION,
    RELAY_ENVIRONMENT_SANDBOX,
    RELAY_MODE_MANAGED,
    SERVICE_CONFIGURE_MANAGED_RELAY,
    SERVICE_END_ACTIVITY,
    SERVICE_SET_ACTIVITY,
    SERVICE_START_ACTIVITY,
    SERVICE_START_ENTITY_ACTIVITY,
    SERVICE_UPDATE_ACTIVITY,
    SERVICE_UPDATE_ENTITY_ACTIVITY,
)
from .coordinator import HALiveKitCoordinator
from .entity_activity import build_entity_activity_payload
from .webhook import async_register_webhook

_LOGGER = logging.getLogger(__name__)
_SERVICES_REGISTERED = "_services_registered"
_APP_SECRET_HEADER = "X-HA-LiveKit-App-Secret"
_DUPLICATE_ACTIVITY_NAME_ERROR = "duplicate_activity_name"
_DUPLICATE_ACTIVITY_NAME_MESSAGE = "An active Live Activity with this name already exists. Please choose another name."
_ENTITY_ID_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]+$")
_GENERIC_ENTITY_REFERENCE_KEYS = {
    ATTR_ENTITY_ID,
    ATTR_PROGRESS_ENTITY_ID,
    "entityId",
    "primaryEntity",
    "primaryEntityId",
    "primary_entity",
    "primary_entity_id",
    "progressEntityId",
    "secondaryEntity",
    "secondaryEntityId",
    "secondary_entity",
    "secondary_entity_id",
}


START_ACTIVITY_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_DEVICE_ID): cv.string,
        vol.Required(ATTR_ACTIVITY_ID): cv.string,
        vol.Optional(ATTR_ENTITY_ID): cv.entity_id,
        vol.Optional(ATTR_TITLE): cv.string,
        vol.Optional(ATTR_DISPLAY_NAME): cv.string,
        vol.Optional(ATTR_SUBTITLE): cv.string,
        vol.Optional(ATTR_TEMPLATE, default="custom"): cv.string,
        vol.Optional(ATTR_STATE): cv.string,
        vol.Optional(ATTR_PROGRESS): vol.Coerce(float),
        vol.Optional(ATTR_DATA, default=dict): dict,
    }
)

UPDATE_ACTIVITY_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_DEVICE_ID): cv.string,
        vol.Required(ATTR_ACTIVITY_ID): cv.string,
        vol.Optional(ATTR_ENTITY_ID): cv.entity_id,
        vol.Optional(ATTR_TITLE): cv.string,
        vol.Optional(ATTR_DISPLAY_NAME): cv.string,
        vol.Optional(ATTR_SUBTITLE): cv.string,
        vol.Optional(ATTR_TEMPLATE): cv.string,
        vol.Optional(ATTR_STATE): cv.string,
        vol.Optional(ATTR_PROGRESS): vol.Coerce(float),
        vol.Optional(ATTR_DATA, default=dict): dict,
    }
)

SET_ACTIVITY_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_DEVICE_ID): cv.string,
        vol.Required(ATTR_ACTIVITY_ID): cv.string,
        vol.Optional(ATTR_ENTITY_ID): cv.entity_id,
        vol.Optional(ATTR_TITLE): cv.string,
        vol.Optional(ATTR_DISPLAY_NAME): cv.string,
        vol.Optional(ATTR_SUBTITLE): cv.string,
        vol.Optional(ATTR_TEMPLATE, default="custom"): cv.string,
        vol.Optional(ATTR_STATE): cv.string,
        vol.Optional(ATTR_PROGRESS): vol.Coerce(float),
        vol.Optional(ATTR_PROGRESS_ENTITY_ID): cv.entity_id,
        vol.Optional(ATTR_ICON_NAME): cv.string,
        vol.Optional(ATTR_END_WHEN): vol.Any(cv.string, dict),
        vol.Optional(ATTR_DATA, default=dict): dict,
    }
)

END_ACTIVITY_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_DEVICE_ID): cv.string,
        vol.Required(ATTR_ACTIVITY_ID): cv.string,
        vol.Optional(ATTR_REASON, default="ended"): cv.string,
    }
)

ENTITY_ACTIVITY_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_DEVICE_ID): cv.string,
        vol.Optional(ATTR_ACTIVITY_ID): cv.string,
        vol.Required(ATTR_ENTITY_ID): cv.entity_id,
        vol.Optional(ATTR_TEMPLATE): cv.string,
        vol.Optional(ATTR_DISPLAY_NAME): cv.string,
        vol.Optional(ATTR_TITLE): cv.string,
        vol.Optional(ATTR_SUBTITLE): cv.string,
        vol.Optional(ATTR_PROGRESS_ENTITY_ID): cv.entity_id,
        vol.Optional(ATTR_PROGRESS): vol.Coerce(float),
        vol.Optional(ATTR_ICON_NAME): cv.string,
        vol.Optional(ATTR_END_WHEN): vol.Any(cv.string, dict),
    }
)

CONFIGURE_MANAGED_RELAY_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_RELAY_URL): cv.string,
        vol.Optional(CONF_RELAY_SHARED_SECRET): cv.string,
        vol.Optional(CONF_RELAY_APP_REGISTRATION_SECRET): cv.string,
        vol.Optional(CONF_RELAY_ENVIRONMENT, default=RELAY_ENVIRONMENT_SANDBOX): vol.In(
            [RELAY_ENVIRONMENT_SANDBOX, RELAY_ENVIRONMENT_PRODUCTION]
        ),
        vol.Required(CONF_HOME_ASSISTANT_INSTANCE_ID): cv.string,
    }
)


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Set up HA LiveKit services."""
    hass.data.setdefault(DOMAIN, {})
    _async_register_services(hass)

    return True


def _async_register_services(hass: HomeAssistant) -> None:
    """Register HA LiveKit services once."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    expected_services = {
        SERVICE_START_ACTIVITY,
        SERVICE_UPDATE_ACTIVITY,
        SERVICE_SET_ACTIVITY,
        SERVICE_END_ACTIVITY,
        SERVICE_START_ENTITY_ACTIVITY,
        SERVICE_UPDATE_ENTITY_ACTIVITY,
        SERVICE_CONFIGURE_MANAGED_RELAY,
    }
    if domain_data.get(_SERVICES_REGISTERED) and all(
        hass.services.has_service(DOMAIN, service) for service in expected_services
    ):
        return

    async def handle_start(call: ServiceCall) -> None:
        await _handle_service(hass, ACTION_START, call)

    async def handle_update(call: ServiceCall) -> None:
        await _handle_service(hass, ACTION_UPDATE, call)

    async def handle_set(call: ServiceCall) -> None:
        await _handle_set_activity(hass, call)

    async def handle_end(call: ServiceCall) -> None:
        await _handle_service(hass, ACTION_END, call)

    async def handle_start_entity(call: ServiceCall) -> None:
        await _handle_entity_service(hass, ACTION_START, call, SERVICE_START_ENTITY_ACTIVITY)

    async def handle_update_entity(call: ServiceCall) -> None:
        await _handle_entity_service(hass, ACTION_UPDATE, call, SERVICE_UPDATE_ENTITY_ACTIVITY)

    async def handle_configure_managed_relay(call: ServiceCall) -> None:
        await _handle_configure_managed_relay(hass, call)

    services = (
        (SERVICE_START_ACTIVITY, handle_start, START_ACTIVITY_SCHEMA),
        (SERVICE_UPDATE_ACTIVITY, handle_update, UPDATE_ACTIVITY_SCHEMA),
        (SERVICE_SET_ACTIVITY, handle_set, SET_ACTIVITY_SCHEMA),
        (SERVICE_END_ACTIVITY, handle_end, END_ACTIVITY_SCHEMA),
        (SERVICE_START_ENTITY_ACTIVITY, handle_start_entity, ENTITY_ACTIVITY_SCHEMA),
        (SERVICE_UPDATE_ENTITY_ACTIVITY, handle_update_entity, ENTITY_ACTIVITY_SCHEMA),
        (
            SERVICE_CONFIGURE_MANAGED_RELAY,
            handle_configure_managed_relay,
            CONFIGURE_MANAGED_RELAY_SCHEMA,
        ),
    )
    for service, handler, schema in services:
        if not hass.services.has_service(DOMAIN, service):
            if service == SERVICE_CONFIGURE_MANAGED_RELAY:
                admin_register = getattr(
                    getattr(getattr(hass, "helpers", None), "service", None),
                    "async_register_admin_service",
                    None,
                )
                if admin_register is not None:
                    admin_register(DOMAIN, service, handler, schema)
                    continue
            hass.services.async_register(DOMAIN, service, handler, schema=schema)

    domain_data[_SERVICES_REGISTERED] = True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up HA LiveKit from a config entry."""
    _async_register_services(hass)
    coordinator = HALiveKitCoordinator(hass, entry)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    async_register_webhook(hass, entry, coordinator)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload HA LiveKit."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok


async def _handle_service(
    hass: HomeAssistant,
    action: str,
    call: ServiceCall,
) -> None:
    payload = dict(call.data)
    coordinator = _get_coordinator(hass)
    await _async_require_generic_activity_permissions(hass, call, payload)
    result = await coordinator.async_send_activity(action, payload)
    _raise_if_duplicate_activity_name_rejected(result)


async def _handle_entity_service(
    hass: HomeAssistant,
    action: str,
    call: ServiceCall,
    source_service: str,
) -> None:
    payload = dict(call.data)
    await _async_require_entity_read_permissions(
        hass,
        call,
        [
            str(payload[ATTR_ENTITY_ID]).strip(),
            str(payload.get(ATTR_PROGRESS_ENTITY_ID, "")).strip(),
        ],
    )
    entity_payload = build_entity_activity_payload(hass, payload, source_service)
    if entity_payload is None:
        return

    coordinator = _get_coordinator(hass)
    result = await coordinator.async_send_activity(action, entity_payload)
    _raise_if_duplicate_activity_name_rejected(result)


async def _handle_set_activity(
    hass: HomeAssistant,
    call: ServiceCall,
) -> None:
    payload = dict(call.data)
    entity_id = str(payload.get(ATTR_ENTITY_ID, "")).strip()

    if entity_id:
        await _async_require_entity_read_permissions(
            hass,
            call,
            [
                entity_id,
                str(payload.get(ATTR_PROGRESS_ENTITY_ID, "")).strip(),
            ],
        )
        entity_payload = build_entity_activity_payload(hass, payload, SERVICE_SET_ACTIVITY)
        if entity_payload is None:
            return

        coordinator = _get_coordinator(hass)
        result = await coordinator.async_send_activity(ACTION_START, entity_payload)
        _raise_if_duplicate_activity_name_rejected(result)
        return

    coordinator = _get_coordinator(hass)
    result = await coordinator.async_send_activity(ACTION_START, payload)
    _raise_if_duplicate_activity_name_rejected(result)


async def _handle_configure_managed_relay(
    hass: HomeAssistant,
    call: ServiceCall,
) -> None:
    await _async_require_admin_user(hass, call)

    payload = dict(call.data)
    coordinator = _get_coordinator(hass)
    relay_url = str(payload[CONF_RELAY_URL]).strip()
    relay_secret = str(payload.get(CONF_RELAY_SHARED_SECRET) or "").strip()
    relay_app_registration_secret = str(payload.get(CONF_RELAY_APP_REGISTRATION_SECRET) or "").strip()
    home_assistant_instance_id = str(payload[CONF_HOME_ASSISTANT_INSTANCE_ID]).strip()

    parsed = urlsplit(relay_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HomeAssistantError("Invalid managed relay URL")
    if not _is_allowed_managed_relay_url(relay_url):
        raise HomeAssistantError("Managed relay URL is not allowed")
    if not _valid_home_assistant_instance_id(home_assistant_instance_id):
        raise HomeAssistantError("Managed relay Home Assistant instance ID is invalid")
    if not relay_secret and not relay_app_registration_secret:
        raise HomeAssistantError("Managed relay provisioning secret is required")

    current_relay_secret = coordinator.relay_shared_secret.strip()
    if relay_app_registration_secret:
        relay_secret = secrets.token_urlsafe(32)
        await _async_provision_managed_relay_secret(
            hass,
            relay_url,
            relay_app_registration_secret,
            home_assistant_instance_id,
            relay_secret,
            current_relay_secret,
        )

    entry = coordinator.config_entry
    options = {
        **entry.options,
        CONF_RELAY_ENABLED: True,
        CONF_RELAY_MODE: RELAY_MODE_MANAGED,
        CONF_RELAY_URL: relay_url,
        CONF_RELAY_SHARED_SECRET: relay_secret,
        CONF_RELAY_ENVIRONMENT: payload.get(CONF_RELAY_ENVIRONMENT, RELAY_ENVIRONMENT_SANDBOX),
        CONF_HOME_ASSISTANT_INSTANCE_ID: home_assistant_instance_id,
    }
    hass.config_entries.async_update_entry(entry, options=options)
    coordinator.async_update_listeners()
    _LOGGER.info(
        "HA LiveKit managed relay configured from iOS app: relay_url_present=%s secret_present=%s environment=%s",
        bool(relay_url),
        bool(relay_secret),
        options[CONF_RELAY_ENVIRONMENT],
    )


async def _async_require_admin_user(hass: HomeAssistant, call: ServiceCall) -> None:
    """Reject service calls from known non-admin users before config mutation."""
    user_id = getattr(call.context, "user_id", None)
    if not user_id:
        return

    user = await hass.auth.async_get_user(user_id)
    if user is None:
        raise UnknownUser(context=call.context, user_id=user_id)
    if not user.is_admin:
        raise Unauthorized(context=call.context, user_id=user_id)


async def _async_require_entity_read_permissions(
    hass: HomeAssistant,
    call: ServiceCall,
    entity_ids: list[str],
) -> None:
    """Reject unauthorized entity-state reads before accessing the state machine."""
    requested_entity_ids = [entity_id for entity_id in entity_ids if entity_id]
    if not requested_entity_ids:
        return

    user_id = getattr(call.context, "user_id", None)
    if not user_id:
        return

    user = await hass.auth.async_get_user(user_id)
    if user is None:
        raise UnknownUser(context=call.context, user_id=user_id, permission=POLICY_READ)
    if user.is_admin:
        return

    for entity_id in requested_entity_ids:
        if not user.permissions.check_entity(entity_id, POLICY_READ):
            raise Unauthorized(
                context=call.context,
                user_id=user_id,
                entity_id=entity_id,
                permission=POLICY_READ,
            )


async def _async_require_generic_activity_permissions(
    hass: HomeAssistant,
    call: ServiceCall,
    payload: dict[str, Any],
) -> None:
    """Reject generic activity calls that reference unreadable entity state."""
    await _async_require_entity_read_permissions(
        hass,
        call,
        _generic_activity_entity_ids(hass, payload),
    )


def _generic_activity_entity_ids(hass: HomeAssistant, payload: dict[str, Any]) -> list[str]:
    """Return entity ids a generic activity request can render or mutate."""
    entity_ids: list[str] = []
    entity_ids.extend(_payload_entity_references(payload))

    activity_id = _clean_string(payload.get(ATTR_ACTIVITY_ID))
    if activity_id:
        entity_ids.extend(_entity_ids_for_activity_id(hass, activity_id))

    return _dedupe_entity_ids(entity_ids)


def _payload_entity_references(payload: dict[str, Any]) -> list[str]:
    entity_ids: list[str] = []
    entity_ids.extend(_entity_references_from_mapping(payload))

    data = payload.get(ATTR_DATA)
    if isinstance(data, dict):
        entity_ids.extend(_entity_references_from_mapping(data))

    return entity_ids


def _entity_references_from_mapping(mapping: dict[str, Any]) -> list[str]:
    entity_ids: list[str] = []
    for key in _GENERIC_ENTITY_REFERENCE_KEYS:
        if key in mapping:
            entity_ids.extend(_entity_references_from_value(mapping[key]))
    return entity_ids


def _entity_references_from_value(value: Any) -> list[str]:
    if isinstance(value, str):
        entity_id = value.strip()
        return [entity_id] if _ENTITY_ID_PATTERN.match(entity_id) else []
    if isinstance(value, dict):
        entity_ids: list[str] = []
        for item in value.values():
            entity_ids.extend(_entity_references_from_value(item))
        return entity_ids
    if isinstance(value, (list, tuple, set)):
        entity_ids = []
        for item in value:
            entity_ids.extend(_entity_references_from_value(item))
        return entity_ids
    return []


def _entity_ids_for_activity_id(hass: HomeAssistant, activity_id: str) -> list[str]:
    states = getattr(hass, "states", None)
    async_all = getattr(states, "async_all", None)
    if async_all is None:
        return []

    entity_ids: list[str] = []
    for state in async_all():
        entity_id = str(getattr(state, "entity_id", "")).strip()
        if entity_id and (
            entity_id == activity_id or _activity_id_from_entity_id(entity_id) == activity_id
        ):
            entity_ids.append(entity_id)
    return entity_ids


def _activity_id_from_entity_id(entity_id: str) -> str:
    object_id = entity_id.split(".", 1)[-1]
    value = re.sub(r"[^A-Za-z0-9_-]+", "_", object_id).strip("_")
    value = re.sub(r"_+", "_", value)
    return value or "ha_livekit_activity"


def _dedupe_entity_ids(entity_ids: list[str]) -> list[str]:
    deduped: list[str] = []
    for entity_id in entity_ids:
        if entity_id and entity_id not in deduped:
            deduped.append(entity_id)
    return deduped


def _clean_string(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


async def _async_provision_managed_relay_secret(
    hass: HomeAssistant,
    relay_url: str,
    relay_app_registration_secret: str,
    home_assistant_instance_id: str,
    relay_secret: str,
    current_relay_secret: str,
) -> None:
    """Provision or rotate the HA-owned relay secret before saving config."""
    session = async_get_clientsession(hass)
    body: dict[str, Any] = {
        CONF_HOME_ASSISTANT_INSTANCE_ID: home_assistant_instance_id,
        "instance_id_version": 2,
        CONF_RELAY_SHARED_SECRET: relay_secret,
    }
    if current_relay_secret:
        body["current_relay_shared_secret"] = current_relay_secret

    try:
        async with session.post(
            f"{relay_url.rstrip('/')}/provision-instance",
            data=json.dumps(body, separators=(",", ":"), sort_keys=True).encode(),
            headers={
                "Content-Type": "application/json",
                _APP_SECRET_HEADER: relay_app_registration_secret,
            },
            timeout=ClientTimeout(total=10),
        ) as response:
            text = await response.text()
            if response.status >= 400:
                raise HomeAssistantError(
                    f"Managed relay provisioning failed: HTTP {response.status}: {_safe_response_summary(text)}"
                )
    except HomeAssistantError:
        raise
    except Exception as err:  # noqa: BLE001 - surface relay provisioning failures to the admin caller.
        raise HomeAssistantError(f"Managed relay provisioning failed: {err}") from err


def _get_coordinator(hass: HomeAssistant) -> HALiveKitCoordinator:
    entries = hass.data.get(DOMAIN, {})
    for coordinator in entries.values():
        if isinstance(coordinator, HALiveKitCoordinator):
            return coordinator

    raise HomeAssistantError("HA LiveKit is not configured")


def _raise_if_duplicate_activity_name_rejected(result: Any) -> None:
    """Surface explicit duplicate-name relay rejections without changing relay-outage tolerance."""
    if result is None:
        return

    relay_status_code = getattr(result, "relay_status_code", None)
    relay_error = str(getattr(result, "relay_error", "") or "")
    if relay_status_code == 409 and _DUPLICATE_ACTIVITY_NAME_ERROR in relay_error:
        raise HomeAssistantError(_DUPLICATE_ACTIVITY_NAME_MESSAGE)


def _valid_home_assistant_instance_id(value: str) -> bool:
    """Return whether an iOS-provisioned HA instance id is safe to use."""
    return bool(value) and value.startswith("ha_") and len(value) == 35 and all(
        character in "0123456789abcdef" for character in value[3:]
    )


def _is_allowed_managed_relay_url(value: str) -> bool:
    """Return whether the managed relay auto-config URL is the expected origin."""
    expected = MANAGED_RELAY_URL.strip().rstrip("/")
    return bool(expected) and value.strip().rstrip("/") == expected


def _safe_response_summary(text: str) -> str:
    """Return a short relay response summary without secrets."""
    if not text:
        return "empty response"
    redacted = re.sub(
        r'(?i)("?(?:relay_shared_secret|home_assistant_relay_token|home_assistant_relay_secret|relay_app_registration_secret|token|secret)"?\s*:\s*"?)[^",}\s]+',
        r"\1<redacted>",
        text,
    )
    return redacted[:240]
