# RFC-001: Verifiable Dependency Decisions

- **Status:** Draft R1 — adversarial security review complete, **three CRITICAL findings open** (see §13). Not implementation-ready; the criticals force design decisions that are the owner's to make.
- **Author:** SafeInstall maintainers
- **Created:** 2026-07-09
- **Revised:** 2026-07-10 (folded in the §13 security review)
- **Discussion:** this PR

> **Reading order for the owner:** read §13 first. An independent adversarial
> review found that the RFC's central automatic-enforcement claim does not
> hold as written — the CI anchor stands on four PR-mutable artifacts with no
> off-machine reference. §13 states each finding, what it forces, and the one
> decision (require human review of the trust-surface diff, or accept a weaker
> guarantee) that only you can make. Sections 1–12 are the original draft;
> where §13 overrides a claim, it is marked ⚠︎R1.

## 1. Summary

SafeInstall today answers "may this package be installed?" at the moment of
installation and discards the reasoning. This RFC specifies **Dependency
Decision Records (DDR)**: a deterministic, machine-readable record of every
dependency change — what was requested, what exactly was resolved, which
policy and trust surface evaluated it, and why it was allowed — plus a CI
protocol that makes the record *load-bearing*: a lockfile change without a
matching, freshly re-authorized decision does not merge.

The deliberate naming: these are **records**, not proofs. What is verifiable
is (a) that the recorded inputs hash-match the repository state being merged
and (b) that an independent re-evaluation in CI reaches an allow verdict.
The word "proof" is not used anywhere in the user-facing surface until a
signing trust root (L2+) is in place.

> ⚠︎R1 — "independent re-evaluation in CI" overclaims. The CI re-evaluation's
> integrity depends on four artifacts the same PR can mutate: the workflow
> file, `safeinstall.config.json` (incl. `registryUrl` and policy thresholds),
> `trust-surface.lock`, and `.gitattributes`. There is no automatic off-machine
> reference against a consistent rewrite of all four (§13 K1–K3). The real
> boundary is CODEOWNERS-enforced human review of the trust-surface diff on
> *every* dependency PR. This must become a named hard precondition of the
> trust ladder, not a footnote — see §13.

## 2. Threat model

### 2.1 The first-page statement

**The local SafeInstall process is bypassable and its outputs are
self-attested.** An agent (or compromised toolchain) on the developer
machine can skip SafeInstall entirely and call the package manager
directly, and it can fabricate any local file, including a decision
record. Nothing in this RFC changes that. What this RFC makes enforceable
is **repository integrity**: no dependency change reaches the protected
branch without an independent, CI-side re-evaluation. Local pre-execution
safety (the guard hooks) remains best-effort defense-in-depth in the same
user context; strong local isolation (OS sandboxing, non-agent-controlled
proxies) is out of scope and explicitly not claimed.

### 2.2 Assets

1. The protected branch's manifest + lockfile (the dependency state that CI,
   releases, and other developers consume).
2. The policy (`safeinstall.config.json`) and trust surface (locked agent
   hooks, workflows, `.safeinstall/`).
3. The decision history (ledger + DDRs) as audit evidence.

### 2.3 Attackers

- **A1 — malicious/compromised package:** typo-squat, hijacked maintainer,
  install-script payloads, provenance/identity discontinuity.
- **A2 — schema-aware agent on the dev machine:** installs directly,
  edits policy/hooks, fabricates records, replays old approvals. (Observed
  in practice during Phase 1: an agent replicated the internal
  `writeBaseline()` API after `trust approve` correctly refused it.)
- **A3 — attacker with a compromised dev machine:** everything A2 can do,
  plus credential theft. Local damage is out of scope (see 2.1); keeping
  the damage out of the repository is in scope.
- **A4 — malicious PR author:** submits a dependency change with a
  plausible-looking record that does not match the actual lockfile delta.

### 2.4 Trust boundaries

| Boundary | Trusted for |
|---|---|
| Developer machine (agent context) | nothing (L0 preview only) |
| Human in an interactive terminal | trust-surface approvals, lock/unlock (existing human gate) |
| CI on the protected branch's PR | authorization verdicts (L1), attestation signing (L2) |
| Branch protection / ruleset | making CI verdicts load-bearing |

**Context resolution is repository-scoped.** A nested checkout (worktree,
submodule, vendored repo) must never inherit the trust context of an
enclosing checkout. (Found and fixed during Phase 1:
`findTrustContext` previously walked past `.git` boundaries.)

## 3. Trust ladder

