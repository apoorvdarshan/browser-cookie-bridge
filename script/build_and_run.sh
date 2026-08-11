#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROCESS_NAME="BraveCodexSyncApp"
SYSTEM_APP="/Applications/Browser Cookie Bridge.app"
USER_APP="$HOME/Applications/Browser Cookie Bridge.app"

pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true

cd "$ROOT_DIR"
npm run build:app

if [[ -d "$SYSTEM_APP" ]]; then
  APP_BUNDLE="$SYSTEM_APP"
else
  APP_BUNDLE="$USER_APP"
fi
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$PROCESS_NAME"

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs|--telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$PROCESS_NAME\""
    ;;
  --verify|verify)
    open_app
    sleep 2
    pgrep -x "$PROCESS_NAME" >/dev/null
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
