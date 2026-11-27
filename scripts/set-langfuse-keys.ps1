# Saves your Langfuse keys to .env.local and to the repo's GitHub Actions
# secrets. You paste them into hidden prompts; nothing is shown or printed.
# Run from the repo folder:
#   powershell -ExecutionPolicy Bypass -File scripts\set-langfuse-keys.ps1
param([string]$PublicKey = "")
$ErrorActionPreference = "Stop"
$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) ".env.local"
$repo = (gh repo view --json nameWithOwner --jq .nameWithOwner)

function Plain($secure) {
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
}

Write-Host "Langfuse keys are under Settings > API Keys in your Langfuse project."
$public = $PublicKey.Trim()
if (-not $public) { $public = (Read-Host "Paste your PUBLIC key (pk-lf-...) and press Enter").Trim() }
# A plain prompt (pasting works everywhere); the screen is cleared right after.
$secret = (Read-Host "Paste your SECRET key (sk-lf-...) and press Enter").Trim()
Clear-Host
$base = (Read-Host "Langfuse host: just press Enter for https://cloud.langfuse.com").Trim().TrimEnd("/")
if (-not $base) { $base = "https://cloud.langfuse.com" }

if (-not $public.StartsWith("pk-lf-")) { Write-Host "That public key doesn't start with pk-lf-. Run this again."; exit 1 }
if (-not $secret.StartsWith("sk-lf-")) { Write-Host "That secret key doesn't start with sk-lf-. Run this again."; exit 1 }

$values = [ordered]@{
  LANGFUSE_PUBLIC_KEY = $public
  LANGFUSE_SECRET_KEY = $secret
  LANGFUSE_BASE_URL   = $base
}

# .env.local (UTF-8 without a BOM, so the first line still reads correctly)
$lines = @()
if (Test-Path $envFile) { $lines = @(Get-Content $envFile | Where-Object { $_ -and $_ -notmatch '^LANGFUSE_' }) }
foreach ($k in $values.Keys) { $lines += "$k=$($values[$k])" }
[IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
Write-Host "Saved to .env.local"

foreach ($k in $values.Keys) { gh secret set $k -R $repo --body $values[$k] | Out-Null }
Write-Host "Saved as GitHub Actions secrets in $repo"

$auth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${public}:${secret}"))
try {
  Invoke-RestMethod -Uri "$base/api/public/projects" -Headers @{ Authorization = "Basic $auth" } | Out-Null
  Write-Host "Langfuse accepted the keys. All done: you can close this tab."
} catch {
  Write-Host "Langfuse did not accept these keys (check the host, EU vs US). Run this again."
}
