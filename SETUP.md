# Pocket POS — Setup Guide

This takes about 30–45 minutes the first time. You need:

- A Mac with **Node.js 20 or newer** (check with `node -v`; install from nodejs.org if missing)
- A Google account
- A free **Vercel** account (vercel.com), signed in with GitHub, GitLab or email
- Your domain, with access to its DNS settings (at your registrar or Cloudflare)

> **Try it first without any setup:** in Terminal, `cd` into this folder and run `npm install`, then `npm run dev`, and open http://localhost:3000 on your Mac. The password is `demo` and data is saved to `.data/demo-db.json`. Desktop Chrome on a Mac has the native barcode detector, so you can hold a product up to the webcam. You can also type barcodes with the ⌨︎ button.

---

## 1. Create the Google Sheet

1. Go to sheets.google.com and create a **blank** spreadsheet. Name it something like `Pocket POS`.
2. Copy the **Sheet ID** from the address bar. It is the long part between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`1AbC...xyz`**`/edit`

That's all you need. On the first run the app creates the **Products** and **Sales** tabs, writes the header rows, freezes them, and formats the barcode column as plain text so leading zeros are kept.

**Prefer to start from the template?** Upload `sheet-template/Pocket-POS-template.xlsx` to Google Drive, open it, then choose **File → Save as Google Sheets** and use that sheet's ID. Delete the two example rows when you're done.

### Sheet layout

**Products**

| barcode (TEXT) | name | price | cost | category | stock | created_at | updated_at |
|---|---|---|---|---|---|---|---|
| 0012345678905 | Example item | 2.50 | 1.10 | Snacks | 20 | | |

- `barcode` must be **Plain text** (Format → Number → Plain text). Otherwise Sheets turns `0012…` into `12…`.
- `price` is the shelf price in AUD, GST-inclusive by default.
- You can add or edit rows by hand at any time. Then tap **☰ → Refresh products** in the app.

**Sales** (written by the app, one row per sale)

| sale_id | date_time | items (JSON) | subtotal | gst | total | payment_type | cash_received | change |
|---|---|---|---|---|---|---|---|---|

`items` holds the line items as JSON, for example `[{"barcode":"…","name":"…","qty":2,"price":3.5,"line_total":7}]`.

---

## 2. Google Cloud: project, Sheets API, service account

1. Open **console.cloud.google.com** and sign in with the same Google account.
2. Click the project picker at the top, then **New project**. Name it `pocket-pos` and click **Create**, then select it.
3. Go to **APIs & Services → Library**, search for **Google Sheets API**, and click **Enable**. The Drive API is **not** needed.
4. Go to **IAM & Admin → Service Accounts → + Create service account**.
   - Name: `pocket-pos`. Click **Create and continue**.
   - Skip the optional role and user steps. Click **Done**.
5. Click the new service account, open the **Keys** tab, then **Add key → Create new key → JSON → Create**.
   A `.json` file downloads. **Treat it like a password.** Never put it in the `public/` folder or in git.
6. Copy the service account's **email**. It looks like `pocket-pos@pocket-pos-123456.iam.gserviceaccount.com` and also appears as `client_email` in the JSON file.

> If key creation is blocked with "Service account key creation is disabled", your Google account is under an organisation policy (common on work or school accounts). Use a personal Gmail account instead.

## 3. Share the sheet with the service account

Open your Google Sheet, click **Share**, and paste the service account email. Give it **Editor** access, untick "Notify people" and click **Share**.
This is the most common setup mistake: without it the app reports `Google Sheets 403/404 … is the sheet shared…`.

## 4. Create your password hash and session secret

In Terminal, inside this folder:

```bash
npm install
npm run hash-password
```

Type your POS password twice (hidden; at least 8 characters). The command prints two lines:

```
PASSWORD_HASH=scrypt:....:....
SESSION_SECRET=....
```

Keep them for the next steps. Your real password is never stored, only the hash.

## 5. (Optional) Test locally with the real sheet

