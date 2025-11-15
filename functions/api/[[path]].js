import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';
// Kita masih perlu 'serveStatic' untuk catch-all terakhir
import { serveStatic } from 'hono/cloudflare-pages';

// Impor semua rute API Anda (gunakan './' lagi)
import adminRoutes from './routes/admin.js';
import memberRoutes from './routes/member.js';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import v1Routes from './routes/v1.js';
import hookRoutes from './routes/hooks.js';
import demoRoutes from './routes/demo.js';

const app = new Hono();

// --- 1. RUTE API (Tidak berubah) ---
const api = app.basePath('/api');
api.route('/admin', adminRoutes);
api.route('/member', memberRoutes);
api.route('/public', publicRoutes);
api.route('/projects', projectRoutes);
api.route('/v1', v1Routes);
api.route('/demo', demoRoutes);
api.route('/', authRoutes);
api.route('/', hookRoutes);


// --- 2. RUTE HALAMAN STATIS (PENGGANTI _routes.json) ---
// Ini adalah perbaikan utamanya.
// Kita gunakan 'c.env.ASSETS.fetch' untuk menyajikan file shell.

const serveHtmlShell = (c, shellPath) => {
  const url = new URL(c.req.url);
  // Buat URL baru yang menunjuk ke file HTML shell di root
  const assetUrl = new URL(shellPath, url.origin);
  // Ambil aset (blog.html atau page.html) dan sajikan
  return c.env.ASSETS.fetch(assetUrl.toString());
};

// Saat URL adalah /blog, sajikan /blog.html
app.get('/blog', (c) => {
  return serveHtmlShell(c, '/blog.html');
});

// Saat URL adalah /blog/* (misal /blog/tesblog), sajikan /blog.html
app.get('/blog/*', (c) => {
  return serveHtmlShell(c, '/blog.html');
});

// Saat URL adalah /p/*, sajikan /page.html
app.get('/p/*', (c) => {
  return serveHtmlShell(c, '/page.html');
});


// --- 3. CATCH-ALL (TERAKHIR) ---
// Ini akan menangani /index.html, /login.html, /admin.html,
// dan semua aset lain (CSS, JS, gambar).
app.get('*', serveStatic({ root: './' }));

export const onRequest = handle(app);
