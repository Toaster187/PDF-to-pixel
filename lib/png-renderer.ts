import { Zlib } from 'fflate';
import type { PDFPageProxy } from 'pdfjs-dist';

export type RenderProgress = {
  ratio: number;
  message: string;
};

type RenderOptions = {
  width: number;
  height: number;
  scale: number;
  dpi: number;
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
};

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = new Uint32Array(256);

for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(data.length + 8, crc32(chunk.subarray(4, data.length + 8)));
  return chunk;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function makeHeader(width: number, height: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8;
  data[9] = 2;
  return pngChunk('IHDR', data);
}

function makePhysicalResolution(dpi: number): Uint8Array {
  const pixelsPerMeter = Math.max(1, Math.round(dpi / 0.0254));
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, pixelsPerMeter);
  view.setUint32(4, pixelsPerMeter);
  data[8] = 1;
  return pngChunk('pHYs', data);
}

function paeth(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function filterRows(
  rgb: Uint8Array,
  width: number,
  rows: number,
  previousRow: Uint8Array,
): Uint8Array {
  const rowBytes = width * 3;
  const filtered = new Uint8Array((rowBytes + 1) * rows);

  for (let row = 0; row < rows; row += 1) {
    const sourceOffset = row * rowBytes;
    const targetOffset = row * (rowBytes + 1);
    filtered[targetOffset] = 4;
    for (let index = 0; index < rowBytes; index += 1) {
      const current = rgb[sourceOffset + index];
      const left = index >= 3 ? rgb[sourceOffset + index - 3] : 0;
      const up = previousRow[index];
      const upperLeft = index >= 3 ? previousRow[index - 3] : 0;
      filtered[targetOffset + 1 + index] =
        (current - paeth(left, up, upperLeft) + 256) & 0xff;
    }
    previousRow.set(rgb.subarray(sourceOffset, sourceOffset + rowBytes));
  }

  return filtered;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Export abgebrochen', 'AbortError');
}

async function nextFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

export async function renderPageToPng(
  page: PDFPageProxy,
  options: RenderOptions,
): Promise<Blob> {
  const { width, height, scale, dpi, signal, onProgress } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('Ungültige PNG-Abmessungen.');
  }
  if (width > 2_147_483_647 || height > 2_147_483_647) {
    throw new Error('Die Seite überschreitet die maximale PNG-Abmessung.');
  }

  throwIfAborted(signal);
  const viewport = page.getViewport({ scale });
  const parts: BlobPart[] = [
    copyToArrayBuffer(PNG_SIGNATURE),
    copyToArrayBuffer(makeHeader(width, height)),
    copyToArrayBuffer(makePhysicalResolution(dpi)),
  ];
  const compressor = new Zlib({ level: 6, mem: 8 }, (chunk) => {
    if (chunk.length) parts.push(copyToArrayBuffer(pngChunk('IDAT', chunk.slice())));
  });

  const rowBytes = width * 3;
  const previousRow = new Uint8Array(rowBytes);
  const targetStripBytes = 24 * 1024 * 1024;
  const coreStripHeight = Math.max(1, Math.min(768, Math.floor(targetStripBytes / rowBytes)));
  const maxTileWidth = 8192;
  const overlap = 4;

  for (let y = 0; y < height; y += coreStripHeight) {
    throwIfAborted(signal);
    const stripHeight = Math.min(coreStripHeight, height - y);
    const stripRgb = new Uint8Array(rowBytes * stripHeight);

    for (let x = 0; x < width; x += maxTileWidth) {
      throwIfAborted(signal);
      const tileWidth = Math.min(maxTileWidth, width - x);
      const renderX = Math.max(0, x - overlap);
      const renderY = Math.max(0, y - overlap);
      const renderRight = Math.min(width, x + tileWidth + overlap);
      const renderBottom = Math.min(height, y + stripHeight + overlap);
      const renderWidth = renderRight - renderX;
      const renderHeight = renderBottom - renderY;
      const canvas = document.createElement('canvas');
      canvas.width = renderWidth;
      canvas.height = renderHeight;
      const context = canvas.getContext('2d', {
        alpha: false,
        willReadFrequently: true,
      });
      if (!context) throw new Error('Die Browser-Zeichenfläche konnte nicht geöffnet werden.');

      const renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: [1, 0, 0, 1, -renderX, -renderY],
        background: '#ffffff',
      });
      const cancelRender = () => renderTask.cancel();
      signal?.addEventListener('abort', cancelRender, { once: true });
      try {
        await renderTask.promise;
      } catch (error) {
        if (signal?.aborted) throw new DOMException('Export abgebrochen', 'AbortError');
        throw error;
      } finally {
        signal?.removeEventListener('abort', cancelRender);
      }

      const sourceX = x - renderX;
      const sourceY = y - renderY;
      const rgba = context.getImageData(sourceX, sourceY, tileWidth, stripHeight).data;
      for (let row = 0; row < stripHeight; row += 1) {
        let source = row * tileWidth * 4;
        let target = row * rowBytes + x * 3;
        for (let column = 0; column < tileWidth; column += 1) {
          stripRgb[target] = rgba[source];
          stripRgb[target + 1] = rgba[source + 1];
          stripRgb[target + 2] = rgba[source + 2];
          source += 4;
          target += 3;
        }
      }

      canvas.width = 1;
      canvas.height = 1;
      const tileProgress = (y + ((x + tileWidth) / width) * stripHeight) / height;
      onProgress?.({
        ratio: tileProgress * 0.88,
        message: `Seite wird gekachelt · ${Math.round(tileProgress * 100)} %`,
      });
      await nextFrame();
    }

    throwIfAborted(signal);
    compressor.push(filterRows(stripRgb, width, stripHeight, previousRow), false);
    const rowProgress = (y + stripHeight) / height;
    onProgress?.({
      ratio: 0.88 + rowProgress * 0.12,
      message: `PNG wird verlustfrei komprimiert · ${Math.round(rowProgress * 100)} %`,
    });
    await nextFrame();
  }

  throwIfAborted(signal);
  compressor.push(new Uint8Array(0), true);
  parts.push(copyToArrayBuffer(pngChunk('IEND', new Uint8Array(0))));
  onProgress?.({ ratio: 1, message: 'PNG ist fertig' });
  return new Blob(parts, { type: 'image/png' });
}
