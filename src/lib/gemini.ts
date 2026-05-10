import { GoogleAuth } from 'google-auth-library';
import sharp from 'sharp';

// ── Model names ────────────────────────────────────────────────────────────────
export const TRYON_MODEL_PRIMARY  = 'virtual-try-on-001';            // Vertex AI — dormant after fallback removal
export const TRYON_MODEL_FALLBACK = 'gemini-3.1-flash-image-preview'; // Gemini Flash 3.1 — default model, ~$0.045/img @ 512px

const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1';
const MAX_RETRIES = 3;

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
// Normalizes any input photo to JPEG, max 1024px on longest side, good quality.
// This ensures the API always gets a clean, consistent input regardless of what
// the user uploaded (huge PNG, tiny JPEG, portrait, landscape, etc.)

export async function preprocessImage(base64: string, mimeType: string, maxDim = 512): Promise<{ base64: string; mimeType: string }> {
  const inputBuffer = Buffer.from(base64, 'base64');

  const outputBuffer = await sharp(inputBuffer)
    .rotate()                          // auto-rotate based on EXIF orientation
    .resize(maxDim, maxDim, {
      fit: 'inside',                   // scale down only, never upscale
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92 })
    .toBuffer();

  return { base64: outputBuffer.toString('base64'), mimeType: 'image/jpeg' };
}

// ── PRIMARY: Google Virtual Try-On API (GA, stable, 1 call) ───────────────────

async function callVirtualTryOnOnce(
  personBase64: string,
  garmentBase64: string,
  token: string,
  projectId: string
): Promise<{ data: string; mimeType: string }> {
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
        baseSteps: 50,              // increased from 32 → better quality/consistency
        addWatermark: false,
        personGeneration: 'allow_adult',
        outputOptions: { mimeType: 'image/jpeg', compressionQuality: 92 },
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

  return { data: prediction.bytesBase64Encoded, mimeType: prediction.mimeType ?? 'image/jpeg' };
}

export async function virtualTryOn(
  personBase64: string,
  garmentBase64: string
): Promise<{ data: string; mimeType: string; model: string }> {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (!projectId) throw new Error('GOOGLE_CLOUD_PROJECT_ID is required');

  // Preprocess both images before sending
  const [person, garment] = await Promise.all([
    preprocessImage(personBase64, 'image/jpeg'),
    preprocessImage(garmentBase64, 'image/jpeg'),
  ]);

  const token = await getAccessToken('https://www.googleapis.com/auth/cloud-platform');

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[try-on] Virtual Try-On attempt ${attempt}/${MAX_RETRIES}...`);
      const result = await callVirtualTryOnOnce(person.base64, garment.base64, token, projectId);
      console.log(`[try-on] Success on attempt ${attempt}`);
      return { ...result, model: TRYON_MODEL_PRIMARY };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[try-on] Attempt ${attempt} failed: ${lastError.message}`);
      if (attempt < MAX_RETRIES) {
        // short wait before retry
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  throw lastError ?? new Error('Virtual Try-On API failed after retries');
}

