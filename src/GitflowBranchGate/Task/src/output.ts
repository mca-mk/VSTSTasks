import { Branch, outErrors, PullRequest } from "./rules";

const SEPARATOR = "------------------------------------------------------------------------------";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(date: Date): string {
  return `${String(date.getDate()).padStart(2, "0")}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join(" ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function section(title: string): string {
  return `${SEPARATOR}\n${title}\n${SEPARATOR}`;
}

export function currentBranchesOutput(branches: Branch[]): string {
  const rows = branches.map((b) => [
    b.branchName,
    `${b.master.behind} | ${b.master.ahead}`,
    `${b.develop.behind} | ${b.develop.ahead}`,
    formatDate(b.modified),
    b.modifiedBy,
    String(b.staleDays),
    String(b.errors.length),
  ]);
  const headers = ["BranchName", "Master", "Develop", "Modified", "ModifiedBy", "StaleDays", "Issues"];
  return `${section("Current Branches:")}\n${formatTable(headers, rows)}\n`;
}

export function pullRequestsOutput(pullRequests: PullRequest[]): string {
  if (pullRequests.length === 0) {
    return `${section("Active Pull Requests:")}\nThere are no active Pull Requests at the moment...`;
  }
  const rows = pullRequests.map((pr) => [String(pr.id), pr.createdBy, pr.sourceBranch, pr.targetBranch, formatDate(pr.created)]);
  const headers = ["ID", "CreatedBy", "SourceBranch", "TargetBranch", "Created"];
  return `${section("Active Pull Requests:")}\n${formatTable(headers, rows)}\n`;
}

export function errorsOutput(branches: Branch[]): string {
  const rows = outErrors(branches, "Error")
    .sort((a, b) => a.branchName.localeCompare(b.branchName))
    .map((e) => [e.branchName, e.message]);
  return `${section("Branches with Errors:")}\n${formatTable(["BranchName", "Message"], rows)}\n`;
}

export function reportSummary(template: string, branches: Branch[], pullRequests: PullRequest[], displayIssues: boolean): string {
  const errors = outErrors(branches, "Error");
  const warnings = outErrors(branches, "Warning");
  const staleDays = branches.map((b) => b.staleDays);
  const stat = (fn: () => number) => (staleDays.length > 0 ? String(fn()) : "");

  let issues = "Not issues found";
  let gateResult = "<span style='color:#fff;Background-Color:#00c700;padding:5px 5px;'>Passed</span>";
  if (errors.length > 0) {
    gateResult = "<span style='color:#fff;Background-Color:#e80303;padding:5px 8px;'>Failed</span>";
    issues = displayIssues ? `### Issues:\n${errors.map((e) => `- ${e.message}\n`).join("")}` : "";
  }

  return template
    .split("@@TotalBranches@@").join(String(branches.length))
    .split("@@TotalWarnings@@").join(String(warnings.length))
    .split("@@TotalErrors@@").join(String(errors.length))
    .split("@@ActivePullRequests@@").join(String(pullRequests.length))
    .split("@@MaxStaleDays@@").join(stat(() => Math.max(...staleDays)))
    .split("@@MinStaleDays@@").join(stat(() => Math.min(...staleDays)))
    .split("@@AvgStaleDays@@").join(stat(() => staleDays.reduce((a, b) => a + b, 0) / staleDays.length))
    .split("@@GateResult@@").join(gateResult)
    .split("@@Issues@@").join(issues);
}
