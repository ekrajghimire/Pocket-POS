POCKET POS DRAWER HELPER (Windows)
==================================
Opens the cash drawer from Pocket POS without printing anything.

1. Put this folder somewhere permanent, e.g. Documents\Pocket POS Drawer
   (If you downloaded a zip: right-click the zip > Properties > tick "Unblock" > OK, then Extract All.)
2. Right-click "Start Pocket POS Drawer.cmd" > Edit. Check POS_PRINTER matches your printer's
   name exactly (e.g. XP-80C) and POS_ORIGINS is your Pocket POS web address. Save.
3. Double-click "Start Pocket POS Drawer.cmd". A window says "Drawer Helper is running".
   If Windows shows "Windows protected your PC": More info > Run anyway.
4. In Pocket POS: Menu > Receipt settings > Cash drawer > "Open with: Drawer Helper on this PC",
   then tap "Test: open drawer". If Chrome asks to allow access to apps on this device, click Allow.

Start it automatically with Windows:
   Press Win+R, type  shell:startup  and press Enter. Right-click "Start Pocket POS Drawer.cmd" >
   Create shortcut, and move the shortcut into that Startup folder.

IMPORTANT: once the helper works, set the printer driver's CashDrawer option back to
"Don't open" (XP-80C: Printing preferences > Print Settings > CashDrawer). Otherwise every
print (receipts, reprints) also pops the drawer. Pocket POS opens it for cash sales and the $ button.
