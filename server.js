import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import { fileURLToPath } from 'node:url';
import { buildPrompt, parseJsonReply, normalizeQuiz } from './prompts.js';

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
const ALLOWED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, '.pdf', '.docx']);

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
app.use(express.json({ limit: '2mb' }));
// Markdown rendering libraries, served locally (no CDN needed)
app.get('/vendor/marked.min.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/marked/marked.min.js')));
app.get('/vendor/purify.min.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/dompurify/dist/purify.min.js')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, webhookConfigured: Boolean(N8N_WEBHOOK_URL), method: N8N_WEBHOOK_METHOD });
});

/**
 * Upload step: receives files/pasted notes, extracts their text, and asks the agent
 * for a summary / flashcards / explanation / quiz.
 *
 * Fields sent to n8n (multipart/form-data for POST, query string for GET):
 *   prompt     full instructions for the AI Agent  ← use {{ $json.body.prompt }} in n8n
 *   notes      combined plain text of all notes
 *   task       summarize | flashcards | explain | quiz | followup | mark
 *   question   optional instruction / follow-up question
 *   sessionId  per-browser-tab ID (for n8n memory nodes)
 *   fileNames  JSON array of uploaded file names
 *   file0..N   original files (POST only)
 *
 * Returns { output, notes, quiz? } — `notes` is the extracted text, which the browser
 * keeps so follow-up questions and quizzes can be generated without re-uploading.
 */
app.post('/api/analyze', upload.array('files', 5), async (req, res) => {
  const pasted = (req.body.notes || '').trim();
  const task = (req.body.task || 'summarize').trim();
  const question = (req.body.question || '').trim();
  const files = req.files || [];

  if (!pasted && files.length === 0) {
    return res.status(400).json({ error: 'Please upload a notes file or paste some notes.' });
  }

  // Build the notes text the agent reads: pasted text + text extracted from every file.
  const textParts = [];
  if (pasted) textParts.push(pasted);
  const unreadable = [];
  for (const f of files) {
    let text = '';
    try {
      text = (await fileToText(f)).trim();
    } catch (err) {
      console.error(`Could not extract text from ${f.originalname}:`, err.message);
    }
    if (text) textParts.push(`--- ${f.originalname} ---\n${text}`);
    else unreadable.push(f.originalname);
  }

  if (textParts.length === 0) {
    return res.status(400).json({
      error: `Couldn't read any text from ${unreadable.join(', ')}. If it's a scanned PDF or photo, it contains images rather than text. Try a text-based PDF, a .docx/.txt file, or paste the notes instead.`,
    });
  }

  const notes = textParts.join('\n\n');
  const quizOptions = { count: req.body.quizCount, difficulty: req.body.quizDifficulty };

  try {
    const output = await callAgent(
      { task, notes, question, sessionId: req.body.sessionId, fileNames: files.map((f) => f.originalname), quizOptions },
      files,
    );
    const body = { output, notes };
    if (task === 'quiz') {
      body.quiz = normalizeQuiz(parseJsonReply(output));
      if (!body.quiz) console.warn('Quiz reply was not valid quiz JSON; showing it as text.');
    }
    res.json(body);
  } catch (err) {
    sendAgentError(res, err);
  }
});

/**
 * Follow-up step (JSON, no files): follow-up chat, new quizzes, and marking short answers.
 * Body: { task, notes, question?, history?, quizOptions?, item?, studentAnswer?, sessionId? }
 */
