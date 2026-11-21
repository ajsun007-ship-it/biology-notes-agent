import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
// GET sends fields as URL query parameters (no binary files possible); POST sends multipart/form-data.
const N8N_WEBHOOK_METHOD = (process.env.N8N_WEBHOOK_METHOD || 'POST').toUpperCase();
// Most servers reject URLs longer than ~8 KB, so cap notes sent via GET.
const MAX_GET_NOTES_CHARS = Number(process.env.MAX_GET_NOTES_CHARS) || 6000;
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 10;
const AGENT_TIMEOUT_MS = (Number(process.env.AGENT_TIMEOUT_SECONDS) || 120) * 1000;

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.rtf']);
const ALLOWED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, '.pdf', '.docx', '.doc']);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) return cb(null, true);
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', `Unsupported file type: ${ext || 'none'}`));
  },
});

app.use(express.static(path.join(__dirname, 'public')));
// Markdown rendering libraries, served locally (no CDN needed)
app.get('/vendor/marked.min.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/marked/marked.min.js')));
app.get('/vendor/purify.min.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/dompurify/dist/purify.min.js')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, webhookConfigured: Boolean(N8N_WEBHOOK_URL), method: N8N_WEBHOOK_METHOD });
});

/**
 * Receives notes from the browser and forwards them to the n8n webhook.
 * The browser never sees the webhook URL, and there are no CORS issues.
 *
 * Sent to n8n as multipart/form-data:
 *   - notes:      combined plain text (pasted text + contents of text files)
 *   - task:       what the user wants done (summary, quiz, flashcards...)
 *   - question:   optional free-form instruction
 *   - fileNames:  JSON array of uploaded file names
 *   - file0..N:   the original uploaded files (binary, e.g. PDFs)
 */
app.post('/api/analyze', upload.array('files', 5), async (req, res) => {
  if (!N8N_WEBHOOK_URL) {
    return res.status(500).json({ error: 'N8N_WEBHOOK_URL is not configured on the server. Copy .env.example to .env and set it.' });
  }

  const pasted = (req.body.notes || '').trim();
  const task = (req.body.task || 'summarize').trim();
  const question = (req.body.question || '').trim();
  const files = req.files || [];

  if (!pasted && files.length === 0) {
    return res.status(400).json({ error: 'Please upload a notes file or paste some notes.' });
  }

  // Build combined text so the agent can work even without parsing binaries.
  const textParts = [];
  if (pasted) textParts.push(pasted);
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) {
      textParts.push(`--- ${f.originalname} ---\n${f.buffer.toString('utf8')}`);
    }
  }

  const headers = {};
  if (process.env.N8N_AUTH_HEADER_NAME && process.env.N8N_AUTH_HEADER_VALUE) {
    headers[process.env.N8N_AUTH_HEADER_NAME] = process.env.N8N_AUTH_HEADER_VALUE;
  }

  const notesText = textParts.join('\n\n');
  const fields = {
    notes: notesText,
    task,
    question,
    fileNames: JSON.stringify(files.map((f) => f.originalname)),
    // n8n memory nodes need a session ID; the browser sends one per tab, otherwise generate one.
    sessionId: (req.body.sessionId || '').trim() || randomUUID(),
  };

  let url = N8N_WEBHOOK_URL;
  const init = { method: N8N_WEBHOOK_METHOD, headers, signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) };

  if (N8N_WEBHOOK_METHOD === 'GET') {
    const binary = files.filter((f) => !TEXT_EXTENSIONS.has(path.extname(f.originalname).toLowerCase()));
    if (binary.length) {
      return res.status(400).json({
        error: `PDF/Word files can't be sent to a GET webhook (${binary.map((f) => f.originalname).join(', ')}). Upload .txt/.md files or paste the text instead.`,
      });
    }
    if (notesText.length > MAX_GET_NOTES_CHARS) {
      return res.status(400).json({
        error: `Notes are too long for a GET webhook (${notesText.length.toLocaleString()} characters, max ${MAX_GET_NOTES_CHARS.toLocaleString()}). Shorten them, or switch the n8n webhook to POST.`,
      });
    }
    const u = new URL(N8N_WEBHOOK_URL);
    for (const [k, v] of Object.entries(fields)) u.searchParams.set(k, v);
    url = u.toString();
  } else {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    files.forEach((f, i) => {
      form.append(`file${i}`, new Blob([f.buffer], { type: f.mimetype || 'application/octet-stream' }), f.originalname);
    });
    init.body = form;
  }

  try {
    const upstream = await fetch(url, init);

    const contentType = upstream.headers.get('content-type') || '';
    const raw = await upstream.text();

    if (upstream.status === 404 && /webhook-test/.test(N8N_WEBHOOK_URL)) {
      return res.status(502).json({
        error: 'n8n test webhook is not listening. Click "Execute workflow" / "Listen for test event" in the n8n editor and try again (test URLs work for one request at a time).',
        details: raw.slice(0, 500),
      });
    }
    if (!upstream.ok) {
      console.error(`n8n responded ${upstream.status}: ${raw.slice(0, 500)}`);
      return res.status(502).json({ error: `The agent returned an error (HTTP ${upstream.status}).`, details: raw.slice(0, 1000) });
    }

    res.json({ output: extractOutput(raw, contentType) });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError';
    console.error('Error calling n8n webhook:', err);
    res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'The agent took too long to respond.' : 'Could not reach the n8n agent.',
    });
  }
});

/**
 * n8n can respond in many shapes depending on the "Respond to Webhook" node:
 *   "plain text", {"output": "..."}, [{"output": "..."}], {"text": "..."}, etc.
 * Normalise to a single string (markdown) for the UI.
 */
function extractOutput(raw, contentType) {
  if (!raw) return '';
  let data = raw;
  if (contentType.includes('json') || /^[\[{]/.test(raw.trim())) {
    try { data = JSON.parse(raw); } catch { return raw; }
  } else {
    return raw;
  }
  return pickText(data);
}

function pickText(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return data.map(pickText).filter(Boolean).join('\n\n');
  if (typeof data === 'object') {
    for (const key of ['output', 'text', 'response', 'answer', 'message', 'result', 'content', 'data', 'json']) {
      if (key in data) return pickText(data[key]);
    }
    return '```json\n' + JSON.stringify(data, null, 2) + '\n```';
  }
  return String(data);
}

// Multer / generic error handler
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${MAX_FILE_MB} MB).` : err.field || err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`Biology Notes Agent running at http://localhost:${PORT}`);
  if (!N8N_WEBHOOK_URL) console.warn('⚠  N8N_WEBHOOK_URL is not set — requests will fail until you configure it in .env');
});
