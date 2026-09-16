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
            text: `Show ONLY the clothing from this photo, by itself on a plain white background, as if worn on an invisible person.

CLOTHING ONLY. Include every garment the person is wearing — shirts, tops, jackets, outerwear, trousers, jeans, skirts, dresses — each in its natural worn position and unchanged in design, color, pattern, and detail. Do not drop or merge any garment that is present.

REMOVE EVERYTHING THAT IS NOT CLOTHING. Do not include: sunglasses or glasses, hats, caps, turbans or any headwear, earrings, necklaces, rings, bracelets, watches, belts, bags, handbags, purses, backpacks, scarves, shoes or any footwear, phones, cups, bottles, or any other object, prop, or accessory the person is holding, wearing, or carrying. If an accessory overlaps a garment, reconstruct the garment underneath so it is whole and uninterrupted.

Do NOT invent or add any garment that is not in the photo. Reproduce only what is actually there.

Show NO human body parts at all — no face, head, hair, neck, skin, hands, arms, legs, or feet. The clothing holds its natural worn shape on an empty invisible person. Only the clothing on a plain white background — nothing else.`,
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
      parts: [{ text: `Put the outfit from IMAGE 1 onto the customer in IMAGE 2. IMAGE 1 is ONLY a flat swatch reference for the outfit's design, color, pattern, and fabric. Ignore everything else about IMAGE 1 — its pose, its framing, its crop, its body proportions, and any emptiness or hollowness. Never copy IMAGE 1's composition.

IMAGE 2 defines the final image completely. Keep its exact camera framing, crop, zoom, aspect ratio, and composition. The customer's body must be shown to exactly the same extent as in IMAGE 2 and no further: if IMAGE 2 is cropped at the waist, the result is cropped at the waist; if the legs or feet are not in IMAGE 2, they must NOT appear in the result. Do NOT zoom out, extend the frame, add missing body parts, or turn a partial shot into a full-body shot.

Keep everything about the customer exactly as it is in IMAGE 2 — face, head, hair, skin, body proportions, pose, limb positions, anything they are holding, and the background. They are a real person with a real body filling the clothes, never a hollow or empty outfit.

Change ONLY their clothing into the outfit from IMAGE 1, keeping its design the same and making it look naturally worn on their body in their pose, covering them modestly. Adapt the outfit to fit the visible crop — show only the portion of the garment that falls inside IMAGE 2's frame.` }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'IMAGE 1 — the outfit:' },
          { inlineData: { data: garment.data, mimeType: garment.mimeType } },
          { text: 'IMAGE 2 — the customer:' },
          { inlineData: { data: userPhotoBase64, mimeType: userMimeType } },
          { text: 'Now show this same customer wearing the outfit from IMAGE 1 — naturally fitted to their body and pose, covering them modestly, with no hollow or empty parts. Keep IMAGE 2 exactly as it is apart from the clothing: same face, hair, body, pose, held objects, background, and above all the same camera crop and framing. Show no more of their body than IMAGE 2 already shows — do not extend the frame or invent body parts that are outside it.' },
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
