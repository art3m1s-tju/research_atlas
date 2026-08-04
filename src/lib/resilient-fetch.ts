/**
 * Unified transient-failure retry for every outbound network call in the
 * translation pipeline.
 *
 * Rules:
 * - Transient HTTP statuses (408/425/429/5xx) are retried on safe methods,
 *   or on POST only when the caller explicitly opts in.
 * - Transient network errors (ECONNRESET, DNS, timeout, socket resets, ...)
 *   are retried; permanent errors (400/401/404, TLS certificate failures,
 *   user aborts) are surfaced immediately.
 * - Backoff is exponential with jitter and honors Retry-After when present.
 */

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "EPIPE",
  "EPROTO",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code || (error as { code?: string })?.code || "";
  if (RETRYABLE_NETWORK_CODES.has(code)) return true;
  if (error instanceof Error && error.name === "TimeoutError") return true;
  const message = error instanceof Error ? error.message : String(error);
  const detail = `${message} ${cause?.message || ""}`;
  return /socket hang up|network error|connection (?:closed|reset|refused|timed out)|temporary failure in name resolution|tls handshake/i.test(detail);
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

type RetryableStatusPredicate = (status: number) => boolean;

export type FetchWithRetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  /** Retry POST bodies on transient network errors (never on HTTP status unless retryStatusOnPost is set). */
  retryPost?: boolean;
  /** Also retry transient HTTP statuses for POST requests. */
  retryStatusOnPost?: boolean;
  retryableStatus?: RetryableStatusPredicate;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; error?: unknown; status?: number; delayMs: number }) => void;
};

function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.max(50, Math.round(exponential * (0.75 + Math.random() * 0.5)));
}

function retryAfterMs(response: Response, fallbackMs: number) {
  const value = response.headers.get("retry-after");
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(60000, seconds * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(60000, date - Date.now()));
  return fallbackMs;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function attemptSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const baseDelayMs = options.baseDelayMs ?? 800;
  const maxDelayMs = options.maxDelayMs ?? 15000;
  const timeoutMs = options.timeoutMs ?? 60000;
  const method = String(init.method || "GET").toUpperCase();
  const isPost = method === "POST";
  const retryableStatus = options.retryableStatus ?? isRetryableHttpStatus;
  const retryStatus = !isPost || options.retryStatusOnPost === true;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetch(url, { ...init, signal: attemptSignal(options.signal, timeoutMs) });
    } catch (error) {
      lastError = error;
      const retryable = (!isPost || options.retryPost === true) && isRetryableNetworkError(error);
      if (!retryable || attempt === attempts) throw error;
      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.({ attempt, error, delayMs });
      await sleep(delayMs, options.signal);
      continue;
    }
    const retryable = retryStatus && retryableStatus(response.status);
    if (!retryable || attempt === attempts) return response;
    await response.arrayBuffer().catch(() => null);
    const delayMs = retryAfterMs(response, backoffDelay(attempt, baseDelayMs, maxDelayMs));
    options.onRetry?.({ attempt, status: response.status, delayMs });
    await sleep(delayMs, options.signal);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
