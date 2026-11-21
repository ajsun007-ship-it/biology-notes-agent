# Biology Notes Agent

A small web app: a welcome page where students upload biology notes. The notes go to an **n8n AI agent** through a webhook, and the agent's reply is shown on the page as formatted Markdown.

```
Browser ──(upload)──▶ Express server /api/analyze ──(multipart POST)──▶ n8n Webhook ──▶ AI Agent ──▶ Respond to Webhook
   ▲                                                                                                      │
   └───────────────────────────── rendered Markdown ◀───────────── JSON / text ◀─────────────────────────┘
```

The Node server sits in the middle so the webhook URL and any auth header stay private, and the browser never runs into CORS problems.

## Quick start

```bash
npm install
cp .env.example .env      # then set N8N_WEBHOOK_URL
npm start                 # http://localhost:3000
```

### Try it without n8n

```bash
npm run mock                                                            # terminal 1
N8N_WEBHOOK_URL=http://localhost:5678/webhook/biology-notes npm start   # terminal 2
```

## Study features

- **Interactive quizzes** — choose 5/10/15 questions and a difficulty. Multiple-choice answers are marked instantly with an explanation; short answers are marked by the AI out of 2 with feedback. The results screen shows a grade, the questions to review, and buttons to retry missed questions, get a new quiz focused on weak spots, or have the tutor explain your mistakes.
- **Follow-up chat** — ask questions about your notes under any answer, with one-click prompts ("Explain that more simply", "Give me a memory trick"…). The browser keeps the extracted notes and recent conversation and sends them with each question, so no re-uploading is needed.

## GET vs POST webhooks

Set `N8N_WEBHOOK_METHOD` to match the HTTP Method of your n8n Webhook node.

- **POST** (recommended): sends `multipart/form-data`, including the original files. In n8n, read fields from `$json.body.*`.
- **GET**: sends the fields as URL query parameters. In n8n, read them from `$json.query.*` (e.g. `{{ $json.query.notes }}`). GET has no request body, so only the extracted text is sent (not the original files), and notes are capped at `MAX_GET_NOTES_CHARS` (default 6000) to stay under URL length limits.

## Setting up the n8n workflow

1. **Webhook** node
   - HTTP Method: `POST`
   - Path: e.g. `biology-notes`
   - Respond: **Using 'Respond to Webhook' Node**
   - Optional: Authentication → Header Auth (matches `N8N_AUTH_HEADER_NAME` / `N8N_AUTH_HEADER_VALUE`)
2. No file-parsing node is needed: the app extracts the text from PDF and Word (.docx) files itself and sends it in `notes`.
3. **AI Agent** node, with a chat model connected.
   - Source for Prompt: **Define below**
   - Prompt (Expression): `{{ $json.body.prompt }}`

   The app writes the complete instructions for each mode (summary, flashcards, quiz JSON,
   marking, follow-up chat) into the `prompt` field — see `prompts.js`. Edit that file to change
   how the tutor behaves; n8n doesn't need to change.
   If you use a memory node, set its Session ID to **Define below** → `{{ $json.body.sessionId }}`.
4. **Respond to Webhook** node → Respond With: JSON, body `{ "output": {{ JSON.stringify($json.output) }} }`
   (plain text also works).

### Fields the app sends (multipart/form-data)

| Field       | Description                                                    |
|-------------|----------------------------------------------------------------|
| `prompt`    | Full instructions for the AI Agent (use this in n8n)          |
| `notes`     | Pasted text plus text extracted from every file (TXT, MD, PDF, DOCX) |
| `task`      | `summarize`, `flashcards`, `explain`, `quiz`, `followup`, `mark` |
| `question`  | Optional extra instruction from the user                       |
| `fileNames` | JSON array of uploaded file names                              |
| `sessionId` | Random ID per browser tab (for agent memory)                   |
| `file0..4`  | The original files as binary (POST only, optional to use)      |

### Response formats the app understands

Plain text, `{"output": "..."}`, `[{"output": "..."}]`, and also the keys `text`, `response`, `answer`, `message`, `result` or `content`. Anything else is shown as formatted JSON.

## Configuration (`.env`)

| Variable                | Default | Purpose                                |
|-------------------------|---------|----------------------------------------|
| `N8N_WEBHOOK_URL`       | —       | **Required.** Your n8n webhook URL     |
| `N8N_WEBHOOK_METHOD`    | `POST`  | `POST` or `GET` (match the n8n node)   |
| `MAX_GET_NOTES_CHARS`   | `6000`  | Max notes length when using GET        |
| `N8N_AUTH_HEADER_NAME`  | —       | Optional header name for webhook auth  |
| `N8N_AUTH_HEADER_VALUE` | —       | Optional header value                  |
| `PORT`                  | `3000`  | Port for the web app                   |
| `MAX_FILE_MB`           | `10`    | Max size per uploaded file             |
| `AGENT_TIMEOUT_SECONDS` | `120`   | How long to wait for the agent         |

> Use the `/webhook/...` **production** URL with the workflow activated. The `/webhook-test/...` URL only works while you have "Listen for test event" running in the editor.
