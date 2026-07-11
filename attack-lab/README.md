# SafeInstall Attack Lab

A machine-readable catalogue of attacks against SafeInstall, each pinned to the
layer expected to stop it and to a regression test in the normal suite. The lab
is **eval-system-first**: the schema, the runner, and the tests came before the
content, so "the catalogue" and "the tests that prove it" cannot drift.

## Layout

```
attack-lab/
  README.md            this file
  schema.md            the case-manifest schema (normative)
  cases/*.json         one file per attack case (id == filename)
  run.mjs              the runner (machine-readable results + summary)
src/attack-lab.ts      the eval logic (loader, validator, eval verdict)
tests/attack-lab.test.ts  the regression suite (validates + live-executes)
```

## Running

```sh
pnpm build
node attack-lab/run.mjs          # RESULT lines + SUMMARY
node attack-lab/run.mjs --json   # the full report as JSON
```

Or via the normal suite (also runs the live-defense checks):

```sh
pnpm test tests/attack-lab.test.ts
```

## What a case means

Every case declares a `defense` status, and the eval turns it into a verdict:

| `defense` | eval `status` | meaning |
|---|---|---|
| `defended` | `ok` | the shipped control stops it; a named regression test proves it |
| `documented-limit` | `known-gap` | the control does **not** stop it, and this is a stated, honest boundary (not a bug) |
| `unpatched` | `regression` | a real gap awaiting a fix — CI fails so it cannot sit silently green |

The runner exits non-zero on any `regression` or `discipline-error`.

## Disclosure discipline

An `unpatched` case marked `disclosure: public` is a **discipline error** — the
eval fails it. Exploit detail for an unpatched bypass must not be published
before a coordinated release + advisory (see [SECURITY.md](../SECURITY.md) and
issue #41). Keep such cases `internal` or `advisory-pending` until the fix
ships, then flip to `public`.

## The two honest limits

The lab deliberately carries cases SafeInstall does **not** defend, so the
project's limits are catalogued as first-class, executable facts rather than
buried in prose:

- **`incident-approval-fatigue`** — the human gate proves *presence*, not
  *informed consent*. An agent can dictate an approve ritual to a click-through
  user. Boundary: the diff shown at approve time and user education.
- **`workflow-consistent-rewrite-no-mirror`** — the RFC-001 §13 K2 residual: a
  fully consistent rewrite of policy + lock + ledger passes automated
  verification on any fresh clone. Boundary: human review of the trust-surface
  diff, which on a solo project is the merging owner (issue #41).

These are `documented-limit` / `known-gap`. A change that relabels either
"defended" without a real fix fails the regression suite.

## Adding a case

Drop a `cases/<id>.json` matching [schema.md](schema.md), point its
`regressionTest` at a real test that executes the defense, and run the suite.
For a newly discovered *unpatched* bypass: file it `internal` first, fix it,
release + advisory, then flip to `public`.
