// @ts-nocheck
import { VERSION, HEADER_PREFIX } from './constants.js';

function pickResponseHeaders(response) {
    const headers = {};
    const contentType = response.headers.get('content-type');
    headers['content-type'] = contentType || 'application/json; charset=utf-8';
    return headers;
}

function callProgress(onProgress, patch) {
    try {
        if (typeof onProgress === 'function') onProgress(patch);
    } catch {
        // progress callbacks must never break the proxied request
    }
}

function parseContentLength(response) {
    const raw = response.headers.get('content-length');
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function progressPatch(phase, startedAt, bytesReceived, totalBytes, extra = {}) {
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    const speedBps = bytesReceived > 0 ? bytesReceived / (elapsedMs / 1000) : 0;
    const hasTotal = Number.isFinite(totalBytes) && totalBytes > 0;
    const percent = hasTotal ? Math.max(0, Math.min(100, (bytesReceived / totalBytes) * 100)) : null;
    const etaMs = hasTotal && speedBps > 0 ? Math.max(0, ((totalBytes - bytesReceived) / speedBps) * 1000) : null;
    return {
        phase,
        bytesReceived,
        totalBytes: hasTotal ? totalBytes : null,
        speedBps,
        percent,
        etaMs,
        ...extra,
    };
}

async function readBodyWithProgress(response, onProgress, startedAt) {
    const totalBytes = parseContentLength(response);
    let bytesReceived = 0;
    let lastEmitAt = 0;

    callProgress(onProgress, progressPatch('downloading', startedAt, 0, totalBytes, { status: response.status }));

    if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            const buffer = Buffer.from(value);
            chunks.push(buffer);
            bytesReceived += buffer.byteLength;
            const now = Date.now();
            if (now - lastEmitAt >= 100) {
                lastEmitAt = now;
                callProgress(onProgress, progressPatch('downloading', startedAt, bytesReceived, totalBytes, { status: response.status }));
            }
        }
        callProgress(onProgress, progressPatch('downloading', startedAt, bytesReceived, totalBytes, { status: response.status, etaMs: 0, percent: totalBytes ? 100 : null }));
        return { bodyText: Buffer.concat(chunks).toString('utf8'), bytesReceived, totalBytes };
    }

    const bodyText = await response.text();
    bytesReceived = Buffer.byteLength(bodyText || '', 'utf8');
    callProgress(onProgress, progressPatch('downloading', startedAt, bytesReceived, totalBytes || bytesReceived, { status: response.status, etaMs: 0, percent: 100 }));
    return { bodyText, bytesReceived, totalBytes: totalBytes || bytesReceived };
}

export async function fetchOriginal(ctx, endpoint, options = {}) {
    const method = endpoint.method || 'POST';
    const url = `${ctx.protocol}://${ctx.host}${endpoint.originalPath}`;
    const headers = {};
    for (const [key, value] of Object.entries(ctx.headers || {})) {
        if (typeof value === 'string' && value.length > 0) headers[key] = value;
    }
    if (method !== 'GET') {
        headers['content-type'] = headers['content-type'] || 'application/json';
    }
    headers[HEADER_PREFIX] = VERSION;

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    const onProgress = options?.onProgress;
    try {
        const fetchOptions = { method, headers, redirect: 'manual', signal: controller.signal };
        if (method !== 'GET' && method !== 'HEAD') {
            fetchOptions.body = ctx.bodyText;
        }
        callProgress(onProgress, { phase: 'requesting', startedAt, bytesReceived: 0, totalBytes: null, speedBps: 0, percent: null, etaMs: null, status: null, error: null });
        const response = await fetch(url, fetchOptions);
        callProgress(onProgress, { phase: 'downloading', status: response.status, totalBytes: parseContentLength(response), bytesReceived: 0, speedBps: 0, percent: null, etaMs: null });
        const { bodyText, bytesReceived, totalBytes } = await readBodyWithProgress(response, onProgress, startedAt);
        const durationMs = Date.now() - startedAt;
        return { ok: response.ok, status: response.status, statusText: response.statusText, headers: pickResponseHeaders(response), bodyText, durationMs, bytesReceived, totalBytes };
    } finally {
        clearTimeout(timer);
    }
}
