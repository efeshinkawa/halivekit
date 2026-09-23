import SwiftUI

struct DashboardView: View {
    @Environment(AppModel.self) private var appModel
    @State private var didDismissCurrentConnectivityNotice = false

    var body: some View {
        NavigationStack {
            ZStack {
                PremiumBackground()
                ScrollView {
                    AdaptiveScreenContent {
                        VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.large) {
                            connectionCard
                            if appModel.isDemoMode {
                                demoScenarioSection
                            }
                            if let notice = appModel.dashboardConnectivityNotice,
                               !didDismissCurrentConnectivityNotice {
                                CompactConnectivityBanner(message: notice) {
                                    didDismissCurrentConnectivityNotice = true
                                }
                            }
                            activeActivitiesSection
                        }
                        .padding(.top, HALiveKitDesign.Spacing.standard)
                    }
                }
            }
            .navigationTitle("HA LiveKit")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await appModel.refreshEntities() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh entities")
                }
            }
        }
        .tint(HALiveActivityTheme.homeAssistant.accentColor)
        .onChange(of: appModel.webSocketStatus) { _, status in
            // A dismissal applies only to the current disconnect cycle. Once
            // reconnecting starts (or succeeds), a later failure is new and
            // deserves to be surfaced again.
            if status == .connecting || status == .connected {
                didDismissCurrentConnectivityNotice = false
            }
        }
    }

    private var connectionCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(appModel.homeDisplayName)
                        .font(.title2.weight(.bold))
                        .lineLimit(2)
                    Text(appModel.isDemoMode
                         ? L10n.format("Demo Home - %d rooms, %d entities", appModel.demoRooms.count, appModel.entities.count)
                         : L10n.format("%d entities loaded", appModel.entities.count))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                StatusPill(
                    title: appModel.connectionState.title,
                    systemImage: appModel.isDemoMode ? "play.circle.fill" : "checkmark.circle.fill",
                    color: appModel.isDemoMode ? .orange : .green
                )
            }

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: HALiveKitDesign.Spacing.small)], spacing: HALiveKitDesign.Spacing.small) {
                MiniMetric(title: "Entities", value: "\(appModel.entities.count)", iconName: "square.stack.3d.up.fill", color: .cyan)
                MiniMetric(title: "Live", value: "\(appModel.activeActivities.count)", iconName: "livephoto", color: .green)
                MiniMetric(title: updateMetricTitle, value: updateModeTitle, iconName: "dot.radiowaves.left.and.right", color: updateMetricColor)
            }

            NavigationLink {
                EntityPickerView()
            } label: {
                Label("New Live Activity", systemImage: "plus.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var demoScenarioSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                title: "Demo Scenarios",
                subtitle: "Run local smart-home changes and test Live Activities without Home Assistant."
            )

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: HALiveKitDesign.Spacing.small) {
                    ForEach(appModel.demoRooms.prefix(3)) { room in
                        StatusPill(title: room.name, systemImage: room.iconName, color: .cyan)
                    }
                }
            }

            Button {
                Task { await appModel.runDemoScenario(.laundryRunning) }
            } label: {
                Label("Start Demo Live Activity", systemImage: "livephoto")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 156), spacing: 10)], spacing: 10) {
                ForEach(appModel.demoScenarios) { scenario in
                    Button {
                        Task { await appModel.runDemoScenario(scenario) }
                    } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            Image(systemName: scenario.iconName)
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(HALiveActivityTheme.homeAssistant.accentColor)
                            Text(scenario.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                            Text(scenario.subtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
                        .padding(12)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
    }

    private var activeActivitiesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                title: "Active Live Activities",
                subtitle: "Foreground WebSocket events update matching activities immediately."
            )

            if appModel.activeActivities.isEmpty {
                EmptyStateView(
                    iconName: "livephoto.slash",
                    title: "Nothing live yet",
                    message: "Pick an entity to start showing Home Assistant state on the Lock Screen."
                )
            } else {
                ForEach(appModel.activeActivities) { record in
                    ActiveActivityCard(record: record)
                }
            }
        }
    }

    private var updateModeTitle: String {
        if appModel.isDemoMode {
            return L10n.string("Demo")
        }

        switch appModel.webSocketStatus {
        case .connected:
            return L10n.string("Live")
        case .connecting:
            return L10n.string("Connecting")
        case .disconnected, .failed:
            return appModel.restStatus == .connected ? L10n.string("Limited") : L10n.string("Offline")
        default:
            return L10n.string("Manual")
        }
    }

    private var updateMetricTitle: String {
        L10n.string("Updates")
    }

    private var updateMetricColor: Color {
        if appModel.isDemoMode {
            return .orange
        }

        switch appModel.webSocketStatus {
        case .connected:
            return .green
        case .connecting, .disconnected, .failed:
            return .orange
        case .idle:
            return .secondary
        }
    }
}

