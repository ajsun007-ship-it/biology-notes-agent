const MAX_FILES = 5;
const $ = (id) => document.getElementById(id);

const form = $('notes-form');
const fileInput = $('file-input');
const dropzone = $('dropzone');
const fileList = $('file-list');
const notesText = $('notes-text');
const submitBtn = $('submit-btn');
const formError = $('form-error');
const outputCard = $('output-card');
const outputTitle = $('output-title');
const outputEl = $('output');
const quizEl = $('quiz');
const chatCard = $('chat-card');
const chatMessages = $('chat-messages');
const chatForm = $('chat-form');
const chatInput = $('chat-input');
const chatError = $('chat-error');

const state = {
  files: [],
  notes: '',          // extracted notes text returned by the server
  lastOutput: '',
  history: [],        // follow-up chat turns: { role: 'user' | 'assistant', content }
  quiz: null,         // { title, questions }
  qIndex: 0,
  results: [],        // per question: { score, max, chosen?, answerText? }
  sessionId: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()),
};

// ---------- Exam picker (remembered in this browser) ----------
const examSelect = $('exam');
try { const saved = localStorage.getItem('exam'); if (saved !== null) examSelect.value = saved; } catch {}
examSelect.addEventListener('change', () => { try { localStorage.setItem('exam', examSelect.value); } catch {} });
const exam = () => examSelect.value;

// ---------- Helpers ----------
function md(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text || ''));
  const div = document.createElement('div');
  div.textContent = text || '';
  return `<p style="white-space:pre-wrap">${div.innerHTML}</p>`;
}
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}
function showError(target, msg) { target.textContent = msg; target.hidden = false; }
function hideError(target) { target.hidden = true; }
function flash(btn, msg) { const t = btn.textContent; btn.textContent = msg; setTimeout(() => (btn.textContent = t), 1500); }
const formatSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const quizOptions = () => ({ count: $('quiz-count').value, difficulty: $('quiz-difficulty').value });

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exam: exam(), ...body }) });
  const json = await res.json().catch(() => ({ error: 'Invalid response from server.' }));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

// ---------- File selection ----------
function addFiles(files) {
  for (const f of files) {
    if (state.files.length >= MAX_FILES) { showError(formError, `You can upload up to ${MAX_FILES} files.`); break; }
    if (!state.files.some((s) => s.name === f.name && s.size === f.size)) state.files.push(f);
  }
  renderFileList();
}
function renderFileList() {
  fileList.innerHTML = '';
  state.files.forEach((f, i) => {
    fileList.append(el('li', {},
      el('span', { class: 'name' }, f.name),
      el('span', { class: 'size' }, formatSize(f.size)),
      el('button', { type: 'button', 'aria-label': `Remove ${f.name}`, onclick: () => { state.files.splice(i, 1); renderFileList(); } }, '✕'),
    ));
  });
}
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

// Show extra settings only for "Quiz me" and "Podcast"
form.querySelectorAll('input[name="task"]').forEach((r) =>
  r.addEventListener('change', () => {
    const task = form.querySelector('input[name="task"]:checked').value;
    $('quiz-options').hidden = task !== 'quiz';
    $('podcast-options').hidden = task !== 'podcast';
  }));

