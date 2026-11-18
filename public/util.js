export async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // Session missing/expired: let the app swap to the login screen.
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('unauthorized'));
    throw Object.assign(new Error(err.error || `${res.status} ${res.statusText}`), { status: res.status, body: err });
  }
  return res.json();
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.round(sec / 60);
  if (m < 1) return '<1m';
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export function fmtSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i > 2 ? 2 : 0)} ${u[i]}`;
}

export const epCode = (i) =>
  i.episode != null ? `S${i.season} · E${i.episode}${i.episodeEnd ? `–${i.episodeEnd}` : ''}` : i.season === 0 ? 'Special' : `Season ${i.season}`;

// Parses SRT or WebVTT into [{start, end, text}].
export function parseCues(text) {
  const toSec = (t) => {
    const parts = t.replace(',', '.').split(':').map(Number);
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  };
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->').map((s) => s.trim().split(/\s+/)[0]);
    const body = lines.slice(i + 1).join('\n')
      .replace(/<[^>]+>/g, '')        // <i>, <font>, vtt tags
      .replace(/\{\\[^}]*\}/g, '')    // ASS overrides
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
    if (body) cues.push({ start: toSec(a), end: toSec(b), text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

// TMDB image paths ("/abc.jpg") are proxied + cached by the server.
export const tmdbImg = (p, size = 'w342') => (p ? `/api/img/${size}${p}` : null);
