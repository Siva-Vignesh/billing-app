# Billing App (Offline, Cross-Platform)

Offline desktop billing software for shops, built with **Electron + React + TypeScript + SQLite**.
It runs fully offline on Windows, macOS and Linux.

## Features
- **Billing:** multiple held bills, quantity/discount/GST (inclusive or exclusive), cash change, biller selection
- **QR / barcode:** scan products with the webcam, **UPI payment QR** for the bill total, print product QR labels
- **Products & customers:** add/edit/delete, stock tracking, import/export (CSV/JSON)
- **Reports:** Day / Week / Month / Year / All dashboards with sales trend, payment-mode split and invoices;
  click a product to filter the whole dashboard by that product
- **Printing:** receipts to any installed printer
- **Settings:** shop details, UPI ID, currency, themes, keyboard shortcuts
- **Subscriptions:** Diamond (lifetime), Gold (1 year), Silver (monthly); plan shown in every header,
  renewal popup 5 days before expiry, renew/upgrade from Settings
- **Backup:** full JSON backup and CSV (Excel) exports

---

## 1. Prerequisites (install once)

| Tool | Version | Why | Download |
|------|---------|-----|----------|
| **Node.js** (includes **npm**) | 18 or newer (20 LTS+ recommended) | Runs the build tools and installs libraries | https://nodejs.org |
| **Git** | any recent | To clone the repository | https://git-scm.com |
| Webcam | optional | Only needed for QR/barcode scanning | — |

Check they are installed:
```bash
node -v
npm -v
git --version
```

> No Python, Visual Studio or C++ build tools are needed — the database driver
> (`node-sqlite3-wasm`) is pure WebAssembly, so nothing is compiled during install.

## 2. Get the code

**Option A — clone with Git**
```bash
git clone <your-repository-url>
cd <repository-folder>/billing-app
```

**Option B — copy the folder**: copy the `billing-app` folder to the new machine
(you can skip `node_modules/`, `dist/`, `dist-electron/` and `release/` — they are regenerated).

## 3. Install the libraries
From inside `billing-app/`:
```bash
npm install
```
This downloads everything listed in `package.json` into `node_modules/` (including the Electron runtime).
Use `npm ci` instead to install the exact versions pinned in `package-lock.json`.

### Libraries used
**Runtime (`dependencies`)**

| Package | Purpose |
|---------|---------|
| `react`, `react-dom` | User interface |
| `node-sqlite3-wasm` | SQLite database (WebAssembly, no native build) |
| `qrcode` | Generates UPI payment and product QR codes |
| `html5-qrcode` | Webcam QR / barcode scanning |

**Development / build (`devDependencies`)**

| Package | Purpose |
|---------|---------|
| `electron` | Desktop app shell (Chromium + Node.js) |
| `vite`, `@vitejs/plugin-react` | Dev server and bundler |
| `vite-plugin-electron`, `vite-plugin-electron-renderer` | Builds the Electron main/preload scripts with Vite |
| `typescript`, `@types/react`, `@types/react-dom`, `@types/qrcode` | Type checking |
| `electron-builder` | Packages installers for Windows / macOS / Linux |

You never install these one by one — `npm install` handles all of them.

## 4. Open the app (development mode)
```bash
npm run dev
```
The desktop window opens automatically (DevTools opens in a separate window in dev mode).
Code changes reload automatically. Stop it with `Ctrl+C` in the terminal.

