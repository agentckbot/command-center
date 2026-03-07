#!/bin/bash
# deploy.sh — Enterprise deployment pipeline
# Only deploys from main branch. Runs full test suite first.
set -e

cd "$(dirname "$0")"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMIT=$(git rev-parse --short HEAD)
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

echo "============================================"
echo "  Command Center — Deploy Pipeline"
echo "  Branch: $BRANCH | Commit: $COMMIT"
echo "  Time:   $TIMESTAMP"
echo "============================================"
echo ""

# [0/5] Verify we're on main
echo "[0/5] Checking branch..."
if [ "$BRANCH" != "main" ]; then
  echo "❌ ABORT: Must deploy from 'main' branch (currently on '$BRANCH')"
  echo "   Merge your feature branch first: git checkout main && git merge <branch>"
  exit 1
fi

# [1/5] Check for uncommitted changes
echo "[1/5] Checking working tree..."
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ ABORT: Uncommitted changes detected. Commit or stash first."
  git status --short
  exit 1
fi

# [2/5] Run server tests
echo "[2/5] Running server tests..."
(cd server && npx vitest run --reporter=verbose 2>&1) | tee /tmp/cc-test-server.log
SERVER_EXIT=${PIPESTATUS[0]}
if [ $SERVER_EXIT -ne 0 ]; then
  echo "❌ ABORT: Server tests failed"
  # Save results
  echo '{"server":"FAIL","client":"SKIPPED","timestamp":"'"$TIMESTAMP"'","commit":"'"$COMMIT"'"}' > tests/last-run.json 2>/dev/null || true
  exit 1
fi

# [3/5] Run client tests
echo "[3/5] Running client tests..."
(cd client && npx vitest run --reporter=verbose 2>&1) | tee /tmp/cc-test-client.log
CLIENT_EXIT=${PIPESTATUS[0]}
if [ $CLIENT_EXIT -ne 0 ]; then
  echo "❌ ABORT: Client tests failed"
  echo '{"server":"PASS","client":"FAIL","timestamp":"'"$TIMESTAMP"'","commit":"'"$COMMIT"'"}' > tests/last-run.json 2>/dev/null || true
  exit 1
fi

# [4/5] Build client
echo "[4/5] Building client..."
(cd client && npm run build)

# [5/5] Restart server
echo "[5/5] Restarting server..."
# Kill existing server if running
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
sleep 1

# Start production server
cd server
nohup npx tsx src/index.ts > /tmp/cc-server.log 2>&1 &
SERVER_PID=$!
sleep 2

# Verify it's running
if curl -s http://localhost:3000/ > /dev/null 2>&1; then
  echo ""
  echo "============================================"
  echo "  ✅ Deploy successful!"
  echo "  Commit: $COMMIT"
  echo "  Server PID: $SERVER_PID"
  echo "  URL: http://localhost:3000"
  echo "============================================"
  
  # Save success results
  cd "$(dirname "$0")"
  mkdir -p tests
  echo '{"server":"PASS","client":"PASS","deploy":"OK","timestamp":"'"$TIMESTAMP"'","commit":"'"$COMMIT"'","pid":'"$SERVER_PID"'}' > tests/last-run.json
else
  echo "❌ Server failed to start. Check /tmp/cc-server.log"
  echo '{"server":"PASS","client":"PASS","deploy":"FAIL","timestamp":"'"$TIMESTAMP"'","commit":"'"$COMMIT"'"}' > tests/last-run.json 2>/dev/null || true
  exit 1
fi
