import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { verifyInitData, safeEqual } from './auth.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const LEVELS = ['any', 'beginner', 'intermediate', 'advanced', 'pro'];
const FORMATS = { singles: 2, doubles: 4 };
const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

function validDateTime(s) {
  if (typeof s !== 'string' || !DT_RE.test(s)) return false;
  const d = new Date(s + ':00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 16) === s;
}

function text(v, max) {
  if (v == null) return '';
  if (typeof v !== 'string') throw bad('Некорректные данные');
  return v.trim().slice(0, max);
}

export function createApp(opts = {}) {
  const {
    dbPath = ':memory:',
    botToken = '',
    clubApiKey = '',
    appLink = '',
    clubName = 'Теннисный клуб',
    clubTz = 'Europe/Moscow',
    now = () => new Date(),
  } = opts;
  const db = openDb(dbPath);
  const devMode = !botToken;

  /** Текущее локальное время клуба, 'YYYY-MM-DDTHH:MM' */
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: clubTz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const nowLocal = (shiftMin = 0) => fmt.format(new Date(now().getTime() + shiftMin * 60000)).replace(' ', 'T');

  // ---------- Telegram-уведомления (не блокируют запрос, ошибки игнорируются) ----------
  function notify(userIds, message) {
    if (!botToken) return;
    for (const chat_id of new Set(userIds)) {
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id, text: message, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
  }
  const who = (u) => (u.username ? `${u.name} (@${u.username})` : u.name);
  const when = (dt) => {
    const [d, t] = dt.split('T');
    const [, m, day] = d.split('-');
    return `${day}.${m} в ${t}`;
  };

  // ---------- Пользователи ----------
  const USER_COLS = 'u.id, u.username, u.name, u.photo_url, u.level';

  function upsertUser(tg) {
    const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ').slice(0, 64) || tg.username || `Игрок ${tg.id}`;
    db.prepare(`
      INSERT INTO users (id, username, name, photo_url) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET username = excluded.username, name = excluded.name, photo_url = excluded.photo_url
    `).run(tg.id, tg.username || null, name, tg.photo_url || null);
    return db.prepare(`SELECT ${USER_COLS} FROM users u WHERE id = ?`).get(tg.id);
  }

  function authUser(req) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('tma ')) {
      const tg = verifyInitData(auth.slice(4), botToken, now().getTime() / 1000);
      if (tg) return upsertUser(tg);
    }
    if (devMode && req.headers['x-dev-user']) {
      try {
        const tg = JSON.parse(decodeURIComponent(req.headers['x-dev-user']));
        if (Number.isSafeInteger(tg.id)) return upsertUser(tg);
      } catch { /* ignore */ }
    }
    throw new HttpError(401, 'Откройте приложение через Telegram');
  }

  function authClub(req) {
    if (!clubApiKey) throw new HttpError(503, 'Club API is disabled: CLUB_API_KEY is not set');
    const key = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!key || !safeEqual(key, clubApiKey)) throw new HttpError(401, 'Invalid API key');
  }

  // ---------- Запросы ----------
  function withPlayers(rows, table, fk) {
    if (!rows.length) return rows;
    const ids = rows.map((r) => r.id);
    const extra = table === 'match_players' ? ', p.side' : '';
    const order = table === 'match_players' ? 'p.side, u.name' : 'p.joined_at, p.rowid';
    const players = db.prepare(
      `SELECT p.${fk} AS pid, ${USER_COLS}${extra} FROM ${table} p JOIN users u ON u.id = p.user_id
       WHERE p.${fk} IN (${ids.map(() => '?').join(',')}) ORDER BY ${order}`,
    ).all(...ids);
    const by = new Map(rows.map((r) => [r.id, { ...r, players: [] }]));
    for (const { pid, ...p } of players) by.get(pid).players.push(p);
    return [...by.values()];
  }

  const getGame = (id) => {
    const g = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!g) throw new HttpError(404, 'Игра не найдена');
    return withPlayers([g], 'game_players', 'game_id')[0];
  };

  const upcomingGames = () => withPlayers(
    // игра остаётся в списке ещё час после начала
    db.prepare(`SELECT * FROM games WHERE status = 'open' AND starts_at >= ? ORDER BY starts_at, id LIMIT 200`).all(nowLocal(-60)),
    'game_players', 'game_id',
  );

  function listMatches({ month, userId, limit = 100 }) {
    const where = [];
    const args = [];
    if (month) { where.push('m.played_at LIKE ?'); args.push(month + '%'); }
    if (userId) { where.push('m.id IN (SELECT match_id FROM match_players WHERE user_id = ?)'); args.push(userId); }
    const rows = db.prepare(
      `SELECT m.id, m.game_id, m.played_at, m.format, m.score, m.winner, m.created_by FROM matches m
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.played_at DESC, m.id DESC LIMIT ?`,
    ).all(...args, limit);
    return withPlayers(rows, 'match_players', 'match_id');
  }

  function leaderboard(month) {
    const args = month ? [month + '%'] : [];
    return db.prepare(
      `SELECT ${USER_COLS}, COUNT(*) AS games, COALESCE(SUM(m.winner = mp.side), 0) AS wins,
              COUNT(DISTINCT substr(m.played_at, 1, 10)) AS days
       FROM match_players mp JOIN matches m ON m.id = mp.match_id JOIN users u ON u.id = mp.user_id
       ${month ? 'WHERE m.played_at LIKE ?' : ''}
       GROUP BY u.id ORDER BY games DESC, wins DESC, u.name LIMIT 200`,
    ).all(...args).map((r, i) => ({ rank: i + 1, ...r }));
  }

  const monthParam = (q) => {
    const m = q.get('month');
    if (!m || m === 'all') return null;
    if (!MONTH_RE.test(m)) throw bad('month: ожидается YYYY-MM или all');
    return m;
  };

  const upcomingSlots = () =>
    db.prepare('SELECT id, court, starts_at, ends_at, price, note FROM club_slots WHERE starts_at >= ? ORDER BY starts_at, court LIMIT 100').all(nowLocal());

  // ---------- Маршруты ----------
  const routes = [];
  const route = (method, pattern, kind, handler) => routes.push({ method, pattern, kind, handler });

  route('GET', /^\/api\/config$/, 'public', () => ({
    club_name: clubName, app_link: appLink, dev_mode: devMode, levels: LEVELS, now: nowLocal(),
  }));

  route('GET', /^\/api\/me$/, 'user', ({ user }) => {
    const month = nowLocal().slice(0, 7);
    const stats = db.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(m.winner = mp.side), 0) AS wins,
              COALESCE(SUM(m.played_at LIKE ?), 0) AS month
       FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.user_id = ?`,
    ).get(month + '%', user.id);
    return { user, stats };
  });

  route('PATCH', /^\/api\/me$/, 'user', ({ user, body }) => {
    if (!LEVELS.includes(body.level)) throw bad('Неизвестный уровень');
    db.prepare('UPDATE users SET level = ? WHERE id = ?').run(body.level, user.id);
    return { user: { ...user, level: body.level } };
  });

  route('GET', /^\/api\/users$/, 'user', () => ({
    users: db.prepare(`SELECT ${USER_COLS} FROM users u ORDER BY u.name LIMIT 1000`).all(),
  }));

  route('GET', /^\/api\/games$/, 'user', ({ user }) => {
    // прошедшие игры пользователя, которые ещё не отмечены как сыгранные
    const toReport = withPlayers(
      db.prepare(
        `SELECT g.* FROM games g JOIN game_players gp ON gp.game_id = g.id AND gp.user_id = ?
         WHERE g.status = 'open' AND g.starts_at < ? AND g.starts_at >= ? ORDER BY g.starts_at DESC`,
      ).all(user.id, nowLocal(), nowLocal(-14 * 24 * 60)),
      'game_players', 'game_id',
    ).filter((g) => g.players.length >= 2);
    return { now: nowLocal(), games: upcomingGames(), to_report: toReport, slots: upcomingSlots() };
  });

  route('POST', /^\/api\/games$/, 'user', ({ user, body }) => {
    if (!validDateTime(body.starts_at)) throw bad('Укажите дату и время');
    if (body.starts_at < nowLocal()) throw bad('Это время уже прошло');
    if (body.starts_at > nowLocal(180 * 24 * 60)) throw bad('Слишком далеко в будущем');
    if (!FORMATS[body.format]) throw bad('Выберите формат игры');
    const duration = Number(body.duration_min ?? 60);
    if (!Number.isInteger(duration) || duration < 30 || duration > 300) throw bad('Некорректная длительность');
    const level = body.level ?? 'any';
    if (!LEVELS.includes(level)) throw bad('Неизвестный уровень');
    const active = db.prepare(`SELECT COUNT(*) AS n FROM games WHERE creator_id = ? AND status = 'open' AND starts_at >= ?`).get(user.id, nowLocal()).n;
    if (active >= 20) throw bad('Слишком много активных заявок');

    db.exec('BEGIN');
    try {
      const { lastInsertRowid: id } = db.prepare(
        `INSERT INTO games (creator_id, starts_at, duration_min, place, format, max_players, level, comment) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(user.id, body.starts_at, duration, text(body.place, 80), body.format, FORMATS[body.format], level, text(body.comment, 300));
      db.prepare('INSERT INTO game_players (game_id, user_id) VALUES (?, ?)').run(id, user.id);
      db.exec('COMMIT');
      return { game: getGame(Number(id)) };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  route('POST', /^\/api\/games\/(\d+)\/join$/, 'user', ({ user, params }) => {
    const g = getGame(Number(params[0]));
    if (g.status !== 'open' || g.starts_at < nowLocal(-60)) throw new HttpError(409, 'Запись на эту игру закрыта');
    if (g.players.some((p) => p.id === user.id)) return { game: g };
    if (g.players.length >= g.max_players) throw new HttpError(409, 'Мест уже нет');
    db.prepare('INSERT INTO game_players (game_id, user_id) VALUES (?, ?)').run(g.id, user.id);
    const left = g.max_players - g.players.length - 1;
    notify(g.players.map((p) => p.id), `🎾 ${who(user)} присоединяется к игре ${when(g.starts_at)}. ${left ? `Свободно мест: ${left}` : 'Состав собран!'}`);
    return { game: getGame(g.id) };
  });

  route('POST', /^\/api\/games\/(\d+)\/leave$/, 'user', ({ user, params }) => {
    const g = getGame(Number(params[0]));
    if (g.creator_id === user.id) throw bad('Организатор не может выйти — отмените игру');
    if (g.status !== 'open') throw new HttpError(409, 'Игра уже закрыта');
    const { changes } = db.prepare('DELETE FROM game_players WHERE game_id = ? AND user_id = ?').run(g.id, user.id);
    if (changes) notify(g.players.filter((p) => p.id !== user.id).map((p) => p.id), `${who(user)} не сможет прийти на игру ${when(g.starts_at)}. Место освободилось.`);
    return { game: getGame(g.id) };
  });

  route('POST', /^\/api\/games\/(\d+)\/cancel$/, 'user', ({ user, params }) => {
    const g = getGame(Number(params[0]));
    if (g.creator_id !== user.id) throw new HttpError(403, 'Отменить игру может только организатор');
    if (g.status !== 'open') throw new HttpError(409, 'Игра уже закрыта');
    db.prepare(`UPDATE games SET status = 'cancelled' WHERE id = ?`).run(g.id);
    notify(g.players.filter((p) => p.id !== user.id).map((p) => p.id), `❌ ${who(user)} отменил(а) игру ${when(g.starts_at)}.`);
    return { ok: true };
  });

  route('GET', /^\/api\/matches$/, 'user', ({ query }) => ({ matches: listMatches({ month: monthParam(query) }) }));

  route('POST', /^\/api\/matches$/, 'user', ({ user, body }) => {
    const size = FORMATS[body.format] / 2;
    if (!size) throw bad('Выберите формат игры');
    if (!validDateTime(body.played_at)) throw bad('Укажите дату и время матча');
    if (body.played_at > nowLocal()) throw bad('Матч ещё не сыгран');
    if (body.played_at < nowLocal(-60 * 24 * 60)) throw bad('Слишком давний матч');
    const teams = [body.team1, body.team2];
    if (!teams.every((t) => Array.isArray(t) && t.length === size && t.every(Number.isSafeInteger))) {
      throw bad(size === 1 ? 'Выберите соперника' : 'Выберите всех четырёх игроков');
    }
    const ids = teams.flat();
    if (new Set(ids).size !== ids.length) throw bad('Игрок указан дважды');
    if (!ids.includes(user.id)) throw bad('Отмечать можно только свои матчи');
    const known = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids).n;
    if (known !== ids.length) throw bad('Игрок не найден');
    const winner = body.winner == null ? null : Number(body.winner);
    if (winner !== null && winner !== 1 && winner !== 2) throw bad('Некорректный победитель');

    let gameId = null;
    if (body.game_id != null) {
      const g = getGame(Number(body.game_id));
      if (g.status !== 'open') throw new HttpError(409, 'Эта игра уже отмечена');
      if (!g.players.some((p) => p.id === user.id)) throw new HttpError(403, 'Вы не участник этой игры');
      gameId = g.id;
    }

    db.exec('BEGIN');
    try {
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO matches (game_id, played_at, format, score, winner, created_by) VALUES (?,?,?,?,?,?)',
      ).run(gameId, body.played_at, body.format, text(body.score, 40), winner, user.id);
      const id = Number(lastInsertRowid);
      const ins = db.prepare('INSERT INTO match_players (match_id, user_id, side) VALUES (?,?,?)');
      teams.forEach((t, i) => t.forEach((uid) => ins.run(id, uid, i + 1)));
      if (gameId) db.prepare(`UPDATE games SET status = 'played' WHERE id = ?`).run(gameId);
      db.exec('COMMIT');
      notify(ids.filter((i) => i !== user.id), `🎾 ${who(user)} отметил(а) матч с вами ${when(body.played_at)}${body.score ? `, счёт ${text(body.score, 40)}` : ''}. Если это ошибка — удалите запись в приложении.`);
      return { match: withPlayers(db.prepare('SELECT id, game_id, played_at, format, score, winner, created_by FROM matches WHERE id = ?').all(id), 'match_players', 'match_id')[0] };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  // Удалить запись может любой участник матча (на случай ошибки или «меня там не было»)
  route('DELETE', /^\/api\/matches\/(\d+)$/, 'user', ({ user, params }) => {
    const id = Number(params[0]);
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    if (!m) throw new HttpError(404, 'Матч не найден');
    const mine = db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND user_id = ?').get(id, user.id);
    if (!mine && m.created_by !== user.id) throw new HttpError(403, 'Удалить матч может только его участник');
    db.prepare('DELETE FROM matches WHERE id = ?').run(id);
    return { ok: true };
  });

  route('GET', /^\/api\/leaderboard$/, 'user', ({ query }) => {
    const month = monthParam(query);
    return { month: month ?? 'all', leaderboard: leaderboard(month) };
  });

  // ---------- API для клуба (X-API-Key) ----------
  route('GET', /^\/api\/club\/v1\/ping$/, 'club', () => ({ ok: true, club: clubName, now: nowLocal(), tz: clubTz }));
  route('GET', /^\/api\/club\/v1\/members$/, 'club', () => ({
    members: db.prepare(`SELECT ${USER_COLS}, u.created_at FROM users u ORDER BY u.name`).all(),
  }));
  route('GET', /^\/api\/club\/v1\/games$/, 'club', () => ({ games: upcomingGames() }));
  route('GET', /^\/api\/club\/v1\/matches$/, 'club', ({ query }) => ({ matches: listMatches({ month: monthParam(query), limit: 1000 }) }));
  route('GET', /^\/api\/club\/v1\/leaderboard$/, 'club', ({ query }) => {
    const month = monthParam(query);
    return { month: month ?? 'all', leaderboard: leaderboard(month) };
  });
  route('GET', /^\/api\/club\/v1\/slots$/, 'club', () => ({ slots: upcomingSlots() }));
  // Клуб целиком заменяет список свободных кортов данными из своей таблицы
  route('PUT', /^\/api\/club\/v1\/slots$/, 'club', ({ body }) => {
    if (!Array.isArray(body.slots) || body.slots.length > 2000) throw bad('slots: expected an array (max 2000)');
    const rows = body.slots.map((s, i) => {
      if (!s || typeof s !== 'object') throw bad(`slots[${i}]: expected an object`);
      const court = text(s.court, 60);
      if (!court) throw bad(`slots[${i}].court is required`);
      if (!validDateTime(s.starts_at) || !validDateTime(s.ends_at) || s.ends_at <= s.starts_at) {
        throw bad(`slots[${i}]: starts_at/ends_at must be YYYY-MM-DDTHH:MM, ends_at after starts_at`);
      }
      return [court, s.starts_at, s.ends_at, text(s.price == null ? '' : String(s.price), 30), text(s.note, 120)];
    });
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM club_slots');
      const ins = db.prepare('INSERT INTO club_slots (court, starts_at, ends_at, price, note) VALUES (?,?,?,?,?)');
      rows.forEach((r) => ins.run(...r));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { ok: true, count: rows.length };
  });

  // ---------- HTTP ----------
  async function readJson(req) {
    if (req.method === 'GET' || req.method === 'DELETE') return {};
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 512 * 1024) throw new HttpError(413, 'Слишком большой запрос');
      chunks.push(c);
    }
    if (!size) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      return v;
    } catch {
      throw bad('Некорректный JSON');
    }
  }

  function send(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, { error: 'Bad path' }); }
    if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    try {
      const matched = routes.filter((r) => r.pattern.test(url.pathname));
      const r = matched.find((x) => x.method === req.method);
      if (!r) throw new HttpError(matched.length ? 405 : 404, matched.length ? 'Method not allowed' : 'Not found');
      const ctx = { query: url.searchParams, params: url.pathname.match(r.pattern).slice(1) };
      if (r.kind === 'user') ctx.user = authUser(req);
      if (r.kind === 'club') authClub(req);
      ctx.body = await readJson(req);
      send(res, 200, r.handler(ctx));
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  });
  server.on('close', () => db.close());
  return server;
}
