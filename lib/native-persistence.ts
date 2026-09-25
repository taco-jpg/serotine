/** Installed clients register a durable-storage barrier before mounting React.
 * The browser keeps its normal storage behavior and needs no native bridge. */
type NativeStorageBarrier = () => Promise<void>
let barrier: NativeStorageBarrier | undefined

export function registerNativeStorageBarrier(next: NativeStorageBarrier): void { barrier = next }
export async function flushNativeStorage(): Promise<void> { await barrier?.() }
export function nativeStorageLimits(): { fileBytes: number; bankBytes: number } | undefined {
  return barrier ? { fileBytes: 16 * 1024 ** 2, bankBytes: 32 * 1024 ** 2 } : undefined
}
