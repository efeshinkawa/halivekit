"""Webhook support for HA LiveKit."""

from __future__ import annotations

import asyncio
import json
import logging

from aiohttp import web

from homeassistant.components import webhook
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import (
    DOMAIN,
    HEADER_NONCE,
    HEADER_SECRET,
    HEADER_SIGNATURE,
    HEADER_TIMESTAMP,
    WEBHOOK_ID,
)
from .coordinator import (
    HALiveKitCoordinator,
    WEBHOOK_AUTH_OK,
    WEBHOOK_AUTH_OK_LEGACY_SECRET,
    WEBHOOK_AUTH_OK_LEGACY_SIGNATURE,
)
from .security import (
    MAX_WEBHOOK_BODY_BYTES,
    PayloadValidationError,
    validate_routable_activity_payload,
)

_LOGGER = logging.getLogger(__name__)


def async_register_webhook(
    hass: HomeAssistant,
    entry: ConfigEntry,
    coordinator: HALiveKitCoordinator,
) -> None:
    """Register the HA LiveKit webhook."""

    async def _handle(
        hass: HomeAssistant,
        webhook_id: str,
        request: web.Request,
    ) -> web.Response:
        raw = await _async_read_limited_body(request)
        if raw is None:
            return web.json_response({"ok": False, "error": "payload_too_large"}, status=413)

        signature = request.headers.get(HEADER_SIGNATURE)
        timestamp = request.headers.get(HEADER_TIMESTAMP)
        nonce = request.headers.get(HEADER_NONCE)
        header_secret = request.headers.get(HEADER_SECRET)

        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)

        if not isinstance(payload, dict):
            return web.json_response({"ok": False, "error": "payload_must_be_object"}, status=400)

        payload_secret = payload.get("secret")
        legacy_secret = header_secret or (payload_secret if isinstance(payload_secret, str) else None)
        auth_result = coordinator.authenticate_webhook_request(
            raw,
            signature,
            timestamp,
            nonce,
            legacy_secret,
        )
        if auth_result not in {
            WEBHOOK_AUTH_OK,
            WEBHOOK_AUTH_OK_LEGACY_SIGNATURE,
            WEBHOOK_AUTH_OK_LEGACY_SECRET,
        }:
            _LOGGER.warning("Rejected HA LiveKit webhook request: %s", auth_result)
            return web.json_response({"ok": False, "error": "unauthorized"}, status=401)

        try:
            validate_routable_activity_payload(payload)
        except PayloadValidationError as err:
            return web.json_response({"ok": False, "error": err.code}, status=400)

        await coordinator.async_handle_webhook(payload)
        return web.json_response({"ok": True})

    webhook.async_register(
        hass,
        DOMAIN,
        "HA LiveKit Update",
        WEBHOOK_ID,
        _handle,
        local_only=False,
    )
    entry.async_on_unload(lambda: webhook.async_unregister(hass, WEBHOOK_ID))


async def _async_read_limited_body(request: web.Request) -> bytes | None:
    """Read at most one byte beyond the webhook request limit."""
    content_length = request.content_length
    if content_length is not None and content_length > MAX_WEBHOOK_BODY_BYTES:
        return None

    content = getattr(request, "content", None)
    if content is None or not hasattr(content, "readexactly"):
        raw = await request.read()
    else:
        try:
            raw = await content.readexactly(MAX_WEBHOOK_BODY_BYTES + 1)
        except asyncio.IncompleteReadError as err:
            raw = err.partial

    return raw if len(raw) <= MAX_WEBHOOK_BODY_BYTES else None
