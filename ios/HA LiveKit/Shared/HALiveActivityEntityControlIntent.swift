import AppIntents

enum HALiveActivityEntityControlAction: String, AppEnum, Sendable {
    case turnOn
    case turnOff

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Live Activity Control Action")

    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .turnOn: "Turn On",
        .turnOff: "Turn Off"
    ]

    var homeAssistantService: String {
        switch self {
        case .turnOn: "turn_on"
        case .turnOff: "turn_off"
        }
    }

    var resultingState: String {
        switch self {
        case .turnOn: "on"
        case .turnOff: "off"
        }
    }
}

/// A deliberately narrow, non-discoverable intent used only by buttons that
/// belong to an explicitly opted-in Live Activity.
struct HALiveActivityEntityControlIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Control Live Activity Entity"
    static var description = IntentDescription("Turn the opted-in Home Assistant entity on or off from a Live Activity.")
    static var openAppWhenRun = false
    static var isDiscoverable = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "Activity ID")
    var activityID: String

    @Parameter(title: "Entity ID")
    var entityID: String

    @Parameter(title: "Action")
    var action: HALiveActivityEntityControlAction

    init() {
        activityID = ""
        entityID = ""
        action = .turnOn
    }

    init(
        activityID: String,
        entityID: String,
        action: HALiveActivityEntityControlAction
    ) {
        self.activityID = activityID
        self.entityID = entityID
        self.action = action
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
#if HALIVEKIT_WIDGET_EXTENSION
        // WidgetKit normally executes a LiveActivityIntent in the containing
        // app process. If this extension-side implementation is ever invoked,
        // it must not attempt credentials or network access.
        return .result(dialog: "This control is unavailable right now.")
#else
        let message = await LiveActivityEntityControlService().execute(
            activityID: activityID,
            entityID: entityID,
            action: action
        )
        return .result(dialog: "\(message)")
#endif
    }
}
