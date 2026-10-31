// The cockpit's Ink screen (decision 0002, #365): the title and the sessions of a `factory cockpit --json` snapshot.
// It only draws what it is given; the snapshot is read by factory_cockpit.ts, so this file has no factory logic.
import { Box, Text } from "ink";
import type { ReactElement } from "react";

export type Session = { name: string; state: string; role: string; machine: string };

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The sessions of a snapshot; anything that isn't a list of rows is no sessions. */
export function sessionsOf(snapshot: unknown): Session[] {
  const rows = obj(snapshot).sessions;
  return (Array.isArray(rows) ? rows : []).map(obj).map((r) => ({
    name: str(r.name), state: str(r.state) || "unknown", role: str(r.role), machine: str(r.machine),
  }));
}

export function App({ snapshot }: { snapshot: unknown }): ReactElement {
  const sessions = sessionsOf(snapshot);
  const width = Math.min(Math.max(...sessions.map((s) => s.name.length), 4), 32);
  return (
    <Box flexDirection="column">
      <Text bold>cockpit (Ink)</Text>
      <Text dimColor>Sessions</Text>
      {sessions.length === 0 ? <Text>no sessions</Text> : null}
      {sessions.map((s, i) => (
        <Text key={`${s.machine}/${s.name}/${i}`}>
          {s.name.padEnd(width)}  {s.state}
          {s.role ? <Text dimColor>  {s.role}</Text> : null}
          {s.machine ? <Text dimColor>  on {s.machine}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}