// ---------- Main submit ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError(formError);
  if (state.files.length === 0 && !notesText.value.trim()) {
    showError(formError, 'Please upload a notes file or paste some notes first.');
    return;
  }

  const task = form.querySelector('input[name="task"]:checked').value;
  const data = new FormData();
  state.files.forEach((f) => data.append('files', f));
  data.append('notes', notesText.value);
  data.append('task', task);
  data.append('question', $('question').value);
  data.append('sessionId', state.sessionId);
  data.append('quizCount', quizOptions().count);
  data.append('quizDifficulty', quizOptions().difficulty);
  data.append('podcastLength', $('podcast-length').value);
  data.append('exam', exam());

  setLoading(submitBtn, true, task === 'quiz' ? 'Writing your quiz…' : task === 'podcast' ? 'Making your podcast…' : 'Agent is working…');
  if (task === 'podcast') { outputCard.hidden = true; showPodcastLoading(); }
  else showLoadingOutput(task === 'quiz' ? 'The agent is writing your quiz…' : task === 'gapcheck' ? 'Comparing your notes with the syllabus…' : 'The agent is reading your notes…');

  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: data });
    const json = await res.json().catch(() => ({ error: 'Invalid response from server.' }));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);

    state.notes = json.notes || state.notes;
    state.history = [];
    chatMessages.innerHTML = '';
    chatCard.hidden = false;

    if (task === 'podcast') {
      if (json.podcast) showPodcast(json.podcast);
      else { podcastCard.hidden = true; showMarkdown(json.output || '_The agent did not return a podcast script._'); }
    } else if (json.quiz) startQuiz(json.quiz);
    else showMarkdown(json.output || '_The agent returned an empty response._', task === 'gapcheck' ? '🔍 Syllabus gap check' : 'Agent response');
  } catch (err) {
    outputCard.hidden = true;
    if (task === 'podcast') podcastCard.hidden = true;
    showError(formError, err.message);
  } finally {
    setLoading(submitBtn, false, 'Send to agent');
  }
});

function setLoading(btn, on, label) {
  btn.disabled = on;
  btn.classList.toggle('loading', on);
  const lbl = btn.querySelector('.btn-label');
  if (lbl) lbl.textContent = label;
}

