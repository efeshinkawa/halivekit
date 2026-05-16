"""Entity-derived Live Activity payload helpers."""

from __future__ import annotations

import logging
import re
from typing import Any

from homeassistant.core import HomeAssistant, State

from .const import (
    ATTR_ACTIVITY_ID,
    ATTR_DEVICE_ID,
    ATTR_DISPLAY_NAME,
    ATTR_END_WHEN,
    ATTR_ENTITY_ID,
    ATTR_PROGRESS,
    ATTR_PROGRESS_ENTITY_ID,
    ATTR_STATE,
    ATTR_SUBTITLE,
    ATTR_TEMPLATE,
    ATTR_TITLE,
)

_LOGGER = logging.getLogger(__name__)

_DOOR_DEVICE_CLASSES = {"door", "garage_door", "gate", "opening", "window"}
_DETECTION_DEVICE_CLASSES = {"motion", "occupancy", "presence", "moisture", "smoke", "gas", "problem", "safety"}
_OPEN_STATES = {"on", "open", "opening", "unlocked"}
_CLOSED_STATES = {"off", "closed", "closing", "locked"}


def build_entity_activity_payload(
    hass: HomeAssistant,
    payload: dict[str, Any],
    source_service: str,
) -> dict[str, Any] | None:
    """Build a start/update payload from the current Home Assistant entity state."""
    entity_id = str(payload[ATTR_ENTITY_ID]).strip()
    entity_state = hass.states.get(entity_id)
    if entity_state is None:
        _LOGGER.warning(
            "HA LiveKit %s skipped: entity_id %s was not found",
            source_service,
            entity_id,
        )
        return None

    progress_entity_id = _clean_string(payload.get(ATTR_PROGRESS_ENTITY_ID))
    progress_state = None
    if progress_entity_id:
        progress_state = hass.states.get(progress_entity_id)
        if progress_state is None:
            _LOGGER.warning(
                "HA LiveKit %s continuing without progress: progress_entity_id %s was not found",
                source_service,
                progress_entity_id,
            )

    activity_id = _clean_string(payload.get(ATTR_ACTIVITY_ID)) or _activity_id_from_entity_id(entity_id)
    template = _clean_string(payload.get(ATTR_TEMPLATE)) or _infer_template(entity_state, progress_state)
    display_name = _clean_string(payload.get(ATTR_DISPLAY_NAME)) or _friendly_name(entity_state)
    title = _clean_string(payload.get(ATTR_TITLE)) or display_name
    state_text = _clean_string(payload.get(ATTR_STATE)) or _display_state(entity_state, template)
    progress = _progress_value(payload.get(ATTR_PROGRESS))
    if progress is None:
        progress = (
            _progress_from_state(progress_state, allow_unitless_state=True)
            if progress_state
            else _progress_from_state(entity_state)
        )

    data = _entity_data(entity_state, template, state_text, progress_state, source_service)
    if progress_entity_id:
        data["progress_entity_id"] = progress_entity_id
    if progress_state is not None:
        data["progress_display_name"] = _friendly_name(progress_state)
        data["progress_value"] = progress_state.state
        progress_unit = _unit(progress_state)
        if progress_unit:
            data["progress_unit"] = progress_unit

    subtitle = _clean_string(payload.get(ATTR_SUBTITLE)) or _default_subtitle(
        entity_state,
        template,
        display_name,
        state_text,
        data,
    )

    result: dict[str, Any] = {
        ATTR_ACTIVITY_ID: activity_id,
        ATTR_ENTITY_ID: entity_id,
        ATTR_TITLE: title,
        ATTR_DISPLAY_NAME: display_name,
        ATTR_SUBTITLE: subtitle,
        ATTR_TEMPLATE: template,
        ATTR_STATE: state_text,
        "data": data,
    }

    if progress is not None:
        result[ATTR_PROGRESS] = progress
    if device_id := _clean_string(payload.get(ATTR_DEVICE_ID)):
        result[ATTR_DEVICE_ID] = device_id
    if end_when := payload.get(ATTR_END_WHEN):
        result["data"]["end_when"] = end_when

    return result


