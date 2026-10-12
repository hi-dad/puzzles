// Jigsaw cut generation: grid sizing, seeded random tab shapes and piece outlines.

const TAB = 0.1; // knob size relative to the shorter piece side
const JITTER = 0.05;

export function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick columns × rows close to the target count with pieces as square as possible.
export function chooseGrid(width, height, target) {
  let best = null;
  for (let cols = 2; cols <= 120; cols++) {
    for (const rows of [Math.floor(target / cols), Math.ceil(target / cols)]) {
      if (rows < 2) continue;
      const shape = Math.abs(Math.log(width / cols / (height / rows)));
      const count = Math.abs(cols * rows - target) / target;
      const score = shape + count * 1.5;
      if (!best || score < best.score) best = { cols, rows, score };
    }
  }
  return { cols: best.cols, rows: best.rows };
}

// Control points of one edge in (along, across) units; across > 0 is the knob side.
function edgeShape(e) {
  const t = TAB;
  const { a, b, c, d } = e;
  return [
    [0, 0], [0.2, a], [0.5 + b + d, -t + c], [0.5 - t + b, t + c],
    [0.5 - 2 * t + b - d, 3 * t + c], [0.5 + 2 * t + b - d, 3 * t + c], [0.5 + t + b, t + c],
    [0.5 + b + d, -t + c], [0.8, e.e], [1, 0],
  ];
}

export class Cut {
  constructor(cols, rows, width, height, seed) {
    this.cols = cols;
    this.rows = rows;
    this.pw = width / cols;
    this.ph = height / rows;
    this.T = Math.min(this.pw, this.ph);
    this.M = Math.ceil(this.T * 0.36) + 2; // margin around a piece body for knobs
    const rnd = mulberry32(seed);
    const j = () => (rnd() * 2 - 1) * JITTER;
    const mk = () => ({ s: rnd() < 0.5 ? 1 : -1, a: j(), b: j(), c: j(), d: j(), e: j() });
    // h[r][c]: edge on top of piece (c, r); v[r][c]: edge on the left of piece (c, r).
    this.h = [];
    this.v = [];
    for (let r = 0; r < rows; r++) {
      this.h.push([]);
      this.v.push([]);
      for (let c = 0; c < cols; c++) {
        this.h[r].push(r > 0 ? mk() : null);
        this.v[r].push(c > 0 ? mk() : null);
      }
    }
  }

  isEdge(col, row) {
    return col === 0 || row === 0 || col === this.cols - 1 || row === this.rows - 1;
  }

  _edge(p, e, ax, ay, bx, by, nx, ny, reverse) {
    if (!e) {
      if (reverse) p.lineTo(ax, ay);
      else p.lineTo(bx, by);
      return;
    }
    const pts = edgeShape(e).map(([u, v]) => [
      ax + (bx - ax) * u + nx * v * e.s,
      ay + (by - ay) * u + ny * v * e.s,
    ]);
    if (reverse) pts.reverse();
    p.bezierCurveTo(...pts[1], ...pts[2], ...pts[3]);
    p.bezierCurveTo(...pts[4], ...pts[5], ...pts[6]);
    p.bezierCurveTo(...pts[7], ...pts[8], ...pts[9]);
  }

  // Trace piece (col, row) clockwise into a Path2D or context, shifted by (dx, dy).
  trace(p, col, row, dx = 0, dy = 0) {
    const { pw, ph, T, cols, rows } = this;
    const x0 = col * pw + dx, y0 = row * ph + dy, x1 = x0 + pw, y1 = y0 + ph;
    p.moveTo(x0, y0);
    this._edge(p, row > 0 ? this.h[row][col] : null, x0, y0, x1, y0, 0, T, false);
    this._edge(p, col < cols - 1 ? this.v[row][col + 1] : null, x1, y0, x1, y1, T, 0, false);
    this._edge(p, row < rows - 1 ? this.h[row + 1][col] : null, x0, y1, x1, y1, 0, T, true);
    this._edge(p, col > 0 ? this.v[row][col] : null, x0, y0, x0, y1, T, 0, true);
    p.closePath();
  }

  // Piece outline in the piece's own canvas coordinates (body starts at margin M).
  localPath(col, row) {
    const path = new Path2D();
    this.trace(path, col, row, -col * this.pw + this.M, -row * this.ph + this.M);
    return path;
  }

  // Render a piece from the source image into its own canvas with a bevelled edge.
  renderPiece(img, col, row) {
    const { pw, ph, M, T } = this;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(pw + 2 * M);
    cv.height = Math.ceil(ph + 2 * M);
    const ctx = cv.getContext('2d');
    const path = this.localPath(col, row);
    const ox = -col * pw + M, oy = -row * ph + M;
    ctx.save();
    ctx.clip(path);
    ctx.drawImage(img, ox, oy);
    const lw = Math.min(3, Math.max(1.2, T * 0.02));
    ctx.lineWidth = lw * 2;
    ctx.translate(lw * 0.7, lw * 0.7);
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.stroke(path);
    ctx.translate(-lw * 1.4, -lw * 1.4);
    ctx.strokeStyle = 'rgba(0,0,0,0.38)';
    ctx.stroke(path);
    ctx.restore();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.stroke(path);
    return { canvas: cv, path, shadow: this.renderShadow(path, cv.width, cv.height) };
  }

  // A soft, low-resolution silhouette drawn under loose pieces.
  renderShadow(path, w, h) {
    const pad = Math.ceil(this.T * 0.14);
    const sc = 0.25;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil((w + 2 * pad) * sc));
    cv.height = Math.max(1, Math.ceil((h + 2 * pad) * sc));
    const ctx = cv.getContext('2d');
    // Draw the shape far off-canvas and let only its blurred shadow land in view.
    const far = 10000;
    ctx.setTransform(sc, 0, 0, sc, (pad - far) * sc, pad * sc);
    ctx.shadowColor = '#000';
    ctx.shadowBlur = Math.max(1, this.T * 0.05 * sc);
    ctx.shadowOffsetX = far * sc;
    ctx.translate(far, 0);
    ctx.fill(path);
    return { canvas: cv, pad, scale: sc };
  }
}