// ── FALLBACK: Gemini image generation (2 calls) ────────────────────────────────

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callGemini(requestBody: object, model = TRYON_MODEL_FALLBACK): Promise<any> {
  const token = await getAccessToken('https://www.googleapis.com/auth/generative-language');

  const response = await fetch(`${GEMINI_BASE_URL}/${model}:generateContent`, {
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
  model = TRYON_MODEL_FALLBACK
): Promise<{ data: string; mimeType: string }> {
  const result = await callGemini({
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `This is a product catalog photo showing a model or mannequin wearing one or more garments (an outfit).

Your task: output an image of the COMPLETE OUTFIT — every visible clothing item on the model — isolated together on a plain white background.
- Remove the model/mannequin entirely — keep ONLY the clothing
- Remove the background
- KEEP EVERY garment piece visible in the photo: top, kameez, shirt, kurta, bottom, trousers, shalwar, pants, skirt, dupatta, scarf, jacket, vest, belt — all of them, arranged together in their natural relative positions (top above bottom, dupatta draped or alongside, etc.)
- Do NOT drop, hide, or omit any clothing piece. If the model is wearing a 3-piece suit (kameez + shalwar + dupatta), output all three. If it's a 2-piece (top + bottom), output both.
- Show the outfit flat or as if on an invisible hanger/dress form, at full size, with each piece clearly visible
- CRITICAL — preserve the EXACT colors of every piece: if the kameez is sky blue and the dupatta is maroon, both must keep those exact colors in the output. Do not lighten, darken, or shift any color.
- Preserve all details exactly: fabric texture, collar style, sleeve length, buttons, embroidery, prints, patterns, cut, and length — for every piece
Output: the complete outfit (all clothing pieces together) on a white background, with every piece's exact original color and details intact.`,
          },
          { inlineData: { data: productBase64, mimeType: productMimeType } },
        ],
      },
    ],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
  }, model);

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
  productMimeType: string,
  cachedGarment?: { data: string; mimeType: string },
  model = TRYON_MODEL_FALLBACK,
  maxDim = 512
): Promise<{ data: string; mimeType: string; model: string; isolatedGarment?: { data: string; mimeType: string } }> {
  // Preprocess each image at most once. The user photo is always needed
  // for step 2. The product image is only needed for step 1 (garment
  // isolation) — when we have a cached garment we skip preprocessing it.
  const userPhoto = await preprocessImage(userPhotoBase64, userMimeType, maxDim);
  userPhotoBase64 = userPhoto.base64;
  userMimeType = userPhoto.mimeType;

  let garment: { data: string; mimeType: string };
  let freshlyIsolated = false;

  if (cachedGarment) {
    console.log('[try-on] Using cached isolated garment, skipping Step 1.');
    garment = cachedGarment;
  } else {
    console.log('[try-on] Step 1: Preprocessing product + isolating garment...');
    const productImg = await preprocessImage(productBase64, productMimeType, maxDim);
    garment = await isolateGarment(productImg.base64, productImg.mimeType, model);
    freshlyIsolated = true;
  }

  console.log('[try-on] Step 2: Applying garment to person...');

  // Step 2: Apply isolated outfit to customer photo
  const result = await callGemini({
    systemInstruction: {
      parts: [{ text: `You are a photo editing AI that performs full-outfit clothing swaps. You receive a customer photo and an isolated-outfit image (one or more garments together on white background, no person). Your job is to dress the customer in the COMPLETE outfit — every piece shown — preserving their face, body, pose, and background completely. You only change the clothing.

CRITICAL OUTPUT RULES (these are not optional):
- The output MUST have the EXACT same canvas dimensions, framing, zoom, and crop as the customer photo. Do NOT add empty space above the head, below the feet, or to the sides to fit the outfit. If the outfit would extend beyond the original frame, let it crop naturally at the original canvas edges.
- Do NOT change the customer's face, head size, body proportions, height, or pose. The face must stay at the EXACT pixel position and size as in the customer photo.
- Do NOT alter, smooth, retouch, or beautify the face — keep skin texture, hair, and features identical.` }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: `You will receive two images:

IMAGE 1 — ISOLATED OUTFIT (one or more garments on white background, no person):
This is the COMPLETE outfit — every garment shown (e.g. top + bottom, kameez + shalwar + dupatta, jacket + pants, etc.) must appear on the customer. Use this as your reference for exact colors, fabrics, textures, collars, sleeves, lengths, buttons, embroidery, prints, and all design details for every piece.

IMAGE 2 — CUSTOMER PHOTO (your canvas — DO NOT RESIZE OR REFRAME):
Preserve EVERYTHING exactly: face, head size, pose, body proportions, background, AND the exact canvas dimensions/framing/crop. The output must be pixel-aligned with this image — same width, same height, same zoom level, same camera angle.

THE ONLY CHANGE: Replace the customer's existing clothing in IMAGE 2 with the COMPLETE outfit from IMAGE 1. Apply every garment piece in its natural position (top on torso, bottom on legs, dupatta draped over shoulders/across body, etc.). Do not skip or omit any piece.

If the outfit is longer or wider than what fits in the customer's frame (e.g. a floor-length lehenga in a half-body photo), CROP the outfit at the original frame edges — DO NOT zoom out, DO NOT add canvas above the head or below the feet. The customer's head/face/pose stays anchored at its original position and size.

OUTPUT: IMAGE 2's exact canvas with the customer wearing the full outfit from IMAGE 1. Face, head size, pose, body, background, and framing unchanged.` },
          { text: 'IMAGE 1 — ISOLATED OUTFIT (all pieces):' },
          { inlineData: { data: garment.data, mimeType: garment.mimeType } },
          { text: 'IMAGE 2 — CUSTOMER PHOTO (this is your output canvas — same dimensions, same framing, same head position and size):' },
          { inlineData: { data: userPhotoBase64, mimeType: userMimeType } },
          { text: 'Now output IMAGE 2 with the customer dressed in the complete outfit from IMAGE 1. Every piece in IMAGE 1 must appear on the customer. Face, head size, pose, body, background, and the exact frame/crop of IMAGE 2 must remain unchanged. Do NOT add canvas space to fit the outfit — crop the outfit at the frame edges if needed.' },
        ],
      },
    ],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
  }, model);

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
    model,
    isolatedGarment: freshlyIsolated ? garment : undefined,
  };
}
