"""HA LiveKit custom integration."""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlsplit

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError
import homeassistant.helpers.config_validation as cv

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
    CONF_RELAY_ENVIRONMENT,
    CONF_RELAY_MODE,
    CONF_RELAY_SHARED_SECRET,
    CONF_RELAY_URL,
    CONF_HOME_ASSISTANT_INSTANCE_ID,
    DOMAIN,
    PLATFORMS,
    RELAY_ENVIRONMENT_PRODUCTION,
    RELAY_ENVIRONMENT_SANDBOX,
    RELAY_MODE_MANAGED,
    SERVICE_CONFIGURE_MANAGED_RELAY,
    SERVICE_END_ACTIVITY,
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
        vol.Required(CONF_RELAY_SHARED_SECRET): cv.string,
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
        await _handle_service(hass, ACTION_START, dict(call.data))

    async def handle_update(call: ServiceCall) -> None:
        await _handle_service(hass, ACTION_UPDATE, dict(call.data))

    async def handle_end(call: ServiceCall) -> None:
        await _handle_service(hass, ACTION_END, dict(call.data))

    async def handle_start_entity(call: ServiceCall) -> None:
        await _handle_entity_service(hass, ACTION_START, dict(call.data), SERVICE_START_ENTITY_ACTIVITY)

    async def handle_update_entity(call: ServiceCall) -> None:
        await _handle_entity_service(hass, ACTION_UPDATE, dict(call.data), SERVICE_UPDATE_ENTITY_ACTIVITY)

    async def handle_configure_managed_relay(call: ServiceCall) -> None:
        await _handle_configure_managed_relay(hass, dict(call.data))

    services = (
        (SERVICE_START_ACTIVITY, handle_start, START_ACTIVITY_SCHEMA),
        (SERVICE_UPDATE_ACTIVITY, handle_update, UPDATE_ACTIVITY_SCHEMA),
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
    payload: dict[str, Any],
) -> None:
    coordinator = _get_coordinator(hass)
    await coordinator.async_send_activity(action, payload)


async def _handle_entity_service(
    hass: HomeAssistant,
    action: str,
    payload: dict[str, Any],
    source_service: str,
) -> None:
    entity_payload = build_entity_activity_payload(hass, payload, source_service)
    if entity_payload is None:
        return

    coordinator = _get_coordinator(hass)
    await coordinator.async_send_activity(action, entity_payload)


async def _handle_configure_managed_relay(
    hass: HomeAssistant,
    payload: dict[str, Any],
) -> None:
    coordinator = _get_coordinator(hass)
    relay_url = payload[CONF_RELAY_URL].strip()
    relay_secret = payload[CONF_RELAY_SHARED_SECRET].strip()
    home_assistant_instance_id = payload[CONF_HOME_ASSISTANT_INSTANCE_ID].strip()

    parsed = urlsplit(relay_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HomeAssistantError("Invalid managed relay URL")
    if not relay_secret:
        raise HomeAssistantError("Managed relay secret is required")
    if not _valid_home_assistant_instance_id(home_assistant_instance_id):
        raise HomeAssistantError("Managed relay Home Assistant instance ID is invalid")

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
    _LOGGER.warning(
        "HA LiveKit managed relay configured from iOS app: relay_url_present=%s secret_present=%s environment=%s",
        bool(relay_url),
        bool(relay_secret),
        options[CONF_RELAY_ENVIRONMENT],
    )


def _get_coordinator(hass: HomeAssistant) -> HALiveKitCoordinator:
    entries = hass.data.get(DOMAIN, {})
    for coordinator in entries.values():
        if isinstance(coordinator, HALiveKitCoordinator):
            return coordinator

    raise HomeAssistantError("HA LiveKit is not configured")


def _valid_home_assistant_instance_id(value: str) -> bool:
    """Return whether an iOS-provisioned HA instance id is safe to use."""
    return bool(value) and value.startswith("ha_") and len(value) == 35 and all(
        character in "0123456789abcdef" for character in value[3:]
    )
