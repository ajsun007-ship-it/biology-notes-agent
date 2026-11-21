// A tiny stand-in for your n8n webhook, for local testing without n8n.
// Run: npm run mock   then set N8N_WEBHOOK_URL=http://localhost:5678/webhook/biology-notes
import express from 'express';
import multer from 'multer';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.all('/webhook/biology-notes', upload.any(), async (req, res) => {
  const { notes = '', task, question } = req.method === 'GET' ? req.query : req.body;
  const files = (req.files || []).map((f) => `${f.originalname} (${f.size} bytes)`);
  await new Promise((r) => setTimeout(r, 1200));
  const words = notes.split(/\s+/).filter(Boolean).length;
  res.json({
    output: `## Mock agent response (${req.method})\n\n**Task:** ${task}\n\n${question ? `**Question:** ${question}\n\n` : ''}` +
      `Received **${words}** words of text and ${files.length} file(s): ${files.join(', ') || 'none'}.\n\n` +
      `### Key points\n- First line of notes: _${notes.split('\n').find(Boolean) || 'n/a'}_\n- Replace this mock with your real n8n workflow.`,
  });
});

app.listen(5678, () => console.log('Mock n8n webhook at http://localhost:5678/webhook/biology-notes'));
