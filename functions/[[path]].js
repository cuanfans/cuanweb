import { Hono } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import { handle } from 'hono/cloudflare-pages';
import { serveStatic } from 'hono/cloudflare-pages';

// --- HELPER FUNCTIONS (Diambil dari referensi, karena logikanya solid) ---

// FUNGSI CRC16-CCITT (Poly: 0x1021, Init: 0xFFFF)
function crc16_ccitt_js(data) {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
        let byte = data.charCodeAt(i);
        let x = ((crc >> 8) ^ byte) & 0xFF;
        x ^= x >> 4;
        crc = ((crc << 8) ^ (x << 12) ^ (x << 5) ^ x) & 0xFFFF;
    }
    return crc;
}

// Mem-parsing string TLV (Tag-Length-Value)
function parseTlv_js(tlv) {
    const tags = {};
    let i = 0;
    while (i < tlv.length) {
        const tag = tlv.substring(i, i + 2);
        const lengthStr = tlv.substring(i + 2, i + 4);
        const length = parseInt(lengthStr, 10);
        const value = tlv.substring(i + 4, i + 4 + length);
        tags[tag] = value;
        i += 4 + length;
    }
    return tags;
}

// Fungsi utama: Menyuntikkan nominal ke QRIS
function injectAmountIntoQris(qrisRaw, amount) {
    if (!qrisRaw || typeof qrisRaw !== 'string') return null;
    try {
        const tags = parseTlv_js(qrisRaw);
        delete tags['63'];
        tags['53'] = '360'; // IDR
        tags['54'] = amount.toFixed(2);
        tags['58'] = 'ID';
        const sortedKeys = Object.keys(tags).sort();
        let newTlvString = '';
        for (const tag of sortedKeys) {
            const value = tags[tag];
            const lengthStr = String(value.length).padStart(2, '0');
            newTlvString += tag + lengthStr + value;
        }
        const stringToCrc = newTlvString + '6304';
        const crc = crc16_ccitt_js(stringToCrc);
        const crcHex = crc.toString(16).toUpperCase().padStart(4, '0');
        return stringToCrc + crcHex;
    } catch (e) {
        console.error("Gagal inject QRIS:", e.message);
        return null;
    }
}

// --- HELPER CRYPTO & UTILS BARU (Sesuai Skema) ---

function strToBuf(str) { return new TextEncoder().encode(str); }
function bufToHex(buffer) { return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join(''); }

async function hashPassword(password, secret) {
  // PERBAIKAN: Mengganti typo SHA-26 menjadi SHA-256
  const data = strToBuf(password + secret);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return bufToHex(hashBuffer);
}

// Menghitung detail transaksi (Kode Unik)
function calculateTransactionDetails(baseAmount) {
    const amount = parseInt(baseAmount, 10);
    const uniqueCode = Math.floor(Math.random() * 999) + 1; 
    const totalAmount = amount + uniqueCode;
    return { uniqueCode: uniqueCode, totalAmount: totalAmount, baseAmount: amount };
}

// Mencari nominal dari teks notifikasi
function parseAmountFromText(text) {
    if (!text) return null;
    const regex = /(?:Rp|IDR|sebesar)\s*([\d\.,]+)/i;
    const match = text.match(regex);
    if (match && match[1]) {
        const cleanNumber = match[1].replace(/\./g, '').replace(/,.*$/, '');
        const amount = parseInt(cleanNumber, 10);
        return isNaN(amount) ? null : amount;
    }
    return null;
}

// Helper untuk slugify
function slugify(text) {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-');
}


// --- INISIALISASI HONO ---
const app = new Hono();
const api = app.basePath('/api');

// --- MIDDLEWARE (BARU, Sesuai Skema) ---

