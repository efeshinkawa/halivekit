import CryptoKit
import Foundation

struct HALiveKitIntegrationStatus: Equatable, Decodable {
    let ok: Bool
    let integrationVersion: String
    let capabilities: [String: Bool]

    var supportsRelayPairingV2: Bool {
        capabilities["relay_pairing_v2"] == true
    }

    var supportsRelayDevicesV2: Bool {
        capabilities["relay_devices_v2"] == true
    }

    enum CodingKeys: String, CodingKey {
        case ok
        case integrationVersion = "integration_version"
        case capabilities
    }
}

struct HomeAssistantClient {
    private let configuration: ConnectionConfiguration
    private let session: URLSession

    init(configuration: ConnectionConfiguration, session: URLSession = .haliveKit) {
        self.configuration = configuration
        self.session = session
    }

    func testConnection() async throws -> RESTDebugResponse {
        let (_, debug) = try await fetchConfig()
        return debug
    }

    func fetchConfig() async throws -> (HAConfig, RESTDebugResponse) {
        var request = authenticatedRequest(url: apiURL(path: "config"))
        request.httpMethod = "GET"

        let (data, response) = try await perform(request)
        let debug = try makeDebugResponse(data: data, response: response, endpoint: request.url)
        try validate(response: response)

        let config = try JSONDecoder().decode(HAConfig.self, from: data)
        return (config, debug)
    }

    func fetchStates() async throws -> ([HAEntity], RESTDebugResponse) {
        var request = authenticatedRequest(url: apiURL(path: "states"))
        request.httpMethod = "GET"

        let (data, response) = try await perform(request)
        let debug = try makeDebugResponse(data: data, response: response, endpoint: request.url)
        try validate(response: response)

        let decoder = JSONDecoder.homeAssistant
        let entities = try decoder.decode([HAEntity].self, from: data)
            .filter { HAEntityDomain.allCases.dropLast().contains($0.domain) }
            .sorted { $0.entityId.localizedStandardCompare($1.entityId) == .orderedAscending }
        return (entities, debug)
    }

    func fetchHALiveKitIntegrationStatus() async throws -> HALiveKitIntegrationStatus {
        var request = authenticatedRequest(url: apiURL(path: "ha_livekit/status"))
        request.httpMethod = "GET"

        let (data, response) = try await perform(request)
        guard data.count <= 8 * 1024,
              let http = response as? HTTPURLResponse
        else {
            throw HALiveKitError.invalidResponse
        }
        if http.statusCode == 404 {
            throw HALiveKitError.integrationUpdateRequired
        }
        try validate(response: response)

        let status = try JSONDecoder().decode(HALiveKitIntegrationStatus.self, from: data)
        guard status.ok,
              status.integrationVersion.range(
                of: #"^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$"#,
                options: .regularExpression
              ) != nil,
              status.capabilities.count <= 16
        else {
            throw HALiveKitError.invalidResponse
        }
        return status
    }

    func fetchState(entityID: String) async throws -> HAEntity {
        var request = authenticatedRequest(url: apiURL(path: "states/\(entityID)"))
        request.httpMethod = "GET"

        let (data, response) = try await perform(request)
        try validate(response: response)
        return try JSONDecoder.homeAssistant.decode(HAEntity.self, from: data)
    }

