import { GoogleAuth } from 'google-auth-library';
import sharp from 'sharp';

// ── Locked model + size ────────────────────────────────────────────────────────
// The whole try-on pipeline is locked to one model at one resolution.
// No fallbacks, no client overrides.
export const TRYON_MODEL = 'gemini-3.1-flash-image-preview';
export const TRYON_MAX_DIM = 512;

// ── Auth ───────────────────────────────────────────────────────────────────────

async function getAccessToken(scope: string): Promise<string> {
  const keyJson = process.env.GOOGLE_CLOUD_KEY_JSON;
  if (!keyJson) throw new Error('GOOGLE_CLOUD_KEY_JSON is required');

  const credentials = JSON.parse(keyJson);
  const auth = new GoogleAuth({ credentials, scopes: [scope] });

  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to get OAuth2 access token');
  return token;
}

// ── Image preprocessing ────────────────────────────────────────────────────────
// Normalises any input photo to JPEG at TRYON_MAX_DIM on the longest side.

export async function preprocessImage(base64: string, mimeType: string): Promise<{ base64: string; mimeType: string }> {
  const inputBuffer = Buffer.from(base64, 'base64');

  const outputBuffer = await sharp(inputBuffer)
    .rotate()                          // auto-rotate based on EXIF orientation
    .resize(TRYON_MAX_DIM, TRYON_MAX_DIM, {
      fit: 'inside',                   // scale down only, never upscale
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92 })
    .toBuffer();

  return { base64: outputBuffer.toString('base64'), mimeType: 'image/jpeg' };
}

// ── Gemini API ─────────────────────────────────────────────────────────────────

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callGemini(requestBody: object): Promise<any> {
  const token = await getAccessToken('https://www.googleapis.com/auth/generative-language');

  const response = await fetch(`${GEMINI_BASE_URL}/${TRYON_MODEL}:generateContent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API ${response.status}: ${text}`);
  }

  return response.json();
}

export async function isolateGarment(
  productBase64: string,
  productMimeType: string,
): Promise<{ data: string; mimeType: string }> {
  const result = await callGemini({
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Show this complete look by itself on a plain white background, as if worn on an invisible person — same design exactly. Include EVERYTHING the person is wearing: every clothing piece (coat/sherwani, kurta/shirt, trousers/churidar, dupatta or stole) plus headwear (cap/turban/safa), footwear (shoes/khussa), jewelry (mala/necklace), belt, and any other worn item. Keep each piece in its natural worn position, and do not drop or merge any item.

Show NO human body parts at all — no face, head, hair, neck, skin, hands, arms, legs, or feet anywhere in the image. The items hold their natural worn shape on an empty invisible person: the cap with nothing inside it, the shoes empty with no feet, the mala resting where the neck would be but with no neck shown. Only the items on a plain white background, nothing of a person.`,
          },
          { inlineData: { data: productBase64, mimeType: productMimeType } },
        ],
      },
    ],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = result.candidates?.[0]?.content?.parts ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imagePart = parts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
  if (!imagePart?.inlineData?.data) {
    throw new Error('Could not isolate garment from product image');
  }
  return { data: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType };
}

export async function geminiTryOn(
  userPhotoBase64: string,
  userMimeType: string,
  garment: { data: string; mimeType: string },
): Promise<{ data: string; mimeType: string; model: string }> {
  // Single-step try-on. The garment must already be isolated upstream
  // (at product upload / QR generation). The try-on path never isolates
  // inline; if no cached garment exists, the caller must fail fast.
  const userPhoto = await preprocessImage(userPhotoBase64, userMimeType);
  userPhotoBase64 = userPhoto.base64;
  userMimeType = userPhoto.mimeType;

  console.log('[try-on] Applying isolated garment to customer photo...');

  // Step 2: Apply isolated outfit to customer photo
  const result = await callGemini({
    systemInstruction: {
      parts: [{ text: `Put the outfit from IMAGE 1 onto the customer in IMAGE 2. Keep her face, hair, body, pose, and background exactly as they are — only change her clothing. Keep the outfit's design the same as IMAGE 1, and make it look naturally worn on her body in her pose, covering her modestly.` }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'IMAGE 1 — the outfit:' },
          { inlineData: { data: garment.data, mimeType: garment.mimeType } },
          { text: 'IMAGE 2 — the customer:' },
          { inlineData: { data: userPhotoBase64, mimeType: userMimeType } },
          { text: 'Now show this customer wearing the outfit from IMAGE 1, naturally fitted to her body and pose and covering her modestly. Keep her face, hair, body, pose, and background unchanged.' },
        ],
      },
    ],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = result.candidates?.[0]?.content?.parts ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imagePart = parts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));

  if (!imagePart?.inlineData?.data) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textPart = parts.find((p: any) => p.text);
    console.error('[try-on] No image in Gemini response. Text:', textPart?.text);
    throw new Error('AI could not generate the try-on. Please try a clearer, front-facing photo.');
  }

  return {
    data: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType ?? 'image/jpeg',
    model: TRYON_MODEL,
  };
}
