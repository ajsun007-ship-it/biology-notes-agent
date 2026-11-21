# Add an IB & AP Biology knowledge base to the n8n agent

This guide gives the AI Agent two search tools, **`ib_biology_knowledge_base`** and **`ap_biology_knowledge_base`**,
filled with the official syllabus, past exam questions, markschemes / scoring guidelines and examiner reports.

Once the tools exist, you flip one switch in the app (`KNOWLEDGE_BASE=true`, Step 5). Every prompt for an IB or AP
student then tells the agent to search its tool first, so quizzes, marking, gap checks, chat and podcasts use the real documents.

> Don't turn the switch on before the tools exist. The agent would try to call a tool that isn't there, which can
> stall it until n8n cuts the request off.

```
LOADING (one-time workflow)
Form upload ─▶ Pinecone Vector Store (Insert) ◀─ Embeddings OpenAI
                                              ◀─ Default Data Loader ◀─ Recursive Text Splitter

YOUR EXISTING WORKFLOW
Webhook ─▶ AI Agent ─▶ Respond to Webhook
             ├─ Chat model
             ├─ Tool: Pinecone Vector Store (namespace "ib") ◀─ Embeddings OpenAI
             └─ Tool: Pinecone Vector Store (namespace "ap") ◀─ Embeddings OpenAI
```

Menu names below match recent n8n versions. Older versions may label things slightly differently.

---

## Step 1. Create a free Pinecone index (5 minutes)

Pinecone stores the documents so the agent can search them. Its free plan is plenty for this.

1. Sign up at **https://www.pinecone.io** (free Starter plan).
2. **Create index**:
   - Name: `biology-exams`
   - Dimensions: **1536**
   - Metric: **cosine**
   - Serverless, any cloud/region
3. Go to **API Keys** and copy your key.
4. In n8n, go to **Credentials → Add credential → Pinecone API**, paste the key and save.

> You'll use the OpenAI model **`text-embedding-3-small`** (1536 dimensions) to turn text into searchable numbers.
> The loading workflow and both tools must use this same model. You already have an OpenAI credential in n8n.

---

## Step 2. Build the loading workflow (10 minutes)

Create a **new workflow** called *"Load exam documents"*.

### 2a. Form trigger
Add the **On form submission** trigger (n8n Form) with these fields:

| Field label | Type | Settings |
|---|---|---|
| `File` | File | Required, accepted file types: `.pdf` |
| `Exam` | Dropdown | Options: `ib`, `ap` (lowercase, exactly) |
| `Document type` | Dropdown | Options: `syllabus`, `past paper`, `markscheme`, `examiner report` |

### 2b. Pinecone Vector Store (insert)
Add a **Pinecone Vector Store** node after the form:
- Operation: **Insert Documents**
- Credential: your Pinecone credential
- Pinecone Index: `biology-exams`
- Options → **Pinecone Namespace**: switch to Expression and enter `{{ $json.Exam }}`

The namespace keeps IB and AP documents separate.

### 2c. Sub-nodes of the Pinecone node
Click the **+** under each connector of the Pinecone node:

1. **Embedding → Embeddings OpenAI**
   - Model: `text-embedding-3-small`
2. **Document → Default Data Loader**
   - Type of Data: **Binary**
   - Mode: Load All Input Data
   - Data Format: Automatically Detect by Mime Type
   - Options → **Metadata** (add three; values as Expressions):
     - `exam` → `{{ $('On form submission').item.json.Exam }}`
     - `doc_type` → `{{ $('On form submission').item.json['Document type'] }}`
     - `source` → `{{ $('On form submission').item.binary.File.fileName }}`
   - Text Splitting: Custom → connect a **Recursive Character Text Splitter** (chunk size `1000`, overlap `200`)

> If n8n complains that it can't find the binary data, open the form trigger's output and check the binary
> property name (usually `File`). Use that name wherever this guide says `File`.

### 2d. Activate and upload
Save the workflow, turn it **Active** (or **Publish**), open the **Production URL** of the form trigger, and upload
documents **one at a time**, choosing the exam and document type each time.
Each upload takes a few seconds. You can check the record count in your Pinecone index going up.

---

## Step 3. Which documents to upload

Use **text-based PDFs** (where you can select the text). Scanned PDFs contain images, not text, and won't be searchable.

