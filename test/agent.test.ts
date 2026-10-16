import { describe, expect, it } from 'vitest';
import { AGENTS, extractLastJson, fillTemplate, parseCopilotEvents, parseCopilotUsage, safeTestVars } from '../src/agent.js';

describe('fillTemplate', () => {
  it('replaces known vars and leaves unknown ones', () => {
    expect(fillTemplate('{{a}} and {{b}}', { a: 'x' })).toBe('x and {{b}}');
  });
  it('does not re-expand placeholders that appear inside values', () => {
    expect(fillTemplate('{{body}} / {{secret}}', { body: '{{secret}}', secret: 'S' })).toBe('{{secret}} / S');
  });
});

describe('extractLastJson', () => {
  it('prefers the last json fence', () => {
    const text = 'first ```json\n{"a":1}\n``` then ```json\n{"a":2}\n```';
    expect(extractLastJson(text)).toEqual({ a: 2 });
  });
  it('falls back to the last bare object, including nested braces', () => {
    expect(extractLastJson('blah {"x": {"y": [1,2]}} trailing')).toEqual({ x: { y: [1, 2] } });
  });
  it('skips a broken fence and uses an earlier valid one', () => {
    expect(extractLastJson('```json\n{"ok":true}\n```\n```json\n{oops\n```')).toEqual({ ok: true });
  });
  it('throws when there is no JSON', () => {
    expect(() => extractLastJson('no json here')).toThrow();
  });
});

describe('agent schemas', () => {
  it('rejects test vars that could inject shell', () => {
    expect(safeTestVars({ testClass: 'Foo; curl evil' })).toBe(false);
    expect(safeTestVars({ module: 'core', task: 'S3UnitTest', testClass: 'kafka.log.FooTest' })).toBe(true);
  });
  it('accepts Go package paths in test vars but not ..', () => {
    expect(safeTestVars({ pkg: './internal/diff', test: 'TestParse/bare_header' })).toBe(true);
    expect(safeTestVars({ pkg: '../../etc' })).toBe(false);
    expect(safeTestVars({ test: "TestA' ; rm -rf / '" })).toBe(false);
  });
  it('lets a reproducer that found nothing return any test vars', () => {
    const r = { reproduced: false, testFiles: [], testVars: { test: '' }, notes: '' };
    expect(AGENTS.reproducer.schema.safeParse(r).success).toBe(true);
  });
  it('rejects an unknown reviewer verdict', () => {
    expect(AGENTS.reviewer.schema.safeParse({ verdict: 'maybe', reasons: [] }).success).toBe(false);
  });
});

describe('parseCopilotEvents', () => {
  it('keeps the last tool calls and the spend of a run that was killed', () => {
    const lines = [
      { type: 'tool.execution_start', timestamp: 't1', data: { toolName: 'bash', arguments: { command: 'go test\n  ./pkg/...' } } },
      { type: 'session.usage_record', data: { usage: { model: 'm', inputTokens: 100, outputTokens: 10, copilotUsage: { totalNanoAiu: 20e9 } } } },
      { type: 'tool.execution_start', timestamp: 't2', data: { toolName: 'view', arguments: { path: 'a.go' } } },
      { type: 'session.usage_record', data: { usage: { model: 'm', inputTokens: 50, outputTokens: 5, copilotUsage: { totalNanoAiu: 10e9 } } } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n{"type":"tool.exec'; // cut off mid-write
    expect(parseCopilotEvents(lines, 1)).toEqual({
      lastTools: ['t2 view: a.go'], models: ['m'], inputTokens: 150, outputTokens: 15, cost: 0.3,
    });
    expect(parseCopilotEvents(lines).lastTools[0]).toBe('t1 bash: go test ./pkg/...');
  });
});

describe('parseCopilotUsage', () => {
  it('converts AI credits to dollars and sums tokens across models', () => {
    const usage = {
      totalNanoAiu: 42e9,
      totalPremiumRequestCost: 0,
      lastCallInputTokens: 9, lastCallOutputTokens: 9,
      modelMetrics: { a: { usage: { inputTokens: 1000, outputTokens: 200 } }, b: { usage: { inputTokens: 500, outputTokens: 50 } } },
      // The real file repeats the per-model numbers here; they must not be counted twice.
      agentMetrics: { main: { modelMetrics: { a: { usage: { inputTokens: 1000, outputTokens: 200 } } } } },
    };
    expect(parseCopilotUsage(usage)).toEqual({ cost: 0.42, inputTokens: 1500, outputTokens: 250, models: ['a', 'b'] });
  });
  it('returns nulls when the file has no recognisable fields', () => {
    expect(parseCopilotUsage({ foo: 1 })).toEqual({ cost: null, inputTokens: null, outputTokens: null, models: [] });
  });
});
