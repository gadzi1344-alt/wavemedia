// Cloudflare Pages Function: /api/u/{me,register,login,logout,listen,featured,fp_save,fp_delete}
// Нужна привязка D1 с именем DB. Админ — пользователь ADMIN_USER (по умолчанию bibnaq).
// Регистрация имени админа требует секрет ADMIN_CODE, иначе его мог бы занять кто угодно.

const json = (d, s = 200, h = {}) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...h },
  });

const te = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const rnd = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', te.encode(s)));
const now = () => Math.floor(Date.now() / 1000);

async function hashPw(pw, salt) {
  const k = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(salt), iterations: 100000 }, k, 256));
}

let ready;
const init = (db) =>
  ready ||
  (ready = db
    .batch([
      db.prepare('CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL COLLATE NOCASE, email TEXT, salt TEXT, hash TEXT, listen_sec INTEGER DEFAULT 0, created INTEGER)'),
      db.prepare('CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER)'),
      db.prepare("CREATE TABLE IF NOT EXISTS fp(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, category TEXT, cover TEXT, tracks TEXT DEFAULT '[]', created INTEGER)"),
    ])
    .catch((e) => { ready = null; throw e; }));

export async function onRequest({ request, env, params }) {
  if (!env.DB) return json({ error: 'Не подключена база D1 (привязка DB). См. README.' }, 500);
  try {
    const db = env.DB;
    await init(db);
    const a = params.action;
    const sp = new URL(request.url).searchParams;
    const adminName = (env.ADMIN_USER || 'bibnaq').toLowerCase();
    const post = request.method === 'POST';
    const body = post ? await request.json().catch(() => ({})) : {};

    const token = (request.headers.get('cookie') || '').match(/(?:^|; )wave_s=([a-f0-9]+)/)?.[1];
    const user = token
      ? await db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').bind(await sha(token)).first()
      : null;
    const pub = (u) => u && { name: u.name, listen_sec: u.listen_sec || 0, created: u.created, admin: u.name.toLowerCase() === adminName };
    const isAdmin = !!user && user.name.toLowerCase() === adminName;

    const startSession = async (id) => {
      const t = rnd(32);
      await db.prepare('INSERT INTO sessions(token, user_id, created) VALUES(?,?,?)').bind(await sha(t), id, now()).run();
      const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
      return json({ user: pub(u) }, 200, { 'set-cookie': `wave_s=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` });
    };

    if (a === 'me') return json({ user: pub(user) });

    if (a === 'featured') {
      const id = sp.get('id');
      if (id) {
        const r = await db.prepare('SELECT * FROM fp WHERE id = ?').bind(id).first();
        if (!r) return json({ error: 'Плейлист не найден' }, 404);
        return json({ playlist: { ...r, tracks: JSON.parse(r.tracks || '[]') } });
      }
      const { results } = await db.prepare('SELECT * FROM fp ORDER BY id DESC').all();
      return json({
        playlists: results.map((r) => {
          const t = JSON.parse(r.tracks || '[]');
          return { id: r.id, name: r.name, category: r.category, cover: r.cover || t[0]?.cover || '', count: t.length };
        }),
      });
    }

    if (!post) return json({ error: 'Не найдено' }, 404);

    if (a === 'register') {
      const name = String(body.name || '').trim();
      const pw = String(body.password || '');
      if (!/^[\w.\-а-яёА-ЯЁ]{3,20}$/.test(name)) return json({ error: 'Имя: 3–20 символов (буквы, цифры, _ . -)' }, 400);
      if (pw.length < 6) return json({ error: 'Пароль: минимум 6 символов' }, 400);
      if (name.toLowerCase() === adminName && !(env.ADMIN_CODE && body.code === env.ADMIN_CODE))
        return json({ error: 'Это имя зарезервировано. Нужен верный админ-код.' }, 403);
      const salt = rnd(16);
      let id;
      try {
        const r = await db.prepare('INSERT INTO users(name, email, salt, hash, created) VALUES(?,?,?,?,?)')
          .bind(name, String(body.email || '').slice(0, 100), salt, await hashPw(pw, salt), now()).run();
        id = r.meta.last_row_id;
      } catch (_) { return json({ error: 'Такое имя уже занято' }, 409); }
      return startSession(id);
    }

    if (a === 'login') {
      const u = await db.prepare('SELECT * FROM users WHERE name = ?').bind(String(body.name || '').trim()).first();
      if (!u || (await hashPw(String(body.password || ''), u.salt)) !== u.hash) return json({ error: 'Неверное имя или пароль' }, 401);
      return startSession(u.id);
    }

    if (a === 'logout') {
      if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha(token)).run();
      return json({ ok: true }, 200, { 'set-cookie': 'wave_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
    }

    if (a === 'listen') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const sec = Math.min(120, Math.max(0, Math.floor(Number(body.sec)) || 0));
      await db.prepare('UPDATE users SET listen_sec = listen_sec + ? WHERE id = ?').bind(sec, user.id).run();
      return json({ ok: true });
    }

    if (a === 'fp_save' || a === 'fp_delete') {
      if (!isAdmin) return json({ error: 'Только для администратора' }, 403);
      if (a === 'fp_delete') {
        await db.prepare('DELETE FROM fp WHERE id = ?').bind(body.id).run();
        return json({ ok: true });
      }
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) return json({ error: 'Нужно название' }, 400);
      const category = String(body.category || 'Подборка').trim().slice(0, 30) || 'Подборка';
      const cover = /^https:\/\//.test(body.cover || '') ? String(body.cover).slice(0, 500) : '';
      const tracks = (Array.isArray(body.tracks) ? body.tracks : []).slice(0, 200).map((t) => ({
        id: String(t.id), title: String(t.title || '').slice(0, 200), duration: Number(t.duration) || 0,
        cover: String(t.cover || '').slice(0, 500),
        artists: (t.artists || []).slice(0, 10).map((x) => ({ id: x.id, name: String(x.name || '').slice(0, 100) })),
      }));
      if (body.id) {
        await db.prepare('UPDATE fp SET name=?, category=?, cover=?, tracks=? WHERE id=?').bind(name, category, cover, JSON.stringify(tracks), body.id).run();
        return json({ ok: true, id: body.id });
      }
      const r = await db.prepare('INSERT INTO fp(name, category, cover, tracks, created) VALUES(?,?,?,?,?)').bind(name, category, cover, JSON.stringify(tracks), now()).run();
      return json({ ok: true, id: r.meta.last_row_id });
    }

    return json({ error: 'Не найдено' }, 404);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
