import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { Database } from 'node-sqlite3-wasm'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ==================== Subscription licensing ====================

// Vendor's Ed25519 public key. Subscription keys are signed with the matching private key
// (tools/private-key.pem), so they cannot be forged or edited without it.
const PUBLIC_KEY_B64 = 'TSMQU5UM8C0iNHDNRQFT3ouC0W7Vl3trZUTFcuD6Tjk='

const PLANS: Record<string, string> = {
  silver: 'Silver (Monthly)',
  gold: 'Gold (1 Year)',
  diamond: 'Diamond (Lifetime)',
}
const REMIND_DAYS = 5
const DAY_MS = 86_400_000
// Small allowance for clock corrections/time-zone changes before treating it as rollback.
const CLOCK_TOLERANCE_MS = 6 * 3_600_000

interface Subscription {
  plan: string
  machineId: string
  issuedAt: string
  expiry: string | null
}

interface LicenseFile {
  key: string
  lastSeen: number
}

interface LicenseStatus {
  state: 'none' | 'active' | 'expired' | 'invalid' | 'clock'
  active: boolean
  plan: string | null
  planLabel: string
  expiry: string | null
  daysLeft: number | null
  remind: boolean
  machineId: string
}

function licenseFile() {
  return path.join(app.getPath('userData'), 'subscription.dat')
}

function readOsMachineGuid(): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
        { encoding: 'utf8', windowsHide: true },
      )
      return out.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] ?? ''
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
      })
      return out.match(/"IOPlatformUUID" = "([^"]+)"/)?.[1] ?? ''
    }
    for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim()
    }
  } catch {
    /* fall back to hostname below */
  }
  return ''
}

let cachedMachineId = ''

/** Hardware-bound id like 1A2B-3C4D-5E6F-7A8B; keys are issued for exactly one machine. */
function machineId(): string {
  if (!cachedMachineId) {
    const raw = `${readOsMachineGuid() || os.hostname()}|${os.platform()}|${os.arch()}`
    const hex = crypto
      .createHash('sha256')
      .update(`billing-app:${raw}`)
      .digest('hex')
      .slice(0, 16)
      .toUpperCase()
    cachedMachineId = hex.match(/.{4}/g)!.join('-')
  }
  return cachedMachineId
}

// Encrypted + authenticated (AES-GCM) so the stored key/last-seen time can't be edited by hand.
function fileKey() {
  return crypto.createHash('sha256').update(`billing-app-store-v2|${machineId()}`).digest()
}

function readLicenseFile(): LicenseFile | null {
  try {
    const buf = fs.readFileSync(licenseFile())
    const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey(), buf.subarray(0, 12))
    decipher.setAuthTag(buf.subarray(12, 28))
    const json = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()])
    const data = JSON.parse(json.toString('utf8')) as LicenseFile
    return typeof data.key === 'string' && typeof data.lastSeen === 'number' ? data : null
  } catch {
    return null
  }
}

function writeLicenseFile(data: LicenseFile) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey(), iv)
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
  fs.writeFileSync(licenseFile(), Buffer.concat([iv, cipher.getAuthTag(), enc]))
}

function publicKeyObject() {
  const der = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(PUBLIC_KEY_B64, 'base64'),
  ])
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' })
}

function fromB64u(s: string) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function verifyKey(key: string): Subscription | null {
  try {
    const [p, s] = key.trim().split('.')
    if (!p || !s) return null
    const payload = fromB64u(p)
    if (!crypto.verify(null, payload, publicKeyObject(), fromB64u(s))) return null
    const d = JSON.parse(payload.toString('utf8'))
    if (d.v !== 2 || !(d.plan in PLANS) || typeof d.machineId !== 'string') return null
    if (typeof d.issuedAt !== 'string' || Number.isNaN(Date.parse(d.issuedAt))) return null
    if (d.plan === 'diamond' ? d.expiry !== null : Number.isNaN(Date.parse(d.expiry))) return null
    return { plan: d.plan, machineId: d.machineId, issuedAt: d.issuedAt, expiry: d.expiry }
  } catch {
    return null
  }
}

const endsAt = (s: Subscription) => (s.expiry ? Date.parse(s.expiry) : Infinity)

/** Latest time this install has ever seen; a system clock behind this means rollback. */
function trustedLastSeen(lic: LicenseFile | null): number {
  const meta = db.get("SELECT value FROM meta WHERE key = 'lastSeen'") as
    | { value: string }
    | undefined
  const inv = db.get('SELECT MAX(created_at) AS t FROM invoices') as { t: string | null }
  return Math.max(lic?.lastSeen ?? 0, Number(meta?.value) || 0, inv.t ? Date.parse(inv.t) : 0)
}

