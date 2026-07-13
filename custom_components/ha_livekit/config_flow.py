"""Config flow for HA LiveKit."""

from __future__ import annotations

import secrets
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.selector import (
    BooleanSelector,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .const import (
    CONF_ALLOW_LEGACY_WEBHOOK_SECRET,
    CONF_PUSH_ENDPOINT_URL,
    CONF_RELAY_ENABLED,
    CONF_RELAY_ENVIRONMENT,
    CONF_RELAY_MODE,
    CONF_RELAY_SHARED_SECRET,
    CONF_RELAY_URL,
    CONF_SHARED_SECRET,
    DOMAIN,
    MANAGED_RELAY_URL,
    RELAY_ENVIRONMENT_PRODUCTION,
    RELAY_ENVIRONMENT_SANDBOX,
    RELAY_MODE_CUSTOM,
    RELAY_MODE_MANAGED,
)


RELAY_MODE_OPTIONS = {
    RELAY_MODE_MANAGED: "Managed Relay",
    RELAY_MODE_CUSTOM: "Custom Relay advanced",
}

RELAY_ENVIRONMENT_OPTIONS = {
    RELAY_ENVIRONMENT_SANDBOX: "Sandbox",
    RELAY_ENVIRONMENT_PRODUCTION: "Production",
}


def _default_relay_mode(defaults: dict[str, Any]) -> str:
    configured_mode = defaults.get(CONF_RELAY_MODE)
    if configured_mode in RELAY_MODE_OPTIONS:
        return configured_mode
    if defaults.get(CONF_RELAY_URL) or defaults.get(CONF_PUSH_ENDPOINT_URL):
        return RELAY_MODE_CUSTOM
    return RELAY_MODE_MANAGED


def _schema(
    defaults: dict[str, Any] | None = None,
    *,
    show_custom: bool | None = None,
) -> vol.Schema:
    defaults = defaults or {}
    relay_mode = _default_relay_mode(defaults)
    show_custom = show_custom if show_custom is not None else relay_mode == RELAY_MODE_CUSTOM
    relay_url_default = defaults.get(
        CONF_RELAY_URL,
        defaults.get(CONF_PUSH_ENDPOINT_URL, ""),
    )
    relay_enabled_default = defaults.get(CONF_RELAY_ENABLED)
    if relay_enabled_default is None:
        relay_enabled_default = bool(MANAGED_RELAY_URL or defaults.get(CONF_RELAY_URL))

    fields: dict[Any, Any] = {
        vol.Optional(
            CONF_RELAY_ENABLED,
            default=relay_enabled_default,
        ): BooleanSelector(),
        vol.Optional(
            CONF_RELAY_MODE,
            default=relay_mode,
        ): vol.In(RELAY_MODE_OPTIONS),
        vol.Optional(
            CONF_ALLOW_LEGACY_WEBHOOK_SECRET,
            default=bool(defaults.get(CONF_ALLOW_LEGACY_WEBHOOK_SECRET, False)),
        ): BooleanSelector(),
    }

    if show_custom:
        fields.update(
            {
                vol.Optional(
                    CONF_RELAY_URL,
                    default=relay_url_default,
                ): TextSelector(TextSelectorConfig(type=TextSelectorType.URL)),
                vol.Optional(
                    CONF_RELAY_SHARED_SECRET,
                    default=defaults.get(CONF_RELAY_SHARED_SECRET, ""),
                ): TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD)),
                vol.Optional(
                    CONF_RELAY_ENVIRONMENT,
                    default=defaults.get(CONF_RELAY_ENVIRONMENT, RELAY_ENVIRONMENT_SANDBOX),
                ): vol.In(RELAY_ENVIRONMENT_OPTIONS),
            }
        )

    return vol.Schema(fields)


def _finalize_input(user_input: dict[str, Any], defaults: dict[str, Any] | None = None) -> dict[str, Any]:
    data = {**(defaults or {}), **user_input}
    data.setdefault(CONF_SHARED_SECRET, secrets.token_urlsafe(32))
    data.setdefault(CONF_ALLOW_LEGACY_WEBHOOK_SECRET, False)
    data.setdefault(CONF_RELAY_MODE, RELAY_MODE_MANAGED)
    data.setdefault(
        CONF_RELAY_ENABLED,
        bool(MANAGED_RELAY_URL or data.get(CONF_RELAY_URL)),
    )
    return data


class HALiveKitConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle an HA LiveKit config flow."""

    VERSION = 1
    MINOR_VERSION = 0

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> config_entries.OptionsFlow:
        """Create the options flow."""
        return HALiveKitOptionsFlow(config_entry)

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Handle the initial step."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            data = _finalize_input(user_input)
            if data.get(CONF_RELAY_MODE) == RELAY_MODE_CUSTOM and CONF_RELAY_URL not in user_input:
                return self.async_show_form(
                    step_id="user",
                    data_schema=_schema(data, show_custom=True),
                    description_placeholders={"webhook_path": "/api/webhook/ha_livekit_update"},
                )
            return self.async_create_entry(title="HA LiveKit", data=data)

        return self.async_show_form(
            step_id="user",
            data_schema=_schema(),
            description_placeholders={"webhook_path": "/api/webhook/ha_livekit_update"},
        )


class HALiveKitOptionsFlow(config_entries.OptionsFlow):
    """Handle HA LiveKit options."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self._config_entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Manage HA LiveKit options."""
        defaults = {**self._config_entry.data, **self._config_entry.options}

        if user_input is not None:
            data = _finalize_input(user_input, defaults)
            if data.get(CONF_RELAY_MODE) == RELAY_MODE_CUSTOM and CONF_RELAY_URL not in user_input:
                return self.async_show_form(step_id="init", data_schema=_schema(data, show_custom=True))
            return self.async_create_entry(title="", data=data)

        return self.async_show_form(step_id="init", data_schema=_schema(defaults))
