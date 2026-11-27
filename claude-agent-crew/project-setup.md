# Project setup (`/crew setup`)

Run it on the first `/crew` in a project and whenever something looks wrong. It checks each step and only does
what is missing.

**Once ever (GitHub):** two GitHub Apps under the human's account, never their personal token:
- `crew-writer`: Contents, Pull requests and Issues read/write, Metadata read; no Administration. Builders push
  branches and open PRs with it; the orchestrator files issues and merges with it once the rule allows.
- `crew-reviewer`: Contents read, Pull requests read/write (to post reviews), Commit statuses read/write (for the
  fallback check below), Metadata read. Reviewers and auditors post their verdict with it.

Workers never hold app keys. The token helper (built with `/crew setup`) runs as the orchestrator and hands each
job a 1-hour token for its role only, as `GH_TOKEN`. Builders' guards also refuse `gh pr merge`, so a builder
cannot merge even an approved PR. For a hard boundary, run crew jobs as a separate OS user that cannot read the
keys (see `machines.md`).
Create each from a manifest: open its page already filled in, the human clicks Create and Install; GitHub hands the
key back, so nobody copies secrets.

**Once per repo:**
1. Install both apps on the repo (or pick "All repositories" once).
2. The rule on main: a PR, one approval from someone other than the author, CI green, no bypass for anyone. This is
   the only step that uses the human's admin rights. If GitHub doesn't count an app's approval, `crew-reviewer`
   posts a required status check instead.
3. `AGENTS.md` at the root pointing every agent to `CLAUDE.md`, and `.agents/skills` linking to `.claude/skills`, so
   other agent CLIs find the project's rules and skills.
4. `.claude/crew.json` from `crew.example.json`: ask the human which worker and model fill each role, once.
   A role may set `"agent"` to reuse another role's agent definition with a different model, for example
   `"builder-strong": { "worker": "agy", "model": "claude-sonnet-5-5-medium", "agent": "builder" }`; without it the
   agent is the role's own name.
   A `claude` role may also set `"maxTurns"` (a whole number) and `"maxBudgetUsd"` (dollars) to cap each job, passed
   as `claude --max-turns` and `--max-budget-usd`; a job that hits a cap stops and its result says so.
5. `.crew/` in `.git/info/exclude`.

**Once per machine:** see `machines.md`.

Re-running: report what is in place, fix what is missing, and show a diff before changing an existing rule.
`/crew setup add <repo>` covers another repo; `/crew setup rotate` replaces the apps' keys.
