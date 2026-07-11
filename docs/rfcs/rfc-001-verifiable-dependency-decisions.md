# RFC-001: Verifiable Dependency Decisions

- **Status:** R2 — the trust-root questions R1 left open are **decided** (§14).
  Partially implemented: the base-branch-loaded, hash-pinned CI trust check
  shipped in 0.12.0; the external verifier repository and the decision-record
  commands are in progress against this revision.
- **Author:** SafeInstall maintainers
- **Created:** 2026-07-09
- **Revised:** 2026-07-11 (R2 — decisions folded in; shipped state reflected)
- **Discussion:** this PR

## Revision history

| Rev | Date | What changed |
|---|---|---|
| R0 | 2026-07-09 | Original draft |
| R1 | 2026-07-10 | Adversarial security review (§13); owner decision on the verifier model recorded |
| R2 | 2026-07-11 | Open trust-root questions decided with rationale (§14); shipped 0.12.0 state folded into §2/§3/§10; §5–§7 rewritten against blob-OID binding and RFC 8785 canonicalization; solo-maintainer residual made explicit (§3, §13) |

> **Reading order:** §14 holds the R2 decisions and their rationale — each
> §13 finding now carries a pointer to the decision that resolves (or
> deliberately accepts) it. §13 is preserved verbatim as the R1 audit trail;
> where a §1–§12 claim changed in R2, the section says so inline. External
> references to "§13" (SECURITY.md, workflow comments) remain valid.

## 1. Summary

SafeInstall today answers "may this package be installed?" at the moment of
installation and discards the reasoning. This RFC specifies **Dependency
Decision Records (DDR)**: a deterministic, machine-readable record of every
dependency change — what was requested, what exactly was resolved, which
policy and trust surface evaluated it, and why it was allowed — plus a CI
protocol that makes the record *load-bearing*: a lockfile change without a
matching, freshly re-authorized decision does not merge.

The deliberate naming: these are **records**, not proofs. What is verifiable
is (a) that the recorded inputs match the repository state being merged —
bound by git blob identity, §7 — and (b) that an independent re-evaluation
in CI reaches an allow verdict. The word "proof" is not used anywhere in the
user-facing surface until a signing trust root (L2+) is in place.

**Where the independence of the CI re-evaluation comes from (R2):** the
verification logic runs from sources a pull request cannot mutate — the
workflow definition is loaded from the protected base branch
(`pull_request_target`, shipped 0.12.0), the verifier CLI is pinned by
sha512 content hash (shipped 0.12.0), and the verification steps themselves
move into a separate, code-owner-locked repository referenced by full commit
SHA (§10, in progress). The registry the verifier re-fetches from is a
verifier-side constant, not repository configuration (§14 D3). What remains
outside automation is honestly bounded: a consistent rewrite that lands on
the protected branch still requires review by the single maintainer — the
residual documented in §13 and SECURITY.md.

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
| External verifier repo (code-owner-locked, SHA-referenced) | the verification logic itself (R2, §10) |

**Context resolution is repository-scoped.** A nested checkout (worktree,
submodule, vendored repo) must never inherit the trust context of an
enclosing checkout. (Found and fixed during Phase 1:
`findTrustContext` previously walked past `.git` boundaries.)

**Shipped state (0.12.0), so the model is read against reality:** the
`safeinstall-trust.yml` check already runs from the base branch
(`pull_request_target`), checks out the PR head only as inert data
(`persist-credentials: false`, no PR code executes), and installs the
verifier CLI from a tarball verified against a recorded sha512. A PR that
edits the workflow file does not change what runs for that PR; editing it
is enforcement-zone drift under the trust lock. What the shipped state does
**not** yet give: verification steps outside the repository entirely (a
merged malicious edit to the thin workflow would apply to *subsequent*
PRs — §10 closes this with the external verifier repo), and any second
human on trust-surface diffs (owner decision: stays a documented limit,
§13 decision note).

## 3. Trust ladder

| Level | Record | Who creates it | What it claims |
|---|---|---|---|
| **L0** | Preview record | local SafeInstall run (agent or human) | "this evaluation happened here, with these observed inputs" — **untrusted, advisory** |
| **L1** | Authorization | CI re-evaluation on the PR, running verifier logic referenced by commit SHA from outside the repo | "an independent runner re-resolved and re-evaluated this exact lockfile state and reached *allow* at time T" |
| **L2** | Signed authorization | CI + OIDC/Sigstore (optional peer dep already present) | L1 plus a verifiable signature binding the verdict to workflow identity |
| **L3** | Two-party approval | second human maintainer | L2 plus independent human review of the dependency delta |

