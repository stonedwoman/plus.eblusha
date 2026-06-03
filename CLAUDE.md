# Eblusha Plus (Еблуша) — working agreement

Self-hosted messenger. Live at **https://eblusha.org** (NOT plus.eblusha.org).
Frontend: React 19 + Vite (`frontend/`). Backend: Node + TS + Prisma + LiveKit SFU (`src/`).

## ALWAYS rebuild what changed, then commit (standing instruction)

After ANY code change, do BOTH automatically — do not ask first:

1. **Rebuild whatever was changed**
   - Frontend (`frontend/`): `cd frontend && npm run build`
     → outputs `frontend/dist/`, which nginx bind-mounts and serves live. A browser
     hard-refresh (Ctrl+Shift+R) loads the new hashed bundle. Typecheck first with
     `npx tsc --noEmit -p tsconfig.json`.
   - Backend (`src/`): rebuild + restart the containers:
     `docker compose -f deploy/docker-compose.full.yml --env-file .env build backend worker maintenance`
     then `... up -d`. Typecheck with `npm run build` (runs `tsc`).
   - Front + back together: `npm run deploy` (builds frontend, rebuilds backend
     containers, restarts the stack).

2. **Commit and push** with a clear message, ending with the trailer:
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Never commit secrets
Private keys and `*.bak` backups stay out of git — `deploy/certs/` and `*.bak` are
gitignored. Do not force-add them.

## Notes
- `frontend/public/{s,v,w}/*.json` are runtime status files the app rewrites; they show
  as "modified" constantly. They are noise — don't include them in code commits.
