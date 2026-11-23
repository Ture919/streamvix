// Fork Ture919 (23/11/2026): funzioni comuni ai provider portati dal plugin Nuvio PriSynx (stesso autore di StreamViX).
// La logica e' riscritta in TypeScript leggendo il codice dei plugin; nessun JS dei plugin viene eseguito.

export const TMDB_FALLBACK_KEY = '40a9faa1f6741afb2c0c40238d85f8d0';
export const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface PrisynxReq {
    id: string;              // "tt123" | "tt123:S:E" | "tmdb:123" | "tmdb:123:S:E"
    type: 'movie' | 'series';
    tmdbApiKey?: string;
    mfpUrl?: string;
    mfpPsw?: string;
}

export interface ParsedId { imdb?: string; tmdb?: string; season: number | null; episode: number | null; }

export function parseId(id: string): ParsedId {
    const p = String(id || '').split(':');
    if (p[0] === 'tmdb') {
        return { tmdb: p[1], season: p.length >= 4 ? parseInt(p[2], 10) : null, episode: p.length >= 4 ? parseInt(p[3], 10) : null };
    }
    if (/^tt\d+$/i.test(p[0])) {
        return { imdb: p[0], season: p.length >= 3 ? parseInt(p[1], 10) : null, episode: p.length >= 3 ? parseInt(p[2], 10) : null };
    }
    return { season: null, episode: null };
}

export async function fetchText(url: string, opts: { headers?: Record<string, string>; method?: string; body?: any; timeoutMs?: number; redirect?: 'follow' | 'manual' } = {}):
    Promise<{ status: number; ok: boolean; text: string; headers: Headers | null; url: string }> {
    try {
        const r = await fetch(url, {
            method: opts.method || 'GET',
            headers: opts.headers,
            body: opts.body,
            redirect: opts.redirect || 'follow',
            signal: AbortSignal.timeout(opts.timeoutMs || 12000),
        } as any);
        const text = await r.text();
        return { status: r.status, ok: r.ok, text, headers: r.headers, url: r.url };
    } catch (e: any) {
        return { status: 0, ok: false, text: String(e?.message || e), headers: null, url };
    }
}

export async function fetchJson<T = any>(url: string, opts: Parameters<typeof fetchText>[1] = {}): Promise<T | null> {
    const r = await fetchText(url, opts);
    if (!r.ok) return null;
    try { return JSON.parse(r.text) as T; } catch { return null; }
}

export interface TmdbInfo { tmdbId: string; imdbId: string; title: string; original: string; year: number; runtime: number; }

// Titolo italiano, originale, anno, id IMDb e durata (per i film; per le serie la durata dell'episodio se c'e').
export async function tmdbInfo(pid: ParsedId, isTv: boolean, apiKey?: string, season?: number | null, episode?: number | null, lang = 'it-IT'): Promise<TmdbInfo | null> {
    const key = apiKey || process.env.TMDB_API_KEY || TMDB_FALLBACK_KEY;
    const kind = isTv ? 'tv' : 'movie';
    let tmdbId = pid.tmdb || '';
    if (!tmdbId && pid.imdb) {
        const f = await fetchJson<any>(`https://api.themoviedb.org/3/find/${pid.imdb}?api_key=${key}&external_source=imdb_id`, { timeoutMs: 8000 });
        const hit = f && (isTv ? f.tv_results : f.movie_results)?.[0];
        if (!hit) return null;
        tmdbId = String(hit.id);
    }
    if (!/^\d+$/.test(tmdbId)) return null;
    const extra = isTv && season ? `,season/${season}` : '';
    const d = await fetchJson<any>(`https://api.themoviedb.org/3/${kind}/${tmdbId}?api_key=${key}${lang ? `&language=${lang}` : ''}&append_to_response=external_ids${extra}`, { timeoutMs: 8000 });
    if (!d) return null;
    let runtime = Number(d.runtime || 0);
    if (isTv) {
        const ep = (d[`season/${season}`]?.episodes || []).find((e: any) => e.episode_number === episode);
        runtime = Number(ep?.runtime || (d.episode_run_time || [])[0] || 0);
    }
    return {
        tmdbId,
        imdbId: String(d.external_ids?.imdb_id || d.imdb_id || pid.imdb || ''),
        title: String((isTv ? d.name : d.title) || ''),
        original: String((isTv ? d.original_name : d.original_title) || ''),
        year: parseInt(String(isTv ? d.first_air_date : d.release_date || '').slice(0, 4), 10) || 0,
        runtime,
    };
}

export function pad2(n: number | string): string { return String(n).padStart(2, '0'); }

// Avvolge una playlist HLS nel proxy EasyProxy/MediaFlow dell'utente, passando gli header richiesti dal sito (h_<nome>).
export function mfpHls(url: string, headers: Record<string, string>, mfpUrl?: string, mfpPsw?: string): string {
    if (!mfpUrl) return url;
    const base = mfpUrl.replace(/\/+$/, '');
    const h = Object.entries(headers || {}).map(([k, v]) => `&h_${k.toLowerCase()}=${encodeURIComponent(v)}`).join('');
    const pw = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
    return `${base}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(url)}${pw}${h}`;
}

export function heightToLabel(h: number): string {
    return h >= 2000 ? '2160p' : h >= 1400 ? '1440p' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : h >= 560 ? '576p' : h >= 460 ? '480p' : h > 0 ? '360p' : '';
}

export function widthToLabel(w: number): string {
    return w >= 3200 ? '2160p' : w >= 2400 ? '1440p' : w >= 1800 ? '1080p' : w >= 1200 ? '720p' : w >= 800 ? '480p' : w > 0 ? '360p' : '';
}

export function hlsAttr(line: string, key: string): string | null {
    const m = line.match(new RegExp('(?:^|[,:])' + key + '=("([^"]*)"|[^,]*)'));
    if (!m) return null;
    return m[2] !== undefined ? m[2] : m[1];
}

export function absUrl(uri: string, base: string): string {
    if (/^https?:\/\//i.test(uri)) return uri;
    try { return new URL(uri, base).toString(); } catch { return uri; }
}
