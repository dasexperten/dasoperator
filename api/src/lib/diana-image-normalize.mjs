import jpeg from 'jpeg-js';
import { decode as decodePng } from 'fast-png';
import { Buffer } from 'node:buffer';

// JEV image limits: docs.typesafe.ai/images. Preserve the entire picture,
// resize to fit and pad narrow/small images rather than cropping evidence.
export function normalizeJevImage(image) {
  const bytes = Buffer.from(image.data, 'base64');
  const decoded = image.mediaType === 'image/jpeg'
    ? jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 64 })
    : image.mediaType === 'image/png' ? decodePng(bytes, { checkCrc: true }) : null;
  if (!decoded) return null;
  const scale = Math.min(1, 1568 / decoded.width, 1568 / decoded.height);
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const paddedWidth = Math.max(280, width), paddedHeight = Math.max(280, height);
  const data = new Uint8Array(paddedWidth * paddedHeight * 4).fill(255);
  const left = Math.floor((paddedWidth - width) / 2), top = Math.floor((paddedHeight - height) / 2);
  const channels = decoded.channels ?? 4, depth = decoded.depth ?? 8;
  const sample = (x, y, channel) => {
    if (depth >= 8) return decoded.data[(y * decoded.width + x) * channels + channel];
    const bit = (x * channels + channel) * depth;
    return (decoded.data[y * Math.ceil(decoded.width * channels * depth / 8) + Math.floor(bit / 8)] >> (8 - depth - bit % 8)) & ((1 << depth) - 1);
  };
  const byte = value => Math.round(value * 255 / (2 ** depth - 1));
  for (let y = 0; y < height; y++) {
    const sy = Math.min(decoded.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(decoded.width - 1, Math.floor(x / scale));
      const to = ((y + top) * paddedWidth + x + left) * 4;
      const palette = decoded.palette?.[sample(sx, sy, 0)];
      const alpha = palette ? (palette[3] ?? 255) : [2, 4].includes(channels) ? byte(sample(sx, sy, channels - 1)) : 255;
      for (let c = 0; c < 3; c++) {
        const color = palette ? palette[c] : byte(sample(sx, sy, channels < 3 ? 0 : c));
        data[to + c] = Math.round(color * alpha / 255 + 255 - alpha);
      }
    }
  }
  return { ...image, mediaType: 'image/jpeg', data: Buffer.from(jpeg.encode({ data, width: paddedWidth, height: paddedHeight }, 92).data).toString('base64') };
}
