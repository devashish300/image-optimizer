const { S3Client, CreateBucketCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");

const client = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  forcePathStyle: true,
});

async function setup() {
  try {
    await client.send(new CreateBucketCommand({ Bucket: "my-images" }));
    console.log("Bucket created: my-images");
  } catch (err) {
    console.log("Bucket may already exist, continuing...");
  }

  const imageBuffer = fs.readFileSync("scripts/sample.jpg");
  await client.send(new PutObjectCommand({
    Bucket: "my-images",
    Key: "sample.jpg",
    Body: imageBuffer,
  }));
  console.log("Uploaded sample.jpg to bucket");
}

setup();