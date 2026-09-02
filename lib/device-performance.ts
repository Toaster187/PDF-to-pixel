import { isNativeDesktop, nativeSystemProfile } from '@/lib/native-desktop';

type NavigatorWithDeviceHints = Navigator & {
  deviceMemory?: number;
  userAgentData?: {
    mobile?: boolean;
  };
};

export type DevicePerformanceProfile = {
  analysisConcurrency: number;
  maxCanvasSide: number;
  maxCanvasBytes: number;
  stripBudgetBytes: number;
  useHardwareCanvas: boolean;
  nativeCompression: boolean;
  directFileSave: boolean;
};

const MIB = 1024 * 1024;
let nativeProfile: DevicePerformanceProfile | null = null;

export async function initializeNativePerformanceProfile(): Promise<void> {
  if (!isNativeDesktop()) return;

  const system = await nativeSystemProfile();
  const cores = Math.max(1, system.logicalCpus);
  const memoryBytes = Math.max(2 * 1024 ** 3, system.totalMemoryBytes);
  const memoryGiB = memoryBytes / 1024 ** 3;
  nativeProfile = {
    analysisConcurrency: Math.max(1, Math.min(8, cores - 1)),
    maxCanvasSide: 16_384,
    maxCanvasBytes: Math.min(1024 * MIB, Math.max(256 * MIB, memoryBytes / 16)),
    stripBudgetBytes: Math.min(
      512 * MIB,
      Math.max(128 * MIB, memoryBytes / 24),
    ),
    useHardwareCanvas: cores >= 4 && memoryGiB >= 4,
    nativeCompression: typeof CompressionStream !== 'undefined',
    directFileSave: true,
  };
}

export function getDevicePerformanceProfile(): DevicePerformanceProfile {
  if (nativeProfile) return nativeProfile;
  if (typeof navigator === 'undefined') {
    return {
      analysisConcurrency: 2,
      maxCanvasSide: 8192,
      maxCanvasBytes: 64 * MIB,
      stripBudgetBytes: 24 * MIB,
      useHardwareCanvas: false,
      nativeCompression: false,
      directFileSave: false,
    };
  }

  const deviceNavigator = navigator as NavigatorWithDeviceHints;
  const cores = Math.max(1, deviceNavigator.hardwareConcurrency || 4);
  const mobile =
    deviceNavigator.userAgentData?.mobile ??
    /Android|iPhone|iPad|iPod/i.test(deviceNavigator.userAgent);
  const memoryGiB = Math.max(
    1,
    deviceNavigator.deviceMemory || (mobile ? 4 : 8),
  );
  const constrained = memoryGiB <= 4;

  return {
    analysisConcurrency: mobile
      ? Math.max(1, Math.min(2, cores - 1))
      : Math.max(1, Math.min(constrained ? 2 : 4, cores - 1)),
    maxCanvasSide: mobile || constrained ? 8192 : 16_384,
    maxCanvasBytes: mobile
      ? (constrained ? 48 : 96) * MIB
      : (constrained ? 96 : 256) * MIB,
    stripBudgetBytes: mobile
      ? (constrained ? 16 : 32) * MIB
      : (constrained ? 48 : 128) * MIB,
    useHardwareCanvas: cores >= 4 && memoryGiB >= 4,
    nativeCompression: typeof CompressionStream !== 'undefined',
    directFileSave:
      typeof window !== 'undefined' &&
      typeof (window as Window & { showSaveFilePicker?: unknown })
        .showSaveFilePicker === 'function',
  };
}

export async function yieldToBrowser(): Promise<void> {
  const schedulerWithYield = (
    globalThis as typeof globalThis & {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  if (schedulerWithYield?.yield) {
    await schedulerWithYield.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
