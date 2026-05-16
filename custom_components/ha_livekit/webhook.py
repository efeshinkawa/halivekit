"""Webhook support for HA LiveKit."""

from __future__ import annotations

import json
import logging

from aiohttp import web

from homeassistant.components import webhook
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN, HEADER_SECRET, HEADER_SIGNATURE, WEBHOOK_ID
from .coordinator import HALiveKitCoordinator

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
        raw = await request.read()
        signature = request.headers.get(HEADER_SIGNATURE)
        header_secret = request.headers.get(HEADER_SECRET)

        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except json.JSONDecodeError:
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)

        payload_secret = payload.get("secret") if isinstance(payload, dict) else None
        if not coordinator.verify_signature(raw, signature, header_secret or payload_secret):
            _LOGGER.warning("Rejected unsigned HA LiveKit webhook request")
            return web.json_response({"ok": False, "error": "unauthorized"}, status=401)

        if not isinstance(payload, dict):
            return web.json_response({"ok": False, "error": "payload_must_be_object"}, status=400)

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
