// SPDX-License-Identifier: MIT
//
// MCP dispatch integration test — exercises the full ToolDispatcher
// surface end-to-end as a real MCP-shaped flow:
//
//   register   →  agent declares tools available on a server
//   dispatch   →  with valid + invalid + expired + wrong-resource claims
//   outcomes   →  result / denied / not-found / bad-args
//
// Iter 10 shipped the dispatcher but only had unit tests for the
// capability+resource matchers. This pins the FULL execution shape
// that a real MCP client would observe.

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolDispatcher } from '../packages/kernel-js/src/dispatch.js';
import type { ToolClaim } from '../packages/kernel-js/src/dispatch.js';

const NOW_UNIX = 1_700_000_000;
const FUTURE = NOW_UNIX + 86_400;
const PAST = NOW_UNIX - 86_400;

describe('MCP dispatch integration', () => {
  let d: ToolDispatcher;

  beforeEach(() => {
    d = new ToolDispatcher();
    // Register a handful of "tools" that mimic what a real MCP server
    // exposes: a memory store, a search, an evaluator that throws.
    d.register('mem', 'store', async args => ({ stored: true, key: args.key }));
    d.register('mem', 'search', async args => ({ hits: [`match-${args.query}`] }));
    d.register('eval', 'run', async args => {
      if (args.crash === true) throw new Error('intentional crash');
      return { value: 42 };
    });
  });

  it('happy path: registered tool with matching claim returns result', async () => {
    const claims: ToolClaim[] = [
      { capability: 'tool.invoke.mem.store', expires_at: FUTURE },
    ];
    const out = await d.dispatch({
      server: 'mem', tool: 'store',
      args: { key: 'foo', value: 'bar' },
      claims,
    }, NOW_UNIX);
    expect(out.kind).toBe('result');
    if (out.kind === 'result') expect(out.output).toEqual({ stored: true, key: 'foo' });
  });

  it('not-found: unregistered tool surfaces server+tool in the outcome', async () => {
    const out = await d.dispatch({
      server: 'mem', tool: 'noexist',
      args: {},
      claims: [{ capability: '*', expires_at: FUTURE }],
    }, NOW_UNIX);
    expect(out.kind).toBe('not-found');
    if (out.kind === 'not-found') {
      expect(out.server).toBe('mem');
      expect(out.tool).toBe('noexist');
    }
  });

  it('denied: no matching claim returns denied with reason naming the capability', async () => {
    const out = await d.dispatch({
      server: 'mem', tool: 'store',
      args: { key: 'x' },
      claims: [{ capability: 'tool.invoke.mem.search', expires_at: FUTURE }],
    }, NOW_UNIX);
    expect(out.kind).toBe('denied');
    if (out.kind === 'denied') expect(out.reason).toMatch(/tool\.invoke\.mem\.store/);
  });

  it('denied: expired claim does NOT authorise', async () => {
    const out = await d.dispatch({
      server: 'mem', tool: 'store',
      args: { key: 'x' },
      claims: [{ capability: 'tool.invoke.mem.store', expires_at: PAST }],
    }, NOW_UNIX);
    expect(out.kind).toBe('denied');
  });

  it('bad-args: array or null args returns bad-args, never reaches the handler', async () => {
    let handlerCalls = 0;
    d.register('safe', 'tool', async () => { handlerCalls++; return {}; });
    const claims: ToolClaim[] = [{ capability: '*', expires_at: FUTURE }];
    // @ts-expect-error - intentionally bad args shape
    const arrOut = await d.dispatch({ server: 'safe', tool: 'tool', args: [], claims }, NOW_UNIX);
    expect(arrOut.kind).toBe('bad-args');
    // @ts-expect-error - intentionally bad args shape
    const nullOut = await d.dispatch({ server: 'safe', tool: 'tool', args: null, claims }, NOW_UNIX);
    expect(nullOut.kind).toBe('bad-args');
    expect(handlerCalls, 'handler must NOT run on bad-args').toBe(0);
  });

  it('handler throws: outcome is denied with the throw message (not result)', async () => {
    const out = await d.dispatch({
      server: 'eval', tool: 'run',
      args: { crash: true },
      claims: [{ capability: 'tool.invoke.eval.run', expires_at: FUTURE }],
    }, NOW_UNIX);
    expect(out.kind).toBe('denied');
    if (out.kind === 'denied') expect(out.reason).toBe('intentional crash');
  });

  it('wildcard capability: `*` authorises every tool', async () => {
    const claims: ToolClaim[] = [{ capability: '*', expires_at: FUTURE }];
    for (const [s, t] of [['mem', 'store'], ['mem', 'search'], ['eval', 'run']]) {
      const out = await d.dispatch({ server: s, tool: t, args: { query: 'x' }, claims }, NOW_UNIX);
      expect(out.kind, `${s}/${t}`).toBe('result');
    }
  });

  it('prefix capability: `tool.invoke.mem.*` authorises ALL mem.* tools but not eval.*', async () => {
    const claims: ToolClaim[] = [{ capability: 'tool.invoke.mem.*', expires_at: FUTURE }];
    const store = await d.dispatch({ server: 'mem', tool: 'store', args: { key: 'x' }, claims }, NOW_UNIX);
    expect(store.kind).toBe('result');
    const search = await d.dispatch({ server: 'mem', tool: 'search', args: { query: 'x' }, claims }, NOW_UNIX);
    expect(search.kind).toBe('result');
    const evalRun = await d.dispatch({ server: 'eval', tool: 'run', args: {}, claims }, NOW_UNIX);
    expect(evalRun.kind).toBe('denied');
  });

  it('resource scoping: granted ns/x matches ns/x, not ns/y, and ns/* matches both', async () => {
    d.register('store', 'put', async () => ({ ok: true }));
    // Narrow grant: only ns/x
    const narrow: ToolClaim[] = [{ capability: 'tool.invoke.store.put', resource: 'ns/x', expires_at: FUTURE }];
    const match = await d.dispatch({ server: 'store', tool: 'put', args: {}, resource: 'ns/x', claims: narrow }, NOW_UNIX);
    expect(match.kind).toBe('result');
    const wrong = await d.dispatch({ server: 'store', tool: 'put', args: {}, resource: 'ns/y', claims: narrow }, NOW_UNIX);
    expect(wrong.kind).toBe('denied');
    // Wildcard resource grant: ns/* matches both
    const wild: ToolClaim[] = [{ capability: 'tool.invoke.store.put', resource: 'ns/*', expires_at: FUTURE }];
    const w1 = await d.dispatch({ server: 'store', tool: 'put', args: {}, resource: 'ns/x', claims: wild }, NOW_UNIX);
    expect(w1.kind).toBe('result');
    const w2 = await d.dispatch({ server: 'store', tool: 'put', args: {}, resource: 'ns/y', claims: wild }, NOW_UNIX);
    expect(w2.kind).toBe('result');
  });

  it('multiple claims: ANY matching claim is sufficient', async () => {
    const claims: ToolClaim[] = [
      { capability: 'tool.invoke.unrelated.x', expires_at: FUTURE },
      { capability: 'tool.invoke.mem.store', expires_at: FUTURE },
      { capability: 'tool.invoke.also-unrelated', expires_at: PAST },
    ];
    const out = await d.dispatch({ server: 'mem', tool: 'store', args: { key: 'x' }, claims }, NOW_UNIX);
    expect(out.kind).toBe('result');
  });

  it('end-to-end realistic flow: register + claim issue + dispatch + revoke + dispatch', async () => {
    // Simulates: agent gets a claim, uses a tool, claim expires, next call denied.
    d.register('cache', 'get', async args => ({ value: `cached-${args.k}` }));
    let claims: ToolClaim[] = [{ capability: 'tool.invoke.cache.*', resource: 'tenant-A/*', expires_at: NOW_UNIX + 60 }];

    // First call: within window
    const live = await d.dispatch({ server: 'cache', tool: 'get', args: { k: 'hot' }, resource: 'tenant-A/cache', claims }, NOW_UNIX);
    expect(live.kind).toBe('result');

    // Same call after expiry: denied
    const expired = await d.dispatch({ server: 'cache', tool: 'get', args: { k: 'hot' }, resource: 'tenant-A/cache', claims }, NOW_UNIX + 120);
    expect(expired.kind).toBe('denied');

    // Re-issued claim with new expiry: result again
    claims = [{ capability: 'tool.invoke.cache.*', resource: 'tenant-A/*', expires_at: NOW_UNIX + 180 }];
    const renewed = await d.dispatch({ server: 'cache', tool: 'get', args: { k: 'hot' }, resource: 'tenant-A/cache', claims }, NOW_UNIX + 120);
    expect(renewed.kind).toBe('result');
  });
});
