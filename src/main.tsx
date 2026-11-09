import React, {
  Component,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import ReactDOM from 'react-dom/client'
import QRCode from 'qrcode'
import { Html5Qrcode, Html5QrcodeScannerState } from 'html5-qrcode'

// ==================== Shared types ====================

interface Product {
  id: number
  code: string
  name: string
  price: number
  tax_percent: number
  stock: number
  category?: string | null
  hsn?: string | null
}

interface CartItem {
  code: string
  name: string
  price: number
  qty: number
  taxPercent: number
  hsn?: string
}

interface Customer {
  id: number
  name: string
  phone: string
  email: string
  note: string
}

interface Biller {
  id: number
  name: string
}

interface InvoiceRow {
  id: number
  number: string
  customer_name: string | null
  customer_phone: string | null
  subtotal: number
  tax: number
  discount: number
  total: number
  payment_mode: string | null
  biller: string | null
  tendered: number | null
  change_due: number | null
  created_at: string
}

interface ReportQuery {
  from: string | null
  to: string | null
  /** Product code (or name when the item had no code). */
  product: string | null
}

/** Invoice with `amount`/`qty` limited to the filtered product, if any. */
interface ReportInvoice extends InvoiceRow {
  amount: number
  qty: number
}

interface ReportProduct {
  key: string
  name: string
  qty: number
  revenue: number
}

interface ReportData {
  invoices: ReportInvoice[]
  products: ReportProduct[]
}

interface Settings {
  shopName: string
  address: string
  phone: string
  gstin: string
  upiId: string
  /** Uploaded shop UPI QR as an image data URL ('' when not set). */
  upiQrImage: string
  /** Printer chosen in the billing header ('' = show the print dialog). */
  printer: string
  currency: string
  defaultTax: string
  footer: string
  theme: string
  shortcuts: string
  gstInclusive: string
}

/** A single in-progress bill; multiple can be held at once. */
interface Bill {
  id: string
  label: string
  cart: CartItem[]
  customerName: string
  customerPhone: string
  discountInput: number
  discountType: 'amount' | 'percent'
  paymentMode: string
  tendered: number
}

interface LicenseStatus {
  state: 'none' | 'active' | 'expired' | 'invalid' | 'clock'
  active: boolean
  plan: 'silver' | 'gold' | 'diamond' | null
  planLabel: string
  expiry: string | null
  daysLeft: number | null
  /** True within the last 5 days of a Silver/Gold plan. */
  remind: boolean
  machineId: string
}

interface BillingApi {
  listProducts: () => Promise<Product[]>
  getProductByCode: (code: string) => Promise<Product | undefined>
  upsertProduct: (p: Omit<Product, 'id'>) => Promise<Product>
  deleteProduct: (code: string) => Promise<{ ok: boolean }>
  listCustomers: () => Promise<Customer[]>
  upsertCustomer: (c: Omit<Customer, 'id'> & { id?: number }) => Promise<Customer[]>
  deleteCustomer: (id: number) => Promise<{ ok: boolean }>
  listBillers: () => Promise<Biller[]>
  addBiller: (name: string) => Promise<Biller[]>
  deleteBiller: (id: number) => Promise<{ ok: boolean }>
  reportData: (q: ReportQuery) => Promise<ReportData>
  listPrinters: () => Promise<{ name: string; isDefault?: boolean; status?: number }[]>
  licenseStatus: () => Promise<LicenseStatus>
  licenseActivate: (
    code: string,
  ) => Promise<{ ok: boolean; error?: string; status?: LicenseStatus }>
  createInvoice: (inv: unknown) => Promise<{ id: number; number: string }>
  listInvoices: () => Promise<InvoiceRow[]>
  getInvoice: (id: number) => Promise<unknown>
  getSettings: () => Promise<Record<string, string>>
  saveSettings: (s: Record<string, string>) => Promise<Record<string, string>>
  printHtml: (html: string, printer: string) => Promise<{ ok: boolean; error?: string }>
  logError: (msg: string) => Promise<void>
}

declare global {
  interface Window {
    api: BillingApi
  }
}

// ==================== Utilities ====================

function money(currency: string, n: number): string {
  return `${currency || '₹'}${(n || 0).toFixed(2)}`
}

const PAYMENT_MODES = ['Cash', 'UPI', 'Card'] as const

/** Standard Indian GST rate slabs (%). */
const GST_SLABS = [0, 5, 12, 18, 28] as const

const SHORTCUT_ACTIONS = [
  { id: 'newBill', label: 'New / Hold bill' },
  { id: 'quickAdd', label: 'Quick add item' },
  { id: 'focusSearch', label: 'Focus product search' },
  { id: 'saveInvoice', label: 'Save invoice' },
  { id: 'savePrint', label: 'Save & print' },
  { id: 'showQr', label: 'Show UPI QR' },
  { id: 'toggleScanner', label: 'Toggle camera scanner' },
] as const

const DEFAULT_SHORTCUTS: Record<string, string> = {
  newBill: 'F2',
  quickAdd: 'F4',
  focusSearch: 'F3',
  saveInvoice: 'F9',
  savePrint: 'F10',
  showQr: 'F8',
  toggleScanner: 'F6',
}

/** Canonical string for a key event, e.g. "Ctrl+S", "F4", "Shift+A". */
function keyCombo(e: {
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  key: string
}): string {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return ''
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  let k = e.key
  if (k === ' ') k = 'Space'
  if (k.length === 1) k = k.toUpperCase()
  parts.push(k)
  return parts.join('+')
}

function parseShortcuts(json: string | undefined): Record<string, string> {
  try {
    return { ...DEFAULT_SHORTCUTS, ...(json ? JSON.parse(json) : {}) }
  } catch {
    return { ...DEFAULT_SHORTCUTS }
  }
}

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function exportJson(filename: string, data: unknown) {
  downloadFile(filename, JSON.stringify(data, null, 2), 'application/json')
}

/** Export rows as CSV (opens directly in Excel), UTF-8 with BOM for ₹ etc. */
function exportExcel(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) {
    downloadFile(filename, '\uFEFF', 'text/csv;charset=utf-8')
    return
  }
  const headers = Object.keys(rows[0])
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(',')),
  ].join('\r\n')
  downloadFile(filename, '\uFEFF' + csv, 'text/csv;charset=utf-8')
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10)
}

function escapeHtml(v: unknown): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(v ?? '').replace(/[&<>"']/g, (c) => map[c])
}

/** Readable message from any thrown value (drops Electron's IPC prefix). */
function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Logs to error.log and shows a toast instead of letting the error break the app. */
function reportError(err: unknown) {
  const msg = errorMessage(err)
  window.api?.logError?.(err instanceof Error && err.stack ? err.stack : msg)?.catch(() => {})
  window.dispatchEvent(new CustomEvent('app-error', { detail: msg }))
}

/** Prints straight to `printer`, or opens the print dialog when it is ''. */
async function printDocument(html: string, printer: string, notify: (msg: string) => void) {
  try {
    const res = await window.api.printHtml(html, printer)
    if (!res.ok && !/cancel/i.test(res.error ?? '')) notify(`Print failed: ${res.error}`)
  } catch (err) {
    notify(`Print failed: ${errorMessage(err)}`)
  }
}

/** Parse CSV text (handles quoted fields) into an array of row objects. */
function parseCSV(text: string): Record<string, string>[] {
  const s = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cur.push(field)
      field = ''
    } else if (ch === '\n') {
      cur.push(field)
      rows.push(cur)
      cur = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field)
    rows.push(cur)
  }
  if (!rows.length) return []
  const headers = rows[0].map((h) => h.trim())
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c !== ''))
    .map((r) => {
      const obj: Record<string, string> = {}
      headers.forEach((h, idx) => (obj[h] = (r[idx] ?? '').trim()))
      return obj
    })
}

// ==================== Icons ====================

const ICONS: Record<string, ReactNode> = {
  receipt: (
    <>
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1Z" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
      <path d="M12 17.5v-11" />
    </>
  ),
  cart: (
    <>
      <circle cx="8" cy="21" r="1" />
      <circle cx="19" cy="21" r="1" />
      <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
    </>
  ),
  box: (
    <>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  chart: (
    <>
      <line x1="12" x2="12" y1="20" y2="10" />
      <line x1="18" x2="18" y1="20" y2="4" />
      <line x1="6" x2="6" y1="20" y2="16" />
    </>
  ),
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  camera: (
    <>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </>
  ),
  scan: (
    <>
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <line x1="7" x2="7" y1="8" y2="16" />
      <line x1="11" x2="11" y1="8" y2="16" />
      <line x1="15" x2="15" y1="8" y2="16" />
    </>
  ),
  printer: (
    <>
      <path d="M6 9V2h12v7" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect width="12" height="8" x="6" y="14" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </>
  ),
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </>
  ),
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" x2="12" y1="3" y2="15" />
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
}

interface IconProps {
  name: keyof typeof ICONS | string
  size?: number
}

function Icon({ name, size = 18 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: '-0.18em', flexShrink: 0 }}
      aria-hidden="true"
    >
      {ICONS[name] ?? null}
    </svg>
  )
}

// ==================== Error boundary ====================

interface ErrorBoundaryProps {
  children: ReactNode
  fallbackTitle?: string
  onReset?: () => void
}

interface ErrorBoundaryState {
  hasError: boolean
  message: string
}

/** Prevents a crash in a child (e.g. the camera) from blanking the whole app. */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: '' }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  componentDidCatch(error: unknown) {
    console.error('ErrorBoundary caught:', error)
    window.api?.logError?.(error instanceof Error ? (error.stack ?? error.message) : String(error))?.catch(() => {})
  }

  handleReset = () => {
    this.setState({ hasError: false, message: '' })
    this.props.onReset?.()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="panel">
          <div className="panel-body">
            <h2 style={{ marginTop: 0 }}>
              {this.props.fallbackTitle ?? 'Something went wrong'}
            </h2>
            <p className="muted">{this.state.message}</p>
            <button className="btn primary" onClick={this.handleReset}>
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ==================== QR / barcode scanner ====================

interface ScannerProps {
  onScan: (code: string) => void
}

/** Webcam-based QR / barcode scanner for adding products to the bill. */
function Scanner({ onScan }: ScannerProps) {
  // Auto-start so the camera is live as soon as the scanner is opened.
  const [active, setActive] = useState(true)
  const [status, setStatus] = useState('Starting camera…')
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const onScanRef = useRef(onScan)
  const regionId = 'qr-scan-region'

  // Keep latest callback without re-triggering the camera effect.
  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    if (!active) return

    let cancelled = false
    const scanner = new Html5Qrcode(regionId)
    scannerRef.current = scanner
    const config = { fps: 10, qrbox: { width: 260, height: 260 } }

    // The camera decodes ~10 times a second; one physical scan should add one item.
    let last = { text: '', at: 0 }
    const handle = (decodedText: string) => {
      const now = Date.now()
      if (decodedText === last.text && now - last.at < 1500) return
      last = { text: decodedText, at: now }
      try {
        onScanRef.current(decodedText)
      } catch (err) {
        reportError(err)
      }
    }
    const start = (camera: string | { facingMode: unknown }) =>
      scanner
        .start(camera as never, config, handle, () => {})
        .then(() => !cancelled && setStatus('Point the camera at a barcode / QR'))
        .catch((err) => {
          console.error('Camera start failed:', err)
          if (!cancelled) setStatus('Unable to access camera')
        })

    // Laptops usually only have a front camera, so enumerate and pick one
    // instead of forcing the (missing) rear "environment" camera.
    Html5Qrcode.getCameras()
      .then((cams) => {
        if (cancelled) return
        if (cams && cams.length) start(cams[cams.length - 1].id)
        else start({ facingMode: 'environment' })
      })
      .catch(() => {
        if (!cancelled) start({ facingMode: { ideal: 'environment' } })
      })

    return () => {
      cancelled = true
      const instance = scannerRef.current
      scannerRef.current = null
      if (!instance) return
      // Stop fully before clearing; both are wrapped so a teardown error
      // can never crash the React tree (white screen).
      void (async () => {
        try {
          if (instance.getState() === Html5QrcodeScannerState.SCANNING) {
            await instance.stop()
          }
          instance.clear()
        } catch (err) {
          console.warn('Scanner cleanup skipped:', err)
        }
      })()
    }
  }, [active])

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Camera Scanner</h2>
        <button className="btn" onClick={() => setActive((a) => !a)}>
          {active ? 'Stop Camera' : 'Start Camera'}
        </button>
      </div>
      <div className="panel-body">
        <div id={regionId} style={{ width: '100%' }} />
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
          {active ? status : 'Camera stopped.'}
        </p>
      </div>
    </div>
  )
}

