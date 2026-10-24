param(
  [Parameter(Mandatory = $true)]
  [string]$PostgresPassword
)
$ErrorActionPreference = 'Stop'

$databaseName = 'trustvault'
$databaseUser = 'trustvault'
$databasePassword = 'trustvault_secret'
$service = Get-Service | Where-Object {
  $_.Name -match '^postgresql' -or $_.DisplayName -match 'PostgreSQL'
} | Select-Object -First 1

if (-not $service) {
  throw 'PostgreSQL is not installed. Install PostgreSQL 17 with: winget install --id PostgreSQL.PostgreSQL.17 --exact'
}

if ($service.Status -ne 'Running') {
  Start-Service -Name $service.Name
}

$bin = Split-Path (Get-Command psql -ErrorAction Stop).Source
$env:PGPASSWORD = $PostgresPassword

& (Join-Path $bin 'psql.exe') -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DO `$`$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$databaseUser') THEN CREATE ROLE $databaseUser LOGIN PASSWORD '$databasePassword'; ELSE ALTER ROLE $databaseUser WITH LOGIN PASSWORD '$databasePassword'; END IF; END `$`$;"
& (Join-Path $bin 'psql.exe') -h localhost -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$databaseName'" | ForEach-Object {
  if ($_.Trim() -ne '1') {
    & (Join-Path $bin 'createdb.exe') -h localhost -U postgres -O $databaseUser $databaseName
  }
}

Write-Host "PostgreSQL is ready: postgresql://$databaseUser`:***@localhost:5432/$databaseName"
