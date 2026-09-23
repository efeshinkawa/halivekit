import Foundation

struct APNsRelayHTTPResult: Equatable {
    var statusCode: Int
    var responseSummary: String
    var ok: Bool?
    var registered: Bool?
    var unregistered: Bool?
    var deviceID: String?
    var homeAssistantInstanceID: String?
    var environment: String?
    var activityID: String?
    var homeAssistantRelayToken: String?
    var deviceCredential: String?
    var authenticationProtocol: String?
}

enum APNsRelayClientError: LocalizedError {
    case httpStatus(Int, String)
    case transport(String)
    case environmentMismatch(relay: String, build: String)

    var statusCode: Int? {
        switch self {
        case .httpStatus(let statusCode, _):
            statusCode
        case .transport, .environmentMismatch:
            nil
        }
    }

    var errorDescription: String? {
        switch self {
        case .httpStatus(let statusCode, let summary):
            L10n.format("Relay returned HTTP %d: %@", statusCode, summary)
        case .transport(let message):
            message
        case .environmentMismatch(let relay, let build):
            L10n.format(
                "Relay uses %@ APNs, but this build uses %@. Use a matching sandbox relay for Debug builds; the production relay was left unchanged.",
                relay,
                build
            )
        }
    }

    var isEnvironmentMismatch: Bool {
        if case .environmentMismatch = self { return true }
        return false
    }
}

final class APNsLiveActivityRelayClient {
    private static let instanceIDVersion = 2
    private let session: URLSession

    init(session: URLSession = .haliveKit) {
        self.session = session
    }

    func registerPushToStartToken(
        settings: APNsRelaySettings,
        deviceID: String,
        homeAssistantInstanceID: String,
        friendlyDeviceName: String?,
        token: String,
        bundleIdentifier: String,
        appVersion: String
    ) async throws -> APNsRelayHTTPResult {
        var body: [String: Any] = [
            "device_id": deviceID,
            "home_assistant_instance_id": homeAssistantInstanceID,
            "instance_id_version": Self.instanceIDVersion,
            "push_to_start_token": token,
            "bundle_id": bundleIdentifier,
            "app_version": appVersion,
            "apns_mode": settings.effectiveMode.rawValue
        ]
        if let friendlyDeviceName,
           !friendlyDeviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["friendly_device_name"] = friendlyDeviceName
        }

