import Foundation

struct HAEntity: Identifiable, Codable, Hashable {
    var entityId: String
    var state: String
    var attributes: HAEntityAttributes
    var lastChanged: Date
    var lastUpdated: Date?

    var id: String { entityId }

    var domain: HAEntityDomain {
        HAEntityDomain(rawValue: String(entityId.split(separator: ".").first ?? "")) ?? .other
    }

    var friendlyName: String {
        attributes.friendlyName ?? entityId
    }

    var displayUnit: String? {
        attributes.unitOfMeasurement
    }

    var suggestedIconName: String {
        if let mappedIcon = Self.sfSymbolName(forHomeAssistantIcon: attributes.icon) {
            return mappedIcon
        }

        if let deviceClass = attributes.deviceClass {
            switch (domain, deviceClass) {
            case (.sensor, "power"): return "bolt.fill"
            case (.sensor, "energy"): return "chart.bar.fill"
            case (.sensor, "temperature"): return "thermometer.medium"
            case (.sensor, "humidity"): return "humidity.fill"
            case (.sensor, "battery"): return "battery.75percent"
            case (.sensor, "duration"): return "timer"
            case (.sensor, "monetary"): return "banknote.fill"
            case (.binarySensor, "door"), (.binarySensor, "garage_door"): return state == "on" ? "door.left.hand.open" : "door.left.hand.closed"
            case (.binarySensor, "window"): return state == "on" ? "window.vertical.open" : "window.vertical.closed"
            case (.binarySensor, "motion"): return "figure.walk.motion"
            case (.binarySensor, "moisture"): return "drop.fill"
            case (.binarySensor, "smoke"): return "smoke.fill"
            case (.binarySensor, "occupancy"), (.binarySensor, "presence"): return "person.fill.checkmark"
            case (.binarySensor, "lock"): return state == "on" ? "lock.open.fill" : "lock.fill"
            case (.binarySensor, "opening"): return state == "on" ? "rectangle.portrait.and.arrow.right" : "rectangle.portrait"
            default: break
            }
        }

        switch domain {
        case .sensor:
            if displayUnit == "W" || displayUnit == "kW" { return "bolt.fill" }
            if displayUnit == "kWh" { return "chart.bar.fill" }
            if displayUnit == "%" { return "percent" }
            return domain.iconName
        case .binarySensor:
            return state == "on" ? "circle.fill" : "circle"
        case .switch:
            return state == "on" ? "switch.2" : "power"
        case .light:
            return state == "on" ? "lightbulb.fill" : "lightbulb"
        case .climate:
            return "thermometer.medium"
        case .lock:
            return state == "unlocked" ? "lock.open.fill" : "lock.fill"
        case .cover:
            return "blinds.horizontal.closed"
        case .vacuum:
            return "sparkles"
        case .mediaPlayer:
            return "play.rectangle.fill"
        case .timer:
            return "timer"
        case .inputBoolean:
            return state == "on" ? "checkmark.circle.fill" : "circle"
        case .other:
            return domain.iconName
        }
    }

    private static func sfSymbolName(forHomeAssistantIcon icon: String?) -> String? {
        guard let icon else { return nil }
        let normalized = icon
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "mdi:", with: "")
            .replacingOccurrences(of: "-", with: "_")
            .lowercased()
        guard !normalized.isEmpty else { return nil }

        let mapping = [
            "lightbulb": "lightbulb.fill",
            "lightbulb_on": "lightbulb.fill",
            "power_plug": "powerplug.fill",
            "power_socket": "powerplug.fill",
            "door": "door.left.hand.closed",
            "door_open": "door.left.hand.open",
            "window_closed": "window.vertical.closed",
            "window_open": "window.vertical.open",
            "washing_machine": "washer.fill",
            "dishwasher": "dishwasher.fill",
            "robot_vacuum": "sparkles",
            "vacuum": "sparkles",
            "thermometer": "thermometer.medium",
            "lightning_bolt": "bolt.fill",
            "flash": "bolt.fill",
            "battery": "battery.75percent",
            "lock": "lock.fill",
            "lock_open": "lock.open.fill",
            "garage": "door.garage.closed",
            "garage_open": "door.garage.open"
        ]
        return mapping[normalized]
    }

    enum CodingKeys: String, CodingKey {
        case entityId = "entity_id"
        case state
        case attributes
        case lastChanged = "last_changed"
        case lastUpdated = "last_updated"
    }
}