    /// Generic Home Assistant service caller. Used by Shortcuts/AppIntents
    /// so they can trigger HA's `ha_livekit.*` services from the background
    /// instead of foregrounding the app.
    ///
    /// `data` must contain only non-sensitive values. The token used for
    /// authentication is the Long-Lived Access Token loaded from the
    /// Keychain by the caller.
    func callService(domain: String, service: String, data: [String: Any]) async throws -> RESTDebugResponse {
        var request = authenticatedRequest(url: apiURL(path: "services/\(domain)/\(service)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: data, options: [])

        let (responseData, response) = try await perform(request)
        let debug = try makeDebugResponse(data: responseData, response: response, endpoint: request.url)
        do {
            try validate(response: response)
        } catch HALiveKitError.httpStatus(let code) where (400..<500).contains(code) {
            // HA's voluptuous validator returns plain-text "extra keys not
            // allowed" / "required key not provided" messages for bad service
            // payloads. Surface a sanitized snippet so the user (or a
            // developer) can tell the difference between "bad payload" and
            // the generic "URL/token issue" wording from validate().
            let raw = String(data: responseData, encoding: .utf8) ?? ""
            let sanitized = LogSanitizer.sanitizeLogMessage(raw)
            let snippet = sanitized.prefix(200)
            if !snippet.isEmpty {
                throw HALiveKitError.message(
                    L10n.format("Home Assistant rejected the request (HTTP %d): %@", code, String(snippet))
                )
            }
            throw HALiveKitError.httpStatus(code)
        }
        return debug
    }

    func configureManagedRelay(
        relayURLString: String,
        relaySharedSecret: String,
        relayAppRegistrationSecret: String,
        environment: String,
        homeAssistantInstanceID: String
    ) async throws -> RESTDebugResponse {
        var request = authenticatedRequest(url: apiURL(path: "services/ha_livekit/configure_managed_relay"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var payload = [
            "relay_url": relayURLString,
            "relay_environment": environment,
            "home_assistant_instance_id": homeAssistantInstanceID
        ]
        let trimmedRelaySecret = relaySharedSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedRelaySecret.isEmpty {
            payload["relay_shared_secret"] = trimmedRelaySecret
        }
        let trimmedAppSecret = relayAppRegistrationSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedAppSecret.isEmpty {
            payload["relay_app_registration_secret"] = trimmedAppSecret
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await perform(request)
        let debug = try makeDebugResponse(data: data, response: response, endpoint: request.url)
        try validate(response: response)
        return debug
    }

    func requestManagedRelayPairing(
        _ pairingRequest: ManagedRelayPairingRequest
    ) async throws -> ManagedRelayPairingGrant {
        var request = authenticatedRequest(url: apiURL(path: "ha_livekit/relay/pair"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "home_assistant_instance_id": pairingRequest.homeAssistantInstanceID,
            "device_id": pairingRequest.deviceID,
            "push_to_start_token_hash": Self.sha256Hex(pairingRequest.pushToStartToken),
            "relay_environment": pairingRequest.environment.rawValue,
            "bundle_id": pairingRequest.bundleIdentifier,
            "app_version": pairingRequest.appVersion
        ])

        let (data, response) = try await perform(request)
        guard data.count <= 32 * 1024 else {
            throw ManagedRelayPairingError.invalidResponse
        }
        guard let http = response as? HTTPURLResponse else {
            throw ManagedRelayPairingError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw HALiveKitError.invalidToken }
            if http.statusCode == 403 { throw ManagedRelayPairingError.administratorRequired }
            let errorPayload = Self.pairingErrorPayload(from: data)
            if [404, 405, 501].contains(http.statusCode) || errorPayload.code == "relay_v2_unavailable" {
                throw ManagedRelayPairingError.unavailable(
                    L10n.string("Secure relay pairing requires the HA LiveKit 2.0 HACS integration. Update it and restart Home Assistant; compatibility registration remains active until then."),
                    homeAssistantInstanceID: errorPayload.homeAssistantInstanceID
                )
            }
            throw ManagedRelayPairingError.rejected(
                http.statusCode,
                errorPayload.message ?? L10n.format("Secure relay pairing failed (HTTP %d).", http.statusCode)
            )
        }

        var grant: ManagedRelayPairingGrant
        do {
            grant = try JSONDecoder().decode(ManagedRelayPairingGrant.self, from: data)
        } catch {
            throw ManagedRelayPairingError.invalidResponse
        }
        grant.statusCode = http.statusCode
        guard grant.ok,
              grant.authenticationProtocol == RelayAuthenticationProtocol.deviceV2.rawValue,
              grant.pairingToken.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              (60...900).contains(grant.expiresIn),
              HomeAssistantInstanceIdentity.isSafeIdentifier(grant.homeAssistantInstanceID),
              grant.deviceID == pairingRequest.deviceID,
              grant.environment == pairingRequest.environment.rawValue,
              let returnedRelayURL = URL(string: grant.relayURLString),
              returnedRelayURL.scheme?.lowercased() == "https",
              returnedRelayURL.host?.isEmpty == false,
              returnedRelayURL.normalizedOriginAndPath == ManagedRelayConfig.current.managedRelayBaseURL?.normalizedOriginAndPath
        else {
            throw ManagedRelayPairingError.invalidResponse
        }
        return grant
    }

    func fetchManagedRelayDevices() async throws -> [ManagedRelayDevice] {
        var request = authenticatedRequest(url: apiURL(path: "ha_livekit/relay/devices"))
        request.httpMethod = "GET"
        let (data, response) = try await perform(request)
        guard data.count <= 32 * 1024 else { throw HALiveKitError.invalidResponse }
        if (response as? HTTPURLResponse)?.statusCode == 404 {
            throw HALiveKitError.integrationUpdateRequired
        }
        try validate(response: response)
        let inventory = try JSONDecoder().decode(ManagedRelayDeviceInventory.self, from: data)
        guard inventory.ok, inventory.devices.count <= 256 else {
            throw HALiveKitError.invalidResponse
        }
        var seen = Set<String>()
        for device in inventory.devices {
            guard device.deviceID.range(
                of: #"^[A-Za-z0-9._-]{1,128}$"#,
                options: .regularExpression
            ) != nil,
            ["v1", "v2"].contains(device.authenticationProtocol),
            device.authenticationGeneration >= 0,
            seen.insert(device.deviceID).inserted
            else {
                throw HALiveKitError.invalidResponse
            }
        }
        return inventory.devices
    }

    func revokeManagedRelayDevice(deviceID: String) async throws {
        guard deviceID.range(
            of: #"^[A-Za-z0-9._-]{1,128}$"#,
            options: .regularExpression
        ) != nil else {
            throw HALiveKitError.invalidResponse
        }
        var request = authenticatedRequest(url: apiURL(path: "ha_livekit/relay/devices"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["device_id": deviceID])
        let (data, response) = try await perform(request)
        guard data.count <= 32 * 1024 else { throw HALiveKitError.invalidResponse }
        if (response as? HTTPURLResponse)?.statusCode == 404 {
            throw HALiveKitError.integrationUpdateRequired
        }
        try validate(response: response)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["ok"] as? Bool == true,
              object["revoked"] as? Bool == true,
              object["device_id"] as? String == deviceID
        else {
            throw HALiveKitError.invalidResponse
        }
    }

    private func validate(response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw HALiveKitError.invalidResponse
        }

        switch http.statusCode {
        case 200..<300:
            return
        case 401:
            throw HALiveKitError.invalidToken
        case 403:
            throw HALiveKitError.unauthorized
        default:
            throw HALiveKitError.httpStatus(http.statusCode)
        }
    }

    private func authenticatedRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("HA LiveKit iOS", forHTTPHeaderField: "User-Agent")
        return request
    }

    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await withTimeout(seconds: 10, timeoutError: .connectionTimeout) {
                try await session.data(for: request)
            }
        } catch let error as HALiveKitError {
            throw error
        } catch {
            throw mapNetworkError(error)
        }
    }

    private func makeDebugResponse(data: Data, response: URLResponse, endpoint: URL?) throws -> RESTDebugResponse {
        guard let http = response as? HTTPURLResponse else {
            throw HALiveKitError.invalidResponse
        }

        return RESTDebugResponse(
            endpoint: endpoint ?? http.url ?? configuration.baseURL,
            statusCode: http.statusCode,
            bodySnippet: LogSanitizer.summarizeNetworkResponse(data: data)
        )
    }

    private func mapNetworkError(_ error: Error) -> HALiveKitError {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            let code = URLError.Code(rawValue: nsError.code)
            switch code {
            case .timedOut:
                return .connectionTimeout
            case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .networkConnectionLost, .notConnectedToInternet, .internationalRoamingOff, .dataNotAllowed:
                return .cannotReachHomeAssistant
            case .appTransportSecurityRequiresSecureConnection:
                return .transportSecurity(L10n.string("Use HTTPS for remote Home Assistant URLs, or use a local HTTP URL such as http://homeassistant.local:8123."))
            case .secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted, .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired:
                return .transportSecurity(L10n.string("TLS certificate validation failed. Check the certificate, reverse proxy and Nabu Casa URL."))
            default:
                return .message(nsError.localizedDescription)
            }
        }

        return .message(error.localizedDescription)
    }

