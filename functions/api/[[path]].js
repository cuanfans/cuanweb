import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';

// Impor SEMUA rute API Anda
import adminRoutes from '../routes/admin.js'; // (Perhatikan '../' karena kita sekarang di dalam /api)
import memberRoutes from '../routes/member.js';
import publicRoutes from '../routes/public.js';
import authRoutes from '../routes/auth.js';
import projectRoutes from '../routes/projects.js';
import v1Routes from '../routes/v1.js';
import hookRoutes from '../routes/hooks.js';
import demoRoutes from '../routes/demo.js';

const app = new Hono();

// 'basePath' SANGAT PENTING agar Hono tahu bahwa 
// file ini hanya mengurus /api
const api = app.basePath('/api');

// Daftarkan semua rute API Anda
api.route('/admin', adminRoutes);
api.route('/member', memberRoutes);
api.route('/public', publicRoutes);
api.route('/projects', projectRoutes);
api.route('/v1', v1Routes);
api.route('/demo', demoRoutes);
api.route('/', authRoutes);
api.route('/', hookRoutes);

// !!! PENTING: HAPUS SEMUA rute app.get() untuk /blog, /p, dan *
// JANGAN ADA 'serveStatic' DI FILE INI LAGI

export const onRequest = handle(app);
