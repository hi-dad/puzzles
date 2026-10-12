// Photo loading: decode (EXIF orientation is applied by the browser), keep a
// high-resolution copy, and size the puzzle image to the chosen piece count.

const MAX_SIDE = 4096; // largest photo we keep while setting up a puzzle
const MIN_SIDE = 2400; // small puzzles never go below this
const PIECE_PX = 110; // aim for at least this many source pixels across a piece
const MAX_PIXELS = 10e6; // iPhone Safari limits total canvas memory; pieces use ~3× this

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = src;
  });
}

export async function loadBlobImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    await img.decode?.().catch(() => {});
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encode failed'))), type, quality),
  );
}

function scaled(src, w, h, maxSide, k = Math.min(1, maxSide / Math.max(w, h))) {
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * k);
  cv.height = Math.round(h * k);
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}

export async function preparePhoto(file) {
  const img = await loadBlobImage(file);
  const canvas = scaled(img, img.naturalWidth, img.naturalHeight, MAX_SIDE);
  const thumb = scaled(canvas, canvas.width, canvas.height, 480).toDataURL('image/jpeg', 0.8);
  return { canvas, thumb, width: canvas.width, height: canvas.height };
}

// Scale factor for the puzzle image: enough pixels per piece to stay sharp when zoomed
// in, within what a phone can hold in memory.
export function puzzleScale(w, h, cols) {
  const want = Math.max(MIN_SIDE / Math.max(w, h), (PIECE_PX * cols) / w);
  return Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)), want);
}

export async function puzzleImage(photo, cols) {
  const k = puzzleScale(photo.width, photo.height, cols);
  const canvas = k < 1 ? scaled(photo.canvas, photo.width, photo.height, 0, k) : photo.canvas;
  const blob = await toBlob(canvas, 'image/jpeg', 0.92);
  return { blob, width: canvas.width, height: canvas.height };
}
