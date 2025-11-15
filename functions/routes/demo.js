import { Hono } from 'hono';
import { injectAmountIntoQris } from '../helpers.js';

const demo = new Hono();

demo.post('/create', async (c) => {
    // Ambil body, tangani jika body kosong/invalid
    const body = await c.req.json().catch(() => ({})); 
    const now = Math.floor(Date.now() / 1000);

    // 1. Ambil channel QRIS milik Admin (project_id = 1)
    const adminChannel = await c.env.DB.prepare(
        "SELECT id, qris_raw FROM payment_channels WHERE project_id = '1' AND is_qris = 1 AND is_active = 1 LIMIT 1"
    ).first();

    if (!adminChannel || !adminChannel.qris_raw) {
        return c.json({ error: 'Demo channel (Admin QRIS) tidak dikonfigurasi.' }, 500);
    }

    // 2. Hitung nominal (base + random)
    const baseAmount = parseInt(body.amount, 10) || 100; 
    const randomAmount = Math.floor(Math.random() * 901) + 100; 
    const totalAmount = baseAmount + randomAmount;
    const referenceId = `DEMO-${crypto.randomUUID()}`;
    const expiredAt = now + (60 * 30); // 30 menit

    // 3. Suntikkan nominal ke QRIS Admin menggunakan helper Anda
    const qrisFinal = injectAmountIntoQris(adminChannel.qris_raw, totalAmount);
    if (!qrisFinal) {
         return c.json({ error: 'Gagal memproses string QRIS.' }, 500);
    }

    try {
        // 4. Simpan transaksi demo sebagai UNPAID
        await c.env.DB.prepare(
            `INSERT INTO transactions (
                id, project_id, payment_channel_id, reference_id, amount, unique_code, total_amount, currency, status,
                customer_name, description, expired_at, created_at, updated_at, qr_string
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            crypto.randomUUID(), '1', adminChannel.id,
            referenceId, baseAmount, randomAmount, totalAmount,
            'IDR', 'UNPAID', 'Demo User', 'Demo Transaksi CuanFans',
            expiredAt, now, now, qrisFinal
        ).run();

        // 5. Kembalikan data ke frontend
        return c.json({
            success: true,
            qris_string: qrisFinal,
            reference_id: referenceId,
            total_amount: totalAmount
        }, 201);

    } catch (e) {
        return c.json({ error: 'Terjadi kesalahan internal saat membuat demo: ' + e.message }, 500);
    }
});

demo.get('/check/:referenceId', async (c) => {
    const referenceId = c.req.param('referenceId');

    const tx = await c.env.DB.prepare(
        "SELECT status, total_amount FROM transactions WHERE reference_id = ? AND project_id = '1'"
    ).bind(referenceId).first();

    if (!tx) {
        return c.json({ error: 'Transaksi demo tidak ditemukan' }, 404);
    }

    return c.json({
        status: tx.status,
        total_amount: tx.total_amount
    });
});

export default demo;