function recordSeen(now: number, lic: LicenseFile) {
  if (now > lic.lastSeen) writeLicenseFile({ ...lic, lastSeen: now })
  db.run(
    `INSERT INTO meta (key, value) VALUES ('lastSeen', ?)
     ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))`,
    [String(now)],
  )
}

function computeStatus(): LicenseStatus {
  const base: LicenseStatus = {
    state: 'none',
    active: false,
    plan: null,
    planLabel: 'No subscription',
    expiry: null,
    daysLeft: null,
    remind: false,
    machineId: machineId(),
  }
  const lic = readLicenseFile()
  if (!lic) return base
  const sub = verifyKey(lic.key)
  if (!sub || sub.machineId !== base.machineId) return { ...base, state: 'invalid' }

  const info = { ...base, plan: sub.plan, planLabel: PLANS[sub.plan], expiry: sub.expiry }
  const now = Date.now()
  if (now + CLOCK_TOLERANCE_MS < Math.max(trustedLastSeen(lic), Date.parse(sub.issuedAt))) {
    return { ...info, state: 'clock' }
  }
  recordSeen(now, lic)
  if (sub.expiry === null) return { ...info, state: 'active', active: true }
  const left = Date.parse(sub.expiry) - now
  if (left <= 0) return { ...info, state: 'expired', daysLeft: 0 }
  const daysLeft = Math.ceil(left / DAY_MS)
  return { ...info, state: 'active', active: true, daysLeft, remind: daysLeft <= REMIND_DAYS }
}

let statusCache: { at: number; status: LicenseStatus } | null = null

function getStatus(force = false): LicenseStatus {
  if (force || !statusCache || Date.now() - statusCache.at > 60_000) {
    statusCache = { at: Date.now(), status: computeStatus() }
  }
  return statusCache.status
}

function activate(key: unknown): { ok: boolean; error?: string; status?: LicenseStatus } {
  if (typeof key !== 'string' || !key.trim() || key.length > 2000) {
    return { ok: false, error: 'Enter a valid subscription key.' }
  }
  const sub = verifyKey(key)
  if (!sub) return { ok: false, error: 'Invalid subscription key.' }
  if (sub.machineId !== machineId()) {
    return { ok: false, error: 'This key was issued for a different computer (Machine ID mismatch).' }
  }
  const prev = readLicenseFile()
  const now = Date.now()
  if (now + CLOCK_TOLERANCE_MS < Math.max(trustedLastSeen(prev), Date.parse(sub.issuedAt))) {
    return { ok: false, error: 'Your system date/time is incorrect. Fix the clock and try again.' }
  }
  if (endsAt(sub) <= now) return { ok: false, error: 'This subscription key has already expired.' }
  const current = prev && verifyKey(prev.key)
  if (current && current.machineId === sub.machineId && endsAt(current) > endsAt(sub)) {
    return { ok: false, error: 'Your current subscription lasts longer than this key.' }
  }
  writeLicenseFile({ key: key.trim(), lastSeen: Math.max(prev?.lastSeen ?? 0, now) })
  return { ok: true, status: getStatus(true) }
}

// ==================== Database (SQLite) ====================

let db: Database

