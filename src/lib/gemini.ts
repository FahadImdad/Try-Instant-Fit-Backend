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
            text: `This is a product catalog photo showing a model or mannequin wearing one or more garments (an outfit).

Your task: output an image of the COMPLETE OUTFIT — every visible clothing item — isolated together on a plain white background, in a NEUTRAL product-display orientation. Treat this like a clean e-commerce ghost-mannequin / hanger shot, NOT a styled photo.

CRITICAL LAYOUT RULE (read first — most common failure on this prompt):
When you place the top and bottom on the canvas, the top's BOTTOM edge and the bottom's TOP edge MUST TOUCH or OVERLAP. There must be ZERO empty white pixels between them — they are stacked tightly together like books on a shelf, not floating apart with space in between.

This applies whenever the source photo shows the model with visible midriff/stomach (cropped choli + low-rise lehenga, crop top + jeans, short blouse + skirt, any midriff-baring cut). Spatial example to be unambiguous: if the choli's bottom hem renders at Y=400 in the output, the lehenga's waistband must start at Y=400 (touching) or Y=395 (5-pixel overlap). It MUST NOT start at Y=420 with 20 pixels of white space in between — that white gap is the bug.

If — AND ONLY IF — the original photo shows the top and bottom already overlapping naturally with no midriff (long kameez, full kurta, maxi, abaya, gown, modest cut, long shirt + trousers), then lay them out with their natural spacing — do not force together.

How to achieve the touching layout WITHOUT changing the garments:
- The TOP keeps its actual length, hem shape, embroidery line — UNCHANGED.
- The BOTTOM keeps its actual waistband, cut, length — UNCHANGED.
- DO NOT extend the top's hem downward, do NOT add fabric or embroidery to fill the gap, do NOT redraw the hem, do NOT shift the waistband.
- You're just choosing WHERE on the canvas to place each piece. Place them touching. That's it.

POSE-FREE PRESENTATION (critical — common failure mode):
- Do NOT copy the model's pose in any form. IGNORE the model's body angle, arm position, hand placement, leg stance, hip tilt, head tilt, or any walking/twisting/turning posture in the original photo.
- The garment must NOT retain any sense of a body inside it. No body-shaped silhouette, no implied hips/chest/shoulders, no pose-induced draping or folds.
- Kameez / top / kurta / shirt / jacket: render it STRAIGHT and SYMMETRICAL, as if hanging on an invisible hanger, FULLY SPREAD so the entire piece is visible. Sleeves hang naturally DOWN at the sides — not splayed out, not bent at the elbow, not crossed in front, not raised.
- Bottom (shalwar / trousers / pants / skirt / lehenga): render it STRAIGHT and SYMMETRICAL, neutral fall, FULL WIDTH and FULL LENGTH visible — for a lehenga or full skirt, spread the entire flare so the whole pattern, embroidery border, and hem are clearly shown. Not bunched, not folded, not partially behind another piece.
- Dupatta / scarf / shawl: show it FULLY UNFOLDED and SPREAD FLAT beside the outfit — the ENTIRE piece visible (full length, full width, both edges, both borders, all embroidery, all patterns, the centre field, every detail). Do NOT fold it into a small square, do NOT bunch it, do NOT show only a corner, do NOT drape it across the body as the model wore it. The dupatta is a separate piece that must be reproducible in full from this reference alone.

SHOW EVERY PIECE IN FULL (no assumptions):
The downstream try-on step renders this reference faithfully — it does NOT guess or fill in missing parts of a garment. So every garment piece must be FULLY VISIBLE here, with EVERY detail readable: full neckline, full hemline, full embroidery field, every border, every embellishment, every pattern repeat, every panel. If any part of a garment is hidden, folded, cropped, or obscured in your output, the try-on step will guess that part wrong. Lay each piece out so a designer could reproduce it exactly from your reference image alone.

OTHER RULES:
- Remove the model/mannequin entirely — keep ONLY the clothing.
- Remove the background — pure white.
- KEEP EVERY garment piece visible in the photo: top, kameez, shirt, kurta, bottom, trousers, shalwar, pants, skirt, dupatta, scarf, jacket, vest, belt — all of them.
- Do NOT drop, hide, or omit any clothing piece. If it's a 3-piece (kameez + shalwar + dupatta), output all three. If it's a 2-piece (top + bottom), output both.
- Each piece at full size, clearly visible, no overlap that hides detail (except for the top + bottom touching at the waist per the layout rule above).
- CRITICAL — preserve the EXACT colors of every piece: if the kameez is red and the dupatta is red-with-gold-embroidery, both must keep those exact colors. Do not lighten, darken, or shift any color.
- Preserve all details exactly: fabric texture, collar style, sleeve length, buttons, embroidery, prints, patterns, cut, and length — for every piece.
- DO NOT alter the design of any garment. Garments are brand products; reproduce them as-is. The ONLY freedom you have is WHERE on the canvas to position each piece (per the layout rule). You do NOT have freedom to extend lengths, change hems, add fabric, shift waistbands, continue patterns, or modify cuts.

Output: the complete outfit (all pieces together) on a white background, posed NEUTRALLY (hanger / flat-lay style — never the model's pose), every piece's design / color / details exact, and the top + bottom laid out TOUCHING at the waist (zero white pixels between them) whenever the source shows midriff.`,
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
