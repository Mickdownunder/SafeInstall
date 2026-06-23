# Attack replay

This directory replays real npm supply-chain attacks against SafeInstall's
**actual policy engine** and reports which checks would have blocked the
install — and under which configuration.

```bash
pnpm replay            # list available attacks
pnpm replay mastra     # replay a specific attack
```

## How it works (and why it's honest)

The malicious package versions behind these attacks were removed from npm
shortly after disclosure, so a live `npm install` is impossible. Instead,
each attack folder reconstructs the **package metadata as it existed during
the attack window** — the lockfile shape, the dependency that was injected,
the publish timestamps, the install-script flags — from public incident
reporting.

The replay feeds that reconstructed state into the real, shipped engine
(`evaluatePackage`, `evaluateTransitiveDependencies`). **The verdicts are
produced by the actual code, not hardcoded.** A regression test
(`tests/replay.test.ts`) runs the same fixtures through the same engine, so
if a future change stops blocking a known attack, CI fails.

The replay is deliberately precise about which config each block requires
(default vs. opt-in). It will tell you when an attack is only caught with a
non-default setting, rather than overclaiming.

## Available attacks

### mastra (2026-06-17)

A dormant former-contributor account republished 143 `@mastra` packages in
84 minutes, each with one injected dependency: `easy-day-js`, a `dayjs`
typosquat whose `1.11.22` release carried a `postinstall` dropper.

SafeInstall blocks this **with default settings** via release-age (every
`@mastra` version was republished hours old; default minimum is 72h), and
additionally via transitive install-script detection (the `easy-day-js`
postinstall) when `transitive.mode` is enabled.

## Adding an attack

Create `attacks/<name>/` with:

- `attack.json` — metadata, the direct install descriptor, a fixed `now`
  timestamp, the lockfile filename, and source links.
- `<lockfile>` — a lockfile snapshot (`package-lock.json` or
  `pnpm-lock.yaml`) reflecting the attack-time dependency tree.

Then add a case to `tests/replay.test.ts` asserting the expected verdicts.
