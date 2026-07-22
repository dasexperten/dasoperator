# Justina + Zina — seed COGS-RU into dasoperator-api prod
$ErrorActionPreference = 'Continue'
$base = 'https://dasoperator-api.dasexperten.workers.dev'
$h = @{
  'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GrokJustinaZina/cogs-ru-seed'
  'Accept' = 'application/json'
  'Content-Type' = 'application/json'
}

function Get-Api([string]$path) {
  return Invoke-RestMethod -Uri ($base + $path) -Headers $h -TimeoutSec 60
}
function Post-Api([string]$path, $bodyObj) {
  $json = $bodyObj | ConvertTo-Json -Depth 8 -Compress
  return Invoke-RestMethod -Uri ($base + $path) -Method POST -Headers $h -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60
}

$CONTAINER_USD = 6000.0
$CONTAINER_CBM = 33.2
$CONTAINER_KG = 21800.0
$FILL = 0.85
$MARK = 3.0

function Units-Per20([double]$cbm, [int]$units, $kg = $null) {
  $byCube = [math]::Floor($CONTAINER_CBM / $cbm * $FILL)
  if ($null -ne $kg) {
    $byW = [math]::Floor($CONTAINER_KG / [double]$kg * $FILL)
    $ctns = [math]::Min($byCube, $byW)
  } else { $ctns = $byCube }
  return $ctns * $units
}

$frPaste = $CONTAINER_USD / (Units-Per20 (0.365 * 0.325 * 0.34) 288)
$frBrush = $CONTAINER_USD / (Units-Per20 (0.41 * 0.38 * 0.25) 288 8.5)
$frFloss = $CONTAINER_USD / (Units-Per20 (0.41 * 0.38 * 0.25) 288 8.0)
$frPack4 = $CONTAINER_USD / (Units-Per20 (0.52 * 0.43 * 0.25) 144)

$fx = (Get-Api '/api/fx/latest').result
$rubPerUsd = 1e9 / $fx.rates.RUB.rate_to_usd_nano
$cnyToUsd = $fx.rates.CNY.rate_to_usd_nano / 1e9
Write-Host ("FX {0} RUB/USD={1:N4} frP={2:N4} frB={3:N4} fr4={4:N4}" -f $fx.date, $rubPerUsd, $frPaste, $frBrush, $frPack4)

# Full product cards (list is thin — no bundle_size)
$prodList = (Get-Api '/api/products').result.products
Write-Host "list count $($prodList.Count)"

function Get-SellPrice([string]$skuId, [string]$pt) {
  $url = "/api/products/$skuId/price?price_type_id=$pt"
  try {
    $resp = Get-Api $url
    $res = $resp.result
    if ($null -eq $res) { return $null }
    if ($res.source -eq 'd1' -and $null -ne $res.price) {
      return [double]$res.price
    }
  } catch {
    Write-Host "  price-fail $skuId $pt : $($_.Exception.Message)"
  }
  return $null
}

function Get-Group([string]$cat, [string]$sku) {
  $c = $cat.ToLower()
  $s = $sku.ToLower()
  if ($s -eq 'de310') { return 'mouthwash' }
  if ($c -match 'paste' -or $s.StartsWith('de2')) { return 'paste' }
  if ($c -match 'floss') { return 'floss' }
  if ($c -match 'brush' -or $s.StartsWith('de1')) { return 'brush' }
  return 'other'
}

$ok = 0
$gap = 0
$rows = New-Object System.Collections.Generic.List[object]

