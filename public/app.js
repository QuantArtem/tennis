const tg = window.Telegram?.WebApp;
const inTelegram = Boolean(tg?.initData);

const LEVELS = { any: 'Любой уровень', beginner: 'Новичок', intermediate: 'Любитель', advanced: 'Продвинутый', pro: 'Профи' };
const FORMATS = { singles: 'Одиночка', doubles: 'Пара' };
const COLORS = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const state = { tab: 'games', me: null, stats: null, config: {}, now: '', lbMonth: null, lbAll: false, users: null, flashGame: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- API ----------
function authHeaders() {
  if (inTelegram) return { authorization: 'tma ' + tg.initData };
  const dev = localStorage.getItem('devUser');
  return dev ? { 'x-dev-user': encodeURIComponent(dev) } : {};
}

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Что-то пошло не так');
  return data;
}

// ---------- helpers ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2800);
}
const haptic = (type = 'success') => tg?.HapticFeedback?.notificationOccurred?.(type);

function confirmDialog(text) {
  return new Promise((resolve) => {
    if (inTelegram && tg.showConfirm) tg.showConfirm(text, resolve);
    else resolve(window.confirm(text));
  });
}

/** 'YYYY-MM-DDTHH:MM' -> Date (как локальные компоненты, без сдвига поясов) */
const toDate = (s) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13) || 0, +s.slice(14, 16) || 0);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return ymd(d); };

function dayLabel(dt) {
  const day = dt.slice(0, 10);
  const today = state.now.slice(0, 10);
  const full = toDate(dt).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
  if (day === today) return 'Сегодня · ' + full;
  if (day === addDays(today, 1)) return 'Завтра · ' + full;
  return full;
}
const shortDate = (dt) => toDate(dt).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
const monthLabel = (m) => toDate(m + '-01').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '');
const shiftMonth = (m, n) => { const d = toDate(m + '-01'); d.setMonth(d.getMonth() + n); return ymd(d).slice(0, 7); };
const plural = (n, [one, few, many]) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);

function avatar(u, cls = '') {
  const initials = u.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const safePhoto = u.photo_url && /^https:\/\//.test(u.photo_url) ? u.photo_url : null;
  const style = safePhoto
    ? `background-image:url('${encodeURI(safePhoto)}')`
    : `background:${COLORS[Math.abs(u.id) % COLORS.length]}`;
  return `<span class="ava ${cls}" style="${esc(style)}">${safePhoto ? '' : esc(initials)}</span>`;
}

function openChat(username) {
  const url = 'https://t.me/' + username;
  if (inTelegram) tg.openTelegramLink(url);
  else window.open(url, '_blank', 'noopener');
}

// ---------- Игры ----------
function gameCard(g) {
  const mine = g.players.some((p) => p.id === state.me.id);
  const owner = g.creator_id === state.me.id;
  const free = g.max_players - g.players.length;
  const meta = [FORMATS[g.format], `${g.duration_min} мин`, g.place].filter(Boolean).map(esc).join(' · ');
  const players = g.players.map((p) => `
    <button class="player" ${p.username ? `data-chat="${esc(p.username)}"` : 'disabled'}>
      ${avatar(p)}
      <span class="grow"><span class="name">${esc(p.name)}${p.id === g.creator_id ? ' <span class="meta">· организатор</span>' : ''}</span></span>
      ${p.username ? `<span class="nick">@${esc(p.username)}</span>` : '<span class="nick none">без ника</span>'}
    </button>`).join('');
  const slots = Array.from({ length: free }, () => '<div class="player free"><span class="ava slot">+</span>Свободное место</div>').join('');

  let action = '';
  if (owner) action = `<button class="btn soft" data-share="${g.id}">Позвать игроков</button><button class="btn danger" data-cancel="${g.id}">Отменить</button>`;
  else if (mine) action = `<button class="btn soft" data-share="${g.id}">Позвать ещё</button><button class="btn danger" data-leave="${g.id}">Выйти</button>`;
  else if (free > 0) action = `<button class="btn" data-join="${g.id}">Вступить в игру</button><button class="btn ghost" data-share="${g.id}">Поделиться</button>`;
  else action = `<button class="btn" disabled>Состав собран</button>`;

  return `
  <article class="card ${state.flashGame === g.id ? 'flash' : ''}" id="game-${g.id}">
    <div class="row">
      <div class="time">${esc(g.starts_at.slice(11))}</div>
      <div class="grow meta">${meta}</div>
      <span class="badge ${free ? '' : 'full'}">${free ? `${free} ${plural(free, ['место', 'места', 'мест'])}` : 'Полный состав'}</span>
    </div>
    ${g.level !== 'any' ? `<div class="meta" style="margin-top:4px">Уровень: ${esc(LEVELS[g.level])}</div>` : ''}
    ${g.comment ? `<p class="comment">${esc(g.comment)}</p>` : ''}
    <div class="players">${players}${slots}</div>
    <div class="actions">${action}</div>
  </article>`;
}

