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
    & (Join-Path $pgBin 'psql.exe') @psqlArgs -f (Join-Path $PSScriptRoot 'customer-coupons.sql')
    if ($LASTEXITCODE -ne 0) { throw 'customer coupon tests failed' }
    $fixture = @'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql AS
  'SELECT nullif(current_setting(''test.uid'',true),'''')::uuid';
INSERT INTO public.coupon_accounts(store_id,customer_type,customer_name,balance)
VALUES('00000000-0000-0000-0000-000000000002','개척자','동시테스트',6000);
'@
    [IO.File]::WriteAllText("$testRoot\coupon-fixture.sql", "\encoding UTF8`n$fixture", [Text.UTF8Encoding]::new($false))
    & (Join-Path $pgBin 'psql.exe') @psqlArgs -f "$testRoot\coupon-fixture.sql"
    if ($LASTEXITCODE -ne 0) { throw 'coupon fixture failed' }
    foreach ($mode in @('spend', 'charge', 'credit')) {
        $processes = @()
        $sharedId = [guid]::NewGuid().ToString()
        foreach ($index in 1..4) {
            $requestId = if ($mode -eq 'charge') { $sharedId } else { [guid]::NewGuid().ToString() }
            $arguments = $psqlArgs + @('-v', "mode=$mode", '-v', "request_id=$requestId", '-f', "`"$PSScriptRoot\coupon-concurrent.sql`"")
            $process = Start-Process -FilePath (Join-Path $pgBin 'psql.exe') -WindowStyle Hidden -PassThru -ArgumentList $arguments -RedirectStandardOutput "$testRoot\coupon-$mode-$index.out" -RedirectStandardError "$testRoot\coupon-$mode-$index.err"
            $null = $process.Handle
            $processes += $process
        }
        foreach ($process in $processes) {
            $process.WaitForExit()
            if ($process.ExitCode -ne 0) {
                Get-ChildItem -LiteralPath $testRoot -Filter 'coupon-*.err' | Get-Content
                throw 'coupon concurrency request failed'
            }
        }
    }
    $couponAssertions = @'
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM public.orders WHERE table_number='동시차감')=2;
  ASSERT (SELECT balance FROM public.coupon_accounts WHERE customer_name='동시테스트')=1000;
  ASSERT (SELECT count(*) FROM public.coupon_accounts WHERE customer_name='동시생성')=1;
  ASSERT (SELECT balance FROM public.coupon_accounts WHERE customer_name='동시생성')=4000;
END; $$;
'@
    [IO.File]::WriteAllText("$testRoot\coupon-assertions.sql", "\encoding UTF8`n$couponAssertions", [Text.UTF8Encoding]::new($false))
    & (Join-Path $pgBin 'psql.exe') @psqlArgs -f "$testRoot\coupon-assertions.sql"
    if ($LASTEXITCODE -ne 0) { throw 'coupon concurrency assertions failed' }
    & (Join-Path $pgBin 'psql.exe') @psqlArgs -f (Join-Path $PSScriptRoot 'kitchen-history.sql')
    if ($LASTEXITCODE -ne 0) { throw 'kitchen history timestamp tests failed' }
    Write-Output 'Order, menu history, coupon and kitchen completion history tests passed.'
} finally {
    if ($started) {
        & (Join-Path $pgBin 'pg_ctl.exe') -D $testRoot -m fast -w stop | Out-Null
    }
    # Keep the isolated cluster and logs for diagnosing a failed test; never touch an existing database.
    Write-Output "Isolated test database files: $testRoot"
}
