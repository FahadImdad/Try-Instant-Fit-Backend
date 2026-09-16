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

KEEP EVERY GARMENT. A garment is anything made of fabric that is worn on or draped over the body — including shirts, tops, kurtas, jackets, coats, outerwear, trousers, jeans, shalwar, skirts, dresses, and draped pieces such as scarves, dupattas, shawls, stoles and sashes. Keep ALL of them, including every layer, each in its natural worn or draped position and unchanged in design, color, pattern, and detail. When in doubt about a fabric item, KEEP it. Do not drop, merge, simplify or replace any garment that is present.

REMOVE EVERYTHING THAT IS NOT A GARMENT — that is, hard accessories and objects. Do not include: sunglasses or glasses, hats, caps, turbans or any headwear, earrings, necklaces, rings, bracelets, watches, belts, bags, handbags, purses, backpacks, shoes or any footwear, phones, cups, bottles, or any other object or prop the person is holding or carrying. Where one of these covered part of a garment, fill in ONLY the small hidden patch, continuing the surrounding fabric's exact color, shade, pattern and weave so the seam is invisible. Do not redraw, restyle or re-render any garment beyond that hidden patch.

MATCH EVERY GARMENT EXACTLY as it appears in the photo — identical color, shade, tone, wash, fade, fabric, texture, pattern, cut, length, fit and every seam, button, pocket and stitch. Do not change, lighten, darken, brighten, clean up, or substitute a garment for a similar-looking one. Denim in particular must keep its exact wash and shade: a grey or faded jean must stay that same grey or faded tone, never a brighter or bluer denim. This is a real product being sold — any change to its color or design is wrong.

KEEP THE EXACT STYLING — how each garment is worn is part of the product and must be reproduced, not neutralised. Copy precisely: which parts are tucked in and which hang loose (a half-tuck or front-tuck stays a half-tuck, tucked on the same side, with the same loose drape elsewhere), how sleeves are rolled or pushed up and to what height, which buttons are done up or left open, how collars and lapels sit, and how hems fall. Do NOT straighten, untuck, even out, or tidy the styling into a plain catalogue hang.

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
      parts: [{ text: `Dress the customer in IMAGE 2 in the garment shown in IMAGE 1. IMAGE 1 is ONLY a flat swatch reference for that garment's design, color, pattern, and fabric. Ignore everything else about IMAGE 1 — its pose, its framing, its crop, its body proportions, its waistband and hemline, and any emptiness or hollowness. Never copy IMAGE 1's composition.

IMAGE 2 defines the final image completely. Keep its exact camera framing, crop, zoom, aspect ratio, and composition. The customer's body must be shown to exactly the same extent as in IMAGE 2 and no further: if IMAGE 2 is cropped at the waist, the result is cropped at the waist; if the legs or feet are not in IMAGE 2, they must NOT appear in the result. Do NOT zoom out, extend the frame, add missing body parts, or turn a partial shot into a full-body shot.

Keep everything about the customer exactly as it is in IMAGE 2 — face, head, hair, skin, body proportions, pose, limb positions, anything they are holding, and the background. They are a real person with a real body filling the clothes, never a hollow or empty outfit.

REPLACE ONLY THE MATCHING GARMENTS, AND KEEP THE CUSTOMER'S OWN CLOTHES EVERYWHERE ELSE. IMAGE 1 may show a full outfit, but only swap the pieces it actually covers. If IMAGE 1 shows a top (shirt, kurta, jacket), replace only the customer's top and KEEP THEIR OWN trousers, jeans, skirt or lower garment exactly as they are in IMAGE 2 — same denim wash, shade, cut and length, unchanged. If IMAGE 1 shows only a lower garment, replace only their lower garment and keep their own top. Never swap, restyle, recolor or replace a garment that IMAGE 1 does not show, and never add a belt, waistband or any piece the customer is not already wearing.

Reproduce IMAGE 1's exact colors, shades, patterns and fabric for the garments you do replace — never lighten, brighten or substitute a similar-looking fabric. Carry over how that garment itself is worn — its sleeve roll, which buttons are open or closed, its collar and its drape.

HOW THE NEW GARMENT MEETS THE CUSTOMER'S OWN CLOTHES is decided by IMAGE 2, not IMAGE 1. Keep the customer's existing tuck: if their top hangs loose over their trousers in IMAGE 2, the new top hangs loose too; if it was tucked, keep it tucked the same way. Do NOT tuck in a top that was untucked, do NOT untuck one that was tucked, and do NOT copy the tuck, waistband or hemline from IMAGE 1.

Make the replaced garment look naturally worn on their body in their pose, covering them modestly. Adapt it to fit the visible crop — show only the portion that falls inside IMAGE 2's frame.` }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'IMAGE 1 — the outfit:' },
          { inlineData: { data: garment.data, mimeType: garment.mimeType } },
          { text: 'IMAGE 2 — the customer:' },
          { inlineData: { data: userPhotoBase64, mimeType: userMimeType } },
          { text: 'Now show this same customer wearing the garment from IMAGE 1 — naturally fitted to their body and pose, covering them modestly, with no hollow or empty parts. Swap ONLY the pieces IMAGE 1 actually shows: keep the customer\'s own trousers, jeans or lower garment from IMAGE 2 exactly as they are if IMAGE 1 is a top, and add no belt or piece they were not already wearing. Keep their existing tuck as it is in IMAGE 2 — do not tuck in a top that was hanging loose. Keep IMAGE 2 exactly as it is apart from the swapped garment: same face, hair, body, pose, held objects, background, and above all the same camera crop and framing. Show no more of their body than IMAGE 2 already shows — do not extend the frame or invent body parts that are outside it.' },
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
