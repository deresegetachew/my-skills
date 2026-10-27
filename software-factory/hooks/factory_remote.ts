#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Keeps the git remotes pointing at where the repository lives now.
//
// When a repository is moved or renamed on GitHub, the old address still works for reading (GitHub redirects it),
// but writes through the API answer `307` and fail. An agent then sees red errors on its own checkout and may
// decide the repository has moved somewhere it hasn't. The loop runs this at start and between tasks: it asks
// GitHub for each remote's current name and, when it differs, points the remote at it and says so in one line.
// Remotes are shared by every worktree of the repository, so one fix covers all the agents on the machine.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_remote.ts          check and fix; prints one line per remote it changed
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_remote.ts --check  only say what it would change (exit 1 if anything)
import { run, runMain } from "./factory_lib.ts";

const GITHUB = /^(?<pre>(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/])(?<owner>[\w.-]+)\/(?<repo>[\w.-]+?)(?<post>\.git)?\/?$/;

function sh(...args: string[]): [number, string] {
  const p = run(args);
  return [p.code, p.stdout.trim()];
}

/** The repository's full name as GitHub has it now (GET follows a move or a rename), or null when unknown. */
export function currentName(owner: string, repo: string): string | null {
  const [rc, out] = sh("gh", "api", `repos/${owner}/${repo}`, "--jq", ".full_name");
  return rc === 0 && /^[\w.-]+\/[\w.-]+$/.test(out) ? out : null;
}

/** [remote, old url, new url] for the GitHub remotes whose repository now has another name. */
export function fixes(): [string, string, string][] {
  const [rc, out] = sh("git", "remote");
  const found: [string, string, string][] = [];
  for (const remote of rc === 0 ? out.split(/\s+/).filter(Boolean) : []) {
    const [rc2, url] = sh("git", "config", "--get", `remote.${remote}.url`); // as written, before insteadOf
    const m = rc2 === 0 ? GITHUB.exec(url) : null;
    if (!m?.groups) continue;
    const { pre, owner, repo, post } = m.groups as { pre: string; owner: string; repo: string; post?: string };
    const now = currentName(owner, repo);
    if (now && now.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) found.push([remote, url, `${pre}${now}${post ?? ""}`]);
  }
  return found;
}

/** The URL with any credentials in it hidden, for printing (https://x-access-token:TOKEN@github.com/...). */
export function shown(url: string): string {
  return url.replace(/^((?:https?|ssh):\/\/)[^@/]+@/, "$1***@");
}

export function main(argv: string[]): number {
  const check = argv.includes("--check");
  const found = fixes();
  for (const [remote, old, now] of found) {
    if (check) console.log(`${remote} points at ${shown(old)}, but the repository is now ${shown(now)}.`);
    else if (sh("git", "remote", "set-url", remote, now)[0] === 0) {
      console.log(`The repository moved on GitHub: ${remote} now points at ${shown(now)} (was ${shown(old)}).`);
    }
  }
  return check && found.length ? 1 : 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
