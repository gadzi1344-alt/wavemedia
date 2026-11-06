// Соцсеть: посты, просмотры, лайки, комментарии, подписки, профили, поиск,
// загрузка фото в R2 и админка (галочка и значки).
// Привязки Pages: DB (D1, та же база, что у плеера), MEDIA (R2-бакет).
// Админ: ADMIN_USER (по умолчанию bibnaq). Аккаунты общие с плеером: cookie wave_s.

const DEFAULT_ADMIN = 'bibnaq';
const BADGES = {
  star: { label: 'Звезда', emoji: '⭐' },
  fire: { label: 'Огонь', emoji: '🔥' },
  heart: { label: 'Сердечко', emoji: '💜' },
  cat: { label: 'Котик', emoji: '🐱' },
  crown: { label: 'Корона', emoji: '👑' },
  flower: { label: 'Цветочек', emoji: '🌸' },
  sparkle: { label: 'Блёстки', emoji: '✨' },
  bunny: { label: 'Зайка', emoji: '🐰' },
};

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL COLLATE NOCASE, email TEXT, salt TEXT, hash TEXT, listen_sec INTEGER DEFAULT 0, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, text TEXT, image_key TEXT, views INTEGER DEFAULT 0, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS post_views(post_id INTEGER, user_id INTEGER, PRIMARY KEY(post_id, user_id))',
  'CREATE TABLE IF NOT EXISTS likes(post_id INTEGER, user_id INTEGER, PRIMARY KEY(post_id, user_id))',
  'CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, user_id INTEGER, text TEXT, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS follows(follower_id INTEGER, followee_id INTEGER, PRIMARY KEY(follower_id, followee_id))',
];
// Новые колонки в users (если их ещё нет)
const ALTERS = [
  "ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN avatar_key TEXT DEFAULT ''",
  'ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0',
  "ALTER TABLE users ADD COLUMN badges TEXT DEFAULT '[]'",
];

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
const te = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const rnd = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', te.encode(s)));
const now = () => Math.floor(Date.now() / 1000);
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

let ready;
function init(db) {
  return ready || (ready = (async () => {
    await db.batch(SCHEMA.map((q) => db.prepare(q)));
    for (const q of ALTERS) {
      try { await db.prepare(q).run(); } catch (_) { /* колонка уже есть */ }
    }
  })().catch((e) => { ready = null; throw e; }));
}

async function getUser(db, request) {
  const token = (request.headers.get('cookie') || '').match(/(?:^|; )wave_s=([a-f0-9]+)/)?.[1];
  if (!token) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
    .bind(await sha(token)).first();
}

const mediaUrl = (k) => `/api/s/media?key=${encodeURIComponent(k)}`;
const parseBadges = (s) => {
  try { return JSON.parse(s || '[]').filter((b) => BADGES[b]); } catch (_) { return []; }
};
const mapUser = (u) => ({
  id: u.id, name: u.name, bio: u.bio || '', created: u.created,
  avatar: u.avatar_key ? mediaUrl(u.avatar_key) : '',
  verified: !!u.verified, badges: parseBadges(u.badges),
});
const mapAuthor = (r) => ({
  name: r.name, verified: !!r.verified, badges: parseBadges(r.badges),
  avatar: r.avatar_key ? mediaUrl(r.avatar_key) : '',
});
function mapPost(r, uid, isAdmin) {
  return {
    id: r.id, text: r.text || '', created: r.created, views: r.views || 0,
    image: r.image_key ? mediaUrl(r.image_key) : '',
    likes: r.likes || 0, comments: r.comments || 0, liked: !!r.liked,
    can: isAdmin || r.user_id === uid, author: mapAuthor(r),
  };
}

// Общий запрос постов: первый знак вопроса — id зрителя (для лайка «моё»)
const POST_SQL = `SELECT p.id, p.text, p.image_key, p.views, p.created, p.user_id,
  u.name, u.verified, u.badges, u.avatar_key,
  (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments,
  (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
  FROM posts p JOIN users u ON u.id = p.user_id`;

