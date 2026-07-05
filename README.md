# Image Optimizer

An on-the-fly image optimization microservice built with **Express 5**, **Sharp**, and **AWS S3**. Request any image stored in S3 with resize, format, and quality parameters in the URL, and get back an optimized version — streamed, not buffered, so memory stays flat regardless of source image size.

```
GET /images/products/hero.jpg?w=800&format=webp&q=75
```

## How it works

```
Client ──► Express ──► S3 (GetObject stream)
                            │
                            ▼
                      Sharp transform stream (resize / convert / compress)
                            │
                            ▼
                      HTTP response (streamed, cached 1 year)
```

The S3 object is piped through a Sharp transform stream directly into the HTTP response. The original image is never fully loaded into memory.

## API

### `GET /images/<key>`

`<key>` is the S3 object key — subfolders work (`/images/products/2026/photo.jpg`).

| Query param | Type | Default | Description |
|---|---|---|---|
| `w` | int (1–4096) | — | Max width. Aspect ratio is preserved (`fit: inside`). |
| `h` | int (1–4096) | — | Max height. Aspect ratio is preserved. |
| `format` | `jpg` `jpeg` `png` `webp` `avif` | `jpeg` | Output format. |
| `q` | int (1–100) | `80` | Output quality. |

**Responses:** `200` optimized image · `400` invalid parameters · `404` key not found in S3 · `500` processing failure.

Successful responses include `Cache-Control: public, max-age=31536000, immutable` — a given URL always produces the same output, so CDNs and browsers can cache indefinitely. An `X-Cache: HIT | MISS` header reports whether the response came from the in-memory cache.

## Caching strategy

Two layers:

1. **HTTP / CDN layer** — every response carries `Cache-Control: public, max-age=31536000, immutable`. A given URL always produces identical bytes, so browsers and CDNs can cache for a year without revalidation.
2. **In-memory LRU** — processed outputs are cached in-process (100 MB budget, 5 MB per-item cap, least-recently-used eviction). Hot images on repeat requests skip S3 and Sharp entirely and are served from memory (`X-Cache: HIT`). Outputs over 5 MB are streamed through without being cached.

The LRU is per-instance; running multiple replicas would warrant a shared cache (Redis) or relying purely on the CDN layer.

## Logging & observability

Every request logs one line with method, path, status, and duration:

```
GET /images/sample.jpg?w=300&format=webp 200 184.2ms
```

Every image operation additionally logs processing stats — bytes in (original from S3), bytes out (optimized), processing time, and cache result:

```
[image] sample.jpg webp w=300 h=- q=80 in=248301B out=18450B 179ms cache=MISS
[image] sample.jpg webp w=300 h=- q=80 out=18450B 1ms cache=HIT
```

## Getting started (local dev with MinIO)

Requires Node 20+ and Docker.

```bash
# 1. Install dependencies
npm install

# 2. Start MinIO (local S3-compatible storage)
docker compose up -d

# 3. Configure environment
cp .env.example .env   # defaults already match the MinIO container

# 4. Create the bucket and upload a sample image
npm run setup:local

# 5. Run the dev server
npm run dev
```

Try it: <http://localhost:3000/images/sample.jpg?w=300&format=webp>

### Environment variables

| Variable | Description |
|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 credentials (`minioadmin` for local MinIO) |
| `AWS_S3_BUCKET` | Bucket to serve images from |
| `AWS_REGION` | AWS region |
| `S3_ENDPOINT` | Only for MinIO/local dev — omit for real AWS |
| `PORT` | Server port (default `3000`) |

## Tests

```bash
npm test
```

Vitest + Supertest, with the S3 client mocked (`aws-sdk-client-mock`) — no network or Docker needed. Covers the streamed pipeline end-to-end (real Sharp processing on a real image), resize/aspect-ratio behavior, format conversion, cache headers, LRU cache hits/misses and key normalization, request/stats logging, nested keys, parameter validation, and S3 error mapping.

## Run with Docker

The whole stack (service + MinIO) runs in containers:

```bash
docker compose up --build
```

The app is built with a multi-stage Dockerfile (TypeScript compiled in a build stage, production image ships only compiled JS + prod dependencies). The app container reads its configuration from your `.env` file:

- **Real AWS S3** — omit `S3_ENDPOINT` from `.env`; the service talks directly to AWS using your credentials.
- **Local MinIO** — set `S3_ENDPOINT=http://minio:9000` (the container hostname, not localhost, since the app runs inside the compose network).

From your machine everything stays on the usual ports (app 3000, MinIO 9000/9001).

## Production build

```bash
npm run build   # compiles TypeScript to dist/
npm start       # runs dist/server.js
```

## Assumptions & edge case handling

- **No authentication** — per the spec, the service assumes internal use (e.g. behind a CDN/gateway). Rate limiting and auth would be added at the gateway layer before public exposure.
- **Missing S3 key** → `404` with a JSON error; unexpected S3 failures → `500`.
- **Invalid parameters** (non-numeric, zero/negative, `q` outside 1–100, unknown `format`) → `400` with a descriptive message, rejected before S3 is ever contacted.
- **Oversized dimension requests** — `w`/`h` are capped at 4096 to prevent memory/CPU exhaustion from a single malicious request.
- **`jpg` vs `jpeg`** — treated as the same format (normalized), including in the cache key.
- **Corrupt/non-image objects in the bucket** — Sharp fails mid-stream; if headers were already sent the connection is destroyed rather than delivering a corrupt image with a 200 status.
- **Very large outputs** (>5 MB) — streamed to the client but not cached, so one huge image can't evict the whole cache.
- **No enlargement guard is intentional** — `fit: inside` preserves aspect ratio; upscaling beyond source size is allowed since consumers may legitimately request it.
- **Quality default** — `q` defaults to 80 when omitted.

## Design notes & tradeoffs

- **Streaming over buffering** — S3 → Sharp → response is a single pipe. Errors mid-stream after headers are sent destroy the connection rather than sending a corrupt 200.
- **Dimension cap (4096)** — prevents a `?w=999999` request from exhausting CPU/memory.
- **Shared S3 client** — one client instance reused across requests.
- **Two-layer caching** — CDN/browser via immutable cache headers, plus an in-process byte-budgeted LRU for CDN-miss traffic. A shared Redis cache would be the next step for multi-instance deployments.