let gamesCache = { games: [], to_report: [], slots: [] };

async function renderGames() {
  gamesCache = await api('GET', '/games');
  state.now = gamesCache.now;
  const { games } = gamesCache;
  let html = '';
  if (!games.length) {
    html = `<div class="empty"><span class="big">🎾</span><b>Пока никто не собирает игру</b>Создайте заявку — и другие участники клуба смогут к вам присоединиться.</div>`;
  } else {
    let day = '';
    for (const g of games) {
      if (g.starts_at.slice(0, 10) !== day) {
        day = g.starts_at.slice(0, 10);
        html += `<div class="day">${esc(dayLabel(g.starts_at))}</div>`;
      }
      html += gameCard(g);
    }
  }
  view.innerHTML = html + `<button class="fab" data-new-game>＋ Собрать игру</button>`;
  if (state.flashGame) {
    document.getElementById('game-' + state.flashGame)?.scrollIntoView({ block: 'center' });
    state.flashGame = null;
  }
}

function openGameForm() {
  const today = state.now.slice(0, 10);
  const slots = gamesCache.slots || [];
  openSheet(`
    <h2>Собрать игру</h2>
    ${slots.length ? `<div class="field" style="margin-bottom:5px"><span>Свободные корты клуба</span></div>
      <div class="chips">${slots.slice(0, 30).map((s, i) => `<button type="button" class="chip" data-slot="${i}"><b>${esc(shortDate(s.starts_at))}, ${esc(s.starts_at.slice(11))}</b>${esc(s.court)}${s.price ? ' · ' + esc(s.price) : ''}</button>`).join('')}</div>` : ''}
    <form id="f">
      <div class="two">
        <label class="field"><span>Дата</span><input type="date" name="date" required min="${today}" value="${today}"></label>
        <label class="field"><span>Время</span><input type="time" name="time" required value="19:00" step="300"></label>
      </div>
      <div class="field"><span>Формат</span>
        <div class="seg" data-seg="format" style="margin:0"><button type="button" class="on" data-v="singles">Одиночка · 2</button><button type="button" data-v="doubles">Пара · 4</button></div>
      </div>
      <div class="two">
        <label class="field"><span>Длительность</span><select name="duration_min"><option value="60">1 час</option><option value="90">1,5 часа</option><option value="120">2 часа</option></select></label>
        <label class="field"><span>Уровень</span><select name="level">${Object.entries(LEVELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Где играем</span><input name="place" maxlength="80" placeholder="Корт 3, грунт"></label>
      <label class="field"><span>Комментарий</span><textarea name="comment" maxlength="300" placeholder="Мячи есть, корт оплачен пополам…"></textarea></label>
      <button class="btn">Опубликовать заявку</button>
    </form>`);
  const form = $('#f');
  let format = 'singles';
  bindSeg(form, (v) => (format = v));
  $('.sheet').querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', () => {
    const s = slots[+b.dataset.slot];
    form.date.value = s.starts_at.slice(0, 10);
    form.time.value = s.starts_at.slice(11);
    form.place.value = s.court;
    const mins = (toDate(s.ends_at) - toDate(s.starts_at)) / 60000;
    if ([60, 90, 120].includes(mins)) form.duration_min.value = mins;
  }));
  form.addEventListener('submit', (e) => submit(e, async () => {
    await api('POST', '/games', {
      starts_at: `${form.date.value}T${form.time.value.slice(0, 5)}`,
      format,
      duration_min: +form.duration_min.value,
      level: form.level.value,
      place: form.place.value,
      comment: form.comment.value,
    });
    toast('Заявка опубликована');
  }));
}

function shareGame(id) {
  const g = gamesCache.games.find((x) => x.id === id);
  if (!g) return;
  const text = `🎾 Ищу ${g.format === 'doubles' ? 'игроков на пару' : 'партнёра'}: ${shortDate(g.starts_at)}, ${g.starts_at.slice(11)}${g.place ? ', ' + g.place : ''}. Присоединяйся!`;
  const link = state.config.app_link ? `${state.config.app_link}?startapp=game_${id}` : location.origin;
  if (inTelegram) tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  else navigator.clipboard?.writeText(`${text}\n${link}`).then(() => toast('Текст приглашения скопирован'), () => toast(link));
}

