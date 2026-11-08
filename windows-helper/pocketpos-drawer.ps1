# Pocket POS Drawer Helper  (Windows)
# -----------------------------------
# Opens a cash drawer that is plugged into a receipt printer, WITHOUT printing anything.
# It sends the printer the standard ESC/POS "kick drawer" command as a RAW print job.
#
# The Pocket POS web app talks to this helper at http://127.0.0.1:17777 (this PC only;
# nothing on your network or the internet can reach it). Only the web addresses listed in
# POS_ORIGINS are allowed to use it.
#
# Settings come from "Start Pocket POS Drawer.cmd". You normally never edit this file.

$ErrorActionPreference = 'Stop'

$Port        = if ($env:POS_PORT)    { [int]$env:POS_PORT } else { 17777 }
$PrinterName = if ($env:POS_PRINTER) { $env:POS_PRINTER }   else { '' }
$DrawerPin   = if ($env:POS_PIN)     { $env:POS_PIN }       else { 'both' }   # 2, 5 or both
$Origins     = @(($env:POS_ORIGINS -split '[,; ]+') | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('/').ToLower() })

# If no printer name was given, use the Windows default printer.
if (-not $PrinterName) {
  $def = Get-CimInstance Win32_Printer | Where-Object { $_.Default } | Select-Object -First 1
  if ($def) { $PrinterName = $def.Name }
}

# --- Raw printing through the Windows print spooler (Microsoft's standard RawPrinterHelper) ---
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PocketPosRawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

    // Returns null on success, or an error message.
    public static string Send(string printerName, byte[] data) {
        IntPtr h;
        if (!OpenPrinter(printerName, out h, IntPtr.Zero))
            return "Could not open printer '" + printerName + "' (error " + Marshal.GetLastWin32Error() + "). Check the name in Start Pocket POS Drawer.cmd.";
        try {
            DOCINFOA di = new DOCINFOA();
            di.pDocName = "Pocket POS - open drawer";
            di.pDataType = "RAW";
            if (!StartDocPrinter(h, 1, di)) return "StartDocPrinter failed (error " + Marshal.GetLastWin32Error() + ")";
            try {
                StartPagePrinter(h);
                int written;
                bool ok = WritePrinter(h, data, data.Length, out written);
                EndPagePrinter(h);
                if (!ok) return "WritePrinter failed (error " + Marshal.GetLastWin32Error() + ")";
            } finally { EndDocPrinter(h); }
        } finally { ClosePrinter(h); }
        return null;
    }
}
'@

# ESC p m t1 t2 : pulse drawer pin (m=0 -> pin 2, m=1 -> pin 5), on 50 ms, off 500 ms
function Get-KickBytes {
  $pin2 = [byte[]](0x1B, 0x70, 0x00, 0x19, 0xFA)
  $pin5 = [byte[]](0x1B, 0x70, 0x01, 0x19, 0xFA)
  switch ($DrawerPin) { '2' { return $pin2 } '5' { return $pin5 } default { return [byte[]]($pin2 + $pin5) } }
}

function Open-Drawer { return [PocketPosRawPrinter]::Send($PrinterName, (Get-KickBytes)) }

# --- Tiny HTTP server on 127.0.0.1 (TcpListener needs no admin rights) ---
function Send-Response($stream, [string]$status, [string]$json, [string]$origin) {
  $body = [Text.Encoding]::UTF8.GetBytes($json)
  $h  = "HTTP/1.1 $status`r`nContent-Type: application/json`r`nContent-Length: $($body.Length)`r`nConnection: close`r`nCache-Control: no-store`r`n"
  if ($origin) {
    $h += "Access-Control-Allow-Origin: $origin`r`nVary: Origin`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`n"
    $h += "Access-Control-Allow-Headers: Content-Type`r`nAccess-Control-Allow-Private-Network: true`r`nAccess-Control-Max-Age: 600`r`n"
  }
  $h += "`r`n"
  $head = [Text.Encoding]::ASCII.GetBytes($h)
  $stream.Write($head, 0, $head.Length)
  $stream.Write($body, 0, $body.Length)
  $stream.Flush()
}

function Esc-Json([string]$s) { return ($s -replace '\\', '\\' -replace '"', '\"') }

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } catch {
  Write-Host "Could not start on port $Port. Is the helper already running in another window?" -ForegroundColor Red
  Read-Host 'Press Enter to close'; exit 1
}

Write-Host ''
Write-Host ' Pocket POS Drawer Helper is running.' -ForegroundColor Green
Write-Host "   Printer : $PrinterName"
Write-Host "   Pin     : $DrawerPin"
Write-Host "   Allowed : $($Origins -join ', ')"
Write-Host '   Keep this window open (you can minimise it). Close it to stop the helper.'
Write-Host ''

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $client.ReceiveTimeout = 3000
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [Text.Encoding]::ASCII, $false, 4096, $true)
    $requestLine = $reader.ReadLine()
    if (-not $requestLine) { continue }
    $headers = @{}
    while ($true) {
      $line = $reader.ReadLine()
      if ($null -eq $line -or $line -eq '') { break }
      $i = $line.IndexOf(':')
      if ($i -gt 0) { $headers[$line.Substring(0, $i).Trim().ToLower()] = $line.Substring($i + 1).Trim() }
    }
    $parts  = $requestLine.Split(' ')
    $method = $parts[0].ToUpper()
    $path   = ($parts[1] -split '\?')[0]
    $origin = [string]$headers['origin']
    $allowed = $origin -and ($Origins -contains $origin.TrimEnd('/').ToLower())

    if ($origin -and -not $allowed) {
      Write-Host "$(Get-Date -Format T)  Refused request from $origin (not in POS_ORIGINS)" -ForegroundColor Yellow
      Send-Response $stream '403 Forbidden' '{"ok":false,"error":"This website is not allowed. Add it to POS_ORIGINS in Start Pocket POS Drawer.cmd"}' ''
      continue
    }
    $corsOrigin = if ($allowed) { $origin } else { '' }

    if ($method -eq 'OPTIONS') {
      Send-Response $stream '204 No Content' '' $corsOrigin
    } elseif ($path -eq '/status') {
      Send-Response $stream '200 OK' ('{"ok":true,"printer":"' + (Esc-Json $PrinterName) + '","pin":"' + $DrawerPin + '"}') $corsOrigin
    } elseif ($path -eq '/open' -and $method -eq 'POST') {
      $err = Open-Drawer
      if ($err) {
        Write-Host "$(Get-Date -Format T)  ERROR: $err" -ForegroundColor Red
        Send-Response $stream '500 Internal Server Error' ('{"ok":false,"error":"' + (Esc-Json $err) + '"}') $corsOrigin
      } else {
        Write-Host "$(Get-Date -Format T)  Drawer opened"
        Send-Response $stream '200 OK' '{"ok":true}' $corsOrigin
      }
    } else {
      Send-Response $stream '404 Not Found' '{"ok":false,"error":"Not found"}' $corsOrigin
    }
  } catch {
    Write-Host "$(Get-Date -Format T)  $($_.Exception.Message)" -ForegroundColor Red
  } finally {
    # Close politely: finish sending the reply first, so the browser always receives all of it.
    try { $client.Client.Shutdown([System.Net.Sockets.SocketShutdown]::Send) } catch { }
    Start-Sleep -Milliseconds 30
    $client.Close()
  }
}