// Middleware untuk deteksi Bahasa & Mata Uang (i18n)
const i18nMiddleware = async (c, next) => {
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
const authMiddleware = async (c, next) => {
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
const apiKeyAuthMiddleware = async (c, next) => {
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
const adminMiddleware = async (c, next) => {
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


// --- RUTE API PUBLIK (Untuk Fans / Pengunjung) ---
const pub = api.basePath('/public');

// Endpoint untuk mengambil daftar Gifts Store (Bi-lingual & Multi-mata uang)
pub.get('/gifts', i18nMiddleware, async (c) => {
    const { lang, currency } = c.get('i18n');
    
    try {
        const { results } = await c.env.DB.prepare(
            "SELECT id, name_en, name_id_lang, image_url, price_idr, price_usd_cents FROM gifts_store WHERE is_active = 1"
        ).all();

        const formattedGifts = results.map(g => ({
            id: g.id,
            name: (lang === 'id') ? g.name_id_lang : g.name_en,
            image_url: g.image_url,
            price: (currency === 'IDR') ? g.price_idr : g.price_usd_cents,
            currency: currency
        }));

        return c.json(formattedGifts);
    } catch (e) {
        return c.json({ error: 'Gagal memuat hadiah: ' + e.message }, 500);
    }
});

// Endpoint untuk membeli Gift (Step 1: Membuat Transaksi)
pub.post('/buy-gift', i18nMiddleware, async (c) => {
    const { gift_id, social_url, display_name } = await c.req.json();
    const { lang, currency, country } = c.get('i18n');
    const now = Math.floor(Date.now() / 1000);
    
    if (!gift_id || !social_url) {
        return c.json({ error: 'gift_id dan social_url wajib diisi' }, 400);
    }

    try {
        // 1. Cari atau buat Fan
        const fanId = crypto.randomUUID();
        const fan = await c.env.DB.prepare(
            `INSERT INTO fans (id, social_profile_url, display_name, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(social_profile_url) DO UPDATE SET display_name = excluded.display_name
             RETURNING id`
        ).bind(fanId, social_url, display_name || social_url, now).first();

        if (!fan) { throw new Error('Gagal membuat data fans.'); }

        // 2. Dapatkan harga Gift
        const gift = await c.env.DB.prepare(
            "SELECT price_idr, price_usd_cents FROM gifts_store WHERE id = ? AND is_active = 1"
        ).bind(gift_id).first();
        
        if (!gift) { return c.json({ error: 'Hadiah tidak ditemukan atau tidak aktif' }, 404); }

        // 3. Tentukan harga dasar dan hitung kode unik
        const baseAmount = (currency === 'IDR') ? gift.price_idr : gift.price_usd_cents;
        const { totalAmount, uniqueCode } = calculateTransactionDetails(baseAmount);

        // 4. Dapatkan Channel Pembayaran Platform (project_id = 1)
        const channel = await c.env.DB.prepare(
            `SELECT id, is_qris, qris_raw, bank_data, type 
             FROM payment_channels 
             WHERE project_id = '1' AND currency_support = ? AND is_active = 1 
             ORDER BY type ASC LIMIT 1`
        ).bind(currency).first();

        if (!channel) { return c.json({ error: `Metode pembayaran ${currency} tidak tersedia` }, 500); }

        // 5. Buat string QRIS dinamis jika perlu
        let paymentQrString = null;
        if (channel.is_qris == 1 && channel.qris_raw && currency === 'IDR') {
            paymentQrString = injectAmountIntoQris(channel.qris_raw, totalAmount);
        }
        
        const referenceId = `GIFT-${crypto.randomUUID()}`;
        const expiredAt = now + (60 * 60 * 1); // 1 jam

        // 6. Buat Transaksi (tertuju ke project_id = 1)
        const tx = await c.env.DB.prepare(
            `INSERT INTO transactions (
                id, project_id, payment_channel_id, reference_id, amount, unique_code, total_amount, currency, 
                status, customer_name, description, qr_string, expired_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNPAID', ?, ?, ?, ?, ?, ?) RETURNING id`
        ).bind(
            crypto.randomUUID(), '1', channel.id, referenceId, baseAmount, uniqueCode, totalAmount, currency,
            display_name || social_url, `Pembelian Gift ID: ${gift_id}`, paymentQrString,
            expiredAt, now, now
        ).first();

        if (!tx) { throw new Error('Gagal membuat transaksi.'); }

        // 7. Buat entri inventaris
        await c.env.DB.prepare(
            `INSERT INTO user_gift_inventory (
                id, gift_id, purchase_transaction_id, owner_fan_id, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'PENDING_PAYMENT', ?, ?)`
        ).bind(crypto.randomUUID(), gift_id, tx.id, fan.id, now, now).run();

        // 8. Kembalikan instruksi pembayaran
        return c.json({
            reference_id: referenceId,
            total_amount: totalAmount,
            currency: currency,
            payment_details: {
                type: channel.type,
                is_qris: channel.is_qris,
                qr_string: paymentQrString,
                bank_data: channel.bank_data 
            }
        });

    } catch (e) {
        return c.json({ error: 'Gagal memproses pembelian: ' + e.message }, 500);
    }
});

// Endpoint untuk redeem/klaim Gift (Mencairkan)
pub.post('/gift-claim', async (c) => {
    const { redeem_code, social_url } = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    
    if (!redeem_code || !social_url) {
        return c.json({ error: 'redeem_code dan social_url (identitas Anda) wajib diisi' }, 400);
    }

    try {
        // 1. Cari atau buat Fan
        const fanId = crypto.randomUUID();
        const fan = await c.env.DB.prepare(
            `INSERT INTO fans (id, social_profile_url, created_at)
             VALUES (?, ?, ?)
             ON CONFLICT(social_profile_url) DO NOTHING
             RETURNING id`
        ).bind(fanId, social_url, now).first();
        
        const fanQuery = await c.env.DB.prepare("SELECT id FROM fans WHERE social_profile_url = ?").bind(social_url).first();
        const finalFanId = fan ? fan.id : fanQuery.id;

        // 2. Cari atau buat Wallet untuk Fan
        const walletId = crypto.randomUUID();
        const wallet = await c.env.DB.prepare(
            `INSERT INTO wallets (id, fan_id, created_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(fan_id) DO NOTHING
             RETURNING id`
        ).bind(walletId, finalFanId, now, now).first();

        const walletQuery = await c.env.DB.prepare("SELECT id FROM wallets WHERE fan_id = ?").bind(finalFanId).first();
        const finalWalletId = wallet ? wallet.id : walletQuery.id;

        // 3. Cari Gift di inventaris
        const inventoryItem = await c.env.DB.prepare(
            `SELECT inv.id, inv.gift_id, g.redeem_value_idr, g.redeem_value_usd_cents
             FROM user_gift_inventory inv
             JOIN gifts_store g ON inv.gift_id = g.id
             WHERE inv.redeem_code = ? AND inv.status = 'OWNED'`
        ).bind(redeem_code).first();

        if (!inventoryItem) {
            return c.json({ error: 'Kode redeem tidak valid, sudah dipakai, atau gift belum dimiliki' }, 404);
        }
        
        // 4. Tentukan nilai redeem (Saat ini default ke IDR)
        // TODO: Tambahkan logika jika redeem ke USD
        const redeemAmount = inventoryItem.redeem_value_idr;
        const redeemCurrency = 'IDR';

        // 5. Eksekusi Redeem (Pindahkan ke wallet)
        await c.env.DB.batch([
            c.env.DB.prepare(
                `UPDATE user_gift_inventory 
                 SET status = 'REDEEMED', owner_fan_id = ?, updated_at = ?
                 WHERE id = ?`
            ).bind(finalFanId, now, inventoryItem.id),
            
            c.env.DB.prepare(
                `UPDATE wallets 
                 SET balance_idr = balance_idr + ?, updated_at = ?
                 WHERE id = ?`
            ).bind(redeemAmount, now, finalWalletId),

            c.env.DB.prepare(
                `INSERT INTO wallet_transactions 
                 (id, wallet_id, type, amount, currency, related_inventory_id, status, created_at)
                 VALUES (?, ?, 'REDEEM', ?, ?, ?, 'COMPLETED', ?)`
            ).bind(crypto.randomUUID(), finalWalletId, redeemAmount, redeemCurrency, inventoryItem.id, now)
        ]);
        
        return c.json({
            message: 'Klaim hadiah berhasil!',
            redeemed_amount: redeemAmount,
            currency: redeemCurrency
        });

    } catch (e) {
        return c.json({ error: 'Gagal memproses klaim: ' + e.message }, 500);
    }
});

// Rute Publik: Blog & Pages
pub.get('/blog/posts', async (c) => {
    try {
        const { results } = await c.env.DB.prepare(
            `SELECT id, title, slug, featured_image_url, published_at 
             FROM blog_posts
             WHERE status = 'published'
             ORDER BY published_at DESC`
        ).all();
        return c.json(results || []);
    } catch (e) {
        return c.json({ error: 'Gagal memuat posting: ' + e.message }, 500);
    }
});

pub.get('/blog/posts/:slug', async (c) => {
    const slug = c.req.param('slug');
    try {
        const post = await c.env.DB.prepare(
            `SELECT p.*, u.name as author_name
             FROM blog_posts p
             JOIN users u ON p.author_id = u.id
             WHERE p.slug = ? AND p.status = 'published'`
        ).bind(slug).first();
        
        if (!post) {
            return c.json({ error: 'Postingan tidak ditemukan' }, 404);
        }
        
        const { results: categories } = await c.env.DB.prepare(
            `SELECT c.name, c.slug FROM blog_categories c
             JOIN blog_post_categories pc ON c.id = pc.category_id
             WHERE pc.post_id = ?`
        ).bind(post.id).all();
        
        const { results: tags } = await c.env.DB.prepare(
            `SELECT t.name, t.slug FROM blog_tags t
             JOIN blog_post_tags pt ON t.id = pt.tag_id
             WHERE pt.post_id = ?`
        ).bind(post.id).all();

        return c.json({ ...post, categories, tags });
    } catch (e) {
        return c.json({ error: 'Gagal memuat posting: ' + e.message }, 500);
    }
});

pub.get('/pages/:slug', async (c) => {
    const slug = c.req.param('slug');
    try {
        const page = await c.env.DB.prepare(
            `SELECT title, content, template_type 
             FROM pages 
             WHERE slug = ? AND status = 'published'`
        ).bind(slug).first();
        
        if (!page) {
            return c.json({ error: 'Halaman tidak ditemukan' }, 404);
        }
        return c.json(page);
    } catch (e) {
        return c.json({ error: 'Gagal memuat halaman: ' + e.message }, 500);
    }
});

// ==========================================================
// --- RUTE API BARU: MEMBER AREA ---
// ==========================================================

// Endpoint untuk Statistik Dashboard Member
api.get('/member/stats', authMiddleware, async (c) => {
    const user = c.get('user');
    try {
        const [projects, revenueIDR, revenueUSD, gifts] = await Promise.all([
            c.env.DB.prepare("SELECT COUNT(id) as value FROM projects WHERE user_id = ?").bind(user.sub).first(),
            c.env.DB.prepare("SELECT SUM(t.total_amount) as value FROM transactions t JOIN projects p ON t.project_id = p.id WHERE p.user_id = ? AND t.status = 'PAID' AND t.currency = 'IDR'").bind(user.sub).first(),
            c.env.DB.prepare("SELECT SUM(t.total_amount) as value FROM transactions t JOIN projects p ON t.project_id = p.id WHERE p.user_id = ? AND t.status = 'PAID' AND t.currency = 'USD'").bind(user.sub).first(),
            c.env.DB.prepare("SELECT COUNT(id) as value FROM user_gift_inventory WHERE owner_user_id = ? AND status = 'OWNED'").bind(user.sub).first()
        ]);
        return c.json({
            total_projects: projects.value || 0,
            total_revenue_idr: revenueIDR.value || 0,
            total_revenue_usd: revenueUSD.value || 0,
            total_gifts_owned: gifts.value || 0
        });
    } catch (e) {
        return c.json({ error: 'Gagal memuat statistik member: ' + e.message }, 500);
    }
});

// Endpoint untuk Transaksi Member (BYOG)
api.get('/transactions', authMiddleware, async (c) => {
    const user = c.get('user');
    const { project_id, status } = c.req.query();
    
    let query = `
        SELECT t.id, t.reference_id, t.total_amount, t.currency, t.status, t.created_at, p.name as project_name
        FROM transactions t
        JOIN projects p ON t.project_id = p.id
        WHERE p.user_id = ?
    `;
    const params = [user.sub];

    if (project_id) {
        query += " AND t.project_id = ?";
        params.push(project_id);
    }
    if (status) {
        query += " AND t.status = ?";
        params.push(status.toUpperCase());
    }
    query += " ORDER BY t.created_at DESC LIMIT 50";

    try {
        const { results } = await c.env.DB.prepare(query).bind(...params).all();
        return c.json(results || []);
    } catch (e) {
        return c.json({ error: 'Gagal memuat transaksi: ' + e.message }, 500);
    }
});

// Endpoint untuk Wallet Member
api.get('/wallets', authMiddleware, async (c) => {
    const user = c.get('user');
    try {
        const wallet = await c.env.DB.prepare(
            "SELECT balance_idr, balance_usd_cents FROM wallets WHERE user_id = ?"
        ).bind(user.sub).first();
        
        if (!wallet) {
            return c.json({ balance_idr: 0, balance_usd_cents: 0 });
        }
        return c.json(wallet);
    } catch (e) {
        return c.json({ error: 'Gagal memuat wallet: ' + e.message }, 500);
    }
});

// Endpoint untuk Histori Transaksi Wallet Member
api.get('/wallets/transactions', authMiddleware, async (c) => {
    const user = c.get('user');
    try {
        const { results } = await c.env.DB.prepare(
            `SELECT wt.type, wt.amount, wt.currency, wt.status, wt.created_at 
             FROM wallet_transactions wt
             JOIN wallets w ON wt.wallet_id = w.id
             WHERE w.user_id = ? 
             ORDER BY wt.created_at DESC LIMIT 50`
        ).bind(user.sub).all();
        return c.json(results || []);
    } catch (e) {
        return c.json({ error: 'Gagal memuat histori wallet: ' + e.message }, 500);
    }
});

// Endpoint untuk Inventaris Gift Member
api.get('/gifts/inventory', authMiddleware, async (c) => {
    const user = c.get('user');
    try {
        const { results } = await c.env.DB.prepare(
            `SELECT inv.id, inv.status, inv.redeem_code, g.name_id_lang, g.name_en, g.image_url 
             FROM user_gift_inventory inv
             JOIN gifts_store g ON inv.gift_id = g.id
             WHERE inv.owner_user_id = ?
             ORDER BY inv.created_at DESC`
        ).bind(user.sub).all();
        return c.json(results || []);
    } catch (e) {
        return c.json({ error: 'Gagal memuat inventaris gift: ' + e.message }, 500);
    }
});

// Endpoint untuk Generate Kode Redeem
api.post('/gifts/generate-redeem', authMiddleware, async (c) => {
    const user = c.get('user');
    const { inventory_id } = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    
    if (!inventory_id) return c.json({ error: 'inventory_id wajib diisi' }, 400);

    try {
        const item = await c.env.DB.prepare(
            "SELECT id, status FROM user_gift_inventory WHERE id = ? AND owner_user_id = ?"
        ).bind(inventory_id, user.sub).first();

        if (!item) {
            return c.json({ error: 'Item gift tidak ditemukan atau bukan milik Anda' }, 404);
        }
        if (item.status !== 'OWNED') {
            return c.json({ error: 'Hanya gift dengan status OWNED yang bisa dibuatkan kode' }, 400);
        }
        
        const newRedeemCode = `CF-${crypto.randomUUID().substring(0, 8).toUpperCase()}`;
        
        await c.env.DB.prepare(
            "UPDATE user_gift_inventory SET redeem_code = ?, updated_at = ? WHERE id = ?"
        ).bind(newRedeemCode, now, inventory_id).run();

        return c.json({ message: 'Kode redeem berhasil dibuat!', redeem_code: newRedeemCode });
    } catch (e) {
        if (e.message.includes('UNIQUE constraint failed')) {
            return c.json({ error: 'Gagal membuat kode unik, silakan coba lagi.' }, 500);
        }
        return c.json({ error: 'Gagal membuat kode redeem: ' + e.message }, 500);
    }
});
// --- RUTE API KREATOR (Dashboard & BYOG) ---

// Endpoint Autentikasi Kreator
api.post('/register', async (c) => {
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    
    if (!body.email || !body.password || !body.name) {
      return c.json({ error: 'Nama, email, dan password wajib diisi' }, 400);
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

api.post('/login', async (c) => {
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
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24)
  };
  const token = await sign(payload, c.env.JWT_SECRET);
  
  setCookie(c, 'auth_token', token, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge: 60 * 60 * 24 });
  return c.json({ message: 'Login berhasil!', role: user.role });
});

api.get('/logout', (c) => {
  setCookie(c, 'auth_token', '', { path: '/', maxAge: 0 });
  return c.redirect('/'); 
});

api.get('/profile', authMiddleware, async (c) => { 
  const userPayload = c.get('user');
  const user = await c.env.DB.prepare(
      "SELECT id, email, name, api_key, role, status, country_code, default_currency, created_at FROM users WHERE id = ?"
  ).bind(userPayload.sub).first();
  if (!user) { return c.json({ error: 'Pengguna tidak ditemukan' }, 404); }
  return c.json(user);
});

// --- RUTE API KREATOR: CRUD Projects (BYOG) ---
const projectsApi = api.basePath('/projects');
projectsApi.use('*', authMiddleware);

projectsApi.get('/', async (c) => {
    const user = c.get('user');
    try {
        const { results } = await c.env.DB.prepare(
            "SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC"
        ).bind(user.sub).all();
        return c.json(results || []);
    } catch (e) {
        return c.json({ error: 'Gagal memuat proyek: ' + e.message }, 500);
    }
});

projectsApi.post('/', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    if (!body.name) { return c.json({ error: 'Nama proyek wajib diisi' }, 400); }
    
    try {
        const newProjectId = crypto.randomUUID();
        const newCallbackToken = crypto.randomUUID();
        const newProject = await c.env.DB.prepare(
            `INSERT INTO projects (id, user_id, name, domain, description, webhook_url, callback_token, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
        ).bind(
            newProjectId, user.sub, body.name, body.domain || null, body.description || null, 
            body.webhook_url || null, newCallbackToken, now, now
        ).first();
        
        return c.json({ message: 'Proyek berhasil dibuat', project: newProject }, 201);
    } catch (e) {
        return c.json({ error: 'Gagal membuat proyek: ' + e.message }, 500);
    }
});

projectsApi.get('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    try {
        const project = await c.env.DB.prepare(
            "SELECT * FROM projects WHERE id = ? AND user_id = ?"
        ).bind(id, user.sub).first();
        if (!project) { return c.json({ error: 'Proyek tidak ditemukan' }, 404); }
        return c.json(project);
    } catch (e) {
        return c.json({ error: 'Gagal memuat proyek: ' + e.message }, 500);
    }
});

projectsApi.put('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    if (!body.name) { return c.json({ error: 'Nama proyek wajib diisi' }, 400); }
    
    try {
        const updatedProject = await c.env.DB.prepare(
            `UPDATE projects 
             SET name = ?, domain = ?, description = ?, webhook_url = ?, updated_at = ?
             WHERE id = ? AND user_id = ? RETURNING *`
        ).bind(
            body.name, body.domain || null, body.description || null, 
            body.webhook_url || null, now, id, user.sub
        ).first();
        
        if (!updatedProject) { return c.json({ error: 'Proyek tidak ditemukan' }, 404); }
        return c.json({ message: 'Proyek berhasil diperbarui', project: updatedProject });
    } catch (e) {
        return c.json({ error: 'Gagal memperbarui proyek: ' + e.message }, 500);
    }
});

projectsApi.delete('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    try {
        await c.env.DB.prepare(
            "DELETE FROM projects WHERE id = ? AND user_id = ?"
        ).bind(id, user.sub).run();
        return c.json({ message: 'Proyek berhasil dihapus' });
    } catch (e) {
        return c.json({ error: 'Gagal menghapus proyek: ' + e.message }, 500);
    }
});


// --- RUTE API KREATOR: CRUD Payment Channels (BYOG) ---
const channelsApi = projectsApi.basePath('/:projectId/payment-channels');

// Middleware untuk cek kepemilikan proyek
const projectOwnerMiddleware = async (c, next) => {
    const user = c.get('user');
    const projectId = c.req.param('projectId');
    
    const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ? AND user_id = ?").bind(projectId, user.sub).first();
    if (!project) {
        return c.json({ error: 'Proyek tidak ditemukan atau Anda tidak memiliki akses' }, 404);
    }
    c.set('project', project);
    await next();
};

channelsApi.use('*', projectOwnerMiddleware);

channelsApi.get('/', async (c) => {
    const projectId = c.req.param('projectId');
    try {
        const { results } = await c.env.DB.prepare(
            "SELECT * FROM payment_channels WHERE project_id = ? ORDER BY created_at DESC"
        ).bind(projectId).all();
        return c.json(results || []);
    } catch (e) {
        return c.json({ error: 'Gagal memuat channel: ' + e.message }, 500);
    }
});

channelsApi.post('/', async (c) => {
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);

    if (!body.name || !body.type || !body.currency_support) {
        return c.json({ error: 'Nama, Tipe, dan Mata Uang (currency_support) wajib diisi.' }, 400);
    }
    
    try {
        const newChannelId = crypto.randomUUID();
        const newCode = `${body.type.toUpperCase()}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        
        const newChannel = await c.env.DB.prepare(
            `INSERT INTO payment_channels (
                id, project_id, code, name, type, is_qris, qris_raw, bank_data, 
                android_package, icon_url, currency_support, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
        ).bind(
            newChannelId, projectId, newCode, body.name, body.type, body.is_qris || 0, body.qris_raw || null,
            body.bank_data ? JSON.stringify(body.bank_data) : null, body.android_package || null,
            body.icon_url || null, body.currency_support, 1, now, now
        ).first();
        
        return c.json({ message: 'Channel pembayaran berhasil dibuat', channel: newChannel }, 201);
    } catch (e) {
        return c.json({ error: 'Gagal membuat channel: ' + e.message }, 500);
    }
});

channelsApi.put('/:channelId', async (c) => {
    const { projectId, channelId } = c.req.param();
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);

    if (!body.name) { return c.json({ error: 'Nama wajib diisi' }, 400); }
    
    try {
        const updatedChannel = await c.env.DB.prepare(
            `UPDATE payment_channels SET
             name = ?, type = ?, is_qris = ?, qris_raw = ?, bank_data = ?, android_package = ?, 
             icon_url = ?, currency_support = ?, is_active = ?, updated_at = ?
             WHERE id = ? AND project_id = ? RETURNING *`
        ).bind(
            body.name, body.type, body.is_qris || 0, body.qris_raw || null,
            body.bank_data ? JSON.stringify(body.bank_data) : null, body.android_package || null,
            body.icon_url || null, body.currency_support, body.is_active, now,
            channelId, projectId
        ).first();

        if (!updatedChannel) { return c.json({ error: 'Channel tidak ditemukan' }, 404); }
        return c.json({ message: 'Channel berhasil diperbarui', channel: updatedChannel });
    } catch (e) {
        return c.json({ error: 'Gagal memperbarui channel: ' + e.message }, 500);
    }
});

channelsApi.delete('/:channelId', async (c) => {
    const { projectId, channelId } = c.req.param();
    try {
        await c.env.DB.prepare(
            "DELETE FROM payment_channels WHERE id = ? AND project_id = ?"
        ).bind(channelId, projectId).run();
        return c.json({ message: 'Channel berhasil dihapus' });
    } catch (e) {
        return c.json({ error: 'Gagal menghapus channel: ' + e.message }, 500);
    }
});


// ==========================================================
// --- RUTE API BARU: ADMIN AREA ---
// ==========================================================
const admin = api.basePath('/admin');
admin.use('*', authMiddleware, adminMiddleware);

// Endpoint untuk Statistik Dashboard
admin.get('/stats', async (c) => {
    try {
        const [users, revenueIDR, revenueUSD, giftsRedeemed] = await Promise.all([
            c.env.DB.prepare("SELECT COUNT(id) as value FROM users").first(),
            c.env.DB.prepare("SELECT SUM(total_amount) as value FROM transactions WHERE status = 'PAID' AND currency = 'IDR'").first(),
            c.env.DB.prepare("SELECT SUM(total_amount) as value FROM transactions WHERE status = 'PAID' AND currency = 'USD'").first(),
            c.env.DB.prepare("SELECT COUNT(id) as value FROM user_gift_inventory WHERE status = 'REDEEMED'").first()
        ]);
        return c.json({
            totalUsers: users.value || 0,
            revenueIdr: revenueIDR.value || 0,
            revenueUsd: revenueUSD.value || 0,
            giftsRedeemed: giftsRedeemed.value || 0
        });
    } catch (e) {
        return c.json({ error: 'Gagal memuat statistik: ' + e.message }, 500);
    }
});

// CRUD Pengaturan
admin.get('/settings', async (c) => {
    try {
        const { results } = await c.env.DB.prepare("SELECT key, value FROM admin_settings").all();
        const settings = results.reduce((acc, row) => {
            acc[row.key] = row.value;
            return acc;
        }, {});
        return c.json(settings);
    } catch (e) {
        return c.json({ error: 'Gagal memuat pengaturan: ' + e.message }, 500);
    }
});

admin.post('/settings', async (c) => {
    const body = await c.req.json();
    try {
        const statements = Object.entries(body).map(([key, value]) => 
            c.env.DB.prepare("UPDATE admin_settings SET value = ? WHERE key = ?").bind(String(value), key)
        );
        await c.env.DB.batch(statements);
        return c.json({ message: 'Pengaturan berhasil disimpan' });
    } catch (e) {
        return c.json({ error: 'Gagal menyimpan pengaturan: ' + e.message }, 500);
    }
});

// CRUD Users
admin.get('/users', async (c) => {
    try {
        const { results } = await c.env.DB.prepare(
            "SELECT id, email, name, role, status FROM users ORDER BY created_at DESC"
        ).all();
        return c.json(results || []);
    } catch (e) {
        return c.json({ error: 'Gagal memuat pengguna: ' + e.message }, 500);
    }
});

admin.put('/users/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const validRoles = ['admin', 'member'];
    const validStatuses = ['active', 'suspended'];
    
    if (!validRoles.includes(body.role) || !validStatuses.includes(body.status)) {
        return c.json({ error: 'Role atau Status tidak valid' }, 400);
    }
    
    try {
        await c.env.DB.prepare(
            "UPDATE users SET role = ?, status = ? WHERE id = ?"
        ).bind(body.role, body.status, id).run();
        return c.json({ message: 'User berhasil diperbarui' });
    } catch (e) {
        return c.json({ error: 'Gagal memperbarui user: ' + e.message }, 500);
    }
});

// CRUD Platform Payment Channels (project_id = 1)
admin.get('/platform-channels', async (c) => {
    try {
        const { results } = await c.env.DB.prepare(
            "SELECT * FROM payment_channels WHERE project_id = '1' ORDER BY created_at DESC"
        ).all();
        return c.json(results || []);
    } catch (e) {
        return c.json({ error: 'Gagal memuat channel platform: ' + e.message }, 500);
    }
});
// (Gunakan logic yang sama dari `channelsApi` untuk POST, PUT, DELETE, tapi hardcode project_id = '1')

// --- ADMIN: CRUD Gifts Store ---
const adminGifts = admin.basePath('/gifts-store');

adminGifts.get('/', async (c) => {
    try {
        const { results } = await c.env.DB.prepare("SELECT * FROM gifts_store ORDER BY price_idr ASC").all();
        return c.json(results || []);
    } catch (e) {
        return c.json({ error: 'Gagal memuat gifts: ' + e.message }, 500);
    }
});

adminGifts.post('/', async (c) => {
    const body = await c.req.json();
    try {
        await c.env.DB.prepare(
            `INSERT INTO gifts_store (id, name_id, name_en, name_id_lang, image_url, price_idr, price_usd_cents, redeem_value_idr, redeem_value_usd_cents, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            crypto.randomUUID(), body.name_id, body.name_en, body.name_id_lang, body.image_url,
            body.price_idr, body.price_usd_cents, body.redeem_value_idr, body.redeem_value_usd_cents,
            body.is_active
        ).run();
        return c.json({ message: 'Gift berhasil dibuat' }, 201);
    } catch (e) {
        return c.json({ error: 'Gagal membuat gift: ' + e.message }, 500);
    }
});

adminGifts.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    try {
        await c.env.DB.prepare(
            `UPDATE gifts_store SET 
             name_id = ?, name_en = ?, name_id_lang = ?, image_url = ?, 
             price_idr = ?, price_usd_cents = ?, redeem_value_idr = ?, redeem_value_usd_cents = ?, 
             is_active = ?
             WHERE id = ?`
        ).bind(
            body.name_id, body.name_en, body.name_id_lang, body.image_url,
            body.price_idr, body.price_usd_cents, body.redeem_value_idr, body.redeem_value_usd_cents,
            body.is_active, id
        ).run();
        return c.json({ message: 'Gift berhasil diperbarui' });
    } catch (e) {
        return c.json({ error: 'Gagal memperbarui gift: ' + e.message }, 500);
    }
});

adminGifts.delete('/:id', async (c) => {
    const id = c.req.param('id');
    try {
        await c.env.DB.prepare("DELETE FROM gifts_store WHERE id = ?").bind(id).run();
        return c.json({ message: 'Gift berhasil dihapus' });
    } catch (e) {
        return c.json({ error: 'Gagal menghapus gift: ' + e.message }, 500);
    }
});


// --- ADMIN: CRUD Blog ---
const adminBlog = admin.basePath('/blog');

// Kategori
adminBlog.get('/categories', async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM blog_categories ORDER BY name ASC").all();
    return c.json(results || []);
});
adminBlog.post('/categories', async (c) => {
    const { name } = await c.req.json();
    const slug = slugify(name);
    try {
        await c.env.DB.prepare("INSERT INTO blog_categories (id, name, slug) VALUES (?, ?, ?)")
            .bind(crypto.randomUUID(), name, slug).run();
        return c.json({ message: 'Kategori dibuat' }, 201);
    } catch (e) { return c.json({ error: e.message }, 500); }
});
// (Tambahkan PUT dan DELETE untuk Kategori)

// Tags
adminBlog.get('/tags', async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM blog_tags ORDER BY name ASC").all();
    return c.json(results || []);
});
adminBlog.post('/tags', async (c) => {
    const { name } = await c.req.json();
    const slug = slugify(name);
    try {
        await c.env.DB.prepare("INSERT INTO blog_tags (id, name, slug) VALUES (?, ?, ?)")
            .bind(crypto.randomUUID(), name, slug).run();
        return c.json({ message: 'Tag dibuat' }, 201);
    } catch (e) { return c.json({ error: e.message }, 500); }
});
// (Tambahkan PUT dan DELETE untuk Tags)

// Posts
adminBlog.get('/posts', async (c) => {
    try {
        const { results } = await c.env.DB.prepare(
            `SELECT id, title, slug, status, published_at FROM blog_posts ORDER BY created_at DESC`
        ).all();
        return c.json(results || []);
    } catch (e) { return c.json({ error: e.message }, 500); }
});

adminBlog.get('/posts/:id', async (c) => {
    const id = c.req.param('id');
    try {
        const post = await c.env.DB.prepare("SELECT * FROM blog_posts WHERE id = ?").bind(id).first();
        if (!post) return c.json({ error: 'Postingan tidak ditemukan' }, 404);
        // Ambil kategori dan tag
        return c.json(post);
    } catch (e) { return c.json({ error: e.message }, 500); }
});

adminBlog.post('/posts', async (c) => {
    const adminUser = c.get('adminUser');
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    const postId = crypto.randomUUID();
    
    try {
        await c.env.DB.prepare(
            `INSERT INTO blog_posts (id, author_id, title, slug, content, featured_image_url, status, created_at, updated_at, published_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            postId, adminUser.sub, body.title, body.slug || slugify(body.title), 
            body.content, body.featured_image_url, body.status,
            now, now, (body.status === 'published') ? now : null
        ).run();
        
        // TODO: Handle categories dan tags (memerlukan batch DML)
        
        return c.json({ message: 'Postingan berhasil dibuat', id: postId }, 201);
    } catch (e) { return c.json({ error: e.message }, 500); }
});

adminBlog.put('/posts/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    
    try {
        await c.env.DB.prepare(
            `UPDATE blog_posts SET 
             title = ?, slug = ?, content = ?, featured_image_url = ?, status = ?, 
             updated_at = ?, published_at = COALESCE(published_at, ?)
             WHERE id = ?`
        ).bind(
            body.title, body.slug || slugify(body.title), body.content, 
            body.featured_image_url, body.status, now,
            (body.status === 'published') ? now : null,
            id
        ).run();
        
        // TODO: Handle update categories dan tags
        
        return c.json({ message: 'Postingan berhasil diperbarui' });
    } catch (e) { return c.json({ error: e.message }, 500); }
});

adminBlog.delete('/posts/:id', async (c) => {
    const id = c.req.param('id');
    try {
        await c.env.DB.prepare("DELETE FROM blog_posts WHERE id = ?").bind(id).run();
        return c.json({ message: 'Postingan berhasil dihapus' });
    } catch (e) { return c.json({ error: e.message }, 500); }
});

// --- ADMIN: CRUD Pages ---
const adminPages = admin.basePath('/pages');

adminPages.get('/', async (c) => {
    const { results } = await c.env.DB.prepare("SELECT id, title, slug, template_type, status FROM pages ORDER BY created_at DESC").all();
    return c.json(results || []);
});

adminPages.post('/', async (c) => {
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    try {
        await c.env.DB.prepare(
            `INSERT INTO pages (id, title, slug, content, template_type, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            crypto.randomUUID(), body.title, body.slug || slugify(body.title), 
            body.content, body.template_type, body.status, now, now
        ).run();
        return c.json({ message: 'Halaman dibuat' }, 201);
    } catch (e) { return c.json({ error: e.message }, 500); }
});

adminPages.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    try {
        await c.env.DB.prepare(
            `UPDATE pages SET 
             title = ?, slug = ?, content = ?, template_type = ?, status = ?, updated_at = ?
             WHERE id = ?`
        ).bind(
            body.title, body.slug || slugify(body.title), body.content, 
            body.template_type, body.status, now, id
        ).run();
        return c.json({ message: 'Halaman diperbarui' });
    } catch (e) { return c.json({ error: e.message }, 500); }
});

