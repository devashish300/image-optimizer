import "dotenv/config"; // loads .env into process.env — must be the first import
import express, { Request, Response } from "express";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { Readable } from "stream";

const app = express();
const MAX_DIMENSION = 4096; // reject absurd resize requests (memory/CPU DoS guard)

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

app.get("/", (req, res) => {
  res.send("Image optimizer is running");
});

app.get(/^\/images\/(.*)/, async (req: Request, res: Response) => {
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
    transformer = transformer.toFormat(formatMap[outputFormat], { quality });

    res.setHeader("Content-Type", `image/${formatMap[outputFormat]}`);
    // Processed images are immutable for a given URL, so cache aggressively
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    // If sharp fails mid-stream (e.g. corrupt image), headers may already be
    // sent — in that case the only correct move is to kill the connection so
    // the client sees a truncated response instead of a corrupt "200 OK" image.
    transformer.on("error", (err) => {
      console.error("Image processing stream error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to process image" });
      } else {
        res.destroy();
      }
    });

    const body = s3Response.Body as Readable;
    body.on("error", (err) => {
      console.error("S3 stream error:", err);
      res.destroy();
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
