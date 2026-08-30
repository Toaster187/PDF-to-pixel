import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
} from 'pdfjs-dist';

export type Matrix = [number, number, number, number, number, number];

export type FidelitySettings = {
  protectImages: boolean;
  vectorDpi: number;
  minimumTextPixels: number;
};

export type RasterDriver = {
  nativeWidth: number;
  nativeHeight: number;
  placedWidth: number;
  placedHeight: number;
  requiredScale: number;
};

export type PageScan = {
  pageNumber: number;
  baseWidth: number;
  baseHeight: number;
  imageCount: number;
  imageScale: number;
  rasterDriver: RasterDriver | null;
  textCount: number;
  minimumTextHeight: number | null;
  previewUrl: string;
};

export type OutputPlan = {
  scale: number;
  width: number;
  height: number;
  dpi: number;
  megapixels: number;
  rawBytes: number;
  driver: 'image' | 'text' | 'vector';
};

type PdfJs = typeof import('pdfjs-dist');

let pdfJsPromise: Promise<PdfJs> | null = null;

export async function getPdfJs(): Promise<PdfJs> {
  if (!pdfJsPromise) {
    pdfJsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?worker'),
    ]).then(([pdfjs, workerModule]) => {
      if (!pdfjs.GlobalWorkerOptions.workerPort) {
        pdfjs.GlobalWorkerOptions.workerPort = new workerModule.default({
          name: 'pdf-pixel-renderer',
          type: 'module',
        });
      }
      return pdfjs;
    });
  }

  return pdfJsPromise;
}

