import { Plugin } from "@opencode/plugin/tui"
import { readFile } from "node:fs/promises"

/**
 * Multi-agent room (TUI side).
 *
 * `/multi` opens a model picker and creates a normal session tagged with
 * `metadata.multi`. The server plugin then makes the selected models take
 * turns in that one session, so the whole conversation stays in the usual
 * transcript.
 */

type Participant = {
  providerID: string
  id: string
  name: string
  handle: string
  variant?: string
}

type Model = {
  providerID: string
  modelID: string
  id: string
  name: string
  family?: string
  enabled: boolean
  capabilities?: { tools?: boolean }
}

const META = "multi"
const MAX_TURNS = 8
const TURN_TIMEOUT_MS = 240_000

type MultiConfig = {
  maxTurns?: number
  turnsPerModel?: number
  turnTimeoutMs?: number
}

// The server command reads .opencode/multi.json; the TUI must too, otherwise
// a room created through /multi silently ignores the user's configured limits.
async function readConfig(directory: string): Promise<MultiConfig> {
  for (const path of [`${directory}/.opencode/multi.json`, `${directory}/multi.json`]) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as MultiConfig
    } catch {}
  }
  return {}
}

const keyOf = (model: { providerID: string; modelID?: string; id?: string }) =>
  `${model.providerID}/${model.modelID ?? model.id}`

const data = <T,>(value: T): T => ((value as any)?.data ?? value) as T

