#!/usr/bin/env bash
# Run the backend (uvicorn) and frontend (vite) together with hot reload.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Activate Python venv
if [[ ! -d "$REPO_ROOT/.venv" ]]; then
  echo "No virtualenv found. Run: python3 -m venv .venv && source .venv/bin/activate && pip install -e \".[dev]\""
  exit 1
fi
# shellcheck disable=SC1091
source "$REPO_ROOT/.venv/bin/activate"

cleanup() {
  echo
  echo "Stopping..."
  jobs -p | xargs -I {} kill {} 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(
  cd "$REPO_ROOT/backend"
  PYTHONPATH=. exec uvicorn app.main:app --reload --host 127.0.0.1 --port 8765
) &

(
  cd "$REPO_ROOT/frontend"
  exec pnpm dev
) &

wait