export async function openLocalPdf(
  file: File,
  onPassword: (reason: number) => string | null,
  onProgress?: (loaded: number, total: number) => void,
): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfJs();
  const assetBase = new URL('pdfjs/', window.location.href).toString();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask: PDFDocumentLoadingTask = pdfjs.getDocument({
    data: bytes,
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    iccUrl: `${assetBase}iccs/`,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`,
    useSystemFonts: true,
  });

  loadingTask.onPassword = (updatePassword: (password: string) => void, reason: number) => {
    const password = onPassword(reason);
    if (password === null) {
      loadingTask.destroy();
      return;
    }
    updatePassword(password);
  };
  loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) =>
    onProgress?.(loaded, total || file.size);

  return loadingTask.promise;
}

function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function isMatrix(value: unknown): value is Matrix {
  return (
    Array.isArray(value) &&
    value.length >= 6 &&
    value.slice(0, 6).every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function getPdfObject(page: PDFPageProxy, objectId: string): Promise<unknown> {
  const objects = objectId.startsWith('g_') ? page.commonObjs : page.objs;

  return new Promise((resolve, reject) => {
    try {
      resolve(objects.get(objectId));
    } catch {
      try {
        objects.get(objectId, resolve);
      } catch (error) {
        reject(error);
      }
    }
  });
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export async function scanPage(page: PDFPageProxy): Promise<Omit<PageScan, 'previewUrl'>> {
  const pdfjs = await getPdfJs();
  const viewport = page.getViewport({ scale: 1 });
  const [operatorList, textContent] = await Promise.all([
    page.getOperatorList(),
    page.getTextContent({ disableNormalization: false }),
  ]);

  let current: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const pendingRasterObjects: Promise<void>[] = [];
  let imageCount = 0;
  let imageScale = 0;
  let rasterDriver: RasterDriver | null = null;
  const userUnit = page.userUnit || 1;

  const addRaster = (
    nativeWidthValue: unknown,
    nativeHeightValue: unknown,
    placement: Matrix,
    instances = 1,
  ) => {
    const nativeWidth = asPositiveNumber(nativeWidthValue);
    const nativeHeight = asPositiveNumber(nativeHeightValue);
    if (!nativeWidth || !nativeHeight) return;

    const placedWidth = Math.hypot(placement[0], placement[1]) * userUnit;
    const placedHeight = Math.hypot(placement[2], placement[3]) * userUnit;
    if (placedWidth < 1e-6 || placedHeight < 1e-6) return;

    const requiredScale = Math.max(nativeWidth / placedWidth, nativeHeight / placedHeight);
    if (!Number.isFinite(requiredScale) || requiredScale <= 0) return;

    imageCount += Math.max(1, Math.round(instances));
    if (requiredScale > imageScale) {
      imageScale = requiredScale;
      rasterDriver = {
        nativeWidth,
        nativeHeight,
        placedWidth,
        placedHeight,
        requiredScale,
      };
    }
  };

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] ?? [];

    if (operation === pdfjs.OPS.save) {
      stack.push([...current] as Matrix);
      continue;
    }
    if (operation === pdfjs.OPS.restore) {
      current = stack.pop() ?? current;
      continue;
    }
    if (operation === pdfjs.OPS.transform && isMatrix(args)) {
      current = multiply(current, args);
      continue;
    }
    if (operation === pdfjs.OPS.paintFormXObjectBegin) {
      stack.push([...current] as Matrix);
      if (isMatrix(args[0])) current = multiply(current, args[0]);
      continue;
    }
    if (operation === pdfjs.OPS.paintFormXObjectEnd) {
      current = stack.pop() ?? current;
      continue;
    }
    if (operation === pdfjs.OPS.beginGroup) {
      stack.push([...current] as Matrix);
      const group = args[0] as { matrix?: unknown } | undefined;
      if (isMatrix(group?.matrix)) current = multiply(current, group.matrix);
      continue;
    }
    if (operation === pdfjs.OPS.endGroup) {
      current = stack.pop() ?? current;
      continue;
    }
    if (operation === pdfjs.OPS.beginAnnotation) {
      stack.push([...current] as Matrix);
      const annotationTransform = args[2];
      const annotationMatrix = args[3];
      current = [1, 0, 0, 1, 0, 0];
      if (isMatrix(annotationTransform)) current = multiply(current, annotationTransform);
      if (isMatrix(annotationMatrix)) current = multiply(current, annotationMatrix);
      continue;
    }
    if (operation === pdfjs.OPS.endAnnotation) {
      current = stack.pop() ?? current;
      continue;
    }

    if (operation === pdfjs.OPS.paintImageXObject) {
      addRaster(args[1], args[2], current);
      continue;
    }
    if (operation === pdfjs.OPS.paintInlineImageXObject) {
      const image = args[0] as { width?: unknown; height?: unknown } | undefined;
      addRaster(image?.width, image?.height, current);
      continue;
    }
    if (operation === pdfjs.OPS.paintInlineImageXObjectGroup) {
      const image = args[0] as { width?: unknown; height?: unknown } | undefined;
      const entries = (args[1] ?? []) as Array<{
        transform?: unknown;
        w?: unknown;
        h?: unknown;
      }>;
      for (const entry of entries) {
        if (!isMatrix(entry.transform)) continue;
        addRaster(
          entry.w ?? image?.width,
          entry.h ?? image?.height,
          multiply(current, entry.transform),
        );
      }
      continue;
    }
    if (operation === pdfjs.OPS.paintImageXObjectRepeat) {
      const [objectId, scaleX, scaleY, positions] = args as [
        string,
        number,
        number,
        ArrayLike<number>,
      ];
      const repeatedPlacement: Matrix = [scaleX, 0, 0, scaleY, 0, 0];
      const placement = multiply(current, repeatedPlacement);
      const instances = Math.max(1, Math.floor((positions?.length ?? 2) / 2));
      pendingRasterObjects.push(
        getPdfObject(page, objectId)
          .then((image) => {
            const dimensions = image as { width?: unknown; height?: unknown } | undefined;
            addRaster(dimensions?.width, dimensions?.height, placement, instances);
          })
          .catch(() => undefined),
      );
      continue;
    }
    if (operation === pdfjs.OPS.paintImageMaskXObject) {
      const mask = args[0] as { width?: unknown; height?: unknown } | undefined;
      addRaster(mask?.width, mask?.height, current);
      continue;
    }
    if (operation === pdfjs.OPS.paintImageMaskXObjectGroup) {
      const masks = (args[0] ?? []) as Array<{
        width?: unknown;
        height?: unknown;
        transform?: unknown;
      }>;
      for (const mask of masks) {
        if (!isMatrix(mask.transform)) continue;
        addRaster(mask.width, mask.height, multiply(current, mask.transform));
      }
      continue;
    }
    if (operation === pdfjs.OPS.paintImageMaskXObjectRepeat) {
      const mask = args[0] as { width?: unknown; height?: unknown } | undefined;
      const scaleX = asPositiveNumber(Math.abs(args[1])) ?? 1;
      const skewX = typeof args[2] === 'number' ? args[2] : 0;
      const skewY = typeof args[3] === 'number' ? args[3] : 0;
      const scaleY = asPositiveNumber(Math.abs(args[4])) ?? 1;
      const positions = args[5] as ArrayLike<number> | undefined;
      addRaster(
        mask?.width,
        mask?.height,
        multiply(current, [scaleX, skewX, skewY, scaleY, 0, 0]),
        Math.max(1, Math.floor((positions?.length ?? 2) / 2)),
      );
    }
  }

  await Promise.all(pendingRasterObjects);

  let textCount = 0;
  let minimumTextHeight: number | null = null;
  for (const item of textContent.items) {
    if (!('str' in item)) continue;
    const textItem = item as {
      str: string;
      height: number;
      transform: Array<number>;
    };
    if (!textItem.str.trim()) continue;
    const measuredHeight = Math.abs(textItem.height || Math.hypot(textItem.transform[2], textItem.transform[3]));
    const physicalHeight = measuredHeight * userUnit;
    if (!Number.isFinite(physicalHeight) || physicalHeight <= 1e-5) continue;
    textCount += 1;
    minimumTextHeight =
      minimumTextHeight === null ? physicalHeight : Math.min(minimumTextHeight, physicalHeight);
  }

  return {
    pageNumber: page.pageNumber,
    baseWidth: viewport.width,
    baseHeight: viewport.height,
    imageCount,
    imageScale,
    rasterDriver,
    textCount,
    minimumTextHeight,
  };
}

export function planOutput(scan: PageScan, settings: FidelitySettings): OutputPlan {
  const vectorScale = settings.vectorDpi / 72;
  const textScale = scan.minimumTextHeight
    ? settings.minimumTextPixels / scan.minimumTextHeight
    : 0;
  const imageScale = settings.protectImages ? scan.imageScale : 0;
  const scale = Math.max(1, vectorScale, textScale, imageScale);

  let driver: OutputPlan['driver'] = 'vector';
  if (imageScale >= vectorScale && imageScale >= textScale && imageScale > 0) driver = 'image';
  else if (textScale >= vectorScale && textScale > 0) driver = 'text';

  const width = Math.max(1, Math.ceil(scan.baseWidth * scale));
  const height = Math.max(1, Math.ceil(scan.baseHeight * scale));

  return {
    scale,
    width,
    height,
    dpi: scale * 72,
    megapixels: (width * height) / 1_000_000,
    rawBytes: width * height * 3,
    driver,
  };
}

export async function createPagePreview(page: PDFPageProxy): Promise<string> {
  const baseViewport = page.getViewport({ scale: 1 });
  const previewScale = Math.min(1.35, 720 / Math.max(baseViewport.width, 1));
  const viewport = page.getViewport({ scale: previewScale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Die Browser-Zeichenfläche konnte nicht geöffnet werden.');

  await page.render({
    canvas,
    canvasContext: context,
    viewport,
    background: '#ffffff',
  }).promise;

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.84),
  );
  canvas.width = 1;
  canvas.height = 1;
  if (!blob) throw new Error('Die Seitenvorschau konnte nicht erstellt werden.');
  return URL.createObjectURL(blob);
}