// ---------- Сыгранные матчи ----------
function matchCard(m) {
  const side = (n) => {
    const ps = m.players.filter((p) => p.side === n);
    return `<div class="side ${m.winner === n ? 'win' : ''}">${ps.map((p) => `<span class="p">${esc(p.name)}</span>`).join('')}</div>`;
  };
  const mine = m.players.some((p) => p.id === state.me.id);
  return `
  <article class="card">
    <div class="row meta"><span class="grow">${esc(shortDate(m.played_at))}, ${esc(m.played_at.slice(11))} · ${FORMATS[m.format]}</span>
      ${mine ? `<button class="btn danger" style="min-height:28px;padding:0 4px" data-del-match="${m.id}">Удалить</button>` : ''}</div>
    <div class="vs">${side(1)}<div class="score ${m.score ? '' : 'none'}">${m.score ? esc(m.score) : 'vs'}</div>${side(2)}</div>
  </article>`;
}

async function renderMatches() {
  const [games, { matches }] = await Promise.all([api('GET', '/games'), api('GET', '/matches')]);
  gamesCache = games;
  state.now = games.now;
  let html = '';
  if (games.to_report.length) {
    html += `<div class="day">Ждут отметки</div>` + games.to_report.map((g) => `
      <article class="card">
        <div class="row"><div class="grow"><b>${esc(shortDate(g.starts_at))}, ${esc(g.starts_at.slice(11))}</b>
          <div class="meta">${g.players.map((p) => esc(p.name)).join(', ')}</div></div></div>
        <div class="actions" style="margin-top:10px"><button class="btn" data-report="${g.id}">Мы сыграли</button></div>
      </article>`).join('');
  }
  if (matches.length) html += `<div class="day">Последние матчи клуба</div>` + matches.map(matchCard).join('');
  else if (!games.to_report.length) html += `<div class="empty"><span class="big">✅</span><b>Матчей пока нет</b>Сыграли? Отметьте матч — он попадёт в рейтинг клуба.</div>`;
  view.innerHTML = html + `<button class="fab" data-new-match>＋ Отметить матч</button>`;
}

async function openMatchForm(game) {
  state.users ??= (await api('GET', '/users')).users;
  if (game && game.players.some((p) => !state.users.find((u) => u.id === p.id))) state.users = (await api('GET', '/users')).users;
  const others = state.users.filter((u) => u.id !== state.me.id);
  if (!others.length) return toast('В клубе пока нет других игроков — позовите друзей в приложение');

  let format = game?.format ?? 'singles';
  if (game && game.players.length < 4) format = 'singles';
  const preset = game ? game.players.filter((p) => p.id !== state.me.id).map((p) => p.id) : [];
  const when = game?.starts_at ?? state.now;
  const options = (sel) => `<option value="">— выбрать —</option>` + others.map((u) =>
    `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name)}${u.username ? ' @' + esc(u.username) : ''}</option>`).join('');

  openSheet(`
    <h2>Отметить матч</h2>
    <form id="f">
      <div class="two">
        <label class="field"><span>Дата</span><input type="date" name="date" required max="${state.now.slice(0, 10)}" value="${when.slice(0, 10)}"></label>
        <label class="field"><span>Время</span><input type="time" name="time" required value="${when.slice(11)}"></label>
      </div>
      <div class="seg" data-seg="format"><button type="button" data-v="singles">Одиночка</button><button type="button" data-v="doubles">Пара</button></div>
      <div id="teams"></div>
      <div class="two">
        <label class="field"><span>Счёт (необязательно)</span><input name="score" maxlength="40" placeholder="6:4 3:6 10:7" autocomplete="off"></label>
        <label class="field"><span>Кто победил</span><select name="winner"><option value="">Не указывать</option><option value="1">Моя команда</option><option value="2">Соперники</option></select></label>
      </div>
      <button class="btn">Сохранить матч</button>
    </form>`);
  const form = $('#f');
  const teams = $('#teams');
  const drawTeams = () => {
    const dbl = format === 'doubles';
    form.winner.options[1].textContent = dbl ? 'Моя команда' : 'Я';
    form.winner.options[2].textContent = dbl ? 'Соперники' : 'Соперник';
    teams.innerHTML = dbl
      ? `<div class="team">Моя команда</div>
         <label class="field"><span>Напарник</span><select name="p1" required>${options(preset[0])}</select></label>
         <div class="team">Соперники</div>
         <div class="two"><label class="field"><select name="p2" required aria-label="Соперник 1">${options(preset[1])}</select></label>
         <label class="field"><select name="p3" required aria-label="Соперник 2">${options(preset[2])}</select></label></div>`
      : `<label class="field"><span>Соперник</span><select name="p2" required>${options(preset[0])}</select></label>`;
  };
  bindSeg(form, (v) => { format = v; drawTeams(); }, format);
  drawTeams();
  form.addEventListener('submit', (e) => submit(e, async () => {
    const dbl = format === 'doubles';
    await api('POST', '/matches', {
      game_id: game?.id,
      played_at: `${form.date.value}T${form.time.value.slice(0, 5)}`,
      format,
      team1: dbl ? [state.me.id, +form.p1.value] : [state.me.id],
      team2: dbl ? [+form.p2.value, +form.p3.value] : [+form.p2.value],
      score: form.score.value,
      winner: form.winner.value ? +form.winner.value : null,
    });
    toast('Матч записан — он уже в рейтинге');
  }));
}

