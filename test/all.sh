#!/bin/bash
# Every test suite, one after another. Needs: Postgres on port 5433 with its socket in /tmp (user postgres, trust),
# run as root (the suites reset the test database with "su postgres"), and Playwright with Chromium for the page checks.
#   bash test/all.sh            all suites
#   bash test/all.sh kb roles   only these
cd "$(dirname "$0")/.." || exit 1
export NODE_PATH="${NODE_PATH:-$(npm root -g)}:$(pwd)/node_modules"
DB="postgresql://postgres@localhost:5433/recruiting_test?host=/tmp"
mkdir -p /tmp/shot
fresh() { # a new empty database and a server on it
  pkill -f "node src/serve[r].js" 2>/dev/null; sleep 0.4
  su postgres -c "psql -q -h /tmp -p 5433 -c 'DROP DATABASE IF EXISTS recruiting_test' -c 'CREATE DATABASE recruiting_test'" >/dev/null 2>&1
  DATABASE_URL="$DB" PGSSL=off ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=test-password-123 PORT=3999 nohup node src/server.js > /tmp/server.log 2>&1 &
  for i in $(seq 1 40); do curl -s localhost:3999/healthz >/dev/null && return 0; sleep 0.3; done
  echo "the server did not start"; tail -5 /tmp/server.log; return 1
}
suites=("$@"); [ ${#suites[@]} -eq 0 ] && suites=($(ls test/*.js | xargs -n1 basename | sed 's/\.js$//'))
bad=0; total=0
for t in "${suites[@]}"; do
  f="test/$t.js"; [ -f "$f" ] || { echo "no such suite: $t"; bad=1; continue; }
  if grep -q "'src/server.js'" "$f"; then :; else fresh || { bad=1; continue; }; fi   # a suite that starts the server itself, or one that needs it running
  out=$(DATABASE_URL="$DB" PGSSL=off timeout 900 node "$f" 2>&1); code=$?
  okn=$(echo "$out" | grep -c '^ok'); failn=$(echo "$out" | grep -c '^FAIL')
  total=$((total + okn))
  if [ "$failn" -gt 0 ] || [ "$code" -ne 0 ] || [ "$okn" -eq 0 ]; then bad=1; echo "FAILED  $t: $okn ok, $failn failed (exit $code)"; echo "$out" | grep -v '^ok' | tail -15 | sed 's/^/    /'
    # on GitHub: the failure as a note anyone can read (the full log needs a sign-in)
    [ -n "$GITHUB_ACTIONS" ] && echo "::error title=$t failed::$(echo "$out" | grep -v '^ok' | tail -8 | cut -c1-300 | tr '\n' '|' | sed 's/%/%25/g')"
  else echo "passed  $t: $okn checks"; fi
done
pkill -f "node src/serve[r].js" 2>/dev/null
echo "----"; [ $bad -eq 0 ] && echo "ALL PASSED: $total checks in ${#suites[@]} suites" || echo "SOME FAILED ($total checks passed)"
exit $bad
