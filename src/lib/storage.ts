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

export async function uploadIsolatedGarment(
  imageBuffer: Buffer,
  productId: string,
  mimeType = 'image/jpeg'
): Promise<string> {
  const bucketName = process.env.GOOGLE_CLOUD_BUCKET_NAME;
  if (!bucketName) throw new Error('GOOGLE_CLOUD_BUCKET_NAME is required');

  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const fileName = `garments/${productId}.${ext}`;

  const bucket = getStorage().bucket(bucketName);
  const file = bucket.file(fileName);

  await file.save(imageBuffer, {
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
