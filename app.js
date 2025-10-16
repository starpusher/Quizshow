/* ======= Rollen & Broadcast ======= */
const params = new URLSearchParams(location.search);
const role = params.get('view') || 'host';  // 'host' | 'screen'
if (role === 'screen') document.body.classList.add('audience');

const chan = new BroadcastChannel('quiz-show');
function send(type, payload={}) { if (role === 'host') chan.postMessage({ type, payload }); }
chan.onmessage = ({ data }) => handleMsg(data);

function handleMsg(msg) {
  const { type, payload } = msg || {};
  if (role !== 'screen') return;
  switch (type) {
    case 'SHOW_Q':
      showForAudience(payload);
      break;
    case 'REVEAL_ANSWER':
      els.answer.hidden = false;
      break;
    case 'RESOLVE_Q':
      state.q[payload.id] = { status: 'resolved', attempts: [] };
      state.used.add(payload.id);
      renderBoard();
      if (els.modal.open) els.modal.close();
      break;
    case 'SYNC_STATE':
      // kompletter Stand vom Host
      data = payload.data;
      state.players = payload.state.players;
      state.scores = payload.state.scores;
      state.q = payload.state.q || {};
      state.used = new Set(payload.state.used || []);
      state.settings = payload.state.settings || {};
      renderPlayersBar(true);  // Publikum: nur lesen
      renderBoard();
      break;
  }
}
// Publikum bittet beim Start um Sync
if (role === 'screen') chan.postMessage({ type: 'SCREEN_READY' });
else chan.onmessage = ({ data }) => {
  if (data?.type === 'SCREEN_READY') sendSync();
};

/* ======= DOM-Refs ======= */
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
  loadFile: document.getElementById('loadFile'),
  presentBtn: document.getElementById('presentBtn')
};

/* ======= Daten & State ======= */
let data = null;
const state = {
  players: [],
  scores: {},
  q: {},
  used: new Set(),
  settings: {}
};
let current = { col: -1, row: -1, q: null, id: null };

/* ======= Init ======= */
init();
async function init() {
  await loadContent('data/questions.json');
  loadState();
  renderPlayersBar(role === 'screen');
  renderBoard();
  attachGlobalHandlers();
  if (role === 'host') sendSync();
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
  state.players = (data.players || ['Spieler 1','Spieler 2']).map((name, i) => ({ id: `p${i+1}`, name }));
  for (const p of state.players) if (!(p.id in state.scores)) state.scores[p.id] = 0;
}

/* ======= Render ======= */
function renderPlayersBar(readOnly=false) {
  els.playersBar.innerHTML = '';
  for (const p of state.players) {
    const wrap = document.createElement('div');
    wrap.className = 'pill';

    const inp = document.createElement('input');
    inp.value = p.name;
    inp.disabled = readOnly || role === 'screen';
    inp.addEventListener('change', () => { p.name = inp.value; saveState(); sendSync(); });

    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = state.scores[p.id] ?? 0;

    wrap.append(inp, score);
    els.playersBar.appendChild(wrap);

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

      if (role === 'host') tile.addEventListener('click', () => openQuestion(c, r)); // Publikum klickt nicht
      els.board.appendChild(tile);
    }
  }
}

/* ======= Modal / Host-Flow ======= */
function openQuestion(col, row) {
  const cat = data.categories[col];
  const q = cat.questions[row];
  const id = q.id || `${col}-${row}`;
  current = { col, row, q, id };

  markBusyTile(true);

  // Inhalt
  els.qCat.textContent = cat.title;
  els.qPts.textContent = `${q.points} Punkte`;
  els.qText.textContent = q.text || '';
  els.answer.textContent = q.answer || '—';
  els.answer.hidden = true;
  setMedia(q);

  // State
  const qst = state.q[id] ||= { status: 'open', attempts: [] };
  if (qst.status === 'resolved') { els.modal.close(); return; }
  populatePlayerSelect(id);
  updateAttemptInfo(id);

  // Buttons
  els.revealBtn.onclick = () => { els.answer.hidden = false; send('REVEAL_ANSWER'); };
  els.correctBtn.onclick = () => onResult('correct');
  els.wrongBtn.onclick   = () => onResult('wrong');
  els.skipBtn.onclick    = () => resolveQuestion(null);

  els.modal.addEventListener('close', onModalCloseOnce, { once: true });
  els.modal.showModal();

  // Publikum anzeigen lassen
  send('SHOW_Q', { col, row, id, q: {
    cat: cat.title, points: q.points, text: q.text, answer: q.answer,
    image: q.image, audio: q.audio, video: q.video
  }});
}

function onModalCloseOnce(){ markBusyTile(false); }

function populatePlayerSelect(qid) {
  const tried = new Set((state.q[qid]?.attempts || []).map(a => a.playerId));
  els.playerSelect.innerHTML = '';
  for (const p of state.players) {
    if (tried.has(p.id)) continue;
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    els.playerSelect.appendChild(opt);
  }
}

function updateAttemptInfo(qid) {
  const attempts = state.q[qid]?.attempts?.length || 0;
  const max = state.settings.max_attempts ?? 99;
  const triedNames = (state.q[qid]?.attempts || []).map(a => idToName(a.playerId));
  els.attemptInfo.textContent = `Versuch ${attempts + 1}/${max}${triedNames.length ? " – schon probiert: " + triedNames.join(", ") : ""}`;
}

