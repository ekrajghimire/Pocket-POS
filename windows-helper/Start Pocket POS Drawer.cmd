@echo off
REM ============================================================
REM  Pocket POS Drawer Helper - settings. Edit the lines below.
REM ============================================================

REM Exact printer name as shown in Windows "Printers & scanners":
set POS_PRINTER=XP-80C

REM Web address(es) of your Pocket POS, separated by commas.
REM Add your own domain here when you connect it, e.g. https://pos.yourshop.com.au
set POS_ORIGINS=https://pocket-pos-ten.vercel.app

REM Which drawer pin to pulse: 2, 5 or both (both works for almost every drawer)
set POS_PIN=both

set POS_PORT=17777
title Pocket POS Drawer Helper
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pocketpos-drawer.ps1"
pause
