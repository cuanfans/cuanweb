import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { sign } from 'hono/jwt';
import { hashPassword } from '../helpers.js';
import { authMiddleware } from '../middleware.js';

const auth = new Hono();

auth.post('/register', async (c) => {
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    
    if (!body.email || !body.password || !body.name) {
      return c.json({ error: 'Nama, email, dan password wajib diisi' }, 400);
    }
    if (body.password.length < 6) {
        return c.json({ error: 'Password minimal 6 karakter' }, 400);
    }
    
    const country = c.req.header('cf-ipcountry') || 'ID';
    const currency = (country === 'ID') ? 'IDR' : 'USD';
    
    try {
        const password_hash = await hashPassword(body.password, c.env.JWT_SECRET);
        const newUserId = crypto.randomUUID();
        const newApiKey = crypto.randomUUID();
        const newWalletId = crypto.randomUUID();

        await c.env.DB.batch([
            c.env.DB.prepare(
                `INSERT INTO users (id, email, password_hash, name, api_key, role, status, country_code, default_currency, created_at)
                 VALUES (?, ?, ?, ?, ?, 'member', 'active', ?, ?, ?)`
            ).bind(newUserId, body.email, password_hash, body.name, newApiKey, country, currency, now),
            
            c.env.DB.prepare(
                `INSERT INTO wallets (id, user_id, balance_idr, balance_usd_cents, created_at, updated_at)
                 VALUES (?, ?, 0, 0, ?, ?)`
            ).bind(newWalletId, newUserId, now, now)
        ]);

        const user = await c.env.DB.prepare("SELECT id, email, name, api_key, role, status, created_at FROM users WHERE id = ?").bind(newUserId).first();
        return c.json({ message: 'Registrasi berhasil!', user: user }, 201);
    } catch (e) {
        if (e.message.includes('UNIQUE constraint failed')) { return c.json({ error: 'Email ini sudah terdaftar.' }, 409); }
        return c.json({ error: 'Terjadi kesalahan internal: ' + e.message }, 500);
    }
});

auth.post('/login', async (c) => {
  const body = await c.req.json();
  if (!body.email || !body.password) { return c.json({ error: 'Email dan password wajib diisi' }, 400); }
  
  const user = await c.env.DB.prepare("SELECT id, email, name, password_hash, role, status FROM users WHERE email = ?").bind(body.email).first();
  if (!user) { return c.json({ error: 'Email atau password salah' }, 401); }
  if (user.status === 'suspended') { return c.json({ error: 'Akun Anda telah di-suspend.' }, 403); }
  
  const password_hash = await hashPassword(body.password, c.env.JWT_SECRET);
  if (password_hash !== user.password_hash) { return c.json({ error: 'Email atau password salah' }, 401); }
  
  const payload = { 
      sub: user.id, 
      email: user.email, 
      name: user.name, 
      role: user.role,
      status: user.status, 
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24) // 24 jam
  };
  const token = await sign(payload, c.env.JWT_SECRET);
  
  setCookie(c, 'auth_token', token, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge: 60 * 60 * 24 });
  return c.json({ message: 'Login berhasil!', role: user.role });
});

auth.get('/logout', (c) => {
  setCookie(c, 'auth_token', '', { path: '/', maxAge: 0 });
  return c.redirect('/'); 
});

auth.get('/profile', authMiddleware, async (c) => { 
  const userPayload = c.get('user');
  const user = await c.env.DB.prepare(
      "SELECT id, email, name, api_key, role, status, country_code, default_currency, created_at FROM users WHERE id = ?"
  ).bind(userPayload.sub).first();
  if (!user) { return c.json({ error: 'Pengguna tidak ditemukan' }, 404); }
  return c.json(user);
});

export default auth;
