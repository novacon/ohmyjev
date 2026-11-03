#!/usr/bin/env node
// ohmyjev's command line: `install` puts ohmyjev in every agent it finds, `key` stores the TypeSafe key once for all
// of them. Plain Node, no dependencies, so `npx ohmyjev` runs it straight from the npm package.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, platform } from 'node:os'

// mirrors hooks/jev.ts: where the agents look for the stored key
const KEY_SERVICE = 'ohmyjev'
const KEY_ACCOUNT = 'typesafe'
const KEY_FILE = `${homedir()}/.ohmyjev/key`
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const REPO = 'novacon/ohmyjev'

const USAGE = `usage:
  npx ohmyjev install [--check] [--uninstall]   ohmyjev in Claude Code, Codex, omp and pi, whichever are here
  npx ohmyjev key [--tty]                        store your TypeSafe key once, for all of them`

/** Run a command; resolves { code, out } and never throws. */
const run = (cmd, args, input) =>
  new Promise(resolve => {
    const child = execFile(cmd, args, { timeout: 180_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}`.trim() }))
    if (input !== undefined) child.stdin.end(input)
  })
const has = async cmd => (await run('sh', ['-c', `command -v ${cmd}`])).code === 0

// --- install: each agent's own install command, never a copy of its files ---

/** Per agent: is ohmyjev in it (and which version), and the commands to install, update and remove it. */
const AGENTS = [
  {
    name: 'Claude Code',
    bin: 'claude',
    version: async () => /ohmyjev@ohmyjev[\s\S]*?Version:\s*(\S+)/.exec((await run('claude', ['plugin', 'list'])).out)?.[1],
    install: [['claude', 'plugin', 'marketplace', 'add', REPO], ['claude', 'plugin', 'install', 'ohmyjev@ohmyjev']],
    update: [['claude', 'plugin', 'marketplace', 'update', 'ohmyjev'], ['claude', 'plugin', 'update', 'ohmyjev@ohmyjev']],
    remove: [['claude', 'plugin', 'uninstall', 'ohmyjev@ohmyjev']],
  },
  {
    name: 'Codex',
    bin: 'codex',
    version: async () => /^ohmyjev@ohmyjev\s+installed\S*\s+\S*\s+(\S+)/m.exec((await run('codex', ['plugin', 'list'])).out)?.[1],
    install: [['codex', 'plugin', 'marketplace', 'add', REPO], ['codex', 'plugin', 'add', 'ohmyjev@ohmyjev']],
    update: [['codex', 'plugin', 'marketplace', 'upgrade', 'ohmyjev'], ['codex', 'plugin', 'add', 'ohmyjev@ohmyjev']],
    remove: [['codex', 'plugin', 'remove', 'ohmyjev@ohmyjev']],
  },
  {
    name: 'omp',
    bin: 'omp',
    version: async () => /ohmyjev@(\S+)/.exec((await run('omp', ['plugin', 'list'])).out)?.[1],
    install: [['omp', 'plugin', 'install', 'ohmyjev']],
    update: [['omp', 'plugin', 'upgrade', 'ohmyjev']],
    remove: [['omp', 'plugin', 'uninstall', 'ohmyjev']],
  },
  {
    name: 'pi',
    bin: 'pi',
    version: async () => {
      if (!/npm:ohmyjev\b/.test((await run('pi', ['list'])).out)) return undefined
      const pkg = await readFile(`${homedir()}/.pi/agent/npm/node_modules/ohmyjev/package.json`, 'utf8').catch(() => '{}')
      return JSON.parse(pkg).version ?? 'installed'
    },
    install: [['pi', 'install', 'npm:ohmyjev']],
    update: [['pi', 'update', '--extensions']],
    remove: [['pi', 'remove', 'npm:ohmyjev']],
  },
]

async function install(args) {
  const check = args.includes('--check')
  const uninstall = args.includes('--uninstall')
  const latest = (await run('npm', ['view', 'ohmyjev', 'version'])).out.split('\n').at(-1)
  const found = []
  for (const a of AGENTS) {
    if (!(await has(a.bin))) {
      console.log(`${a.name}: not found`)
      continue
    }
    found.push(a.name)
    const before = await a.version()
    const current = !uninstall && before && before === latest
    const steps = uninstall ? (before ? a.remove : []) : current ? [] : before ? a.update : a.install
    const plan = uninstall ? (before ? 'remove' : 'not installed, nothing to remove') : before ? `update ${before} → ${latest || 'latest'}` : 'install'
    if (check || !steps.length) {
      console.log(`${a.name}: ${before ?? 'not installed'}${current ? ' (up to date)' : check ? ` · would ${plan}` : ''}`)
      if (check && steps.length) for (const s of steps) console.log(`  $ ${s.join(' ')}`)
      continue
    }
    let failed = ''
    for (const [i, s] of steps.entries()) {
      const r = await run(s[0], s.slice(1))
      // adding a marketplace that is already there fails harmlessly; anything else is a real failure
      if (r.code !== 0 && !(s.includes('marketplace') && s.includes('add') && /already/i.test(r.out))) {
        failed = `${s.join(' ')}: ${r.out.split('\n').at(-1)}`
        break
      }
    }
    const after = await a.version()
    console.log(`${a.name}: ${failed ? `failed (${failed})` : uninstall ? 'removed' : `${before ? `${before} → ` : ''}${after ?? 'installed'}`}`)
  }
  if (!found.length) console.log('No supported agent found on PATH: claude, codex, omp or pi.')
  if (!check && !uninstall && found.length) {
    console.log(`\nRestart running sessions to load it.${(await storedKey()) || process.env.TYPESAFE_API_KEY ? '' : ' No Jev key yet: run `npx ohmyjev key`.'}`)
  }
}

// --- key: one-time local page (or a hidden prompt) → the OS secret store; the key is never printed ---

/** The key already stored, or ''. */
async function storedKey() {
  const readers = platform() === 'darwin'
    ? [['security', ['find-generic-password', '-s', KEY_SERVICE, '-a', KEY_ACCOUNT, '-w']]]
    : [['secret-tool', ['lookup', 'service', KEY_SERVICE, 'account', KEY_ACCOUNT]]]
  for (const [cmd, args] of readers) {
    const r = await run(cmd, args)
    if (r.code === 0 && r.out) return r.out
  }
  return (await readFile(KEY_FILE, 'utf8').catch(() => '')).trim()
}

/** Store the key; returns where it went. The key travels on stdin, never in a command line other processes can read. */
async function store(key) {
  if (platform() === 'darwin') {
    const r = await run('security', ['-i'], `add-generic-password -U -s ${KEY_SERVICE} -a ${KEY_ACCOUNT} -w ${key}\n`)
    if (r.code === 0 && (await storedKey()) === key) return 'macOS Keychain'
  } else if (await has('secret-tool')) {
    const r = await run('secret-tool', ['store', '--label=ohmyjev TypeSafe key', 'service', KEY_SERVICE, 'account', KEY_ACCOUNT], key)
    if (r.code === 0) return 'the secret store (secret-tool)'
  }
  await mkdir(`${homedir()}/.ohmyjev`, { recursive: true, mode: 0o700 })
  await writeFile(KEY_FILE, `${key}\n`, { mode: 0o600 })
  return `${KEY_FILE} (readable only by you)`
}

/** One tiny decision request: true when TypeSafe accepts the key, false when it refuses it, null when unreachable. */
async function verify(key) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'jev-1.13.0', state: { text: 'hello' }, questions: { greeting: { type: 'noul', instructions: 'Is `text` a greeting?' } } }),
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok ? true : res.status === 401 || res.status === 403 ? false : null
  } catch {
    return null
  }
}

// a key is one token; spaces, quotes and backslashes are refused before the key reaches the secret store's input
const KEY_SHAPE = /^[!#-&(-[\]-~]{8,512}$/

async function saveKey(key) {
  key = key.trim()
  if (!KEY_SHAPE.test(key)) return 'That does not look like a TypeSafe key (one token, no spaces or quotes). Nothing stored.'
  const ok = await verify(key)
  if (ok === false) return 'TypeSafe refused that key. Nothing stored: check it at console.typesafe.ai/settings/keys.'
  const where = await store(key)
  return `Stored in ${where}. Verified: ${ok ? 'yes' : 'not reachable, stored anyway'}. Every ohmyjev agent finds it there.`
}

const PAGE = (body) => `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>ohmyjev key</title>
<body style="font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem;background:#111;color:#eee">${body}</body>`
const FORM = PAGE(`<h1 style="font-size:1.4rem">Store your TypeSafe key</h1>
<p>It goes from this page into your computer's secret store. Your agent never sees it. This page works once.</p>
<form method="post"><input name="key" type="password" autocomplete="off" autofocus required
 style="width:100%;padding:.6rem;font:inherit;background:#222;color:#eee;border:1px solid #555;border-radius:6px">
<p><button style="padding:.6rem 1.2rem;font:inherit">Store key</button></p></form>
<p style="color:#999">Get a key at console.typesafe.ai/settings/keys. Do not paste it into a chat.</p>`)

async function keyCommand(args) {
  if (args.includes('--tty')) {
    if (!process.stdin.isTTY) return console.log('--tty needs a terminal.')
    process.stdout.write('TypeSafe key (hidden): ')
    process.stdin.setRawMode(true)
    let key = ''
    for await (const chunk of process.stdin) {
      const ch = String(chunk)
      if (ch === '\u0003') process.exit(1) // Ctrl-C
      if (ch === '\r' || ch === '\n') break
      key = ch === '\u007f' ? key.slice(0, -1) : key + ch
    }
    process.stdin.setRawMode(false)
    process.stdin.pause()
    return console.log(`\n${await saveKey(key)}`)
  }

  // one-time page: an unguessable path on 127.0.0.1, its own Host only, one use or ten minutes
  const token = randomBytes(24).toString('hex')
  let done
  const finished = new Promise(resolve => (done = resolve))
  const server = createServer((req, res) => {
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" }
    const port = server.address().port
    if (req.headers.host !== `127.0.0.1:${port}` || req.url !== `/${token}`) {
      res.writeHead(404, headers).end() // a foreign Host (DNS rebinding) or a guessed path
      return
    }
    if (req.method === 'GET') return res.writeHead(200, headers).end(FORM)
    if (req.method !== 'POST') return res.writeHead(405, headers).end()
    let body = ''
    req.on('data', d => {
      body += d
      if (body.length > 4096) req.destroy()
    })
    req.on('end', async () => {
      const message = await saveKey(new URLSearchParams(body).get('key') ?? '')
      res.writeHead(200, headers).end(PAGE(`<p>${message.replace(/[<>&]/g, '')}</p><p>You can close this tab.</p>`))
      done(message)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/${token}`
  const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open'
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  console.log(`Paste your key in the page that just opened (or open ${url}).\nWaiting up to 10 minutes. On a machine with no browser, run: npx ohmyjev key --tty`)
  const timeout = setTimeout(() => done('Timed out after 10 minutes. Nothing stored.'), 600_000)
  const message = await finished
  clearTimeout(timeout)
  server.close()
  console.log(message)
}

const [cmd, ...args] = process.argv.slice(2)
if (cmd === 'install') await install(args)
else if (cmd === 'key') await keyCommand(args)
else console.log(USAGE)
