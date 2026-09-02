import { Zlib } from 'fflate';
import type { PDFPageProxy } from 'pdfjs-dist';

import {
  getDevicePerformanceProfile,
  yieldToBrowser,
} from '@/lib/device-performance';

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

type ChunkWriter = (chunk: Uint8Array) => Promise<void> | void;

type PngCompressor = {
  write: (chunk: Uint8Array) => Promise<void>;
  finish: () => Promise<void>;
  abort: (reason?: unknown) => Promise<void>;
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

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException('Export abgebrochen', 'AbortError');
}

async function createNativeCompressor(
  emit: ChunkWriter,
): Promise<PngCompressor> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.byteLength) await emit(pngChunk('IDAT', value));
    }
  })();

  return {
    write: (chunk) => writer.write(chunk as Uint8Array<ArrayBuffer>),
    finish: async () => {
      await writer.close();
      await pump;
    },
    abort: async (reason) => {
      await writer.abort(reason).catch(() => undefined);
      await pump.catch(() => undefined);
    },
  };
}

function createJavascriptCompressor(emit: ChunkWriter): PngCompressor {
  let writeChain = Promise.resolve();
  let callbackError: Error | null = null;
  const compressor = new Zlib({ level: 1, mem: 8 }, (chunk) => {
    if (!chunk.length) return;
    const framed = pngChunk('IDAT', chunk);
    writeChain = writeChain
      .then(() => emit(framed))
      .catch((error) => {
        callbackError =
          error instanceof Error ? error : new Error(String(error));
      });
  });

  return {
    write: async (chunk) => {
      compressor.push(chunk, false);
      await writeChain;
      if (callbackError) throw callbackError;
    },
    finish: async () => {
      compressor.push(new Uint8Array(0), true);
      await writeChain;
      if (callbackError) throw callbackError;
    },
    abort: async () => undefined,
  };
}

async function createPngCompressor(emit: ChunkWriter): Promise<PngCompressor> {
  if (getDevicePerformanceProfile().nativeCompression) {
    try {
      return await createNativeCompressor(emit);
    } catch {
      // Older WebViews can expose CompressionStream without supporting deflate.
    }
  }
  return createJavascriptCompressor(emit);
}

function createProgressReporter(
  onProgress?: (progress: RenderProgress) => void,
) {
  let lastUpdate = 0;
  return (progress: RenderProgress, force = false) => {
    const now = performance.now();
    if (!force && now - lastUpdate < 80) return;
    lastUpdate = now;
    onProgress?.(progress);
  };
}

