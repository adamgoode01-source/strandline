# Generates Strandline.html (a complete, double-clickable HTML document) from
# index.html (the Artifact source, which has no doctype/html/head/body of its own —
# the Artifact platform injects those at publish time).
#
# index.html stays the single source of truth. Re-run this after editing it:
#   powershell -ExecutionPolicy Bypass -File build-standalone.ps1

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here 'index.html'
$dest = Join-Path $here 'Strandline.html'

if (-not (Test-Path $src)) { throw "index.html not found in $here" }

# Read as UTF-8 explicitly. Windows PowerShell 5.1's Get-Content assumes the system
# ANSI codepage for BOM-less files, which turns every em-dash and non-ASCII character
# into mojibake on the way through.
$raw = [System.IO.File]::ReadAllText($src, (New-Object System.Text.UTF8Encoding($false)))

# Split at the end of the stylesheet: everything before it belongs in <head>,
# everything after it is page content.
$marker = '</style>'
$i = $raw.IndexOf($marker)
if ($i -lt 0) { throw 'Could not find </style> in index.html — layout changed, update this script.' }

$head = $raw.Substring(0, $i + $marker.Length)
$body = $raw.Substring($i + $marker.Length)

$out = @"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Strandline">
<meta name="description" content="Tendon elongation and lift-off records for post-tensioned slabs. post-tensioned concrete.">
$head
</head>
<body>
$body
</body>
</html>
"@

# UTF-8 without a BOM, so the file opens cleanly from disk and over any host.
[System.IO.File]::WriteAllText($dest, $out, (New-Object System.Text.UTF8Encoding($false)))

# Same document is the Capacitor web asset for the iOS build.
$wwwDir = Join-Path $here "www"
if (-not (Test-Path $wwwDir)) { New-Item -ItemType Directory -Path $wwwDir | Out-Null }
$wwwDest = Join-Path $wwwDir "index.html"
[System.IO.File]::WriteAllText($wwwDest, $out, (New-Object System.Text.UTF8Encoding($false)))

$kb = [math]::Round((Get-Item $dest).Length / 1KB)
Write-Output "Wrote Strandline.html and www/index.html ($kb KB each)"