// ==================== Subscription ====================

const PLAN_INFO = [
  { id: 'diamond', icon: '💎', name: 'Diamond', term: 'Lifetime', note: 'One-time, never expires' },
  { id: 'gold', icon: '🥇', name: 'Gold', term: '1 Year', note: 'Renew every year' },
  { id: 'silver', icon: '🥈', name: 'Silver', term: 'Monthly', note: 'Renew every month' },
] as const

const LicenseContext = createContext<{
  license: LicenseStatus | null
  setLicense: (s: LicenseStatus) => void
  openSubscription: () => void
}>({ license: null, setLicense: () => {}, openSubscription: () => {} })

function formatDate(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : 'Never'
}

function PlanBadge() {
  const { license, openSubscription } = useContext(LicenseContext)
  const info = PLAN_INFO.find((p) => p.id === license?.plan)
  if (!license || !info) return null
  const left =
    license.daysLeft === null
      ? 'Lifetime'
      : `${license.daysLeft} day${license.daysLeft === 1 ? '' : 's'} left`
  return (
    <button
      className={`plan-badge ${info.id}${license.remind ? ' warn' : ''}`}
      onClick={openSubscription}
      title={`Expires: ${formatDate(license.expiry)}`}
    >
      {info.icon} {info.name} · {left}
    </button>
  )
}

