import Foundation
import ObjectiveC.runtime

/// Lightweight in-app language override that layers on top of iOS's built-in
/// per-app localization. We deliberately keep iOS's standard language flow
/// working: when `selected` is `.systemDefault`, the OS picks the locale and
/// `Bundle.main.localizedString` behaves exactly as before. When the user
/// picks a specific language, we install a custom `Bundle` subclass on
/// `Bundle.main` so `NSLocalizedString` resolves the user's preference.
enum AppLanguageManager {
    /// Identifier returned by `selectedCode` when the user wants iOS to pick.
    static let systemDefaultCode = ""

    /// All locales currently shipped in the app bundle. Order matters for the
    /// Settings picker.
    static let supportedCodes: [String] = [
        "cs", "da", "de", "en", "es", "fi", "fr", "it",
        "ja", "nl", "no", "pl", "pt", "sv", "tr"
    ]

    static let defaultsKey = "haLiveKitAppLanguageOverride"

    /// Currently effective override (`""` means "follow iOS"). Reads
    /// from `UserDefaults.standard`.
    static var selectedCode: String {
        UserDefaults.standard.string(forKey: defaultsKey) ?? systemDefaultCode
    }

    /// Persist the user's choice and swap the `Bundle.main` class so the
    /// new locale takes effect for subsequently rendered views. SwiftUI
    /// will not retroactively re-render already-displayed strings; the
    /// Settings UI shows a "may need to restart" note when this matters.
    static func apply(code: String?) {
        let normalized = (code ?? "").trimmingCharacters(in: .whitespaces)
        if normalized.isEmpty {
            UserDefaults.standard.removeObject(forKey: defaultsKey)
        } else {
            UserDefaults.standard.set(normalized, forKey: defaultsKey)
        }
        installSwizzleIfNeeded()
    }

    /// Called once at app startup so that even a freshly-launched process
    /// sees the saved language override before any UI is rendered.
    static func installAtLaunch() {
        installSwizzleIfNeeded()
    }

    private static var didInstall = false

    private static func installSwizzleIfNeeded() {
        guard !didInstall else { return }
        didInstall = true
        object_setClass(Bundle.main, AppLanguageBundle.self)
    }
}

/// Custom `Bundle` subclass used as the runtime class of `Bundle.main`
/// when the user has chosen a language override. We deliberately do NOT
/// override anything except `localizedString(forKey:value:table:)` so
/// every other Bundle behavior (paths, resources, code signing, etc.)
/// is unchanged.
final class AppLanguageBundle: Bundle, @unchecked Sendable {
    override func localizedString(forKey key: String, value: String?, table tableName: String?) -> String {
        let code = AppLanguageManager.selectedCode
        guard !code.isEmpty,
              let path = Bundle.main.path(forResource: code, ofType: "lproj"),
              let localized = Bundle(path: path)
        else {
            return super.localizedString(forKey: key, value: value, table: tableName)
        }
        return localized.localizedString(forKey: key, value: value, table: tableName)
    }
}
