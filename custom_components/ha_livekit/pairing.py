"""Authenticated Home Assistant to managed-relay pairing for HA LiveKit."""

from __future__ import annotations

import json
import re
import secrets
from typing import Any

from aiohttp import ClientTimeout, web

from homeassistant.components.http.view import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_HOME_ASSISTANT_INSTANCE_ID,
    CONF_PENDING_MANAGED_RELAY_INSTANCE_ID,
    CONF_PENDING_MANAGED_RELAY_SHARED_SECRET,
    CONF_RELAY_ENABLED,
    CONF_RELAY_ENVIRONMENT,
    CONF_RELAY_MODE,
    CONF_RELAY_SHARED_SECRET,
    CONF_RELAY_URL,
    DOMAIN,
    HEADER_SECRET,
    MANAGED_RELAY_URL,
    RELAY_ENVIRONMENT_PRODUCTION,
    RELAY_ENVIRONMENT_SANDBOX,
    RELAY_MODE_MANAGED,
    UNSAFE_HOME_ASSISTANT_INSTANCE_IDS,
    VERSION,
)
from .coordinator import HALiveKitCoordinator

PAIRING_API_PATH = "/api/ha_livekit/relay/pair"
PAIRING_API_NAME = "api:ha_livekit:relay:pair"
DEVICES_API_PATH = "/api/ha_livekit/relay/devices"
DEVICES_API_NAME = "api:ha_livekit:relay:devices"
STATUS_API_PATH = "/api/ha_livekit/status"
STATUS_API_NAME = "api:ha_livekit:status"
PAIRING_VIEW_REGISTERED = "_pairing_view_registered"
MAX_PAIRING_REQUEST_BYTES = 8 * 1024
MAX_RELAY_RESPONSE_BYTES = 32 * 1024
MAX_PAIRING_TICKET_SECONDS = 15 * 60

_INSTANCE_ID_PATTERN = re.compile(r"^ha_[a-f0-9]{32}$")
_ROUTING_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
_PAIRING_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,512}$")


