import CryptoKit
import Foundation

struct ConnectionConfiguration: Codable, Hashable {
    var baseURL: URL
    var token: String
    var displayName: String?
    var internalURL: URL?
    var externalURL: URL?

    init(
        baseURL: URL,
        token: String,
        displayName: String? = nil,
        internalURL: URL? = nil,
        externalURL: URL? = nil
    ) {
        self.baseURL = baseURL
        self.token = token
        self.displayName = Self.normalizedDisplayName(displayName)
        self.internalURL = internalURL
        self.externalURL = externalURL
    }

    var instanceName: String {
        Self.normalizedDisplayName(displayName) ?? L10n.string("Home Assistant")
    }

    var displayHost: String {
        baseURL.host(percentEncoded: false) ?? baseURL.absoluteString
    }

    var redactedURLString: String {
        LogSanitizer.redactedURLString(baseURL)
    }

    var orderedCandidateURLs: [HomeAssistantURLCandidate] {
        var candidates: [HomeAssistantURLCandidate] = []
        if let internalURL {
            candidates.append(.init(role: .internalNetwork, url: internalURL))
        }
        if let externalURL {
            candidates.append(.init(role: .externalNetwork, url: externalURL))
        }
        if candidates.isEmpty {
            candidates.append(.init(role: .primary, url: baseURL))
        }
        return candidates
    }

    func variant(baseURL: URL) -> ConnectionConfiguration {
        var copy = self
        copy.baseURL = baseURL
        return copy
    }

    static func resolvedDisplayName(preferredName: String?, locationName: String?) -> String {
        normalizedDisplayName(preferredName)
            ?? normalizedDisplayName(locationName)
            ?? L10n.string("Home Assistant")
    }

