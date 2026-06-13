import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const TEXT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const SUPPORTED_IMAGE_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto']);
const SUPPORTED_IMAGE_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);
const requestedImageSize = process.env.OPENAI_IMAGE_SIZE || '1024x1024';
const requestedImageQuality = process.env.OPENAI_IMAGE_QUALITY || 'low';
const IMAGE_SIZE = SUPPORTED_IMAGE_SIZES.has(requestedImageSize) ? requestedImageSize : '1024x1024';
const IMAGE_QUALITY = SUPPORTED_IMAGE_QUALITIES.has(requestedImageQuality) ? requestedImageQuality : 'low';

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY in .env');
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function safeJsonParse(text) {
  if (!text) throw new Error('Empty OpenAI response');
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

function normalizeGenerated(parsed, fallbackCategory = '') {
  return {
    category: String(parsed.category || fallbackCategory || 'Weird Facts').slice(0, 80),
    fact: String(parsed.fact || '').trim(),
    text: String(parsed.text || '').trim(),
    first_comment: String(parsed.first_comment || '').trim(),
    image_prompt: String(parsed.image_prompt || '').trim(),
    verification_query: String(parsed.verification_query || '').trim(),
  };
}

function normalizeForSimilarity(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an|and|or|to|of|in|on|for|with|is|are|was|were|your|brain|has|now|glitched)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keywordSet(value = '') {
  return new Set(normalizeForSimilarity(value).split(' ').filter(w => w.length > 3));
}

function jaccard(a = '', b = '') {
  const as = keywordSet(a);
  const bs = keywordSet(b);
  if (!as.size || !bs.size) return 0;
  let intersection = 0;
  for (const item of as) if (bs.has(item)) intersection++;
  return intersection / (as.size + bs.size - intersection);
}

export function isDuplicateIdea(candidate, existing = []) {
  const candidateText = `${candidate.fact || ''}
${candidate.text || ''}
${candidate.verification_query || ''}`;
  const candidateNorm = normalizeForSimilarity(candidateText);
  if (!candidateNorm) return false;

  for (const item of existing || []) {
    const existingText = `${item.fact || ''}
${item.text || ''}
${item.verification_query || ''}`;
    const existingNorm = normalizeForSimilarity(existingText);
    if (!existingNorm) continue;

    if (candidateNorm === existingNorm) return true;
    if (candidateNorm.includes(existingNorm) || existingNorm.includes(candidateNorm)) return true;
    if (jaccard(candidateText, existingText) >= 0.42) return true;
  }
  return false;
}

function avoidListText(avoidFacts = []) {
  const lines = (avoidFacts || [])
    .map(x => String(x.fact || x.text || x.verification_query || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 80)
    .map((x, i) => `${i + 1}. ${x.slice(0, 220)}`);
  return lines.length ? `
Facts/topics already used. Do NOT repeat or rephrase these:
${lines.join('\n')}` : '';
}

export async function generateOpenAIBrainGlitch({ category = '', topic = '', avoidFacts = [] } = {}) {
  const client = getOpenAIClient();
  const prompt = `Create ONE high-quality BrainGlitchX post idea for X/Twitter.

Brand: BrainGlitchX
Style: short, surprising, factual, curiosity-driven. Not clickbait. No hashtags. No emojis unless truly useful.
Audience: general English-speaking audience.
Category requested: ${category || 'random'}
Topic or hint: ${topic || 'none'}${avoidListText(avoidFacts)}

Requirements:
- If a topic or hint is provided, the fact MUST be clearly about that topic. Do not ignore it.
- If a category is requested, use that category exactly.
- The fact must be plausibly verifiable and not medical/legal/financial advice.
- Avoid overused facts when possible, but it must still be easy to understand.
- Do not repeat, lightly reword, or use the same core topic as any already-used fact above.
- Post text: max 4 short paragraphs, under 280 characters if possible.
- First comment: short engagement booster or helpful extra context.
- Image prompt: create a photorealistic image prompt with no text, no logos, no watermarks. Prefer a single strong visual subject.
- Include a search query that I can use to verify the fact before posting.

Return ONLY valid JSON with these exact keys:
{
  "category": "Space|Science|Nature|History|Human Body|Statistics|Technology|Geography|Weird Facts",
  "fact": "one sentence fact",
  "text": "ready-to-post X post text",
  "first_comment": "ready-to-post first reply",
  "image_prompt": "prompt for image generation",
  "verification_query": "search query to verify the fact"
}`;

  const response = await client.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0.8,
    messages: [
      { role: 'system', content: 'You generate concise, factual, viral educational social posts. You always output valid JSON only.' },
      { role: 'user', content: prompt }
    ],
    response_format: { type: 'json_object' }
  });

  const content = response.choices?.[0]?.message?.content;
  return normalizeGenerated(safeJsonParse(content), category);
}