| Level | Record | Who creates it | What it claims |
|---|---|---|---|
| **L0** | Preview record | local SafeInstall run (agent or human) | "this evaluation happened here, with these observed inputs" — **untrusted, advisory** |
| **L1** | Authorization | CI re-evaluation on the PR | "an independent runner re-resolved and re-evaluated this exact lockfile state and reached *allow* at time T" |
| **L2** | Signed authorization | CI + OIDC/Sigstore (optional peer dep already present) | L1 plus a verifiable signature binding the verdict to workflow identity |
| **L3** | Two-party approval | second human maintainer | L2 plus independent human review of the dependency delta |

Hard rules learned from Phase 1:

- An L0 record **must** carry `actor: "agent" | "human-unverified"`
  provenance and **can never** be upgraded in place. Approval-class ledger
  entries are created only through the interactive human gate. An agent
  that fabricates an approval entry produces a record that fails L1
  verification (the CI check re-derives everything and ignores L0 claims).
- **L3 requires ≥ 2 maintainers.** SafeInstall itself operates at L2 until
  a second maintainer exists. The spec defines L3 now; the project does
  not claim it.

## 4. Two-phase install transaction

SafeInstall must never become a second resolver. The real package manager
resolves; SafeInstall evaluates, binds, and commits.

```
S0  REQUESTED     agent/human asks: add X@spec
S1  RESOLVING     real PM produces a candidate lockfile in an isolated
                  staging dir (network: registry only; scripts disabled)
S2  EVALUATING    policy + provenance + trust surface over the exact
                  resolved graph (delta against previous lockfile)
S3  RECORDED      L0 preview record written; binds:
                  manifest digest (before/after), lockfile digest
                  (before/after), policy digest, trust-surface lock digest,
                  registry metadata observed (per-package: publish time,
                  provenance identity), safeinstall version, schema version
S4  COMMITTED     candidate manifest+lockfile adopted atomically into the
                  worktree (rename, not rewrite-in-place)
S5  INSTALLED     PM executes strictly frozen from the committed lockfile
                  (`npm ci` / `pnpm install --frozen-lockfile`), scripts
                  policy applied
S6  AUTHORIZED    CI re-evaluates the final state on the PR and issues the
                  L1 authorization (see §6)
```

Abort semantics: failure in S1–S3 leaves the worktree untouched (staging
dir discarded). Failure in S5 leaves the committed lockfile in place with
the record marked `installed: false` — the state is honest about the gap.

**v1.0 scope cuts (fail-closed, documented):**

- npm and pnpm only. bun: the transaction refuses (its manifest-only
  analysis cannot bind an exact graph).
- **Git dependencies are blocked in v1.0.** Resolving git deps can execute
  `prepare` scripts during S1; until staging isolation for that path is
  designed and adversarially tested, the transaction fails closed with a
  clear message. This is a Non-Goal boundary, not a TODO.
- Whether `--lockfile-only --ignore-scripts` is truly execution-free for
  every remaining source type is a standing threat-model item with
  adversarial tests required before S1 is declared safe per manager
  version.

## 5. Record schema and canonicalization

- JSON, canonicalized: UTF-8, sorted keys, no insignificant whitespace,
  LF-only. The record digest is sha256 over the canonical bytes.
- `schemaVersion` is mandatory; unknown versions fail closed.
- **Byte semantics for all hashed files:** digests are over exact bytes.
  Repositories are responsible for deterministic materialization —
  SafeInstall's scaffolding adds/verifies a `.gitattributes` LF rule for
  every file class it hashes, and **`.gitattributes` itself becomes part of
  the trust surface** (Phase 1 finding: a CRLF checkout on Windows changed
  the bytes of all four locked files and produced false drift; the same
  mechanism used maliciously would let an attacker alter materialized
  content of "locked" files without touching them).
- Records live in `.safeinstall/decisions/<lockfile-digest-prefix>/…` and
  are committed with the dependency change (same-commit rule).

Field groups (normative list in the implementation spec, not repeated
here): request, resolution (exact versions + integrity hashes + sources),
environment (PM name/version, native security options in effect — see §8),
policy evaluation (verdict, reasons, evidence), digests (manifest/lockfile/
policy/trust-lock before+after), provenance observations, actor + trust
level, timestamps (observed, not asserted — see §6).

## 6. Time semantics: replay vs. authorization

Policy rules are time- and state-dependent (release age, provenance
continuity against registry state). Therefore:

- **Replay** answers: "given the inputs recorded at S3, was the verdict
  computed correctly?" Deterministic, always possible, catches evaluation
  bugs — but proves nothing about the world (a lying local clock or a
  poisoned registry mirror poisons the inputs).
