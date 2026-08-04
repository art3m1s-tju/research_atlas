import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithRetry, isRetryableHttpStatus, isRetryableNetworkError } from "../src/lib/resilient-fetch";

const originalFetch = globalThis.fetch;

function mockFetch(implementation: (url: string | URL, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = implementation as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

test("ECONNRESET is a retryable transient network error (P0 regression)", () => {
  const error = new Error("fetch failed", { cause: { code: "ECONNRESET", message: "read ECONNRESET" } });
  assert.equal(isRetryableNetworkError(error), true);
});

test("DNS and timeout failures are retryable; user aborts are not", () => {
  assert.equal(isRetryableNetworkError(new Error("fetch failed", { cause: { code: "ENOTFOUND" } })), true);
  assert.equal(isRetryableNetworkError(new Error("fetch failed", { cause: { code: "ETIMEDOUT" } })), true);
  assert.equal(isRetryableNetworkError(new DOMException("Aborted", "AbortError")), false);
  assert.equal(isRetryableNetworkError(new Error("fetch failed", { cause: { code: "ERR_CERT_DATE_INVALID" } })), false);
});

test("only transient HTTP statuses are retryable", () => {
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(500), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(400), false);
  assert.equal(isRetryableHttpStatus(401), false);
  assert.equal(isRetryableHttpStatus(404), false);
});

test("fetchWithRetry retries a transient ECONNRESET and succeeds", async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    if (calls === 1) throw new Error("fetch failed", { cause: { code: "ECONNRESET" } });
    return new Response("ok", { status: 200 });
  });
  try {
    const response = await fetchWithRetry("https://example.com/paper.pdf", {}, { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test("fetchWithRetry does not retry permanent HTTP statuses", async () => {
  let calls = 0;
  const restore = mockFetch(() => {
    calls += 1;
    return new Response("not found", { status: 404 });
  });
  try {
    const response = await fetchWithRetry("https://example.com/missing", {}, { attempts: 3, baseDelayMs: 1 });
    assert.equal(response.status, 404);
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test("fetchWithRetry retries transient 5xx and honors Retry-After", async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    if (calls === 1) return new Response("busy", { status: 503, headers: { "Retry-After": "0" } });
    return new Response("ok", { status: 200 });
  });
  try {
    const response = await fetchWithRetry("https://example.com/landing", {}, { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test("fetchWithRetry does not retry POST HTTP statuses unless opted in", async () => {
  let calls = 0;
  const restore = mockFetch(() => {
    calls += 1;
    return new Response("over limit", { status: 429 });
  });
  try {
    const response = await fetchWithRetry("https://example.com/ocr", { method: "POST" }, { attempts: 3, baseDelayMs: 1, retryPost: true });
    assert.equal(response.status, 429);
    assert.equal(calls, 1);
    const optedIn = await fetchWithRetry("https://example.com/chat", { method: "POST" }, { attempts: 3, baseDelayMs: 1, retryPost: true, retryStatusOnPost: true });
    assert.equal(optedIn.status, 429);
    assert.equal(calls, 4);
  } finally {
    restore();
  }
});

test("fetchWithRetry retries POST network errors when retryPost is enabled", async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    if (calls === 1) throw new Error("fetch failed", { cause: { code: "ECONNRESET" } });
    return new Response("accepted", { status: 200 });
  });
  try {
    const response = await fetchWithRetry("https://example.com/ocr", { method: "POST" }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 5, retryPost: true });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test("fetchWithRetry propagates an external abort without retrying", async () => {
  let calls = 0;
  const controller = new AbortController();
  const restore = mockFetch(async () => {
    calls += 1;
    throw new DOMException("Aborted", "AbortError");
  });
  controller.abort();
  try {
    await assert.rejects(
      fetchWithRetry("https://example.com/paper.pdf", { signal: controller.signal }, { attempts: 3, baseDelayMs: 1 }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});