function handleFor(model: Model, used: Set<string>) {
  const id = model.modelID || model.id
  const base =
    (id.split(/[-_.]/)[0] || model.family || "model")
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
  id: "multi.room.tui",
  setup(context) {
    const location = () => context.location ?? context.data.location.default()
    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ title: "Multi", message, variant })

    async function models(): Promise<Model[]> {
      const where = location()
      await context.data.location.model.sync(where)
      const list = (context.data.location.model.list(where) ?? []) as Model[]
      return list
        .filter((model) => model.enabled !== false && model.capabilities?.tools !== false)
        .sort((a, b) => a.providerID.localeCompare(b.providerID) || a.name.localeCompare(b.name))
    }

    function currentSession() {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    async function sessionInfo(sessionID: string) {
      const cached = context.data.session.get(sessionID)
      if (cached) return cached
      return data(await context.client.session.get({ sessionID }))
    }

    // Read-modify-write of metadata must not run on a stale cache: the server
    // plugin may have changed the room (pause, chain rewrites) in between.
    async function freshSession(sessionID: string) {
      try {
        await context.data.session.sync(sessionID)
      } catch {}
      return sessionInfo(sessionID)
    }

    async function roomOf(sessionID: string) {
      const session = await sessionInfo(sessionID)
      const room = (session?.metadata as any)?.[META]
      return room && Array.isArray(room.participants) && room.participants.length > 0 ? room : undefined
    }

    async function pick(selected: Participant[]) {
      const available = await models()
      if (available.length < 2) {
        toast("Need at least two models with tools enabled", "error")
        return undefined
      }

      const byKey = new Map(available.map((model) => [keyOf(model), model]))
      const chosen: Participant[] = selected
        .map((participant) => {
          const model = byKey.get(`${participant.providerID}/${participant.id}`)
          return model ? participant : undefined
        })
        .filter((participant): participant is Participant => Boolean(participant))

      for (;;) {
        const options = [
          {
            title: chosen.length >= 2 ? `▶ Start room — ${chosen.length} models` : `▶ Start room — pick ${2 - chosen.length} more`,
            value: "start",
            category: "Action",
            description: "Models take turns in one shared session",
          },
          {
            title: "✕ Cancel",
            value: "cancel",
            category: "Action",
            description: "Close without creating a room",
          },
          ...available.map((model) => {
            const key = keyOf(model)
            const index = chosen.findIndex((p) => `${p.providerID}/${p.id}` === `${model.providerID}/${model.modelID ?? model.id}`)
            return {
              title: `${index >= 0 ? `[${index + 1}] ✓` : "○"} ${model.name}`,
              value: key,
              category: model.providerID,
              description: `${model.modelID ?? model.id} · @${chosen.find((p) => p.providerID === model.providerID && p.id === (model.modelID ?? model.id))?.handle ?? handleFor(model, new Set(chosen.map((p) => p.handle)))}${index >= 0 ? " · speaks #" + (index + 1) : ""}`,
            }
          }),
        ]

        const value = await context.ui.dialog.select<string>({
          title: `Multi-agent room · ${chosen.length} selected`,
          placeholder: "Search models by name…",
          options,
        })

        if (value === undefined || value === "cancel") return undefined
        if (value === "start") {
          if (chosen.length < 2) {
            toast("Pick at least two models", "warning")
            continue
          }
          return chosen
        }

        const model = byKey.get(value)
        if (!model) continue
        const index = chosen.findIndex((p) => p.providerID === model.providerID && p.id === (model.modelID ?? model.id))
        if (index >= 0) chosen.splice(index, 1)
        else
          chosen.push({
            providerID: model.providerID,
            id: model.modelID ?? model.id,
            name: model.name,
            handle: handleFor(model, new Set(chosen.map((p) => p.handle))),
          })
      }
    }

    async function createRoom() {
      const participants = await pick([])
      if (!participants) return

      const config = await readConfig(location().directory)
      const first = participants[0]
      const title = `Multi · ${participants.map((p) => p.name).join(" + ")}`.slice(0, 120)
      const session = data(
        await context.client.session.create({
          title,
          model: { providerID: first.providerID, id: first.id },
          metadata: {
            [META]: {
              v: 1,
              participants,
              maxTurns: config.maxTurns ?? MAX_TURNS,
              turnsPerModel: config.turnsPerModel ?? 0,
              turnTimeoutMs: config.turnTimeoutMs ?? TURN_TIMEOUT_MS,
            },
          },
          location: { directory: location().directory },
        }),
      )

      const sessionID = (session as any)?.id
      if (!sessionID) {
        toast("Could not create the room", "error")
        return
      }

      try {
        await context.data.session.sync(sessionID)
      } catch {}
      context.ui.router.navigate({ type: "session", sessionID })
      toast(
        `${participants.length} models in the room (${participants.map((p) => "@" + p.handle).join(", ")}). Just type — ${first.name} answers first.`,
        "success",
      )
    }

    async function updateRoom(sessionID: string, patch: Record<string, unknown>) {
      const session = await freshSession(sessionID)
      const room = (session?.metadata as any)?.[META] ?? {}
      await context.client.session.update({
        sessionID,
        metadata: { ...(session?.metadata ?? {}), [META]: { ...room, ...patch } },
      })
      context.data.session.invalidate(sessionID)
    }

    async function openRoomMenu(sessionID: string, room: any) {
      const actions = [
        { title: "➕ Add or remove participants", value: "edit" },
        { title: room.paused ? "▶ Resume the room" : "⏸ Pause the room", value: "pause" },
        { title: "⏹ Turn multi-agent mode off", value: "off" },
        { title: "＋ New room…", value: "new" },
      ]
      const action = await context.ui.dialog.select<string>({
        title: `Multi-agent room · ${room.participants.length} models`,
        options: actions.map((item) => ({ ...item, category: "Room" })),
      })
      if (!action) return

      if (action === "new") return createRoom()

      if (action === "edit") {
        const participants = await pick(room.participants as Participant[])
        if (!participants) return
        await updateRoom(sessionID, { participants })
        toast(`Now ${participants.length} models in the room`, "success")
        return
      }

      if (action === "pause") {
        const paused = !room.paused
        await updateRoom(sessionID, { paused })
        if (paused) {
          await context.client.session.interrupt({ sessionID }).catch(() => undefined)
          toast("Room paused", "warning")
        } else toast("Room resumed", "success")
        return
      }

      if (action === "off") {
        const session = await freshSession(sessionID)
        const metadata: Record<string, any> = { ...(session?.metadata ?? {}) }
        delete metadata[META]
        await context.client.session.update({ sessionID, metadata })
        context.data.session.invalidate(sessionID)
        toast("Multi-agent mode is off for this session")
      }
    }

    async function run(input?: string) {
      const args = (input ?? "").trim()
      const sessionID = currentSession()

      // With arguments /multi behaves exactly like the server command, so the
      // same syntax works in every client.
      if (args) {
        if (!sessionID) return toast("Open a session first", "warning")
        await context.client.session
          .command({ sessionID, name: "multi-room", text: args })
          .then(() => {
            context.data.session.invalidate(sessionID)
            toast(`/multi-room ${args}`, "success")
          })
          .catch((error: any) => toast(error?.message ?? "Command failed", "error"))
        return
      }

      if (sessionID) {
        // Refresh before reading metadata: the cached room can be stale (the
        // server may have paused/resumed or the chain may have rewritten it).
        try {
          await context.data.session.sync(sessionID)
        } catch {}
        const room = await roomOf(sessionID)
        if (room) return openRoomMenu(sessionID, room)
      }
      return createRoom()
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "multi.room",
          title: "Multi-agent room",
          group: "Multi",
          palette: true,
          slash: { name: "multi", aliases: ["room"], arguments: true },
          run: (input) => run(input),
        },
      ],
      bindings: ["multi.room"],
    }))
  },
})
