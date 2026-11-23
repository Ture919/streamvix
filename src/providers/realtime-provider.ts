// Fork Ture919 (23/11/2026): Real Time / NOVE / DMAX / Food Network (Discovery Italia), portato da PriSynx providers/realtime.js.
// Token anonimo dalla pagina del programma (userMeta.realm) + POST videoPlaybackInfo: l'URL HLS e' firmato con l'IP di chi
// lo chiede (qui il server di casa) e scade dopo pochi minuti. Solo serie/programmi, solo HLS senza DRM.
import type { Stream } from 'stremio-addon-sdk';
import { PrisynxReq, parseId, tmdbInfo, fetchText, fetchJson, pad2, hlsAttr, widthToLabel, mfpHls } from './prisynx-common';

const API = 'https://public.aurora.enhanced.live';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CHANNELS = [
    { env: 'realtime', parent: 'programmi-real-time', site: 'https://realtime.it', name: 'Real Time' },
    { env: 'nove', parent: 'programmi-nove', site: 'https://nove.tv', name: 'NOVE' },
    { env: 'dmaxit', parent: 'programmi-dmax', site: 'https://dmax.it', name: 'DMAX' },
    { env: 'foodnetwork', parent: 'programmi-food-network', site: 'https://foodnetwork.it', name: 'Food Network' },
];
type Channel = typeof CHANNELS[number];

const log = (...a: any[]) => { try { console.log('[RealTime]', ...a); } catch { /* */ } };
const siteHeaders = (ch: Channel, extra: Record<string, string> = {}) => ({ 'User-Agent': UA, Referer: ch.site + '/', Origin: ch.site, ...extra });