private struct ActiveActivityCard: View {
    @Environment(AppModel.self) private var appModel
    var record: ActiveActivityRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: record.lastState.iconName)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 46, height: 46)
                    .background(record.theme.gradient, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))
                    .shadow(color: record.theme.accentColor.opacity(0.24), radius: 12, x: 0, y: 8)

                VStack(alignment: .leading, spacing: 5) {
                    Text(record.title)
                        .font(.headline)
                        .lineLimit(2)
                    HStack(spacing: 6) {
                        Image(systemName: record.displayStyle.defaultIcon)
                        Text(record.lastState.displayName ?? record.entityId)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
            }

            HStack(alignment: .firstTextBaseline, spacing: HALiveKitDesign.Spacing.small) {
                Text(record.lastState.primaryState)
                    .font(.title2.weight(.bold))
                    .lineLimit(2)
                    .minimumScaleFactor(0.75)
                Spacer(minLength: HALiveKitDesign.Spacing.small)
                Text(record.lastState.displayStyle.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(record.theme.accentColor)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(record.theme.accentColor.opacity(0.12), in: Capsule())
            }

            if let progress = record.lastState.progress {
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: progress)
                        .tint(record.theme.accentColor)
                    Text("\(Int(progress * 100))%")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            } else if let secondary = record.lastState.secondaryState {
                Label(secondary, systemImage: "smallcircle.filled.circle")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            HStack {
                Label(L10n.format("Updated %@", record.lastState.lastUpdated.relativeShort), systemImage: "clock")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    Task { await appModel.refreshActivity(recordId: record.id) }
                } label: {
                    Image(systemName: "arrow.triangle.2.circlepath")
                }
                .buttonStyle(.bordered)
                .frame(minWidth: HALiveKitDesign.Layout.minimumTapTarget, minHeight: HALiveKitDesign.Layout.minimumTapTarget)
                .accessibilityLabel("Manually update")

                Button(role: .destructive) {
                    Task { await appModel.endActivity(recordId: record.id) }
                } label: {
                    Image(systemName: "stop.circle")
                }
                .buttonStyle(.bordered)
                .frame(minWidth: HALiveKitDesign.Layout.minimumTapTarget, minHeight: HALiveKitDesign.Layout.minimumTapTarget)
                .accessibilityLabel("Stop")
            }
        }
        .padding(HALiveKitDesign.Spacing.standard)
        .glassPanel()
        .overlay(alignment: .top) {
            Capsule()
                .fill(record.theme.gradient)
                .frame(height: 3)
                .padding(.horizontal, HALiveKitDesign.Spacing.standard)
        }
    }
}

private struct MiniMetric: View {
    var title: String
    var value: String
    var iconName: String
    var color: Color

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: iconName)
                .font(.caption.weight(.bold))
                .foregroundStyle(color)
                .frame(width: 22, height: 22)
                .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: 6, style: .continuous))

            VStack(alignment: .leading, spacing: 1) {
                Text(value)
                    .font(.subheadline.weight(.bold))
                    .lineLimit(1)
                Text(L10n.string(title))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

private struct CompactConnectivityBanner: View {
    var message: String
    var onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .foregroundStyle(.orange)
                .frame(width: 22)

            VStack(alignment: .leading, spacing: 4) {
                Text("Foreground updates paused")
                    .font(.caption.weight(.semibold))
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .frame(width: HALiveKitDesign.Layout.minimumTapTarget, height: HALiveKitDesign.Layout.minimumTapTarget)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Dismiss update notice")
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous)
                .stroke(.orange.opacity(0.18), lineWidth: 1)
        }
    }
}

#Preview {
    DashboardView()
        .environment(AppModel())
}
