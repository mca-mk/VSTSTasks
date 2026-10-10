// Port of tests/GitFlowBranchGateTests/BranchRulesTests.ps1 (Pester, 79 `It` blocks) to node:test.
//
// Every test builds its own fresh state from the JSON fixtures, so tests are independent.
// The Pester `Add-DevelopCompare` and `Add-PullRequests` contexts share `$branches` across `It`
// blocks, but those functions are idempotent for the asserted values (develop compare is
// overwritten; PR counts are recomputed), so no `It` depends on leaked state.
//
// Skipped `It` blocks (no TypeScript meaning, or asserting fields dropped from the TS model):
//   - Generic Tests / "has a BranchRules.psm1 file" - PowerShell module file existence; the TS
//     modules are imported directly, so compilation proves they exist.
//   - Generic Tests / "BranchRules is valid PowerShell code" - PowerShell parser check.
//   - ConvertTo-Branches / "should return 0 for Status when given valid master branch" - `Status`
//     is not part of the TS model.
//   - ConvertTo-Branches / "should return info for SeverityThreshold when given valid master
//     branch" - `SeverityThreshold` is not part of the TS model.
//   - ConvertTo-Branches / "should return 0 stale days when given correct data for master" - the
//     Pester body has its only assertion commented out, so there is nothing to port.
//
// Partially ported (the PowerShell-only assertions inside them are dropped):
//   - ConvertTo-PullRequests "should have the correct data": `SeverityThreshold` and `Errors`
//     are dropped (the TS PullRequest has neither).
//   - ConvertTo-PullRequests / ConvertTo-Branches "should have the correct data types":
//     BeOfType checks are ported as runtime typeof/instanceof checks; `Status`,
//     `SeverityThreshold` are dropped. Pester's `Develop | Should Be $null` passed because
//     PowerShell initialises Develop to an empty array; the TS model initialises it to
//     { behind: 0, ahead: 0 }, which is asserted instead.

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { addDevelopCompare, GitBranchStats, GitPullRequest, toBranches, toPullRequests } from "../src/api";
import { addPullRequests, Branch, Build, invokeBranchRules, IssueType, Rules } from "../src/rules";

const assetsPath = path.join(__dirname, "../../../../../tests/GitFlowBranchGateTests/assets");

interface ListJson<T> {
  count: number;
  value: T[];
}

function loadJson<T>(name: string): ListJson<T> {
  return JSON.parse(fs.readFileSync(path.join(assetsPath, name), "utf8")) as ListJson<T>;
}

// Get-DefaultRules from the Pester file (note: differs from test/rules.test.ts defaults for
// featureBranchesMustNotBeBehindDevelop / currentFeatureMustNotBeBehindDevelop).
function getDefaultRules(): Rules {
  return {
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
    featureBranchesMustNotBeBehindDevelop: true,
    currentFeatureMustNotBeBehindDevelop: false,
    currentFeatureMustNotBeBehindMaster: true,
    mustNotHaveHotfixAndReleaseBranches: true,
    masterMustNotHaveActivePullRequests: true,
    hotfixBranchesMustNotHaveActivePullRequests: true,
    releaseBranchesMustNotHaveActivePullRequests: true,
    branchNamesMustMatchConventions: true,
    bypassBranchesWithNameMatchingPattern: "",
  };
}

function getDefaultManualBuild(): Build {
  return { buildDefinitionId: "1", sourceBranch: "master", buildReason: "Manual", pullRequestId: 0 };
}

function getDefaultPullRequestBuild(): Build {
  return { buildDefinitionId: "2", sourceBranch: "master", buildReason: "PullRequest", pullRequestId: 1 };
}

function masterStats(): GitBranchStats[] {
  return loadJson<GitBranchStats>("Branches.Stats.MasterAsBase.json").value;
}

function developStats(): GitBranchStats[] {
  return loadJson<GitBranchStats>("Branches.Stats.DevelopAsBase.json").value;
}

function developToMasterPullRequests() {
  return toPullRequests(loadJson<GitPullRequest>("PullRequests.DevelopToMaster.json").value);
}

// _getConextBranches from the Pester file.
function getContextBranches(): Branch[] {
  const branches = toBranches(masterStats());
  addDevelopCompare(branches, developStats());
  addPullRequests(branches, developToMasterPullRequests());
  return branches;
}

