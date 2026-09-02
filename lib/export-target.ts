export type ExportTarget = {
  mode: 'direct' | 'memory';
  write: (chunk: Uint8Array) => Promise<void>;
  finish: () => Promise<Blob | null>;
  abort: (reason?: unknown) => Promise<void>;
};

type WritableFileStreamLike = {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
};

type SaveFileHandleLike = {
  createWritable(): Promise<WritableFileStreamLike>;
};

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<SaveFileHandleLike>;
};

function copyChunk(chunk: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  return copy.buffer;
}

export async function createExportTarget(
  filename: string,
  mimeType: string,
): Promise<ExportTarget | null> {
  const pickerWindow = window as SavePickerWindow;
  const picker = pickerWindow.showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const extension = filename.includes('.')
        ? `.${filename.split('.').pop()}`
        : '';
      const handle = await picker.call(pickerWindow, {
        suggestedName: filename,
        types: [
          {
            description: mimeType === 'image/png' ? 'PNG-Bild' : 'ZIP-Archiv',
            accept: { [mimeType]: extension ? [extension] : [] },
          },
        ],
      });
      const stream = await handle.createWritable();
      return {
        mode: 'direct',
        write: (chunk) => stream.write(chunk),
        finish: async () => {
          await stream.close();
          return null;
        },
        abort: async (reason) => {
          if (stream.abort) await stream.abort(reason).catch(() => undefined);
        },
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError')
        return null;
      // Browsers can expose the picker while blocking it in a particular context.
      // The in-memory download below remains the compatible fallback.
    }
  }

  const parts: BlobPart[] = [];
  let aborted = false;
  return {
    mode: 'memory',
    write: async (chunk) => {
      if (aborted) throw new DOMException('Export abgebrochen', 'AbortError');
      parts.push(copyChunk(chunk));
    },
    finish: async () => (aborted ? null : new Blob(parts, { type: mimeType })),
    abort: async () => {
      aborted = true;
      parts.length = 0;
    },
  };
}