On first run the app:
- creates its database `billing.db` in the OS user-data folder and adds 3 sample products
  - Windows: `%APPDATA%\billing-app\`
  - macOS: `~/Library/Application Support/billing-app/`
  - Linux: `~/.config/billing-app/`
- asks for a subscription (shows the plans and this computer's **Machine ID**) before the app can be used

## 5. Build an installer
```bash
npm run build
```
Installers are written to `release/`. Build on each target OS for its installer
(Windows → `.exe`, macOS → `.dmg`, Linux → `AppImage`).

Optional type check:
```bash
npx tsc --noEmit
```

## 6. Subscriptions (vendor only)

| Plan | Duration | Key command |
|------|----------|-------------|
| 💎 Diamond | Lifetime | `node tools/license-tool.js code diamond <MACHINE-ID>` |
| 🥇 Gold | 1 year | `node tools/license-tool.js code gold <MACHINE-ID>` |
| 🥈 Silver | 1 month | `node tools/license-tool.js code silver <MACHINE-ID>` |

1. The customer opens the app and sends you the **Machine ID** shown on the subscription screen (or in Settings → Subscription).
2. Run the command above and send back the printed key. The customer pastes it and clicks **Activate**.
3. **Renewal / upgrade:** issue a new key the same way; the customer enters it in **Settings → Subscription**.
   For an early renewal, pass the current expiry date so no days are lost:
   `node tools/license-tool.js code gold <MACHINE-ID> 2027-11-09`

One-time setup: `node tools/license-tool.js keys` creates `tools/private-key.pem` and prints the public key —
paste it into `PUBLIC_KEY_B64` in `electron/main.ts`. Running `keys` again invalidates all existing keys.
**Never share or commit `tools/private-key.pem`** (it is in `.gitignore`).

### How keys are protected
- Each key is **signed with Ed25519** (private key never leaves the vendor). Changing the plan, expiry or Machine ID breaks the signature.
- Keys are **bound to one computer** (OS machine GUID); a key copied to another PC is rejected.
- The expiry date is inside the signed key, so it cannot be extended by editing files.
- The stored subscription file is **AES-GCM encrypted** per machine; edits are detected.
- **Clock rollback** is detected (last-seen time + latest invoice time); setting the date back locks the app.
- The main process **refuses all data requests** without an active subscription, so bypassing the UI does not help.
- Packaged builds disable DevTools and refuse to start with debugger flags.

> No offline licence is 100% unbreakable — someone who modifies the app's program files can remove checks.
> These measures stop key sharing, key forging, file editing and clock tricks.

---

## Project structure
```
billing-app/
├─ index.html            HTML page + all CSS styles
├─ src/main.tsx          Entire UI: types, utilities, views (Billing, Products, Customers,
│                        Reports, Settings, Activation) and the app shell
├─ electron/main.ts      Main process: window, IPC handlers, SQLite database, licensing
├─ electron/preload.ts   Secure bridge exposing window.api to the UI (must be a separate file)
├─ tools/license-tool.js Vendor tool for signing keys and subscription keys
├─ vite.config.ts        Build configuration
├─ tsconfig.json         TypeScript configuration
└─ package.json          Scripts and library list
```

### Architecture
```
UI (React, src/main.tsx) ── window.api (preload.ts, IPC) ──► Main process (electron/main.ts)
                                                               └─ node-sqlite3-wasm → billing.db
```
All database access runs in the main process; the UI only calls the typed `window.api` bridge.

### Database tables
`products`, `customers`, `billers`, `invoices`, `invoice_items`, `settings`.

## Troubleshooting
| Problem | Fix |
|---------|-----|
| `npm` / `node` not recognized | Install Node.js and reopen the terminal |
| Electron download fails during `npm install` | Check internet/proxy, then `npm install` again |
| Window doesn't open / blank screen | Stop with `Ctrl+C`, run `npm run dev` again, check the terminal for errors |
| Camera scanner shows nothing | Allow camera access in OS privacy settings; close other apps using the webcam |
| USB barcode scanner adds nothing | Scanner must be in keyboard (HID) mode with Enter or Tab suffix; click on the New Bill screen first |
| Receipt doesn't print | Pick the printer in the printer dropdown on New Bill (or "Ask every time" for the print dialog) |
| Something went wrong / screen error | The app keeps running; details are written to `error.log` in the user-data folder |
| Start fresh (deletes all data) | Close the app and delete `billing.db` (and `subscription.dat`) from the user-data folder |

## Roadmap
- User login & roles (admin / cashier)
- Restore from JSON backup
- GST summary and profit reports
- PDF export
- Auto-update