function onResult(result) {
  const pid = els.playerSelect.value;
  if (!pid) return;
  const qid = current.id;
  const q = current.q;

  state.q[qid].attempts.push({ playerId: pid, result });

  if (result === 'correct') {
    addPoints(pid, q.points);
    state.q[qid].winner = pid;
    resolveQuestion(pid);
  } else {
    if (state.settings.negative_scoring) {
      const pen = state.settings.wrong_penalty === 'question_points' ? q.points : Number(state.settings.wrong_penalty || 0);
      addPoints(pid, -pen);
    }
    const max = state.settings.max_attempts ?? 99;
    const attempts = state.q[qid].attempts.length;
    const othersLeft = state.players.some(p => !state.q[qid].attempts.find(a => a.playerId === p.id));
    if ((state.settings.allow_steal && othersLeft) && attempts < max) {
      populatePlayerSelect(qid);
      updateAttemptInfo(qid);
      saveState(); sendSync();
      return;
    } else {
      resolveQuestion(null);
    }
  }
}

function resolveQuestion() {
  const qid = current.id;
  state.q[qid].status = 'resolved';
  state.used.add(qid);
  saveState(); sendSync();
  renderBoard();
  els.modal.close();
  send('RESOLVE_Q', { id: qid });
}

/* ======= Publikum-Ansicht ======= */
function showForAudience(payload){
  const { id, q } = payload;
  current = { id, q };
  els.qCat.textContent = q.cat;
  els.qPts.textContent = `${q.points} Punkte`;
  els.qText.textContent = q.text || '';
  els.answer.textContent = q.answer || '—';
  els.answer.hidden = true;
  setMedia(q);
  els.modal.showModal();
}

/* ======= Gemeinsames ======= */
function setMedia(q){
  const base = (data.settings && data.settings.media_base) || '';
  // Reset
  els.qImg.hidden = els.qAud.hidden = els.qVid.hidden = true;
  if (q.image){ els.qImg.src = base + q.image; els.qImg.hidden = false; }
  if (q.audio){ els.qAud.src = base + q.audio; els.qAud.hidden = false; }
  if (q.video){ els.qVid.src = base + q.video; els.qVid.hidden = false; }
}

function addPoints(pid, delta) {
  state.scores[pid] = (state.scores[pid] || 0) + Number(delta);
  const p = state.players.find(x => x.id === pid);
  if (p && p._scoreEl) p._scoreEl.textContent = state.scores[pid];
}

function markBusyTile(isBusy) {
  const { col, row } = current;
  if (col < 0) return;
  const idx = data.categories.length + (row * data.categories.length) + col;
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
    if (s.players && s.players.length === (data.players || []).length) {
      state.players = s.players;
    }
    state.scores = s.scores || state.scores;
    state.q = s.q || {};
    state.used = new Set(s.used || []);
  } catch {}
}

/* ======= Helper & Global ======= */
function idToName(pid){ return state.players.find(p => p.id === pid)?.name || pid; }
function sendSync(){
  send('SYNC_STATE', { state: {
    players: state.players, scores: state.scores, q: state.q,
    used: Array.from(state.used), settings: state.settings
  }, data });
}

function attachGlobalHandlers() {
  if (els.presentBtn && role === 'host') {
    els.presentBtn.onclick = () => window.open(`${location.pathname}?view=screen`, 'quiz-screen', 'width=1280,height=800');
  }

  els.resetBtn.onclick = () => {
    if (role !== 'host') return;
    if (!confirm('Spielstand wirklich löschen?')) return;
    for (const p of state.players) state.scores[p.id] = 0;
    state.q = {}; state.used = new Set();
    saveState(); renderPlayersBar(); renderBoard(); sendSync();
  };

  els.exportBtn.onclick = () => {
    const blob = new Blob([localStorage.getItem('quiz_state') || '{}'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `quiz_state_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
    a.click();
  };

  els.importBtn.onclick = () => els.importFile.click();
  els.importFile.onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const text = await f.text();
    localStorage.setItem('quiz_state', text);
    loadState(); renderPlayersBar(); renderBoard(); sendSync();
  };

  els.loadBtn.onclick = () => els.loadFile.click();
  els.loadFile.onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const text = await f.text();
    await loadContent(text);
    state.q = {}; state.used = new Set();
    for (const p of state.players) state.scores[p.id] = 0;
    saveState(); renderPlayersBar(); renderBoard(); sendSync();
  };

  // Shortcuts nur für Host & nur im Modal
  window.addEventListener('keydown', (ev) => {
    if (role !== 'host' || !els.modal.open) return;
    if (ev.key === 'a') els.answer.hidden = false, send('REVEAL_ANSWER');
    if (ev.key.toLowerCase() === 'r') els.correctBtn.click();
    if (ev.key.toLowerCase() === 'f') els.wrongBtn.click();
    if (ev.key.toLowerCase() === 's') els.skipBtn.click();
    if (/^[1-8]$/.test(ev.key)) {
      const idx = Number(ev.key) - 1;
      const opt = els.playerSelect.options[idx];
      if (opt) els.playerSelect.value = opt.value;
    }
  });
}
