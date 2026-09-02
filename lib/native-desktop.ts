import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';

export type NativeSystemProfile = {
  logicalCpus: number;
  totalMemoryBytes: number;
  architecture: string;
};

export function isNativeDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function filenameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || 'Dokument.pdf';
}

export async function pickNativePdf(): Promise<File | null> {
  if (!isNativeDesktop()) return null;
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'PDF-Dokument', extensions: ['pdf'] }],
  });
  if (!path) return null;

  const contents = await invoke<ArrayBuffer>('read_pdf', { path });
  const bytes = new Uint8Array(contents);
  return new File([bytes], filenameFromPath(path), {
    type: 'application/pdf',
    lastModified: Date.now(),
  });
}

export async function nativeSystemProfile(): Promise<NativeSystemProfile> {
  return invoke<NativeSystemProfile>('system_profile');
}

export async function pickNativeExportPath(
  filename: string,
  mimeType: string,
): Promise<string | null> {
  const extension = mimeType === 'image/png' ? 'png' : 'zip';
  return save({
    defaultPath: filename,
    filters: [
      {
        name: mimeType === 'image/png' ? 'PNG-Bild' : 'ZIP-Archiv',
        extensions: [extension],
      },
    ],
  });
}

export async function beginNativeExport(path: string): Promise<void> {
  await invoke('begin_export', { path });
}

export async function writeNativeExport(chunk: Uint8Array): Promise<void> {
  await invoke('write_export', chunk);
}

export async function finishNativeExport(): Promise<void> {
  await invoke('finish_export');
}

export async function abortNativeExport(): Promise<void> {
  await invoke('abort_export').catch(() => undefined);
}
