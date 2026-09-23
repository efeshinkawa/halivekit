import Foundation

/// Device-local, tenant-scoped entity cache used by the app and App Intents.
///
/// Encoding and disk writes run on a dedicated serial queue so a large Home
/// Assistant installation cannot stall SwiftUI's main actor. The active scope
/// is persisted separately, preventing one HA connection from reading another
/// connection's names or entity identifiers.
final class HAEntityCacheStore: @unchecked Sendable {
    private struct Envelope: Codable {
        static let currentSchemaVersion = 2

        var schemaVersion: Int
        var updatedAt: Date
        var entities: [HAEntity]
    }

    private let defaults: UserDefaults
    private let legacyKey = "haLiveKitEntityCache"
    private let scopedKeyPrefix = "haLiveKitEntityCache.v2."
    private let activeScopeKey = "haLiveKitEntityCacheActiveScope.v2"
    private let maximumCacheBytes = 16 * 1024 * 1024
    private let maximumCacheAge: TimeInterval = 7 * 24 * 60 * 60
    private let queue = DispatchQueue(label: "com.halivekit.entity-cache", qos: .utility)
    private var memoryScope: String?
    private var memoryEntities: [HAEntity]?
    private var memoryIndex: [String: HAEntity]?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func activateScope(_ scope: String?) {
        queue.sync {
            let normalized = Self.normalizedScope(scope)
            if let normalized {
                defaults.set(normalized, forKey: activeScopeKey)
            } else {
                defaults.removeObject(forKey: activeScopeKey)
            }
            guard normalized != memoryScope else { return }
            memoryScope = nil
            memoryEntities = nil
            memoryIndex = nil
        }
    }

    func load() -> [HAEntity] {
        queue.sync {
            guard let scope = activeScopeLocked() else { return [] }
            if memoryScope == scope, let memoryEntities {
                return memoryEntities
            }

            let scopedKey = key(for: scope)
            let usedLegacyValue = defaults.data(forKey: scopedKey) == nil
            guard let data = defaults.data(forKey: scopedKey)
                    ?? defaults.data(forKey: legacyKey)
            else {
                return []
            }
            guard data.count <= maximumCacheBytes else {
                defaults.removeObject(forKey: usedLegacyValue ? legacyKey : scopedKey)
                return []
            }

            let decoder = JSONDecoder()
            let decoded: [HAEntity]
            if let envelope = try? decoder.decode(Envelope.self, from: data),
               envelope.schemaVersion == Envelope.currentSchemaVersion {
                guard Date.now.timeIntervalSince(envelope.updatedAt) <= maximumCacheAge else {
                    defaults.removeObject(forKey: scopedKey)
                    return []
                }
                decoded = envelope.entities
            } else if let legacyEnvelope = try? decoder.decode(LegacyEnvelope.self, from: data) {
                decoded = legacyEnvelope.entities
            } else if let legacy = try? decoder.decode([HAEntity].self, from: data) {
                decoded = legacy
            } else {
                defaults.removeObject(forKey: usedLegacyValue ? legacyKey : scopedKey)
                return []
            }

            let normalized = Self.normalized(decoded)
            setMemory(normalized, scope: scope)
            if usedLegacyValue {
                persistLocked(normalized, scope: scope)
                defaults.removeObject(forKey: legacyKey)
            }
            return normalized
        }
    }

    func save(_ entities: [HAEntity]) async {
        let scope = queue.sync { activeScopeLocked() }
        guard let scope else { return }
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                let normalized = Self.normalized(entities)
                if memoryScope != scope || normalized != memoryEntities {
                    persistLocked(normalized, scope: scope)
                }
                continuation.resume()
            }
        }
    }

    func entity(withID entityID: String) -> HAEntity? {
        queue.sync {
            guard let scope = activeScopeLocked() else { return nil }
            if memoryScope != scope || memoryIndex == nil {
                _ = loadLocked(scope: scope)
            }
            return memoryIndex?[entityID]
        }
    }

    func clearActiveScope() async {
        let scope = queue.sync { activeScopeLocked() }
        guard let scope else { return }
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                defaults.removeObject(forKey: key(for: scope))
                if memoryScope == scope {
                    memoryScope = nil
                    memoryEntities = nil
                    memoryIndex = nil
                }
                continuation.resume()
            }
        }
    }

    func clearAll() async {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                defaults.removeObject(forKey: legacyKey)
                defaults.removeObject(forKey: activeScopeKey)
                for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(scopedKeyPrefix) {
                    defaults.removeObject(forKey: key)
                }
                memoryScope = nil
                memoryEntities = nil
                memoryIndex = nil
                continuation.resume()
            }
        }
    }

    private struct LegacyEnvelope: Codable {
        var schemaVersion: Int
        var updatedAt: Date
        var entities: [HAEntity]
    }

    private func loadLocked(scope: String) -> [HAEntity] {
        if memoryScope == scope, let memoryEntities {
            return memoryEntities
        }
        guard let data = defaults.data(forKey: key(for: scope)),
              data.count <= maximumCacheBytes,
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              envelope.schemaVersion == Envelope.currentSchemaVersion,
              Date.now.timeIntervalSince(envelope.updatedAt) <= maximumCacheAge
        else {
            return []
        }
        let normalized = Self.normalized(envelope.entities)
        setMemory(normalized, scope: scope)
        return normalized
    }

    private func persistLocked(_ entities: [HAEntity], scope: String) {
        let envelope = Envelope(
            schemaVersion: Envelope.currentSchemaVersion,
            updatedAt: .now,
            entities: entities
        )
        guard let data = try? JSONEncoder().encode(envelope),
              data.count <= maximumCacheBytes
        else { return }
        defaults.set(data, forKey: key(for: scope))
        setMemory(entities, scope: scope)
    }

    private func setMemory(_ entities: [HAEntity], scope: String) {
        memoryScope = scope
        memoryEntities = entities
        memoryIndex = Dictionary(uniqueKeysWithValues: entities.map { ($0.entityId, $0) })
    }

    private func activeScopeLocked() -> String? {
        Self.normalizedScope(defaults.string(forKey: activeScopeKey))
    }

    private func key(for scope: String) -> String {
        scopedKeyPrefix + scope
    }

    private static func normalizedScope(_ scope: String?) -> String? {
        let value = scope?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard value.range(of: #"^[A-Za-z0-9_-]{1,80}$"#, options: .regularExpression) != nil else {
            return nil
        }
        return value
    }

    private static func normalized(_ entities: [HAEntity]) -> [HAEntity] {
        var byID: [String: HAEntity] = [:]
        byID.reserveCapacity(entities.count)
        for entity in entities where !entity.entityId.isEmpty {
            byID[entity.entityId] = entity
        }
        return byID.values.sorted {
            $0.entityId.localizedStandardCompare($1.entityId) == .orderedAscending
        }
    }
}
