/**
 * Tavern REST API over the webServer prefix route `/tavern`. Plain
 * JSON-in/JSON-out for library CRUD and play management. The route is the
 * DSH-hosted plugin extension point (dsh-host-webserver) — no separate
 * backend process; the conversation itself lives in DSH sessions.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LoggerService } from '@deepseek-ai/cordis'
import type { CharacterRecord, Play, Preset, SwipeBranchSummary, WorldBookRecord } from './types.ts'
import { TavernStorage, newId, nowIso } from './storage.ts'
import { normalizeCard, parseCardInput, avatarDataUrl, normalizeWorldBook, serializeWorldBookFile, importPreset, serializePreset, serializeCharacterCard } from './cardcodec.ts'
import { encodePngCardResult } from './png.ts'
import { playLorebookIds, TavernSessionRuntime } from './play.ts'
import { importTauriTavernData } from './tauritavern.ts'
import { badRequest, TavernUserError } from './errors.ts'
import type { TavernConfig } from './config.ts'
import type { AvatarStore } from './avatarstore.ts'

export interface TavernApiDeps {
  storage: TavernStorage
  runtime: TavernSessionRuntime
  avatars: AvatarStore
  logger: LoggerService
  /** Plugin config; supplies the extra Host allowlist. */
  config: TavernConfig
  /** Whether the agent-loop factory is currently available (session assembly). */
  multiAgentAvailable: () => boolean
  /**
   * The host's own admission check for one raw request, when the profile has a
   * connection service.
   *
   * `ctx.webServer.register` is a bare `node:http` listener: the host's
   * browser-credential and Host/Origin fence lives in `ctx.connection`, and
   * nothing applies it to a plugin route. Without this probe `/tavern` is an
   * unauthenticated local API — any process on the machine could read the whole
   * card library, delete records, or use the importer as a directory oracle.
   * @returns 401/403 to refuse, or undefined to continue.
   */
  authorize?: (req: IncomingMessage) => 401 | 403 | undefined
}

/** Read and JSON-parse a request body (bounded). */
function readJsonBody(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) {
        // A plain `Error` here used to surface as `500 服务器内部错误`; an
        // oversized body is the caller's problem and must say so.
        reject(new TavernUserError(`请求体超过上限（${Math.floor(limit / 1024 / 1024)} MiB）`, 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text === '' ? undefined : JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message })
}

