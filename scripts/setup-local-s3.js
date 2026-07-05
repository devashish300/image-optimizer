const { S3Client, CreateBucketCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");

const client = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  forcePathStyle: true,
});

async function upload(filePath, key) {
  await client.send(new PutObjectCommand({
    Bucket: "my-images",
    Key: key,
    Body: fs.readFileSync(filePath),
  }));
  console.log(`Uploaded: ${key}`);
}

async function setup() {
  try {
    await client.send(new CreateBucketCommand({ Bucket: "my-images" }));
    console.log("Bucket created: my-images");
  } catch (err) {
    console.log("Bucket may already exist, continuing...");
  }

  // Always upload the base sample image
  await upload(path.join(__dirname, "sample.jpg"), "sample.jpg");

  // Upload every image found in scripts/seed-images/ (drop your own in there)
  const seedDir = path.join(__dirname, "seed-images");
  if (fs.existsSync(seedDir)) {
    const images = fs.readdirSync(seedDir).filter((f) =>
      /\.(jpe?g|png|webp|avif|gif|tiff?)$/i.test(f)
    );
    for (const file of images) {
      await upload(path.join(seedDir, file), file);
    }
    if (images.length === 0) console.log("(seed-images folder is empty — add images there to seed more)");
  }

  console.log("Done.");
}

setup();
