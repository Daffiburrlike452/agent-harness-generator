// SPDX-License-Identifier: MIT
//
// DRACO M3 — deterministic scorer (ADR-037 §3, dimensions 1-3 + 5).
//
// Scores a fused answer against a question's rubric using ONLY machine-checkable
// signals — no LLM. The LLM-judge "faithfulness" dimension is M4. Every check
// here is deterministic + reproducible: same answer + same rubric → same score.
//
// Dimensions (each 0-1):
//   - grounding   fraction of cited URLs that RESOLVE (injected fetch). A
//                 must_not "fabricated"/"no citation" hit hard-zeroes it.
//   - coverage    fraction of rubric must_contain terms present (case-insensitive).
//   - balance     for questions demanding multiple positions, are ≥2 present.
//   - cleanliness 1 minus fraction of must_not anti-patterns present.
// The quality MEAN is the mean of those four. Efficiency (tokens/wall/usd) is
// reported separately — it gates regression but is not part of the quality mean
// (ADR-037 §3).
//
// The URL re-fetch is dependency-injected (UrlChecker), so the scorer runs
// fully OFFLINE in tests + the --no-judge CI path.

export interface Rubric {
  must_cite?: string[];
  must_contain?: string[];
  must_not?: string[];
  grader?: string;
}

/** Resolves a URL to "ok" / "dead" / "mismatch". Injected so tests are offline. */
export type UrlChecker = (url: string) => Promise<'ok' | 'dead' | 'mismatch'>;

export interface DimensionScores {
  grounding: number;
  coverage: number;
  balance: number;
  cleanliness: number;
  /** Mean of the four quality dimensions. */
  mean: number;
}

const URL_RE = /https?:\/\/[^\s)\]]+/g;

/** Markers that a balance-demanding question wants more than one position. */
const BALANCE_PROMPT_RE = /\b(dissent|dissenting|both|two\s+strongest|multiple|opposing|counter|unresolved|trade-?offs?)\b/i;

/** must_not patterns that, if present, hard-zero grounding. */
const FABRICATION_RE = /(fabricat|no citation|unverified)/i;

function fractionPresent(text: string, terms: string[] | undefined): number {
  if (!terms || terms.length === 0) return 1; // nothing required → full marks
  const lc = text.toLowerCase();
  const hit = terms.filter((t) => lc.includes(t.toLowerCase())).length;
  return hit / terms.length;
}

/** Extract unique URLs from the answer text. */
export function extractUrls(text: string): string[] {
  return [...new Set(text.match(URL_RE) ?? [])];
}

/**
 * Score one answer against one rubric. `prompt` is used only for the balance
 * heuristic (does the QUESTION demand multiple positions?). `checkUrl` is
 * injected; in offline runs it's a deterministic mock.
 */
export async function scoreAnswer(
  answer: string,
  rubric: Rubric,
  prompt: string,
  checkUrl: UrlChecker,
): Promise<DimensionScores> {
  // coverage
  const coverage = fractionPresent(answer, rubric.must_contain);

  // cleanliness — penalise must_not anti-patterns
  const lc = answer.toLowerCase();
  const badHits = (rubric.must_not ?? []).filter((p) => lc.includes(p.toLowerCase())).length;
  const cleanliness = rubric.must_not && rubric.must_not.length
    ? 1 - badHits / rubric.must_not.length
    : 1;

  // grounding — re-fetch cited URLs; fraction that resolve. A fabrication
  // anti-pattern present in must_not AND matched in the answer hard-zeroes it.
  const urls = extractUrls(answer);
  let grounding: number;
  if (urls.length === 0) {
    grounding = 0; // unsourced claims cannot be grounded
  } else {
    const results = await Promise.all(urls.map((u) => checkUrl(u)));
    grounding = results.filter((r) => r === 'ok').length / urls.length;
  }
  const fabricationFlagged = (rubric.must_not ?? []).some((p) => FABRICATION_RE.test(p) && lc.includes(p.toLowerCase()));
  if (fabricationFlagged) grounding = 0;

  // balance — only graded for questions whose PROMPT demands multiple positions.
  let balance: number;
  if (BALANCE_PROMPT_RE.test(prompt)) {
    // Heuristic: count distinct position markers in the answer.
    const positionMarkers = (answer.match(/\b(however|on the other hand|in contrast|dissent|critics?|alternatively|whereas|conversely)\b/gi) ?? []).length;
    balance = positionMarkers >= 2 ? 1 : positionMarkers === 1 ? 0.5 : 0;
  } else {
    balance = 1; // not a balance question → not penalised
  }

  const mean = (grounding + coverage + balance + cleanliness) / 4;
  return { grounding, coverage, balance, cleanliness, mean };
}

/**
 * A live URL checker: GET each URL, "ok" on 2xx, "dead" otherwise.
 * Injected separately so the scorer core stays offline-testable. Not used in
 * --no-judge CI (which passes a mock); reserved for full judged runs.
 *
 * CRITICAL: each request is bounded by an AbortController timeout. Without it a
 * single dead/slow/hung domain stalls the WHOLE run — the grounding pass (ADR-038
 * arms 5+6) checks every cited + pooled URL (often dozens of likely-dead links),
 * so an unbounded fetch on one hanging host froze a live grounded run at 5/20.
 * A timed-out / errored request is treated as "dead" (an unreachable citation is,
 * for grounding purposes, exactly that).
 */
export function liveUrlChecker(fetchImpl: typeof fetch = fetch, opts: { timeoutMs?: number } = {}): UrlChecker {
  const timeoutMs = opts.timeoutMs ?? 8000;
  return async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'GET', signal: ctrl.signal });
      return res.ok ? 'ok' : 'dead';
    } catch {
      return 'dead'; // network error, timeout/abort, bad URL → unreachable = dead
    } finally {
      clearTimeout(timer);
    }
  };
}
