import Foundation
import Observation

/// User-visible status of the optional iCloud sync layer.
enum CloudKitSyncStatus: Equatable {
    case off
    case unavailable
    case signedOut
    /// Reserved — the OS does not expose a clear "restricted" state for
    /// `NSUbiquitousKeyValueStore`, but the case is kept so call sites
    /// remain stable. Equivalent UX to `.signedOut`.
    case restricted
    case syncing
    case on
    case error(String)

    var isOn: Bool {
        if case .on = self { return true }
        return false
    }
}

/// Optional iCloud preferences mirror for non-sensitive `AppPreferences`.
///
/// Backing store: `NSUbiquitousKeyValueStore` (iCloud key-value store).
///
/// SAFETY:
/// - Lives entirely on top of `AppPreferencesStore`. Local UserDefaults
///   remains the source of truth. iCloud failures never block UI or
///   change local state.
/// - Writes ONLY the JSON-encoded `AppPreferences` blob. Tokens, relay
///   secrets, registration secrets, APNs tokens, push tokens,
///   internal/external URLs, diagnostics and logs are never touched.
/// - If iCloud is signed out, unavailable, or the user has disabled
///   the sync toggle, callers see local-only behavior identical to
///   the 1.0.2 baseline.
///
/// We deliberately keep the type name `CloudKitPreferencesMirror` so
/// the rest of the app (AppModel, SettingsView) doesn't need to
/// re-wire its references after switching the backing store from a
/// custom CKDatabase record (which required production schema
/// deployment) to the OS-managed key-value store.
@MainActor
final class CloudKitPreferencesMirror {
    nonisolated private static let payloadKey = "haLiveKitAppPreferencesPayload.v1"

    private(set) var status: CloudKitSyncStatus = .off
    var onStatusChanged: ((CloudKitSyncStatus) -> Void)?
    var onRemoteSnapshot: ((AppPreferences) -> Void)?

    private let kvStore: NSUbiquitousKeyValueStore
    private var changeObserver: NSObjectProtocol?

    init() {
        self.kvStore = .default
    }

    deinit {
        if let changeObserver {
            NotificationCenter.default.removeObserver(changeObserver)
        }
    }

    /// Begin sync. Safe to call repeatedly. If iCloud is unavailable for
    /// any reason this resolves to a non-fatal status update.
    func enable(currentLocal: AppPreferences) {
        guard FileManager.default.ubiquityIdentityToken != nil else {
            setStatus(.signedOut)
            return
        }

        setStatus(.syncing)

        // Subscribe to remote-change notifications so other devices'
        // writes flow back into the local store automatically.
        if changeObserver == nil {
            changeObserver = NotificationCenter.default.addObserver(
                forName: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
                object: kvStore,
                queue: .main
            ) { [weak self] note in
                Task { @MainActor in
                    self?.handleExternalChange(notification: note)
                }
            }
        }

        // Ask the OS to refresh first so we see any remote snapshot.
        let didStart = kvStore.synchronize()
        guard didStart else {
            setStatus(.unavailable)
            return
        }

        if let remote = readRemoteSnapshot() {
            onRemoteSnapshot?(remote)
        }
        writeLocalSnapshot(currentLocal.merging(remote: readRemoteSnapshot() ?? .empty))
        setStatus(.on)
    }

    /// Stop further iCloud writes/reads. Local state is retained.
    func disable() {
        if let changeObserver {
            NotificationCenter.default.removeObserver(changeObserver)
            self.changeObserver = nil
        }
        setStatus(.off)
    }

    /// Push the latest local snapshot to iCloud. Non-fatal on errors.
    func push(_ local: AppPreferences) {
        guard status.isOn else { return }
        writeLocalSnapshot(local)
    }

    /// Re-fetch the remote record and bubble it up via `onRemoteSnapshot`.
    func pull() {
        guard status.isOn else { return }
        _ = kvStore.synchronize()
        if let remote = readRemoteSnapshot() {
            onRemoteSnapshot?(remote)
        }
    }

    /// Account swap path — drop cache and re-evaluate availability.
    func resetForAccountChange(currentLocal: AppPreferences) {
        disable()
        enable(currentLocal: currentLocal)
    }

    // MARK: - Internals

    private func writeLocalSnapshot(_ preferences: AppPreferences) {
        guard let data = try? JSONEncoder().encode(preferences) else { return }
        kvStore.set(data, forKey: Self.payloadKey)
        _ = kvStore.synchronize()
    }

    private func readRemoteSnapshot() -> AppPreferences? {
        guard let data = kvStore.data(forKey: Self.payloadKey) else { return nil }
        return try? JSONDecoder().decode(AppPreferences.self, from: data)
    }

    private func handleExternalChange(notification: Notification) {
        guard status.isOn else { return }
        guard let userInfo = notification.userInfo,
              let reason = userInfo[NSUbiquitousKeyValueStoreChangeReasonKey] as? Int else {
            return
        }
        switch reason {
        case NSUbiquitousKeyValueStoreServerChange,
             NSUbiquitousKeyValueStoreInitialSyncChange:
            if let remote = readRemoteSnapshot() {
                onRemoteSnapshot?(remote)
            }
        case NSUbiquitousKeyValueStoreAccountChange:
            // Account changed — caller (AppModel) handles full reset via
            // its NSUbiquityIdentityDidChange observer.
            break
        case NSUbiquitousKeyValueStoreQuotaViolationChange:
            // 1 MB total quota; we only store a tiny JSON blob, so this
            // realistically never fires. Surface a user-friendly message.
            setStatus(.error(L10n.string("iCloud storage is full.")))
        default:
            break
        }
    }

    private func setStatus(_ next: CloudKitSyncStatus) {
        guard status != next else { return }
        status = next
        onStatusChanged?(next)
    }
}
