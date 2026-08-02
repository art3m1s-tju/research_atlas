import path from "node:path";

export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

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
