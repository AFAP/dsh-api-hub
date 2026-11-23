/**
 * 本地预览：把 API-HUB 的 Host 半挂到一个迷你 http 服务器上，
 * 再起一个 echo 接口当靶子，整套跑在 127.0.0.1 上，不经过 DSH。
 *
 *   npm run preview          （等价于 node scripts/preview.mjs）
 *   → 插件模式   http://127.0.0.1:8799/api-hub/
 *   → 单网页模式 http://127.0.0.1:8799/api-hub/?mode=file
 *   → echo 靶子  http://127.0.0.1:8798/echo
 *
 * 预览用的数据文件默认放 <仓库>/.preview/api-hub.json（已 gitignore），
 * 不会碰你真正在用的接口清单；要换路径就设环境变量 DATA_FILE。
 */
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PREVIEW_DIR = path.join(REPO_DIR, '.preview')
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(PREVIEW_DIR, 'api-hub.json')
const PAGE_PORT = Number(process.env.PAGE_PORT || 8799)
const ECHO_PORT = Number(process.env.ECHO_PORT || 8798)

/* ─────────────── 1. 假的 Cordis ctx，只为拿到那条 prefix route ─────────────── */

const captured = []
const fakeWebCtx = {
  effect(fn) {
    try {
      fn()
    } catch (error) {
      console.error('[effect]', error)
    }
    return () => {}
  },
  webServer: {
    register(route) {
      captured.push(route)
      return () => {}
    },
  },
}
const fakeCtx = {
  inject(_deps, callback) {
    callback(fakeWebCtx)
  },
  effect(fn) {
    try {
      fn()
    } catch (error) {
      console.error('[effect]', error)
    }
    return () => {}
  },
}
apply(fakeCtx, { dataFile: DATA_FILE })
const route = captured.find((item) => item && item.kind === 'prefix')
if (!route) throw new Error('插件没有注册 prefix route')

/* ─────────────── 2. 靶子接口 ─────────────── */

const ECHO = http.createServer((req, res) => {
  // 放开跨域，方便用「单网页 + 浏览器直连」模式测这个靶子
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
    'access-control-max-age': '600',
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const body = Buffer.concat(chunks).toString('utf8')
    if (url.pathname === '/json') {
      const out = JSON.stringify({
        code: 0,
        data: {
          id: 1024,
          name: '演示接口',
          active: true,
          tags: ['a', 'b'],
          nested: { ok: true, n: 12.5, nil: null },
          rows: [{ id: 1, title: '第一行' }, { id: 2, title: '第二行' }],
        },
        msg: 'ok',
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...cors })
      res.end(out)
      return
    }
    if (url.pathname === '/text') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...cors })
      res.end('纯文本响应，没有 JSON。')
      return
    }
    if (url.pathname === '/html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cors })
      res.end('<!doctype html><h1>hi</h1>')
      return
    }
    if (url.pathname === '/big') {
      const payload = JSON.stringify({ rows: Array.from({ length: 4000 }, (_, i) => ({ i, s: 'x'.repeat(40) })) })
      res.writeHead(200, { 'content-type': 'application/json', ...cors })
      res.end(payload)
      return
    }
    if (url.pathname === '/gzip') {
      const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ gzipped: true, list: [1, 2, 3] })))
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', ...cors })
      res.end(payload)
      return
    }
    if (url.pathname === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json', ...cors })
        res.end(JSON.stringify({ slow: true }))
      }, 1500)
      return
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/echo?from=redirect', ...cors })
      res.end()
      return
    }
    const statusMatch = /^\/status\/(\d{3})$/.exec(url.pathname)
    if (statusMatch) {
      res.writeHead(Number(statusMatch[1]), { 'content-type': 'application/json', ...cors })
      res.end(JSON.stringify({ status: Number(statusMatch[1]) }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...cors })
    res.end(JSON.stringify({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    }, null, 2))
  })
})

/* ─────────────── 3. 页面 + API ─────────────── */

const PAGE = http.createServer((req, res) => route.handler(req, res))

const start = (server, port, label) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => {
    console.log(`${label}  http://127.0.0.1:${server.address().port}`)
    resolve(server)
  })
})

await fs.mkdir(path.dirname(DATA_FILE), { recursive: true })
await start(ECHO, ECHO_PORT, '靶子    ')
await start(PAGE, PAGE_PORT, '插件模式')
console.log('单网页  http://127.0.0.1:%d/api-hub/?mode=file', PAGE_PORT)
console.log('数据    %s', DATA_FILE)
