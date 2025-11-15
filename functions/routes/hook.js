import { Hono } from 'hono';
import { apiKeyAuthMiddleware } from '../middleware.js';
import { parseAmountFromText } from '../helpers.js';

const hooks = new Hono();

// Hook untuk Aplikasi Android Kreator (BYOG)
hooks.post('/app/hook', apiKeyAuthMiddleware, async (c) => {
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
hooks.post('/webhooks/platform-payment', async (c) => {
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

export default hooks;
