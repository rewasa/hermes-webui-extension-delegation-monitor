#!/bin/sh
# install.sh — Install delegation-monitor extension for hermes-webui
# Idempotent: safe to run multiple times.
set -eu

# --- Resolve extension directory ---
EXT_ROOT="${HERMES_WEBUI_EXTENSION_ROOT:-$HOME/.hermes/webui/extensions}"
TARGET="${EXT_ROOT}/delegation-monitor"

echo "==> Extension target: ${TARGET}"

# --- Create target directory ---
mkdir -p "${TARGET}"

# --- Copy extension files ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
for f in manifest.json locales.js app.js app.css refresh.py; do
  if [ ! -f "${SCRIPT_DIR}/${f}" ]; then
    echo "ERROR: ${f} not found in ${SCRIPT_DIR}" >&2
    exit 1
  fi
  cp "${SCRIPT_DIR}/${f}" "${TARGET}/${f}"
done
echo "==> Extension files copied."

# --- Find Python interpreter ---
PYTHON=""
if command -v "${HERMES_PYTHON:-}" >/dev/null 2>&1; then
  PYTHON="${HERMES_PYTHON}"
elif [ -x "$HOME/.hermes/hermes-agent/venv/bin/python" ]; then
  PYTHON="$HOME/.hermes/hermes-agent/venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
else
  echo "ERROR: No Python interpreter found. Set \$HERMES_PYTHON or install python3." >&2
  exit 1
fi
echo "==> Python: ${PYTHON}"

# --- Platform-specific setup ---
UNAME_S="$(uname -s)"

if [ "${UNAME_S}" = "Darwin" ]; then
  # macOS: generate and load a launchd LaunchAgent
  LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "${LAUNCH_AGENTS_DIR}"

  # Derive a label from the current user's short name
  USER_SHORT="$(id -un)"
  LABEL="dev.${USER_SHORT}.delegation-monitor"
  PLIST_PATH="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"

  # Resolve absolute paths for the plist
  REFRESH_PY="$(cd "${TARGET}" && pwd)/refresh.py"
  DATA_DIR="$(cd "${TARGET}" && pwd)/data"

  cat > "${PLIST_PATH}" <<-PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${PYTHON}</string>
        <string>${REFRESH_PY}</string>
    </array>
    <key>WatchPaths</key>
    <array>
        <string>${DATA_DIR}</string>
    </array>
    <key>StartInterval</key>
    <integer>10</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/${LABEL}.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/${LABEL}.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HERMES_WEBUI_EXTENSION_ROOT</key>
        <string>${EXT_ROOT}</string>
    </dict>
</dict>
</plist>
PLISTEOF

  echo "==> LaunchAgent plist created: ${PLIST_PATH}"

  # Unload first if already loaded (idempotent)
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}" 2>/dev/null || true
  echo "==> LaunchAgent loaded. Refresh runs every 10 seconds."

elif [ "${UNAME_S}" = "Linux" ]; then
  echo "==> Linux detected."
  echo ""
  echo "To set up periodic refresh, choose one of the following:"
  echo ""
  echo "--- Option A: systemd timer ---"
  echo "Create /etc/systemd/system/delegation-monitor.service:"
  echo ""
  echo "  [Unit]"
  echo "  Description=Delegation Monitor refresh"
  echo "  [Service]"
  echo "  Type=oneshot"
  echo "  ExecStart=${PYTHON} ${TARGET}/refresh.py"
  echo "  Environment=HERMES_WEBUI_EXTENSION_ROOT=${EXT_ROOT}"
  echo ""
  echo "Create /etc/systemd/system/delegation-monitor.timer:"
  echo ""
  echo "  [Unit]"
  echo "  Description=Run delegation-monitor every 10s"
  echo "  [Timer]"
  echo "  OnBootSec=10s"
  echo "  OnUnitActiveSec=10s"
  echo "  [Install]"
  echo "  WantedBy=timers.target"
  echo ""
  echo "Then: sudo systemctl daemon-reload && sudo systemctl enable --now delegation-monitor.timer"
  echo ""
  echo "--- Option B: crontab ---"
  echo "Add to your crontab (crontab -e):"
  echo ""
  echo "  * * * * * ${PYTHON} ${TARGET}/refresh.py"
  echo ""
  echo "(For 10-second intervals, use a sleep loop wrapper or install the systemd timer above.)"
  echo ""
  echo "==> Manual setup required — no automatic scheduler configured."
else
  echo "==> Unsupported platform: ${UNAME_S}"
  echo "    Manual setup required. Run ${PYTHON} ${TARGET}/refresh.py periodically."
fi

echo "==> Done. Reload hermes-webui in your browser to see the extension."