// ---------- Рейтинг ----------
async function renderTop() {
  const current = state.now.slice(0, 7);
  state.lbMonth ??= current;
  const { leaderboard } = await api('GET', '/leaderboard?month=' + (state.lbAll ? 'all' : state.lbMonth));
  const medals = ['🥇', '🥈', '🥉'];
  const rows = leaderboard.map((r) => `
    <div class="row ${r.id === state.me.id ? 'me' : ''}">
      <span class="rank">${medals[r.rank - 1] ?? r.rank}</span>
      ${avatar(r)}
      <span class="grow"><span class="name" style="font-weight:600">${esc(r.name)}</span>
        <div class="meta">${r.days} ${plural(r.days, ['игровой день', 'игровых дня', 'игровых дней'])}</div></span>
      <span class="num"><b>${r.games}</b><small>${plural(r.games, ['матч', 'матча', 'матчей'])} · ${r.wins} поб.</small></span>
    </div>`).join('');
  view.innerHTML = `
    <div class="seg" data-seg="period"><button data-v="month" class="${state.lbAll ? '' : 'on'}">По месяцам</button><button data-v="all" class="${state.lbAll ? 'on' : ''}">За всё время</button></div>
    ${state.lbAll ? '' : `<div class="switch">
      <button data-month="-1" aria-label="Предыдущий месяц">‹</button>
      <span class="label">${esc(monthLabel(state.lbMonth))}</span>
      <button data-month="1" aria-label="Следующий месяц" ${state.lbMonth >= current ? 'disabled' : ''}>›</button></div>`}
    ${leaderboard.length ? `<div class="card lb">${rows}</div>`
      : `<div class="empty"><span class="big">🏆</span><b>Пока пусто</b>${state.lbAll ? 'Отметьте первый матч' : 'В этом месяце ещё никто не отметил матч'} — и рейтинг оживёт.</div>`}`;
  bindSeg(view, (v) => { state.lbAll = v === 'all'; render(); });
}

// ---------- Профиль ----------
async function renderMe() {
  const { user, stats } = await api('GET', '/me');
  state.me = user;
  view.innerHTML = `
    <div class="card"><div class="row">${avatar(user)}
      <div class="grow"><b>${esc(user.name)}</b><div class="meta">${user.username ? '@' + esc(user.username) : 'Ник в Telegram не задан'}</div></div></div></div>
    ${user.username ? '' : `<div class="card meta">Задайте имя пользователя в настройках Telegram — тогда участники клуба смогут написать вам одним касанием.</div>`}
    <div class="stats">
      <div class="stat"><b>${stats.month}</b><span>в этом месяце</span></div>
      <div class="stat"><b>${stats.total}</b><span>всего матчей</span></div>
      <div class="stat"><b>${stats.wins}</b><span>побед</span></div>
    </div>
    <div class="card"><label class="field" style="margin:0"><span>Мой уровень игры</span>
      <select id="level">${Object.entries(LEVELS).map(([k, v]) => `<option value="${k}" ${k === user.level ? 'selected' : ''}>${k === 'any' ? 'Не указан' : v}</option>`).join('')}</select></label></div>
    ${state.config.dev_mode && !inTelegram ? `<div class="card"><div class="meta" style="margin-bottom:8px">Демо-режим: сервер запущен без BOT_TOKEN</div><button class="btn soft" data-dev-switch>Сменить демо-пользователя</button></div>` : ''}`;
  $('#level').addEventListener('change', async (e) => {
    try { await api('PATCH', '/me', { level: e.target.value }); toast('Сохранено'); } catch (err) { toast(err.message); }
  });
}

// ---------- Общие вещи ----------
function bindSeg(root, onChange, initial) {
  const seg = $('.seg', root);
  if (!seg) return;
  if (initial) seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === initial));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.classList.contains('on')) return;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    onChange(b.dataset.v);
  });
}

