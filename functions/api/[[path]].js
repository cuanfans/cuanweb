import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';
import { serveStatic } from 'hono/cloudflare-pages';

// ... (semua import rute API Anda: adminRoutes, dkk.) ...
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


// --- 2. RUTE HALAMAN STATIS (VERSI BARU YANG LEBIH KUAT) ---
const serveHtmlShell = async (c, shellPath) => {
  // LOG 1: Mencatat percobaan
  console.log(`Mencoba menyajikan shell: ${shellPath} untuk URL: ${c.req.url}`);
  
  const url = new URL(c.req.url);
  const assetUrl = new URL(shellPath, url.origin);
  
  // LOG 2: Mencatat aset apa yang diambil
  console.log(`URL Aset yang diambil: ${assetUrl.toString()}`);
  
  try {
    const response = await c.env.ASSETS.fetch(assetUrl);
    
    // PENANGANAN ERROR: Hentikan fall-through jika file tidak ditemukan
    if (!response.ok) {
      console.error(`Gagal mengambil aset: ${shellPath}. Status: ${response.status}`);
      return c.text(`Gagal memuat aset ${shellPath}. Status: ${response.status}`, 500);
    }
    
    // LOG 3: Berhasil
    console.log(`Berhasil mengambil aset: ${shellPath}`);
    return response;
    
  } catch (err) {
    // PENANGANAN ERROR: Hentikan fall-through jika ada error sistem
    console.error(`Error di c.env.ASSETS.fetch: ${err.message}`);
    return c.text(`Error server saat mengambil aset: ${err.message}`, 500);
  }
};

// Rute-rute ini sekarang 'async'
app.get('/blog', (c) => serveHtmlShell(c, 'blog.html'));
app.get('/blog/*', (c) => serveHtmlShell(c, 'blog.html'));
app.get('/p/*', (c) => serveHtmlShell(c, 'page.html'));


// --- 3. CATCH-ALL (TERAKHIR) ---
// Kita tambahkan log di sini untuk membuktikan jika /blog/tesblog jatuh ke sini
app.get('*', (c) => {
  console.log(`JATUH KE CATCH-ALL (*) untuk URL: ${c.req.url}`);
  // Gunakan return eksplisit di sini
  return serveStatic({ root: './' })(c);
});

export const onRequest = handle(app);
