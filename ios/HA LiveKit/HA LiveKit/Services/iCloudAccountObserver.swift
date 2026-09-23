import Foundation

/// Watches for iCloud account swaps so the CloudKit mirror can drop its
/// in-memory cache before pulling a new account's preferences. This does
/// NOT enable CloudKit on its own — it just emits notifications.
@MainActor
final class iCloudAccountObserver {
    var onAccountChanged: (() -> Void)?

    private var token: NSObjectProtocol?

    init() {
        token = NotificationCenter.default.addObserver(
            forName: .NSUbiquityIdentityDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.onAccountChanged?()
            }
        }
    }

    deinit {
        if let token {
            NotificationCenter.default.removeObserver(token)
        }
    }
}
