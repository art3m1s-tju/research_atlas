import assert from "node:assert/strict";
import test from "node:test";

process.env.EMBEDDING_PROVIDER = "api";
process.env.EMBEDDING_API_KEY = "test-key";
process.env.EMBEDDING_API_BASE_URL = "https://embedding.test/v1";
process.env.EMBEDDING_MODEL = "qwen3.7-text-embedding";
process.env.EMBEDDING_DIMENSIONS = "1024";

test("cloud embedding provider sends an OpenAI-compatible request", async () => {
  const semanticSearch = await import("../src/lib/semantic-search");
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    assert.deepEqual(await semanticSearch.embedText("自动驾驶世界模型"), [0.1, 0.2, 0.3]);
    assert.deepEqual(requestBody, {
      model: "qwen3.7-text-embedding",
      input: "自动驾驶世界模型",
      dimensions: 1024,
      encoding_format: "float",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
