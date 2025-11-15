import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';
import { serveStatic } from 'hono/cloudflare-pages';

// Impor "Plugins" (Rute yang sudah dipecah dari folder /routes)
// Asumsi file-file ini ada di /functions/routes/
import adminRoutes from './routes/admin.js';
import memberRoutes from './routes/member.js';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js'; // Ini sudah termasuk /:projectId/payment-channels
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
api.route('/public', publicRoutes);
api.route('/projects', projectRoutes);
api.route('/v1', v1Routes);
api.route('/demo', demoRoutes);

// Rute yang tidak memiliki prefix (auth, hooks)
api.route('/', authRoutes); // /api/login, /api/register, /api/logout, /api/profile
api.route('/', hookRoutes); // /api/app/hook, /api/webhooks/platform-payment


// --- RUTE FILE STATIS ---
// (Ini harus di bagian akhir)
// Menyajikan file dari /public (index.html, admin.html, member.html, dll)
app.get('*', serveStatic({ root: './' }));

// Handler untuk Cloudflare Pages
export const onRequest = handle(app);