Copy `.env.example` to `.env.local` and fill it in:

```bash
cp .env.example .env.local
# Turn the JSON key into one line you can paste:
node -e "console.log(JSON.stringify(require('./path/to/your-key.json')))"
```

In `.env.local`, wrap that one-line JSON in **single quotes**:

```
GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
```

Then run `npm run dev` and open http://localhost:3000. Scan or type a new barcode, save it, and check that it appears in your sheet within a few seconds.

## 6. Deploy to Vercel

**Option A: Vercel CLI (no GitHub needed)**

```bash
npx vercel            # first time: log in, accept the defaults ("Other" framework)
```

**Option B: GitHub.** Push this folder to a **private** GitHub repo, then in Vercel click **Add New → Project → Import** that repo. Keep the defaults; `vercel.json` already sets the build command and output folder.

Then add the environment variables in **Vercel → your project → Settings → Environment Variables**, for the **Production** environment:

| Name | Value |
|---|---|
| `PASSWORD_HASH` | from step 4 |
| `SESSION_SECRET` | from step 4 |
| `SHEET_ID` | from step 1 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the **entire contents** of the JSON key file (multi-line is fine here) |
| `TZ_NAME` | `Australia/Sydney` (optional) |

Environment variables only apply to new deployments, so redeploy:

```bash
npx vercel --prod
```

(or click **Redeploy** on the latest deployment in the dashboard). Open the `https://<project>.vercel.app` production URL on your phone to check it works.

> Preview URLs (the long ones with random letters) sit behind Vercel's own login by default. Use the production URL or your domain.

## 7. Connect your domain

1. **Vercel → project → Settings → Domains → Add**. Enter the address you want, for example `pos.yourdomain.com` (a subdomain is easiest) or `yourdomain.com`.
2. Vercel shows the exact DNS record on the domain card. At your DNS provider:
   - **Subdomain** (`pos.yourdomain.com`): add a **CNAME** with name `pos` pointing to the target shown on the card.
   - **Root domain** (`yourdomain.com`): add an **A** record for `@` with the IP shown (usually `76.76.21.21`), and delete any old A records for `@`.
   - On Cloudflare, set the record to **DNS only** (grey cloud) so Vercel can issue the certificate.
3. Wait for Vercel to show **Valid Configuration**. HTTPS is issued automatically, and the camera only works over HTTPS.

## 8. Install it on your phone

1. Open `https://pos.yourdomain.com` on the phone and log in.
2. Allow camera access when asked.
3. Add it to your home screen:
   - **iPhone (Safari):** Share → **Add to Home Screen**
   - **Android (Chrome):** ⋮ → **Install app** (or **Add to Home screen**)
4. Open it from the home-screen icon. It runs full-screen and remembers your login for 30 days. On iPhone the home-screen app has its own login, separate from Safari, so you log in once more there.

## 9. Daily use

- Point the box at a barcode. Known items beep and go straight into the cart; unknown items open the **New product** form.
- Tap a cart line to change its quantity or price for this sale, or to remove it. **+ Item** adds something without a barcode.
- The badge at top-left shows **Synced**, **N pending** or **Offline**. Sales are saved on the phone first and sent to the sheet in the background, so you can keep selling through a dropout.
- **☰ → Refresh products** pulls in changes you made directly in the sheet.
- **Edit a product** (name, price, cost, category, stock) in either of two ways:
  - **From the cart:** tap the item → **✎ Edit product (all future sales)**.
  - **Without selling:** ☰ → **✎ Edit a product**, then scan the item or type its barcode.

  The change works immediately on that device and is saved to the sheet within seconds. Other devices pick it up with **Refresh products**. "Price for this sale" in the cart only changes the current sale.
