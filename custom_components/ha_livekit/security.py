"""Input validation helpers for HA LiveKit trust boundaries."""

from __future__ import annotations

import json
import math
from typing import Any


MAX_WEBHOOK_BODY_BYTES = 64 * 1024
MAX_ACTIVITY_PAYLOAD_BYTES = 48 * 1024
MAX_PAYLOAD_DEPTH = 8
MAX_PAYLOAD_ITEMS = 512
MAX_MAPPING_KEY_LENGTH = 128
MAX_GENERIC_STRING_LENGTH = 4096

_FIELD_STRING_LIMITS = {
    "action": 64,
    "type": 64,
    "activity_id": 128,
    "activityId": 128,
    "device_id": 256,
    "deviceId": 256,
    "home_assistant_instance_id": 128,
    "entity_id": 255,
    "progress_entity_id": 255,
    "entityId": 255,
    "primaryEntity": 255,
    "primaryEntityId": 255,
    "primary_entity": 255,
    "primary_entity_id": 255,
    "progressEntityId": 255,
    "secondaryEntity": 255,
    "secondaryEntityId": 255,
    "secondary_entity": 255,
    "secondary_entity_id": 255,
    "template": 128,
    "icon_name": 128,
    "iconName": 128,
    "display_style": 128,
    "theme": 128,
    "unit": 128,
    "title": 512,
    "display_name": 512,
    "displayName": 512,
    "friendly_name": 512,
    "subtitle": 1024,
    "state": 1024,
    "raw_state": 1024,
    "secondary_state": 1024,
    "reason": 512,
    "secret": 512,
}


class PayloadValidationError(ValueError):
    """Raised when an untrusted activity payload exceeds safe limits."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def validate_activity_payload(payload: Any) -> None:
    """Validate shape, depth and encoded size without mutating the payload."""
    if not isinstance(payload, dict):
        raise PayloadValidationError("payload_must_be_object")

    item_count = [0]
    _validate_value(payload, depth=0, item_count=item_count, field_name=None)

    try:
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, OverflowError) as err:
        raise PayloadValidationError("payload_not_json_safe") from err

    if len(encoded) > MAX_ACTIVITY_PAYLOAD_BYTES:
        raise PayloadValidationError("payload_too_large")


def _validate_value(
    value: Any,
    *,
    depth: int,
    item_count: list[int],
    field_name: str | None,
) -> None:
    if depth > MAX_PAYLOAD_DEPTH:
        raise PayloadValidationError("payload_too_deep")

    item_count[0] += 1
    if item_count[0] > MAX_PAYLOAD_ITEMS:
        raise PayloadValidationError("payload_too_complex")

    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise PayloadValidationError("payload_key_must_be_string")
            if not key or len(key) > MAX_MAPPING_KEY_LENGTH:
                raise PayloadValidationError("payload_key_too_long")
            _validate_value(
                item,
                depth=depth + 1,
                item_count=item_count,
                field_name=key,
            )
        return

    if isinstance(value, (list, tuple)):
        for item in value:
            _validate_value(
                item,
                depth=depth + 1,
                item_count=item_count,
                field_name=field_name,
            )
        return

    if isinstance(value, str):
        limit = _FIELD_STRING_LIMITS.get(field_name or "", MAX_GENERIC_STRING_LENGTH)
        if len(value) > limit:
            raise PayloadValidationError(f"field_too_long:{field_name or 'value'}")
        return

    if value is None or isinstance(value, (bool, int)):
        return

    if isinstance(value, float):
        if not math.isfinite(value):
            raise PayloadValidationError("payload_number_not_finite")
        return

    raise PayloadValidationError("payload_value_type_not_supported")