struct HAEntityAttributes: Codable, Hashable {
    var friendlyName: String?
    var icon: String?
    var unitOfMeasurement: String?
    var deviceClass: String?
    var batteryLevel: Double?
    var currentTemperature: Double?
    var temperature: Double?
    var hvacMode: String?
    var brightness: Double?
    var currentPosition: Double?
    var progress: Double?
    var percentage: Double?
    var remaining: String?
    var remainingTime: String?
    var room: String?
    var status: String?

    init(
        friendlyName: String? = nil,
        icon: String? = nil,
        unitOfMeasurement: String? = nil,
        deviceClass: String? = nil,
        batteryLevel: Double? = nil,
        currentTemperature: Double? = nil,
        temperature: Double? = nil,
        hvacMode: String? = nil,
        brightness: Double? = nil,
        currentPosition: Double? = nil,
        progress: Double? = nil,
        percentage: Double? = nil,
        remaining: String? = nil,
        remainingTime: String? = nil,
        room: String? = nil,
        status: String? = nil
    ) {
        self.friendlyName = friendlyName
        self.icon = icon
        self.unitOfMeasurement = unitOfMeasurement
        self.deviceClass = deviceClass
        self.batteryLevel = batteryLevel
        self.currentTemperature = currentTemperature
        self.temperature = temperature
        self.hvacMode = hvacMode
        self.brightness = brightness
        self.currentPosition = currentPosition
        self.progress = progress
        self.percentage = percentage
        self.remaining = remaining
        self.remainingTime = remainingTime
        self.room = room
        self.status = status
    }

    enum CodingKeys: String, CodingKey {
        case friendlyName = "friendly_name"
        case icon
        case unitOfMeasurement = "unit_of_measurement"
        case deviceClass = "device_class"
        case batteryLevel = "battery_level"
        case currentTemperature = "current_temperature"
        case temperature
        case hvacMode = "hvac_mode"
        case brightness
        case currentPosition = "current_position"
        case progress
        case percentage
        case remaining
        case remainingTime = "remaining_time"
        case room
        case status
    }
}

enum HAEntityDomain: String, CaseIterable, Codable, Identifiable {
    case sensor
    case binarySensor = "binary_sensor"
    case `switch`
    case light
    case climate
    case lock
    case cover
    case vacuum
    case mediaPlayer = "media_player"
    case timer
    case inputBoolean = "input_boolean"
    case other

    var id: String { rawValue }

    var title: String {
        switch self {
        case .sensor: "Sensor"
        case .binarySensor: "Binary Sensor"
        case .switch: "Switch"
        case .light: "Light"
        case .climate: "Climate"
        case .lock: "Lock"
        case .cover: "Cover"
        case .vacuum: "Vacuum"
        case .mediaPlayer: "Media Player"
        case .timer: "Timer"
        case .inputBoolean: "Input Boolean"
        case .other: "Other"
        }
    }

    var iconName: String {
        switch self {
        case .sensor: "sensor.tag.radiowaves.forward"
        case .binarySensor: "circle.lefthalf.filled"
        case .switch: "switch.2"
        case .light: "lightbulb.fill"
        case .climate: "thermometer.medium"
        case .lock: "lock.fill"
        case .cover: "rectangle.portrait.and.arrow.right"
        case .vacuum: "sparkles"
        case .mediaPlayer: "play.rectangle.fill"
        case .timer: "timer"
        case .inputBoolean: "togglepower"
        case .other: "square.grid.2x2"
        }
    }
}