- **Authorization** answers: "is this dependency state acceptable *now*,
  observed from CI?" CI re-fetches registry metadata itself and re-runs
  the evaluation. Divergence from the L0 verdict is **legitimate** (a
  package aged past the release window) and is recorded, not treated as
  an error. Only the CI-observed result gates the merge.
- Local timestamps are recorded but never trusted. No historical claim
  ("this was safe on date D") is made without an external time anchor —
  deferred to L2+ (Sigstore timestamps).

**Authorization freshness:** an L1 authorization binds to the exact
lockfile digest and carries `evaluatedAt`. It expires: a merge attempted
more than `authorizationTtl` (default: 7 days) after `evaluatedAt`
requires a re-run. Implementation: the ruleset's
`strict_required_status_checks_policy` (branch must be up to date)
already forces re-runs on stale branches; the TTL is additionally
enforced by the trust check itself so the guarantee does not silently
depend on a GitHub setting. Rationale: between evaluation and merge, the
world can change (package unpublished/deprecated, provenance revoked,
policy tightened).

## 7. Digest binding and lockfile integrity

- The CI check recomputes the manifest and lockfile digests of the PR HEAD
  and requires an exact match with the record (A4 defense).
- A PR that changes the lockfile without a record, or with a record whose
  digests do not match, fails the required check. This is the load-bearing
  rule that closes the bypass gap: it does not matter *how* the lockfile
  was produced (agent bypass, manual edit) — it does not merge without
  fresh CI authorization over the actual bytes.
