// SPDX-License-Identifier: MIT
//
// DRACO Adaptive Cost-Optimal Routing (ADR-040) — Phase 2.
//
// Phase 1 (ADR-038): a harness cannot beat the model on quality. Phase 2: can a
// harness CHOOSE the right model? The objective shifts from `quality` to
// `quality / dollar`, subject to quality >= frontier_baseline − ε.
//
// Method: run vanilla on each model in the pool, once per question, to build a
// per-question × per-model SCORE+TOKEN matrix. Every routing policy — always_X,
// the oracle (post-hoc per-question best), the constrained oracle, and any real
// router — is then a PURE function over that single matrix: one live run, every
// policy evaluated offline for free. Dependency-injected → offline-testable.

import type { OpenRouterTransport } from './fusion.js';
import type { UrlChecker } from './scorer.js';
import { scoreAnswer } from './scorer.js';
import { judgeFaithfulness, DRACO_JUDGE } from './judge.js';
import { vanillaResearch } from './optimized.js';
import { parseQuality } from './self-consistency.js';
import { costOf, BLENDED_USD_PER_MTOK } from './cost-efficiency.js';
import type { DracoCorpus } from './runner.js';

/** Holistic pre-signal prompt — NO URL re-fetch, so a real router can use it. */
const SIGNAL_PROMPT =
  'You are a research-quality judge. Rate the dossier below from 0.0 to 1.0 on ' +
  'overall quality (grounding, coverage, balance, faithfulness). You cannot fetch ' +
  'URLs — judge from the text alone. Reply with ONLY the number.';

/** One (question, model) cell: the DRACO quality + tokens for that model's dossier. */
export interface RoutingCell {
  quality: number;
  tokens: number;
  /**
   * Routing-time PRE-SIGNAL: a cheap holistic judge rating (0..1) of the dossier,
   * computed WITHOUT the scorer's URL re-fetch — i.e. exactly what a real router
   * can observe before committing. router_v2 may read this; the oracle may not
   * (the oracle uses the post-hoc `quality`). Present only when the matrix was
   * built with recordSignal.
   */
  signal?: number;
}

/** questionId -> model -> cell. The reusable artifact every policy reads. */
export interface RoutingMatrix {
  models: string[];
  questionIds: string[];
  cells: Record<string, Record<string, RoutingCell>>;
}

export interface PolicyResult {
  label: string;
  /** Per question, the model this policy picked. */
  picks: string[];
  quality: number; // mean DRACO quality of the picked dossiers
  costUSD: number; // total cost of the picked dossiers
  qualityPerUSD: number;
  /** Fraction of oracle quality-per-dollar (filled by analyse()). */
  pctOfOracle?: number;
  /** Fraction of oracle QUALITY — the constrained figure of merit (filled by analyse()). */
  pctOfOracleQuality?: number;
}

/**
 * Build the per-question × per-model matrix with one vanilla call per (q, model).
 * Bounded concurrency is the caller's responsibility (pass a pooled map if
 * desired); here questions run in order, models concurrently per question.
 */
export async function runRoutingMatrix(
  corpus: DracoCorpus,
  opts: {
    pool: string[];
    transport: OpenRouterTransport;
    checkUrl: UrlChecker;
    judgeTransport?: OpenRouterTransport;
    judgeModel?: string;
    limit?: number;
    concurrency?: number;
    onProgress?: (done: number, total: number, id: string) => void;
    /** Record the routing-time pre-signal per cell (a cheap holistic rating). */
    recordSignal?: boolean;
    /** Model for the pre-signal rating (default: judgeModel). A cheap model is realistic. */
    signalModel?: string;
    signalTransport?: OpenRouterTransport;
  },
): Promise<RoutingMatrix> {
  const judgeModel = opts.judgeModel ?? DRACO_JUDGE.model;
  let questions = corpus.questions;
  if (opts.limit != null) questions = questions.slice(0, opts.limit);
  const limit = Math.max(1, opts.concurrency ?? 4);

  const cells: Record<string, Record<string, RoutingCell>> = {};
  let done = 0;

  // Simple bounded pool over questions; models run concurrently within a question.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const qi = next++;
      if (qi >= questions.length) return;
      const q = questions[qi];
      const row: Record<string, RoutingCell> = {};
      await Promise.all(
        opts.pool.map(async (model) => {
          const r = await vanillaResearch({ id: q.id, prompt: q.prompt }, model, opts.transport);
          const dims = await scoreAnswer(r.answer, q.rubric, q.prompt, opts.checkUrl);
          let quality = dims.mean;
          if (opts.judgeTransport) {
            const j = await judgeFaithfulness(r.answer, opts.judgeTransport, judgeModel);
            // fold faithfulness into the composite the same way the ablations do
            quality = (dims.grounding + dims.coverage + dims.balance + dims.cleanliness + j.faithfulness) / 5;
          }
          let signal: number | undefined;
          if (opts.recordSignal) {
            const st = opts.signalTransport ?? opts.judgeTransport;
            const sm = opts.signalModel ?? judgeModel;
            if (st) {
              const s = await st(sm, [
                { role: 'system', content: SIGNAL_PROMPT },
                { role: 'user', content: r.answer },
              ]);
              signal = parseQuality(s.text);
            }
          }
          row[model] = { quality, tokens: r.totalTokens, ...(signal != null ? { signal } : {}) };
        }),
      );
      cells[q.id] = row;
      opts.onProgress?.(++done, questions.length, q.id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, questions.length) }, () => worker()));

  return { models: opts.pool, questionIds: questions.map((q) => q.id), cells };
}

