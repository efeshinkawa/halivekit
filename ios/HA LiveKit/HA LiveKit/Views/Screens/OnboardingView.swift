import SwiftUI

struct OnboardingView: View {
    @Environment(AppModel.self) private var appModel
    @AppStorage(HALiveKitDefaults.hasSeenIntegrationGuideKey) private var hasSeenIntegrationGuide = false

    @State private var baseURL = HomeAssistantURLNormalizer.defaultLocalAddress
    @State private var homeName = ""
    @State private var token = ""
    @State private var isTesting = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            PremiumBackground()

            ScrollView {
                AdaptiveScreenContent {
                    VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.large) {
                        header
                        sampleActivity
                        modeOptions
                        connectionForm
                        privacyNote
                    }
                    .frame(maxWidth: 560)
                    .padding(.top, HALiveKitDesign.Spacing.standard)
                }
            }
        }
        .tint(HALiveActivityTheme.homeAssistant.accentColor)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center, spacing: 14) {
                Image(systemName: "livephoto")
                    .font(.system(size: 36, weight: .semibold))
                    .foregroundStyle(HALiveActivityTheme.homeAssistant.gradient)
                    .frame(width: 62, height: 62)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.card, style: .continuous))

                VStack(alignment: .leading, spacing: 6) {
                    Text("HA LiveKit")
                        .font(.system(.largeTitle, design: .rounded, weight: .bold))
                    Text("Bring Home Assistant states to your Lock Screen and Dynamic Island.")
                        .font(.headline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: HALiveKitDesign.Spacing.small) {
                    StatusPill(title: "Native", systemImage: "iphone", color: HALiveActivityTheme.homeAssistant.accentColor)
                    StatusPill(title: "Keychain", systemImage: "key.fill", color: .green)
                    StatusPill(title: "Local first", systemImage: "house.fill", color: .orange)
                }
            }
        }
    }

    private var sampleActivity: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "washer.fill")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(HALiveActivityTheme.homeAssistant.gradient)
                    .frame(width: 46, height: 46)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text("Laundry")
                        .font(.headline)
                    Text("28 min remaining")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Text("62%")
                    .font(.title3.weight(.bold))
            }

            ProgressView(value: 0.62)
                .tint(HALiveActivityTheme.homeAssistant.accentColor)
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var connectionForm: some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionHeader(title: "Connect Home Assistant", subtitle: "Use your local address or paste your Nabu Casa URL.")

            VStack(alignment: .leading, spacing: 12) {
                FormFieldLabel(title: "Home Assistant URL")
                TextField(HomeAssistantURLNormalizer.defaultLocalAddress, text: $baseURL)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

                FormFieldLabel(title: "Home name")
                TextField("My Home", text: $homeName)
                    .textInputAutocapitalization(.words)
                    .textContentType(.name)
                    .padding(12)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

                FormFieldLabel(title: "Long-Lived Access Token")
                SecureField("Long-Lived Access Token", text: $token)
                    .textInputAutocapitalization(.never)
                    .textContentType(.password)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

                if let errorMessage {
                    NoticeBanner(title: "Connection failed", message: errorMessage, tone: .error)
                } else if case .failed(let message) = appModel.connectionState {
                    NoticeBanner(title: "Connection failed", message: message, tone: .error)
                }

                Button {
                    Task { await testConnection() }
                } label: {
                    Label(isTesting ? "Connecting..." : "Connect Home Assistant", systemImage: "checkmark.seal.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
                .disabled(isTesting)
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var modeOptions: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Choose a mode", subtitle: "Connect your own Home Assistant or explore a local demo home.")

            Button {
                baseURL = HomeAssistantURLNormalizer.defaultLocalAddress
            } label: {
                optionRow(
                    title: "Connect Home Assistant",
                    subtitle: "Use a local, reverse proxy or Nabu Casa URL with your token.",
                    iconName: "house.and.flag.fill",
                    accent: HALiveActivityTheme.homeAssistant.accentColor
                )
            }
            .buttonStyle(.plain)

            Button {
                hasSeenIntegrationGuide = true
                appModel.startDemoMode()
            } label: {
                optionRow(
                    title: "Try Demo Home",
                    subtitle: "No URL or token needed. Simulate devices and Live Activities locally.",
                    iconName: "play.circle.fill",
                    accent: .orange
                )
            }
            .buttonStyle(.plain)
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private func optionRow(title: String, subtitle: String, iconName: String, accent: Color) -> some View {
        HStack(spacing: 12) {
            Image(systemName: iconName)
                .font(.title3.weight(.semibold))
                .foregroundStyle(accent)
                .frame(width: 42, height: 42)
                .background(accent.opacity(0.14), in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

            VStack(alignment: .leading, spacing: 4) {
                Text(L10n.string(title))
                    .font(.headline)
                Text(L10n.string(subtitle))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(12)
        .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var privacyNote: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "key.fill")
                .foregroundStyle(.secondary)
            Text("Your token is stored in the iOS Keychain. It is never written to UserDefaults.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 4)
    }

    private func testConnection() async {
        isTesting = true
        errorMessage = nil
        defer { isTesting = false }

        do {
            try await appModel.connect(
                baseURLString: baseURL,
                token: token,
                displayName: homeName,
                offerIntegrationGuide: false
            )
            hasSeenIntegrationGuide = true
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

#Preview {
    OnboardingView()
        .environment(AppModel())
}
