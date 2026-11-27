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
