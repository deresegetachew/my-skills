// The Add machine card's rules (#445, #504) that aren't drawing: what the confirm asks before the hub makes a join code, the
// agents it sends, and which problem text may be shown (the page names no command except the one join command the owner
// copies to the new machine). No React here, so tests/web_ui_machines.test.ts runs it as it is.
import type { ConfirmSpec } from "./parts_model.ts";

/** A machine's name, as the hub takes it (it names the machine's board login): lowercase letters, digits and dashes,
 * starting with a letter, up to 40. */
export const MACHINE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export interface PickedAgent {
  name: string;
  role: string;
}

/** What the page sends for the picked agents: each as `name:role`, the role as the team lists it. */
export function agentArgs(agents: PickedAgent[]): string[] {
  return agents.map((a) => (a.role ? `${a.name}:${a.role}` : a.name));
}

/** Adding a machine: a good name not in use yet and at least one agent. The hub makes a board login and a code; nothing starts. */
export function addMachineAsk(name: string, agents: PickedAgent[], taken: string[]): ConfirmSpec {
  const n = name.trim();
  const good = MACHINE_NAME.test(n);
  const free = !taken.includes(n);
  const who = agents.map((a) => a.name);
  const list = who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}` : (who[0] ?? "");
  return {
    title: `Add ${n || "a machine"}?`,
    checks: [
      { title: "The name uses lowercase letters, digits and dashes", met: good, ...(good ? {} : { sub: "Starting with a letter, like office-pc or mac-mini-2." }) },
      { title: "No machine has that name yet", met: free, ...(free ? {} : { sub: `${n} is already in the list.` }) },
      { title: "At least one agent is picked", met: agents.length > 0, ...(agents.length ? {} : { sub: "Pick who will run there." }) },
    ],
    happens: `The hub makes ${n || "the machine"} a login of its own to the message board, with only the board's rights, and a join code ` +
      `for ${list || "the agents you pick"}. The code works once, until it expires; if ${n || "the machine"} hasn't joined by then, its login is removed.`,
    doesNot: "Nothing is installed or started on the new machine until you run the join there. The agents here keep running.",
    action: "Make the join code",
    tone: "primary",
  };
}

const NAMES_COMMAND = /factory [a-z]|--[a-z]|`/;

/** A refusal as the card shows it: its own words when they name no command or flag, else a plain line in their place. */
export function plainProblem(message: string, fix: string): { message: string; fix: string } {
  return {
    message: NAMES_COMMAND.test(message) ? "The hub couldn't make the join code." : message,
    fix: NAMES_COMMAND.test(fix) ? "Check that this machine is the hub, then try again." : fix,
  };
}
