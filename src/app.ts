import "dotenv/config"; // loads .env into process.env — must be the first import
import express, { Request, Response, NextFunction } from "express";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { Readable } from "stream";

const app = express();
const MAX_DIMENSION = 4096; // reject absurd resize requests (memory/CPU DoS guard)
const CACHE_CONTROL = "public, max-age=31536000, immutable";

// ---------------------------------------------------------------------------
// In-memory LRU response cache (layer 2 of the caching strategy).
// Layer 1 is the Cache-Control header above: CDNs and browsers cache the
// response for a year since a given URL always produces identical bytes.
// This LRU covers CDN misses and direct traffic — hot images are served
// from memory without touching S3 or sharp again.
// ---------------------------------------------------------------------------
const CACHE_MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB total budget
const CACHE_MAX_ITEM_BYTES = 5 * 1024 * 1024; // skip caching outputs over 5 MB

interface CacheEntry {
  buffer: Buffer;
  contentType: string;
}

class LruByteCache {
  private map = new Map<string, CacheEntry>();
  private totalBytes = 0;

  get(key: string): CacheEntry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Map preserves insertion order — re-inserting marks this key most recent
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    if (entry.buffer.length > CACHE_MAX_ITEM_BYTES) return;
    const existing = this.map.get(key);
    if (existing) {
      this.totalBytes -= existing.buffer.length;
      this.map.delete(key);
    }
    this.map.set(key, entry);
    this.totalBytes += entry.buffer.length;
    // Evict least-recently-used entries until back under budget
    for (const [k, v] of this.map) {
      if (this.totalBytes <= CACHE_MAX_TOTAL_BYTES) break;
      this.map.delete(k);
      this.totalBytes -= v.buffer.length;
    }
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }
}

export const imageCache = new LruByteCache();

// One shared S3 client for the whole app — reused across every request,
// not recreated per request (that would be wasteful)
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  endpoint: process.env.S3_ENDPOINT, // only used for MinIO/local dev; omit for real AWS
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET!;

// ---------------------------------------------------------------------------
// Request logging: one line per request with method, path, status, duration
// ---------------------------------------------------------------------------
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
});

app.get("/", (req, res) => {
  res.send("Image optimizer is running");
});

app.get(/^\/images\/(.*)/, async (req: Request, res: Response) => {
  const t0 = Date.now();
  const imagePath = req.params[0];
  const { h, w, format, q } = req.query;

  const height = h ? parseInt(h as string, 10) : undefined;
  const width = w ? parseInt(w as string, 10) : undefined;
  const quality = q ? parseInt(q as string, 10) : 80;

  if (height !== undefined && (isNaN(height) || height <= 0 || height > MAX_DIMENSION)) {
    return res.status(400).json({ error: `Invalid height, must be 1-${MAX_DIMENSION}` });
  }
  if (width !== undefined && (isNaN(width) || width <= 0 || width > MAX_DIMENSION)) {
    return res.status(400).json({ error: `Invalid width, must be 1-${MAX_DIMENSION}` });
  }
  if (isNaN(quality) || quality < 1 || quality > 100) {
    return res.status(400).json({ error: "Invalid quality, must be 1-100" });
  }

  const allowedFormats = ["jpg", "jpeg", "png", "webp", "avif"];
  const outputFormat = (format as string) || "jpeg";
  if (!allowedFormats.includes(outputFormat)) {
    return res.status(400).json({ error: `Invalid format. Allowed: ${allowedFormats.join(", ")}` });
  }

  const formatMap: Record<string, "jpeg" | "png" | "webp" | "avif"> = {
    jpg: "jpeg",
    jpeg: "jpeg",
    png: "png",
    webp: "webp",
    avif: "avif",
  };
  const fmt = formatMap[outputFormat];

  // Normalized key: jpg and jpeg map to the same entry
  const cacheKey = `${imagePath}|w=${width ?? ""}|h=${height ?? ""}|f=${fmt}|q=${quality}`;

  const cached = imageCache.get(cacheKey);
  if (cached) {
    res.setHeader("Content-Type", cached.contentType);
    res.setHeader("Cache-Control", CACHE_CONTROL);
    res.setHeader("X-Cache", "HIT");
    res.send(cached.buffer);
    console.log(
      `[image] ${imagePath} ${fmt} w=${width ?? "-"} h=${height ?? "-"} q=${quality} out=${cached.buffer.length}B ${Date.now() - t0}ms cache=HIT`
    );
    return;
  }

  try {
    // 1. Fetch the original image from S3
    const s3Response = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: imagePath })
    );

    // 2. Build a sharp transform stream. The image is piped through it chunk
    // by chunk — the original is never fully buffered in this process, which
    // keeps memory flat no matter how large the source image is.
    let transformer = sharp();
    if (width || height) {
      transformer = transformer.resize(width, height, { fit: "inside" });
    }
    transformer = transformer.toFormat(fmt, { quality });

    res.setHeader("Content-Type", `image/${fmt}`);
    res.setHeader("Cache-Control", CACHE_CONTROL);
    res.setHeader("X-Cache", "MISS");

    // Stats + cache collection. Extra 'data' listeners don't disturb pipe() —
    // every consumer of a flowing stream receives the same chunks.
    let bytesIn = 0;
    let bytesOut = 0;
    let failed = false;
    let overflow = false;
    const outChunks: Buffer[] = [];

    const body = s3Response.Body as Readable;
    body.on("data", (chunk: Buffer) => {
      bytesIn += chunk.length;
    });
    body.on("error", (err) => {
      failed = true;
      console.error("S3 stream error:", err);
      res.destroy();
    });

    transformer.on("data", (chunk: Buffer) => {
      bytesOut += chunk.length;
      if (!overflow) {
        outChunks.push(chunk);
        if (bytesOut > CACHE_MAX_ITEM_BYTES) {
          overflow = true; // too big to cache — keep streaming, stop collecting
          outChunks.length = 0;
        }
      }
    });

    // If sharp fails mid-stream (e.g. corrupt image), headers may already be
    // sent — in that case the only correct move is to kill the connection so
    // the client sees a truncated response instead of a corrupt "200 OK" image.
    transformer.on("error", (err) => {
      failed = true;
      console.error("Image processing stream error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to process image" });
      } else {
        res.destroy();
      }
    });

    transformer.on("end", () => {
      if (!failed && !overflow) {
        imageCache.set(cacheKey, {
          buffer: Buffer.concat(outChunks),
          contentType: `image/${fmt}`,
        });
      }
      console.log(
        `[image] ${imagePath} ${fmt} w=${width ?? "-"} h=${height ?? "-"} q=${quality} in=${bytesIn}B out=${bytesOut}B ${Date.now() - t0}ms cache=MISS`
      );
    });

    // 3. Stream: S3 → sharp → HTTP response
    body.pipe(transformer).pipe(res);
  } catch (err: any) {
    if (err.name === "NoSuchKey") {
      return res.status(404).json({ error: `Image not found: ${imagePath}` });
    }
    console.error(err);
    return res.status(500).json({ error: "Failed to process image" });
  }
});

export default app;
