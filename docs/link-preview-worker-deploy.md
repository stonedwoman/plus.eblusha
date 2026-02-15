# Link Preview Worker Deploy Notes

`link preview` must run as a separate worker process/container from the API server.

## Process split

- API: `npm run start` (`dist/server.js`)
- Worker: `npm run start:worker` (`dist/worker.js`)

## Network isolation requirement

The worker performs outbound HTTP fetches to untrusted URLs. Run it in a restricted network policy:

- deny egress to RFC1918/private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
- deny loopback/link-local/multicast ranges (`127.0.0.0/8`, `169.254.0.0/16`, `224.0.0.0/4`, IPv6 local/link-local/multicast)
- deny access to cluster/VPC internal ranges used in your environment
- allow only public internet egress on `80/443` for the worker

Even with in-code SSRF checks, this network policy is mandatory as defense-in-depth.

## Host vs Docker environment mismatch

Common failure mode: API/worker run via `systemd` on host, but env values assume Docker DNS.

### Symptoms

- `REDIS_URL=redis://redis:6379` on host (without Docker DNS) causes Redis connection failures
- enqueue fails, worker does not consume jobs, pub/sub bridge does not emit `message:update`
- login/API routes may degrade to `500/502` depending on error handling
- if worker points to another `DATABASE_URL`/volume, previews are written to a different database

### Quick diagnostics (on host)

- check effective service env:
  - `systemctl show <service> -p Environment`
  - inspect unit file and drop-ins under `/etc/systemd/system/`
- check Redis resolve/connect:
  - `getent hosts redis` (empty output on host usually means wrong `REDIS_URL`)
  - `redis-cli -u "$REDIS_URL" ping` (must return `PONG`)
- ensure API and worker use the same targets:
  - compare `REDIS_URL` and `DATABASE_URL` for API and worker services

### Recommended setup

- host/systemd:
  - use loopback or real hostnames/FQDNs, for example `redis://127.0.0.1:6379`
- Docker compose:
  - service names are fine, for example `redis://redis:6379`, only if API and worker are in the same compose network
- keep separate env templates:
  - `.env.host` for host runtime
  - `.env.docker` for compose runtime
