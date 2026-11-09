// Vendor tool for subscription keys. Never ship tools/private-key.pem.
//   node tools/license-tool.js keys                                      -> create signing key pair (run ONCE)
//   node tools/license-tool.js code <silver|gold|diamond> <MACHINE-ID> [YYYY-MM-DD]
//     Optional date = start of the new period (use the current expiry date for early renewals).
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const KEY_FILE = path.join(__dirname, 'private-key.pem')
const PLANS = ['silver', 'gold', 'diamond']
const [command, plan, machineArg, startArg] = process.argv.slice(2)

function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  fs.writeFileSync(KEY_FILE, privateKey.export({ format: 'pem', type: 'pkcs8' }))
  console.log('PUBLIC_KEY_B64 =', pubRaw.toString('base64'))
  console.log('Paste it into PUBLIC_KEY_B64 in electron/main.ts.')
  console.log('Private key written to tools/private-key.pem (keep this secret).')
}

function makeCode() {
  const machineId = (machineArg || '').trim().toUpperCase()
  if (!PLANS.includes(plan) || !/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(machineId)) usage()
  const now = new Date()
  const requested = startArg ? new Date(`${startArg}T00:00:00`) : now
  if (Number.isNaN(requested.getTime())) usage()
  const expiry = new Date(Math.max(requested.getTime(), now.getTime()))
  if (plan === 'silver') expiry.setMonth(expiry.getMonth() + 1)
  if (plan === 'gold') expiry.setFullYear(expiry.getFullYear() + 1)

  const payload = Buffer.from(
    JSON.stringify({
      v: 2,
      plan,
      machineId,
      issuedAt: now.toISOString(),
      expiry: plan === 'diamond' ? null : expiry.toISOString(),
      nonce: crypto.randomBytes(4).toString('hex'),
    }),
    'utf8',
  )
  const priv = crypto.createPrivateKey(fs.readFileSync(KEY_FILE))
  const sig = crypto.sign(null, payload, priv)
  const b64u = (b) =>
    b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  console.error(
    `Plan: ${plan} | Machine: ${machineId} | Expires: ${plan === 'diamond' ? 'never' : expiry.toDateString()}`,
  )
  console.log(`${b64u(payload)}.${b64u(sig)}`)
}

function usage() {
  console.error(
    'Usage:\n  node tools/license-tool.js keys\n  node tools/license-tool.js code <silver|gold|diamond> <MACHINE-ID> [YYYY-MM-DD]',
  )
  process.exit(1)
}

if (command === 'keys') generateKeys()
else if (command === 'code') makeCode()
else usage()