def _entity_data(
    state: State,
    template: str,
    state_text: str,
    progress_state: State | None,
    source_service: str,
) -> dict[str, Any]:
    attrs = state.attributes
    domain = _domain(state.entity_id)
    unit = _unit(state)
    data: dict[str, Any] = {
        "entity_based": True,
        "source": "home_assistant_entity",
        "source_service": source_service,
        "entity_id": state.entity_id,
        "friendly_name": _friendly_name(state),
        "entity_domain": domain,
        "domain": domain,
        "raw_state": state.state,
        "value": state.state,
        "display_state": state_text,
        "icon_name": _icon_name(state, template),
        "display_style": _display_style(template),
        "theme": "homeAssistant",
        "attributes": _attributes_summary(state),
    }

    if unit:
        data["unit"] = unit
        data["unit_of_measurement"] = unit
    if device_class := _device_class(state):
        data["device_class"] = device_class
    if secondary := _secondary_state(state, template, progress_state):
        data["secondary_state"] = secondary

    if domain == "climate":
        _copy_attribute(attrs, data, "current_temperature")
        _copy_attribute(attrs, data, "temperature", "target_temperature")
        _copy_attribute(attrs, data, "target_temp_low")
        _copy_attribute(attrs, data, "target_temp_high")
        data["hvac_mode"] = state.state
    elif domain == "vacuum":
        _copy_attribute(attrs, data, "battery_level")
        for source_key, target_key in (
            ("room", "room"),
            ("current_room", "room"),
            ("status", "status"),
            ("fan_speed", "fan_speed"),
        ):
            if target_key not in data:
                _copy_attribute(attrs, data, source_key, target_key)
    elif domain == "light":
        _copy_attribute(attrs, data, "brightness")
    elif domain == "cover":
        _copy_attribute(attrs, data, "current_position")
    elif domain == "timer":
        _copy_attribute(attrs, data, "remaining")
        _copy_attribute(attrs, data, "remaining_time")

    return data


def _default_subtitle(
    state: State,
    template: str,
    display_name: str,
    state_text: str,
    data: dict[str, Any],
) -> str:
    domain = _domain(state.entity_id)
    lower = state_text.lower()

    if domain in {"binary_sensor", "lock"} or _normalize(template) in {"door", "security"}:
        if lower in {"open", "unlocked"}:
            return f"{display_name} is open"
        if lower in {"closed", "locked"}:
            return f"{display_name} is closed"
        return f"{display_name}: {state_text}"

    if domain in {"light", "switch", "input_boolean"}:
        return f"{display_name} is {lower}"

    if domain == "climate":
        target = data.get("target_temperature") or data.get("temperature")
        if target is not None:
            unit = data.get("unit") or state.attributes.get("temperature_unit") or ""
            return f"{state_text} -> {target}{unit}"
        return f"{display_name}: {state_text}"

    if domain == "vacuum":
        pieces = [str(value) for value in (data.get("room"), data.get("status")) if value]
        battery = data.get("battery_level")
        if battery is not None:
            pieces.append(f"{battery}% battery")
        return " - ".join(pieces) or f"{display_name}: {state_text}"

    if _normalize(template) in {"laundry", "washing_machine", "washingmachine", "dishwasher"}:
        progress = data.get("progress_value")
        if progress is not None:
            return f"{display_name}: {progress}{data.get('progress_unit', '')}"
        return f"{display_name}: {state_text}"

    return f"{display_name}: {state_text}"


