// Host comuni a Guardoserie e Guardaflix (stesso gestore, stessi player).
// Stato verificato il 23/11/2026:
//  - uqload.vc/e/<code>   -> POST /dl, JS "packed" con file:"...master.m3u8" (FUNZIONA)
//  - loadm.cam/#<id>      -> /api/public/resolve?file1=<id> (la vecchia /api/v1/video da' "Cannot GET")
//  - mload.cam|mloadm.cam/?v=<slug> -> solo MP4 cifrato a blocchi (.fd): NON riproducibile, si salta
import axios from 'axios';
import * as crypto from 'crypto';

export const GUARDO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HOST_TIMEOUT_MS = 8000;

export interface HostResult {
    url: string;
    headers: Record<string, string>;
    player: 'Uqload' | 'LoadM';
    hls: boolean;
}

/** Normalizza l'URL di un iframe (protocollo relativo, entita' HTML). */
export function normalizeIframeSrc(src?: string | null): string | null {
    if (!src) return null;
    let s = String(src).trim().replace(/&amp;/g, '&').replace(/&#0?38;/g, '&');
    if (!s || s.startsWith('data:')) return null;
    if (s.startsWith('//')) s = 'https:' + s;
    return /^https?:\/\//i.test(s) ? s : null;
}

export function isUqload(u: string): boolean { return /uqload/i.test(u); }
export function isLoadmHash(u: string): boolean { return /\/\/(?:www\.)?loadm\.[a-z]+\/?#/i.test(u); }
export function isMloadEncrypted(u: string): boolean { return /\/\/(?:www\.)?m?loadm?\.cam\/\?v=/i.test(u) && !isLoadmHash(u); }

// Dean Edwards packer: eval(function(p,a,c,k,e,d){...}('...',a,c,'...'.split('|')))
function unpackPacked(p: string, a: number, c: number, k: string[]): string {
    const enc = (n: number): string =>
        (n < a ? '' : enc(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    const dict: Record<string, string> = {};
    while (c--) dict[enc(c)] = k[c] || enc(c);
    return p.replace(/\b\w+\b/g, w => (Object.prototype.hasOwnProperty.call(dict, w) ? dict[w] : w));
}

async function isHlsMaster(url: string, headers: Record<string, string>): Promise<boolean> {
    try {
        const r = await axios.get(url, { headers, timeout: HOST_TIMEOUT_MS, responseType: 'text', proxy: false, validateStatus: () => true });
        return r.status === 200 && typeof r.data === 'string' && r.data.includes('#EXTM3U');
    } catch { return false; }
}

/** Uqload: stessa logica del plugin PriSynx guardoserie.js (POST /dl + unpack). */
export async function extractUqload(playerUrl: string, pageUrl: string): Promise<HostResult | null> {
    try {
        const host = (playerUrl.match(/^https?:\/\/([^/]+)/i) || [])[1] || 'uqload.vc';
        const code = (playerUrl.match(/\/(?:e\/|embed-)([A-Za-z0-9]+)/) || [])[1];
        if (!code) return null;
        const origin = `https://${host}`;
        const body = `op=embed&file_code=${encodeURIComponent(code)}&auto=1&referer=${encodeURIComponent(pageUrl)}`;
        const r = await axios.post(`${origin}/dl`, body, {
            headers: { 'User-Agent': GUARDO_UA, 'Referer': `${origin}/e/${code}`, 'Origin': origin, 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: HOST_TIMEOUT_MS, responseType: 'text', proxy: false, validateStatus: () => true
        });
        if (r.status !== 200 || typeof r.data !== 'string') { console.log(`[GuardoHosts] uqload /dl HTTP ${r.status}`); return null; }
        let src: string | undefined;
        const pm = r.data.match(/\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/);
        if (pm) {
            const unpacked = unpackPacked(pm[1], parseInt(pm[2], 10), parseInt(pm[3], 10), pm[4].split('|'));
            src = (unpacked.match(/file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)/) || [])[1];
        }
        if (!src) src = (r.data.match(/(?:sources|file|src)\s*[:=]\s*\[?\s*\{?\s*(?:file\s*:\s*)?["']([^"']+(?:m3u8|mp4)[^"']*)/i) || [])[1];
        if (!src) return null;
        if (src.startsWith('//')) src = 'https:' + src;
        if (/\/static\//i.test(src)) { console.log('[GuardoHosts] uqload: video rimosso (segnaposto)'); return null; }
        const headers = { 'User-Agent': GUARDO_UA, 'Referer': `${origin}/`, 'Origin': origin };
        const hls = /\.m3u8/i.test(src);
        if (hls && !(await isHlsMaster(src, headers))) { console.log('[GuardoHosts] uqload: master non raggiungibile'); return null; }
        return { url: src, headers, player: 'Uqload', hls };
    } catch (e: any) {
        console.log(`[GuardoHosts] uqload errore: ${e?.message || e}`);
        return null;
    }
}

const LOADM_KEY = Buffer.from('kiemtienmua911ca', 'utf-8');
const LOADM_IV = Buffer.from('1234567890oiuytr', 'utf-8');

/** LoadM: prima la API pubblica nuova, poi la vecchia API cifrata (campi source/cfNative/cf). */
export async function extractLoadm(playerUrl: string, siteHost: string): Promise<HostResult | null> {
    try {
        const [rawBase, rawId] = playerUrl.split('#');
        const id = (rawId || '').trim();
        if (!id) return null;
        const base = rawBase.replace(/\/?$/, '/');
        const headers = { 'User-Agent': GUARDO_UA, 'Referer': base };

        // 1. API pubblica (quella che usa oggi il player loadm.cam)
        const pub = await axios.get(`${base}api/public/resolve?file1=${encodeURIComponent(id)}`, {
            headers: { ...headers, 'Accept': 'application/json' }, timeout: HOST_TIMEOUT_MS, proxy: false, validateStatus: () => true
        });
        if (pub.status === 200 && pub.data && pub.data.url) {
            const url = new URL(String(pub.data.url), base).toString();
            const hls = /\.m3u8/i.test(url) || (await isHlsMaster(url, headers));
            return { url, headers, player: 'LoadM', hls };
        }
        console.log(`[GuardoHosts] loadm public resolve ${pub.status} ${pub.data?.error || ''} (id ${id})`);

        // 2. API vecchia (fino a meta' 2026)
        const legacy = await axios.get(`${base}api/v1/video`, {
            params: { id, w: '2560', h: '1440', r: siteHost },
            headers: { ...headers, 'X-Requested-With': 'XMLHttpRequest' },
            timeout: HOST_TIMEOUT_MS, responseType: 'text', proxy: false, validateStatus: () => true
        });
        if (legacy.status !== 200 || typeof legacy.data !== 'string') return null;
        const hex = legacy.data.replace(/[^0-9a-fA-F]/g, '');
        if (!hex || hex.length % 32 !== 0) return null;
        const decipher = crypto.createDecipheriv('aes-128-cbc', LOADM_KEY, LOADM_IV);
        decipher.setAutoPadding(false);
        let dec = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]);
        const pad = dec[dec.length - 1];
        if (pad >= 1 && pad <= 16) dec = dec.subarray(0, dec.length - pad);
        const txt = dec.toString('utf-8');
        const data = JSON.parse(txt.slice(0, txt.lastIndexOf('}') + 1));
        for (const cand of [data.source, data.cfNative, data.cf]) {
            if (typeof cand === 'string' && /^https?:\/\//.test(cand) && (await isHlsMaster(cand, headers))) {
                return { url: cand, headers, player: 'LoadM', hls: true };
            }
        }
    } catch (e: any) {
        console.log(`[GuardoHosts] loadm errore: ${e?.message || e}`);
    }
    return null;
}

/** Se c'e' MediaFlow/EasyProxy, incapsula l'HLS con gli header giusti; altrimenti URL diretto. */
export function wrapWithMfp(res: HostResult, mfpUrl?: string, mfpPsw?: string): string {
    if (!mfpUrl || !res.hls) return res.url;
    const params = new URLSearchParams();
    params.append('d', res.url);
    if (mfpPsw) params.append('api_password', mfpPsw);
    for (const [k, v] of Object.entries(res.headers)) params.append(`h_${k}`, v);
    return `${mfpUrl.replace(/\/+$/, '')}/proxy/hls/manifest.m3u8?${params.toString()}`;
}

/** Risolve un iframe di player in un risultato, oppure null (host non supportato o video assente). */
export async function resolveGuardoPlayer(src: string, pageUrl: string, siteHost: string): Promise<HostResult | null> {
    if (isUqload(src)) return extractUqload(src, pageUrl);
    if (isLoadmHash(src)) return extractLoadm(src, siteHost);
    if (isMloadEncrypted(src)) { console.log(`[GuardoHosts] ${src}: mload (MP4 cifrato a blocchi), non supportato`); return null; }
    return null;
}

// --- confronto titoli (come PriSynx: titolo normalizzato + anno) ---
export function normTitle(s: string): string {
    let t = String(s || '')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;|&rsquo;|&lsquo;/g, "'")
        .toLowerCase();
    try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch { /* ignore */ }
    return t.replace(/\[\s*\d{4}\s*\]|\(\s*\d{4}\s*\)/g, ' ').replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function scoreTitle(candTitle: string, candYear: number, titles: string[], year: number): number {
    const t = normTitle(candTitle);
    const wanted = titles.map(normTitle).filter(Boolean);
    let score = 0;
    if (wanted.includes(t)) score += 5;
    else {
        const parts = candTitle.split(/\s+[-–—:|]\s+|:\s+/).map(normTitle).filter(Boolean);
        if (parts.some(p => wanted.includes(p))) score += 3;
        else for (const w of wanted) {
            if (t && (t.includes(w) || w.includes(t)) && Math.min(t.length, w.length) / Math.max(t.length, w.length) >= 0.6) { score += 2; break; }
        }
    }
    if (candYear && year) {
        const d = Math.abs(candYear - year);
        score += d === 0 ? 2 : d === 1 ? 1 : -3;
    }
    return score;
}
