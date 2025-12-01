export interface Env { DB: D1Database }

type Json = Record<string, any> | any[] | string | number | null;

function json(data: Json, status = 200) {
  return new Response(JSON.stringify({ code: 0, data }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function error(message: string, status = 400) {
  return new Response(JSON.stringify({ code: status, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function readJson(req: Request) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const now = Date.now();
    const userId = request.headers.get('X-Encrypted-Yw-ID') || 'anonymous';

    // Health
    if (path === '/api/health') {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // Create or list datasets
    if (path === '/api/datasets') {
      if (method === 'POST') {
        const body = await readJson(request);
        if (!body || !body.name) return error('name is required', 422);
        const description = body.description || '';
        const stmt = env.DB.prepare('INSERT INTO datasets (name, description, created_by, created_at) VALUES (?, ?, ?, ?)');
        const res = await stmt.bind(body.name, description, userId, now).run();
        const id = (res.meta && (res.meta.last_row_id as number)) || undefined;
        return json({ id, name: body.name, description });
      }
      if (method === 'GET') {
        const { results } = await env.DB.prepare('SELECT id, name, description, created_by, created_at FROM datasets ORDER BY id DESC').all();
        return json(results);
      }
      return error('Method not allowed', 405);
    }

    // Dataset detail
    const dsMatch = path.match(/^\/api\/datasets\/(\d+)$/);
    if (dsMatch) {
      const dsId = Number(dsMatch[1]);
      if (method === 'GET') {
        const { results } = await env.DB.prepare('SELECT id, name, description, created_by, created_at FROM datasets WHERE id = ?').bind(dsId).all();
        if (!results || results.length === 0) return error('dataset not found', 404);
        return json(results[0]);
      }
      return error('Method not allowed', 405);
    }

    // Presign sample upload
    const presignMatch = path.match(/^\/api\/datasets\/(\d+)\/samples\/presign$/);
    if (presignMatch && method === 'POST') {
      const dsId = Number(presignMatch[1]);
      const body = await readJson(request) || {};
      const filename: string = (body.filename || 'sample.bin').toString();
      const contentType: string | undefined = body.contentType || undefined;
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const key = `datasets/${dsId}/${now}-${safeName}`;

      try {
        const resp = await fetch('https://storage.youware.me/presign/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, contentType })
        });
        if (!resp.ok) {
          const err = await resp.text();
          console.error('presign upload failed', err);
          return error('presign failed', 502);
        }
        const data = await resp.json();
        return json({ ...data, key });
      } catch (e: any) {
        console.error('presign exception', e?.message || e);
        return error('presign exception', 500);
      }
    }

    // Save sample metadata
    const sampleMatch = path.match(/^\/api\/datasets\/(\d+)\/samples$/);
    if (sampleMatch && method === 'POST') {
      const dsId = Number(sampleMatch[1]);
      const body = await readJson(request);
      if (!body || !body.label || !body.key) return error('label and key are required', 422);
      const stmt = env.DB.prepare('INSERT INTO samples (dataset_id, label, file_key, notes, created_at) VALUES (?, ?, ?, ?, ?)');
      const res = await stmt.bind(dsId, body.label, body.key, body.notes || '', now).run();
      const id = (res.meta && (res.meta.last_row_id as number)) || undefined;
      return json({ id, dataset_id: dsId });
    }

    // Queue training job
    if (path === '/api/retrain' && method === 'POST') {
      const body = await readJson(request);
      if (!body || !body.dataset_id) return error('dataset_id is required', 422);
      const dsId = Number(body.dataset_id);
      const stmt = env.DB.prepare('INSERT INTO training_jobs (dataset_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)');
      const res = await stmt.bind(dsId, 'queued', now, now).run();
      const id = (res.meta && (res.meta.last_row_id as number)) || undefined;
      return json({ id, dataset_id: dsId, status: 'queued' });
    }

    // Get training job
    const jobMatch = path.match(/^\/api\/training-jobs\/(\d+)$/);
    if (jobMatch && method === 'GET') {
      const jobId = Number(jobMatch[1]);
      const { results } = await env.DB.prepare('SELECT id, dataset_id, status, created_at, updated_at FROM training_jobs WHERE id = ?').bind(jobId).all();
      if (!results || results.length === 0) return error('job not found', 404);
      return json(results[0]);
    }

    return error('Not found', 404);
  }
};
