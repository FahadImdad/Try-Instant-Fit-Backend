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

IDENTITY LOCK (mandatory): The person in the output MUST be the SAME person from the customer photo — same face, same features (eyes, nose, lips, jawline, eyebrows), same skin texture and tone, same hair, same body shape, same height, same pose. Do NOT smooth, retouch, beautify, slim, or alter the face or body in any way. The customer must be recognizable as the SAME individual — pixel-faithful to the customer photo. No "improving" the face. No swapping the person for a model.

FRAME-AWARE COVERAGE (mandatory): Only dress what's actually visible of the customer in IMAGE 2. If IMAGE 2 shows only part of her body (waist-up, chest-up, half-body, three-quarter, close-up, etc.), apply ONLY the outfit pieces that would naturally appear within that visible crop — e.g. a waist-up photo gets ONLY the top piece swapped; do NOT add, fabricate, or render the bottom piece (lehenga, trousers, shalwar, etc.) outside the visible frame just because IMAGE 1 contains it. Do NOT zoom out, extend the canvas, reframe, or add space to make the full outfit fit. The customer's framing and crop must stay exactly as in IMAGE 2; outfit pieces that fall outside the frame simply do not appear — exactly as a real photo at the same crop would naturally clip them. Also: do NOT disturb anything OUTSIDE the clothing area — background, hair, hands, jewellery, accessories, and any visible non-clothing body parts (face, neck, arms, legs) must remain identical to IMAGE 2.

NATURAL FIT: The new outfit must look like REAL fabric draped on the customer's actual body in their actual pose — natural folds, natural drape, weight, wrinkles, and lighting that matches the photo. The customer is wearing the clothes; the clothes are not floating on her. No flat 2D paste-on look, no AI-render plastic sheen.

MODESTY (CONDITIONAL — apply ONLY when needed): If the outfit in IMAGE 1 would otherwise leave the customer's stomach, midriff, or navel exposed (e.g. cropped choli + low-rise lehenga with a gap at the waist, crop top + jeans, short blouse + skirt, sleeveless midriff-baring cut), close that gap on the customer by extending the TOP piece downward using its own fabric, color, and pattern so the midriff is fully covered. For outfits that already cover the midriff (long kameez, maxi, full-length gown, long shirt + trousers, abaya, etc.), do NOT alter the garment's design or length — keep it exactly as shown in IMAGE 1. This rule activates ONLY when there would be visible bare skin between the top and bottom pieces; otherwise it is a no-op.

QUALITY UPLIFT (CONDITIONAL — only when the source is blurry): If IMAGE 2 is noticeably blurry, soft, out-of-focus, or low-resolution, you MAY improve the OUTPUT's clarity — sharpen edges, reduce noise, recover fine detail — but ONLY at the level of image quality. This is NOT permission to alter the person's face, features, expression, skin tone, body proportions, or identity in any way. The IDENTITY LOCK above still fully applies: same individual, same eyes/nose/lips/jawline/eyebrows, same hair, same body shape — just rendered more clearly. If IMAGE 2 is already sharp and well-exposed, do NOT over-sharpen, smooth, or apply any quality changes — leave it as-is.` }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: `You will receive two images:

IMAGE 1 — ISOLATED OUTFIT (one or more garments on white background, no person):
This is the COMPLETE outfit — every garment shown (e.g. top + bottom, kameez + shalwar + dupatta, jacket + pants, etc.) must appear on the customer. Use this as your reference for exact colors, fabrics, textures, collars, sleeves, lengths, buttons, embroidery, prints, and all design details for every piece.

IMAGE 2 — CUSTOMER PHOTO (your canvas — this is the PERSON, do not change her):
Preserve the SAME PERSON exactly: identical face, identical features, identical skin texture and tone, identical hair, identical body proportions, identical pose, identical background. Do NOT alter, smooth, retouch, beautify, slim, or "improve" the face or body in any way. The output must show the SAME individual from IMAGE 2 — instantly recognizable as her.

THE ONLY CHANGE: Replace the customer's existing clothing in IMAGE 2 with the COMPLETE outfit from IMAGE 1. Apply every garment piece in its natural position (top on torso, bottom on legs, dupatta draped over shoulders/across body, etc.). Do not skip or omit any piece.

The cloth must look like REAL fabric on a real body — natural drape, natural folds and wrinkles where the body bends, weight, soft shadows where the cloth meets skin, and lighting that matches IMAGE 2. Not a flat overlay, not an AI render. The customer is wearing the clothes naturally.

MIDRIFF CHECK (conditional): If — and ONLY if — the outfit would otherwise leave the customer's stomach/midriff/navel visible (cropped choli + low-rise lehenga with a waist gap, crop top + jeans, short blouse, sleeveless midriff cut, etc.), extend the top piece downward using its own fabric, color, and pattern to close that gap so the stomach is fully covered. For outfits that already cover the midriff (long kameez, gowns, maxis, full-length tops, abayas), do NOT alter the garment's design or length — render it exactly as shown in IMAGE 1.

OUTPUT: IMAGE 2 with the SAME PERSON now wearing the full outfit from IMAGE 1 — face, features, skin, hair, body, pose, and background identical to the original. Only the clothing has changed, and it fits naturally on her body.` },
          { text: 'IMAGE 1 — ISOLATED OUTFIT (all pieces):' },
          { inlineData: { data: garment.data, mimeType: garment.mimeType } },
          { text: 'IMAGE 2 — CUSTOMER PHOTO (this is the PERSON — keep her identical):' },
          { inlineData: { data: userPhotoBase64, mimeType: userMimeType } },
          { text: 'Now output IMAGE 2 with the SAME customer dressed in the complete outfit from IMAGE 1. Every piece in IMAGE 1 must appear on her, fitting naturally like real fabric on her real body. She must remain IDENTICAL to the customer photo — same face, same features, same skin, same hair, same body, same pose. Do not retouch, smooth, beautify, or change her in any way.' },
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
