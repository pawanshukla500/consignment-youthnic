# Push local .env values → GitHub Actions secrets (never prints secret values).
# Run: powershell -ExecutionPolicy Bypass -File scripts/push-github-secrets.ps1

$ErrorActionPreference = 'Stop'
$Repo = 'pawanshukla500/consignment-youthnic'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$gh = "$env:ProgramFiles\GitHub CLI\gh.exe"
if (-not (Test-Path $gh)) { $gh = "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe" }
if (-not (Test-Path $gh)) { throw 'GitHub CLI (gh) not found. Install from https://cli.github.com/' }

function Read-DotEnv([string]$Path) {
  $map = @{}
  if (-not (Test-Path $Path)) { return $map }
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { return }
    $key = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).Trim()
    if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    $map[$key] = $val
  }
  return $map
}

$be = Read-DotEnv (Join-Path $Root 'backend\.env')
$fe = Read-DotEnv (Join-Path $Root 'frontend\.env')

# Map: GitHub secret name → source env key / value resolver
$pairs = @(
  @{ Secret = 'JWT_SECRET'; Value = $be['JWT_SECRET'] }
  @{ Secret = 'DATABASE_URL'; Value = $be['DATABASE_URL'] }
  @{ Secret = 'MAILGUN_API_KEY'; Value = $be['MAILGUN_API_KEY'] }
  @{ Secret = 'MAILGUN_DOMAIN'; Value = $(if ($be['MAILGUN_DOMAIN']) { $be['MAILGUN_DOMAIN'] } else { 'youthnic.shop' }) }
  @{ Secret = 'FIREBASE_SERVICE_ACCOUNT_JSON'; Value = $be['FIREBASE_SERVICE_ACCOUNT_JSON'] }
  @{ Secret = 'R2_ACCOUNT_ID'; Value = $be['R2_ACCOUNT_ID'] }
  @{ Secret = 'R2_ACCESS_KEY_ID'; Value = $be['R2_ACCESS_KEY_ID'] }
  @{ Secret = 'R2_SECRET_ACCESS_KEY'; Value = $be['R2_SECRET_ACCESS_KEY'] }
  @{ Secret = 'SUPABASE_JWT_SECRET'; Value = $be['SUPABASE_JWT_SECRET'] }
  @{ Secret = 'VITE_SUPABASE_URL'; Value = $(if ($fe['VITE_SUPABASE_URL']) { $fe['VITE_SUPABASE_URL'] } else { $be['SUPABASE_URL'] }) }
  @{ Secret = 'VITE_SUPABASE_ANON_KEY'; Value = $(if ($fe['VITE_SUPABASE_ANON_KEY']) { $fe['VITE_SUPABASE_ANON_KEY'] } else { $be['SUPABASE_ANON_KEY'] }) }
  @{ Secret = 'VITE_FIREBASE_API_KEY'; Value = $fe['VITE_FIREBASE_API_KEY'] }
  @{ Secret = 'VITE_FIREBASE_AUTH_DOMAIN'; Value = $fe['VITE_FIREBASE_AUTH_DOMAIN'] }
  @{ Secret = 'VITE_FIREBASE_PROJECT_ID'; Value = $fe['VITE_FIREBASE_PROJECT_ID'] }
  @{ Secret = 'VITE_FIREBASE_MESSAGING_SENDER_ID'; Value = $fe['VITE_FIREBASE_MESSAGING_SENDER_ID'] }
  @{ Secret = 'VITE_FIREBASE_APP_ID'; Value = $fe['VITE_FIREBASE_APP_ID'] }
  @{ Secret = 'VITE_POSTHOG_KEY'; Value = $fe['VITE_POSTHOG_KEY'] }
)

$missing = @()
$set = @()
$skipped = @()

foreach ($p in $pairs) {
  $name = $p.Secret
  $val = $p.Value
  if ([string]::IsNullOrWhiteSpace($val)) {
    $missing += $name
    continue
  }
  $val | & $gh secret set $name -R $Repo
  if ($LASTEXITCODE -ne 0) { throw "Failed to set secret $name" }
  $set += $name
  Write-Host "SET  $name"
}

# Optional: GCP secrets if present as env vars for this script session
foreach ($gcp in @('GCP_PROJECT_ID', 'GCP_SA_KEY')) {
  $v = [Environment]::GetEnvironmentVariable($gcp)
  if ([string]::IsNullOrWhiteSpace($v)) {
    $skipped += $gcp
    continue
  }
  $v | & $gh secret set $gcp -R $Repo
  if ($LASTEXITCODE -ne 0) { throw "Failed to set secret $gcp" }
  $set += $gcp
  Write-Host "SET  $gcp"
}

# Repo variables (non-secret)
& $gh variable set CUSTOM_DOMAIN -R $Repo -b 'https://consignment.youthnic.shop' 2>$null
& $gh variable set CLOUD_RUN_REGION -R $Repo -b 'europe-west1' 2>$null
& $gh variable set CLOUD_RUN_SERVICE -R $Repo -b 'consignment-youthnic-git' 2>$null

Write-Host ''
Write-Host "Done. Set $($set.Count) secrets."
if ($missing.Count) {
  Write-Host "Missing from local .env (add manually in GitHub):"
  $missing | ForEach-Object { Write-Host "  - $_" }
}
if ($skipped.Count) {
  Write-Host "Still need GCP secrets (not in .env). Create in GCP, then:"
  Write-Host '  $env:GCP_PROJECT_ID="your-project"; $env:GCP_SA_KEY=(Get-Content sa.json -Raw); .\scripts\push-github-secrets.ps1'
  $skipped | ForEach-Object { Write-Host "  - $_" }
}

Write-Host ''
Write-Host 'Edit secrets: https://github.com/pawanshukla500/consignment-youthnic/settings/secrets/actions'
Write-Host 'Run deploy:   https://github.com/pawanshukla500/consignment-youthnic/actions/workflows/deploy.yml'
