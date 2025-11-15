import { Hono } from 'hono';
import { authMiddleware } from '../middleware.js';

const member = new Hono();
member.use('*', authMiddleware); // Melindungi semua rute member

// Endpoint untuk Statistik Dashboard Member
member.get('/stats', async (c) => {
    // ... (salin kode dari /api/member/stats) ...
    const user = c.get('user');
    try {
        const [projects, revenueIDR, revenueUSD, gifts] = await Promise.all([
            c.env.DB.prepare("SELECT COUNT(id) as value FROM projects WHERE user_id = ?").bind(user.sub).first(),
            c.env.DB.prepare("SELECT SUM(t.total_amount) as value FROM transactions t JOIN projects p ON t.project_id = p.id WHERE p.user_id = ? AND t.status = 'PAID' AND t.currency = 'IDR'").bind(user.sub).first(),
            c.env.DB.prepare("SELECT SUM(t.total_amount) as value FROM transactions t JOIN projects p ON t.project_id = p.id WHERE p.user_id = ? AND t.status = 'PAID' AND t.currency = 'USD'").bind(user.sub).first(),
            c.env.DB.prepare("SELECT COUNT(id) as value FROM user_gift_inventory WHERE owner_user_id = ? AND status = 'OWNED'").bind(user.sub).first()
        ]);
        
        const transactions = await c.env.DB.prepare(
            `SELECT COUNT(t.id) as value FROM transactions t
             JOIN projects p ON t.project_id = p.id
             WHERE p.user_id = ?`
        ).bind(user.sub).first();

        return c.json({
            total_projects: projects.value || 0,
            total_revenue_idr: revenueIDR.value || 0,
            total_revenue_usd: (revenueUSD.value || 0),
            total_gifts_owned: gifts.value || 0,
            total_transactions: transactions.value || 0
        });
    } catch (e) {
        return c.json({ error: 'Gagal memuat statistik member: ' + e.message }, 500);
    }
});

// ... (Salin semua endpoint /api/member lainnya ke sini) ...
// member.get('/transactions', ...)
// member.get('/wallet', ...)
// member.get('/gifts', ...)
// member.post('/gifts/generate-redeem', ...)

export default member;
