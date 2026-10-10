import { test } from "node:test";
import * as assert from "node:assert/strict";
import { addDevelopCompare, GitBranchStats, toBranches, toPullRequests } from "../src/api";
import { reportSummary } from "../src/output";
import { addPullRequests, Branch, Build, invokeBranchRules, outErrors, PullRequest, Rules } from "../src/rules";
import { isLike } from "../src/wildcard";

const defaultRules: Rules = {
  masterBranch: "master",
  developBranch: "develop",
  hotfixPrefix: "hotfix/*",
  releasePrefix: "release/*",
  featurePrefix: "feature/*",
  hotfixBranchLimit: 1,
  hotfixDaysLimit: 10,
  releaseBranchLimit: 1,
  releaseDaysLimit: 10,
  featureBranchLimit: 50,
  featureDaysLimit: 45,
  hotfixBranchesMustNotBeBehindMaster: true,
  releaseBranchesMustNotBeBehindMaster: true,
  developMustNotBeBehindMaster: true,
  featureBranchesMustNotBeBehindMaster: true,
  featureBranchesMustNotBeBehindDevelop: false,
  currentFeatureMustNotBeBehindDevelop: true,
  currentFeatureMustNotBeBehindMaster: true,
  mustNotHaveHotfixAndReleaseBranches: true,
  masterMustNotHaveActivePullRequests: true,
  hotfixBranchesMustNotHaveActivePullRequests: true,
  releaseBranchesMustNotHaveActivePullRequests: true,
  branchNamesMustMatchConventions: true,
  bypassBranchesWithNameMatchingPattern: "",
};

const ciBuild: Build = { buildDefinitionId: "1", sourceBranch: "develop", buildReason: "IndividualCI", pullRequestId: 0 };

function branch(name: string, overrides: Partial<Branch> = {}): Branch {
  return {
    branchName: name,
    master: { behind: 0, ahead: 0 },
    develop: { behind: 0, ahead: 0 },
    staleDays: 0,
    modified: new Date(2026, 0, 5),
    modifiedBy: "Someone",
    modifiedByEmail: "someone@example.com",
    isBaseVersion: false,
    sourcePullRequests: 0,
    targetPullRequests: 0,
    pullRequests: [],
    errors: [],
    ...overrides,
  };
}

function pr(id: number, source: string, target: string): PullRequest {
  return { id, title: `PR ${id}`, sourceBranch: source, targetBranch: target, created: new Date(), createdBy: "Someone", status: "active" };
}

function messages(branches: Branch[], type: "Error" | "Warning" = "Error"): string[] {
  return outErrors(branches, type).map((e) => e.message);
}

test("isLike follows PowerShell -like semantics", () => {
  assert.equal(isLike("feature/abc", "feature/*"), true);
  assert.equal(isLike("Feature/ABC", "feature/*"), true);
  assert.equal(isLike("bugfix/abc", "feature/*"), false);
  assert.equal(isLike("release/1.2", "release/?.?"), true);
  assert.equal(isLike("release/1.20", "release/?.?"), false);
  assert.equal(isLike("hotfix/a", "hotfix/[abc]"), true);
  assert.equal(isLike("hotfix/d", "hotfix/[a-c]"), false);
  assert.equal(isLike("x.y", "x.y"), true);
  assert.equal(isLike("xzy", "x.y"), false);
  assert.equal(isLike("anything", ""), false);
  assert.equal(isLike("anything", undefined), false);
});

test("a clean set of branches passes", () => {
  const branches = [branch("master", { isBaseVersion: true }), branch("develop"), branch("feature/a")];
  invokeBranchRules(branches, ciBuild, defaultRules);
  assert.deepEqual(messages(branches), []);
  assert.deepEqual(messages(branches, "Warning"), []);
});

test("develop behind master is an error unless the build is the PR that fixes it", () => {
  const develop = () => [branch("develop", { master: { behind: 3, ahead: 0 } })];

  const ci = develop();
  invokeBranchRules(ci, ciBuild, defaultRules);
  assert.deepEqual(messages(ci), ["develop is missing 3 commit(s) from master"]);

  const prBranches = develop();
  addPullRequests(prBranches, [pr(7, "develop", "feature/x")]);
  invokeBranchRules(prBranches, { ...ciBuild, buildReason: "PullRequest", pullRequestId: 7 }, defaultRules);
  assert.deepEqual(messages(prBranches), []);
});

