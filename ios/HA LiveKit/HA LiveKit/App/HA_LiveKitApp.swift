import SwiftUI

@main
struct HA_LiveKitApp: App {
    @State private var appModel: AppModel
    @AppStorage(AppLanguageManager.defaultsKey) private var appLanguageCode = AppLanguageManager.systemDefaultCode

    init() {
        AppLanguageManager.installAtLaunch()
        _appModel = State(wrappedValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            AppRootView()
                .environment(appModel)
                .environment(\.locale, selectedLocale)
        }
    }

    private var selectedLocale: Locale {
        appLanguageCode.isEmpty ? .autoupdatingCurrent : Locale(identifier: appLanguageCode)
    }
}
