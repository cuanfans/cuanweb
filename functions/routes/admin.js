import { Hono } from 'hono';
import { authMiddleware, adminMiddleware } from '../middleware.js';
import { slugify } from '../helpers.js';

const admin = new Hono();
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
            revenueUsd: revenueUSD.value || 0, // Dalam sen
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
    const adminUser = c.get('adminUser');
    const body = await c.req.json();
    const validRoles = ['admin', 'member'];
    const validStatuses = ['active', 'suspended'];
    
    if (!validRoles.includes(body.role) || !validStatuses.includes(body.status)) {
        return c.json({ error: 'Role atau Status tidak valid' }, 400);
    }

    if (id === adminUser.sub && body.status === 'suspended') {
        return c.json({ error: 'Anda tidak dapat men-suspend akun Anda sendiri.'}, 403);
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

admin.post('/platform-channels', async (c) => {
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    const projectId = '1'; // Hardcoded untuk platform

    if (!body.name || !body.type || !body.currency_support) {
        return c.json({ error: 'Nama, Tipe, dan Mata Uang (currency_support) wajib diisi.' }, 400);
    }
    
    try {
        const newChannelId = crypto.randomUUID();
        const newCode = `PLATFORM_${body.type.toUpperCase()}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        
        await c.env.DB.prepare(
            `INSERT INTO payment_channels (
                id, project_id, code, name, type, is_qris, qris_raw, bank_data, 
                android_package, icon_url, currency_support, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            newChannelId, projectId, newCode, body.name, body.type, body.is_qris || 0, body.qris_raw || null,
            body.bank_data ? JSON.stringify(body.bank_data) : null, body.android_package || null,
            body.icon_url || null, body.currency_support, body.is_active, now, now
        ).run();
        
        return c.json({ message: 'Channel platform berhasil dibuat' }, 201);
    } catch (e) {
        return c.json({ error: 'Gagal membuat channel platform: ' + e.message }, 500);
    }
});

admin.put('/platform-channels/:channelId', async (c) => {
    const { channelId } = c.req.param();
    const projectId = '1'; // Hardcoded
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

admin.delete('/platform-channels/:channelId', async (c) => {
    const { channelId } = c.req.param();
    const projectId = '1'; // Hardcoded
    try {
        await c.env.DB.prepare(
            "DELETE FROM payment_channels WHERE id = ? AND project_id = ?"
        ).bind(channelId, projectId).run();
        return c.json({ message: 'Channel berhasil dihapus' });
    } catch (e) {
        return c.json({ error: 'Gagal menghapus channel: ' + e.message }, 500);
    }
});

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
adminBlog.delete('/categories/:id', async (c) => {
    const id = c.req.param('id');
    try {
        await c.env.DB.prepare("DELETE FROM blog_categories WHERE id = ?").bind(id).run();
        return c.json({ message: 'Kategori dihapus' });
    } catch (e) { return c.json({ error: e.message }, 500); }
});

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
adminBlog.delete('/tags/:id', async (c) => {
    const id = c.req.param('id');
    try {
        await c.env.DB.prepare("DELETE FROM blog_tags WHERE id = ?").bind(id).run();
        return c.json({ message: 'Tag dihapus' });
    } catch (e) { return c.json({ error: e.message }, 500); }
});

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
        // TODO: Ambil kategori dan tag
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
        
        // TODO: Handle categories dan tags
        
        return c.json({ message: 'Postingan berhasil dibuat', id: postId }, 201);
    } catch (e) { return c.json({ error: e.message }, 500); }
});

adminBlog.put('/posts/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const now = Math.floor(Date.now() / 1000);
    
    try {
        const post = await c.env.DB.prepare("SELECT published_at FROM blog_posts WHERE id = ?").bind(id).first();
        if (!post) return c.json({ error: 'Postingan tidak ditemukan' }, 404);

        const publishedAt = (body.status === 'published' && !post.published_at) ? now : post.published_at;

        await c.env.DB.prepare(
            `UPDATE blog_posts SET 
             title = ?, slug = ?, content = ?, featured_image_url = ?, status = ?, 
             updated_at = ?, published_at = ?
             WHERE id = ?`
        ).bind(
            body.title, body.slug || slugify(body.title), body.content, 
            body.featured_image_url, body.status, now,
            publishedAt,
            id
        ).run();
        
        // TODO: Handle update categories dan tags
        
        return c.json({ message: 'Postingan berhasil diperbarui' });
    } catch (e) { return c.json({ error: e.message }, 500); }
});

adminBlog.delete('/posts/:id', async (c) => {
    const id = c.req.param('id');
    try {
        // Hapus relasi dulu
        await c.env.DB.batch([
            c.env.DB.prepare("DELETE FROM blog_post_categories WHERE post_id = ?").bind(id),
            c.env.DB.prepare("DELETE FROM blog_post_tags WHERE post_id = ?").bind(id),
            c.env.DB.prepare("DELETE FROM blog_posts WHERE id = ?").bind(id)
        ]);
        return c.json({ message: 'Postingan berhasil dihapus' });
    } catch (e) { return c.json({ error: e.message }, 500); }
});

// --- ADMIN: CRUD Pages ---
const adminPages = admin.basePath('/pages');

adminPages.get('/', async (c) => {
    const { results } = await c.env.DB.prepare("SELECT id, title, slug, template_type, status FROM pages ORDER BY created_at DESC").all();
    return c.json(results || []);
});

adminPages.get('/:id', async (c) => {
    const id = c.req.param('id');
    try {
        const page = await c.env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first();
        if (!page) return c.json({ error: 'Halaman tidak ditemukan' }, 404);
        return c.json(page);
    } catch (e) { return c.json({ error: e.message }, 500); }
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

export default admin;