function SubscriptionKeyForm({
  machineId,
  buttonLabel,
  onActivated,
}: {
  machineId: string
  buttonLabel: string
  onActivated: (status: LicenseStatus) => void
}) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  async function submit() {
    if (!key.trim()) {
      setError('Paste your subscription key.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await window.api.licenseActivate(key.trim())
      if (res.ok && res.status) {
        setKey('')
        onActivated(res.status)
      } else {
        setError(res.error ?? 'Activation failed.')
      }
    } catch (err) {
      setError(`Activation failed: ${errorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(machineId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Could not copy — select the Machine ID and copy it manually.')
    }
  }

  return (
    <div style={{ textAlign: 'left' }}>
      <div className="field">
        <label>
          Machine ID <span className="hint">— send this to your vendor to get a key</span>
        </label>
        <div className="machine-id">
          <span>{machineId}</span>
          <button className="link-btn" onClick={copyId}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <div className="field">
        <label>Subscription key</label>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Paste the subscription key"
          spellCheck={false}
        />
      </div>
      {error && <p className="activation-error">{error}</p>}
      <button className="btn primary block" onClick={submit} disabled={busy} style={{ marginTop: 6 }}>
        {busy ? 'Verifying…' : buttonLabel}
      </button>
    </div>
  )
}

interface ActivationScreenProps {
  status: LicenseStatus
  onActivated: (status: LicenseStatus) => void
}

function ActivationScreen({ status, onActivated }: ActivationScreenProps) {
  const [plan, setPlan] = useState<(typeof PLAN_INFO)[number]['id']>('gold')
  const selected = PLAN_INFO.find((p) => p.id === plan)!
  const message: Record<LicenseStatus['state'], string> = {
    none: 'Choose a subscription plan to start using the app.',
    active: '',
    expired: `Your ${status.planLabel} subscription expired on ${formatDate(status.expiry)}. Enter a renewal key to continue.`,
    invalid: 'The saved subscription is not valid for this computer. Enter a key issued for this Machine ID.',
    clock: 'Your system date/time is behind the last time the app was used. Correct the clock, then restart the app.',
  }

  return (
    <div className="activation-screen">
      <div className="activation-card wide">
        <div className="activation-logo">🧾</div>
        <h1>Choose your subscription</h1>
        <p className={status.state === 'none' ? 'muted' : 'activation-warn'}>
          {message[status.state]}
        </p>

        <div className="plan-grid">
          {PLAN_INFO.map((p) => (
            <button
              key={p.id}
              className={`plan-card ${plan === p.id ? 'selected' : ''}`}
              onClick={() => setPlan(p.id)}
            >
              <div className="plan-icon">{p.icon}</div>
              <div className="plan-name">{p.name}</div>
              <div className="plan-term">{p.term}</div>
              <div className="plan-note">{p.note}</div>
            </button>
          ))}
        </div>

        <ol className="activation-steps">
          <li>
            Send your <strong>Machine ID</strong> and plan (<strong>{selected.name}</strong>)
            to your vendor.
          </li>
          <li>Paste the subscription key you receive and activate.</li>
        </ol>

        <SubscriptionKeyForm
          machineId={status.machineId}
          buttonLabel="Activate subscription"
          onActivated={onActivated}
        />
      </div>
    </div>
  )
}

// ==================== Billing view ====================

interface BillingViewProps {
  bill: Bill
  bills: Bill[]
  activeBillId: string
  products: Product[]
  customers: Customer[]
  billers: Biller[]
  currentBiller: string
  onSelectBiller: (name: string) => void
  onSelectPrinter: (name: string) => void
  settings: Settings
  onUpdate: (patch: Partial<Bill> | ((bill: Bill) => Partial<Bill>)) => void
  onSwitch: (id: string) => void
  onNew: () => void
  onClose: (id: string) => void
  refreshProducts: () => void
  notify: (msg: string) => void
}

/** Parse a scanned QR: supports plain code or JSON {code,...}. */
function codeFromScan(text: string): string {
  try {
    const obj = JSON.parse(text)
    if (obj && (obj.code || obj.c)) return String(obj.code ?? obj.c)
  } catch {
    /* not JSON — treat as raw code */
  }
  return text.trim()
}

function BillingView({
  bill,
  bills,
  activeBillId,
  products,
  customers,
  billers,
  currentBiller,
  onSelectBiller,
  onSelectPrinter,
  settings,
  onUpdate,
  onSwitch,
  onNew,
  onClose,
  refreshProducts,
  notify,
}: BillingViewProps) {
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [custOpen, setCustOpen] = useState(false)
  const [custHi, setCustHi] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const [quick, setQuick] = useState({
    open: false,
    code: '',
    name: '',
    price: '',
    category: '',
  })
  const [showScanner, setShowScanner] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [qrAmount, setQrAmount] = useState(0)
  const [scanFlash, setScanFlash] = useState(false)
  const [scannerActive, setScannerActive] = useState(false)
  const [scannerName, setScannerName] = useState('')
  const [printers, setPrinters] = useState<
    { name: string; isDefault?: boolean; status?: number }[]
  >([])
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  const loadPrinters = () =>
    window.api
      .listPrinters()
      .then(setPrinters)
      .catch(() => setPrinters([]))

  useEffect(() => {
    loadPrinters()
  }, [])

  // Detect an HID-mode barcode scanner if the OS exposes it (keyboard-wedge
  // scanners can't be enumerated, so this only helps HID/POS scanners).
  useEffect(() => {
    const hid = (navigator as unknown as { hid?: any }).hid
    if (!hid?.getDevices) return
    const check = async () => {
      try {
        const devices = await hid.getDevices()
        const s = devices.find((d: any) =>
          /scan|barcode|symbol|honeywell|zebra|datalogic/i.test(d.productName || ''),
        )
        if (s) {
          setScannerName(s.productName || 'Barcode scanner')
          setScannerActive(true)
        } else {
          setScannerName('')
        }
      } catch {
        /* ignore */
      }
    }
    check()
    hid.addEventListener?.('connect', check)
    hid.addEventListener?.('disconnect', check)
    return () => {
      hid.removeEventListener?.('connect', check)
      hid.removeEventListener?.('disconnect', check)
    }
  }, [])

  const selectedPrinter = printers.find((p) => p.name === settings.printer)
  const printerState = !settings.printer
    ? 'off'
    : !selectedPrinter || (selectedPrinter.status ?? 0) !== 0
      ? 'error'
      : 'ok'
  const scannerState = scanFlash || scannerActive ? 'ok' : 'off'

  const cur = settings.currency || '₹'
  const cart = bill.cart
  const gstInclusive = settings.gstInclusive === 'yes'

  const lines = useMemo(
    () =>
      cart.map((i) => {
        const gross = i.price * i.qty
        const rate = i.taxPercent
        const taxable = gstInclusive ? (gross * 100) / (100 + rate) : gross
        const gst = gstInclusive ? gross - taxable : (taxable * rate) / 100
        return { ...i, gross, rate, taxable, gst }
      }),
    [cart, gstInclusive],
  )
  const subtotal = lines.reduce((s, l) => s + l.taxable, 0)
  const tax = lines.reduce((s, l) => s + l.gst, 0)
  const cgst = tax / 2
  const sgst = tax / 2
  const base = subtotal + tax
  const discountAmount =
    bill.discountType === 'percent'
      ? (base * Math.min(bill.discountInput, 100)) / 100
      : bill.discountInput
  const total = Math.max(0, base - discountAmount)

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    return products
      .filter((p) => p.name.toLowerCase().includes(q) || p.code.includes(q))
      .slice(0, 8)
  }, [products, search])

  const custSuggestions = useMemo(() => {
    const q = bill.customerName.trim().toLowerCase()
    const list = q
      ? customers.filter(
          (c) =>
            c.name.toLowerCase().includes(q) || (c.phone ?? '').includes(q),
        )
      : customers
    return list.slice(0, 8)
  }, [customers, bill.customerName])

  function addByCode(rawText: string) {
    const code = codeFromScan(rawText)
    if (!code) return
    const product = products.find((p) => p.code === code)
    if (!product) {
      // Item not in the system — let the biller add it on the spot.
      openQuickAdd({ code })
      return
    }
    // Functional update so back-to-back scans never lose a quantity.
    onUpdate((b) => {
      const existing = b.cart.find((i) => i.code === code)
      return {
        cart: existing
          ? b.cart.map((i) => (i.code === code ? { ...i, qty: i.qty + 1 } : i))
          : [
              ...b.cart,
              {
                code: product.code,
                name: product.name,
                price: product.price,
                qty: 1,
                taxPercent: product.tax_percent,
                hsn: product.hsn ?? '',
              },
            ],
      }
    })
  }

  function addProduct(code: string) {
    addByCode(code)
    setSearch('')
    setSearchOpen(false)
    searchRef.current?.focus()
  }

  function changeQty(code: string, delta: number) {
    onUpdate((b) => ({
      cart: b.cart
        .map((i) => (i.code === code ? { ...i, qty: i.qty + delta } : i))
        .filter((i) => i.qty > 0),
    }))
  }

  function removeItem(code: string) {
    onUpdate((b) => ({ cart: b.cart.filter((i) => i.code !== code) }))
  }

  function openQuickAdd(prefill?: { code?: string; name?: string }) {
    setQuick({
      open: true,
      code: prefill?.code ?? '',
      name: prefill?.name ?? '',
      price: '',
      category: '',
    })
  }

  async function saveQuick() {
    const name = quick.name.trim()
    if (!name || quick.price === '') {
      notify('Name and price are required.')
      return
    }
    const code = quick.code.trim() || 'Q' + Date.now().toString().slice(-9)
    const price = Number(quick.price) || 0
    try {
      await window.api.upsertProduct({
        code,
        name,
        category: quick.category.trim(),
        price,
        tax_percent: 0,
        stock: 0,
      })
    } catch (err) {
      notify(`Could not save item: ${errorMessage(err)}`)
      return
    }
    refreshProducts()
    onUpdate((b) => {
      const existing = b.cart.find((i) => i.code === code)
      return {
        cart: existing
          ? b.cart.map((i) => (i.code === code ? { ...i, qty: i.qty + 1 } : i))
          : [...b.cart, { code, name, price, qty: 1, taxPercent: 0 }],
      }
    })
    setQuick({ open: false, code: '', name: '', price: '', category: '' })
    notify(`Added "${name}" to bill and catalog.`)
  }

  // Hardware USB barcode scanner: it "types" the code fast then presses Enter.
  // Keep the latest add handler in a ref so the global listener stays fresh.
  const scanFn = useRef<(code: string) => void>(() => {})
  scanFn.current = addByCode
  const flashTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    const buf = { text: '', start: 0, last: 0 }
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const inSearch = !!target && target === searchRef.current
      const editable =
        !!target &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)
      // Scans into other fields (quick-add code, customer, …) belong to that field.
      if (editable && !inSearch) {
        buf.text = ''
        return
      }
      const now = Date.now()
      if (buf.text === '' || now - buf.last > 120) {
        buf.text = ''
        buf.start = now
      }
      buf.last = now
      // Scanners end a code with Enter (default) or Tab, depending on their setup.
      if (e.key === 'Enter' || e.key === 'Tab') {
        const code = buf.text.trim()
        const elapsed = now - buf.start
        buf.text = ''
        // Only treat as a scan when entered at scanner speed (not manual typing).
        if (code.length >= 3 && elapsed < code.length * 60) {
          // Stop the search box / focused button from also handling this Enter.
          e.preventDefault()
          e.stopPropagation()
          if (inSearch) {
            setSearch('')
            setSearchOpen(false)
          }
          try {
            scanFn.current(code)
          } catch (err) {
            reportError(err)
          }
          setScannerActive(true)
          setScanFlash(true)
          window.clearTimeout(flashTimer.current)
          flashTimer.current = window.setTimeout(() => setScanFlash(false), 1200)
        }
        return
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) buf.text += e.key
    }
    // Capture phase runs before React's handlers on the focused element.
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.clearTimeout(flashTimer.current)
    }
  }, [])

  function receiptHtml(invoiceNumber: string): string {
    const rows = lines
      .map(
        (l) =>
          `<tr><td>${escapeHtml(l.name)}${l.hsn ? `<br><small>HSN ${escapeHtml(l.hsn)}</small>` : ''}</td><td class="c">${l.qty}</td><td class="c">${l.rate}%</td><td class="r">${escapeHtml(money(cur, l.gross))}</td></tr>`,
      )
      .join('')
    const byRate: Record<string, { taxable: number; gst: number }> = {}
    lines.forEach((l) => {
      const k = String(l.rate)
      byRate[k] = byRate[k] || { taxable: 0, gst: 0 }
      byRate[k].taxable += l.taxable
      byRate[k].gst += l.gst
    })
    const m = (n: number) => escapeHtml(money(cur, n))
    const gstRows = Object.entries(byRate)
      .map(
        ([rate, v]) =>
          `<tr><td>${escapeHtml(rate)}%</td><td class="r">${m(v.taxable)}</td><td class="r">${m(v.gst / 2)}</td><td class="r">${m(v.gst / 2)}</td></tr>`,
      )
      .join('')
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(invoiceNumber)}</title>
<style>
  @page{margin:4mm}
  *{font-family:'Segoe UI',Arial,sans-serif}
  body{width:300px;margin:0 auto;padding:10px;color:#000}
  h1{font-size:17px;text-align:center;margin:0}
  .tag{text-align:center;font-size:11px;letter-spacing:1px;font-weight:700}
  .muted{color:#333;font-size:11px;text-align:center;margin:1px 0}
  hr{border:none;border-top:1px dashed #000;margin:7px 0}
  table{width:100%;border-collapse:collapse;font-size:11px}
  td{padding:2px 0;vertical-align:top}
  small{color:#555;font-size:9px}
  .c{text-align:center}.r{text-align:right}
  .tot{display:flex;justify-content:space-between;font-size:12px;margin:2px 0}
  .grand{font-size:15px;font-weight:800}
  .gsttab td{border-top:1px solid #ccc;padding:3px 0}
  .foot{text-align:center;margin-top:10px;font-size:11px}
</style></head><body>
  <h1>${escapeHtml(settings.shopName || 'My Shop')}</h1>
  <div class="tag">TAX INVOICE</div>
  ${settings.address ? `<div class="muted">${escapeHtml(settings.address)}</div>` : ''}
  ${settings.phone ? `<div class="muted">Ph: ${escapeHtml(settings.phone)}</div>` : ''}
  ${settings.gstin ? `<div class="muted">GSTIN: ${escapeHtml(settings.gstin)}</div>` : ''}
  <hr/>
  <div class="tot"><span>Invoice</span><span>${escapeHtml(invoiceNumber)}</span></div>
  <div class="tot"><span>Date</span><span>${escapeHtml(new Date().toLocaleString())}</span></div>
  <div class="tot"><span>Cashier</span><span>${escapeHtml(currentBiller || '\u2014')}</span></div>
  <div class="tot"><span>Customer</span><span>${escapeHtml(bill.customerName || 'Walk-in')}</span></div>
  ${bill.customerPhone ? `<div class="tot"><span>Phone</span><span>${escapeHtml(bill.customerPhone)}</span></div>` : ''}
  <hr/>
  <table><thead><tr><td>Item</td><td class="c">Qty</td><td class="c">GST</td><td class="r">Amount</td></tr></thead>
  <tbody>${rows}</tbody></table>
  <hr/>
  <div class="tot"><span>Taxable Value</span><span>${m(subtotal)}</span></div>
  <div class="tot"><span>CGST</span><span>${m(tax / 2)}</span></div>
  <div class="tot"><span>SGST</span><span>${m(tax / 2)}</span></div>
  ${discountAmount ? `<div class="tot"><span>Discount</span><span>-${m(discountAmount)}</span></div>` : ''}
  <div class="tot grand"><span>TOTAL</span><span>${m(total)}</span></div>
  <div class="tot"><span>Payment</span><span>${escapeHtml(bill.paymentMode)}</span></div>
  ${
    bill.paymentMode === 'Cash' && (bill.tendered || 0) > 0
      ? `<div class="tot"><span>Cash Received</span><span>${m(bill.tendered)}</span></div><div class="tot"><span>Balance</span><span>${m(Math.max(0, (bill.tendered || 0) - total))}</span></div>`
      : ''
  }
  <hr/>
  <div class="tag" style="text-align:left">GST SUMMARY</div>
  <table class="gsttab"><thead><tr><td>Rate</td><td class="r">Taxable</td><td class="r">CGST</td><td class="r">SGST</td></tr></thead>
  <tbody>${gstRows}</tbody></table>
  <hr/>
  <div class="foot">${escapeHtml(settings.footer || '')}</div>
</body></html>`
  }

  async function buildUpiQr(amount: number, note: string) {
    if (settings.upiQrImage) {
      setQrAmount(amount)
      setQrDataUrl(settings.upiQrImage)
      return
    }
    if (!settings.upiId) {
      notify('Upload your UPI QR or set your UPI ID in Settings.')
      return
    }
    const url = `upi://pay?pa=${encodeURIComponent(settings.upiId)}&pn=${encodeURIComponent(
      settings.shopName,
    )}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`
    try {
      setQrDataUrl(await QRCode.toDataURL(url, { width: 240, margin: 1 }))
      setQrAmount(amount)
    } catch (err) {
      notify(`Could not create UPI QR: ${errorMessage(err)}`)
    }
  }

  async function checkout(print = false) {
    // Ignore double-clicks / repeated shortcut presses while saving.
    if (savingRef.current) return
    if (cart.length === 0) {
      notify('Cart is empty.')
      return
    }
    savingRef.current = true
    setSaving(true)
    try {
      const invoice = {
        customerName: bill.customerName,
        customerPhone: bill.customerPhone,
        subtotal,
        tax,
        discount: discountAmount,
        total,
        paymentMode: bill.paymentMode,
        biller: currentBiller,
        tendered: bill.paymentMode === 'Cash' ? bill.tendered || 0 : 0,
        change:
          bill.paymentMode === 'Cash' && (bill.tendered || 0) > total
            ? (bill.tendered || 0) - total
            : 0,
        items: cart.map((i) => ({
          code: i.code,
          name: i.name,
          price: i.price,
          qty: i.qty,
          taxPercent: i.taxPercent,
          lineTotal: i.price * i.qty,
        })),
      }
      const result = await window.api.createInvoice(invoice)
      const receipt = print ? receiptHtml(result.number) : ''
      notify(`Invoice ${result.number} saved • ${money(cur, total)}`)
      onUpdate({
        cart: [],
        discountInput: 0,
        customerName: '',
        customerPhone: '',
        tendered: 0,
      })
      refreshProducts()
      if (print) void printDocument(receipt, settings.printer, notify)
      if (bill.paymentMode === 'UPI' && (settings.upiId || settings.upiQrImage)) {
        await buildUpiQr(total, result.number)
      }
    } catch (err) {
      // The cart is kept so nothing is lost; the biller can retry.
      notify(`Could not save invoice: ${errorMessage(err)}`)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  function selectCustomer(c: Customer) {
    onUpdate({ customerName: c.name, customerPhone: c.phone ?? '' })
    setCustOpen(false)
  }

  const itemCount = cart.reduce((s, i) => s + i.qty, 0)

  // Customizable keyboard shortcuts (configured in Settings).
  const shortcuts = useMemo(
    () => parseShortcuts(settings.shortcuts),
    [settings.shortcuts],
  )
  const actionsRef = useRef<Record<string, () => void>>({})
  actionsRef.current = {
    newBill: onNew,
    quickAdd: () => openQuickAdd(),
    focusSearch: () => searchRef.current?.focus(),
    saveInvoice: () => checkout(false),
    savePrint: () => checkout(true),
    showQr: () => buildUpiQr(total, 'Bill payment'),
    toggleScanner: () => setShowScanner((s) => !s),
  }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const combo = keyCombo(e)
      if (!combo) return
      const match = Object.entries(shortcuts).find(([, k]) => k === combo)
      if (!match) return
      const target = e.target as HTMLElement | null
      const typing = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
      const safe = /^F\d+$/.test(combo) || e.ctrlKey || e.altKey
      if (typing && !safe) return
      e.preventDefault()
      actionsRef.current[match[0]]?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcuts])

  return (
    <>
      <header className="topbar">
        <div>
          <h1>New Bill <PlanBadge /></h1>
          <div className="sub">
            {itemCount} item{itemCount === 1 ? '' : 's'} • {money(cur, total)}
          </div>
        </div>
        <div className="topbar-actions">
          <span
            className={`hw-chip ${scannerState}`}
            title={
              scannerName
                ? `Scanner: ${scannerName}`
                : scannerActive
                  ? 'Scanner connected and working'
                  : 'No scanner detected — scan an item to confirm it is connected'
            }
          >
            <span className="hw-dot" />{' '}
            {scanFlash
              ? 'Scanned!'
              : scannerName || (scannerActive ? 'Scanner ready' : 'No scanner')}
          </span>
          <label
            className={`hw-chip printer-pick ${printerState}`}
            title={
              !settings.printer
                ? 'Print dialog opens each time — choose a printer to print directly'
                : selectedPrinter
                  ? `Printing to ${settings.printer}`
                  : `${settings.printer} is not connected`
            }
          >
            <Icon name="printer" size={14} />
            <select
              value={settings.printer}
              onMouseDown={loadPrinters}
              onFocus={loadPrinters}
              onChange={(e) => {
                onSelectPrinter(e.target.value)
                // Blur so a barcode scan can't change the selection by typing.
                e.target.blur()
              }}
            >
              <option value="">Ask every time</option>
              {settings.printer && !selectedPrinter && (
                <option value={settings.printer}>{settings.printer} (not connected)</option>
              )}
              {printers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                  {p.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <select
            value={currentBiller}
            onChange={(e) => {
              onSelectBiller(e.target.value)
              e.target.blur()
            }}
            style={{ width: 'auto' }}
            title="Biller"
          >
            <option value="">Select biller…</option>
            {billers.map((b) => (
              <option key={b.id} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => setShowScanner((s) => !s)}>
            {showScanner ? (
              <>
                <Icon name="x" size={15} /> Close Scanner
              </>
            ) : (
              <>
                <Icon name="camera" size={15} /> Scan
              </>
            )}
          </button>
          <button className="btn" onClick={() => onUpdate({ cart: [], discountInput: 0 })}>
            Clear
          </button>
        </div>
      </header>

      <div className="content">
        <div className="bill-tabs">
          {bills.map((b, idx) => {
            const count = b.cart.reduce((s, i) => s + i.qty, 0)
            return (
              <button
                key={b.id}
                className={`bill-tab ${b.id === activeBillId ? 'active' : ''}`}
                onClick={() => onSwitch(b.id)}
              >
                Bill {idx + 1}{' '}
                {count > 0 && <span className="tab-count">{count}</span>}
                <span
                  className="close"
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(b.id)
                  }}
                  title="Close bill"
                >
                  ✕
                </span>
              </button>
            )
          })}
          <button className="tab-add" onClick={onNew}>
            + Hold / New Bill
          </button>
        </div>

        <div className="bill-split">
          <div className="stack">
            {showScanner && (
              <ErrorBoundary
                fallbackTitle="Camera unavailable"
                onReset={() => setShowScanner(false)}
              >
                <Scanner onScan={addByCode} />
              </ErrorBoundary>
            )}

            <div className="panel">
              <div className="panel-head">
                <h2>
                  Bill Items{' '}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    ({itemCount})
                  </span>
                </h2>
                <button className="btn" onClick={() => openQuickAdd()}>
                  <Icon name="plus" size={15} /> Quick Add
                </button>
              </div>
              <div className="panel-body">
                <div className="combo" style={{ marginBottom: 12 }}>
                  <input
                    ref={searchRef}
                    placeholder="Scan barcode or type to add an item…"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value)
                      setSearchOpen(true)
                      setHighlight(0)
                    }}
                    onFocus={() => setSearchOpen(true)}
                    onBlur={() => setSearchOpen(false)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        setSearchOpen(true)
                        setHighlight((h) =>
                          Math.min(h + 1, Math.max(searchResults.length - 1, 0)),
                        )
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        setHighlight((h) => Math.max(h - 1, 0))
                      } else if (e.key === 'Enter') {
                        e.preventDefault()
                        const exact = products.find((p) => p.code === search.trim())
                        const sel = exact ?? searchResults[highlight]
                        if (sel) addProduct(sel.code)
                        else if (search.trim()) {
                          openQuickAdd({ name: search })
                          setSearchOpen(false)
                        }
                      } else if (e.key === 'Escape') {
                        setSearchOpen(false)
                      }
                    }}
                  />
                  {searchOpen && search.trim() && (
                    <div className="menu combo-menu">
                      {searchResults.map((p, idx) => (
                        <button
                          key={p.code}
                          type="button"
                          className={`menu-item ${idx === highlight ? 'active' : ''}`}
                          style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}
                          onMouseEnter={() => setHighlight(idx)}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            addProduct(p.code)
                          }}
                        >
                          <span>{p.name}</span>
                          <span className="muted">{money(cur, p.price)}</span>
                        </button>
                      ))}
                      {searchResults.length === 0 && (
                        <button
                          type="button"
                          className="menu-item"
                          onMouseDown={(e) => {
                            e.preventDefault()
                            openQuickAdd({ name: search })
                            setSearchOpen(false)
                          }}
                        >
                          Add “{search}” as new item
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <table className="cart-table compact">
                  <thead>
                    <tr>
                      <th style={{ width: 30 }}>#</th>
                      <th>Item</th>
                      <th style={{ textAlign: 'right' }}>Rate</th>
                      <th style={{ textAlign: 'center' }}>Qty</th>
                      <th style={{ textAlign: 'right' }}>Amount</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {cart.map((i, idx) => (
                      <tr key={i.code}>
                        <td className="muted">{idx + 1}</td>
                        <td>{i.name}</td>
                        <td style={{ textAlign: 'right' }}>{money(cur, i.price)}</td>
                        <td style={{ textAlign: 'center' }}>
                          <div className="qty-control">
                            <button onClick={() => changeQty(i.code, -1)}>−</button>
                            <span>{i.qty}</span>
                            <button onClick={() => changeQty(i.code, 1)}>+</button>
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {money(cur, i.price * i.qty)}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="icon-btn"
                            onClick={() => removeItem(i.code)}
                            title="Remove"
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {cart.length === 0 && (
                  <div className="cart-empty">
                    Scan a barcode or search above to add items.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="panel bill-details">
            <div className="panel-head">
              <h2>Bill {Math.max(0, bills.findIndex((b) => b.id === activeBillId)) + 1}</h2>
              <span className="muted">{money(cur, total)}</span>
            </div>
            <div className="panel-body">
              <div className="field-grid">
                <div className="field">
                  <label>Customer</label>
                  <div className="combo">
                    <input
                      value={bill.customerName}
                      onChange={(e) => {
                        onUpdate({ customerName: e.target.value })
                        setCustOpen(true)
                        setCustHi(0)
                      }}
                      onFocus={() => setCustOpen(true)}
                      onBlur={() => setCustOpen(false)}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault()
                          setCustOpen(true)
                          setCustHi((h) =>
                            Math.min(h + 1, Math.max(custSuggestions.length - 1, 0)),
                          )
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault()
                          setCustHi((h) => Math.max(h - 1, 0))
                        } else if (e.key === 'Enter') {
                          const c = custSuggestions[custHi]
                          if (custOpen && c) {
                            e.preventDefault()
                            selectCustomer(c)
                          }
                        } else if (e.key === 'Escape') {
                          setCustOpen(false)
                        }
                      }}
                      placeholder="Walk-in customer"
                    />
                    {custOpen && custSuggestions.length > 0 && (
                      <div className="menu combo-menu">
                        {custSuggestions.map((c, idx) => (
                          <button
                            key={c.id}
                            type="button"
                            className={`menu-item ${idx === custHi ? 'active' : ''}`}
                            style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}
                            onMouseEnter={() => setCustHi(idx)}
                            onMouseDown={(e) => {
                              e.preventDefault()
                              selectCustomer(c)
                            }}
                          >
                            <span>{c.name}</span>
                            <span className="muted">{c.phone}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="field">
                  <label>Phone</label>
                  <input
                    value={bill.customerPhone}
                    onChange={(e) => onUpdate({ customerPhone: e.target.value })}
                    placeholder="Optional"
                  />
                </div>
              </div>

              <div className="summary" style={{ marginTop: 4 }}>
                <div className="summary-row">
                  <span>Taxable Value</span>
                  <span>{money(cur, subtotal)}</span>
                </div>
                <div className="summary-row">
                  <span>CGST</span>
                  <span>{money(cur, cgst)}</span>
                </div>
                <div className="summary-row">
                  <span>SGST</span>
                  <span>{money(cur, sgst)}</span>
                </div>
                <div className="summary-row">
                  <span>Discount</span>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span className="segmented">
                      <button
                        className={bill.discountType === 'amount' ? 'active' : ''}
                        onClick={() => onUpdate({ discountType: 'amount' })}
                      >
                        {cur}
                      </button>
                      <button
                        className={bill.discountType === 'percent' ? 'active' : ''}
                        onClick={() => onUpdate({ discountType: 'percent' })}
                      >
                        %
                      </button>
                    </span>
                    <input
                      type="number"
                      min={0}
                      value={bill.discountInput}
                      onChange={(e) =>
                        onUpdate({ discountInput: Number(e.target.value) })
                      }
                      style={{ width: 78 }}
                    />
                  </span>
                </div>
                <div className="summary-row grand">
                  <span>Total</span>
                  <span>{money(cur, total)}</span>
                </div>
              </div>

              <div className="field" style={{ marginTop: 16 }}>
                <label>Payment mode</label>
                <div className="segmented">
                  {PAYMENT_MODES.map((m) => (
                    <button
                      key={m}
                      className={bill.paymentMode === m ? 'active' : ''}
                      onClick={() => onUpdate({ paymentMode: m })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              {bill.paymentMode === 'Cash' && (
                <div className="field" style={{ marginTop: 12 }}>
                  <label>Cash received</label>
                  <input
                    type="number"
                    min={0}
                    value={bill.tendered || ''}
                    onChange={(e) =>
                      onUpdate({ tendered: Number(e.target.value) })
                    }
                    placeholder="Amount given by customer"
                  />
                  {(bill.tendered || 0) > 0 && (
                    <div
                      className="summary-row grand"
                      style={{ marginTop: 8, borderTop: 'none', paddingTop: 0 }}
                    >
                      <span>Balance to return</span>
                      <span>
                        {money(cur, Math.max(0, (bill.tendered || 0) - total))}
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div className="btn-row">
                <button
                  className="btn success block"
                  onClick={() => checkout(false)}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  className="btn primary block"
                  onClick={() => checkout(true)}
                  disabled={saving}
                >
                  <Icon name="printer" size={15} /> Save &amp; Print
                </button>
              </div>
              <button
                className="btn block"
                style={{ marginTop: 10 }}
                onClick={() => buildUpiQr(total, 'Bill payment')}
              >
                Show UPI QR
              </button>
            </div>
          </div>
        </div>
      </div>

      {qrDataUrl && (
        <div className="modal-overlay" onClick={() => setQrDataUrl('')}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Scan to Pay</h3>
            <div className="qr-amount">{money(cur, qrAmount)}</div>
            {qrDataUrl === settings.upiQrImage ? (
              <>
                <img
                  src={qrDataUrl}
                  alt="UPI payment QR"
                  style={{ maxWidth: 260, maxHeight: 300, objectFit: 'contain' }}
                />
                <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>
                  Customer scans and enters the amount shown above.
                </p>
              </>
            ) : (
              <img src={qrDataUrl} alt="UPI payment QR" width={224} height={224} />
            )}
            <p className="muted" style={{ marginTop: 12 }}>
              {settings.upiId}
            </p>
            <button
              className="btn primary block"
              style={{ marginTop: 8 }}
              onClick={() => setQrDataUrl('')}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {quick.open && (
        <div
          className="modal-overlay"
          onClick={() => setQuick((q) => ({ ...q, open: false }))}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ textAlign: 'left', width: 360 }}
          >
            <h3 style={{ marginTop: 0 }}>Quick Add Item</h3>
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              Adds to this bill and saves it to the product list for later.
            </p>
            <div className="field">
              <label>Name</label>
              <input
                autoFocus
                value={quick.name}
                onChange={(e) => setQuick((q) => ({ ...q, name: e.target.value }))}
              />
            </div>
            <div className="field-grid">
              <div className="field">
                <label>Price</label>
                <input
                  type="number"
                  value={quick.price}
                  onChange={(e) =>
                    setQuick((q) => ({ ...q, price: e.target.value }))
                  }
                />
              </div>
              <div className="field">
                <label>Category</label>
                <input
                  value={quick.category}
                  onChange={(e) =>
                    setQuick((q) => ({ ...q, category: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="field">
              <label>Code / barcode (optional)</label>
              <input
                value={quick.code}
                onChange={(e) => setQuick((q) => ({ ...q, code: e.target.value }))}
                placeholder="auto-generated if blank"
              />
            </div>
            <div className="btn-row">
              <button className="btn success block" onClick={saveQuick}>
                Add to Bill
              </button>
              <button
                className="btn"
                onClick={() => setQuick((q) => ({ ...q, open: false }))}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ==================== Products view ====================

interface ProductsViewProps {
  products: Product[]
  settings: Settings
  refresh: () => void
  notify: (msg: string) => void
}

interface ProductForm {
  code: string
  name: string
  category: string
  hsn: string
  price: string
  tax_percent: string
  stock: string
}

const EMPTY_PRODUCT: ProductForm = {
  code: '',
  name: '',
  category: '',
  hsn: '',
  price: '',
  tax_percent: '',
  stock: '',
}

function ProductsView({ products, settings, refresh, notify }: ProductsViewProps) {
  const [form, setForm] = useState<ProductForm>(EMPTY_PRODUCT)
  const [editing, setEditing] = useState(false)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [showScan, setShowScan] = useState(false)
  const [exportMenu, setExportMenu] = useState(false)
  const [catOpen, setCatOpen] = useState(false)
  const [qr, setQr] = useState<{ product: Product; dataUrl: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const cur = settings.currency || '₹'
  const set = (k: keyof ProductForm, v: string) => setForm({ ...form, [k]: v })

  function loadIfExists(code: string): boolean {
    if (!code) return false
    const existing = products.find((p) => p.code === code)
    if (existing) {
      edit(existing)
      notify(`"${existing.name}" already exists — showing its saved details.`)
      return true
    }
    return false
  }

  function captureCode(text: string) {
    const code = codeFromScan(text)
    if (!code) return
    setShowScan(false)
    if (!loadIfExists(code)) {
      setForm((f) => ({ ...f, code }))
      notify(`Barcode captured: ${code}`)
    }
  }

  // Hardware USB barcode scanner fills the code field (when adding a product).
  const captureRef = useRef<(t: string) => void>(() => {})
  captureRef.current = (t) => {
    if (!editing) captureCode(t)
  }
  useEffect(() => {
    const buf = { text: '', start: 0, last: 0 }
    function onKey(e: KeyboardEvent) {
      const now = Date.now()
      if (buf.text === '' || now - buf.last > 120) {
        buf.text = ''
        buf.start = now
      }
      buf.last = now
      if (e.key === 'Enter') {
        const code = buf.text.trim()
        const elapsed = now - buf.start
        buf.text = ''
        if (code.length >= 3 && elapsed < code.length * 60) {
          e.preventDefault()
          captureRef.current(code)
        }
        return
      }
      if (e.key.length === 1) buf.text += e.key
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const categories = useMemo(
    () =>
      Array.from(
        new Set(products.map((p) => (p.category ?? '').trim()).filter(Boolean)),
      ).sort(),
    [products],
  )

  const catSuggestions = useMemo(() => {
    const q = form.category.trim().toLowerCase()
    return q ? categories.filter((c) => c.toLowerCase().includes(q)) : categories
  }, [categories, form.category])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products.filter((p) => {
      const matchesText =
        !q || p.name.toLowerCase().includes(q) || p.code.includes(q)
      const matchesCat = !categoryFilter || (p.category ?? '') === categoryFilter
      return matchesText && matchesCat
    })
  }, [products, search, categoryFilter])

  function edit(p: Product) {
    setForm({
      code: p.code,
      name: p.name,
      category: p.category ?? '',
      hsn: p.hsn ?? '',
      price: String(p.price),
      tax_percent: String(p.tax_percent),
      stock: String(p.stock),
    })
    setEditing(true)
  }

  function reset() {
    setForm(EMPTY_PRODUCT)
    setEditing(false)
  }

  async function save() {
    if (!form.code.trim() || !form.name.trim()) {
      notify('Code and name are required.')
      return
    }
    if (!editing && loadIfExists(form.code.trim())) {
      return
    }
    try {
      await window.api.upsertProduct({
        code: form.code.trim(),
        name: form.name.trim(),
        category: form.category.trim(),
        hsn: form.hsn.trim(),
        price: Number(form.price) || 0,
        tax_percent: Number(form.tax_percent) || 0,
        stock: Number(form.stock) || 0,
      })
      notify(editing ? 'Product updated.' : 'Product added.')
      reset()
      refresh()
    } catch (err) {
      notify(
        'Could not save: ' + (err instanceof Error ? err.message : String(err)),
      )
    }
  }

  async function remove(p: Product) {
    if (!confirm(`Delete "${p.name}"?`)) return
    await window.api.deleteProduct(p.code)
    notify('Product deleted.')
    refresh()
  }

  function exportRows() {
    return products.map((p) => ({
      code: p.code,
      name: p.name,
      category: p.category ?? '',
      hsn: p.hsn ?? '',
      price: p.price,
      tax_percent: p.tax_percent,
      stock: p.stock,
    }))
  }

  async function importFile(file: File) {
    try {
      const text = await file.text()
      let rows: Record<string, unknown>[]
      if (file.name.toLowerCase().endsWith('.json')) {
        const data = JSON.parse(text)
        rows = Array.isArray(data) ? data : (data.products ?? [])
      } else {
        rows = parseCSV(text)
      }
      let count = 0
      for (const r of rows) {
        const code = String(r.code ?? '').trim()
        const name = String(r.name ?? '').trim()
        if (!code || !name) continue
        await window.api.upsertProduct({
          code,
          name,
          category: String(r.category ?? '').trim(),
          hsn: String(r.hsn ?? '').trim(),
          price: Number(r.price) || 0,
          tax_percent: Number(r.tax_percent ?? (r as Record<string, unknown>).tax) || 0,
          stock: Number(r.stock) || 0,
        })
        count++
      }
      refresh()
      notify(`Imported ${count} product(s).`)
    } catch (err) {
      notify('Import failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) importFile(file)
    e.target.value = ''
  }

  async function showQr(p: Product) {
    // Encode code + name + price so labels are self-describing and scannable.
    const payload = JSON.stringify({ code: p.code, name: p.name, price: p.price })
    try {
      const dataUrl = await QRCode.toDataURL(payload, { width: 260, margin: 1 })
      setQr({ product: p, dataUrl })
    } catch (err) {
      notify(`Could not create QR: ${errorMessage(err)}`)
    }
  }

  function printLabel() {
    if (!qr) return
    void printDocument(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(qr.product.name)}</title>
      <style>body{font-family:sans-serif;text-align:center;padding:20px}
      h2{margin:6px 0}.price{font-size:22px;font-weight:800;color:#4f46e5}</style>
      </head><body>
      <h2>${escapeHtml(qr.product.name)}</h2>
      <img src="${qr.dataUrl}" width="240" height="240"/>
      <div class="price">${escapeHtml(money(cur, qr.product.price))}</div>
      <div>Code: ${escapeHtml(qr.product.code)}</div>
      </body></html>`,
      settings.printer,
      notify,
    )
  }

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Products <PlanBadge /></h1>
          <div className="sub">{products.length} items in catalog</div>
        </div>
      </header>

      <div className="content">
        <div className="billing-grid">
          <div className="panel">
            <div className="panel-head">
              <h2>Catalog</h2>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  placeholder="Search…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ maxWidth: 150 }}
                />
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  style={{ width: 'auto' }}
                  title="Filter by category"
                >
                  <option value="">All categories</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <button
                  className="btn"
                  onClick={() => fileInputRef.current?.click()}
                  title="Import products from JSON or Excel/CSV"
                >
                  <Icon name="upload" size={15} /> Import
                </button>
                <div style={{ position: 'relative' }}>
                  <button
                    className="btn"
                    onClick={() => setExportMenu((m) => !m)}
                    title="Export products"
                  >
                    <Icon name="download" size={15} /> Export
                  </button>
                  {exportMenu && (
                    <>
                      <div
                        className="menu-backdrop"
                        onClick={() => setExportMenu(false)}
                      />
                      <div className="menu">
                        <button
                          className="menu-item"
                          onClick={() => {
                            exportExcel(`products-${dateStamp()}.csv`, exportRows())
                            setExportMenu(false)
                          }}
                        >
                          Excel (CSV)
                        </button>
                        <button
                          className="menu-item"
                          onClick={() => {
                            exportJson(`products-${dateStamp()}.json`, exportRows())
                            setExportMenu(false)
                          }}
                        >
                          JSON
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,.csv"
                  style={{ display: 'none' }}
                  onChange={onFilePick}
                />
              </div>
            </div>
            <div className="panel-body">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Category</th>
                    <th>HSN</th>
                    <th style={{ textAlign: 'right' }}>GST%</th>
                    <th style={{ textAlign: 'right' }}>Price</th>
                    <th style={{ textAlign: 'right' }}>Stock</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr key={p.code}>
                      <td>{p.code}</td>
                      <td>{p.name}</td>
                      <td>
                        <span className={`badge cat ${p.category ? '' : 'unknown'}`}>
                          {p.category || 'unknown'}
                        </span>
                      </td>
                      <td>{p.hsn || <span className="muted">—</span>}</td>
                      <td style={{ textAlign: 'right' }}>{p.tax_percent}%</td>
                      <td style={{ textAlign: 'right' }}>{money(cur, p.price)}</td>
                      <td style={{ textAlign: 'right' }}>{p.stock}</td>
                      <td>
                        <div className="table-actions">
                          <button className="link-btn" onClick={() => showQr(p)}>
                            QR
                          </button>
                          <button className="link-btn" onClick={() => edit(p)}>
                            Edit
                          </button>
                          <button
                            className="link-btn danger"
                            onClick={() => remove(p)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={8} className="muted" style={{ textAlign: 'center' }}>
                        No products.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel" style={{ alignSelf: 'start' }}>
            <div className="panel-head">
              <h2>{editing ? 'Edit Product' : 'Add Product'}</h2>
            </div>
            <div className="panel-body">
              {showScan && (
                <ErrorBoundary
                  fallbackTitle="Camera unavailable"
                  onReset={() => setShowScan(false)}
                >
                  <div style={{ marginBottom: 14 }}>
                    <Scanner onScan={captureCode} />
                  </div>
                </ErrorBoundary>
              )}
              <div className="field">
                <label>Product code / barcode</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={form.code}
                    disabled={editing}
                    onChange={(e) => set('code', e.target.value)}
                    onBlur={() => {
                      if (!editing) loadIfExists(form.code.trim())
                    }}
                    placeholder="Scan or type…"
                  />
                  <button
                    className="btn"
                    type="button"
                    disabled={editing}
                    onClick={() => setShowScan((s) => !s)}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {showScan ? (
                      <Icon name="x" size={15} />
                    ) : (
                      <>
                        <Icon name="camera" size={15} /> Scan
                      </>
                    )}
                  </button>
                </div>
                <span className="hint">
                  <Icon name="scan" size={13} /> A USB barcode scanner fills this
                  automatically — just scan.
                </span>
              </div>
              <div className="field">
                <label>Name</label>
                <input value={form.name} onChange={(e) => set('name', e.target.value)} />
              </div>
              <div className="field-grid">
                <div className="field">
                  <label>Category</label>
                  <div className="combo">
                    <input
                      value={form.category}
                      onChange={(e) => {
                        set('category', e.target.value)
                        setCatOpen(true)
                      }}
                      onFocus={() => setCatOpen(true)}
                      onBlur={() => setCatOpen(false)}
                      placeholder="Type or choose…"
                    />
                    {catOpen && catSuggestions.length > 0 && (
                      <div className="menu combo-menu">
                        {catSuggestions.map((c) => (
                          <button
                            key={c}
                            type="button"
                            className="menu-item"
                            onMouseDown={(e) => {
                              e.preventDefault()
                              set('category', c)
                              setCatOpen(false)
                            }}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="field">
                  <label>HSN / SAC code</label>
                  <input
                    value={form.hsn}
                    onChange={(e) => set('hsn', e.target.value)}
                    placeholder="e.g. 2106"
                  />
                </div>
              </div>
              <div className="field-grid">
                <div className="field">
                  <label>Price</label>
                  <input
                    type="number"
                    value={form.price}
                    onChange={(e) => set('price', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>GST %</label>
                  <input
                    list="gst-slabs"
                    type="number"
                    value={form.tax_percent}
                    onChange={(e) => set('tax_percent', e.target.value)}
                  />
                  <datalist id="gst-slabs">
                    {GST_SLABS.map((g) => (
                      <option key={g} value={g} />
                    ))}
                  </datalist>
                </div>
              </div>
              <div className="field">
                <label>Stock</label>
                <input
                  type="number"
                  value={form.stock}
                  onChange={(e) => set('stock', e.target.value)}
                />
              </div>
              <div className="form-actions">
                <button className="btn primary" onClick={save}>
                  {editing ? 'Update' : 'Add'} Product
                </button>
                {editing && (
                  <button className="btn" onClick={reset}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {qr && (
        <div className="modal-overlay" onClick={() => setQr(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{qr.product.name}</h3>
            <div className="qr-amount">{money(cur, qr.product.price)}</div>
            <img src={qr.dataUrl} alt="Product QR" width={240} height={240} />
            <p className="muted" style={{ marginTop: 10 }}>
              Code: {qr.product.code}
            </p>
            <div className="btn-row">
              <a
                className="btn block"
                href={qr.dataUrl}
                download={`${qr.product.code}.png`}
                style={{ textAlign: 'center', textDecoration: 'none' }}
              >
                Download
              </a>
              <button className="btn primary block" onClick={printLabel}>
                Print Label
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ==================== Customers view ====================

interface CustomersViewProps {
  customers: Customer[]
  refresh: () => void
  notify: (msg: string) => void
}

interface CustomerForm {
  id?: number
  name: string
  phone: string
  email: string
  note: string
}

const EMPTY_CUSTOMER: CustomerForm = { name: '', phone: '', email: '', note: '' }

function CustomersView({ customers, refresh, notify }: CustomersViewProps) {
  const [form, setForm] = useState<CustomerForm>(EMPTY_CUSTOMER)
  const [search, setSearch] = useState('')
  const [exportMenu, setExportMenu] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const set = (k: keyof CustomerForm, v: string) => setForm({ ...form, [k]: v })
  const editing = form.id !== undefined

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return customers
    return customers.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.phone ?? '').includes(q),
    )
  }, [customers, search])

  function edit(c: Customer) {
    setForm({ id: c.id, name: c.name, phone: c.phone ?? '', email: c.email ?? '', note: c.note ?? '' })
  }

  function reset() {
    setForm(EMPTY_CUSTOMER)
  }

  async function save() {
    if (!form.name.trim()) {
      notify('Customer name is required.')
      return
    }
    await window.api.upsertCustomer({
      id: form.id,
      name: form.name.trim(),
      phone: form.phone.trim(),
      email: form.email.trim(),
      note: form.note.trim(),
    })
    notify(editing ? 'Customer updated.' : 'Customer added.')
    reset()
    refresh()
  }

  async function remove(c: Customer) {
    if (!confirm(`Delete "${c.name}"?`)) return
    await window.api.deleteCustomer(c.id)
    notify('Customer deleted.')
    refresh()
  }

  function exportRows() {
    return customers.map((c) => ({
      name: c.name,
      phone: c.phone,
      email: c.email,
      note: c.note,
    }))
  }

  async function importFile(file: File) {
    try {
      const text = await file.text()
      let rows: Record<string, unknown>[]
      if (file.name.toLowerCase().endsWith('.json')) {
        const data = JSON.parse(text)
        rows = Array.isArray(data) ? data : (data.customers ?? [])
      } else {
        rows = parseCSV(text)
      }
      let count = 0
      for (const r of rows) {
        const name = String(r.name ?? '').trim()
        if (!name) continue
        const phone = String(r.phone ?? '').trim()
        // Update an existing customer matched by phone or name, else insert.
        const match = customers.find(
          (c) => (phone && c.phone === phone) || c.name === name,
        )
        await window.api.upsertCustomer({
          id: match?.id,
          name,
          phone,
          email: String(r.email ?? '').trim(),
          note: String(r.note ?? '').trim(),
        })
        count++
      }
      refresh()
      notify(`Imported ${count} customer(s).`)
    } catch (err) {
      notify('Import failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) importFile(file)
    e.target.value = ''
  }

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Customers <PlanBadge /></h1>
          <div className="sub">{customers.length} saved</div>
        </div>
      </header>

      <div className="content">
        <div className="billing-grid">
          <div className="panel">
            <div className="panel-head">
              <h2>Customer List</h2>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  placeholder="Search…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ maxWidth: 150 }}
                />
                <button
                  className="btn"
                  onClick={() => fileInputRef.current?.click()}
                  title="Import customers from JSON or Excel/CSV"
                >
                  <Icon name="upload" size={15} /> Import
                </button>
                <div style={{ position: 'relative' }}>
                  <button
                    className="btn"
                    onClick={() => setExportMenu((m) => !m)}
                    title="Export customers"
                  >
                    <Icon name="download" size={15} /> Export
                  </button>
                  {exportMenu && (
                    <>
                      <div
                        className="menu-backdrop"
                        onClick={() => setExportMenu(false)}
                      />
                      <div className="menu">
                        <button
                          className="menu-item"
                          onClick={() => {
                            exportExcel(
                              `customers-${dateStamp()}.csv`,
                              exportRows(),
                            )
                            setExportMenu(false)
                          }}
                        >
                          Excel (CSV)
                        </button>
                        <button
                          className="menu-item"
                          onClick={() => {
                            exportJson(
                              `customers-${dateStamp()}.json`,
                              exportRows(),
                            )
                            setExportMenu(false)
                          }}
                        >
                          JSON
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,.csv"
                  style={{ display: 'none' }}
                  onChange={onFilePick}
                />
              </div>
            </div>
            <div className="panel-body">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Phone</th>
                    <th>Email</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>{c.phone}</td>
                      <td>{c.email}</td>
                      <td>
                        <div className="table-actions">
                          <button className="link-btn" onClick={() => edit(c)}>
                            Edit
                          </button>
                          <button className="link-btn danger" onClick={() => remove(c)}>
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={4} className="muted" style={{ textAlign: 'center' }}>
                        No customers.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel" style={{ alignSelf: 'start' }}>
            <div className="panel-head">
              <h2>{editing ? 'Edit Customer' : 'Add Customer'}</h2>
            </div>
            <div className="panel-body">
              <div className="field">
                <label>Name</label>
                <input value={form.name} onChange={(e) => set('name', e.target.value)} />
              </div>
              <div className="field">
                <label>Phone</label>
                <input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
              </div>
              <div className="field">
                <label>Email</label>
                <input value={form.email} onChange={(e) => set('email', e.target.value)} />
              </div>
              <div className="field">
                <label>Note</label>
                <input value={form.note} onChange={(e) => set('note', e.target.value)} />
              </div>
              <div className="form-actions">
                <button className="btn primary" onClick={save}>
                  {editing ? 'Update' : 'Add'} Customer
                </button>
                {editing && (
                  <button className="btn" onClick={reset}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ==================== Reports view ====================

type Period = 'day' | 'week' | 'month' | 'year' | 'all'

const PERIODS: { id: Period; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'all', label: 'All' },
]

interface Range {
  from: Date | null
  to: Date | null
  label: string
}

/** Local-time range for the current period, shifted by `offset` periods (negative = past). */
function periodRange(period: Period, offset: number): Range {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  switch (period) {
    case 'day': {
      const from = new Date(y, m, d + offset)
      const label = from.toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
      return {
        from,
        to: new Date(y, m, d + offset + 1),
        label: offset === 0 ? `Today, ${label}` : label,
      }
    }
    case 'week': {
      const monday = d - ((now.getDay() + 6) % 7) + offset * 7
      const from = new Date(y, m, monday)
      const last = new Date(y, m, monday + 6)
      const short = { day: 'numeric', month: 'short' } as const
      return {
        from,
        to: new Date(y, m, monday + 7),
        label: `${from.toLocaleDateString(undefined, short)} – ${last.toLocaleDateString(undefined, { ...short, year: 'numeric' })}`,
      }
    }
    case 'month': {
      const from = new Date(y, m + offset, 1)
      return {
        from,
        to: new Date(y, m + offset + 1, 1),
        label: from.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      }
    }
    case 'year':
      return {
        from: new Date(y + offset, 0, 1),
        to: new Date(y + offset + 1, 0, 1),
        label: String(y + offset),
      }
    default:
      return { from: null, to: null, label: 'All time' }
  }
}

interface Bucket {
  start: Date
  label: string
  title: string
  value: number
}

/** Hourly buckets for a day, daily for a week/month, monthly for a year or all time. */
function trendBuckets(period: Period, range: Range, invoices: ReportInvoice[]): Bucket[] {
  const buckets: Bucket[] = []
  if (period === 'day' && range.from) {
    const f = range.from
    for (let h = 0; h < 24; h++) {
      buckets.push({
        start: new Date(f.getFullYear(), f.getMonth(), f.getDate(), h),
        label: String(h),
        title: `${h}:00 – ${h + 1}:00`,
        value: 0,
      })
    }
  } else if ((period === 'week' || period === 'month') && range.from && range.to) {
    for (
      let day = range.from;
      day < range.to;
      day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
    ) {
      buckets.push({
        start: day,
        label:
          period === 'week'
            ? day.toLocaleDateString(undefined, { weekday: 'short' })
            : String(day.getDate()),
        title: day.toLocaleDateString(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        }),
        value: 0,
      })
    }
  } else {
    if (!range.from && !invoices.length) return []
    const now = new Date()
    // Invoices arrive newest first, so the last one is the earliest.
    const earliest = new Date(invoices[invoices.length - 1]?.created_at ?? now)
    const start = range.from ?? new Date(earliest.getFullYear(), earliest.getMonth(), 1)
    const end = range.to ?? new Date(now.getFullYear(), now.getMonth() + 1, 1)
    for (let mo = start; mo < end; mo = new Date(mo.getFullYear(), mo.getMonth() + 1, 1)) {
      buckets.push({
        start: mo,
        label: mo.toLocaleDateString(
          undefined,
          period === 'year' ? { month: 'short' } : { month: 'short', year: '2-digit' },
        ),
        title: mo.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        value: 0,
      })
    }
  }
  for (const inv of invoices) {
    const t = new Date(inv.created_at)
    if (range.to && t >= range.to) continue
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (buckets[i].start <= t) {
        buckets[i].value += inv.amount
        break
      }
    }
  }
  return buckets
}

function BarChart({ data, format }: { data: Bucket[]; format: (n: number) => string }) {
  const max = Math.max(0, ...data.map((b) => b.value))
  const labelEvery = Math.ceil(data.length / 16)
  return (
    <div className="bar-chart">
      {data.map((b, i) => (
        <div key={i} className="bar-col" title={`${b.title}: ${format(b.value)}`}>
          <div className="bar-track">
            <div
              className="bar"
              style={{
                height: b.value > 0 ? `max(2px, ${(b.value / max) * 100}%)` : 0,
              }}
            />
          </div>
          <span className="bar-label">{i % labelEvery === 0 ? b.label : ''}</span>
        </div>
      ))}
    </div>
  )
}

const DONUT_COLORS = ['#4f46e5', '#059669', '#ea580c', '#0891b2', '#e11d48', '#d97706']

function Donut({
  data,
  centerLabel,
  centerValue,
  size = 190,
  thickness = 30,
}: {
  data: { label: string; value: number }[]
  centerLabel: string
  centerValue: string
  size?: number
  thickness?: number
}) {
  const total = data.reduce((s, d) => s + d.value, 0)
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  let acc = 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {total > 0 ? (
          data.map((d, i) => {
            const frac = d.value / total
            const seg = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
                strokeWidth={thickness}
                strokeDasharray={`${frac * c} ${c}`}
                strokeDashoffset={-acc * c}
              />
            )
            acc += frac
            return seg
          })
        ) : (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--border)"
            strokeWidth={thickness}
          />
        )}
      </g>
      <text x="50%" y="45%" textAnchor="middle" fontSize="12" fill="var(--muted)">
        {centerLabel}
      </text>
      <text
        x="50%"
        y="60%"
        textAnchor="middle"
        fontSize="18"
        fontWeight="800"
        fill="var(--text)"
      >
        {centerValue}
      </text>
    </svg>
  )
}

interface ReportsViewProps {
  settings: Settings
}

function ReportsView({ settings }: ReportsViewProps) {
  const [period, setPeriod] = useState<Period>('month')
  const [offset, setOffset] = useState(0)
  const [product, setProduct] = useState<{ key: string; name: string } | null>(null)
  const [data, setData] = useState<ReportData>({ invoices: [], products: [] })
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const cur = settings.currency || '₹'

  const range = useMemo(() => periodRange(period, offset), [period, offset])

  useEffect(() => {
    window.api.listInvoices().then(setInvoices)
    window.api.listProducts().then(setProducts)
    window.api.listCustomers().then(setCustomers)
  }, [])

  useEffect(() => {
    let stale = false
    window.api
      .reportData({
        from: range.from?.toISOString() ?? null,
        to: range.to?.toISOString() ?? null,
        product: product?.key ?? null,
      })
      .then((d) => {
        if (!stale) setData(d)
      })
    return () => {
      stale = true
    }
  }, [range, product])

  const rows = data.invoices
  const sales = rows.reduce((s, r) => s + r.amount, 0)
  const qtySold = rows.reduce((s, r) => s + r.qty, 0)
  const allProductsRevenue = data.products.reduce((s, p) => s + p.revenue, 0)

  const byPayment = useMemo(() => {
    const totals = new Map<string, number>()
    for (const r of rows) {
      const mode = r.payment_mode || '—'
      totals.set(mode, (totals.get(mode) ?? 0) + r.amount)
    }
    return [...totals]
      .map(([mode, total]) => ({ mode, total }))
      .sort((a, b) => b.total - a.total)
  }, [rows])

  const trend = useMemo(() => trendBuckets(period, range, rows), [period, range, rows])

  const stats = product
    ? [
        { label: 'Product Revenue', value: money(cur, sales) },
        { label: 'Qty Sold', value: qtySold },
        { label: 'Bills', value: rows.length },
        {
          label: 'Share of Sales',
          value: `${allProductsRevenue ? Math.round((sales / allProductsRevenue) * 100) : 0}%`,
        },
      ]
    : [
        { label: 'Total Sales', value: money(cur, sales) },
        { label: 'Invoices', value: rows.length },
        { label: 'Avg Bill Value', value: money(cur, rows.length ? sales / rows.length : 0) },
        { label: 'Items Sold', value: qtySold },
      ]

  function choosePeriod(p: Period) {
    setPeriod(p)
    setOffset(0)
  }

  function toggleProduct(p: ReportProduct) {
    setProduct((prev) => (prev?.key === p.key ? null : { key: p.key, name: p.name }))
  }

  const datasets = [
    { name: 'Invoices', file: 'invoices', rows: invoices },
    { name: 'Products', file: 'products', rows: products },
    { name: 'Customers', file: 'customers', rows: customers },
  ]

  function fullBackup() {
    exportJson(`billing-backup-${dateStamp()}.json`, {
      exportedAt: new Date().toISOString(),
      shop: settings.shopName,
      products,
      customers,
      invoices,
    })
  }

  const right = { textAlign: 'right' } as const

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Reports <PlanBadge /></h1>
          <div className="sub">
            {range.label}
            {product ? ` • ${product.name}` : ''}
          </div>
        </div>
        <div className="topbar-actions">
          <div className="segmented">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                className={period === p.id ? 'active' : ''}
                onClick={() => choosePeriod(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="content">
        <div className="report-toolbar">
          {period !== 'all' ? (
            <div className="period-nav">
              <button
                className="btn"
                onClick={() => setOffset((o) => o - 1)}
                aria-label="Previous period"
              >
                ‹
              </button>
              <strong>{range.label}</strong>
              <button
                className="btn"
                onClick={() => setOffset((o) => o + 1)}
                disabled={offset >= 0}
                aria-label="Next period"
              >
                ›
              </button>
              {offset !== 0 && (
                <button className="link-btn" onClick={() => setOffset(0)}>
                  Current
                </button>
              )}
            </div>
          ) : (
            <strong>All time</strong>
          )}
          {product ? (
            <span className="filter-chip">
              Product: {product.name}
              <button onClick={() => setProduct(null)} aria-label="Clear product filter">
                ✕
              </button>
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 13 }}>
              Click a product below to filter the report
            </span>
          )}
        </div>

        <div className="stat-grid">
          {stats.map((s) => (
            <div key={s.label} className="stat-card">
              <div className="stat-label">{s.label}</div>
              <div className="stat-value">{s.value}</div>
            </div>
          ))}
        </div>

        <div className="panel" style={{ marginBottom: 18 }}>
          <div className="panel-head">
            <h2>{product ? `${product.name} — Sales Trend` : 'Sales Trend'}</h2>
            <span className="muted" style={{ fontSize: 12 }}>
              by {period === 'day' ? 'hour' : period === 'year' || period === 'all' ? 'month' : 'day'}
            </span>
          </div>
          <div className="panel-body">
            {rows.length ? (
              <BarChart data={trend} format={(n) => money(cur, n)} />
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                No sales in this period.
              </p>
            )}
          </div>
        </div>

        <div className="billing-grid">
          <div className="panel">
            <div className="panel-head">
              <h2>Products Sold</h2>
              <span className="muted" style={{ fontSize: 12 }}>
                Click to filter
              </span>
            </div>
            <div className="panel-body scroll-list">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th style={right}>Qty Sold</th>
                    <th style={right}>Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((p) => (
                    <tr
                      key={p.key}
                      className={`clickable${product?.key === p.key ? ' selected' : ''}`}
                      onClick={() => toggleProduct(p)}
                    >
                      <td>{p.name}</td>
                      <td style={right}>{p.qty}</td>
                      <td style={right}>{money(cur, p.revenue)}</td>
                    </tr>
                  ))}
                  {!data.products.length && (
                    <tr>
                      <td colSpan={3} className="muted" style={{ textAlign: 'center' }}>
                        No sales in this period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel" style={{ alignSelf: 'start' }}>
            <div className="panel-head">
              <h2>Sales by Payment Mode</h2>
            </div>
            <div className="panel-body" style={{ textAlign: 'center' }}>
              <Donut
                data={byPayment.map((p) => ({ label: p.mode, value: p.total }))}
                centerLabel="Total"
                centerValue={money(cur, sales)}
              />
              <div style={{ marginTop: 12, textAlign: 'left' }}>
                {byPayment.map((p, i) => {
                  const pct = sales ? Math.round((p.total / sales) * 100) : 0
                  return (
                    <div
                      key={p.mode}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '6px 0',
                      }}
                    >
                      <span
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: 3,
                          background: DONUT_COLORS[i % DONUT_COLORS.length],
                        }}
                      />
                      <span style={{ flex: 1 }}>{p.mode}</span>
                      <span className="muted">{pct}%</span>
                      <strong>{money(cur, p.total)}</strong>
                    </div>
                  )
                })}
                {!byPayment.length && <p className="muted">No sales in this period.</p>}
              </div>
            </div>
          </div>
        </div>

        <div className="panel" style={{ marginTop: 18 }}>
          <div className="panel-head">
            <h2>{product ? `Invoices with ${product.name}` : 'Invoices'}</h2>
            <span className="muted" style={{ fontSize: 12 }}>
              {rows.length > 50 ? `Latest 50 of ${rows.length}` : `${rows.length} total`}
            </span>
          </div>
          <div className="panel-body">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Payment</th>
                  <th style={right}>{product ? 'Qty' : 'Items'}</th>
                  {product && <th style={right}>Product Amt</th>}
                  <th style={right}>Bill Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 50).map((inv) => (
                  <tr key={inv.id}>
                    <td>{inv.number}</td>
                    <td>{new Date(inv.created_at).toLocaleString()}</td>
                    <td>{inv.customer_name || '—'}</td>
                    <td>{inv.payment_mode || '—'}</td>
                    <td style={right}>{inv.qty}</td>
                    {product && <td style={right}>{money(cur, inv.amount)}</td>}
                    <td style={right}>{money(cur, inv.total)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={product ? 7 : 6}
                      className="muted"
                      style={{ textAlign: 'center' }}
                    >
                      No invoices in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel" style={{ marginTop: 18 }}>
          <div className="panel-head">
            <h2>Export Data</h2>
          </div>
          <div className="panel-body">
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              Excel (CSV) is for reading; JSON is for backup and re-importing into
              the app.
            </p>
            <table className="data-table">
              <tbody>
                {datasets.map((d) => (
                  <tr key={d.file}>
                    <td>
                      {d.name}
                      <span className="muted"> — {d.rows.length} rows</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="table-actions" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="link-btn"
                          onClick={() =>
                            exportExcel(
                              `${d.file}-${dateStamp()}.csv`,
                              d.rows as unknown as Record<string, unknown>[],
                            )
                          }
                        >
                          Excel
                        </button>
                        <button
                          className="link-btn"
                          onClick={() =>
                            exportJson(`${d.file}-${dateStamp()}.json`, d.rows)
                          }
                        >
                          JSON
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn primary" style={{ marginTop: 12 }} onClick={fullBackup}>
              Download Full Backup (JSON)
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ==================== Settings view ====================

const THEMES = [
  { id: 'light', label: 'Light', color: '#4f46e5' },
  { id: 'dark', label: 'Dark', color: '#111827' },
  { id: 'ocean', label: 'Ocean', color: '#0891b2' },
  { id: 'forest', label: 'Forest', color: '#059669' },
  { id: 'sunset', label: 'Sunset', color: '#ea580c' },
]

interface SettingsViewProps {
  settings: Settings
  setSettings: (s: Settings) => void
  onSave: () => void
  billers: Biller[]
  refreshBillers: () => void
  notify: (msg: string) => void
}

function SettingsView({
  settings,
  setSettings,
  onSave,
  billers,
  refreshBillers,
  notify,
}: SettingsViewProps) {
  const set = (k: keyof Settings, v: string) =>
    setSettings({ ...settings, [k]: v })
  const [newBiller, setNewBiller] = useState('')
  const shortcuts = parseShortcuts(settings.shortcuts)
  const { license, setLicense } = useContext(LicenseContext)
  const qrInput = useRef<HTMLInputElement>(null)

  function onQrUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      notify('Choose an image file (PNG or JPG).')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      notify('Image is too large (max 5 MB).')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        // Downscale big phone screenshots so the saved setting stays small.
        const scale = Math.min(1, 800 / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
        set('upiQrImage', canvas.toDataURL('image/png'))
        notify('UPI QR loaded — click Save Settings to keep it.')
      }
      img.onerror = () => notify('Could not read that image.')
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  }

  function setShortcut(id: string, combo: string) {
    set('shortcuts', JSON.stringify({ ...shortcuts, [id]: combo }))
  }

  async function addBiller() {
    const name = newBiller.trim()
    if (!name) {
      notify('Enter a biller name.')
      return
    }
    await window.api.addBiller(name)
    setNewBiller('')
    refreshBillers()
    notify('Biller added.')
  }

  async function removeBiller(id: number) {
    await window.api.deleteBiller(id)
    refreshBillers()
    notify('Biller removed.')
  }

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Settings <PlanBadge /></h1>
          <div className="sub">Shop profile &amp; payment configuration</div>
        </div>
      </header>

      <div className="content">
        <div className="settings-masonry">
          <div className="panel">
            <div className="panel-head">
              <h2>Subscription</h2>
              <PlanBadge />
            </div>
            <div className="panel-body">
              <table className="data-table" style={{ marginBottom: 12 }}>
                <tbody>
                  <tr>
                    <td className="muted">Plan</td>
                    <td style={{ textAlign: 'right' }}>
                      <strong>{license?.planLabel ?? '—'}</strong>
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Status</td>
                    <td style={{ textAlign: 'right' }}>
                      {license?.active ? 'Active' : 'Inactive'}
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Expires</td>
                    <td style={{ textAlign: 'right' }}>
                      {formatDate(license?.expiry ?? null)}
                      {license?.daysLeft != null && ` (${license.daysLeft} days left)`}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
                To renew or change plan (Silver → Gold → Diamond), send your Machine ID
                to your vendor and enter the new key here.
              </p>
              <SubscriptionKeyForm
                machineId={license?.machineId ?? ''}
                buttonLabel="Apply new key"
                onActivated={(s) => {
                  setLicense(s)
                  notify(`Subscription updated: ${s.planLabel}`)
                }}
              />
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Shop Profile</h2>
            </div>
            <div className="panel-body">
              <div className="field">
                <label>Shop name</label>
                <input
                  value={settings.shopName}
                  onChange={(e) => set('shopName', e.target.value)}
                />
              </div>
              <div className="field">
                <label>Address</label>
                <input
                  value={settings.address}
                  onChange={(e) => set('address', e.target.value)}
                  placeholder="Street, City, PIN"
                />
              </div>
              <div className="field-grid">
                <div className="field">
                  <label>Phone</label>
                  <input
                    value={settings.phone}
                    onChange={(e) => set('phone', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>GST / Tax ID</label>
                  <input
                    value={settings.gstin}
                    onChange={(e) => set('gstin', e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Payment &amp; Billing</h2>
            </div>
            <div className="panel-body">
              <div className="field">
                <label>
                  UPI ID (VPA){' '}
                  <span className="hint">— used for payment QR codes</span>
                </label>
                <input
                  value={settings.upiId}
                  onChange={(e) => set('upiId', e.target.value)}
                  placeholder="name@bank"
                />
              </div>
              <div className="field">
                <label>
                  UPI QR image{' '}
                  <span className="hint">— your GPay / PhonePe / Paytm shop QR</span>
                </label>
                <div className="upi-qr-upload">
                  {settings.upiQrImage ? (
                    <img src={settings.upiQrImage} alt="UPI QR" />
                  ) : (
                    <div className="upi-qr-empty">No QR uploaded</div>
                  )}
                  <div className="stack" style={{ gap: 8 }}>
                    <button className="btn" onClick={() => qrInput.current?.click()}>
                      <Icon name="upload" size={15} />{' '}
                      {settings.upiQrImage ? 'Change QR' : 'Upload QR'}
                    </button>
                    {settings.upiQrImage && (
                      <button className="link-btn danger" onClick={() => set('upiQrImage', '')}>
                        Remove
                      </button>
                    )}
                  </div>
                  <input
                    ref={qrInput}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={onQrUpload}
                  />
                </div>
                <span className="hint">
                  Shown on &ldquo;Show UPI QR&rdquo; while billing. If empty, a QR is
                  generated from the UPI ID. Click Save Settings after uploading.
                </span>
              </div>
              <div className="field-grid">
                <div className="field">
                  <label>Currency symbol</label>
                  <input
                    value={settings.currency}
                    onChange={(e) => set('currency', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>Default GST %</label>
                  <input
                    type="number"
                    value={settings.defaultTax}
                    onChange={(e) => set('defaultTax', e.target.value)}
                  />
                </div>
              </div>
              <div className="field">
                <label>Price includes GST (MRP)</label>
                <div className="segmented">
                  <button
                    className={settings.gstInclusive !== 'yes' ? 'active' : ''}
                    onClick={() => set('gstInclusive', 'no')}
                  >
                    No — add GST
                  </button>
                  <button
                    className={settings.gstInclusive === 'yes' ? 'active' : ''}
                    onClick={() => set('gstInclusive', 'yes')}
                  >
                    Yes — MRP
                  </button>
                </div>
                <span className="hint">
                  MRP mode treats prices as GST-inclusive and back-calculates the
                  tax.
                </span>
              </div>
              <div className="field">
                <label>Invoice footer note</label>
                <input
                  value={settings.footer}
                  onChange={(e) => set('footer', e.target.value)}
                />
              </div>
              <button className="btn primary" onClick={onSave}>
                Save Settings
              </button>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Appearance</h2>
            </div>
            <div className="panel-body">
              <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
                Choose a theme. Changes apply instantly; click Save Settings to keep
                it.
              </p>
              <div className="theme-grid">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    className={`theme-swatch ${settings.theme === t.id ? 'active' : ''}`}
                    onClick={() => set('theme', t.id)}
                  >
                    <span className="theme-dot" style={{ background: t.color }} />
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Billers / Cashiers</h2>
            </div>
            <div className="panel-body">
              <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
                Staff who operate the billing counter. The selected biller is saved
                with each invoice and printed on the receipt.
              </p>
              <div className="search-row">
                <input
                  placeholder="Add biller name…"
                  value={newBiller}
                  onChange={(e) => setNewBiller(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addBiller()}
                />
                <button className="btn primary" onClick={addBiller}>
                  Add
                </button>
              </div>
              <table className="data-table">
                <tbody>
                  {billers.map((b) => (
                    <tr key={b.id}>
                      <td>{b.name}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="link-btn danger"
                          onClick={() => removeBiller(b.id)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                  {billers.length === 0 && (
                    <tr>
                      <td className="muted">No billers added yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Keyboard Shortcuts</h2>
            </div>
            <div className="panel-body">
              <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
                Click a box and press the key(s) to rebind. Remember to Save
                Settings.
              </p>
              <table className="data-table">
                <tbody>
                  {SHORTCUT_ACTIONS.map((a) => (
                    <tr key={a.id}>
                      <td>{a.label}</td>
                      <td style={{ textAlign: 'right', width: 150 }}>
                        <input
                          readOnly
                          value={shortcuts[a.id] ?? ''}
                          placeholder="Press key…"
                          onKeyDown={(e) => {
                            e.preventDefault()
                            const c = keyCombo(e)
                            if (c) setShortcut(a.id, c)
                          }}
                          style={{ textAlign: 'center', cursor: 'pointer' }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ==================== App shell ====================

type View = 'billing' | 'products' | 'customers' | 'reports' | 'settings'

const DEFAULT_SETTINGS: Settings = {
  shopName: 'My Shop',
  address: '',
  phone: '',
  gstin: '',
  upiId: '',
  upiQrImage: '',
  printer: '',
  currency: '₹',
  defaultTax: '',
  footer: 'Thank you for your business!',
  theme: 'light',
  shortcuts: JSON.stringify(DEFAULT_SHORTCUTS),
  gstInclusive: 'no',
}

const NAV: [View, string, string][] = [
  ['billing', 'cart', 'New Bill'],
  ['products', 'box', 'Products'],
  ['customers', 'users', 'Customers'],
  ['reports', 'chart', 'Reports'],
  ['settings', 'settings', 'Settings'],
]

function makeBill(): Bill {
  return {
    id:
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now() + Math.random()),
    label: '',
    cart: [],
    customerName: '',
    customerPhone: '',
    discountInput: 0,
    discountType: 'amount',
    paymentMode: 'Cash',
    tendered: 0,
  }
}

function App() {
  const [view, setView] = useState<View>('billing')
  const [products, setProducts] = useState<Product[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [billers, setBillers] = useState<Biller[]>([])
  const [currentBiller, setCurrentBiller] = useState('')
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [bills, setBills] = useState<Bill[]>(() => [makeBill()])
  const [activeBillId, setActiveBillId] = useState<string>('')
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | undefined>(undefined)
  const [collapsed, setCollapsed] = useState(false)
  const [license, setLicense] = useState<LicenseStatus | null>(null)
  const [licenseChecked, setLicenseChecked] = useState(false)
  const [showReminder, setShowReminder] = useState(false)
  const reminderShown = useRef(false)

  useEffect(() => {
    const check = () =>
      window.api
        .licenseStatus()
        .then(setLicense)
        .catch(() => {})
        .finally(() => setLicenseChecked(true))
    if (!window.api?.licenseStatus) {
      setLicenseChecked(true)
      return
    }
    check()
    // Re-check so an expiry while the app stays open still locks it.
    const id = setInterval(check, 10 * 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (license?.remind && !reminderShown.current) {
      reminderShown.current = true
      setShowReminder(true)
    }
  }, [license])

  const licenseActive = !!license?.active
  useEffect(() => {
    if (!licenseActive) return
    setActiveBillId((id) => id || bills[0].id)
    refreshProducts()
    refreshCustomers()
    refreshBillers()
    window.api
      .getSettings()
      .then((s) => setSettings({ ...DEFAULT_SETTINGS, ...(s as Partial<Settings>) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licenseActive])

  const refreshProducts = () => window.api.listProducts().then(setProducts)
  const refreshCustomers = () => window.api.listCustomers().then(setCustomers)
  const refreshBillers = () => window.api.listBillers().then(setBillers)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme || 'light')
  }, [settings.theme])

  function notify(msg: string) {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 3500)
  }

  useEffect(() => {
    const onAppError = (e: Event) =>
      notify(`Something went wrong: ${(e as CustomEvent<string>).detail}`)
    window.addEventListener('app-error', onAppError)
    return () => window.removeEventListener('app-error', onAppError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function selectPrinter(name: string) {
    setSettings((s) => ({ ...s, printer: name }))
    window.api.saveSettings({ printer: name }).catch(reportError)
    notify(name ? `Receipts will print to ${name}` : 'Print dialog will open for each receipt')
  }

  const activeBill = bills.find((b) => b.id === activeBillId) ?? bills[0]

  function updateBill(patch: Partial<Bill> | ((bill: Bill) => Partial<Bill>)) {
    setBills((prev) =>
      prev.map((b) =>
        b.id === activeBill.id
          ? { ...b, ...(typeof patch === 'function' ? patch(b) : patch) }
          : b,
      ),
    )
  }

  function newBill() {
    const b = makeBill()
    setBills((prev) => [...prev, b])
    setActiveBillId(b.id)
    setView('billing')
  }

  function closeBill(id: string) {
    setBills((prev) => {
      const rest = prev.filter((b) => b.id !== id)
      if (rest.length === 0) {
        const nb = makeBill()
        setActiveBillId(nb.id)
        return [nb]
      }
      if (id === activeBillId) setActiveBillId(rest[0].id)
      return rest
    })
  }

  async function saveSettings() {
    const saved = await window.api.saveSettings(
      settings as unknown as Record<string, string>,
    )
    setSettings({ ...DEFAULT_SETTINGS, ...(saved as Partial<Settings>) })
    notify('Settings saved.')
  }

  if (!licenseChecked) {
    return <div className="activation-screen" />
  }
  if (license && !license.active) {
    return <ActivationScreen status={license} onActivated={setLicense} />
  }

  return (
    <LicenseContext.Provider
      value={{ license, setLicense, openSubscription: () => setView('settings') }}
    >
    <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <Icon name="receipt" size={20} />
          </div>
          <div className="brand-text">
            <div className="brand-name">{settings.shopName || 'My Shop'}</div>
            <div className="brand-sub">Billing System</div>
          </div>
          <button
            className="sidebar-toggle"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'Expand menu' : 'Collapse menu'}
          >
            <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} />
          </button>
        </div>
        {NAV.map(([key, icon, label]) => (
          <button
            key={key}
            className={`nav-item ${view === key ? 'active' : ''}`}
            onClick={() => setView(key)}
            title={label}
          >
            <span className="nav-icon">
              <Icon name={icon} />
            </span>{' '}
            <span className="nav-label">{label}</span>
            {key === 'billing' && bills.length > 1 && (
              <span className="tab-count" style={{ marginLeft: 'auto' }}>
                {bills.length}
              </span>
            )}
          </button>
        ))}
        <div className="sidebar-foot">
          © {new Date().getFullYear()} {settings.shopName || 'My Shop'}
        </div>
      </aside>

      <main className="main">
        {/* key={view}: switching screens clears an error shown for the previous one. */}
        <ErrorBoundary key={view} fallbackTitle="This screen hit a problem — your data is safe">
        {view === 'billing' && (
          <BillingView
            bill={activeBill}
            bills={bills}
            activeBillId={activeBill.id}
            products={products}
            customers={customers}
            billers={billers}
            currentBiller={currentBiller}
            onSelectBiller={setCurrentBiller}
            onSelectPrinter={selectPrinter}
            settings={settings}
            onUpdate={updateBill}
            onSwitch={setActiveBillId}
            onNew={newBill}
            onClose={closeBill}
            refreshProducts={refreshProducts}
            notify={notify}
          />
        )}
        {view === 'products' && (
          <ProductsView
            products={products}
            settings={settings}
            refresh={refreshProducts}
            notify={notify}
          />
        )}
        {view === 'customers' && (
          <CustomersView
            customers={customers}
            refresh={refreshCustomers}
            notify={notify}
          />
        )}
        {view === 'reports' && <ReportsView settings={settings} />}
        {view === 'settings' && (
          <SettingsView
            settings={settings}
            setSettings={setSettings}
            onSave={saveSettings}
            billers={billers}
            refreshBillers={refreshBillers}
            notify={notify}
          />
        )}
        </ErrorBoundary>
      </main>

      {toast && <div className="toast">{toast}</div>}

      {showReminder && license && (
        <div className="modal-overlay" onClick={() => setShowReminder(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 36 }}>⏰</div>
            <h3>Subscription expiring soon</h3>
            <p className="muted">
              Your <strong>{license.planLabel}</strong> plan expires in{' '}
              <strong>
                {license.daysLeft} day{license.daysLeft === 1 ? '' : 's'}
              </strong>{' '}
              on {formatDate(license.expiry)}. Renew now to avoid interruption.
            </p>
            <div className="btn-row">
              <button className="btn block" onClick={() => setShowReminder(false)}>
                Remind me later
              </button>
              <button
                className="btn primary block"
                onClick={() => {
                  setShowReminder(false)
                  setView('settings')
                }}
              >
                Renew now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </LicenseContext.Provider>
  )
}

// ==================== Entry point ====================

// Errors outside React rendering (event handlers, timers, promises) become a toast + log entry.
window.addEventListener('error', (e) => {
  if (/ResizeObserver loop/.test(e.message ?? '')) return
  reportError(e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault()
  reportError(e.reason)
})
// A file dropped outside an upload control would otherwise replace the app page.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary fallbackTitle="Application error">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
