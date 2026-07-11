# Provability chapter — consolidated handoff

**Current main SHA:** `638f9ec` (Mickdownunder/SafeInstall)
**State:** all agent-autonomous stages complete; everything merged to green main.
**Verification on merged main:** `tsc` (both configs) clean · full suite **796/796** · `node attack-lab/run.mjs` → 7 ok / 2 known-gap / 0 regression / 0 discipline-error.

The moat, preserved precisely: agent-side install control + lockfile-bound decision **record** + independent CI re-authorization + local open-source execution. Language discipline held throughout — local artifacts are **records** and **signable statements**, never "proofs", because no independent signature exists yet.

---

## PRs merged (all squash-merged, branches deleted)

| PR | Purpose |
|---|---|
| [#47](https://github.com/Mickdownunder/SafeInstall/pull/47) | **RFC-001 → R2.** Decided the open trust-root questions (§14 D1–D7) with rationale; folded shipped 0.12.0 state into §2/§3/§10; §13 preserved verbatim as the R1 audit trail with per-finding R2 resolution notes. |
| [#48](https://github.com/Mickdownunder/SafeInstall/pull/48) | **SECURITY.md** updated to the real shipped state + the solo-maintainer residual (owner decision, #41). |
| [#49](https://github.com/Mickdownunder/SafeInstall/pull/49) | **fix(registry):** registry `time` map is now the primary publish-time source; `last-modified` header is fallback only, and `publishTimeSource` is recorded (D7 / §13 M1). Cache namespace bumped to `-v2`. |
| [#50](https://github.com/Mickdownunder/SafeInstall/pull/50) | **Decision records L0 foundations:** canonical JCS (D1), git blob-OID bindings (D2), per-lockfile-path chains under the extracted file lock, and `decisions verify` (committed-state verifier: chain + binding + D3 registry root + D5 completeness). |
| [#51](https://github.com/Mickdownunder/SafeInstall/pull/51) | **L0 emission + L1 authorize:** installs leave records (D4 non-registry findings); `decisions authorize` = verify + fresh policy re-evaluation of committed head with registry fetched now; `--output` writes the canonical authorization artifact. Includes the Windows/macOS path-canonicalization fix. |
| [#52](https://github.com/Mickdownunder/SafeInstall/pull/52) | **Attack Lab** (eval-system-first): `attack-lab/` catalogue + `src/attack-lab.ts` eval + `run.mjs` + regression suite that live-executes representative defenses and pins the two honest limits. |
| [#53](https://github.com/Mickdownunder/SafeInstall/pull/53) | **L2 signable statement layer:** `decisions attest` / `verify-attestation` build and check the in-toto statement (the DSSE payload). Signing itself is gated (see below). |

## New public repository created

**[Mickdownunder/safeinstall-verifier](https://github.com/Mickdownunder/safeinstall-verifier)** — the external verification anchor (RFC-001 §13 K1).
- Commit `1e20eb3843e5afe0a4fef7c649aea83121ecbc90`, release **v0.1.0** (published, not draft).
- Composite action installs `safeinstall-cli@0.12.0` pinned by sha512 (`pin.json`), runs `trust status --require-lock` against a candidate treated as data.
- CI-required **9-case adversarial suite**, all held green: clean passes; tampered workflow / policy / registryUrl, forged lock, identically-named-but-neutered check, removed baseline, naive consistent rewrite (mirror containment), corrupt tarball all fail.
- Governance: `CODEOWNERS` on `*`, **active** branch ruleset (PR required, strict required checks `adversarial` + `action-selftest`, no deletion, no force-push).

---

## HUMAN GATES — queued for you, in order

### GATE 1 (enforcement zone) — switch the main-repo trust workflow to the verifier@SHA

This is the one autonomous stages could not land: editing `.github/workflows/safeinstall-trust.yml` is an enforcement-zone change that makes `trust-base` red until you re-baseline interactively. **I did not edit it** — doing so would have locked every subsequent Bash command in the session (by design). The exact replacement and sequence:

**New file content for `.github/workflows/safeinstall-trust.yml`** (replaces the inline curl/sha512/npm-install/run steps with the SHA-pinned verifier action; the two checkout steps are unchanged):

```yaml
name: SafeInstall Trusted Base Verification

# The verification logic is invoked from the external, code-owner-locked
# verifier repository BY FULL COMMIT SHA (RFC-001 §13 K1). This workflow file
# is loaded from the protected base branch (pull_request_target); the PR
# candidate is checked out only as inert data and never executed.
on:
  pull_request_target:
    types: [opened, synchronize, reopened]
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  trust-base:
    runs-on: ubuntu-latest
    steps:
      - name: Check out pull request candidate as data
        if: github.event_name == 'pull_request_target'
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          repository: ${{ github.event.pull_request.head.repo.full_name }}
          ref: ${{ github.event.pull_request.head.sha }}
          path: candidate
          persist-credentials: false

      - name: Check out protected main revision
        if: github.event_name == 'push'
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          path: candidate
          persist-credentials: false

      # Verification runs from the external verifier repo, pinned by full commit
      # SHA — never a branch or tag. A PR against THIS repo cannot alter what
      # runs; bumping the SHA is an enforcement-zone change requiring review.
      - name: SafeInstall trusted verification
        uses: Mickdownunder/safeinstall-verifier@1e20eb3843e5afe0a4fef7c649aea83121ecbc90 # v0.1.0
        with:
          candidate-path: candidate
```

**Exact approve sequence** (interactive terminal, on a branch off `main`):

```bash
git checkout -b chore/trust-verifier-switch origin/main
# apply the file content above to .github/workflows/safeinstall-trust.yml, then:
safeinstall trust status                       # confirm the drift is exactly this file
safeinstall trust approve                      # interactive /dev/tty confirm — re-baselines .safeinstall/
git add .github/workflows/safeinstall-trust.yml .safeinstall/
git commit -m "chore(trust): invoke the external verifier by pinned commit SHA (RFC-001 K1)"
git push -u origin chore/trust-verifier-switch
```

Then open the PR and admin-merge once green. **Caveat:** the verifier action at `1e20eb3` pins `safeinstall-cli@0.12.0`, which runs only `trust status --require-lock` — identical protection to today, just relocated outside PR mutation. It does **not** yet run the `decisions` job (that is GATE 3).

### GATE 2 (UI-only) — immutable release artifacts on the verifier repo

`immutable_releases` is not settable via the REST API. In the verifier repo's **Settings → General → (releases/immutability)** (or the org policy), enable immutable release artifacts so `v0.1.0`'s tag/assets cannot be re-pointed. Low urgency; the SHA-pin is the real anchor.

### GATE 3 (deploy gate, then enforcement zone) — activate L1/L2 in CI

The `decisions verify` / `authorize` / `attest` commands exist and are proven locally + e2e, but they are **not yet running in production CI**, because:
- The verifier's hash-pinned CLI must be a **released** version that carries `decisions`. Today's pin is 0.12.0 (no `decisions`). This needs an npm release — **your deploy gate**, per the release flow.
- Once a release (e.g. 0.13.0) carrying `decisions` exists: bump `pin.json` in the verifier repo to that version+sha512, rebuild its fixtures, and add a `decisions` job to the main-repo trust workflow invoking `decisions authorize --base <merge-base>` — another enforcement-zone edit needing `trust approve`.
- **L2 keyless signing** (`sigstore.attest` → Fulcio/Rekor, `sigstore.verify` against the workflow identity) activates in that same CI job. It needs an OIDC identity (only present in a real workflow) — it cannot be exercised in a hermetic build, which is why only the signable-statement layer shipped. The `sigstore` peer dep is already present.

### GATE 4 (not agent-autonomous — the mission STOP line)

- **Independent external security audit** of the trust-surface paths — needs external humans.
- **1.0** — needs the schema + CLI-contract freeze.
Both are explicitly outside agent scope. Flagging, not attempting.

---

## Documented limits (deliberately unclosed, honestly stated)

- **K2 consistent-rewrite residual:** a fully consistent rewrite of policy + lock + ledger passes automated verification on any fresh clone. Boundary = human review of the trust-surface diff, which on a solo project is the merging owner. Documented in SECURITY.md and catalogued as `attack-lab/cases/workflow-consistent-rewrite-no-mirror.json` (known-gap).
- **Approval fatigue:** the human gate proves presence, not informed consent. Catalogued as `attack-lab/cases/incident-approval-fatigue.json` (known-gap).
- **Second maintainer (K2/K3 human layer):** owner decision (#41) — stays a documented limit until a co-maintainer emerges organically. No reviewer appointed for availability.

## Deferred / to verify

- **L1 in production CI** is release-gated (GATE 3), not yet live. The CLI + verifier infrastructure exist and pass locally + e2e; the CI job does not run yet. Do not describe L1 as "running in CI" until GATE 3 lands.
- The `decisions` disk artifacts (`.safeinstall/decisions/`) are emitted by installs but this repo has not yet dogfooded a committed decision-record chain (no dependency PR has run through emission-in-anger here). Consider one small dependency PR after GATE 3 to exercise the full loop end to end in this repo.

## Multi-agent hygiene

All 7 PR branches were `--delete-branch` squash-merged (remote branches gone). No open PRs authored by you remain. Local session-worktree branches can be pruned with `git fetch --prune`. The verifier repo has no worktrees.
