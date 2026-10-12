// Photo loading: decode (EXIF orientation is applied by the browser), downscale,
// and produce a JPEG for storage plus a small thumbnail for the library.

export const MAX_SIDE = 2400;

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

function scaled(src, w, h, maxSide) {
  const k = Math.min(1, maxSide / Math.max(w, h));
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
  const blob = await toBlob(canvas, 'image/jpeg', 0.9);
  const thumb = scaled(canvas, canvas.width, canvas.height, 480).toDataURL('image/jpeg', 0.8);
  return { canvas, blob, thumb, width: canvas.width, height: canvas.height };
}