export async function generateOpenAIBrainGlitchBatch({ count = 5, categories = [], topic = '', avoidFacts = [] } = {}) {
  const client = getOpenAIClient();
  const n = Math.max(1, Math.min(Number(count) || 5, 12));
  const categoryText = categories.length ? categories.join(', ') : 'mixed categories';

  const prompt = `Create ${n} high-quality BrainGlitchX post ideas for X/Twitter.

Brand: BrainGlitchX
Style: short, surprising, factual, curiosity-driven. Not clickbait. No hashtags. No emojis unless truly useful.
Audience: general English-speaking audience.
Categories requested: ${categoryText}
Topic or hint: ${topic || 'none'}${avoidListText(avoidFacts)}

Requirements for every item:
- If a topic or hint is provided, EVERY item MUST be clearly about that topic. Do not ignore it.
- If categories are requested, every item category must be one of the requested categories.
- The fact must be plausibly verifiable and not medical/legal/financial advice.
- Avoid repeating the same category or theme too much.
- Avoid overused facts when possible, but each fact must be easy to understand.
- Do not repeat, lightly reword, or use the same core topic as any already-used fact above.
- Items in this batch must also be distinct from each other.
- Post text: max 4 short paragraphs, under 280 characters if possible.
- First comment: short engagement booster or helpful extra context.
- Image prompt: photorealistic, no text, no logos, no watermarks, single strong visual subject when possible.
- Include a search query for manual fact-checking.

Return ONLY valid JSON:
{
  "items": [
    {
      "category": "Space|Science|Nature|History|Human Body|Statistics|Technology|Geography|Weird Facts",
      "fact": "one sentence fact",
      "text": "ready-to-post X post text",
      "first_comment": "ready-to-post first reply",
      "image_prompt": "prompt for image generation",
      "verification_query": "search query to verify the fact"
    }
  ]
}`;

  const response = await client.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0.85,
    messages: [
      { role: 'system', content: 'You generate concise, factual, viral educational social posts. You always output valid JSON only.' },
      { role: 'user', content: prompt }
    ],
    response_format: { type: 'json_object' }
  });

  const content = response.choices?.[0]?.message?.content;
  const parsed = safeJsonParse(content);
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return items.slice(0, n).map(item => normalizeGenerated(item));
}

function imageStyleSuffix() {
  return 'Photorealistic, cinematic lighting, high detail, professional photography, square composition, no text, no captions, no logos, no watermark.';
}

export async function generateOpenAIImage({ prompt, uploadDir }) {
  if (!prompt || !String(prompt).trim()) throw new Error('Missing image prompt');
  const client = getOpenAIClient();
  await fs.mkdir(uploadDir, { recursive: true });

  const fullPrompt = `${prompt.trim()}\n\n${imageStyleSuffix()}`;
  const response = await client.images.generate({
    model: IMAGE_MODEL,
    prompt: fullPrompt,
    size: IMAGE_SIZE,
    quality: IMAGE_QUALITY,
  });

  const item = response.data?.[0];
  if (!item) throw new Error('OpenAI image generation returned no image');

  const filename = `${Date.now()}-${crypto.randomUUID()}.png`;
  const absolutePath = path.join(uploadDir, filename);

  if (item.b64_json) {
    await fs.writeFile(absolutePath, Buffer.from(item.b64_json, 'base64'));
  } else if (item.url) {
    const fetched = await fetch(item.url);
    if (!fetched.ok) throw new Error(`Could not download generated image: HTTP ${fetched.status}`);
    const buffer = Buffer.from(await fetched.arrayBuffer());
    await fs.writeFile(absolutePath, buffer);
  } else {
    throw new Error('OpenAI image generation returned neither b64_json nor url');
  }

  return path.join('public', 'uploads', filename).replaceAll('\\', '/');
}