Hard rules learned from Phase 1:

- An L0 record **must** carry `actor: "agent" | "human-unverified"`
  provenance and **can never** be upgraded in place. Approval-class ledger
  entries are created only through the interactive human gate. An agent
  that fabricates an approval entry produces a record that fails L1
  verification (the CI check re-derives everything and ignores L0 claims).
- **L3 requires ≥ 2 maintainers.** SafeInstall operates below L3 until a
  second maintainer exists. The spec defines L3 now; the project does not
  claim it. **Owner decision (2026-07-11, issue #41):** no second reviewer
  will be appointed prematurely — a reviewer chosen for availability rather
  than demonstrated trustworthiness would add attack surface, not security.
  The residual stays documented in SECURITY.md until a co-maintainer
  emerges from the contributor pool.

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
                  manifest blob OID (before/after), lockfile blob OID
                  (before/after), policy blob OID, trust-surface lock blob
                  OID, registry metadata observed (per-package: publish
                  time, provenance identity), safeinstall version, schema
                  version (binding semantics: §7)
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

**Why `installed: false` does not gate the merge (R2, resolves §13 M3):**
the asset this RFC protects is the repository's dependency state (§2.2),
not the local `node_modules` materialization. L1 re-evaluates the lockfile
delta on policy grounds; whether the *local* install completed is honesty
metadata about the developer machine, which §2.4 trusts for nothing. S5
runs with scripts disabled by default, so "the postinstall errored" is not
a signal the gate could act on — CI's own frozen install in the normal `ci`
job is where installability is proven. The newest record carrying
`installed: false` produces an informational finding in the L1 summary so
the state is visible, never silent.

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

> R2: this section is normative and replaces the R1 text. Decisions D1
> (canonical form) and D2 (blob-OID binding) in §14 carry the rationale.

### 5.1 Canonical form (D1)

- A record is a single JSON document canonicalized per **RFC 8785 (JSON
  Canonicalization Scheme)**, with a producer profile that keeps every
  conforming implementation trivial and removes JCS's only hard cases:
  - all numbers are **integers** within the IEEE-754 exact range (counts,
    sizes in bytes, durations in whole seconds/hours); no fractional or
    non-finite values anywhere in the schema;
  - timestamps are RFC 3339 UTC **strings**, never numbers;
  - strings are valid Unicode (I-JSON: no lone surrogates).
- The record **file content is exactly the canonical bytes** (UTF-8, no
  insignificant whitespace, no trailing newline). One consequence, by
  design: `recordDigest` = sha256 over the file bytes = sha256 over the
  canonical form, and the record's git blob OID binds the same bytes. No
  "pretty file + canonical digest" split — one byte truth.
- `schemaVersion` is mandatory; unknown versions fail closed.

### 5.2 Binding to repository state (D2)

Digests over *files* (manifest, lockfile, policy, trust lock) are **git
blob bindings**, not working-tree byte hashes:

- At record time, SafeInstall computes the blob OID of the exact bytes it
  is adopting, as git itself would stage them (`git hash-object
  --path=<repo-relative-path> --stdin`), so record-time identity and
  commit-time identity agree by construction.
- Each binding records: `path` (repo-relative, forward slashes),
  `blobOid`, `objectFormat` (`sha1` | `sha256`, from the repository), and
  `sha256` computed over the same staged bytes. The independent sha256
  keeps the binding collision-resistant even in `sha1` repositories; the
  L1 verifier checks **both** (tree lookup by OID, and a recomputed sha256
  over `git cat-file blob` output).
- Working-tree materialization games — `core.autocrlf`, smudge/clean
  filters, uncommitted `.git/info/attributes` — cannot alter what these
  bindings mean: both the recorder and the verifier bind post-clean staged
  content, and any staged-byte manipulation (including via a PR edit to
  `.gitattributes`) surfaces as a plain OID mismatch. `.gitattributes`
  therefore carries no load in DDR binding. It **remains** in the *local*
  trust surface, where the trust lock hashes materialized bytes and
  deterministic materialization still matters (the Phase 1 CRLF finding).

### 5.3 Layout and content

- Records live under `.safeinstall/decisions/<lockfile-path-slug>/`, one
  directory per lockfile path (slug: repo-relative path with `/` → `__`),
  named `<seq, 6 digits>-<recordDigest first 12 hex>.json`. One record per
  transaction; committed with the dependency change (same-commit rule).
- Field groups (normative list in the implementation spec, not repeated
  here): request, resolution (exact versions + integrity hashes + sources),
  environment (PM name/version, native security options in effect — §8),
  policy evaluation (verdict, reasons, evidence), bindings (§5.2, before +
  after), provenance observations, actor + trust level, timestamps
  (observed, not asserted — §6).

### 5.4 Non-registry sources are explicit findings (D4)

Release age and provenance are structurally not evaluable for
`file:`/`link:`/`directory:` dependencies. R1 let those evaluate to empty
fields, so a local-path payload produced a record that read "clean" —
§13 H2. Normative in R2:

- Every resolved package whose source is not the pinned registry yields an
  **explicit finding**: `non-registry-source` for `file:`/`link:`/
  `directory:` (severity per policy; the default policy warns), and
  `workspace-source` (informational) for workspace links.
- Signals that cannot be computed are recorded as
  `"notEvaluable": "<reason>"` — never as absent fields, and never as a
  passing value.
- A record's summary carries the count of not-evaluable packages; a record
  containing any non-registry source can never render as "no findings".
- Git dependencies remain fail-closed at S1 (§4) and never reach a record.

## 6. Time semantics: replay vs. authorization

Policy rules are time- and state-dependent (release age, provenance
continuity against registry state). Therefore:

- **Replay** answers: "given the inputs recorded at S3, was the verdict
  computed correctly?" Deterministic, always possible, catches evaluation
  bugs — but proves nothing about the world (a lying local clock or a
  poisoned registry mirror poisons the inputs).
- **Authorization** answers: "is this dependency state acceptable *now*,
  observed from CI?" CI re-fetches registry metadata itself — from the
  verifier's pinned registry root, not from repository configuration
  (D3) — and re-runs the evaluation. Divergence from the L0 verdict is
  **legitimate** (a package aged past the release window) and is recorded,
  not treated as an error. Only the CI-observed result gates the merge.
- Local timestamps are recorded but never trusted. No historical claim
  ("this was safe on date D") is made without an external time anchor —
  deferred to L2+ (Sigstore timestamps).
- **Publish-time source of truth (D7, resolves §13 M1):** the registry
  document's `time[version]` field is the primary source for release age;
  the tarball `last-modified` header is a fallback only, and using the
  fallback is itself recorded (`publishTimeSource: "last-modified"`) so a
  record never silently rests on a mutable CDN header. (The shipped
  `registry.ts` prefers the header; flipping the priority is a queued
  implementation change tracked with this RFC.)

**Authorization freshness (H4 corrected):** an L1 authorization binds to
the exact lockfile blob OID and carries `evaluatedAt`. Staleness is
enforced **ruleset-first**: the branch protection's
`strict_required_status_checks_policy` (branch must be up to date) forces
re-runs on stale branches and is the *stronger* mechanism, because it is
platform-enforced state outside any workflow's control. The verifier's own
TTL check (`authorizationTtl`, default 7 days) is defense-in-depth for
configurations where the ruleset is weaker — not the other way around, as
R1's wording implied. Rationale: between evaluation and merge, the world
can change (package unpublished/deprecated, provenance revoked, policy
tightened).

## 7. Digest binding and lockfile integrity

- The CI check resolves the PR HEAD tree and requires the manifest and
  lockfile **blob OIDs** (and their independent sha256s, §5.2) to match
  the record exactly (A4 defense).
- A PR that changes a lockfile without a record, or with a record whose
  bindings do not match, fails the required check. This is the
  load-bearing rule that closes the bypass gap: it does not matter *how*
  the lockfile was produced (agent bypass, manual edit) — it does not
  merge without fresh CI authorization over the actual committed content.
- **Chains are per lockfile path (D5, resolves §13 M4 / Open-Q5):**
  - every record binds exactly one lockfile path (§5.3);
  - within a path, record N's `before` binding equals record N−1's
    `after`; the first record's `before` matches the merge-base blob OID;
    the last record's `after` matches the PR HEAD blob OID;
  - **PR-level completeness:** the set of lockfile paths changed between
    merge-base and PR HEAD (by known lockfile name, at any depth) must
    equal the set of paths with valid chains. A changed-but-unchained
    lockfile — the unrecorded second workspace lockfile of M4 — is a
    deterministic failure, not a gap.
- **What the chain is, honestly (M2 accepted):** digest continuity is
  audit bookkeeping that orders and completes the record history. The
  security gate is the independent L1 re-evaluation; CI ignores every L0
  verdict. Records carry evidential value, not enforcement value — the
  "records, not proofs" line in §1 is this sentence in schema form.

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
  advisory lock (`.safeinstall/transaction.lock`) using the same
  owned-token + atomic-steal pattern the trust ledger lock shipped with
  (exclusive create, token-checked release, rename-based steal of stale
  locks) — that pattern already survived concurrent-writer review; a
  second starter fails closed with the holder's PID + start time.
- **Registry mutation between S1 and S6:** irrelevant to integrity — all
  binding is to committed blob identity; CI re-observes metadata itself
  from the pinned registry root (D3).
- **Ledger rollback:** the out-of-tree head mirror catches naive and
  accidental rewrites and reconciles by hash-chain containment (legitimate
  advancement stays silent; rewrite/rollback blocks — shipped 0.12.0,
  #33). Per §13 K2 it is **not** an adversary-proof anchor and this RFC
  does not lean on it for A2/A3: what holds against a scheme-aware rewrite
  is CI re-verification of committed state plus human review of
  trust-surface diffs. DDR chains get the same mirror treatment, with the
  same honest scope.
- **Record deletion:** deleting `.safeinstall/decisions/` entries breaks
  the §7 chain check on the next dependency PR touching that lockfile;
  deleting them *without* a lockfile change is inert (records are not
  secrets) but visible in review.
- **Retention and compaction (D6):** records are append-only.
  `safeinstall decisions compact` (specified now, shipped with L0) rolls
  records older than `decisionRetentionDays` (default 365) into one
  archive file per lockfile path; the archive embeds the compacted range's
  final `after` binding and running record-digest head, and the live
  chain's first record references that head — chain verification stays
  deterministic across compaction. Compaction is a normal reviewed change;
  the L1 completeness rule (§7) is unaffected because it binds to
  merge-base..HEAD deltas, not to history depth.

## 10. CI verification protocol (normative sketch)

> R2: rewritten against the owner-decided verifier model (§13 decision,
> issue #41). The 0.12.0 trust check already implements the base-loaded +
> hash-pinned half of this; the external verifier repo is the remaining
> half.

**Verification runs from sources a PR cannot mutate:**

1. The main repo's workflow (`safeinstall-trust.yml`, and the `decisions`
   job when L1 ships) stays a **thin invocation shell**: loaded from the
   protected base branch via `pull_request_target`, checking out the PR
   head strictly as inert data (`persist-credentials: false`; no PR code
   executes).
2. The verification steps live in a separate, public, code-owner-locked
   repository (**`safeinstall-verifier`**) and are referenced **by full
   commit SHA** — never by branch or tag. A PR against the main repo
   cannot alter them; changing the pinned SHA is an enforcement-zone diff
   under the trust lock, visible and review-required.
3. The verifier CLI is installed from a tarball pinned by **sha512 content
   hash** (shipped pattern), so neither a floating version nor a registry
   serving different bytes for the same version can swap the logic.
4. The registry the verifier re-fetches metadata from is a **verifier-side
   constant** (D3): `https://registry.npmjs.org` unless an explicit
   allowlist entry exists in the verifier invocation (base-branch-loaded,
   outside PR mutation). The PR's `safeinstall.config.json#registryUrl`
   is never used for L1 re-fetching; a non-default value is a hard finding
   (D3).

**The `decisions` job (L1), once records exist:**

1. Checkout PR head as data; resolve merge-base.
2. `safeinstall decisions verify` — per-path chain + binding checks (§7),
   schema validation, TTL check (defense-in-depth, §6).
3. `safeinstall decisions authorize` — fresh S2 evaluation of every
   changed lockfile's delta against merge-base, registry metadata fetched
   by CI from the pinned root.
4. Verdict `allow` → check passes and (L2, when enabled) a signed
   attestation is uploaded as a workflow artifact bound to the lockfile
   blob OID.
5. Any other verdict → check fails with the policy reasons as the check
   summary.

Both job names are required status checks in the ruleset. Required checks
are matched **by name**, so the name-spoofing residual (an identically
named job from a neutered workflow) is countered by the combination of
base-loaded workflow definitions (a PR cannot change what produces the
check for its own run) and enforcement-zone review of workflow diffs (a
merged change to the thin shell is a trust-surface event, not a silent
edit). The adversarial suite in the verifier repo keeps a spoofed-name
case red forever.

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

## 12. Open questions

R2 resolves the R1 list as follows:

1. **Staging isolation per PM version for S1 — still open.** The
   adversarial test matrix (which resolver paths can execute code, per
   manager and version) is Attack-Lab work and remains the gate before S1
   is declared safe per manager version.
2. Canonical JSON — **decided**, §14 D1.
3. Record retention/compaction — **decided**, §14 D6 / §9.
4. **Windows execution layer — still open.** The BatBadBut-safe spawn
   constraints (shipped in `win32-spawn.ts` for the guard path) must be
   folded into S5's "strictly frozen install" path with the same
   fail-closed argument rules.
5. Monorepo/workspace semantics — **decided**, §14 D5 / §7.

## 13. Security review findings (R1) — adversarial pass

> R2 note: this section is the preserved R1 audit trail. Each finding
> carries a `R2:` line stating how it is resolved, mitigated, or accepted;
> the rationale lives in §14. Nothing else in the section was altered.

An independent adversarial review checked the R0 draft against the actual
implementation (`src/trust-ci.ts`, `src/registry.ts`, `src/trust-surface.ts`,
`src/trust-ledger.ts`, `src/provenance.ts`, `safeinstall.config.json`). The
findings below supersede any conflicting claim in §1–§12 as of R1; the R2
revisions of §1–§12 are drafted against them.

### The one sentence the RFC must add

> The integrity of the CI re-evaluation depends on four PR-mutable artifacts —
> the workflow file, `safeinstall.config.json`, `trust-surface.lock`, and
> `.gitattributes` — and there is **no automatic, off-machine reference** for a
> consistent rewrite of all four. The real security boundary is therefore
> **CODEOWNERS-enforced human review of the trust-surface diff on every
> dependency PR**, plus a ruleset that makes workflow/config/lock changes
> review-required. Without that, the "automatic enforcement" advantage in §1
> is an illusion.

> R2: three of the four artifacts are no longer PR-mutable *for the running
> check* (base-loaded workflow; verifier logic by external SHA; registry
> root verifier-side) — see D2/D3 and §10. `.gitattributes` drops out of DDR
> binding entirely (D2). The residual — human review of a consistent rewrite
> that is being *merged* — is real, solo-bounded, and documented (§3, K2
> below, SECURITY.md).

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

  > R2: (a) half-shipped in 0.12.0 (`pull_request_target` base loading),
  > completed by the external verifier repo (§10); (b) shipped in 0.12.0
  > (sha512-pinned tarball); (c) bounded by the solo owner decision — the
  > review requirement exists as documented process, not as a platform-
  > enforced second approver. Residual stated in SECURITY.md.

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

  > R2: §9 rewritten to the honest scope. The structural gap narrows —
  > policy re-evaluation reads the PR's policy, but the *verifier logic and
  > registry root* no longer do (D3, §10), and a policy rewrite is an
  > enforcement-zone diff the trust check surfaces. What closes the last
  > mile is human review of that diff; solo residual documented (§3).

- **K3 — `registryUrl` is PR-mutable config, not a trust root.** §6's "CI
  re-fetches registry metadata itself" is undercut because `registryUrl`
  comes from `safeinstall.config.json` (in-repo, PR-editable). Point it at an
  attacker mirror serving forged publish times and provenance bundles, and
  CI's "independent" re-evaluation reads from the attacker's source.
  `npm ci --frozen-lockfile` then verifies integrity hashes that also came
  from that registry (self-consistent). **Forces:** pin the registry
  identity to a trust root, or treat any non-default `registryUrl` as a
  hard, human-review-required finding.

  > R2: decided — both halves. D3: the verifier re-fetches only from its
  > own pinned root, and a non-default repo `registryUrl` is a hard finding
  > that fails L1 pending explicit out-of-band allowlisting.

### HIGH

- **H1 — L2 signatures prove identity, not logic.** With K1 unfixed, a
  signed attestation says "this repo's runner said allow" over
  attacker-controlled evaluation code — a cryptographic façade on a
  manipulable result. L2 is only meaningful once the workflow content is
  outside PR mutation.

  > R2: resolved by construction once §10 lands (verifier logic by external
  > SHA); L2 stays sequenced strictly after L1 is adversarially stable.

- **H2 — non-registry sources bypass the core signals.** `allowedSources`
  includes `file`/`directory`; release-age and provenance are structurally
  N/A for `file:`/`link:`/`directory:` deps, so a `file:./vendor/x.tgz`
  payload produces a DDR with **no findings** — reads "clean". §4 blocks git
  deps but not local-path deps, an equivalent opaque-content vector. §5 must
  make "missing provenance/publish-time for a non-registry source" an
  **explicit finding**, not an empty field.

  > R2: decided — D4 / §5.4. Explicit findings, `notEvaluable` markers, and
  > a summary that cannot read "clean" for non-registry sources.

- **H3 — hash working-tree bytes → adopt git blob OIDs instead.** §5 hashes
  materialized bytes and band-aids CRLF with a `.gitattributes` rule that
  itself joins the trust surface. But working-tree bytes also depend on
  `.git/info/attributes` (uncommitted), `core.autocrlf`, and clean/smudge
  filters that committed `.gitattributes` does not capture — both a
  false-drift source and the very "materialization" attack §5 half-closes.
  **SOTA fix:** bind to **git blob OIDs** (already content-addressed,
  renderer-independent); the entire `.gitattributes`-in-trust-surface
  construction then becomes unnecessary.

  > R2: adopted — D2 / §5.2, with an independent sha256 alongside the OID
  > (sha1-repo collision hedge). `.gitattributes` stays in the *local*
  > trust surface only, where materialized bytes are still what is hashed.

- **H4 — "TTL enforced by the trust check itself" is backwards.** A ruleset
  setting (`strict_required_status_checks_policy`) is *stronger* than logic
  self-enforced inside a PR-mutable workflow (K1). §6's wording suggests the
  opposite; correct it.

  > R2: corrected — §6 "ruleset-first"; the in-verifier TTL is
  > defense-in-depth.

### MEDIUM

- **M1 — publish time from `last-modified` header, not the authoritative
  `time` field.** `registry.ts` prefers the tarball `HEAD`→`last-modified`
  (a mutable CDN/cache header) over the registry `time` record. The
  release-age control should treat `time` as primary.

  > R2: decided — D7 / §6; implementation change queued with this RFC.

- **M2 — the record chain is bookkeeping, not a gate.** §7 verifies digest
  continuity only; CI ignores the L0 verdict and re-evaluates. The schema
  yields audit metadata, not gate security. Do not ascribe more security
  value to records than they carry (the "proof" illusion §1 warns against).

  > R2: accepted and now stated inside §7 itself.

- **M3 — `installed: false` still merges.** §4's abort leaves the committed
  lockfile with `installed:false`; CI authorizes policy-only. A package whose
  malicious `postinstall` merely errored still lands in the protected
  lockfile. The gate ignores the honesty.

  > R2: accepted with rationale — §4 "why installed:false does not gate";
  > surfaced as an informational L1 finding instead of a gate input.

- **M4 — monorepo chain is an attack vector, not a nice-to-have.** §7's chain
  assumes a single lockfile line; a PR touching two workspace lockfiles has
  no unique linear chain, leaving room for an unrecorded second-lockfile
  change. Close Open-Q5 **before** implementation.

  > R2: closed — D5 / §7 (per-path chains + PR-level completeness).

### Reviewer's stated gaps (kept honest)

GitHub `pull_request` head-ref semantics (K1) and required-check-by-name
evaluation are derived from established platform behavior, not reproduced
end-to-end in this repo. The `decisions verify/authorize` commands (§10) do
not exist yet; their behavior is assessed from the spec against the existing
registry/trust-surface implementation.

> R2: the adversarial suite required for the verifier repo (issue #41,
> stage 2) turns the platform-behavior assumptions into executed tests:
> tampered workflow, policy, lock, registryUrl, and an identically-named
> neutered check must all fail against a live invocation.

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

### Decision (owner, 2026-07-10)

The strongest coherent variant is chosen and is the R2 foundation:

- **(2) in full:** trust verification moves to a source outside PR mutation —
  a separate, CODEOWNERS-locked verifier repository, referenced from this
  repo's workflow by commit SHA, with the verifier CLI pinned by hash (not
  just version). Closes K1.
- **plus (1), scoped:** code-owner review required exactly on the
  trust-surface paths (`.github/workflows/**`, `.safeinstall/**`,
  `safeinstall.config.json`, `.gitattributes`), not on every PR. Closes
  K2/K3 at the human layer for the rare PRs that touch them.
- **Interim honesty:** until both land, SECURITY.md documents the weaker
  guarantee in the (3) wording. No claim ships ahead of its enforcement.

R2 must be drafted against this model; H1's "cryptographic façade" objection
is thereby resolved by construction, not by wording.

> R2 addendum (owner, 2026-07-11, issue #41): the "(1), scoped" half is
> bounded by the solo decision — GitHub does not count a PR author's
> self-approval, so platform-enforced code-owner review of trust-surface
> paths is not attainable with one maintainer. The scoped-review intent
> stands as documented process (trust-surface diffs are enforcement-zone
> drift, surfaced by the trust check and reviewed by the owner at merge);
> the platform-enforced form activates when a second maintainer exists.
> Until then SECURITY.md carries the residual, stated plainly.

## 14. R2 decisions

Each decision names what it resolves, the decision, the rationale, and the
consequences. These are the trust-root questions R1 left open.

### D1 — Canonical JSON: RFC 8785 (JCS) with an integer-only producer profile

*Resolves: Open-Q2.*

**Decision.** Records are canonicalized per RFC 8785 (JSON Canonicalization
Scheme). The schema constrains producers to integers-only numbers, RFC 3339
UTC string timestamps, and I-JSON-valid strings. The record file *is* the
canonical bytes (§5.1).

**Rationale.** The digest must be recomputable by an independent verifier,
potentially in another language, forever. A published, testable spec with
existing cross-language implementations beats a homegrown subset whose
corner cases (number formatting, key ordering of non-ASCII keys, escaping)
would be discovered by divergence in the field. JCS's only genuinely hard
requirement — ECMAScript number serialization — is neutralized by the
integer-only profile: every mainstream JSON serializer prints exact-range
integers identically, so a conforming producer is a recursive key sort (by
UTF-16 code units) plus a plain serializer. In Node, `JSON.stringify` over
sort-ordered structures is JCS-conformant for this profile with zero
dependencies.

**Consequences.** No floats anywhere in the schema, ever (durations in
whole units; ratios as scaled integers). Any future field that wants a
fraction must justify a schema-version bump. Verifier implementations must
reject non-canonical record bytes (recompute-and-compare, not parse-and-
re-serialize-loosely).

### D2 — Bind to git blob OIDs, not working-tree bytes

*Resolves: H3. Details: §5.2.*

**Decision.** All file bindings in a record are git blob OIDs computed
as-staged (`git hash-object --path`), each paired with an independent
sha256 over the same staged bytes and the repo's object format.

**Rationale.** The artifact CI verifies is the *committed* content — blob
identity is git's own content-addressing of exactly that, immune to every
working-tree materialization knob (`core.autocrlf`, smudge/clean,
uncommitted `.git/info/attributes`) that made byte-hashing both fragile
(Phase 1's Windows false drift) and attackable (materialization games).
Recorder and verifier both bind post-clean staged content, so they agree by
construction. The paired sha256 removes any residual dependence on SHA-1
collision resistance in `sha1`-format repos; the verifier checks both.

**Consequences.** DDR binding no longer needs `.gitattributes` as a trust
root (it stays in the *local* trust surface for the materialized-byte
checks the trust lock performs). Record creation requires a git repository
— already true of the same-commit rule. A transaction in a non-git
directory fails closed at S3 with a clear message.

### D3 — Registry identity is a verifier-side trust root

*Resolves: K3. Details: §6, §10.*

**Decision.** The L1 verifier re-fetches registry metadata exclusively from
its own pinned registry root (default `https://registry.npmjs.org`),
configured in the verifier invocation that lives outside PR mutation. The
repository's `safeinstall.config.json#registryUrl` affects only local L0
behavior. Any effective non-default `registryUrl` in the repo config is a
**hard L1 finding** (`registry-not-default`) that fails authorization
unless an explicit allowlist entry for that URL exists on the verifier
side.

**Rationale.** A trust root the subject can edit is not a root. Legitimate
private-mirror users exist, but they are exactly the users who must make
that choice out-of-band (in the base-branch-loaded invocation, reviewed as
enforcement-zone change), not inside the PR being judged. Failing closed on
divergence converts K3's silent poisoning into a loud, reviewable event.

**Consequences.** Private-registry projects must configure the verifier
allowlist once, deliberately. L0 records against a private mirror carry the
observed URL so the divergence is visible in the record itself, not only in
CI.

### D4 — Non-registry sources produce explicit findings

*Resolves: H2. Details: §5.4.*

**Decision.** `file:`/`link:`/`directory:` sources always yield a
`non-registry-source` finding; non-computable signals are recorded as
`notEvaluable` with a reason; records with non-registry sources can never
summarize as clean. Workspace links yield an informational
`workspace-source` marker. Git dependencies stay blocked pre-record.

**Rationale.** The absence of evidence must be distinguishable from
evidence of absence in the record itself — H2 showed that empty fields read
as "clean" to every downstream consumer (human, CI summary, future Attack
Lab). Local-path payloads are the same opaque-content vector as git deps;
since blocking them outright would break legitimate vendoring and monorepo
workflows, the honest middle is *loud visibility with policy control*.

**Consequences.** Default policy keeps `file`/`directory` in
`allowedSources` (compatibility) but the finding is always present; strict
profiles can escalate it to a block without schema changes.

### D5 — Monorepo semantics: per-lockfile-path chains + PR-level completeness

*Resolves: Open-Q5, M4. Details: §7.*

**Decision.** One record binds one lockfile path; chains are continuous per
path; and the set of lockfile paths changed in the PR must exactly equal
the set covered by valid chains.

**Rationale.** A single linear chain across multiple lockfiles has no
natural order and invites exactly the gap M4 named (an unrecorded second
lockfile riding along). Per-path linearity restores a total order where one
exists; the completeness rule converts "forgot/omitted a lockfile" from a
blind spot into a deterministic red check. Both rules are computable from
`merge-base..HEAD` alone — no repository-wide scan, no heuristics.

**Consequences.** Workspace-level operations that touch N lockfiles produce
N records per transaction (each self-contained). The completeness rule
needs a maintained list of known lockfile names (`package-lock.json`,
`pnpm-lock.yaml`, `bun.lock`/`bun.lockb` for detection-only) — additions to
that list are verifier changes, outside PR mutation.

### D6 — Race, TTL, and retention

*Resolves: Open-Q3 and the §9 race items.*

**Decision.** (a) Transactions serialize per worktree via
`.safeinstall/transaction.lock` reusing the shipped owned-token +
atomic-steal ledger-lock pattern. (b) Authorization freshness is
ruleset-first; the verifier's `authorizationTtl` (default 7 days) is
defense-in-depth (§6). (c) Records are append-only with deterministic
compaction after `decisionRetentionDays` (default 365) that preserves chain
verifiability by embedding the compacted head (§9).

**Rationale.** (a) The ledger lock's concurrency properties were already
adversarially reviewed once; a second, different locking scheme would be
new risk for zero gain. (b) Platform-enforced staleness beats
self-enforced staleness (H4); keeping the in-verifier check costs little
and covers repos with weaker rulesets. (c) One-file-per-transaction grows
unboundedly (Open-Q3); compaction that *summarizes into the chain* keeps
the audit property (any tampering with archived history breaks the
embedded head) without keeping every byte forever.

**Consequences.** `decisions compact` ships with L0 (specified now, so the
schema reserves the archive-reference field from day one and no migration
is needed later).

### D7 — Publish time: registry `time` field primary

*Resolves: M1. Details: §6.*

**Decision.** Release-age evaluation reads the registry document's
`time[version]` as primary; the tarball `last-modified` header is fallback
only and its use is recorded in the record (`publishTimeSource`).

**Rationale.** `time` is the registry's authoritative statement of publish
time; `last-modified` is a CDN/cache artifact that can drift or be
manipulated independently of the registry document. A security control's
primary input should be the authoritative source; when the fallback is
used, the record must say so — silent fallback to a weaker source is the
downgrade pattern this project exists to flag.

**Consequences.** `registry.ts`'s current preference order flips
(implementation change queued with this RFC); disk-cache entries keyed on
the old source are invalidated by namespace bump.

## Appendix A: Phase 1 empirical findings feeding this spec

| Finding | Where it landed |
|---|---|
| Human gate refused agent approval (`CLAUDECODE`); agent replicated internal API instead | §3 L0 rules; A2 attacker |
| Ledger head mirror caught in-repo ledger revert | §9 rollback |
| Trust context walked past repo boundary (worktree inherited foreign baseline) | §2.4 repository-scoped resolution |
| CRLF checkout changed locked-file bytes → false drift on Windows | §5 byte semantics (R2: superseded by blob-OID binding, D2; still relevant to the local trust lock) |
| Node refuses `.cmd` spawn (BatBadBut); cmd.exe arg injection risk | §12.4 |
| pnpm `minimumReleaseAgeStrict: false` silently falls back | §8 downgrade findings |
| Codex approve-gate gap: `CODEX_SHELL` missing from the refusal list (fixed 0.11.1) | §3 human-gate rules; Attack Lab seed |
| Mirror reconciliation moved to hash-chain containment so legitimate advancement stays silent (#33) | §9 rollback |
