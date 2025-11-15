import { Hono } from 'hono';
import { authMiddleware, adminMiddleware } from '../middleware.js';
import { slugify } 'from ../helpers.js';

const admin = new Hono();
admin.use('*', authMiddleware, adminMiddleware);

// Endpoint untuk Statistik Dashboard
admin.get('/stats', async (c) => {
    // ... (salin kode dari /api/admin/stats) ...
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

// ... (Salin semua endpoint /api/admin lainnya ke sini) ...
// admin.get('/settings', ...)
// admin.post('/settings', ...)
// admin.get('/users', ...)
// admin.put('/users/:id', ...)
// admin.get('/platform-channels', ...)
// ... (dan semua sub-rute /gifts-store, /blog, /pages) ...

export default admin;
