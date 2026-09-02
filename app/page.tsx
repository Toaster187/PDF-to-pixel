'use client';

import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Download,
  FileImage,
  FileText,
  Gauge,
  Info,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  RefreshCcw,
  ScanLine,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Zip, ZipPassThrough } from 'fflate';

import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  getDevicePerformanceProfile,
  yieldToBrowser,
} from '@/lib/device-performance';
import { createExportTarget } from '@/lib/export-target';
import {
  closeLocalPdf,
  createPagePreview,
  openLocalPdf,
  planOutput,
  scanPage,
  type FidelitySettings,
  type OutputPlan,
  type PageScan,
} from '@/lib/pdf-fidelity';
import { streamPageToPng } from '@/lib/png-renderer';

type Phase = 'idle' | 'loading' | 'analyzing' | 'ready' | 'error';

type ExportState = {
  scope: 'single' | 'all';
  pageNumber?: number;
  progress: number;
  message: string;
};

type FileInfo = {
  name: string;
  size: number;
  pages: number;
};

const DEFAULT_SETTINGS: FidelitySettings = {
  protectImages: true,
  vectorDpi: 600,
  minimumTextPixels: 32,
};

const numberFormatter = new Intl.NumberFormat('de-DE');
const decimalFormatter = new Intl.NumberFormat('de-DE', {
  maximumFractionDigits: 1,
});

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${decimalFormatter.format(bytes / 1024 ** index)} ${units[index]}`;
}

function cleanBaseName(filename: string): string {
  const withoutExtension = filename.replace(/\.pdf$/i, '');
  return (
    withoutExtension
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'pdf-export'
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function riskFor(plan: OutputPlan): 'normal' | 'large' | 'extreme' {
  if (
    plan.rawBytes >= 2 * 1024 ** 3 ||
    Math.max(plan.width, plan.height) > 65_535
  )
    return 'extreme';
  if (
    plan.rawBytes >= 512 * 1024 ** 2 ||
    Math.max(plan.width, plan.height) > 32_768
  )
    return 'large';
  return 'normal';
}

function driverLabel(driver: OutputPlan['driver']): string {
  if (driver === 'image') return 'Native Bilddetails';
  if (driver === 'text') return 'Kleinster Text';
  return 'Vektor-Basis';
}

function SettingsPanel({
  settings,
  onChange,
  disabled,
}: {
  settings: FidelitySettings;
  onChange: (settings: FidelitySettings) => void;
  disabled?: boolean;
}) {
  return (
    <aside className="self-start rounded-[28px] border border-border bg-card p-5 shadow-[0_24px_70px_rgb(27_33_45/7%)] lg:sticky lg:top-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.17em] text-muted-foreground">
            Smart Fidelity
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-[-0.025em]">
            Qualitätsregeln
          </h2>
        </div>
        <span className="rounded-full bg-primary/10 px-2.5 py-1 font-mono text-[10px] font-bold text-primary">
          AUTO
        </span>
      </div>

      <div className="space-y-3">
        <div className="rounded-2xl border border-border bg-secondary/55 p-4">
          <div className="flex items-center gap-3">
            <FileImage className="size-4 text-primary" />
            <label className="text-sm font-semibold" htmlFor="protect-images">
              Originale Bildpixel
            </label>
            <Switch
              id="protect-images"
              className="ml-auto"
              checked={settings.protectImages}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange({ ...settings, protectImages: checked })
              }
            />
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Jedes platzierte Rasterbild erhält mindestens so viele Ausgabepixel
            wie seine native Quelle.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-secondary/55 p-4">
          <div className="flex items-center gap-3">
            <ScanLine className="size-4 text-primary" />
            <label className="text-sm font-semibold" htmlFor="vector-dpi">
              Vektor-Basis
            </label>
            <output className="ml-auto font-mono text-xs font-bold">
              {settings.vectorDpi} dpi
            </output>
          </div>
          <Slider
            id="vector-dpi"
            className="mt-4"
            min={150}
            max={1200}
            step={150}
            value={[settings.vectorDpi]}
            disabled={disabled}
            aria-label="Vektor-Auflösung in dpi"
            onValueChange={(value) =>
              onChange({
                ...settings,
                vectorDpi: Array.isArray(value) ? value[0] : Number(value),
              })
            }
          />
          <div className="mt-2 flex justify-between font-mono text-[9px] text-muted-foreground">
            <span>150</span>
            <span>1200</span>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-secondary/55 p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-5 place-items-center rounded-md bg-foreground font-serif text-[10px] font-bold text-background">
              Aa
            </span>
            <label className="text-sm font-semibold" htmlFor="text-pixels">
              Kleinster Text
            </label>
            <output className="ml-auto font-mono text-xs font-bold">
              {settings.minimumTextPixels} px
            </output>
          </div>
          <Slider
            id="text-pixels"
            className="mt-4"
            min={16}
            max={64}
            step={4}
            value={[settings.minimumTextPixels]}
            disabled={disabled}
            aria-label="Mindesthöhe des kleinsten Texts in Pixeln"
            onValueChange={(value) =>
              onChange({
                ...settings,
                minimumTextPixels: Array.isArray(value)
                  ? value[0]
                  : Number(value),
              })
            }
          />
          <div className="mt-2 flex justify-between font-mono text-[9px] text-muted-foreground">
            <span>16 px</span>
            <span>64 px</span>
          </div>
        </div>
      </div>

      <div className="mt-5 flex gap-3 rounded-2xl border border-blue-100 bg-blue-50 p-4 text-blue-950">
        <LockKeyhole className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="text-xs leading-5">
          Kein Upload, kein Konto, keine KI-Inferenz. PDF-Analyse, Rendering und
          Kompression laufen vollständig auf diesem Gerät.
        </p>
      </div>
      <div className="mt-3 flex gap-3 rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-emerald-950">
        <Gauge className="mt-0.5 size-4 shrink-0 text-emerald-700" />
        <p className="text-xs leading-5">
          Windows und Android nutzen automatisch Hardware-Rendering, native
          PNG-Kompression und direktes Schreiben auf den Datenträger, soweit der
          Browser es unterstützt.
        </p>
      </div>
    </aside>
  );
}

function DropSurface({
  onFile,
  dragging,
  onDraggingChange,
}: {
  onFile: (file: File) => void;
  dragging: boolean;
  onDraggingChange: (dragging: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) onFile(file);
          event.currentTarget.value = '';
        }}
      />
      <button
        type="button"
        className={`group relative grid min-h-[340px] cursor-pointer place-items-center overflow-hidden rounded-[28px] border border-dashed bg-card p-8 text-center shadow-[0_28px_80px_rgb(27_33_45/8%)] transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/20 ${
          dragging
            ? 'scale-[1.01] border-primary bg-blue-50 shadow-[0_32px_90px_rgb(36_75_255/16%)]'
            : 'border-primary/40 hover:border-primary hover:shadow-[0_32px_90px_rgb(36_75_255/12%)]'
        }`}
        aria-label="PDF-Datei auswählen oder hier ablegen"
        onClick={() => inputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          onDraggingChange(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            onDraggingChange(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          onDraggingChange(false);
          const file = event.dataTransfer.files[0];
          if (file) onFile(file);
        }}
      >
        <span className="precision-grid pointer-events-none absolute inset-0 opacity-55" />
        <span className="relative flex max-w-md flex-col items-center">
          <span className="mb-6 grid size-20 place-items-center rounded-[24px] border border-primary/15 bg-primary/8 text-primary transition group-hover:-translate-y-1 group-hover:scale-105">
            <FileImage className="size-9" strokeWidth={1.7} />
          </span>
          <strong className="text-2xl tracking-[-0.03em]">
            {dragging ? 'Loslassen und lokal prüfen' : 'PDF hier ablegen'}
          </strong>
          <span className="mt-2 text-sm leading-6 text-muted-foreground">
            oder klicken und eine Datei auswählen
          </span>
          <span className="mt-7 rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background">
            PDF auswählen
          </span>
        </span>
      </button>
    </>
  );
}

function PageCard({
  scan,
  plan,
  exporting,
  onExport,
}: {
  scan: PageScan;
  plan: OutputPlan;
  exporting: boolean;
  onExport: () => void;
}) {
  const risk = riskFor(plan);
  return (
    <article className="overflow-hidden rounded-[26px] border border-border bg-card shadow-[0_18px_55px_rgb(27_33_45/7%)]">
      <div className="relative grid min-h-[280px] place-items-center overflow-hidden border-b border-border bg-[linear-gradient(135deg,#edf0f5_25%,transparent_25%),linear-gradient(225deg,#edf0f5_25%,transparent_25%),linear-gradient(45deg,#edf0f5_25%,transparent_25%),linear-gradient(315deg,#edf0f5_25%,#f7f8fa_25%)] bg-[length:18px_18px] bg-[position:9px_0,9px_0,0_0,0_0] p-6 sm:min-h-[340px]">
        <span className="absolute left-4 top-4 rounded-full border border-white/80 bg-white/90 px-3 py-1.5 font-mono text-[10px] font-bold shadow-sm backdrop-blur">
          SEITE {String(scan.pageNumber).padStart(2, '0')}
        </span>
        <img
          src={scan.previewUrl}
          alt={`Vorschau der PDF-Seite ${scan.pageNumber}`}
          className="max-h-[310px] max-w-full rounded-[3px] bg-white object-contain shadow-[0_18px_45px_rgb(27_33_45/24%)]"
        />
      </div>

      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Geplante Ausgabe
            </p>
            <h3 className="mt-1 text-xl font-semibold tracking-[-0.035em]">
              {numberFormatter.format(plan.width)} ×{' '}
              {numberFormatter.format(plan.height)} px
            </h3>
          </div>
          {risk !== 'normal' && (
            <span
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[9px] font-bold uppercase ${
                risk === 'extreme'
                  ? 'bg-red-100 text-red-800'
                  : 'bg-amber-100 text-amber-800'
              }`}
            >
              <AlertTriangle className="size-3" />
              {risk === 'extreme' ? 'Extrem groß' : 'Sehr groß'}
            </span>
          )}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-secondary/65 p-3">
            <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
              Auslöser
            </dt>
            <dd className="mt-1 text-xs font-semibold">
              {driverLabel(plan.driver)}
            </dd>
          </div>
          <div className="rounded-xl bg-secondary/65 p-3">
            <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
              Raster
            </dt>
            <dd className="mt-1 text-xs font-semibold">
              {numberFormatter.format(Math.round(plan.dpi))} dpi
            </dd>
          </div>
          <div className="rounded-xl bg-secondary/65 p-3">
            <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
              Pixelmenge
            </dt>
            <dd className="mt-1 text-xs font-semibold">
              {decimalFormatter.format(plan.megapixels)} MP
            </dd>
          </div>
          <div className="rounded-xl bg-secondary/65 p-3">
            <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
              Rohdaten
            </dt>
            <dd className="mt-1 text-xs font-semibold">
              {formatBytes(plan.rawBytes)}
            </dd>
          </div>
        </dl>

        <div className="mt-4 flex items-center gap-2 text-[11px] leading-5 text-muted-foreground">
          <Layers3 className="size-3.5 shrink-0" />
          <span>
            {scan.imageCount} Rasterelemente · {scan.textCount} Textläufe
            {scan.rasterDriver
              ? ` · stärkste Quelle ${numberFormatter.format(scan.rasterDriver.nativeWidth)} × ${numberFormatter.format(scan.rasterDriver.nativeHeight)} px`
              : ''}
          </span>
        </div>

        <Button
          className="mt-5 h-11 w-full rounded-xl bg-foreground px-4 text-background hover:bg-foreground/85"
          disabled={exporting}
          onClick={onExport}
        >
          {exporting ? <LoaderCircle className="animate-spin" /> : <Download />}
          Seite als PNG speichern
        </Button>
      </div>
    </article>
  );
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [scans, setScans] = useState<PageScan[]>([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('Bereit');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const previewUrlsRef = useRef<string[]>([]);
  const loadTokenRef = useRef(0);
  const exportAbortRef = useRef<AbortController | null>(null);

  const plannedPages = useMemo(
    () => scans.map((scan) => ({ scan, plan: planOutput(scan, settings) })),
    [scans, settings],
  );

  const revokePreviews = useCallback(() => {
    for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
    previewUrlsRef.current = [];
  }, []);

  useEffect(() => {
    return () => {
      loadTokenRef.current += 1;
      exportAbortRef.current?.abort();
      revokePreviews();
      if (documentRef.current) void closeLocalPdf(documentRef.current);
    };
  }, [revokePreviews]);

  const loadFile = useCallback(
    async (file: File) => {
      if (
        !file.name.toLowerCase().endsWith('.pdf') &&
        file.type !== 'application/pdf'
      ) {
        setError('Bitte wähle eine PDF-Datei aus.');
        setPhase('error');
        return;
      }

      const token = ++loadTokenRef.current;
      exportAbortRef.current?.abort();
      revokePreviews();
      const previousDocument = documentRef.current;
      documentRef.current = null;
      if (previousDocument)
        await closeLocalPdf(previousDocument).catch(() => undefined);

      setError(null);
      setScans([]);
      setFileInfo({ name: file.name, size: file.size, pages: 0 });
      setPhase('loading');
      setProgress(0.02);
      setStatus('PDF wird lokal geöffnet …');

      try {
        const pdf = await openLocalPdf(
          file,
          (reason) =>
            window.prompt(
              reason === 2
                ? 'Das Passwort war nicht richtig. Bitte erneut eingeben:'
                : 'Diese PDF ist geschützt. Bitte Passwort eingeben:',
            ),
          (loaded, total) =>
            setProgress(Math.min(0.18, (loaded / Math.max(total, 1)) * 0.18)),
        );
        if (token !== loadTokenRef.current) {
          await closeLocalPdf(pdf);
          return;
        }

        documentRef.current = pdf;
        setFileInfo({ name: file.name, size: file.size, pages: pdf.numPages });
        setPhase('analyzing');
        setStatus(`0 von ${pdf.numPages} Seiten analysiert`);

        const profile = getDevicePerformanceProfile();
        const completed = Array.from<PageScan | undefined>({
          length: pdf.numPages,
        });
        const previewWidth =
          pdf.numPages >= 80 ? 420 : pdf.numPages >= 30 ? 540 : 720;
        let nextPage = 1;
        let completedCount = 0;
        let lastUiCommit = 0;

        const analyzeNextPage = async () => {
          while (token === loadTokenRef.current) {
            const pageNumber = nextPage;
            nextPage += 1;
            if (pageNumber > pdf.numPages) return;

            const page = await pdf.getPage(pageNumber);
            const [scan, previewUrl] = await Promise.all([
              scanPage(page),
              createPagePreview(page, previewWidth),
            ]);
            page.cleanup();
            if (token !== loadTokenRef.current) {
              URL.revokeObjectURL(previewUrl);
              return;
            }

            previewUrlsRef.current.push(previewUrl);
            completed[pageNumber - 1] = { ...scan, previewUrl };
            completedCount += 1;
            const now = performance.now();
            if (now - lastUiCommit >= 80 || completedCount === pdf.numPages) {
              setScans(
                completed.filter((item): item is PageScan => Boolean(item)),
              );
              setProgress(0.18 + (completedCount / pdf.numPages) * 0.82);
              setStatus(
                `${completedCount} von ${pdf.numPages} Seiten analysiert`,
              );
              lastUiCommit = now;
            }
            await yieldToBrowser();
          }
        };

        await Promise.all(
          Array.from(
            { length: Math.min(profile.analysisConcurrency, pdf.numPages) },
            () => analyzeNextPage(),
          ),
        );
        if (token !== loadTokenRef.current) return;

        setPhase('ready');
        setProgress(1);
        setStatus(
          `${pdf.numPages} ${pdf.numPages === 1 ? 'Seite ist' : 'Seiten sind'} bereit`,
        );
      } catch (caught) {
        if (token !== loadTokenRef.current) return;
        const message =
          caught instanceof Error
            ? caught.message
            : 'Die PDF konnte nicht gelesen werden.';
        setError(
          /password|worker was destroyed/i.test(message)
            ? 'Die geschützte PDF wurde nicht geöffnet.'
            : `Die PDF konnte nicht verarbeitet werden: ${message}`,
        );
        setPhase('error');
        setStatus('PDF konnte nicht geöffnet werden');
      }
    },
    [revokePreviews],
  );

  const reset = useCallback(async () => {
    ++loadTokenRef.current;
    exportAbortRef.current?.abort();
    revokePreviews();
    const currentDocument = documentRef.current;
    documentRef.current = null;
    if (currentDocument)
      await closeLocalPdf(currentDocument).catch(() => undefined);
    setFileInfo(null);
    setScans([]);
    setError(null);
    setProgress(0);
    setPhase('idle');
    setStatus('Bereit');
  }, [revokePreviews]);

  const confirmLargeExport = useCallback(
    (plans: OutputPlan[], label: string) => {
      const totalRaw = plans.reduce((sum, plan) => sum + plan.rawBytes, 0);
      const longestEdge = Math.max(
        ...plans.map((plan) => Math.max(plan.width, plan.height)),
      );
      if (totalRaw < 1024 ** 3 && longestEdge <= 32_768) return true;
      const directSave = getDevicePerformanceProfile().directFileSave;
      return window.confirm(
        `${label} umfasst ${formatBytes(totalRaw)} ungefilterte RGB-Daten und kann trotz Beschleunigung lange dauern. ` +
          (directSave
            ? 'Die Ausgabe wird blockweise direkt in die gewählte Datei geschrieben und nicht komplett im Arbeitsspeicher gesammelt. '
            : 'Dieser Browser kann die Ausgabe nicht direkt auf den Datenträger streamen und muss das Ergebnis im Arbeitsspeicher sammeln. ') +
          'Trotzdem starten?',
      );
    },
    [],
  );

  const exportSingle = useCallback(
    async (pageNumber: number) => {
      const pdf = documentRef.current;
      const item = plannedPages.find(
        ({ scan }) => scan.pageNumber === pageNumber,
      );
      if (!pdf || !item || exportState) return;
      if (!confirmLargeExport([item.plan], `Seite ${pageNumber}`)) return;

      const baseName = cleanBaseName(fileInfo?.name ?? 'pdf-export');
      const filename = `${baseName}-seite-${String(pageNumber).padStart(2, '0')}.png`;
      const target = await createExportTarget(filename, 'image/png');
      if (!target) return;

      const controller = new AbortController();
      exportAbortRef.current = controller;
      setError(null);
      setExportState({
        scope: 'single',
        pageNumber,
        progress: 0,
        message:
          target.mode === 'direct'
            ? `Seite ${pageNumber} wird direkt gespeichert …`
            : `Seite ${pageNumber} wird vorbereitet …`,
      });

      try {
        const page = await pdf.getPage(pageNumber);
        try {
          await streamPageToPng(
            page,
            {
              ...item.plan,
              signal: controller.signal,
              onProgress: ({ ratio, message }) =>
                setExportState({
                  scope: 'single',
                  pageNumber,
                  progress: ratio,
                  message,
                }),
            },
            target.write,
          );
        } finally {
          page.cleanup();
        }
        const blob = await target.finish();
        if (blob) downloadBlob(blob, filename);
      } catch (caught) {
        await target.abort(caught);
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          setError(
            caught instanceof Error
              ? `Export fehlgeschlagen: ${caught.message}`
              : 'Der PNG-Export ist fehlgeschlagen.',
          );
        }
      } finally {
        exportAbortRef.current = null;
        setExportState(null);
      }
    },
    [confirmLargeExport, exportState, fileInfo?.name, plannedPages],
  );

  const exportAll = useCallback(async () => {
    const pdf = documentRef.current;
    if (!pdf || !plannedPages.length || exportState || phase !== 'ready')
      return;
    if (
      !confirmLargeExport(
        plannedPages.map(({ plan }) => plan),
        'Alle Seiten zusammen',
      )
    )
      return;

    const baseName = cleanBaseName(fileInfo?.name ?? 'pdf-export');
    const filename = `${baseName}-alle-seiten.zip`;
    const target = await createExportTarget(filename, 'application/zip');
    if (!target) return;

    const controller = new AbortController();
    exportAbortRef.current = controller;
    setError(null);
    setExportState({
      scope: 'all',
      progress: 0,
      message:
        target.mode === 'direct'
          ? 'ZIP wird direkt gespeichert …'
          : 'ZIP wird vorbereitet …',
    });

    try {
      const {
        promise: zipFinished,
        resolve: finishZip,
        reject: failZip,
      } = Promise.withResolvers<void>();
      let zipFailure: Error | null = null;
      let writeChain = Promise.resolve();
      const zip = new Zip((zipError, chunk, final) => {
        if (zipError) {
          zipFailure = zipError;
          failZip(zipError);
          return;
        }
        if (chunk.length) {
          const copy = chunk.slice();
          writeChain = writeChain.then(() => target.write(copy));
        }
        if (final)
          writeChain.then(
            () => finishZip(),
            (error) => failZip(error),
          );
      });

      for (let index = 0; index < plannedPages.length; index += 1) {
        if (controller.signal.aborted)
          throw new DOMException('Export abgebrochen', 'AbortError');
        const { scan, plan } = plannedPages[index];
        const page = await pdf.getPage(scan.pageNumber);
        const zipFile = new ZipPassThrough(
          `${baseName}-seite-${String(scan.pageNumber).padStart(2, '0')}.png`,
        );
        zip.add(zipFile);
        try {
          await streamPageToPng(
            page,
            {
              ...plan,
              signal: controller.signal,
              onProgress: ({ ratio, message }) =>
                setExportState({
                  scope: 'all',
                  progress: (index + ratio) / plannedPages.length,
                  message: `Seite ${scan.pageNumber}/${plannedPages.length} · ${message}`,
                }),
            },
            async (chunk) => {
              zipFile.push(chunk, false);
              await writeChain;
              if (zipFailure) throw zipFailure;
            },
          );
        } finally {
          page.cleanup();
        }
        zipFile.push(new Uint8Array(0), true);
        await writeChain;
        if (zipFailure) throw zipFailure;
      }

      zip.end();
      await zipFinished;
      const archive = await target.finish();
      if (archive) downloadBlob(archive, filename);
    } catch (caught) {
      await target.abort(caught);
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setError(
          caught instanceof Error
            ? `Gesamtexport fehlgeschlagen: ${caught.message}`
            : 'Der ZIP-Export ist fehlgeschlagen.',
        );
      }
    } finally {
      exportAbortRef.current = null;
      setExportState(null);
    }
  }, [confirmLargeExport, exportState, fileInfo?.name, phase, plannedPages]);

  const isWorking = phase === 'loading' || phase === 'analyzing';
  const totalPixels = plannedPages.reduce(
    (sum, { plan }) => sum + plan.megapixels,
    0,
  );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/80 bg-background/95">
        <div className="mx-auto flex h-16 max-w-[1480px] items-center justify-between px-5 lg:px-8">
          <button
            className="flex items-center gap-3 text-left"
            onClick={() => void reset()}
          >
            <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-[0_8px_24px_rgb(36_75_255/22%)]">
              <ScanLine className="size-5" />
            </span>
            <span>
              <span className="block font-semibold leading-none tracking-[-0.02em]">
                PDF / PIXEL
              </span>
              <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Fidelity renderer
              </span>
            </span>
          </button>
          <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800">
            <ShieldCheck className="size-3.5" />
            <span className="hidden sm:inline">100 % lokal</span>
            <span className="sm:hidden">Lokal</span>
          </div>
        </div>
      </header>

      {!fileInfo ? (
        <section className="mx-auto grid max-w-[1480px] gap-6 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-8 lg:py-8">
          <div className="min-w-0">
            <div className="mb-7 max-w-3xl">
              <p className="mb-3 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                PDF → verlustfreies PNG
              </p>
              <h1 className="text-balance text-[clamp(2.2rem,5vw,4.7rem)] font-semibold leading-[0.95] tracking-[-0.055em]">
                Jedes Detail bekommt die Pixel, die es braucht.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
                Die Seite prüft native Bildauflösungen und kleinen Text,
                berechnet daraus die nötige Ausgabegröße und rendert jede
                PDF-Seite direkt in deinem Browser.
              </p>
            </div>
            <DropSurface
              onFile={(file) => void loadFile(file)}
              dragging={dragging}
              onDraggingChange={setDragging}
            />
            {error && (
              <div className="mt-4 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p>{error}</p>
              </div>
            )}
          </div>
          <SettingsPanel
            settings={settings}
            onChange={setSettings}
            disabled={false}
          />
        </section>
      ) : (
        <section className="mx-auto max-w-[1480px] px-5 py-6 lg:px-8 lg:py-8">
          <div className="mb-6 rounded-[24px] border border-border bg-card p-4 shadow-[0_18px_55px_rgb(27_33_45/6%)] sm:p-5">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
              <div className="flex min-w-0 items-center gap-4">
                <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
                  <FileText className="size-6" />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-semibold tracking-[-0.02em]">
                    {fileInfo.name}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatBytes(fileInfo.size)} · {fileInfo.pages || '…'}{' '}
                    Seiten · nur lokal geöffnet
                  </p>
                </div>
              </div>

              <div className="min-w-0 flex-1 xl:px-8">
                <div className="mb-2 flex items-center justify-between gap-4 text-xs">
                  <span className="truncate font-medium">{status}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {Math.round(progress * 100)} %
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300"
                    style={{ width: `${Math.max(2, progress * 100)}%` }}
                  />
                </div>
              </div>

              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  className="h-10 rounded-xl px-3"
                  disabled={Boolean(exportState)}
                  onClick={() => void reset()}
                >
                  <RefreshCcw />
                  Neue PDF
                </Button>
                <Button
                  className="h-10 rounded-xl px-4"
                  disabled={phase !== 'ready' || Boolean(exportState)}
                  onClick={() => void exportAll()}
                >
                  {exportState?.scope === 'all' ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Archive />
                  )}
                  Alle Seiten
                </Button>
              </div>
            </div>
          </div>

          {error && (
            <div className="mb-5 flex items-start justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p>{error}</p>
              </div>
              <button
                aria-label="Fehlermeldung schließen"
                onClick={() => setError(null)}
              >
                <X className="size-4" />
              </button>
            </div>
          )}

          {exportState && (
            <div className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-xl rounded-[22px] border border-blue-200 bg-white/96 p-4 shadow-[0_25px_90px_rgb(27_33_45/25%)] backdrop-blur-xl sm:bottom-6">
              <div className="flex items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                  <LoaderCircle className="size-5 animate-spin" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {exportState.message}
                  </p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary transition-[width]"
                      style={{
                        width: `${Math.max(1, exportState.progress * 100)}%`,
                      }}
                    />
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-lg"
                  onClick={() => exportAbortRef.current?.abort()}
                >
                  Abbrechen
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0">
              <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-primary">
                    Seitenplan
                  </p>
                  <h1 className="mt-1 text-3xl font-semibold tracking-[-0.045em]">
                    Auflösung pro Seite
                  </h1>
                </div>
                {phase === 'ready' && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CheckCircle2 className="size-4 text-emerald-600" />
                    {decimalFormatter.format(totalPixels)} Megapixel geplant
                  </div>
                )}
              </div>

              {isWorking && scans.length === 0 ? (
                <div className="grid min-h-[420px] place-items-center rounded-[28px] border border-border bg-card p-8 text-center shadow-[0_18px_55px_rgb(27_33_45/6%)]">
                  <div>
                    <span className="mx-auto grid size-16 place-items-center rounded-[22px] bg-primary/10 text-primary">
                      <Gauge className="size-7 animate-pulse" />
                    </span>
                    <h2 className="mt-5 text-xl font-semibold">
                      Details werden vermessen
                    </h2>
                    <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                      Der Browser liest Bildabmessungen, Platzierungen und
                      Textgrößen jeder Seite.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="grid gap-5 md:grid-cols-2">
                  {plannedPages.map(({ scan, plan }) => (
                    <PageCard
                      key={scan.pageNumber}
                      scan={scan}
                      plan={plan}
                      exporting={Boolean(exportState)}
                      onExport={() => void exportSingle(scan.pageNumber)}
                    />
                  ))}
                  {phase === 'analyzing' && scans.length < fileInfo.pages && (
                    <div className="grid min-h-[420px] place-items-center rounded-[26px] border border-dashed border-border bg-card/60 p-8 text-center">
                      <div>
                        <LoaderCircle className="mx-auto size-6 animate-spin text-primary" />
                        <p className="mt-3 text-sm font-medium">
                          Nächste Seite wird analysiert …
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-6 rounded-[24px] border border-border bg-card p-5 sm:p-6">
                <div className="flex items-start gap-4">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-800">
                    <Info className="size-5" />
                  </span>
                  <div>
                    <h2 className="font-semibold tracking-[-0.02em]">
                      Was „verlustfrei“ hier genau bedeutet
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      PNG komprimiert ohne JPEG-Verluste. Eingebettete Bilder
                      werden nicht unter ihre native Detaildichte verkleinert.
                      Text und Vektoren sind mathematisch unbegrenzt skalierbar
                      – deshalb definieren die dpi-Basis und die Mindesthöhe
                      eine endliche, sehr scharfe Rasterausgabe. Ein einzelnes
                      PNG kann keine unterschiedlichen Pixelraster pro Element
                      besitzen: Ein 720p-Bild gewinnt im großen Seitenraster
                      keine erfundenen Details, seine einfacheren Bilddaten
                      werden aber verlustfrei mitkomprimiert.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <SettingsPanel
              settings={settings}
              onChange={setSettings}
              disabled={Boolean(exportState)}
            />
          </div>
        </section>
      )}
    </main>
  );
}
