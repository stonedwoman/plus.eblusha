# EBP2 Verification

## Prerequisites

- `STORAGE_ENC_KEY` set (hex or base64, 32 bytes)
- `STORAGE_ENC_V2=1` for new uploads
- Auth token for `/api/upload` and `/api/files/*`

## curl Commands

Replace `BASE` (e.g. `https://eblusha.org`), `TOKEN`, and `FILE_PATH` (path segment from upload response url, e.g. `uploads/1234567890-xxx.eblusha`).

```bash
# 1. Upload a file (get url from response)
curl -X POST -H "Authorization: Bearer TOKEN" -F "file=@/path/to/test.mp4" "$BASE/api/upload"

# 2. HEAD — check Accept-Ranges, Content-Length (plaintext size)
curl -I "$BASE/api/files/$FILE_PATH"

# 3. Full file (200)
curl -D - -o /dev/null "$BASE/api/files/$FILE_PATH"

# 4. Range bytes=0-1023 (206)
curl -D - -H "Range: bytes=0-1023" "$BASE/api/files/$FILE_PATH" -o /dev/null

# 5. Range bytes=5000000-5001023 (206)
curl -D - -H "Range: bytes=5000000-5001023" "$BASE/api/files/$FILE_PATH" -o /dev/null

# 6. Range too large (expect 416)
curl -D - -H "Range: bytes=0-20000000" "$BASE/api/files/$FILE_PATH" -o /dev/null
# Expect: 416 Range Not Satisfiable, Content-Range: bytes */<totalSize>
```

Note: Add `-H "Authorization: Bearer TOKEN"` if `/api/files/*` requires auth.

## Range limits by Content-Type

| Content-Type prefix | Max Range span |
|---------------------|----------------|
| video/*             | 64MB           |
| audio/*             | 16MB           |
| other               | 16MB           |

Exceeding the limit returns **416 Range Not Satisfiable** (not 400). EBP1: for files >50MB or oversized Range, Range is ignored and 200 full file is returned so `<video>` can play without seek.

## Expected Headers

### 200 (full file)

```
HTTP/1.1 200 OK
Content-Type: video/mp4
Content-Length: 12345678
Accept-Ranges: bytes
Content-Range: (absent)
Cache-Control: public, max-age=31536000, immutable
Access-Control-Expose-Headers: ETag, Content-Length, Content-Type, Last-Modified, Content-Range, Accept-Ranges
```

### 206 (Range)

```
HTTP/1.1 206 Partial Content
Content-Type: video/mp4
Content-Length: 1024
Content-Range: bytes 0-1023/12345678
Accept-Ranges: bytes
Cache-Control: public, max-age=31536000, immutable
Access-Control-Expose-Headers: ETag, Content-Length, Content-Type, Last-Modified, Content-Range, Accept-Ranges
```

### HEAD (metadata only)

```
HTTP/1.1 200 OK
Content-Type: video/mp4
Content-Length: 12345678
Accept-Ranges: bytes
```

### 416 (Range Not Satisfiable — too large or invalid)

```
HTTP/1.1 416 Range Not Satisfiable
Content-Range: bytes */12345678
Accept-Ranges: bytes
Content-Type: application/json
{"message":"Range too large (max 16MB). Requested: 20MB"}
```

## chunkSize Tradeoffs (1MB default)

| chunkSize | Pros | Cons |
|-----------|------|------|
| 64KB | Fine Range granularity, low RAM per chunk | Many chunks, more S3 Range requests, higher overhead (28B nonce+tag per chunk) |
| 1MB | Good balance: modest overhead, reasonable seek granularity | Coarse for tiny Range requests (fetch 1 chunk ≈ 1MB) |
| 4MB | Fewer S3 requests for full download, less overhead | Coarser seek; each Range request may fetch up to 4MB |

**1MB chosen:** Typical video seeks request ~1MB; overhead is small; full-file decrypt streams in ~1MB chunks. Larger files (100MB+) benefit from Range without full decrypt.

## Verification

1. **HEAD:** `curl -I "$BASE/api/files/$FILE_PATH"` — expect `Accept-Ranges: bytes`, `Content-Length`, `Content-Type`.
2. **Small Range (206):** `curl -D - -H "Range: bytes=0-1023" "$BASE/api/files/$FILE_PATH" -o /dev/null` — expect `HTTP/1.1 206`, `Content-Range: bytes 0-1023/<total>`, `Content-Length: 1024`.
3. **Range > limit (416):** `curl -D - -H "Range: bytes=0-20000000" "$BASE/api/files/$FILE_PATH" -o /dev/null` — expect `HTTP/1.1 416`, `Content-Range: bytes */<total>`, `Accept-Ranges: bytes`.
4. **Browser:** Use `<video src="/api/files/...">` — should play without crashing on 416 (browsers typically retry with a smaller range or fall back).