export async function streamPageToPng(
  page: PDFPageProxy,
  options: RenderOptions,
  writeChunk: ChunkWriter,
): Promise<void> {
  const { width, height, scale, dpi, signal, onProgress } = options;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error('Ungültige PNG-Abmessungen.');
  }
  if (width > 2_147_483_647 || height > 2_147_483_647) {
    throw new Error('Die Seite überschreitet die maximale PNG-Abmessung.');
  }

  const rowBytes = width * 3;
  if (!Number.isSafeInteger(rowBytes) || rowBytes + 1 > 2_147_483_647) {
    throw new Error('Eine einzelne PNG-Zeile ist für diesen Browser zu groß.');
  }

  throwIfAborted(signal);
  await writeChunk(PNG_SIGNATURE);
  await writeChunk(makeHeader(width, height));
  await writeChunk(makePhysicalResolution(dpi));

  const profile = getDevicePerformanceProfile();
  const viewport = page.getViewport({ scale });
  const report = createProgressReporter(onProgress);
  const compressor = await createPngCompressor(writeChunk);
  const filteredRowBytes = rowBytes + 1;
  const overlap = 4;
  const maximumCoreSide = Math.max(1, profile.maxCanvasSide - overlap * 2);
  const tileWidthLimit = Math.min(width, maximumCoreSide);
  const widestCanvas = Math.min(
    profile.maxCanvasSide,
    tileWidthLimit + overlap * 2,
  );
  const heightForStripMemory = Math.max(
    1,
    Math.floor(profile.stripBudgetBytes / filteredRowBytes),
  );
  const heightForCanvasMemory = Math.max(
    1,
    Math.floor(profile.maxCanvasBytes / (widestCanvas * 4)) - overlap * 2,
  );
  const coreStripHeight = Math.max(
    1,
    Math.min(maximumCoreSide, heightForStripMemory, heightForCanvasMemory),
  );
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', {
    alpha: false,
    willReadFrequently: !profile.useHardwareCanvas,
  });
  if (!context)
    throw new Error('Die Browser-Zeichenfläche konnte nicht geöffnet werden.');

  try {
    for (let y = 0; y < height; y += coreStripHeight) {
      throwIfAborted(signal);
      const stripHeight = Math.min(coreStripHeight, height - y);
      const filtered = new Uint8Array(filteredRowBytes * stripHeight);
      const leftPixels = new Uint8Array(stripHeight * 3);
      for (let row = 0; row < stripHeight; row += 1) {
        filtered[row * filteredRowBytes] = 1; // PNG Sub filter
      }

      for (let x = 0; x < width; x += tileWidthLimit) {
        throwIfAborted(signal);
        const tileWidth = Math.min(tileWidthLimit, width - x);
        const renderX = Math.max(0, x - overlap);
        const renderY = Math.max(0, y - overlap);
        const renderRight = Math.min(width, x + tileWidth + overlap);
        const renderBottom = Math.min(height, y + stripHeight + overlap);
        const renderWidth = renderRight - renderX;
        const renderHeight = renderBottom - renderY;
        canvas.width = renderWidth;
        canvas.height = renderHeight;

        const renderTask = page.render({
          canvas,
          viewport,
          transform: [1, 0, 0, 1, -renderX, -renderY],
          background: '#ffffff',
          intent: 'print',
        });
        const cancelRender = () => renderTask.cancel();
        signal?.addEventListener('abort', cancelRender, { once: true });
        try {
          await renderTask.promise;
        } catch (error) {
          if (signal?.aborted)
            throw new DOMException('Export abgebrochen', 'AbortError');
          throw error;
        } finally {
          signal?.removeEventListener('abort', cancelRender);
        }

        const sourceX = x - renderX;
        const sourceY = y - renderY;
        const rgba = context.getImageData(
          sourceX,
          sourceY,
          tileWidth,
          stripHeight,
        ).data;
        for (let row = 0; row < stripHeight; row += 1) {
          let source = row * tileWidth * 4;
          let target = row * filteredRowBytes + 1 + x * 3;
          const leftOffset = row * 3;
          let leftRed = leftPixels[leftOffset];
          let leftGreen = leftPixels[leftOffset + 1];
          let leftBlue = leftPixels[leftOffset + 2];

          for (let column = 0; column < tileWidth; column += 1) {
            const red = rgba[source];
            const green = rgba[source + 1];
            const blue = rgba[source + 2];
            filtered[target] = (red - leftRed + 256) & 0xff;
            filtered[target + 1] = (green - leftGreen + 256) & 0xff;
            filtered[target + 2] = (blue - leftBlue + 256) & 0xff;
            leftRed = red;
            leftGreen = green;
            leftBlue = blue;
            source += 4;
            target += 3;
          }

          leftPixels[leftOffset] = leftRed;
          leftPixels[leftOffset + 1] = leftGreen;
          leftPixels[leftOffset + 2] = leftBlue;
          if (row > 0 && row % 256 === 0) await yieldToBrowser();
        }

        const tileProgress =
          (y + ((x + tileWidth) / width) * stripHeight) / height;
        report({
          ratio: tileProgress * 0.96,
          message: `Gerätebeschleunigtes Rendering · ${Math.round(tileProgress * 100)} %`,
        });
        await yieldToBrowser();
      }

      throwIfAborted(signal);
      await compressor.write(filtered);
      const stripProgress = (y + stripHeight) / height;
      report({
        ratio: stripProgress * 0.98,
        message: `PNG wird direkt komprimiert · ${Math.round(stripProgress * 100)} %`,
      });
    }

    throwIfAborted(signal);
    await compressor.finish();
    await writeChunk(pngChunk('IEND', new Uint8Array(0)));
    report({ ratio: 1, message: 'PNG ist fertig' }, true);
  } catch (error) {
    await compressor.abort(error);
    throw error;
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

export async function renderPageToPng(
  page: PDFPageProxy,
  options: RenderOptions,
): Promise<Blob> {
  const parts: BlobPart[] = [];
  await streamPageToPng(page, options, (chunk) => {
    parts.push(copyToArrayBuffer(chunk));
  });
  return new Blob(parts, { type: 'image/png' });
}
