"""Diagnostic sensor for HA LiveKit."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import ATTR_ACTIVITY_ID, ATTR_DISPLAY_NAME, DOMAIN
from .coordinator import HALiveKitCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up HA LiveKit sensors."""
    coordinator: HALiveKitCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([HALiveKitLastEventSensor(coordinator, entry)])


class HALiveKitLastEventSensor(CoordinatorEntity[HALiveKitCoordinator], SensorEntity):
    """Expose the last HA LiveKit activity request for diagnostics."""

    _attr_has_entity_name = True
    _attr_name = "Last Activity Event"
    _attr_icon = "mdi:cellphone-arrow-down"

    def __init__(self, coordinator: HALiveKitCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_last_activity_event"

    @property
    def native_value(self) -> str | None:
        """Return the last action."""
        if not self.coordinator.data:
            return None
        return self.coordinator.data.get("action")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return diagnostic details."""
        if not self.coordinator.data:
            return {}

        data = dict(self.coordinator.data)
        return {
            "activity_id": data.get(ATTR_ACTIVITY_ID),
            "device_id": data.get("device_id"),
            "timestamp": data.get("timestamp"),
            "title": data.get("title"),
            "display_name": data.get(ATTR_DISPLAY_NAME),
            "entity_id": data.get("entity_id"),
            "relay_enabled": self.coordinator.relay_enabled,
            "relay_mode": self.coordinator.relay_mode,
            "home_assistant_instance_id": _redact_instance_id(self.coordinator.home_assistant_instance_id),
            "relay_url_configured": bool(self.coordinator.relay_url),
            "relay_shared_secret_configured": bool(self.coordinator.relay_shared_secret),
            "last_relay_attempt_at": self.coordinator.last_relay_attempt_at,
            "last_relay_action": self.coordinator.last_relay_action,
            "last_relay_status_code": self.coordinator.last_relay_status_code,
            "last_relay_response": self.coordinator.last_relay_response,
            "last_relay_error": self.coordinator.last_relay_error,
            "delivered_to_endpoint": self.coordinator.relay_enabled
            and self.coordinator.last_relay_status_code is not None
            and self.coordinator.last_relay_status_code < 400,
        }


def _redact_instance_id(value: str) -> str:
    """Return a diagnostics-safe Home Assistant instance identifier."""
    if not value:
        return ""
    if len(value) <= 14:
        return "<redacted-instance>"
    return f"{value[:9]}...{value[-5:]}"
