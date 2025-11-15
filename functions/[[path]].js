import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';
// Impor 'serveStatic' dari 'hono/cloudflare-pages'
import { serveStatic } from 'hono/cloudflare-pages';

// Impor "Plugins" (Rute yang sudah dipecah dari folder /routes)
import adminRoutes from './routes/admin.js';
import memberRoutes from './routes/member.js';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import v1Routes from './routes/v1.js';
import hookRoutes from './routes/hooks.js';
import demoRoutes from './routes/demo.js';

// --- INISIALISASI HONO ---
const app = new Hono();

// --- PASANG "PLUGINS" KE RUTE UTAMA ---
const api = app.basePath('/api');

// Pasang rute-rute yang diimpor
api.route('/admin', adminRoutes);
api.route('/member', memberRoutes);
api.route('/public', publicRoutes); // API Anda tetap aman di sini
api.route('/projects', projectRoutes);
api.route('/v1', v1Routes);
api.route('/demo', demoRoutes);
api.route('/', authRoutes);
api.route('/', hookRoutes);


// ===== BLOK DIAGNOSTIK (GANTIKAN KODE LAMA ANDA DENGAN INI) =====

app.get('/blog', (c) => {
  return c.text('INI HALAMAN DAFTAR /blog');
});

app.get('/blog/*', (c) => {
  return c.text('INI HALAMAN DETAIL /blog/*'); 
});

app.get('/p/*', (c) => {
  return c.text('INI HALAMAN PAGES /p/*');
});
// ========================================================


// --- RUTE FILE STATIS ---
// (Ini harus di bagian akhir)
// 'serveStatic' ini sekarang akan menangani aset (CSS/JS/Gambar)
// dan file HTML bernama (index.html, login.html, admin.html, dll)
app.get('*', serveStatic({ root: './' }));

// Handler untuk Cloudflare Pages
export const onRequest = handle(app);
