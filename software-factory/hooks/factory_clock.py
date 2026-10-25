#!/usr/bin/env python3
"""One clock for the factory's scripts that write or judge times (agent pings, the heartbeat daemon, the sweep).

`now()` is the current time in seconds since 1970. When FACTORY_NOW is set to a number, that number is the time
instead, so a test can move time by hand and run hours of daemon cycles in a moment. Nobody sets it in real use."""
import os, time


def now():
    given = os.environ.get("FACTORY_NOW", "").strip()
    if given:
        try:
            return float(given)
        except ValueError:
            pass
    return time.time()
