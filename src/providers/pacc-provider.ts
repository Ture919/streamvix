// Fork Ture919 (23/11/2026): PaCC (www.partite.cc), portato da PriSynx providers/pa.cc.js.
// Le pagine /film/<imdb> e /serie-tv/<imdb> contengono le playlist /hls/... ; quelle non firmate (/hls/sN/...) si firmano
// con /api/play/grant. Si tengono solo le playlist che hanno una traccia audio italiana (o nessuna traccia separata).
import type { Stream } from 'stremio-addon-sdk';
import { PrisynxReq, parseId, tmdbInfo, fetchText, fetchJson, pad2, hlsAttr, absUrl, mfpHls, heightToLabel, UA_DESKTOP } from './prisynx-common';

const BASE = 'https://www.partite.cc';
const MAPPING = 'https://animemapping.realbestia.com';
const log = (...a: any[]) => { try { console.log('[PaCC]', ...a); } catch { /* */ } };

interface PccUrl { url: string; server: number; kind: 'movie' | 'serial'; id: string; season: number | null; episode: number | null; }

function decode(v: string): string {
    return String(v || '').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'").replace(/\\\//g, '/');
}

function parsePcc(value: string): PccUrl | null {
    if (!value) return null;
    const full = absUrl(decode(value), BASE + '/');
    const p = full.replace(/^https?:\/\/[^/]+/i, '').split('?')[0];
    const m = p.match(/\/hls\/(?:p\/[^/]+\/[^/]+\/)?s(\d+)\/(movie|serial)\/([^/]+)(?:\/(\d+)\/(\d+))?\/playlist\.m3u8$/i);
    if (!m) return null;
    return {
        url: full, server: parseInt(m[1], 10), kind: m[2].toLowerCase() as any, id: m[3],
        season: m[4] ? parseInt(m[4], 10) : null, episode: m[5] ? parseInt(m[5], 10) : null,
    };
}

function playlistsIn(html: string): PccUrl[] {
    const src = decode(html);
    const seen = new Set<string>();
    const out: PccUrl[] = [];
    for (const m of src.matchAll(/(?:https?:\/\/[^\s"'<>]+)?\/hls\/[^\s"'<>]+?\/playlist\.m3u8(?:\?[^\s"'<>]*)?/gi)) {
        const p = parsePcc(m[0].replace(/[),.;]+$/g, ''));
        if (p && !seen.has(p.url)) { seen.add(p.url); out.push(p); }
    }
    return out;
}

