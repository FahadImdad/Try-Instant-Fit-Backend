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
            text: `Show this complete outfit on a plain white background, as if worn together on one invisible person — natural worn shape and drape, no body, mannequin, pose, or background.

Keep the dress design EXACTLY the same as the photo — this is critical. Reproduce every piece (top, bottom, dress, dupatta, scarf, jacket) with full fidelity: its exact colors, fabric, embroidery, prints, patterns, motifs, borders, neckline, and cut. Do NOT redesign, recolor, restyle, simplify, embellish, or change any detail of the garment. Pieces worn together sit in their normal worn positions, the top resting on the skirt or trousers with no empty gap between them. Leave out all accessories (jewelry, watch, bag, shoes, glasses, hat).`,
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
      parts: [{ text: `Edit IMAGE 2 (the customer): change only her clothing into the garment from IMAGE 1, and keep everything else exactly as it is — her face, hair, skin, body, hands, pose, background, and lighting. Use IMAGE 1 only for the garment's design, color, and fabric; ignore its model, pose, and background.

Keep the dress design EXACTLY the same as IMAGE 1 — this is critical. Reproduce its exact colors, fabric, embroidery, prints, patterns, motifs, borders, neckline, and cut with full fidelity. Do NOT redesign, recolor, restyle, simplify, embellish, or change any detail of the garment. The only adjustments allowed are fitting and draping it to her body in her pose, and the modesty coverage below — nothing else about the design changes.

Make it look like she is really wearing the outfit, not a flat cutout pasted on: real fabric that drapes, folds, and catches her photo's light, moving with her pose. Re-drape the outfit onto HER body in THIS pose — do not keep the garment's original flat shape or the way it hung in IMAGE 1. Each piece attaches to her: sleeves follow her arms wherever they are, a dupatta rests on the shoulder/arm it would actually touch and falls from there, and a skirt swings, lifts, and sweeps to one side with her motion instead of fanning out flat and symmetrical. The fabric reacts to her limbs and movement, never floating beside her in empty space. Keep each piece its true length from IMAGE 1 (long stays long, flowing past the frame if needed; never shortened).

Modesty is required: no bare stomach, midriff, navel, waist, cleavage, or back may show in the result. If the top in IMAGE 1 is a short or cropped cut that would leave the waist bare, lengthen it in the same fabric and embroidery so it reaches and meets the skirt's waistband — the top and skirt connect with skin fully covered all the way around. Her torso from chest to hips is always covered by fabric. This overrides faithfulness to a revealing cut.` }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'IMAGE 1 — the garment to put on her (use only its design, color, and fabric):' },
          { inlineData: { data: garment.data, mimeType: garment.mimeType } },
          { text: 'IMAGE 2 — the customer (keep her exactly as she is, change only her clothing):' },
          { inlineData: { data: userPhotoBase64, mimeType: userMimeType } },
          { text: 'Now show this same customer really wearing the garment from IMAGE 1 — full length, fitted naturally to her real body and pose, with her waist and midriff fully covered (no bare stomach; if the top is cropped, lengthen it to meet the skirt). Keep her face, hair, body, hands, pose, and background unchanged.' },
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