function initDb() {
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  db = new Database(path.join(dir, 'billing.db'))
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      tax_percent REAL NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      hsn TEXT
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT UNIQUE NOT NULL,
      customer_name TEXT,
      customer_phone TEXT,
      subtotal REAL NOT NULL,
      tax REAL NOT NULL,
      discount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      payment_mode TEXT,
      biller TEXT,
      tendered REAL,
      change_due REAL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      product_code TEXT,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      qty INTEGER NOT NULL,
      tax_percent REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS billers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `)
  // Add columns for databases created before these features existed.
  try {
    db.run('ALTER TABLE invoices ADD COLUMN biller TEXT')
  } catch {
    /* column already exists */
  }
  try {
    db.run('ALTER TABLE products ADD COLUMN category TEXT')
  } catch {
    /* column already exists */
  }
  try {
    db.run('ALTER TABLE products ADD COLUMN hsn TEXT')
  } catch {
    /* column already exists */
  }
  try {
    db.run('ALTER TABLE invoices ADD COLUMN tendered REAL')
  } catch {
    /* column already exists */
  }
  try {
    db.run('ALTER TABLE invoices ADD COLUMN change_due REAL')
  } catch {
    /* column already exists */
  }
  seedDemoData()
}

function closeDb() {
  if (db) db.close()
}

function seedDemoData() {
  const row = db.get('SELECT COUNT(*) AS c FROM products') as { c: number }
  if (row.c === 0) {
    db.run(
      'INSERT INTO products (code, name, price, tax_percent, stock) VALUES (?, ?, ?, ?, ?)',
      ['1001', 'Sample Coffee', 120, 5, 50],
    )
    db.run(
      'INSERT INTO products (code, name, price, tax_percent, stock) VALUES (?, ?, ?, ?, ?)',
      ['1002', 'Sample Tea', 80, 5, 50],
    )
    db.run(
      'INSERT INTO products (code, name, price, tax_percent, stock) VALUES (?, ?, ?, ?, ?)',
      ['1003', 'Sample Snack', 40, 12, 100],
    )
  }
}

interface InvoiceItemInput {
  code: string
  name: string
  price: number
  qty: number
  taxPercent: number
  lineTotal: number
}

interface InvoiceInput {
  customerName?: string
  customerPhone?: string
  subtotal: number
  tax: number
  discount: number
  total: number
  paymentMode?: string
  biller?: string
  tendered?: number
  change?: number
  items: InvoiceItemInput[]
}

const api = {
  listProducts: () => db.all('SELECT * FROM products ORDER BY name'),

  getProductByCode: (code: string) =>
    db.get('SELECT * FROM products WHERE code = ?', [code]),

  upsertProduct: (p: {
    code: string
    name: string
    price: number
    tax_percent: number
    stock: number
    category?: string
    hsn?: string
  }) => {
    db.run(
      `INSERT INTO products (code, name, price, tax_percent, stock, category, hsn)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         name = excluded.name,
         price = excluded.price,
         tax_percent = excluded.tax_percent,
         stock = excluded.stock,
         category = excluded.category,
         hsn = excluded.hsn`,
      [
        p.code,
        p.name,
        p.price,
        p.tax_percent,
        p.stock,
        p.category ?? null,
        p.hsn ?? null,
      ],
    )
    return api.getProductByCode(p.code)
  },

  deleteProduct: (code: string) => {
    db.run('DELETE FROM products WHERE code = ?', [code])
    return { ok: true }
  },

  listCustomers: () => db.all('SELECT * FROM customers ORDER BY name'),

  upsertCustomer: (c: {
    id?: number
    name: string
    phone: string
    email: string
    note: string
  }) => {
    if (c.id) {
      db.run('UPDATE customers SET name = ?, phone = ?, email = ?, note = ? WHERE id = ?', [
        c.name,
        c.phone,
        c.email,
        c.note,
        c.id,
      ])
    } else {
      db.run('INSERT INTO customers (name, phone, email, note) VALUES (?, ?, ?, ?)', [
        c.name,
        c.phone,
        c.email,
        c.note,
      ])
    }
    return db.all('SELECT * FROM customers ORDER BY name')
  },

  deleteCustomer: (id: number) => {
    db.run('DELETE FROM customers WHERE id = ?', [id])
    return { ok: true }
  },

  listBillers: () => db.all('SELECT * FROM billers ORDER BY name'),

  addBiller: (name: string) => {
    db.run('INSERT OR IGNORE INTO billers (name) VALUES (?)', [name])
    return db.all('SELECT * FROM billers ORDER BY name')
  },

  deleteBiller: (id: number) => {
    db.run('DELETE FROM billers WHERE id = ?', [id])
    return { ok: true }
  },

  /**
   * Invoices and product sales within [from, to) (ISO strings, either optional).
   * With `product`, invoice amount/qty cover only that product's lines.
   */
  reportData: (q: { from?: string | null; to?: string | null; product?: string | null }) => {
    const productKey = "COALESCE(NULLIF(ii.product_code, ''), ii.name)"
    const cond: string[] = []
    const params: string[] = []
    if (typeof q?.from === 'string') {
      cond.push('i.created_at >= ?')
      params.push(q.from)
    }
    if (typeof q?.to === 'string') {
      cond.push('i.created_at < ?')
      params.push(q.to)
    }
    const where = (extra: string[] = []) =>
      [...cond, ...extra].length ? 'WHERE ' + [...cond, ...extra].join(' AND ') : ''

    const products = db.all(
      `SELECT ${productKey} AS key, MAX(ii.name) AS name,
              SUM(ii.qty) AS qty, SUM(ii.line_total) AS revenue
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
       ${where()}
       GROUP BY key ORDER BY qty DESC, revenue DESC`,
      params,
    )

    const invoices =
      typeof q?.product === 'string'
        ? db.all(
            `SELECT i.*, SUM(ii.line_total) AS amount, SUM(ii.qty) AS qty
             FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
             ${where([`${productKey} = ?`])}
             GROUP BY i.id ORDER BY i.id DESC`,
            [...params, q.product],
          )
        : db.all(
            `SELECT i.*, i.total AS amount,
                    COALESCE((SELECT SUM(ii.qty) FROM invoice_items ii WHERE ii.invoice_id = i.id), 0) AS qty
             FROM invoices i
             ${where()}
             ORDER BY i.id DESC`,
            params,
          )

    return { invoices, products }
  },

  createInvoice: (inv: InvoiceInput) => {
    const number = 'INV-' + Date.now()
    db.run('BEGIN')
    try {
      const result = db.run(
        `INSERT INTO invoices
          (number, customer_name, customer_phone, subtotal, tax, discount, total, payment_mode, biller, tendered, change_due, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          number,
          inv.customerName ?? null,
          inv.customerPhone ?? null,
          inv.subtotal,
          inv.tax,
          inv.discount,
          inv.total,
          inv.paymentMode ?? null,
          inv.biller ?? null,
          inv.tendered ?? null,
          inv.change ?? null,
          new Date().toISOString(),
        ],
      )
      const invoiceId = Number(result.lastInsertRowid)
      for (const it of inv.items) {
        db.run(
          `INSERT INTO invoice_items
            (invoice_id, product_code, name, price, qty, tax_percent, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [invoiceId, it.code, it.name, it.price, it.qty, it.taxPercent, it.lineTotal],
        )
        if (it.code) {
          db.run('UPDATE products SET stock = stock - ? WHERE code = ?', [
            it.qty,
            it.code,
          ])
        }
      }
      db.run('COMMIT')
      return { id: invoiceId, number }
    } catch (err) {
      db.run('ROLLBACK')
      throw err
    }
  },

  listInvoices: () => db.all('SELECT * FROM invoices ORDER BY id DESC'),

  getInvoice: (id: number) => {
    const invoice = db.get('SELECT * FROM invoices WHERE id = ?', [id])
    const items = db.all('SELECT * FROM invoice_items WHERE invoice_id = ?', [id])
    return { invoice, items }
  },

  getSettings: () => {
    const rows = db.all('SELECT key, value FROM settings') as {
      key: string
      value: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  },

  saveSettings: (settings: Record<string, string>) => {
    db.run('BEGIN')
    try {
      for (const [k, v] of Object.entries(settings)) {
        db.run(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [k, v],
        )
      }
      db.run('COMMIT')
    } catch (err) {
      db.run('ROLLBACK')
      throw err
    }
    return api.getSettings()
  },
}

// ==================== Window, IPC and app lifecycle ====================

let win: BrowserWindow | null = null

/** Appends to error.log in the user-data folder; never throws. */
function logError(source: string, err: unknown) {
  try {
    const file = path.join(app.getPath('userData'), 'error.log')
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) {
      fs.renameSync(file, file + '.old')
    }
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${source}: ${msg}\n`)
  } catch {
    /* logging must never crash the app */
  }
}

