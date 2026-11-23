/**
 * API-HUB · Host 半
 *
 * 一件事，三个接口，都为 `web/index.html` 那一个单页服务：
 *
 *   GET  /api-hub/                → 把单网页发出去（同一份文件，单开也行）
 *   POST /api-hub/api/open|save   → 读写本地 JSON（接口清单真正落盘的地方）
 *   POST /api-hub/api/send        → 用 node:http(s) 代为发请求，绕开浏览器跨域
 *
 * 单网页自己判断有没有这一层：探到 /api-hub/api/status 就走「插件模式」，
 * 探不到就当纯静态页用浏览器文件 API 自己管文件（单网页模式，兜底用）。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROUTE_PREFIX = '/api-hub'
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const PAGE_CANDIDATES = [
  path.resolve(PLUGIN_DIR, '..', 'web', 'index.html'),
  path.resolve(PLUGIN_DIR, '..', 'index.html'),
  path.resolve(PLUGIN_DIR, 'index.html'),
]

/** 数据落在 `$DSH_HOME/storages/dsh-api-hub/`，和 DSH 其它插件的存储习惯一致。 */
function resolveDshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv || path.join(os.homedir(), '.dsh')
}

const DEFAULT_DATA_DIR = path.join(resolveDshHome(), 'storages', 'dsh-api-hub')
const DEFAULT_DATA_FILE = path.join(DEFAULT_DATA_DIR, 'api-hub.json')
const MAX_BODY_BYTES = 96 * 1024 * 1024   // 客户端最多传 40MB 文件，base64 后会胀 1/3
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT_MS = 60000

/* ───────────────────────────── HTTP 小工具 ───────────────────────────── */

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, data })
}

function fail(res, status, message) {
  sendJson(res, status, { ok: false, error: message })
}

function readBody(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  const raw = (await readBody(req)).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`请求体不是合法 JSON：${error.message}`)
  }
}

/** 只放行同源调用，挡住别处网页顺手把本机文件写掉。 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true // 同源 fetch / 直接 curl 不带 Origin
  try {
    const parsed = new URL(origin)
    const host = req.headers.host || ''
    return parsed.host === host
  } catch {
    return false
  }
}

function requireJson(req) {
  const type = String(req.headers['content-type'] || '')
  return /^application\/json\b/i.test(type)
}

/* ───────────────────────────── 本地文件读写 ───────────────────────────── */

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function assertWritablePath(input) {
  const value = typeof input === 'string' ? input.trim() : ''
  if (!value) throw new HttpError(400, '缺少文件路径')
  if (value.includes('\0')) throw new HttpError(400, '路径里有非法字符')
  if (!path.isAbsolute(value)) throw new HttpError(400, '请填绝对路径')
  if (!/\.json$/i.test(value)) throw new HttpError(400, '数据文件必须是 .json 结尾')
  return path.normalize(value)
}

function assertReadablePath(input) {
  const value = typeof input === 'string' ? input.trim() : ''
  if (!value) throw new HttpError(400, '缺少文件路径')
  if (value.includes('\0')) throw new HttpError(400, '路径里有非法字符')
  if (!path.isAbsolute(value)) throw new HttpError(400, '请填绝对路径')
  return path.normalize(value)
}

async function readDataFile(file) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, data: null }
    throw new Error(`读取失败：${error.message}`)
  }
  if (!text.trim()) return { exists: false, data: null }
  try {
    return { exists: true, data: JSON.parse(text) }
  } catch (error) {
    return { exists: true, data: null, invalid: true, error: `JSON 解析失败：${error.message}` }
  }
}

async function writeDataFile(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const text = JSON.stringify(data, null, 2)
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
  return Buffer.byteLength(text)
}

/* ───────────────────────────── 代为发请求 ───────────────────────────── */

const BINARY_TYPES = /^(image|audio|video|font)\/|^application\/(pdf|zip|gzip|x-tar|x-7z-compressed|octet-stream|vnd\.)/i

function headerObject(input) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const [key, value] of Object.entries(input)) {
    const name = String(key || '').trim()
    if (!name) continue
    out[name] = String(value === undefined || value === null ? '' : value)
  }
  return out
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === lower)
}

function decodeBody(buffer, encoding) {
  const how = String(encoding || '').trim().toLowerCase()
  if (!how || how === 'identity') return buffer
  try {
    if (how === 'gzip') return zlib.gunzipSync(buffer)
    if (how === 'deflate') {
      try {
        return zlib.inflateSync(buffer)
      } catch {
        return zlib.inflateRawSync(buffer)
      }
    }
    if (how === 'br') return zlib.brotliDecompressSync(buffer)
    if (how === 'zstd' && typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buffer)
  } catch {
    return buffer
  }
  return buffer
}

