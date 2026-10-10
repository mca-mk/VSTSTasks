import * as fs from "fs";
import * as path from "path";
import * as tl from "azure-pipelines-task-lib/task";
import { addDevelopCompare, GitClient, toBranches, toPullRequests } from "./api";
import { currentBranchesOutput, errorsOutput, pullRequestsOutput, reportSummary } from "./output";
import { addPullRequests, Build, invokeBranchRules, outErrors, Rules } from "./rules";

function getIntInput(name: string): number {
  const raw = tl.getInputRequired(name);
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Input '${name}' must be a whole number but was '${raw}'.`);
  }
  return value;
}

function getAccessToken(): string {
  const token =
    tl.getEndpointAuthorizationParameter("SystemVssConnection", "AccessToken", true) ?? process.env.SYSTEM_ACCESSTOKEN;
  if (!token) {
    throw new Error("Could not get the OAuth token for the build. Enable 'Allow scripts to access the OAuth token' for this job.");
  }
  return token;
}

async function run(): Promise<void> {
  const collectionUri = tl.getVariable("System.TeamFoundationCollectionUri") ?? "";
  const projectName = tl.getVariable("System.TeamProject") ?? "";
  const repository = tl.getInputRequired("repository");
  const authenticationType = tl.getInput("authenticationType") ?? "OAuthToken";
  const stagingDirectory = tl.getVariable("Build.StagingDirectory") ?? process.cwd();
  const showIssuesOnBuildSummary = tl.getBoolInput("showIssuesOnBuildSummary");

  const build: Build = {
    buildDefinitionId: tl.getVariable("System.DefinitionId") ?? "",
    sourceBranch: (tl.getVariable("Build.SourceBranch") ?? "").replace("refs/heads/", ""),
    buildReason: tl.getVariable("Build.Reason") ?? "",
    pullRequestId: Number.parseInt(tl.getVariable("System.PullRequest.PullRequestId") ?? "", 10) || 0,
  };

  const rules: Rules = {
    masterBranch: tl.getInputRequired("masterBranch"),
    developBranch: tl.getInputRequired("developBranch"),
    hotfixPrefix: tl.getInputRequired("hotfixBranches"),
    releasePrefix: tl.getInputRequired("releaseBranches"),
    featurePrefix: tl.getInputRequired("featureBranches"),

    hotfixBranchLimit: getIntInput("hotfixBranchLimit"),
    hotfixDaysLimit: getIntInput("hotfixBranchDaysLimit"),
    releaseBranchLimit: getIntInput("releaseBranchLimit"),
    releaseDaysLimit: getIntInput("releaseBranchDaysLimit"),
    featureBranchLimit: getIntInput("featureBranchLimit"),
    featureDaysLimit: getIntInput("featureBranchDaysLimit"),

    hotfixBranchesMustNotBeBehindMaster: tl.getBoolInput("hotfixMustNotBeBehindMaster"),
    releaseBranchesMustNotBeBehindMaster: tl.getBoolInput("releaseMustNotBeBehindMaster"),
    developMustNotBeBehindMaster: tl.getBoolInput("developMustNotBeBehindMaster"),
    featureBranchesMustNotBeBehindMaster: tl.getBoolInput("featureBranchesMustNotBeBehindMaster"),
    featureBranchesMustNotBeBehindDevelop: tl.getBoolInput("featureBranchesMustNotBeBehindDevelop"),
    currentFeatureMustNotBeBehindDevelop: tl.getBoolInput("CurrentFeatureMustNotBeBehindDevelop"),
    currentFeatureMustNotBeBehindMaster: tl.getBoolInput("CurrentFeatureMustNotBeBehindMaster"),
    mustNotHaveHotfixAndReleaseBranches: tl.getBoolInput("mustNotHaveHotfixAndReleaseBranches"),
    masterMustNotHaveActivePullRequests: tl.getBoolInput("masterMustNotHavePendingPullRequests"),
    hotfixBranchesMustNotHaveActivePullRequests: tl.getBoolInput("hotfixBranchesMustNotHavePendingPullRequests"),
    releaseBranchesMustNotHaveActivePullRequests: tl.getBoolInput("releaseBranchesMustNotHavePendingPullRequests"),
    branchNamesMustMatchConventions: tl.getBoolInput("branchNamesMustMatchConventions"),

    bypassBranchesWithNameMatchingPattern: tl.getInput("BypassBranchesWithNameMatchingPattern") ?? "",
  };

  console.log(`Project Collection: [${collectionUri}]`);
  console.log(`Project Name: [${projectName}]`);
  console.log(`Build Definition: [${build.buildDefinitionId}]`);
  console.log(`Build Reason: [${build.buildReason}]`);
  console.log(`Repository: [${repository}]`);
  console.log(`Current Branch: [${build.sourceBranch}]`);
  console.log(`Authentication Type: [OAuthToken]`);
  if (authenticationType !== "OAuthToken") {
    console.log(`Authentication type '${authenticationType}' is no longer supported; using the build's OAuth token instead.`);
  }
  console.log("Rules:");
  for (const [key, value] of Object.entries(rules)) {
    console.log(`  ${key.padEnd(46)}: ${value}`);
  }

  const client = new GitClient(collectionUri, projectName, repository, getAccessToken());

  const refs = await client.getBranches();
  for (const branchName of [rules.masterBranch, rules.developBranch]) {
    if (!refs.some((r) => r.name.toLowerCase() === `refs/heads/${branchName}`.toLowerCase())) {
      throw new Error(`Could not find remote branch: refs/heads/${branchName}`);
    }
  }

  const pullRequests = toPullRequests(await client.getActivePullRequests());
  const comparedToDevelop = await client.getBranchStats(rules.developBranch);
  const branches = toBranches(await client.getBranchStats(rules.masterBranch));
  addDevelopCompare(branches, comparedToDevelop);
  addPullRequests(branches, pullRequests);
  invokeBranchRules(branches, build, rules, tl.debug);

  console.log(currentBranchesOutput(branches));
  console.log(pullRequestsOutput(pullRequests));

  const summaryTitle = "Gitflow Branch Gate Report";
  const summaryFilePath = path.join(stagingDirectory, "GitflowBranchGate.ReportSummary.md");
  const template = fs.readFileSync(path.join(__dirname, "..", "..", "ReportSummary.md"), "utf8");
  fs.writeFileSync(summaryFilePath, reportSummary(template, branches, pullRequests, showIssuesOnBuildSummary));
  tl.addAttachment("Distributedtask.Core.Summary", summaryTitle, summaryFilePath);

  if (outErrors(branches, "Error").length > 0) {
    console.log(errorsOutput(branches));
    tl.setResult(tl.TaskResult.Failed, "Current branches did not pass the Gitflow Branch Gate rules.");
  } else {
    console.log("Branches passed the Gitflow Branch Gate rules.");
    tl.setResult(tl.TaskResult.Succeeded, "");
  }
}

run().catch((err: unknown) => {
  tl.setResult(tl.TaskResult.Failed, err instanceof Error ? err.message : String(err));
});
