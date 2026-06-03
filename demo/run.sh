#!/usr/bin/env bash
#
# SafeInstall demonstration script.
#
# Runs SafeInstall against one scenario per policy check and prints the
# block (or allow) for each. Every scenario uses real, legitimate packages
# or controlled local config — there is no malware here, only demonstrations
# of the mechanisms that would catch it.
#
# Requirements: Node.js >= 20, npm, network access.
# Usage:        bash demo/run.sh
#
set -uo pipefail

DEMO_DIR="$(mktemp -d)"
SAFEINSTALL_VERSION="${SAFEINSTALL_VERSION:-latest}"

cleanup() { rm -rf "$DEMO_DIR"; }
trap cleanup EXIT

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
rule()  { printf '%s\n' "------------------------------------------------------------"; }

bold "Installing safeinstall-cli@${SAFEINSTALL_VERSION} into a scratch project..."
(
  cd "$DEMO_DIR"
  npm init -y >/dev/null 2>&1
  npm install "safeinstall-cli@${SAFEINSTALL_VERSION}" >/dev/null 2>&1
)
SAFEINSTALL="$DEMO_DIR/node_modules/.bin/safeinstall"
rule

# ----------------------------------------------------------------------------
# Scenario 1 — Release too new
# ----------------------------------------------------------------------------
bold "1) Release age: block a package because the release is too new"
echo "   Config: minimumReleaseAgeHours = 999999 (forces every release to look fresh)"
cat > "$DEMO_DIR/safeinstall.config.json" <<'JSON'
{ "minimumReleaseAgeHours": 999999 }
JSON
( cd "$DEMO_DIR" && "$SAFEINSTALL" npm install axios )
rule

# ----------------------------------------------------------------------------
# Scenario 2 — Install script present
# ----------------------------------------------------------------------------
bold "2) Lifecycle scripts: block a package that declares an install script"
echo "   esbuild ships a postinstall script — blocked unless explicitly allowed."
cat > "$DEMO_DIR/safeinstall.config.json" <<'JSON'
{ "minimumReleaseAgeHours": 0 }
JSON
( cd "$DEMO_DIR" && "$SAFEINSTALL" npm install esbuild )
rule

# ----------------------------------------------------------------------------
# Scenario 3 — Untrusted source
# ----------------------------------------------------------------------------
bold "3) Source policy: block a git install"
echo "   Git/URL/tarball sources are blocked unless added to allowedSources."
cat > "$DEMO_DIR/safeinstall.config.json" <<'JSON'
{ "minimumReleaseAgeHours": 0 }
JSON
( cd "$DEMO_DIR" && "$SAFEINSTALL" npm install github:axios/axios )
rule

# ----------------------------------------------------------------------------
# Scenario 4 — Typo-squat
# ----------------------------------------------------------------------------
bold "4) Typo-squat: block a one-letter variation of a popular package"
echo "   'raect' is one transposition away from 'react'."
cat > "$DEMO_DIR/safeinstall.config.json" <<'JSON'
{ "minimumReleaseAgeHours": 0, "typoSquat": { "mode": "block", "minNameLength": 4, "ignore": [] } }
JSON
( cd "$DEMO_DIR" && "$SAFEINSTALL" pnpm add raect )
rule

# ----------------------------------------------------------------------------
# Scenario 5 — Publisher mismatch (maintainer-compromise defense)
# ----------------------------------------------------------------------------
bold "5) Provenance: block a valid signature from the wrong source repository"
echo "   safeinstall-cli is pinned to the WRONG publisher to simulate compromise."
cat > "$DEMO_DIR/package.json" <<'JSON'
{ "name": "demo", "version": "1.0.0", "dependencies": { "safeinstall-cli": "*" } }
JSON
cat > "$DEMO_DIR/safeinstall.config.json" <<'JSON'
{
  "minimumReleaseAgeHours": 0,
  "provenance": {
    "mode": "require",
    "requireFor": [],
    "trustedPublishers": { "safeinstall-cli": "evil-org/SafeInstall" },
    "offlineBehavior": "fail-closed"
  }
}
JSON
( cd "$DEMO_DIR" && "$SAFEINSTALL" check )
rule

# ----------------------------------------------------------------------------
# Scenario 6 — Allowlist does not disable attack-signal checks (0.4.0)
# ----------------------------------------------------------------------------
bold "6) Allowlist: even an allowlisted package is blocked from a git source"
echo "   axios is allowlisted, but a git source is still an active attack signal."
cat > "$DEMO_DIR/package.json" <<'JSON'
{ "name": "demo", "version": "1.0.0" }
JSON
cat > "$DEMO_DIR/safeinstall.config.json" <<'JSON'
{ "minimumReleaseAgeHours": 0, "allowedPackages": ["axios"], "allowedSources": ["registry"] }
JSON
( cd "$DEMO_DIR" && "$SAFEINSTALL" npm install github:axios/axios )
rule

bold "Demo complete."
echo "Each scenario above shows SafeInstall blocking a distinct risk class."
echo "No package was actually installed — policy ran before the package manager."