function charsetOf(headers) {
  const type = String(headers['content-type'] || '')
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(type)
  return match ? match[1].toLowerCase() : 'utf-8'
}

function decodeText(buffer, charset) {
  const alias = { gb2312: 'gb18030', gbk: 'gb18030', 'utf8': 'utf-8', big5: 'big5' }
  const label = alias[charset] || charset || 'utf-8'
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  }
}

function oneRequest(target, method, headers, body, timeoutMs, tlsInsecure) {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:'
    const mod = isHttps ? https : http
    const options = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers,
    }
    if (isHttps) {
      options.rejectUnauthorized = tlsInsecure !== true
      options.servername = target.hostname
    }
    const startedAt = process.hrtime.bigint()
    let req
    try {
      req = mod.request(options, (res) => {
        const chunks = []
        let total = 0
        let truncated = false
        res.on('data', (chunk) => {
          total += chunk.length
          if (total <= MAX_RESPONSE_BYTES) chunks.push(chunk)
          else truncated = true
        })
        res.on('end', () => {
          const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
          resolve({ res, buffer: Buffer.concat(chunks), total, truncated, elapsedMs })
        })
        res.on('error', reject)
      })
    } catch (error) {
      reject(error)
      return
    }
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`))
    })
    if (body !== null && body !== undefined && body !== '') req.write(body)
    req.end()
  })
}

function headerPairs(res) {
  const rows = []
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    rows.push([res.rawHeaders[i], res.rawHeaders[i + 1]])
  }
  return rows
}

/** 把「文本 + base64 文件」拼成 multipart/form-data 的字节流 */
function buildMultipart(multipart) {
  const boundary = String(multipart.boundary || `----ApiHubBoundary${Date.now().toString(16)}`).replace(/[^\w-]/g, '')
  const chunks = []
  for (const part of Array.isArray(multipart.parts) ? multipart.parts : []) {
    const name = String(part.name || '').replace(/"/g, '%22')
    if (!name) continue
    if (part.type === 'file') {
      const data = Buffer.from(String(part.base64 || ''), 'base64')
      const fileName = String(part.fileName || 'file').replace(/"/g, '%22')
      const type = String(part.contentType || 'application/octet-stream')
      chunks.push(Buffer.from(`--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"; filename="${fileName}"\r\n` +
        `Content-Type: ${type}\r\n\r\n`, 'utf8'))
      chunks.push(data)
      chunks.push(Buffer.from('\r\n', 'utf8'))
    } else {
      chunks.push(Buffer.from(`--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${part.value === undefined || part.value === null ? '' : String(part.value)}\r\n`, 'utf8'))
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

async function sendRequest(options) {
  const method = String(options.method || 'GET').toUpperCase()
  let currentUrl = String(options.url || '').trim()
  if (!currentUrl) throw new Error('缺少请求地址')

  const headers = headerObject(options.headers)

  // form-data 由这里拼，覆盖掉客户端可能带来的 boundary
  let body = options.body === undefined || options.body === null ? null : String(options.body)
  if (options.multipart) {
    const built = buildMultipart(options.multipart)
    body = built.body
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') delete headers[key]
    }
    headers['Content-Type'] = built.contentType
  }
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), 600000)
  const tlsInsecure = options.tlsInsecure === true

  if (body !== null && !hasHeader(headers, 'content-length') && !hasHeader(headers, 'transfer-encoding')) {
    headers['Content-Length'] = String(Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body))
  }

  let currentMethod = method
  let currentBody = body
  let lastResult = null

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let target
    try {
      target = new URL(currentUrl)
    } catch {
      throw new Error(`地址不合法：${currentUrl}`)
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('只支持 http / https 地址')
    }
    if (target.username && !hasHeader(headers, 'authorization')) {
      const pair = `${decodeURIComponent(target.username)}:${decodeURIComponent(target.password || '')}`
      headers['Authorization'] = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`
    }

    const result = await oneRequest(target, currentMethod, headers, currentBody, timeoutMs, tlsInsecure)
    lastResult = { result, url: target.toString() }

    const status = result.res.statusCode || 0
    const location = result.res.headers.location
    if (location && [301, 302, 303, 307, 308].includes(status) && hop < MAX_REDIRECTS) {
      const nextUrl = new URL(location, target).toString()
      if (status === 303 || ((status === 301 || status === 302) && currentMethod !== 'GET' && currentMethod !== 'HEAD')) {
        currentMethod = 'GET'
        currentBody = null
        delete headers['Content-Length']
        delete headers['content-length']
        delete headers['Content-Type']
        delete headers['content-type']
      }
      currentUrl = nextUrl
      continue
    }
    break
  }

  const { result, url } = lastResult
  const res = result.res
  const encoding = String(res.headers['content-encoding'] || '')
  const decoded = decodeBody(result.buffer, encoding)
  const contentType = String(res.headers['content-type'] || '')
  const isBinary = BINARY_TYPES.test(contentType)
  const charset = charsetOf(res.headers)

  let text = ''
  let binary = false
  if (result.total === 0) {
    text = ''
  } else if (isBinary) {
    binary = true
    text = `[二进制内容 ${decoded.length} 字节，Content-Type: ${contentType || '未知'}]`
  } else {
    text = decodeText(decoded, charset)
    if (text.includes('\uFFFD') && charset === 'utf-8') {
      const decodedGbk = decodeText(decoded, 'gb18030')
      if (decodedGbk && decodedGbk.indexOf('\uFFFD') < decodedGbk.length) text = decodedGbk
    }
  }
  if (result.truncated) {
    text += `\n\n…（响应超过 ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)} MB，已截断显示）`
  }

  return {
    status: res.statusCode || 0,
    statusText: res.statusMessage || '',
    headers: headerPairs(res),
    body: text,
    binary,
    size: result.total,
    timeMs: Math.round(result.elapsedMs),
    contentType,
    url,
    finalMethod: currentMethod,
  }
}

/* ───────────────────────────── 静态页 ───────────────────────────── */

let cachedPage = { mtimeMs: 0, text: '', file: '' }

async function readPage() {
  for (const candidate of PAGE_CANDIDATES) {
    try {
      const stat = await fs.stat(candidate)
      if (cachedPage.file === candidate && cachedPage.mtimeMs === stat.mtimeMs && cachedPage.text) {
        return cachedPage.text
      }
      const text = await fs.readFile(candidate, 'utf8')
      cachedPage = { mtimeMs: stat.mtimeMs, text, file: candidate }
      return text
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
  }
  return null
}

/* ───────────────────────────── 插件本体 ───────────────────────────── */

export function apply(ctx, config = {}) {
  const configured = typeof config?.dataFile === 'string' ? config.dataFile.trim() : ''
  const configuredFile = configured
    ? (path.isAbsolute(configured) ? path.normalize(configured) : path.join(DEFAULT_DATA_DIR, configured))
    : DEFAULT_DATA_FILE

  async function handleHttp(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://api-hub.invalid')
      const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'

      // ── 单网页本体 ──
      if ((route === '/' || route === '/index.html' || route === '') && (req.method === 'GET' || req.method === 'HEAD')) {
        const html = await readPage()
        if (!html) {
          fail(res, 404, '找不到 web/index.html（插件缺少页面文件）')
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
        })
        res.end(req.method === 'HEAD' ? undefined : html)
        return
      }

      if (route === '/favicon.ico' || route === '/favicon.svg') {
        res.writeHead(204)
        res.end()
        return
      }

      // ── API ──
      if (route.startsWith('/api/')) {
        if (req.method === 'POST' && !sameOrigin(req)) {
          fail(res, 403, '只接受同源请求')
          return
        }
        if (req.method === 'POST' && !requireJson(req)) {
          fail(res, 415, '请用 application/json 提交')
          return
        }

        if (route === '/api/status' && req.method === 'GET') {
          ok(res, {
            mode: 'dsh',
            dataFile: configuredFile,
            dataDir: path.dirname(configuredFile),
            defaultDataFile: DEFAULT_DATA_FILE,
            page: cachedPage.file || null,
            node: process.version,
          })
          return
        }

        if (route === '/api/open' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const file = assertReadablePath(body?.path || configuredFile)
          const result = await readDataFile(file)
          ok(res, {
            path: file,
            exists: result.exists,
            invalid: result.invalid === true,
            error: result.error || null,
            data: result.data,
          })
          return
        }

        if (route === '/api/save' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const file = assertWritablePath(body?.path || configuredFile)
          if (!body || typeof body.data !== 'object' || body.data === null) {
            fail(res, 400, '缺少要写入的数据')
            return
          }
          const bytes = await writeDataFile(file, body.data)
          ok(res, { path: file, bytes, savedAt: new Date().toISOString() })
          return
        }

        if (route === '/api/send' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const result = await sendRequest(body || {})
          ok(res, result)
          return
        }

        fail(res, 404, `未知接口 ${route}`)
        return
      }

      fail(res, 404, `未知路由 ${route}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = error && Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500
      try {
        sendJson(res, status, { ok: false, error: message })
      } catch {
        /* 连接已经断了 */
      }
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => {
            void handleHttp(req, res)
          },
        }),
      'API-HUB: http routes',
    )
  })
}
