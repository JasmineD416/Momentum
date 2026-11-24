# Puts the Google sign-in Client ID and secret into the server's settings and restarts Momentum.
# Run in Windows PowerShell:  powershell -ExecutionPolicy Bypass -File C:\Users\jasmi\Projects\Momentum\deploy\set-google.ps1
# The values go straight to the server over SSH; they aren't saved on this computer.

$ServerHost = '172.105.0.58'
$Key = Join-Path $env:USERPROFILE '.ssh\momentum-deploy'

$id = (Read-Host 'Paste the Client ID, then press Enter').Trim()
if ($id -notmatch '^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$') { Write-Host 'That does not look like a Client ID (it ends in .apps.googleusercontent.com). Nothing was changed.' -ForegroundColor Red; exit 1 }
$secure = Read-Host 'Paste the Client secret (it stays hidden), then press Enter' -AsSecureString
$secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
if ($secret -notmatch '^[A-Za-z0-9_-]{20,}$') { Write-Host 'That does not look like a Client secret (it usually starts with GOCSPX-). Nothing was changed.' -ForegroundColor Red; exit 1 }

# The saving is done by /opt/momentum/set-google.sh on the server (Windows PowerShell mangles quotes in commands sent to ssh).
$result = "GOOGLE_CLIENT_ID=$id`nGOOGLE_CLIENT_SECRET=$secret`n" | ssh -i $Key -o BatchMode=yes "deploy@$ServerHost" bash /opt/momentum/set-google.sh
$secret = $null

if ($result -match 'ok') { Write-Host 'Done. Google sign-in is saved on the server and Momentum restarted.' -ForegroundColor Green }
else { Write-Host 'Something went wrong; nothing may have changed. Tell Claude what this window shows.' -ForegroundColor Red; exit 1 }
