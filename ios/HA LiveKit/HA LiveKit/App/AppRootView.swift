import SwiftUI

struct AppRootView: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(HALiveKitDefaults.hasSeenIntegrationGuideKey) private var hasSeenIntegrationGuide = false
    @State private var presentingWhatsNew = false
    @State private var hadSeenIntegrationGuideAtLaunch = UserDefaults.standard.bool(forKey: HALiveKitDefaults.hasSeenIntegrationGuideKey)
    @State private var updateService = AppUpdateService()

    var body: some View {
        Group {
            if !hasSeenIntegrationGuide {
                NavigationStack {
                    IntegrationGuideView(
                        showsPrimaryActions: true,
                        onSkip: {
                            hasSeenIntegrationGuide = true
                        },
                        onTryDemo: {
                            hasSeenIntegrationGuide = true
                            appModel.startDemoMode()
                        },
                        onConnect: {
                            hasSeenIntegrationGuide = true
                            Task { await appModel.exitDemoMode() }
                        }
                    )
                }
            } else {
                switch appModel.connectionState {
                case .connected, .demo:
                    MainTabView()
                case .connecting:
                    SplashConnectionView()
                case .disconnected, .failed:
                    OnboardingView()
                }
            }
        }
        .environment(updateService)
        .safeAreaInset(edge: .top, spacing: 0) {
            if hasSeenIntegrationGuide,
               let update = updateService.availableUpdate {
                AppUpdateBanner(update: update) {
                    updateService.remindLater()
                }
                .environment(updateService)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .task(id: hasSeenIntegrationGuide) {
            appModel.handleScenePhase(scenePhase)
            guard hasSeenIntegrationGuide else { return }
            await appModel.restoreIfPossible()
            await appModel.requestInitialNotificationPermissionIfNeeded()
            await updateService.refresh()
            evaluateWhatsNewPresentation()
        }
        .onChange(of: scenePhase) { _, newPhase in
            appModel.handleScenePhase(newPhase)
            if newPhase == .active, hasSeenIntegrationGuide {
                Task { await updateService.refresh() }
            }
        }
        .sheet(isPresented: $presentingWhatsNew) {
            WhatsNewView(version: AppRootView.currentMarketingVersion) {
                appModel.preferencesStore.update {
                    $0.lastSeenWhatsNewVersion = AppRootView.currentMarketingVersion
                }
            }
        }
        .alert(L10n.string("Error"), isPresented: lastErrorIsPresented) {
            Button("OK", role: .cancel) {
                appModel.dismissLastError()
            }
        } message: {
            Text(appModel.lastErrorMessage ?? "")
        }
    }

    static var currentMarketingVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? ""
    }

    private var lastErrorIsPresented: Binding<Bool> {
        Binding(
            get: { appModel.lastErrorMessage != nil },
            set: { isPresented in
                if !isPresented {
                    appModel.dismissLastError()
                }
            }
        )
    }

    private func evaluateWhatsNewPresentation() {
        let current = AppRootView.currentMarketingVersion
        let lastSeen = appModel.preferencesStore.preferences.lastSeenWhatsNewVersion ?? ""
        guard !current.isEmpty else { return }
        guard hasSeenIntegrationGuide else { return }
        // Suppress on a brand-new install: the integration guide is the
        // welcome experience. Only existing-user upgrades see What's New.
        guard hadSeenIntegrationGuideAtLaunch else {
            appModel.preferencesStore.update {
                $0.lastSeenWhatsNewVersion = current
            }
            return
        }
        guard current != lastSeen else { return }

        // Patch releases keep the same tour. Mark the patch as seen instead
        // of presenting the previous minor release's content again.
        if Self.releaseLine(current) == Self.releaseLine(lastSeen) {
            appModel.preferencesStore.update {
                $0.lastSeenWhatsNewVersion = current
            }
            return
        }

        presentingWhatsNew = true
    }

    private static func releaseLine(_ version: String) -> [Substring] {
        Array(version.split(separator: ".").prefix(2))
    }
}

private struct AppUpdateBanner: View {
    @Environment(\.openURL) private var openURL

    let update: AvailableAppUpdate
    let onRemindLater: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.medium) {
            HStack(alignment: .top, spacing: HALiveKitDesign.Spacing.medium) {
                Image(systemName: "arrow.down.app.fill")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(HALiveActivityTheme.homeAssistant.gradient)
                    .frame(width: 42, height: 42)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n.format("HA LiveKit %@ is ready", update.latestVersion))
                        .font(.headline)
                    Text(L10n.string("This update requires the latest HA LiveKit HACS integration. After updating the app, update HA LiveKit in HACS, restart Home Assistant, then reopen the app. Secure relay and device management require both sides to be current."))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: HALiveKitDesign.Spacing.small) {
                    actions
                }
                VStack(spacing: HALiveKitDesign.Spacing.small) {
                    actions
                }
            }
        }
        .padding(.horizontal, HALiveKitDesign.Layout.screenInset)
        .padding(.vertical, HALiveKitDesign.Spacing.medium)
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial)
        .overlay(alignment: .bottom) { Divider() }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var actions: some View {
        Button(L10n.string("Remind Later"), action: onRemindLater)
            .buttonStyle(.bordered)
            .frame(maxWidth: .infinity, minHeight: HALiveKitDesign.Layout.minimumTapTarget)

        Button {
            openURL(AppUpdateService.appStoreURL)
        } label: {
            Label(L10n.string("Update"), systemImage: "arrow.up.right.square")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .frame(maxWidth: .infinity, minHeight: HALiveKitDesign.Layout.minimumTapTarget)
    }
}

private struct MainTabView: View {
    var body: some View {
        TabView {
            DashboardView()
                .tabItem {
                    Label("Home", systemImage: "house.fill")
                }

            NavigationStack {
                EntityPickerView()
            }
                .tabItem {
                    Label("Create", systemImage: "plus.square.fill")
                }

            DiagnosticsView()
                .tabItem {
                    Label("Health", systemImage: "heart.text.square.fill")
                }

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gearshape.fill")
                }
        }
        .tint(HALiveActivityTheme.homeAssistant.accentColor)
    }
}

private struct SplashConnectionView: View {
    var body: some View {
        ZStack {
            PremiumBackground()
            VStack(spacing: 16) {
                ProgressView()
                    .controlSize(.large)
                Text("Connecting to Home Assistant")
                    .font(.headline)
                Text("Validating your token. Entity sync and live events continue after Dashboard opens.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(HALiveKitDesign.Spacing.large)
            .frame(maxWidth: 480)
            .glassPanel()
            .padding(HALiveKitDesign.Layout.screenInset)
        }
    }
}
