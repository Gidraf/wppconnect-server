#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# fix-stale-session.sh
# Wipes the stale WPPConnect userDataDir for a session so the next start
# generates a fresh QR code instead of immediately disconnecting.
#
# Usage:  bash fix-stale-session.sh [session_id]
# If no session_id given, wipes ALL sessions.
# Run from the wppconnect-server directory.
# ─────────────────────────────────────────────────────────────────────────────

WPP_CONTAINER="wpp-server"
USERDATA_DIR="/usr/src/wpp-server/userDataDir"
SESSION="${1:-}"

if [ -z "$SESSION" ]; then
  echo "⚠️  No session ID given – wiping ALL userDataDir sessions"
  echo "Press Ctrl+C to cancel, Enter to continue..."
  read
  docker exec "$WPP_CONTAINER" sh -c "
    for d in ${USERDATA_DIR}/*/; do
      echo \"Wiping: \$d\"
      rm -rf \"\$d\"*
    done
    echo 'Done – all session data wiped'
  "
else
  echo "Wiping session: $SESSION"
  docker exec "$WPP_CONTAINER" sh -c "
    TARGET='${USERDATA_DIR}/${SESSION}'
    if [ -d \"\$TARGET\" ]; then
      rm -rf \"\$TARGET\"/*
      echo 'Wiped: \$TARGET'
    else
      echo 'Session dir not found: \$TARGET'
      ls '${USERDATA_DIR}/' 2>/dev/null || echo 'userDataDir is empty or missing'
    fi
  "
fi

echo ""
echo "Now restart the session from your dashboard to get a fresh QR code."