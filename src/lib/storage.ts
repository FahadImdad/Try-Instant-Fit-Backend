import { Storage } from '@google-cloud/storage';

let _storage: Storage | null = null;

function getStorage(): Storage {
  if (_storage) return _storage;

  const keyJson = process.env.GOOGLE_CLOUD_KEY_JSON;
  let credentials: object | undefined;
  if (keyJson) {
    try {
      credentials = JSON.parse(keyJson);
    } catch {
      throw new Error('GOOGLE_CLOUD_KEY_JSON must be valid JSON');
    }
  }

  _storage = new Storage({
    projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
    credentials,
  });

  return _storage;
}

// Unique filename suffix avoids overwriting an existing object — overwrites in
// fine-grained-ACL buckets need storage.objects.delete on the prior object's
// ACLs, which the upload service account doesn't always have. Each upload
// creates a fresh path, the new URL is stored in the DB row, old objects become
// orphans (cheap to GC later).
function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function uploadIsolatedGarment(
  imageBuffer: Buffer,
  productId: string,
  mimeType = 'image/jpeg'
): Promise<string> {
  const bucketName = process.env.GOOGLE_CLOUD_BUCKET_NAME;
  if (!bucketName) throw new Error('GOOGLE_CLOUD_BUCKET_NAME is required');

  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const safeProductId = productId.replace(/[^a-zA-Z0-9-_]/g, '-');
  const fileName = `garments/${safeProductId}-${uniqueSuffix()}.${ext}`;

  const bucket = getStorage().bucket(bucketName);
  const file = bucket.file(fileName);

  await file.save(imageBuffer, {
    contentType: mimeType,
    metadata: { cacheControl: 'public, max-age=31536000' },
    public: true,
  });

  return `https://storage.googleapis.com/${bucketName}/${fileName}`;
}

export async function uploadProductImage(
  imageBuffer: Buffer,
  brandId: string,
  productId: string,
  mimeType = 'image/jpeg'
): Promise<string> {
  const bucketName = process.env.GOOGLE_CLOUD_BUCKET_NAME;
  if (!bucketName) throw new Error('GOOGLE_CLOUD_BUCKET_NAME is required');

  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const safeProductId = productId.replace(/[^a-zA-Z0-9-_]/g, '-');
  const fileName = `products/${brandId}/${safeProductId}-${uniqueSuffix()}.${ext}`;

  const bucket = getStorage().bucket(bucketName);
  const file = bucket.file(fileName);

  await file.save(imageBuffer, {
    contentType: mimeType,
    metadata: { cacheControl: 'public, max-age=31536000' },
    public: true,
  });

  return `https://storage.googleapis.com/${bucketName}/${fileName}`;
}

export async function uploadBrandLogo(
  imageBuffer: Buffer,
  brandId: string,
  mimeType = 'image/png'
): Promise<string> {
  const bucketName = process.env.GOOGLE_CLOUD_BUCKET_NAME;
  if (!bucketName) throw new Error('GOOGLE_CLOUD_BUCKET_NAME is required');
  const ext = mimeType === 'image/svg+xml' ? 'svg' : mimeType === 'image/webp' ? 'webp' : mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const fileName = `brands/${brandId}/logo.${ext}`;
  const bucket = getStorage().bucket(bucketName);
  await bucket.file(fileName).save(imageBuffer, {
    contentType: mimeType,
    metadata: { cacheControl: 'public, max-age=31536000' },
    public: true,
  });
  return `https://storage.googleapis.com/${bucketName}/${fileName}?v=${Date.now()}`;
}

export async function uploadPaymentScreenshot(
  imageBuffer: Buffer,
  brandId: string,
  mimeType = 'image/jpeg'
): Promise<string> {
  const bucketName = process.env.GOOGLE_CLOUD_BUCKET_NAME;
  if (!bucketName) throw new Error('GOOGLE_CLOUD_BUCKET_NAME is required');
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const fileName = `topups/${brandId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bucket = getStorage().bucket(bucketName);
  await bucket.file(fileName).save(imageBuffer, {
    contentType: mimeType,
    metadata: { cacheControl: 'public, max-age=31536000' },
    public: true,
  });
  return `https://storage.googleapis.com/${bucketName}/${fileName}`;
}

/**
 * Save a customer's input photo when they submit a "bad try-on" report.
 * Normally the input photo is ephemeral and never stored — but if a user
 * is unhappy with the AI result, we keep their photo alongside the report
 * so admin/AI ops can compare before vs. after and tune the model. Lives
 * under reports/ so it can be lifecycled separately from try-on assets.
 */
export async function uploadReportUserPhoto(
  imageBuffer: Buffer,
  brandId: string,
  mimeType = 'image/jpeg'
): Promise<string> {
  const bucketName = process.env.GOOGLE_CLOUD_BUCKET_NAME;
  if (!bucketName) throw new Error('GOOGLE_CLOUD_BUCKET_NAME is required');
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const fileName = `reports/${brandId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bucket = getStorage().bucket(bucketName);
  await bucket.file(fileName).save(imageBuffer, {
    contentType: mimeType,
    metadata: { cacheControl: 'public, max-age=31536000' },
    public: true,
  });
  return `https://storage.googleapis.com/${bucketName}/${fileName}`;
}

export async function uploadTryOnResult(
  imageBuffer: Buffer,
  brandId: string,
  mimeType = 'image/jpeg'
): Promise<string> {
  const bucketName = process.env.GOOGLE_CLOUD_BUCKET_NAME;
  if (!bucketName) throw new Error('GOOGLE_CLOUD_BUCKET_NAME is required');

  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const fileName = `tryons/${brandId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const bucket = getStorage().bucket(bucketName);
  const file = bucket.file(fileName);

  await file.save(imageBuffer, {
    contentType: mimeType,
    metadata: { cacheControl: 'public, max-age=31536000' },
    public: true,
  });

  return `https://storage.googleapis.com/${bucketName}/${fileName}`;
}
