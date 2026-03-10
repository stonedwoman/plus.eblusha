#!/bin/sh
set -e
# Run migrations on startup (idempotent)
npx prisma migrate deploy
exec "$@"
