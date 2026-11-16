import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY,           -- Telegram user id
      username   TEXT,
      name       TEXT NOT NULL,
      photo_url  TEXT,
      level      TEXT NOT NULL DEFAULT 'any',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Заявки на игру. Время — локальное время клуба, 'YYYY-MM-DDTHH:MM'
    CREATE TABLE IF NOT EXISTS games (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id   INTEGER NOT NULL REFERENCES users(id),
      starts_at    TEXT NOT NULL,
      duration_min INTEGER NOT NULL DEFAULT 60,
      place        TEXT NOT NULL DEFAULT '',
      format       TEXT NOT NULL CHECK (format IN ('singles','doubles')),
      max_players  INTEGER NOT NULL,
      level        TEXT NOT NULL DEFAULT 'any',
      comment      TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled','played')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS games_starts ON games(status, starts_at);

    CREATE TABLE IF NOT EXISTS game_players (
      game_id   INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (game_id, user_id)
    );

    -- Сыгранные матчи («мы играли»)
    CREATE TABLE IF NOT EXISTS matches (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id    INTEGER REFERENCES games(id) ON DELETE SET NULL,
      played_at  TEXT NOT NULL,
      format     TEXT NOT NULL CHECK (format IN ('singles','doubles')),
      score      TEXT NOT NULL DEFAULT '',
      winner     INTEGER CHECK (winner IN (1,2)),   -- победившая сторона, NULL = не указано
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS matches_played ON matches(played_at);

    CREATE TABLE IF NOT EXISTS match_players (
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id),
      side     INTEGER NOT NULL CHECK (side IN (1,2)),
      PRIMARY KEY (match_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS match_players_user ON match_players(user_id);

    -- Свободные корты, которые клуб присылает из своей таблицы через API
    CREATE TABLE IF NOT EXISTS club_slots (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      court     TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at   TEXT NOT NULL,
      price     TEXT NOT NULL DEFAULT '',
      note      TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}
