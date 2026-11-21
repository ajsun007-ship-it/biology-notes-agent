// Builds the full instruction text the n8n AI Agent receives in the `prompt` field.
// In n8n, set the AI Agent's prompt to:  {{ $json.body.prompt }}
// Editing this file changes the agent's behaviour without touching n8n.

const MAX_NOTES_CHARS = Number(process.env.MAX_NOTES_CHARS) || 60000;

const TUTOR = `You are a friendly, expert biology tutor helping a student aim for an A+.
Be accurate, use correct scientific terminology, and keep explanations clear and encouraging.
Base your answers on the student's notes; where you add facts that are not in the notes, keep them standard and exam-relevant.`;

const DIFFICULTY = {
  easy: 'Easy: test recall of key facts and definitions.',
  exam: 'Exam level: mix recall with application and "explain why" questions, like a real school exam.',
  challenge: 'Challenge: focus on application, analysis, linking concepts and tricky misconceptions — A+ level.',
};

function notesBlock(notes) {
  const text = notes.length > MAX_NOTES_CHARS ? `${notes.slice(0, MAX_NOTES_CHARS)}\n[...notes truncated...]` : notes;
  return `STUDENT'S NOTES:\n"""\n${text}\n"""`;
}

function extra(question) {
  return question ? `\nExtra instructions from the student: ${question}\n` : '';
}

const MARKDOWN = 'Reply in clear Markdown with headings, short paragraphs and bullet points. Bold the key terms.';

export function buildPrompt({ task, notes = '', question = '', history = [], quizOptions = {}, item, studentAnswer }) {
  switch (task) {
    case 'quiz': {
      const count = Math.min(Math.max(Number(quizOptions.count) || 5, 3), 15);
      const difficulty = DIFFICULTY[quizOptions.difficulty] || DIFFICULTY.exam;
      return `${TUTOR}

Create a quiz of exactly ${count} questions on the notes below.
Difficulty — ${difficulty}
Use mostly multiple-choice questions with 4 options, plus 1–2 short-answer questions that need a 1–3 sentence explanation.
Make wrong options plausible (common misconceptions). Spread the correct option position randomly.
${extra(question)}
Respond with ONLY valid JSON (no Markdown, no code fences, no text before or after), in exactly this shape:
{
  "title": "short quiz title",
  "questions": [
    {
      "type": "mcq",
      "question": "question text",
      "options": ["option A", "option B", "option C", "option D"],
      "answer": 0,
      "explanation": "why the correct option is right and the others are wrong"
    },
    {
      "type": "short",
      "question": "question text",
      "modelAnswer": "an ideal full-marks answer",
      "keyPoints": ["point the answer must mention", "another point"],
      "explanation": "short teaching note"
    }
  ]
}
"answer" is the 0-based index of the correct option.

${notesBlock(notes)}`;
    }

    case 'mark':
      return `${TUTOR}

Mark the student's answer to this short-answer question out of 2, like a fair but strict exam marker.
2 = all key points correct, 1 = partly correct or missing a key point, 0 = incorrect or blank.

QUESTION: ${item?.question || ''}
MODEL ANSWER: ${item?.modelAnswer || ''}
KEY POINTS: ${(item?.keyPoints || []).join('; ')}
STUDENT'S ANSWER: ${studentAnswer || '(blank)'}

Respond with ONLY valid JSON (no Markdown, no code fences), in exactly this shape:
{"score": 0, "maxScore": 2, "feedback": "1–3 sentences: what was good, what was missing, how to get full marks"}`;

    case 'followup': {
      const convo = history
        .slice(-8)
        .map((m) => `${m.role === 'user' ? 'STUDENT' : 'TUTOR'}: ${String(m.content).slice(0, 4000)}`)
        .join('\n\n');
      return `${TUTOR}

You are in a tutoring conversation about the student's notes. Answer the student's latest question directly.
If they seem confused, explain step by step and use a simple analogy or example. End with one short check-for-understanding question when it helps.
${MARKDOWN}

${notesBlock(notes)}

CONVERSATION SO FAR:
${convo || '(none)'}

STUDENT'S NEW QUESTION: ${question}`;
    }

    case 'podcast': {
      const minutes = quizOptions.length === 'long' ? 6 : 3;
      const words = minutes * 150;
      return `${TUTOR}

Write a script for a ${minutes}-minute study podcast (about ${words} words) that teaches the notes below.
Two hosts:
- "Alex": an enthusiastic host who asks the questions a student would ask, sometimes voices a common misconception so it can be corrected.
- "Sam": a warm biology expert who explains clearly, with vivid analogies and real-life examples.
Structure: a catchy 1–2 line intro → walk through the key concepts and processes in a logical order → a quick recap of the must-know facts → end with 2 quick-fire quiz questions for the listener (pause, then give the answer) and a one-line sign-off.
Write for the ear: short sentences, natural conversation, no Markdown, no bullet points, no stage directions, no sound effects. Spell out symbols (say "A T P", "carbon dioxide", "H plus ions").
${extra(question)}
Respond with ONLY valid JSON (no Markdown, no code fences), in exactly this shape:
{"title": "episode title", "lines": [{"speaker": "Alex", "text": "..."}, {"speaker": "Sam", "text": "..."}]}

${notesBlock(notes)}`;
    }

    case 'flashcards':
      return `${TUTOR}

Turn the notes into 10–20 flashcards covering every key term, process and fact an exam could ask about.
Format each as:  **Q:** question  then on the next line  **A:** concise answer  — separated by a horizontal rule (---).
${extra(question)}
${notesBlock(notes)}`;

    case 'explain':
      return `${TUTOR}

Explain the main concepts in the notes so they are easy to understand: start simple, then build up to exam-level detail.
Use analogies, step-by-step breakdowns of processes, and point out common mistakes students make.
${MARKDOWN}
${extra(question)}
${notesBlock(notes)}`;

    case 'summarize':
    default:
      return `${TUTOR}

Summarize the notes into a concise revision sheet: key concepts, processes (as numbered steps), key terms with definitions, and a final "Exam tips" section.
${MARKDOWN}
${extra(question)}
${notesBlock(notes)}`;
  }
}

