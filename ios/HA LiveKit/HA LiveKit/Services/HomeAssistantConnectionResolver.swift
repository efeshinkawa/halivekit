import Foundation

struct HomeAssistantResolvedConnection {
    var client: HomeAssistantClient
    var configuration: ConnectionConfiguration
    var candidate: HomeAssistantURLCandidate
    var debug: RESTDebugResponse
    var haConfig: HAConfig
}

struct HomeAssistantConnectionResolver {
    var configuration: ConnectionConfiguration

    func resolve() async throws -> HomeAssistantResolvedConnection {
        let candidates = configuration.orderedCandidateURLs
        var lastError: Error?

        for candidate in candidates {
            let variant = configuration.variant(baseURL: candidate.url)
            let client = HomeAssistantClient(configuration: variant)
            do {
                let (haConfig, debug) = try await client.fetchConfig()
                return HomeAssistantResolvedConnection(
                    client: client,
                    configuration: variant,
                    candidate: candidate,
                    debug: debug,
                    haConfig: haConfig
                )
            } catch let error as HALiveKitError {
                if Self.isAuthFailure(error) {
                    throw error
                }
                lastError = error
                continue
            } catch {
                lastError = error
                continue
            }
        }

        throw lastError ?? HALiveKitError.cannotReachHomeAssistant
    }

    static func isAuthFailure(_ error: HALiveKitError) -> Bool {
        switch error {
        case .invalidToken, .unauthorized, .invalidURL, .missingCredentials:
            return true
        default:
            return false
        }
    }
}

extension HomeAssistantURLCandidate {
    var localizedRoleLabel: String {
        switch role {
        case .primary:
            L10n.string("Primary URL")
        case .internalNetwork:
            L10n.string("Internal URL")
        case .externalNetwork:
            L10n.string("External URL")
        }
    }
}
