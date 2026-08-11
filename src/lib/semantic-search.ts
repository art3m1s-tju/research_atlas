import path from "node:path";
import { fetchWithRetry } from "./resilient-fetch";

export const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER || "api").toLowerCase();
export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || (EMBEDDING_PROVIDER === "local" ? "Xenova/paraphrase-multilingual-MiniLM-L12-v2" : "qwen3.7-text-embedding");
const EMBEDDING_API_BASE_URL = (process.env.EMBEDDING_API_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || process.env.DASHSCOPE_API_KEY || "";
const EMBEDDING_DIMENSIONS = Math.max(64, Number(process.env.EMBEDDING_DIMENSIONS || 1024));
export const EMBEDDING_VERSION = `${EMBEDDING_PROVIDER}:${EMBEDDING_MODEL}:${EMBEDDING_PROVIDER === "local" ? "native" : EMBEDDING_DIMENSIONS}`;

const embeddingCacheDir =
  process.env.TRANSFORMERS_CACHE || path.join(process.cwd(), ".cache", "transformers");

let extractorPromise: Promise<any> | null = null;

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.cacheDir = embeddingCacheDir;
      env.allowRemoteModels = true;
      return pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" });
    })();
  }
  return extractorPromise;
}

async function embedTextWithApi(text: string): Promise<number[]> {
  if (!EMBEDDING_API_KEY) throw new Error("EMBEDDING_API_KEY 或 DASHSCOPE_API_KEY 未配置");
  const response = await fetchWithRetry(`${EMBEDDING_API_BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${EMBEDDING_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
      encoding_format: "float",
    }),
  }, {
    attempts: 3,
    timeoutMs: 60000,
    retryPost: true,
    retryStatusOnPost: true,
  });
  if (!response.ok) throw new Error(`Embedding API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json().catch(() => { throw new Error("Embedding API 返回了无法解析的 JSON"); }) as { data?: Array<{ embedding?: unknown }> };
  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || !embedding.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new Error("Embedding API 没有返回有效向量");
  }
  return embedding as number[];
}

export function paperEmbeddingText(paper: {
  title: string;
  abstract?: string | null;
  authors?: string | null;
  venue?: string | null;
}) {
  return [paper.title, paper.abstract, paper.authors, paper.venue]
    .filter(Boolean)
    .join("\n")
    .slice(0, 6000);
}

export async function embedText(text: string): Promise<number[]> {
  if (EMBEDDING_PROVIDER !== "local") return embedTextWithApi(text);
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array, Number);
}

export function parseEmbedding(value: string | null | undefined): number[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function lexicalScore(text: string, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1);
  if (!terms.length) return 0;
  const normalizedText = text.toLowerCase();
  const matched = terms.filter((term) => normalizedText.includes(term)).length;
  return matched / terms.length;
}