function showLoadingOutput(msg) {
  outputCard.hidden = false;
  quizEl.hidden = true;
  outputEl.hidden = false;
  outputEl.className = 'markdown loading';
  outputEl.textContent = msg;
  outputCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showMarkdown(text, title = 'Agent response') {
  state.lastOutput = text;
  state.quiz = null;
  outputTitle.textContent = title;
  outputEl.className = 'markdown';
  outputEl.hidden = false;
  outputEl.innerHTML = md(text);
  quizEl.hidden = true;
  toggleCopyButtons(true);
  // Give the follow-up chat context about what the student is looking at.
  state.history.push({ role: 'assistant', content: text });
  outputCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleCopyButtons(show) {
  $('copy-btn').hidden = !show;
  $('download-btn').hidden = !show;
}

// ---------- Output actions ----------
$('copy-btn').addEventListener('click', async (e) => {
  try { await navigator.clipboard.writeText(state.lastOutput); flash(e.target, 'Copied!'); }
  catch { flash(e.target, 'Copy failed'); }
});
$('download-btn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([state.lastOutput], { type: 'text/markdown' }));
  a.download = 'biology-notes-agent-output.md';
  a.click();
  URL.revokeObjectURL(a.href);
});
$('quiz-me-btn').addEventListener('click', () => requestQuiz());
$('podcast-btn').addEventListener('click', () => requestPodcast());
$('gap-btn').addEventListener('click', async (e) => {
  if (!state.notes) return;
  e.currentTarget.disabled = true;
  showLoadingOutput('Comparing your notes with the syllabus…');
  try {
    const json = await postJson('/api/ask', { task: 'gapcheck', notes: state.notes, sessionId: state.sessionId });
    showMarkdown(json.output || '_No gap check returned._', '🔍 Syllabus gap check');
  } catch (err) {
    outputEl.className = 'markdown';
    outputEl.innerHTML = '';
    outputEl.append(el('p', { class: 'error' }, err.message));
  } finally {
    $('gap-btn').disabled = false;
  }
});

async function requestQuiz(extraInstruction = '') {
  if (!state.notes) return;
  const btn = $('quiz-me-btn');
  btn.disabled = true;
  showLoadingOutput('The agent is writing your quiz…');
  try {
    const json = await postJson('/api/ask', {
      task: 'quiz', notes: state.notes, question: extraInstruction, quizOptions: quizOptions(), sessionId: state.sessionId,
    });
    if (json.quiz) startQuiz(json.quiz);
    else showMarkdown(json.output || '_The agent did not return a quiz._');
  } catch (err) {
    outputEl.className = 'markdown';
    outputEl.innerHTML = '';
    outputEl.append(el('p', { class: 'error' }, err.message));
  } finally {
    btn.disabled = false;
  }
}

// ---------- Quiz ----------
function startQuiz(quiz) {
  state.quiz = quiz;
  state.qIndex = 0;
  state.results = [];
  outputTitle.textContent = `🎯 ${quiz.title}`;
  outputEl.hidden = true;
  quizEl.hidden = false;
  toggleCopyButtons(false);
  renderQuestion();
  outputCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderQuestion() {
  const { quiz, qIndex } = state;
  const q = quiz.questions[qIndex];
  const total = quiz.questions.length;
  quizEl.innerHTML = '';

  const progress = el('div', { class: 'quiz-progress' },
    el('span', {}, `Question ${qIndex + 1} of ${total}`),
    el('span', {}, `Score: ${scoreText()}`));
  const bar = el('div', { class: 'progress-bar' }, el('div', { style: `width:${(qIndex / total) * 100}%` }));
  const questionEl = el('div', { class: 'quiz-question', html: md(q.question) });
  if (q.type === 'short' && q.marks) questionEl.append(el('span', { class: 'marks' }, `[${q.marks} mark${q.marks > 1 ? 's' : ''}]`));
  const feedback = el('div', { class: 'quiz-feedback', hidden: '' });
  const nextBtn = el('button', { type: 'button', class: 'btn btn-inline', hidden: '', onclick: nextQuestion },
    qIndex + 1 < total ? 'Next question →' : 'See my results');

  quizEl.append(progress, bar, questionEl);

  if (q.type === 'mcq') {
    const options = el('div', { class: 'quiz-options-list' });
    q.options.forEach((opt, i) => {
      const btn = el('button', { type: 'button', class: 'quiz-option' },
        el('span', { class: 'letter' }, String.fromCharCode(65 + i)), el('span', {}, opt));
      btn.addEventListener('click', () => {
        const correct = i === q.answer;
        state.results[qIndex] = { score: correct ? 1 : 0, max: 1, chosen: i };
        [...options.children].forEach((b, j) => {
          b.disabled = true;
          if (j === q.answer) b.classList.add('correct');
          else if (j === i) b.classList.add('wrong');
        });
        showFeedback(feedback, correct ? 'good' : 'bad',
          correct ? '✅ Correct!' : `❌ Not quite — the answer is **${String.fromCharCode(65 + q.answer)}**.`, q.explanation);
        nextBtn.hidden = false;
        nextBtn.focus();
      });
      options.append(btn);
    });
    quizEl.append(options);
  } else {
    const answer = el('textarea', { rows: '4', class: 'quiz-answer', placeholder: 'Type your answer in 1–3 sentences…' });
    const checkBtn = el('button', { type: 'button', class: 'btn btn-inline' }, el('span', { class: 'btn-label' }, 'Check my answer'), el('span', { class: 'spinner' }));
    checkBtn.addEventListener('click', async () => {
      if (!answer.value.trim()) { answer.focus(); return; }
      setLoading(checkBtn, true, 'Marking…');
      answer.disabled = true;
      try {
        const json = await postJson('/api/ask', { task: 'mark', item: q, studentAnswer: answer.value, sessionId: state.sessionId });
        checkBtn.remove();
        if (json.mark) {
          const { score, maxScore, feedback: fb } = json.mark;
          state.results[qIndex] = { score: score / maxScore, max: 1, answerText: answer.value };
          const tone = score === maxScore ? 'good' : score > 0 ? 'ok' : 'bad';
          showFeedback(feedback, tone, `${tone === 'good' ? '✅' : tone === 'ok' ? '🟡' : '❌'} **${score}/${maxScore}** — ${fb}`,
            `**Model answer:** ${q.modelAnswer}`);
          nextBtn.hidden = false;
        } else {
          selfMark(feedback, q, answer.value, nextBtn);
        }
      } catch (err) {
        setLoading(checkBtn, false, 'Check my answer');
        answer.disabled = false;
        showFeedback(feedback, 'bad', err.message);
      }
    });
    quizEl.append(answer, el('div', { class: 'quiz-actions' }, checkBtn));
  }

  quizEl.append(feedback, el('div', { class: 'quiz-actions' }, nextBtn));
}

// Fallback when the AI's marking reply couldn't be read: student marks themselves.
function selfMark(feedback, q, answerText, nextBtn) {
  showFeedback(feedback, 'ok', `**Model answer:** ${q.modelAnswer}`,
    q.keyPoints.length ? `Key points: ${q.keyPoints.join('; ')}\n\nHow did you do?` : 'How did you do?');
  const row = el('div', { class: 'self-mark' });
  [['✅ Got it', 1], ['🟡 Partly', 0.5], ['❌ Missed it', 0]].forEach(([label, score]) => {
    row.append(el('button', { type: 'button', class: 'btn-secondary', onclick: () => {
      state.results[state.qIndex] = { score, max: 1, answerText };
      row.remove();
      nextBtn.hidden = false;
    } }, label));
  });
  feedback.append(row);
}

function showFeedback(box, tone, headline, detail) {
  box.className = `quiz-feedback ${tone}`;
  box.innerHTML = md(headline) + (detail ? md(detail) : '');
  box.hidden = false;
}

function scoreText() {
  const got = state.results.reduce((s, r) => s + (r ? r.score : 0), 0);
  return `${Number.isInteger(got) ? got : got.toFixed(1)}/${state.results.filter(Boolean).length}`;
}

function nextQuestion() {
  if (state.qIndex + 1 < state.quiz.questions.length) {
    state.qIndex += 1;
    renderQuestion();
    quizEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    renderResults();
  }
}

function renderResults() {
  const { quiz, results } = state;
  const total = quiz.questions.length;
  const got = results.reduce((s, r) => s + (r ? r.score : 0), 0);
  const pct = Math.round((got / total) * 100);
  const [grade, msg] =
    pct >= 90 ? ['A+', 'Outstanding — you really know this!'] :
    pct >= 80 ? ['A', 'Great work — just a couple of details to polish.'] :
    pct >= 65 ? ['B', 'Good progress — review the questions below and try again.'] :
    pct >= 50 ? ['C', 'Getting there — go over the explanations, then retry the missed ones.'] :
                ['Keep going', 'Every attempt helps you remember. Review the notes and retry the missed questions.'];

  const missed = quiz.questions.map((q, i) => ({ q, r: results[i] })).filter(({ r }) => !r || r.score < 1);

  quizEl.innerHTML = '';
  quizEl.append(
    el('div', { class: 'quiz-results' },
      el('div', { class: 'score-ring', style: `--pct:${pct}` }, el('span', {}, `${pct}%`)),
      el('div', {},
        el('div', { class: 'grade' }, grade),
        el('p', {}, `${Number.isInteger(got) ? got : got.toFixed(1)} / ${total} correct. ${msg}`))),
  );

  if (missed.length) {
    const list = el('div', { class: 'missed' }, el('h3', {}, 'Review these'));
    missed.forEach(({ q, r }) => {
      const correct = q.type === 'mcq' ? q.options[q.answer] : q.modelAnswer;
      const yours = q.type === 'mcq' ? (r ? q.options[r.chosen] : '—') : (r?.answerText || '—');
      list.append(el('div', { class: 'missed-item', html:
        md(`**${q.question}**`) + md(`Your answer: ${yours}`) + md(`✅ ${correct}`) + (q.explanation ? md(`_${q.explanation}_`) : '') }));
    });
    quizEl.append(list);
  }

  const actions = el('div', { class: 'quiz-actions wrap' });
  if (missed.length) {
    actions.append(
      el('button', { type: 'button', class: 'btn btn-inline', onclick: () => startQuiz({ title: `${quiz.title} — retry`, questions: missed.map((m) => m.q) }) }, '🔁 Retry missed questions'),
      el('button', { type: 'button', class: 'btn-secondary', onclick: () => askAboutMistakes(missed) }, '💬 Explain my mistakes'),
    );
  }
  actions.append(el('button', { type: 'button', class: 'btn-secondary', onclick: () =>
    requestQuiz(missed.length ? `Focus especially on these topics the student got wrong: ${missed.map((m) => m.q.question).join(' | ')}` : 'Make it harder than the last quiz.') },
  '🎯 New quiz'));
  quizEl.append(actions);
}

function askAboutMistakes(missed) {
  const summary = missed.map(({ q, r }) => {
    const yours = q.type === 'mcq' ? (r ? q.options[r.chosen] : 'no answer') : (r?.answerText || 'no answer');
    return `- "${q.question}" — I answered: ${yours}`;
  }).join('\n');
  sendChat(`I got these quiz questions wrong. Please explain what I misunderstood in each and how to remember the right answer:\n${summary}`);
  chatCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Follow-up chat ----------
function addChatMessage(role, content, { pending = false } = {}) {
  const msg = el('div', { class: `chat-msg ${role}${pending ? ' pending' : ''}` });
  if (role === 'user') msg.textContent = content;
  else msg.innerHTML = pending ? '<span class="typing"><i></i><i></i><i></i></span>' : md(content);
  chatMessages.append(msg);
  msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return msg;
}

async function sendChat(text) {
  text = text.trim();
  if (!text || !state.notes) return;
  hideError(chatError);
  chatInput.value = '';
  $('chat-send').disabled = true;
  addChatMessage('user', text);
  const pending = addChatMessage('assistant', '', { pending: true });

  try {
    const json = await postJson('/api/ask', {
      task: 'followup', notes: state.notes, question: text, history: state.history, sessionId: state.sessionId,
    });
    const answer = json.output || '_No answer returned._';
    pending.classList.remove('pending');
    pending.innerHTML = md(answer);
    state.history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
  } catch (err) {
    pending.remove();
    showError(chatError, err.message);
  } finally {
    $('chat-send').disabled = false;
    chatInput.focus();
  }
}

chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendChat(chatInput.value); });
document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => sendChat(chip.textContent)));

