export type HackerNewsItemType = "story" | "comment" | "job" | "poll" | "pollopt";

export interface HackerNewsItem {
  id: number;
  type?: HackerNewsItemType;
  by?: string;
  time?: number;
  title?: string;
  url?: string;
  score?: number;
  descendants?: number;
  kids?: number[];
  text?: string;
  deleted?: boolean;
  dead?: boolean;
}
