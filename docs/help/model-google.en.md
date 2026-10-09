# Connect Google Gemini

Create an API key in Google AI Studio: text runs on Gemini, and image generation automatically uses Nano Banana 2.1 with the same key. You pay on your Google bill — **no Agents Workshop credits are used**.

## Option: API key (pay as you go)

This is Google's official OpenAI-compatible endpoint: `https://generativelanguage.googleapis.com/v1beta/openai`. Fill in a Google key and it works.

1. Open [Google AI Studio (get an API key)](https://aistudio.google.com/apikey) and sign in with your Google account.
2. Click "Get API key" → "Create API key" and copy it.
3. On the "Google Gemini" card click "Enter API key" and paste it; keep the prefilled address.
4. Click "Fetch model list", pick a Gemini model (default `gemini-3.8-flash`, which can see images), then click "Test".
5. Nothing else to set up for images: Settings → Models → "Image generation" will say "Now using: your Google account (Nano Banana 2.1)".

- [OpenAI compatibility notes](https://ai.google.dev/gemini-api/docs/openai)
- [Pricing (including per-image prices)](https://ai.google.dev/gemini-api/docs/pricing)

## Image generation

- Generating and editing from product photos both use Nano Banana 2.1 (`gemini-nano-banana-2.1`), up to 10 reference images at once.
- It has no mask input: say in words which part to change (e.g. "only replace the background, keep the product").
- At Google's list price a 1K image is about $0.034 and 2K about $0.05. The "made with your own account" line on the data board is an estimate; Google's console has the real bill.
- To use a different image endpoint (or pay with credits), pick one explicitly in the "Image generation" block.

The API key only goes into this computer's encrypted vault — never through the AI, never into logs. If this computer can't reach Google, switch image generation to Agents Workshop credits.