function norm(s: string): string {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/'/g, '').replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// TMDB aggiunge sottotitoli che il canale non usa ("Bake Off Italia - Dolci in forno" -> "Bake Off Italia")
function titles(t: string, o: string): string[] {
    const out = [t, o];
    for (const x of [t, o]) {
        const base = String(x || '').split(/\s+[-–—]\s+|:\s+/)[0];
        if (base && base !== x) out.push(base);
    }
    return out.filter(Boolean);
}

function score(candidate: string, list: string[]): number {
    const c = norm(candidate);
    if (!c) return 0;
    let best = 0;
    for (const x of list.map(norm)) {
        if (!x) continue;
        if (c === x) best = Math.max(best, 3);
        else if ((c.includes(x) || x.includes(c)) && Math.min(c.length, x.length) / Math.max(c.length, x.length) >= 0.6) best = Math.max(best, 2);
    }
    return best;
}

async function searchChannel(ch: Channel, q: string): Promise<any[]> {
    const url = `${API}/site/search/page/?include=default&filter[environment]=${ch.env}&v=2&q=${encodeURIComponent(q)}&page[number]=1&page[size]=20`;
    const d = await fetchJson<any>(url, { headers: siteHeaders(ch, { Accept: 'application/json, text/plain, */*' }), timeoutMs: 8000 });
    return (d && d.data) || [];
}

async function findShow(list: string[]): Promise<{ slug: string; title: string; ch: Channel } | null> {
    const queries = [...new Set(list.map(norm).filter(Boolean))];
    for (const q of queries) {
        const results = await Promise.all(CHANNELS.map((ch) => searchChannel(ch, q)));
        let best: { slug: string; title: string; ch: Channel } | null = null, bestScore = 0;
        results.forEach((items, ci) => {
            for (const it of items) {
                if (!it || !it.slug || it.type !== 'showpage') continue;
                const s = score(it.title, list);
                if (s > bestScore) { best = { slug: it.slug, title: it.title, ch: CHANNELS[ci] }; bestScore = s; }
            }
        });
        if (best) return best;
    }
    return null;
}

function findEpisode(page: any, season: number, episode: number): any | null {
    let showId: string | null = null;
    for (const b of page.blocks || []) {
        if (!showId && b?.showId) showId = String(b.showId);
        if (!showId && b?.show?.id) showId = String(b.show.id);
    }
    for (const b of page.blocks || []) {
        for (const it of [b.item, ...(b.items || [])]) {
            if (!it || typeof it !== 'object' || !it.id) continue;
            if (showId && !(it.show && String(it.show.id) === showId)) continue;
            if (Number(it.seasonNumber) === season && Number(it.episodeNumber) === episode) return it;
        }
    }
    return null;
}

async function playbackUrl(ch: Channel, videoId: string, token: string): Promise<string | null> {
    const r = await fetchText(`${API}/playback/v3/videoPlaybackInfo`, {
        method: 'POST',
        headers: siteHeaders(ch, {
            Accept: '*/*', 'Content-Type': 'application/json',
            'X-disco-client': 'WEB:UNKNOWN:wbdatv:2.1.9', 'X-disco-params': 'realm=it', Authorization: 'Bearer ' + token,
        }),
        body: JSON.stringify({
            deviceInfo: { adBlocker: false, drmSupported: false, hdrCapabilities: ['SDR'], hwDecodingCapabilities: [], soundCapabilities: ['STEREO'] },
            wisteriaProperties: {}, videoId: String(videoId),
        }),
        timeoutMs: 10000,
    });
    if (!r.ok) { log('playback HTTP', r.status); return null; }
    let d: any = null;
    try { d = JSON.parse(r.text); } catch { /* */ }
    for (const s of d?.data?.attributes?.streaming || []) {
        if (s.type === 'hls' && s.url && !(s.protection || {}).drmEnabled) return s.url;
    }
    log('nessun HLS senza DRM');
    return null;
}

export async function realtime(req: PrisynxReq): Promise<Stream[]> {
    if (req.type !== 'series') return [];
    const pid = parseId(req.id);
    if (pid.season == null || pid.episode == null) return [];
    const info = await tmdbInfo(pid, true, req.tmdbApiKey);
    if (!info || !info.title) { log('TMDB senza titolo per', req.id); return []; }
    const show = await findShow(titles(info.title, info.original));
    if (!show) { log('nessun programma Discovery per', info.title); return []; }
    const { ch, slug } = show;
    const page = await fetchJson<any>(`${API}/site/page/${encodeURIComponent(slug)}/?include=default&filter[environment]=${ch.env}&v=2&parent_slug=${ch.parent}`,
        { headers: siteHeaders(ch, { Accept: 'application/json, text/plain, */*' }), timeoutMs: 10000 });
    if (!page) { log('pagina programma non letta', slug); return []; }
    const realm = page.userMeta?.realm || {};
    const token = realm['X-REALM-IT'] || realm['X-REALM-DPLAY'];
    if (!token) { log('token anonimo non trovato'); return []; }
    const item = findEpisode(page, pid.season, pid.episode);
    if (!item) { log(`"${show.title}" S${pid.season}E${pid.episode} non disponibile su ${ch.name}`); return []; }
    const url = await playbackUrl(ch, item.id, token);
    if (!url) return [];
    const headers = siteHeaders(ch);
    const master = await fetchText(url, { headers, timeoutMs: 8000 });
    if (!master.ok || !master.text.includes('#EXTM3U')) { log('master HTTP', master.status); return []; }
    let bw = 0, bh = 0;
    for (const m of master.text.matchAll(/#EXT-X-STREAM-INF:([^\r\n]*)/g)) {
        const r = (hlsAttr(m[1], 'RESOLUTION') || '').split('x');
        const w = Number(r[0]) || 0;
        if (w > bw) { bw = w; bh = Number(r[1]) || 0; }
    }
    const q = widthToLabel(bw) || 'HD';
    const head = `${info.title} S${pad2(pid.season)}E${pad2(pid.episode)}${info.year ? ` (${info.year})` : ''}`;
    log(`"${show.title}" su ${ch.name}: ${q}`);
    // Con EasyProxy il player non deve mandare gli header del sito; senza, li passa behaviorHints.proxyHeaders.
    const finalUrl = mfpHls(url, headers, req.mfpUrl, req.mfpPsw);
    return [{
        name: 'Real Time',
        title: `${head}\n▶️ ${ch.name}\n💾 ${q}${bw ? ` • ${bw}x${bh}` : ''}`,
        url: finalUrl,
        behaviorHints: {
            notWebReady: true,
            ...(finalUrl === url ? { proxyHeaders: { request: headers } } : {}),
            bingeGroup: 'realtime-discovery',
            filename: `${info.title.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().replace(/\s+/g, '.')}.S${pad2(pid.season)}E${pad2(pid.episode)}.${q}.ITA.m3u8`,
        } as any,
    } as Stream];
}
