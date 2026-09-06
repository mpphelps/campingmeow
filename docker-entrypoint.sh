#!/bin/sh
set -e

echo "[entrypoint] Running prisma migrate deploy..."
(cd /app/packages/database && npx prisma migrate deploy)

# `exec node ...` rather than `exec npx ...` on purpose.
#
# npx runs the server as a *child*, so npx is PID 1 and the server is not.
# When the server dies — killed by the kernel under memory pressure, say —
# npx notices, exits 0, and Docker records a clean exit. The real cause is
# thrown away: no signal, no exit code, no OOMKilled flag. That is exactly the
# blindness we hit chasing 12 silent restarts.
#
# Running node directly makes the server PID 1: signals reach it, its exit code
# is the container's exit code, and a kill shows up as 137 instead of 0.
echo "[entrypoint] Starting react-router-serve..."
exec node /app/node_modules/@react-router/serve/bin.js ./build/server/index.js