function openSheet(html) {
  const wrap = $('#sheet');
  $('.sheet', wrap).innerHTML = html;
  wrap.hidden = false;
  if (inTelegram) { tg.BackButton?.show(); }
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet .sheet').innerHTML = '';
  tg?.BackButton?.hide();
}
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
tg?.BackButton?.onClick(closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

async function submit(e, fn) {
  e.preventDefault();
  const btn = e.target.querySelector('button.btn:not([type=button])');
  btn.disabled = true;
  try {
    await fn();
    haptic();
    closeSheet();
    await render();
  } catch (err) {
    haptic('error');
    toast(err.message);
    btn.disabled = false;
  }
}

async function act(fn, okMsg) {
  try {
    await fn();
    haptic();
    if (okMsg) toast(okMsg);
  } catch (err) {
    haptic('error');
    toast(err.message);
  }
  await render();
}

view.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  if (d.chat) return openChat(d.chat);
  if ('newGame' in d) return openGameForm();
  if ('newMatch' in d) return openMatchForm().catch((err) => toast(err.message));
  if (d.join) return act(() => api('POST', `/games/${d.join}/join`), 'Вы в игре! Напишите организатору, чтобы договориться');
  if (d.leave) return (await confirmDialog('Выйти из игры?')) && act(() => api('POST', `/games/${d.leave}/leave`));
  if (d.cancel) return (await confirmDialog('Отменить игру? Участники получат уведомление.')) && act(() => api('POST', `/games/${d.cancel}/cancel`), 'Игра отменена');
  if (d.share) return shareGame(+d.share);
  if (d.report) return openMatchForm(gamesCache.to_report.find((g) => g.id === +d.report)).catch((err) => toast(err.message));
  if (d.delMatch) return (await confirmDialog('Удалить запись о матче? Она пропадёт из рейтинга у всех участников.')) && act(() => api('DELETE', `/matches/${d.delMatch}`), 'Матч удалён');
  if (d.month) { state.lbMonth = shiftMonth(state.lbMonth, +d.month); return render(); }
  if ('devSwitch' in d) { localStorage.removeItem('devUser'); location.reload(); }
});

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.tab = b.dataset.tab;
  tg?.HapticFeedback?.selectionChanged?.();
  render();
});

const RENDER = { games: renderGames, matches: renderMatches, top: renderTop, me: renderMe };
let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  try {
    await RENDER[state.tab]();
  } catch (err) {
    if (seq === renderSeq) view.innerHTML = `<div class="empty"><span class="big">😕</span><b>Не удалось загрузить</b>${esc(err.message)}<br><br><button class="btn soft" onclick="location.reload()">Обновить</button></div>`;
  }
  window.scrollTo(0, 0);
}

function devLogin() {
  view.innerHTML = `
    <div class="card"><h2 style="margin:0 0 6px;font-size:18px">Демо-вход</h2>
      <p class="meta" style="margin:0 0 12px">Приложение открыто вне Telegram, а сервер запущен без BOT_TOKEN. Представьтесь, чтобы попробовать.</p>
      <form id="dev"><label class="field"><span>Имя</span><input name="name" required maxlength="40" value="Игрок"></label>
      <label class="field"><span>Ник в Telegram</span><input name="username" maxlength="32" placeholder="без @" pattern="[A-Za-z0-9_]*"></label>
      <button class="btn">Войти</button></form></div>`;
  $('#dev').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    localStorage.setItem('devUser', JSON.stringify({ id: Math.floor(Math.random() * 1e9) + 1000, first_name: f.name.value.trim(), username: f.username.value.trim() || undefined }));
    location.reload();
  });
}

async function init() {
  tg?.ready();
  tg?.expand();
  try {
    state.config = await api('GET', '/config');
    state.now = state.config.now;
    $('#title').textContent = state.config.club_name;
    document.title = state.config.club_name;
    if (!inTelegram && !localStorage.getItem('devUser')) {
      $('#tabs').hidden = true;
      if (state.config.dev_mode) return devLogin();
      view.innerHTML = `<div class="empty"><span class="big">🎾</span><b>Откройте в Telegram</b>Это приложение работает внутри Telegram — запустите его через бота клуба.</div>`;
      return;
    }
    state.me = (await api('GET', '/me')).user;
    const start = tg?.initDataUnsafe?.start_param?.match(/^game_(\d+)$/);
    if (start) state.flashGame = +start[1];
    await render();
  } catch (err) {
    $('#tabs').hidden = true;
    view.innerHTML = `<div class="empty"><span class="big">😕</span><b>Не удалось войти</b>${esc(err.message)}</div>`;
  }
}
init();
