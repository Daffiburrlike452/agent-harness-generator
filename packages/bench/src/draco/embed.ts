// SPDX-License-Identifier: MIT
//
// DRACO embedding helper (ADR-040 embedding router). Batches text → dense
// vectors via OpenRouter's /embeddings endpoint (OpenRouter does proxy embedding
// models, e.g. openai/text-embedding-3-small, 1536-dim). Dependency-injected
// fetch so it's offline-testable; reads OPENROUTER_API_KEY from env on the live
// path. Tiny cost (the DRACO corpus is 20 short prompts).

export interface EmbedTransport {
  (texts: string[]): Promise<number[][]>;
}

export function openRouterEmbed(opts: {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
} = {}): EmbedTransport {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  const model = opts.model ?? 'openai/text-embedding-3-small';
  const baseUrl = opts.baseUrl ?? 'https://openrouter.ai/api/v1';
  const doFetch = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 5;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY required for the live embed transport.');
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return async (texts) => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res: Awaited<ReturnType<typeof doFetch>>;
      try {
        res = await doFetch(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: texts }),
        });
      } catch (err) {
        if (attempt === maxRetries) throw new Error(`embed → ${String((err as Error)?.message ?? err)} (after ${attempt} retries)`);
        await sleep(Math.min(1000 * 2 ** attempt, 16000));
        continue;
      }
      if (res.ok) {
        try {
          const json = JSON.parse(await res.text()) as { data?: { embedding: number[] }[] };
          const out = (json.data ?? []).map((d) => d.embedding);
          if (out.length !== texts.length) throw new Error(`embed returned ${out.length} of ${texts.length} vectors`);
          return out;
        } catch (err) {
          if (attempt === maxRetries) throw new Error(`embed parse failed: ${String((err as Error)?.message ?? err)}`);
          await sleep(Math.min(1000 * 2 ** attempt, 16000));
          continue;
        }
      }
      if (!(res.status === 429 || res.status >= 500) || attempt === maxRetries) {
        throw new Error(`embed → HTTP ${res.status}`);
      }
      await sleep(Math.min(1000 * 2 ** attempt, 16000));
    }
    throw new Error('embed: unreachable');
  };
}
