# EBP2 Verification

## Prerequisites

- `STORAGE_ENC_KEY` set (hex or base64, 32 bytes)
- `STORAGE_ENC_V2=1` for new uploads
- Auth token for `/api/upload` and `/api/files/*`

## curl Commands

Replace `BASE` (e.g. `https://plus.eblusha.org`), `TOKEN`, and `FILE_PATH` (path segment from upload response url, e.g. `uploads/1234567890-xxx.eblusha`).

```bash
# 1. Upload a file (get url from response)
curl -X POST -H "Authorization: Bearer TOKEN" -F "file=@/path/to/test.mp4" "$BASE/api/upload"

# 2. HEAD — check Accept-Ranges, Content-Length (plaintext size)
curl -I -H "Authorization: Bearer TOKEN" "$BASE/api/files/$FILE_PATH"
# Expect: Accept-Ranges: bytes, Content-Length: <plaintext size>

# 3. Range bytes=0-1023 (first 1KB)
curl -H "Authorization: Bearer TOKEN" -H "Range: bytes=0-1023" "$BASE/api/files/$FILE_PATH" -o /dev/null -w "%{http_code}\n"
# Expect: 206

# 4. Range bytes=5000000-5001023 (middle 1KB)
curl -H "Authorization: Bearer TOKEN" -H "Range: bytes=5000000-5001023" "$BASE/api/files/$FILE_PATH" -o /dev/null -w "%{http_code}\n"
# Expect: 206
```

Note: `/api/files/*` may allow unauthenticated access depending on server config. If auth is required, add `-H "Authorization: Bearer TOKEN"`.

## chunkSize Tradeoffs (1MB default)

| chunkSize | Pros | Cons |
|-----------|------|------|
| 64KB | Fine Range granularity, low RAM per chunk | Many chunks, more S3 Range requests, higher overhead (28B nonce+tag per chunk) |
| 1MB | Good balance: modest overhead, reasonable seek granularity | Coarse for tiny Range requests (fetch 1 chunk ≈ 1MB) |
| 4MB | Fewer S3 requests for full download, less overhead | Coarser seek; each Range request may fetch up to 4MB |

**1MB chosen:** Typical video seeks request ~1MB; overhead is small; full-file decrypt streams in ~1MB chunks. Larger files (100MB+) benefit from Range without full decrypt.
