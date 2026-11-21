// Builds the full instruction text the n8n AI Agent receives in the `prompt` field.
// In n8n, set the AI Agent's prompt to:  {{ $json.body.prompt }}
// Editing this file changes the agent's behaviour without touching n8n.

const MAX_NOTES_CHARS = Number(process.env.MAX_NOTES_CHARS) || 60000;

const BASE_TUTOR = `You are a friendly, expert biology tutor helping a student aim for top grades.
Be accurate, use correct scientific terminology, and keep explanations clear and encouraging.
Base your answers on the student's notes; where you add facts that are not in the notes, keep them standard and exam-relevant.`;

// Exam-specific guidance. `tool` must match the tool name of the knowledge base attached to the n8n AI Agent.
export const EXAMS = {
  ib_sl: {
    label: 'IB Diploma Biology SL',
    tool: 'ib_biology_knowledge_base',
    guide: `The student is preparing for IB Diploma Biology at STANDARD LEVEL (SL) — current guide, first assessed 2025, organised into four themes (A Unity and diversity, B Form and function, C Interaction and interdependence, D Continuity and change) across levels of organisation (molecules, cells, organisms, ecosystems). Do not require additional higher level (AHL) content from an SL student; you may mention it as extension only.`,
  },
  ib_hl: {
    label: 'IB Diploma Biology HL',
    tool: 'ib_biology_knowledge_base',
    guide: `The student is preparing for IB Diploma Biology at HIGHER LEVEL (HL) — current guide, first assessed 2025, organised into four themes (A Unity and diversity, B Form and function, C Interaction and interdependence, D Continuity and change) across levels of organisation (molecules, cells, organisms, ecosystems). Include additional higher level (AHL) content.`,
  },
  ap: {
    label: 'AP Biology',
    tool: 'ap_biology_knowledge_base',
    guide: `The student is preparing for the College Board AP Biology exam. The Course and Exam Description (CED) has 8 units: 1 Chemistry of Life, 2 Cell Structure and Function, 3 Cellular Energetics, 4 Cell Communication and Cell Cycle, 5 Heredity, 6 Gene Expression and Regulation, 7 Natural Selection, 8 Ecology — plus science practices (concept explanation, visual representations, questions and methods, representing and describing data, statistical tests and data analysis, argumentation). Refer to topics by unit where helpful.`,
  },
};

const STYLE = {
  ib: `IB exam conventions: questions start with an IB command term (e.g. state, outline, describe, explain, compare and contrast, distinguish, deduce, suggest, evaluate, discuss) and the command term sets the depth required. Markschemes award one mark per valid point (alternatives separated by "/", with "accept" / "do not accept" notes) and the number of marks signals how many points are needed. Data-based questions and experimental skills (variables, uncertainty, reliability) are common.`,
  ap: `AP exam conventions: free-response questions use task verbs (identify, describe, explain, predict, justify, construct/draw, calculate, make a claim, support with evidence) and are scored with point-based scoring guidelines where each point needs a specific, precise idea. Common skills: experimental design (independent/dependent variable, controls, null hypothesis), interpreting graphs and data, and calculations (e.g. chi-square, Hardy-Weinberg, water potential, rate, percent change).`,
};

function tutor(exam) {
  const e = EXAMS[exam];
  if (!e) return BASE_TUTOR;
  const style = exam === 'ap' ? STYLE.ap : STYLE.ib;
  // Only mention the search tool once it exists in n8n — otherwise some models stall trying to call it.
  const kb = process.env.KNOWLEDGE_BASE === 'true'
    ? `KNOWLEDGE BASE: use your tool "${e.tool}" FIRST`
    : null;
  if (!kb) return `${BASE_TUTOR}

${e.guide}
${style}
Use your own knowledge of the ${e.label} course. Never invent past-paper references.`;
  return `${BASE_TUTOR}

${e.guide}
${style}

${kb} (1–3 focused searches) for the relevant syllabus statements, past exam questions, markschemes/scoring guidelines and examiner/chief reader reports, and base your answer on what you find — match their wording and the points examiners reward. Never invent past-paper references. If it finds nothing relevant, rely on your own knowledge of the ${e.label} course.`;
}

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

export function buildPrompt({ task, notes = '', question = '', history = [], quizOptions = {}, item, studentAnswer, exam = '' }) {
  const TUTOR = tutor(exam);
  const examName = EXAMS[exam]?.label;
  switch (task) {
    case 'quiz': {
      const count = Math.min(Math.max(Number(quizOptions.count) || 5, 3), 15);
      const difficulty = DIFFICULTY[quizOptions.difficulty] || DIFFICULTY.exam;
      return `${TUTOR}

Create a quiz of exactly ${count} questions on the notes below.
Difficulty — ${difficulty}
Use mostly multiple-choice questions with 4 options, plus 1–2 written questions worth 2–4 marks each${examName ? `, written exactly in the style of real ${examName} exam questions (correct command terms / task verbs, and a markscheme with one point per mark)` : ''}.
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
      "marks": 3,
      "modelAnswer": "an ideal full-marks answer",
      "keyPoints": ["markscheme point 1 (one mark)", "markscheme point 2", "markscheme point 3"],
      "explanation": "short teaching note"
    }
  ]
}
"answer" is the 0-based index of the correct option.

${notesBlock(notes)}`;
    }

    case 'mark':
      return `${TUTOR}

Mark the student's answer out of ${marks(item)}, like a fair but strict ${examName || 'exam'} examiner: award one mark per markscheme point that is clearly and correctly made (accept equivalent wording, but not vague answers).

QUESTION: ${item?.question || ''}
MODEL ANSWER: ${item?.modelAnswer || ''}
KEY POINTS: ${(item?.keyPoints || []).join('; ')}
STUDENT'S ANSWER: ${studentAnswer || '(blank)'}

Respond with ONLY valid JSON (no Markdown, no code fences), in exactly this shape:
{"score": 0, "maxScore": ${marks(item)}, "feedback": "1–3 sentences: which points earned marks, which were missing, and the exact wording an examiner wants to see for full marks"}`;

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

    case 'gapcheck':
      return `${TUTOR}

Do a syllabus GAP CHECK: compare the student's notes with the official ${examName || 'biology'} syllabus for the topic(s) these notes cover.
${MARKDOWN}
Use exactly these sections:
## Coverage
One line: an estimated coverage percentage for the topic(s), and which ${examName ? (exam === 'ap' ? 'unit(s)/topic(s)' : 'theme(s)/topic(s)') : 'topic(s)'} the notes belong to.
## ✅ Covered well
Bullet list.
## ⚠️ Covered partly
Bullet list — say exactly what detail is missing.
## ❌ Missing
Bullet list of syllabus content not in the notes, most exam-relevant first${exam === 'ib_sl' ? ' (SL content only; list any AHL content separately as "HL only — not needed for SL")' : ''}.
## 🎯 How it's examined
2–3 typical exam questions on the missing or weak areas, each with the marks it would carry and the key points examiners look for.
## Next steps
A short, prioritised 3-step revision plan.
${extra(question)}
${notesBlock(notes)}`;

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

function marks(item) {
  const m = Number(item?.marks);
  return Number.isInteger(m) && m >= 1 && m <= 10 ? m : Math.max(2, Math.min((item?.keyPoints || []).length, 6));
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
        marks: Number.isInteger(Number(x.marks)) && Number(x.marks) > 0 ? Number(x.marks) : undefined,
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
