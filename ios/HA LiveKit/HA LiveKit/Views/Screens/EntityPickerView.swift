import SwiftUI

struct EntityPickerView: View {
    @Environment(AppModel.self) private var appModel
    @State private var searchText = ""
    @State private var selectedDomain: HAEntityDomain?

    var preselectedTemplate: LiveActivityTemplate?

    init(preselectedTemplate: LiveActivityTemplate? = nil) {
        self.preselectedTemplate = preselectedTemplate
        _selectedDomain = State(initialValue: preselectedTemplate?.preferredDomains.first)
    }

    var body: some View {
        ZStack {
            PremiumBackground()
            ScrollView {
                AdaptiveScreenContent {
                    VStack(alignment: .leading, spacing: HALiveKitDesign.Spacing.standard) {
                        filterBar

                        if filteredEntities.isEmpty {
                            EmptyStateView(
                                iconName: "magnifyingglass",
                                title: "No matching entities",
                                message: "Adjust the search or domain filter, then refresh from Home Assistant."
                            )
                        } else {
                            LazyVStack(spacing: HALiveKitDesign.Spacing.small) {
                                ForEach(filteredEntities) { entity in
                                    NavigationLink {
                                        ActivityBuilderView(primaryEntity: entity, template: preselectedTemplate)
                                    } label: {
                                        EntityRow(entity: entity)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                    .padding(.top, HALiveKitDesign.Spacing.standard)
                }
            }
        }
        .navigationTitle("Create Activity")
        .searchable(text: $searchText, prompt: "Search entity or friendly name")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task {
                        await appModel.refreshEntities()
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .frame(width: HALiveKitDesign.Layout.minimumTapTarget, height: HALiveKitDesign.Layout.minimumTapTarget)
                }
                .accessibilityLabel("Refresh entities")
            }
        }
        .task {
            if appModel.entities.isEmpty {
                await appModel.refreshEntities()
            }
        }
    }

    private var filterBar: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Entities", subtitle: L10n.format("%d matching entities", filteredEntities.count))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    domainButton(title: "All", icon: "square.grid.2x2", domain: nil)

                    ForEach(HAEntityDomain.allCases.filter { $0 != .other }) { domain in
                        domainButton(title: domain.title, icon: domain.iconName, domain: domain)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func domainButton(title: String, icon: String, domain: HAEntityDomain?) -> some View {
        Button {
            selectedDomain = domain
        } label: {
            Label(L10n.string(title), systemImage: icon)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
        }
        .buttonStyle(.bordered)
        .tint(selectedDomain == domain ? HALiveActivityTheme.homeAssistant.accentColor : .secondary)
        .frame(minHeight: HALiveKitDesign.Layout.minimumTapTarget)
        .accessibilityAddTraits(selectedDomain == domain ? .isSelected : [])
    }

    private var filteredEntities: [HAEntity] {
        appModel.entities.filter { entity in
            let matchesDomain = selectedDomain == nil || entity.domain == selectedDomain
            let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !query.isEmpty else { return matchesDomain }

            return matchesDomain && (
                entity.entityId.localizedCaseInsensitiveContains(query) ||
                entity.friendlyName.localizedCaseInsensitiveContains(query) ||
                entity.state.localizedCaseInsensitiveContains(query)
            )
        }
    }
}

private struct EntityRow: View {
    var entity: HAEntity

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: iconName)
                .font(.title3.weight(.semibold))
                .foregroundStyle(HALiveActivityTheme.homeAssistant.gradient)
                .frame(width: 42, height: 42)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HALiveKitDesign.Radius.control, style: .continuous))

            VStack(alignment: .leading, spacing: 4) {
                Text(entity.friendlyName)
                    .font(.headline)
                    .lineLimit(2)
                Text(entity.entityId)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(L10n.format("Changed %@", entity.lastChanged.relativeShort))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 4) {
                Text(entity.state)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if let unit = entity.displayUnit {
                    Text(unit)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(14)
        .glassPanel()
        .accessibilityElement(children: .combine)
    }

    private var iconName: String {
        entity.suggestedIconName
    }
}

#Preview {
    NavigationStack {
        EntityPickerView()
            .environment(AppModel())
    }
}
