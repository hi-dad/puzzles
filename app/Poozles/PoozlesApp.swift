import SwiftUI

// Poozles for iPhone and iPad: the same game as poozles.app, bundled inside a native
// shell. The shell adds what a browser can't: native Sign in with Apple and Google,
// invite links that open the app, vibration on snaps, the share sheet, offline start-up,
// and quietly updating the bundled game files from poozles.app.
@main
struct PoozlesApp: App {
    @State private var game = GameController()

    var body: some Scene {
        WindowGroup {
            GameView(controller: game)
                .ignoresSafeArea()
                .background(Color(red: 1, green: 0.976, blue: 0.953)) // the cream page color
                // Invite links (https://poozles.app/join/CODE) open here when the app is installed.
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { game.openInvite(url) }
                }
                .onOpenURL { url in game.openInvite(url) }
                .task { await GameFiles.updateIfNeeded() }
        }
    }
}
