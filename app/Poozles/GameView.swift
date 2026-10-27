import SwiftUI
import UIKit
import WebKit

// The game itself runs in a web view, talking to this native shell through a small bridge:
//   game -> app:  window.webkit.messageHandlers.poozles.postMessage({ type, ... })
//                 signIn {provider} · signedOut · storeToken {token} · haptic {kind} · share {url, title}
//   app -> game:  window.poozlesNativeEvent({ type, ... })
//                 signedIn {token, email} · signInFailed {cancelled} · join {code}
// On start-up the game also finds window.poozlesApp = { api, token, platform, shell }.
@MainActor
@Observable
final class GameController: NSObject {
    private(set) var webView: WKWebView?
    private let signIn = SignIn()
    private var loaded = false
    private var pending: [[String: Any]] = []

    func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(GameFiles(), forURLScheme: GameFiles.scheme)
        config.mediaTypesRequiringUserActionForPlayback = []
        let content = config.userContentController
        content.add(WeakHandler(self), name: "poozles")
        content.addUserScript(WKUserScript(source: Self.startupScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #if DEBUG
        // Debug builds: copy the game's errors to the Xcode console / system log.
        let relay = """
        const send = (m) => { try { webkit.messageHandlers.poozles.postMessage({ type: 'log', message: String(m) }); } catch {} };
        addEventListener('error', (e) => send('error: ' + e.message + ' @ ' + e.filename + ':' + e.lineno));
        addEventListener('unhandledrejection', (e) => send('rejection: ' + (e.reason && (e.reason.stack || e.reason))));
        const ce = console.error; console.error = (...a) => { send('console.error: ' + a.join(' ')); ce(...a); };
        """
        content.addUserScript(WKUserScript(source: relay, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif

        let web = WKWebView(frame: .zero, configuration: config)
        let cream = UIColor(red: 1, green: 0.976, blue: 0.953, alpha: 1)
        web.backgroundColor = cream
        web.scrollView.backgroundColor = cream
        web.isOpaque = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never // the game handles safe areas itself
        web.allowsLinkPreview = false
        web.allowsBackForwardNavigationGestures = false // no accidental "back" swipes mid-puzzle
        web.navigationDelegate = self
        web.uiDelegate = self
        #if DEBUG
        web.isInspectable = true // Safari → Develop menu, for debugging in the Simulator
        #endif
        web.load(URLRequest(url: URL(string: "\(GameFiles.scheme)://app/index.html")!))
        webView = web
        return web
    }

    private static func startupScript() -> String {
        let info: [String: Any] = [
            "api": GameFiles.site.absoluteString,
            "token": Keychain.token ?? NSNull(),
            "platform": "ios",
            "shell": GameFiles.shellVersion,
        ]
        let json = (try? JSONSerialization.data(withJSONObject: info)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return "window.poozlesApp = \(json);"
    }

    // MARK: app -> game

    private func send(_ event: [String: Any]) {
        guard loaded, let webView else { return pending.append(event) }
        guard let data = try? JSONSerialization.data(withJSONObject: event), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.poozlesNativeEvent && window.poozlesNativeEvent(\(json))")
    }

    /// https://poozles.app/join/CODE (or ?join=CODE) opened from Messages, Safari, etc.
    func openInvite(_ url: URL) {
        let parts = url.pathComponents
        var code = parts.count >= 3 && parts[1] == "join" ? parts[2] : nil
        code = code ?? URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "join" })?.value
        if let code, code.count == 6 { send(["type": "join", "code": code.uppercased()]) }
    }

    // MARK: game -> app

    fileprivate func handle(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "signIn":
            let provider = message["provider"] as? String ?? ""
            Task {
                do {
                    let result = try await signIn.signIn(with: provider)
                    Keychain.token = result.token
                    send(["type": "signedIn", "token": result.token, "email": result.email])
                } catch {
                    send(["type": "signInFailed", "cancelled": (error as? SignIn.Failure) == .cancelled])
                }
            }
        case "signedOut":
            Keychain.token = nil
        case "log":
            NSLog("[Poozles web] %@", message["message"] as? String ?? "")
        case "storeToken": // signed in some other way (the developer sign-in on a test server)
            Keychain.token = message["token"] as? String
        case "haptic":
            switch message["kind"] as? String {
            case "lock": UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "snap": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        case "share":
            guard let link = (message["url"] as? String).flatMap(URL.init(string:)) else { return }
            let items: [Any] = [(message["title"] as? String).map { "\($0)\n" } ?? "", link]
            let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
            let root = SignIn.keyWindow().rootViewController
            sheet.popoverPresentationController?.sourceView = root?.view // iPad
            sheet.popoverPresentationController?.sourceRect = CGRect(x: root?.view.bounds.midX ?? 0, y: 80, width: 1, height: 1)
            root?.present(sheet, animated: true)
        default:
            break
        }
    }
}

extension GameController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        let queued = pending
        pending = []
        queued.forEach(send)
    }

    // The game stays inside the app; ordinary links (like the privacy page) open in Safari.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.scheme == GameFiles.scheme || url.scheme == "about" { return .allow }
        if action.targetFrame?.isMainFrame ?? true, ["http", "https", "mailto"].contains(url.scheme ?? "") {
            await UIApplication.shared.open(url)
            return .cancel
        }
        return .allow
    }

    // If iOS reclaims the web view's memory in the background, start it again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loaded = false
        webView.reload()
    }
}

// The game's confirm() and prompt() boxes (e.g. "Delete your account?") as native alerts;
// a web view shows nothing for them otherwise.
extension GameController: WKUIDelegate {
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        await withCheckedContinuation { done in
            present(message, actions: [UIAlertAction(title: "OK", style: .default) { _ in done.resume() }])
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        await withCheckedContinuation { done in
            present(message, actions: [
                UIAlertAction(title: "Cancel", style: .cancel) { _ in done.resume(returning: false) },
                UIAlertAction(title: "OK", style: .default) { _ in done.resume(returning: true) },
            ])
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        await withCheckedContinuation { done in
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done.resume(returning: nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume(returning: alert.textFields?.first?.text) })
            SignIn.keyWindow().rootViewController?.present(alert, animated: true)
        }
    }

    private func present(_ message: String, actions: [UIAlertAction]) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        actions.forEach(alert.addAction)
        SignIn.keyWindow().rootViewController?.present(alert, animated: true)
    }
}

// WKUserContentController keeps a strong reference to its handlers; this breaks the cycle.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var controller: GameController?
    init(_ controller: GameController) { self.controller = controller }

    func userContentController(_ content: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        MainActor.assumeIsolated { controller?.handle(body) }
    }
}

struct GameView: UIViewRepresentable {
    let controller: GameController

    func makeUIView(context: Context) -> WKWebView { controller.webView ?? controller.makeWebView() }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
