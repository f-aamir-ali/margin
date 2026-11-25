import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { computeStats, type DocStats } from './stats';
import { createStatsRunner, useDocStats, type StatsWorker } from './useDocStats';
import type { StatsJob, StatsReply } from './stats.worker';

interface FakeWorker extends StatsWorker {
  posted: StatsJob[];
  terminated: boolean;
  reply(r: StatsReply): void;
  fail(): void;
}

function fakeWorker(): FakeWorker {
  const posted: StatsJob[] = [];
  const w: FakeWorker = {
    posted,
    terminated: false,
    postMessage: (job) => {
      posted.push(job);
    },
    terminate: () => {
      w.terminated = true;
    },
    onmessage: null,
    onerror: null,
    reply: (r) => w.onmessage?.({ data: r } as MessageEvent<StatsReply>),
    fail: () => w.onerror?.({}),
  };
  return w;
}

describe('createStatsRunner', () => {
  it('keeps one job with the worker, and only the newest request waits', () => {
    const workers: FakeWorker[] = [];
    const got: DocStats[] = [];
    const runner = createStatsRunner(() => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    }, (s) => got.push(s));

    runner.submit('one two', false);
    runner.submit('one two three', false);
    runner.submit('one two three four', false);
    const w = workers[0];
    expect(w.posted.map((j) => j.version)).toEqual([1]);

    // The answer to job 1 is stale (job 3 is newest). It is dropped, and job 3 goes out next.
    w.reply({ version: 1, stats: computeStats('one two', false) });
    expect(got).toEqual([]);
    expect(w.posted.map((j) => j.version)).toEqual([1, 3]);

    w.reply({ version: 3, stats: computeStats('one two three four', false) });
    expect(got.map((s) => s.words)).toEqual([4]);
    expect(workers).toHaveLength(1);
  });

  it('counts on this thread when there is no worker', () => {
    const got: DocStats[] = [];
    const runner = createStatsRunner(() => null, (s) => got.push(s));
    runner.submit('a b c', false);
    expect(got.map((s) => s.words)).toEqual([3]);
  });

  it('counts on this thread when the worker cannot be made', () => {
    const got: DocStats[] = [];
    const runner = createStatsRunner(() => {
      throw new Error('blocked');
    }, (s) => got.push(s));
    runner.submit('a b', false);
    expect(got.map((s) => s.words)).toEqual([2]);
  });

  it('counts the newest text here if the worker fails, and never uses it again', () => {
    const workers: FakeWorker[] = [];
    const got: DocStats[] = [];
    const runner = createStatsRunner(() => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    }, (s) => got.push(s));
    runner.submit('a', false);
    runner.submit('a b c', false);
    workers[0].fail();
    expect(got.map((s) => s.words)).toEqual([3]);
    expect(workers[0].terminated).toBe(true);
    runner.submit('a b c d', false);
    expect(got.map((s) => s.words)).toEqual([3, 4]);
    expect(workers).toHaveLength(1);
  });

  it('dispose stops the worker, and the runner still works afterwards', () => {
    const workers: FakeWorker[] = [];
    const got: DocStats[] = [];
    const runner = createStatsRunner(() => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    }, (s) => got.push(s));
    runner.submit('a b', false);
    runner.dispose();
    expect(workers[0].terminated).toBe(true);
    workers[0].reply({ version: 1, stats: computeStats('a b', false) });
    expect(got).toEqual([]);
    runner.submit('a b c', false);
    expect(workers).toHaveLength(2);
    workers[1].reply({ version: 2, stats: computeStats('a b c', false) });
    expect(got.map((s) => s.words)).toEqual([3]);
  });
});

/** Renders the hook once on the server (effects don't run there) and returns what it produced. */
function statsDuring(content: string, plain: boolean): DocStats {
  const out: { stats?: DocStats } = {};
  function Probe() {
    out.stats = useDocStats(content, plain);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return out.stats as DocStats;
}

describe('useDocStats without a Worker (tests, jsdom)', () => {
  it('counts short text during render', () => {
    expect(statsDuring('Hello there, world.', false)).toEqual(computeStats('Hello there, world.', false));
  });

  it('falls back to counting during render for long text too', () => {
    const long = 'word '.repeat(50_000);
    const seen = statsDuring(long, true);
    expect(seen).toEqual(computeStats(long, true));
    expect(seen.chars).toBe(long.length);
  });
});
