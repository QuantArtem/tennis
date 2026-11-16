import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { verifyInitData, signInitData } from '../server/auth.js';

const NOW = new Date('2026-11-16T12:00:00Z'); // 15:00 по Москве

async function start(opts = {}) {
  const server = createApp({ now: () => NOW, ...opts });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = (user, method, path, body, headers = {}) =>
    fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(user ? { 'x-dev-user': encodeURIComponent(JSON.stringify(user)) } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { server, call };
}

const anna = { id: 1, first_name: 'Анна', username: 'anna' };
const boris = { id: 2, first_name: 'Борис', username: 'boris' };
const vera = { id: 3, first_name: 'Вера' };
const gleb = { id: 4, first_name: 'Глеб' };

test('initData: подпись Telegram проверяется', () => {
  const token = '123:ABC';
  const nowSec = NOW.getTime() / 1000;
  const init = signInitData({ auth_date: String(nowSec - 10), user: JSON.stringify({ id: 42, first_name: 'T' }) }, token);
  assert.equal(verifyInitData(init, token, nowSec).id, 42);
  assert.equal(verifyInitData(init, 'other:token', nowSec), null);
  assert.equal(verifyInitData(init.replace('42', '43'), token, nowSec), null);
  assert.equal(verifyInitData(init, token, nowSec + 2 * 86400), null, 'устаревшие данные отклоняются');
});

test('с BOT_TOKEN демо-вход запрещён, initData работает', async (t) => {
  const { server, call } = await start({ botToken: '123:ABC' });
  t.after(() => server.close());
  assert.equal((await call(anna, 'GET', '/api/me')).status, 401);
  const init = signInitData({ auth_date: String(NOW.getTime() / 1000), user: JSON.stringify(anna) }, '123:ABC');
  const r = await call(null, 'GET', '/api/me', null, { authorization: 'tma ' + init });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, 'anna');
});

test('заявка → вступление → матч → лидерборд', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  for (const u of [anna, boris, vera, gleb]) await call(u, 'GET', '/api/me');

  // прошедшее время нельзя
  assert.equal((await call(anna, 'POST', '/api/games', { starts_at: '2026-11-16T10:00', format: 'singles' })).status, 400);

  const g = (await call(anna, 'POST', '/api/games', { starts_at: '2026-11-21T19:00', format: 'singles', place: 'Корт 2' })).body.game;
  assert.equal(g.players.length, 1);
  assert.equal(g.max_players, 2);

  let r = await call(boris, 'POST', `/api/games/${g.id}/join`);
  assert.equal(r.body.game.players.length, 2);
  r = await call(vera, 'POST', `/api/games/${g.id}/join`);
  assert.equal(r.status, 409, 'мест нет');

  r = await call(boris, 'POST', `/api/games/${g.id}/leave`);
  assert.equal(r.body.game.players.length, 1);
  assert.equal((await call(anna, 'POST', `/api/games/${g.id}/leave`)).status, 400, 'организатор не выходит');
  assert.equal((await call(boris, 'POST', `/api/games/${g.id}/cancel`)).status, 403);
  assert.equal((await call(anna, 'POST', `/api/games/${g.id}/cancel`)).status, 200);
  assert.equal((await call(anna, 'GET', '/api/games')).body.games.length, 0);

  // матчи
  const m1 = { played_at: '2026-11-15T18:00', format: 'singles', team1: [1], team2: [2], score: '6:4 6:3', winner: 1 };
  assert.equal((await call(anna, 'POST', '/api/matches', m1)).status, 200);
  assert.equal((await call(vera, 'POST', '/api/matches', m1)).status, 400, 'чужой матч отметить нельзя');
  assert.equal((await call(anna, 'POST', '/api/matches', { ...m1, team2: [1] })).status, 400);
  assert.equal((await call(anna, 'POST', '/api/matches', { ...m1, played_at: '2026-11-17T18:00' })).status, 400, 'будущее');
  assert.equal((await call(anna, 'POST', '/api/matches', { ...m1, team2: [999] })).status, 400);

  const dbl = { played_at: '2026-11-14T11:00', format: 'doubles', team1: [1, 3], team2: [2, 4], winner: 2 };
  const m2 = (await call(anna, 'POST', '/api/matches', dbl)).body.match;
  assert.equal(m2.players.length, 4);
  await call(boris, 'POST', '/api/matches', { played_at: '2026-10-30T11:00', format: 'singles', team1: [2], team2: [3] });

  const lb = (await call(anna, 'GET', '/api/leaderboard?month=2026-11')).body.leaderboard;
  assert.deepEqual(lb.map((x) => [x.name, x.games, x.wins]), [['Анна', 2, 1], ['Борис', 2, 1], ['Глеб', 1, 1], ['Вера', 1, 0]]);
  const all = (await call(anna, 'GET', '/api/leaderboard?month=all')).body.leaderboard;
  assert.equal(all.find((x) => x.name === 'Борис').games, 3);
  assert.equal((await call(anna, 'GET', '/api/leaderboard?month=nope')).status, 400);

  const me = (await call(anna, 'GET', '/api/me')).body;
  assert.deepEqual(me.stats, { total: 2, wins: 1, month: 2 });

  // удалить может участник, посторонний — нет
  const m3 = (await call(boris, 'GET', '/api/matches?month=2026-10')).body.matches[0];
  assert.equal((await call(anna, 'DELETE', `/api/matches/${m3.id}`)).status, 403);
  assert.equal((await call(vera, 'DELETE', `/api/matches/${m3.id}`)).status, 200);
});

