import * as tl from "azure-pipelines-task-lib/task";
import { RestClient } from "typed-rest-client/RestClient";
import { BearerCredentialHandler } from "typed-rest-client/handlers/bearertoken";
import { IRequestOptions } from "typed-rest-client/Interfaces";
import { Branch, PullRequest } from "./rules";

interface ListResponse<T> {
  count: number;
  value: T[];
}

export interface GitRef {
  name: string;
  objectId: string;
}

export interface GitBranchStats {
  name: string;
  aheadCount: number;
  behindCount: number;
  isBaseVersion: boolean;
  commit: { author: { name: string; email: string; date: string } };
}

export interface GitPullRequest {
  pullRequestId: number;
  title: string;
  sourceRefName: string;
  targetRefName: string;
  creationDate: string;
  createdBy: { displayName: string };
  status: string;
}

export class GitClient {
  private readonly client: RestClient;
  private readonly repoUrl: string;

  constructor(collectionUri: string, projectName: string, repository: string, accessToken: string) {
    const options: IRequestOptions = {
      ignoreSslError: (tl.getVariable("Agent.SkipCertValidation") ?? "").toLowerCase() === "true",
    };
    const proxy = tl.getHttpProxyConfiguration(collectionUri);
    if (proxy) {
      options.proxy = proxy;
    }
    const cert = tl.getHttpCertConfiguration();
    if (cert) {
      options.cert = cert;
    }
    this.client = new RestClient("GitflowBranchGate", undefined, [new BearerCredentialHandler(accessToken)], options);
    this.repoUrl = `${collectionUri.replace(/\/+$/, "")}/${encodeURIComponent(projectName)}/_apis/git/repositories/${encodeURIComponent(repository)}`;
  }

  async getBranches(): Promise<GitRef[]> {
    return this.getList<GitRef>(`${this.repoUrl}/refs/heads?api-version=1.0`);
  }

  async getBranchStats(baseBranch: string): Promise<GitBranchStats[]> {
    return this.getList<GitBranchStats>(
      `${this.repoUrl}/stats/branches?baseVersion=${encodeURIComponent(baseBranch)}&api-version=1.0`
    );
  }

  async getActivePullRequests(): Promise<GitPullRequest[]> {
    return this.getList<GitPullRequest>(`${this.repoUrl}/pullRequests?api-version=3.0`);
  }

  private async getList<T>(url: string): Promise<T[]> {
    tl.debug(`GET ${url}`);
    const response = await this.client.get<ListResponse<T>>(url);
    if (response.statusCode !== 200 || !response.result) {
      throw new Error(`Request to ${url} failed with status ${response.statusCode}`);
    }
    return response.result.value ?? [];
  }
}

export function toBranches(stats: GitBranchStats[], now: Date = new Date()): Branch[] {
  return stats.map((s) => {
    const modified = new Date(s.commit.author.date);
    return {
      branchName: s.name,
      master: { behind: s.behindCount ?? 0, ahead: s.aheadCount ?? 0 },
      develop: { behind: 0, ahead: 0 },
      staleDays: Math.trunc((now.getTime() - modified.getTime()) / 86_400_000),
      modified,
      modifiedBy: s.commit.author.name,
      modifiedByEmail: s.commit.author.email,
      isBaseVersion: s.isBaseVersion,
      sourcePullRequests: 0,
      targetPullRequests: 0,
      pullRequests: [],
      errors: [],
    };
  });
}

export function addDevelopCompare(branches: Branch[], comparedToDevelop: GitBranchStats[]): void {
  for (const branch of branches) {
    const match = comparedToDevelop.find((s) => s.name.toLowerCase() === branch.branchName.toLowerCase());
    branch.develop = { behind: match?.behindCount ?? 0, ahead: match?.aheadCount ?? 0 };
  }
}

export function toPullRequests(pullRequests: GitPullRequest[]): PullRequest[] {
  const shortName = (ref: string) => ref.replace("refs/heads/", "");
  return pullRequests.map((pr) => ({
    id: Number(pr.pullRequestId),
    title: pr.title,
    sourceBranch: shortName(pr.sourceRefName),
    targetBranch: shortName(pr.targetRefName),
    created: new Date(pr.creationDate),
    createdBy: pr.createdBy?.displayName ?? "",
    status: pr.status,
  }));
}