class RelayPairingError(RuntimeError):
    """Safe error returned by the authenticated pairing API."""

    def __init__(
        self,
        code: str,
        message: str,
        status: int = 400,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details or {}


class HALiveKitRelayPairingView(HomeAssistantView):
    """Issue a short-lived relay ticket to an authenticated administrator."""

    url = PAIRING_API_PATH
    name = PAIRING_API_NAME
    requires_auth = True

    async def post(self, request: web.Request) -> web.Response:
        """Provision the HA instance and return a device-scoped pairing ticket."""
        user = request["hass_user"]
        if user is None or not user.is_admin:
            return _pairing_json_response(
                {"ok": False, "error": "administrator_required"},
                status=403,
            )

        if (
            request.content_length is not None
            and request.content_length > MAX_PAIRING_REQUEST_BYTES
        ):
            return _pairing_json_response(
                {"ok": False, "error": "payload_too_large"},
                status=413,
            )

        raw = await _async_read_limited_stream(request, MAX_PAIRING_REQUEST_BYTES)
        if raw is None:
            return _pairing_json_response(
                {"ok": False, "error": "payload_too_large"},
                status=413,
            )
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            return _pairing_json_response(
                {"ok": False, "error": "invalid_json"},
                status=400,
            )

        hass: HomeAssistant = request.app["hass"]
        try:
            result = await async_create_relay_pairing(hass, payload)
        except RelayPairingError as err:
            return _pairing_json_response(
                {"ok": False, "error": err.code, "message": str(err), **err.details},
                status=err.status,
            )
        return _pairing_json_response(result)


class HALiveKitStatusView(HomeAssistantView):
    """Expose secret-free integration compatibility metadata."""

    url = STATUS_API_PATH
    name = STATUS_API_NAME
    requires_auth = True

    async def get(self, request: web.Request) -> web.Response:
        """Return only version and capability flags to an authenticated client."""
        return _pairing_json_response(
            {
                "ok": True,
                "integration_version": VERSION,
                "capabilities": {
                    "relay_pairing_v2": True,
                    "relay_devices_v2": True,
                },
            }
        )


class HALiveKitRelayDevicesView(HomeAssistantView):
    """List and revoke this HA instance's relay devices for administrators."""

    url = DEVICES_API_PATH
    name = DEVICES_API_NAME
    requires_auth = True

    async def get(self, request: web.Request) -> web.Response:
        """Return redacted, revocable device metadata."""
        user = request["hass_user"]
        if user is None or not user.is_admin:
            return _pairing_json_response(
                {"ok": False, "error": "administrator_required"},
                status=403,
            )
        hass: HomeAssistant = request.app["hass"]
        try:
            result = await async_list_relay_devices(hass)
        except RelayPairingError as err:
            return _pairing_json_response(
                {"ok": False, "error": err.code, "message": str(err)},
                status=err.status,
            )
        return _pairing_json_response(result)

    async def post(self, request: web.Request) -> web.Response:
        """Revoke one exact device ID without exposing relay credentials."""
        user = request["hass_user"]
        if user is None or not user.is_admin:
            return _pairing_json_response(
                {"ok": False, "error": "administrator_required"},
                status=403,
            )
        raw = await _async_read_limited_stream(request, MAX_PAIRING_REQUEST_BYTES)
        if raw is None:
            return _pairing_json_response(
                {"ok": False, "error": "payload_too_large"},
                status=413,
            )
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            return _pairing_json_response(
                {"ok": False, "error": "invalid_json"},
                status=400,
            )
        hass: HomeAssistant = request.app["hass"]
        try:
            result = await async_revoke_relay_device(hass, payload)
        except RelayPairingError as err:
            return _pairing_json_response(
                {"ok": False, "error": err.code, "message": str(err)},
                status=err.status,
            )
        return _pairing_json_response(result)


def _pairing_json_response(payload: dict[str, Any], *, status: int = 200) -> web.Response:
    """Return a non-cacheable pairing response because it can contain a ticket."""
    return web.json_response(
        payload,
        status=status,
        headers={"Cache-Control": "no-store"},
    )


def async_register_pairing_view(hass: HomeAssistant) -> None:
    """Register the authenticated view once per Home Assistant process."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get(PAIRING_VIEW_REGISTERED):
        return
    hass.http.register_view(HALiveKitRelayPairingView())
    hass.http.register_view(HALiveKitRelayDevicesView())
    hass.http.register_view(HALiveKitStatusView())
    domain_data[PAIRING_VIEW_REGISTERED] = True


async def async_list_relay_devices(hass: HomeAssistant) -> dict[str, Any]:
    """Fetch a bounded, secret-free inventory from the managed relay."""
    coordinator = _get_coordinator(hass)
    relay_url, instance_id, environment, relay_secret = _active_managed_relay(coordinator)
    session = async_get_clientsession(hass)
    result = await _async_relay_get(
        session,
        (
            f"{relay_url}/v2/devices"
            f"?home_assistant_instance_id={instance_id}"
            f"&apns_mode={environment}"
        ),
        headers={HEADER_SECRET: relay_secret},
    )
    if result.get("ok") is not True:
        raise RelayPairingError("invalid_relay_response", "Invalid relay inventory response.", 502)
    if result.get(CONF_HOME_ASSISTANT_INSTANCE_ID) != instance_id:
        raise RelayPairingError("invalid_relay_response", "Invalid relay inventory scope.", 502)
    if result.get("apns_environment") != environment:
        raise RelayPairingError("invalid_relay_response", "Invalid relay inventory scope.", 502)
    raw_devices = result.get("devices")
    if not isinstance(raw_devices, list) or len(raw_devices) > 256:
        raise RelayPairingError("invalid_relay_response", "Invalid relay inventory response.", 502)
    devices: list[dict[str, Any]] = []
    for item in raw_devices:
        if not isinstance(item, dict):
            raise RelayPairingError("invalid_relay_response", "Invalid relay inventory response.", 502)
        device_id = item.get("device_id")
        protocol = item.get("auth_protocol")
        generation = item.get("auth_generation")
        if (
            not isinstance(device_id, str)
            or not _ROUTING_ID_PATTERN.fullmatch(device_id)
            or protocol not in {"v1", "v2"}
            or not isinstance(generation, int)
            or generation < 0
        ):
            raise RelayPairingError("invalid_relay_response", "Invalid relay inventory response.", 502)
        devices.append(
            {
                "device_id": device_id,
                "friendly_device_name": _optional_safe_text(item.get("friendly_device_name"), 128),
                "auth_protocol": protocol,
                "auth_generation": generation,
                "app_version": _optional_safe_text(item.get("app_version"), 64),
                "updated_at": _optional_safe_text(item.get("updated_at"), 64),
            }
        )
    return {
        "ok": True,
        CONF_HOME_ASSISTANT_INSTANCE_ID: instance_id,
        "relay_environment": environment,
        "devices": devices,
    }


async def async_revoke_relay_device(
    hass: HomeAssistant,
    payload: Any,
) -> dict[str, Any]:
    """Revoke one exact relay device using HA's instance credential."""
    if not isinstance(payload, dict):
        raise RelayPairingError("invalid_payload", "The request body must be an object.")
    device_id = payload.get("device_id")
    if not isinstance(device_id, str) or not _ROUTING_ID_PATTERN.fullmatch(device_id):
        raise RelayPairingError("invalid_device_id", "A valid device_id is required.")
    coordinator = _get_coordinator(hass)
    relay_url, instance_id, environment, relay_secret = _active_managed_relay(coordinator)
    session = async_get_clientsession(hass)
    result = await _async_relay_post(
        session,
        f"{relay_url}/revoke-device",
        {
            CONF_HOME_ASSISTANT_INSTANCE_ID: instance_id,
            "instance_id_version": 2,
            "device_id": device_id,
            "apns_mode": environment,
        },
        headers={HEADER_SECRET: relay_secret},
        unavailable_code="relay_device_management_unavailable",
    )
    if (
        result.get("ok") is not True
        or result.get("revoked") is not True
        or result.get("device_id") != device_id
        or result.get(CONF_HOME_ASSISTANT_INSTANCE_ID) != instance_id
        or result.get("apns_environment") != environment
    ):
        raise RelayPairingError("invalid_relay_response", "Invalid relay revocation response.", 502)
    return {
        "ok": True,
        "revoked": True,
        "device_id": device_id,
        CONF_HOME_ASSISTANT_INSTANCE_ID: instance_id,
        "relay_environment": environment,
    }


def _active_managed_relay(
    coordinator: HALiveKitCoordinator,
) -> tuple[str, str, str, str]:
    relay_url = MANAGED_RELAY_URL.strip().rstrip("/")
    instance_id = coordinator.home_assistant_instance_id
    relay_secret = _safe_relay_secret(coordinator.relay_shared_secret)
    environment = coordinator.relay_environment
    if (
        coordinator.relay_mode != RELAY_MODE_MANAGED
        or not relay_url.startswith("https://")
        or not _safe_instance_id(instance_id)
        or not relay_secret
        or environment not in {RELAY_ENVIRONMENT_SANDBOX, RELAY_ENVIRONMENT_PRODUCTION}
    ):
        raise RelayPairingError(
            "managed_relay_unavailable",
            "Managed relay device management is not configured.",
            503,
        )
    return relay_url, instance_id, environment, relay_secret


async def async_create_relay_pairing(
    hass: HomeAssistant,
    payload: Any,
) -> dict[str, Any]:
    """Provision/verify the HA secret and request an exact-scope ticket."""
    validated = _validate_pairing_payload(payload)
    coordinator = _get_coordinator(hass)
    relay_url = MANAGED_RELAY_URL.strip().rstrip("/")
    if not relay_url.startswith("https://"):
        raise RelayPairingError(
            "managed_relay_unavailable",
            "The managed relay URL is not securely configured.",
            503,
        )

    entry = coordinator.config_entry
    canonical_instance_id, relay_secret, current_secret, requires_staging = (
        _managed_relay_identity(entry, coordinator)
    )
    validated[CONF_HOME_ASSISTANT_INSTANCE_ID] = canonical_instance_id

    if requires_staging:
        staged_options = {
            **entry.options,
            CONF_PENDING_MANAGED_RELAY_INSTANCE_ID: canonical_instance_id,
            CONF_PENDING_MANAGED_RELAY_SHARED_SECRET: relay_secret,
        }
        # Persist only recovery material before the network call. In particular,
        # do not replace relay_mode/url/environment/shared_secret here: those are
        # live coordinator inputs and an unsuccessful managed pairing must not
        # interrupt an already working custom relay.
        hass.config_entries.async_update_entry(entry, options=staged_options)

    session = async_get_clientsession(hass)
    provision_body = {
        CONF_HOME_ASSISTANT_INSTANCE_ID: validated[CONF_HOME_ASSISTANT_INSTANCE_ID],
        "instance_id_version": 2,
        CONF_RELAY_SHARED_SECRET: relay_secret,
    }
    if current_secret:
        provision_body["current_relay_shared_secret"] = current_secret

    try:
        provision_result = await _async_relay_post(
            session,
            f"{relay_url}/v2/instances/provision",
            provision_body,
            unavailable_code="relay_v2_unavailable",
        )
        _validate_provision_response(provision_result, canonical_instance_id)

        pairing_body = {
            CONF_HOME_ASSISTANT_INSTANCE_ID: canonical_instance_id,
            "instance_id_version": 2,
            "device_id": validated["device_id"],
            "push_to_start_token_hash": validated["push_to_start_token_hash"],
            "apns_mode": validated[CONF_RELAY_ENVIRONMENT],
            "bundle_id": validated.get("bundle_id"),
            "app_version": validated.get("app_version"),
        }
        pairing_body = {key: value for key, value in pairing_body.items() if value is not None}
        pairing_result = await _async_relay_post(
            session,
            f"{relay_url}/v2/pairing-tokens",
            pairing_body,
            headers={HEADER_SECRET: relay_secret},
            unavailable_code="relay_v2_unavailable",
        )
        pairing_token, expires_in = _validate_pairing_response(
            pairing_result,
            instance_id=canonical_instance_id,
            device_id=validated["device_id"],
            environment=validated[CONF_RELAY_ENVIRONMENT],
        )
    except RelayPairingError as err:
        # The recovery identifier is HA-generated or a previously validated HA
        # value. Never reflect the client-supplied candidate in an error.
        err.details[CONF_HOME_ASSISTANT_INSTANCE_ID] = canonical_instance_id
        raise

    enabled_options = {**entry.options}
    enabled_options.pop(CONF_PENDING_MANAGED_RELAY_INSTANCE_ID, None)
    enabled_options.pop(CONF_PENDING_MANAGED_RELAY_SHARED_SECRET, None)
    enabled_options.update(
        {
            CONF_RELAY_ENABLED: True,
            CONF_RELAY_MODE: RELAY_MODE_MANAGED,
            CONF_RELAY_URL: relay_url,
            CONF_RELAY_SHARED_SECRET: relay_secret,
            CONF_RELAY_ENVIRONMENT: validated[CONF_RELAY_ENVIRONMENT],
            CONF_HOME_ASSISTANT_INSTANCE_ID: canonical_instance_id,
        }
    )
    hass.config_entries.async_update_entry(entry, options=enabled_options)
    coordinator.async_update_listeners()

    return {
        "ok": True,
        "auth_protocol": "v2",
        "pairing_token": pairing_token,
        "expires_in": expires_in,
        "relay_url": relay_url,
        CONF_HOME_ASSISTANT_INSTANCE_ID: validated[CONF_HOME_ASSISTANT_INSTANCE_ID],
        "device_id": validated["device_id"],
        "apns_environment": validated[CONF_RELAY_ENVIRONMENT],
    }


async def _async_relay_post(
    session: Any,
    url: str,
    body: dict[str, Any],
    *,
    headers: dict[str, str] | None = None,
    unavailable_code: str,
) -> dict[str, Any]:
    request_headers = {"Content-Type": "application/json", **(headers or {})}
    try:
        async with session.post(
            url,
            data=json.dumps(body, separators=(",", ":"), sort_keys=True).encode(),
            headers=request_headers,
            timeout=ClientTimeout(total=10),
            allow_redirects=False,
        ) as response:
            if response.status in {404, 405, 501}:
                raise RelayPairingError(
                    unavailable_code,
                    "The managed relay does not support secure pairing yet.",
                    503,
                )
            if 300 <= response.status < 400:
                raise RelayPairingError(
                    "relay_redirect_rejected",
                    "The managed relay returned an unexpected redirect.",
                    502,
                )
            if response.status < 200 or response.status >= 300:
                raise RelayPairingError(
                    "relay_pairing_failed",
                    f"Managed relay pairing failed with HTTP {response.status}.",
                    502,
                )
            raw_response = await _async_read_limited_stream(response, MAX_RELAY_RESPONSE_BYTES)
            if raw_response is None:
                raise RelayPairingError(
                    "relay_response_too_large",
                    "The managed relay returned an oversized response.",
                    502,
                )
            try:
                text = raw_response.decode(response.charset or "utf-8")
            except (LookupError, UnicodeDecodeError) as err:
                raise RelayPairingError(
                    "invalid_relay_response",
                    "The managed relay returned invalid text.",
                    502,
                ) from err
    except RelayPairingError:
        raise
    except Exception as err:  # noqa: BLE001 - convert transport details to a safe response.
        raise RelayPairingError(
            "relay_unreachable",
            "The managed relay could not be reached.",
            503,
        ) from err

    try:
        decoded = json.loads(text) if text else {}
    except json.JSONDecodeError as err:
        raise RelayPairingError(
            "invalid_relay_response",
            "The managed relay returned invalid JSON.",
            502,
        ) from err
    if not isinstance(decoded, dict):
        raise RelayPairingError(
            "invalid_relay_response",
            "The managed relay returned an invalid response.",
            502,
        )
    return decoded


async def _async_relay_get(
    session: Any,
    url: str,
    *,
    headers: dict[str, str],
) -> dict[str, Any]:
    """Fetch one bounded JSON object without following credential-bearing redirects."""
    try:
        async with session.get(
            url,
            headers={"Accept": "application/json", **headers},
            timeout=ClientTimeout(total=10),
            allow_redirects=False,
        ) as response:
            if 300 <= response.status < 400:
                raise RelayPairingError(
                    "relay_redirect_rejected",
                    "The managed relay returned an unexpected redirect.",
                    502,
                )
            if response.status < 200 or response.status >= 300:
                raise RelayPairingError(
                    "relay_device_management_failed",
                    f"Managed relay device management failed with HTTP {response.status}.",
                    502,
                )
            raw_response = await _async_read_limited_stream(
                response,
                MAX_RELAY_RESPONSE_BYTES,
            )
            if raw_response is None:
                raise RelayPairingError(
                    "relay_response_too_large",
                    "The managed relay returned an oversized response.",
                    502,
                )
            try:
                text = raw_response.decode(response.charset or "utf-8")
            except (LookupError, UnicodeDecodeError) as err:
                raise RelayPairingError(
                    "invalid_relay_response",
                    "The managed relay returned invalid text.",
                    502,
                ) from err
    except RelayPairingError:
        raise
    except Exception as err:  # noqa: BLE001 - convert transport details to a safe response.
        raise RelayPairingError(
            "relay_unreachable",
            "The managed relay could not be reached.",
            503,
        ) from err

    try:
        decoded = json.loads(text) if text else {}
    except json.JSONDecodeError as err:
        raise RelayPairingError(
            "invalid_relay_response",
            "The managed relay returned invalid JSON.",
            502,
        ) from err
    if not isinstance(decoded, dict):
        raise RelayPairingError(
            "invalid_relay_response",
            "The managed relay returned an invalid response.",
            502,
        )
    return decoded


async def _async_read_limited_stream(source: Any, limit: int) -> bytes | None:
    """Read an aiohttp request/response stream without buffering past limit."""
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


def _managed_relay_identity(
    entry: Any,
    coordinator: HALiveKitCoordinator,
) -> tuple[str, str, str, bool]:
    """Return one HA-owned managed identity/secret pair and staging state."""
    configured_instance_id = _safe_instance_id(
        entry.options.get(
            CONF_HOME_ASSISTANT_INSTANCE_ID,
            entry.data.get(CONF_HOME_ASSISTANT_INSTANCE_ID),
        )
    )
    configured_secret = _safe_relay_secret(coordinator.relay_shared_secret)
    if (
        coordinator.relay_mode == RELAY_MODE_MANAGED
        and configured_instance_id
        and configured_secret
    ):
        # A fully configured working managed relay wins over abandoned pending
        # material that may have survived a later manual configuration change.
        return configured_instance_id, configured_secret, configured_secret, False

    pending_instance_id = _safe_instance_id(
        entry.options.get(CONF_PENDING_MANAGED_RELAY_INSTANCE_ID)
    )
    pending_secret = _safe_relay_secret(
        entry.options.get(CONF_PENDING_MANAGED_RELAY_SHARED_SECRET)
    )
    if pending_instance_id and pending_secret:
        # On retry the pending secret may already have been committed by the
        # Worker, so it is both the desired and current proof.
        return pending_instance_id, pending_secret, pending_secret, False

    if coordinator.relay_mode == RELAY_MODE_MANAGED and configured_instance_id:
        return configured_instance_id, secrets.token_urlsafe(32), "", True

    # Never borrow a custom relay's credentials for the managed trust domain.
    # Likewise, an unsafe/missing legacy ID gets a new random secret so a known
    # shared value cannot become the root credential of a fresh tenant.
    return f"ha_{secrets.token_hex(16)}", secrets.token_urlsafe(32), "", True


def _safe_instance_id(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    normalized = value.strip()
    if (
        not _INSTANCE_ID_PATTERN.fullmatch(normalized)
        or normalized in UNSAFE_HOME_ASSISTANT_INSTANCE_IDS
    ):
        return ""
    return normalized


def _optional_safe_text(value: Any, limit: int) -> str | None:
    """Return bounded non-control text or None for relay inventory metadata."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise RelayPairingError(
            "invalid_relay_response",
            "Invalid relay inventory response.",
            502,
        )
    normalized = value.strip()
    if not normalized:
        return None
    if len(normalized) > limit or any(ord(character) < 32 for character in normalized):
        raise RelayPairingError(
            "invalid_relay_response",
            "Invalid relay inventory response.",
            502,
        )
    return normalized


def _safe_relay_secret(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    normalized = value.strip()
    return normalized if 32 <= len(normalized) <= 512 else ""


def _validate_provision_response(result: dict[str, Any], instance_id: str) -> None:
    if (
        result.get("ok") is not True
        or result.get("provisioned") is not True
        or result.get("auth_protocol") != "v2"
        or result.get("instance_id_version") != 2
        or result.get(CONF_HOME_ASSISTANT_INSTANCE_ID) != instance_id
    ):
        raise RelayPairingError(
            "invalid_relay_response",
            "The managed relay returned an invalid provisioning response.",
            502,
        )


def _validate_pairing_response(
    result: dict[str, Any],
    *,
    instance_id: str,
    device_id: str,
    environment: str,
) -> tuple[str, int]:
    pairing_token = result.get("pairing_token")
    expires_in = result.get("expires_in")
    if (
        result.get("ok") is not True
        or result.get("auth_protocol") != "v2"
        or result.get(CONF_HOME_ASSISTANT_INSTANCE_ID) != instance_id
        or result.get("device_id") != device_id
        or result.get("apns_environment") != environment
        or not isinstance(pairing_token, str)
        or not _PAIRING_TOKEN_PATTERN.fullmatch(pairing_token)
        or isinstance(expires_in, bool)
        or not isinstance(expires_in, int)
        or not 1 <= expires_in <= MAX_PAIRING_TICKET_SECONDS
    ):
        raise RelayPairingError(
            "invalid_relay_response",
            "The managed relay returned an invalid pairing response.",
            502,
        )
    return pairing_token, expires_in


def _validate_pairing_payload(payload: Any) -> dict[str, str]:
    if not isinstance(payload, dict):
        raise RelayPairingError("payload_must_be_object", "Pairing payload must be an object.")

    instance_id = payload.get(CONF_HOME_ASSISTANT_INSTANCE_ID)
    if instance_id is not None and not _safe_instance_id(instance_id):
        raise RelayPairingError("invalid_instance_id", "Home Assistant instance ID is invalid.")
    device_id = _required_string(payload, "device_id", 128)
    if not _ROUTING_ID_PATTERN.fullmatch(device_id):
        raise RelayPairingError("invalid_device_id", "Device ID contains unsupported characters.")
    token_hash = _required_string(payload, "push_to_start_token_hash", 64).lower()
    if not _SHA256_PATTERN.fullmatch(token_hash):
        raise RelayPairingError("invalid_push_token_hash", "Push token hash is invalid.")
    environment = _required_string(payload, CONF_RELAY_ENVIRONMENT, 16).lower()
    if environment not in {RELAY_ENVIRONMENT_PRODUCTION, RELAY_ENVIRONMENT_SANDBOX}:
        raise RelayPairingError("invalid_relay_environment", "Relay environment is invalid.")

    result = {
        "device_id": device_id,
        "push_to_start_token_hash": token_hash,
        CONF_RELAY_ENVIRONMENT: environment,
    }
    if instance_id is not None:
        # This is only a compatibility hint. async_create_relay_pairing replaces
        # it with HA's persisted canonical identity before any relay request.
        result[CONF_HOME_ASSISTANT_INSTANCE_ID] = _safe_instance_id(instance_id)
    for key, limit in (("bundle_id", 255), ("app_version", 64)):
        value = payload.get(key)
        if value is None:
            continue
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
            raise RelayPairingError("invalid_field", f"{key} is invalid.")
        result[key] = value.strip()
    return result


def _required_string(payload: dict[str, Any], key: str, limit: int) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RelayPairingError("missing_field", f"{key} is required.")
    normalized = value.strip()
    if len(normalized) > limit:
        raise RelayPairingError("field_too_long", f"{key} is too long.")
    return normalized


def _get_coordinator(hass: HomeAssistant) -> HALiveKitCoordinator:
    for coordinator in hass.data.get(DOMAIN, {}).values():
        if isinstance(coordinator, HALiveKitCoordinator):
            return coordinator
    raise RelayPairingError(
        "integration_not_configured",
        "HA LiveKit is not configured in Home Assistant.",
        409,
    )
