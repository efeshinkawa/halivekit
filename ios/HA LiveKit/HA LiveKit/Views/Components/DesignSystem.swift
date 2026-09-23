import SwiftUI
import UIKit

enum HALiveKitDesign {
    enum Spacing {
        static let xSmall: CGFloat = 4
        static let small: CGFloat = 8
        static let medium: CGFloat = 12
        static let standard: CGFloat = 16
        static let large: CGFloat = 24
        static let xLarge: CGFloat = 32
    }

    enum Radius {
        static let control: CGFloat = 12
        static let card: CGFloat = 18
        static let feature: CGFloat = 24
    }

    enum Layout {
        static let minimumTapTarget: CGFloat = 44
        static let screenInset: CGFloat = 16
        static let maximumContentWidth: CGFloat = 760
        static let floatingTabBarContentClearance: CGFloat = 80
    }

    enum Motion {
        static let quick = Animation.easeOut(duration: 0.18)
        static let standard = Animation.easeInOut(duration: 0.26)
    }
}

struct PremiumBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            Color(uiColor: .systemGroupedBackground)

            LinearGradient(
                colors: backgroundColors,
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            RadialGradient(
                colors: [
                    HALiveActivityTheme.homeAssistant.accentColor.opacity(colorScheme == .dark ? 0.22 : 0.12),
                    .clear
                ],
                center: .topTrailing,
                startRadius: 12,
                endRadius: 420
            )
        }
        .ignoresSafeArea()
    }

    private var backgroundColors: [Color] {
        if colorScheme == .dark {
            return [
                Color(red: 0.025, green: 0.075, blue: 0.12),
                Color(red: 0.035, green: 0.16, blue: 0.22),
                Color(red: 0.06, green: 0.075, blue: 0.09)
            ]
        }

        return [
            Color(red: 0.93, green: 0.98, blue: 1.0),
            Color(uiColor: .systemGroupedBackground),
            Color(red: 0.91, green: 0.95, blue: 0.97)
        ]
    }
}

struct AdaptiveScreenContent<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .frame(maxWidth: HALiveKitDesign.Layout.maximumContentWidth)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, HALiveKitDesign.Layout.screenInset)
            .padding(.bottom, HALiveKitDesign.Spacing.large)
    }
}

struct SectionHeader: View {
    var title: String
    var subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L10n.string(title))
                .font(.headline)
            if let subtitle {
                Text(L10n.string(subtitle))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

struct FormFieldLabel: View {
    let title: String

    var body: some View {
        Text(L10n.string(title))
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct EmptyStateView: View {
    var iconName: String
    var title: String
    var message: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: iconName)
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(.tint)
                .frame(width: 56, height: 56)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))
            Text(L10n.string(title))
                .font(.headline)
            Text(L10n.string(message))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(22)
        .frame(maxWidth: .infinity)
        .glassPanel()
        .accessibilityElement(children: .combine)
    }
}

struct NoticeBanner: View {
    enum Tone {
        case info
        case warning
        case error

        var color: Color {
            switch self {
            case .info: HALiveActivityTheme.homeAssistant.accentColor
            case .warning: .orange
            case .error: .red
            }
        }

        var iconName: String {
            switch self {
            case .info: "info.circle.fill"
            case .warning: "exclamationmark.triangle.fill"
            case .error: "xmark.octagon.fill"
            }
        }
    }

    var title: String
    var message: String
    var tone: Tone = .info

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: tone.iconName)
                .foregroundStyle(tone.color)
                .font(.headline)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 3) {
                Text(L10n.string(title))
                    .font(.footnote.weight(.semibold))
                Text(L10n.string(message))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(tone.color.opacity(0.11), in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous)
                .stroke(tone.color.opacity(0.20), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

struct StatusPill: View {
    var title: String
    var systemImage: String
    var color: Color

    var body: some View {
        Label {
            Text(L10n.string(title))
        } icon: {
            Image(systemName: systemImage)
        }
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: Capsule())
            .accessibilityElement(children: .combine)
    }
}

extension View {
    func glassPanel() -> some View {
        modifier(HALiveKitSurfaceModifier())
    }
}

private struct HALiveKitSurfaceModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .background(
                panelFill,
                in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.card, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.card, style: .continuous)
                    .strokeBorder(borderColor, lineWidth: 1)
            }
            .shadow(
                color: .black.opacity(colorScheme == .dark ? 0.20 : 0.08),
                radius: colorScheme == .dark ? 18 : 12,
                x: 0,
                y: 8
            )
    }

    private var panelFill: AnyShapeStyle {
        if reduceTransparency {
            return AnyShapeStyle(Color(uiColor: .secondarySystemGroupedBackground))
        }
        return AnyShapeStyle(.regularMaterial)
    }

    private var borderColor: Color {
        colorScheme == .dark ? .white.opacity(0.14) : .black.opacity(0.08)
    }
}

extension Date {
    var relativeShort: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: self, relativeTo: .now)
    }
}

#if DEBUG
#Preview("Premium Background") {
    PremiumBackground()
}

#Preview("Section Header") {
    ZStack {
        PremiumBackground()
        VStack(spacing: 16) {
            SectionHeader(title: "Health Checklist", subtitle: "An honest summary of your setup.")
            SectionHeader(title: "Connection")
        }
        .padding(16)
        .glassPanel()
        .padding(16)
    }
}

#Preview("Notice Banner") {
    ZStack {
        PremiumBackground()
        VStack(spacing: 12) {
            NoticeBanner(
                title: "Demo Home",
                message: "12 simulated entities are available for previewing Live Activities.",
                tone: .info
            )
            NoticeBanner(
                title: "Foreground updates paused",
                message: "REST connected, WebSocket disconnected. Background relay will retry.",
                tone: .warning
            )
            NoticeBanner(
                title: "Connection failed",
                message: "Could not reach the demo Home Assistant URL.",
                tone: .error
            )
        }
        .padding(16)
    }
}

#Preview("Status Pill") {
    ZStack {
        PremiumBackground()
        HStack(spacing: 8) {
            StatusPill(title: "Native", systemImage: "iphone", color: HALiveActivityTheme.homeAssistant.accentColor)
            StatusPill(title: "Keychain", systemImage: "key.fill", color: .green)
            StatusPill(title: "Local first", systemImage: "house.fill", color: .orange)
        }
        .padding(16)
    }
}

#Preview("Empty State") {
    ZStack {
        PremiumBackground()
        EmptyStateView(
            iconName: "livephoto.slash",
            title: "Nothing live yet",
            message: "Pick an entity to start showing Home Assistant state on the Lock Screen."
        )
        .padding(16)
    }
}
#endif