/** Build a safe Content-Disposition header value for both ASCII and UTF-8 filenames. */
function contentDisposition(filename: string): string {
  const safe = filename.replace(/[\\/:*?"<>|\r\n]/g, '_')
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_') || 'download'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

/** Split `/tavern/...` pathname into segments. */
function segments(pathname: string): string[] {
  return pathname.split('/').filter(segment => segment !== '')
}

/**
 * Whether a `Host` header may drive a mutating request.
 *
 * Comparing `Origin` against `Host` alone does not stop DNS rebinding: the
 * attacker points `evil.example` at 127.0.0.1, and the browser then sends
 * `Origin: http://evil.example` with `Host: evil.example` — a perfect match,
 * from a page the attacker controls. A loopback IP literal cannot be rebound
 * this way (the browser sends the literal the user actually typed), and neither
 * can `localhost`, so those are the safe set. A deployment reached through a
 * real hostname opts that name in through the plugin config's `allowedHosts`.
 *
 * This is a defence against a BROWSER on this machine; it is not
 * authentication. Every request is admitted by the host's own credential fence
 * first (see `TavernApiDeps.authorize`), which is what covers non-browser
 * clients.
 * @param hostHeader - the request's Host header.
 * @param allowed - extra host names from the plugin config, already lowercased.
 */
function hostAllowsMutation(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  if (hostHeader === undefined || hostHeader === '') return false
  const value = hostHeader.toLowerCase()
  // Strip the port, taking care with bracketed IPv6 literals.
  const host = value.startsWith('[')
    ? value.slice(1, value.indexOf(']') === -1 ? undefined : value.indexOf(']'))
    : value.replace(/:\d+$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  // Only the LOOPBACK ranges are inherently safe. Treating every IPv4 literal
  // as safe accepted `Host: 8.8.8.8` (a page can reach this server through any
  // address it is bound to), and treating every IPv6 literal as safe accepted
  // everything with a colon.
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  // A configured name may carry a port (`tavern.example:8443`); compare hosts,
  // not authorities, so both spellings match.
  return allowed.some((entry) => {
    const name = entry.startsWith('[')
      ? entry.slice(1, entry.indexOf(']') === -1 ? undefined : entry.indexOf(']'))
      : entry.replace(/:\d+$/, '')
    return name === host
  })
}

export interface PlayCreateInput {
  title?: string
  characterIds: string[]
  /** World-book ids (multi-select); order is the injection order. */
  lorebookIds?: string[]
  /** @deprecated Legacy single-book alias for older clients. */
  lorebookId?: string
  presetId?: string
  narratorEnabled?: boolean
  multiAgent?: boolean
  greetingIndex?: number
}

/** Strip a stored swipe branch down to its client-facing summary. */
function toSwipeSummary(branch: import('./types.ts').SwipeBranch): SwipeBranchSummary {
  return {
    playId: branch.playId,
    key: branch.key,
    count: branch.variants.length,
    current: branch.current,
    busy: branch.busy,
    updatedAt: branch.updatedAt,
    ...(branch.error !== undefined ? { error: branch.error } : {}),
  }
}

const PRESET_NUMBER_KEYS = [
  'maxTokens', 'temperature', 'topP', 'topK', 'topA', 'typicalP', 'minP',
  'repPen', 'repPenRange', 'repPenSlope', 'presencePenalty', 'frequencyPenalty',
] as const

/** Merge a preset PATCH. `null` clears a field; undefined means "not provided". */
function patchPreset(existing: Preset, body: Record<string, unknown>): Preset {
  const updated: Preset = { ...existing }
  if (typeof body.name === 'string' && body.name.trim() !== '') updated.name = body.name

  for (const key of ['model', 'provider'] as const) {
    const value = body[key]
    if (value === undefined) continue
    if (value === null || (typeof value === 'string' && value.trim() === '')) {
      delete updated[key]
    } else if (typeof value === 'string') {
      updated[key] = value.trim()
    }
  }
  if (body.systemPrompt !== undefined) {
    if (body.systemPrompt === null || (typeof body.systemPrompt === 'string' && body.systemPrompt.trim() === '')) {
      delete updated.systemPrompt
    } else if (typeof body.systemPrompt === 'string') {
      updated.systemPrompt = body.systemPrompt
    }
  }
  for (const key of PRESET_NUMBER_KEYS) {
    const value = body[key]
    if (value === undefined) continue
    if (value === null) delete updated[key]
    else if (typeof value === 'number' && Number.isFinite(value)) updated[key] = value
  }
  if (typeof body.raw === 'object' && body.raw !== null) {
    updated.raw = body.raw as Record<string, unknown>
  }
  updated.updatedAt = nowIso()
  return updated
}

/**
 * Run one decoder and map its failure onto a caller-visible 400.
 *
 * The card / world-book / preset decoders throw plain `Error`s for ordinary
 * input problems ("缺少字段 name", "entries 不是对象"). Letting those reach the
 * catch-all turned every malformed body into `500 服务器内部错误`, which tells
 * the user nothing and looks like a server fault.
 * @param label - what was being decoded, prefixed onto the message.
 * @param run - the decoding call.
 * @returns the decoded value.
 */
function validated<T>(label: string, run: () => T): T {
  try {
    return run()
  } catch (error: unknown) {
    if (error instanceof TavernUserError) throw error
    throw badRequest(`${label}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The prefix-route handler for /tavern. */
export async function tavernHandler(deps: TavernApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { storage, runtime } = deps
  const seg = segments(new URL(req.url ?? '/', 'http://x').pathname)
  const method = req.method ?? 'GET'

  try {
    // Host admission first, for EVERY method: the same-origin rules below are
    // a second fence for browser-borne writes, but they do not authenticate a
    // non-browser client, and they do not protect reads at all.
    const rejection = deps.authorize?.(req)
    if (rejection !== undefined) {
      return sendError(res, rejection, '需要 DSH 会话凭据')
    }

    // Mutating endpoints are same-origin only. A cross-site page could
    // otherwise drive the local server with CORS-simple requests (e.g.
    // text/plain POST via no-cors): the response stays unread, but the
    // side effect (import arbitrary local paths, delete records, spawn
    // agents) would already have happened.
    const mutating = method !== 'GET' && method !== 'HEAD'
    if (mutating) {
      if (!hostAllowsMutation(req.headers.host, deps.config.allowedHosts)) {
        return sendError(
          res,
          403,
          '拒绝来自该主机名的写请求（DNS rebinding 防护）。如确需通过该域名访问，请在插件配置的 allowedHosts 中加入它',
        )
      }
      const origin = req.headers.origin
      if (origin !== undefined) {
        let originHost: string | undefined
        try { originHost = new URL(origin).host } catch { originHost = undefined }
        if (originHost === undefined || originHost !== req.headers.host) {
          return sendError(res, 403, '拒绝跨站请求')
        }
      }
      const fetchSite = req.headers['sec-fetch-site']
      if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
        return sendError(res, 403, '拒绝跨站请求')
      }
      // A body must be JSON; urlencoded/text/plain (the CSRF-capable types)
      // never reach a handler.
      //
      // `content-length: 0` is NOT a body: several clients (PowerShell's
      // Invoke-WebRequest among them) send that header on a bodiless DELETE,
      // and treating it as "there is a body" rejected every such delete with
      // 415 before the route was even reached.
      const declaredLength = Number(req.headers['content-length'] ?? 0)
      const hasBody = (Number.isFinite(declaredLength) && declaredLength > 0)
        || req.headers['transfer-encoding'] !== undefined
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
      if (hasBody && !contentType.includes('application/json')) {
        return sendError(res, 415, '仅接受 application/json 请求体')
      }
    }

    // ── state ──
    if ((seg.length === 1 || (seg.length === 2 && seg[1] === 'state')) && method === 'GET') {
      const plays = storage.listPlays()
      return sendJson(res, 200, {
        characters: storage.listCharacters(),
        lorebooks: storage.listLorebooks(),
        presets: storage.listPresets(),
        plays: plays.map(play => ({
          id: play.id,
          title: play.title,
          characterIds: play.characterIds,
          lorebookIds: playLorebookIds(play),
          narratorEnabled: play.narratorEnabled,
          multiAgent: play.multiAgent,
          sessionId: play.sessionId,
          live: runtime.getDirector(play.id) !== undefined,
          updatedAt: play.updatedAt,
        })),
        defaultPresetId: storage.snapshot().defaultPresetId,
        style: storage.snapshot().style,
        multiAgentAvailable: deps.multiAgentAvailable(),
        swipes: (storage.snapshot().branches ?? []).map(toSwipeSummary),
      })
    }

    // ── local TauriTavern data-directory import ──
    const importBase = seg[0] === 'tavern' ? 1 : 0
    if (method === 'POST'
      && seg.length === importBase + 2
      && seg[importBase] === 'import'
      && seg[importBase + 1] === 'tauritavern') {
      const body = (await readJsonBody(req)) as { path?: unknown; characters?: unknown; lorebooks?: unknown; presets?: unknown } | undefined
      if (body === undefined) return sendError(res, 400, '缺少请求体')
      if (typeof body.path !== 'string' || body.path.trim() === '') {
        return sendError(res, 400, '缺少 TauriTavern 目录路径')
      }
      try {
        const report = await importTauriTavernData(storage, deps.avatars, body.path, {
          characters: typeof body.characters === 'boolean' ? body.characters : undefined,
          lorebooks: typeof body.lorebooks === 'boolean' ? body.lorebooks : undefined,
          presets: typeof body.presets === 'boolean' ? body.presets : undefined,
        })
        return sendJson(res, 200, report)
      } catch (error) {
        return sendError(res, 400, error instanceof Error ? error.message : String(error))
      }
    }

    // ── stored avatar files ──
    if (seg[1] === 'avatars' && seg.length === 3 && method === 'GET') {
      const avatar = await deps.avatars.read(seg[2]!)
      if (avatar === undefined) return sendError(res, 404, '头像不存在')
      res.writeHead(200, {
        'content-type': avatar.contentType,
        'content-length': avatar.bytes.length,
        'cache-control': 'private, max-age=3600',
      })
      res.end(avatar.bytes)
      return
    }

    // ── characters ──
    if (seg[1] === 'characters') {
      if (seg.length === 2 && method === 'POST') {
        const body = (await readJsonBody(req)) as Record<string, unknown> | undefined
        if (body === undefined) return sendError(res, 400, '缺少请求体')
        const input = typeof body.input === 'string'
          ? body.input
          : typeof body.input === 'object'
            ? JSON.stringify(body.input)
            : undefined
        if (input === undefined && typeof body.card === 'object' && body.card !== null) {
          const card = normalizeCard(body.card)
          const record: CharacterRecord = {
            id: newId('char'),
            source: typeof body.source === 'string' ? body.source : 'manual',
            ...(typeof body.avatar === 'string' ? { avatar: body.avatar } : {}),
            createdAt: nowIso(),
            updatedAt: nowIso(),
            card,
          }
          const stored = await deps.avatars.materializeCharacter(record)
          await storage.upsertCharacter(stored)
          return sendJson(res, 201, stored)
        }
        if (input === undefined || input.trim() === '') return sendError(res, 400, '缺少卡片输入')
        const bytes = typeof body.input === 'string' && body.input.startsWith('data:')
          ? Buffer.from(body.input.split(',')[1] ?? '', 'base64')
          : Buffer.from(input, 'utf8')
        const card = parseCardInput(bytes, typeof body.source === 'string' ? body.source : undefined)
        const avatar = avatarDataUrl(bytes)
        const record: CharacterRecord = {
          id: newId('char'),
          source: typeof body.source === 'string' ? body.source : 'upload',
          ...(avatar !== undefined ? { avatar } : {}),
          createdAt: nowIso(),
          updatedAt: nowIso(),
          card,
        }
        const stored = await deps.avatars.materializeCharacter(record)
        await storage.upsertCharacter(stored)
        return sendJson(res, 201, stored)
      }
      if (seg.length === 3 && method === 'PUT') {
        const body = (await readJsonBody(req)) as Record<string, unknown> | undefined
        const existing = storage.getCharacter(seg[2]!)
        if (existing === undefined) return sendError(res, 404, '角色不存在')
        const incoming = typeof body?.data === 'object' && body.data !== null
          ? (body.data as Record<string, unknown>)
          : {}
        const data = { ...existing.card.data, ...incoming }
        const card = normalizeCard({ spec: existing.card.spec, spec_version: existing.card.spec_version, data })
        const updated: CharacterRecord = {
          ...existing,
          ...(typeof body?.avatar === 'string' ? { avatar: body.avatar } : {}),
          card,
          updatedAt: nowIso(),
        }
        const stored = await deps.avatars.materializeCharacter(updated, existing)
        await storage.upsertCharacter(stored)
        return sendJson(res, 200, stored)
      }
      if (seg.length === 3 && method === 'DELETE') {
        const existing = storage.getCharacter(seg[2]!)
        if (existing === undefined) return sendError(res, 404, '角色不存在')
        await storage.deleteCharacter(seg[2]!)
        await deps.avatars.removeCharacter(existing)
        return sendJson(res, 200, { ok: true })
      }
      if (seg.length === 4 && seg[3] === 'export' && method === 'GET') {
        const character = storage.getCharacter(seg[2]!)
        if (character === undefined) return sendError(res, 404, '角色不存在')
        const avatar = await deps.avatars.readCharacter(character)
        const encoded = encodePngCardResult(JSON.stringify(serializeCharacterCard(character.card)), avatar)
        const name = character.card.data.name.replace(/[\\/:*?"<>|]/g, '_') || 'character'
        // A jpeg/webp/gif avatar cannot be embedded in a PNG card without
        // transcoding, so the card falls back to a blank image. Say so in a
        // header instead of silently shipping a card with no portrait.
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': encoded.png.length,
          'content-disposition': contentDisposition(`${name}.png`),
          ...(avatar !== undefined && !encoded.avatarEmbedded
            ? { 'x-tavern-avatar': 'omitted-unsupported-format' }
            : {}),
        })
        res.end(encoded.png)
        return
      }
    }

    // ── lorebooks ──
    if (seg[1] === 'lorebooks') {
      if (seg.length === 2 && method === 'POST') {
        const body = (await readJsonBody(req)) as Record<string, unknown> | undefined
        if (body === undefined) return sendError(res, 400, '缺少请求体')
        let book
        let name = typeof body.name === 'string' && body.name !== '' ? body.name : '未命名世界书'
        const bookObj = body.book
        if (typeof bookObj === 'object' && bookObj !== null) {
          book = validated('世界书', () => normalizeWorldBook(bookObj))
          const bookName = (bookObj as Record<string, unknown>).name
          if (typeof bookName === 'string' && bookName !== '') name = bookName
        } else if (typeof body.input === 'string') {
          book = validated('世界书', () => normalizeWorldBook(JSON.parse(body.input as string)))
        } else {
          return sendError(res, 400, '缺少世界书内容')
        }
        const record: WorldBookRecord = {
          id: newId('book'),
          name,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          book,
        }
        await storage.upsertLorebook(record)
        return sendJson(res, 201, record)
      }
      if (seg.length === 3 && method === 'PUT') {
        const body = (await readJsonBody(req)) as Record<string, unknown> | undefined
        const existing = storage.getLorebook(seg[2]!)
        if (existing === undefined) return sendError(res, 404, '世界书不存在')
        if (typeof body?.book !== 'object' || body.book === null) {
          return sendError(res, 400, '缺少世界书内容')
        }
        const book = validated('世界书', () => normalizeWorldBook(body.book))
        const updated: WorldBookRecord = {
          ...existing,
          name: typeof body?.name === 'string' && body.name !== '' ? body.name : existing.name,
          book,
          updatedAt: nowIso(),
        }
        await storage.upsertLorebook(updated)
        return sendJson(res, 200, updated)
      }
      if (seg.length === 3 && method === 'DELETE') {
        await storage.deleteLorebook(seg[2]!)
        return sendJson(res, 200, { ok: true })
      }
      if (seg.length === 4 && seg[3] === 'export' && method === 'GET') {
        const record = storage.getLorebook(seg[2]!)
        if (record === undefined) return sendError(res, 404, '世界书不存在')
        const payload = JSON.stringify(serializeWorldBookFile(record.book), null, 2)
        const name = record.name.replace(/[\\/:*?"<>|]/g, '_') || 'lorebook'
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
          'content-disposition': contentDisposition(`${name}.json`),
        })
        res.end(payload)
        return
      }
    }

    // ── presets ──
    if (seg[1] === 'presets') {
      if (seg.length === 2 && method === 'POST') {
        const body = (await readJsonBody(req)) as Record<string, unknown> | undefined
        if (body === undefined) return sendError(res, 400, '缺少请求体')
        const rawPreset = body.preset ?? body.raw ?? {}
        const presetInput = typeof rawPreset === 'string'
          ? JSON.parse(rawPreset)
          : rawPreset
        const rawName = typeof presetInput === 'object' && presetInput !== null
          ? (presetInput as Record<string, unknown>).name
          : undefined
        const name = typeof body.name === 'string' && body.name !== ''
          ? body.name
          : typeof rawName === 'string' && rawName !== ''
            ? rawName
            : '未命名预设'
        const preset = importPreset(presetInput, newId('preset'), name)
        await storage.upsertPreset(preset)
        return sendJson(res, 201, preset)
      }
      if (seg.length === 3 && method === 'PUT') {
        const body = (await readJsonBody(req)) as Record<string, unknown> | undefined
        if (body === undefined) return sendError(res, 400, '缺少请求体')
        const existing = storage.getPreset(seg[2]!)
        if (existing === undefined) return sendError(res, 404, '预设不存在')
        const updated = patchPreset(existing, body)
        await storage.upsertPreset(updated)
        return sendJson(res, 200, updated)
      }
      if (seg.length === 3 && method === 'DELETE') {
        await storage.deletePreset(seg[2]!)
        return sendJson(res, 200, { ok: true })
      }
      if (seg.length === 4 && seg[3] === 'export' && method === 'GET') {
        const preset = storage.getPreset(seg[2]!)
        if (preset === undefined) return sendError(res, 404, '预设不存在')
        const payload = JSON.stringify(serializePreset(preset), null, 2)
        const name = preset.name.replace(/[\\/:*?"<>|]/g, '_') || 'preset'
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
          'content-disposition': contentDisposition(`${name}.json`),
        })
        res.end(payload)
        return
      }
    }

    // ── plays ──
    if (seg[1] === 'plays') {
      if (seg.length === 2 && method === 'POST') {
        const body = (await readJsonBody(req)) as PlayCreateInput | undefined
        if (body === undefined || !Array.isArray(body.characterIds) || body.characterIds.length === 0) {
          return sendError(res, 400, '需要至少一个角色')
        }
        if (body.characterIds.some(id => typeof id !== 'string')) {
          return sendError(res, 400, '角色 id 必须是字符串')
        }
        const characters = storage.listCharacters()
        for (const id of body.characterIds) {
          if (!characters.some(c => c.id === id)) return sendError(res, 400, `角色不存在：${id}`)
        }
        const lorebookIds = Array.isArray(body.lorebookIds)
          ? [...new Set(body.lorebookIds)]
          : typeof body.lorebookId === 'string'
            ? [body.lorebookId]
            : []
        if (body.lorebookIds !== undefined && !Array.isArray(body.lorebookIds)) {
          return sendError(res, 400, '世界书 id 必须是数组')
        }
        if (lorebookIds.some(id => typeof id !== 'string' || id === '')) {
          return sendError(res, 400, '世界书 id 必须是字符串')
        }
        for (const id of lorebookIds) {
          if (storage.getLorebook(id) === undefined) return sendError(res, 400, `世界书不存在：${id}`)
        }
        if (body.presetId !== undefined && storage.getPreset(body.presetId) === undefined) {
          return sendError(res, 400, `预设不存在：${body.presetId}`)
        }
        const main = characters.find(c => c.id === body.characterIds[0])
        const mainData = main?.card.data
        const greetings = mainData !== undefined
          ? [mainData.first_mes, ...(mainData.alternate_greetings ?? [])].filter(g => g !== '')
          : []
        const greetingIndex = typeof body.greetingIndex === 'number' && Number.isInteger(body.greetingIndex)
          ? body.greetingIndex
          : 0
        const title = typeof body.title === 'string' && body.title.trim() !== ''
          ? body.title.trim()
          : mainData?.name ?? '新酒馆'
        const sessionId = `tavern-${newId('play').replace('play-', '')}`
        const play: Play = {
          id: newId('play'),
          title,
          characterIds: body.characterIds,
          lorebookIds,
          presetId: body.presetId,
          narratorEnabled: body.narratorEnabled ?? false,
          multiAgent: body.multiAgent ?? false,
          sessionId,
          greetingIndex,
          ...(greetings[greetingIndex] !== undefined ? { greeting: greetings[greetingIndex] } : {}),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
        await storage.upsertPlay(play)
        // Assemble the director session; roll the play back on failure.
        try {
          await runtime.ensureDirector(play)
        } catch (error: unknown) {
          await storage.deletePlay(play.id)
          throw error
        }
        return sendJson(res, 201, play)
      }
      if (seg.length === 3 && method === 'GET') {
        const play = storage.getPlay(seg[2]!)
        if (play === undefined) return sendError(res, 404, '酒馆会话不存在')
        return sendJson(res, 200, play)
      }
      // Retry: regenerate the last assistant reply as a new swipe variant.
      if (seg.length === 5 && seg[3] === 'messages' && seg[4] === 'retry' && method === 'POST') {
        const result = await runtime.reroll(seg[2]!)
        return sendJson(res, 200, { play: result.play, branch: toSwipeSummary(result.branch) })
      }
      // Swipe: materialize another stored variant of the current branch.
      if (seg.length === 5 && seg[3] === 'messages' && seg[4] === 'swipe' && method === 'POST') {
        const body = (await readJsonBody(req)) as { key?: unknown; step?: unknown } | undefined
        if (typeof body?.key !== 'string' || typeof body?.step !== 'number') {
          return sendError(res, 400, '需要分支 key 与移动方向 step')
        }
        const result = await runtime.swipe(seg[2]!, body.key, body.step)
        return sendJson(res, 200, { play: result.play, branch: toSwipeSummary(result.branch) })
      }
      // Edit one user message and regenerate from it.
      if (seg.length === 6 && seg[3] === 'messages' && seg[5] === 'retry' && method === 'POST') {
        const body = (await readJsonBody(req)) as { text?: unknown } | undefined
        if (typeof body?.text !== 'string') return sendError(res, 400, '缺少修改后的内容')
        const play = await runtime.editUserAndRetry(seg[2]!, seg[4]!, body.text)
        return sendJson(res, 200, { play })
      }
      // Edit one assistant reply in place (no regeneration).
      if (seg.length === 5 && seg[3] === 'messages' && method === 'PUT') {
        const body = (await readJsonBody(req)) as { text?: unknown } | undefined
        if (typeof body?.text !== 'string') return sendError(res, 400, '缺少修改后的内容')
        const play = await runtime.editAssistant(seg[2]!, seg[4]!, body.text)
        return sendJson(res, 200, { play })
      }
      // Activate (create or resume) the play's director session.
      if (seg.length === 4 && seg[3] === 'activate' && method === 'POST') {
        const play = storage.getPlay(seg[2]!)
        if (play === undefined) return sendError(res, 404, '酒馆会话不存在')
        await runtime.ensureDirector(play)
        return sendJson(res, 200, play)
      }
      if (seg.length === 3 && method === 'PUT') {
        const body = (await readJsonBody(req)) as Record<string, unknown> | undefined
        if (body === undefined) return sendError(res, 400, '缺少请求体')
        const existing = storage.getPlay(seg[2]!)
        if (existing === undefined) return sendError(res, 404, '酒馆会话不存在')
        const characterIds = Array.isArray(body.characterIds)
          ? body.characterIds as string[]
          : existing.characterIds
        if (characterIds.length === 0) return sendError(res, 400, '需要至少一个角色')
        if (characterIds.some(id => typeof id !== 'string')) return sendError(res, 400, '角色 id 必须是字符串')
        const characters = storage.listCharacters()
        for (const id of characterIds) {
          if (!characters.some(c => c.id === id)) return sendError(res, 400, `角色不存在：${id}`)
        }
        let lorebookIds = playLorebookIds(existing)
        if (body.lorebookIds !== undefined) {
          if (!Array.isArray(body.lorebookIds)) return sendError(res, 400, '世界书 id 必须是数组')
          if (body.lorebookIds.some(id => typeof id !== 'string' || id === '')) {
            return sendError(res, 400, '世界书 id 必须是字符串')
          }
          lorebookIds = [...new Set(body.lorebookIds)]
        } else if (typeof body.lorebookId === 'string') {
          lorebookIds = [body.lorebookId]
        }
        for (const id of lorebookIds) {
          if (storage.getLorebook(id) === undefined) return sendError(res, 400, `世界书不存在：${id}`)
        }
        if (typeof body.presetId === 'string' && storage.getPreset(body.presetId) === undefined) {
          return sendError(res, 400, `预设不存在：${body.presetId}`)
        }
        const updated: Play = {
          ...existing,
          ...(typeof body.title === 'string' && body.title.trim() !== '' ? { title: body.title.trim() } : {}),
          characterIds,
          lorebookIds,
          ...(typeof body.presetId === 'string' ? { presetId: body.presetId } : {}),
          ...(typeof body.narratorEnabled === 'boolean' ? { narratorEnabled: body.narratorEnabled } : {}),
          ...(typeof body.multiAgent === 'boolean' ? { multiAgent: body.multiAgent } : {}),
          updatedAt: nowIso(),
        }
        delete updated.lorebookId
        await storage.upsertPlay(updated)
        return sendJson(res, 200, updated)
      }
      if (seg.length === 3 && method === 'DELETE') {
        await runtime.dropPlay(seg[2]!)
        await storage.deletePlay(seg[2]!)
        return sendJson(res, 200, { ok: true })
      }
    }

    // ── settings ──
    if (seg[1] === 'settings' && seg.length === 2 && method === 'PUT') {
      const body = (await readJsonBody(req)) as { defaultPresetId?: string | null; style?: unknown } | undefined
      if (body === undefined) return sendError(res, 400, '缺少请求体')
      if ('defaultPresetId' in body) {
        const defaultPresetId = typeof body.defaultPresetId === 'string' && body.defaultPresetId !== ''
          ? body.defaultPresetId
          : undefined
        await storage.setDefaultPreset(defaultPresetId)
      }
      if (body.style === 'dsh' || body.style === 'classic') await storage.setStyle(body.style)
      return sendJson(res, 200, { ok: true })
    }

    return sendError(res, 404, '未知接口')
  } catch (error: unknown) {
    // Validation failures are the caller's problem and carry their own status
    // and a message that is safe to display. Everything else stays opaque.
    if (error instanceof TavernUserError) {
      return sendError(res, error.status, error.message)
    }
    if (error instanceof SyntaxError) {
      return sendError(res, 400, `JSON 格式错误：${error.message}`)
    }
    deps.logger.warn(`tavern api error: ${String(error)}`)
    // Internal error text (paths, stack details) stays in the log; the
    // client gets a generic message.
    return sendError(res, 500, '服务器内部错误')
  }
}