// ---------- Podcast ----------
const podcastCard = $('podcast-card');
const podcastPlayer = $('podcast-player');
const podcastStatus = $('podcast-status');
const transcriptEl = $('podcast-transcript');
const speech = { lines: [], index: 0, playing: false, rate: 1, voices: {} };

function stopSpeech() {
  speech.playing = false;
  if (window.speechSynthesis) speechSynthesis.cancel();
  transcriptEl.querySelectorAll('.speaking').forEach((li) => li.classList.remove('speaking'));
}

function showPodcastLoading() {
  stopSpeech();
  podcastCard.hidden = false;
  $('podcast-title').textContent = 'Recording your episode…';
  podcastStatus.textContent = 'The agent is writing the script, then the hosts record it. This usually takes 30–90 seconds.';
  podcastPlayer.innerHTML = '<div class="podcast-loading"><span class="typing"><i></i><i></i><i></i></span></div>';
  transcriptEl.innerHTML = '';
  podcastCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function requestPodcast() {
  if (!state.notes) return;
  const btn = $('podcast-btn');
  btn.disabled = true;
  showPodcastLoading();
  try {
    const json = await postJson('/api/ask', {
      task: 'podcast', notes: state.notes, quizOptions: { length: $('podcast-length').value }, sessionId: state.sessionId,
    });
    if (json.podcast) showPodcast(json.podcast);
    else throw new Error('The agent did not return a podcast script. Try again.');
  } catch (err) {
    $('podcast-title').textContent = 'Podcast';
    podcastPlayer.innerHTML = '';
    podcastStatus.textContent = '';
    podcastStatus.append(el('span', { class: 'error' }, err.message));
  } finally {
    btn.disabled = false;
  }
}

function showPodcast(p) {
  stopSpeech();
  podcastCard.hidden = false;
  $('podcast-title').textContent = p.title;
  podcastPlayer.innerHTML = '';
  transcriptEl.innerHTML = '';
  p.lines.forEach((line, i) => {
    transcriptEl.append(el('li', { class: `speaker-${line.speaker.toLowerCase()}`, 'data-i': i },
      el('strong', {}, `${line.speaker}: `), line.text));
  });

  const speeds = el('div', { class: 'speed' }, el('span', {}, 'Speed'));
  [1, 1.25, 1.5, 2].forEach((r) => {
    speeds.append(el('button', { type: 'button', class: `chip${r === 1 ? ' active' : ''}`, onclick: (e) => {
      speeds.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      e.currentTarget.classList.add('active');
      setRate(r);
    } }, `${r}×`));
  });

  if (p.audioUrl) {
    podcastStatus.textContent = 'Press play to listen. You can download the episode for the bus or the gym.';
    const audio = el('audio', { controls: '', preload: 'auto', src: p.audioUrl, class: 'podcast-audio' });
    setRate = (r) => { audio.playbackRate = r; };
    podcastPlayer.append(audio, el('div', { class: 'podcast-row' }, speeds,
      el('a', { class: 'btn-secondary', href: `${p.audioUrl}?download=1`, download: 'biology-podcast.mp3' }, '⬇ Download MP3')));
  } else {
    podcastStatus.textContent = p.audioError ||
      'Playing with your browser\'s built-in voices. (Add an OpenAI API key to the server for studio-quality voices and MP3 downloads.)';
    if (!window.speechSynthesis) {
      podcastStatus.textContent = 'Your browser cannot read text aloud — read the transcript below instead.';
      return;
    }
    speech.lines = p.lines;
    speech.index = 0;
    const playBtn = el('button', { type: 'button', class: 'btn btn-inline' }, '▶ Play');
    const restartBtn = el('button', { type: 'button', class: 'btn-secondary' }, '⏮ Restart');
    playBtn.addEventListener('click', () => {
      if (speech.playing) { speech.playing = false; speechSynthesis.cancel(); playBtn.textContent = '▶ Play'; }
      else { speech.playing = true; playBtn.textContent = '⏸ Pause'; speakLine(playBtn); }
    });
    restartBtn.addEventListener('click', () => {
      stopSpeech(); speech.index = 0; speech.playing = true; playBtn.textContent = '⏸ Pause'; speakLine(playBtn);
    });
    setRate = (r) => { speech.rate = r; };
    podcastPlayer.append(el('div', { class: 'podcast-row' }, playBtn, restartBtn, speeds));
    transcriptEl.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
      stopSpeech(); speech.index = Number(li.dataset.i); speech.playing = true; playBtn.textContent = '⏸ Pause'; speakLine(playBtn);
    }));
    transcriptEl.classList.add('clickable');
  }
  podcastCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let setRate = () => {};