def _display_state(state: State, template: str) -> str:
    domain = _domain(state.entity_id)
    raw = str(state.state).strip()
    normalized = raw.casefold()

    if normalized in {"unknown", "unavailable"}:
        return normalized.capitalize()

    if domain == "binary_sensor":
        device_class = _device_class(state)
        if device_class in _DOOR_DEVICE_CLASSES or _normalize(template) in {"door", "security"}:
            if normalized in _OPEN_STATES:
                return "Open"
            if normalized in _CLOSED_STATES:
                return "Closed"
        if device_class in _DETECTION_DEVICE_CLASSES:
            if normalized == "on":
                return "Detected"
            if normalized == "off":
                return "Clear"
        if normalized in {"on", "off"}:
            return normalized.capitalize()

    if _normalize(template) in {"door", "security"}:
        if normalized in _OPEN_STATES:
            return "Open"
        if normalized in _CLOSED_STATES:
            return "Closed"

    if domain == "lock":
        if normalized == "locked":
            return "Locked"
        if normalized == "unlocked":
            return "Unlocked"

    if domain in {"light", "switch", "input_boolean"} and normalized in {"on", "off"}:
        return normalized.capitalize()

    if domain == "cover":
        if normalized in {"open", "closed", "opening", "closing"}:
            return normalized.capitalize()
        position = state.attributes.get("current_position")
        if position is not None:
            return f"{position}%"

    if domain == "climate":
        current = _numeric_attribute(state.attributes, "current_temperature")
        if current is not None:
            unit = state.attributes.get("temperature_unit") or _unit(state) or ""
            return f"{_format_number(current)}{unit}"
        return raw.replace("_", " ").title()

    if domain == "sensor":
        unit = _unit(state)
        return f"{raw} {unit}" if unit and unit not in raw else raw

    return raw.replace("_", " ").title() if normalized == raw and "_" in raw else raw.capitalize()


def _secondary_state(state: State, template: str, progress_state: State | None) -> str | None:
    domain = _domain(state.entity_id)
    attrs = state.attributes

    if progress_state is not None:
        unit = _unit(progress_state) or ""
        return f"{progress_state.state}{unit}"

    if domain == "climate":
        mode = str(state.state).replace("_", " ").title()
        target = attrs.get("temperature")
        if target is not None:
            unit = attrs.get("temperature_unit") or _unit(state) or ""
            return f"{mode} -> {target}{unit}"
        return mode

    if domain == "vacuum":
        battery = attrs.get("battery_level")
        room = attrs.get("room") or attrs.get("current_room")
        if room and battery is not None:
            return f"{room} - {battery}%"
        if battery is not None:
            return f"{battery}% battery"
        if room:
            return str(room)

    if domain == "light":
        brightness = attrs.get("brightness")
        if brightness is not None:
            try:
                return f"{round((float(brightness) / 255) * 100)}% brightness"
            except (TypeError, ValueError):
                return None

    if domain == "cover":
        position = attrs.get("current_position")
        if position is not None:
            return f"{position}% open"

    if domain == "timer":
        remaining = attrs.get("remaining") or attrs.get("remaining_time")
        if remaining:
            return str(remaining)

    if _normalize(template) in {"laundry", "washing_machine", "washingmachine", "dishwasher"}:
        remaining = attrs.get("remaining_time") or attrs.get("remaining") or attrs.get("time_remaining")
        if remaining:
            return f"{remaining} remaining"

    return None


def _infer_template(state: State, progress_state: State | None) -> str:
    domain = _domain(state.entity_id)
    device_class = _device_class(state)

    if domain == "binary_sensor" and device_class in _DOOR_DEVICE_CLASSES:
        return "door"
    if domain == "lock":
        return "door"
    if domain == "climate":
        return "climate"
    if domain == "vacuum":
        return "vacuum"
    if domain == "timer":
        return "timer"
    if domain == "sensor":
        if progress_state is not None:
            return "laundry"
        if device_class in {"power", "energy", "voltage", "current"}:
            return "energy"
        if device_class == "temperature":
            return "climate"
        if _unit(state) == "%":
            return "laundry"
    return "custom"


def _display_style(template: str) -> str:
    normalized = _normalize(template)
    styles = {
        "door": "security",
        "security": "security",
        "laundry": "progress",
        "washing_machine": "progress",
        "washingmachine": "progress",
        "dishwasher": "progress",
        "vacuum": "vacuum",
        "climate": "climate",
        "energy": "energy",
        "timer": "timer",
    }
    return styles.get(normalized, "compactStatus")