    private func apiURL(path: String) -> URL {
        let base = configuration.baseURL.appendingPathComponent("api")
        guard !path.isEmpty else { return base }
        return base.appendingPathComponent(path)
    }

    private static func sha256Hex(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static func pairingErrorPayload(
        from data: Data
    ) -> (code: String?, message: String?, homeAssistantInstanceID: String?) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return (nil, nil, nil)
        }
        let code = (object["error"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawMessage = (object["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let message = rawMessage.map { LogSanitizer.sanitizeLogMessage(String($0.prefix(240))) }
        let candidate = (object["home_assistant_instance_id"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let homeAssistantInstanceID = candidate.flatMap {
            HomeAssistantInstanceIdentity.isSafeIdentifier($0) ? $0 : nil
        }
        return (code, message, homeAssistantInstanceID)
    }
}

private extension URL {
    var normalizedOriginAndPath: String {
        let scheme = scheme?.lowercased() ?? ""
        let host = host(percentEncoded: false)?.lowercased() ?? ""
        let portText = port.map { ":\($0)" } ?? ""
        let normalizedPath = path == "/" ? "" : path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return "\(scheme)://\(host)\(portText)\(normalizedPath.isEmpty ? "" : "/\(normalizedPath)")"
    }
}

extension URLSession {
    static var haliveKit: URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 10
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }
}

extension JSONDecoder {
    static var homeAssistant: JSONDecoder {
        let decoder = JSONDecoder()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        let regular = ISO8601DateFormatter()
        regular.formatOptions = [.withInternetDateTime]

        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)

            if let date = fractional.date(from: value) ?? regular.date(from: value) {
                return date
            }

            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid Home Assistant date: \(value)"
            )
        }
        return decoder
    }
}
