// The browser's side of a shared puzzle's live room (worker/room.js): one WebSocket that
// sends this player's moves and hands everyone else's to the game. Reconnects by itself if
// the connection drops; the room then sends the whole board again.

import { app, apiBase } from './native.js';

const DRAG_EVERY = 70; // ms between drag updates (about 14 a second)

export class Room {
  constructor(id, handlers) {
    this.id = id;
    this.on = handlers; // init, players, hold, deny, drag, patch, release, status, gone
    this.refused = 0; // connections closed before opening (e.g. no longer a player)
    this.closed = false;
    this.retry = 0;
    this.lastDrag = 0;
    this.pendingDrag = null;
    this.open();
  }

  open() {
    const path = `/api/rooms/${encodeURIComponent(this.id)}`;
    // In the app, the sign-in token travels as a WebSocket sub-protocol (browsers can't
    // add headers to WebSockets); on the website the sign-in cookie does the job.
    const ws = app
      ? new WebSocket(apiBase.replace(/^http/, 'ws') + path, ['poozles', app.token || ''])
      : new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`);
    this.ws = ws;
    ws.onopen = () => {
      ws.opened = true;
      this.retry = 0;
      this.refused = 0;
      this.on.status?.('connected');
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.on[msg.t]?.(msg);
    };
    ws.onclose = () => {
      if (this.closed) return;
      // Refused three times in a row while online: this person isn't a player any more.
      if (!ws.opened && navigator.onLine && ++this.refused >= 3) {
        this.on.gone?.();
        return;
      }
      this.on.status?.('reconnecting');
      const wait = Math.min(15_000, 1000 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.open(), wait);
    };
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  hold(pieces) {
    this.send({ t: 'hold', pieces });
  }

  // Throttled: the latest position always goes out, just not on every pointer move.
  drag(groups) {
    this.pendingDrag = groups;
    const wait = DRAG_EVERY - (performance.now() - this.lastDrag);
    if (wait <= 0) this.flushDrag();
    else this.dragTimer ??= setTimeout(() => this.flushDrag(), wait);
  }

  flushDrag() {
    clearTimeout(this.dragTimer);
    this.dragTimer = null;
    if (!this.pendingDrag) return;
    this.lastDrag = performance.now();
    this.send({ t: 'drag', groups: this.pendingDrag });
    this.pendingDrag = null;
  }

  patch(patch, elapsed) {
    this.flushDrag();
    this.send({ t: 'patch', patch, elapsed });
  }

  release() {
    this.send({ t: 'release' });
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.dragTimer);
    this.ws?.close();
  }
}
