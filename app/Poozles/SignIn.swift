import AuthenticationServices
import CryptoKit
import UIKit

// Native sign-in. Apple uses the system Face ID sheet; Google uses Apple's secure login
// window (ASWebAuthenticationSession) with Google's standard OAuth flow for iPhone apps,
// so no Google library is needed. Either way the result is an ID token, which poozles.app
// checks and swaps for a Poozles session token — the same accounts as on the website.
@MainActor
final class SignIn: NSObject {
    static let googleClientID = "392796332509-jvs3enrad2n3llj3qa8ki6jug9jns5hb.apps.googleusercontent.com"

    struct Result { let token: String; let email: String }
    enum Failure: Error { case cancelled, failed }

    private var appleContinuation: CheckedContinuation<(String, String?, String?), Error>?
    private var webSession: ASWebAuthenticationSession?

    func signIn(with provider: String) async throws -> Result {
        let (idToken, name, code): (String, String?, String?)
        switch provider {
        case "apple": (idToken, name, code) = try await appleIDToken()
        case "google": (idToken, name, code) = (try await googleIDToken(), nil, nil)
        default: throw Failure.failed
        }
        return try await exchange(provider: provider, idToken: idToken, name: name, code: code)
    }

    // MARK: Apple

    private func appleIDToken() async throws -> (String, String?, String?) {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        return try await withCheckedThrowingContinuation { continuation in
            appleContinuation = continuation
            controller.performRequests()
        }
    }

    // MARK: Google (OAuth with PKCE, as Google recommends for installed apps)

    private func googleIDToken() async throws -> String {
        let scheme = "com.googleusercontent.apps." + SignIn.googleClientID.replacingOccurrences(of: ".apps.googleusercontent.com", with: "")
        let redirect = "\(scheme):/oauth2redirect"
        let verifier = Self.randomString()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        var auth = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        auth.queryItems = [
            .init(name: "client_id", value: SignIn.googleClientID),
            .init(name: "redirect_uri", value: redirect),
            .init(name: "response_type", value: "code"),
            .init(name: "scope", value: "openid email profile"),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "prompt", value: "select_account"),
        ]
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: auth.url!, callbackURLScheme: scheme) { url, error in
                if let url { continuation.resume(returning: url) }
                else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { continuation.resume(throwing: Failure.cancelled) }
                else { continuation.resume(throwing: error ?? Failure.failed) }
            }
            session.presentationContextProvider = self
            webSession = session
            session.start()
        }
        guard let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value else { throw Failure.failed }

        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [
            .init(name: "code", value: code),
            .init(name: "client_id", value: SignIn.googleClientID),
            .init(name: "redirect_uri", value: redirect),
            .init(name: "grant_type", value: "authorization_code"),
            .init(name: "code_verifier", value: verifier),
        ]
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        let (data, _) = try await URLSession.shared.data(for: request)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let idToken = json["id_token"] as? String else { throw Failure.failed }
        return idToken
    }

    // MARK: poozles.app session

    private func exchange(provider: String, idToken: String, name: String?, code: String?) async throws -> Result {
        var request = URLRequest(url: GameFiles.site.appendingPathComponent("api/auth/\(provider)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["idToken": idToken, "app": true]
        if let name { body["name"] = name }
        if let code { body["code"] = code }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String, let email = json["email"] as? String else { throw Failure.failed }
        return Result(token: token, email: email)
    }

    private static func randomString() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URL
    }
}

extension SignIn: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        let credential = authorization.credential as? ASAuthorizationAppleIDCredential
        let token = credential?.identityToken.flatMap { String(data: $0, encoding: .utf8) }
        let name = credential?.fullName?.givenName // Apple only shares this the first time
        let code = credential?.authorizationCode.flatMap { String(data: $0, encoding: .utf8) } // lets the server disconnect Apple on account deletion
        Task { @MainActor in
            if let token { appleContinuation?.resume(returning: (token, name, code)) }
            else { appleContinuation?.resume(throwing: Failure.failed) }
            appleContinuation = nil
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let cancelled = (error as? ASAuthorizationError)?.code == .canceled
        Task { @MainActor in
            appleContinuation?.resume(throwing: cancelled ? Failure.cancelled : error)
            appleContinuation = nil
        }
    }
}

extension SignIn: ASAuthorizationControllerPresentationContextProviding, ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated { SignIn.keyWindow() }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { SignIn.keyWindow() }
    }

    static func keyWindow() -> UIWindow {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? UIWindow()
    }
}

extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
