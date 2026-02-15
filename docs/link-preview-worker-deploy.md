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
