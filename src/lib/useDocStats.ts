import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { computeStats, LARGE_DOC_CHARS, type DocStats } from './stats';
import type { StatsJob, StatsReply } from './stats.worker';

/** The part of a Worker that the runner uses. Tests pass a fake. */
export interface StatsWorker {
  postMessage(job: StatsJob): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<StatsReply>) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

/** Makes the worker, or returns null when there can't be one (the runner then counts on this thread). */
export type StatsWorkerFactory = () => StatsWorker | null;

export interface StatsRunner {
  /** Ask for the stats of this text. Only the newest request's result is delivered. */
  submit(content: string, plain: boolean): void;
  /** Stop the worker and forget unfinished work. The runner still works afterwards. */
  dispose(): void;
  /** Stop an idle worker so its memory (copies of a huge text) goes back to Windows. The next request starts a new one. */
  release(): void;
}

/**
 * At most one job is with the worker at a time. Requests that arrive meanwhile replace each other,
 * so only the newest text is ever waiting. A result for an older request is dropped.
 */
export function createStatsRunner(makeWorker: StatsWorkerFactory, onResult: (stats: DocStats) => void): StatsRunner {
  let version = 0;
  let newest: StatsJob | null = null; // the latest request, kept in case the worker fails
  let waiting: StatsJob | null = null; // the latest request not yet sent (always the newest)
  let inFlight: number | null = null; // version the worker is computing now
  let worker: StatsWorker | null = null;
  let broken = false; // no worker can be had: count on this thread from now on

  const countHere = (job: StatsJob) => onResult(computeStats(job.content, job.plain));

  function workerFor(): StatsWorker | null {
    if (worker || broken) return worker;
    let made: StatsWorker | null = null;
    try {
      made = makeWorker();
    } catch {
      made = null;
    }
    if (!made) {
      broken = true;
      return null;
    }
    const w = made;
    worker = w;
    w.onmessage = (e) => {
      if (worker !== w) return;
      inFlight = null;
      if (e.data.version === version) onResult(e.data.stats);
      pump();
    };
    w.onerror = () => {
      if (worker !== w) return;
      // The worker failed. Stop using it and count the newest text here.
      w.terminate();
      worker = null;
      broken = true;
      inFlight = null;
      waiting = null;
      if (newest) countHere(newest);
    };
    return w;
  }

  function pump() {
    if (inFlight !== null || !waiting) return;
    const job = waiting;
    waiting = null;
    const w = workerFor();
    if (!w) {
      countHere(job);
      return;
    }
    inFlight = job.version;
    w.postMessage(job);
  }

  return {
    submit(content, plain) {
      version++;
      newest = { version, content, plain };
      waiting = newest;
      pump();
    },
    dispose() {
      worker?.terminate();
      worker = null;
      inFlight = null;
      waiting = null;
    },
    release() {
      if (inFlight !== null || waiting) return;
      worker?.terminate();
      worker = null;
    },
  };
}

const workerFactory: StatsWorkerFactory = () => {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./stats.worker.ts', import.meta.url), { type: 'module' }) as unknown as StatsWorker;
};

const NOTHING_YET: DocStats = { words: 0, chars: 0, lines: 0, minutes: 0 };

/**
 * Stats for the status bar. Short texts are counted during render. Long ones are counted in a worker:
 * until the newest count arrives, the last known words and lines are shown with the current characters.
 * Without Worker support (tests, jsdom) everything is counted during render.
 */
export function useDocStats(content: string, plain: boolean): DocStats {
  const text = useDeferredValue(content);
  const threaded = text.length >= LARGE_DOC_CHARS && typeof Worker !== 'undefined';
  const [remote, setRemote] = useState<DocStats | null>(null);
  const [runner] = useState(() => createStatsRunner(workerFactory, setRemote));

  // Long texts are counted once typing pauses, not on every keystroke: each request copies the
  // whole text into the worker. An idle worker is stopped so those copies don't linger.
  useEffect(() => {
    if (!threaded) return;
    const submit = setTimeout(() => runner.submit(text, plain), remote ? 300 : 0);
    const release = setTimeout(() => runner.release(), 5000);
    return () => {
      clearTimeout(submit);
      clearTimeout(release);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner, threaded, text, plain]);
  useEffect(() => () => runner.dispose(), [runner]);

  const sync = useMemo(() => (threaded ? null : computeStats(text, plain)), [threaded, text, plain]);
  const lastKnown = useMemo(() => ({ ...(remote ?? NOTHING_YET), chars: text.length }), [remote, text.length]);
  return sync ?? lastKnown;
}
