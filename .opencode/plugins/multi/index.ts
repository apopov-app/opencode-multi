import { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"

/**
 * Multi-agent room (server side).
 *
 * A room is an ordinary OpenCode session whose metadata contains a `multi`
 * config. Every participant speaks in the same session: we switch the session
 * model and nudge it with an invisible synthetic message. Because it is one
 * session, every participant sees the whole conversation and the full tool
 * history, and the TUI attributes each answer to the model that produced it.
 */

const META = "multi"
// A safety cap for a runaway loop; 0 disables it. Per-model turns are
// unlimited by default, so a chain can run until stopped or this cap hits.
const DEFAULT_MAX_TURNS = 50
const DEFAULT_TURNS_PER_MODEL = 0
const DEFAULT_TIMEOUT_MS = 240_000
// A turn that keeps failing must not spin the chain; stop after N in a row.
const MAX_CONSECUTIVE_FAILURES = 3
// The synthetic turn may sit in the queue; session.wait() resolves
// immediately on an idle session, so gate on the execution actually
// having started before treating wait() as the completion signal.
const START_GRACE_MS = 10_000
// Window for a just-delivered interrupted/failed event to overrule a
// resolved session.wait().
const FAILURE_GRACE_MS = 250
// session.wait() can resolve before the reply is persisted to history; poll
// for a fresh assistant message this long before reading the text.
const PERSIST_GRACE_MS = 2_500

type Participant = {
  providerID: string
  id: string
  name: string
  handle: string
  variant?: string
}

type Room = {
  v: 1
  participants: Participant[]
  maxTurns: number
  turnsPerModel: number
  turnTimeoutMs: number
  paused?: boolean
}

type Finished = { ok: boolean; error?: string }
type Turn = { ok: true; text: string } | { ok: false; error: string }
type ChainEnd = "limit" | "voted" | "no-candidates" | "user" | "paused" | "failure" | "idle"

const keyOf = (p: { providerID: string; id: string }) => `${p.providerID}/${p.id}`

function normalizeRoom(raw: unknown): Room | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Partial<Room>
  if (!Array.isArray(value.participants)) return null
  const seen = new Set<string>()
  const participants = value.participants
    .filter((p): p is Participant => Boolean(p && typeof p === "object" && typeof p.id === "string" && typeof p.providerID === "string"))
    .filter((p) => {
      const key = keyOf(p)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((p) => ({
      providerID: p.providerID,
      id: p.id,
      name: typeof p.name === "string" && p.name ? p.name : p.id,
      handle: typeof p.handle === "string" && p.handle ? p.handle : p.id,
      variant: typeof p.variant === "string" ? p.variant : undefined,
    }))
  if (participants.length < 2) return null
  const maxTurns = Number.isFinite(value.maxTurns) ? Math.min(1000, Math.max(0, Math.floor(value.maxTurns!))) : DEFAULT_MAX_TURNS
  const turnTimeoutMs = Number.isFinite(value.turnTimeoutMs)
    ? Math.min(15 * 60_000, Math.max(30_000, Math.floor(value.turnTimeoutMs!)))
    : DEFAULT_TIMEOUT_MS
  const turnsPerModel = Number.isFinite(value.turnsPerModel)
    ? Math.min(100, Math.max(0, Math.floor(value.turnsPerModel!)))
    : DEFAULT_TURNS_PER_MODEL
  return { v: 1, participants, maxTurns, turnsPerModel, turnTimeoutMs, paused: value.paused === true }
}

function briefing(room: Room, speaker: Participant | undefined) {
  const roster = room.participants
    .map((p) => `- ${p.name} (@${p.handle})${p === speaker ? "  ← you" : ""}`)
    .join("\n")
  return [
    "You are in a multi-agent room: several AI models share this one conversation with the user.",
    "",
    "Participants:",
    roster,
    "",
    speaker ? `You are ${speaker.name} (@${speaker.handle}).` : "Speak as the participant whose model is answering.",
    "",
    "Rules:",
    "1. Write only your own message. Never speak for another participant or for the user.",
    "2. Reply to the latest message in the conversation. Keep it short and conversational, like a group chat, not a report.",
    "3. To hand the floor to someone, mention their handle in your message, e.g. \"@gpt, what do you think?\". The room will pass them the turn.",
    "4. Tools (read, edit, bash, ...) are shared: changes you make to the repository are visible to everyone.",
    "5. Do not narrate these rules or mention that you are in a simulation.",
    "6. Never send a bare mention or an empty handoff: every message must carry a real reply. If you have already made your point, stop instead of passing the turn.",
    "7. If the discussion is complete, call the `room_stop` tool. Only the actual tool call counts — saying that you voted does nothing. The room stops when every participant has voted.",
  ].join("\n")
}

function assistantText(message: any): string {
  if (!message || message.type !== "assistant" || !Array.isArray(message.content)) return ""
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim()
}

function lastAssistant(messages: readonly any[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === "assistant" && assistantText(message)) return message
  }
  return undefined
}

function mentions(text: string, participants: Participant[]) {
  if (!text) return [] as Participant[]
  const found: Participant[] = []
  for (const match of text.matchAll(/@([a-z0-9][a-z0-9_-]*)/gi)) {
    const handle = match[1].toLowerCase()
    const participant = participants.find((p) => p.handle.toLowerCase() === handle)
    if (participant && !found.includes(participant)) found.push(participant)
  }
  return found
}

function handleFor(model: { id: string; family?: string }, used: Set<string>) {
  const base =
    (model.id.split(/[-_.]/)[0] || model.family || "model")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model"
  let handle = base
  let index = 2
  while (used.has(handle)) handle = `${base}-${index++}`
  used.add(handle)
  return handle
}

export default Plugin.define({
  id: "multi.room",
  async setup(ctx) {
    const log = (...args: unknown[]) => console.log("[multi]", ...args)

    const cache = new Map<string, { room: Room | null; at: number }>()
    const waiters = new Map<string, Set<(result: Finished) => void>>()
    const running = new Set<string>()
    const deferred = new Set<string>()
    const busy = new Set<string>()
    const lastInput = new Map<string, "user" | "synthetic">()
    const generations = new Map<string, number>()
    const stopVotes = new Map<string, Set<string>>()
    const continueRequests = new Set<string>()
    let disposed = false
    // How many executions ever started on each session; speak() snapshots the
    // count before enqueueing its synthetic turn to detect that the turn has
    // actually begun (it may be queued, and wait() resolves instantly when
    // the session is idle).
    const startedCount = new Map<string, number>()

    const votedAll = (sessionID: string, room: Room) => {
      const votes = stopVotes.get(sessionID)
      return !!votes && room.participants.every((participant) => votes.has(keyOf(participant)))
    }

    const idle = async (sessionID: string, timeoutMs = 30_000) => {
      const started = Date.now()
      while (busy.has(sessionID)) {
        if (Date.now() - started > timeoutMs) return false
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      return true
    }

    async function roomOf(sessionID: string): Promise<Room | null> {
      const cached = cache.get(sessionID)
      // Short TTL so pausing/resuming or editing participants in the TUI takes
      // effect during a live conversation.
      if (cached && Date.now() - cached.at < 3_000) return cached.room
      try {
        const session = await ctx.session.get({ sessionID })
        const room = normalizeRoom((session.metadata as any)?.[META])
        cache.set(sessionID, { room, at: Date.now() })
        return room
      } catch {
        return null
      }
    }

    // The waiter only resolves on `session.execution.interrupted`, on an
    // execution failure, or on timeout; normal completion is awaited via
    // `ctx.session.wait()` in `speak()`. Resolving waiters on *any* execution
    // end made a turn satisfiable by an unrelated execution on the same
    // session (e.g. a user message enqueued mid-turn), which could hand the
    // floor to a stale or partially streamed reply.
    function waitTurn(sessionID: string, timeoutMs: number) {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let resolvePromise!: (result: Finished) => void
      const promise = new Promise<Finished>((resolve) => {
        resolvePromise = resolve
      })
      const set = waiters.get(sessionID) ?? new Set()
      waiters.set(sessionID, set)
      const finish = (result: Finished) => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        timer = undefined
        set.delete(finish)
        if (set.size === 0) waiters.delete(sessionID)
        resolvePromise(result)
      }
      set.add(finish)
      timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs)
      ;(timer as any)?.unref?.()
      return { promise, finish, get done() { return done } }
    }

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

    // The assistant message id present right before a turn starts; used to
    // distinguish the fresh reply from the previous participant's.
    const lastAssistantID = async (sessionID: string): Promise<string | undefined> => {
      const messages = (await ctx.session.context({ sessionID }).catch(() => [])) as any[]
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.type === "assistant") return String(messages[i]?.id ?? "")
      }
      return undefined
    }

    // Poll the history until a new assistant message lands. session.wait()
    // may resolve before the reply is persisted, and falling back to an older
    // message would replay a stale handoff.
    const freshReply = async (sessionID: string, baseline: string | undefined): Promise<any> => {
      const deadline = Date.now() + PERSIST_GRACE_MS
      for (;;) {
        const messages = (await ctx.session.context({ sessionID }).catch(() => [])) as any[]
        let last: any
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.type === "assistant") {
            last = messages[i]
            break
          }
        }
        if (last && String(last.id ?? "") !== String(baseline ?? "")) return last
        if (Date.now() > deadline) return undefined
        await sleep(100)
      }
    }

    const executionStarted = async (sessionID: string, previous: number, graceMs: number) => {
      const deadline = Date.now() + graceMs
      while ((startedCount.get(sessionID) ?? 0) <= previous) {
        if (Date.now() > deadline) return false
        await sleep(50)
      }
      return true
    }

    await ctx.session.hook("context", async (event) => {
      const room = await roomOf(event.sessionID)
      if (!room) {
        delete event.tools["room_stop"]
        return
      }
      if (room.paused) delete event.tools["room_stop"]
      const speaker = room.participants.find((p) => p.providerID === event.model.providerID && p.id === event.model.id)
      event.system.push({ type: "text", text: briefing(room, speaker) })
    })

    type MultiConfig = {
      maxTurns?: number
      turnsPerModel?: number
      turnTimeoutMs?: number
      providers?: string[] | "all"
    }

    async function readConfig(): Promise<MultiConfig> {
      for (const path of [`${ctx.location.directory}/.opencode/multi.json`, `${ctx.location.directory}/multi.json`]) {
        try {
          const parsed = JSON.parse(await readFile(path, "utf8"))
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as MultiConfig
        } catch {}
      }
      return {}
    }

    async function resolveParticipants(specs: string[], preferredProvider?: string) {
      const listed = await ctx.model.list()
      // Participants share the room's tools and must be able to call
      // room_stop; a model without tool calling would take the floor and
      // never be able to vote to end the discussion.
      const models = listed.data.filter(
        (model) => model.enabled !== false && model.capabilities?.tools !== false,
      )
      const unique = new Map<string, (typeof models)[number]>()
      for (const model of models) unique.set(`${model.providerID}/${model.id}`, model)
      const all = [...unique.values()]

      const used = new Set<string>()
      const seen = new Set<string>()
      const picked: Participant[] = []

      for (const raw of specs) {
        const spec = raw.trim().replace(/^@/, "").toLowerCase()
        if (!spec) continue

        let candidates = all.filter(
          (model) => model.id.toLowerCase() === spec || `${model.providerID}/${model.id}`.toLowerCase() === spec,
        )
        if (candidates.length === 0) candidates = all.filter((model) => (model.family ?? "").toLowerCase() === spec)
        if (candidates.length === 0)
          candidates = all.filter(
            (model) => model.id.toLowerCase().includes(spec) || model.name.toLowerCase().includes(spec),
          )
        if (candidates.length === 0) throw new Error(`Unknown model "${raw}". Use a model id, e.g. "claude-sonnet-5-5".`)

        const exact = candidates.filter((model) => model.id.toLowerCase() === spec)
        if (exact.length > 0) candidates = exact
        if (preferredProvider) {
          const preferred = candidates.filter((model) => model.providerID === preferredProvider)
          if (preferred.length > 0) candidates = preferred
        }

        const model = [...candidates].sort((a, b) => (b.time?.released ?? 0) - (a.time?.released ?? 0))[0]
        const key = `${model.providerID}/${model.id}`
        if (seen.has(key)) continue
        seen.add(key)
        picked.push({
          providerID: model.providerID,
          id: model.id,
          name: model.name,
          handle: handleFor(model, used),
        })
      }

      return picked
    }

    const roomTitle = (participants: Participant[]) =>
      `Multi · ${participants.map((p) => p.name).join(" + ")}`.slice(0, 120)

    type PendingForm = { sessionID: string; config: MultiConfig; keys: string[] }
    const pendingForms = new Map<string, PendingForm>()
    const continueForms = new Map<string, { sessionID: string; generation: number }>()

    // The desktop app keeps per-model visibility in its own SQLite store
    // (state -> "opencode.global.dat" / "model"). Reading it lets the picker
    // show exactly the models the user left enabled in the GUI.
    let visibilityCache: { at: number; map: Map<string, string> | undefined } | undefined

    async function desktopVisibility() {
      if (visibilityCache && Date.now() - visibilityCache.at < 15_000) return visibilityCache.map
      const paths = [
        `${homedir()}/Library/Application Support/ai.opencode.desktop/drafts.sqlite`,
        `${process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`}/ai.opencode.desktop/drafts.sqlite`,
        `${process.env.APPDATA ?? ""}/ai.opencode.desktop/drafts.sqlite`,
      ].filter(Boolean)

      let map: Map<string, string> | undefined
      for (const path of paths) {
        try {
          const specifier = "bun:sqlite"
          const { Database } = (await import(specifier)) as any
          const db = new Database(path, { readonly: true })
          try {
            const row = db
              .query("select value from state where name = ? and key = ?")
              .get("opencode.global.dat", "model") as { value?: string } | null
            if (!row?.value) continue
            const parsed = JSON.parse(row.value)
            if (!Array.isArray(parsed?.user)) continue
            map = new Map<string, string>()
            for (const item of parsed.user) {
              if (typeof item?.providerID !== "string" || typeof item?.modelID !== "string") continue
              map.set(`${item.providerID}/${item.modelID}`, item.visibility)
            }
            break
          } finally {
            db.close()
          }
        } catch {}
      }

      visibilityCache = { at: Date.now(), map }
      return map
    }

    async function formFields(session: any, config: MultiConfig) {
      const listed = await ctx.model.list()
      const visibility = await desktopVisibility()

      // Same rule as participants: models without tool calling can't take
      // turns, so don't offer them in the picker.
      const enabled = listed.data.filter(
        (model) => model.enabled !== false && model.capabilities?.tools !== false,
      )
      const preferred = session.model?.providerID
      const requested =
        config.providers === "all"
          ? undefined
          : Array.isArray(config.providers)
            ? config.providers
            : preferred
              ? [preferred]
              : undefined

      const scoped = requested ? enabled.filter((model) => requested.includes(model.providerID)) : enabled
      // A single provider with one usable model is useless for a room; fall back
      // to the whole catalog.
      const pool = scoped.length >= 2 ? scoped : enabled
      // The desktop's persisted visibility can lag behind the live settings, so
      // only explicit "hide" entries are trusted; new models (missing entries)
      // stay available.
      const models = pool.filter((model) => visibility?.get(`${model.providerID}/${model.id}`) !== "hide")

      const names = new Map<string, string>()
      try {
        const providers = await ctx.provider.list()
        for (const provider of providers.data) names.set(provider.id, provider.name)
      } catch {}

      const groups = new Map<string, typeof models>()
      for (const model of models) {
        const list = groups.get(model.providerID) ?? []
        list.push(model)
        groups.set(model.providerID, list)
      }

      return [...groups.entries()]
        .sort(([a], [b]) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b))
        .map(([providerID, list]) => {
          const raw = names.get(providerID) ?? providerID
          const title = raw.includes(" / ") ? raw.split(" / ").pop()! : raw
          return {
            key: `models:${providerID}`,
            title,
            description: `Models from ${title}`,
            type: "multiselect" as const,
            custom: true,
            options: [...list]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((model) => ({
                value: `${model.providerID}/${model.id}`,
                label: model.name,
                description: model.id,
              })),
          }
        })
        .filter((field) => field.options.length > 0)
    }

    // Forms are the one dialog primitive every client renders (TUI, desktop,
    // web). The plugin API does not expose form creation yet, so we call the
    // local server API with the service credentials.
    async function serviceInfo() {
      const state = process.env.XDG_STATE_HOME ?? `${homedir()}/.local/state`
      for (const path of [`${state}/opencode/service.json`, `${homedir()}/.local/state/opencode/service.json`]) {
        try {
          const info = JSON.parse(await readFile(path, "utf8"))
          if (info?.url && info?.password) return info as { url: string; password: string }
        } catch {}
      }
      return undefined
    }

    async function api(path: string, init: { method?: string; body?: string } = {}) {
      const info = await serviceInfo()
      if (!info) throw new Error("Local OpenCode service not found. Pass models explicitly: /multi-room model-a,model-b")
      const response = await fetch(`${info.url}${path}`, {
        method: init.method ?? "GET",
        body: init.body,
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`,
        },
      })
      if (!response.ok) throw new Error(`OpenCode API ${response.status}: ${await response.text()}`)
      return response.json()
    }

    async function openRoomForm(sessionID: string, config: MultiConfig) {
      const session = await ctx.session.get({ sessionID })
      const fields = await formFields(session, config)
      const total = fields.reduce((sum, field) => sum + field.options.length, 0)
      if (total < 2)
        throw new Error("Not enough visible models for a picker. Enable models in the model settings or pass them explicitly.")

      const created: any = await api(`/api/session/${sessionID}/form`, {
        method: "POST",
        body: JSON.stringify({
          title: "Multi-agent room",
          // Desktop only renders forms tagged as questions (or websearch
          // providers); the TUI shows any form. This tag makes the picker
          // appear in both.
          metadata: { kind: "question" },
          fields: fields.map((field) => ({
            ...field,
            description: `${field.description}. Pick two or more in total; the selection order is the speaking order.`,
          })),
        }),
      })

      const form = created?.data ?? created
      if (!form?.id) throw new Error("Could not open the model picker.")
      pendingForms.set(form.id, { sessionID, config, keys: fields.map((field) => field.key) })
      // Visible acknowledgement: some clients only show a pending form when the
      // session is (re)opened, so at least the title confirms the command ran.
      if (!session.title) await ctx.session.update({ sessionID, title: "Multi · choose models" }).catch(() => undefined)
      return form
    }

    async function applyRoom(sessionID: string, specs: string[], config: MultiConfig) {
      const session = await ctx.session.get({ sessionID })
      const participants = await resolveParticipants(specs, session.model?.providerID)
      if (participants.length < 2) throw new Error("A multi-agent room needs at least two different models.")

      const metadata: Record<string, any> = { ...(session.metadata ?? {}) }
      metadata[META] = {
        v: 1,
        participants,
        maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
        turnsPerModel: config.turnsPerModel ?? DEFAULT_TURNS_PER_MODEL,
        turnTimeoutMs: config.turnTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      }

      await ctx.session.update({ sessionID, metadata, title: roomTitle(participants) })
      await ctx.session.switchModel({
        sessionID,
        model: { providerID: participants[0].providerID, id: participants[0].id },
      })
      cache.delete(sessionID)
      stopVotes.delete(sessionID)
      cancelContinueForms(sessionID)
      return participants
    }

    // Works from any client (desktop, web, TUI): no picker needed.
    await ctx.command.transform((editor) => {
      editor.add({
        name: "multi-room",
        description:
          "Multi-agent room here: /multi-room [model,model | continue | pause | resume | off]. No arguments opens a model picker.",
        execute: async ({ sessionID, prompt }) => {
          const args = (prompt.text ?? "").trim()
          const lower = args.toLowerCase()
          const session = await ctx.session.get({ sessionID })
          const metadata: Record<string, any> = { ...(session.metadata ?? {}) }
          const existing = normalizeRoom(metadata[META])

          if (lower === "off") {
            delete metadata[META]
            await ctx.session.update({ sessionID, metadata })
            cache.delete(sessionID)
            await stopRoom(sessionID)
            return
          }

          if (lower === "pause" || lower === "resume") {
            if (!existing) throw new Error("This session is not a multi-agent room.")
            metadata[META] = { ...metadata[META], paused: lower === "pause" }
            await ctx.session.update({ sessionID, metadata })
            cache.delete(sessionID)
            if (lower === "pause") await stopRoom(sessionID)
            return
          }

          if (lower === "continue") {
            if (!existing) throw new Error("This session is not a multi-agent room.")
            if (existing.paused) throw new Error("The room is paused. Run /multi-room resume first.")
            stopVotes.delete(sessionID)
            cancelContinueForms(sessionID)
            continueRequests.add(sessionID)
            void startChain(sessionID)
            return
          }

          const config = await readConfig()

          if (args) {
            const specs = args.split(/[\s,]+/).filter(Boolean)
            if (specs.length === 0) throw new Error('Pass models, e.g. "/multi-room claude-haiku-5-5,minimax-m3".')
            await applyRoom(sessionID, specs, config)
            return
          }

          await openRoomForm(sessionID, config)
        },
      })
    })

    // Models can vote to end the discussion; the chain stops when everyone agrees.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "room_stop",
        description:
          "Vote to stop the multi-agent room. Call this when you believe the discussion is complete. Only the tool call counts — saying you voted does nothing. The room stops when every participant has voted.",
        input: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Optional short reason for stopping." },
          },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (_input, context) => {
          const sessionID = context.sessionID
          const room = await roomOf(sessionID)
          if (!room) return { content: "This session is not a multi-agent room." }
          if (room.paused) return { content: "The room is paused." }

          const session = await ctx.session.get({ sessionID })
          const model = session.model
          const speaker = model
            ? room.participants.find((p) => p.providerID === model.providerID && p.id === model.id)
            : undefined
          if (!speaker) return { content: "Only room participants can vote to stop." }

          const votes = stopVotes.get(sessionID) ?? new Set<string>()
          votes.add(keyOf(speaker))
          stopVotes.set(sessionID, votes)
          const total = room.participants.length
          log("stop vote", `${votes.size}/${total}`, keyOf(speaker))
          return {
            content:
              votes.size >= total
                ? `Stop vote recorded (${votes.size}/${total}). Everyone agrees — the room stops after this turn.`
                : `Stop vote recorded (${votes.size}/${total}). Waiting for the other participants.`,
          }
        },
      })
    })

    function pick(room: Room, text: string, current: string | undefined, spoken: Map<string, number>) {
      const cap = room.turnsPerModel
      const allowed = (participant: Participant) => cap === 0 || (spoken.get(keyOf(participant)) ?? 0) < cap

      const addressed = mentions(text, room.participants).filter(
        (p) => keyOf(p) !== current && allowed(p),
      )
      if (addressed.length > 0) return addressed[0]

      // No explicit handoff: keep the room going round-robin, least-spoken first.
      const candidates = room.participants.filter((p) => keyOf(p) !== current && allowed(p))
      if (candidates.length === 0) return undefined
      return [...candidates].sort(
        (a, b) => (spoken.get(keyOf(a)) ?? 0) - (spoken.get(keyOf(b)) ?? 0),
      )[0]
    }

    async function speak(sessionID: string, participant: Participant, room: Room): Promise<Turn> {
      if (disposed) return { ok: false, error: "interrupted" }
      try {
        await ctx.session.switchModel({
          sessionID,
          model: {
            providerID: participant.providerID,
            id: participant.id,
            ...(participant.variant ? { variant: participant.variant } : {}),
          },
        })
      } catch (error) {
        log("switchModel failed", keyOf(participant), String(error))
        return { ok: false, error: "switch-model" }
      }

      const turn = waitTurn(sessionID, room.turnTimeoutMs)
      const startedBefore = startedCount.get(sessionID) ?? 0
      const baseline = await lastAssistantID(sessionID)
      const votes = stopVotes.get(sessionID)?.size ?? 0
      const extra = continueRequests.delete(sessionID)
        ? " The user asked to continue — add a new point or ask someone a question; don't just repeat a stop vote."
        : ""
      try {
        await ctx.session.synthetic({
          sessionID,
          text: `[room] Your turn, ${participant.name} (@${participant.handle}). Stop votes: ${votes}/${room.participants.length}. If you are done, call the room_stop tool — only the tool call counts.${extra}`,
          resume: true,
        })
      } catch (error) {
        log("synthetic failed", String(error))
        turn.finish({ ok: false, error: "synthetic" })
        return { ok: false, error: "synthetic" }
      }

      // The turn may be queued rather than running: session.wait() resolves
      // immediately on an idle session, so first make sure an execution
      // actually started for this turn.
      const began = await Promise.race([
        executionStarted(sessionID, startedBefore, START_GRACE_MS),
        turn.promise.then(() => false as const),
      ])
      if (!began && !turn.done) {
        turn.finish({ ok: false, error: "execution-not-started" })
        log("turn never started", keyOf(participant))
        return { ok: false, error: "execution-not-started" }
      }
      // If the waiter fired on the gate race above, it resolves immediately
      // in the race below (interrupt/timeout/failure paths).

      // `session.wait()` is the authoritative completion signal; the waiter
      // only carries interruption/timeout/execution-failure. Racing them means
      // an unrelated execution on this session can no longer satisfy the turn.
      const settled = await Promise.race([
        ctx.session
          .wait({ sessionID })
          .then(() => ({ via: "wait" as const, ok: true }))
          .catch((error) => ({ via: "wait" as const, ok: false, error })),
        turn.promise.then((finished) => ({ via: "waiter" as const, finished })),
      ])
      if (settled.via === "waiter") {
        if (settled.finished.error === "timeout") await ctx.session.interrupt({ sessionID }).catch(() => undefined)
        return { ok: false, error: settled.finished.error ?? "failed" }
      }
      if (!settled.ok) {
        // session.wait() itself failed (transport/API error): stop the
        // execution instead of hanging until the waiter's timeout.
        log("session.wait failed", String((settled as any).error))
        turn.finish({ ok: false, error: "failed" })
        await ctx.session.interrupt({ sessionID }).catch(() => undefined)
        return { ok: false, error: "failed" }
      }
      // wait() succeeded; give a just-delivered interrupted/failed event a
      // short window to overrule the success signal.
      const late = await Promise.race([
        turn.promise.then((finished) => (finished.ok ? undefined : finished)),
        sleep(FAILURE_GRACE_MS).then(() => undefined),
      ])
      if (late) {
        if (late.error === "timeout") await ctx.session.interrupt({ sessionID }).catch(() => undefined)
        return { ok: false, error: late.error ?? "failed" }
      }
      turn.finish({ ok: true })
      // The reply must be a *fresh* assistant message: falling back to an
      // older one would replay handoffs from a previous participant's text.
      // A turn whose reply never lands, or that ends in tool calls with no
      // visible reply, counts as failed — the consecutive-failure cap keeps a
      // silent model from looping the room forever.
      const fresh = await freshReply(sessionID, baseline)
      if (!fresh) {
        log("no fresh reply", keyOf(participant))
        return { ok: false, error: "no-answer" }
      }
      const text = assistantText(fresh)
      if (!text) return { ok: false, error: "no-answer" }
      return { ok: true, text }
    }

    async function runChain(sessionID: string, generation: number): Promise<ChainEnd> {
      const room = await roomOf(sessionID)
      if (!room || room.paused) return "paused"
      if (disposed) return "user"

      const messages = await ctx.session.context({ sessionID })
      const previous = lastAssistant(messages)
      let speaker = previous?.model ? keyOf(previous.model) : undefined
      let text = assistantText(previous)

      const spoken = new Map<string, number>()
      if (speaker) spoken.set(speaker, 1)

      let turns = 0
      let failures = 0
      while (room.maxTurns === 0 || turns < room.maxTurns) {
        if (disposed) return "user"
        if (generations.get(sessionID) !== generation) return "user"
        const fresh = await roomOf(sessionID)
        if (!fresh || fresh.paused) return "paused"
        if (votedAll(sessionID, fresh)) return "voted"

        const next = pick(fresh, text, speaker, spoken)
        if (!next) return "no-candidates"

        log("turn", `${turns + 1}/${fresh.maxTurns || "∞"}`, keyOf(next))
        if (!(await idle(sessionID))) return "idle"
        const result = await speak(sessionID, next, fresh)
        turns += 1
        if (!result.ok) {
          log("turn failed", keyOf(next), result.error)
          if (result.error === "interrupted") return "user"
          if (result.error === "timeout") return "failure"
          // A turn that never started or produced no answer must not be retried
          // in a loop: that only queues more synthetic turns.
          if (result.error === "no-answer" || result.error === "execution-not-started") return "failure"
          // A persistently broken participant (switch-model/synthetic/turn
          // errors return immediately) must not spin the chain forever.
          failures += 1
          spoken.set(keyOf(next), 2)
          speaker = keyOf(next)
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            log("chain stopped", `${failures} turn failures in a row`)
            return "failure"
          }
          continue
        }
        failures = 0

        spoken.set(keyOf(next), (spoken.get(keyOf(next)) ?? 0) + 1)
        speaker = keyOf(next)
        text = result.text
        if (votedAll(sessionID, fresh)) return "voted"
      }

      return "limit"
    }

    async function cancelQueuedTurns(sessionID: string) {
      try {
        const list: any = await api(`/api/session/${sessionID}/inbox`)
        for (const item of list?.data ?? []) {
          if (item?.type !== "synthetic") continue
          const text = String(item?.payload?.text ?? "")
          if (!text.startsWith("[room]")) continue
          const id = item.id ?? item.inboxID
          if (id) await api(`/api/session/${sessionID}/inbox/${id}`, { method: "DELETE" })
        }
      } catch {}
    }

    async function cancelAllForms(sessionID: string) {
      try {
        const list: any = await api(`/api/session/${sessionID}/form`)
        for (const form of list?.data ?? []) {
          if (form?.id) await api(`/api/session/${sessionID}/form/${form.id}`, { method: "DELETE" }).catch(() => undefined)
        }
      } catch {}
    }

    async function stopRoom(sessionID: string) {
      generations.set(sessionID, (generations.get(sessionID) ?? 0) + 1)
      stopVotes.delete(sessionID)
      continueRequests.delete(sessionID)
      cancelContinueForms(sessionID)
      await ctx.session.interrupt({ sessionID }).catch(() => undefined)
      await cancelQueuedTurns(sessionID)
      await cancelAllForms(sessionID)
    }

    function cancelContinueForms(sessionID: string) {
      for (const [id, pending] of continueForms) {
        if (pending.sessionID !== sessionID) continue
        continueForms.delete(id)
        void api(`/api/session/${sessionID}/form/${id}`, { method: "DELETE" }).catch(() => undefined)
      }
    }

    async function openContinueForm(sessionID: string, reason: ChainEnd, generation: number) {
      if (disposed) return
      try {
        if (generations.get(sessionID) !== generation) return
        const room = await roomOf(sessionID)
        if (!room || room.paused || running.has(sessionID)) return
        cancelContinueForms(sessionID)
        const created: any = await api(`/api/session/${sessionID}/form`, {
          method: "POST",
          body: JSON.stringify({
            title: "Multi-agent room",
            metadata: { kind: "question" },
            fields: [
              {
                key: "action",
                title: reason === "voted" ? "All participants voted to stop" : "Turn limit reached",
                description: "Continue the discussion?",
                type: "string",
                required: true,
                options: [
                  { value: "continue", label: "Continue", description: "Start another chain of turns" },
                  { value: "stop", label: "Stop", description: "Leave the room idle" },
                ],
              },
            ],
          }),
        })
        const form = created?.data ?? created
        if (form?.id) continueForms.set(form.id, { sessionID, generation })
      } catch (error) {
        log("continue form failed", String(error))
      }
    }

    async function startChain(sessionID: string) {
      if (disposed) return
      if (running.has(sessionID)) {
        deferred.add(sessionID)
        return
      }
      const room = await roomOf(sessionID)
      if (!room || room.paused) return
      if (votedAll(sessionID, room)) return
      if (!(await idle(sessionID))) return
      if (disposed) return
      // Drop synthetic turns queued by a previous (possibly reloaded) chain.
      await cancelQueuedTurns(sessionID)
      running.add(sessionID)
      const generation = generations.get(sessionID) ?? 0
      let reason: ChainEnd | undefined
      try {
        reason = await runChain(sessionID, generation)
      } catch (error) {
        log("chain failed", String(error))
      } finally {
        running.delete(sessionID)
        const next = deferred.delete(sessionID)
        if (next) {
          setTimeout(() => void startChain(sessionID), 250)
        } else {
          const end = reason
          if (end === "limit" || end === "voted" || end === "no-candidates") {
            setTimeout(() => void openContinueForm(sessionID, end, generation), 300)
          }
        }
      }
    }

    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const data: any = (event as any).data
          const sessionID: string | undefined = data?.sessionID
          if (!sessionID) continue

          switch ((event as any).type) {
            case "session.execution.started": {
              busy.add(sessionID)
              startedCount.set(sessionID, (startedCount.get(sessionID) ?? 0) + 1)
              break
            }
            case "session.inbox.enqueued": {
              if (data.item?.type === "user") {
                lastInput.set(sessionID, "user")
                generations.set(sessionID, (generations.get(sessionID) ?? 0) + 1)
                stopVotes.delete(sessionID)
                cancelContinueForms(sessionID)
                continueRequests.delete(sessionID)
              } else if (data.item?.type === "synthetic") {
                lastInput.set(sessionID, "synthetic")
              }
              break
            }
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted": {
              busy.delete(sessionID)
              const type = (event as any).type
              const ok = type === "session.execution.succeeded"
              const error = ok
                ? undefined
                : type === "session.execution.interrupted"
                  ? "interrupted"
                  : (data?.error?.message ?? "failed")
              // Normal completion is awaited via session.wait() in speak();
              // resolving waiters on success too would let an unrelated
              // execution on this session satisfy a pending turn.
              if (!ok) {
                for (const waiter of [...(waiters.get(sessionID) ?? [])]) waiter({ ok, error })
              }
              if (lastInput.get(sessionID) === "user") {
                lastInput.delete(sessionID)
                void startChain(sessionID)
              }
              break
            }
            case "form.replied": {
              const pending = pendingForms.get(data.id)
              if (pending) {
                pendingForms.delete(data.id)
                const selected = pending.keys.flatMap((key) => {
                  const value = data.answer?.[key]
                  if (Array.isArray(value)) return value.filter((item: unknown): item is string => typeof item === "string")
                  if (typeof value === "string") return [value]
                  return []
                })
                // A one-model answer still makes sense: add the session's current
                // model as the second participant.
                if (selected.length === 1) {
                  const session = await ctx.session.get({ sessionID: pending.sessionID }).catch(() => undefined)
                  const key = session?.model ? `${session.model.providerID}/${session.model.id}` : undefined
                  if (key && key !== selected[0]) selected.push(key)
                }
                if (selected.length >= 2) {
                  await applyRoom(pending.sessionID, selected, pending.config).catch((error) =>
                    log("form apply failed", String(error)),
                  )
                }
                break
              }

              const cont = continueForms.get(data.id)
              if (!cont) break
              continueForms.delete(data.id)
              const raw = data.answer?.action
              const action = Array.isArray(raw) ? raw[0] : raw
              if (action !== "continue") {
                await stopRoom(cont.sessionID)
                break
              }
              if (generations.get(cont.sessionID) !== cont.generation) break
              if (running.has(cont.sessionID)) break
              const room = await roomOf(cont.sessionID)
              if (!room || room.paused) break
              stopVotes.delete(cont.sessionID)
              continueRequests.add(cont.sessionID)
              void startChain(cont.sessionID)
              break
            }
            case "form.cancelled": {
              pendingForms.delete(data.id)
              continueForms.delete(data.id)
              break
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) log("event stream stopped", String(error))
      }
    })()

    log("ready in", ctx.location.directory)

    return () => {
      disposed = true
      controller.abort()
      cache.clear()
      waiters.clear()
      startedCount.clear()
      stopVotes.clear()
      continueRequests.clear()
      continueForms.clear()
    }
  },
})
