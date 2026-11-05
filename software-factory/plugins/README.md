# Plugins

An adapter that needs npm packages is a plugin (decision 0004 point 5, #405). Each one is a folder here:

```
plugins/<name>/
  package.json    its own, pinned dependencies (and a bun.lock)
  index.ts        the entry: implements a core interface; the core imports only types from it
  tests/          its own tests; bun tools/run_tests.ts runs them
```

`<name>` is lowercase letters, digits and dashes, starting with a letter. Only files in this folder may import the
plugin's packages (`bun tools/check_skills.ts`). The release bundles `index.ts` and its packages into one file,
`hooks/plugins/<name>.js`, with the factory version on its first line (`tools/build_plugins.ts`); the sources are not in
the release. The core loads a plugin by name with `hooks/factory_plugins.ts`: the bundle, else this source (install its
packages with `bun install --frozen-lockfile` in its folder). See the plugins paragraph on the wiki's
[updating page](../docs/wiki/updating.md).

The plugins:

- `nats` (#409): the messaging port over NATS JetStream, and claims over its key-value bucket, for
  `messaging.transport: "nats"`. Its tests start a real `nats-server` (`brew install nats-server`, or a release binary);
  without one they are skipped and say so, and CI sets `FACTORY_REQUIRE_NATS=1` so a missing server fails instead.
  Each call runs the plugin's own file as a child Bun that connects, does the one thing and exits, because the port is
  synchronous and the NATS client is not.
