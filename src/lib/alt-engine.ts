import sharp from 'sharp';

// ── Alternate try-on engine (TEMPORARY — quality evaluation only) ─────────────
// Opt-in per brand via brands.tryon_model_override = 'alt'. Every brand with
// NULL keeps the default engine in ./gemini. Nothing here runs unless a brand
// row is explicitly flipped.
//
// Kept in its own module so the live pipeline in ./gemini.ts is untouched —
// delete this file and the one branch in the try-on route to remove it.

export const ALT_TRYON_MODEL = 'gpt-image-1-mini';
export const ALT_TRYON_MAX_DIM = 512;

// Mirrors the default engine's two-reference framing. IMAGE 1 is the isolated
// garment, IMAGE 2 the customer — same ordering, same intent.
const ALT_PROMPT = `Put the outfit from IMAGE 1 onto the customer in IMAGE 2.

IMAGE 1 is ONLY a flat reference for the outfit's design, color, pattern and fabric. Ignore its pose, framing and crop.

IMAGE 2 defines the final image completely. Keep its exact camera framing, crop, zoom and aspect ratio. Show the customer's body to exactly the same extent as IMAGE 2 and no further — if it is cropped at the waist, the result is cropped at the waist. Do not zoom out, extend the frame, or add body parts that are not in IMAGE 2.

Keep the customer exactly as they are in IMAGE 2 — face, hair, skin, body proportions, pose, anything held, and the background. Change ONLY their clothing into the outfit from IMAGE 1, naturally worn on their body, covering them modestly.

Reproduce IMAGE 1's exact colors, shades and washes — never lighten, brighten or substitute a similar fabric. Keep its styling: the same tuck, the same sleeve roll, the same buttons open or closed, the same drape.`;

// Normalise to PNG (the edits endpoint requires it) at the same max dimension
// as the default engine, so a quality comparison isn't skewed by input size.
async function toPng(base64: string): Promise<Uint8Array<ArrayBuffer>> {
  const out = await sharp(Buffer.from(base64, 'base64'))
    .rotate()
    .resize(ALT_TRYON_MAX_DIM, ALT_TRYON_MAX_DIM, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

  // Copy into a Uint8Array backed by a plain ArrayBuffer: Node's Buffer (and a
  // Uint8Array over ArrayBufferLike) is not a valid BlobPart.
  const copy = new Uint8Array(new ArrayBuffer(out.byteLength));
  copy.set(out);
  return copy;
}

export async function altTryOn(
  userPhotoBase64: string,
  userMimeType: string,
  garment: { data: string; mimeType: string },
): Promise<{ data: string; mimeType: string; model: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for the alternate engine');

  console.log('[try-on] Alternate engine: applying isolated garment...');

  const [garmentPng, customerPng] = await Promise.all([
    toPng(garment.data),
    toPng(userPhotoBase64),
  ]);

  const form = new FormData();
  form.append('model', ALT_TRYON_MODEL);
  form.append('prompt', ALT_PROMPT);
  form.append('size', '1024x1024');
  form.append('image[]', new Blob([garmentPng], { type: 'image/png' }), 'garment.png');
  form.append('image[]', new Blob([customerPng], { type: 'image/png' }), 'customer.png');

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[try-on] Alternate engine ${response.status}:`, text);
    throw new Error('AI could not generate the try-on. Please try a clearer, front-facing photo.');
  }

  const json = await response.json();
  const b64 = json.data?.[0]?.b64_json;

  if (!b64) {
    console.error('[try-on] No image from alternate engine:', JSON.stringify(json).slice(0, 500));
    throw new Error('AI could not generate the try-on. Please try a clearer, front-facing photo.');
  }

  if (json.usage) console.log('[try-on] Alternate engine usage:', JSON.stringify(json.usage));

  return { data: b64, mimeType: 'image/png', model: ALT_TRYON_MODEL };
}
