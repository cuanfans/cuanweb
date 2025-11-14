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
        // (Ini mengasumsikan '1' adalah ID proyek Admin/Platform)
        const channel = await c.env.DB.prepare(
            `SELECT id, is_qris, qris_raw, bank_data, type 
             FROM payment_channels 
             WHERE project_id = '1' AND currency_support = ? AND is_active = 1 
             ORDER BY type ASC LIMIT 1` // Prioritaskan QRIS/Bank dulu
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
        
        const finalFanId = fan ? fan.id : (await c.env.DB.prepare("SELECT id FROM fans WHERE social_profile_url = ?").bind(social_url).first()).id;

        // 2. Cari atau buat Wallet untuk Fan
        const walletId = crypto.randomUUID();
        const wallet = await c.env.DB.prepare(
            `INSERT INTO wallets (id, fan_id, created_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(fan_id) DO NOTHING
             RETURNING id`
        ).bind(walletId, finalFanId, now, now).first();

        const finalWalletId = wallet ? wallet.id : (await c.env.DB.prepare("SELECT id FROM wallets WHERE fan_id = ?").bind(finalFanId).first()).id;

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
            // Tandai gift sebagai terpakai
            c.env.DB.prepare(
                `UPDATE user_gift_inventory 
                 SET status = 'REDEEMED', owner_fan_id = ?, updated_at = ?
                 WHERE id = ?`
            ).bind(finalFanId, now, inventoryItem.id),
            
            // Tambahkan saldo ke wallet
            c.env.DB.prepare(
                `UPDATE wallets 
                 SET balance_idr = balance_idr + ?, updated_at = ?
                 WHERE id = ?`
            ).bind(redeemAmount, now, finalWalletId),

            // Catat di histori wallet
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


// --- RUTE API KREATOR (Dashboard & BYOG) ---

// Endpoint Autentikasi Kreator
api.post('/register', async (c) => {
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    
    if (!body.email || !body.password || !body.name) {
      return c.json({ error: 'Nama, email, dan password wajib diisi' }, 400);
    }
    
    // Deteksi negara dari IP
    const country = c.req.header('cf-ipcountry') || 'ID';
    const currency = (country === 'ID') ? 'IDR' : 'USD';
    
    try {
        const password_hash = await hashPassword(body.password, c.env.JWT_SECRET);
        const newUserId = crypto.randomUUID();
        const newApiKey = crypto.randomUUID();
        const newWalletId = crypto.randomUUID();

        // Batch insert User dan Wallet
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

        // Ambil data user baru untuk dikembalikan
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
  
  const payload = { sub: user.id, email: user.email, name: user.name, role: user.role, status: user.status, exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24) }; // 1 hari
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

// Endpoint untuk Kreator mengelola Proyek (BYOG)
api.get('/projects', authMiddleware, async (c) => {
    // ... Logika untuk mengambil proyek (Mirip referensi) ...
    // SELECT * FROM projects WHERE user_id = ?
    return c.json({ message: "TODO: Daftar proyek" });
});

api.post('/projects', authMiddleware, async (c) => {
    // ... Logika untuk membuat proyek (Mirip referensi) ...
    // INSERT INTO projects ...
    return c.json({ message: "TODO: Buat proyek" });
});

api.get('/projects/:id/payment-channels', authMiddleware, async (c) => {
    // ... Logika untuk mengambil channel (Mirip referensi) ...
    // SELECT * FROM payment_channels WHERE project_id = ?
    return c.json({ message: "TODO: Daftar channel" });
});

api.post('/projects/:id/payment-channels', authMiddleware, async (c) => {
    // ... Logika untuk membuat channel (Mirip referensi) ...
    // INSERT INTO payment_channels ...
    return c.json({ message: "TODO: Buat channel" });
});


// --- RUTE API V1 (Otentikasi API Key) ---
const v1 = api.basePath('/v1');

// Endpoint V1 untuk Kreator membuat transaksi (BYOG)
v1.post('/transactions', apiKeyAuthMiddleware, async (c) => {
    // ... Logika ini bisa diambil dari referensi (Rute 30) ...
    // Ini adalah inti dari fitur BYOG Anda
    return c.json({ message: "TODO: Implementasi V1 Create Transaction (BYOG)" });
});


// --- RUTE WEBHOOKS / HOOKS ---

// Hook untuk Aplikasi Android Kreator (BYOG)
// Logika ini sama persis dengan referensi Anda, karena tujuannya sama
api.post('/app/hook', apiKeyAuthMiddleware, async (c) => {
    const user = c.get('user'); 
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);

    if (!body.text) { return c.json({ error: 'text wajib diisi.' }, 400); }
    const amount = parseAmountFromText(body.text);
    if (!amount) { return c.json({ error: 'Nominal tidak ditemukan dalam teks notifikasi.' }, 400); }

    try {
        // Cari transaksi UNPAID milik user (Kreator) yang cocok
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

        // Update Transaksi menjadi PAID
        await c.env.DB.prepare(
            "UPDATE transactions SET status = 'PAID', paid_at = ? WHERE id = ?"
        ).bind(now, transaction.id).run();

        // Cek apakah ini pembayaran langganan (jika ada di metadata)
        // ... (Logika aktivasi langganan bisa ditambahkan di sini) ...

        // Kirim webhook ke Kreator (jika ada)
        if (transaction.webhook_url && transaction.callback_token) {
            const webhookPromise = fetch(transaction.webhook_url, {
                // ... (Logika fetch webhook) ...
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
    // Ini adalah endpoint yang dipanggil oleh CoinPayments atau Notifikasi QRIS Admin
    // Anda perlu memvalidasi request ini (misal: cek IPN Secret)
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

        // Update Transaksi dan Inventaris Gift
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
