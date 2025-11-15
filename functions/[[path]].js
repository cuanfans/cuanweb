// functions/[[path]].js

import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';
import { serveStatic } from 'hono/cloudflare-pages';

// ... Impor semua rute API Anda ...
import adminRoutes from './routes/admin.js';
import memberRoutes from './routes/member.js';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import v1Routes from './routes/v1.js';
import hookRoutes from './routes/hooks.js';
import demoRoutes from './routes/demo.js';

const app = new Hono();
const api = app.basePath('/api');

// ... Semua pendaftaran api.route(...) Anda ...
api.route('/admin', adminRoutes);
api.route('/member', memberRoutes);
api.route('/public', publicRoutes);
api.route('/projects', projectRoutes);
api.route('/v1', v1Routes);
api.route('/demo', demoRoutes);
api.route('/', authRoutes);
api.route('/', hookRoutes);


// ===== BLOK PERUTEAN SPA (KEMBALIKAN SEPERTI INI) =====
// Ini harus ada SEBELUM catch-all terakhir

app.get('/blog', serveStatic({ path: './blog.html' }));
app.get('/blog/*', serveStatic({ path: './blog.html' }));
app.get('/p/*', serveStatic({ path: './page.html' }));
// ========================================================

// --- CATCH-ALL TERAKHIR ---
app.get('*', serveStatic({ root: './' }));

export const onRequest = handle(app);
