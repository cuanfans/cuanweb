import { Hono } from 'hono';
import { i18nMiddleware } from '../middleware.js';
import { injectAmountIntoQris, calculateTransactionDetails } from '../helpers.js';

const pub = new Hono();

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
             ON CONFLICT(social_profile_url) DO NOTHING`
        ).bind(fanId, social_url, now).run();
        
        const fanQuery = await c.env.DB.prepare("SELECT id FROM fans WHERE social_profile_url = ?").bind(social_url).first();
        const finalFanId = fanQuery.id;

        // 2. Cari atau buat Wallet untuk Fan
        const walletId = crypto.randomUUID();
        await c.env.DB.prepare(
            `INSERT INTO wallets (id, fan_id, created_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(fan_id) DO NOTHING`
        ).bind(walletId, finalFanId, now, now).run();

        const walletQuery = await c.env.DB.prepare("SELECT id FROM wallets WHERE fan_id = ?").bind(finalFanId).first();
        const finalWalletId = walletQuery.id;

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

export default pub;