function pickVoices() {
  const all = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  const prefer = (re) => all.find((v) => re.test(v.name));
  const alex = prefer(/samantha|female|zira|aria|jenny|google us english/i) || all[0];
  const sam = prefer(/daniel|male|david|guy|google uk english male|alex/i) || all.find((v) => v !== alex) || alex;
  speech.voices = { Alex: alex, Sam: sam === alex ? all[1] || alex : sam };
}

function speakLine(playBtn) {
  if (!speech.playing) return;
  if (speech.index >= speech.lines.length) {
    speech.playing = false; speech.index = 0; playBtn.textContent = '▶ Play again';
    transcriptEl.querySelectorAll('.speaking').forEach((li) => li.classList.remove('speaking'));
    return;
  }
  if (!speech.voices.Alex) pickVoices();
  const line = speech.lines[speech.index];
  const u = new SpeechSynthesisUtterance(line.text);
  u.voice = speech.voices[line.speaker] || null;
  u.rate = speech.rate;
  u.pitch = line.speaker === 'Alex' ? 1.1 : 0.9;
  transcriptEl.querySelectorAll('li').forEach((li, i) => li.classList.toggle('speaking', i === speech.index));
  transcriptEl.children[speech.index]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  u.onend = () => { if (speech.playing) { speech.index += 1; speakLine(playBtn); } };
  speechSynthesis.speak(u);
}
if (window.speechSynthesis) speechSynthesis.addEventListener?.('voiceschanged', pickVoices);