        return try await send(
            method: "POST",
            endpoint: "register",
            settings: settings,
            body: body
        )
    }

    func registerPushToStartTokenV2(
        settings: APNsRelaySettings,
        deviceID: String,
        homeAssistantInstanceID: String,
        friendlyDeviceName: String?,
        token: String,
        bundleIdentifier: String,
        appVersion: String,
        pairingToken: String? = nil,
        deviceCredential: String? = nil
    ) async throws -> APNsRelayHTTPResult {
        var body: [String: Any] = [
            "device_id": deviceID,
            "home_assistant_instance_id": homeAssistantInstanceID,
            "instance_id_version": Self.instanceIDVersion,
            "push_to_start_token": token,
            "bundle_id": bundleIdentifier,
            "app_version": appVersion,
            "apns_mode": settings.effectiveMode.rawValue
        ]
        if let friendlyDeviceName,
           !friendlyDeviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["friendly_device_name"] = friendlyDeviceName
        }
        if let pairingToken, !pairingToken.isEmpty {
            body["pairing_token"] = pairingToken
        }
        return try await send(
            method: "POST",
            endpoint: "v2/register",
            settings: settings,
            body: body,
            includesAppSecret: false,
            deviceCredential: deviceCredential
        )
    }

    func registerActivityToken(
        settings: APNsRelaySettings,
        deviceID: String,
        homeAssistantInstanceID: String,
        activityID: String,
        activityKitID: String,
        token: String,
        contentState: HALiveActivityAttributes.ContentState,
        bundleIdentifier: String,
        appVersion: String
    ) async throws -> APNsRelayHTTPResult {
        let body: [String: Any] = [
            "device_id": deviceID,
            "home_assistant_instance_id": homeAssistantInstanceID,
            "instance_id_version": Self.instanceIDVersion,
            "activity_id": activityID,
            "activity_kit_id": activityKitID,
            "update_token": token,
            "bundle_id": bundleIdentifier,
            "app_version": appVersion,
            "apns_mode": settings.effectiveMode.rawValue,
            "display_name": contentState.displayName ?? contentState.title,
            "content_state": Self.relayContentState(from: contentState)
        ]
        return try await send(
            method: "POST",
            endpoint: "activity-token",
            settings: settings,
            body: body
        )
    }

    func registerActivityTokenV2(
        settings: APNsRelaySettings,
        deviceCredential: String,
        deviceID: String,
        homeAssistantInstanceID: String,
        activityID: String,
        activityKitID: String,
        token: String,
        contentState: HALiveActivityAttributes.ContentState,
        bundleIdentifier: String,
        appVersion: String
    ) async throws -> APNsRelayHTTPResult {
        let body: [String: Any] = [
            "device_id": deviceID,
            "home_assistant_instance_id": homeAssistantInstanceID,
            "instance_id_version": Self.instanceIDVersion,
            "activity_id": activityID,
            "activity_kit_id": activityKitID,
            "update_token": token,
            "bundle_id": bundleIdentifier,
            "app_version": appVersion,
            "apns_mode": settings.effectiveMode.rawValue,
            "display_name": contentState.displayName ?? contentState.title,
            "content_state": Self.relayContentState(from: contentState)
        ]
        return try await send(
            method: "POST",
            endpoint: "v2/activity-token",
            settings: settings,
            body: body,
            includesAppSecret: false,
            deviceCredential: deviceCredential
        )
    }

    /// Reports that a Live Activity reached a terminal ActivityKit state.
    ///
    /// A dismissed or ended activity keeps an update token APNs still answers with
    /// HTTP 200, so the relay would keep "delivering" updates that can never be shown.
    /// Only the device observes that transition, so it retires the route here and the
    /// next Home Assistant Set starts a fresh, visible activity.
    func retireActivity(
        settings: APNsRelaySettings,
        deviceID: String,
        homeAssistantInstanceID: String,
        activityID: String,
        activityState: String
    ) async throws -> APNsRelayHTTPResult {
        return try await send(
            method: "POST",
            endpoint: "activity-retire",
            settings: settings,
            body: [
                "device_id": deviceID,
                "home_assistant_instance_id": homeAssistantInstanceID,
                "instance_id_version": Self.instanceIDVersion,
                "activity_id": activityID,
                "apns_mode": settings.effectiveMode.rawValue,
                "activity_state": activityState
            ]
        )
    }

    func retireActivityV2(
        settings: APNsRelaySettings,
        deviceCredential: String,
        deviceID: String,
        homeAssistantInstanceID: String,
        activityID: String,
        activityState: String
    ) async throws -> APNsRelayHTTPResult {
        return try await send(
            method: "POST",
            endpoint: "v2/activity-retire",
            settings: settings,
            body: [
                "device_id": deviceID,
                "home_assistant_instance_id": homeAssistantInstanceID,
                "instance_id_version": Self.instanceIDVersion,
                "activity_id": activityID,
                "apns_mode": settings.effectiveMode.rawValue,
                "activity_state": activityState
            ],
            includesAppSecret: false,
            deviceCredential: deviceCredential
        )
    }

    func sendTestStart(
        settings: APNsRelaySettings,
        deviceID: String,
        homeAssistantInstanceID: String,
        activityID: String,
        bundleIdentifier: String,
        appVersion: String
    ) async throws -> APNsRelayHTTPResult {
        return try await send(
            method: "POST",
            endpoint: "test-start",
            settings: settings,
            body: [
                "device_id": deviceID,
                "home_assistant_instance_id": homeAssistantInstanceID,
                "instance_id_version": Self.instanceIDVersion,
                "activity_id": activityID,
                "title": "HA LiveKit",
                "subtitle": "Background test",
                "display_name": "Background Updates",
                "template": "custom",
                "state": "Testing",
                "bundle_id": bundleIdentifier,
                "app_version": appVersion,
                "apns_mode": settings.effectiveMode.rawValue
            ]
        )
    }

    func sendTestStartV2(
        settings: APNsRelaySettings,
        deviceCredential: String,
        deviceID: String,
        homeAssistantInstanceID: String,
        activityID: String,
        bundleIdentifier: String,
        appVersion: String
    ) async throws -> APNsRelayHTTPResult {
        return try await send(
            method: "POST",
            endpoint: "v2/test-start",
            settings: settings,
            body: [
                "device_id": deviceID,
                "home_assistant_instance_id": homeAssistantInstanceID,
                "instance_id_version": Self.instanceIDVersion,
                "activity_id": activityID,
                "title": "HA LiveKit",
                "subtitle": "Background test",
                "display_name": "Background Updates",
                "template": "custom",
                "state": "Testing",
                "bundle_id": bundleIdentifier,
                "app_version": appVersion,
                "apns_mode": settings.effectiveMode.rawValue
            ],
            includesAppSecret: false,
            deviceCredential: deviceCredential
        )
    }

    func unregisterV2(
        settings: APNsRelaySettings,
        deviceCredential: String,
        deviceID: String,
        homeAssistantInstanceID: String
    ) async throws -> APNsRelayHTTPResult {
        try await send(
            method: "POST",
            endpoint: "v2/unregister",
            settings: settings,
            body: [
                "device_id": deviceID,
                "home_assistant_instance_id": homeAssistantInstanceID,
                "instance_id_version": Self.instanceIDVersion,
                "apns_mode": settings.effectiveMode.rawValue
            ],
            includesAppSecret: false,
            deviceCredential: deviceCredential
        )
    }

    func testHealth(settings: APNsRelaySettings) async throws -> APNsRelayHTTPResult {
        return try await send(
            method: "GET",
            endpoint: "health",
            settings: settings,
            body: nil,
            includesAppSecret: false
        )
    }

    private func send(
        method: String,
        endpoint: String,
        settings: APNsRelaySettings,
        body: [String: Any]?,
        includesAppSecret: Bool = true,
        deviceCredential: String? = nil
    ) async throws -> APNsRelayHTTPResult {
        guard let baseURL = settings.relayURL else {
            throw HALiveKitError.invalidURL
        }

        let url = endpoint
            .split(separator: "/")
            .reduce(baseURL) { partial, component in
                partial.appendingPathComponent(String(component))
            }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 10
        if includesAppSecret {
            request.setValue(settings.effectiveRegistrationSecret, forHTTPHeaderField: "X-HA-LiveKit-App-Secret")
        }
        if let deviceCredential, !deviceCredential.isEmpty {
            request.setValue(deviceCredential, forHTTPHeaderField: "X-HA-LiveKit-Device-Credential")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        // Relay requests carry device-scoped credentials. Refuse redirects so
        // those headers can never be replayed to a different origin by a
        // compromised or misconfigured endpoint.
        let (bytes, response) = try await session.bytes(
            for: request,
            delegate: RelayRedirectRejectingDelegate.shared
        )
        let maximumResponseBytes = 32 * 1024
        guard response.expectedContentLength <= 0
                || response.expectedContentLength <= Int64(maximumResponseBytes)
        else {
            throw HALiveKitError.invalidResponse
        }
        var data = Data()
        data.reserveCapacity(
            response.expectedContentLength > 0
                ? min(Int(response.expectedContentLength), maximumResponseBytes)
                : 1024
        )
        for try await byte in bytes {
            guard data.count < maximumResponseBytes else {
                throw HALiveKitError.invalidResponse
            }
            data.append(byte)
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            throw HALiveKitError.invalidResponse
        }

        let summary = Self.responseSummary(from: data)
        let object = Self.responseObject(from: data)
        let homeAssistantRelayToken = Self.homeAssistantRelayToken(from: object)
        let returnedDeviceCredential = Self.stringValue("device_credential", from: object)
        let authenticationProtocol = Self.stringValue("auth_protocol", from: object)
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw APNsRelayClientError.httpStatus(httpResponse.statusCode, summary)
        }

        return APNsRelayHTTPResult(
            statusCode: httpResponse.statusCode,
            responseSummary: summary,
            ok: object?["ok"] as? Bool,
            registered: object?["registered"] as? Bool,
            unregistered: object?["unregistered"] as? Bool,
            deviceID: Self.stringValue("device_id", from: object),
            homeAssistantInstanceID: Self.stringValue("home_assistant_instance_id", from: object),
            environment: Self.stringValue("apns_environment", from: object),
            activityID: Self.stringValue("activity_id", from: object),
            homeAssistantRelayToken: homeAssistantRelayToken,
            deviceCredential: returnedDeviceCredential,
            authenticationProtocol: authenticationProtocol
        )
    }

    private static func responseSummary(from data: Data) -> String {
        LogSanitizer.summarizeNetworkResponse(data: data)
    }

    private static func homeAssistantRelayToken(from object: [String: Any]?) -> String? {
        guard let object else { return nil }
        for key in ["relay_shared_secret", "home_assistant_relay_token", "home_assistant_relay_secret"] {
            guard let token = object[key] as? String else { continue }
            let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }

        return nil
    }

    private static func stringValue(_ key: String, from object: [String: Any]?) -> String? {
        guard let object,
              let value = object[key] as? String
        else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func responseObject(from data: Data) -> [String: Any]? {
        guard !data.isEmpty else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private static func relayContentState(from state: HALiveActivityAttributes.ContentState) -> [String: Any] {
        [
            "title": state.title,
            "subtitle": state.subtitle,
            "displayName": state.displayName ?? state.title,
            "entityId": state.entityId,
            "primaryState": state.primaryState,
            "secondaryState": jsonValue(state.secondaryState),
            "progress": jsonValue(state.progress),
            "value": jsonValue(state.value),
            "unit": jsonValue(state.unit),
            "iconName": state.iconName,
            "theme": state.theme.rawValue,
            "displayStyle": state.displayStyle.rawValue,
            "lastUpdated": state.lastUpdated.timeIntervalSinceReferenceDate
        ]
    }

    private static func jsonValue(_ value: String?) -> Any {
        value ?? NSNull()
    }

    private static func jsonValue(_ value: Double?) -> Any {
        value ?? NSNull()
    }
}

private final class RelayRedirectRejectingDelegate: NSObject, URLSessionTaskDelegate {
    static let shared = RelayRedirectRejectingDelegate()

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
