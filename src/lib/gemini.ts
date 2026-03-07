import { GoogleAuth } from 'google-auth-library';

// ── Model names ────────────────────────────────────────────────────────────────
export const TRYON_MODEL_PRIMARY  = 'virtual-try-on-001';           // Vertex AI — GA, stable, $0.04/try-on
export const TRYON_MODEL_FALLBACK = 'gemini-3.1-flash-image-preview'; // Gemini — preview, $0.14/try-on

const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1';

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

// ── PRIMARY: Google Virtual Try-On API (GA, stable, 1 call) ───────────────────

export async function virtualTryOn(
  personBase64: string,
  garmentBase64: string
): Promise<{ data: string; mimeType: string; model: string }> {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (!projectId) throw new Error('GOOGLE_CLOUD_PROJECT_ID is required');

  const token = await getAccessToken('https://www.googleapis.com/auth/cloud-platform');

  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${TRYON_MODEL_PRIMARY}:predict`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      instances: [
        {
          personImage:   { image: { bytesBase64Encoded: personBase64 } },
          productImages: [{ image: { bytesBase64Encoded: garmentBase64 } }],
        },
      ],
      parameters: {
        sampleCount: 1,
        baseSteps: 32,
        addWatermark: false,
        personGeneration: 'allow_adult',
        outputOptions: { mimeType: 'image/jpeg', compressionQuality: 90 },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Virtual Try-On API ${response.status}: ${text}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await response.json();
  const prediction = result.predictions?.[0];

  if (!prediction?.bytesBase64Encoded) {
    throw new Error('Virtual Try-On API returned no image');
  }

  return {
    data: prediction.bytesBase64Encoded,
    mimeType: prediction.mimeType ?? 'image/jpeg',
    model: TRYON_MODEL_PRIMARY,
  };
}

// ── FALLBACK: Gemini image generation (2 calls) ────────────────────────────────

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callGemini(requestBody: object): Promise<any> {
  const token = await getAccessToken('https://www.googleapis.com/auth/generative-language');

  const response = await fetch(`${GEMINI_BASE_URL}/${TRYON_MODEL_FALLBACK}:generateContent`, {
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

async function isolateGarment(
  productBase64: string,
  productMimeType: string
): Promise<{ data: string; mimeType: string }> {
  const result = await callGemini({
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `This is a product catalog photo showing a garment worn by a model or mannequin.
Your task: output an image of ONLY the garment item, completely isolated on a plain white background.
- Remove the model/mannequin entirely — keep ONLY the clothing
- Remove the background
- Show the garment flat or as if on an invisible hanger, at full size
- CRITICAL — preserve the EXACT color: if the garment is sky blue, it must be sky blue in the output. If it is maroon, it must be maroon. Do not lighten, darken, or shift the color at all.
- Preserve all details exactly: fabric texture, collar style, sleeve length, buttons, embroidery, cut, and any patterns
Output: just the garment on a white background with its exact original color and details intact.`,
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
  productBase64: string,
  productMimeType: string
): Promise<{ data: string; mimeType: string; model: string }> {
  // Step 1: Isolate the garment
  console.log('[try-on] Fallback Step 1: Isolating garment...');
  const isolatedGarment = await isolateGarment(productBase64, productMimeType);
  console.log('[try-on] Fallback Step 2: Applying garment to person...');

  // Step 2: Apply isolated garment to customer photo
  const result = await callGemini({
    systemInstruction: {
      parts: [{ text: `You are a photo editing AI that performs clothing swaps. You receive a customer photo and an isolated garment image (garment on white background, no person). Your job is to place the garment onto the customer exactly as they appear — preserving their face, body, pose, and background completely. You only change the clothing.` }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: `You will receive two images:\n\nIMAGE 1 — ISOLATED GARMENT (on white background, no person):\nUse this as your garment reference — its exact color, fabric, texture, collar, sleeves, buttons, and all design details.\n\nIMAGE 2 — CUSTOMER PHOTO (your canvas):\nPreserve EVERYTHING exactly: face, pose, body, background.\n\nTHE ONLY CHANGE: Replace the clothing in IMAGE 2 with the garment from IMAGE 1.\n\nOUTPUT: IMAGE 2 with only the clothing swapped. Everything else unchanged.` },
          { text: 'IMAGE 1 — ISOLATED GARMENT:' },
          { inlineData: { data: isolatedGarment.data, mimeType: isolatedGarment.mimeType } },
          { text: 'IMAGE 2 — CUSTOMER PHOTO:' },
          { inlineData: { data: userPhotoBase64, mimeType: userMimeType } },
          { text: 'Now output IMAGE 2 with only the clothing replaced by the garment from IMAGE 1. Face, pose, body, and background unchanged.' },
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
    model: TRYON_MODEL_FALLBACK,
  };
}
