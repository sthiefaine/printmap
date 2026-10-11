export function fetchWithTimeout(
  url: string,
  options: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
}

export function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