/** Pull a JSON object out of an AI reply that may be wrapped in code fences or extra text. */
export function parseJsonReply(text) {
  if (!text) return null;
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  return null;
}

/** Validate/normalise a quiz object; returns null if unusable. */
export function normalizeQuiz(q) {
  if (!q || !Array.isArray(q.questions)) return null;
  const questions = q.questions
    .map((x) => {
      if (!x || typeof x.question !== 'string') return null;
      if (Array.isArray(x.options) && x.options.length >= 2) {
        const answer = Number(x.answer);
        if (!Number.isInteger(answer) || answer < 0 || answer >= x.options.length) return null;
        return { type: 'mcq', question: x.question, options: x.options.map(String), answer, explanation: String(x.explanation || '') };
      }
      return {
        type: 'short',
        question: x.question,
        modelAnswer: String(x.modelAnswer || x.answer || ''),
        keyPoints: Array.isArray(x.keyPoints) ? x.keyPoints.map(String) : [],
        explanation: String(x.explanation || ''),
      };
    })
    .filter(Boolean);
  return questions.length ? { title: String(q.title || 'Quiz'), questions } : null;
}

/** Validate/normalise a podcast script; returns null if unusable. */
export function normalizePodcast(p) {
  if (!p || !Array.isArray(p.lines)) return null;
  const lines = p.lines
    .filter((l) => l && typeof l.text === 'string' && l.text.trim())
    .map((l) => ({ speaker: /sam/i.test(l.speaker) ? 'Sam' : 'Alex', text: l.text.trim().slice(0, 3000) }));
  return lines.length ? { title: String(p.title || 'Study podcast'), lines } : null;
}
