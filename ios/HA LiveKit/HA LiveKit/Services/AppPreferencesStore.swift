import Foundation
import Observation

/// Local-first store for non-sensitive `AppPreferences`.
///
/// Backing layer: `UserDefaults.standard`. The Keychain and existing relay-secret
/// stores remain untouched. CloudKit mirroring is opt-in and layered on top of
/// this store via `CloudKitPreferencesMirror`; if iCloud is unavailable or
/// disabled, this store keeps working exactly like 1.0.2 local-only behavior.
@MainActor
@Observable
final class AppPreferencesStore {
    /// Snapshot is published; views observe `preferences` directly.
    private(set) var preferences: AppPreferences

    /// True once `iCloudSyncEnabled` was flipped on by the user. Optional CloudKit
    /// mirroring runs only while this is true and the iCloud account is healthy.
    var iCloudSyncEnabled: Bool {
        didSet {
            defaults.set(iCloudSyncEnabled, forKey: Keys.iCloudSyncEnabled)
        }
    }

    var onPreferencesChanged: ((AppPreferences) -> Void)?

    private let defaults: UserDefaults
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.preferences = Self.load(defaults: defaults)
        self.iCloudSyncEnabled = defaults.bool(forKey: Keys.iCloudSyncEnabled)
    }

    private static func load(defaults: UserDefaults) -> AppPreferences {
        if let data = defaults.data(forKey: Keys.preferencesBlob),
           let decoded = try? JSONDecoder().decode(AppPreferences.self, from: data) {
            return decoded
        }
        return AppPreferences.empty
    }

    /// Apply a mutation and persist atomically. The mutation must be cheap and
    /// non-throwing; this method is intentionally minimal.
    func update(_ mutate: (inout AppPreferences) -> Void) {
        var next = preferences
        mutate(&next)
        guard next != preferences else { return }
        preferences = next
        persist()
        onPreferencesChanged?(next)
    }

    /// Used by the CloudKit mirror to apply a remote snapshot without re-broadcasting.
    func applyRemoteSnapshot(_ remote: AppPreferences) {
        let merged = preferences.merging(remote: remote)
        guard merged != preferences else { return }
        preferences = merged
        persist()
    }

    private func persist() {
        guard let data = try? encoder.encode(preferences) else { return }
        defaults.set(data, forKey: Keys.preferencesBlob)
    }

    enum Keys {
        static let preferencesBlob = "haLiveKitAppPreferences.v1"
        static let iCloudSyncEnabled = "haLiveKitiCloudSyncEnabled"
    }
}
