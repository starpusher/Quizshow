/* ======= Lade Daten & State ======= */
let data = null;
const state = {
  players: [],
  scores: {},                 // key -> number
  q: {},                      // questionId -> {status, attempts: [{playerId,result}], winner}
  used: new Set(),            // redundant zu q.status === resolved (für schnelles Rendern)
  settings: {}
};

const els = {
  board: document.getElementById('board'),
  playersBar: document.getElementById('playersBar'),
  modal: document.getElementById('qModal'),
  qCat: document.getElementById('qCat'),
  qPts: document.getElementById('qPts'),
  qText: document.getElementById('qText'),
  qImg: document.getElementById('qImg'),
  qAud: document.getElementById('qAud'),
  qVid: document.getElementById('qVid'),
  answer: document.getElementById('answer'),
  revealBtn: document.getElementById('revealBtn'),
  playerSelect: document.getElementById('playerSelect'),
  attemptInfo: document.getElementById('attemptInfo'),
  correctBtn: document.getElementById('correctBtn'),
  wrongBtn: document.getElementById('wrongBtn'),
  skipBtn: document.getElementById('skipBtn'),
  closeBtn: document.getElementById('closeBtn'),
  resetBtn: document.getElementById('resetBtn'),
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  importFile: document.getElementById('importFile'),
  loadBtn: document.getElementById('loadBtn'),
  loadFile: document.getElementById('loadFile')
};

let current = { col: -1, row: -1, q: null, id: null };

/* ======= Init ======= */
init();
async function init() {
  await loadContent('data/questions.json');
  loadState();
  renderPlayersBar();
  renderBoard();

  attachGlobalHandlers();
}

async function loadContent(urlOrFileText) {
  if (typeof urlOrFileText === 'string' && urlOrFileText.trim().startsWith('{')) {
    data = JSON.parse(urlOrFileText);
  } else if (typeof urlOrFileText === 'string') {
    const res = await fetch(urlOrFileText);
    data = await res.json();
  } else {
    data = urlOrFileText;
  }

  state.settings = data.settings || {};
  // Players
  state.players = (data.players || ['Spieler 1','Spieler 2']).map((name, i) => ({ id: `p${i+1}`, name }));
  // Scores init
  for (const p of state.players) if (!(p.id in state.scores)) state.scores[p.id] = 0;
}

/* ======= Render ======= */
function renderPlayersBar() {
  els.playersBar.innerHTML = '';
  for (const p of state.players) {
    const wrap = document.createElement('div');
    wrap.className = 'pill';

    const inp = document.createElement('input');
    inp.value = p.name;
    inp.addEventListener('change', () => { p.name = inp.value; saveState(); });

    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = state.scores[p.id] ?? 0;

    wrap.append(inp, score);
    els.playersBar.appendChild(wrap);

    // Keep a reference for updates
    p._scoreEl = score;
  }
}

function renderBoard() {
  const cats = data.categories;
  const cols = cats.length;
  const maxRows = Math.max(...cats.map(c => c.questions.length));

  els.board.style.gridTemplateColumns = `repeat(${cols}, minmax(140px,1fr))`;
  els.board.innerHTML = '';

  // Header
  for (const cat of cats) {
    const h = document.createElement('div');
    h.className = 'tile category';
    h.textContent = cat.title;
    els.board.appendChild(h);
  }

  // Tiles
  for (let r = 0; r < maxRows; r++) {
    for (let c = 0; c < cols; c++) {
      const q = cats[c].questions[r];
      const tile = document.createElement('button');
      tile.className = 'tile';
      tile.disabled = !q;

      if (!q) { tile.textContent = '—'; els.board.appendChild(tile); continue; }

      tile.textContent = q.points;
      const id = q.id || `${c}-${r}`;
      if (state.used.has(id) || (state.q[id]?.status === 'resolved')) tile.classList.add('used');

      tile.addEventListener('click', () => openQuestion(c, r));
      els.board.appendChild(tile);
    }
  }
}

/* ======= Modal / Flow ======= */
function openQuestion(col, row) {
  const cat = data.categories[col];
  const q = cat.questions[row];
  const id = q.id || `${col}-${row}`;
  current = { col, row, q, id };

  markBusyTile(true);

  // Set content
  els.qCat.textContent = cat.title;
  els.qPts.textContent = `${q.points} Punkte`;
  els.qText.textContent = q.text || '';
  els.answer.textContent = q.answer || '—';
  els.answer.hidden = true;

  // Media
  const base = (data.settings && data.settings.media_base) || '';
  // reset media elements
  els.qImg.hidden = true; els.qAud.hidden = true; els.qVid.hidden = true;
  if (q.image) { els.qImg.src = base + q.image; els.qImg.hidden = false; }
  if (q.audio) { els.qAud.src = base + q.audio; els.qAud.hidden = false; }
  if (q.video) { els.qVid.src = base + q.video; els.qVid.hidden = false; }

  // State for this question
  const qst = state.q[id] ||= { status: 'open', attempts: [] };
  if (qst.status === 'resolved') { // falls per Reload
    els.modal.close();
    return;
  } else {
    qst.status = qst.status === 'unused' ? 'open' : 'open';
  }

  // Player select: exclude already attempted
  populatePlayerSelect(id);

  updateAttemptInfo(id);

  els.revealBtn.onclick = () => (els.answer.hidden = false);
  els.correctBtn.onclick = () => onResult('correct');
  els.wrongBtn.onclick   = () => onResult('wrong');
  els.skipBtn.onclick    = () => resolveQuestion(null);

  els.modal.addEventListener('close', onModalCloseOnce, { once: true });
  els.modal.showModal();
}

