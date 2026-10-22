#!/bin/sh
# Refuse operator fleet values in a staged commit. See CLAUDE.md.
set -u
root=$(git rev-parse --show-toplevel) || exit 1
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed; cannot scan for fleet values." >&2
  exit 1
fi
report=$(mktemp)
trap 'rm -f "$report"' EXIT
gitleaks git --pre-commit --staged --no-banner --redact \
  --config "$root/.gitleaks.toml" \
  --report-format json --report-path "$report" \
  "$root" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
  exit 0
fi
echo "fleet value; put it in the operator's private deploy notes (see CLAUDE.md)" >&2
exit 1