// Independent implementation of PowerShell's case-insensitive -like for the `*`/`?` patterns
// used in the Pester assertions (kept separate from src/wildcard.ts so it is not self-testing).
function like(value: string, pattern: string): boolean {
  const source = pattern
    .split("")
    .map((c) => (c === "*" ? "[\\s\\S]*" : c === "?" ? "[\\s\\S]" : c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`, "i").test(value);
}

// Where-Object { $_.BranchName -eq $name } (case-insensitive)
function find(branches: Branch[], name: string): Branch {
  const matches = branches.filter((b) => b.branchName.toLowerCase() === name.toLowerCase());
  assert.equal(matches.length, 1, `expected exactly one branch named ${name}`);
  return matches[0];
}

// Where-Object { $_.BranchName -like $pattern }
function filterLike(branches: Branch[], pattern: string): Branch[] {
  return branches.filter((b) => like(b.branchName, pattern));
}

// $branch.Errors | Where-Object { $_.Message -like $pattern [-and $_.Type -eq $type] }
function errorsLike(branch: Branch, pattern: string, type?: IssueType) {
  return branch.errors.filter((e) => like(e.message, pattern) && (type === undefined || e.type === type));
}

// $branch.Errors | Where-Object { $_.Message -eq $message }
function errorsEq(branch: Branch, message: string) {
  return branch.errors.filter((e) => e.message.toLowerCase() === message.toLowerCase());
}

describe("BrandRules Module Tests", () => {
  describe("Default branch rules tests", () => {
    // $branches here is the raw ConvertFrom-Json object (not ConvertTo-Branches output).
    const raw = () => loadJson<{ name: string }>("Branches.defaults.json");
    const emptyPullRequests = () => toPullRequests(loadJson<GitPullRequest>("PullRequests.empty.json").value);

    test("Branches array should return 2 Branches", () => {
      // PowerShell `$branches.Count` resolves to the JSON `count` property.
      assert.equal(raw().count, 2);
    });

    test("should return 'refs/heads/develop' when passed default valid default branches", () => {
      assert.equal(raw().value[0].name, "refs/heads/develop");
    });

    test("should return 'refs/heads/master' when passed default valid default branches", () => {
      assert.equal(raw().value[1].name, "refs/heads/master");
    });

    test("Pull Request array should have 0 items", () => {
      assert.equal(emptyPullRequests().length, 0);
    });
  });

  describe("When ConvertTo-PullRequestsPull is passed a PR from develop to master", () => {
    test("should have 1 item in the array", () => {
      assert.equal(developToMasterPullRequests().length, 1);
    });

    test("should have the correct data", () => {
      const pr = developToMasterPullRequests()[0];
      assert.equal(pr.id, 1);
      assert.equal(pr.title, "developToMasterTest");
      assert.equal(pr.sourceBranch, "develop");
      assert.equal(pr.targetBranch, "master");
      assert.equal(pr.createdBy, "Kerwin Carpede");
      assert.equal(pr.status, "active");
      // SeverityThreshold / Errors: not part of the TS model.
    });

    test("should have the correct data types", () => {
      const pr = developToMasterPullRequests()[0];
      assert.equal(typeof pr.id, "number");
      assert.ok(Number.isInteger(pr.id));
      assert.equal(typeof pr.title, "string");
      assert.equal(typeof pr.sourceBranch, "string");
      assert.equal(typeof pr.targetBranch, "string");
      assert.ok(pr.created instanceof Date);
      assert.ok(!Number.isNaN(pr.created.getTime()));
      assert.equal(typeof pr.createdBy, "string");
      assert.equal(typeof pr.status, "string");
    });
  });

  describe("When ConvertTo-Branches is passed 2 branches", () => {
    const master = () => find(toBranches(masterStats()), "master");

    test("should have 8 items in the array", () => {
      assert.equal(toBranches(masterStats()).length, 8);
    });

    test("should have the correct data types", () => {
      const b = toBranches(masterStats())[0];
      assert.equal(typeof b.branchName, "string");
      assert.equal(typeof b.master, "object");
      assert.equal(typeof b.master.behind, "number");
      assert.equal(typeof b.master.ahead, "number");
      // PowerShell: Develop is an empty array (Should Be $null passes); TS: zeroed compare.
      assert.deepEqual(b.develop, { behind: 0, ahead: 0 });
      assert.ok(Number.isInteger(b.staleDays));
      assert.ok(b.modified instanceof Date);
      assert.ok(!Number.isNaN(b.modified.getTime()));
      assert.equal(typeof b.modifiedBy, "string");
      assert.equal(typeof b.modifiedByEmail, "string");
      assert.equal(typeof b.isBaseVersion, "boolean");
      assert.ok(Number.isInteger(b.sourcePullRequests));
      assert.ok(Number.isInteger(b.targetPullRequests));
      assert.equal(b.pullRequests.length, 0);
      assert.equal(b.errors.length, 0);
    });

    test("should not return null branch when given correct data for master", () => {
      assert.ok(master());
    });

    test("should return 'master' for BranchName when given valid master branch", () => {
      assert.equal(master().branchName, "master");
    });

    test("should return 'Kerwin Carpede' for ModifiedBy when given valid master branch", () => {
      assert.equal(master().modifiedBy, "Kerwin Carpede");
    });

    test("should return 'kerwinc@videojunky.co.za' for ModifiedByEmail when given valid master branch", () => {
      // The Pester body asserts ModifiedBy (copy/paste slip); keep that and also check the email.
      assert.equal(master().modifiedBy, "Kerwin Carpede");
      assert.equal(master().modifiedByEmail, "kerwinc@videojunky.co.za");
    });

    test("should return 0 for Master.Behind when given valid master branch", () => {
      assert.equal(master().master.behind, 0);
    });

    test("should return 0 for Master.Ahead when given valid master branch", () => {
      assert.equal(master().master.ahead, 0);
    });

    test("should return null for PullRequests when given valid master branch", () => {
      assert.equal(master().pullRequests.length, 0);
    });

    test("should return true for IsBaseVersion when given valid master branch", () => {
      assert.equal(master().isBaseVersion, true);
    });

    test("should return 0 for SourcePullRequests when given valid master branch", () => {
      assert.equal(master().sourcePullRequests, 0);
    });

    test("should return 0 for TargetPullRequests when given valid master branch", () => {
      assert.equal(master().targetPullRequests, 0);
    });

    test("should return null for Errors when given valid master branch", () => {
      assert.equal(master().errors.length, 0);
    });
  });

  describe("When Add-DevelopCompare is passed valid develop compare", () => {
    const branches = () => {
      const result = toBranches(masterStats());
      addDevelopCompare(result, developStats());
      return result;
    };

    test("should return 5 aheadfor feature/feature1 (develop comapre)", () => {
      assert.equal(find(branches(), "feature/Feature1").develop.ahead, 5);
    });

    test("should return 1 behind for feature/feature1 (develop comapre)", () => {
      assert.equal(find(branches(), "feature/Feature1").develop.behind, 1);
    });

    test("should return 20 ahead for develop (develop comapre)", () => {
      assert.equal(find(branches(), "develop").develop.ahead, 20);
    });

    test("should return 0 behind for develop (develop comapre)", () => {
      assert.equal(find(branches(), "develop").develop.behind, 0);
    });

    test("should return 0 behind for release/release1 (develop comapre)", () => {
      // Title says 0 but the Pester assertion is 1; the assertion is ported.
      assert.equal(find(branches(), "release/release1").develop.behind, 1);
    });

    test("should return 0 ahead for release/release1 (develop comapre)", () => {
      // Title says 0 but the Pester assertion is 5; the assertion is ported.
      assert.equal(find(branches(), "release/release1").develop.ahead, 5);
    });
  });

  describe("When Add-PullRequests is passed valid list of active PRs", () => {
    const branches = () => {
      const result = toBranches(masterStats());
      addPullRequests(result, developToMasterPullRequests());
      return result;
    };

    test("should return 1 TargetPullRequests for master", () => {
      assert.equal(find(branches(), "master").targetPullRequests, 1);
    });

    test("should return 0 SourcePullRequests for master", () => {
      assert.equal(find(branches(), "master").sourcePullRequests, 0);
    });
  });
});

describe("Invoke-BranchRules Tests", () => {
  describe("When Invoke-BranchRules is executed and validating master", () => {
    test("should return 'has an active Pull Request' error when master has an active PR", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      const m = find(branches, "master");
      m.targetPullRequests = 1;
      m.sourcePullRequests = 0;
      const build = getDefaultPullRequestBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "master");

      assert.equal(branch.targetPullRequests, 1);
      assert.equal(branch.sourcePullRequests, 0);
      assert.equal(branch.errors.length, 0);
    });

    test("should return 'has an active Pull Request' error when master has an active PR and renamed master", () => {
      const rules = getDefaultRules();
      rules.masterBranch = "AlternateMaster";
      const branches = getContextBranches();
      find(branches, "master").branchName = "AlternateMaster";
      const build = getDefaultPullRequestBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "AlternateMaster");

      assert.equal(branch.branchName, "AlternateMaster");
      assert.equal(branch.targetPullRequests, 1);
      assert.equal(branch.sourcePullRequests, 0);
      assert.equal(branch.errors.length, 0);
    });

    test("should return 'has an active Pull Request targeting another branch' error when SourcePullRequests=1 and NOT PR build", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      const m = find(branches, "master");
      m.targetPullRequests = 0;
      m.sourcePullRequests = 1;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "master");

      assert.equal(branch.targetPullRequests, 0);
      assert.equal(branch.sourcePullRequests, 1);
      assert.equal(branch.errors.length, 1);
      assert.ok(like(branch.errors[0].message, "*has an active Pull Request targeting another branch*"));
    });

    test("should return 0 errors when master has an active PR and build trigger is manual", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "master");

      assert.equal(rules.masterBranch, "master");
      assert.ok(branch.errors.length > 0);
      assert.ok(errorsLike(branch, "*has an active Pull Request.").length > 0);
    });

    test("should have 0 errors if master has an active PR and MasterMustNotHaveActivePullRequests is false", () => {
      const rules = getDefaultRules();
      rules.masterMustNotHaveActivePullRequests = false;
      const branches = getContextBranches();
      const build = getDefaultPullRequestBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "master");

      assert.equal(rules.masterMustNotHaveActivePullRequests, false);
      assert.equal(rules.masterBranch, "master");
      assert.equal(branch.errors.length, 0);
    });
  });

  describe("When Invoke-BranchRules is executed and validating develop", () => {
    test("should return 'develop is missing 3 commit(s) from master' Error when develop is behind master with default rules", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "develop");

      assert.equal(branch.errors.length, 1);
      assert.ok(like(branch.errors[0].message, "*develop is missing 3 commit(s) from master"));
    });

    test("should return 'AlternateDevelop is missing 3 commit(s) from master' Error when develop is behind master and renamed develop branch", () => {
      const rules = getDefaultRules();
      rules.developBranch = "AlternateDevelop";
      const branches = getContextBranches();
      find(branches, "develop").branchName = "AlternateDevelop";
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "AlternateDevelop");

      assert.equal(branch.branchName, "AlternateDevelop");
      assert.equal(branch.errors.length, 1);
      assert.ok(like(branch.errors[0].message, "*develop is missing 3 commit(s) from master"));
    });

    test("should return no errors when develop is NOT behind master and Rules.DevelopMustNotBeBehindMaster is true", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      find(branches, "develop").master.behind = 0;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);

      assert.equal(find(branches, "develop").errors.length, 0);
    });

    test("should return no errors when develop is behind master and PR Build", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      const build = getDefaultPullRequestBuild();

      invokeBranchRules(branches, build, rules);

      assert.equal(find(branches, "develop").errors.length, 0);
    });

    test("should return no errors when develop is behind master and Rules.DevelopMustNotBeBehindMaster is false", () => {
      const rules = getDefaultRules();
      rules.developMustNotBeBehindMaster = false;
      const branches = getContextBranches();
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);

      assert.equal(find(branches, "develop").errors.length, 0);
    });
  });

  describe("When Invoke-BranchRules is executed and validating hotfix branches", () => {
    const hotfixMessage = "Must not have hotfix and release branches at the same time";

    test("should return 'Hotfix branch limit reached' error when multiple hotfix branches and HotfixBranchLimit is 1", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      filterLike(branches, "hotfix/*").forEach((b) => (b.master.behind = 0));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const hotfixBranches = filterLike(branches, "hotfix/*");

      assert.equal(hotfixBranches.length, 2);
      for (const branch of hotfixBranches) {
        assert.ok(errorsEq(branch, "Hotfix branch limit reached").length > 0);
        assert.ok(like(branch.errors[0].message, "Hotfix branch limit reached"));
      }
    });

    test("should return 'is stale and has reached hotfix days limit' error when hotfix branche is stale", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      find(branches, "hotfix/hotfix1").staleDays = 11;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "hotfix/hotfix1");

      assert.ok(errorsLike(branch, "*is stale and has reached hotfix days limit").length > 0);
    });

    test("should return 'Must not have hotfix and release branches at the same time' error when there are hotfix & release branches", () => {
      const rules = getDefaultRules();
      rules.mustNotHaveHotfixAndReleaseBranches = true;
      const branches = getContextBranches();
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const hotfixBranches = filterLike(branches, "hotfix/*");

      assert.equal(hotfixBranches.length, 2);
      for (const branch of hotfixBranches) {
        assert.ok(errorsEq(branch, hotfixMessage).length > 0);
      }
    });

    test("should NOT return 'Must not have hotfix and release branches at the same time' error when there are hotfix & release branches and MustNotHaveHotfixAndReleaseBranches is false", () => {
      const rules = getDefaultRules();
      rules.mustNotHaveHotfixAndReleaseBranches = false;
      const branches = getContextBranches();
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const hotfixBranches = filterLike(branches, "hotfix/*");

      assert.equal(hotfixBranches.length, 2);
      for (const branch of hotfixBranches) {
        assert.equal(errorsEq(branch, hotfixMessage).length, 0);
      }
    });

    test("should return 'hotfix is missing 100 commit(s) from master' error when hotfix1 is behind master", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      find(branches, "hotfix/hotfix1").master.behind = 100;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "hotfix/hotfix1");

      assert.ok(errorsLike(branch, "*hotfix1 is missing 100 commit(s) from master").length > 0);
    });

    test("should NOT return 'hotfix is missing 100 commit(s) from master' error when hotfix1 is behind master and HotfixeBranchesMustNotBeBehindMaster is false", () => {
      const rules = getDefaultRules();
      rules.hotfixBranchesMustNotBeBehindMaster = false;
      const branches = getContextBranches();
      find(branches, "hotfix/hotfix1").master.behind = 100;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "hotfix/hotfix1");

      assert.equal(errorsLike(branch, "*hotfix1 is missing 100 commit(s) from master").length, 0);
    });

    test("should return 'hotfix has an active Pull Request.' error when hotfix1 has an active PR", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      filterLike(branches, "hotfix/*").forEach((b) => {
        b.targetPullRequests = 1;
        b.sourcePullRequests = 0;
      });
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const hotfixBranches = filterLike(branches, "hotfix/*");

      assert.equal(hotfixBranches.length, 2);
      for (const branch of hotfixBranches) {
        assert.equal(branch.targetPullRequests, 1);
        assert.equal(branch.sourcePullRequests, 0);
        assert.ok(errorsLike(branch, "*has an active Pull Request.").length > 0);
      }
    });

    test("should return NOT 'hotfix has an active Pull Request.' error when hotfix has an active PR and HotfixBranchesMustNotHaveActivePullRequests is false", () => {
      const rules = getDefaultRules();
      rules.hotfixBranchesMustNotHaveActivePullRequests = false;
      const branches = getContextBranches();
      filterLike(branches, "hotfix/*").forEach((b) => (b.targetPullRequests = 1));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const hotfixBranches = filterLike(branches, "hotfix/*");

      assert.equal(hotfixBranches.length, 2);
      for (const branch of hotfixBranches) {
        assert.equal(branch.targetPullRequests, 1);
        assert.equal(errorsLike(branch, "*has an active Pull Request.").length, 0);
      }
    });

    test("should NOT return 'hotfix has an active Pull Request.' error when hotfix has an no active PRs", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      filterLike(branches, "hotfix/*").forEach((b) => (b.targetPullRequests = 0));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const hotfixBranches = filterLike(branches, "hotfix/*");

      assert.equal(hotfixBranches.length, 2);
      for (const branch of hotfixBranches) {
        assert.equal(branch.targetPullRequests, 0);
        assert.equal(errorsLike(branch, "*has an active Pull Request.").length, 0);
      }
    });

    test("should return 'hotfix has an active Pull Request targeting another branch.' error when hotfix has an active PR", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      filterLike(branches, "hotfix/*").forEach((b) => (b.sourcePullRequests = 1));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const hotfixBranches = filterLike(branches, "hotfix/*");

      assert.equal(hotfixBranches.length, 2);
      for (const branch of hotfixBranches) {
        assert.equal(branch.sourcePullRequests, 1);
        assert.ok(errorsLike(branch, "*has an active Pull Request targeting another branch.").length > 0);
      }
    });

    test("should NOT return 'hotfix has an active Pull Request targeting another branch.' error when hotfix has an active PR and HotfixBranchesMustNotHaveActivePullRequests is false", () => {
      const rules = getDefaultRules();
      rules.hotfixBranchesMustNotHaveActivePullRequests = false;
      const branches = getContextBranches();
      filterLike(branches, "hotfix/*").forEach((b) => (b.sourcePullRequests = 0));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const hotfixBranches = filterLike(branches, "hotfix/*");

      assert.equal(hotfixBranches.length, 2);
      for (const branch of hotfixBranches) {
        assert.equal(branch.sourcePullRequests, 0);
        assert.equal(errorsLike(branch, "*has an active Pull Request targeting another branch.").length, 0);
      }
    });

    test("should NOT return 'hotfix has an active Pull Request targeting another branch.' error when hotfix has NO active PRs", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      filterLike(branches, "hotfix/*").forEach((b) => (b.sourcePullRequests = 0));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const hotfixBranches = filterLike(branches, "hotfix/*");

      assert.equal(hotfixBranches.length, 2);
      for (const branch of hotfixBranches) {
        assert.equal(branch.sourcePullRequests, 0);
        assert.equal(errorsLike(branch, "*has an active Pull Request targeting another branch.").length, 0);
      }
    });
  });

  describe("When Invoke-BranchRules is executed and validating release branches", () => {
    const bothMessage = "Must not have hotfix and release branches at the same time";

    test("should return 'Release branch limit reached' error when multiple release branches and ReleaseBranchLimit is 1", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      filterLike(branches, "release/*").forEach((b) => (b.master.behind = 0));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const releaseBranches = filterLike(branches, "release/*");

      assert.equal(releaseBranches.length, 2);
      for (const branch of releaseBranches) {
        assert.ok(errorsEq(branch, "Release branch limit reached").length > 0);
      }
    });

    test("should return 'Release1 is stale and has reached hotfix days limit' error when release branch is stale", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      find(branches, "release/release1").staleDays = 11;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "release/release1");

      assert.ok(errorsLike(branch, "*is stale and has reached release days limit").length > 0);
    });

    test("should return 'Must not have hotfix and release branches at the same time' error when there are hotfix & release branches", () => {
      const rules = getDefaultRules();
      rules.mustNotHaveHotfixAndReleaseBranches = true;
      const branches = getContextBranches();
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const releaseBranches = filterLike(branches, "release/*");

      assert.equal(releaseBranches.length, 2);
      for (const branch of releaseBranches) {
        assert.ok(errorsEq(branch, bothMessage).length > 0);
      }
    });

    test("should NOT return 'Must not have hotfix and release branches at the same time' error when there are hotfix & release branches and MustNotHaveHotfixAndReleaseBranches is false", () => {
      const rules = getDefaultRules();
      rules.mustNotHaveHotfixAndReleaseBranches = false;
      const branches = getContextBranches();
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const releaseBranches = filterLike(branches, "release/*");

      assert.equal(releaseBranches.length, 2);
      for (const branch of releaseBranches) {
        assert.equal(errorsEq(branch, bothMessage).length, 0);
      }
    });

    test("should return 'release is missing 50 commit(s) from master' error when release1 is behind master", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      find(branches, "release/release1").master.behind = 50;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "release/release1");

      assert.ok(errorsLike(branch, "*release1 is missing 50 commit(s) from master").length > 0);
    });

    test("should NOT return 'release1 is missing 50 commit(s) from master' error when release1 is behind master and HotfixeBranchesMustNotBeBehindMaster is false", () => {
      const rules = getDefaultRules();
      rules.releaseBranchesMustNotBeBehindMaster = false;
      const branches = getContextBranches();
      find(branches, "release/release1").master.behind = 50;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "release/release1");

      assert.equal(errorsLike(branch, "*release1 is missing 50 commit(s) from master").length, 0);
    });

    test("should return 'release has an active Pull Request.' error when release has an active PR", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      filterLike(branches, "release/*").forEach((b) => (b.targetPullRequests = 1));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const releaseBranches = filterLike(branches, "release/*");

      assert.equal(releaseBranches.length, 2);
      for (const branch of releaseBranches) {
        assert.equal(branch.targetPullRequests, 1);
        assert.ok(errorsLike(branch, "*has an active Pull Request.").length > 0);
      }
    });

    test("should return NOT 'release has an active Pull Request.' error when release has an active PR and ReleaseBranchesMustNotHaveActivePullRequests is false", () => {
      const rules = getDefaultRules();
      rules.releaseBranchesMustNotHaveActivePullRequests = false;
      const branches = getContextBranches();
      filterLike(branches, "release/*").forEach((b) => (b.targetPullRequests = 1));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const releaseBranches = filterLike(branches, "release/*");

      assert.equal(releaseBranches.length, 2);
      for (const branch of releaseBranches) {
        assert.equal(branch.targetPullRequests, 1);
        assert.equal(errorsLike(branch, "*has an active Pull Request.").length, 0);
      }
    });

    test("should NOT return 'hotfix has an active Pull Request.' error when hotfix has an no active PRs", () => {
      // Pester title says hotfix; the body exercises release branches.
      const rules = getDefaultRules();
      const branches = getContextBranches();
      filterLike(branches, "release/*").forEach((b) => (b.targetPullRequests = 0));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const releaseBranches = filterLike(branches, "release/*");

      assert.equal(releaseBranches.length, 2);
      for (const branch of releaseBranches) {
        assert.equal(branch.targetPullRequests, 0);
        assert.equal(errorsLike(branch, "*has an active Pull Request.").length, 0);
      }
    });

    test("should return 'release has an active Pull Request targeting another branch.' error when release has an active PR", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      filterLike(branches, "release/*").forEach((b) => (b.sourcePullRequests = 1));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const releaseBranches = filterLike(branches, "release/*");

      assert.equal(releaseBranches.length, 2);
      for (const branch of releaseBranches) {
        assert.equal(branch.sourcePullRequests, 1);
        assert.ok(errorsLike(branch, "*has an active Pull Request targeting another branch.").length > 0);
      }
    });

    test("should NOT return 'release has an active Pull Request targeting another branch.' error when hotfix has an active PR and HotfixBranchesMustNotHaveActivePullRequests is false", () => {
      const rules = getDefaultRules();
      rules.releaseBranchesMustNotHaveActivePullRequests = false;
      const branches = getContextBranches();
      filterLike(branches, "release/*").forEach((b) => (b.sourcePullRequests = 0));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const releaseBranches = filterLike(branches, "release/*");

      assert.equal(releaseBranches.length, 2);
      for (const branch of releaseBranches) {
        assert.equal(branch.sourcePullRequests, 0);
        assert.equal(errorsLike(branch, "*has an active Pull Request targeting another branch.").length, 0);
      }
    });

    test("should NOT return 'release has an active Pull Request targeting another branch.' error when hotfix has NO active PRs", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      filterLike(branches, "release/*").forEach((b) => (b.sourcePullRequests = 0));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const releaseBranches = filterLike(branches, "release/*");

      assert.equal(releaseBranches.length, 2);
      for (const branch of releaseBranches) {
        assert.equal(branch.sourcePullRequests, 0);
        assert.equal(errorsLike(branch, "*has an active Pull Request targeting another branch.").length, 0);
      }
    });
  });

  describe("When Invoke-BranchRules is executed and validating feature branches", () => {
    test("should return 'Feature branch limit reached' error when multiple feature branches and ReleaseBranchLimit is 50", () => {
      const rules = getDefaultRules();
      rules.featureBranchLimit = 1;
      const branches = getContextBranches();
      filterLike(branches, "feature/*").forEach((b) => (b.master.behind = 0));
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const featureBranches = filterLike(branches, "feature/*");

      assert.equal(featureBranches.length, 2);
      for (const branch of featureBranches) {
        assert.ok(errorsEq(branch, "Feature branch limit reached").length > 0);
      }
    });

    test("should return 'Feature1 is stale and has reached feature days limit' error when feature branch is stale", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      find(branches, "feature/feature1").staleDays = 200;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "feature/feature1");

      assert.ok(errorsLike(branch, "*is stale and has reached feature days limit").length > 0);
    });

    test("should return 'Feature1 is missing 500 commit(s) from master' error when feature1 is behind master", () => {
      const rules = getDefaultRules();
      const branches = getContextBranches();
      find(branches, "feature/feature1").master.behind = 500;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "feature/feature1");

      assert.ok(errorsLike(branch, "*feature1 is missing 500 commit(s) from master").length > 0);
    });

    test("should NOT return 'Feature1 is missing 500 commit(s) from master' error when release1 is behind master and FeatureBranchesMustNotBeBehindMaster is false", () => {
      const rules = getDefaultRules();
      rules.featureBranchesMustNotBeBehindMaster = false;
      rules.currentFeatureMustNotBeBehindMaster = false;
      const branches = getContextBranches();
      find(branches, "feature/feature1").master.behind = 500;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "feature/feature1");

      assert.equal(errorsLike(branch, "*feature1 is missing 500 commit(s) from master", "Error").length, 0);
    });

    test("should return 'Feature1 is missing 99 commit(s) from develop' error when feature1 is behind develop", () => {
      const rules = getDefaultRules();
      rules.featureBranchesMustNotBeBehindMaster = true;
      const branches = getContextBranches();
      find(branches, "feature/feature1").develop.behind = 99;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "feature/feature1");

      assert.ok(errorsLike(branch, "*feature1 is missing 99 commit(s) from develop", "Error").length > 0);
    });

    test("should return 'Feature1 is missing 89 commit(s) from develop' error when feature1 is behind develop and CurrentFeatureMustNotBeBehindDevelop is true", () => {
      const rules = getDefaultRules();
      rules.featureBranchesMustNotBeBehindDevelop = false;
      rules.currentFeatureMustNotBeBehindDevelop = true;
      const branches = getContextBranches();
      find(branches, "feature/feature1").develop.behind = 89;
      const build = getDefaultManualBuild();
      // Lower-case source branch vs "feature/Feature1": relies on case-insensitive -eq.
      build.sourceBranch = "feature/feature1";

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "feature/feature1");

      assert.ok(branch.errors.length > 0);
      assert.ok(errorsLike(branch, "*feature1 is missing 89 commit(s) from develop", "Error").length > 0);
    });

    test("should NOT return 'Feature1 is missing 89 commit(s) from develop' error when feature1 is behind develop and CurrentFeatureMustNotBeBehindDevelop is false", () => {
      const rules = getDefaultRules();
      rules.featureBranchesMustNotBeBehindDevelop = false;
      rules.currentFeatureMustNotBeBehindDevelop = false;
      const branches = getContextBranches();
      // The Pester body sets Master.Behind (not Develop.Behind) = 89; ported as written.
      find(branches, "feature/feature1").master.behind = 89;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "feature/feature1");

      assert.equal(errorsLike(branch, "*feature1 is missing 89 commit(s) from develop", "Error").length, 0);
    });

    test("should return 'Feature1 is missing 79 commit(s) from master' error when feature1 is behind develop and CurrentFeatureMustNotBeBehindMaster is true", () => {
      const rules = getDefaultRules();
      rules.featureBranchesMustNotBeBehindMaster = false;
      rules.currentFeatureMustNotBeBehindMaster = true;
      const branches = getContextBranches();
      find(branches, "feature/feature1").master.behind = 79;
      const build = getDefaultManualBuild();
      build.sourceBranch = "feature/feature1";

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "feature/feature1");

      assert.ok(branch.errors.length > 0);
      assert.ok(errorsLike(branch, "*feature1 is missing 79 commit(s) from master", "Error").length > 0);
    });

    test("should NOT return 'Feature1 is missing 79 commit(s) from master' error when feature1 is behind master and CurrentFeatureMustNotBeBehindMaster is false", () => {
      const rules = getDefaultRules();
      rules.featureBranchesMustNotBeBehindMaster = false;
      rules.currentFeatureMustNotBeBehindMaster = false;
      const branches = getContextBranches();
      find(branches, "feature/feature1").master.behind = 79;
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "feature/feature1");

      assert.equal(errorsLike(branch, "*feature1 is missing 79 commit(s) from master", "Error").length, 0);
    });
  });

  describe("When Invoke-BranchRules is executed and validating Bypassed branches", () => {
    test("should NOT have Any errors if branch name matches bypass pattern prototype/*", () => {
      const rules = getDefaultRules();
      rules.bypassBranchesWithNameMatchingPattern = "prototype/*";
      const branches = getContextBranches();
      filterLike(branches, "feature/feature1").forEach((b) => {
        b.master.behind = 500;
        b.branchName = "prototype/prototype1";
      });
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const branch = find(branches, "prototype/prototype1");

      assert.equal(branch.errors.length, 0);
    });

    test("should NOT have Any errors if branch name matches bypass pattern feature/*", () => {
      const rules = getDefaultRules();
      rules.bypassBranchesWithNameMatchingPattern = "feature/*";
      const branches = getContextBranches();
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);
      const featureBranches = filterLike(branches, "feature/*");

      assert.equal(featureBranches.length, 2);
      for (const branch of featureBranches) {
        assert.equal(branch.errors.length, 0);
      }
    });

    test("should NOT have Any errors if branch name matches bypass pattern *", () => {
      const rules = getDefaultRules();
      rules.bypassBranchesWithNameMatchingPattern = "*";
      const branches = getContextBranches();
      const build = getDefaultManualBuild();

      invokeBranchRules(branches, build, rules);

      assert.ok(branches.length > 0);
      for (const branch of branches) {
        assert.equal(branch.errors.length, 0);
      }
    });
  });
});
