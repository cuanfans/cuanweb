import { Hono } from 'hono';
import { authMiddleware, projectOwnerMiddleware } from '../middleware.js';

const projectsApi = new Hono();
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
            body.icon_url || null, body.currency_support, body.is_active, now, now
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

export default projectsApi;
