import { equalsIgnoreCase, isLike } from "./wildcard";

export type IssueType = "Info" | "Warning" | "Error";

export interface Issue {
  type: IssueType;
  message: string;
}

export interface Compare {
  behind: number;
  ahead: number;
}

export interface PullRequest {
  id: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  created: Date;
  createdBy: string;
  status: string;
}

export interface Branch {
  branchName: string;
  master: Compare;
  develop: Compare;
  staleDays: number;
  modified: Date;
  modifiedBy: string;
  modifiedByEmail: string;
  isBaseVersion: boolean;
  sourcePullRequests: number;
  targetPullRequests: number;
  pullRequests: PullRequest[];
  errors: Issue[];
}

export interface Build {
  buildDefinitionId: string;
  sourceBranch: string;
  buildReason: string;
  pullRequestId: number;
}

export interface Rules {
  masterBranch: string;
  developBranch: string;
  hotfixPrefix: string;
  releasePrefix: string;
  featurePrefix: string;

  hotfixBranchLimit: number;
  hotfixDaysLimit: number;
  releaseBranchLimit: number;
  releaseDaysLimit: number;
  featureBranchLimit: number;
  featureDaysLimit: number;

  hotfixBranchesMustNotBeBehindMaster: boolean;
  releaseBranchesMustNotBeBehindMaster: boolean;
  developMustNotBeBehindMaster: boolean;
  featureBranchesMustNotBeBehindMaster: boolean;
  featureBranchesMustNotBeBehindDevelop: boolean;
  currentFeatureMustNotBeBehindDevelop: boolean;
  currentFeatureMustNotBeBehindMaster: boolean;
  mustNotHaveHotfixAndReleaseBranches: boolean;
  masterMustNotHaveActivePullRequests: boolean;
  hotfixBranchesMustNotHaveActivePullRequests: boolean;
  releaseBranchesMustNotHaveActivePullRequests: boolean;
  branchNamesMustMatchConventions: boolean;

  bypassBranchesWithNameMatchingPattern: string;
}

export interface BranchIssue extends Issue {
  branchName: string;
}

export function addPullRequests(branches: Branch[], pullRequests: PullRequest[]): void {
  for (const branch of branches) {
    const isSource = (pr: PullRequest) => equalsIgnoreCase(pr.sourceBranch, branch.branchName);
    const isTarget = (pr: PullRequest) => equalsIgnoreCase(pr.targetBranch, branch.branchName);
    branch.pullRequests.push(...pullRequests.filter((pr) => isSource(pr) || isTarget(pr)));
    branch.sourcePullRequests = pullRequests.filter(isSource).length;
    branch.targetPullRequests = pullRequests.filter(isTarget).length;
  }
}