    private static func normalizedDisplayName(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

struct HomeAssistantURLCandidate: Hashable {
    enum Role: String, Hashable {
        case primary
        case internalNetwork
        case externalNetwork
    }

    var role: Role
    var url: URL
}

struct HAConfig: Decodable, Hashable {
    var locationName: String?
    var externalURL: String?
    var internalURL: String?
    var timeZone: String?

    enum CodingKeys: String, CodingKey {
        case locationName = "location_name"
        case externalURL = "external_url"
        case internalURL = "internal_url"
        case timeZone = "time_zone"
    }
}

enum HomeAssistantInstanceIdentity {
    private static let defaultsKeyPrefix = "haLiveKitHomeAssistantInstanceID.v2"
    private static let validIdentifierPattern = #"^ha_[a-f0-9]{32}$"#

    static func identifier(baseURL: URL, config: HAConfig) -> String {
        let parts = [
            normalizedComponent(prefix: "url", value: baseURL.absoluteString),
            normalizedComponent(prefix: "location", value: config.locationName),
            normalizedComponent(prefix: "external", value: config.externalURL),
            normalizedComponent(prefix: "internal", value: config.internalURL),
            normalizedComponent(prefix: "timezone", value: config.timeZone)
        ].compactMap { $0 }

        let fingerprint = parts.joined(separator: "|")
        let key = "\(defaultsKeyPrefix).\(shortHash(fingerprint))"
        if let stored = UserDefaults.standard.string(forKey: key),
           isValidIdentifier(stored) {
            return stored
        }

        let seed = "\(UUID().uuidString)|\(fingerprint)|\(Date().timeIntervalSince1970)"
        let identifier = "ha_\(shortHash(seed))"
        UserDefaults.standard.set(identifier, forKey: key)
        return identifier
    }

    private static func shortHash(_ value: String) -> String {
        let digest = SHA256.hash(data: Data(value.utf8))
        return digest.map { String(format: "%02x", $0) }.joined().prefix(32).description
    }

    static func isValidIdentifier(_ value: String) -> Bool {
        value.range(of: validIdentifierPattern, options: .regularExpression) != nil
    }

    static func isSafeIdentifier(_ value: String) -> Bool {
        isValidIdentifier(value) && value != "ha_980c4bd6a677da0511813adb8c98192e"
    }

    static var identityVersion: Int {
        2
    }

    private static func normalizedComponent(prefix: String, value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        return "\(prefix):\(normalizedURLString(trimmed) ?? trimmed.lowercased())"
    }

    private static func normalizedURLString(_ value: String) -> String? {
        guard var components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              ["http", "https"].contains(scheme)
        else {
            return nil
        }

        components.scheme = scheme
        components.host = host
        components.query = nil
        components.fragment = nil

        var result = "\(scheme)://\(host)"
        if let port = components.port {
            result += ":\(port)"
        }
        let path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !path.isEmpty {
            result += "/\(path)"
        }
        return result
    }
}

/// Stores only the non-secret mapping from the app's connection fingerprint to
/// the canonical tenant identity owned by Home Assistant. UserDefaults is used
/// deliberately: the value is device-local routing metadata, not a credential.
final class ManagedRelayInstanceIDStore {
    private let defaults: UserDefaults
    private let keyPrefix = "haLiveKitManagedRelayCanonicalInstanceID.v2"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func canonicalInstanceID(for localInstanceID: String) -> String? {
        guard HomeAssistantInstanceIdentity.isSafeIdentifier(localInstanceID),
              let stored = defaults.string(forKey: key(for: localInstanceID)),
              HomeAssistantInstanceIdentity.isSafeIdentifier(stored)
        else {
            return nil
        }
        return stored
    }

    func save(canonicalInstanceID: String, for localInstanceID: String) throws {
        guard HomeAssistantInstanceIdentity.isSafeIdentifier(localInstanceID),
              HomeAssistantInstanceIdentity.isSafeIdentifier(canonicalInstanceID)
        else {
            throw ManagedRelayPairingError.invalidResponse
        }
        defaults.set(canonicalInstanceID, forKey: key(for: localInstanceID))
    }

    private func key(for localInstanceID: String) -> String {
        "\(keyPrefix).\(localInstanceID)"
    }
}

struct RESTDebugResponse: Hashable {
    var endpoint: URL
    var statusCode: Int
    var bodySnippet: String

    var summary: String {
        let response = bodySnippet.isEmpty ? "" : ", response: \(bodySnippet)"
        return "REST \(LogSanitizer.endpointPath(endpoint)) -> HTTP \(statusCode)\(response)"
    }
}

enum LogSanitizer {
    static func sanitizeLogMessage(_ message: String, secrets: [String] = []) -> String {
        let redacted = redactSecrets(message, secrets: secrets)
        return redactPotentialPaths(redacted)
    }

    static func redactSecrets(_ value: String, secrets: [String] = []) -> String {
        let replacements: [(String, String)] = [
            (#"(?i)(Authorization\s*[:=]\s*Bearer\s+)[^\s,;\]}"']+"#, "$1<redacted>"),
            (#"(?i)(Bearer\s+)[A-Za-z0-9._\-~+/=]{12,}"#, "$1<redacted>"),
            (#"(?i)(X-HA-LiveKit-App-Secret\s*[:=]\s*)[^\s,;\]}"']+"#, "$1<redacted>"),
            (#"(?i)(X-HA-LiveKit-Secret\s*[:=]\s*)[^\s,;\]}"']+"#, "$1<redacted>"),
            (#"(?i)(X-HA-LiveKit-Device-Credential\s*[:=]\s*)[^\s,;\]}"']+"#, "$1<redacted>"),
            (#"(?i)("?(?:access_token|authorization|token|apns_token|push_to_start_token|push-to-start token|update_token|activity_update_token|relay_shared_secret|home_assistant_relay_token|home_assistant_relay_secret|device_credential|pairing_token|HA_LIVEKIT_APP_SECRET|HA_LIVEKIT_SHARED_SECRET|DEVICE_CREDENTIAL_PEPPER|APPLE_PRIVATE_KEY|private_key|client_secret|secret)"?\s*[:=]\s*"?)[^",\s;\}]+"#, "$1<redacted>"),
            (#"(?i)([?&](?:access_token|token|auth|secret)=)[^&\s]+"#, "$1<redacted>"),
            (#"https?://[A-Za-z0-9-]{8,}\.ui\.nabu\.casa[^\s,;\)]*"#, "https://<redacted>.ui.nabu.casa"),
            (#"wss?://[A-Za-z0-9-]{8,}\.ui\.nabu\.casa[^\s,;\)]*"#, "wss://<redacted>.ui.nabu.casa"),
            (#"\bha_[a-fA-F0-9]{32}\b"#, "<redacted-instance-id>"),
            (#"\b[a-fA-F0-9]{32,}\b"#, "<redacted>"),
            (#"\b[A-Za-z0-9_-]{43}\b"#, "<redacted>"),
            (#"\b[A-Za-z0-9_-]{80,}\b"#, "<redacted>")
        ]

        var result = replacements.reduce(value) { current, replacement in
            current.replacingOccurrences(
                of: replacement.0,
                with: replacement.1,
                options: .regularExpression
            )
        }

        for secret in secrets
            .map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) })
            .filter({ $0.count >= 8 })
            .sorted(by: { $0.count > $1.count }) {
            result = result.replacingOccurrences(of: secret, with: "<redacted>")
        }

        return result
    }

    static func containsCredentialShapedValue(_ value: String) -> Bool {
        guard redactSecrets(value) == value else { return true }

        let credentialPatterns = [
            #"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"#,
            #"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"#,
            #"\bsk-[A-Za-z0-9_-]{16,}\b"#,
            #"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,128}(?![A-Za-z0-9_-])"#,
            #"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,128}={0,2}(?![A-Za-z0-9+/=])"#
        ]
        return credentialPatterns.contains { pattern in
            value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
        }
    }

    /// Produces a fixed-vocabulary event summary for an explicitly opted-in
    /// support export. No user-controlled text is ever returned: names,
    /// identifiers, URLs, server responses, error details and timestamps are
    /// intentionally reduced to a category and outcome.
    static func privacySafeSupportEventSummary(
        _ message: String,
        secrets: [String] = []
    ) -> String {
        let boundedMessage = String(message.prefix(2_048))
        let sanitized = sanitizeLogMessage(boundedMessage, secrets: secrets)
        guard !containsCredentialShapedValue(sanitized) else {
            return "Security-sensitive event: details omitted"
        }

        let normalized = sanitized.lowercased()
        let category: String
        if let knownCategory = supportKnownCategory(in: normalized) {
            category = knownCategory
        } else if normalized.contains("notification permission") {
            category = "Notification permission"
        } else if normalized.contains("activity-token")
                    || normalized.contains("activity update token")
                    || normalized.contains("push-to-start token") {
            category = "Activity token"
        } else if normalized.contains("live activity") {
            category = "Live Activity"
        } else if normalized.contains("websocket") {
            category = "WebSocket"
        } else if normalized.contains("entity") || normalized.contains("entities") {
            category = "Entity sync"
        } else if normalized.contains("relay health") {
            category = "Relay health"
        } else if normalized.contains("relay test") {
            category = "Relay test"
        } else if normalized.contains("relay pairing") || normalized.contains("pairing ticket") {
            category = "Relay pairing"
        } else if normalized.contains("relay device") {
            category = "Relay device"
        } else if normalized.contains("relay") || normalized.contains("apns") {
            category = "Relay"
        } else if normalized.contains("home assistant")
                    || normalized.contains("connection")
                    || normalized.contains("rest") {
            category = "Home Assistant connection"
        } else if normalized.contains("credential") {
            category = "Credentials"
        } else if normalized.contains("demo") {
            category = "Demo mode"
        } else if normalized.contains("background") {
            category = "App lifecycle"
        } else {
            category = "Application event"
        }

        let outcome: String
        if let knownOutcome = supportKnownOutcome(in: normalized) {
            outcome = knownOutcome
        } else if normalized.contains("compatibility registration succeeded") {
            outcome = "fallback used"
        } else if normalized.contains("succeeded, but") {
            outcome = "partial success"
        } else if normalized.contains("disconnected") {
            outcome = "disconnected"
        } else if normalized.contains("failed")
                    || normalized.contains("failure")
                    || normalized.contains("error")
                    || normalized.contains("could not")
                    || normalized.contains("couldn’t")
                    || normalized.contains("rejected")
                    || normalized.contains("unavailable")
                    || normalized.contains("not granted") {
            outcome = "failed"
        } else if normalized.contains("ignored")
                    || normalized.contains("discarded")
                    || normalized.contains("skipped") {
            outcome = "skipped"
        } else if normalized.contains("queued")
                    || normalized.contains("pending")
                    || normalized.contains("waiting") {
            outcome = "pending"
        } else if normalized.contains("revoked")
                    || normalized.contains("removed")
                    || normalized.contains("cleared")
                    || normalized.contains("ended")
                    || normalized.contains("completed") {
            outcome = "completed"
        } else if normalized.contains("refreshed")
                    || normalized.contains("updated")
                    || normalized.contains("changed") {
            outcome = "updated"
        } else if normalized.contains("started") || normalized.contains("restoring") {
            outcome = "started"
        } else if normalized.contains("succeeded")
                    || normalized.contains("connected")
                    || normalized.contains("granted")
                    || normalized.contains("authorized")
                    || normalized.contains("saved")
                    || normalized.contains("available")
                    || normalized.contains("subscribed")
                    || normalized.contains("installed")
                    || normalized.contains("ready")
                    || normalized.contains("received") {
            outcome = "succeeded"
        } else if normalized.contains("checked") || normalized.contains("test") {
            outcome = "checked"
        } else {
            outcome = "recorded"
        }

        let statusSuffix = supportHTTPStatus(in: normalized).map { " (HTTP \($0))" } ?? ""
        return "\(category): \(outcome)\(statusSuffix)"
    }

    static func summarizeNetworkResponse(data: Data) -> String {
        guard !data.isEmpty else {
            return "empty response"
        }

        if let json = try? JSONSerialization.jsonObject(with: data) {
            if let array = json as? [Any] {
                return array.isEmpty ? "empty JSON array" : "JSON array (\(array.count) items)"
            }

            if let object = json as? [String: Any] {
                if let ok = object["ok"] as? Bool {
                    return "JSON object (ok: \(ok ? "true" : "false"))"
                }
                return "JSON object"
            }

            return "JSON value"
        }

        return "text response (\(data.count) bytes)"
    }

    static func redactedURLString(_ url: URL, includePath: Bool = false) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme,
              let host = components.host
        else {
            return "<redacted-url>"
        }

        components.user = nil
        components.password = nil
        components.query = nil
        components.fragment = nil

        let displayHost = redactedHost(host)
        var result = "\(scheme)://\(displayHost)"
        if let port = components.port {
            result += ":\(port)"
        }

        if includePath {
            let path = components.path
            if path == "/api/websocket" {
                result += path
            } else if !path.isEmpty && path != "/" {
                result += "/..."
            }
        }

        return result
    }

    static func endpointPath(_ url: URL) -> String {
        let path = url.path.isEmpty ? "/" : url.path
        return path
    }

    static func redactedInstanceID(_ value: String?) -> String {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty
        else {
            return L10n.string("Not connected")
        }
        guard value.count > 14 else {
            return "<redacted-instance>"
        }
        return "\(value.prefix(9))...\(value.suffix(5))"
    }

    private static func redactedHost(_ host: String) -> String {
        let lowercased = host.lowercased()
        let nabuSuffix = ".ui.nabu.casa"
        guard lowercased.hasSuffix(nabuSuffix) else {
            return host
        }

        let prefixLength = host.count - nabuSuffix.count
        guard prefixLength > 0 else {
            return "<redacted>.ui.nabu.casa"
        }

        let subdomain = String(host.prefix(prefixLength))
        return "\(shortRedacted(subdomain)).ui.nabu.casa"
    }

    private static func shortRedacted(_ value: String) -> String {
        guard value.count > 12 else {
            return "<redacted>"
        }
        return "\(value.prefix(6))...\(value.suffix(6))"
    }

    private static func redactPotentialPaths(_ value: String) -> String {
        value.replacingOccurrences(
            of: #"/Users/[^,\s\]\)]+"#,
            with: "/Users/<redacted>",
            options: .regularExpression
        )
    }

    private static func supportHTTPStatus(in value: String) -> String? {
        guard let range = value.range(
            of: #"\bhttp\s+[1-5][0-9]{2}\b"#,
            options: .regularExpression
        ) else {
            return nil
        }
        return value[range].split(separator: " ").last.map(String.init)
    }

    private static func supportKnownCategory(in value: String) -> String? {
        if hasAnyPrefix(value, [
            "restore failed:",
            "home assistant config checked",
            "rest connected to ",
            "connection failed:",
            "connection test ",
            "connection save failed:",
            "stored home assistant connection",
            "previous home assistant connection"
        ]) {
            return "Home Assistant connection"
        }
        if hasAnyPrefix(value, [
            "apns push-to-start token",
            "registered live activity update token",
            "apns relay activity-token"
        ]) {
            return "Activity token"
        }
        if hasAnyPrefix(value, [
            "started live activity",
            "started or updated live activity",
            "manually refreshed live activity",
            "ended live activity",
            "ignored ha livekit request",
            "ha entity service",
            "ha service",
            "ha livekit service request"
        ]) {
            return "Live Activity"
        }
        if hasAnyPrefix(value, ["websocket", "reconnecting websocket", "foreground websocket"]) {
            return "WebSocket"
        }
        if hasAnyPrefix(value, ["entity list refreshed", "refresh failed:"]) {
            return "Entity sync"
        }
        if value.hasPrefix("apns relay health") {
            return "Relay health"
        }
        if value.hasPrefix("apns relay test") {
            return "Relay test"
        }
        if hasAnyPrefix(value, [
            "home assistant authorized secure relay pairing",
            "home assistant secure relay pairing",
            "ignored a managed relay credential",
            "discarded a managed relay credential",
            "home assistant managed relay credential",
            "stored relay device credential",
            "relay rejected the first pairing ticket",
            "secure relay pairing"
        ]) {
            return "Relay pairing"
        }
        if hasAnyPrefix(value, ["revoked relay device", "relay device registration"]) {
            return "Relay device"
        }
        if value.hasPrefix("apns relay") || value.hasPrefix("relay ") {
            return "Relay"
        }
        if value.hasPrefix("notification permission") {
            return "Notification permission"
        }
        if value.hasPrefix("credentials cleared") {
            return "Credentials"
        }
        if value.hasPrefix("demo") {
            return "Demo mode"
        }
        if hasAnyPrefix(value, ["app returned from background", "app moved to background"]) {
            return "App lifecycle"
        }
        return nil
    }

    private static func supportKnownOutcome(in value: String) -> String? {
        if value.hasPrefix("apns relay register succeeded, but") {
            return "partial success"
        }
        if value.hasPrefix("secure relay pairing is unavailable; compatibility registration succeeded") {
            return "fallback used"
        }
        if value.hasPrefix("websocket disconnected:") {
            return "disconnected"
        }
        if hasAnyPrefix(value, [
            "restore failed:",
            "connection failed:",
            "apns relay settings save failed:",
            "notification permission was not granted",
            "notification permission request failed:",
            "home assistant secure relay pairing was not completed:",
            "refresh failed:",
            "connection test failed:",
            "connection save failed:",
            "stored home assistant connection could not",
            "demo mode ended, but the stored home assistant connection could not",
            "previous home assistant connection could not",
            "demo scenario failed:",
            "ha livekit service request failed:",
            "foreground websocket unavailable:",
            "websocket reconnect failed:",
            "apns relay test start failed:",
            "apns relay health check failed:",
            "apns relay push-to-start registration failed:",
            "apns relay activity-token registration failed for ",
            "pending relay revocations could not be read:"
        ]) {
            return "failed"
        }
        if hasAnyPrefix(value, [
            "ignored a managed relay credential",
            "discarded a managed relay credential",
            "home assistant managed relay auto-config skipped",
            "ignored ha livekit request"
        ]) {
            return "skipped"
        }
        if hasAnyPrefix(value, [
            "home assistant managed relay credential pending",
            "reconnecting websocket",
            "stored relay device credential was rejected",
            "relay rejected the first pairing ticket",
            "relay device registration removal is queued"
        ]) {
            return "pending"
        }
        if hasAnyPrefix(value, [
            "revoked relay device",
            "ended live activity",
            "credentials cleared",
            "demo mode ended",
            "ha service ended live activity",
            "demo laundry cycle completed",
            "relay device registration removed"
        ]) {
            return "completed"
        }
        if hasAnyPrefix(value, [
            "display name updated to ",
            "demo entities refreshed",
            "entity list refreshed",
            "started or updated live activity",
            "manually refreshed live activity",
            "demo scenario applied:",
            "ha entity service started or updated live activity",
            "ha service refreshed existing live activity",
            "ha entity service updated live activity",
            "ha service updated live activity",
            "app returned from background",
            "app moved to background"
        ]) {
            return "updated"
        }
        if hasAnyPrefix(value, [
            "debug session started",
            "started live activity for ",
            "demo mode started",
            "ha service started live activity"
        ]) {
            return "started"
        }
        if hasAnyPrefix(value, [
            "rest connected to ",
            "apns relay saved as ",
            "notification permission granted",
            "home assistant authorized secure relay pairing",
            "home assistant relay credential installed",
            "connection test succeeded",
            "websocket subscribed",
            "apns relay test start succeeded",
            "apns relay health check succeeded",
            "apns push-to-start token available",
            "registered live activity update token"
        ]) {
            return "succeeded"
        }
        if value.hasPrefix("relay "), value.contains(" registration succeeded") {
            return "succeeded"
        }
        if value.hasPrefix("home assistant config checked") {
            return "checked"
        }
        return nil
    }

    private static func hasAnyPrefix(_ value: String, _ prefixes: [String]) -> Bool {
        prefixes.contains(where: value.hasPrefix)
    }
}

enum ConnectionDiagnosticStatus: String, Codable, Hashable {
    case idle
    case connecting
    case connected
    case disconnected
    case failed

    var title: String {
        switch self {
        case .idle: L10n.string("Not started")
        case .connecting: L10n.string("Connecting")
        case .connected: L10n.string("Connected")
        case .disconnected: L10n.string("Disconnected")
        case .failed: L10n.string("Failed")
        }
    }
}

enum AppConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case demo
    case failed(String)

    var title: String {
        switch self {
        case .disconnected: L10n.string("Disconnected")
        case .connecting: L10n.string("Connecting...")
        case .connected: L10n.string("Connected")
        case .demo: L10n.string("Demo Mode")
        case .failed: L10n.string("Needs attention")
        }
    }
}

enum HALiveKitError: LocalizedError {
    case invalidURL
    case missingCredentials
    case invalidResponse
    case invalidToken
    case unauthorized
    case connectionTimeout
    case cannotReachHomeAssistant
    case transportSecurity(String)
    case httpStatus(Int)
    case integrationUpdateRequired
    case webSocketAuthFailed(String?)
    case webSocketDisconnected
    case webSocketTimeout
    case liveActivitiesDisabled
    case activityNotFound
    case duplicateActivityName
    case keychain(OSStatus)
    case message(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            L10n.string("Enter a valid Home Assistant URL. Examples: homeassistant.local:8123, http://homeassistant.local:8123 or your Nabu Casa HTTPS URL.")
        case .missingCredentials:
            L10n.string("Home Assistant token is required for real Home Assistant connections. If the URL is empty, HA LiveKit uses homeassistant.local:8123.")
        case .invalidResponse:
            L10n.string("Home Assistant returned an unexpected response.")
        case .invalidToken:
            L10n.string("Invalid Home Assistant token. Create a fresh Long-Lived Access Token and try again.")
        case .unauthorized:
            L10n.string("Invalid Home Assistant token. Create a fresh Long-Lived Access Token and try again.")
        case .connectionTimeout:
            L10n.string("Connection timed out after 10 seconds. Check the Home Assistant URL and network reachability.")
        case .cannotReachHomeAssistant:
            L10n.string("Cannot reach Home Assistant at this URL. Check the host, port, VPN, local network permission and whether Home Assistant is running.")
        case .transportSecurity(let message):
            L10n.format("Network security blocked the connection. %@", message)
        case .httpStatus(let statusCode):
            L10n.format("Home Assistant returned HTTP %d. Check the URL and token permissions.", statusCode)
        case .integrationUpdateRequired:
            L10n.string("Update the HA LiveKit integration in HACS, restart Home Assistant, then reopen the app. The installed integration does not support secure relay pairing and device management yet.")
        case .webSocketAuthFailed(let message):
            message ?? L10n.string("Home Assistant WebSocket authentication failed.")
        case .webSocketDisconnected:
            L10n.string("The Home Assistant WebSocket disconnected.")
        case .webSocketTimeout:
            L10n.string("Home Assistant WebSocket timed out after 10 seconds. REST is connected, but live foreground updates are temporarily unavailable.")
        case .liveActivitiesDisabled:
            L10n.string("Live Activities are disabled for this app. Enable them in iOS Settings.")
        case .activityNotFound:
            L10n.string("That Live Activity is no longer available.")
        case .duplicateActivityName:
            L10n.string("An active Live Activity with this name already exists. Please choose another name.")
        case .keychain(let status):
            L10n.format("Keychain operation failed with status %d.", status)
        case .message(let message):
            message
        }
    }
}

enum HomeAssistantURLNormalizer {
    static let defaultLocalAddress = "homeassistant.local:8123"

    static func usesUnencryptedHTTP(_ rawValue: String) -> Bool {
        guard let normalizedURL = try? normalize(rawValue) else { return false }
        return normalizedURL.scheme?.lowercased() == "http"
    }

    static func normalize(_ rawValue: String) throws -> URL {
        var trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            trimmed = defaultLocalAddress
        }

        if !trimmed.localizedCaseInsensitiveContains("://") {
            trimmed = "http://\(trimmed)"
        }

        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              let host = components.host,
              !host.isEmpty
        else {
            throw HALiveKitError.invalidURL
        }

        guard components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil
        else {
            throw HALiveKitError.invalidURL
        }

        components.scheme = scheme
        components.path = normalizePath(components.path)

        guard let url = components.url else {
            throw HALiveKitError.invalidURL
        }

        return url
    }

    private static func normalizePath(_ path: String) -> String {
        let trimmedPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !trimmedPath.isEmpty else { return "" }

        var parts = trimmedPath.split(separator: "/").map(String.init)
        if parts.last?.lowercased() == "api" {
            parts.removeLast()
        }

        return parts.isEmpty ? "" : "/\(parts.joined(separator: "/"))"
    }
}

func withTimeout<T>(
    seconds: TimeInterval,
    timeoutError: HALiveKitError,
    operation: @escaping () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask {
            try await operation()
        }

        group.addTask {
            let nanoseconds = UInt64(seconds * 1_000_000_000)
            try await Task.sleep(nanoseconds: nanoseconds)
            throw timeoutError
        }

        guard let result = try await group.next() else {
            throw timeoutError
        }

        group.cancelAll()
        return result
    }
}
