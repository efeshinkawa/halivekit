import Foundation

struct LiveActivityTemplate: Identifiable, Hashable {
    var id: HALiveActivityTemplateKind
    var title: String
    var subtitle: String
    var iconName: String
    var style: HALiveActivityDisplayStyle
    var theme: HALiveActivityTheme
    var preferredDomains: [HAEntityDomain]

    static let defaults: [LiveActivityTemplate] = [
        .init(
            id: .progress,
            title: L10n.string("Progress"),
            subtitle: L10n.string("Custom progress and status"),
            iconName: "progress.indicator",
            style: .progress,
            theme: .homeAssistant,
            preferredDomains: [.sensor, .timer]
        ),
        .init(
            id: .washingMachine,
            title: L10n.string("Laundry"),
            subtitle: L10n.string("Remaining time and run state"),
            iconName: "washer.fill",
            style: .progress,
            theme: .homeAssistant,
            preferredDomains: [.sensor, .binarySensor]
        ),
        .init(
            id: .dishwasher,
            title: L10n.string("Dishwasher"),
            subtitle: L10n.string("Cycle status and remaining time"),
            iconName: "dishwasher.fill",
            style: .progress,
            theme: .ocean,
            preferredDomains: [.sensor, .binarySensor]
        ),
        .init(
            id: .vacuum,
            title: L10n.string("Robot Vacuum"),
            subtitle: L10n.string("Cleaning status, room and battery"),
            iconName: "sparkles",
            style: .vacuum,
            theme: .mint,
            preferredDomains: [.vacuum, .sensor]
        ),
        .init(
            id: .security,
            title: L10n.string("Door Security"),
            subtitle: L10n.string("Open, closed and last change"),
            iconName: "lock.shield",
            style: .security,
            theme: .rose,
            preferredDomains: [.binarySensor, .lock]
        ),
        .init(
            id: .climate,
            title: L10n.string("Climate"),
            subtitle: L10n.string("Current and target temperature"),
            iconName: "thermometer.medium",
            style: .climate,
            theme: .ocean,
            preferredDomains: [.climate, .sensor]
        ),
        .init(
            id: .energy,
            title: L10n.string("Energy"),
            subtitle: L10n.string("Current watt and daily usage"),
            iconName: "bolt.fill",
            style: .energy,
            theme: .amber,
            preferredDomains: [.sensor, .switch]
        ),
        .init(
            id: .timer,
            title: L10n.string("Timer"),
            subtitle: L10n.string("Countdown state"),
            iconName: "timer",
            style: .timer,
            theme: .graphite,
            preferredDomains: [.timer, .sensor]
        ),
        .init(
            id: .custom,
            title: L10n.string("Custom"),
            subtitle: L10n.string("Flexible status for any supported entity"),
            iconName: "slider.horizontal.3",
            style: .compactStatus,
            theme: .homeAssistant,
            preferredDomains: [.sensor, .binarySensor, .switch, .light]
        )
    ]
}

struct LiveActivityDraft: Hashable {
    var activityId: String?
    var title: String
    var subtitle: String
    var displayName: String
    var primaryEntity: HAEntity
    var secondaryEntity: HAEntity?
    var displayStyle: HALiveActivityDisplayStyle
    var template: HALiveActivityTemplateKind
    var iconName: String
    var theme: HALiveActivityTheme
}

struct ActiveActivityRecord: Identifiable, Hashable {
    var id: String
    var activityKitId: String
    var title: String
    var subtitle: String
    var entityId: String
    var displayStyle: HALiveActivityDisplayStyle
    var theme: HALiveActivityTheme
    var lastState: HALiveActivityAttributes.ContentState
}
