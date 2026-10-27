import CryptoKit
import Foundation
import WebKit

// The game's web files, served to the web view from a private poozles://app/ address.
// A real address (rather than file://) lets the game work exactly as on the website:
// its scripts load normally and its offline saves (IndexedDB) persist.
//
// The files come from the newest copy downloaded from poozles.app, or from the copy built
// into the app. Updates arrive in the background and take effect on the next launch.
final class GameFiles: NSObject, WKURLSchemeHandler {
    static let scheme = "poozles"
    static let site: URL = {
        #if DEBUG
        // Testing: launch with `-api http://localhost:8787` to use the server on this Mac.
        if let api = UserDefaults.standard.string(forKey: "api"), let url = URL(string: api) { return url }
        #endif
        return URL(string: "https://poozles.app")!
    }()
    /// Bump when the web code needs something new from this native shell; poozles.app's
    /// app-manifest.json says which shell version its files need (`minApp`).
    static let shellVersion = 1

    private let root: URL

    override init() {
        root = GameFiles.activeRoot()
        super.init()
    }

    // MARK: serving

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            let notFound = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
            task.didReceive(notFound)
            task.didFinish()
            return
        }
        // The game's scripts are ES modules, which WebKit fetches with CORS rules even from
        // a custom scheme like this one, so say they may be used.
        let headers = [
            "Content-Type": GameFiles.mimeType(file.pathExtension),
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*",
        ]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    static func mimeType(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": "text/html; charset=utf-8"
        case "js", "mjs": "text/javascript; charset=utf-8"
        case "css": "text/css; charset=utf-8"
        case "json", "webmanifest": "application/json"
        case "svg": "image/svg+xml"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        default: "application/octet-stream"
        }
    }

    // MARK: which copy to use

    private static var updatesDir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("web", isDirectory: true)
    }

    private static let activeKey = "webVersion"

    static func activeRoot() -> URL {
        if let version = UserDefaults.standard.string(forKey: activeKey) {
            let dir = updatesDir.appendingPathComponent(version, isDirectory: true)
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("index.html").path) { return dir }
        }
        return Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
    }

    // MARK: updating from poozles.app

    private struct Manifest: Decodable {
        struct File: Decodable { let path: String; let sha256: String }
        let version: String
        let minApp: Int
        let files: [File]
    }

    /// Downloads a newer copy of the game files if poozles.app has one this shell can run.
    /// Every file is checked against its fingerprint, and the copy only switches over once
    /// everything has arrived, so a dropped connection can never leave a half-updated game.
    static func updateIfNeeded() async {
        do {
            var request = URLRequest(url: site.appendingPathComponent("app-manifest.json"))
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, _) = try await URLSession.shared.data(for: request)
            let manifest = try JSONDecoder().decode(Manifest.self, from: data)
            guard manifest.minApp <= shellVersion, manifest.version != currentVersion() else { return }

            let fm = FileManager.default
            let incoming = updatesDir.appendingPathComponent("incoming-\(manifest.version)", isDirectory: true)
            try? fm.removeItem(at: incoming)
            for file in manifest.files {
                guard !file.path.contains("..") else { return }
                let (body, response) = try await URLSession.shared.data(from: site.appendingPathComponent(file.path))
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      SHA256.hash(data: body).map({ String(format: "%02x", $0) }).joined() == file.sha256 else { return }
                let dest = incoming.appendingPathComponent(file.path)
                try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
                try body.write(to: dest)
            }
            let final = updatesDir.appendingPathComponent(manifest.version, isDirectory: true)
            try? fm.removeItem(at: final)
            try fm.moveItem(at: incoming, to: final)
            let previous = UserDefaults.standard.string(forKey: activeKey)
            UserDefaults.standard.set(manifest.version, forKey: activeKey)
            if let previous, previous != manifest.version {
                try? fm.removeItem(at: updatesDir.appendingPathComponent(previous, isDirectory: true))
            }
        } catch {
            // Offline or poozles.app unreachable: keep playing the copy we have.
        }
    }

    private static func currentVersion() -> String? {
        let root = activeRoot()
        guard let data = try? Data(contentsOf: root.appendingPathComponent("app-manifest.json")),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: data) else { return nil }
        return manifest.version
    }
}
