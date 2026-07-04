import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import request from "supertest";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import app, { imageCache } from "../src/app";

// Mock the S3 client at the prototype level — the app's shared client is
// intercepted without any real network calls.
const s3Mock = mockClient(S3Client);

const sampleImage = fs.readFileSync(path.resolve("scripts/sample.jpg"));

// supertest parses JSON by default; images need a raw binary parser
const binaryParser = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

const mockS3WithSample = () => {
  // Body is a fresh Readable per call — a stream can only be consumed once
  s3Mock.on(GetObjectCommand).callsFake(() => ({
    Body: Readable.from(sampleImage),
  }));
};

const getImage = (url: string) =>
  request(app).get(url).buffer(true).parse(binaryParser);

// The cache write happens on stream end, a tick after the response resolves
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  s3Mock.reset();
  imageCache.clear();
});

describe("GET /", () => {
  it("responds with a health message", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("running");
  });
});

describe("GET /images/* — streamed image processing", () => {
  it("streams back a resized jpeg", async () => {
    mockS3WithSample();

    const res = await getImage("/images/sample.jpg?w=100");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");

    const meta = await sharp(res.body).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeLessThanOrEqual(100);
  });

  it("resizes by height while preserving aspect ratio (fit: inside)", async () => {
    mockS3WithSample();
    const original = await sharp(sampleImage).metadata();

    const res = await getImage("/images/sample.jpg?h=50");

    expect(res.status).toBe(200);
    const meta = await sharp(res.body).metadata();
    expect(meta.height).toBeLessThanOrEqual(50);
    // aspect ratio preserved within rounding error
    const originalRatio = original.width! / original.height!;
    const newRatio = meta.width! / meta.height!;
    expect(Math.abs(originalRatio - newRatio)).toBeLessThan(0.1);
  });

  it("converts to webp on request", async () => {
    mockS3WithSample();

    const res = await getImage("/images/sample.jpg?format=webp&w=80");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    const meta = await sharp(res.body).metadata();
    expect(meta.format).toBe("webp");
  });

  it("sends long-lived cache headers", async () => {
    mockS3WithSample();

    const res = await getImage("/images/sample.jpg?w=100");

    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("handles nested keys (subfolders)", async () => {
    mockS3WithSample();

    const res = await getImage("/images/products/2026/sample.jpg?w=60");

    expect(res.status).toBe(200);
    const call = s3Mock.commandCalls(GetObjectCommand)[0];
    expect(call.args[0].input.Key).toBe("products/2026/sample.jpg");
  });
});

describe("in-memory LRU cache", () => {
  it("serves repeat requests from cache without hitting S3 again", async () => {
    mockS3WithSample();

    const first = await getImage("/images/sample.jpg?w=100");
    expect(first.headers["x-cache"]).toBe("MISS");
    await settle();

    const second = await getImage("/images/sample.jpg?w=100");
    expect(second.status).toBe(200);
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(Buffer.compare(first.body, second.body)).toBe(0);
    expect(s3Mock.commandCalls(GetObjectCommand).length).toBe(1);
  });

  it("caches different parameter combinations separately", async () => {
    mockS3WithSample();

    await getImage("/images/sample.jpg?w=100");
    await settle();
    const other = await getImage("/images/sample.jpg?w=50");

    expect(other.headers["x-cache"]).toBe("MISS");
    expect(s3Mock.commandCalls(GetObjectCommand).length).toBe(2);
  });

  it("normalizes jpg and jpeg to the same cache entry", async () => {
    mockS3WithSample();

    await getImage("/images/sample.jpg?w=100&format=jpg");
    await settle();
    const second = await getImage("/images/sample.jpg?w=100&format=jpeg");

    expect(second.headers["x-cache"]).toBe("HIT");
    expect(s3Mock.commandCalls(GetObjectCommand).length).toBe(1);
  });
});

describe("logging", () => {
  it("logs the request line and image stats (bytes in/out, duration)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockS3WithSample();

    await getImage("/images/sample.jpg?w=100");
    await settle();

    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("GET /images/sample.jpg"))).toBe(true);
    const stats = lines.find((l) => l.startsWith("[image]"));
    expect(stats).toBeDefined();
    expect(stats).toMatch(/in=\d+B/);
    expect(stats).toMatch(/out=\d+B/);
    expect(stats).toMatch(/\d+ms/);
    expect(stats).toContain("cache=MISS");

    spy.mockRestore();
  });
});

describe("validation", () => {
  it.each([
    ["negative width", "/images/a.jpg?w=-5"],
    ["zero height", "/images/a.jpg?h=0"],
    ["non-numeric width", "/images/a.jpg?w=abc"],
    ["width above cap", "/images/a.jpg?w=99999"],
    ["height above cap", "/images/a.jpg?h=99999"],
    ["quality above 100", "/images/a.jpg?q=101"],
    ["quality below 1", "/images/a.jpg?q=0"],
    ["disallowed format", "/images/a.jpg?format=gif"],
  ])("rejects %s with 400", async (_label, url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    // validation must fail fast — S3 should never be called
    expect(s3Mock.commandCalls(GetObjectCommand).length).toBe(0);
  });
});

describe("error handling", () => {
  it("returns 404 when the image does not exist in S3", async () => {
    const err = new Error("The specified key does not exist.");
    err.name = "NoSuchKey";
    s3Mock.on(GetObjectCommand).rejects(err);

    const res = await request(app).get("/images/missing.jpg");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("missing.jpg");
  });

  it("returns 500 on unexpected S3 failures", async () => {
    s3Mock.on(GetObjectCommand).rejects(new Error("connection reset"));

    const res = await request(app).get("/images/sample.jpg");
    expect(res.status).toBe(500);
  });
});
