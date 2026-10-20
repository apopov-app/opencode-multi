# opencode-multi

Multi-agent rooms for [OpenCode](https://opencode.ai) V2. Several models share
one normal session: they see the whole dialog and the tool history, pass the
floor with `@mentions`, and can vote to stop the discussion.

## Install

No npm release yet — install from GitHub:

```sh
opencode plugin add github:apopov-app/opencode-multi
```

For a project-local install, copy `.opencode/plugins/multi` into the project.

## Use

Open a session and run:

```
/multi-room
```

A native model picker appears (same form component as the built-in `question`),
grouped by provider. Pick at least two models and submit. The session becomes a
room:

- the first model answers your message as usual;
- the others take turns in the same session, so everyone sees everything;
- models can hand the floor to each other with `@handle`;
- `room_stop` lets each model vote to finish; when all vote, the room stops.
- `request_input` lets a model stop the chain immediately and wait for the user's
  reply when it needs a decision or information.

Commands:

```
/multi-room                      # model picker
/multi-room deepseek-v4.1-flash,glm-5.3-flash
/multi-room continue             # another chain without a new message
/multi-room pause | resume | off
```

In the TUI, `/multi` opens a searchable picker and a room menu.

## Configure

`.opencode/multi.json` (project) or `~/.config/opencode/multi.json` (global):

```json
{
  "maxTurns": 50,
  "turnsPerModel": 0,
  "turnTimeoutMs": 240000,
  "providers": "current"
}
```

- `maxTurns` / `turnsPerModel`: `50` / `0` by default. `maxTurns` is a safety cap
  against a runaway loop; `turnsPerModel` is unlimited. Set either to `0` to
  disable that cap.
- When a chain stops by itself (turn cap, all voted, no eligible turns), a
  Continue/Stop question appears in the composer dock (desktop and TUI).
- `turnTimeoutMs`: per-turn timeout for a hung provider (default 4 min).
- `providers`: `"current"` (models of the session's provider), `"all"` (tabs per
  provider), or an array of provider IDs.

## Notes

- The room is an ordinary session, so it works in the TUI, desktop and web, and
  each answer keeps the model attribution of the client.
- Stopping: interrupt/Esc, `/multi-room pause`, or a new user message.
- Editing the plugin's own files while a room is live reloads the plugin and
  stops the room.
- Desktop model visibility is best-effort: the plugin reads the desktop's
  `drafts.sqlite` when present and hides models marked `hide`.

## License

MIT