foreach ($thin in $prodList) {
  $skuId = [string]$thin.id
  # full card for bundle_size / base_sku / category
  try {
    $full = (Get-Api "/api/products/$skuId").result
  } catch {
    Write-Host "GAP $skuId product fetch fail"
    $gap++
    continue
  }
  $name = [string]$full.product_name
  $cat = [string]$full.category
  $bundle = 1
  if ($null -ne $full.bundle_size -and [string]$full.bundle_size -ne '') {
    $bundle = [math]::Max(1, [int]$full.bundle_size)
  }
  $baseSku = $null
  if ($full.base_sku) { $baseSku = [string]$full.base_sku }

  $grp = Get-Group $cat $skuId

  $cny = Get-SellPrice $skuId 'purchase_cny'
  $usd = Get-SellPrice $skuId 'export_usd'
  $fac = $null
  $src = $null
  if ($null -ne $cny) {
    $fac = $cny * $cnyToUsd
    $src = "purchase_cny $cny"
  } elseif ($null -ne $usd) {
    $fac = $usd
    $src = "export_usd $usd"
  } elseif ($baseSku) {
    $cnyB = Get-SellPrice $baseSku 'purchase_cny'
    $usdB = Get-SellPrice $baseSku 'export_usd'
    if ($null -ne $cnyB) {
      $fac = $cnyB * $cnyToUsd * $bundle
      $src = "base $baseSku purchase_cny x$bundle"
    } elseif ($null -ne $usdB) {
      $fac = $usdB * $bundle
      $src = "base $baseSku export_usd x$bundle"
    }
  }

  if ($null -eq $fac) {
    $gap++
    Write-Host "GAP $skuId $name (no purchasing)"
    $rows.Add([ordered]@{ product_id = $skuId; name = $name; status = 'GAP' }) | Out-Null
    continue
  }

  if ($grp -eq 'paste') {
    $fr = $frPaste * $bundle
    $dutyRate = 0.065
    $markRub = $MARK * $bundle
  } elseif ($grp -eq 'floss') {
    $fr = $frFloss * $bundle
    $dutyRate = 0.15
    $markRub = 0.0
  } elseif ($grp -eq 'brush') {
    if ($bundle -ge 4) { $fr = $frPack4 } else { $fr = $frBrush * $bundle }
    $dutyRate = 0.15
    $markRub = 0.0
  } else {
    $fr = $frPaste * $bundle
    $dutyRate = 0.15
    $markRub = 0.0
  }

  $cv = $fac + $fr
  $duty = $cv * $dutyRate
  $cogsUsd = $cv + $duty
  $cogsRub = [math]::Round($cogsUsd * $rubPerUsd + $markRub, 2)
  $note = "COGS-RU Justina+Zina | $src | fr`$$([math]::Round($fr, 4)) duty$($dutyRate * 100)% CZ${markRub}R | FX$($fx.date) no import VAT"

  try {
    $posted = Post-Api "/api/products/$skuId/prices" @{
      price_type_id = 'cogs_ru'
      sell_price    = $cogsRub
      notes         = $note
    }
    $ok++
    Write-Host ("OK {0,-12} {1,8:N2} RUB bundle={2} {3}" -f $skuId, $cogsRub, $bundle, $name)
    $rows.Add([ordered]@{
        product_id  = $skuId
        name        = $name
        grp         = $grp
        bundle      = $bundle
        factory_usd = [math]::Round($fac, 4)
        freight_usd = [math]::Round($fr, 4)
        duty_usd    = [math]::Round($duty, 4)
        mark_rub    = $markRub
        cogs_rub    = $cogsRub
        source      = $src
        status      = 'OK'
        price_id    = $posted.result.id
      }) | Out-Null
  } catch {
    $gap++
    Write-Host "ERR $skuId $($_.Exception.Message)"
    $rows.Add([ordered]@{ product_id = $skuId; name = $name; status = 'ERR'; error = $_.Exception.Message }) | Out-Null
  }
}

$summary = [ordered]@{
  fx_date     = $fx.date
  rub_per_usd = $rubPerUsd
  ok          = $ok
  gap         = $gap
  rows        = $rows
}
$summary | ConvertTo-Json -Depth 8 | Set-Content 'C:\Users\user\Downloads\cogs_ru_seed_result.json' -Encoding UTF8
Write-Host "DONE ok=$ok gap=$gap"
$v = Get-Api '/api/products/de202aa/price?price_type_id=cogs_ru'
Write-Host "verify de202aa: $($v.result | ConvertTo-Json -Compress)"
try {
  $v2 = Get-Api '/api/pricer/list/cogs_ru'
  Write-Host "list count=$($v2.result.count)"
} catch { Write-Host "list err $($_.Exception.Message)" }