// ── Pure policy evaluators over the matrix (offline, no API) ──────────────────

function evalPicks(m: RoutingMatrix, label: string, pick: (q: string) => string, prices = BLENDED_USD_PER_MTOK): PolicyResult {
  const picks = m.questionIds.map(pick);
  let qSum = 0;
  let cost = 0;
  m.questionIds.forEach((q, i) => {
    const cell = m.cells[q][picks[i]];
    qSum += cell.quality;
    cost += costOf(picks[i], cell.tokens, prices);
  });
  const quality = qSum / m.questionIds.length;
  return { label, picks, quality, costUSD: cost, qualityPerUSD: cost > 0 ? quality / cost : Infinity };
}

/** Always use `model`. */
export function alwaysPolicy(m: RoutingMatrix, model: string, prices = BLENDED_USD_PER_MTOK): PolicyResult {
  return evalPicks(m, `always_${model}`, () => model, prices);
}

/** Oracle: per question pick the highest-QUALITY model (post-hoc upper bound on quality). */
export function oracleQuality(m: RoutingMatrix, prices = BLENDED_USD_PER_MTOK): PolicyResult {
  return evalPicks(m, 'oracle_quality', (q) => bestBy(m, q, (c) => c.quality), prices);
}

/**
 * Cost-optimal oracle: per question pick the CHEAPEST model whose quality is
 * within ε of that question's best — the operational target (least money for
 * frontier-ε quality). This is the quality/dollar upper bound under the ADR-040
 * constraint.
 */
export function oracleCostOptimal(m: RoutingMatrix, epsilon: number, prices = BLENDED_USD_PER_MTOK): PolicyResult {
  return evalPicks(m, `oracle_cost_optimal(eps=${epsilon})`, (q) => {
    const best = m.cells[q][bestBy(m, q, (c) => c.quality)].quality;
    // among models within ε of the per-question best, take the cheapest.
    let pick = '';
    let pickCost = Infinity;
    for (const model of m.models) {
      const cell = m.cells[q][model];
      if (cell.quality >= best - epsilon) {
        const c = costOf(model, cell.tokens, prices);
        if (c < pickCost) { pickCost = c; pick = model; }
      }
    }
    return pick;
  }, prices);
}

/** A real router: a selection function seeing only the matrix's structure (caller supplies the policy). */
export function routerPolicy(m: RoutingMatrix, label: string, pick: (q: string, m: RoutingMatrix) => string, prices = BLENDED_USD_PER_MTOK): PolicyResult {
  return evalPicks(m, label, (q) => pick(q, m), prices);
}

/**
 * router_v2 — adaptive escalation. Run the cheap model; observe ONLY its
 * routing-time pre-signal (cell.signal, no URL re-fetch); if the signal is below
 * `threshold`, escalate to `escalateTo`, else keep the cheap dossier. This is an
 * HONEST router: it never reads the post-hoc `quality` the oracle uses — only
 * the signal a real deployment can see. Cost includes the cheap call always (you
 * pay for it before deciding) plus the escalation call when it fires.
 */
export function routerEscalate(
  m: RoutingMatrix,
  opts: { cheapModel: string; escalateTo: string; threshold: number },
  prices = BLENDED_USD_PER_MTOK,
): PolicyResult {
  const label = `router_v2(${opts.cheapModel.split('/').pop()}→${opts.escalateTo.split('/').pop()}@${opts.threshold})`;
  const picks: string[] = [];
  let qSum = 0;
  let cost = 0;
  for (const q of m.questionIds) {
    const cheap = m.cells[q][opts.cheapModel];
    const sig = cheap.signal ?? 0; // no signal recorded → treat as low → escalate (conservative)
    // Always pay for the cheap probe call.
    let questionCost = costOf(opts.cheapModel, cheap.tokens, prices);
    let chosen = opts.cheapModel;
    if (sig < opts.threshold) {
      const esc = m.cells[q][opts.escalateTo];
      questionCost += costOf(opts.escalateTo, esc.tokens, prices); // pay for the escalation too
      chosen = opts.escalateTo;
    }
    const cell = m.cells[q][chosen];
    qSum += cell.quality;
    cost += questionCost;
    picks.push(chosen);
  }
  const quality = qSum / m.questionIds.length;
  return { label, picks, quality, costUSD: cost, qualityPerUSD: cost > 0 ? quality / cost : Infinity };
}

