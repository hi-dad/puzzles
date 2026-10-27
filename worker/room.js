// The live room for one shared puzzle: a Cloudflare Durable Object that every player's
// browser keeps a WebSocket open to. It holds the board, decides who may pick up which
// pieces, passes each move on to the other players, and saves the board back to D1.
//
// Messages (JSON, client -> room):
//   { t: 'hold', pieces }            ask to pick up pieces (granted unless someone has them)
//   { t: 'drag', groups }            where the held pieces are right now (shown to others)
//   { t: 'patch', patch, elapsed }   the result of a move; releases the sender's pieces
//   { t: 'release' }                 put pieces down without changing anything
// Room -> client: init, players, hold, deny, drag, patch, release.
//
// It uses the WebSocket Hibernation API, so an idle room costs nothing and can be evicted
// from memory at any time: the board lives in this object's storage, and each socket's
// player details travel in its attachment.

import { DurableObject } from 'cloudflare:workers';
import { applyPatch, placedCount } from '../public/js/logic.js';
import { loadShared, saveShared } from './share.js';

const COLORS = ['#EF5A4C', '#3E8FC9', '#4E9A47', '#8E5CC4'];
const SAVE_DELAY = 30_000; // write the board to D1 at most this often while people play

export class PuzzleRoom extends DurableObject {
  async fetch(request) {
    const id = request.headers.get('x-puzzle');
    const email = request.headers.get('x-member');
    const name = decodeURIComponent(request.headers.get('x-name') || 'Player');
    await this.ctx.storage.put('id', id);
    const rec = await this.board();
    if (!rec) return new Response('Not found', { status: 404 });

    const { 0: client, 1: server } = new WebSocketPair();
    const others = this.sockets();
    const same = others.map((ws) => ws.deserializeAttachment()).find((p) => p.email === email);
    const used = new Set(others.map((ws) => ws.deserializeAttachment().color));
    const color = same?.color || COLORS.find((c) => !used.has(c)) || COLORS[0];
    const me = { pid: crypto.randomUUID().slice(0, 8), email, name, color, holds: [] };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(me);

    server.send(JSON.stringify({
      t: 'init', you: me.pid, state: boardState(rec), players: this.players(),
      holds: this.sockets().filter((ws) => ws !== server).map((ws) => holdMsg(ws.deserializeAttachment())),
    }));
    this.broadcast({ t: 'players', players: this.players() }, server);
    // The app sends its sign-in as a sub-protocol; the reply has to name it back.
    const app = (request.headers.get('sec-websocket-protocol') || '').startsWith('poozles');
    return new Response(null, { status: 101, webSocket: client, headers: app ? { 'sec-websocket-protocol': 'poozles' } : {} });
  }

  async webSocketMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment();

    if (msg.t === 'hold' && Array.isArray(msg.pieces)) {
      const taken = new Set();
      for (const other of this.sockets()) {
        if (other === ws) continue;
        for (const i of other.deserializeAttachment().holds) taken.add(i);
      }
      if (msg.pieces.some((i) => taken.has(i))) {
        ws.send(JSON.stringify({ t: 'deny', pieces: msg.pieces }));
        return;
      }
      me.holds = [...new Set([...me.holds, ...msg.pieces])];
      ws.serializeAttachment(me);
      this.broadcast(holdMsg(me), ws);
    } else if (msg.t === 'drag' && Array.isArray(msg.groups)) {
      this.broadcast({ t: 'drag', pid: me.pid, groups: msg.groups }, ws);
    } else if (msg.t === 'patch' && msg.patch) {
      const rec = await this.board();
      if (!rec) return;
      applyPatch(rec, msg.patch);
      rec.placed = placedCount(rec.groups);
      rec.done = rec.done || rec.placed === rec.cols * rec.rows;
      if (Number.isFinite(msg.elapsed)) rec.elapsed = Math.max(rec.elapsed || 0, msg.elapsed);
      rec.updatedAt = Date.now();
      await this.ctx.storage.put('rec', rec);
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + SAVE_DELAY);
      me.holds = [];
      ws.serializeAttachment(me);
      this.broadcast({ t: 'patch', pid: me.pid, patch: msg.patch, elapsed: rec.elapsed }, ws);
    } else if (msg.t === 'release') {
      me.holds = [];
      ws.serializeAttachment(me);
      this.broadcast({ t: 'release', pid: me.pid }, ws);
    }
  }

  async webSocketClose(ws) {
    this.gone(ws);
  }

  async webSocketError(ws) {
    this.gone(ws);
  }

  async gone(ws) {
    const me = ws.deserializeAttachment();
    this.broadcast({ t: 'release', pid: me.pid }, ws);
    this.broadcast({ t: 'players', players: this.players(ws) }, ws);
    if (!this.sockets().some((s) => s !== ws)) await this.save(); // last one out saves
  }

  async alarm() {
    await this.save();
  }

  // The board, from this room's storage or (first time / after a long break) from D1.
  async board() {
    let rec = await this.ctx.storage.get('rec');
    if (!rec) {
      const id = await this.ctx.storage.get('id');
      rec = id && (await loadShared(this.env, id));
      if (rec) await this.ctx.storage.put('rec', rec);
    }
    return rec || null;
  }

  async save() {
    const id = await this.ctx.storage.get('id');
    const rec = await this.ctx.storage.get('rec');
    if (id && rec) await saveShared(this.env, id, rec);
  }

  sockets() {
    return this.ctx.getWebSockets();
  }

  // Everyone connected, once per person (someone may have the puzzle open on two devices).
  players(except) {
    const seen = new Map();
    for (const ws of this.sockets()) {
      if (ws === except) continue;
      const p = ws.deserializeAttachment();
      if (!seen.has(p.email)) seen.set(p.email, { pid: p.pid, name: p.name, color: p.color, email: p.email });
    }
    return [...seen.values()].map(({ email, ...p }) => p); // other players never see emails
  }

  broadcast(msg, except) {
    const text = JSON.stringify(msg);
    for (const ws of this.sockets()) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {}
    }
  }
}

function holdMsg(p) {
  return { t: 'hold', pid: p.pid, name: p.name, color: p.color, pieces: p.holds };
}

function boardState(rec) {
  return { groups: rec.groups, tray: rec.tray, rot: rec.rot, elapsed: rec.elapsed || 0, done: !!rec.done };
}
