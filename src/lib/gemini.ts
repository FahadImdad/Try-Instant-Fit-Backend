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
      parts: [{ text: `You are operating Photoshop, not generating a new image.

Your task: open IMAGE 2 (the customer photo) as a layer. Select ONLY the pixels containing the customer's current clothing. Replace those pixels — and ONLY those pixels — with the matching garment regions from IMAGE 1. Save the file. That is the entire job.

Everything else in IMAGE 2 — the canvas dimensions, the face pixels, the head, the hair, the skin, the pose, the wall, the ceiling, the floor, the lights, every pixel that isn't on the customer's current clothes — is LOCKED. Read-only. Untouchable. If a pixel was in IMAGE 2 and was not on the old clothing, it must appear at the EXACT same coordinates and the EXACT same color in the output.

You are NOT allowed to:
  • Resize the canvas (output must be exactly IMAGE 2's pixel width × pixel height).
  • Re-frame, re-crop, zoom in, or zoom out.
  • Move, resize, retouch, or "improve" the face or head — face must stay at the same pixel coordinates and the same pixel size as IMAGE 2.
  • Add ceiling, sky, sidewalk, or extra room above/below/beside the customer to make the new outfit fit. If the outfit would extend beyond the canvas, the outfit gets clipped at the canvas edge — IMAGE 2's original frame wins.
  • Re-render walls, floor, or background with new texture. The wall is the same wall. The floor is the same floor.

You MAY:
  • Replace clothing pixels with the new garment's pixels.
  • Inpaint the small slivers of floor or wall that get revealed when the new outfit is narrower or shorter than the original — by sampling and extending the existing floor/wall texture from immediately adjacent visible pixels. No invention, no blur.

Failure mode you must avoid: "regenerating" the image as a new fashion photo. That is wrong. You are editing pixels, not re-imagining the scene.` }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: `Edit IMAGE 2's clothing pixels to show the outfit in IMAGE 1. That's it.

Constraints (every one is mandatory):
  1. Output canvas = IMAGE 2's exact width × height in pixels. Do not resize.
  2. The face in the output is the SAME face at the SAME pixel coordinates and SAME size as IMAGE 2. Don't move it, don't shrink it, don't smooth it.
  3. Every non-clothing pixel of IMAGE 2 (background, floor, walls, ceiling, body parts not covered by the old clothing, hair) must remain visually identical. Sliver areas revealed by a narrower new outfit get filled by extending the immediately adjacent IMAGE 2 texture.
  4. Use IMAGE 1 only as the source of garment colors, fabric, embroidery, sleeves, length, dupatta drape, etc. Do NOT copy IMAGE 1's pose, body, or background — only the clothing pieces. Apply EVERY garment piece shown in IMAGE 1 (top, bottom, dupatta, jacket — all of them) in their natural anatomical positions.
  5. If the outfit is longer than the customer's frame (e.g. floor-length lehenga in a half-body photo), the outfit clips at IMAGE 2's bottom edge. You do NOT extend the canvas downward.

Self-check before responding: is your output the same pixel dimensions as IMAGE 2? Is the customer's face in the same place at the same size? Is the wall/floor/ceiling the same as IMAGE 2? If any answer is no, redo it.` },
          { text: 'IMAGE 1 — outfit reference (read garment design only, ignore its background and any model):' },
          { inlineData: { data: garment.data, mimeType: garment.mimeType } },
          { text: 'IMAGE 2 — the file you are editing. Output dimensions = this file\'s dimensions. Face position = this file\'s face position. Background = this file\'s background.' },
          { inlineData: { data: userPhotoBase64, mimeType: userMimeType } },
          { text: 'Output: IMAGE 2 with only the clothing pixels replaced by IMAGE 1\'s outfit. Same canvas, same face position, same face size, same background. Treat this as a Photoshop layer edit, not a new image.' },
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
