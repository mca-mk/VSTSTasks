# Builds the Gitflow Branch Gate extension (.vsix) for upload to Azure DevOps Server.
# Runs on Windows, Linux or macOS with PowerShell 7 (pwsh) and Node.js 20+.
# Bump the version in Task/task.json before building; vss-extension.json is kept in sync from it.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$taskDir = Join-Path $PSScriptRoot "Task"
$stageDir = Join-Path $PSScriptRoot "build" "stage" "Task"
$outputDir = Join-Path $PSScriptRoot "build"

$task = Get-Content (Join-Path $taskDir "task.json") -Raw | ConvertFrom-Json
$version = "$($task.version.Major).$($task.version.Minor).$($task.version.Patch)"
Write-Host "Building $($task.name) $version" -ForegroundColor Yellow

$manifestPath = Join-Path $PSScriptRoot "vss-extension.json"
$manifest = Get-Content $manifestPath -Raw
$updated = $manifest -replace '("version"\s*:\s*")[^"]*(")', "`${1}$version`${2}"
if ($updated -ne $manifest) {
  Set-Content -Path $manifestPath -Value $updated -NoNewline
  Write-Host "Updated vss-extension.json version to $version"
}

Push-Location $taskDir
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
  npm test
  if ($LASTEXITCODE -ne 0) { throw "Tests failed" }
}
finally {
  Pop-Location
}

# Stage only what the agent needs: compiled code, production dependencies and task metadata.
if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir | Out-Null
foreach ($file in "task.json", "icon.png", "icon.svg", "ReportSummary.md", "package.json", "package-lock.json") {
  Copy-Item (Join-Path $taskDir $file) $stageDir
}
New-Item -ItemType Directory -Path (Join-Path $stageDir "dist") | Out-Null
Copy-Item (Join-Path $taskDir "dist" "src") (Join-Path $stageDir "dist") -Recurse

Push-Location $stageDir
try {
  npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm ci --omit=dev failed" }
}
finally {
  Pop-Location
}

npx --yes tfx-cli extension create --manifest-globs vss-extension.json --output-path $outputDir --no-prompt
if ($LASTEXITCODE -ne 0) { throw "tfx extension create failed" }
