param(
  [string]$Message = ""
)

$ErrorActionPreference = "Stop"

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Args
  )

  & git @Args
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Args -join ' ') failed with exit code $LASTEXITCODE"
  }
}

try {
  $inside = git rev-parse --is-inside-work-tree 2>$null
  if ($LASTEXITCODE -ne 0 -or $inside -ne "true") {
    throw "Current directory is not a git repository."
  }

  Invoke-Git -Args @("add", "-A")

  $status = git status --porcelain
  if ([string]::IsNullOrWhiteSpace(($status | Out-String))) {
    Write-Host "No changes to commit."
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($Message)) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $Message = "chore: sync $timestamp"
  }

  Invoke-Git -Args @("commit", "-m", $Message)

  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  $upstream = git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>$null
  if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($upstream)) {
    Invoke-Git -Args @("push")
  } else {
    Invoke-Git -Args @("push", "-u", "origin", $branch)
  }

  Write-Host "Sync complete."
} catch {
  Write-Error $_
  exit 1
}
