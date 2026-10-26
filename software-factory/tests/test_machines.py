#!/usr/bin/env python3
"""Per-machine agent names and a machine id in claims (#45): the one check left in Python until factory_report is
ported (#252). Everything else is in machines.test.ts.  python3 software-factory/tests/test_machines.py"""
import os, sys

HOOKS = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))


def test_the_report_reads_claims_with_a_machine():
    sys.path.insert(0, HOOKS)
    import factory_report
    m = factory_report.CLAIM.search("<!-- factory-claim agent=menelik machine=mach-a -->")
    assert m and m.group(1) == "menelik"


# --- agent issues ------------------------------------------------------------------------------------------------


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
