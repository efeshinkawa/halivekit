import SwiftUI

extension HALiveActivityTheme {
    var accentColor: Color {
        switch self {
        case .homeAssistant: Color(red: 0.02, green: 0.65, blue: 0.90)
        case .ocean: Color(red: 0.08, green: 0.42, blue: 0.82)
        case .mint: Color(red: 0.15, green: 0.72, blue: 0.52)
        case .amber: Color(red: 0.95, green: 0.62, blue: 0.16)
        case .rose: Color(red: 0.94, green: 0.32, blue: 0.45)
        case .graphite: Color(red: 0.45, green: 0.48, blue: 0.54)
        }
    }

    var secondaryColor: Color {
        switch self {
        case .homeAssistant: Color(red: 0.21, green: 0.77, blue: 0.68)
        case .ocean: Color(red: 0.24, green: 0.70, blue: 0.90)
        case .mint: Color(red: 0.46, green: 0.82, blue: 0.28)
        case .amber: Color(red: 0.98, green: 0.43, blue: 0.22)
        case .rose: Color(red: 0.66, green: 0.42, blue: 0.92)
        case .graphite: Color(red: 0.18, green: 0.20, blue: 0.24)
        }
    }

    var gradient: LinearGradient {
        LinearGradient(
            colors: [accentColor, secondaryColor],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}