test('прошедшая игра предлагается к отметке и закрывается матчем', async (t) => {
  let now = NOW;
  const { server, call } = await start({ now: () => now });
  t.after(() => server.close());
  const g = (await call(anna, 'POST', '/api/games', { starts_at: '2026-11-16T19:00', format: 'singles' })).body.game;
  await call(boris, 'POST', `/api/games/${g.id}/join`);
  now = new Date('2026-11-17T08:00:00Z');
  let r = (await call(boris, 'GET', '/api/games')).body;
  assert.equal(r.games.length, 0);
  assert.equal(r.to_report.length, 1);
  const body = { game_id: g.id, played_at: g.starts_at, format: 'singles', team1: [2], team2: [1] };
  assert.equal((await call(vera, 'POST', '/api/matches', { ...body, team1: [3] })).status, 403);
  assert.equal((await call(boris, 'POST', '/api/matches', body)).status, 200);
  assert.equal((await call(anna, 'POST', '/api/matches', body)).status, 409, 'повторно отметить нельзя');
  assert.equal((await call(boris, 'GET', '/api/games')).body.to_report.length, 0);
});

test('API клуба: ключ, слоты, выгрузки', async (t) => {
  const off = await start();
  assert.equal((await off.call(null, 'GET', '/api/club/v1/ping')).status, 503);
  off.server.close();

  const { server, call } = await start({ clubApiKey: 'secret-key' });
  t.after(() => server.close());
  const key = { 'x-api-key': 'secret-key' };
  assert.equal((await call(null, 'GET', '/api/club/v1/ping')).status, 401);
  assert.equal((await call(null, 'GET', '/api/club/v1/ping', null, { 'x-api-key': 'wrong' })).status, 401);
  assert.equal((await call(null, 'GET', '/api/club/v1/ping', null, key)).status, 200);
  assert.equal((await call(null, 'GET', '/api/club/v1/ping', null, { authorization: 'Bearer secret-key' })).status, 200);

  const slots = [
    { court: 'Корт 1', starts_at: '2026-11-21T19:00', ends_at: '2026-11-21T20:00', price: 2500 },
    { court: 'Корт 1', starts_at: '2026-11-10T19:00', ends_at: '2026-11-10T20:00' },
  ];
  assert.equal((await call(null, 'PUT', '/api/club/v1/slots', { slots: [{ court: 'x', starts_at: 'bad', ends_at: 'bad' }] }, key)).status, 400);
  assert.deepEqual((await call(null, 'PUT', '/api/club/v1/slots', { slots }, key)).body, { ok: true, count: 2 });

  await call(anna, 'POST', '/api/games', { starts_at: '2026-11-21T19:00', format: 'doubles' });
  const games = (await call(anna, 'GET', '/api/games')).body;
  assert.equal(games.slots.length, 1, 'игрокам видны только будущие слоты');
  assert.equal(games.slots[0].price, '2500');

  assert.equal((await call(null, 'GET', '/api/club/v1/games', null, key)).body.games.length, 1);
  assert.equal((await call(null, 'GET', '/api/club/v1/members', null, key)).body.members.length, 1);
  assert.deepEqual((await call(null, 'GET', '/api/club/v1/leaderboard?month=2026-11', null, key)).body.leaderboard, []);
  // ключ клуба не даёт доступа к пользовательскому API и наоборот
  assert.equal((await call(null, 'GET', '/api/games', null, key)).status, 401);
  assert.equal((await call(anna, 'GET', '/api/club/v1/members')).status, 401);
});

test('статика и защита от обхода путей', async (t) => {
  const { server } = await start();
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/..%2fpackage.json')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/server/app.js')).status, 404);
});
