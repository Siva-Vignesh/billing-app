import { contextBridge, ipcRenderer } from 'electron'

const api = {
  listProducts: () => ipcRenderer.invoke('products:list'),
  getProductByCode: (code: string) =>
    ipcRenderer.invoke('products:getByCode', code),
  upsertProduct: (p: unknown) => ipcRenderer.invoke('products:upsert', p),
  deleteProduct: (code: string) => ipcRenderer.invoke('products:delete', code),
  listCustomers: () => ipcRenderer.invoke('customers:list'),
  upsertCustomer: (c: unknown) => ipcRenderer.invoke('customers:upsert', c),
  deleteCustomer: (id: number) => ipcRenderer.invoke('customers:delete', id),
  listBillers: () => ipcRenderer.invoke('billers:list'),
  addBiller: (name: string) => ipcRenderer.invoke('billers:add', name),
  deleteBiller: (id: number) => ipcRenderer.invoke('billers:delete', id),
  reportData: (q: unknown) => ipcRenderer.invoke('reports:data', q),
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  licenseStatus: () => ipcRenderer.invoke('license:status'),
  licenseActivate: (code: string) => ipcRenderer.invoke('license:activate', code),
  createInvoice: (inv: unknown) => ipcRenderer.invoke('invoices:create', inv),
  listInvoices: () => ipcRenderer.invoke('invoices:list'),
  getInvoice: (id: number) => ipcRenderer.invoke('invoices:get', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: Record<string, string>) =>
    ipcRenderer.invoke('settings:save', s),
  printHtml: (html: string, printer: string) => ipcRenderer.invoke('print:html', html, printer),
  logError: (msg: string) => ipcRenderer.invoke('log:error', msg),
}

contextBridge.exposeInMainWorld('api', api)

export type BillingApi = typeof api
