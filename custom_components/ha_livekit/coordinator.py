"""Coordinator and outbound dispatch for HA LiveKit."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import hmac
import json
import logging
import re
import time
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
    ATTR_DATA,
    CONF_ALLOW_LEGACY_WEBHOOK_SECRET,
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
    WEBHOOK_MAX_CLOCK_SKEW_SECONDS,
    WEBHOOK_REPLAY_CACHE_MAX_ENTRIES,
    WEBHOOK_REPLAY_CACHE_TTL_SECONDS,
    UNSAFE_HOME_ASSISTANT_INSTANCE_IDS,
)
from .security import canonicalize_activity_id_fields

_LOGGER = logging.getLogger(__name__)
_WEBHOOK_NONCE_PATTERN = re.compile(r"[A-Za-z0-9._~-]{16,128}")
_WEBHOOK_SIGNATURE_PATTERN = re.compile(r"(?:sha256=)?[a-f0-9]{64}")
_MAX_RELAY_RESPONSE_BYTES = 32 * 1024
_ENTITY_SET_OPERATION_HEADER = "X-HA-LiveKit-Operation"
_ENTITY_SET_OPERATION_VALUE = "entity-set-v1"
_RESERVED_ENTITY_SET_DATA_KEYS = frozenset({"entity_based", "source_service"})
_SEMANTIC_ENTITY_RELAY_ERRORS = frozenset(
    {
        "ambiguous_entity_activity",
        "duplicate_activity_name",
        "entity_activity_id_changed",
        "pending_entity_activity_id_changed",
        "immutable_activity_attributes_changed",
        "activity_restart_required",
    }
)

WEBHOOK_AUTH_OK = "ok"
WEBHOOK_AUTH_OK_LEGACY_SIGNATURE = "ok_legacy_signature"
WEBHOOK_AUTH_OK_LEGACY_SECRET = "ok_legacy_secret"
WEBHOOK_AUTH_UNAUTHORIZED = "unauthorized"
WEBHOOK_AUTH_INVALID_FRESHNESS = "invalid_freshness"
WEBHOOK_AUTH_STALE = "stale"
WEBHOOK_AUTH_REPLAYED = "replayed"
WEBHOOK_AUTH_LEGACY_SECRET_DISABLED = "legacy_secret_disabled"


@dataclass(slots=True)
class DispatchResult:
    """Result of a local and optional outbound dispatch."""

    delivered_locally: bool
    delivered_outbound: bool
    relay_enabled: bool
    relay_status_code: int | None = None
    relay_error: str | None = None
    relay_accepted_pending: bool = False


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
        self.last_relay_error_code: str | None = None
        self.last_relay_accepted_pending: bool = False
        self._relay_dispatch_lock = asyncio.Lock()
        self._webhook_replay_cache: dict[str, float] = {}
        self._legacy_webhook_warning_logged = False

    @property
    def shared_secret(self) -> str:
        """Return the configured shared secret."""
        return self.config_entry.options.get(
            CONF_SHARED_SECRET,
            self.config_entry.data.get(CONF_SHARED_SECRET, ""),
        )

    @property
    def allow_legacy_webhook_secret(self) -> bool:
        """Return whether deprecated plaintext webhook secret auth is enabled."""
        return bool(
            self.config_entry.options.get(
                CONF_ALLOW_LEGACY_WEBHOOK_SECRET,
                self.config_entry.data.get(CONF_ALLOW_LEGACY_WEBHOOK_SECRET, False),
            )
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
        return value.strip() if _valid_home_assistant_instance_id(value) else ""

    async def async_send_activity(
        self,
        action: str,
        payload: dict[str, Any],
    ) -> DispatchResult:
        """Publish an activity request inside HA and optionally to a relay endpoint."""
        message = self._normalize_message(action, payload)
        delivered_outbound = False
        relay_enabled = self.relay_enabled
        defer_local_publish = relay_enabled and _is_entity_backed_set_message(message)
        delivered_locally = False
        if not defer_local_publish:
            self._publish_local(message)
            delivered_locally = True
        relay_url = self.relay_url.strip()
        _LOGGER.debug(
            "HA LiveKit relay forwarding state: enabled=%s mode=%s relay_url_present=%s activity_id=%s action=%s",
            relay_enabled,
            self.relay_mode,
            bool(relay_url),
            message.get("activity_id"),
            message.get("action"),
        )

        async with self._relay_dispatch_lock:
            self._reset_last_relay_state()
            if relay_enabled:
                delivered_outbound = await self._post_to_relay(message)
                self.async_update_listeners()
            else:
                self.last_relay_error = "Relay forwarding disabled"
                _LOGGER.debug(
                    "HA LiveKit background relay forwarding disabled; foreground event bus only"
                )

            relay_status_code = self.last_relay_status_code
            relay_error = self.last_relay_error
            relay_error_code = self.last_relay_error_code
            relay_accepted_pending = self.last_relay_accepted_pending

        semantic_rejection = (
            defer_local_publish
            and not delivered_outbound
            and relay_status_code == 409
            and relay_error_code in _SEMANTIC_ENTITY_RELAY_ERRORS
        )
        if defer_local_publish and not semantic_rejection:
            self._publish_local(message)
            delivered_locally = True
        elif semantic_rejection:
            _LOGGER.warning(
                "HA LiveKit withheld foreground event after relay semantic rejection: error=%s activity_id=%s",
                relay_error_code,
                message.get("activity_id"),
            )

        return DispatchResult(
            delivered_locally=delivered_locally,
            delivered_outbound=delivered_outbound,
            relay_enabled=relay_enabled,
            relay_status_code=relay_status_code,
            relay_error=relay_error,
            relay_accepted_pending=relay_accepted_pending,
        )

    async def async_handle_webhook(
        self,
        payload: dict[str, Any],
    ) -> DispatchResult:
        """Handle a signed webhook payload."""
        action = str(payload.get("action") or payload.get("type") or ACTION_UPDATE)
        payload = {key: value for key, value in payload.items() if key not in {"secret"}}
        payload = _without_internal_entity_set_markers(payload)
        return await self.async_send_activity(action, payload)

    def signature_for_bytes(
        self,
        body: bytes,
        timestamp: str | None = None,
        nonce: str | None = None,
    ) -> str:
        """Return a sha256 HMAC for either legacy or freshness-bound requests."""
        signed_bytes = _webhook_signed_bytes(body, timestamp, nonce)
        digest = hmac.new(self.shared_secret.encode(), signed_bytes, hashlib.sha256).hexdigest()
        return f"sha256={digest}"

    def verify_signature(
        self,
        body: bytes,
        signature: str | None,
        secret: str | None = None,
        timestamp: str | None = None,
        nonce: str | None = None,
    ) -> bool:
        """Verify HMAC or an explicitly enabled legacy plaintext secret."""
        if not self.shared_secret:
            return False

        if signature:
            if not _WEBHOOK_SIGNATURE_PATTERN.fullmatch(signature):
                return False
            if bool(timestamp) != bool(nonce):
                return False
            expected = self.signature_for_bytes(body, timestamp, nonce)
            normalized = signature if signature.startswith("sha256=") else f"sha256={signature}"
            return hmac.compare_digest(expected, normalized)

        if secret and self.allow_legacy_webhook_secret:
            return hmac.compare_digest(self.shared_secret, secret)

        return False

    def authenticate_webhook_request(
        self,
        body: bytes,
        signature: str | None,
        timestamp: str | None,
        nonce: str | None,
        legacy_secret: str | None,
        *,
        now: float | None = None,
    ) -> str:
        """Authenticate a webhook request and atomically reject replay attempts."""
        current_time = time.time() if now is None else now

        if timestamp or nonce:
            if not timestamp or not nonce or not signature:
                return WEBHOOK_AUTH_INVALID_FRESHNESS
            if len(timestamp) > 12 or not timestamp.isascii() or not timestamp.isdigit():
                return WEBHOOK_AUTH_INVALID_FRESHNESS
            try:
                request_time = int(timestamp)
            except (TypeError, ValueError):
                return WEBHOOK_AUTH_INVALID_FRESHNESS
            if not _WEBHOOK_NONCE_PATTERN.fullmatch(nonce):
                return WEBHOOK_AUTH_INVALID_FRESHNESS
            if abs(current_time - request_time) > WEBHOOK_MAX_CLOCK_SKEW_SECONDS:
                return WEBHOOK_AUTH_STALE
            if not self.verify_signature(
                body,
                signature,
                timestamp=timestamp,
                nonce=nonce,
            ):
                return WEBHOOK_AUTH_UNAUTHORIZED

            replay_key = f"fresh:{hashlib.sha256(nonce.encode()).hexdigest()}"
            if not self._consume_webhook_replay_key(replay_key, current_time):
                return WEBHOOK_AUTH_REPLAYED
            return WEBHOOK_AUTH_OK

        if signature:
            if not self.verify_signature(body, signature):
                return WEBHOOK_AUTH_UNAUTHORIZED

            # Legacy HMAC clients stay compatible, but identical captured bodies
            # cannot be replayed during the cache window. New clients should send
            # timestamp + nonce headers so freshness is cryptographically bound.
            replay_key = f"legacy-signature:{hashlib.sha256(body).hexdigest()}"
            if not self._consume_webhook_replay_key(replay_key, current_time):
                return WEBHOOK_AUTH_REPLAYED
            self._warn_legacy_webhook_auth_once("HMAC without timestamp and nonce")
            return WEBHOOK_AUTH_OK_LEGACY_SIGNATURE

        if legacy_secret:
            if not self.allow_legacy_webhook_secret:
                return WEBHOOK_AUTH_LEGACY_SECRET_DISABLED
            if not self.verify_signature(body, None, legacy_secret):
                return WEBHOOK_AUTH_UNAUTHORIZED

            replay_key = f"legacy-secret:{hashlib.sha256(body).hexdigest()}"
            if not self._consume_webhook_replay_key(replay_key, current_time):
                return WEBHOOK_AUTH_REPLAYED
            self._warn_legacy_webhook_auth_once("plaintext shared secret")
            return WEBHOOK_AUTH_OK_LEGACY_SECRET

        return WEBHOOK_AUTH_UNAUTHORIZED

    def _consume_webhook_replay_key(self, replay_key: str, now: float) -> bool:
        """Record one authenticated request key in a bounded in-memory cache."""
        expired = [
            key
            for key, expires_at in self._webhook_replay_cache.items()
            if expires_at <= now
        ]
        for key in expired:
            self._webhook_replay_cache.pop(key, None)

        if replay_key in self._webhook_replay_cache:
            return False

        while len(self._webhook_replay_cache) >= WEBHOOK_REPLAY_CACHE_MAX_ENTRIES:
            self._webhook_replay_cache.pop(next(iter(self._webhook_replay_cache)))
        self._webhook_replay_cache[replay_key] = now + WEBHOOK_REPLAY_CACHE_TTL_SECONDS
        return True

    def _warn_legacy_webhook_auth_once(self, mechanism: str) -> None:
        """Log one migration warning without creating an attacker-controlled flood."""
        if self._legacy_webhook_warning_logged:
            return
        self._legacy_webhook_warning_logged = True
        _LOGGER.warning(
            "Accepted deprecated HA LiveKit webhook authentication (%s); migrate to timestamped HMAC",
            mechanism,
        )

    def _normalize_message(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        normalized_action = self._normalize_action(action)
        message = {
            "version": 1,
            "domain": DOMAIN,
            "timestamp": datetime.now(UTC).isoformat(),
            **payload,
            "action": normalized_action,
        }
        canonicalize_activity_id_fields(message)
        return message

    def _publish_local(self, message: dict[str, Any]) -> None:
        """Publish one foreground event after any required relay preflight."""
        self.async_set_updated_data(message)
        self.hass.bus.async_fire(EVENT_ACTIVITY_REQUEST, message)
        _LOGGER.debug(
            "HA LiveKit foreground event bus fired for %s activity_id=%s",
            message.get("action"),
            message.get("activity_id"),
        )

    @staticmethod
    def _normalize_action(action: str) -> str:
        normalized = action.strip().lower().replace("-", "_")
        if normalized in {ACTION_START, "set_activity", "start_activity", "start_entity_activity"}:
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
        self._reset_last_relay_state()
        self.last_relay_attempt_at = datetime.now(UTC).isoformat()
        self.last_relay_action = action or None

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
            _LOGGER.debug(
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
        if _is_entity_backed_set_message(message):
            headers[_ENTITY_SET_OPERATION_HEADER] = _ENTITY_SET_OPERATION_VALUE
        url = f"{relay_url.rstrip('/')}/{action}"
        _LOGGER.debug(
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
                allow_redirects=False,
            ) as response:
                self.last_relay_status_code = response.status
                if 300 <= response.status < 400:
                    self.last_relay_response = "redirect rejected"
                    self.last_relay_error = f"HTTP {response.status}: redirect rejected"
                    _LOGGER.warning(
                        "HA LiveKit relay POST rejected redirect: endpoint=%s status=%s",
                        action,
                        response.status,
                    )
                    return False
                raw_response = await _async_read_limited_stream(
                    response,
                    _MAX_RELAY_RESPONSE_BYTES,
                )
                if raw_response is None:
                    self.last_relay_response = "response too large"
                    self.last_relay_error = "Relay response exceeded 32 KiB"
                    _LOGGER.warning(
                        "HA LiveKit relay POST rejected oversized response: endpoint=%s status=%s",
                        action,
                        response.status,
                    )
                    return False
                try:
                    text = raw_response.decode(response.charset or "utf-8")
                except (LookupError, UnicodeDecodeError):
                    self.last_relay_response = "invalid response encoding"
                    self.last_relay_error = "Relay returned invalid text"
                    _LOGGER.warning(
                        "HA LiveKit relay POST rejected invalid text: endpoint=%s status=%s",
                        action,
                        response.status,
                    )
                    return False
                self.last_relay_response = _safe_response_summary(text)
                if (
                    action == ACTION_END
                    and response.status == 404
                    and _relay_error_code(text) == "no_activity_tokens"
                ):
                    # The activity is already gone - ended earlier, dismissed on the
                    # device, or retired by the app's launch reconciliation. End is
                    # idempotent: the requested end state is already true.
                    self.last_relay_accepted_pending = True
                    _LOGGER.info(
                        "HA LiveKit relay end already satisfied (no matching activity): endpoint=%s status=%s response=%s",
                        action,
                        response.status,
                        self.last_relay_response,
                    )
                    return False
                if response.status >= 400:
                    self.last_relay_error_code = _relay_error_code(text)
                    self.last_relay_error = f"HTTP {response.status}: {self.last_relay_response}"
                    _LOGGER.warning(
                        "HA LiveKit relay POST status: endpoint=%s status=%s response=%s",
                        action,
                        response.status,
                        self.last_relay_response,
                    )
                    return False
                try:
                    relay_result = json.loads(text)
                except json.JSONDecodeError:
                    relay_result = None
                if isinstance(relay_result, dict) and (
                    "attempted" in relay_result or "delivered" in relay_result
                ):
                    attempted = relay_result.get("attempted")
                    delivered = relay_result.get("delivered")
                    if (
                        not _is_nonnegative_json_integer(attempted)
                        or not _is_nonnegative_json_integer(delivered)
                        or delivered > attempted
                    ):
                        self.last_relay_error_code = "invalid_delivery_counters"
                        self.last_relay_error = (
                            "Relay returned invalid delivery counters: "
                            f"{self.last_relay_response}"
                        )
                        _LOGGER.warning(
                            "HA LiveKit relay rejected invalid counters: endpoint=%s status=%s response=%s",
                            action,
                            response.status,
                            self.last_relay_response,
                        )
                        return False
                    if delivered == 0:
                        reused_pending = relay_result.get("reused_pending")
                        reused_persistent_intent = relay_result.get(
                            "reused_persistent_intent"
                        )
                        if (
                            action == ACTION_START
                            and attempted == 0
                            and response.status == 200
                            and relay_result.get("ok") is True
                            and (
                                (
                                    _is_nonnegative_json_integer(reused_pending)
                                    and reused_pending > 0
                                )
                                # A committed Start intent stays authoritative after
                                # its short-lived pending record expires; the relay
                                # reports it as awaiting the device's registration.
                                # Re-sending would create a duplicate start, so this
                                # is an accepted idempotent state, not a failure.
                                or (
                                    _is_nonnegative_json_integer(
                                        reused_persistent_intent
                                    )
                                    and reused_persistent_intent > 0
                                )
                            )
                        ):
                            self.last_relay_accepted_pending = True
                            _LOGGER.info(
                                "HA LiveKit relay accepted idempotent pending start: endpoint=%s status=%s response=%s",
                                action,
                                response.status,
                                self.last_relay_response,
                            )
                            return False
                        self.last_relay_error_code = (
                            _relay_error_code(text)
                            or "zero_delivery_not_accepted"
                        )
                        self.last_relay_error = (
                            "Relay reported zero deliveries without an accepted pending "
                            f"registration: {self.last_relay_response}"
                        )
                        _LOGGER.warning(
                            "HA LiveKit relay rejected zero delivery: endpoint=%s status=%s response=%s",
                            action,
                            response.status,
                            self.last_relay_response,
                        )
                        return False
                if isinstance(relay_result, dict) and (
                    "ok" in relay_result and relay_result.get("ok") is not True
                ):
                    self.last_relay_error_code = (
                        _relay_error_code(text) or "relay_response_not_ok"
                    )
                    self.last_relay_error = (
                        "Relay response did not report success: "
                        f"{self.last_relay_response}"
                    )
                    _LOGGER.warning(
                        "HA LiveKit relay rejected unsuccessful 2xx response: endpoint=%s status=%s response=%s",
                        action,
                        response.status,
                        self.last_relay_response,
                    )
                    return False
                _LOGGER.debug(
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

    def _reset_last_relay_state(self) -> None:
        """Clear per-dispatch relay diagnostics before a new send decision."""
        self.last_relay_attempt_at = None
        self.last_relay_action = None
        self.last_relay_status_code = None
        self.last_relay_response = None
        self.last_relay_error = None
        self.last_relay_error_code = None
        self.last_relay_accepted_pending = False


def _is_nonnegative_json_integer(value: Any) -> bool:
    """Return whether a JSON counter is a non-negative integer, excluding bool."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _without_internal_entity_set_markers(
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Remove relay control markers reserved for service-built entity Set calls."""
    data = payload.get(ATTR_DATA)
    if not isinstance(data, dict) or not any(
        key in data for key in _RESERVED_ENTITY_SET_DATA_KEYS
    ):
        return payload

    sanitized = dict(payload)
    sanitized[ATTR_DATA] = {
        key: value
        for key, value in data.items()
        if key not in _RESERVED_ENTITY_SET_DATA_KEYS
    }
    return sanitized


def _is_entity_backed_set_message(message: dict[str, Any]) -> bool:
    """Return whether relay semantics must be known before local publication."""
    data = message.get("data")
    entity_id = message.get("entity_id")
    return (
        message.get("action") == ACTION_START
        and isinstance(data, dict)
        and data.get("entity_based") is True
        and data.get("source_service") == "set_activity"
        and isinstance(entity_id, str)
        and bool(entity_id.strip())
    )


def _relay_error_code(text: str) -> str | None:
    """Extract one bounded relay error code without trusting free-form text."""
    try:
        payload = json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if not isinstance(error, str) or not re.fullmatch(r"[a-z0-9_]{1,64}", error):
        return None
    return error


async def _async_read_limited_stream(source: Any, limit: int) -> bytes | None:
    """Read an aiohttp response without buffering beyond the safety limit."""
    content_length = getattr(source, "content_length", None)
    if isinstance(content_length, int) and content_length > limit:
        return None
    stream = getattr(source, "content", None)
    if stream is None or not hasattr(stream, "read"):
        raw = await source.read()
        return raw if len(raw) <= limit else None

    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await stream.read(min(4096, limit + 1 - size))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
        if size > limit:
            return None
    return b"".join(chunks)


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


def _webhook_signed_bytes(
    body: bytes,
    timestamp: str | None,
    nonce: str | None,
) -> bytes:
    """Return the versioned bytes covered by a freshness-bound webhook HMAC."""
    if timestamp is None and nonce is None:
        return body
    if not timestamp or not nonce:
        return b""
    return b"ha-livekit-v1\n" + timestamp.encode() + b"\n" + nonce.encode() + b"\n" + body


def _valid_home_assistant_instance_id(value: Any) -> bool:
    """Return whether a Home Assistant instance id can be used for relay routing."""
    if not isinstance(value, str):
        return False
    normalized = value.strip()
    return bool(re.fullmatch(r"ha_[a-f0-9]{32}", normalized)) and (
        normalized not in UNSAFE_HOME_ASSISTANT_INSTANCE_IDS
    )


def _log_instance_id(value: str) -> str:
    """Return a non-sensitive prefix for relay diagnostics."""
    return f"{value[:11]}..." if value else "missing"
