import { getCookie } from 'hono/cookie';
import { verify } from 'hono/jwt';

// Middleware untuk deteksi Bahasa & Mata Uang (i18n)
export const i18nMiddleware = async (c, next) => {
    const country = c.req.header('cf-ipcountry') || 'ID';
    let lang, currency;
    
    if (country === 'ID') {
        lang = 'id';
        currency = 'IDR';
    } else {
        lang = 'en';
        currency = 'USD';
    }
    
    c.set('i18n', { lang, currency, country });
    await next();
};

// Middleware autentikasi untuk Dashboard (Cookie JWT)
export const authMiddleware = async (c, next) => {
  const token = getCookie(c, 'auth_token');
  if (!token) { return c.json({ error: 'Tidak terotentikasi' }, 401); }
  try {
    const payload = await verify(token, c.env.JWT_SECRET);
    c.set('user', payload);
    await next();
  } catch (e) {
    return c.json({ error: 'Token tidak valid' }, 401);
  }
};

// Middleware autentikasi untuk API Kreator (API Key)
export const apiKeyAuthMiddleware = async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ error: 'Header Authorization (Bearer Token) tidak ditemukan.' }, 401);
    }
    const apiKey = authHeader.split(' ')[1];
    
    try {
        const user = await c.env.DB.prepare(
            "SELECT id, role, status, country_code, default_currency FROM users WHERE api_key = ?"
        ).bind(apiKey).first();
        
        if (!user) { return c.json({ error: 'API Key tidak valid.' }, 401); }
        if (user.status === 'suspended') { return c.json({ error: 'Akun Anda di-suspend.' }, 403); }
        
        c.set('user', { 
            sub: user.id, 
            role: user.role, 
            status: user.status,
            currency: user.default_currency,
            country: user.country_code
        });
        await next();
    } catch (e) {
         return c.json({ error: 'Kesalahan server saat validasi API Key.' }, 500);
    }
};

// Middleware Admin Auth
export const adminMiddleware = async (c, next) => {
    const userPayload = c.get('user');
    try {
        const user = await c.env.DB.prepare(
            "SELECT role, status FROM users WHERE id = ?"
        ).bind(userPayload.sub).first();

        if (!user) {
             return c.json({ error: 'User tidak ditemukan' }, 401);
        }
        if (user.role !== 'admin') {
            return c.json({ error: 'Akses ditolak. Memerlukan peran admin.' }, 403);
        }
        if (user.status === 'suspended') {
            return c.json({ error: 'Akun admin Anda di-suspend.' }, 403);
        }
        
        c.set('adminUser', { ...userPayload, role: user.role });
        await next();

    } catch (e) {
        return c.json({ error: 'Kesalahan server saat validasi admin: ' + e.message }, 500);
    }
};

// Middleware untuk cek kepemilikan proyek
export const projectOwnerMiddleware = async (c, next) => {
    const user = c.get('user');
    const projectId = c.req.param('projectId');
    
    const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ? AND user_id = ?").bind(projectId, user.sub).first();
    if (!project) {
        return c.json({ error: 'Proyek tidak ditemukan atau Anda tidak memiliki akses' }, 404);
    }
    c.set('project', project);
    await next();
};
