#!/bin/bash
# =============================================================================
# clear-broken-session.sh
# Clears the stale token and userDataDir for a session so the next start
# generates completely fresh cryptographic keys and a scannable QR code.
#
# Run ONCE on the server, then trigger reconnect from the dashboard.
# Usage:  bash clear-broken-session.sh cmj60plti000009ldtdyy27yq
# =============================================================================
set -e

SESSION="${1:-cmj60plti000009ldtdyy27yq}"
WPP_CONTAINER="wpp-server"
USERDATA_PATH="/usr/src/wpp-server/userDataDir/${SESSION}"
TOKEN_PATH="/usr/src/wpp-server/tokens/${SESSION}.data.json"

echo "═══════════════════════════════════════════════════"
echo " Clearing broken session: $SESSION"
echo "═══════════════════════════════════════════════════"

echo ""
echo "1. Wiping userDataDir (stale Chromium profile)..."
docker exec "$WPP_CONTAINER" sh -c "
  if [ -d '${USERDATA_PATH}' ]; then
    rm -rf '${USERDATA_PATH}'
    echo '   ✅ Wiped: ${USERDATA_PATH}'
  else
    echo '   (not found – ok)'
  fi
"

echo ""
echo "2. Deleting file token (stale session keys)..."
docker exec "$WPP_CONTAINER" sh -c "
  if [ -f '${TOKEN_PATH}' ]; then
    rm -f '${TOKEN_PATH}'
    echo '   ✅ Deleted: ${TOKEN_PATH}'
  else
    echo '   (not found – ok)'
  fi
  # Also check for .json without .data extension
  ALT='/usr/src/wpp-server/tokens/${SESSION}.json'
  if [ -f \"\$ALT\" ]; then
    rm -f \"\$ALT\"
    echo '   ✅ Deleted: \$ALT'
  fi
"

echo ""
echo "3. Confirming cleanup..."
docker exec "$WPP_CONTAINER" sh -c "
  echo '   userDataDir exists: $([ -d ${USERDATA_PATH} ] && echo YES || echo no)'
  echo '   token file exists:  $(ls /usr/src/wpp-server/tokens/${SESSION}* 2>/dev/null && echo YES || echo no)'
"

echo ""
echo "═══════════════════════════════════════════════════"
echo " ✅ Done. Session state cleared."
echo ""
echo " Next steps:"
echo "   1. Go to your dashboard → Integrations"
echo "   2. Click 'Connect' on WhatsApp"
echo "   3. A fresh QR code with new keys will appear"
echo "   4. Scan it within 5 minutes"
echo "═══════════════════════════════════════════════════"