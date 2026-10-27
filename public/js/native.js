// Inside the Poozles iPhone/iPad app the game runs from a private poozles://app/ address,
// and the app provides window.poozlesApp: where the server is and the sign-in token. Native
// features (Sign in with Apple/Google, vibration, the share sheet) are reached by message.
// On the website none of this exists and everything below quietly does nothing.

export const app = window.poozlesApp || null;

// Where /api lives: the same site on the web, poozles.app inside the app.
export const apiBase = app ? app.api : '';

// The public address of Poozles, for invite links people can open anywhere.
export const site = app ? app.api : location.origin;

export function post(type, data = {}) {
  try {
    window.webkit?.messageHandlers?.poozles?.postMessage({ type, ...data });
  } catch {}
}

// The app signs requests with its token; the website uses its sign-in cookie instead.
export function authHeaders() {
  return app?.token ? { authorization: `Bearer ${app.token}` } : {};
}
