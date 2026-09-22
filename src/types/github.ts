export interface GithubOwner {
  login: string;
  avatar_url: string;
}

export interface GithubLicense {
  key: string;
  name: string;
  spdx_id: string | null;
}

/** Fields we actually use from a GitHub repository-search result item. */
export interface GithubRepository {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  topics: string[];
  owner: GithubOwner;
  license: GithubLicense | null;
  archived: boolean;
  fork: boolean;
}

export interface GithubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GithubRepository[];
}

export interface GithubErrorResponse {
  message: string;
  documentation_url?: string;
}