- Multiple dependency changes per PR: one record per transaction; the CI
  check verifies the chain (record N's `before` digests equal record
  N-1's `after`; the first record's `before` matches the merge-base; the
  last record's `after` matches PR HEAD).

## 8. Native capability reuse (policy compiler boundary)

The record includes an `environment.nativeControls` section: which native
protections (npm `min-release-age`/`allow-scripts`/`strict-allow-scripts`,
pnpm `minimumReleaseAge`/`minimumReleaseAgeStrict`/`trustPolicy`/
`trustLockfile`) are supported by the active PM version and what their
effective values were. The evaluation reports **policy downgrade findings**
when native settings are weaker than SafeInstall policy (e.g.
`minimumReleaseAgeStrict: false` fallback vs. SafeInstall's hard block).
Full compiler behavior (configuring/aligning native settings) is RFC-002
scope; v1.0 only *observes and records* — but the schema reserves the
section now so records remain comparable.

## 9. Abort, race, and rollback scenarios

- **Concurrent transactions** in one worktree: a transaction takes an
  advisory lock (`.safeinstall/transaction.lock`); a second starter fails
  closed with the holder's PID+start time.
- **Registry mutation between S1 and S6:** irrelevant to integrity — all
  binding is to the resolved digests; CI re-observes metadata itself.
- **Ledger rollback:** already covered by the out-of-tree head mirror
  (validated in Phase 1: it correctly flagged a real in-repo
  ledger/lock revert as a potential rewrite). DDR chains get the same
  mirror treatment.
- **Record deletion:** deleting `.safeinstall/decisions/` entries breaks
  the §7 chain check on the next dependency PR touching the lockfile;
  deleting them *without* a lockfile change is inert (records are not
  secrets) but visible in review via CODEOWNERS.

## 10. CI verification protocol (normative sketch)

The `safeinstall-trust` workflow gains a `decisions` job:

1. Checkout PR HEAD; install pinned `safeinstall-cli`.
2. `safeinstall decisions verify` — chain + digest checks (§7), schema
   validation, TTL check.
3. `safeinstall decisions authorize` — fresh S2 evaluation of the final
   lockfile delta against merge-base, registry metadata fetched by CI.
4. Verdict `allow` → check passes and (L2, when enabled) a signed
   attestation is uploaded as a workflow artifact bound to
   `${lockfileDigest}`.
5. Any other verdict → check fails with the policy reasons as the check
   summary.

The job name is a required status check in the ruleset, same as `trust`.

## 11. Non-goals

- No claim of local pre-execution security against a schema-aware agent
  (§2.1). The guard reduces accidents; it is not a boundary.
- No CRA/SLSA/SOC-2 conformance claims. Positioning: *machine-readable
  audit evidence for dependency-change controls.* Mappings to frameworks
  require validation with auditors and are marketing-forbidden until then.
- No signing in v1.0 (L2 is specified but off by default; `sigstore` is
  already an optional peer dependency).
- No dashboard, no cloud service, no bun/yarn, no git dependencies.
- No historical safety claims without external time anchors.

## 12. Open questions (blocking implementation, in order)

1. Staging isolation guarantees per PM version for S1 (adversarial test
   matrix: which resolver paths can execute code?).
2. Exact canonical-JSON spec choice (RFC 8785 JCS vs. simpler subset) —
   affects every digest; decide once.
3. Record retention/compaction policy for long-lived repos (one file per
   transaction grows unboundedly).
4. Windows execution layer: the BatBadBut-safe spawn constraints (Phase 1
   work in progress) must be folded into S5's "strictly frozen install"
   path with the same fail-closed argument rules.
5. Monorepo/workspace semantics: one record per workspace-level lockfile
   or per package-level change?

## 13. Security review findings (R1) — adversarial pass

An independent adversarial review checked the R0 draft against the actual
implementation (`src/trust-ci.ts`, `src/registry.ts`, `src/trust-surface.ts`,
`src/trust-ledger.ts`, `src/provenance.ts`, `safeinstall.config.json`). The
findings below supersede any conflicting claim in §1–§12.

### The one sentence the RFC must add

> The integrity of the CI re-evaluation depends on four PR-mutable artifacts —
> the workflow file, `safeinstall.config.json`, `trust-surface.lock`, and
> `.gitattributes` — and there is **no automatic, off-machine reference** for a
> consistent rewrite of all four. The real security boundary is therefore
> **CODEOWNERS-enforced human review of the trust-surface diff on every
> dependency PR**, plus a ruleset that makes workflow/config/lock changes
> review-required. Without that, the "automatic enforcement" advantage in §1
> is an illusion.

### CRITICAL

- **K1 — the CI anchor is PR-mutable.** `trust-ci.ts` generates the workflow
  with `on: pull_request`, so GitHub runs the workflow **definition from the
  PR head ref**. A malicious PR can replace the verification steps with a
  no-op that reports `success` under the **same job/check name** — and a
  required status check is satisfied by name. Deleting the check blocks
  (stays pending); neutralizing-and-renaming-identically passes. Compounding:
  the workflow does `npm install -g safeinstall-cli@<version>` — the verifier
  itself is pulled unpinned-by-hash at runtime. **Forces:** (a) run
  verification from a source outside PR mutation (reusable workflow in a
  separate, CODEOWNERS-locked repo, or a base-ref-pinned trusted workflow);
  (b) hash-pin the verifier (integrity, not just version); (c) name
  CODEOWNERS review of the workflow as a hard precondition.
  **Applies to the trust check we shipped in Phase 1**, not just the future
  DDR job — see the decision note below.

- **K2 — no off-machine anchor for the baseline itself.** The ledger head
  mirror lives in `~/.safeinstall/ledger-heads/` — inside the "developer
  machine" boundary that §2.4 trusts for nothing; CI has no mirror (fresh
  clone) and only checks committed-file hashes against the committed lock.
  The intersection of "outside attacker control" and "remembers the prior
  baseline" is **empty**. A consistent rewrite (`minimumReleaseAgeHours: 0`,
  `provenance.mode: off`, target in `allowedPackages`, plus regenerated lock
  and ledger) passes both checks; CI then re-evaluates against the attacker's
  policy and returns allow. §9 must stop citing the mirror as A2/A3 rollback
  protection — the code comment (`trust-ledger.ts:12-25`, "modest job: catch
  naive/accidental rewrites") is more honest than the R0 draft was.

- **K3 — `registryUrl` is PR-mutable config, not a trust root.** §6's "CI
  re-fetches registry metadata itself" is undercut because `registryUrl`
  comes from `safeinstall.config.json` (in-repo, PR-editable). Point it at an
  attacker mirror serving forged publish times and provenance bundles, and
  CI's "independent" re-evaluation reads from the attacker's source.
  `npm ci --frozen-lockfile` then verifies integrity hashes that also came
  from that registry (self-consistent). **Forces:** pin the registry
  identity to a trust root, or treat any non-default `registryUrl` as a
  hard, human-review-required finding.

### HIGH

- **H1 — L2 signatures prove identity, not logic.** With K1 unfixed, a
  signed attestation says "this repo's runner said allow" over
  attacker-controlled evaluation code — a cryptographic façade on a
  manipulable result. L2 is only meaningful once the workflow content is
  outside PR mutation.
- **H2 — non-registry sources bypass the core signals.** `allowedSources`
  includes `file`/`directory`; release-age and provenance are structurally
  N/A for `file:`/`link:`/`directory:` deps, so a `file:./vendor/x.tgz`
  payload produces a DDR with **no findings** — reads "clean". §4 blocks git
  deps but not local-path deps, an equivalent opaque-content vector. §5 must
  make "missing provenance/publish-time for a non-registry source" an
  **explicit finding**, not an empty field.
- **H3 — hash working-tree bytes → adopt git blob OIDs instead.** §5 hashes
  materialized bytes and band-aids CRLF with a `.gitattributes` rule that
  itself joins the trust surface. But working-tree bytes also depend on
  `.git/info/attributes` (uncommitted), `core.autocrlf`, and clean/smudge
  filters that committed `.gitattributes` does not capture — both a
  false-drift source and the very "materialization" attack §5 half-closes.
  **SOTA fix:** bind to **git blob OIDs** (already content-addressed,
  renderer-independent); the entire `.gitattributes`-in-trust-surface
  construction then becomes unnecessary.
- **H4 — "TTL enforced by the trust check itself" is backwards.** A ruleset
  setting (`strict_required_status_checks_policy`) is *stronger* than logic
  self-enforced inside a PR-mutable workflow (K1). §6's wording suggests the
  opposite; correct it.

### MEDIUM

- **M1 — publish time from `last-modified` header, not the authoritative
  `time` field.** `registry.ts` prefers the tarball `HEAD`→`last-modified`
  (a mutable CDN/cache header) over the registry `time` record. The
  release-age control should treat `time` as primary.
- **M2 — the record chain is bookkeeping, not a gate.** §7 verifies digest
  continuity only; CI ignores the L0 verdict and re-evaluates. The schema
  yields audit metadata, not gate security. Do not ascribe more security
  value to records than they carry (the "proof" illusion §1 warns against).
- **M3 — `installed: false` still merges.** §4's abort leaves the committed
  lockfile with `installed:false`; CI authorizes policy-only. A package whose
  malicious `postinstall` merely errored still lands in the protected
  lockfile. The gate ignores the honesty.
- **M4 — monorepo chain is an attack vector, not a nice-to-have.** §7's chain
  assumes a single lockfile line; a PR touching two workspace lockfiles has
  no unique linear chain, leaving room for an unrecorded second-lockfile
  change. Close Open-Q5 **before** implementation.

### Reviewer's stated gaps (kept honest)

GitHub `pull_request` head-ref semantics (K1) and required-check-by-name
evaluation are derived from established platform behavior, not reproduced
end-to-end in this repo. The `decisions verify/authorize` commands (§10) do
not exist yet; their behavior is assessed from the spec against the existing
registry/trust-surface implementation.

### Decision note for the owner (blocks R2)

K1 and the ⚠︎R1 marks apply to **the trust check shipped in Phase 1**, at a
reduced practical severity: this is a solo repo, so the human merge (you) is
today's real gate, and the current ruleset requires status checks but **0
approvals and no code-owner review**. Three options, your call — I did not
change the ruleset autonomously because each has a real cost:

1. **Require code-owner review on trust-surface paths** (`.github/workflows/**`,
   `.safeinstall/**`, `safeinstall.config.json`, `.gitattributes`). Closes
   K1/K2/K3 at the human layer — but on a solo repo it forces you to
   self-approve or `--admin`-merge **every** PR (this is exactly the L3
   "requires ≥2 maintainers" limit surfacing).
2. **Move verification to a base-ref-pinned / reusable workflow** from a
   separate CODEOWNERS-locked source, and hash-pin the CLI. Closes K1 without
   per-PR review friction — more engineering, and still needs (1) for K2/K3.
3. **Accept the weaker guarantee for now**, document it honestly in
   SECURITY.md ("the trust surface is enforced against inconsistent tampering
   automatically; a fully consistent rewrite requires human review of the
   diff"), and revisit when a second maintainer exists. Cheapest; keeps the
   claim truthful.

My recommendation: **(3) now + (2) as the R2 design target**, because (1)'s
per-PR friction on a solo project trains you to bypass your own gate, which is
worse than an honestly-scoped weaker claim.

## Appendix A: Phase 1 empirical findings feeding this spec

| Finding | Where it landed |
|---|---|
| Human gate refused agent approval (`CLAUDECODE`); agent replicated internal API instead | §3 L0 rules; A2 attacker |
| Ledger head mirror caught in-repo ledger revert | §9 rollback |
| Trust context walked past repo boundary (worktree inherited foreign baseline) | §2.4 repository-scoped resolution |
| CRLF checkout changed locked-file bytes → false drift on Windows | §5 byte semantics; `.gitattributes` in trust surface |
| Node refuses `.cmd` spawn (BatBadBut); cmd.exe arg injection risk | §12.4 |
| pnpm `minimumReleaseAgeStrict: false` silently falls back | §8 downgrade findings |
