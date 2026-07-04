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

Successful responses include `Cache-Control: public, max-age=31536000, immutable` — a given URL always produces the same output, so CDNs and browsers can cache indefinitely.

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

Vitest + Supertest, with the S3 client mocked (`aws-sdk-client-mock`) — no network or Docker needed. Covers the streamed pipeline end-to-end (real Sharp processing on a real image), resize/aspect-ratio behavior, format conversion, cache headers, nested keys, parameter validation, and S3 error mapping.

## Production build

```bash
npm run build   # compiles TypeScript to dist/
npm start       # runs dist/server.js
```

## Design notes & tradeoffs

- **Streaming over buffering** — S3 → Sharp → response is a single pipe. Errors mid-stream after headers are sent destroy the connection rather than sending a corrupt 200.
- **Dimension cap (4096)** — prevents a `?w=999999` request from exhausting CPU/memory.
- **Shared S3 client** — one client instance reused across requests.
- **No result caching layer** — in production this service should sit behind a CDN (the immutable cache headers are designed for that); a Redis/disk cache would be the next addition for CDN-miss traffic.
