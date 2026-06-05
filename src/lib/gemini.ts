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
            text: `Look at this product photo and identify every separate CLOTHING item shown. Count the clothing pieces. Clothing includes garments and worn fabric: tops, shirts, kurtas, dresses, bottoms, trousers, skirts, jackets, outerwear, and draped pieces like a dupatta, scarf, or shawl, and a belt if one is worn with the outfit. Every CLOTHING piece you see MUST appear in your output — dropping or merging a clothing piece is the main failure, do not do it.

EXCLUDE accessories and personal items entirely — they must NOT appear in the output at all: glasses and sunglasses, jewelry of any kind (necklaces, earrings, bracelets, rings), watches, bags and handbags, shoes and footwear, hats and headwear. If the source shows any of these, simply leave them out. Output only the clothing.

Produce the clothing on a pure white background as if worn on an invisible person — natural 3D shape, volume, and drape, with no person, no body, no mannequin, no pose, and no background visible. The shapes should look filled out and worn, not flattened or laid out.

For EACH clothing piece, fully visible, nothing overlapping or hidden:
- show it with its natural worn shape, full size, and full extent
- reproduce it EXACTLY as in the source: same colors, materials, textures, prints, patterns, details, and proportions
- do NOT redesign, restyle, recolor, or simplify

If two clothing pieces are worn directly adjacent in the source (one ending where the next begins), keep them in that same adjacent position, touching at that join — no gap of empty background between them. The pieces themselves stay unchanged; only their arrangement is set by how they are worn. Otherwise, position them as they would naturally sit when worn together.

Before finishing, verify your output contains the SAME number of clothing pieces you counted, and that NO glasses, jewelry, watch, bag, shoe, or hat appears. If a clothing piece is missing, add it; if an accessory slipped in, remove it. Output: every clothing piece, no accessories, on white, on an invisible body, faithful to the original.`,
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
      parts: [{ text: `You are a photo editing AI that performs clothing swaps. You receive two images with very different roles. Read this first — it's the most common failure mode if you skip it:

THE TWO IMAGES HAVE DIFFERENT ROLES (do not confuse them):

IMAGE 1 — CLOTHING REFERENCE ONLY.
The ONLY thing you take from IMAGE 1 is the GARMENT DESIGN: its colors, fabric, embroidery, cut, sleeves, neckline, length, drape, prints, patterns, and embellishments. Everything else in IMAGE 1 is IRRELEVANT and must NOT appear in the output. Specifically, do NOT copy from IMAGE 1: the model's face, hair, skin, body shape, hands, pose, jewellery, bangles, watches, rings, earrings, necklaces, bags, shoes, makeup, lighting, or background. You are NOT recreating IMAGE 1's photo. You are using IMAGE 1 like a flat lay reference for what the customer should be wearing.

IMAGE 2 — THE PERSON + THE CANVAS (ground truth).
EVERYTHING in IMAGE 2 except her current clothing must appear in the output unchanged. That includes: her exact face (every feature — eyes, nose, lips, jawline, brows, expression), her hair (texture, length, parting, volume, fly-aways), her skin tone and texture, her body shape and proportions, her hands and their position, her existing jewellery / bangles / accessories (if she has any in IMAGE 2, keep them; if not, do NOT add any), her pose, her background (every plant, flower, wall, bench, shadow), and her lighting direction. If something is in IMAGE 2 and it isn't clothing, it stays.

WHAT YOU ACTUALLY DO:
Replace ONLY the customer's current clothing with the garment from IMAGE 1, fitted naturally to her actual body in her actual pose. Nothing else changes.

HOW THESE RULES APPLY:
• ALWAYS-ON (every try-on, no matter the inputs): IDENTITY LOCK, FRAME-AWARE COVERAGE, NATURAL FIT.
• CONDITIONAL (apply only when its specific trigger is present): QUALITY UPLIFT (trigger = IMAGE 2 is visibly blurry/soft/low-resolution). If the trigger isn't present, do nothing extra.

IDENTITY LOCK (always): The person in the output must be the SAME person from IMAGE 2. Same face down to the features (eyes, nose, lips, jawline, eyebrows), same expression, same skin texture and tone (do not smooth, blur, soften, or "clean up"), same hair (do not straighten, restyle, or reduce volume), same body shape and proportions (do not slim, slim down shoulders, or reshape), same height, same pose, same hand positions. Beautifying IS a change — do not do it. Smoothing IS a change — do not do it. If you find yourself "improving" anything about her, stop — that's the failure mode.

FRAME-AWARE COVERAGE (always): Only dress what's visible of the customer in IMAGE 2. Render every outfit piece from IMAGE 1 that fits within IMAGE 2's visible crop, in its natural anatomical position. Pieces outside the visible frame simply do NOT appear — exactly as a real photo at the same crop would clip them. A waist-up customer photo gets only the top, never a fabricated bottom. Do NOT zoom out, extend the canvas, or reframe. The customer's framing and crop stay exactly as in IMAGE 2.

NATURAL FIT (always): The new outfit must look like REAL fabric draped on the customer's actual body in her actual pose — natural folds, drape, weight, wrinkles, and lighting that matches IMAGE 2's light direction and color temperature. The customer is wearing the clothes; the clothes are not floating, not posted on, not in some other pose. No flat paste-on look, no AI-render plastic sheen, no implausible drape (e.g., a dupatta fanning out across a bench like spilled fabric is wrong — drape it as it would actually hang on her body in her pose).

QUALITY UPLIFT (conditional — trigger: IMAGE 2 is visibly blurry/soft/low-resolution): If — and ONLY if — IMAGE 2 is noticeably blurry or low-resolution, apply a uniform clarity uplift across the entire output (sharpen edges, reduce noise, recover detail). This is upscaling, NOT editing. The person, outfit, and background must remain IDENTICAL to the source, just clearer. If IMAGE 2 is already sharp, do not sharpen — render at the original quality.` }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: `Apply the system rules above. Two images coming. Remember their roles:

IMAGE 1 — CLOTHING REFERENCE.
Use it ONLY for the garment design: colors, fabric, embroidery, cut, sleeves, length, drape, prints, patterns. Ignore everything else about IMAGE 1 — the model in it, her face, hair, body, hands, pose, jewellery, accessories, makeup, lighting, background — none of that appears in your output.

IMAGE 2 — THE CUSTOMER. The person, the canvas, the framing, the background, the lighting, the pose, the hands, the existing accessories — ALL of that is the ground truth and appears in the output unchanged.

YOUR TASK: Replace ONLY the customer's current clothing with the garment from IMAGE 1, fitted naturally to her actual body in her actual pose. Pieces of the outfit that fall outside her visible crop don't appear. Don't extend the canvas, don't reframe, don't add jewellery from IMAGE 1, don't redraw her face, don't restyle her hair, don't change the background.` },
          { text: 'IMAGE 1 — CLOTHING REFERENCE (use only the garment design, ignore everything else):' },
          { inlineData: { data: garment.data, mimeType: garment.mimeType } },
          { text: 'IMAGE 2 — CUSTOMER (everything except her current clothing stays exactly as shown):' },
          { inlineData: { data: userPhotoBase64, mimeType: userMimeType } },
          { text: 'Now output IMAGE 2 with the same customer wearing the garment design from IMAGE 1, fitted naturally to her real body in her real pose. Keep her face, features, skin, hair, body shape, hands, existing jewellery/accessories, pose, lighting, and background exactly as in IMAGE 2 — do not import any of those from IMAGE 1. Apply QUALITY UPLIFT only if IMAGE 2 is visibly blurry.' },
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
