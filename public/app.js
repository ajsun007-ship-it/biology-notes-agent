const MAX_FILES = 5;
const form = document.getElementById('notes-form');
const fileInput = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const fileList = document.getElementById('file-list');
const notesText = document.getElementById('notes-text');
const submitBtn = document.getElementById('submit-btn');
const formError = document.getElementById('form-error');
const outputCard = document.getElementById('output-card');
const outputEl = document.getElementById('output');

let selectedFiles = [];
let lastOutput = '';
const sessionId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());

// ---------- File selection ----------
function addFiles(files) {
  for (const f of files) {
    if (selectedFiles.length >= MAX_FILES) { showError(`You can upload up to ${MAX_FILES} files.`); break; }
    if (!selectedFiles.some((s) => s.name === f.name && s.size === f.size)) selectedFiles.push(f);
  }
  renderFileList();
}

function renderFileList() {
  fileList.innerHTML = '';
  selectedFiles.forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="name"></span><span class="size">${formatSize(f.size)}</span>
      <button type="button" aria-label="Remove file">✕</button>`;
    li.querySelector('.name').textContent = f.name;
    li.querySelector('button').onclick = () => { selectedFiles.splice(i, 1); renderFileList(); };
    fileList.appendChild(li);
  });
}

const formatSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

// ---------- Submit ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  if (selectedFiles.length === 0 && !notesText.value.trim()) {
    showError('Please upload a notes file or paste some notes first.');
    return;
  }

  const data = new FormData();
  selectedFiles.forEach((f) => data.append('files', f));
  data.append('notes', notesText.value);
  data.append('task', form.querySelector('input[name="task"]:checked').value);
  data.append('question', document.getElementById('question').value);
  data.append('sessionId', sessionId);

  setLoading(true);
  outputCard.hidden = false;
  outputEl.className = 'markdown loading';
  outputEl.textContent = 'The agent is reading your notes…';

  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: data });
    const json = await res.json().catch(() => ({ error: 'Invalid response from server.' }));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    renderOutput(json.output || '_The agent returned an empty response._');
  } catch (err) {
    outputCard.hidden = true;
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

function renderOutput(text) {
  lastOutput = text;
  outputEl.className = 'markdown';
  if (window.marked && window.DOMPurify) {
    outputEl.innerHTML = DOMPurify.sanitize(marked.parse(text));
  } else {
    outputEl.textContent = text; // CDN unavailable: plain text fallback
    outputEl.style.whiteSpace = 'pre-wrap';
  }
  outputCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Output actions ----------
document.getElementById('copy-btn').addEventListener('click', async (e) => {
  try { await navigator.clipboard.writeText(lastOutput); flash(e.target, 'Copied!'); }
  catch { flash(e.target, 'Copy failed'); }
});
document.getElementById('download-btn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lastOutput], { type: 'text/markdown' }));
  a.download = 'biology-notes-agent-output.md';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- Helpers ----------
function setLoading(on) {
  submitBtn.disabled = on;
  submitBtn.classList.toggle('loading', on);
  submitBtn.querySelector('.btn-label').textContent = on ? 'Agent is working…' : 'Send to agent';
}
function showError(msg) { formError.textContent = msg; formError.hidden = false; }
function hideError() { formError.hidden = true; }
function flash(btn, msg) { const t = btn.textContent; btn.textContent = msg; setTimeout(() => (btn.textContent = t), 1500); }