process.on('uncaughtException', (err) => logError('main', err))
process.on('unhandledRejection', (err) => logError('main (promise)', err))

let rendererCrashes: number[] = []

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
  })

  const wc = win.webContents
  // A dropped file or stray link would replace the app with a blank page.
  wc.on('will-navigate', (e, url) => {
    if (url !== wc.getURL()) e.preventDefault()
  })
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('render-process-gone', (_e, details) => {
    logError('renderer', `gone: ${details.reason} (exit ${details.exitCode})`)
    if (details.reason === 'clean-exit' || !win || win.isDestroyed()) return
    const now = Date.now()
    rendererCrashes = [...rendererCrashes.filter((t) => now - t < 60_000), now]
    if (rendererCrashes.length <= 3) {
      win.reload()
    } else {
      dialog.showErrorBox(
        'Billing App',
        'The window keeps stopping. Please restart the app. Details are in error.log.',
      )
    }
  })
  wc.on('unresponsive', () => {
    logError('renderer', 'window became unresponsive')
    if (!win || win.isDestroyed()) return
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        message: 'The app is not responding.',
        buttons: ['Wait', 'Reload'],
        defaultId: 0,
      })
      .then((r) => {
        if (r.response === 1 && win && !win.isDestroyed()) win.reload()
      })
      .catch((err) => logError('dialog', err))
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
    wc.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

