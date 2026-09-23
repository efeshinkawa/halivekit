import Foundation
import Security

final class KeychainCredentialStore {
    private let service = "com.halivekit.credentials"
    private let account = "home-assistant"

    func save(_ configuration: ConnectionConfiguration) throws {
        let data = try JSONEncoder().encode(configuration)
        var query = baseQuery()
        SecItemDelete(query as CFDictionary)

        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw HALiveKitError.keychain(status)
        }
    }

    func load() throws -> ConnectionConfiguration? {
        var query = baseQuery()
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

        guard let data = result as? Data else {
            throw HALiveKitError.invalidResponse
        }

        return try JSONDecoder().decode(ConnectionConfiguration.self, from: data)
    }

    func clear() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw HALiveKitError.keychain(status)
        }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}

final class RelayDeviceCredentialStore {
    private let service = "com.halivekit.apns-relay-device-v2"

    func save(
        _ credential: String,
        relayURL: URL,
        environment: APNsRelayMode,
        homeAssistantInstanceID: String,
        deviceID: String
    ) throws {
        let normalized = credential.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              let data = normalized.data(using: .utf8)
        else {
            throw HALiveKitError.invalidResponse
        }
        var query = baseQuery(
            relayURL: relayURL,
            environment: environment,
            homeAssistantInstanceID: homeAssistantInstanceID,
            deviceID: deviceID
        )
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw HALiveKitError.keychain(status)
        }
    }

    func load(
        relayURL: URL,
        environment: APNsRelayMode,
        homeAssistantInstanceID: String,
        deviceID: String
    ) throws -> String? {
        var query = baseQuery(
            relayURL: relayURL,
            environment: environment,
            homeAssistantInstanceID: homeAssistantInstanceID,
            deviceID: deviceID
        )
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess,
              let data = result as? Data,
              let credential = String(data: data, encoding: .utf8),
              credential.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil
        else {
            if status != errSecSuccess { throw HALiveKitError.keychain(status) }
            throw HALiveKitError.invalidResponse
        }
        return credential
    }

    func clear(
        relayURL: URL,
        environment: APNsRelayMode,
        homeAssistantInstanceID: String,
        deviceID: String
    ) throws {
        let status = SecItemDelete(baseQuery(
            relayURL: relayURL,
            environment: environment,
            homeAssistantInstanceID: homeAssistantInstanceID,
            deviceID: deviceID
        ) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw HALiveKitError.keychain(status)
        }
    }

    private func baseQuery(
        relayURL: URL,
        environment: APNsRelayMode,
        homeAssistantInstanceID: String,
        deviceID: String
    ) -> [String: Any] {
        let relayPort = relayURL.port.map { ":\($0)" } ?? ""
        let relayOrigin = "\(relayURL.scheme?.lowercased() ?? "https")://\(relayURL.host(percentEncoded: false)?.lowercased() ?? "unknown")\(relayPort)"
        let normalizedPath = relayURL.path
            .split(separator: "/")
            .map(String.init)
            .joined(separator: "/")
        let relayScope = normalizedPath.isEmpty ? relayOrigin : "\(relayOrigin)/\(normalizedPath)"
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "\(relayScope)|\(environment.rawValue)|\(homeAssistantInstanceID)|\(deviceID)"
        ]
    }
}

struct PendingRelayRevocation: Codable, Equatable, Identifiable {
    var relayURLString: String
    var environment: APNsRelayMode
    var homeAssistantInstanceID: String
    var deviceID: String
    var deviceCredential: String

    var id: String {
        "\(relayURLString)|\(environment.rawValue)|\(homeAssistantInstanceID)|\(deviceID)"
    }
}

/// Device-only durable storage for unregister requests that must survive logout,
/// relay setting changes, app termination, and temporary network failures.
final class RelayPendingRevocationStore {
    private let service = "com.halivekit.apns-relay-revocations-v2"
    private let account = "pending"

    func load() throws -> [PendingRelayRevocation] {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let data = result as? Data else {
            if status != errSecSuccess { throw HALiveKitError.keychain(status) }
            throw HALiveKitError.invalidResponse
        }
        return try JSONDecoder().decode([PendingRelayRevocation].self, from: data)
    }

    func enqueue(_ revocation: PendingRelayRevocation) throws {
        var records = try load()
        records.removeAll { $0.id == revocation.id }
        records.append(revocation)
        try save(records)
    }

    func remove(id: String) throws {
        var records = try load()
        records.removeAll { $0.id == id }
        try save(records)
    }

    private func save(_ records: [PendingRelayRevocation]) throws {
        if records.isEmpty {
            let status = SecItemDelete(baseQuery() as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw HALiveKitError.keychain(status)
            }
            return
        }

        let data = try JSONEncoder().encode(records)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(
            baseQuery() as CFDictionary,
            attributes as CFDictionary
        )
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw HALiveKitError.keychain(updateStatus)
        }

        var addQuery = baseQuery()
        for (key, value) in attributes {
            addQuery[key] = value
        }
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw HALiveKitError.keychain(addStatus)
        }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}
