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
3. **AI Agent** node, with a chat model connected. Example prompt (expression):
   ```
   You are a biology tutor. Task: {{ $json.body.task }}.
   Extra instructions: {{ $json.body.question }}
   Notes:
   {{ $json.body.notes }}
   Reply in Markdown.
   ```
   For memory, use `{{ $json.body.sessionId }}` as the session key.
4. **Respond to Webhook** node → Respond With: JSON, body `{ "output": {{ JSON.stringify($json.output) }} }`
   (plain text also works).

### Fields the app sends (multipart/form-data)

| Field       | Description                                                    |
|-------------|----------------------------------------------------------------|
| `notes`     | Pasted text plus text extracted from every file (TXT, MD, PDF, DOCX) |
| `task`      | `summarize`, `flashcards`, `quiz` or `explain`                 |
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