export async function onRequest({ request, env, params }) {
  if (!env.DB) return json({ error: 'Не подключена база D1 (привязка DB)' }, 500);
  try {
    const db = env.DB;
    await init(db);
    const a = params.action;
    const sp = new URL(request.url).searchParams;
    const user = await getUser(db, request);
    const uid = user ? user.id : 0;
    const isAdmin = !!user && user.name.toLowerCase() === (env.ADMIN_USER || DEFAULT_ADMIN).toLowerCase();
    const mapP = (r) => mapPost(r, uid, isAdmin);

    // ---- Картинка из R2 ----
    if (a === 'media') {
      const key = sp.get('key') || '';
      if (!/^(post|avatar)\/\d+\/[a-f0-9]+\.(jpg|png|webp|gif)$/.test(key)) return json({ error: 'Плохой ключ' }, 400);
      if (!env.MEDIA) return json({ error: 'Не подключено хранилище R2 (привязка MEDIA)' }, 500);
      const obj = await env.MEDIA.get(key);
      if (!obj) return json({ error: 'Нет файла' }, 404);
      return new Response(obj.body, {
        headers: {
          'content-type': obj.httpMetadata?.contentType || 'image/jpeg',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    }

    // ---- Загрузка картинки: тело запроса — сам файл ----
    if (a === 'upload') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      if (!env.MEDIA) return json({ error: 'Не подключено хранилище R2 (привязка MEDIA)' }, 500);
      const type = (request.headers.get('content-type') || '').split(';')[0];
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[type];
      if (!ext) return json({ error: 'Только JPG, PNG, WebP или GIF' }, 400);
      const buf = await request.arrayBuffer();
      if (buf.byteLength > 5 * 1024 * 1024) return json({ error: 'Файл больше 5 МБ' }, 413);
      const kind = sp.get('kind') === 'avatar' ? 'avatar' : 'post';
      const key = `${kind}/${user.id}/${rnd(12)}.${ext}`;
      await env.MEDIA.put(key, buf, { httpMetadata: { contentType: type } });
      return json({ key });
    }

    // ---- Чтение ----
    if (request.method === 'GET') {
      if (a === 'feed') {
        const tab = sp.get('tab') === 'follow' ? 'follow' : 'all';
        if (tab === 'follow' && !user) return json({ error: 'Войдите, чтобы видеть подписки' }, 401);
        const before = Number(sp.get('before')) || 2147483647;
        const follow = tab === 'follow' ? ' AND p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)' : '';
        const binds = [uid, before, ...(follow ? [uid] : [])];
        const { results } = await db.prepare(`${POST_SQL} WHERE p.id < ?${follow} ORDER BY p.id DESC LIMIT 20`).bind(...binds).all();
        return json({ posts: results.map(mapP) });
      }

      if (a === 'post') {
        const id = Number(sp.get('id')) || 0;
        // Просмотр: зарегистрированный пользователь считается один раз, гость — каждый раз
        if (user) {
          const ins = await db.prepare('INSERT OR IGNORE INTO post_views(post_id, user_id) VALUES(?, ?)').bind(id, user.id).run();
          if (ins.meta.changes) await db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').bind(id).run();
        } else {
          await db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').bind(id).run();
        }
        const row = await db.prepare(`${POST_SQL} WHERE p.id = ?`).bind(uid, id).first();
        if (!row) return json({ error: 'Пост не найден' }, 404);
        const { results: cm } = await db.prepare(
          'SELECT c.id, c.text, c.created, u.name, u.verified, u.badges, u.avatar_key FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id LIMIT 200'
        ).bind(id).all();
        return json({
          post: mapP(row),
          comments: cm.map((c) => ({ id: c.id, text: c.text, created: c.created, author: mapAuthor(c) })),
        });
      }

      if (a === 'profile') {
        const u = await db.prepare('SELECT * FROM users WHERE name = ?').bind(clip(sp.get('name'), 40)).first();
        if (!u) return json({ error: 'Пользователь не найден' }, 404);
        const count = async (sql, ...b) => (await db.prepare(sql).bind(...b).first()).n;
        const stats = {
          posts: await count('SELECT COUNT(*) AS n FROM posts WHERE user_id = ?', u.id),
          followers: await count('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', u.id),
          following: await count('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?', u.id),
        };
        const following = !!user && !!(await db.prepare('SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ?').bind(uid, u.id).first());
        const { results } = await db.prepare(`${POST_SQL} WHERE p.user_id = ? AND p.id < ? ORDER BY p.id DESC LIMIT 20`)
          .bind(uid, u.id, Number(sp.get('before')) || 2147483647).all();
        return json({ user: mapUser(u), stats, following, isMe: uid === u.id, posts: results.map(mapP) });
      }

      if (a === 'search') {
        const q = clip(sp.get('q'), 60);
        const like = `%${q}%`;
        const { results: us } = await db.prepare('SELECT * FROM users WHERE name LIKE ? ORDER BY id DESC LIMIT 12').bind(like).all();
        const posts = q
          ? (await db.prepare(`${POST_SQL} WHERE p.text LIKE ? ORDER BY p.id DESC LIMIT 12`).bind(uid, like).all()).results.map(mapP)
          : [];
        return json({ users: us.map(mapUser), posts });
      }

      if (a === 'admin_users') {
        if (!isAdmin) return json({ error: 'Только для администратора' }, 403);
        const { results } = await db.prepare('SELECT * FROM users WHERE name LIKE ? ORDER BY id DESC LIMIT 100')
          .bind(`%${clip(sp.get('q'), 40)}%`).all();
        return json({ users: results.map(mapUser), badges: BADGES });
      }
      return json({ error: 'Не найдено' }, 404);
    }

    // ---- Запись ----
    const body = await request.json().catch(() => ({}));

    if (a === 'post_create') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const text = clip(body.text, 1000);
      const img = String(body.image_key || '');
      if (img && !new RegExp(`^post/${user.id}/[a-f0-9]+\\.(jpg|png|webp|gif)$`).test(img)) return json({ error: 'Плохое фото' }, 400);
      if (!text && !img) return json({ error: 'Напишите текст или добавьте фото' }, 400);
      const r = await db.prepare('INSERT INTO posts(user_id, text, image_key, views, created) VALUES(?, ?, ?, 0, ?)')
        .bind(user.id, text, img, now()).run();
      return json({ id: r.meta.last_row_id });
    }

    if (a === 'post_delete') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const id = Number(body.id) || 0;
      const p = await db.prepare('SELECT user_id, image_key FROM posts WHERE id = ?').bind(id).first();
      if (!p) return json({ error: 'Пост не найден' }, 404);
      if (p.user_id !== user.id && !isAdmin) return json({ error: 'Нельзя удалить чужой пост' }, 403);
      await db.batch([
        db.prepare('DELETE FROM likes WHERE post_id = ?').bind(id),
        db.prepare('DELETE FROM comments WHERE post_id = ?').bind(id),
        db.prepare('DELETE FROM post_views WHERE post_id = ?').bind(id),
        db.prepare('DELETE FROM posts WHERE id = ?').bind(id),
      ]);
      if (p.image_key && env.MEDIA) await env.MEDIA.delete(p.image_key);
      return json({ ok: true });
    }

    if (a === 'like') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const id = Number(body.id) || 0;
      if (!(await db.prepare('SELECT 1 AS x FROM posts WHERE id = ?').bind(id).first())) return json({ error: 'Пост не найден' }, 404);
      const ex = await db.prepare('SELECT 1 AS x FROM likes WHERE post_id = ? AND user_id = ?').bind(id, user.id).first();
      if (ex) await db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').bind(id, user.id).run();
      else await db.prepare('INSERT INTO likes(post_id, user_id) VALUES(?, ?)').bind(id, user.id).run();
      const n = await db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').bind(id).first();
      return json({ liked: !ex, likes: n.n });
    }

    if (a === 'comment') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const id = Number(body.post_id) || 0;
      const text = clip(body.text, 500);
      if (!text) return json({ error: 'Пустой комментарий' }, 400);
      if (!(await db.prepare('SELECT 1 AS x FROM posts WHERE id = ?').bind(id).first())) return json({ error: 'Пост не найден' }, 404);
      await db.prepare('INSERT INTO comments(post_id, user_id, text, created) VALUES(?, ?, ?, ?)').bind(id, user.id, text, now()).run();
      return json({ ok: true });
    }

    if (a === 'follow') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const t = await db.prepare('SELECT id FROM users WHERE name = ?').bind(clip(body.name, 40)).first();
      if (!t) return json({ error: 'Пользователь не найден' }, 404);
      if (t.id === user.id) return json({ error: 'Нельзя подписаться на себя' }, 400);
      const ex = await db.prepare('SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ?').bind(user.id, t.id).first();
      if (ex) await db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').bind(user.id, t.id).run();
      else await db.prepare('INSERT INTO follows(follower_id, followee_id) VALUES(?, ?)').bind(user.id, t.id).run();
      return json({ following: !ex });
    }

    if (a === 'profile_update') {
      if (!user) return json({ error: 'Нужен вход' }, 401);
      const bio = body.bio !== undefined ? clip(body.bio, 200) : (user.bio || '');
      let avatar = user.avatar_key || '';
      if (body.avatar_key !== undefined) {
        const k = String(body.avatar_key || '');
        if (k && !new RegExp(`^avatar/${user.id}/[a-f0-9]+\\.(jpg|png|webp|gif)$`).test(k)) return json({ error: 'Плохая аватарка' }, 400);
        avatar = k;
      }
      await db.prepare('UPDATE users SET bio = ?, avatar_key = ? WHERE id = ?').bind(bio, avatar, user.id).run();
      return json({ ok: true });
    }

    // Админка: галочка и значки
    if (a === 'admin_set') {
      if (!isAdmin) return json({ error: 'Только для администратора' }, 403);
      const t = await db.prepare('SELECT id FROM users WHERE name = ?').bind(clip(body.name, 40)).first();
      if (!t) return json({ error: 'Пользователь не найден' }, 404);
      const badges = (Array.isArray(body.badges) ? body.badges : []).filter((b) => BADGES[b]).slice(0, 8);
      await db.prepare('UPDATE users SET verified = ?, badges = ? WHERE id = ?')
        .bind(body.verified ? 1 : 0, JSON.stringify(badges), t.id).run();
      return json({ ok: true });
    }

    return json({ error: 'Не найдено' }, 404);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
