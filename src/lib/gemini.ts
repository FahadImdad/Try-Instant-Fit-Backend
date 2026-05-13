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
- MIDRIFF COVERAGE (conditional — trigger: top is a crop cut that would leave a midriff gap with the bottom): If the top piece is a cropped choli, short blouse, crop top, or any cut whose length stops above the bottom piece's waistband (so a real wearer would show bare midriff), EXTEND the top downward using its OWN fabric, color, pattern, embroidery, and embellishment so it reaches and overlaps the bottom's waistband — no skin gap. Keep the same neckline, sleeves, and design; only the lower hem is lengthened so the top + bottom meet seamlessly. If the top already reaches or overlaps the bottom (long kameez, full kurta, abaya, maxi, gown, long shirt), DO NOT alter its length — keep it exactly as shown in the original. The trigger fires ONLY when the original garment design would leave bare midriff; otherwise this rule is a no-op.
Output: the complete outfit (all clothing pieces together) on a white background, with every piece's exact original color and details intact, and the top piece extended to meet the bottom if the original design would otherwise leave a midriff gap.`,
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
      parts: [{ text: `You are a photo editing AI that performs clothing swaps. You receive a customer photo (IMAGE 2) and an isolated-outfit reference (IMAGE 1, garments on white background, no person). Your job is to dress the customer in the outfit shown in IMAGE 1 — while keeping her identical to the original and the framing intact. You only change the clothing.

HOW THESE RULES APPLY (read this first):
• ALWAYS-ON (apply to every try-on, no matter the inputs): IDENTITY LOCK, FRAME-AWARE COVERAGE, NATURAL FIT.
• CONDITIONAL (apply ONLY when their specific trigger is present; otherwise do nothing): MODESTY (trigger = the outfit in IMAGE 1 would expose the midriff), QUALITY UPLIFT (trigger = IMAGE 2 is visibly blurry/soft/low-resolution).
• If a conditional rule's trigger is not present in the actual inputs, it is a NO-OP — do not invent reasons to apply it, do not alter the garment design, do not sharpen a sharp photo.

IDENTITY LOCK (always): The person in the output MUST be the SAME person from IMAGE 2 — same face, same features (eyes, nose, lips, jawline, eyebrows), same skin texture and tone, same hair, same body shape, same height, same pose. Do NOT smooth, retouch, beautify, slim, or alter the face or body in any way. The customer must be recognizable as the SAME individual — pixel-faithful to the customer photo. No "improving" the face. No swapping the person for a model.

FRAME-AWARE COVERAGE (always): Only dress what's actually visible of the customer in IMAGE 2. Render every outfit piece from IMAGE 1 that fits within the visible crop, in its natural anatomical position; pieces that fall outside the visible frame simply do NOT appear in the output — exactly as a real photo at the same crop would naturally clip them. Examples: a full-body customer photo gets the full outfit; a waist-up photo gets ONLY the top piece — do NOT fabricate the bottom piece off-frame. Do NOT zoom out, extend the canvas, reframe, or add space to fit the full outfit. The customer's framing and crop stay exactly as in IMAGE 2. Also: do NOT disturb anything OUTSIDE the clothing area — background, hair, hands, jewellery, accessories, and visible non-clothing body parts (face, neck, arms, legs) must remain identical to IMAGE 2.

NATURAL FIT (always): The new outfit must look like REAL fabric draped on the customer's actual body in their actual pose — natural folds, natural drape, weight, wrinkles, and lighting that matches the photo. The customer is wearing the clothes; the clothes are not floating on her. No flat 2D paste-on look, no AI-render plastic sheen.

MODESTY (conditional — trigger: outfit in IMAGE 1 would expose the midriff): If — and ONLY if — the outfit on the customer would otherwise leave her stomach, midriff, or navel exposed (cropped choli + low-rise lehenga with a waist gap, crop top + jeans, short blouse + skirt, sleeveless midriff-baring cut, etc.), close that gap by extending the TOP piece downward using its own fabric, color, pattern, and embellishment so it reaches and overlaps the bottom's waistband — no bare skin between top and bottom. NOTE: The Step 1 isolation already extends crop-cut tops to cover the midriff in IMAGE 1, so usually you just need to render IMAGE 1 faithfully and the midriff will be covered automatically. But if any gap still appears in your draft output, close it before finalizing. If the outfit already covers the midriff (long kameez, maxi, full-length gown, long shirt + trousers, abaya, full kurta, etc.), the trigger is NOT present — do nothing extra, render the outfit exactly as shown in IMAGE 1 without altering its design or length.

QUALITY UPLIFT (conditional — trigger: IMAGE 2 is visibly blurry/soft/low-resolution): If — and ONLY if — IMAGE 2 is noticeably blurry, soft, out-of-focus, or low-resolution, apply a clarity uplift UNIFORMLY across the ENTIRE output image — face, hair, skin, clothing, hands, jewellery, background, every region — at the level of image quality only (sharpen edges, reduce noise, recover fine detail, lift overall sharpness). The uplift must be uniform: do NOT selectively sharpen one area more than another, do NOT leave parts blurry while others are crisp. Critically: this is NOT permission to CHANGE anything. The person's face, features, expression, skin tone, hair, body, pose; the outfit's exact colors, patterns, and embellishments; the background's exact contents, layout, lighting, and color — every visual element must remain IDENTICAL to the source, just rendered with higher clarity. Think "upscale to higher resolution," not "edit or redraw." The IDENTITY LOCK and all other rules still fully bind. If IMAGE 2 is already sharp and well-exposed, the trigger is NOT present — do NOT sharpen or apply any quality changes; render at the original quality.` }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: `You will receive two images. Apply the system rules above (always-on rules + conditional rules whose triggers are actually present in these inputs).

IMAGE 1 — ISOLATED OUTFIT (one or more garments on white background, no person):
The outfit reference. Use it for exact colors, fabrics, textures, collars, sleeves, lengths, buttons, embroidery, prints, and all design details for every piece (top, bottom, dupatta, jacket, etc.).

IMAGE 2 — CUSTOMER PHOTO (the PERSON, the canvas, the framing):
This is the same person who must appear in the output, at the same crop and framing. Preserve her exactly.

WHAT TO DO: Replace ONLY her current clothing with the outfit from IMAGE 1. Apply every piece from IMAGE 1 that fits within IMAGE 2's visible crop, in its natural anatomical position (top on torso, bottom on legs, dupatta draped, etc.). Pieces that fall outside the visible frame simply do not appear — do not extend the canvas to fit them.

OUTPUT: IMAGE 2 with the SAME person, same face/features/skin/hair/body/pose/background, wearing the visible portion of the outfit from IMAGE 1 — fitting like real fabric, with natural drape and matched lighting. Apply MODESTY only if the outfit would otherwise expose the midriff. Apply QUALITY UPLIFT only if IMAGE 2 is visibly blurry. Otherwise, do nothing extra.` },
          { text: 'IMAGE 1 — ISOLATED OUTFIT (all pieces):' },
          { inlineData: { data: garment.data, mimeType: garment.mimeType } },
          { text: 'IMAGE 2 — CUSTOMER PHOTO (this is the PERSON — keep her identical):' },
          { inlineData: { data: userPhotoBase64, mimeType: userMimeType } },
          { text: 'Now output IMAGE 2 with the SAME customer wearing the outfit from IMAGE 1 — only the pieces that fit within her visible crop, fitting naturally like real fabric on her real body. She must remain IDENTICAL to the customer photo (same face, features, skin, hair, body, pose). Do not retouch or beautify her. Apply the conditional rules (modesty, quality uplift) only if their triggers are actually present.' },
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
