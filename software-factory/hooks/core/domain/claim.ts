// A claim on a task (decision 0003, #377): one agent at a time holds a task. Claims can race (two loops, or one agent
// name on two machines); the claim that landed first since the last release wins, and every other claimant gives way.
// Plain rules, no I/O: an adapter turns its own records (comments, a claims file) into ClaimEvents.

/** Who claimed: an agent's name and its machine (null for a claim made before claims carried one). */
export interface Claim {
  agent: string;
  machine: string | null;
}

/** Who is claiming now. `pid` is for trackers whose claims live as long as a process (the plan file's). */
export interface Claimant {
  agent: string;
  machine: string;
  pid?: number | string;
}

/** What a tracker recorded about a task, oldest first: a claim, or a release (which a block also is). */
export type ClaimEvent = { claim: Claim } | { release: true };

/** The claims made since the last release, oldest first. */
export function standing(events: ClaimEvent[]): Claim[] {
  let out: Claim[] = [];
  for (const e of events) {
    if ("release" in e) out = [];
    else out.push(e.claim);
  }
  return out;
}

/** The claim that won: the earliest since the last release, or null when nobody holds the task. */
export function winner(events: ClaimEvent[]): Claim | null {
  return standing(events)[0] ?? null;
}

/** Whether `claim` is this agent on this machine. A claim without a machine (an older kit) matches by name alone, as
 * it always did; so does a machine that has no id. */
export function isMe(claim: Claim | null, agent: string, machine: string): boolean {
  if (!claim || claim.agent !== agent) return false;
  return !(claim.machine && machine && claim.machine !== machine);
}
