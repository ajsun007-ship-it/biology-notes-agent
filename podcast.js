// Turns a two-host podcast script into one MP3 using OpenAI text-to-speech.
// Without OPENAI_API_KEY the app falls back to the browser's built-in voices.
import { randomUUID } from 'node:crypto';

const TTS_URL = process.env.TTS_URL || 'https://api.openai.com/v1/audio/speech';
const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const VOICES = { Alex: process.env.TTS_VOICE_ALEX || 'coral', Sam: process.env.TTS_VOICE_SAM || 'onyx' };
const STYLE = {
  Alex: 'Upbeat, curious podcast host. Natural, conversational and energetic.',
  Sam: 'Warm, friendly biology teacher. Clear, calm and encouraging, explaining to a student.',
};
const CONCURRENCY = 4;
const KEEP_MS = 60 * 60 * 1000; // keep generated episodes for 1 hour
const MAX_EPISODES = 30;

const episodes = new Map(); // id -> { audio: Buffer, created }

export const audioEnabled = () => Boolean(process.env.OPENAI_API_KEY);

async function speak(line) {
  const body = { model: TTS_MODEL, voice: VOICES[line.speaker] || VOICES.Alex, input: line.text, response_format: 'mp3' };
  if (TTS_MODEL.startsWith('gpt-4o')) body.instructions = STYLE[line.speaker] || STYLE.Alex;

  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Text-to-speech failed (HTTP ${res.status}): ${detail}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Record every line (a few at a time) and join them into one MP3. Returns the episode id. */
export async function recordEpisode(script) {
  const parts = new Array(script.lines.length);
  let next = 0;
  async function worker() {
    while (next < script.lines.length) {
      const i = next++;
      parts[i] = await speak(script.lines[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, script.lines.length) }, worker));

  // MP3 files made of plain frames can be concatenated and play as one track.
  const audio = Buffer.concat(parts);
  const id = randomUUID();
  episodes.set(id, { audio, created: Date.now() });
  cleanup();
  return id;
}

export function getEpisode(id) {
  const ep = episodes.get(id);
  return ep && Date.now() - ep.created < KEEP_MS ? ep.audio : null;
}

function cleanup() {
  const now = Date.now();
  for (const [id, ep] of episodes) if (now - ep.created > KEEP_MS) episodes.delete(id);
  while (episodes.size > MAX_EPISODES) episodes.delete(episodes.keys().next().value);
}
