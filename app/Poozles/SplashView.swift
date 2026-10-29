import SwiftUI
import UIKit

// The launch screen (Info.plist UILaunchScreen) is a still picture of the poodle on cream.
// This view takes over from it in the same spot, makes the poodle hop while the game loads,
// then fades away. It never holds the game back: once the game is ready it leaves after
// the current hop. With Reduce Motion on it just fades.
struct SplashView: View {
    let game: GameController // read live: a plain Bool would be frozen inside the async task
    let onDone: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lift: CGFloat = 0
    @State private var squash: CGFloat = 1
    @State private var opacity: Double = 1

    var body: some View {
        ZStack {
            Color("LaunchBackground")
            Image("LaunchPoodle")
                .offset(y: lift)
                .scaleEffect(x: 2 - squash, y: squash, anchor: .bottom)
        }
        .ignoresSafeArea()
        .opacity(opacity)
        .allowsHitTesting(false)
        .task { await run() }
    }

    private func run() async {
        let started = Date()
        if !reduceMotion {
            repeat {
                await hop()
            } while !game.pageReady && Date().timeIntervalSince(started) < 4
        }
        while !game.pageReady && Date().timeIntervalSince(started) < 4 { try? await Task.sleep(for: .milliseconds(50)) }
        withAnimation(.easeOut(duration: 0.25)) { opacity = 0 }
        try? await Task.sleep(for: .milliseconds(250))
        onDone()
    }

    private func hop() async {
        withAnimation(.easeOut(duration: 0.08)) { squash = 0.92 } // crouch
        try? await Task.sleep(for: .milliseconds(80))
        withAnimation(.easeOut(duration: 0.24)) { lift = -44; squash = 1.04 } // up
        try? await Task.sleep(for: .milliseconds(240))
        withAnimation(.easeIn(duration: 0.18)) { lift = 0; squash = 1 } // down
        try? await Task.sleep(for: .milliseconds(180))
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        withAnimation(.spring(duration: 0.22, bounce: 0.5)) { squash = 0.9 } // land
        try? await Task.sleep(for: .milliseconds(90))
        withAnimation(.spring(duration: 0.25, bounce: 0.4)) { squash = 1 }
        try? await Task.sleep(for: .milliseconds(260))
    }
}