/** Prints HTML in a hidden window: silently to `printer`, or via the system dialog when empty. */
async function printHtml(html: unknown, printer: unknown): Promise<{ ok: boolean; error?: string }> {
  if (typeof html !== 'string' || !html || html.length > 2_000_000) {
    return { ok: false, error: 'Nothing to print.' }
  }
  const deviceName = typeof printer === 'string' ? printer : ''
  if (deviceName) {
    const list = win ? await win.webContents.getPrintersAsync().catch(() => []) : []
    if (!list.some((p) => p.name === deviceName)) {
      return { ok: false, error: `Printer "${deviceName}" is not connected.` }
    }
  }
  const pw = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
  try {
    await pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    return await new Promise((resolve) => {
      const timer = deviceName
        ? setTimeout(() => resolve({ ok: false, error: 'The printer did not respond.' }), 60_000)
        : undefined
      pw.webContents.print(
        { silent: !!deviceName, deviceName: deviceName || undefined, printBackground: true },
        (success, reason) => {
          clearTimeout(timer)
          resolve(success ? { ok: true } : { ok: false, error: reason || 'Printing failed.' })
        },
      )
    })
  } catch (err) {
    logError('print', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (!pw.isDestroyed()) pw.destroy()
  }
}

/** Data channels only work with an active subscription, even if the UI gate is bypassed. */
function handlePaid<A extends unknown[]>(channel: string, fn: (...args: A) => unknown) {
  ipcMain.handle(channel, (_e, ...args) => {
    if (!getStatus().active) throw new Error('An active subscription is required.')
    return fn(...(args as A))
  })
}

function registerIpc() {
  handlePaid('products:list', () => api.listProducts())
  handlePaid('products:getByCode', (code: string) => api.getProductByCode(code))
  handlePaid('products:upsert', (p: Parameters<typeof api.upsertProduct>[0]) =>
    api.upsertProduct(p),
  )
  handlePaid('products:delete', (code: string) => api.deleteProduct(code))
  handlePaid('customers:list', () => api.listCustomers())
  handlePaid('customers:upsert', (c: Parameters<typeof api.upsertCustomer>[0]) =>
    api.upsertCustomer(c),
  )
  handlePaid('customers:delete', (id: number) => api.deleteCustomer(id))
  handlePaid('billers:list', () => api.listBillers())
  handlePaid('billers:add', (name: string) => api.addBiller(name))
  handlePaid('billers:delete', (id: number) => api.deleteBiller(id))
  handlePaid('reports:data', (q: Parameters<typeof api.reportData>[0]) => api.reportData(q))
  handlePaid('printers:list', async () => {
    if (!win) return []
    try {
      return await win.webContents.getPrintersAsync()
    } catch {
      return []
    }
  })
  ipcMain.handle('license:status', () => getStatus(true))
  ipcMain.handle('license:activate', (_e, key: unknown) => activate(key))
  handlePaid('invoices:create', (inv: InvoiceInput) => api.createInvoice(inv))
  handlePaid('invoices:list', () => api.listInvoices())
  handlePaid('invoices:get', (id: number) => api.getInvoice(id))
  handlePaid('settings:get', () => api.getSettings())
  handlePaid('settings:save', (s: Record<string, string>) => api.saveSettings(s))
  handlePaid('print:html', (html: unknown, printer: unknown) => printHtml(html, printer))
  ipcMain.handle('log:error', (_e, msg: unknown) => {
    logError('renderer', typeof msg === 'string' ? msg.slice(0, 4000) : 'unknown error')
  })
}

// Debugger flags would allow patching the licence check at runtime in a shipped build.
if (
  app.isPackaged &&
  (app.commandLine.hasSwitch('remote-debugging-port') ||
    app.commandLine.hasSwitch('inspect') ||
    process.argv.some((a) => /^--(inspect|remote-debugging)/.test(a)))
) {
  app.exit(1)
}

// Two running copies would write the same database at once.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  try {
    initDb()
  } catch (err) {
    logError('database', err)
    dialog.showErrorBox(
      'Billing App',
      `Could not open the database.\n\n${err instanceof Error ? err.message : String(err)}\n\nClose other copies of the app and try again.`,
    )
    app.exit(1)
    return
  }
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  try {
    closeDb()
  } catch (err) {
    logError('database', err)
  }
})
