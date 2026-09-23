import Foundation

/// Non-sensitive user preferences that can optionally be mirrored to iCloud.
///
/// Anything that could compromise a Home Assistant instance — tokens, relay
/// secrets, registration secrets, APNs tokens, push tokens, internal/external
/// URLs, diagnostics or logs — is intentionally NOT part of this struct and
/// stays device-local in the existing Keychain / UserDefaults stores.
struct AppPreferences: Codable, Equatable {
    static let currentSchemaVersion: Int = 1

    var schemaVersion: Int
    var displayName: String?
    var apnsRelayMode: String?
    var useManagedRelay: Bool?
    var favoriteEntityIds: [String]
    var liveActivityPresetsJSON: String?
    var importantNoticesOptedIn: Bool
    var lastSeenWhatsNewVersion: String?
    var uiPreferencesJSON: String?

    static let empty = AppPreferences(
        schemaVersion: AppPreferences.currentSchemaVersion,
        displayName: nil,
        apnsRelayMode: nil,
        useManagedRelay: nil,
        favoriteEntityIds: [],
        liveActivityPresetsJSON: nil,
        importantNoticesOptedIn: false,
        lastSeenWhatsNewVersion: nil,
        uiPreferencesJSON: nil
    )

    func merging(remote: AppPreferences) -> AppPreferences {
        var merged = self
        merged.schemaVersion = max(self.schemaVersion, remote.schemaVersion)
        merged.displayName = remote.displayName ?? self.displayName
        merged.apnsRelayMode = remote.apnsRelayMode ?? self.apnsRelayMode
        merged.useManagedRelay = remote.useManagedRelay ?? self.useManagedRelay
        merged.favoriteEntityIds = remote.favoriteEntityIds.isEmpty ? self.favoriteEntityIds : remote.favoriteEntityIds
        merged.liveActivityPresetsJSON = remote.liveActivityPresetsJSON ?? self.liveActivityPresetsJSON
        merged.importantNoticesOptedIn = remote.importantNoticesOptedIn || self.importantNoticesOptedIn
        merged.lastSeenWhatsNewVersion = remote.lastSeenWhatsNewVersion ?? self.lastSeenWhatsNewVersion
        merged.uiPreferencesJSON = remote.uiPreferencesJSON ?? self.uiPreferencesJSON
        return merged
    }
}
