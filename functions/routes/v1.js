import { Hono } from 'hono';
import { apiKeyAuthMiddleware } from '../middleware.js';
import { injectAmountIntoQris, calculateTransactionDetails } from '../helpers.js';

const v1 = new Hono();

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
            transaction_id: tx.lastRowId, // Note: D1 tidak support lastRowId, gunakan UUID
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

export default v1;
