import SwiftUI

struct WhatsNewView: View {
    @Environment(\.dismiss) private var dismiss

    let version: String
    let onAcknowledge: () -> Void

    var body: some View {
        ZStack {
            PremiumBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    highlights
                    importantNoticesCard
                    privacyNote
                    actions
                }
                .padding(20)
                .padding(.bottom, 24)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
        }
        .tint(HALiveActivityTheme.homeAssistant.accentColor)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 14) {
                Image(systemName: "sparkles")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(HALiveActivityTheme.homeAssistant.gradient)
                    .frame(width: 58, height: 58)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))

                VStack(alignment: .leading, spacing: 6) {
                    Text(L10n.format("What's new in %@", version))
                        .font(.system(.title2, design: .rounded, weight: .bold))
                    Text(L10n.string("A short tour of this update."))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var highlights: some View {
        VStack(alignment: .leading, spacing: 12) {
            highlight(
                systemImage: "lightbulb.max.fill",
                title: "Control from Live Activities",
                body: "Optionally add secure On and Off buttons for lights, switches and input booleans, then control them from the Lock Screen or Dynamic Island without opening the app."
            )
            highlight(
                systemImage: "rectangle.grid.2x2.fill",
                title: "More Quick Presets",
                body: "Start compact, tap Show More for nine purpose-built presets, then generate safe Home Assistant YAML from the same builder."
            )
            highlight(
                systemImage: "heart.text.square.fill",
                title: "A cleaner Health Center",
                body: "Compatibility, relay devices and actionable errors stay easy to scan. Redacted Debug Logs now open on their own page."
            )
            highlight(
                systemImage: "bell.badge.fill",
                title: "Important Notices",
                body: "The app can now check a strict plain-text compatibility feed and the official App Store listing without sending Home Assistant or relay data."
            )
        }
        .padding(18)
        .glassPanel()
    }

    private var importantNoticesCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(L10n.string("Important Notices are ready"), systemImage: "checkmark.shield.fill")
                .font(.subheadline.weight(.semibold))

            Text(L10n.string("Turn them on in Settings for rare local alerts about critical compatibility or reliability changes. Notices are plain text, use fixed safe actions, and never include your API token, APNs token or relay credentials."))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .glassPanel()
    }

    private var privacyNote: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(L10n.string("Your token stays on this device"), systemImage: "lock.shield")
                .font(.subheadline.weight(.semibold))
            Text(L10n.string("HA LiveKit never writes your Home Assistant token, relay secrets or private URLs to iCloud."))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .glassPanel()
    }

    private var actions: some View {
        Button {
            onAcknowledge()
            dismiss()
        } label: {
            Label(L10n.string("Got it"), systemImage: "checkmark.circle")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 38)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
    }

    private func highlight(systemImage: String, title: String, body: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .foregroundStyle(HALiveActivityTheme.homeAssistant.gradient)
                .frame(width: 38, height: 38)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))

            VStack(alignment: .leading, spacing: 4) {
                Text(L10n.string(title))
                    .font(.headline)
                Text(L10n.string(body))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

#if DEBUG
#Preview("What's New") {
    WhatsNewView(version: "2.1", onAcknowledge: {})
}
#endif