function onModalCloseOnce() {
  markBusyTile(false);
}

function populatePlayerSelect(qid) {
  const tried = new Set((state.q[qid]?.attempts || []).map(a => a.playerId));
  els.playerSelect.innerHTML = '';
  for (const p of state.players) {
    if (tried.has(p.id)) continue; // darf nicht zweimal
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    els.playerSelect.appendChild(opt);
  }
  // Falls alle schon dran waren → leer; Host kann nur noch „Überspringen“
}

function updateAttemptInfo(qid) {
  const s = state.settings;
  const attempts = state.q[qid]?.attempts?.length || 0;
  const max = s.max_attempts ?? 99;
  const triedNames = (state.q[qid]?.attempts || []).map(a => idToName(a.playerId));
  els.attemptInfo.textContent = `Versuch ${attempts + 1}/${max}${triedNames.length ? " – schon probiert: " + triedNames.join(", ") : ""}`;
}

function onResult(result) {
  const pid = els.playerSelect.value;
  if (!pid) return; // keiner mehr übrig
  const qid = current.id;
  const q = current.q;

  // Log attempt
  const entry = { playerId: pid, result };
  state.q[qid].attempts.push(entry);

  if (result === 'correct') {
    // Punkte + und resolve
    addPoints(pid, q.points);
    state.q[qid].winner = pid;
    resolveQuestion(pid);
  } else {
    // Falsch → ggf. Minus
    const s = state.settings;
    if (s.negative_scoring) {
      const pen = s.wrong_penalty === 'question_points' ? q.points : Number(s.wrong_penalty || 0);
      addPoints(pid, -pen);
    }
    // Steal/weitere Versuche?
    const max = state.settings.max_attempts ?? 99;
    const attempts = state.q[qid].attempts.length;
    const othersLeft = state.players.some(p => !state.q[qid].attempts.find(a => a.playerId === p.id));
    if ((state.settings.allow_steal && othersLeft) && attempts < max) {
      // bleiben in "open" / Steal-Phase – Auswahl neu füllen
      populatePlayerSelect(qid);
      updateAttemptInfo(qid);
      saveState();
      return;
    } else {
      resolveQuestion(null); // keiner richtig
    }
  }
}

function resolveQuestion(winnerId) {
  const qid = current.id;
  state.q[qid].status = 'resolved';
  state.used.add(qid);
  saveState();
  renderBoard();
  els.modal.close();
}

function addPoints(pid, delta) {
  state.scores[pid] = (state.scores[pid] || 0) + Number(delta);
  const p = state.players.find(x => x.id === pid);
  if (p && p._scoreEl) p._scoreEl.textContent = state.scores[pid];
}

/* Busy outline on tile while modal open */
function markBusyTile(isBusy) {
  const { col, row } = current;
  if (col < 0) return;
  const idx = data.categories.length + (row * data.categories.length) + col; // offset by header row
  const tile = els.board.children[idx];
  if (!tile) return;
  tile.classList.toggle('busy', isBusy);
}

/* ======= Speicher ======= */
function saveState() {
  const payload = {
    players: state.players.map(p => ({ id: p.id, name: p.name })),
    scores: state.scores,
    q: state.q,
    used: Array.from(state.used),
    settings: state.settings
  };
  localStorage.setItem('quiz_state', JSON.stringify(payload));
}

function loadState() {
  const raw = localStorage.getItem('quiz_state');
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    // Namen übernehmen falls gleich viele Spieler
    if (s.players && s.players.length === (data.players || []).length) {
      state.players = s.players;
    }
    state.scores = s.scores || state.scores;
    state.q = s.q || {};
    state.used = new Set(s.used || []);
  } catch {}
}

/* ======= Helpers & Global Buttons ======= */
function idToName(pid){ return state.players.find(p => p.id === pid)?.name || pid; }

function attachGlobalHandlers() {
  // Reset
  els.resetBtn.onclick = () => {
    if (!confirm('Spielstand wirklich löschen?')) return;
    for (const p of state.players) state.scores[p.id] = 0;
    state.q = {}; state.used = new Set();
    saveState(); renderPlayersBar(); renderBoard();
  };

  // Export
  els.exportBtn.onclick = () => {
    const blob = new Blob([localStorage.getItem('quiz_state') || '{}'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `quiz_state_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
    a.click();
  };

  // Import
  els.importBtn.onclick = () => els.importFile.click();
  els.importFile.onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const text = await f.text();
    localStorage.setItem('quiz_state', text);
    loadState(); renderPlayersBar(); renderBoard();
  };

  // Neues Spiel (andere Fragen)
  els.loadBtn.onclick = () => els.loadFile.click();
  els.loadFile.onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const text = await f.text();
    await loadContent(text);
    // Reset Spielstand für neue Fragen
    state.q = {}; state.used = new Set();
    for (const p of state.players) state.scores[p.id] = 0;
    saveState();
    renderPlayersBar(); renderBoard();
  };

  // Shortcuts im Modal
  window.addEventListener('keydown', (ev) => {
    if (!els.modal.open) return;
    if (ev.key === 'a') els.answer.hidden = false;
    if (ev.key.toLowerCase() === 'r') els.correctBtn.click();
    if (ev.key.toLowerCase() === 'f') els.wrongBtn.click();
    if (ev.key.toLowerCase() === 's') els.skipBtn.click();
    // 1..8 für Spieler
    if (/^[1-8]$/.test(ev.key)) {
      const idx = Number(ev.key) - 1;
      const opt = els.playerSelect.options[idx];
      if (opt) els.playerSelect.value = opt.value;
    }
  });
}