/**
 * domain_router — a LEARNED router that needs no embeddings: route each question
 * to the model that historically wins its DOMAIN (the `sci-`/`fin-`/`law-`/`cur-`/
 * `tech-` id prefix). Trained LEAVE-ONE-OUT (for question q, learn the best model
 * from the OTHER questions of q's domain) so it never sees its own answer — an
 * honest generalisation estimate. This tests whether a real feature (domain)
 * captures the oracle gap the self-signal router (router_v2) could not.
 */
export function domainRouter(m: RoutingMatrix, prices = BLENDED_USD_PER_MTOK): PolicyResult {
  const domainOf = (qid: string) => qid.split('-')[0];
  const picks = m.questionIds.map((q) => {
    const d = domainOf(q);
    const peers = m.questionIds.filter((o) => o !== q && domainOf(o) === d);
    const pool = peers.length > 0 ? peers : m.questionIds.filter((o) => o !== q); // fallback: global
    // best mean-quality model over the peer (training) set
    let best = m.models[0];
    let bestMean = -Infinity;
    for (const model of m.models) {
      const mean = pool.reduce((s, o) => s + m.cells[o][model].quality, 0) / pool.length;
      if (mean > bestMean) { bestMean = mean; best = model; }
    }
    return best;
  });
  let qSum = 0, cost = 0;
  m.questionIds.forEach((q, i) => { qSum += m.cells[q][picks[i]].quality; cost += costOf(picks[i], m.cells[q][picks[i]].tokens, prices); });
  const quality = qSum / m.questionIds.length;
  return { label: 'domain_router(leave-one-out)', picks, quality, costUSD: cost, qualityPerUSD: cost > 0 ? quality / cost : Infinity };
}

/** Term-frequency vector from a prompt (lowercased word counts). Pure, no deps. */
function tf(text: string): Map<string, number> {
  const v = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) v.set(w, (v.get(w) ?? 0) + 1);
  return v;
}
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [w, x] of a) dot += x * (b.get(w) ?? 0);
  const na = Math.sqrt([...a.values()].reduce((s, x) => s + x * x, 0));
  const nb = Math.sqrt([...b.values()].reduce((s, x) => s + x * x, 0));
  return na && nb ? dot / (na * nb) : 0;
}

/**
 * knn_router — a richer LEARNED router than domain_router, still embedding-free:
 * for each question, find the k most TEXT-SIMILAR other questions (TF cosine over
 * the prompt) and route to the model with the best mean quality among them
 * (leave-one-out). Tests whether finer-grained question features capture more of
 * the oracle gap than the coarse 5-way domain label. A real embedding (tiny-
 * dancer) is the production upgrade of this same idea — semantic instead of TF.
 */
export function knnRouter(m: RoutingMatrix, prompts: Record<string, string>, k = 3, prices = BLENDED_USD_PER_MTOK): PolicyResult {
  const vecs = new Map(m.questionIds.map((q) => [q, tf(prompts[q] ?? q)]));
  const picks = m.questionIds.map((q) => {
    const sims = m.questionIds
      .filter((o) => o !== q)
      .map((o) => [o, cosine(vecs.get(q)!, vecs.get(o)!)] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([o]) => o);
    const pool = sims.length > 0 ? sims : m.questionIds.filter((o) => o !== q);
    let best = m.models[0];
    let bestMean = -Infinity;
    for (const model of m.models) {
      const mean = pool.reduce((s, o) => s + m.cells[o][model].quality, 0) / pool.length;
      if (mean > bestMean) { bestMean = mean; best = model; }
    }
    return best;
  });
  let qSum = 0, cost = 0;
  m.questionIds.forEach((q, i) => { qSum += m.cells[q][picks[i]].quality; cost += costOf(picks[i], m.cells[q][picks[i]].tokens, prices); });
  const quality = qSum / m.questionIds.length;
  return { label: `knn_router(k=${k})`, picks, quality, costUSD: cost, qualityPerUSD: cost > 0 ? quality / cost : Infinity };
}

function bestBy(m: RoutingMatrix, q: string, key: (c: RoutingCell) => number): string {
  let best = m.models[0];
  for (const model of m.models) if (key(m.cells[q][model]) > key(m.cells[q][best])) best = model;
  return best;
}

/**
 * Attach two figures of merit to every policy, measured against the oracle:
 *  - pctOfOracleQuality — quality / oracle.quality. The constrained objective:
 *    how close to perfect per-question routing on QUALITY. (Always-cheapest
 *    scores low here — it's cheap but low-quality.)
 *  - pctOfOracle — quality-per-dollar / oracle.qualityPerUSD. The raw q/$ ratio;
 *    a cheap policy can exceed 100% here while badly missing quality, which is
 *    exactly why quality% is reported alongside it.
 */
export function analyse(policies: PolicyResult[], oracle: PolicyResult): PolicyResult[] {
  return policies.map((p) => ({
    ...p,
    pctOfOracle: oracle.qualityPerUSD > 0 ? p.qualityPerUSD / oracle.qualityPerUSD : 0,
    pctOfOracleQuality: oracle.quality > 0 ? p.quality / oracle.quality : 0,
  }));
}
