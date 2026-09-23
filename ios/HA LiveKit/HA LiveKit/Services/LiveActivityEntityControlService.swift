import ActivityKit
import Foundation

struct LiveActivityEntityControlService {
    private enum ControlError: Error {
        case invalidBinding
        case missingConnection
    }

    /// Performs one idempotent Home Assistant action after binding the request
    /// to exactly one active, explicitly opted-in Live Activity.
    @MainActor
    func execute(
        activityID: String,
        entityID: String,
        action: HALiveActivityEntityControlAction
    ) async -> String {
        do {
            let normalizedActivityID = try validatedActivityID(activityID)
            let normalizedEntityID = try validatedEntityID(entityID)
            let activity = try boundActivity(
                activityID: normalizedActivityID,
                entityID: normalizedEntityID
            )
            guard let expectedInstanceID = activity.attributes.entityControlHomeAssistantInstanceId,
                  HomeAssistantInstanceIdentity.isSafeIdentifier(expectedInstanceID)
            else {
                throw ControlError.invalidBinding
            }

            guard !UserDefaults.standard.bool(forKey: HALiveKitDefaults.demoModeEnabledKey) else {
                throw ControlError.missingConnection
            }
            guard let configuration = try KeychainCredentialStore().load() else {
                throw ControlError.missingConnection
            }

            let resolved = try await HomeAssistantConnectionResolver(
                configuration: configuration
            ).resolve()
            let resolvedInstanceID = HomeAssistantInstanceIdentity.identifier(
                baseURL: configuration.baseURL,
                config: resolved.haConfig
            )
            let canonicalInstanceID = ManagedRelayInstanceIDStore()
                .canonicalInstanceID(for: resolvedInstanceID)
            guard expectedInstanceID == resolvedInstanceID
                    || expectedInstanceID == canonicalInstanceID
            else {
                throw ControlError.invalidBinding
            }
            _ = try await resolved.client.callService(
                domain: "homeassistant",
                service: action.homeAssistantService,
                data: ["entity_id": normalizedEntityID]
            )

            var updatedState = activity.content.state
            updatedState.primaryState = L10n.string(
                action == .turnOn ? "On" : "Off"
            )
            updatedState.value = action.resultingState
            updatedState.lastUpdated = .now

            await activity.update(
                ActivityContent(
                    state: updatedState,
                    staleDate: Date().addingTimeInterval(60 * 30)
                )
            )

            return action == .turnOn
                ? L10n.string("Turned on from the Live Activity.")
                : L10n.string("Turned off from the Live Activity.")
        } catch ControlError.invalidBinding {
            return L10n.string("This Live Activity control is no longer valid.")
        } catch ControlError.missingConnection {
            return L10n.string("Connect Home Assistant in HA LiveKit to use this control.")
        } catch {
            // Never surface transport details, URLs, tokens, or raw HA errors
            // from a Lock Screen interaction.
            return L10n.string("Home Assistant could not complete the request. Try again.")
        }
    }

    @MainActor
    private func boundActivity(
        activityID: String,
        entityID: String
    ) throws -> Activity<HALiveActivityAttributes> {
        let matches = Activity<HALiveActivityAttributes>.activities.filter { activity in
            activity.attributes.activityId == activityID
                && activity.attributes.primaryEntityId == entityID
                && activity.attributes.allowsEntityControl == true
                && activity.content.state.entityId == entityID
        }

        guard matches.count == 1, let activity = matches.first else {
            throw ControlError.invalidBinding
        }
        return activity
    }

    private func validatedActivityID(_ value: String) throws -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              normalized.count <= 256,
              normalized.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
              })
        else {
            throw ControlError.invalidBinding
        }
        return normalized
    }

    private func validatedEntityID(_ value: String) throws -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized.count <= 255,
              normalized.range(
                  of: #"^(?:light|switch|input_boolean)\.[a-z0-9_]{1,200}$"#,
                  options: .regularExpression
              ) != nil
        else {
            throw ControlError.invalidBinding
        }
        return normalized
    }
}
