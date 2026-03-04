import { GoogleAuth } from 'google-auth-library';

export const TRYON_MODEL = 'gemini-3-pro-image-preview';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

async function getAccessToken(): Promise<string> {
  const keyJson = process.env.GOOGLE_CLOUD_KEY_JSON;
  if (!keyJson) throw new Error('GOOGLE_CLOUD_KEY_JSON is required');

  const credentials = JSON.parse(keyJson);
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/generative-language'],
  });

  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to get OAuth2 access token');
  return token;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generateContent(requestBody: object): Promise<any> {
  const token = await getAccessToken();

  const response = await fetch(`${BASE_URL}/${TRYON_MODEL}:generateContent`, {
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

// Step 1: Isolate the garment from the product image (remove model/mannequin)
export async function isolateGarment(
  productBase64: string,
  productMimeType: string
): Promise<{ data: string; mimeType: string }> {
  const result = await generateContent({
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

// System instruction for the try-on step
export const TRYON_SYSTEM_INSTRUCTION = `You are a photo editing AI that performs clothing swaps. You receive a customer photo and an isolated garment image (garment on white background, no person). Your job is to place the garment onto the customer exactly as they appear — preserving their face, body, pose, and background completely. You only change the clothing.`;

export const TRYON_PROMPT = `You will receive two images:

IMAGE 1 — ISOLATED GARMENT (on white background, no person):
This shows a clothing item on a plain white background. Use this as your garment reference — its exact color, fabric, texture, collar, sleeves, buttons, and all design details.
There is no model or pose to copy from this image.

IMAGE 2 — CUSTOMER PHOTO (your canvas):
This is the real person's photo that you will edit. Preserve EVERYTHING exactly:
- Face: same person, same skin tone, same beard, same hair, same eyes — do not change
- Pose: exact same body position — if lying down, keep lying down; if sitting, keep sitting; if standing, keep standing
- Body: same build, same proportions — do not change
- Background: same room, same surface, same lighting — do not change

THE ONLY CHANGE: Replace the clothing in IMAGE 2 with the garment from IMAGE 1.
Fit the garment naturally onto the person in their exact pose as shown in IMAGE 2.

OUTPUT: IMAGE 2 with only the clothing swapped. Everything else unchanged.`;
