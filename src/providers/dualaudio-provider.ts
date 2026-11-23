// Fork Ture919 (23/11/2026): MovyITA e DualSync, portati da PriSynx providers/movyita.js e providers/dualsync.js.
// Video 4K/FHD da un sito internazionale (Movy; Cinejoy, Vidfast/Vidcore/Vidup) + audio e sottotitoli ITA da vixsrc
// (StreamingCommunity) uniti in una playlist HLS "master" scritta in una data: URI (come fa PriSynx).
// Il ritardo dell'audio ITA misurato da ToastFlix/AutoSync (sola lettura: qui NON si inviano misure da fare) va nel
// behaviorHints.audioDelayMs, che solo NuvioTV applica; gli altri player lo ignorano. Gli stream "fuori sync" (velocita'
// diversa, tagli, versioni diverse) non vengono mostrati.
import type { Stream } from 'stremio-addon-sdk';
import { PrisynxReq, parseId, tmdbInfo, fetchText, pad2, hlsAttr, absUrl, TmdbInfo } from './prisynx-common';

const log = (tag: string, ...a: any[]) => { try { console.log(`[${tag}]`, ...a); } catch { /* */ } };

// ------------------------------------------------------------------ comune: vixsrc (audio ITA)
const VIX_DOMAINS_URL = 'https://raw.githubusercontent.com/realbestia1/domains/refs/heads/main/domains.json';
const VIX_DEFAULT_BASE = 'https://vixsrc.to';
const VIX_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const TOASTFLIX_URL = 'https://toastflix.stremio-italia.eu';
const AUTOSYNC_STATUS_URL = 'https://autosync.stremio-italia.eu/plugin/jobs/status';
const SYNC_OK_S = 0.025;
const RATE_TOL = SYNC_OK_S / 7200;
const DELAY_STEP_MS = 25;
const MAX_DELAY_MS = 60000;
const FPS_PAIRS = [[23.976, 24], [24, 25], [23.976, 25]];
const QUALITY: Record<string, { label: string; resolution: string; bandwidth: number }> = {
    '2160': { label: '2160p', resolution: '3840x2160', bandwidth: 16000000 },
    '1080': { label: '1080p', resolution: '1920x1080', bandwidth: 6000000 },
    '720': { label: '720p', resolution: '1280x720', bandwidth: 3000000 },
};

interface ItaTracks { audio: string; eng: string | null; subs: { uri: string; name: string; forced: boolean }[]; headers: Record<string, string>; }

async function getText(url: string, headers: Record<string, string>, ms: number): Promise<string> {
    const r = await fetchText(url, { headers, timeoutMs: ms });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
    return r.text;
}

async function vixBaseAlt(): Promise<string | null> {
    try {
        const t = await getText(VIX_DOMAINS_URL + '?_=' + Date.now(), { Accept: 'application/json' }, 6000);
        const cfg = JSON.parse(t.replace(/("[^"\r\n]+")\s*("[^"]+"\s*:)/g, '$1,$2'));
        const b = String(cfg?.vixsrc || '').trim().replace(/\/+$/, '');
        return /^https?:\/\//i.test(b) ? b : null;
    } catch { return null; }
}

