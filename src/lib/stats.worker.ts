import { computeStats, type DocStats } from './stats';

/** A request to count one text. `version` lets the caller drop answers to requests it has moved past. */
export interface StatsJob {
  version: number;
  content: string;
  plain: boolean;
}

export interface StatsReply {
  version: number;
  stats: DocStats;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<StatsJob>) => void) | null;
  postMessage: (reply: StatsReply) => void;
};

scope.onmessage = (e) => {
  const { version, content, plain } = e.data;
  scope.postMessage({ version, stats: computeStats(content, plain) });
};