### AP Biology (all free from College Board, on AP Central)
1. **AP Biology Course and Exam Description (CED)** → `syllabus`
2. **Free-response questions** from the last 5+ years → `past paper`
3. **Scoring guidelines** for the same years → `markscheme`
4. **Chief Reader Reports** for the same years → `examiner report`. These are the most valuable: they explain what students typically get wrong.

You'll find them on the *AP Biology Exam* page of AP Central (past exam questions are listed by year).

### IB Diploma Biology (from your school)
1. **Biology guide (first assessment 2025)** → `syllabus`. It's on the IB Programme Resource Centre; your IB coordinator has access.
2. **Past papers and markschemes** → `past paper` / `markscheme`. From your school's collection or the IB store.
3. **Subject reports** → `examiner report`. Also on the Programme Resource Centre.

> The IB guide changed for exams from May 2025. Older papers (2016 guide) are still useful practice for topics that
> didn't change. Upload them anyway; the agent is told to match the current syllabus.

> **Copyright:** past papers, markschemes and IB materials are copyrighted. Use them for your own students and keep
> the app private (not publicly advertised). The AP CED and the IB guide are fine for this use.

---

## Step 4. Give the AI Agent the two tools (5 minutes)

Open your **existing** workflow (Webhook → AI Agent → Respond to Webhook).

### IB tool
1. Under the AI Agent, click **+** on **Tool** and choose **Pinecone Vector Store**.
2. Operation Mode: **Retrieve Documents (As Tool for AI Agent)**
3. Name: **`ib_biology_knowledge_base`** (exactly, because the app's prompts use this name)
4. Description:
   ```
   Search official IB Diploma Biology documents: the syllabus guide (first assessment 2025), past exam questions, markschemes and subject reports. Use it to find syllabus statements, how topics are examined, the exact markscheme points and command terms examiners reward, and common student mistakes. Query with specific biology terms.
   ```
5. Pinecone Index: `biology-exams`
6. Limit: `6`
7. Options → **Pinecone Namespace**: `ib`
8. Include Metadata: **on** (lets the agent see which document each passage came from)
9. Connect **Embeddings OpenAI** (`text-embedding-3-small`) to its Embedding connector.

### AP tool
Repeat with:
- Name: **`ap_biology_knowledge_base`**
- Description:
  ```
  Search official College Board AP Biology documents: the Course and Exam Description (units, learning objectives, science practices), past free-response questions, scoring guidelines and Chief Reader Reports. Use it to find learning objectives, how topics are examined, the exact points scoring guidelines award, and common student mistakes. Query with specific biology terms.
  ```
- Namespace: `ap`

Then **save** the workflow and **publish/re-activate** it so the production URL uses the new version.

> In some older n8n versions you instead add a **Vector Store Tool** node, then connect a Pinecone Vector Store and a
> chat model underneath it. Use the same names, descriptions and namespaces.

Make sure the AI Agent's chat model supports tool calling. Current OpenAI, Anthropic and Google models all do.

---

## Step 5. Turn it on in the app

Add this line to `.env` on your Mac (and/or Render → **Environment**), then restart the app:
```
KNOWLEDGE_BASE=true
```

## Step 6. Test it

1. In the app, pick **IB Diploma Biology — SL**, upload some notes and run **🔍 Gap check**.
   The answer should refer to specific syllabus content and how it's examined.
2. In n8n, open **Executions**, click the latest run and open the **AI Agent** node.
   You should see calls to `ib_biology_knowledge_base` with the passages it found.
3. Repeat with **AP Biology** and a **Quiz me**. Written questions should read like real free-response questions,
   with point-based markschemes.

### Troubleshooting

| Problem | Fix |
|---|---|
| Agent never calls the tool | Check `KNOWLEDGE_BASE=true` is set and the app restarted, the tool **name** matches exactly, and you re-published the workflow. |
| Tool returns nothing | The namespace on the tool (`ib` / `ap`) must match the `Exam` value used when uploading. Check the record count in Pinecone. |
| "Dimension mismatch" error | The index must be 1536 dimensions, and every Embeddings node must use `text-embedding-3-small`. |
| "Took longer than n8n allows" (HTTP 524) | n8n Cloud cuts replies off after ~100 seconds. Lower the tool **Limit** to 4, use a faster chat model (e.g. a "mini"/"flash" model), or ask for fewer quiz questions. |

## Cost
Loading a 100-page PDF costs well under 1 cent in OpenAI embeddings. Searches are effectively free.
Pinecone's free plan holds far more than a full set of IB and AP documents.
