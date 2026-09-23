import Foundation

struct ManagedRelayConfig: Equatable {
    var managedRelayBaseURLString: String
    var appRegistrationKey: String
    var environment: APNsRelayMode

    static let current = ManagedRelayConfig(bundle: .main)

    init(bundle: Bundle) {
        let info = bundle.infoDictionary ?? [:]
        self.managedRelayBaseURLString = Self.clean(info["HALiveKitManagedRelayURL"] as? String)
        self.appRegistrationKey = Self.clean(info["HALiveKitManagedRelayAppKey"] as? String)
        self.environment = Self.environment(from: info["HALiveKitRelayEnvironment"] as? String)
    }

    init(
        managedRelayBaseURLString: String,
        appRegistrationKey: String,
        environment: APNsRelayMode
    ) {
        self.managedRelayBaseURLString = Self.clean(managedRelayBaseURLString)
        self.appRegistrationKey = Self.clean(appRegistrationKey)
        self.environment = environment == .production ? .production : .sandbox
    }

    var managedRelayBaseURL: URL? {
        let trimmed = managedRelayBaseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host?.isEmpty == false
        else {
            return nil
        }
        return url
    }

    var hasManagedRelayURL: Bool {
        managedRelayBaseURL != nil
    }

    var hasAppRegistrationKey: Bool {
        !appRegistrationKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var isManagedRelayAvailable: Bool {
        hasManagedRelayURL && hasAppRegistrationKey
    }

    var redactedManagedRelayURL: String {
        guard let managedRelayBaseURL else { return "Not configured in this build" }
        return LogSanitizer.redactedURLString(managedRelayBaseURL, includePath: true)
    }

    private static func environment(from value: String?) -> APNsRelayMode {
        let normalized = clean(value).lowercased()
        return APNsRelayMode(rawValue: normalized) == .production ? .production : .sandbox
    }

    private static func clean(_ value: String?) -> String {
        guard let value else { return "" }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("$(") || trimmed == "<null>" {
            return ""
        }
        return trimmed
    }
}
