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
    CONF_PENDING_MANAGED_RELAY_INSTANCE_ID,
    CONF_PENDING_MANAGED_RELAY_SHARED_SECRET,
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
    UNSAFE_HOME_ASSISTANT_INSTANCE_IDS,
)
from .coordinator import HALiveKitCoordinator
from .entity_activity import build_entity_activity_payload
from .pairing import async_register_pairing_view
from .security import PayloadValidationError, validate_activity_payload
from .webhook import async_register_webhook

_LOGGER = logging.getLogger(__name__)
_SERVICES_REGISTERED = "_services_registered"
_APP_SECRET_HEADER = "X-HA-LiveKit-App-Secret"
_DUPLICATE_ACTIVITY_NAME_ERROR = "duplicate_activity_name"
_DUPLICATE_ACTIVITY_NAME_MESSAGE = "An active Live Activity with this name already exists. Please choose another name."
_MAX_MANAGED_RELAY_RESPONSE_BYTES = 32 * 1024
_LIMITED_ENTITY_ACTIVITY_FIELDS = {
    ATTR_ACTIVITY_ID,
    ATTR_DEVICE_ID,
    ATTR_ENTITY_ID,
    ATTR_PROGRESS_ENTITY_ID,
    ATTR_TEMPLATE,
}
_SAFE_ENTITY_TEMPLATES = {
    "custom",
    "progress",
    "door",
    "laundry",
    "washing_machine",
    "dishwasher",
    "vacuum",
    "security",
    "climate",
    "energy",
    "timer",
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
    async_register_pairing_view(hass)

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
    _validate_activity_service_payload(payload)
    await _async_require_generic_activity_permissions(hass, call, payload)
    coordinator = _get_coordinator(hass)
    result = await coordinator.async_send_activity(action, payload)
    _raise_if_duplicate_activity_name_rejected(result)


async def _handle_entity_service(
    hass: HomeAssistant,
    action: str,
    call: ServiceCall,
    source_service: str,
) -> None:
    payload = dict(call.data)
    _validate_activity_service_payload(payload)
    user = await _async_require_entity_read_permissions(
        hass,
        call,
        [
            str(payload[ATTR_ENTITY_ID]).strip(),
            str(payload.get(ATTR_PROGRESS_ENTITY_ID, "")).strip(),
        ],
    )
    _require_safe_limited_entity_payload(user, call, payload)
    entity_payload = build_entity_activity_payload(hass, payload, source_service)
    if entity_payload is None:
        return
    _validate_activity_service_payload(entity_payload)

    coordinator = _get_coordinator(hass)
    result = await coordinator.async_send_activity(action, entity_payload)
    _raise_if_duplicate_activity_name_rejected(result)


async def _handle_set_activity(
    hass: HomeAssistant,
    call: ServiceCall,
) -> None:
    payload = dict(call.data)
    _validate_activity_service_payload(payload)
    entity_id = str(payload.get(ATTR_ENTITY_ID, "")).strip()

    if entity_id:
        user = await _async_require_entity_read_permissions(
            hass,
            call,
            [
                entity_id,
                str(payload.get(ATTR_PROGRESS_ENTITY_ID, "")).strip(),
            ],
        )
        _require_safe_limited_entity_payload(user, call, payload)
        entity_payload = build_entity_activity_payload(hass, payload, SERVICE_SET_ACTIVITY)
        if entity_payload is None:
            return
        _validate_activity_service_payload(entity_payload)

        coordinator = _get_coordinator(hass)
        result = await coordinator.async_send_activity(ACTION_START, entity_payload)
        _raise_if_duplicate_activity_name_rejected(result)
        return

    await _async_require_trusted_manual_activity_caller(hass, call)
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
    relay_app_registration_secret = str(
        payload.get(CONF_RELAY_APP_REGISTRATION_SECRET) or ""
    ).strip()
    home_assistant_instance_id = str(payload[CONF_HOME_ASSISTANT_INSTANCE_ID]).strip()

    if len(relay_url) > 2048:
        raise HomeAssistantError("Managed relay URL is too long")
    if len(relay_secret) > 512 or len(relay_app_registration_secret) > 512:
        raise HomeAssistantError("Managed relay credential is too long")

    parsed = urlsplit(relay_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HomeAssistantError("Invalid managed relay URL")
    if not _is_allowed_managed_relay_url(relay_url):
        raise HomeAssistantError("Managed relay URL is not allowed")
    if not _valid_home_assistant_instance_id(home_assistant_instance_id):
        raise HomeAssistantError("Managed relay Home Assistant instance ID is invalid")
    if not relay_secret and not relay_app_registration_secret:
        raise HomeAssistantError("Managed relay provisioning secret is required")

    entry = coordinator.config_entry
    if relay_app_registration_secret:
        pending_instance_id = str(
            entry.options.get(CONF_PENDING_MANAGED_RELAY_INSTANCE_ID) or ""
        ).strip()
        pending_secret = str(
            entry.options.get(CONF_PENDING_MANAGED_RELAY_SHARED_SECRET) or ""
        ).strip()
        active_instance_id = str(
            entry.options.get(
                CONF_HOME_ASSISTANT_INSTANCE_ID,
                entry.data.get(CONF_HOME_ASSISTANT_INSTANCE_ID, ""),
            )
            or ""
        ).strip()
        active_secret = str(coordinator.relay_shared_secret or "").strip()
        relay_mode = getattr(coordinator, "relay_mode", "")

        requires_staging = False
        if (
            pending_instance_id == home_assistant_instance_id
            and _valid_home_assistant_instance_id(pending_instance_id)
            and _valid_managed_relay_secret(pending_secret)
        ):
            relay_secret = pending_secret
            current_relay_secret = pending_secret
        elif (
            relay_mode == RELAY_MODE_MANAGED
            and active_instance_id == home_assistant_instance_id
            and _valid_managed_relay_secret(active_secret)
        ):
            # Idempotently verify an already configured managed instance rather
            # than rotating its secret on every legacy compatibility call.
            relay_secret = active_secret
            current_relay_secret = active_secret
        else:
            relay_secret = secrets.token_urlsafe(32)
            current_relay_secret = ""
            requires_staging = True

        if requires_staging:
            hass.config_entries.async_update_entry(
                entry,
                options={
                    **entry.options,
                    CONF_PENDING_MANAGED_RELAY_INSTANCE_ID: home_assistant_instance_id,
                    CONF_PENDING_MANAGED_RELAY_SHARED_SECRET: relay_secret,
                },
            )
        await _async_provision_managed_relay_secret(
            hass,
            relay_url,
            relay_app_registration_secret,
            home_assistant_instance_id,
            relay_secret,
            current_relay_secret,
        )

    options = {**entry.options}
    options.pop(CONF_PENDING_MANAGED_RELAY_INSTANCE_ID, None)
    options.pop(CONF_PENDING_MANAGED_RELAY_SHARED_SECRET, None)
    options.update(
        {
            CONF_RELAY_ENABLED: True,
            CONF_RELAY_MODE: RELAY_MODE_MANAGED,
            CONF_RELAY_URL: relay_url,
            CONF_RELAY_SHARED_SECRET: relay_secret,
            CONF_RELAY_ENVIRONMENT: payload.get(
                CONF_RELAY_ENVIRONMENT,
                RELAY_ENVIRONMENT_SANDBOX,
            ),
            CONF_HOME_ASSISTANT_INSTANCE_ID: home_assistant_instance_id,
        }
    )
    hass.config_entries.async_update_entry(entry, options=options)
    coordinator.async_update_listeners()
    _LOGGER.info(
        "HA LiveKit managed relay configured from iOS app: "
        "relay_url_present=%s secret_present=%s environment=%s",
        bool(relay_url),
        bool(relay_secret),
        options[CONF_RELAY_ENVIRONMENT],
    )


async def _async_require_admin_user(hass: HomeAssistant, call: ServiceCall) -> None:
    """Require a known administrator before changing relay configuration."""
    user_id = getattr(call.context, "user_id", None)
    if not user_id:
        raise Unauthorized(context=call.context, user_id=user_id)

    user = await hass.auth.async_get_user(user_id)
    if user is None:
        raise UnknownUser(context=call.context, user_id=user_id)
    if not user.is_admin:
        raise Unauthorized(context=call.context, user_id=user_id)


async def _async_require_entity_read_permissions(
    hass: HomeAssistant,
    call: ServiceCall,
    entity_ids: list[str],
) -> Any | None:
    """Reject unauthorized entity-state reads before accessing the state machine."""
    requested_entity_ids = [entity_id for entity_id in entity_ids if entity_id]
    if not requested_entity_ids:
        return None

    user_id = getattr(call.context, "user_id", None)
    if not user_id:
        return None

    user = await hass.auth.async_get_user(user_id)
    if user is None:
        raise UnknownUser(context=call.context, user_id=user_id, permission=POLICY_READ)
    if user.is_admin:
        return user

    for entity_id in requested_entity_ids:
        if not user.permissions.check_entity(entity_id, POLICY_READ):
            raise Unauthorized(
                context=call.context,
                user_id=user_id,
                entity_id=entity_id,
                permission=POLICY_READ,
            )
    return user


def _require_safe_limited_entity_payload(
    user: Any | None,
    call: ServiceCall,
    payload: dict[str, Any],
) -> None:
    """Prevent limited users from turning entity services into custom broadcasts."""
    if user is None or user.is_admin:
        return
    disallowed_fields = set(payload) - _LIMITED_ENTITY_ACTIVITY_FIELDS
    if disallowed_fields == {ATTR_DATA} and payload.get(ATTR_DATA) == {}:
        disallowed_fields.clear()
    if disallowed_fields:
        raise Unauthorized(
            context=call.context,
            user_id=getattr(call.context, "user_id", None),
        )
    template = str(payload.get(ATTR_TEMPLATE, "")).strip()
    if template and template not in _SAFE_ENTITY_TEMPLATES:
        raise Unauthorized(
            context=call.context,
            user_id=getattr(call.context, "user_id", None),
        )


async def _async_require_generic_activity_permissions(
    hass: HomeAssistant,
    call: ServiceCall,
    payload: dict[str, Any],
) -> None:
    """Require a trusted caller for the raw/custom activity APIs."""
    del payload
    await _async_require_trusted_manual_activity_caller(hass, call)


async def _async_require_trusted_manual_activity_caller(
    hass: HomeAssistant,
    call: ServiceCall,
) -> None:
    """Allow custom activity content only from admins or HA system automations."""
    user_id = getattr(call.context, "user_id", None)
    if not user_id:
        # Home Assistant automation/script calls can intentionally have no user.
        # They are configured by an authorized user and preserve existing automations.
        return

    user = await hass.auth.async_get_user(user_id)
    if user is None:
        raise UnknownUser(context=call.context, user_id=user_id)
    if not user.is_admin:
        raise Unauthorized(context=call.context, user_id=user_id)


def _validate_activity_service_payload(payload: dict[str, Any]) -> None:
    """Translate boundary validation failures into safe HA service errors."""
    try:
        validate_activity_payload(payload)
    except PayloadValidationError as err:
        raise HomeAssistantError(f"Invalid HA LiveKit activity payload ({err.code})") from err


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
            allow_redirects=False,
        ) as response:
            if 300 <= response.status < 400:
                raise HomeAssistantError(
                    "Managed relay provisioning rejected an unexpected redirect"
                )
            raw_response = await _async_read_bounded_relay_response(
                response,
                _MAX_MANAGED_RELAY_RESPONSE_BYTES,
            )
            if raw_response is None:
                raise HomeAssistantError(
                    "Managed relay provisioning response is too large"
                )
            try:
                text = raw_response.decode(
                    getattr(response, "charset", None) or "utf-8"
                )
            except (LookupError, UnicodeDecodeError) as err:
                raise HomeAssistantError(
                    "Managed relay provisioning returned invalid text"
                ) from err
            if response.status < 200 or response.status >= 300:
                raise HomeAssistantError(
                    f"Managed relay provisioning failed: HTTP {response.status}"
                )
            try:
                result = json.loads(text) if text else {}
            except json.JSONDecodeError as err:
                raise HomeAssistantError(
                    "Managed relay provisioning returned invalid JSON"
                ) from err
            if (
                not isinstance(result, dict)
                or result.get("ok") is not True
                or result.get("provisioned") is not True
                or result.get("instance_id_version") != 2
                or result.get(CONF_HOME_ASSISTANT_INSTANCE_ID)
                != home_assistant_instance_id
                or result.get("auth_protocol") not in {None, "v1", "v2"}
            ):
                raise HomeAssistantError(
                    "Managed relay provisioning returned an invalid scoped response"
                )
    except HomeAssistantError:
        raise
    except Exception as err:  # noqa: BLE001 - convert transport errors safely.
        raise HomeAssistantError("Managed relay provisioning could not be reached") from err


async def _async_read_bounded_relay_response(response: Any, limit: int) -> bytes | None:
    """Read an aiohttp response without buffering beyond the managed limit."""
    content_length = getattr(response, "content_length", None)
    if isinstance(content_length, int) and content_length > limit:
        return None
    stream = getattr(response, "content", None)
    if stream is None or not hasattr(stream, "read"):
        raw = await response.read()
        return raw if len(raw) <= limit else None

    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await stream.read(min(4096, limit + 1 - size))
        if not chunk:
            break
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


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
    if not isinstance(value, str):
        return False
    normalized = value.strip()
    return (
        bool(re.fullmatch(r"ha_[a-f0-9]{32}", normalized))
        and normalized not in UNSAFE_HOME_ASSISTANT_INSTANCE_IDS
    )


def _valid_managed_relay_secret(value: Any) -> bool:
    """Return whether a relay secret is safe to reuse for provisioning."""
    return isinstance(value, str) and 32 <= len(value.strip()) <= 512


def _is_allowed_managed_relay_url(value: str) -> bool:
    """Return whether the managed relay auto-config URL is the expected origin."""
    expected = MANAGED_RELAY_URL.strip().rstrip("/")
    return bool(expected) and value.strip().rstrip("/") == expected
