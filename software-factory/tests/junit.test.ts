// A JUnit XML report's summary (#637, part 2), as `factory attach ls` and the web UI show it: passed, failed and skipped,
// and the failures with their message and text. The parser is the factory's own (no package); what it can't read is
// said, never thrown.
import { expect, test } from "bun:test";
import { junitSummary } from "../hooks/factory_junit.ts";

test("testcases count once each: a failure or an error fails, a skipped skips, the rest pass; the failures are listed", () => {
  const s = junitSummary(`<?xml version="1.0" encoding="UTF-8"?>
<!-- made by a runner -->
<testsuites name="all" time="1.25">
  <testsuite name="login" tests="3">
    <testcase classname="login" name="signs in" time="0.1"/>
    <testcase classname="login" name="remembers &quot;me&quot;"><failure message="expected 1 &lt; 2" type="AssertionError"><![CDATA[at a <b> & c]]></failure></testcase>
    <testcase classname="login" name="later"><skipped message="not now"/></testcase>
  </testsuite>
  <testsuite name="cart"><testcase name="pays"><error message="boom">trace &#x41;</error><system-out>x</system-out></testcase></testsuite>
</testsuites>`);
  expect(s).toMatchObject({ ok: true, tests: 4, passed: 1, failed: 2, skipped: 1, seconds: 1.25 });
  expect(s.failures).toEqual([
    { suite: "login", name: 'remembers "me"', classname: "login", kind: "failure", message: "expected 1 < 2", text: "at a <b> & c" },
    { suite: "cart", name: "pays", classname: "", kind: "error", message: "boom", text: "trace A" },
  ]);
});

test("a single testsuite as the root, and namespaced or self-closing tags, read the same", () => {
  expect(junitSummary(`<testsuite name="one"><testcase name="a"/><testcase name="b"></testcase></testsuite>`)).toMatchObject({ ok: true, passed: 2, failed: 0 });
});

test("a report with only the totals is read from its suites' attributes", () => {
  const s = junitSummary(`<testsuites><testsuite name="a" tests="10" failures="2" errors="1" skipped="3"/><testsuite name="b" tests="4"/></testsuites>`);
  expect(s).toMatchObject({ ok: true, tests: 14, passed: 8, failed: 3, skipped: 3, failures: [] });
});

test("what isn't a JUnit report, or isn't well-formed, is said and not thrown", () => {
  expect(junitSummary("<testsuite><testcase></testsuite>")).toMatchObject({ ok: false, tests: 0 });
  expect(junitSummary("<testsuite><testcase></testsuite>").why).toContain("doesn't close the element that is open");
  expect(junitSummary("<html><body/></html>").why).toContain("Its root is <html>");
  expect(junitSummary("not xml at all").ok).toBe(false);
  expect(junitSummary('<testsuite name="x').ok).toBe(false);
  expect(junitSummary("<!-- open").why).toContain("comment isn't closed");
});

test("the failures listed stop at 200, and a failure's text at 4000 characters", () => {
  const many = Array.from({ length: 250 }, (_, i) => `<testcase name="t${i}"><failure>${"x".repeat(5000)}</failure></testcase>`).join("");
  const s = junitSummary(`<testsuite>${many}</testsuite>`);
  expect(s.failed).toBe(250);
  expect(s.failures.length).toBe(200);
  expect(s.failures[0]?.text.length).toBe(4000);
});