export function invokeBranchRules(
  branches: Branch[],
  build: Build,
  rules: Rules,
  verbose: (message: string) => void = () => {}
): void {
  const isPullRequestBuild = build.buildReason === "PullRequest";
  const countLike = (pattern: string) => branches.filter((b) => isLike(b.branchName, pattern)).length;
  const add = (branch: Branch, type: IssueType, message: string) => branch.errors.push({ type, message });

  for (const branch of branches) {
    const name = branch.branchName;

    if (isLike(name, rules.bypassBranchesWithNameMatchingPattern)) {
      verbose(`${name} bypassed from branch rules. Skipping rule checks`);
      continue;
    }

    const isCurrentPullRequest = branch.pullRequests.some((pr) => pr.id === build.pullRequestId);
    const prRuleApplies = !isPullRequestBuild || !isCurrentPullRequest;

    if (equalsIgnoreCase(name, rules.masterBranch)) {
      if (rules.masterMustNotHaveActivePullRequests && branch.targetPullRequests > 0 && !isPullRequestBuild) {
        add(branch, "Error", `${name} has an active Pull Request.`);
      }
      if (rules.masterMustNotHaveActivePullRequests && branch.sourcePullRequests > 0 && !isPullRequestBuild) {
        add(branch, "Error", `${name} has an active Pull Request targeting another branch.`);
      }
    }

    if (equalsIgnoreCase(name, rules.developBranch)) {
      if (rules.developMustNotBeBehindMaster && branch.master.behind > 0) {
        if (prRuleApplies) {
          add(branch, "Error", `${name} is missing ${branch.master.behind} commit(s) from ${rules.masterBranch}`);
        } else {
          verbose(`Rule Skipped: [DevelopMustNotBeBehindMaster]. Current build was initiated from PR [${build.pullRequestId}]`);
        }
      }
    }

    if (isLike(name, rules.hotfixPrefix)) {
      if (rules.hotfixBranchLimit < countLike(rules.hotfixPrefix)) {
        add(branch, "Error", "Hotfix branch limit reached");
      }
      if (branch.staleDays > rules.hotfixDaysLimit) {
        add(branch, "Error", `${name} is stale and has reached hotfix days limit`);
      }
      if (rules.mustNotHaveHotfixAndReleaseBranches && countLike(rules.releasePrefix) > 0) {
        add(branch, "Error", "Must not have hotfix and release branches at the same time");
      }
      if (rules.hotfixBranchesMustNotBeBehindMaster && branch.master.behind > 0) {
        add(branch, "Error", `${name} is missing ${branch.master.behind} commit(s) from ${rules.masterBranch}`);
      }
      if (rules.hotfixBranchesMustNotHaveActivePullRequests && branch.targetPullRequests > 0 && prRuleApplies) {
        add(branch, "Error", `${name} has an active Pull Request.`);
      }
      if (rules.hotfixBranchesMustNotHaveActivePullRequests && branch.sourcePullRequests > 0 && prRuleApplies) {
        add(branch, "Error", `${name} has an active Pull Request targeting another branch.`);
      }
    }

    if (isLike(name, rules.releasePrefix)) {
      if (rules.releaseBranchLimit < countLike(rules.releasePrefix)) {
        add(branch, "Error", "Release branch limit reached");
      }
      if (branch.staleDays > rules.releaseDaysLimit) {
        add(branch, "Error", `${name} is stale and has reached release days limit`);
      }
      if (rules.mustNotHaveHotfixAndReleaseBranches && countLike(rules.hotfixPrefix) > 0) {
        add(branch, "Error", "Must not have hotfix and release branches at the same time");
      }
      if (rules.releaseBranchesMustNotBeBehindMaster && branch.master.behind > 0) {
        add(branch, "Error", `${name} is missing ${branch.master.behind} commit(s) from ${rules.masterBranch}`);
      }
      if (rules.releaseBranchesMustNotHaveActivePullRequests && branch.targetPullRequests > 0 && prRuleApplies) {
        add(branch, "Error", `${name} has an active Pull Request.`);
      }
      if (rules.releaseBranchesMustNotHaveActivePullRequests && branch.sourcePullRequests > 0 && prRuleApplies) {
        add(branch, "Error", `${name} has an active Pull Request targeting another branch.`);
      }
    }

    if (isLike(name, rules.featurePrefix)) {
      const isCurrentBranch = equalsIgnoreCase(name, build.sourceBranch);
      if (rules.featureBranchLimit < countLike(rules.featurePrefix)) {
        add(branch, "Error", "Feature branch limit reached");
      }
      if (branch.staleDays > rules.featureDaysLimit) {
        add(branch, "Error", `${name} is stale and has reached feature days limit`);
      }
      if (branch.develop.behind > 0) {
        const isError =
          rules.featureBranchesMustNotBeBehindDevelop || (rules.currentFeatureMustNotBeBehindDevelop && isCurrentBranch);
        add(branch, isError ? "Error" : "Warning", `${name} is missing ${branch.develop.behind} commit(s) from ${rules.developBranch}`);
      }
      if (branch.master.behind > 0) {
        const isError =
          rules.featureBranchesMustNotBeBehindMaster || (rules.currentFeatureMustNotBeBehindMaster && isCurrentBranch);
        add(branch, isError ? "Error" : "Warning", `${name} is missing ${branch.master.behind} commit(s) from ${rules.masterBranch}`);
      }
    }

    if (rules.branchNamesMustMatchConventions) {
      const conventions = [rules.masterBranch, rules.developBranch, rules.hotfixPrefix, rules.releasePrefix, rules.featurePrefix];
      if (!conventions.some((pattern) => isLike(name, pattern))) {
        add(branch, "Error", `${name} branch does not follow naming convention i.e ${conventions.join(", ")}`);
      }
    }
  }
}

export function outErrors(branches: Branch[], type: IssueType): BranchIssue[] {
  return branches.flatMap((branch) =>
    branch.errors.filter((e) => e.type === type).map((e) => ({ ...e, branchName: branch.branchName }))
  );
}
