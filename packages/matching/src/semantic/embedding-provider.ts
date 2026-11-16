import { z } from 'zod';

/**
 * Embedding port.
 *
 * The engine depends on this interface, never on a vendor SDK, so switching
 * provider — or running with none at all — is configuration rather than a
 * refactor. The semantic dimension is optional by design: it must add signal
 * when available and cost nothing when it is not.
 */

export interface EmbeddingResult {
  model: string;
  dimensions: number;
  vectors: number[][];
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  /** False when unconfigured; the engine then skips the semantic dimension. */
  isAvailable(): boolean;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<EmbeddingResult>;
}

/**
 * The default: no embeddings.
 *
 * Makes "matching works without a vector model" the tested path rather than an
 * untested fallback, so a missing API key is an ordinary state, not an outage.
 */
export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'null';
  readonly model = 'none';
  readonly dimensions = 0;
  isAvailable(): boolean {
    return false;
  }
  embed(): Promise<EmbeddingResult> {
    return Promise.reject(new Error('No embedding provider configured'));
  }
}

/**
 * Deterministic hashing embedder.
 *
 * Not a semantic model — it is a bag-of-tokens projection. It exists so the
 * semantic *pathway* (storage, staleness, dimension checks, similarity
 * arithmetic) is exercised end to end in tests and local runs without a paid
 * API, and so a missing key degrades to a weak signal rather than a crash. Its
 * id says so plainly; nothing should ship it to production believing otherwise.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'hashing-local';
  readonly model: string;

  constructor(readonly dimensions = 1536) {
    this.model = `hashing-local-${dimensions}`;
  }

  isAvailable(): boolean {
    return true;
  }

  embed(texts: readonly string[]): Promise<EmbeddingResult> {
    return Promise.resolve({
      model: this.model,
      dimensions: this.dimensions,
      vectors: texts.map((text) => this.project(text)),
    });
  }

  private project(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = text.toLowerCase().split(/[^a-z0-9+#.]+/).filter((t) => t.length > 1);
    for (const token of tokens) {
      let hash = 2166136261;
      for (let i = 0; i < token.length; i += 1) {
        hash ^= token.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const bucket = Math.abs(hash) % this.dimensions;
      // Sign from a second bit so unrelated tokens can cancel rather than only
      // ever accumulating, which would make every long text look similar.
      vector[bucket] = (vector[bucket] ?? 0) + ((hash & 1) === 0 ? 1 : -1);
    }

    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return norm === 0 ? vector : vector.map((v) => v / norm);
  }
}

/** Persisted vector shape, validated on read — a wrong-length vector is a bug. */
export const storedEmbeddingSchema = z.object({
  model: z.string().min(1).max(120),
  vector: z.array(z.number()).min(1),
});
export type StoredEmbedding = z.infer<typeof storedEmbeddingSchema>;
