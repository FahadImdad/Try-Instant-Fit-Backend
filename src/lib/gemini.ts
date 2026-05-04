import { GoogleAuth } from 'google-auth-library';
import sharp from 'sharp';

// ── Model names ────────────────────────────────────────────────────────────────
export const TRYON_MODEL_PRIMARY  = 'virtual-try-on-001';           // Vertex AI — GA, stable, $0.04/try-on
export const TRYON_MODEL_FALLBACK = 'gemini-3.1-pro-image-preview';   // Gemini — best quality, ~$0.27/try-on

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
  // Preprocess user photo to target resolution before sending to Gemini
  const [userPhoto, productImg] = await Promise.all([
    preprocessImage(userPhotoBase64, userMimeType, maxDim),
    preprocessImage(productBase64, productMimeType, maxDim),
  ]);
  userPhotoBase64 = userPhoto.base64;
  userMimeType = userPhoto.mimeType;
  productBase64 = productImg.base64;
  productMimeType = productImg.mimeType;

  let garment: { data: string; mimeType: string };
  let freshlyIsolated = false;

  if (cachedGarment) {
    console.log('[try-on] Fallback: Using cached isolated garment, skipping Step 1.');
    garment = cachedGarment;
  } else {
    console.log('[try-on] Fallback Step 1: Isolating garment...');
    garment = await isolateGarment(productBase64, productMimeType, model);
    freshlyIsolated = true;
  }

  console.log('[try-on] Fallback Step 2: Applying garment to person...');

  // Step 2: Apply isolated outfit to customer photo
  const result = await callGemini({
    systemInstruction: {
      parts: [{ text: `You are a high-end fashion photo retoucher. You take a customer photo and an isolated-outfit reference, and you produce a photorealistic image of the customer wearing that outfit — indistinguishable from a real photograph. The result must look like a genuine photograph, NOT an AI-generated or rendered image. You preserve the customer's face, body, pose, and background exactly. The cloth must look like real fabric on a real person — with natural drape, weight, folds, wrinkles, seams, stitching, and texture, and lighting that matches the original photo.` }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: `You will receive two images:

IMAGE 1 — ISOLATED OUTFIT (reference only, on white background, no person):
This is the COMPLETE outfit — every garment shown (e.g. top + bottom, kameez + shalwar + dupatta, jacket + pants, etc.) must appear on the customer. Use this for exact colors, fabrics, textures, collars, sleeves, lengths, buttons, embroidery, prints, and design details for every piece.

IMAGE 2 — CUSTOMER PHOTO (your canvas):
Preserve EVERYTHING exactly: face, skin tone, hair, pose, body proportions, hands, background, and the original photo's lighting direction, color temperature, and shadows.

TASK: Replace ONLY the customer's existing clothing in IMAGE 2 with the COMPLETE outfit from IMAGE 1. Apply every garment piece in its natural position (top on torso, bottom on legs, dupatta draped over shoulders/across body, etc.). Do not skip or omit any piece.

REALISM REQUIREMENTS — the output MUST look like a real photograph, not an AI render:
1. FABRIC TEXTURE: render the visible weave / knit / embroidery / print at thread level — not flat or plastic-smooth. Match the fabric type from IMAGE 1 (cotton, silk, wool, denim, linen, brocade, velvet, etc.).
2. NATURAL DRAPE & FOLDS: cloth must hang and fold the way real fabric does on a real body — natural creases at the elbows, waist, shoulders, hips, and where the body bends or sits. No stiff, floating, or symmetrically-perfect folds.
3. LIGHTING & SHADOWS: light direction, intensity, and color temperature on the new outfit MUST match IMAGE 2's original lighting. Cast soft shadows under collars, cuffs, layered pieces, and where the cloth meets the body. Add subtle highlights on raised areas (shoulders, chest, sleeve tops) consistent with the photo's light source.
4. EDGES & SEAMS: visible stitching at hems, seams, plackets, and cuffs. Natural soft transitions where cloth meets skin (collar/neck, cuffs/wrists, hem/legs) — no hard cut-out lines, no glow halos, no AI smoothing at the boundary.
5. BODY CONFORMITY: cloth follows the body's actual shape and pose under the fabric — not a flat 2D paste-on. Sleeves wrap real arms; the torso piece follows the chest and waist; bottoms drape over the legs in the customer's exact pose.
6. COLOR ACCURACY: keep the EXACT colors from IMAGE 1, but tinted slightly by IMAGE 2's lighting (a touch warmer / cooler / dimmer to match the room).
7. NO ARTIFACTS: no plastic sheen, no over-smoothing, no extra fingers, no warped patterns, no duplicate buttons, no melted embroidery, no floating cloth, no double collars, no extra limbs.

OUTPUT: a single photograph of the customer from IMAGE 2 wearing the full outfit from IMAGE 1, indistinguishable from a real fashion photo. Face, skin, hair, pose, body, hands, and background completely unchanged.` },
          { text: 'IMAGE 1 — ISOLATED OUTFIT (reference, all pieces):' },
          { inlineData: { data: garment.data, mimeType: garment.mimeType } },
          { text: 'IMAGE 2 — CUSTOMER PHOTO (canvas):' },
          { inlineData: { data: userPhotoBase64, mimeType: userMimeType } },
          { text: 'Output a photorealistic photo of the customer from IMAGE 2 wearing the complete outfit from IMAGE 1 — every piece must appear on the customer. The cloth must look like REAL fabric: natural drape, folds, wrinkles, visible texture and stitching, and lighting that matches IMAGE 2. Face, pose, body, hands, hair, and background unchanged. The result must look like a real photograph, not an AI render.' },
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