async function italianTracks(tmdbId: string, isTv: boolean, s: number, e: number): Promise<ItaTracks | null> {
    const apiPath = isTv ? `/api/tv/${tmdbId}/${s}/${e}` : `/api/movie/${tmdbId}`;
    const hdr = (base: string) => ({ 'User-Agent': VIX_UA, Referer: base + '/', Accept: 'application/json', 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8' });
    let base = VIX_DEFAULT_BASE;
    let payload: any;
    try { payload = JSON.parse(await getText(base + apiPath + '?lang=it', hdr(base), 12000)); }
    catch (err) {
        const alt = await vixBaseAlt();
        if (!alt || alt === base) throw err;
        base = alt;
        payload = JSON.parse(await getText(base + apiPath + '?lang=it', hdr(base), 12000));
    }
    if (!payload?.src) return null;
    const embed = absUrl(String(payload.src), base + '/');
    const html = await getText(embed, { 'User-Agent': VIX_UA, Referer: base + '/' }, 12000);
    const token = (html.match(/'token'\s*:\s*'([^']+)'/) || [])[1];
    const expires = (html.match(/'expires'\s*:\s*'([^']+)'/) || [])[1];
    const playlist = (html.match(/url\s*:\s*'([^']+\/playlist\/\d+[^']*)'/) || [])[1];
    if (!token || !expires || !playlist) return null;
    const fhd = /window\.canPlayFHD\s*=\s*true/.test(html) || /[?&]canPlayFHD=1/.test(embed);
    const masterUrl = playlist + (playlist.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) +
        '&expires=' + encodeURIComponent(expires) + (fhd ? '&h=1' : '') + '&lang=it';
    const headers = { 'User-Agent': VIX_UA, Referer: embed, Origin: base };
    const master = await getText(masterUrl, headers, 12000);
    let audio: string | null = null, eng: string | null = null;
    const subs: ItaTracks['subs'] = [];
    for (const line of master.split(/\r?\n/)) {
        if (!line.startsWith('#EXT-X-MEDIA:') || !hlsAttr(line, 'URI')) continue;
        const type = hlsAttr(line, 'TYPE');
        const lang = String(hlsAttr(line, 'LANGUAGE') || '').toLowerCase();
        const name = String(hlsAttr(line, 'NAME') || '');
        const uri = absUrl(hlsAttr(line, 'URI')!, masterUrl);
        if (type === 'AUDIO') {
            if (!audio && (lang === 'ita' || lang === 'it' || /^ita/i.test(name))) audio = uri;
            else if (!eng && (lang === 'eng' || lang === 'en' || /^eng|english/i.test(name))) eng = uri;
        } else if (type === 'SUBTITLES') {
            const forced = /forced/i.test(name + ' ' + lang) || hlsAttr(line, 'FORCED') === 'YES';
            if (subs.some((x) => x.uri === uri || x.forced === forced)) continue;
            subs.push({ uri, name: name || 'Italiano', forced });
        }
    }
    return audio ? { audio, eng, subs, headers } : null;
}

// ------------------------------------------------------------------ comune: master HLS in data: URI
const quoteSafe = (v: string) => String(v).replace(/["\r\n]/g, '').replace(/[^\x20-\x7e]/g, '');

function masterDataUri(videoUrl: string, qkey: string, ita: ItaTracks, original?: { uri: string; lang: string } | null,
    videoSubs: { uri: string; name: string; lang: string; forced: boolean }[] = []): string {
    const q = QUALITY[qkey];
    // Prima riga con CR "nudo": il parser m3u generico di mpv non la prende; FFmpeg/ExoPlayer accettano il CR (nota PriSynx).
    const lines = ['#EXTM3U\r#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Italiano",LANGUAGE="it",DEFAULT=YES,AUTOSELECT=YES,URI="${quoteSafe(ita.audio)}"`);
    if (original) lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Originale",LANGUAGE="${quoteSafe(original.lang || 'en')}",DEFAULT=NO,AUTOSELECT=NO,URI="${quoteSafe(original.uri)}"`);
    let hasSubs = false;
    for (const s of ita.subs) {
        hasSubs = true;
        lines.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${quoteSafe(s.name)}",LANGUAGE="it",DEFAULT=NO,AUTOSELECT=${s.forced ? 'YES' : 'NO'},FORCED=${s.forced ? 'YES' : 'NO'},URI="${quoteSafe(s.uri)}"`);
    }
    for (const s of videoSubs) {
        hasSubs = true;
        lines.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${quoteSafe(s.name)}",LANGUAGE="${quoteSafe(s.lang || 'en')}",DEFAULT=NO,AUTOSELECT=NO,FORCED=${s.forced ? 'YES' : 'NO'},URI="${quoteSafe(s.uri)}"`);
    }
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${q.bandwidth},RESOLUTION=${q.resolution},AUDIO="aud"${hasSubs ? ',SUBTITLES="subs"' : ''}`);
    lines.push(quoteSafe(videoUrl));
    let text = lines.join('\n') + '\n';
    // Il base64 deve finire con '=' perche' FFmpeg si fermi prima di "#.m3u8"; "data://" e "/m3u8/" per mpv e NuvioTV (note PriSynx).
    if (text.length % 3 === 0) text += '\n';
    return 'data://application/m3u8/;base64,' + Buffer.from(text, 'latin1').toString('base64') + '#.m3u8';
}

// ------------------------------------------------------------------ comune: verdetto di sync
interface SyncInfo { status: string; offsetMs: number | null; rate: number; hasCuts: boolean; }
interface Sync { level: 'green' | 'yellow' | 'red' | 'unknown'; tag: string; delayMs?: number; info?: SyncInfo; }

const delayOf = (sec: number) => Math.round(sec * 1000 / DELAY_STEP_MS) * DELAY_STEP_MS;
const fmtDelay = (ms: number) => (ms >= 0 ? '+' : '') + String(ms / 1000).replace('.', ',') + ' s';

function fpsPair(rate: number): string | null {
    for (const [a, b] of FPS_PAIRS) {
        const r = a / b;
        if (Math.abs(rate - r) < 0.0003 || Math.abs(rate - 1 / r) < 0.0003) return `${a}<->${b} fps`;
    }
    return null;
}

function classify(d: any): Sync {
    const info: SyncInfo = { status: d.status, offsetMs: d.offset == null ? null : Math.round(Number(d.offset) * 1000), rate: Number(d.rate || 1), hasCuts: !!d.has_cuts };
    if (d.status !== 'ok') return { level: 'red', tag: d.status === 'incompatible' ? 'versioni diverse' : 'sync n/d', info };
    if (Math.abs(info.rate - 1) > RATE_TOL) return { level: 'red', tag: fpsPair(info.rate) || 'velocita diversa', info };
    if (info.hasCuts) return { level: 'red', tag: 'tagli diversi', info };
    const off = Number(d.offset || 0);
    if (Math.abs(off) <= SYNC_OK_S) return { level: 'green', tag: 'audio ITA in sync', delayMs: 0, info };
    const ms = delayOf(off);
    if (Math.abs(ms) > MAX_DELAY_MS) return { level: 'red', tag: `offset ${fmtDelay(ms)}`, info };
    return { level: 'yellow', tag: `ritardo audio ITA ${fmtDelay(ms)} (auto solo NuvioTV)`, delayMs: ms, info };
}

async function autoSyncMeasured(mediaKey: string): Promise<any[]> {
    try {
        const d = JSON.parse(await getText(`${AUTOSYNC_STATUS_URL}?media_key=${encodeURIComponent(mediaKey)}`, { Accept: 'application/json' }, 2500));
        return (d?.items || []).filter((it: any) => it.status === 'done' && it.result?.status === 'ok').map((it: any) => ({
            provider: it.provider, status: 'ok', offset: it.result.offset, rate: it.result.rate || 1, has_cuts: !!it.result.has_cuts, video_duration: it.video_duration,
        }));
    } catch { return []; }
}

function syncLines(s: Sync): string {
    const icon = s.level === 'green' ? '🔊' : s.level === 'yellow' ? '⏱️' : '⚠️';
    return `${icon} ${s.tag}`;
}

function buildStream(tag: 'MovyITA' | 'DualSync', info: TmdbInfo, isTv: boolean, s: number, e: number, qkey: string, host: string,
    url: string, headers: Record<string, string>, sync: Sync, subs: { url: string; lang: string; id: string }[]): Stream {
    const head = `${info.title}${isTv ? ` S${pad2(s)}E${pad2(e)}` : ''}${info.year ? ` (${info.year})` : ''}`;
    const fnTitle = info.title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().replace(/\s+/g, '.');
    const hints: any = {
        notWebReady: true,
        proxyHeaders: { request: headers },
        bingeGroup: `${tag.toLowerCase()}-${qkey}`,
        filename: `${fnTitle}${isTv ? `.S${pad2(s)}E${pad2(e)}` : info.year ? `.${info.year}` : ''}.${QUALITY[qkey].label}.ITA.ENG.m3u8`,
    };
    if (sync.delayMs !== undefined) { hints.audioDelayMs = sync.delayMs; hints.audioDelayLanguage = 'it'; }
    return {
        name: tag,
        title: `${head}\n▶️ ${host}\n💾 ${QUALITY[qkey].label}\n${syncLines(sync)}\n🔈 audio ITA (StreamingCommunity) + originale`,
        url,
        subtitles: subs.length ? subs : undefined,
        behaviorHints: hints,
    } as any;
}

function subsFor(ita: ItaTracks): { url: string; lang: string; id: string }[] {
    return ita.subs.map((x, i) => ({ id: `ita-${i}`, url: x.uri, lang: 'ita' }));
}

// ================================================================== MovyITA
const MOVY_SITES = ['https://www.movy.sx', 'https://movy.sx'];
let movyCfg = { site: MOVY_SITES[0], api: 'https://api.wecollege.net' };
const MOVY_SERVERS = ['miami', 'boise', 'atlanta', 'orlando', 'phoenix', 'seattle', 'denver', 'portland', 'dallas', 'tampa',
    'paris', 'cancun', 'berlin', 'austin', 'delhi', 'munich'];
const MOVY_MEASURED = ['miami', 'boise']; // solo i file di questi server sono misurati da ToastFlix
const MOVY_BUDGET_MS = 8000;
const MOVY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const movyHeaders = (site: string) => ({ 'User-Agent': MOVY_UA, Accept: '*/*', Origin: site, Referer: site + '/' });

// cifrario del payload Movy (porting fedele di PriSynx movyita.js, a sua volta da movy.js)
function uHash(e: number): number {
    e >>>= 0; e ^= e >>> 16; e = Math.imul(e, 0x85ebca6b) >>> 0; e ^= e >>> 13; e = Math.imul(e, 0xc2b2ae35) >>> 0;
    return (e ^= e >>> 16) >>> 0;
}
const rotl = (e: number, t: number) => { e >>>= 0; t &= 31; return t === 0 ? e >>> 0 : ((e << t) | (e >>> (32 - t))) >>> 0; };
function initKey(seed: string, mediaId: number): { S: number[]; acc: number } {
    const S: number[] = new Array(61);
    let h = 0x811c9dc5;
    for (let a = 0; a < seed.length; a++) h = Math.imul(h ^ seed.charCodeAt(a), 0x1000193) >>> 0;
    let i = uHash(uHash(h) ^ uHash((mediaId >>> 0) ^ 0x9e3779b9)) >>> 0;
    for (let e = 0; e < 8; e++) {
        const t = i % 61;
        i = rotl((i + 0x9e3779b9) >>> 0, 7 + (7 & e));
        S[t] = (i ^ uHash(i)) >>> 0;
        i = uHash((i + t) >>> 0);
    }
    return { S, acc: uHash(0xa5a5a5a5 ^ i) >>> 0 };
}
function nextWord(st: { S: number[]; acc: number }, t: number): number {
    const S = st.S; let acc = st.acc; const idx = acc % 61;
    const inBounds = idx in S ? -1 : 0;
    const s = (((S[idx] as number) >>> 0) ^ (Math.imul(0x9e3779b9, t + 1) >>> 0)) >>> 0;
    let c = (((acc ^ s) >>> 0) | ((acc & s & inBounds) >>> 0)) >>> 0;
    c = (rotl((c + acc) >>> 0, 31 & idx) ^ rotl(acc, 31 & Math.imul(idx, 7))) >>> 0;
    acc = uHash((c + 0x9e3779b9) >>> 0);
    S[idx] = acc >>> 0; st.acc = acc;
    return acc >>> 0;
}
function decryptMovy(encB64: string, seed: string, mediaId: number): string {
    const raw = Buffer.from(encB64.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, ''), 'base64');
    const st = initKey(seed, mediaId);
    const out = Buffer.alloc(raw.length);
    for (let i = 0, r = 0; i < raw.length; r++) {
        const w = nextWord(st, r);
        for (let b = 0; b < 4 && i < raw.length; b++, i++) out[i] = raw[i] ^ ((w >>> (8 * b)) & 255);
    }
    if (out.subarray(0, 4).toString('latin1') !== 'mvm1') throw new Error('Movy payload magic mismatch');
    return out.subarray(4).toString('utf8');
}
const toQuery = (p: Record<string, string>) => Object.keys(p).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(p[k]).replace(/%20/g, '+')).join('&');
function movyQkey(q: string): string | null {
    const s = String(q || '').toLowerCase();
    if (s.includes('4k')) return '2160';
    const m = s.match(/(\d{3,4})p/);
    return m && QUALITY[m[1]] ? m[1] : null;
}
function masterVariants(body: string, base: string): { url: string; qkey: string }[] {
    const lines = body.split(/\r?\n/), out: { url: string; qkey: string }[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
        const w = Number(String(hlsAttr(lines[i], 'RESOLUTION') || '').split('x')[0]);
        const uri = lines[i + 1].trim();
        const qk = w >= 3200 ? '2160' : w >= 1800 ? '1080' : w >= 1200 ? '720' : null;
        if (qk && uri && !uri.startsWith('#')) out.push({ url: absUrl(uri, base), qkey: qk });
    }
    return out;
}

async function movySeed(tmdbId: string): Promise<string> {
    const d = JSON.parse(await getText(`${movyCfg.api}/seed?mediaId=${tmdbId}`, movyHeaders(movyCfg.site), 10000));
    if (!d?.seed) throw new Error('Movy: no seed');
    return d.seed;
}

async function movySources(info: TmdbInfo, enTitle: string, isTv: boolean, s: number, e: number) {
    let seed: string;
    try { seed = await movySeed(info.tmdbId); }
    catch (err) {
        // l'host delle API cambia: lo si rilegge dalla home del sito solo quando quello noto non risponde
        let found: { site: string; api: string } | null = null;
        for (const site of MOVY_SITES) {
            const r = await fetchText(site + '/', { headers: { 'User-Agent': MOVY_UA, Accept: 'text/html' }, timeoutMs: 8000 });
            if (!r.ok) continue;
            const apis = (r.text.match(/https:\/\/api\.[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) || []).filter((u) => !/tmdb|themoviedb|google|cloudflare/i.test(u));
            found = { site: (r.url.match(/^https?:\/\/[^/]+/i) || [site])[0], api: apis[0] || movyCfg.api };
            break;
        }
        if (!found || (found.api === movyCfg.api && found.site === movyCfg.site)) throw err;
        movyCfg = found;
        seed = await movySeed(info.tmdbId);
    }
    const headers = movyHeaders(movyCfg.site);
    const out: { url: string; qkey: string; server: string; measured: boolean }[] = [];
    const have: Record<string, boolean> = {}, dirOk: Record<string, boolean> = {};
    const started = Date.now();
    for (let n = 0; n < MOVY_SERVERS.length; n++) {
        if (have['2160'] && have['1080']) break;
        if (n > 0 && Date.now() - started > MOVY_BUDGET_MS) break;
        const server = MOVY_SERVERS[n];
        const add = (url: string, qk: string) => {
            if (have[qk] || !['2160', '1080', '720'].includes(qk)) return;
            have[qk] = true;
            out.push({ url, qkey: qk, server: server[0].toUpperCase() + server.slice(1), measured: MOVY_MEASURED.includes(server) });
        };
        const params: Record<string, string> = {
            title: encodeURIComponent(enTitle), mediaType: isTv ? 'tv' : 'movie', year: info.year ? String(info.year) : '',
            tmdbId: info.tmdbId, imdbId: info.imdbId || '', enc: '2', seed,
        };
        if (isTv) { params.seasonId = String(s); params.episodeId = String(e); }
        try {
            const enc = (await getText(`${movyCfg.api}/${server}/sources?${toQuery(params)}`, headers, n < 2 ? 15000 : 6000)).trim();
            if (!enc) continue;
            const data = JSON.parse(decryptMovy(enc, seed, Number(info.tmdbId)));
            const list = (data.sources || []).filter((x: any) => x?.url && /\.m3u8(?:$|[?#])/i.test(x.url));
            for (const src of list) {
                if (n > 0 && Date.now() - started > MOVY_BUDGET_MS) break;
                const qk = movyQkey(src.quality); const url = String(src.url);
                const dir = url.split('?')[0].replace(/[^/]*$/, '');
                if ((qk && (have[qk] || !QUALITY[qk])) || dirOk[dir] === false) continue;
                if (qk && dirOk[dir]) { add(url, qk); continue; }
                const body = await fetchText(url, { headers: { ...headers, Range: 'bytes=0-65535' }, timeoutMs: 8000 });
                if (body.ok && body.text.includes('#EXT-X-STREAM-INF')) masterVariants(body.text, url).forEach((v) => add(v.url, v.qkey));
                else if (body.ok && body.text.includes('#EXTINF')) { dirOk[dir] = true; if (qk) add(url, qk); }
                else dirOk[dir] = false;
            }
        } catch (err: any) {
            log('MovyITA', `server ${server}: ${err?.message || err}`);
        }
    }
    return { sources: out, headers };
}

// Fork Ture919 (23/11/2026): alcuni server video (es. Movy "Atlanta") danno solo i primi ~30 pezzi e poi 404:
// il player parte e si blocca dopo 2 minuti. Prima di proporre la fonte si provano un pezzo a meta' e l'ultimo.
async function videoIntero(videoUrl: string, headers: Record<string, string>): Promise<boolean> {
    try {
        let url = videoUrl;
        let testo = await getText(url, headers, 8000);
        const varianti = [...testo.matchAll(/#EXT-X-STREAM-INF[^\n]*\n([^\n#][^\n]*)/g)].map((m) => m[1].trim());
        if (varianti.length) { url = new URL(varianti[varianti.length - 1], url).toString(); testo = await getText(url, headers, 8000); }
        const pezzi = testo.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
        if (pezzi.length < 40) return true;
        for (const k of [Math.floor(pezzi.length / 2), pezzi.length - 1]) {
            const r = await fetch(new URL(pezzi[k], url).toString(), { headers: { ...headers, Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(6000) } as any);
            try { await r.arrayBuffer(); } catch { /* corpo non letto */ }
            if (r.status === 404 || r.status === 410 || r.status === 403) return false;
        }
        return true;
    } catch {
        return true; // nel dubbio (lentezza, rete) la fonte resta
    }
}

export async function movyIta(req: PrisynxReq): Promise<Stream[]> {
    const isTv = req.type === 'series';
    const pid = parseId(req.id);
    if (isTv && (pid.season == null || pid.episode == null)) return [];
    const s = pid.season || 1, e = pid.episode || 1;
    const [info, en] = await Promise.all([
        tmdbInfo(pid, isTv, req.tmdbApiKey, s, e),
        tmdbInfo(pid, isTv, req.tmdbApiKey, null, null, ''),
    ]);
    if (!info || !info.title) return [];
    const enTitle = en?.title || info.original || info.title;
    const mediaKey = `${isTv ? 'series' : 'movie'}:${info.imdbId}:${isTv ? s : 0}:${isTv ? e : 0}`;
    const [movy, ita, status] = await Promise.all([
        movySources(info, enTitle, isTv, s, e).catch((err) => { log('MovyITA', 'Movy:', err?.message || err); return { sources: [], headers: {} as Record<string, string> }; }),
        italianTracks(info.tmdbId, isTv, s, e).catch((err) => { log('MovyITA', 'vixsrc:', err?.message || err); return null; }),
        info.imdbId ? fetchText(`${TOASTFLIX_URL}/dual/offset/status?imdb=${encodeURIComponent(info.imdbId)}&type=${isTv ? 'series' : 'movie'}&season=${isTv ? s : 0}&episode=${isTv ? e : 0}&provider=movy&audio_source=vixsrc`,
            { headers: { Accept: 'application/json' }, timeoutMs: 4000 }).then((r) => { try { return JSON.parse(r.text); } catch { return null; } }) : Promise.resolve(null),
    ]);
    if (!movy.sources.length) { log('MovyITA', 'nessuna sorgente Movy per', info.title); return []; }
    if (!ita) { log('MovyITA', 'audio ITA non trovato su vixsrc per', info.title); return []; }
    let measured: Sync = { level: 'unknown', tag: 'sync audio ITA non misurato' };
    if (status && status.found && status.status === 'ok') measured = classify(status);
    else {
        const auto = (await autoSyncMeasured(mediaKey)).filter((x) => String(x.provider || '').toLowerCase() === 'movy');
        if (auto.length) measured = classify(auto[0]);
    }
    const out: Stream[] = [];
    const interi = await Promise.all(movy.sources.map((src) => videoIntero(src.url, movy.headers)));
    const buone = movy.sources.filter((src, i) => { if (!interi[i]) log('MovyITA', `Movy ${src.server} ${src.qkey}p scartato: video interrotto (404 a meta')`); return interi[i]; });
    for (const src of buone.sort((a, b) => Number(b.qkey) - Number(a.qkey))) {
        const sync = src.measured ? measured : { level: 'unknown', tag: 'sync audio ITA non misurato (server diverso)' } as Sync;
        if (sync.level === 'red') continue;
        out.push(buildStream('MovyITA', info, isTv, s, e, src.qkey, `Movy ${src.server}`,
            masterDataUri(src.url, src.qkey, ita), movy.headers, sync, subsFor(ita)));
    }
    log('MovyITA', `${out.length} stream (sync ${measured.level}) per ${info.title}`);
    return out;
}

// ================================================================== DualSync (Cinejoy + Vidfast/Vidcore/Vidup)
const DS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const ENCDEC_API = 'https://enc-dec.app/api';
const VIDFAST_SITES = [
    { name: 'Vidfast', key: 'vidfast', origin: 'https://vidfast.vc' },
    { name: 'Vidcore', key: 'vidcore', origin: 'https://vidcore.io' },
    { name: 'Vidup', key: 'vidup', origin: 'https://vidup.to' },
];
const CINEJOY_API = 'https://api.wing.st';
const CINEJOY_ORIGIN = 'https://cinejoy.pk';
const DS_BUDGET_MS = 22000;
const DB_TOL_S = 0.25;

interface Encode {
    site: string; server: string; headers: Record<string, string>; length: number;
    renditions: Record<string, { url: string }>; original: { uri: string; lang: string } | null;
    subtitles: { uri: string; name: string; lang: string; forced: boolean }[]; qualities?: string[];
}

async function send(url: string, opts: { method?: string; headers?: Record<string, string>; body?: any }, ms: number): Promise<Response> {
    const r = await fetch(url, { method: opts.method || 'GET', headers: opts.headers, body: opts.body, signal: AbortSignal.timeout(ms) } as any);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
    return r;
}

// enc-dec.app (servizio di terzi usato da PriSynx) cifra/decifra le richieste di Cinejoy e Vidfast: risponde {status, result}
async function encdec(path: string, payload?: any): Promise<any> {
    const r = payload === undefined
        ? await send(`${ENCDEC_API}/${path}`, { headers: { Accept: 'application/json' } }, 15000)
        : await send(`${ENCDEC_API}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) }, 15000);
    const d: any = await r.json();
    if (!d || d.status !== 200) throw new Error(`enc-dec ${path.split('?')[0]}: ${d && (d.error || d.status)}`);
    return d.result;
}

const playlistLength = (t: string) => { let tot = 0; for (const m of t.matchAll(/#EXTINF:([\d.]+)/g)) tot += Number(m[1]); return Math.round(tot * 100) / 100; };

async function resolveEncode(site: string, server: string, url: string, headers: Record<string, string>): Promise<Encode | null> {
    const text = await getText(url, headers, 10000);
    if (!text.includes('#EXT-X-STREAM-INF')) return null; // una media playlist non dice la risoluzione
    const lines = text.split(/\r?\n/);
    const variants: { width: number; bandwidth: number; audio: string | null; url: string }[] = [];
    const audios: { group: string | null; lang: string; def: boolean; uri: string }[] = [];
    const subs: Encode['subtitles'] = [];
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('#EXT-X-MEDIA:')) {
            const type = hlsAttr(l, 'TYPE'); const uri = hlsAttr(l, 'URI');
            if (!uri) continue;
            if (type === 'AUDIO') audios.push({ group: hlsAttr(l, 'GROUP-ID'), lang: String(hlsAttr(l, 'LANGUAGE') || '').toLowerCase(), def: hlsAttr(l, 'DEFAULT') === 'YES', uri: absUrl(uri, url) });
            else if (type === 'SUBTITLES') subs.push({ uri: absUrl(uri, url), name: String(hlsAttr(l, 'NAME') || 'Sub'), lang: String(hlsAttr(l, 'LANGUAGE') || 'en').toLowerCase(), forced: hlsAttr(l, 'FORCED') === 'YES' });
        } else if (l.startsWith('#EXT-X-STREAM-INF:')) {
            const u = String(lines[i + 1] || '').trim();
            if (!u || u.startsWith('#')) continue;
            variants.push({ width: Number(String(hlsAttr(l, 'RESOLUTION') || '').split('x')[0]) || 0, bandwidth: Number(hlsAttr(l, 'BANDWIDTH')) || 0, audio: hlsAttr(l, 'AUDIO'), url: absUrl(u, url) });
        }
    }
    const rend: Record<string, { url: string; audio: string | null }> = {};
    for (const v of variants.sort((a, b) => b.bandwidth - a.bandwidth)) {
        const q = v.width >= 3200 ? '2160' : v.width >= 1800 ? '1080' : null;
        if (q && !rend[q]) rend[q] = v;
    }
    const top = rend['2160'] || rend['1080'];
    if (!top) return null;
    const length = playlistLength(await getText(top.url, headers, 12000));
    if (!length) return null;
    const group = audios.filter((a) => a.group === top.audio);
    const orig = group.find((a) => a.def) || group.find((a) => /^en/.test(a.lang)) || group[0] || null;
    return { site, server, headers, length, renditions: rend, original: orig ? { uri: orig.uri, lang: orig.lang } : null, subtitles: subs };
}

const is4k = (sv: any) => (sv && sv['4k'] === true) || /4k/i.test(String((sv && (sv.description || sv.image || sv.name)) || '')) ? 1 : 0;

async function pickFromServers(keep: { add: (e: Encode) => void; expired: () => boolean }, siteName: string, servers: any[], open: (sv: any) => Promise<Encode | null>) {
    servers = servers.slice().sort((a, b) => is4k(b) - is4k(a));
    let uhd: Encode | null = null, fhd: Encode | null = null;
    for (let i = 0; i < servers.length && !keep.expired(); i++) {
        if (fhd && (uhd || !servers.slice(i).some(is4k))) break;
        if (uhd && is4k(servers[i])) continue;
        try {
            const enc = await open(servers[i]);
            if (!enc) continue;
            if (!uhd && enc.renditions['2160']) uhd = enc;
            else if (!fhd && !enc.renditions['2160']) fhd = enc;
        } catch (err: any) { log('DualSync', `${siteName} ${servers[i]?.name}: ${err?.message || err}`); }
    }
    if (uhd) { uhd.qualities = fhd || !uhd.renditions['1080'] ? ['2160'] : ['2160', '1080']; keep.add(uhd); }
    if (fhd) { fhd.qualities = ['1080']; keep.add(fhd); }
}

async function cinejoy(ctx: { info: TmdbInfo; enTitle: string; isTv: boolean; s: number; e: number }, keep: any) {
    const headers = { 'User-Agent': DS_UA, Accept: '*/*', Origin: CINEJOY_ORIGIN, Referer: CINEJOY_ORIGIN + '/' };
    const list = (JSON.parse(await getText(`${CINEJOY_API}/servers`, headers, 8000)) || {}).servers || [];
    const servers = list.filter((x: any) => x && x.name && x.status === 'ok');
    await pickFromServers(keep, 'Cinejoy', servers, async (server) => {
        const p: Record<string, string> = { title: ctx.enTitle, type: ctx.isTv ? 'series' : 'movie', year: ctx.info.year ? String(ctx.info.year) : '', imdb: ctx.info.imdbId, tmdb: ctx.info.tmdbId, server: server.name };
        if (ctx.isTv) { p.season = String(ctx.s); p.episode = String(ctx.e); }
        const q = Object.keys(p).map((k) => k + '=' + encodeURIComponent(p[k])).join('&');
        const sealed = await encdec('enc-cinejoy?url=' + encodeURIComponent(`${CINEJOY_API}/?${q}`));
        const ans = await send(`${CINEJOY_API}/g`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain;charset=UTF-8' }, body: Buffer.from(String(sealed.data), 'base64') }, 12000);
        const bytes = Buffer.from(await ans.arrayBuffer());
        const opened = await encdec('dec-cinejoy', { text: bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), state: sealed.state });
        for (const st of (opened?.data?.stream || []).filter((x: any) => x && x.playlist)) {
            const enc = await resolveEncode('Cinejoy', server.name, st.playlist, headers);
            if (enc) return enc;
        }
        return null;
    });
}

async function vidfast(site: typeof VIDFAST_SITES[number], ctx: { info: TmdbInfo; isTv: boolean; s: number; e: number }, keep: any) {
    const page = site.origin + (ctx.isTv ? `/tv/${ctx.info.tmdbId}/${ctx.s}/${ctx.e}` : `/movie/${ctx.info.tmdbId}`) + '/';
    const html = await getText(page, { 'User-Agent': DS_UA, Referer: site.origin + '/' }, 12000);
    const token = (html.match(/\\"(?:en|token)\\":\\"([^"\\]+)\\"/) || [])[1];
    if (!token) throw new Error('token not found');
    const p1 = await encdec(`enc-${site.key}?text=${encodeURIComponent(token)}&stage=1`);
    if (!p1?.stage1) throw new Error('stage 1 failed');
    const headers: Record<string, string> = { 'User-Agent': DS_UA, Referer: site.origin + '/', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': p1.token };
    const r1 = await (await send(p1.stage1, { method: 'POST', headers, body: '' }, 10000)).text();
    const parts = await encdec(`enc-${site.key}?text=${encodeURIComponent(r1)}&stage=2`);
    if (!parts?.servers || !parts?.stream) throw new Error('stage 2 failed');
    if (parts.token) headers['X-CSRF-Token'] = parts.token;
    const sl = await (await send(parts.servers, { method: 'POST', headers, body: '' }, 10000)).text();
    const servers = (await encdec(`dec-${site.key}`, { text: sl })) || [];
    await pickFromServers(keep, site.name, servers, async (server) => {
        const sealed = await (await send(`${parts.stream}/${server.data}`, { method: 'POST', headers, body: '' }, 10000)).text();
        const stream = await encdec(`dec-${site.key}`, { text: sealed });
        if (!stream?.url) return null;
        const ph: Record<string, string> = stream.noReferrer ? { 'User-Agent': DS_UA } : { 'User-Agent': DS_UA, Referer: site.origin + '/', Origin: site.origin };
        return resolveEncode(site.name, server.name, stream.url, ph);
    });
}

export async function dualSync(req: PrisynxReq): Promise<Stream[]> {
    const deadline = Date.now() + DS_BUDGET_MS;
    const isTv = req.type === 'series';
    const pid = parseId(req.id);
    if (isTv && (pid.season == null || pid.episode == null)) return [];
    const s = pid.season || 1, e = pid.episode || 1;
    const [info, en] = await Promise.all([tmdbInfo(pid, isTv, req.tmdbApiKey, s, e), tmdbInfo(pid, isTv, req.tmdbApiKey, null, null, '')]);
    if (!info || !info.title) return [];
    const enTitle = en?.title || info.original || info.title;
    const ctx = { info, enTitle, isTv, s, e };
    const mediaKey = `${isTv ? 'series' : 'movie'}:${info.imdbId}:${isTv ? s : 0}:${isTv ? e : 0}`;
    const encodes: Encode[] = [];
    const keep = {
        expired: () => Date.now() > deadline,
        // stessa durata della playlist = stesso file raggiunto da un altro server o sito
        add: (enc: Encode) => { if (!encodes.some((x) => Math.abs(x.length - enc.length) < 0.05)) encodes.push(enc); },
    };
    const collect = (async () => {
        try { await cinejoy(ctx, keep); } catch (err: any) { log('DualSync', 'Cinejoy:', err?.message || err); }
        for (const site of VIDFAST_SITES) {
            if (keep.expired()) break;
            const before = encodes.length;
            try { await vidfast(site, ctx, keep); } catch (err: any) { log('DualSync', `${site.name}:`, err?.message || err); }
            if (encodes.length > before) break;
        }
    })();
    const [ita, cand, auto] = await Promise.all([
        italianTracks(info.tmdbId, isTv, s, e).catch((err) => { log('DualSync', 'vixsrc:', err?.message || err); return null; }),
        info.imdbId ? fetchText(`${TOASTFLIX_URL}/dual/offset/candidates?imdb=${encodeURIComponent(info.imdbId)}&type=${isTv ? 'series' : 'movie'}&season=${isTv ? s : 0}&episode=${isTv ? e : 0}&audio_source=vixsrc`,
            { headers: { Accept: 'application/json' }, timeoutMs: 8000 }).then((r) => { try { return JSON.parse(r.text)?.items || []; } catch { return []; } }) : Promise.resolve([]),
        autoSyncMeasured(mediaKey),
        collect,
    ]);
    if (!encodes.length) { log('DualSync', 'nessun video 4K/FHD per', info.title); return []; }
    if (!ita) { log('DualSync', 'audio ITA non trovato su vixsrc per', info.title); return []; }
    const measured: any[] = [...(cand as any[])];
    for (const am of auto) if (!measured.some((m) => Math.abs(Number(m.video_duration) - Number(am.video_duration)) <= DB_TOL_S)) measured.push(am);
    let itaLength = 0;
    const out: Stream[] = [];
    for (const enc of encodes) {
        let hit: any = null, best = Infinity;
        for (const m of measured) {
            if (m.provider && String(m.provider).toLowerCase() !== enc.site.toLowerCase()) continue;
            const d = Math.abs(Number(m.video_duration) - enc.length);
            if (d <= DB_TOL_S && d < best) { hit = m; best = d; }
        }
        let sync: Sync;
        if (hit) sync = classify(hit);
        else {
            // senza misura parlano solo le durate: stessa durata dell'audio ITA (+-1 s) = probabile sync
            if (!itaLength) itaLength = playlistLength(await getText(ita.audio, ita.headers, 12000).catch(() => ''));
            const diff = itaLength ? itaLength - enc.length : NaN;
            if (itaLength && fpsPair(itaLength / enc.length)) sync = { level: 'red', tag: 'velocita diversa' };
            else if (itaLength && Math.abs(diff) <= 1) sync = { level: 'unknown', tag: 'sync non misurato, stessa durata dell\'audio ITA' };
            else if (itaLength && Math.abs(diff) <= 15) sync = { level: 'unknown', tag: `sync non misurato, durata diversa ${fmtDelay(Math.round(diff * 10) * 100)}` };
            else sync = { level: 'red', tag: 'durata diversa' };
        }
        if (sync.level === 'red') { log('DualSync', `${enc.site}/${enc.server} scartato: ${sync.tag}`); continue; }
        const vsubs = enc.subtitles.slice(0, 6);
        for (const qk of enc.qualities || []) {
            const r = enc.renditions[qk];
            if (!r) continue;
            if (!(await videoIntero(r.url, enc.headers))) { log('DualSync', `${enc.site}/${enc.server} ${qk}p scartato: video interrotto (404 a meta')`); continue; }
            out.push(buildStream('DualSync', info, isTv, s, e, qk, `${enc.site} ${enc.server}`, masterDataUri(r.url, qk, ita, enc.original, vsubs), enc.headers, sync, subsFor(ita)));
        }
    }
    log('DualSync', `${out.length} stream da ${encodes.length} encode per ${info.title}`);
    return out;
}