- **Receipts:** set your shop name, address, ABN and paper size once per device in **☰ → Receipt settings**, and use **Print test receipt** to check it. At checkout, tick **🧾 Print receipt**; the app remembers your choice. **☰ → Reprint last receipt** prints the previous sale again. Any printer the device can print to works: USB/network 58 mm or 80 mm thermal receipt printers (install the printer's driver on the PC first), office printers, AirPrint and Android printing. With an ABN entered and GST on, receipts are headed **TAX INVOICE**.
- **🔦** appears only on phones whose browser can control the flashlight (most Android phones). Tap the camera picture to focus where supported.
- **USB / Bluetooth barcode scanners** work on a PC, tablet or phone. Plug it in (or pair it) and scan; nothing to set up.
  - On a computer without a camera, the top panel shows **"Ready — scan an item"**. If it turns amber and says **"Click here, then scan"**, the browser window isn't active. Click it once.
  - On a laptop with a webcam, you can turn off **☰ → Use camera to scan** to use only the hardware scanner. The setting is remembered per device.
  - The scanner must send **Enter** (or Tab) after each code. Almost all do by default; if yours doesn't, scan the "add CR/Enter suffix" setup barcode in its manual.
  - While a panel (checkout, edit…) is open, scans are refused with a warning beep so nothing is added by accident.

## 10. Windows PC with a receipt printer and cash drawer

This is for a cash drawer plugged into the receipt printer with a small phone-style RJ11/RJ12 cable. The **printer** opens the drawer, and its driver can do this every time something is printed.

1. **Install the printer.** Connect the printer by USB and install its Windows driver from the CD or the maker's website. Then print a Windows test page. Plug the drawer cable into the printer's **DK / Drawer** port, not the LAN port.
2. **Make it the default printer.** Go to Settings → Bluetooth & devices → Printers & scanners and turn **off** "Let Windows manage my default printer". Then click the receipt printer → **Set as default**.
3. **Turn on the drawer in the driver.** On the same screen, open the printer → **Printer properties**. Look for a **Cash Drawer** option, usually on the **Device Settings** tab or under **Printing preferences → Advanced**. Set it to open **before printing**. Each driver words this differently, for example "Cash Drawer #1: Open before printing" or "Kick drawer". If there are drawer #1 and #2 settings, use #1; if the drawer doesn't open, try #2.
4. **One-tap printing with no print dialog.** Right-click the desktop → New → Shortcut, and paste:
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --app=https://pocket-pos-ten.vercel.app
   ```
   Name it **Pocket POS**. Use your own domain later if you connect one. **Close every Chrome window first**, then always open the POS from this shortcut. The setting only works when Chrome starts from the shortcut. Edge works the same way with `"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"`. While this Chrome window is open, anything you print from it goes straight to the default printer.
5. **In Pocket POS:** go to ☰ → **Receipt settings**. Set Paper to **80 mm**, tick **Cash drawer is plugged into this device's receipt printer**, then tap **Test: open drawer**.

How it behaves:
- **Cash sale:** the drawer opens. With 🧾 ticked you get a full receipt; without it, a small "CASH SALE" slip showing total, cash and change.
- **Card / Other sale:** the drawer only opens if you print a receipt.
- **💰 button (or F9):** opens the drawer and prints a short "NO SALE" slip with the time. This gives you a paper record of every open.

If the slip prints but the drawer doesn't open, the driver setting in step 3 is off, set to the wrong drawer number, or the cable is in the wrong port. If a lot of blank paper feeds out, choose the roll-paper size (e.g. "80 × 297 mm" or the roll option) in **Printing preferences**.

### Open the drawer without printing: Drawer Helper (recommended)

The **Drawer Helper** is a small program in the `windows-helper` folder. It runs on the Windows PC and sends the printer the "open drawer" command directly, so **no paper prints**. It uses only Windows' built-in PowerShell, so there is nothing to install.

1. On the Windows PC, open Pocket POS → ☰ → **Receipt settings**. Under Cash drawer, set **Open the drawer with** to **Drawer Helper on this PC**, then click **Download Drawer Helper for Windows**.
2. Right-click the downloaded zip → **Properties** → tick **Unblock** → OK. Then right-click it → **Extract All**, into somewhere permanent such as `Documents`.
3. In the extracted folder, right-click **Start Pocket POS Drawer.cmd** → **Edit**. Check that `POS_PRINTER=XP-80C` matches your printer's exact name, and that `POS_ORIGINS` is your Pocket POS address. When you add your own domain later, add it here separated by a comma. Save.
4. Double-click **Start Pocket POS Drawer.cmd**. If Windows says "Windows protected your PC", click **More info → Run anyway**. A window shows **"Drawer Helper is running"**. Leave it open; you can minimise it.
5. In Pocket POS, tap **Check Drawer Helper**, then **Test: open drawer**. If Chrome asks to let the site **access other apps and services on this device**, click **Allow**.
6. **Start it automatically:** press Win + R, type `shell:startup` and press Enter. Put a shortcut to `Start Pocket POS Drawer.cmd` in the folder that opens.
7. Optional: set the printer driver's CashDrawer option (step 3 above) back to **Don't open**. Card-sale receipts will then stop popping the drawer, and Pocket POS opens it itself for cash sales.

If the helper isn't running, Pocket POS shows a warning and prints a slip instead, so the drawer still opens. If the drawer doesn't open but the helper says "Drawer opened", change `POS_PIN` to `2` or `5` in the .cmd file and restart it.

## 11. Customer display (second screen)

A second monitor plugged into the POS computer can show the customer each item, quantity and price, and the running total, live as you scan. After payment it shows **Thank you** with the cash paid and change; when idle it shows your shop name.

1. Plug in the second monitor. In Windows go to **Settings → System → Display** and choose **Extend these displays**.
2. In Pocket POS (Chrome or Edge), click **🖥** in the top bar, or ☰ → **Open customer display**.
3. If Chrome asks to **manage windows on all your displays**, click **Allow**. The display then opens straight onto the second screen. Otherwise drag it across, or press **Win + Shift + →** to move it.
4. **Click once** on the customer display to make it full screen.

The shop name comes from ☰ → Receipt settings. The display only shows information and can't change anything. It must be open in the same browser on the same computer as the POS. If it's closed by accident, press 🖥 again; it picks up the current sale straight away. If the pop-up is blocked, click the blocked-pop-up icon in the address bar → **Always allow**.

## 12. Weather on the home screen

The home screen shows the time, weekday, date and live weather from **Open-Meteo**. No account or key is needed. Its free API is for non-commercial use, and the app shows the required credit *"Weather data by Open-Meteo.com"* at the bottom of the screen.

1. In Pocket POS, tap the **weather button** next to the clock, or ☰ → **Weather location**.
2. Type your suburb or postcode (e.g. `Liverpool` or `2170`) and tap your suburb. You can also use **📍 Use this device's location**.

The button shows the conditions, temperature, and today's high/low. Each device remembers its own suburb. Weather updates every 15 minutes and the last reading stays on screen while offline. **Hide weather** removes it.

## Troubleshooting

| Problem | Fix |
|---|---|
| Camera doesn't start | Must be **https://**. Check the site's camera permission in phone settings. Use ☰ → Restart camera. |
| `Google Sheets 403/404` | Share the sheet with the service account email (step 3) and check `SHEET_ID`. |
| `Google auth failed` | `GOOGLE_SERVICE_ACCOUNT_JSON` must be the whole file contents, unmodified. |
| `PASSWORD_HASH is not set` / can't log in | Add the env vars in Vercel and **redeploy**. |
| "Too many attempts" | 5 wrong passwords in 15 minutes locks that IP for 15 minutes. |
| Barcode lost its leading zero | Format the sheet's barcode column as Plain text and re-type it. |
| App shows old version after a deploy | Close and reopen the app (updates load in the background), or bump `VERSION` in `public/sw.js`. |
| Scanning seems slow on iPhone | iOS Safari has no native barcode detector, so the app uses ZXing (software). Keep the barcode inside the box, about 10–20 cm away, and use good light. |
