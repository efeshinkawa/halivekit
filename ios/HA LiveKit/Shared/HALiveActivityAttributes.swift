import ActivityKit
import Foundation

struct HALiveActivityAttributes: ActivityAttributes, Codable, Hashable {
    struct ContentState: Codable, Hashable {
        var title: String
        var subtitle: String
        var displayName: String?
        var entityId: String
        var primaryState: String
        var secondaryState: String?
        var progress: Double?
        var value: String?
        var unit: String?
        var iconName: String
        var theme: HALiveActivityTheme
        var displayStyle: HALiveActivityDisplayStyle
        var lastUpdated: Date

        enum CodingKeys: String, CodingKey {
            case title
            case subtitle
            case displayName
            case entityId
            case primaryState
            case secondaryState
            case progress
            case value
            case unit
            case iconName
            case theme
            case displayStyle
            case lastUpdated
        }
    }

    var activityId: String
    var primaryEntityId: String
    var secondaryEntityId: String?
    var template: HALiveActivityTemplateKind
    /// Immutable tenant origin for every Home Assistant-backed activity.
    /// Optional keeps activities created by older app/relay versions decodable.
    /// No URL, token, or other credential is stored in ActivityKit attributes.
    let homeAssistantInstanceId: String?
    /// Opt-in flag for idempotent On/Off controls bound to the primary entity.
    /// Optional keeps activities created by older app and integration versions decodable.
    var allowsEntityControl: Bool? = nil
    /// Device-local Home Assistant identity that granted the control opt-in.
    /// No URL, token, or other credential is stored in ActivityKit attributes.
    var entityControlHomeAssistantInstanceId: String? = nil

    var isEntityControlEnabled: Bool {
        allowsEntityControl == true
            && entityControlHomeAssistantInstanceId?.isEmpty == false
    }

    enum CodingKeys: String, CodingKey {
        case activityId
        case primaryEntityId
        case secondaryEntityId
        case template
        case homeAssistantInstanceId
        case allowsEntityControl
        case entityControlHomeAssistantInstanceId
    }

    init(
        activityId: String,
        primaryEntityId: String,
        secondaryEntityId: String?,
        template: HALiveActivityTemplateKind,
        homeAssistantInstanceId: String? = nil,
        allowsEntityControl: Bool? = nil,
        entityControlHomeAssistantInstanceId: String? = nil
    ) {
        self.activityId = activityId
        self.primaryEntityId = primaryEntityId
        self.secondaryEntityId = secondaryEntityId
        self.template = template
        self.homeAssistantInstanceId = homeAssistantInstanceId
        self.allowsEntityControl = allowsEntityControl
        self.entityControlHomeAssistantInstanceId = entityControlHomeAssistantInstanceId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        activityId = try container.decode(String.self, forKey: .activityId)
        primaryEntityId = try container.decode(String.self, forKey: .primaryEntityId)
        secondaryEntityId = try container.decodeIfPresent(
            String.self,
            forKey: .secondaryEntityId
        )
        template = try container.decode(
            HALiveActivityTemplateKind.self,
            forKey: .template
        )
        homeAssistantInstanceId = try container.decodeIfPresent(
            String.self,
            forKey: .homeAssistantInstanceId
        )
        allowsEntityControl = try container.decodeIfPresent(
            Bool.self,
            forKey: .allowsEntityControl
        )
        entityControlHomeAssistantInstanceId = try container.decodeIfPresent(
            String.self,
            forKey: .entityControlHomeAssistantInstanceId
        )
    }
}

enum HALiveActivityDisplayStyle: String, CaseIterable, Codable, Hashable, Identifiable {
    case compactStatus
    case progress
    case timer
    case security
    case energy
    case vacuum
    case climate
    case doorWindow

    var id: String { rawValue }

    var title: String {
        switch self {
        case .compactStatus: L10n.string("Compact Status")
        case .progress: L10n.string("Progress")
        case .timer: L10n.string("Timer")
        case .security: L10n.string("Security")
        case .energy: L10n.string("Energy")
        case .vacuum: L10n.string("Vacuum")
        case .climate: L10n.string("Climate")
        case .doorWindow: L10n.string("Door / Window")
        }
    }

    var defaultIcon: String {
        switch self {
        case .compactStatus: "dot.radiowaves.left.and.right"
        case .progress: "progress.indicator"
        case .timer: "timer"
        case .security: "lock.shield"
        case .energy: "bolt.fill"
        case .vacuum: "sparkles"
        case .climate: "thermometer.medium"
        case .doorWindow: "door.left.hand.open"
        }
    }
}

enum HALiveActivityTheme: String, CaseIterable, Codable, Hashable, Identifiable {
    case homeAssistant
    case ocean
    case mint
    case amber
    case rose
    case graphite

    var id: String { rawValue }

    var title: String {
        switch self {
        case .homeAssistant: L10n.string("Home Assistant")
        case .ocean: L10n.string("Ocean")
        case .mint: L10n.string("Mint")
        case .amber: L10n.string("Amber")
        case .rose: L10n.string("Rose")
        case .graphite: L10n.string("Graphite")
        }
    }
}

enum HALiveActivityTemplateKind: String, CaseIterable, Codable, Hashable, Identifiable {
    case custom
    case progress
    case washingMachine
    case dishwasher
    case vacuum
    case security
    case climate
    case energy
    case timer

    var id: String { rawValue }

    var title: String {
        switch self {
        case .custom: L10n.string("Custom")
        case .progress: L10n.string("Progress")
        case .washingMachine: L10n.string("Washing Machine")
        case .dishwasher: L10n.string("Dishwasher")
        case .vacuum: L10n.string("Vacuum Cleaner")
        case .security: L10n.string("Door / Security")
        case .climate: L10n.string("Climate")
        case .energy: L10n.string("Energy / Plug")
        case .timer: L10n.string("Timer")
        }
    }

    var displayStyle: HALiveActivityDisplayStyle {
        switch self {
        case .custom: .compactStatus
        case .progress: .progress
        case .washingMachine, .dishwasher: .progress
        case .vacuum: .vacuum
        case .security: .security
        case .climate: .climate
        case .energy: .energy
        case .timer: .timer
        }
    }
}
