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
  // Unique path per upload (see uniqueSuffix note above). A fixed `logo.ext`
  // path means every re-upload is an OVERWRITE, which fails in fine-grained-ACL
  // buckets where the service account lacks storage.objects.delete — the exact
  // bug behind "Failed to update profile" when a brand changes its logo.
  const fileName = `brands/${brandId}/logo-${uniqueSuffix()}.${ext}`;
  const bucket = getStorage().bucket(bucketName);
  await bucket.file(fileName).save(imageBuffer, {
    contentType: mimeType,
    metadata: { cacheControl: 'public, max-age=31536000' },
    public: true,
  });
  return `https://storage.googleapis.com/${bucketName}/${fileName}`;
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
 * DISABLED — DO NOT RE-ENABLE WITHOUT UPDATING THE PRIVACY POLICY FIRST.
 *
 * This used to persist a customer's input body photo alongside a "bad try-on"
 * report. Reports are now switched off (see /api/reports, which returns 410)
 * and customer imagery is strictly ephemeral: the input photo is never written
 * to storage, and the generated try-on is returned to the browser as a data:
 * URI instead of being uploaded.
 *
 * Our published Privacy Policy makes an affirmative "Zero-Retention Biometric
 * Data Guarantee" — that we keep zero copies of end-user body photos and
 * rendered previews. Persisting a customer photo here would make that public
 * statement false.
 *
 * Kept as a throwing stub rather than deleted so that any future caller fails
 * loudly at the point of misuse instead of silently restoring retention.
 */
export async function uploadReportUserPhoto(
  _imageBuffer: Buffer,
  _brandId: string,
  _mimeType = 'image/jpeg'
): Promise<never> {
  throw new Error(
    'uploadReportUserPhoto is permanently disabled: storing end-user body photos ' +
    'would violate the zero-retention guarantee in our published Privacy Policy.'
  );
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
