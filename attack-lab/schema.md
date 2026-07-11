# Attack-case manifest schema (v1)

One JSON file per case in `cases/`, named `<id>.json`. Every field is required
unless marked optional. Validation (`src/attack-lab.ts`) fails closed: an
unknown `schemaVersion`, a bad enum, or a missing field rejects the whole case.

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` | Manifest version. Unknown → fail closed. |
| `id` | string | Unique slug; must equal the filename without `.json`. |
| `title` | string | One-line human description of the attack. |
| `layer` | enum | The SafeInstall layer expected to catch it (or to be a limit of): `guard-parser`, `trust-surface`, `human-gate`, `release-age`, `provenance`, `decision-record`, `workflow-anchor`. |
| `attacker.prerequisites` | string[] | What the attacker must already have. |
| `attacker.goal` | string | What they achieve if the control fails. |
| `startingState` | string | Reproducible starting state (files, config, env). |
| `vulnerableVersion` | string | Version range where this was exploitable, or `n/a — defended by design`. |
| `defense` | enum | `defended` \| `documented-limit` \| `unpatched` (see README). |
| `expectedVerdict` | string | Machine-readable expected result: a verdict word (`deny`, `refuse`, `fail`) or a finding code. |
| `regressionTest` | string | Reference to the test that pins this in the normal suite. Must name a real `tests/…` file (or `safeinstall-verifier/…` for the external repo). |
| `disclosure` | enum | `public` \| `advisory-pending` \| `internal`. An `unpatched` + `public` case is a discipline error. |
| `decisionRecord` | string (optional) | The decision-record finding code this maps to, when applicable. |
| `provenance` | string | How it was discovered (manual, fuzz, `incident-<date>`, review). |

## Eval verdict

`evalCase` computes one `status` per case from the fields above:

- `defended` → `ok`
- `documented-limit` → `known-gap`
- `unpatched` → `regression`
- `unpatched` **and** `disclosure: public` → `discipline-error`

The runner and `tests/attack-lab.test.ts` fail on any `regression` or
`discipline-error`.
