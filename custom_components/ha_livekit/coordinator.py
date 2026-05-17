"""Coordinator and outbound dispatch for HA LiveKit."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import hmac
import json
import logging
import re
from typing import Any

from aiohttp import ClientTimeout

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import (
    ACTION_END,
    ACTION_START,
    ACTION_UPDATE,
    CONF_PUSH_ENDPOINT_URL,
    CONF_HOME_ASSISTANT_INSTANCE_ID,
    CONF_RELAY_ENABLED,
    CONF_RELAY_ENVIRONMENT,
    CONF_RELAY_MODE,
    CONF_RELAY_SHARED_SECRET,
    CONF_RELAY_URL,
    CONF_SHARED_SECRET,
    DOMAIN,
    EVENT_ACTIVITY_REQUEST,
    HEADER_SECRET,
    HEADER_SIGNATURE,
    MANAGED_RELAY_SHARED_SECRET,
    MANAGED_RELAY_URL,
    RELAY_ENVIRONMENT_PRODUCTION,
    RELAY_ENVIRONMENT_SANDBOX,
    RELAY_MODE_CUSTOM,
    RELAY_MODE_MANAGED,
)

_LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class DispatchResult:
    """Result of a local and optional outbound dispatch."""

    delivered_locally: bool
    delivered_outbound: bool
    relay_status_code: int | None = None
    relay_error: str | None = None


class HALiveKitCoordinator(DataUpdateCoordinator[dict[str, Any] | None]):
    """Keep the last activity request and optionally forward it."""

    config_entry: ConfigEntry

    def __init__(self, hass: HomeAssistant, config_entry: ConfigEntry) -> None:
        super().__init__(hass, _LOGGER, name=DOMAIN)
        self.config_entry = config_entry
        self.last_relay_attempt_at: str | None = None
        self.last_relay_action: str | None = None
        self.last_relay_status_code: int | None = None
        self.last_relay_response: str | None = None
        self.last_relay_error: str | None = None

    @property
    def shared_secret(self) -> str:
        """Return the configured shared secret."""
        return self.config_entry.options.get(
            CONF_SHARED_SECRET,
            self.config_entry.data.get(CONF_SHARED_SECRET, ""),
        )

    @property
    def push_endpoint_url(self) -> str:
        """Return the optional companion relay endpoint."""
        return self.config_entry.options.get(
            CONF_PUSH_ENDPOINT_URL,
            self.config_entry.data.get(CONF_PUSH_ENDPOINT_URL, ""),
        )

    @property
    def relay_enabled(self) -> bool:
        """Return whether APNs relay forwarding is enabled."""
        if CONF_RELAY_ENABLED in self.config_entry.options:
            return bool(self.config_entry.options[CONF_RELAY_ENABLED])

        # Older config entries may have stored relay_enabled=false when the managed
        # relay URL was not compiled in yet. Once this build has a managed URL,
        # default managed forwarding on after restart without requiring options.
        if self.relay_mode == RELAY_MODE_MANAGED and MANAGED_RELAY_URL:
            return True

        if CONF_RELAY_ENABLED in self.config_entry.data:
            return bool(self.config_entry.data[CONF_RELAY_ENABLED])
        return bool(self.relay_url and self.relay_shared_secret)

    @property
    def relay_mode(self) -> str:
        """Return the relay mode."""
        value = self.config_entry.options.get(
            CONF_RELAY_MODE,
            self.config_entry.data.get(CONF_RELAY_MODE),
        )
        if value in {RELAY_MODE_MANAGED, RELAY_MODE_CUSTOM}:
            return value
        if self.config_entry.options.get(CONF_RELAY_URL) or self.config_entry.data.get(CONF_RELAY_URL) or self.push_endpoint_url:
            return RELAY_MODE_CUSTOM
        return RELAY_MODE_MANAGED

    @property
    def relay_url(self) -> str:
        """Return the configured APNs relay base URL."""
        if self.relay_mode == RELAY_MODE_MANAGED:
            return MANAGED_RELAY_URL or self.config_entry.options.get(
                CONF_RELAY_URL,
                self.config_entry.data.get(CONF_RELAY_URL, self.push_endpoint_url),
            )
        return self.config_entry.options.get(
            CONF_RELAY_URL,
            self.config_entry.data.get(CONF_RELAY_URL, self.push_endpoint_url),
        )

    @property
    def relay_shared_secret(self) -> str:
        """Return the HA-to-relay shared secret."""
        if self.relay_mode == RELAY_MODE_MANAGED:
            return MANAGED_RELAY_SHARED_SECRET or self.config_entry.options.get(
                CONF_RELAY_SHARED_SECRET,
                self.config_entry.data.get(CONF_RELAY_SHARED_SECRET, ""),
            )
        return self.config_entry.options.get(
            CONF_RELAY_SHARED_SECRET,
            self.config_entry.data.get(CONF_RELAY_SHARED_SECRET, ""),
        )

    @property
    def relay_environment(self) -> str:
        """Return the APNs environment configured by the iOS app."""
        value = self.config_entry.options.get(
            CONF_RELAY_ENVIRONMENT,
            self.config_entry.data.get(CONF_RELAY_ENVIRONMENT, RELAY_ENVIRONMENT_SANDBOX),
        )
        return value if value in {RELAY_ENVIRONMENT_SANDBOX, RELAY_ENVIRONMENT_PRODUCTION} else RELAY_ENVIRONMENT_SANDBOX

    @property
    def home_assistant_instance_id(self) -> str:
        """Return the iOS-provisioned HA instance identifier for relay isolation."""
        value = self.config_entry.options.get(
            CONF_HOME_ASSISTANT_INSTANCE_ID,
            self.config_entry.data.get(CONF_HOME_ASSISTANT_INSTANCE_ID, ""),
        )
        return value if _valid_home_assistant_instance_id(value) else ""

    async def async_send_activity(
        self,
        action: str,
        payload: dict[str, Any],
    ) -> DispatchResult:
        """Publish an activity request inside HA and optionally to a relay endpoint."""
        message = self._normalize_message(action, payload)
        self.async_set_updated_data(message)
        self.hass.bus.async_fire(EVENT_ACTIVITY_REQUEST, message)
        _LOGGER.debug(
            "HA LiveKit foreground event bus fired for %s activity_id=%s",
            message.get("action"),
            message.get("activity_id"),
        )

        delivered_outbound = False
        relay_error = None
        relay_enabled = self.relay_enabled
        relay_url = self.relay_url.strip()
        _LOGGER.warning(
            "HA LiveKit relay forwarding state: enabled=%s mode=%s relay_url_present=%s activity_id=%s action=%s",
            relay_enabled,
            self.relay_mode,
            bool(relay_url),
            message.get("activity_id"),
            message.get("action"),
        )

        if relay_enabled:
            delivered_outbound = await self._post_to_relay(message)
            relay_error = self.last_relay_error
            self.async_update_listeners()
        else:
            self.last_relay_error = "Relay forwarding disabled"
            _LOGGER.warning("HA LiveKit background relay forwarding disabled; foreground event bus only")

        return DispatchResult(
            delivered_locally=True,
            delivered_outbound=delivered_outbound,
            relay_status_code=self.last_relay_status_code,
            relay_error=relay_error,
        )

    async def async_handle_webhook(
        self,
        payload: dict[str, Any],
    ) -> DispatchResult:
        """Handle a signed webhook payload."""
        action = str(payload.get("action") or payload.get("type") or ACTION_UPDATE)
        payload = {key: value for key, value in payload.items() if key not in {"secret"}}
        return await self.async_send_activity(action, payload)

    def signature_for_bytes(self, body: bytes) -> str:
        """Return a sha256 HMAC signature for a raw request body."""
        digest = hmac.new(self.shared_secret.encode(), body, hashlib.sha256).hexdigest()
        return f"sha256={digest}"

    def verify_signature(self, body: bytes, signature: str | None, secret: str | None) -> bool:
        """Verify HMAC signature, falling back to explicit shared secret for simple clients."""
        if not self.shared_secret:
            return False

        if signature:
            expected = self.signature_for_bytes(body)
            normalized = signature if signature.startswith("sha256=") else f"sha256={signature}"
            return hmac.compare_digest(expected, normalized)

        if secret:
            return hmac.compare_digest(self.shared_secret, secret)

        return False

    def _normalize_message(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        normalized_action = self._normalize_action(action)
        return {
            "version": 1,
            "domain": DOMAIN,
            "timestamp": datetime.now(UTC).isoformat(),
            **payload,
            "action": normalized_action,
        }

    @staticmethod
    def _normalize_action(action: str) -> str:
        normalized = action.strip().lower().replace("-", "_")
        if normalized in {ACTION_START, "start_activity", "start_entity_activity"}:
            return ACTION_START
        if normalized in {ACTION_UPDATE, "update_activity", "update_entity_activity"}:
            return ACTION_UPDATE
        if normalized in {ACTION_END, "end_activity"}:
            return ACTION_END
        return normalized

    async def _post_to_relay(self, message: dict[str, Any]) -> bool:
        relay_url = self.relay_url.strip()
        relay_secret = self.relay_shared_secret.strip()
        action = str(message.get("action") or "").strip()
        self.last_relay_attempt_at = datetime.now(UTC).isoformat()
        self.last_relay_action = action or None
        self.last_relay_status_code = None
        self.last_relay_response = None
        self.last_relay_error = None

        if not relay_url:
            if self.relay_mode == RELAY_MODE_MANAGED:
                self.last_relay_error = "HA LiveKit managed relay URL missing; background relay forwarding skipped"
                _LOGGER.warning("HA LiveKit managed relay URL missing; background relay forwarding skipped")
            else:
                self.last_relay_error = "Custom relay URL missing"
                _LOGGER.warning("HA LiveKit APNs relay skipped: %s", self.last_relay_error)
            return False

        if not relay_secret:
            if self.relay_mode == RELAY_MODE_CUSTOM:
                self.last_relay_error = "Custom relay shared secret missing"
                _LOGGER.warning("HA LiveKit APNs relay skipped: %s", self.last_relay_error)
                return False
            _LOGGER.warning(
                "HA LiveKit managed relay secret missing; attempting POST so relay diagnostics are visible"
            )

        instance_id = self.home_assistant_instance_id
        if not instance_id:
            self.last_relay_error = "Managed relay Home Assistant instance ID missing; reopen the iOS app to reconfigure"
            _LOGGER.warning("HA LiveKit APNs relay skipped: %s", self.last_relay_error)
            return False

        if action not in {ACTION_START, ACTION_UPDATE, ACTION_END}:
            self.last_relay_error = f"unsupported action {action}"
            _LOGGER.warning("HA LiveKit APNs relay skipped unsupported action %s", action)
            return False

        session = async_get_clientsession(self.hass)
        relay_message = dict(message)
        relay_message["home_assistant_instance_id"] = instance_id
        relay_message["apns_mode"] = self.relay_environment
        if self.hass.config.location_name:
            relay_message["home_assistant_name"] = self.hass.config.location_name
        body = json.dumps(relay_message, separators=(",", ":"), sort_keys=True).encode()
        headers = {"Content-Type": "application/json"}
        if relay_secret:
            headers[HEADER_SECRET] = relay_secret
        url = f"{relay_url.rstrip('/')}/{action}"
        _LOGGER.warning(
            "HA LiveKit relay POST attempt: enabled=%s url_present=%s endpoint=%s activity_id=%s secret_present=%s environment=%s instance_id_prefix=%s",
            self.relay_enabled,
            bool(relay_url),
            action,
            message.get("activity_id"),
            bool(relay_secret),
            self.relay_environment,
            _log_instance_id(instance_id),
        )

        try:
            async with session.post(
                url,
                data=body,
                headers=headers,
                timeout=ClientTimeout(total=10),
            ) as response:
                text = await response.text()
                self.last_relay_status_code = response.status
                self.last_relay_response = _safe_response_summary(text)
                if response.status >= 400:
                    self.last_relay_error = f"HTTP {response.status}: {self.last_relay_response}"
                    _LOGGER.warning(
                        "HA LiveKit relay POST status: endpoint=%s status=%s response=%s",
                        action,
                        response.status,
                        self.last_relay_response,
                    )
                    return False
                _LOGGER.warning(
                    "HA LiveKit relay POST status: endpoint=%s status=%s response=%s",
                    action,
                    response.status,
                    self.last_relay_response,
                )
        except Exception as err:  # noqa: BLE001 - relay failure must not break V1 service flow.
            self.last_relay_error = str(err)
            _LOGGER.exception("HA LiveKit relay POST exception: endpoint=%s error=%s", action, err)
            return False

        return True


def _safe_response_summary(text: str) -> str:
    """Return a short relay response summary without full APNs tokens."""
    if not text:
        return "empty response"

    redacted = re.sub(r"\b[a-fA-F0-9]{64,}\b", "<redacted>", text)
    redacted = re.sub(
        r'(?i)("?(?:relay_shared_secret|home_assistant_relay_token|home_assistant_relay_secret|token|secret)"?\s*:\s*"?)[^",}\s]+',
        r"\1<redacted>",
        redacted,
    )
    return redacted[:700]


def _valid_home_assistant_instance_id(value: Any) -> bool:
    """Return whether a Home Assistant instance id can be used for relay routing."""
    if not isinstance(value, str):
        return False
    return bool(re.fullmatch(r"ha_[a-f0-9]{32}", value.strip()))


def _log_instance_id(value: str) -> str:
    """Return a non-sensitive prefix for relay diagnostics."""
    return f"{value[:11]}..." if value else "missing"
