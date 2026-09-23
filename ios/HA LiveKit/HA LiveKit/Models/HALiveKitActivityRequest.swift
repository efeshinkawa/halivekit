import Foundation

struct HALiveKitActivityRequest {
    enum Action {
        case start
        case update
        case end

        init?(homeAssistantValue: String) {
            switch homeAssistantValue.normalizedHAIdentifier {
            case "start", "set_activity", "start_activity", "start_entity_activity":
                self = .start
            case "update", "update_activity", "update_entity_activity":
                self = .update
            case "end", "end_activity":
                self = .end
            default:
                return nil
            }
        }
    }

    var action: Action
    var deviceId: String?
    var activityId: String
    var title: String?
    var subtitle: String?
    var displayName: String?
    var entityId: String?
    var template: HALiveActivityTemplateKind?
    var state: String?
    var progress: Double?
    var reason: String?
    var allowsEntityControl: Bool?
    var data: [String: Any]

    init?(dictionary: [String: Any]) {
        guard let actionValue = dictionary["action"] as? String,
              let action = Action(homeAssistantValue: actionValue),
              let activityId = dictionary["activity_id"] as? String,
              !activityId.isEmpty
        else {
            return nil
        }

        let data = dictionary["data"] as? [String: Any] ?? [:]
        self.action = action
        self.deviceId = dictionary["device_id"] as? String
        self.activityId = activityId
        self.title = dictionary["title"] as? String
        self.subtitle = dictionary["subtitle"] as? String
        self.displayName = dictionary["display_name"] as? String ?? dictionary["displayName"] as? String
        self.entityId = dictionary["entity_id"] as? String
        self.template = HALiveActivityTemplateKind(homeAssistantValue: dictionary["template"] as? String)
        self.state = dictionary["state"] as? String ?? data["primary_state"] as? String ?? data["primaryState"] as? String
        self.progress = Self.doubleValue(dictionary["progress"] ?? data["progress"])
        self.reason = dictionary["reason"] as? String
        self.allowsEntityControl = dictionary["allow_entity_control"] as? Bool
        self.data = data
    }

    var isEntityBased: Bool {
        if let value = data["entity_based"] as? Bool {
            return value
        }
        if let value = data["entityBased"] as? Bool {
            return value
        }
        if requestedString("source") == "home_assistant_entity" {
            return true
        }
        return requestedString("source_service")?.contains("entity_activity") == true
    }

    var requestedDisplayStyle: HALiveActivityDisplayStyle {
        if let raw = data["displayStyle"] as? String ?? data["display_style"] as? String {
            return HALiveActivityDisplayStyle(homeAssistantValue: raw) ?? template?.displayStyle ?? .compactStatus
        }
        return template?.displayStyle ?? .compactStatus
    }

    var requestedTheme: HALiveActivityTheme {
        guard let raw = data["theme"] as? String else { return .homeAssistant }
        return HALiveActivityTheme(homeAssistantValue: raw) ?? .homeAssistant
    }

    var requestedIconName: String? {
        data["iconName"] as? String ?? data["icon_name"] as? String
    }

    var requestedSecondaryState: String? {
        data["secondaryState"] as? String ?? data["secondary_state"] as? String
    }

    var requestedUnit: String? {
        data["unit"] as? String
    }

    var requestedUnitOfMeasurement: String? {
        requestedString("unit_of_measurement") ?? requestedString("unitOfMeasurement")
    }

    var requestedValue: String? {
        requestedString("value")
    }

    var requestedRawState: String? {
        requestedString("raw_state") ?? requestedString("rawState")
    }

    var requestedFriendlyName: String? {
        requestedString("friendly_name") ?? requestedString("friendlyName")
    }

    var requestedProgressEntityID: String? {
        requestedString("progress_entity_id") ?? requestedString("progressEntityId")
    }

    var requestedDeviceClass: String? {
        requestedString("device_class") ?? requestedString("deviceClass")
    }

    var requestedBatteryLevel: Double? {
        requestedDouble("battery_level") ?? requestedDouble("batteryLevel")
    }

    var requestedCurrentTemperature: Double? {
        requestedDouble("current_temperature") ?? requestedDouble("currentTemperature")
    }

    var requestedTargetTemperature: Double? {
        requestedDouble("target_temperature") ?? requestedDouble("targetTemperature") ?? requestedDouble("temperature")
    }

    var requestedHVACMode: String? {
        requestedString("hvac_mode") ?? requestedString("hvacMode")
    }

    var requestedBrightness: Double? {
        requestedDouble("brightness")
    }

    var requestedCurrentPosition: Double? {
        requestedDouble("current_position") ?? requestedDouble("currentPosition")
    }

    var requestedAttributeProgress: Double? {
        requestedDouble("attribute_progress") ?? requestedDouble("attributeProgress")
    }

    var requestedPercentage: Double? {
        requestedDouble("percentage")
    }

    var requestedRemaining: String? {
        requestedString("remaining")
    }

    var requestedRemainingTime: String? {
        requestedString("remaining_time") ?? requestedString("remainingTime")
    }

    var requestedRoom: String? {
        requestedString("room")
    }

    var requestedStatus: String? {
        requestedString("status")
    }

    private func requestedString(_ key: String) -> String? {
        guard let value = data[key] else { return nil }
        let string = String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
        return string.isEmpty ? nil : string
    }

    private func requestedDouble(_ key: String) -> Double? {
        Self.doubleValue(data[key])
    }

    private static func doubleValue(_ value: Any?) -> Double? {
        if let double = value as? Double { return double }
        if let int = value as? Int { return Double(int) }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

extension HALiveActivityTemplateKind {
    init?(homeAssistantValue: String?) {
        guard let normalized = homeAssistantValue?.normalizedHAIdentifier else {
            return nil
        }

        switch normalized {
        case "custom": self = .custom
        case "progress": self = .progress
        case "washingmachine", "washing_machine", "laundry": self = .washingMachine
        case "dishwasher": self = .dishwasher
        case "vacuum": self = .vacuum
        case "security", "door", "doorsecurity", "door_security": self = .security
        case "climate": self = .climate
        case "energy", "plug", "energyplug", "energy_plug": self = .energy
        case "timer": self = .timer
        default: return nil
        }
    }
}

extension HALiveActivityDisplayStyle {
    init?(homeAssistantValue: String?) {
        guard let normalized = homeAssistantValue?.normalizedHAIdentifier else {
            return nil
        }

        switch normalized {
        case "compactstatus", "compact_status": self = .compactStatus
        case "progress": self = .progress
        case "timer": self = .timer
        case "security": self = .security
        case "energy": self = .energy
        case "vacuum": self = .vacuum
        case "climate": self = .climate
        case "doorwindow", "door_window": self = .doorWindow
        default: return nil
        }
    }
}

extension HALiveActivityTheme {
    init?(homeAssistantValue: String?) {
        guard let normalized = homeAssistantValue?.normalizedHAIdentifier else {
            return nil
        }

        switch normalized {
        case "homeassistant", "home_assistant": self = .homeAssistant
        case "ocean": self = .ocean
        case "mint": self = .mint
        case "amber": self = .amber
        case "rose": self = .rose
        case "graphite": self = .graphite
        default: return nil
        }
    }
}

private extension String {
    var normalizedHAIdentifier: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")
            .replacingOccurrences(of: " ", with: "_")
    }
}
