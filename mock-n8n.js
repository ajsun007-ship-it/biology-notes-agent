// A tiny stand-in for your n8n webhook, for local testing without n8n.
// Run: npm run mock   then set N8N_WEBHOOK_URL=http://localhost:5678/webhook/biology-notes
// It mimics an AI Agent + "Respond to Webhook" returning { "output": "..." }.
import express from 'express';
import multer from 'multer';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.all('/webhook/biology-notes', upload.any(), async (req, res) => {
  const { notes = '', task, question = '', prompt = '' } = req.method === 'GET' ? req.query : req.body;
  await new Promise((r) => setTimeout(r, 800));

  if (task === 'quiz') {
    // Real models sometimes wrap JSON in code fences — the app handles that.
    return res.json({ output: '```json\n' + JSON.stringify({
      title: 'Cell Respiration Check',
      questions: [
        { type: 'mcq', question: 'Where does glycolysis take place?', options: ['Mitochondrial matrix', 'Cytoplasm', 'Inner mitochondrial membrane', 'Nucleus'], answer: 1, explanation: 'Glycolysis happens in the **cytoplasm**; the Krebs cycle is in the matrix.' },
        { type: 'mcq', question: 'What is the final electron acceptor in the ETC?', options: ['NAD+', 'Carbon dioxide', 'Oxygen', 'Glucose'], answer: 2, explanation: 'Oxygen accepts electrons and forms water.' },
        { type: 'short', question: 'Explain why the electron transport chain produces the most ATP.', modelAnswer: 'NADH and FADH2 donate electrons; their energy pumps H+ ions, and the gradient drives ATP synthase (chemiosmosis), producing ~34 ATP.', keyPoints: ['electrons from NADH/FADH2', 'proton gradient', 'ATP synthase'], explanation: 'Link electron flow → proton gradient → ATP synthase.' },
      ],
    }, null, 2) + '\n```' });
  }

  if (task === 'mark') {
    const answered = /gradient|synthase/i.test(prompt.split("STUDENT'S ANSWER:")[1] || '');
    return res.json({ output: JSON.stringify({ score: answered ? 1 : 0, maxScore: 2, feedback: answered ? 'Good mention of the proton gradient, but you did not name where the electrons come from (NADH/FADH2).' : 'This misses the key idea of the proton gradient driving ATP synthase.' }) });
  }

  if (task === 'followup') {
    return res.json({ output: `### Mock tutor reply\nYou asked: **${question}**\n\n- (A real agent would answer using your notes.)\n- Prompt length received: ${prompt.length} characters.\n\n*Quick check:* where does glycolysis happen?` });
  }

  const files = (req.files || []).map((f) => f.originalname);
  const words = notes.split(/\s+/).filter(Boolean).length;
  res.json({
    output: `## Mock agent response (${req.method})\n\n**Task:** ${task}\n\n${question ? `**Question:** ${question}\n\n` : ''}` +
      `Received **${words}** words of notes and ${files.length} file(s): ${files.join(', ') || 'none'}.\n\n` +
      `Prompt received: ${prompt ? `${prompt.length} characters` : '**missing**'}.`,
  });
});

app.listen(5678, () => console.log('Mock n8n webhook at http://localhost:5678/webhook/biology-notes'));
