"""Focused HA LiveKit security regression tests with lightweight HA fakes."""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import base64
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest


def _install_homeassistant_stubs() -> None:
    """Install enough Home Assistant stubs to import the integration modules."""
    aiohttp = types.ModuleType("aiohttp")

    class ClientTimeout:
        def __init__(self, total: int | None = None) -> None:
            self.total = total

    aiohttp.ClientTimeout = ClientTimeout

    web = types.ModuleType("aiohttp.web")

    class WebResponse:
        def __init__(self, payload: dict, status: int = 200, headers: dict | None = None) -> None:
            self.payload = payload
            self.status = status
            self.headers = headers or {}

    web.Request = object
    web.Response = WebResponse
    web.json_response = lambda payload, status=200, headers=None: WebResponse(payload, status, headers)
    aiohttp.web = web
    sys.modules.setdefault("aiohttp", aiohttp)
    sys.modules.setdefault("aiohttp.web", web)

    vol = types.ModuleType("voluptuous")
    vol.Schema = lambda value: value
    vol.Optional = lambda key, default=None: key
    vol.Required = lambda key: key
    vol.Coerce = lambda type_: type_
    vol.In = lambda values: lambda value: value
    vol.Any = lambda *args: lambda value: value
    sys.modules.setdefault("voluptuous", vol)

    homeassistant = types.ModuleType("homeassistant")
    sys.modules.setdefault("homeassistant", homeassistant)

    const = types.ModuleType("homeassistant.const")

    class Platform:
        SENSOR = "sensor"

    const.Platform = Platform
    sys.modules.setdefault("homeassistant.const", const)

    config_entries = types.ModuleType("homeassistant.config_entries")

    class ConfigEntry:
        pass

    config_entries.ConfigEntry = ConfigEntry
    sys.modules.setdefault("homeassistant.config_entries", config_entries)

    core = types.ModuleType("homeassistant.core")

    class HomeAssistant:
        pass

    class ServiceCall:
        pass

    def callback(func):
        return func

    core.HomeAssistant = HomeAssistant
    core.ServiceCall = ServiceCall
    core.State = object
    core.callback = callback
    sys.modules.setdefault("homeassistant.core", core)

    exceptions = types.ModuleType("homeassistant.exceptions")

    class HomeAssistantError(Exception):
        pass

    class Unauthorized(HomeAssistantError):
        def __init__(self, **kwargs) -> None:
            super().__init__("unauthorized")
            self.kwargs = kwargs

    class UnknownUser(HomeAssistantError):
        def __init__(self, **kwargs) -> None:
            super().__init__("unknown user")
            self.kwargs = kwargs

    exceptions.HomeAssistantError = HomeAssistantError
    exceptions.Unauthorized = Unauthorized
    exceptions.UnknownUser = UnknownUser
    sys.modules.setdefault("homeassistant.exceptions", exceptions)

    helpers = types.ModuleType("homeassistant.helpers")
    sys.modules.setdefault("homeassistant.helpers", helpers)

    cv = types.ModuleType("homeassistant.helpers.config_validation")
    cv.string = str
    cv.entity_id = str
    cv.boolean = bool
    sys.modules.setdefault("homeassistant.helpers.config_validation", cv)

    aiohttp_client = types.ModuleType("homeassistant.helpers.aiohttp_client")
    aiohttp_client.async_get_clientsession = lambda hass: hass.session
    sys.modules.setdefault("homeassistant.helpers.aiohttp_client", aiohttp_client)

    update_coordinator = types.ModuleType("homeassistant.helpers.update_coordinator")

    class DataUpdateCoordinator:
        @classmethod
        def __class_getitem__(cls, item):
            return cls

        def __init__(self, hass, logger, name: str) -> None:
            self.hass = hass
            self.data = None

        def async_set_updated_data(self, data) -> None:
            self.data = data

        def async_update_listeners(self) -> None:
            pass

    class CoordinatorEntity:
        @classmethod
        def __class_getitem__(cls, item):
            return cls

        def __init__(self, coordinator) -> None:
            self.coordinator = coordinator

    update_coordinator.DataUpdateCoordinator = DataUpdateCoordinator
    update_coordinator.CoordinatorEntity = CoordinatorEntity
    sys.modules.setdefault("homeassistant.helpers.update_coordinator", update_coordinator)

    entity_platform = types.ModuleType("homeassistant.helpers.entity_platform")
    entity_platform.AddEntitiesCallback = object
    sys.modules.setdefault("homeassistant.helpers.entity_platform", entity_platform)

    components = types.ModuleType("homeassistant.components")
    sys.modules.setdefault("homeassistant.components", components)

    webhook = types.ModuleType("homeassistant.components.webhook")
    webhook.async_register = lambda *args, **kwargs: None
    webhook.async_unregister = lambda *args, **kwargs: None
    components.webhook = webhook
    sys.modules.setdefault("homeassistant.components.webhook", webhook)

    http = types.ModuleType("homeassistant.components.http")
    http_view = types.ModuleType("homeassistant.components.http.view")

    class HomeAssistantView:
        pass

    http_view.HomeAssistantView = HomeAssistantView
    http.view = http_view
    components.http = http
    sys.modules.setdefault("homeassistant.components.http", http)
    sys.modules.setdefault("homeassistant.components.http.view", http_view)

    sensor = types.ModuleType("homeassistant.components.sensor")

    class SensorEntity:
        pass

    sensor.SensorEntity = SensorEntity
    sys.modules.setdefault("homeassistant.components.sensor", sensor)

    permissions_pkg = types.ModuleType("homeassistant.auth")
    sys.modules.setdefault("homeassistant.auth", permissions_pkg)
    permissions = types.ModuleType("homeassistant.auth.permissions")
    sys.modules.setdefault("homeassistant.auth.permissions", permissions)
    permissions_const = types.ModuleType("homeassistant.auth.permissions.const")
    permissions_const.POLICY_READ = "read"
    sys.modules.setdefault("homeassistant.auth.permissions.const", permissions_const)


_install_homeassistant_stubs()
coordinator_stub = types.ModuleType("custom_components.ha_livekit.coordinator")


class StubHALiveKitCoordinator:
    pass


coordinator_stub.HALiveKitCoordinator = StubHALiveKitCoordinator
coordinator_stub._without_internal_entity_set_markers = lambda payload: payload
sys.modules.setdefault("custom_components.ha_livekit.coordinator", coordinator_stub)

entity_activity_stub = types.ModuleType("custom_components.ha_livekit.entity_activity")
entity_activity_stub.build_entity_activity_payload = lambda *args, **kwargs: None
sys.modules.setdefault("custom_components.ha_livekit.entity_activity", entity_activity_stub)

webhook_stub = types.ModuleType("custom_components.ha_livekit.webhook")
webhook_stub.async_register_webhook = lambda *args, **kwargs: None
sys.modules.setdefault("custom_components.ha_livekit.webhook", webhook_stub)

ha_init = importlib.import_module("custom_components.ha_livekit")
ha_sensor = importlib.import_module("custom_components.ha_livekit.sensor")
ha_security = importlib.import_module("custom_components.ha_livekit.security")


def _load_real_integration_module(module_name: str, filename: str):
    """Load a real integration module under a test-only package name."""
    path = Path(__file__).parents[1] / "custom_components" / "ha_livekit" / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


ha_coordinator = _load_real_integration_module(
    "custom_components.ha_livekit._security_test_coordinator",
    "coordinator.py",
)
ha_init._without_internal_entity_set_markers = (
    ha_coordinator._without_internal_entity_set_markers
)
ha_entity_activity = _load_real_integration_module(
    "custom_components.ha_livekit._security_test_entity_activity",
    "entity_activity.py",
)

_coordinator_stub_module = sys.modules["custom_components.ha_livekit.coordinator"]
sys.modules["custom_components.ha_livekit.coordinator"] = ha_coordinator
try:
    ha_webhook = _load_real_integration_module(
        "custom_components.ha_livekit._security_test_webhook",
        "webhook.py",
    )
    ha_pairing = _load_real_integration_module(
        "custom_components.ha_livekit._security_test_pairing",
        "pairing.py",
    )
finally:
    sys.modules["custom_components.ha_livekit.coordinator"] = _coordinator_stub_module


class FakeContext:
    def __init__(self, user_id: str | None) -> None:
        self.user_id = user_id


class FakeCall:
    def __init__(self, data: dict, user_id: str | None = "admin") -> None:
        self.data = data
        self.context = FakeContext(user_id)


class FakePermissions:
    def __init__(self, readable: set[str]) -> None:
        self.readable = readable

    def check_entity(self, entity_id: str, policy: str) -> bool:
        return policy == "read" and entity_id in self.readable


class FakeUser:
    def __init__(self, *, is_admin: bool, readable: set[str] | None = None) -> None:
        self.is_admin = is_admin
        self.permissions = FakePermissions(readable or set())


class FakeAuth:
    def __init__(self, users: dict[str, FakeUser]) -> None:
        self.users = users

    async def async_get_user(self, user_id: str) -> FakeUser | None:
        return self.users.get(user_id)


class FakeState:
    def __init__(self, entity_id: str) -> None:
        self.entity_id = entity_id


class FakeStates:
    def __init__(self, entity_ids: list[str] | None = None) -> None:
        self.entity_ids = entity_ids or []

    def async_all(self) -> list[FakeState]:
        return [FakeState(entity_id) for entity_id in self.entity_ids]


class FakeEntry:
    def __init__(self) -> None:
        self.options: dict = {}
        self.data: dict = {}


class FakeConfigEntries:
    def __init__(self) -> None:
        self.updates: list[dict] = []

    def async_update_entry(self, entry: FakeEntry, *, options: dict) -> None:
        entry.options = options
        self.updates.append(options)


class FakeServices:
    def __init__(self) -> None:
        self.registered: list[str] = []
        self.handlers: dict[str, object] = {}

    def has_service(self, domain: str, service: str) -> bool:
        return False

    def async_register(self, domain: str, service: str, handler, schema=None) -> None:
        self.registered.append(service)
        self.handlers[service] = handler


class FakeAdminServiceHelper:
    def __init__(self) -> None:
        self.registered: list[str] = []

    def async_register_admin_service(self, domain: str, service: str, handler, schema=None) -> None:
        self.registered.append(service)


class FakeHTTP:
    def __init__(self) -> None:
        self.views: list[object] = []

    def register_view(self, view: object) -> None:
        self.views.append(view)


class FakeBus:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def async_fire(self, event_type: str, event_data: dict) -> None:
        self.events.append((event_type, event_data))


class FakeHass:
    def __init__(self, users: dict[str, FakeUser], states: list[str] | None = None) -> None:
        self.data = {ha_init.DOMAIN: {}}
        self.auth = FakeAuth(users)
        self.states = FakeStates(states)
        self.config_entries = FakeConfigEntries()
        self.services = FakeServices()
        self.helpers = types.SimpleNamespace(service=FakeAdminServiceHelper())
        self.http = FakeHTTP()
        self.bus = FakeBus()
        self.session = None


class FakeCoordinator:
    def __init__(
        self,
        relay_secret: str = "",
        dispatch_result=None,
        *,
        relay_mode: str = ha_init.RELAY_MODE_MANAGED,
        instance_id: str = "",
    ) -> None:
        self.config_entry = FakeEntry()
        self.config_entry.data = {
            ha_init.CONF_RELAY_MODE: relay_mode,
            ha_init.CONF_HOME_ASSISTANT_INSTANCE_ID: instance_id,
        }
        self._relay_secret = relay_secret
        self.dispatch_result = dispatch_result
        self.sent: list[tuple[str, dict]] = []
        self.updated = False

    @property
    def relay_shared_secret(self) -> str:
        return self._relay_secret

    @property
    def relay_mode(self) -> str:
        return self.config_entry.options.get(
            ha_init.CONF_RELAY_MODE,
            self.config_entry.data.get(
                ha_init.CONF_RELAY_MODE,
                ha_init.RELAY_MODE_MANAGED,
            ),
        )

    def async_update_listeners(self) -> None:
        self.updated = True

    async def async_send_activity(self, action: str, payload: dict):
        self.sent.append((action, payload))
        return self.dispatch_result


class SecurityRegressionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.original_coordinator = ha_init.HALiveKitCoordinator
        self.original_provision = ha_init._async_provision_managed_relay_secret
        self.original_builder = ha_init.build_entity_activity_payload
        ha_init.HALiveKitCoordinator = FakeCoordinator

    def tearDown(self) -> None:
        ha_init.HALiveKitCoordinator = self.original_coordinator
        ha_init._async_provision_managed_relay_secret = self.original_provision
        ha_init.build_entity_activity_payload = self.original_builder

    async def test_admin_configure_managed_relay_provisions_then_updates_entry(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        existing_secret = "existing-managed-relay-secret-value"
        instance_id = "ha_1234567890abcdef1234567890abcdef"
        coordinator = FakeCoordinator(
            relay_secret=existing_secret,
            instance_id=instance_id,
        )
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        provision_calls = []

        async def fake_provision(*args):
            provision_calls.append(args)

        ha_init._async_provision_managed_relay_secret = fake_provision
        call = FakeCall(
            {
                "relay_url": ha_init.MANAGED_RELAY_URL,
                "relay_app_registration_secret": "app-registration-secret",
                "relay_environment": "production",
                "home_assistant_instance_id": "ha_1234567890abcdef1234567890abcdef",
            },
            user_id="admin",
        )

        await ha_init._handle_configure_managed_relay(hass, call)

        self.assertEqual(len(provision_calls), 1)
        self.assertEqual(len(hass.config_entries.updates), 1)
        self.assertEqual(provision_calls[0][-2:], (existing_secret, existing_secret))
        options = hass.config_entries.updates[-1]
        self.assertEqual(options["relay_url"], ha_init.MANAGED_RELAY_URL)
        self.assertEqual(options["relay_environment"], "production")
        self.assertEqual(
            options["home_assistant_instance_id"],
            "ha_1234567890abcdef1234567890abcdef",
        )
        self.assertEqual(options["relay_shared_secret"], existing_secret)
        self.assertTrue(coordinator.updated)

    async def test_legacy_pairing_failure_preserves_custom_relay_and_retry_reuses_pending_secret(
        self,
    ) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        custom_secret = "custom-relay-secret-that-stays-active"
        custom_id = "ha_cccccccccccccccccccccccccccccccc"
        requested_id = "ha_dddddddddddddddddddddddddddddddd"
        coordinator = FakeCoordinator(
            relay_secret=custom_secret,
            relay_mode=ha_coordinator.RELAY_MODE_CUSTOM,
            instance_id=custom_id,
        )
        original_options = {
            ha_init.CONF_RELAY_ENABLED: True,
            ha_init.CONF_RELAY_MODE: ha_coordinator.RELAY_MODE_CUSTOM,
            ha_init.CONF_RELAY_URL: "https://relay.internal.example/api",
            ha_init.CONF_RELAY_SHARED_SECRET: custom_secret,
            ha_init.CONF_RELAY_ENVIRONMENT: "sandbox",
            ha_init.CONF_HOME_ASSISTANT_INSTANCE_ID: custom_id,
        }
        coordinator.config_entry.options = dict(original_options)
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        provision_calls = []

        async def fail_once_then_succeed(*args):
            provision_calls.append(args)
            if len(provision_calls) == 1:
                raise ha_init.HomeAssistantError("simulated timeout")

        ha_init._async_provision_managed_relay_secret = fail_once_then_succeed
        call = FakeCall(
            {
                "relay_url": ha_init.MANAGED_RELAY_URL,
                "relay_app_registration_secret": "app-registration-secret",
                "relay_environment": "production",
                "home_assistant_instance_id": requested_id,
            },
            user_id="admin",
        )

        with self.assertRaises(ha_init.HomeAssistantError):
            await ha_init._handle_configure_managed_relay(hass, call)

        for key, value in original_options.items():
            self.assertEqual(coordinator.config_entry.options[key], value)
        pending_secret = coordinator.config_entry.options[
            ha_init.CONF_PENDING_MANAGED_RELAY_SHARED_SECRET
        ]
        self.assertEqual(
            coordinator.config_entry.options[
                ha_init.CONF_PENDING_MANAGED_RELAY_INSTANCE_ID
            ],
            requested_id,
        )
        self.assertFalse(coordinator.updated)

        await ha_init._handle_configure_managed_relay(hass, call)

        self.assertEqual(provision_calls[1][-2:], (pending_secret, pending_secret))
        self.assertEqual(
            coordinator.config_entry.options[ha_init.CONF_RELAY_SHARED_SECRET],
            pending_secret,
        )
        self.assertEqual(
            coordinator.config_entry.options[ha_init.CONF_HOME_ASSISTANT_INSTANCE_ID],
            requested_id,
        )
        self.assertNotIn(
            ha_init.CONF_PENDING_MANAGED_RELAY_SHARED_SECRET,
            coordinator.config_entry.options,
        )
        self.assertTrue(coordinator.updated)

    async def test_non_admin_configure_managed_relay_rejects_before_mutation(self) -> None:
        hass = FakeHass({"limited": FakeUser(is_admin=False)})
        hass.data[ha_init.DOMAIN]["entry"] = FakeCoordinator()
        provision_calls = []

        async def fake_provision(*args):
            provision_calls.append(args)

        ha_init._async_provision_managed_relay_secret = fake_provision
        call = FakeCall(
            {
                "relay_url": ha_init.MANAGED_RELAY_URL,
                "relay_app_registration_secret": "app-registration-secret",
                "home_assistant_instance_id": "ha_1234567890abcdef1234567890abcdef",
            },
            user_id="limited",
        )

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_configure_managed_relay(hass, call)

        self.assertEqual(provision_calls, [])
        self.assertEqual(hass.config_entries.updates, [])

    async def test_missing_user_configure_managed_relay_fails_closed(self) -> None:
        hass = FakeHass({})
        hass.data[ha_init.DOMAIN]["entry"] = FakeCoordinator()
        call = FakeCall(
            {
                "relay_url": ha_init.MANAGED_RELAY_URL,
                "relay_app_registration_secret": "app-registration-secret",
                "home_assistant_instance_id": "ha_1234567890abcdef1234567890abcdef",
            },
            user_id=None,
        )

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_configure_managed_relay(hass, call)

        self.assertEqual(hass.config_entries.updates, [])

    async def test_unauthorized_entity_rejects_before_payload_builder(self) -> None:
        hass = FakeHass({"limited": FakeUser(is_admin=False, readable=set())})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        builder_called = False

        def fake_builder(*args):
            nonlocal builder_called
            builder_called = True
            return {"activity_id": "secret"}

        ha_init.build_entity_activity_payload = fake_builder
        call = FakeCall({"entity_id": "sensor.secret"}, user_id="limited")

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_entity_service(
                hass,
                ha_init.ACTION_START,
                call,
                ha_init.SERVICE_START_ENTITY_ACTIVITY,
            )

        self.assertFalse(builder_called)
        self.assertEqual(coordinator.sent, [])

    async def test_unauthorized_progress_entity_rejects_before_payload_builder(self) -> None:
        hass = FakeHass({"limited": FakeUser(is_admin=False, readable={"sensor.allowed"})})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        builder_called = False

        def fake_builder(*args):
            nonlocal builder_called
            builder_called = True
            return {"activity_id": "secret"}

        ha_init.build_entity_activity_payload = fake_builder
        call = FakeCall(
            {"entity_id": "sensor.allowed", "progress_entity_id": "sensor.secret"},
            user_id="limited",
        )

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_entity_service(
                hass,
                ha_init.ACTION_START,
                call,
                ha_init.SERVICE_START_ENTITY_ACTIVITY,
            )

        self.assertFalse(builder_called)
        self.assertEqual(coordinator.sent, [])

    async def test_limited_entity_call_rejects_custom_content_overrides(self) -> None:
        hass = FakeHass({"limited": FakeUser(is_admin=False, readable={"sensor.allowed"})})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        builder_called = False

        def fake_builder(*args):
            nonlocal builder_called
            builder_called = True
            return {"activity_id": "allowed"}

        ha_init.build_entity_activity_payload = fake_builder
        call = FakeCall(
            {"entity_id": "sensor.allowed", "title": "Arbitrary broadcast text"},
            user_id="limited",
        )

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_entity_service(
                hass,
                ha_init.ACTION_START,
                call,
                ha_init.SERVICE_START_ENTITY_ACTIVITY,
            )

        self.assertFalse(builder_called)
        self.assertEqual(coordinator.sent, [])

    async def test_limited_entity_call_rejects_unknown_template(self) -> None:
        hass = FakeHass({"limited": FakeUser(is_admin=False, readable={"sensor.allowed"})})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {"entity_id": "sensor.allowed", "template": "attacker-controlled-template"},
            user_id="limited",
        )

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_entity_service(
                hass,
                ha_init.ACTION_START,
                call,
                ha_init.SERVICE_START_ENTITY_ACTIVITY,
            )

        self.assertEqual(coordinator.sent, [])

    async def test_admin_entity_call_still_sends_payload(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator

        def fake_builder(hass_arg, payload, source_service):
            return {"activity_id": "front_door", "entity_id": payload["entity_id"], "source": source_service}

        ha_init.build_entity_activity_payload = fake_builder
        call = FakeCall({"entity_id": "binary_sensor.front_door"}, user_id="admin")

        await ha_init._handle_entity_service(hass, ha_init.ACTION_START, call, ha_init.SERVICE_START_ENTITY_ACTIVITY)

        self.assertEqual(coordinator.sent, [("start", {
            "activity_id": "front_door",
            "entity_id": "binary_sensor.front_door",
            "source": ha_init.SERVICE_START_ENTITY_ACTIVITY,
        })])

    async def test_oversized_entity_derived_payload_rejects_before_dispatch(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator

        def fake_builder(*args):
            return {"activity_id": "front_door", "state": "x" * 1025}

        ha_init.build_entity_activity_payload = fake_builder
        call = FakeCall({"entity_id": "binary_sensor.front_door"}, user_id="admin")

        with self.assertRaisesRegex(ha_init.HomeAssistantError, "field_too_long:state"):
            await ha_init._handle_entity_service(
                hass,
                ha_init.ACTION_START,
                call,
                ha_init.SERVICE_START_ENTITY_ACTIVITY,
            )

        self.assertEqual(coordinator.sent, [])

    async def test_generic_start_rejects_unauthorized_entity_payload(self) -> None:
        hass = FakeHass({"limited": FakeUser(is_admin=False, readable=set())})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {"activity_id": "front_door", "entity_id": "binary_sensor.front_door"},
            user_id="limited",
        )

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_service(hass, ha_init.ACTION_START, call)

        self.assertEqual(coordinator.sent, [])

    async def test_generic_start_rejects_unauthorized_nested_entity_payload(self) -> None:
        hass = FakeHass({"limited": FakeUser(is_admin=False, readable={"sensor.allowed"})})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "power_status",
                "entity_id": "sensor.allowed",
                "data": {"progressEntityId": "sensor.secret_progress"},
            },
            user_id="limited",
        )

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_service(hass, ha_init.ACTION_START, call)

        self.assertEqual(coordinator.sent, [])

    async def test_generic_update_rejects_protected_entity_backed_activity_id(self) -> None:
        hass = FakeHass(
            {"limited": FakeUser(is_admin=False, readable=set())},
            states=["binary_sensor.front_door"],
        )
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall({"activity_id": "front_door", "state": "Open"}, user_id="limited")

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_service(hass, ha_init.ACTION_UPDATE, call)

        self.assertEqual(coordinator.sent, [])

    async def test_generic_end_rejects_protected_entity_backed_activity_id(self) -> None:
        hass = FakeHass(
            {"limited": FakeUser(is_admin=False, readable=set())},
            states=["binary_sensor.front_door"],
        )
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall({"activity_id": "front_door", "reason": "ended"}, user_id="limited")

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_service(hass, ha_init.ACTION_END, call)

        self.assertEqual(coordinator.sent, [])

    async def test_generic_raw_api_rejects_limited_user_even_with_readable_entity(self) -> None:
        hass = FakeHass(
            {"limited": FakeUser(is_admin=False, readable={"binary_sensor.front_door"})},
            states=["binary_sensor.front_door"],
        )
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall({"activity_id": "front_door", "state": "Open"}, user_id="limited")

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_service(hass, ha_init.ACTION_UPDATE, call)

        self.assertEqual(coordinator.sent, [])

    async def test_limited_user_cannot_send_entityless_manual_activity_flow(self) -> None:
        hass = FakeHass(
            {"limited": FakeUser(is_admin=False, readable=set())},
            states=["binary_sensor.front_door"],
        )
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        start = FakeCall({"activity_id": "custom_status", "title": "Custom"}, user_id="limited")
        update = FakeCall({"activity_id": "custom_status", "state": "Running"}, user_id="limited")
        end = FakeCall({"activity_id": "custom_status", "reason": "ended"}, user_id="limited")

        for action, call in (
            (ha_init.ACTION_START, start),
            (ha_init.ACTION_UPDATE, update),
            (ha_init.ACTION_END, end),
        ):
            with self.assertRaises(ha_init.Unauthorized):
                await ha_init._handle_service(hass, action, call)

        self.assertEqual(coordinator.sent, [])

    async def test_system_automation_context_preserves_entityless_manual_flow(self) -> None:
        hass = FakeHass({}, states=["binary_sensor.front_door"])
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        start = FakeCall({"activity_id": "custom_status", "title": "Custom"}, user_id=None)
        update = FakeCall({"activity_id": "custom_status", "state": "Running"}, user_id=None)
        end = FakeCall({"activity_id": "custom_status", "reason": "ended"}, user_id=None)

        await ha_init._handle_service(hass, ha_init.ACTION_START, start)
        await ha_init._handle_service(hass, ha_init.ACTION_UPDATE, update)
        await ha_init._handle_service(hass, ha_init.ACTION_END, end)

        self.assertEqual(
            coordinator.sent,
            [
                ("start", start.data),
                ("update", update.data),
                ("end", end.data),
            ],
        )

    async def test_admin_preserves_raw_activity_flow(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {"activity_id": "custom_status", "title": "Admin custom activity"},
            user_id="admin",
        )

        await ha_init._handle_service(hass, ha_init.ACTION_START, call)

        self.assertEqual(coordinator.sent, [("start", call.data)])

    async def test_raw_activity_cannot_spoof_entity_set_control_markers(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "custom_status",
                "entity_id": "switch.kitchen",
                "data": {
                    "entity_based": True,
                    "source_service": "set_activity",
                    "custom_value": "preserved",
                },
            },
            user_id="admin",
        )

        await ha_init._handle_service(hass, ha_init.ACTION_START, call)

        self.assertEqual(
            coordinator.sent,
            [(
                "start",
                {
                    "activity_id": "custom_status",
                    "entity_id": "switch.kitchen",
                    "data": {"custom_value": "preserved"},
                },
            )],
        )
        self.assertTrue(call.data["data"]["entity_based"])

    async def test_device_id_does_not_bypass_manual_activity_admin_policy(self) -> None:
        hass = FakeHass({"limited": FakeUser(is_admin=False)})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "custom_status",
                "device_id": "ios-device-controlled-by-attacker",
                "title": "Custom",
            },
            user_id="limited",
        )

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_service(hass, ha_init.ACTION_START, call)

        self.assertEqual(coordinator.sent, [])

    async def test_set_activity_custom_payload_sends_idempotent_start(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "custom_status",
                "title": "Custom Status",
                "subtitle": "Started from Home Assistant",
                "state": "Running",
                "template": "progress",
            },
            user_id="admin",
        )

        await ha_init._handle_set_activity(hass, call)

        self.assertEqual(coordinator.sent, [("start", call.data)])

    async def test_entityless_set_cannot_spoof_entity_set_control_markers(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "custom_status",
                "data": {
                    "entity_based": True,
                    "source_service": "set_activity",
                    "custom_value": "preserved",
                },
            },
            user_id="admin",
        )

        await ha_init._handle_set_activity(hass, call)

        self.assertEqual(
            coordinator.sent,
            [(
                "start",
                {
                    "activity_id": "custom_status",
                    "data": {"custom_value": "preserved"},
                },
            )],
        )

    async def test_set_activity_entityless_payload_requires_activity_id(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {"title": "Admin custom activity"},
            user_id="admin",
        )

        with self.assertRaisesRegex(
            ha_init.HomeAssistantError,
            "Activity ID is required when Entity is omitted",
        ):
            await ha_init._handle_set_activity(hass, call)

        self.assertEqual(coordinator.sent, [])

    async def test_limited_user_cannot_set_entityless_custom_payload(self) -> None:
        hass = FakeHass({"limited": FakeUser(is_admin=False)})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "custom_status",
                "title": "Arbitrary broadcast",
            },
            user_id="limited",
        )

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_set_activity(hass, call)

        self.assertEqual(coordinator.sent, [])

    async def test_oversized_service_field_rejects_before_dispatch(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {"activity_id": "custom_status", "title": "x" * 513},
            user_id="admin",
        )

        with self.assertRaisesRegex(ha_init.HomeAssistantError, "field_too_long:title"):
            await ha_init._handle_set_activity(hass, call)

        self.assertEqual(coordinator.sent, [])

    async def test_duplicate_name_relay_rejection_surfaces_to_service_caller(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator(
            dispatch_result=types.SimpleNamespace(
                relay_status_code=409,
                relay_error='HTTP 409: {"error":"duplicate_activity_name"}',
            )
        )
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "duplicate_status",
                "title": "Duplicate Status",
                "display_name": "deneme",
                "state": "Running",
            },
            user_id="admin",
        )

        with self.assertRaisesRegex(ha_init.HomeAssistantError, "active Live Activity"):
            await ha_init._handle_set_activity(hass, call)

        self.assertEqual(coordinator.sent, [("start", call.data)])

    async def test_activity_restart_conflicts_surface_actionable_guidance(self) -> None:
        for relay_error, expected in (
            ('HTTP 409: {"error":"ambiguous_entity_activity"}', "End the extra activities"),
            ('HTTP 409: {"error":"immutable_activity_attributes_changed"}', "End the existing activity"),
            ('HTTP 409: {"error":"activity_restart_required"}', "End the existing activity"),
            ('HTTP 409: {"error":"entity_activity_id_changed"}', "End the existing activity"),
            (
                'HTTP 409: {"error":"pending_entity_activity_id_changed"}',
                "wait for registration",
            ),
        ):
            hass = FakeHass({"admin": FakeUser(is_admin=True)})
            coordinator = FakeCoordinator(
                dispatch_result=types.SimpleNamespace(
                    relay_status_code=409,
                    relay_error=relay_error,
                )
            )
            hass.data[ha_init.DOMAIN]["entry"] = coordinator
            call = FakeCall(
                {
                    "activity_id": "entity_status",
                    "title": "Entity Status",
                    "state": "Running",
                },
                user_id="admin",
            )

            with self.assertRaisesRegex(ha_init.HomeAssistantError, expected):
                await ha_init._handle_set_activity(hass, call)

    async def test_relay_enabled_delivery_failure_surfaces_to_service_caller(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator(
            dispatch_result=types.SimpleNamespace(
                relay_enabled=True,
                delivered_outbound=False,
                relay_status_code=503,
                relay_error='HTTP 503: {"error":"relay_disabled"}',
            )
        )
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "background_status",
                "title": "Background Status",
                "state": "Running",
            },
            user_id="admin",
        )

        with self.assertRaisesRegex(
            ha_init.HomeAssistantError,
            "Background Live Activity delivery failed",
        ):
            await ha_init._handle_set_activity(hass, call)

        self.assertEqual(coordinator.sent, [("start", call.data)])

    async def test_pending_activity_token_is_an_accepted_idempotent_repeat(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator(
            dispatch_result=types.SimpleNamespace(
                relay_enabled=True,
                delivered_outbound=False,
                relay_accepted_pending=True,
                relay_status_code=200,
                relay_error=None,
            )
        )
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "background_status",
                "title": "Background Status",
                "state": "Running",
            },
            user_id="admin",
        )

        await ha_init._handle_set_activity(hass, call)

        self.assertEqual(coordinator.sent, [("start", call.data)])

    async def test_http_200_without_delivery_or_pending_still_fails(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator(
            dispatch_result=types.SimpleNamespace(
                relay_enabled=True,
                delivered_outbound=False,
                relay_accepted_pending=False,
                relay_status_code=200,
                relay_error=None,
            )
        )
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "background_status",
                "title": "Background Status",
                "state": "Running",
            },
            user_id="admin",
        )

        with self.assertRaisesRegex(
            ha_init.HomeAssistantError,
            "Background Live Activity delivery failed",
        ):
            await ha_init._handle_set_activity(hass, call)

        self.assertEqual(coordinator.sent, [("start", call.data)])

    async def test_non_success_cannot_claim_pending_acceptance(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator(
            dispatch_result=types.SimpleNamespace(
                relay_enabled=True,
                delivered_outbound=False,
                relay_accepted_pending=True,
                relay_status_code=503,
                relay_error='HTTP 503: {"error":"relay_unavailable"}',
            )
        )
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "background_status",
                "title": "Background Status",
                "state": "Running",
            },
            user_id="admin",
        )

        with self.assertRaisesRegex(
            ha_init.HomeAssistantError,
            "Background Live Activity delivery failed.*HTTP 503",
        ):
            await ha_init._handle_set_activity(hass, call)

        self.assertEqual(coordinator.sent, [("start", call.data)])

    def test_set_activity_schema_accepts_entity_control_opt_in(self) -> None:
        for schema in (
            ha_init.SET_ACTIVITY_SCHEMA,
            ha_init.START_ACTIVITY_SCHEMA,
            ha_init.ENTITY_ACTIVITY_SCHEMA,
        ):
            self.assertIn("allow_entity_control", schema)

    def test_set_activity_id_is_optional_for_entity_backed_calls(self) -> None:
        root = Path(__file__).parents[1]
        runtime_source = (
            root / "custom_components" / "ha_livekit" / "__init__.py"
        ).read_text(encoding="utf-8")
        schema_match = re.search(
            r"(?ms)^SET_ACTIVITY_SCHEMA = vol\.Schema\(\n(?P<body>.*?)^\)\n\nEND_ACTIVITY_SCHEMA",
            runtime_source,
        )
        self.assertIsNotNone(schema_match)
        schema_source = schema_match.group("body")
        self.assertIn("vol.Optional(ATTR_ACTIVITY_ID)", schema_source)
        self.assertNotIn("vol.Required(ATTR_ACTIVITY_ID)", schema_source)

        services_source = (
            root / "custom_components" / "ha_livekit" / "services.yaml"
        ).read_text(encoding="utf-8")
        service_match = re.search(
            r"(?ms)^set_activity:\n(?P<body>.*?)(?=^start_activity:\n)",
            services_source,
        )
        self.assertIsNotNone(service_match)
        field_match = re.search(
            r"(?ms)^    activity_id:\n(?P<body>.*?)(?=^    entity_id:\n)",
            service_match.group("body"),
        )
        self.assertIsNotNone(field_match)
        self.assertIn("      required: false", field_match.group("body"))

    def test_entity_control_action_editor_uses_one_boolean_toggle(self) -> None:
        root = Path(__file__).parents[1]
        services_source = (
            root / "custom_components" / "ha_livekit" / "services.yaml"
        ).read_text(encoding="utf-8")
        for service_name in (
            "set_activity",
            "start_activity",
            "start_entity_activity",
        ):
            service_match = re.search(
                rf"(?ms)^{service_name}:\n(?P<body>.*?)(?=^[a-z_]+:\n|\Z)",
                services_source,
            )
            self.assertIsNotNone(service_match)
            field_match = re.search(
                r"(?ms)^    allow_entity_control:\n(?P<body>.*?)(?=^    [a-z_]+:\n|\Z)",
                service_match.group("body"),
            )
            self.assertIsNotNone(field_match)
            field_source = field_match.group("body")
            self.assertIn("      required: true", field_source)
            self.assertIn("      default: false", field_source)

        runtime_source = (
            root / "custom_components" / "ha_livekit" / "__init__.py"
        ).read_text(encoding="utf-8")
        self.assertEqual(
            runtime_source.count("vol.Optional(ATTR_ALLOW_ENTITY_CONTROL)"),
            3,
        )
        self.assertNotIn(
            "vol.Required(ATTR_ALLOW_ENTITY_CONTROL)", runtime_source
        )

    async def test_relay_disabled_foreground_dispatch_remains_compatible(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator(
            dispatch_result=types.SimpleNamespace(
                relay_enabled=False,
                delivered_outbound=False,
                relay_status_code=None,
                relay_error=None,
            )
        )
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "foreground_status",
                "title": "Foreground Status",
            },
            user_id="admin",
        )

        await ha_init._handle_set_activity(hass, call)

        self.assertEqual(coordinator.sent, [("start", call.data)])

    async def test_limited_user_cannot_enable_entity_control(self) -> None:
        hass = FakeHass(
            {"limited": FakeUser(is_admin=False, readable={"light.desk"})}
        )
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "desk_light",
                "entity_id": "light.desk",
                "allow_entity_control": True,
            },
            user_id="limited",
        )

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_set_activity(hass, call)

        self.assertEqual(coordinator.sent, [])

    async def test_limited_user_can_explicitly_disable_entity_control(self) -> None:
        hass = FakeHass(
            {"limited": FakeUser(is_admin=False, readable={"light.desk"})}
        )
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator

        def fake_builder(hass_arg, payload, source_service):
            return {
                "activity_id": payload["activity_id"],
                "entity_id": payload["entity_id"],
                "allow_entity_control": payload["allow_entity_control"],
                "source": source_service,
            }

        original_builder = ha_init.build_entity_activity_payload
        try:
            ha_init.build_entity_activity_payload = fake_builder
            call = FakeCall(
                {
                    "activity_id": "desk_light",
                    "entity_id": "light.desk",
                    "allow_entity_control": False,
                },
                user_id="limited",
            )

            await ha_init._handle_set_activity(hass, call)
        finally:
            ha_init.build_entity_activity_payload = original_builder

        self.assertEqual(
            coordinator.sent,
            [
                (
                    "start",
                    {
                        "activity_id": "desk_light",
                        "entity_id": "light.desk",
                        "allow_entity_control": False,
                        "source": ha_init.SERVICE_SET_ACTIVITY,
                    },
                )
            ],
        )

    def test_foreground_starts_use_canonical_entity_control_identity(self) -> None:
        app_model_source = (
            Path(__file__).parents[1]
            / "ios"
            / "HA LiveKit"
            / "HA LiveKit"
            / "App"
            / "AppModel.swift"
        ).read_text(encoding="utf-8")

        self.assertIn(
            "managedRelayInstanceIDStore.canonicalInstanceID(for: localInstanceID)",
            app_model_source,
        )
        self.assertIn("?? localInstanceID", app_model_source)
        self.assertNotRegex(
            app_model_source,
            r"entityControlHomeAssistantInstanceID:\s*homeAssistantInstanceID",
        )
        self.assertEqual(
            app_model_source.count(
                "entityControlHomeAssistantInstanceID: entityControlHomeAssistantInstanceID"
            ),
            4,
        )

    def test_activity_attributes_carry_backward_compatible_tenant_origin(self) -> None:
        root = Path(__file__).parents[1]
        attributes_source = (
            root
            / "ios"
            / "HA LiveKit"
            / "Shared"
            / "HALiveActivityAttributes.swift"
        ).read_text(encoding="utf-8")
        manager_source = (
            root
            / "ios"
            / "HA LiveKit"
            / "HA LiveKit"
            / "Services"
            / "LiveActivityManager.swift"
        ).read_text(encoding="utf-8")

        self.assertRegex(
            attributes_source,
            r"let homeAssistantInstanceId: String\?",
        )
        self.assertIn("case homeAssistantInstanceId", attributes_source)
        self.assertIn(
            "homeAssistantInstanceId = try container.decodeIfPresent(",
            attributes_source,
        )
        self.assertEqual(
            manager_source.count("homeAssistantInstanceId: homeAssistantInstanceID"),
            2,
        )
        app_model_source = (
            root
            / "ios"
            / "HA LiveKit"
            / "HA LiveKit"
            / "App"
            / "AppModel.swift"
        ).read_text(encoding="utf-8")
        self.assertEqual(
            app_model_source.count(
                "homeAssistantInstanceID: entityControlHomeAssistantInstanceID"
            ),
            4,
        )

    def test_activity_token_observer_captures_immutable_tenant_origin(self) -> None:
        registrar_source = (
            Path(__file__).parents[1]
            / "ios"
            / "HA LiveKit"
            / "HA LiveKit"
            / "Services"
            / "LiveActivityRelayRegistrar.swift"
        ).read_text(encoding="utf-8")

        activity_observer = registrar_source.split(
            "private func observeActivity(", 1
        )[1].split("private func handlePushToStartToken", 1)[0]
        token_registration = registrar_source.split(
            "private func registerActivityToken(", 1
        )[1].split("private func performTestStart", 1)[0]

        self.assertIn("let originHomeAssistantInstanceID", activity_observer)
        self.assertLess(
            activity_observer.index("let originHomeAssistantInstanceID"),
            activity_observer.index("Task {"),
        )
        self.assertLess(
            activity_observer.index("originMatchesContext("),
            activity_observer.index("activityTokenTasks[activityKitID] = Task"),
        )
        self.assertIn("if let currentToken = activity.pushToken", activity_observer)
        self.assertLess(
            activity_observer.index("if let currentToken = activity.pushToken"),
            activity_observer.index("for await tokenData in activity.pushTokenUpdates"),
        )
        self.assertGreaterEqual(
            activity_observer.count(
                "originHomeAssistantInstanceID: originHomeAssistantInstanceID"
            ),
            2,
        )
        self.assertIn(
            "originHomeAssistantInstanceID: String",
            token_registration,
        )
        self.assertNotIn(
            "originLocalInstanceID: localHomeAssistantInstanceID",
            token_registration,
        )
        self.assertLess(
            token_registration.index("guard !Task.isCancelled"),
            token_registration.index("pendingActivityTokens["),
        )

    def test_untagged_legacy_activity_origin_is_never_inferred_from_current_context(self) -> None:
        registrar_source = (
            Path(__file__).parents[1]
            / "ios"
            / "HA LiveKit"
            / "HA LiveKit"
            / "Services"
            / "LiveActivityRelayRegistrar.swift"
        ).read_text(encoding="utf-8")
        origin_resolver = registrar_source.split(
            "private func activityOriginHomeAssistantInstanceID(", 1
        )[1].split("private func originMatchesContext", 1)[0]

        self.assertEqual(origin_resolver.count("tenantBindingStore.bind("), 1)
        self.assertIn("if let taggedOrigin", origin_resolver)
        self.assertIn(
            "return tenantBindingStore.tenantID(for: activityKitID)",
            origin_resolver,
        )
        self.assertNotIn("registrationContext()", origin_resolver)
        self.assertNotIn("context.relayInstanceID", origin_resolver)
        self.assertNotIn("verifiedSavedConnectionRestore", registrar_source)

    def test_legacy_activity_tenant_binding_is_conflict_safe_and_pruned(self) -> None:
        registrar_source = (
            Path(__file__).parents[1]
            / "ios"
            / "HA LiveKit"
            / "HA LiveKit"
            / "Services"
            / "LiveActivityRelayRegistrar.swift"
        ).read_text(encoding="utf-8")

        self.assertIn("LiveActivityTenantBindingStore", registrar_source)
        self.assertIn("func bind(activityKitID:", registrar_source)
        self.assertIn("existingTenantID == tenantID", registrar_source)
        self.assertIn("func prune(keepingActivityKitIDs", registrar_source)
        self.assertIn(
            "tenantBindingStore.prune(keepingActivityKitIDs: activeActivityKitIDs)",
            registrar_source,
        )
        self.assertIn("originMatchesContext(", registrar_source)
        self.assertIn(
            "originHomeAssistantInstanceID == context.localInstanceID",
            registrar_source,
        )
        self.assertIn(
            "originHomeAssistantInstanceID == context.relayInstanceID",
            registrar_source,
        )
        self.assertNotIn("restartActivityTokenObservation", registrar_source)

    def test_local_only_shortcuts_do_not_require_tenant_identity_resolution(self) -> None:
        intents_source = (
            Path(__file__).parents[1]
            / "ios"
            / "HA LiveKit"
            / "HA LiveKit"
            / "App"
            / "HALiveKitIntents.swift"
        ).read_text(encoding="utf-8")

        intent_service = intents_source.split(
            "private struct IntentLiveActivityService", 1
        )[1]
        self.assertNotIn("resolvedHomeAssistantInstanceID", intent_service)
        self.assertNotIn("homeAssistantInstanceID:", intent_service)
        self.assertGreaterEqual(
            intent_service.count("allowsRemotePushUpdates: false"),
            3,
        )

    def test_background_websocket_activity_requests_do_not_queue_global_alert(self) -> None:
        app_model_source = (
            Path(__file__).parents[1]
            / "ios"
            / "HA LiveKit"
            / "HA LiveKit"
            / "App"
            / "AppModel.swift"
        ).read_text(encoding="utf-8")

        scene_handler = app_model_source.split("func handleScenePhase", 1)[1].split(
            "private func applyEntityUpdate", 1
        )[0]
        request_handler = app_model_source.split(
            "private func applyActivityRequest(", 1
        )[1].split("private func isCurrentWebSocketConnection", 1)[0]
        app_root_source = (
            Path(__file__).parents[1]
            / "ios"
            / "HA LiveKit"
            / "HA LiveKit"
            / "App"
            / "AppRootView.swift"
        ).read_text(encoding="utf-8")
        initial_task = app_root_source.split(
            ".task(id: hasSeenIntegrationGuide)", 1
        )[1].split(".onChange(of: scenePhase)", 1)[0]

        self.assertIn(
            "private var acceptsForegroundActivityRequests = false",
            app_model_source,
        )
        self.assertIn("appModel.handleScenePhase(scenePhase)", initial_task)
        self.assertLess(
            initial_task.index("appModel.handleScenePhase(scenePhase)"),
            initial_task.index("await appModel.restoreIfPossible()"),
        )
        self.assertIn("acceptsForegroundActivityRequests = true", scene_handler)
        self.assertGreaterEqual(
            scene_handler.count("acceptsForegroundActivityRequests = false"), 2
        )
        self.assertIn("guard acceptsForegroundActivityRequests else", request_handler)
        self.assertLess(
            request_handler.index("guard acceptsForegroundActivityRequests else"),
            request_handler.index("do {"),
        )
        catch_block = request_handler.rsplit("} catch {", 1)[1]
        self.assertIn("guard acceptsForegroundActivityRequests else", catch_block)
        self.assertLess(
            catch_block.index("guard acceptsForegroundActivityRequests else"),
            catch_block.index("lastErrorMessage ="),
        )

    async def test_entity_control_requires_supported_domain(self) -> None:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        call = FakeCall(
            {
                "activity_id": "temperature",
                "entity_id": "sensor.temperature",
                "allow_entity_control": True,
            },
            user_id="admin",
        )

        with self.assertRaisesRegex(
            ha_init.HomeAssistantError,
            "light, switch, or input_boolean",
        ):
            await ha_init._handle_set_activity(hass, call)

        self.assertEqual(coordinator.sent, [])

    def test_entity_builder_preserves_control_opt_in(self) -> None:
        entity = types.SimpleNamespace(
            entity_id="light.desk",
            state="off",
            attributes={"friendly_name": "Desk"},
        )
        hass = types.SimpleNamespace(
            states=types.SimpleNamespace(
                get=lambda entity_id: entity if entity_id == entity.entity_id else None
            )
        )

        payload = ha_entity_activity.build_entity_activity_payload(
            hass,
            {
                "entity_id": "light.desk",
                "allow_entity_control": True,
            },
            ha_init.SERVICE_SET_ACTIVITY,
        )

        self.assertIsNotNone(payload)
        self.assertEqual(payload["activity_id"], "desk")
        self.assertIs(payload["allow_entity_control"], True)

    async def test_set_activity_entity_rejects_unauthorized_before_payload_builder(self) -> None:
        hass = FakeHass({"limited": FakeUser(is_admin=False, readable=set())})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        builder_called = False

        def fake_builder(*args):
            nonlocal builder_called
            builder_called = True
            return {"activity_id": "secret"}

        ha_init.build_entity_activity_payload = fake_builder
        call = FakeCall(
            {
                "activity_id": "front_door",
                "entity_id": "binary_sensor.front_door",
            },
            user_id="limited",
        )

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_set_activity(hass, call)

        self.assertFalse(builder_called)
        self.assertEqual(coordinator.sent, [])

    async def test_set_activity_progress_entity_rejects_unauthorized_before_payload_builder(self) -> None:
        hass = FakeHass({"limited": FakeUser(is_admin=False, readable={"sensor.washing_machine_power"})})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        builder_called = False

        def fake_builder(*args):
            nonlocal builder_called
            builder_called = True
            return {"activity_id": "secret"}

        ha_init.build_entity_activity_payload = fake_builder
        call = FakeCall(
            {
                "activity_id": "washing_machine",
                "entity_id": "sensor.washing_machine_power",
                "progress_entity_id": "sensor.washing_machine_progress",
            },
            user_id="limited",
        )

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_set_activity(hass, call)

        self.assertFalse(builder_called)
        self.assertEqual(coordinator.sent, [])

    async def test_limited_set_entity_rejects_nonempty_custom_data(self) -> None:
        hass = FakeHass({"limited": FakeUser(is_admin=False, readable={"sensor.allowed"})})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator
        builder_called = False

        def fake_builder(*args):
            nonlocal builder_called
            builder_called = True
            return {"activity_id": "allowed"}

        ha_init.build_entity_activity_payload = fake_builder
        call = FakeCall(
            {
                "activity_id": "allowed",
                "entity_id": "sensor.allowed",
                "data": {"subtitle": "Arbitrary broadcast text"},
            },
            user_id="limited",
        )

        with self.assertRaises(ha_init.Unauthorized):
            await ha_init._handle_set_activity(hass, call)

        self.assertFalse(builder_called)
        self.assertEqual(coordinator.sent, [])

    async def test_set_activity_entity_payload_sends_idempotent_start(self) -> None:
        hass = FakeHass({"limited": FakeUser(is_admin=False, readable={"binary_sensor.front_door"})})
        coordinator = FakeCoordinator()
        hass.data[ha_init.DOMAIN]["entry"] = coordinator

        def fake_builder(hass_arg, payload, source_service):
            return {"activity_id": payload["activity_id"], "entity_id": payload["entity_id"], "source": source_service}

        ha_init.build_entity_activity_payload = fake_builder
        call = FakeCall(
            {
                "activity_id": "front_door",
                "entity_id": "binary_sensor.front_door",
                "template": "door",
                "data": {},
            },
            user_id="limited",
        )

        await ha_init._handle_set_activity(hass, call)

        self.assertEqual(coordinator.sent, [("start", {
            "activity_id": "front_door",
            "entity_id": "binary_sensor.front_door",
            "source": ha_init.SERVICE_SET_ACTIVITY,
        })])

    def test_configure_managed_relay_registers_as_admin_service_when_available(self) -> None:
        hass = FakeHass({})

        ha_init._async_register_services(hass)

        self.assertIn(ha_init.SERVICE_CONFIGURE_MANAGED_RELAY, hass.helpers.service.registered)
        self.assertNotIn(ha_init.SERVICE_CONFIGURE_MANAGED_RELAY, hass.services.registered)
        self.assertIn(ha_init.SERVICE_SET_ACTIVITY, hass.services.registered)

    def test_automatic_relay_setup_copy_is_clear_without_weakening_security(self) -> None:
        root = Path(__file__).parents[1]
        services_source = (
            root / "custom_components" / "ha_livekit" / "services.yaml"
        ).read_text(encoding="utf-8")
        service_match = re.search(
            r"(?ms)^configure_managed_relay:\n(?P<body>.*)\Z",
            services_source,
        )
        self.assertIsNotNone(service_match)
        copy = service_match.group("body").lower()
        self.assertIn("automatic relay setup (do not add manually)", copy)
        self.assertIn("used automatically by the ha livekit app", copy)
        self.assertNotIn("admin-only", copy)
        self.assertNotIn("administrator-only", copy)

    def test_ios_connection_boundary_is_independent_of_ha_url_provider(self) -> None:
        root = Path(__file__).parents[1]
        connection_source = (
            root
            / "ios"
            / "HA LiveKit"
            / "HA LiveKit"
            / "Models"
            / "ConnectionConfiguration.swift"
        ).read_text(encoding="utf-8")
        normalizer = connection_source.split(
            "enum HomeAssistantURLNormalizer", 1
        )[1]

        # The connection boundary accepts both remote HTTPS providers and local
        # HTTP hosts. It must validate URL structure, never a specific domain.
        self.assertIn('["http", "https"].contains(scheme)', normalizer)
        self.assertIn("let host = components.host", normalizer)
        self.assertIn('trimmed = "http://\\(trimmed)"', normalizer)
        for provider_specific_gate in (
            "ui.nabu.casa",
            "hasSuffix(",
            "my-home.example.net",
            "homeassistant.local\"].contains",
            "localhost\"].contains",
        ):
            self.assertNotIn(provider_specific_gate, normalizer)

        swiftc = shutil.which("swiftc")
        if swiftc is None:
            self.skipTest("swiftc is unavailable; static boundary assertions passed")
        harness = f"""
import Foundation

enum HALiveKitError: Error {{
    case invalidURL
}}

enum HomeAssistantURLNormalizer{normalizer}

let cases: [(String, String, String, Int?)] = [
    ("https://example-token.ui.nabu.casa", "https", "example-token.ui.nabu.casa", nil),
    ("https://ha.example.com", "https", "ha.example.com", nil),
    ("http://homeassistant.local:8123", "http", "homeassistant.local", 8123),
    ("http://192.168.1.25:8123", "http", "192.168.1.25", 8123),
    ("http://localhost:8123", "http", "localhost", 8123),
    ("localhost:8123", "http", "localhost", 8123),
]

for (rawValue, expectedScheme, expectedHost, expectedPort) in cases {{
    let url = try HomeAssistantURLNormalizer.normalize(rawValue)
    guard url.scheme == expectedScheme,
          url.host == expectedHost,
          url.port == expectedPort else {{
        fatalError("Unexpected normalization for \\(rawValue): \\(url.absoluteString)")
    }}
}}
print("URL provider boundary OK")
"""
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            source_path = temporary_path / "URLBoundaryHarness.swift"
            executable_path = temporary_path / "URLBoundaryHarness"
            source_path.write_text(harness, encoding="utf-8")
            compile_result = subprocess.run(
                [swiftc, str(source_path), "-o", str(executable_path)],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(
                compile_result.returncode,
                0,
                compile_result.stderr,
            )
            run_result = subprocess.run(
                [str(executable_path)],
                check=False,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(run_result.returncode, 0, run_result.stderr)
            self.assertEqual(run_result.stdout.strip(), "URL provider boundary OK")

    async def test_configure_fallback_registration_still_fails_closed(self) -> None:
        hass = FakeHass({})
        hass.helpers = types.SimpleNamespace(service=types.SimpleNamespace())
        hass.data[ha_init.DOMAIN]["entry"] = FakeCoordinator()

        ha_init._async_register_services(hass)
        handler = hass.services.handlers[ha_init.SERVICE_CONFIGURE_MANAGED_RELAY]
        call = FakeCall(
            {
                "relay_url": ha_init.MANAGED_RELAY_URL,
                "relay_app_registration_secret": "app-registration-secret",
                "home_assistant_instance_id": "ha_1234567890abcdef1234567890abcdef",
            },
            user_id=None,
        )

        with self.assertRaises(ha_init.Unauthorized):
            await handler(call)

        self.assertEqual(hass.config_entries.updates, [])

    def test_sensor_redacts_full_instance_id(self) -> None:
        redacted = ha_sensor._redact_instance_id("ha_a1b2c3000000000000000000000d4e5f")

        self.assertEqual(redacted, "ha_a1b2c3...d4e5f")


class FakePairingEntry:
    def __init__(
        self,
        relay_secret: str = "",
        *,
        relay_mode: str = ha_coordinator.RELAY_MODE_MANAGED,
        instance_id: str = "ha_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        options: dict | None = None,
    ) -> None:
        self.data = {
            ha_coordinator.CONF_RELAY_MODE: relay_mode,
            ha_coordinator.CONF_RELAY_SHARED_SECRET: relay_secret,
            ha_coordinator.CONF_HOME_ASSISTANT_INSTANCE_ID: instance_id,
        }
        self.options: dict = dict(options or {})


class FakeRelayResponse:
    def __init__(
        self,
        status: int,
        payload: dict | str,
        *,
        content_length: int | None = None,
    ) -> None:
        self.status = status
        self.payload = payload
        self.charset = "utf-8"
        self.content = self
        self.content_length = content_length
        self._offset = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None

    async def text(self) -> str:
        return self.payload if isinstance(self.payload, str) else json.dumps(self.payload)

    async def read(self, limit: int = -1) -> bytes:
        data = (await self.text()).encode()
        if self._offset >= len(data):
            return b""
        end = len(data) if limit < 0 else min(len(data), self._offset + limit)
        chunk = data[self._offset:end]
        self._offset = end
        return chunk


class GatedRelayResponse(FakeRelayResponse):
    """Relay response whose first body read waits for an explicit release."""

    def __init__(
        self,
        status: int,
        payload: dict | str,
        entered: asyncio.Event,
        release: asyncio.Event,
    ) -> None:
        super().__init__(status, payload)
        self._entered = entered
        self._release = release
        self._first_read = True

    async def read(self, limit: int = -1) -> bytes:
        if self._first_read:
            self._first_read = False
            self._entered.set()
            await self._release.wait()
        return await super().read(limit)


class FakeRelaySession:
    def __init__(self, responses: list[FakeRelayResponse]) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    def post(self, url: str, **kwargs):
        self.calls.append({"method": "POST", "url": url, **kwargs})
        return self.responses.pop(0)

    def get(self, url: str, **kwargs):
        self.calls.append({"method": "GET", "url": url, **kwargs})
        return self.responses.pop(0)


class CoordinatorRelayTransportTests(unittest.IsolatedAsyncioTestCase):
    def _coordinator(
        self,
        response: FakeRelayResponse | list[FakeRelayResponse],
    ):
        hass = FakeHass({})
        hass.config = types.SimpleNamespace(location_name="")
        responses = response if isinstance(response, list) else [response]
        session = FakeRelaySession(responses)
        hass.session = session
        entry = FakePairingEntry(
            "tenant-relay-secret-value",
            relay_mode=ha_coordinator.RELAY_MODE_CUSTOM,
            options={
                ha_coordinator.CONF_RELAY_MODE: ha_coordinator.RELAY_MODE_CUSTOM,
                ha_coordinator.CONF_RELAY_ENABLED: True,
                ha_coordinator.CONF_RELAY_URL: "https://relay.example.test",
                ha_coordinator.CONF_RELAY_SHARED_SECRET: "tenant-relay-secret-value",
                ha_coordinator.CONF_HOME_ASSISTANT_INSTANCE_ID: "ha_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
        )
        return ha_coordinator.HALiveKitCoordinator(hass, entry), session

    async def test_relay_post_rejects_redirect_without_forwarding_secret(self) -> None:
        coordinator, session = self._coordinator(FakeRelayResponse(307, "redirect"))

        delivered = await coordinator._post_to_relay(
            {"action": "start", "activity_id": "door", "title": "Door"}
        )

        self.assertFalse(delivered)
        self.assertFalse(session.calls[0]["allow_redirects"])
        self.assertEqual(coordinator.last_relay_error, "HTTP 307: redirect rejected")

    async def test_relay_post_rejects_oversized_response(self) -> None:
        coordinator, _ = self._coordinator(
            FakeRelayResponse(
                200,
                "ok",
                content_length=ha_coordinator._MAX_RELAY_RESPONSE_BYTES + 1,
            )
        )

        delivered = await coordinator._post_to_relay(
            {"action": "update", "activity_id": "door", "title": "Door"}
        )

        self.assertFalse(delivered)
        self.assertEqual(coordinator.last_relay_error, "Relay response exceeded 32 KiB")

    async def test_relay_post_still_accepts_bounded_success(self) -> None:
        coordinator, _ = self._coordinator(FakeRelayResponse(200, {"ok": True}))

        delivered = await coordinator._post_to_relay(
            {"action": "end", "activity_id": "door", "title": "Door"}
        )

        self.assertTrue(delivered)
        self.assertEqual(coordinator.last_relay_status_code, 200)

    async def test_relay_pending_start_is_accepted_without_reporting_delivery(self) -> None:
        coordinator, _ = self._coordinator(
            FakeRelayResponse(
                200,
                {
                    "ok": True,
                    "action": "start",
                    "attempted": 0,
                    "delivered": 0,
                    "reused_pending": 1,
                },
            )
        )

        delivered = await coordinator._post_to_relay(
            {"action": "start", "activity_id": "door", "title": "Door"}
        )

        self.assertFalse(delivered)
        self.assertTrue(coordinator.last_relay_accepted_pending)
        self.assertIsNone(coordinator.last_relay_error)

    async def test_relay_persistent_start_intent_is_accepted_without_delivery(self) -> None:
        coordinator, _ = self._coordinator(
            FakeRelayResponse(
                200,
                {
                    "ok": True,
                    "action": "start",
                    "attempted": 0,
                    "delivered": 0,
                    "reused_pending": 0,
                    "reused_persistent_intent": 1,
                    "delivery_state": "awaiting_activity_registration",
                },
            )
        )

        delivered = await coordinator._post_to_relay(
            {"action": "start", "activity_id": "door", "title": "Door"}
        )

        self.assertFalse(delivered)
        self.assertTrue(coordinator.last_relay_accepted_pending)
        self.assertIsNone(coordinator.last_relay_error)

    async def test_relay_end_of_missing_activity_is_idempotent_success(self) -> None:
        coordinator, _ = self._coordinator(
            FakeRelayResponse(
                404,
                {
                    "ok": False,
                    "error": "no_activity_tokens",
                    "message": "No registered Live Activity update tokens matched this request.",
                },
            )
        )

        delivered = await coordinator._post_to_relay(
            {"action": "end", "activity_id": "door"}
        )

        self.assertFalse(delivered)
        self.assertTrue(coordinator.last_relay_accepted_pending)
        self.assertIsNone(coordinator.last_relay_error)

    async def test_relay_end_404_other_errors_still_fail(self) -> None:
        coordinator, _ = self._coordinator(
            FakeRelayResponse(404, {"ok": False, "error": "not_found"})
        )

        delivered = await coordinator._post_to_relay(
            {"action": "end", "activity_id": "door"}
        )

        self.assertFalse(delivered)
        self.assertFalse(coordinator.last_relay_accepted_pending)
        self.assertIsNotNone(coordinator.last_relay_error)

    async def test_dispatch_reports_pending_acceptance_separately_from_delivery(self) -> None:
        coordinator, _ = self._coordinator(
            FakeRelayResponse(
                200,
                {
                    "ok": True,
                    "action": "start",
                    "attempted": 0,
                    "delivered": 0,
                    "reused_pending": 1,
                },
            )
        )

        result = await coordinator.async_send_activity(
            "start",
            {"activity_id": "door", "title": "Door"},
        )

        self.assertFalse(result.delivered_outbound)
        self.assertTrue(result.relay_accepted_pending)
        self.assertEqual(result.relay_status_code, 200)

    async def test_start_zero_delivery_rejects_every_unaccepted_shape(self) -> None:
        cases = (
            (
                "ok false",
                200,
                {
                    "ok": False,
                    "attempted": 0,
                    "delivered": 0,
                    "reused_pending": 1,
                },
            ),
            (
                "no pending reuse",
                200,
                {"ok": True, "attempted": 0, "delivered": 0},
            ),
            (
                "created is not an idempotent acknowledgement",
                201,
                {
                    "ok": True,
                    "attempted": 0,
                    "delivered": 0,
                    "reused_pending": 1,
                },
            ),
            (
                "boolean counters",
                200,
                {
                    "ok": True,
                    "attempted": False,
                    "delivered": False,
                    "reused_pending": 1,
                },
            ),
            (
                "boolean pending count",
                200,
                {
                    "ok": True,
                    "attempted": 0,
                    "delivered": 0,
                    "reused_pending": True,
                },
            ),
        )

        for label, status, payload in cases:
            with self.subTest(label=label):
                coordinator, _ = self._coordinator(
                    FakeRelayResponse(status, payload)
                )

                delivered = await coordinator._post_to_relay(
                    {"action": "start", "activity_id": "door", "title": "Door"}
                )

                self.assertFalse(delivered)
                self.assertFalse(coordinator.last_relay_accepted_pending)
                self.assertIsNotNone(coordinator.last_relay_error)

    async def test_explicit_zero_delivery_fails_for_every_relay_action(self) -> None:
        cases = (
            ("start ok", "start", {"ok": True, "attempted": 1, "delivered": 0}),
            ("start not ok", "start", {"ok": False, "attempted": 1, "delivered": 0}),
            ("update", "update", {"ok": True, "attempted": 0, "delivered": 0}),
            ("end", "end", {"ok": True, "attempted": 0, "delivered": 0}),
        )
        for label, action, payload in cases:
            with self.subTest(label=label):
                coordinator, _ = self._coordinator(FakeRelayResponse(200, payload))

                delivered = await coordinator._post_to_relay(
                    {"action": action, "activity_id": "door", "title": "Door"}
                )

                self.assertFalse(delivered)
                self.assertFalse(coordinator.last_relay_accepted_pending)
                self.assertEqual(
                    coordinator.last_relay_error_code,
                    "zero_delivery_not_accepted",
                )

    async def test_entity_set_operation_header_is_internal_and_entity_scoped(self) -> None:
        responses = [
            FakeRelayResponse(200, {"ok": True}),
            FakeRelayResponse(200, {"ok": True}),
        ]
        coordinator, session = self._coordinator(responses)

        self.assertTrue(await coordinator._post_to_relay({
            "action": "start",
            "activity_id": "kitchen",
            "entity_id": "switch.kitchen",
            "data": {"entity_based": True, "source_service": "set_activity"},
        }))
        self.assertTrue(await coordinator._post_to_relay({
            "action": "start",
            "activity_id": "custom",
            "data": {"custom_value": "preserved"},
        }))

        self.assertEqual(
            session.calls[0]["headers"][ha_coordinator._ENTITY_SET_OPERATION_HEADER],
            ha_coordinator._ENTITY_SET_OPERATION_VALUE,
        )
        self.assertNotIn(
            ha_coordinator._ENTITY_SET_OPERATION_HEADER,
            session.calls[1]["headers"],
        )

    async def test_authenticated_webhook_cannot_spoof_entity_set_operation(self) -> None:
        coordinator, session = self._coordinator(
            FakeRelayResponse(200, {"ok": True})
        )

        result = await coordinator.async_handle_webhook({
            "action": "start",
            "activity_id": "custom",
            "entity_id": "switch.kitchen",
            "data": {
                "entity_based": True,
                "source_service": "set_activity",
                "custom_value": "preserved",
            },
        })

        self.assertTrue(result.delivered_outbound)
        self.assertNotIn(
            ha_coordinator._ENTITY_SET_OPERATION_HEADER,
            session.calls[0]["headers"],
        )
        forwarded = json.loads(session.calls[0]["data"])
        self.assertEqual(forwarded["data"], {"custom_value": "preserved"})

    async def test_concurrent_pending_and_error_dispatches_keep_local_results(self) -> None:
        first_entered = asyncio.Event()
        first_release = asyncio.Event()
        second_entered = asyncio.Event()
        second_release = asyncio.Event()
        coordinator, _ = self._coordinator([
            GatedRelayResponse(
                200,
                {
                    "ok": True,
                    "attempted": 0,
                    "delivered": 0,
                    "reused_pending": 1,
                },
                first_entered,
                first_release,
            ),
            GatedRelayResponse(
                503,
                {"ok": False, "error": "relay_unavailable"},
                second_entered,
                second_release,
            ),
        ])
        message = {"activity_id": "door", "title": "Door"}

        pending_task = asyncio.create_task(
            coordinator.async_send_activity("start", message)
        )
        await asyncio.wait_for(first_entered.wait(), timeout=1)
        error_task = asyncio.create_task(
            coordinator.async_send_activity("start", message)
        )
        await asyncio.sleep(0)
        self.assertFalse(second_entered.is_set())

        first_release.set()
        pending_result = await asyncio.wait_for(pending_task, timeout=1)
        await asyncio.wait_for(second_entered.wait(), timeout=1)
        second_release.set()
        error_result = await asyncio.wait_for(error_task, timeout=1)

        self.assertFalse(pending_result.delivered_outbound)
        self.assertTrue(pending_result.relay_accepted_pending)
        self.assertEqual(pending_result.relay_status_code, 200)
        self.assertIsNone(pending_result.relay_error)
        self.assertFalse(error_result.delivered_outbound)
        self.assertFalse(error_result.relay_accepted_pending)
        self.assertEqual(error_result.relay_status_code, 503)
        self.assertIn("HTTP 503", error_result.relay_error)

    async def test_legacy_counterless_start_success_remains_compatible(self) -> None:
        for status, payload in (
            (200, {"ok": True}),
            (201, {"ok": True, "legacy": True}),
            (202, "accepted"),
        ):
            with self.subTest(status=status):
                coordinator, _ = self._coordinator(
                    FakeRelayResponse(status, payload)
                )

                delivered = await coordinator._post_to_relay(
                    {"action": "start", "activity_id": "door", "title": "Door"}
                )

                self.assertTrue(delivered)
                self.assertFalse(coordinator.last_relay_accepted_pending)
                self.assertIsNone(coordinator.last_relay_error)

    async def test_pending_signal_resets_before_normal_and_error_responses(self) -> None:
        pending = {
            "ok": True,
            "attempted": 0,
            "delivered": 0,
            "reused_pending": 1,
        }
        coordinator, _ = self._coordinator(
            [
                FakeRelayResponse(200, pending),
                FakeRelayResponse(
                    200,
                    {"ok": True, "attempted": 1, "delivered": 1},
                ),
                FakeRelayResponse(200, pending),
                FakeRelayResponse(503, {"ok": False, "error": "unavailable"}),
            ]
        )
        message = {"action": "start", "activity_id": "door", "title": "Door"}

        self.assertFalse(await coordinator._post_to_relay(message))
        self.assertTrue(coordinator.last_relay_accepted_pending)
        self.assertTrue(await coordinator._post_to_relay(message))
        self.assertFalse(coordinator.last_relay_accepted_pending)
        self.assertIsNone(coordinator.last_relay_error)
        self.assertFalse(await coordinator._post_to_relay(message))
        self.assertTrue(coordinator.last_relay_accepted_pending)
        self.assertFalse(await coordinator._post_to_relay(message))
        self.assertFalse(coordinator.last_relay_accepted_pending)
        self.assertEqual(coordinator.last_relay_status_code, 503)
        self.assertIn("HTTP 503", coordinator.last_relay_error)

    async def test_pending_signal_resets_when_relay_is_disabled(self) -> None:
        coordinator, _ = self._coordinator(
            FakeRelayResponse(
                200,
                {
                    "ok": True,
                    "attempted": 0,
                    "delivered": 0,
                    "reused_pending": 1,
                },
            )
        )
        message = {"action": "start", "activity_id": "door", "title": "Door"}
        self.assertFalse(await coordinator._post_to_relay(message))
        self.assertTrue(coordinator.last_relay_accepted_pending)
        coordinator.config_entry.options[ha_coordinator.CONF_RELAY_ENABLED] = False

        result = await coordinator.async_send_activity("start", message)

        self.assertFalse(result.relay_enabled)
        self.assertFalse(result.relay_accepted_pending)
        self.assertIsNone(result.relay_status_code)
        self.assertEqual(result.relay_error, "Relay forwarding disabled")

    async def test_entity_set_pending_and_transport_failure_publish_foreground(self) -> None:
        cases = (
            (
                "pending",
                FakeRelayResponse(
                    200,
                    {
                        "ok": True,
                        "attempted": 0,
                        "delivered": 0,
                        "reused_pending": 1,
                    },
                ),
                True,
            ),
            (
                "transport failure",
                FakeRelayResponse(
                    503,
                    {"ok": False, "error": "relay_unavailable"},
                ),
                False,
            ),
        )
        for label, response, accepted_pending in cases:
            with self.subTest(label=label):
                coordinator, _ = self._coordinator(response)

                result = await coordinator.async_send_activity(
                    "start",
                    {
                        "activity_id": "front-door",
                        "entity_id": "binary_sensor.front_door",
                        "data": {
                            "entity_based": True,
                            "source_service": "set_activity",
                        },
                    },
                )

                self.assertTrue(result.delivered_locally)
                self.assertFalse(result.delivered_outbound)
                self.assertEqual(result.relay_accepted_pending, accepted_pending)
                self.assertEqual(len(coordinator.hass.bus.events), 1)

    async def test_semantic_relay_conflict_does_not_publish_a_divergent_foreground_event(self) -> None:
        for error_code in (
            "entity_activity_id_changed",
            "pending_entity_activity_id_changed",
        ):
            with self.subTest(error_code=error_code):
                coordinator, _ = self._coordinator(
                    FakeRelayResponse(409, {"ok": False, "error": error_code})
                )

                result = await coordinator.async_send_activity(
                    "start",
                    {
                        "activity_id": "changed-id",
                        "entity_id": "switch.same_entity",
                        "data": {"entity_based": True, "source_service": "set_activity"},
                    },
                )

                self.assertFalse(result.delivered_locally)
                self.assertFalse(result.delivered_outbound)
                self.assertEqual(coordinator.hass.bus.events, [])

    async def test_transport_failure_keeps_foreground_compatibility_delivery(self) -> None:
        coordinator, _ = self._coordinator(
            FakeRelayResponse(503, {"ok": False, "error": "relay_unavailable"})
        )

        result = await coordinator.async_send_activity(
            "update",
            {"activity_id": "front_door", "state": "Open"},
        )

        self.assertTrue(result.delivered_locally)
        self.assertFalse(result.delivered_outbound)
        self.assertEqual(len(coordinator.hass.bus.events), 1)

    def test_activity_ids_use_one_collision_safe_routing_identity_for_every_action(self) -> None:
        coordinator, _ = self._coordinator(FakeRelayResponse(200, {"ok": True}))
        unsafe_id = "hadibeartık"
        routed_ids = {
            coordinator._normalize_message(action, {"activity_id": unsafe_id})["activity_id"]
            for action in ("start", "update", "end")
        }

        self.assertEqual(len(routed_ids), 1)
        routed_id = routed_ids.pop()
        self.assertTrue(routed_id.startswith("~"))
        padding = "=" * (-len(routed_id[1:]) % 4)
        self.assertEqual(
            base64.urlsafe_b64decode(routed_id[1:] + padding).decode("utf-8"),
            unsafe_id,
        )
        self.assertNotEqual(
            routed_id,
            coordinator._normalize_message("start", {"activity_id": "hadibeartik"})["activity_id"],
        )
        self.assertEqual(
            coordinator._normalize_message("start", {"activity_id": "legacy.valid-id_1"})["activity_id"],
            "legacy.valid-id_1",
        )

    def test_canonical_shaped_literal_cannot_collide_with_unicode_id(self) -> None:
        coordinator, _ = self._coordinator(FakeRelayResponse(200, {"ok": True}))

        unicode_route = coordinator._normalize_message("start", {"activity_id": "ü"})["activity_id"]
        literal_route = coordinator._normalize_message("start", {"activity_id": unicode_route})["activity_id"]

        self.assertNotEqual(literal_route, unicode_route)
        padding = "=" * (-len(literal_route[1:]) % 4)
        self.assertEqual(
            base64.urlsafe_b64decode(literal_route[1:] + padding).decode("utf-8"),
            unicode_route,
        )

    def test_service_routability_preflight_does_not_replace_raw_activity_id(self) -> None:
        payload = {"activity_id": "hadibeartık"}

        ha_init._validate_activity_service_payload(payload)

        self.assertEqual(payload["activity_id"], "hadibeartık")

    def test_activity_id_preserves_worker_historical_trimming(self) -> None:
        coordinator, _ = self._coordinator(FakeRelayResponse(200, {"ok": True}))

        routed_ids = {
            coordinator._normalize_message(action, {"activity_id": " front_door "})["activity_id"]
            for action in ("start", "update", "end")
        }

        self.assertEqual(routed_ids, {"front_door"})

        maximum_spaced = {"activity_id": f" {'a' * 128} "}
        ha_init._validate_activity_service_payload(maximum_spaced)
        self.assertEqual(maximum_spaced["activity_id"], f" {'a' * 128} ")
        self.assertEqual(
            coordinator._normalize_message("start", maximum_spaced)["activity_id"],
            "a" * 128,
        )

    def test_lone_surrogate_is_a_bounded_activity_id_error(self) -> None:
        coordinator, _ = self._coordinator(FakeRelayResponse(200, {"ok": True}))
        payload = {"activity_id": "\ud800"}

        with self.assertRaises(ha_security.PayloadValidationError) as coordinator_error:
            coordinator._normalize_message("start", payload)
        self.assertEqual(coordinator_error.exception.code, "activity_id_not_utf8")

        with self.assertRaises(ha_init.HomeAssistantError) as service_error:
            ha_init._validate_activity_service_payload(payload)
        self.assertIn("activity_id_not_utf8", str(service_error.exception))

    def test_activity_id_encoding_fails_closed_when_it_cannot_fit_relay_limit(self) -> None:
        coordinator, _ = self._coordinator(FakeRelayResponse(200, {"ok": True}))

        with self.assertRaises(ha_security.PayloadValidationError) as raised:
            coordinator._normalize_message("start", {"activity_id": "😀" * 40})

        self.assertEqual(raised.exception.code, "activity_id_not_routable")

    def test_maximum_legacy_activity_id_is_preserved_exactly(self) -> None:
        coordinator, _ = self._coordinator(FakeRelayResponse(200, {"ok": True}))
        activity_id = "a" * 128

        self.assertEqual(
            coordinator._normalize_message("start", {"activity_id": activity_id})["activity_id"],
            activity_id,
        )

    def test_service_rejects_overlong_encoded_id_before_dispatch(self) -> None:
        payload = {"activity_id": "😀" * 40}

        with self.assertRaises(ha_init.HomeAssistantError) as raised:
            ha_init._validate_activity_service_payload(payload)

        self.assertIn("activity_id_not_routable", str(raised.exception))


class FakePairingRequest:
    def __init__(
        self,
        hass: FakeHass,
        user: FakeUser,
        body: bytes,
        *,
        content_length: int | None | object = ...,
        chunk_size: int | None = None,
    ) -> None:
        self.app = {"hass": hass}
        self.content_length = len(body) if content_length is ... else content_length
        self._body = body
        self._values = {"hass_user": user}
        self.content = FakeByteStream(body, chunk_size=chunk_size) if chunk_size else None

    def __getitem__(self, key: str):
        return self._values[key]

    async def read(self) -> bytes:
        return self._body


class FakeByteStream:
    def __init__(self, body: bytes, *, chunk_size: int | None = None) -> None:
        self.body = body
        self.offset = 0
        self.chunk_size = chunk_size

    async def read(self, limit: int = -1) -> bytes:
        if self.offset >= len(self.body):
            return b""
        requested = len(self.body) - self.offset if limit < 0 else limit
        if self.chunk_size:
            requested = min(requested, self.chunk_size)
        end = min(len(self.body), self.offset + requested)
        chunk = self.body[self.offset:end]
        self.offset = end
        return chunk


class RelayPairingTests(unittest.IsolatedAsyncioTestCase):
    CANONICAL_INSTANCE_ID = "ha_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    PAIRING_TOKEN = "t" * 43

    def _hass_with_coordinator(
        self,
        responses: list[FakeRelayResponse],
        *,
        relay_secret: str = "existing-relay-secret-0123456789abcdef",
    ) -> tuple[FakeHass, object]:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        hass.session = FakeRelaySession(responses)
        coordinator = ha_coordinator.HALiveKitCoordinator(
            hass,
            FakePairingEntry(relay_secret),
        )
        hass.data[ha_pairing.DOMAIN]["entry"] = coordinator
        return hass, coordinator

    @staticmethod
    def _payload() -> dict:
        return {
            "home_assistant_instance_id": "ha_1234567890abcdef1234567890abcdef",
            "device_id": "ios-device-a",
            "push_to_start_token_hash": "a" * 64,
            "relay_environment": "production",
            "bundle_id": "com.example.HALiveKit",
            "app_version": "2.0",
        }

    @classmethod
    def _provision_response(cls, **overrides) -> dict:
        return {
            "ok": True,
            "provisioned": True,
            "auth_protocol": "v2",
            "instance_id_version": 2,
            "home_assistant_instance_id": cls.CANONICAL_INSTANCE_ID,
            **overrides,
        }

    @classmethod
    def _pairing_response(cls, **overrides) -> dict:
        return {
            "ok": True,
            "auth_protocol": "v2",
            "pairing_token": cls.PAIRING_TOKEN,
            "expires_in": 300,
            "home_assistant_instance_id": cls.CANONICAL_INSTANCE_ID,
            "device_id": "ios-device-a",
            "apns_environment": "production",
            **overrides,
        }

    async def test_admin_pairing_provisions_then_returns_only_short_lived_ticket(self) -> None:
        hass, coordinator = self._hass_with_coordinator([
            FakeRelayResponse(200, self._provision_response()),
            FakeRelayResponse(200, self._pairing_response()),
        ])

        result = await ha_pairing.async_create_relay_pairing(hass, self._payload())

        self.assertEqual(result["pairing_token"], self.PAIRING_TOKEN)
        self.assertEqual(result["auth_protocol"], "v2")
        self.assertNotIn("relay_shared_secret", result)
        self.assertEqual(len(hass.session.calls), 2)
        provision_call, pairing_call = hass.session.calls
        self.assertTrue(provision_call["url"].endswith("/v2/instances/provision"))
        self.assertNotIn(ha_pairing.HEADER_SECRET, provision_call["headers"])
        provision_body = json.loads(provision_call["data"])
        self.assertEqual(
            provision_body["current_relay_shared_secret"],
            "existing-relay-secret-0123456789abcdef",
        )
        self.assertTrue(pairing_call["url"].endswith("/v2/pairing-tokens"))
        self.assertEqual(
            pairing_call["headers"][ha_pairing.HEADER_SECRET],
            "existing-relay-secret-0123456789abcdef",
        )
        self.assertFalse(provision_call["allow_redirects"])
        self.assertFalse(pairing_call["allow_redirects"])
        self.assertEqual(len(hass.config_entries.updates), 1)
        options = hass.config_entries.updates[-1]
        self.assertEqual(options[ha_pairing.CONF_RELAY_ENVIRONMENT], "production")
        self.assertEqual(
            options[ha_pairing.CONF_RELAY_SHARED_SECRET],
            "existing-relay-secret-0123456789abcdef",
        )
        self.assertIs(coordinator.config_entry.options, options)

    async def test_new_pairing_generates_secret_inside_home_assistant(self) -> None:
        hass, _ = self._hass_with_coordinator([
            FakeRelayResponse(200, self._provision_response()),
            FakeRelayResponse(200, self._pairing_response()),
        ], relay_secret="")

        await ha_pairing.async_create_relay_pairing(hass, self._payload())

        options = hass.config_entries.updates[0]
        generated = options[ha_pairing.CONF_PENDING_MANAGED_RELAY_SHARED_SECRET]
        self.assertGreaterEqual(len(generated), 32)
        provision_body = json.loads(hass.session.calls[0]["data"])
        self.assertEqual(provision_body[ha_pairing.CONF_RELAY_SHARED_SECRET], generated)
        self.assertNotIn("current_relay_shared_secret", provision_body)
        self.assertEqual(hass.session.calls[1]["headers"][ha_pairing.HEADER_SECRET], generated)
        final_options = hass.config_entries.updates[-1]
        self.assertEqual(final_options[ha_pairing.CONF_RELAY_SHARED_SECRET], generated)
        self.assertNotIn(ha_pairing.CONF_PENDING_MANAGED_RELAY_SHARED_SECRET, final_options)
        self.assertNotIn(ha_pairing.CONF_PENDING_MANAGED_RELAY_INSTANCE_ID, final_options)

    async def test_new_secret_is_recoverable_when_ticket_request_fails(self) -> None:
        hass, coordinator = self._hass_with_coordinator([
            FakeRelayResponse(200, self._provision_response()),
            FakeRelayResponse(502, {"error": "temporary_failure"}),
        ], relay_secret="")

        with self.assertRaises(ha_pairing.RelayPairingError) as raised:
            await ha_pairing.async_create_relay_pairing(hass, self._payload())

        self.assertEqual(raised.exception.code, "relay_pairing_failed")
        self.assertEqual(len(hass.config_entries.updates), 1)
        persisted = coordinator.config_entry.options[
            ha_pairing.CONF_PENDING_MANAGED_RELAY_SHARED_SECRET
        ]
        self.assertGreaterEqual(len(persisted), 32)
        self.assertEqual(
            hass.session.calls[1]["headers"][ha_pairing.HEADER_SECRET],
            persisted,
        )
        self.assertNotIn(ha_pairing.CONF_RELAY_SHARED_SECRET, coordinator.config_entry.options)

    async def test_pairing_validation_and_relay_failures_preserve_recovery_identity(self) -> None:
        hass, _ = self._hass_with_coordinator([])
        invalid = {**self._payload(), "push_to_start_token_hash": "not-a-hash"}
        with self.assertRaises(ha_pairing.RelayPairingError) as raised:
            await ha_pairing.async_create_relay_pairing(hass, invalid)
        self.assertEqual(raised.exception.code, "invalid_push_token_hash")
        self.assertEqual(hass.session.calls, [])

        hass, _ = self._hass_with_coordinator([
            FakeRelayResponse(404, {"error": "not_found"}),
        ])
        with self.assertRaises(ha_pairing.RelayPairingError) as unavailable:
            await ha_pairing.async_create_relay_pairing(hass, self._payload())
        self.assertEqual(unavailable.exception.code, "relay_v2_unavailable")
        self.assertEqual(len(hass.config_entries.updates), 0)
        self.assertEqual(
            unavailable.exception.details[ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID],
            self.CANONICAL_INSTANCE_ID,
        )

        hass, _ = self._hass_with_coordinator([
            FakeRelayResponse(200, "x" * (ha_pairing.MAX_RELAY_RESPONSE_BYTES + 1)),
        ])
        with self.assertRaises(ha_pairing.RelayPairingError) as oversized:
            await ha_pairing.async_create_relay_pairing(hass, self._payload())
        self.assertEqual(oversized.exception.code, "relay_response_too_large")
        self.assertEqual(len(hass.config_entries.updates), 0)

    async def test_home_assistant_owns_one_canonical_instance_id_for_multiple_devices(self) -> None:
        hass, _ = self._hass_with_coordinator([
            FakeRelayResponse(200, self._provision_response()),
            FakeRelayResponse(200, self._pairing_response()),
        ])
        first = await ha_pairing.async_create_relay_pairing(hass, self._payload())
        canonical = first[ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID]
        self.assertRegex(canonical, r"^ha_[a-f0-9]{32}$")

        hass.session = FakeRelaySession([
            FakeRelayResponse(200, self._provision_response()),
            FakeRelayResponse(
                200,
                self._pairing_response(
                    pairing_token="u" * 43,
                    device_id="ios-device-b",
                ),
            ),
        ])
        second_payload = {
            **self._payload(),
            "home_assistant_instance_id": "ha_fedcba0987654321fedcba0987654321",
            "device_id": "ios-device-b",
        }
        second = await ha_pairing.async_create_relay_pairing(hass, second_payload)
        self.assertEqual(second[ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID], canonical)
        self.assertEqual(
            json.loads(hass.session.calls[0]["data"])[ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID],
            canonical,
        )

    async def test_pairing_does_not_require_or_trust_a_client_instance_candidate(self) -> None:
        hass, _ = self._hass_with_coordinator([
            FakeRelayResponse(200, self._provision_response()),
            FakeRelayResponse(200, self._pairing_response()),
        ])
        payload = self._payload()
        payload.pop("home_assistant_instance_id")

        result = await ha_pairing.async_create_relay_pairing(hass, payload)

        self.assertEqual(
            result[ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID],
            self.CANONICAL_INSTANCE_ID,
        )
        self.assertEqual(
            json.loads(hass.session.calls[0]["data"])[
                ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID
            ],
            self.CANONICAL_INSTANCE_ID,
        )

    async def test_working_managed_identity_wins_over_stale_pending_material(self) -> None:
        hass, coordinator = self._hass_with_coordinator([
            FakeRelayResponse(200, self._provision_response()),
            FakeRelayResponse(200, self._pairing_response()),
        ])
        stale_instance_id = "ha_dddddddddddddddddddddddddddddddd"
        stale_secret = "stale-pending-managed-relay-secret"
        coordinator.config_entry.options = {
            ha_pairing.CONF_PENDING_MANAGED_RELAY_INSTANCE_ID: stale_instance_id,
            ha_pairing.CONF_PENDING_MANAGED_RELAY_SHARED_SECRET: stale_secret,
        }

        result = await ha_pairing.async_create_relay_pairing(hass, self._payload())

        provision_body = json.loads(hass.session.calls[0]["data"])
        self.assertEqual(
            provision_body[ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID],
            self.CANONICAL_INSTANCE_ID,
        )
        self.assertEqual(
            result[ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID],
            self.CANONICAL_INSTANCE_ID,
        )
        self.assertNotIn(
            ha_pairing.CONF_PENDING_MANAGED_RELAY_INSTANCE_ID,
            coordinator.config_entry.options,
        )

    async def test_failed_managed_pairing_preserves_active_custom_relay(self) -> None:
        custom_secret = "custom-relay-secret-that-remains-active"
        custom_id = "ha_cccccccccccccccccccccccccccccccc"
        custom_options = {
            ha_pairing.CONF_RELAY_ENABLED: True,
            ha_pairing.CONF_RELAY_MODE: ha_coordinator.RELAY_MODE_CUSTOM,
            ha_pairing.CONF_RELAY_URL: "https://relay.internal.example/api",
            ha_pairing.CONF_RELAY_SHARED_SECRET: custom_secret,
            ha_pairing.CONF_RELAY_ENVIRONMENT: "sandbox",
            ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID: custom_id,
        }
        hass, coordinator = self._hass_with_coordinator([
            FakeRelayResponse(502, {"error": "temporary_failure"}),
        ])
        coordinator.config_entry.options = dict(custom_options)

        with self.assertRaises(ha_pairing.RelayPairingError) as raised:
            await ha_pairing.async_create_relay_pairing(hass, self._payload())

        self.assertEqual(raised.exception.code, "relay_pairing_failed")
        for key, value in custom_options.items():
            self.assertEqual(coordinator.config_entry.options[key], value)
        self.assertEqual(coordinator.relay_mode, ha_coordinator.RELAY_MODE_CUSTOM)
        self.assertEqual(coordinator.relay_url, custom_options[ha_pairing.CONF_RELAY_URL])
        self.assertEqual(coordinator.relay_shared_secret, custom_secret)
        pending_id = coordinator.config_entry.options[
            ha_pairing.CONF_PENDING_MANAGED_RELAY_INSTANCE_ID
        ]
        pending_secret = coordinator.config_entry.options[
            ha_pairing.CONF_PENDING_MANAGED_RELAY_SHARED_SECRET
        ]
        self.assertRegex(pending_id, r"^ha_[a-f0-9]{32}$")
        self.assertNotEqual(pending_id, custom_id)
        self.assertNotEqual(pending_secret, custom_secret)
        self.assertEqual(
            raised.exception.details[ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID],
            pending_id,
        )

    async def test_pending_identity_survives_restart_and_recovers_uncertain_provision(self) -> None:
        hass, coordinator = self._hass_with_coordinator([
            FakeRelayResponse(503, {"error": "upstream_timeout"}),
        ], relay_secret="")
        with self.assertRaises(ha_pairing.RelayPairingError):
            await ha_pairing.async_create_relay_pairing(hass, self._payload())

        pending_options = dict(coordinator.config_entry.options)
        pending_id = pending_options[ha_pairing.CONF_PENDING_MANAGED_RELAY_INSTANCE_ID]
        pending_secret = pending_options[ha_pairing.CONF_PENDING_MANAGED_RELAY_SHARED_SECRET]

        restarted_hass = FakeHass({"admin": FakeUser(is_admin=True)})
        restarted_hass.session = FakeRelaySession([
            FakeRelayResponse(
                200,
                self._provision_response(
                    home_assistant_instance_id=pending_id,
                ),
            ),
            FakeRelayResponse(
                200,
                self._pairing_response(
                    home_assistant_instance_id=pending_id,
                ),
            ),
        ])
        restarted_entry = FakePairingEntry(
            "",
            options=pending_options,
        )
        restarted_coordinator = ha_coordinator.HALiveKitCoordinator(
            restarted_hass,
            restarted_entry,
        )
        restarted_hass.data[ha_pairing.DOMAIN]["entry"] = restarted_coordinator

        result = await ha_pairing.async_create_relay_pairing(
            restarted_hass,
            self._payload(),
        )

        provision_body = json.loads(restarted_hass.session.calls[0]["data"])
        self.assertEqual(provision_body[ha_pairing.CONF_RELAY_SHARED_SECRET], pending_secret)
        self.assertEqual(provision_body["current_relay_shared_secret"], pending_secret)
        self.assertEqual(result[ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID], pending_id)
        self.assertNotIn(
            ha_pairing.CONF_PENDING_MANAGED_RELAY_SHARED_SECRET,
            restarted_entry.options,
        )

    async def test_unsafe_legacy_identity_is_never_used_as_canonical(self) -> None:
        unsafe_id = "ha_980c4bd6a677da0511813adb8c98192e"
        hass, coordinator = self._hass_with_coordinator([
            FakeRelayResponse(404, {"error": "not_found"}),
        ], relay_secret="legacy-secret-that-must-not-be-reused")
        coordinator.config_entry.data[ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID] = unsafe_id

        with self.assertRaises(ha_pairing.RelayPairingError) as raised:
            await ha_pairing.async_create_relay_pairing(hass, self._payload())

        provision_body = json.loads(hass.session.calls[0]["data"])
        recovery_id = raised.exception.details[ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID]
        self.assertRegex(recovery_id, r"^ha_[a-f0-9]{32}$")
        self.assertNotEqual(recovery_id, unsafe_id)
        self.assertNotEqual(
            provision_body[ha_pairing.CONF_RELAY_SHARED_SECRET],
            "legacy-secret-that-must-not-be-reused",
        )
        self.assertNotIn("current_relay_shared_secret", provision_body)

    async def test_relay_redirects_and_declared_oversized_responses_are_rejected(self) -> None:
        for response, expected_code in (
            (FakeRelayResponse(302, "redirect"), "relay_redirect_rejected"),
            (
                FakeRelayResponse(
                    200,
                    self._provision_response(),
                    content_length=ha_pairing.MAX_RELAY_RESPONSE_BYTES + 1,
                ),
                "relay_response_too_large",
            ),
        ):
            with self.subTest(expected_code=expected_code):
                hass, _ = self._hass_with_coordinator([response])
                with self.assertRaises(ha_pairing.RelayPairingError) as raised:
                    await ha_pairing.async_create_relay_pairing(hass, self._payload())
                self.assertEqual(raised.exception.code, expected_code)
                self.assertFalse(hass.session.calls[0]["allow_redirects"])

    async def test_relay_success_responses_require_exact_v2_scope_and_types(self) -> None:
        invalid_cases = (
            (
                [
                    FakeRelayResponse(
                        200,
                        self._provision_response(
                            home_assistant_instance_id="ha_dddddddddddddddddddddddddddddddd",
                        ),
                    ),
                ],
                "provision scope",
            ),
            (
                [
                    FakeRelayResponse(200, self._provision_response()),
                    FakeRelayResponse(200, self._pairing_response(device_id="other-device")),
                ],
                "ticket scope",
            ),
            (
                [
                    FakeRelayResponse(200, self._provision_response()),
                    FakeRelayResponse(200, self._pairing_response(expires_in=True)),
                ],
                "ticket type",
            ),
        )
        for responses, label in invalid_cases:
            with self.subTest(label=label):
                hass, _ = self._hass_with_coordinator(responses)
                with self.assertRaises(ha_pairing.RelayPairingError) as raised:
                    await ha_pairing.async_create_relay_pairing(hass, self._payload())
                self.assertEqual(raised.exception.code, "invalid_relay_response")
                self.assertEqual(
                    raised.exception.details[ha_pairing.CONF_HOME_ASSISTANT_INSTANCE_ID],
                    self.CANONICAL_INSTANCE_ID,
                )

    async def test_only_explicit_unsupported_statuses_enable_v1_unavailable_path(self) -> None:
        for status in (404, 405, 501):
            with self.subTest(status=status):
                hass, _ = self._hass_with_coordinator([
                    FakeRelayResponse(status, {"error": "unsupported"}),
                ])
                with self.assertRaises(ha_pairing.RelayPairingError) as raised:
                    await ha_pairing.async_create_relay_pairing(hass, self._payload())
                self.assertEqual(raised.exception.code, "relay_v2_unavailable")

    async def test_pairing_view_rejects_non_admin_and_registers_once(self) -> None:
        hass = FakeHass({})
        ha_pairing.async_register_pairing_view(hass)
        ha_pairing.async_register_pairing_view(hass)
        self.assertEqual(len(hass.http.views), 3)

        status = await ha_pairing.HALiveKitStatusView().get(
            FakePairingRequest(hass, FakeUser(is_admin=False), b"")
        )
        self.assertEqual(status.status, 200)
        self.assertEqual(status.headers["Cache-Control"], "no-store")
        self.assertEqual(status.payload["integration_version"], ha_pairing.VERSION)
        self.assertEqual(
            status.payload["capabilities"],
            {"relay_pairing_v2": True, "relay_devices_v2": True},
        )
        serialized_status = json.dumps(status.payload).lower()
        for forbidden in ("token", "secret", "credential", "relay_url"):
            self.assertNotIn(forbidden, serialized_status)

        request = FakePairingRequest(
            hass,
            FakeUser(is_admin=False),
            json.dumps(self._payload()).encode(),
        )
        forbidden = await ha_pairing.HALiveKitRelayPairingView().post(request)
        self.assertEqual(forbidden.status, 403)
        self.assertEqual(
            forbidden.payload,
            {"ok": False, "error": "administrator_required"},
        )
        self.assertEqual(forbidden.headers["Cache-Control"], "no-store")

        oversized = b"x" * (ha_pairing.MAX_PAIRING_REQUEST_BYTES + 1)
        declared = FakePairingRequest(
            hass,
            FakeUser(is_admin=True),
            oversized,
        )
        chunked = FakePairingRequest(
            hass,
            FakeUser(is_admin=True),
            oversized,
            content_length=None,
            chunk_size=1024,
        )
        declared_response = await ha_pairing.HALiveKitRelayPairingView().post(declared)
        chunked_response = await ha_pairing.HALiveKitRelayPairingView().post(chunked)
        self.assertEqual(declared_response.status, 413)
        self.assertEqual(chunked_response.status, 413)
        self.assertEqual(declared_response.headers["Cache-Control"], "no-store")
        self.assertEqual(chunked_response.headers["Cache-Control"], "no-store")

    async def test_admin_device_inventory_and_revoke_are_exactly_scoped(self) -> None:
        inventory = {
            "ok": True,
            "home_assistant_instance_id": self.CANONICAL_INSTANCE_ID,
            "apns_environment": "sandbox",
            "devices": [
                {
                    "device_id": "phone-one",
                    "friendly_device_name": "Test iPhone",
                    "auth_protocol": "v2",
                    "auth_generation": 3,
                    "app_version": "1.1.4",
                    "updated_at": "2026-07-12T00:00:00Z",
                }
            ],
        }
        revoked = {
            "ok": True,
            "revoked": True,
            "device_id": "phone-one",
            "home_assistant_instance_id": self.CANONICAL_INSTANCE_ID,
            "apns_environment": "sandbox",
        }
        hass, _ = self._hass_with_coordinator(
            [FakeRelayResponse(200, inventory), FakeRelayResponse(200, revoked)]
        )
        request = FakePairingRequest(hass, FakeUser(is_admin=True), b"")

        listed = await ha_pairing.HALiveKitRelayDevicesView().get(request)
        self.assertEqual(listed.status, 200)
        self.assertEqual(listed.payload["devices"][0]["device_id"], "phone-one")
        self.assertNotIn("device_credential", listed.payload["devices"][0])
        inventory_call = hass.session.calls[0]
        self.assertEqual(inventory_call["method"], "GET")
        self.assertFalse(inventory_call["allow_redirects"])
        self.assertEqual(
            inventory_call["headers"][ha_pairing.HEADER_SECRET],
            "existing-relay-secret-0123456789abcdef",
        )

        revoke_request = FakePairingRequest(
            hass,
            FakeUser(is_admin=True),
            json.dumps({"device_id": "phone-one"}).encode(),
        )
        removed = await ha_pairing.HALiveKitRelayDevicesView().post(revoke_request)
        self.assertEqual(removed.status, 200)
        self.assertTrue(removed.payload["revoked"])
        revoke_call = hass.session.calls[1]
        self.assertEqual(revoke_call["method"], "POST")
        self.assertFalse(revoke_call["allow_redirects"])
        self.assertEqual(json.loads(revoke_call["data"])["device_id"], "phone-one")

    async def test_device_management_rejects_non_admin_before_network(self) -> None:
        hass, _ = self._hass_with_coordinator([])
        request = FakePairingRequest(hass, FakeUser(is_admin=False), b"")

        listed = await ha_pairing.HALiveKitRelayDevicesView().get(request)
        revoked = await ha_pairing.HALiveKitRelayDevicesView().post(request)

        self.assertEqual(listed.status, 403)
        self.assertEqual(revoked.status, 403)
        self.assertEqual(hass.session.calls, [])


class LegacyManagedProvisioningTests(unittest.IsolatedAsyncioTestCase):
    INSTANCE_ID = "ha_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

    @classmethod
    def _success_response(cls, **overrides) -> dict:
        return {
            "ok": True,
            "provisioned": True,
            "instance_id_version": 2,
            "home_assistant_instance_id": cls.INSTANCE_ID,
            **overrides,
        }

    async def _provision(self, response: FakeRelayResponse) -> tuple[FakeHass, FakeRelaySession]:
        hass = FakeHass({"admin": FakeUser(is_admin=True)})
        session = FakeRelaySession([response])
        hass.session = session
        await ha_init._async_provision_managed_relay_secret(
            hass,
            ha_init.MANAGED_RELAY_URL,
            "embedded-app-registration-secret",
            self.INSTANCE_ID,
            "new-managed-relay-secret-value-123",
            "current-managed-relay-secret-value",
        )
        return hass, session

    async def test_legacy_provision_requires_exact_scoped_success_without_redirects(self) -> None:
        _, session = await self._provision(
            FakeRelayResponse(200, self._success_response())
        )

        call = session.calls[0]
        self.assertFalse(call["allow_redirects"])
        self.assertEqual(
            call["headers"][ha_init._APP_SECRET_HEADER],
            "embedded-app-registration-secret",
        )
        body = json.loads(call["data"])
        self.assertEqual(body[ha_init.CONF_HOME_ASSISTANT_INSTANCE_ID], self.INSTANCE_ID)

    async def test_legacy_provision_rejects_redirect_oversize_and_wrong_scope(self) -> None:
        cases = (
            (FakeRelayResponse(307, "redirect"), "redirect"),
            (
                FakeRelayResponse(
                    200,
                    self._success_response(),
                    content_length=ha_init._MAX_MANAGED_RELAY_RESPONSE_BYTES + 1,
                ),
                "too large",
            ),
            (
                FakeRelayResponse(
                    200,
                    self._success_response(
                        home_assistant_instance_id="ha_ffffffffffffffffffffffffffffffff",
                    ),
                ),
                "invalid scoped response",
            ),
        )
        for response, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(ha_init.HomeAssistantError) as raised:
                    await self._provision(response)
                self.assertIn(message, str(raised.exception))

    async def test_legacy_error_body_is_not_reflected_to_the_admin(self) -> None:
        response = FakeRelayResponse(
            409,
            '{"token":"top-secret-value","error":"already provisioned"}',
        )

        with self.assertRaises(ha_init.HomeAssistantError) as raised:
            await self._provision(response)

        message = str(raised.exception)
        self.assertIn("HTTP 409", message)
        self.assertNotIn("top-secret-value", message)
        self.assertNotIn("already provisioned", message)


class FakeWebhookEntry:
    def __init__(self, *, allow_legacy_secret: bool = False) -> None:
        self.data = {ha_coordinator.CONF_SHARED_SECRET: "webhook-test-secret"}
        self.options = {
            ha_coordinator.CONF_ALLOW_LEGACY_WEBHOOK_SECRET: allow_legacy_secret,
        }
        self.unload_callbacks: list[object] = []

    def async_on_unload(self, callback) -> None:
        self.unload_callbacks.append(callback)


class FakeWebhookRequest:
    def __init__(
        self,
        body: bytes,
        *,
        headers: dict[str, str] | None = None,
        content_length: int | None | object = ...,
    ) -> None:
        self._body = body
        self.headers = headers or {}
        self.content = None
        self.content_length = len(body) if content_length is ... else content_length

    async def read(self) -> bytes:
        return self._body


class WebhookAuthenticationTests(unittest.IsolatedAsyncioTestCase):
    def _coordinator(self, *, allow_legacy_secret: bool = False):
        return ha_coordinator.HALiveKitCoordinator(
            types.SimpleNamespace(),
            FakeWebhookEntry(allow_legacy_secret=allow_legacy_secret),
        )

    def _registered_handler(self, coordinator):
        registered: list[object] = []
        original_register = ha_webhook.webhook.async_register
        ha_webhook.webhook.async_register = lambda *args, **kwargs: registered.append(args[4])
        try:
            entry = FakeWebhookEntry()
            ha_webhook.async_register_webhook(types.SimpleNamespace(), entry, coordinator)
        finally:
            ha_webhook.webhook.async_register = original_register
        return registered[0]

    async def test_timestamped_hmac_accepts_once_and_rejects_replay(self) -> None:
        coordinator = self._coordinator()
        body = json.dumps({"action": "update", "activity_id": "door"}).encode()
        timestamp = "1000"
        nonce = "nonce-1234567890"
        signature = coordinator.signature_for_bytes(body, timestamp, nonce)

        first = coordinator.authenticate_webhook_request(
            body,
            signature,
            timestamp,
            nonce,
            None,
            now=1001,
        )
        replay = coordinator.authenticate_webhook_request(
            body,
            signature,
            timestamp,
            nonce,
            None,
            now=1002,
        )

        self.assertEqual(first, ha_coordinator.WEBHOOK_AUTH_OK)
        self.assertEqual(replay, ha_coordinator.WEBHOOK_AUTH_REPLAYED)

    async def test_invalid_signature_does_not_consume_nonce(self) -> None:
        coordinator = self._coordinator()
        body = b'{"action":"update","activity_id":"door"}'
        timestamp = "1000"
        nonce = "nonce-1234567890"
        valid_signature = coordinator.signature_for_bytes(body, timestamp, nonce)

        invalid = coordinator.authenticate_webhook_request(
            body,
            "sha256=invalid",
            timestamp,
            nonce,
            None,
            now=1000,
        )
        valid = coordinator.authenticate_webhook_request(
            body,
            valid_signature,
            timestamp,
            nonce,
            None,
            now=1000,
        )

        self.assertEqual(invalid, ha_coordinator.WEBHOOK_AUTH_UNAUTHORIZED)
        self.assertEqual(valid, ha_coordinator.WEBHOOK_AUTH_OK)

    async def test_stale_timestamp_is_rejected(self) -> None:
        coordinator = self._coordinator()
        body = b'{"action":"update","activity_id":"door"}'
        timestamp = "1000"
        nonce = "nonce-1234567890"
        signature = coordinator.signature_for_bytes(body, timestamp, nonce)

        result = coordinator.authenticate_webhook_request(
            body,
            signature,
            timestamp,
            nonce,
            None,
            now=1301,
        )

        self.assertEqual(result, ha_coordinator.WEBHOOK_AUTH_STALE)

    async def test_noncanonical_timestamp_and_short_nonce_are_rejected(self) -> None:
        coordinator = self._coordinator()
        body = b'{"action":"update","activity_id":"door"}'

        for timestamp, nonce in (("+1000", "nonce-1234567890"), ("1000", "short")):
            with self.subTest(timestamp=timestamp, nonce=nonce):
                signature = coordinator.signature_for_bytes(body, timestamp, nonce)
                result = coordinator.authenticate_webhook_request(
                    body,
                    signature,
                    timestamp,
                    nonce,
                    None,
                    now=1000,
                )
                self.assertEqual(result, ha_coordinator.WEBHOOK_AUTH_INVALID_FRESHNESS)

    async def test_existing_legacy_hmac_path_remains_compatible_with_replay_guard(self) -> None:
        coordinator = self._coordinator()
        body = b'{"action":"update","activity_id":"legacy"}'
        signature = coordinator.signature_for_bytes(body)

        with self.assertLogs(ha_coordinator._LOGGER, level="WARNING"):
            first = coordinator.authenticate_webhook_request(
                body,
                signature,
                None,
                None,
                None,
                now=1000,
            )
        replay = coordinator.authenticate_webhook_request(
            body,
            signature,
            None,
            None,
            None,
            now=1001,
        )
        after_ttl = coordinator.authenticate_webhook_request(
            body,
            signature,
            None,
            None,
            None,
            now=1601,
        )

        self.assertEqual(first, ha_coordinator.WEBHOOK_AUTH_OK_LEGACY_SIGNATURE)
        self.assertEqual(replay, ha_coordinator.WEBHOOK_AUTH_REPLAYED)
        self.assertEqual(after_ttl, ha_coordinator.WEBHOOK_AUTH_OK_LEGACY_SIGNATURE)

    async def test_plaintext_secret_is_disabled_by_default_and_feature_flagged(self) -> None:
        body = b'{"action":"update","activity_id":"legacy","secret":"webhook-test-secret"}'
        secure_default = self._coordinator()
        compatibility_mode = self._coordinator(allow_legacy_secret=True)

        disabled = secure_default.authenticate_webhook_request(
            body,
            None,
            None,
            None,
            "webhook-test-secret",
            now=1000,
        )
        with self.assertLogs(ha_coordinator._LOGGER, level="WARNING"):
            enabled = compatibility_mode.authenticate_webhook_request(
                body,
                None,
                None,
                None,
                "webhook-test-secret",
                now=1000,
            )

        self.assertEqual(disabled, ha_coordinator.WEBHOOK_AUTH_LEGACY_SECRET_DISABLED)
        self.assertEqual(enabled, ha_coordinator.WEBHOOK_AUTH_OK_LEGACY_SECRET)

    async def test_webhook_endpoint_accepts_fresh_hmac_and_dispatches(self) -> None:
        coordinator = self._coordinator()
        received: list[dict] = []

        async def fake_handle(payload: dict) -> None:
            received.append(payload)

        coordinator.async_handle_webhook = fake_handle
        handler = self._registered_handler(coordinator)

        body = b'{"action":"update","activity_id":"door","state":"closed"}'
        timestamp = str(int(time.time()))
        nonce = "nonce-abcdef123456"
        request = FakeWebhookRequest(
            body,
            headers={
                ha_coordinator.HEADER_SIGNATURE: coordinator.signature_for_bytes(body, timestamp, nonce),
                ha_webhook.HEADER_TIMESTAMP: timestamp,
                ha_webhook.HEADER_NONCE: nonce,
            },
        )

        response = await handler(types.SimpleNamespace(), "ha_livekit_update", request)

        self.assertEqual(response.status, 200)
        self.assertEqual(received, [{"action": "update", "activity_id": "door", "state": "closed"}])

    async def test_webhook_preflight_keeps_raw_unicode_for_single_coordinator_transform(self) -> None:
        coordinator = self._coordinator()
        received: list[dict] = []

        async def fake_handle(payload: dict) -> None:
            received.append(payload)

        coordinator.async_handle_webhook = fake_handle
        handler = self._registered_handler(coordinator)
        body = json.dumps(
            {"action": "update", "activity_id": "hadibeartık"},
            ensure_ascii=False,
        ).encode()
        timestamp = str(int(time.time()))
        nonce = "nonce-unicode12345"
        request = FakeWebhookRequest(
            body,
            headers={
                ha_coordinator.HEADER_SIGNATURE: coordinator.signature_for_bytes(body, timestamp, nonce),
                ha_webhook.HEADER_TIMESTAMP: timestamp,
                ha_webhook.HEADER_NONCE: nonce,
            },
        )

        response = await handler(types.SimpleNamespace(), "ha_livekit_update", request)

        self.assertEqual(response.status, 200)
        self.assertEqual(received[0]["activity_id"], "hadibeartık")

    async def test_webhook_lone_surrogate_returns_actionable_400(self) -> None:
        coordinator = self._coordinator()
        received: list[dict] = []

        async def fake_handle(payload: dict) -> None:
            received.append(payload)

        coordinator.async_handle_webhook = fake_handle
        handler = self._registered_handler(coordinator)
        body = b'{"action":"update","activity_id":"\\ud800"}'
        timestamp = str(int(time.time()))
        nonce = "nonce-surrogate123"
        request = FakeWebhookRequest(
            body,
            headers={
                ha_coordinator.HEADER_SIGNATURE: coordinator.signature_for_bytes(body, timestamp, nonce),
                ha_webhook.HEADER_TIMESTAMP: timestamp,
                ha_webhook.HEADER_NONCE: nonce,
            },
        )

        response = await handler(types.SimpleNamespace(), "ha_livekit_update", request)

        self.assertEqual(response.status, 400)
        self.assertEqual(response.payload["error"], "activity_id_not_utf8")
        self.assertEqual(received, [])

    async def test_webhook_endpoint_keeps_existing_signed_body_compatible(self) -> None:
        coordinator = self._coordinator()
        received: list[dict] = []

        async def fake_handle(payload: dict) -> None:
            received.append(payload)

        coordinator.async_handle_webhook = fake_handle
        handler = self._registered_handler(coordinator)
        body = b'{"action":"update","activity_id":"legacy-signed"}'
        request = FakeWebhookRequest(
            body,
            headers={
                ha_coordinator.HEADER_SIGNATURE: coordinator.signature_for_bytes(body),
            },
        )

        with self.assertLogs(ha_coordinator._LOGGER, level="WARNING"):
            response = await handler(types.SimpleNamespace(), "ha_livekit_update", request)

        self.assertEqual(response.status, 200)
        self.assertEqual(received, [{"action": "update", "activity_id": "legacy-signed"}])

    async def test_webhook_endpoint_rejects_body_plaintext_secret_by_default(self) -> None:
        coordinator = self._coordinator()
        handler = self._registered_handler(coordinator)
        body = b'{"action":"update","activity_id":"legacy","secret":"webhook-test-secret"}'

        with self.assertLogs(ha_webhook._LOGGER, level="WARNING"):
            response = await handler(
                types.SimpleNamespace(),
                "ha_livekit_update",
                FakeWebhookRequest(body),
            )

        self.assertEqual(response.status, 401)
        self.assertEqual(response.payload, {"ok": False, "error": "unauthorized"})

    async def test_webhook_body_limit_rejects_declared_and_chunked_oversize(self) -> None:
        oversized = b"x" * (ha_security.MAX_WEBHOOK_BODY_BYTES + 1)
        declared = FakeWebhookRequest(oversized)
        chunked = FakeWebhookRequest(oversized, content_length=None)

        self.assertIsNone(await ha_webhook._async_read_limited_body(declared))
        self.assertIsNone(await ha_webhook._async_read_limited_body(chunked))


class PayloadValidationTests(unittest.TestCase):
    def test_rejects_field_length_depth_complexity_and_non_finite_number(self) -> None:
        cases = [
            ({"activity_id": "door", "title": "x" * 513}, "field_too_long:title"),
            ({"activity_id": "door", "data": {str(index): index for index in range(513)}}, "payload_too_complex"),
            ({"activity_id": "door", "progress": float("nan")}, "payload_number_not_finite"),
        ]
        deep: dict = {}
        cursor = deep
        for _ in range(10):
            cursor["nested"] = {}
            cursor = cursor["nested"]
        cases.append(({"activity_id": "door", "data": deep}, "payload_too_deep"))

        for payload, expected in cases:
            with self.subTest(expected=expected):
                with self.assertRaises(ha_security.PayloadValidationError) as raised:
                    ha_security.validate_activity_payload(payload)
                self.assertEqual(raised.exception.code, expected)


class ReleaseVersionAlignmentTests(unittest.TestCase):
    def test_app_and_hacs_release_lines_match(self) -> None:
        root = Path(__file__).parents[1]
        manifest_version = json.loads(
            (root / "custom_components/ha_livekit/manifest.json").read_text()
        )["version"]
        self.assertRegex(manifest_version, r"^[0-9]+\.[0-9]+\.[0-9]+$")
        self.assertEqual(manifest_version, ha_pairing.VERSION)

        project_text = (
            root / "ios/HA LiveKit/HA LiveKit.xcodeproj/project.pbxproj"
        ).read_text()
        app_versions = {
            match.strip().strip('"')
            for match in re.findall(r"MARKETING_VERSION = ([^;]+);", project_text)
        }
        self.assertEqual(len(app_versions), 1)
        app_version = app_versions.pop()

        def release_line(version: str) -> tuple[int, int]:
            parts = tuple(int(part) for part in version.split("."))
            self.assertGreaterEqual(len(parts), 2)
            return parts[:2]

        self.assertEqual(release_line(app_version), release_line(manifest_version))


class SupportEmailPrivacyPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        root = Path(__file__).parents[1] / "ios" / "HA LiveKit" / "HA LiveKit"
        self.settings_source = (
            root / "Views" / "Screens" / "SettingsView.swift"
        ).read_text(encoding="utf-8")
        self.app_model_source = (root / "App" / "AppModel.swift").read_text(
            encoding="utf-8"
        )
        self.sanitizer_source = (
            root / "Models" / "ConnectionConfiguration.swift"
        ).read_text(encoding="utf-8")

    def test_support_email_is_opt_in_and_never_attaches_existing_diagnostics(self) -> None:
        self.assertIn(
            "@State private var sendSupportLogs = false", self.settings_source
        )
        self.assertIn('let email = "support@efeer.im"', self.settings_source)
        self.assertIn(
            "Data(appModel.privacySafeSupportLogsText.utf8)", self.settings_source
        )

        support_email_block = self.settings_source.split(
            "private func openSupportEmail()", 1
        )[1].split("private struct SupportMailDraft", 1)[0]
        self.assertNotIn("diagnosticsText", support_email_block)
        self.assertNotIn("redactedDebugLogsText", support_email_block)
        self.assertNotIn("Locale.current", support_email_block)
        self.assertIn("guard !sendSupportLogs else", support_email_block)
        self.assertLess(
            support_email_block.index("guard !sendSupportLogs else"),
            support_email_block.index("var components = URLComponents()"),
        )
        self.assertIn("result == .failed || error != nil", self.settings_source)

    def test_support_export_uses_fixed_summaries_without_timestamps(self) -> None:
        support_log_block = self.app_model_source.split(
            "var privacySafeSupportLogsText: String", 1
        )[1].split("var redactedHomeAssistantInstanceID", 1)[0]
        self.assertIn(
            "LogSanitizer.privacySafeSupportEventSummary", support_log_block
        )
        self.assertNotIn("entry.formattedLine", support_log_block)
        self.assertNotIn("entry.timestamp", support_log_block)

        support_summary_block = self.sanitizer_source.split(
            "static func privacySafeSupportEventSummary", 1
        )[1].split("static func summarizeNetworkResponse", 1)[0]
        self.assertIn(
            'return "\\(category): \\(outcome)\\(statusSuffix)"',
            support_summary_block,
        )
        self.assertNotIn("return sanitized", support_summary_block)
        self.assertNotIn("return message", support_summary_block)
        self.assertIn(
            '"home assistant secure relay pairing was not completed:"',
            self.sanitizer_source,
        )
        self.assertNotIn('normalized.contains(" not ")', self.sanitizer_source)
        self.assertNotIn('normalized.contains("missing")', self.sanitizer_source)


if __name__ == "__main__":
    unittest.main()
