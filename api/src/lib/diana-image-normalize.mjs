import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { Buffer } from 'node:buffer';

// JEV image limits: docs.typesafe.ai/images. Preserve the entire picture,
// resize to fit and pad narrow/small images rather than cropping evidence.
export function normalizeJevImage(image) {
  const bytes = Buffer.from(image.data, 'base64');
  const decoded = image.mediaType === 'image/jpeg'
    ? jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 64 })
    : image.mediaType === 'image/png' ? PNG.sync.read(bytes) : null;
  if (!decoded) return null;
  const scale = Math.min(1, 1568 / decoded.width, 1568 / decoded.height);
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const paddedWidth = Math.max(280, width), paddedHeight = Math.max(280, height);
  const data = new Uint8Array(paddedWidth * paddedHeight * 4).fill(255);
  const left = Math.floor((paddedWidth - width) / 2), top = Math.floor((paddedHeight - height) / 2);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(decoded.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(decoded.width - 1, Math.floor(x / scale));
      const from = (sy * decoded.width + sx) * 4;
      const to = ((y + top) * paddedWidth + x + left) * 4;
      for (let c = 0; c < 3; c++) data[to + c] = Math.round(decoded.data[from + c] * decoded.data[from + 3] / 255 + 255 - decoded.data[from + 3]);
    }
  }
  return { ...image, mediaType: 'image/jpeg', data: Buffer.from(jpeg.encode({ data, width: paddedWidth, height: paddedHeight }, 92).data).toString('base64') };
}
