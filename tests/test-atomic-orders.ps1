param([int]$Port = 55439)
$ErrorActionPreference = 'Stop'
$pgBin = Split-Path (Get-Command psql -ErrorAction Stop).Source
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('onedaycafe-orders-' + [guid]::NewGuid())
$started = $false
try {
    & (Join-Path $pgBin 'initdb.exe') -D $testRoot -U postgres -A trust --no-locale -E UTF8 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
    $start = Start-Process -FilePath (Join-Path $pgBin 'pg_ctl.exe') -WindowStyle Hidden -PassThru -ArgumentList @(
        '-D', "`"$testRoot`"", '-l', "`"$testRoot\server.log`"",
        '-o', "`"-p $Port -h 127.0.0.1 -c wal_level=logical`"", '-w', 'start')
    $start.WaitForExit()
    if ($start.ExitCode -ne 0) { throw "test database start failed: $testRoot\server.log" }
    $started = $true
    $psqlArgs = @('-X', '-w', '-h', '127.0.0.1', '-p', $Port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1')
    & (Join-Path $pgBin 'psql.exe') @psqlArgs -f (Join-Path $PSScriptRoot 'atomic-orders.sql')
    if ($LASTEXITCODE -ne 0) { throw 'transaction regression tests failed' }

    # Run separate sessions concurrently: identical requests deduplicate, distinct ones get distinct numbers.
    foreach ($sameRequest in @($true, $false)) {
        $processes = @()
        $sharedId = [guid]::NewGuid().ToString()
        foreach ($index in 1..4) {
            $requestId = if ($sameRequest) { $sharedId } else { [guid]::NewGuid().ToString() }
            $arguments = $psqlArgs + @('-v', "request_id=$requestId", '-f', "`"$PSScriptRoot\atomic-orders-concurrent.sql`"")
            $label = "$sameRequest-$index"
            $process = Start-Process -FilePath (Join-Path $pgBin 'psql.exe') -WindowStyle Hidden -PassThru -ArgumentList $arguments -RedirectStandardOutput "$testRoot\$label.out" -RedirectStandardError "$testRoot\$label.err"
            $null = $process.Handle
            $processes += $process
        }
        foreach ($process in $processes) {
            $process.WaitForExit()
            if ($process.ExitCode -ne 0) {
                Get-ChildItem -LiteralPath $testRoot -Filter '*.err' | Get-Content
                throw "concurrent request failed: $($process.ExitCode)"
            }
        }
    }
    $assertions = 'DO $$ BEGIN ASSERT (SELECT count(*) FROM public.orders) = 6; ASSERT (SELECT count(DISTINCT order_number) FROM public.orders) = 6; ASSERT (SELECT count(*) FROM public.order_items) = 6; END; $$;'
    & (Join-Path $pgBin 'psql.exe') @psqlArgs -c $assertions
    if ($LASTEXITCODE -ne 0) { throw 'concurrency assertions failed' }
    Write-Output 'Order and menu history tests passed (rollback, retries, validation, soft deletion, RLS, concurrency and numbering).'
} finally {
    if ($started) {
        & (Join-Path $pgBin 'pg_ctl.exe') -D $testRoot -m fast -w stop | Out-Null
    }
    # Keep the isolated cluster and logs for diagnosing a failed test; never touch an existing database.
    Write-Output "Isolated test database files: $testRoot"
}
