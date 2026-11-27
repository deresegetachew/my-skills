# agy worker

How to run `agy` headless, read its JSON result, and its known limits.

## Running headless

```bash
agy --agent <role> \
  --model <model> \
  --settings claude-agent-crew/workers/agy/plugin/settings.worker.json \
  --output-format json \
  -p "<brief>"
```

Always pass `--model`.

## Model tiers

| Tier | Model | Use for |
| --- | --- | --- |
| Cheap | `gemini-3.8-flash-medium` | Cheap, fast work (`design-check`, `researcher`) |
| Workhorse | `gemini-4-hydrogen-medium` / `gemini-4-hydrogen-high` | Standard coding, testing, reviews, journeys |
| Heavy | `gemini-4-carbon-medium` | Hard reasoning only (`designer`, complex design) |

## Quota

The Mac and dev PC share one Gemini quota (5-hour and weekly). Check remaining quota with:

```bash
agy -p /usage
```

## Proven facts and limits (27 Nov)

- `--agent <role> --output-format json` runs headless.
- Agent frontmatter must set `mainAgent: true` to be launched via `agy --agent <name>`.
- Read-only tools are `view_file`, `grep_search`, and `find_by_name` (a wrong tool name can hang an agent).
- `PreToolUse` hooks receive JSON with `cwd`, `toolCall.name` (`"run_command"`), `toolCall.args.CommandLine`, and `lastUserInput`.
- A `PreToolUse` hook must **always** exit `0` and print JSON: `{"decision":"allow"}` to allow (an empty `{}` is treated as a refusal), or `{"decision":"deny","reason":"..."}` to refuse.
- Deny rules in settings match by command prefix (e.g. `command(git push)`); regex rules did not match.

## Agent tools (found in the remanual pilot, 27 Nov)

- **Every agent names its tools.** An agent without a `tools:` list gets only agy's small hosted set: `read_file`,
  `send_message`, `schedule`, `generate_image`, `manage_task` and `search_web`. It has no terminal and cannot edit
  files.
- **The names are:** `read_file`, `edit_file`, `write_file`, `run_command` and `search_web`.
- **agy runs hooks with a short PATH,** so the guard hook puts `$HOME/.bun/bin` on it. When the hook cannot run,
  agy refuses the command. That fails closed.
- **After changing the plugin, reinstall it on each machine:**
  `agy plugin install <my-skills>/claude-agent-crew/workers/agy/plugin`.
