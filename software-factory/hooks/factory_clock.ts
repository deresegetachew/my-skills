// One clock for the factory's scripts that write or judge times (agent pings, the heartbeat daemon, the sweep).
//
// `now()` is the current time in seconds since 1970. When FACTORY_NOW is set to a number, that number is the time
// instead, so a test can move time by hand and run hours of daemon cycles in a moment. Nobody sets it in real use.
import { toFloat } from "./factory_config.ts";

export function now(): number {
  const given = (process.env.FACTORY_NOW ?? "").trim();
  if (given) {
    const f = toFloat(given);
    if (f !== null) return f;
  }
  return Date.now() / 1000;
}