adminPages.delete('/:id', async (c) => {
    const id = c.req.param('id');
    try {
        await c.env.DB.prepare("DELETE FROM pages WHERE id = ?").bind(id).run();
        return c.json({ message: 'Halaman dihapus' });
    } catch (e) { return c.json({ error: e.message }, 500); }
});


// --- RUTE API V1 (Otentikasi API Key) ---
const v1 = api.basePath('/v1');

// Endpoint V1 untuk Kreator membuat transaksi (BYOG)
v1.post('/transactions', apiKeyAuthMiddleware, async (c) => {
    const user = c.get('user'); // Didapat dari API Key
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);

    // 1. Validasi input
    if (!body.project_id || !body.payment_channel_id || !body.amount) {
        return c.json({ error: 'project_id, payment_channel_id (array), dan amount wajib diisi.' }, 400);
    }
    if (!Array.isArray(body.payment_channel_id) || body.payment_channel_id.length === 0) {
        return c.json({ error: 'payment_channel_id harus berupa array dan tidak boleh kosong.' }, 400);
    }

    try {
        // 2. Verifikasi kepemilikan Proyek
        const project = await c.env.DB.prepare(
            "SELECT id, webhook_url, callback_token FROM projects WHERE id = ? AND user_id = ?"
        ).bind(body.project_id, user.sub).first();
        if (!project) {
            return c.json({ error: 'Proyek tidak ditemukan atau Anda tidak memiliki akses.' }, 403);
        }
        
        // 3. Verifikasi kepemilikan semua Channel
        const placeholders = body.payment_channel_id.map(() => '?').join(',');
        const channelQuery = `
            SELECT id, name, is_qris, qris_raw, bank_data, currency_support 
            FROM payment_channels 
            WHERE id IN (${placeholders}) AND project_id = ? AND is_active = 1
        `;
        const channelParams = [...body.payment_channel_id, body.project_id];
        const { results: channels } = await c.env.DB.prepare(channelQuery).bind(...channelParams).all();
        
        if (channels.length !== body.payment_channel_id.length) {
             return c.json({ error: 'Satu atau lebih payment_channel_id tidak valid.' }, 404);
        }

        // 4. Hitung nominal unik (ANGKA BULAT)
        const { totalAmount, uniqueCode, baseAmount } = calculateTransactionDetails(body.amount);
        const referenceId = `PAY-${crypto.randomUUID()}`;
        const expiredAt = now + (60 * 60 * 24); // 24 jam
        
        let firstQrString = null;
        let paymentCurrency = 'IDR'; // Default

        const paymentChannelDetails = channels.map(channel => {
            let qris_raw_with_amount = null;
            paymentCurrency = channel.currency_support; // Ambil mata uang dari channel

            if (channel.is_qris == 1 && channel.qris_raw) {
                qris_raw_with_amount = injectAmountIntoQris(channel.qris_raw, totalAmount);
                if (!firstQrString) {
                    firstQrString = qris_raw_with_amount;
                }
            }

            return {
                id: channel.id,
                name: channel.name,
                is_qris: channel.is_qris,
                payment_details: {
                    qris_raw: qris_raw_with_amount,
                    bank_data: channel.bank_data
                }
            };
        });
        
        // 5. Simpan transaksi
        const primary_channel_id = body.payment_channel_id[0];
        
        const tx = await c.env.DB.prepare(
            `INSERT INTO transactions (
                id, project_id, payment_channel_id, reference_id, amount, unique_code, total_amount, currency, status,
                customer_name, customer_email, customer_phone, description, external_reference, 
                expired_at, created_at, updated_at, qr_string
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNPAID', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            crypto.randomUUID(), body.project_id, primary_channel_id, referenceId,
            baseAmount, uniqueCode, totalAmount, paymentCurrency,
            body.customer_name || null, body.customer_email || null, body.customer_phone || null,
            body.description || null, body.internal_ref_id || null,
            expiredAt, now, now, firstQrString
        ).run();

        // 6. Kembalikan instruksi pembayaran
        return c.json({
            success: true,
            transaction_id: tx.lastRowId, // Mungkin perlu UUID, tergantung D1
            reference_id: referenceId, 
            total_amount_expected: totalAmount, 
            unique_code: uniqueCode,
            payment_channels: paymentChannelDetails,
            expired_at: expiredAt
        }, 201);

    } catch (e) {
        return c.json({ error: 'Terjadi kesalahan internal: ' + e.message }, 500);
    }
});


// --- RUTE WEBHOOKS / HOOKS ---

// Hook untuk Aplikasi Android Kreator (BYOG)
api.post('/app/hook', apiKeyAuthMiddleware, async (c) => {
    const user = c.get('user'); 
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);

    if (!body.text) { return c.json({ error: 'text wajib diisi.' }, 400); }
    const amount = parseAmountFromText(body.text);
    if (!amount) { return c.json({ error: 'Nominal tidak ditemukan dalam teks notifikasi.' }, 400); }

    try {
        const transaction = await c.env.DB.prepare(
            `SELECT t.id, t.project_id, p.webhook_url, p.callback_token, t.metadata
             FROM transactions t
             JOIN projects p ON t.project_id = p.id
             WHERE p.user_id = ? 
               AND t.total_amount = ? 
               AND t.status = 'UNPAID' 
               AND t.expired_at > ?`
        ).bind(user.sub, amount, now).first(); 

        if (!transaction) {
            return c.json({ error: 'Transaksi UNPAID (milik Anda) dengan nominal ' + amount + ' tidak ditemukan.' }, 404);
        }

        await c.env.DB.prepare(
            "UPDATE transactions SET status = 'PAID', paid_at = ? WHERE id = ?"
        ).bind(now, transaction.id).run();

        // (Logika aktivasi langganan jika ada) ...

        if (transaction.webhook_url && transaction.callback_token) {
            const fullTransaction = await c.env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(transaction.id).first();
            const payload = { event: 'payment.success', data: fullTransaction };
            
            const webhookPromise = fetch(transaction.webhook_url, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${transaction.callback_token}`
                },
                body: JSON.stringify(payload)
            }).then(async (res) => {
                if (!res.ok) {
                    console.error(`Webhook Gagal (Status ${res.status}): ${transaction.webhook_url}`);
                }
            }).catch(e => {
                console.error(`Webhook Error Jaringan: ${e.message}`);
            });
            c.executionCtx.waitUntil(webhookPromise);
        }

        return c.json({ message: 'Pembayaran berhasil divalidasi.', transaction_id: transaction.id, amount: amount });
    } catch (e) {
        return c.json({ error: 'Kesalahan internal saat memproses hook: ' + e.message }, 500);
    }
});