app.post('/api/ask', async (req, res) => {
  const { task, notes = '', question = '', history = [], quizOptions = {}, item, studentAnswer = '', sessionId } = req.body || {};

  if (!['followup', 'quiz', 'mark', 'summarize', 'flashcards', 'explain'].includes(task)) {
    return res.status(400).json({ error: 'Unknown task.' });
  }
  if (task === 'followup' && !String(question).trim()) {
    return res.status(400).json({ error: 'Please type a question.' });
  }
  if (task === 'mark' && !item?.question) {
    return res.status(400).json({ error: 'Missing question to mark.' });
  }
  if (task !== 'mark' && !String(notes).trim()) {
    return res.status(400).json({ error: 'No notes found — upload your notes first.' });
  }

  try {
    const output = await callAgent({
      task, notes: String(notes), question: String(question).trim(), sessionId,
      history: Array.isArray(history) ? history : [], quizOptions, item, studentAnswer: String(studentAnswer),
    });

    if (task === 'quiz') {
      const quiz = normalizeQuiz(parseJsonReply(output));
      return res.json({ output, quiz });
    }
    if (task === 'mark') {
      const m = parseJsonReply(output);
      if (m && Number.isFinite(Number(m.score))) {
        const maxScore = Number(m.maxScore) || 2;
        const score = Math.min(Math.max(Number(m.score), 0), maxScore);
        return res.json({ mark: { score, maxScore, feedback: String(m.feedback || '') } });
      }
      return res.json({ mark: null, output });
    }
    res.json({ output });
  } catch (err) {
    sendAgentError(res, err);
  }
});

class AgentError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Send one request to the n8n webhook and return the agent's reply as text. */
async function callAgent({ task, notes, question = '', sessionId, fileNames = [], history, quizOptions, item, studentAnswer }, files = []) {
  if (!N8N_WEBHOOK_URL) {
    throw new AgentError(500, 'N8N_WEBHOOK_URL is not configured on the server. Copy .env.example to .env and set it.');
  }

  const fields = {
    prompt: buildPrompt({ task, notes, question, history, quizOptions, item, studentAnswer }),
    notes,
    task,
    question,
    fileNames: JSON.stringify(fileNames),
    // n8n memory nodes need a session ID; the browser sends one per tab, otherwise generate one.
    sessionId: String(sessionId || '').trim() || randomUUID(),
  };

  const headers = {};
  if (process.env.N8N_AUTH_HEADER_NAME && process.env.N8N_AUTH_HEADER_VALUE) {
    headers[process.env.N8N_AUTH_HEADER_NAME] = process.env.N8N_AUTH_HEADER_VALUE;
  }

  let url = N8N_WEBHOOK_URL;
  const init = { method: N8N_WEBHOOK_METHOD, headers, signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) };

  if (N8N_WEBHOOK_METHOD === 'GET') {
    const u = new URL(N8N_WEBHOOK_URL);
    for (const [k, v] of Object.entries(fields)) u.searchParams.set(k, v);
    if (u.toString().length > MAX_GET_NOTES_CHARS * 3) {
      throw new AgentError(400, 'Your notes are too long for a GET webhook. Shorten them, or switch the n8n webhook to POST.');
    }
    url = u.toString();
  } else {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    files.forEach((f, i) => {
      form.append(`file${i}`, new Blob([f.buffer], { type: f.mimetype || 'application/octet-stream' }), f.originalname);
    });
    init.body = form;
  }

  let upstream;
  try {
    upstream = await fetch(url, init);
  } catch (err) {
    console.error('Error calling n8n webhook:', err);
    if (err.name === 'TimeoutError') throw new AgentError(504, 'The agent took too long to respond.');
    throw new AgentError(502, 'Could not reach the n8n agent.');
  }

  const raw = await upstream.text();
  if (upstream.status === 404 && /webhook-test/.test(N8N_WEBHOOK_URL)) {
    throw new AgentError(502, 'n8n test webhook is not listening. Click "Execute workflow" in the n8n editor and try again (test URLs work for one request at a time).', raw.slice(0, 500));
  }
  if (!upstream.ok) {
    console.error(`n8n responded ${upstream.status}: ${raw.slice(0, 500)}`);
    throw new AgentError(502, `The agent returned an error (HTTP ${upstream.status}).`, raw.slice(0, 1000));
  }
  return extractOutput(raw, upstream.headers.get('content-type') || '');
}

function sendAgentError(res, err) {
  if (err instanceof AgentError) return res.status(err.status).json({ error: err.message, details: err.details });
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
}

/** Turn an uploaded file into plain text (PDF, Word .docx, or any text format). */
async function fileToText(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(file.buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  if (ext === '.docx') {
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    return value;
  }
  return file.buffer.toString('utf8');
}

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
