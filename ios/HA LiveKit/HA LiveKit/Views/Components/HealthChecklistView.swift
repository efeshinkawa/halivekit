import SwiftUI

struct HealthChecklistView: View {
    let checklist: HealthChecklist

    var body: some View {
        VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.medium) {
            SectionHeader(
                title: "Health Checklist",
                subtitle: "An honest summary. Status only shows Ready when the app can actually verify the condition."
            )

            VStack(spacing: 0) {
                ForEach(checklist.rows) { row in
                    HealthChecklistRowView(row: row)
                    if row.id != checklist.rows.last?.id {
                        Divider().opacity(0.4)
                    }
                }
            }
            .padding(.vertical, 4)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }
}

private struct HealthChecklistRowView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let row: HealthChecklistRow

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(color)
                .frame(width: 22, height: 22)
                .padding(.top, 1)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 6) {
                header

                if let detail = row.detail, !detail.isEmpty {
                    Text(L10n.string(detail))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
        .accessibilityElement(children: .combine)
    }

    private var title: some View {
        Text(L10n.string(row.title))
            .font(.subheadline.weight(.semibold))
    }

    @ViewBuilder
    private var header: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                title
                status
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                title
                    .layoutPriority(1)

                Spacer(minLength: 8)

                status
                    .multilineTextAlignment(.trailing)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var status: some View {
        Text(L10n.string(row.status))
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
    }

    private var icon: String {
        switch row.state {
        case .ok: return "checkmark.circle.fill"
        case .info: return "info.circle.fill"
        case .attention: return "exclamationmark.circle.fill"
        case .off: return "circle"
        case .unknown: return "questionmark.circle"
        }
    }

    private var color: Color {
        switch row.state {
        case .ok: return .green
        case .info: return HALiveActivityTheme.homeAssistant.accentColor
        case .attention: return .orange
        case .off: return .gray
        case .unknown: return .gray
        }
    }
}

#if DEBUG
#Preview("Health Checklist") {
    ZStack {
        PremiumBackground()
        ScrollView {
            HealthChecklistView(
                checklist: HealthChecklist(rows: [
                    HealthChecklistRow(
                        id: "ha_connection",
                        title: "Home Assistant connection",
                        status: "Ready",
                        state: .ok,
                        detail: "REST and WebSocket connected to the demo home."
                    ),
                    HealthChecklistRow(
                        id: "notifications",
                        title: "Notifications allowed",
                        status: "Needs attention",
                        state: .attention,
                        detail: "Tap to enable notifications so background Live Activities can start."
                    ),
                    HealthChecklistRow(
                        id: "live_activities",
                        title: "Live Activities",
                        status: "Off",
                        state: .off,
                        detail: "Live Activities are disabled in iOS Settings."
                    ),
                    HealthChecklistRow(
                        id: "icloud_sync",
                        title: "iCloud Sync",
                        status: "Unknown",
                        state: .unknown,
                        detail: "Checking iCloud account status."
                    )
                ])
            )
            .padding(16)
        }
    }
}
#endif
