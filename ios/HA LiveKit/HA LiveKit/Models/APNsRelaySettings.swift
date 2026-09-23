import Foundation
import Security

enum APNsRelayMode: String, CaseIterable, Codable, Identifiable {
    case disabled
    case sandbox
    case production

    var id: String { rawValue }

    var title: String {
        switch self {
        case .disabled: L10n.string("Disabled")
        case .sandbox: L10n.string("Sandbox")
        case .production: L10n.string("Production")
        }
    }
}

struct APNsRelaySettings: Equatable {
    var useManagedRelay: Bool
    var relayURLString: String
    var registrationSecret: String
    var sharedSecret: String
    var mode: APNsRelayMode

    static let disabled = APNsRelaySettings(
        useManagedRelay: true,
        relayURLString: "",
        registrationSecret: "",
        sharedSecret: "",
        mode: .disabled
    )

    static var defaultSettings: APNsRelaySettings {
        APNsRelaySettings(
            useManagedRelay: true,
            relayURLString: "",
            registrationSecret: "",
            sharedSecret: "",
            mode: ManagedRelayConfig.current.environment
        )
    }

    var customRelayURL: URL? {
        let trimmed = relayURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host?.isEmpty == false
        else {
            return nil
        }
        return url
    }

    var relayURL: URL? {
        useManagedRelay ? ManagedRelayConfig.current.managedRelayBaseURL : customRelayURL
    }

    var effectiveRegistrationSecret: String {
        useManagedRelay
            ? ManagedRelayConfig.current.appRegistrationKey.trimmingCharacters(in: .whitespacesAndNewlines)
            : registrationSecret.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var effectiveMode: APNsRelayMode {
        mode == .disabled ? .disabled : (useManagedRelay ? ManagedRelayConfig.current.environment : mode)
    }

    var hasRelayURL: Bool {
        relayURL != nil
    }

    var hasRegistrationSecret: Bool {
        !effectiveRegistrationSecret.isEmpty
    }

    var isRegistrationReady: Bool {
        guard effectiveMode != .disabled, hasRelayURL else { return false }
        return useManagedRelay || hasRegistrationSecret
    }

    var relaySourceTitle: String {
        useManagedRelay ? L10n.string("Managed Relay") : L10n.string("Custom Relay")
    }

    var relayConfigurationIssue: String? {
        if effectiveMode == .disabled {
            return L10n.string("Background relay is turned off.")
        }
        if useManagedRelay {
            if !ManagedRelayConfig.current.hasManagedRelayURL {
                return L10n.string("Please update HA LiveKit and open the app once after updating.")
            }
            return nil
        }
        if !hasRelayURL {
            return L10n.string("Custom relay URL missing.")
        }
        if !hasRegistrationSecret {
            return L10n.string("Registration secret missing.")
        }
        return nil
    }

    var redactedRelayURL: String {
        guard let relayURL else { return L10n.string("Not configured") }
        let host = relayURL.host(percentEncoded: false) ?? relayURL.absoluteString
        let path = relayURL.path == "/" ? "" : relayURL.path
        return "\(relayURL.scheme ?? "https")://\(host)\(path)"
    }
}

struct ManagedRelayCredential: Equatable {
    var relayURLString: String
    var relaySharedSecret: String
    var relayAppRegistrationSecret: String
    var environment: APNsRelayMode
    var homeAssistantInstanceID: String
    var localHomeAssistantInstanceID: String
}

struct ManagedRelayPairingRequest: Equatable {
    var homeAssistantInstanceID: String
    var deviceID: String
    var pushToStartToken: String
    var environment: APNsRelayMode
    var bundleIdentifier: String
    var appVersion: String
}

struct ManagedRelayPairingGrant: Equatable, Decodable {
    var ok: Bool
    var authenticationProtocol: String
    var pairingToken: String
    var expiresIn: Int
    var relayURLString: String
    var homeAssistantInstanceID: String
    var deviceID: String
    var environment: String
    var statusCode: Int = 200

    enum CodingKeys: String, CodingKey {
        case ok
        case authenticationProtocol = "auth_protocol"
        case pairingToken = "pairing_token"
        case expiresIn = "expires_in"
        case relayURLString = "relay_url"
        case homeAssistantInstanceID = "home_assistant_instance_id"
        case deviceID = "device_id"
        case environment = "apns_environment"
    }
}

struct ManagedRelayDevice: Equatable, Decodable, Identifiable {
    var deviceID: String
    var friendlyDeviceName: String?
    var authenticationProtocol: String
    var authenticationGeneration: Int
    var appVersion: String?
    var updatedAt: String?