async function sign(p: PccUrl): Promise<PccUrl | null> {
    if (/\/hls\/p\//i.test(p.url)) return p;
    let q: string;
    if (p.kind === 'movie') q = `type=movie&id=${encodeURIComponent(p.id)}`;
    else if (p.season != null && p.episode != null) q = `type=episode&id=${encodeURIComponent(p.id)}&season=${p.season}&episode=${p.episode}`;
    else return null;
    const referer = p.kind === 'movie' ? `${BASE}/film/${p.id}` : `${BASE}/serie-tv/${p.id}`;
    const d = await fetchJson<any>(`${BASE}/api/play/grant?${q}&_=${Date.now()}`, { headers: { Accept: 'application/json', Referer: referer, 'User-Agent': UA_DESKTOP }, timeoutMs: 7000 });
    const s = parsePcc(d && (d.url || d.playlist || d.stream));
    if (!s || s.kind !== p.kind || s.id.toLowerCase() !== p.id.toLowerCase()) return null;
    if (p.kind === 'serial' && (s.season !== p.season || s.episode !== p.episode)) return null;
    return s;
}

// Serie: l'id IMDb puo' avere la numerazione di AnimeMapping (anime) diversa da quella TMDB/IMDb.
async function mapping(imdb: string, s: number, e: number): Promise<{ season?: number; episode?: number; abs?: number } | null> {
    const d = await fetchJson<any>(`${MAPPING}/imdb/${imdb}?ep=${e}&lang=it&s=${s}`, { headers: { 'User-Agent': UA_DESKTOP }, timeoutMs: 5000 });
    const te = d && ((d.mappings && d.mappings.tmdb_episode) || d.tmdb_episode);
    if (!te) return null;
    return { season: Number(te.season) || undefined, episode: Number(te.episode) || undefined, abs: Number(te.absoluteEpisode) || undefined };
}

export async function pacc(req: PrisynxReq): Promise<Stream[]> {
    const isTv = req.type === 'series';
    const pid = parseId(req.id);
    const info = await tmdbInfo(pid, isTv, req.tmdbApiKey);
    const imdb = String(info?.imdbId || pid.imdb || '');
    const titolo = info?.title || imdb;
    if (!/^tt\d+$/.test(imdb)) return [];
    let s = pid.season || 1, e = pid.episode || 1;
    let candidates: PccUrl[] = [];
    const pageUrl = `${BASE}/${isTv ? 'serie-tv' : 'film'}/${imdb}`;
    const page = await fetchText(pageUrl, { headers: { 'User-Agent': UA_DESKTOP }, timeoutMs: 8000 });
    if (!page.ok) { log('pagina', pageUrl, 'HTTP', page.status); return []; }
    const all = playlistsIn(page.text);
    if (isTv) {
        const eps = all.filter((p) => p.kind === 'serial' && p.season != null && p.episode != null)
            .sort((a, b) => (a.season! - b.season!) || (a.episode! - b.episode!));
        let target = eps.filter((p) => p.season === s && p.episode === e);
        if (!target.length) {
            const mp = await mapping(imdb, s, e);
            if (mp?.season && mp?.episode) target = eps.filter((p) => p.season === mp.season && p.episode === mp.episode);
            if (!target.length && mp?.abs) {
                const keys = [...new Set(eps.map((p) => `${p.season}:${p.episode}`))];
                const k = keys[mp.abs - 1];
                if (k) target = eps.filter((p) => `${p.season}:${p.episode}` === k);
            }
        }
        if (target.length) { s = target[0].season!; e = target[0].episode!; }
        candidates = target;
    } else {
        candidates = all.filter((p) => p.kind === 'movie' && p.id.toLowerCase() === imdb.toLowerCase());
    }
    if (!candidates.length) { log('nessuna playlist per', imdb, isTv ? `S${s}E${e}` : ''); return []; }
    const signed = (await Promise.all(candidates.map(sign))).filter(Boolean) as PccUrl[];
    const uniq = [...new Map(signed.map((p) => [p.url, p])).values()];
    const headers = { Referer: BASE + '/', 'User-Agent': UA_DESKTOP };
    const out: Stream[] = [];
    await Promise.all(uniq.map(async (c) => {
        const r = await fetchText(c.url, { headers, timeoutMs: 6000 });
        if (!r.ok || !r.text.includes('#EXTM3U')) return;
        let maxH = 0;
        for (const m of r.text.matchAll(/RESOLUTION=\d+x(\d+)/gi)) maxH = Math.max(maxH, parseInt(m[1], 10));
        let anyAudio = false, ita = false;
        const audio: string[] = [];
        for (const line of r.text.split(/\r?\n/)) {
            if (!line.startsWith('#EXT-X-MEDIA:') || (hlsAttr(line, 'TYPE') || '').toUpperCase() !== 'AUDIO') continue;
            anyAudio = true;
            const lang = hlsAttr(line, 'LANGUAGE') || '', name = hlsAttr(line, 'NAME') || '';
            if (/(^|\b)(it|ita|italiano|italian)(\b|$)/i.test(lang) || /italian|italiano/i.test(name)) ita = true;
            audio.push((lang || name).toUpperCase());
        }
        if (anyAudio && !ita) return; // senza audio italiano non serve
        const q = heightToLabel(maxH) || 'HD';
        out.push({
            name: 'PaCC',
            title: `${titolo}${info?.year && !isTv ? ` (${info.year})` : ''}${isTv ? ` S${pad2(s)}E${pad2(e)}` : ''}\n▶️ Server ${c.server}\n💾 ${q}${audio.length ? ` • audio ${[...new Set(audio)].join('/')}` : ''}`,
            url: mfpHls(c.url, { Referer: BASE + '/' }, req.mfpUrl, req.mfpPsw),
            behaviorHints: {
                notWebReady: true,
                ...(req.mfpUrl ? {} : { proxyHeaders: { request: { Referer: BASE + '/' } } }),
                bingeGroup: `pacc-s${c.server}`,
                filename: `${String(titolo).normalize('NFD').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().replace(/\s+/g, '.')}${isTv ? `.S${pad2(s)}E${pad2(e)}` : info?.year ? `.${info.year}` : ''}.${q}.ITA.m3u8`,
            } as any,
        } as Stream);
    }));
    out.sort((a: any, b: any) => String(a.title).localeCompare(String(b.title)));
    log(`${out.length} stream per ${imdb}${isTv ? ` S${s}E${e}` : ''}`);
    return out;
}
