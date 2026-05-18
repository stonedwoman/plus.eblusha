# RU TURN relay

This directory contains a minimal `coturn` setup for the RU edge host so LiveKit clients can relay media through Russia instead of trying to reach the Romania SFU directly over UDP.

## 1. Prepare the RU host

1. Copy `turnserver.conf.example` to `turnserver.conf`.
2. Replace `REPLACE_WITH_TURN_SECRET` with a long random shared secret.
3. Open these ports on the RU host:
   - `3478/tcp`
   - `3478/udp`
   - `49160-49200/tcp`
   - `49160-49200/udp`
   - `5349/tcp` only if you enable TURN/TLS
4. If you want TURN/TLS, put the certificate and key into `./certs` and uncomment the TLS lines in `turnserver.conf`.

## 2. Start coturn on the RU host

```bash
cd /opt/eblusha-plus/deploy/coturn
cp turnserver.conf.example turnserver.conf
docker compose -f docker-compose.ru.yml up -d
docker logs -f eblusha-coturn
```

## 3. Point Romania LiveKit to the RU relay

Set these variables on the RO host before redeploying `eblusha-livekit`:

```bash
LIVEKIT_TURN_HOST=ru.eblusha.org
LIVEKIT_TURN_SECRET=<same shared secret as coturn>
LIVEKIT_TURN_UDP_PORT=3478
LIVEKIT_TURN_TCP_PORT=3478
# Optional if TURN/TLS is enabled on the RU host:
# LIVEKIT_TURN_TLS_PORT=5349
LIVEKIT_TURN_TTL=14400
```

Then redeploy the RO stack so LiveKit starts advertising the RU TURN server to clients.

## 4. Also expose LiveKit TCP fallback on the RO host

This repo now exposes LiveKit TCP on `7881/tcp`. Make sure the Romania firewall allows it in addition to:

- `7880/tcp`
- `58000-58100/udp`

TURN on the RU host is the important part for restricted networks, but `7881/tcp` gives LiveKit one more fallback path when UDP is unstable.