test("master with active pull requests fails outside PR builds", () => {
  const branches = [branch("master"), branch("develop")];
  addPullRequests(branches, [pr(1, "develop", "master")]);
  invokeBranchRules(branches, ciBuild, defaultRules);
  assert.deepEqual(messages(branches), ["master has an active Pull Request."]);

  const prBuild = [branch("master"), branch("develop")];
  addPullRequests(prBuild, [pr(1, "develop", "master")]);
  invokeBranchRules(prBuild, { ...ciBuild, buildReason: "PullRequest", pullRequestId: 1 }, defaultRules);
  assert.deepEqual(messages(prBuild), []);
});

test("hotfix limits, staleness and hotfix+release conflicts", () => {
  const branches = [branch("hotfix/a", { staleDays: 11 }), branch("hotfix/b"), branch("release/1.0")];
  invokeBranchRules(branches, ciBuild, defaultRules);
  assert.deepEqual(messages(branches), [
    "Hotfix branch limit reached",
    "hotfix/a is stale and has reached hotfix days limit",
    "Must not have hotfix and release branches at the same time",
    "Hotfix branch limit reached",
    "Must not have hotfix and release branches at the same time",
    "Must not have hotfix and release branches at the same time",
  ]);
});

test("feature branches behind develop are warnings unless configured as errors or the current branch", () => {
  const behind = () => [branch("feature/a", { develop: { behind: 2, ahead: 0 } })];

  const other = behind();
  invokeBranchRules(other, ciBuild, defaultRules);
  assert.deepEqual(messages(other), []);
  assert.deepEqual(messages(other, "Warning"), ["feature/a is missing 2 commit(s) from develop"]);

  const current = behind();
  invokeBranchRules(current, { ...ciBuild, sourceBranch: "feature/a" }, defaultRules);
  assert.deepEqual(messages(current), ["feature/a is missing 2 commit(s) from develop"]);

  const strict = behind();
  invokeBranchRules(strict, ciBuild, { ...defaultRules, featureBranchesMustNotBeBehindDevelop: true });
  assert.deepEqual(messages(strict), ["feature/a is missing 2 commit(s) from develop"]);
});

test("naming conventions and bypass pattern", () => {
  const branches = [branch("spike/x"), branch("prototype/y")];
  invokeBranchRules(branches, ciBuild, { ...defaultRules, bypassBranchesWithNameMatchingPattern: "prototype/*" });
  assert.deepEqual(messages(branches), [
    "spike/x branch does not follow naming convention i.e master, develop, hotfix/*, release/*, feature/*",
  ]);
});

test("API responses map into branches and pull requests", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const stat = (name: string, behind: number, date: string): GitBranchStats => ({
    name,
    aheadCount: 1,
    behindCount: behind,
    isBaseVersion: false,
    commit: { author: { name: "A", email: "a@example.com", date } },
  });
  const branches = toBranches([stat("feature/a", 2, "2026-10-01T13:00:00Z")], now);
  addDevelopCompare(branches, [stat("Feature/A", 5, "2026-10-01T13:00:00Z")]);
  assert.equal(branches[0].staleDays, 8);
  assert.deepEqual(branches[0].master, { behind: 2, ahead: 1 });
  assert.deepEqual(branches[0].develop, { behind: 5, ahead: 1 });

  const prs = toPullRequests([
    {
      pullRequestId: 4,
      title: "t",
      sourceRefName: "refs/heads/feature/a",
      targetRefName: "refs/heads/develop",
      creationDate: "2026-10-01T00:00:00Z",
      createdBy: { displayName: "B" },
      status: "active",
    },
  ]);
  assert.equal(prs[0].sourceBranch, "feature/a");
  assert.equal(prs[0].targetBranch, "develop");
});

test("report summary shows failed gate with issues", () => {
  const branches = [branch("spike/x"), branch("feature/a", { develop: { behind: 1, ahead: 0 } })];
  invokeBranchRules(branches, ciBuild, defaultRules);
  const report = reportSummary("@@GateResult@@|@@TotalErrors@@|@@TotalWarnings@@\n@@Issues@@", branches, [], true);
  assert.match(report, /Failed<\/span>\|1\|1/);
  assert.match(report, /### Issues:\n- spike\/x branch does not follow naming convention/);

  const passed = reportSummary("@@GateResult@@ @@Issues@@", [branch("develop")], [], true);
  assert.match(passed, /Passed<\/span> Not issues found/);
});