def _icon_name(state: State, template: str) -> str:
    domain = _domain(state.entity_id)
    normalized_state = str(state.state).casefold()
    device_class = _device_class(state)
    normalized_template = _normalize(template)

    if normalized_template in {"laundry", "washing_machine", "washingmachine"}:
        return "washer.fill"
    if normalized_template == "dishwasher":
        return "dishwasher.fill"
    if normalized_template == "vacuum" or domain == "vacuum":
        return "sparkles"
    if normalized_template == "climate" or domain == "climate":
        return "thermometer.medium"
    if normalized_template == "energy":
        return "bolt.fill"
    if domain == "light":
        return "lightbulb.fill" if normalized_state == "on" else "lightbulb"
    if domain == "lock":
        return "lock.open.fill" if normalized_state == "unlocked" else "lock.fill"
    if domain == "binary_sensor" and device_class in _DOOR_DEVICE_CLASSES:
        return "door.left.hand.open" if normalized_state in _OPEN_STATES else "door.left.hand.closed"
    if domain == "sensor" and _unit(state) == "%":
        return "percent"
    return "dot.radiowaves.left.and.right"


def _progress_from_state(state: State | None, allow_unitless_state: bool = False) -> float | None:
    if state is None:
        return None

    for key in ("progress", "progress_percent", "percentage", "percent", "completion"):
        progress = _progress_value(state.attributes.get(key))
        if progress is not None:
            return progress

    unit = _unit(state)
    if unit == "%" or allow_unitless_state:
        return _progress_value(state.state, unit, allow_unitless=allow_unitless_state)
    return None


def _attributes_summary(state: State) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for key in (
        "friendly_name",
        "device_class",
        "unit_of_measurement",
        "brightness",
        "current_position",
        "current_temperature",
        "temperature",
        "target_temp_low",
        "target_temp_high",
        "hvac_mode",
        "battery_level",
        "room",
        "current_room",
        "status",
        "remaining",
        "remaining_time",
        "progress",
        "progress_percent",
        "percentage",
        "percent",
        "completion",
    ):
        value = state.attributes.get(key)
        if value is not None and value != "":
            summary[key] = value
    return summary


def _progress_value(value: Any, unit: str | None = None, allow_unitless: bool = True) -> float | None:
    if value is None or value == "":
        return None

    try:
        number = float(str(value).strip().rstrip("%"))
    except (TypeError, ValueError):
        return None

    if number < 0:
        return 0
    if number <= 1 and unit != "%":
        return number
    if number <= 100 and (unit == "%" or allow_unitless):
        return number / 100
    return 1


def _friendly_name(state: State) -> str:
    return _clean_string(state.attributes.get("friendly_name")) or state.entity_id


def _domain(entity_id: str) -> str:
    return entity_id.split(".", 1)[0]


def _activity_id_from_entity_id(entity_id: str) -> str:
    object_id = entity_id.split(".", 1)[-1]
    value = re.sub(r"[^A-Za-z0-9_-]+", "_", object_id).strip("_")
    value = re.sub(r"_+", "_", value)
    return value or "ha_livekit_activity"


def _unit(state: State) -> str | None:
    return _clean_string(state.attributes.get("unit_of_measurement"))


def _device_class(state: State) -> str | None:
    value = _clean_string(state.attributes.get("device_class"))
    return value.casefold() if value else None


def _numeric_attribute(attrs: dict[str, Any], key: str) -> float | None:
    value = attrs.get(key)
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _copy_attribute(
    attrs: dict[str, Any],
    data: dict[str, Any],
    source_key: str,
    target_key: str | None = None,
) -> None:
    value = attrs.get(source_key)
    if value is not None and value != "":
        data[target_key or source_key] = value


def _format_number(value: float) -> str:
    return str(int(value)) if value.is_integer() else f"{value:.1f}"


def _normalize(value: str | None) -> str:
    return (value or "").strip().casefold().replace("-", "_").replace(" ", "_")


def _clean_string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