// Webhook untuk Pembayaran Platform (Gifts Store)
api.post('/webhooks/platform-payment', async (c) => {
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    
    // (Contoh: Ambil reference_id dari body webhook)
    const referenceId = body.reference_id; // Sesuaikan dengan payload webhook
    
    // (Tambahkan validasi HMAC/IPN Secret di sini!)
    
    try {
        const tx = await c.env.DB.prepare(
            "SELECT id, project_id FROM transactions WHERE reference_id = ? AND status = 'UNPAID' AND project_id = '1'"
        ).bind(referenceId).first();

        if (!tx) {
            return c.json({ error: 'Transaksi platform tidak ditemukan atau sudah dibayar' }, 404);
        }

        await c.env.DB.batch([
            c.env.DB.prepare(
                "UPDATE transactions SET status = 'PAID', paid_at = ? WHERE id = ?"
            ).bind(now, tx.id),
            
            c.env.DB.prepare(
                "UPDATE user_gift_inventory SET status = 'OWNED', updated_at = ? WHERE purchase_transaction_id = ?"
            ).bind(now, tx.id)
        ]);
        
        return c.json({ message: 'Pembayaran gift dikonfirmasi' });

    } catch (e) {
        return c.json({ error: 'Gagal memproses webhook platform: ' + e.message }, 500);
    }
});


// --- RUTE FILE STATIS ---
// (Ini harus di bagian akhir)
app.get('*', serveStatic({ root: './' }));

export const onRequest = handle(app);