    var id: String { deviceID }

    enum CodingKeys: String, CodingKey {
        case deviceID = "device_id"
        case friendlyDeviceName = "friendly_device_name"
        case authenticationProtocol = "auth_protocol"
        case authenticationGeneration = "auth_generation"
        case appVersion = "app_version"
        case updatedAt = "updated_at"
    }
}

struct ManagedRelayDeviceInventory: Decodable {
    var ok: Bool
    var devices: [ManagedRelayDevice]
}

enum ManagedRelayPairingError: LocalizedError {
    case unavailable(String, homeAssistantInstanceID: String?)
    case administratorRequired
    case rejected(Int, String)
    case invalidResponse

    var isV2Unavailable: Bool {
        if case .unavailable = self { return true }
        return false
    }

    var recoveryInstanceID: String? {
        if case .unavailable(_, let homeAssistantInstanceID) = self {
            return homeAssistantInstanceID
        }
        return nil
    }

    var errorDescription: String? {
        switch self {
        case .unavailable(let message, _), .rejected(_, let message):
            message
        case .administratorRequired:
            L10n.string("Secure relay pairing requires a Home Assistant administrator account.")
        case .invalidResponse:
            L10n.string("Home Assistant returned an invalid secure pairing response.")
        }
    }
}

enum RelayAuthenticationProtocol: String, Equatable {
    case none
    case legacyV1 = "v1"
    case deviceV2 = "v2"

    var title: String {
        switch self {
        case .none: L10n.string("Not registered")
        case .legacyV1: L10n.string("Legacy compatibility")
        case .deviceV2: L10n.string("Device credential")
        }
    }
}

enum RelayPairingTicketStatus: String, Equatable {
    case notRequested = "not_requested"
    case requesting
    case authorized
    case administratorRequired = "administrator_required"
    case unavailable
    case failed
}

enum BackgroundLiveActivitiesStatus: Equatable {
    case ready
    case needsNotificationPermission
    case setupNeeded
    case notificationsDisabled
    case liveActivitiesDisabled
    case relayNotReady
    case error

    var title: String {
        switch self {
        case .ready: L10n.string("Ready")
        case .needsNotificationPermission: L10n.string("Needs Notification Permission")
        case .setupNeeded: L10n.string("Setup Needed")
        case .notificationsDisabled: L10n.string("Notifications Disabled")
        case .liveActivitiesDisabled: L10n.string("Live Activities Disabled")
        case .relayNotReady: L10n.string("Relay Not Ready")
        case .error: L10n.string("Error")
        }
    }

    var message: String {
        switch self {
        case .ready:
            L10n.string("Background Live Activities are ready. Home Assistant can start Live Activities even when the app is closed.")
        case .needsNotificationPermission:
            L10n.string("Allow notifications to enable background Live Activities.")
        case .setupNeeded:
            L10n.string("Open the app once after updating, then check that Notifications and Live Activities are enabled.")
        case .notificationsDisabled:
            L10n.string("Allow notifications to enable background Live Activities.")
        case .liveActivitiesDisabled:
            L10n.string("Enable Live Activities for HA LiveKit in iOS Settings.")
        case .relayNotReady:
            L10n.string("Please update the Home Assistant integration, restart Home Assistant, then open HA LiveKit once.")
        case .error:
            L10n.string("Background updates need Notifications and Live Activities enabled. Foreground Home Assistant updates still work.")
        }
    }
}

struct BackgroundSetupCheck: Identifiable, Equatable {
    var id: String
    var title: String
    var status: String
    var isPassing: Bool
    var detail: String?
}

struct APNsRelayDiagnostics: Equatable {
    var isObservingPushToStartToken: Bool
    var pushToStartTokenAvailable: Bool
    var redactedPushToStartToken: String?
    var lastPushToStartTokenUpdateAt: Date?
    var lastActivityTokenUpdateAt: Date?
    var relayRegistered: Bool
    var lastRegistrationAttemptAt: Date?
    var lastRegistrationStatusCode: Int?
    var lastRegistrationResponseSummary: String?
    var lastRegistrationError: String?
    var registrationEnvironmentMismatch: Bool
    var lastHealthCheckedAt: Date?
    var lastHealthStatusCode: Int?
    var lastHealthResponseSummary: String?
    var lastHealthError: String?
    var lastAPNsAttemptAt: Date?
    var lastAPNsStatusCode: Int?
    var lastAPNsResponseSummary: String?
    var lastAPNSError: String?
    var mode: APNsRelayMode
    var authenticationProtocol: RelayAuthenticationProtocol
    var homeAssistantPairingTicketStatus: RelayPairingTicketStatus
    var workerDeviceCredentialAvailable: Bool

    static let disabled = APNsRelayDiagnostics(
        isObservingPushToStartToken: false,
        pushToStartTokenAvailable: false,
        redactedPushToStartToken: nil,
        lastPushToStartTokenUpdateAt: nil,
        lastActivityTokenUpdateAt: nil,
        relayRegistered: false,
        lastRegistrationAttemptAt: nil,
        lastRegistrationStatusCode: nil,
        lastRegistrationResponseSummary: nil,
        lastRegistrationError: nil,
        registrationEnvironmentMismatch: false,
        lastHealthCheckedAt: nil,
        lastHealthStatusCode: nil,
        lastHealthResponseSummary: nil,
        lastHealthError: nil,
        lastAPNsAttemptAt: nil,
        lastAPNsStatusCode: nil,
        lastAPNsResponseSummary: nil,
        lastAPNSError: nil,
        mode: .disabled,
        authenticationProtocol: .none,
        homeAssistantPairingTicketStatus: .notRequested,
        workerDeviceCredentialAvailable: false
    )
}

final class APNsRelaySettingsStore {
    private let defaults: UserDefaults
    private let service = "com.halivekit.apns-relay"
    private let secretAccount = "registration-secret"
    private let sharedSecretAccount = "shared-secret"
    private let useManagedRelayKey = "apnsRelayUseManagedRelay"
    private let urlKey = "apnsRelayURL"
    private let modeKey = "apnsRelayMode"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> APNsRelaySettings {
        let defaultMode = ManagedRelayConfig.current.environment
        let modeValue = defaults.string(forKey: modeKey) ?? defaultMode.rawValue
        let mode = APNsRelayMode(rawValue: modeValue) ?? defaultMode
        let url = defaults.string(forKey: urlKey) ?? ""
        let secret = (try? loadSecret(account: secretAccount)) ?? ""
        let sharedSecret = (try? loadSecret(account: sharedSecretAccount)) ?? ""
        let useManagedRelay = ManagedRelayConfig.current.isManagedRelayAvailable
            ? true
            : (defaults.object(forKey: useManagedRelayKey) as? Bool
                ?? (url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && secret.isEmpty))

        return APNsRelaySettings(
            useManagedRelay: useManagedRelay,
            relayURLString: url,
            registrationSecret: secret,
            sharedSecret: sharedSecret,
            mode: mode
        )
    }

    func save(_ settings: APNsRelaySettings) throws {
        defaults.set(settings.relayURLString.trimmingCharacters(in: .whitespacesAndNewlines), forKey: urlKey)
        defaults.set(settings.mode.rawValue, forKey: modeKey)
        defaults.set(settings.useManagedRelay, forKey: useManagedRelayKey)

        let secret = settings.registrationSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        if secret.isEmpty {
            try clearSecret(account: secretAccount)
        } else {
            try saveSecret(secret, account: secretAccount)
        }

        let sharedSecret = settings.sharedSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        if sharedSecret.isEmpty {
            try clearSecret(account: sharedSecretAccount)
        } else {
            try saveSecret(sharedSecret, account: sharedSecretAccount)
        }
    }

    private func saveSecret(_ secret: String, account: String) throws {
        guard let data = secret.data(using: .utf8) else {
            throw HALiveKitError.invalidResponse
        }

        var query = secretQuery(account: account)
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw HALiveKitError.keychain(status)
        }
    }

    private func loadSecret(account: String) throws -> String? {
        var query = secretQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }

        guard status == errSecSuccess else {
            throw HALiveKitError.keychain(status)
        }

        guard let data = result as? Data,
              let secret = String(data: data, encoding: .utf8)
        else {
            throw HALiveKitError.invalidResponse
        }

        return secret
    }

    private func clearSecret(account: String) throws {
        let status = SecItemDelete(secretQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw HALiveKitError.keychain(status)
        }
    }

    private func secretQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}
