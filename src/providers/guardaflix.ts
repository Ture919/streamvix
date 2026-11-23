import { CookieJar } from 'tough-cookie';
import { Stream } from 'stremio-addon-sdk';
import { buildUnifiedStreamName, providerLabel } from '../utils/unifiedNames';
import * as cheerio from 'cheerio';
import { fetch, ProxyAgent, Response } from 'undici';
import { getDomain } from '../utils/domains';
import { resolveGuardoPlayer, wrapWithMfp, normalizeIframeSrc, scoreTitle, isUqload, HostResult } from './guardo-hosts';

// Config constants - dynamic domain from domains.json
const getTargetDomain = () => `https://${getDomain('guardaflix') || 'guardaplay.bar'}`;

const jar = new CookieJar();

const SHARED_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.7,en;q=0.6',
};

/**
 * Get a proxied URL from a list of Cloudflare Worker proxies
 * Supports rotation/failover
 */
function getWorkerUrls(): string[] {
    const raw = process.env.CF_PROXY;
    if (!raw) return [];
    return raw.split(',').map(u => u.trim().replace(/,$/, '').trim()).filter(u => u.length > 0);
}

function getProxiedUrl(targetUrl: string, workerUrl: string, referer?: string): string {
    const separator = workerUrl.includes('?') ? '&' : '?';
    let finalUrl = `${workerUrl}${separator}url=${encodeURIComponent(targetUrl)}`;
    if (referer) {
        finalUrl += `&h=referer:${encodeURIComponent(referer)}`;
    }
    return finalUrl;
}

// Helper for fetch with timeout
async function fetchWithTimeout(url: string, options: any = {}, timeoutMs: number = 10000): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // @ts-ignore
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } finally {
        clearTimeout(timeoutId);
    }
}

// Helper to fetch with cookies
async function fetchWithCookies(url: string, options: any = {}, timeoutMs: number = 10000, dispatcher?: any): Promise<{ data: string; status: number; headers: any }> {
    const cookieString = await jar.getCookieString(url);
    const headers = {
        ...SHARED_HEADERS,
        ...options.headers,
        'Cookie': cookieString
    };

    const fetchOpts: any = { ...options, headers };
    if (dispatcher) fetchOpts.dispatcher = dispatcher;

    const response = await fetchWithTimeout(url, fetchOpts, timeoutMs);

    // Handle Set-Cookie
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
        try {
            if (Array.isArray(setCookie)) {
                for (const c of setCookie) await jar.setCookie(c, url);
            } else {
                await jar.setCookie(setCookie, url);
            }
        } catch (e) { console.error('[Guardaflix] Cookie error:', e); }
    }

    const text = await response.text();
    return {
        data: text,
        status: response.status,
        headers: response.headers
    };
}

// Helper to fetch with bypass (Direct -> CF_PROXY -> Warp)
async function fetchWithBypass(url: string, options: any = {}): Promise<{ data: string; status: number; headers: any }> {
    const workers = getWorkerUrls();
    const PROXY = process.env.PROXY;

    try {
        // 1. Try direct fetch (Fastest)
        const res = await fetchWithCookies(url, options, parseInt(process.env.GUARDAFLIX_TIMEOUT_MS || '8000', 10));
        if (res.status === 403 || res.status === 400) {
            throw Object.assign(new Error(`HTTP ${res.status}`), { response: { status: res.status } });
        }
        return res;
    } catch (e: any) {
        const status = e.response?.status;
        const isBlock = status === 403 || status === 400;
        const isTimeout = e.code === 'ABORT_ERR' || e.name === 'AbortError' || e.code === 'UND_ERR_ABORTED' || e.message?.includes('abort');
        const isNetwork = !e.response;

        if (isBlock || isTimeout || isNetwork) {
            
            console.log(`[Guardaflix] Blocked or timeout on ${url} (${status || e.code || 'TIMEOUT'}), trying bypass...`);

            // 2. PROXY (priority)
            if (PROXY) {
                console.log(`[Guardaflix] Trying PROXY for ${url}...`);
                try {
                    const proxyAgent = new ProxyAgent(PROXY);
                    const proxyRes = await fetchWithCookies(url, {
                        ...options,
                        headers: {
                            ...SHARED_HEADERS,
                            ...options.headers,
                            'Origin': getTargetDomain(),
                            'Referer': `${getTargetDomain()}/`
                        }
                    }, 8000, proxyAgent);
                    console.log(`[Guardaflix] PROXY bypass success for ${url}`);
                    return proxyRes;
                } catch (err: any) {
                    console.warn(`[Guardaflix] PROXY bypass failed for ${url}: ${err.message}`);
                }
            }

            // 3. CF_PROXY Workers (fallback, with Rotation)
            if (workers.length > 0) {
                const startIndex = Math.floor(Math.random() * workers.length);
                
                for (let i = 0; i < workers.length; i++) {
                    const workerIndex = (startIndex + i) % workers.length;
                    const workerUrl = workers[workerIndex];
                    
                    console.log(`[Guardaflix] Trying CF Worker #${workerIndex + 1} for ${url}...`);
                    try {
                        const cfProxiedUrl = getProxiedUrl(url, workerUrl, options.headers?.['Referer']);
                        const cfRes = await fetchWithCookies(cfProxiedUrl, options, 8000);
                        console.log(`[Guardaflix] CF Worker #${workerIndex + 1} success for ${url}`);
                        return cfRes;
                    } catch (cfErr: any) {
                        console.error(`[Guardaflix] CF Worker #${workerIndex + 1} failed for ${url}: ${cfErr.message}`);
                    }
                }
            }
        }
        throw e;
    }
}

// --- UQLOAD VIA MFP (EasyProxy) ---
function buildUqloadMfpStream(uqloadUrl: string, mfpUrl: string, mfpPsw?: string, isSub: boolean = false): Stream {
    const extractorUrl = `${mfpUrl.replace(/\/+$/, '')}/extractor/video`;
    const params = new URLSearchParams();
    params.append('host', 'Uqload');
    params.append('d', uqloadUrl);
    params.append('redirect_stream', 'true');
    if (mfpPsw) params.append('api_password', mfpPsw);

    const finalUrl = `${extractorUrl}?${params.toString()}`;
    console.log(`[Guardaflix] Uqload via MFP: ${finalUrl}`);

    return {
        name: providerLabel('guardaflix'),
        title: buildUnifiedStreamName({
            baseTitle: 'Uqload',
            isSub: isSub,
            proxyOn: true,
            provider: 'guardaflix',
            playerName: 'Uqload',
            hideProviderInTitle: true
        }),
        url: finalUrl,
        behaviorHints: {
            notWebReady: true
        }
    };
}

// --- SEARCH & SCRAPE ---

async function searchGuardaflix(query: string, year: string, titles: string[] = []): Promise<string | null> {
    try {
        const searchUrl = `${getTargetDomain()}/?s=${encodeURIComponent(query)}`;
        console.log('[Guardaflix] Direct search:', searchUrl);

        const res = await fetchWithBypass(searchUrl);
        console.log('[GF][Direct] search html length', res.data.length);
        const $ = cheerio.load(res.data);
        const wantYear = parseInt(year, 10) || 0;
        const wanted = titles.length ? titles : [query];

        // Dal 2026 i risultati sono <article class="post ... movies"> con h2.entry-title,
        // span.year e un link vuoto a.lnk-blk verso /movies/<slug>/ (prima era /film/<slug>/)
        let best: { href: string, score: number } | null = null;
        let count = 0;
        $('article.post').each((_, el) => {
            const href = $(el).find('a[href*="/movies/"], a[href*="/film/"]').first().attr('href') || '';
            if (!/\/(?:movies|film)\/[a-z0-9-]+/i.test(href)) return;
            count++;
            const title = $(el).find('.entry-title').first().text().trim();
            const y = parseInt($(el).find('.year').first().text().trim(), 10) || 0;
            const score = scoreTitle(title, y, wanted, wantYear);
            const abs = href.startsWith('http') ? href : `${getTargetDomain()}${href}`;
            if (!best || score > best.score) best = { href: abs, score };
        });
        console.log('[Guardaflix] Found', count, 'candidate links');
        const chosen = best as { href: string, score: number } | null;
        if (chosen && chosen.score >= 5) {
            console.log(`[Guardaflix] Match ${chosen.href} (score ${chosen.score})`);
            return chosen.href;
        }
        console.log(`[Guardaflix] Nessun risultato affidabile (miglior score ${chosen ? chosen.score : 'n/d'})`);
    } catch (e) {
        console.error(`[Guardaflix] Search failed: ${e}`);
    }
    return null;
}

function buildGuardaflixStream(res: HostResult, isSub: boolean, mfpUrl?: string, mfpPsw?: string): Stream {
    const viaMfp = !!mfpUrl && res.hls;
    return {
        name: providerLabel('guardaflix'),
        title: buildUnifiedStreamName({
            baseTitle: res.player,
            isSub,
            proxyOn: viaMfp,
            provider: 'guardaflix',
            playerName: res.player,
            hideProviderInTitle: true
        }),
        url: wrapWithMfp(res, mfpUrl, mfpPsw),
        behaviorHints: {
            notWebReady: true,
            ...(viaMfp ? {} : { proxyHeaders: { request: res.headers } })
        } as any
    };
}

async function resolvePageStream(pageUrl: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    const streams: Stream[] = [];
    try {
        const res = await fetchWithBypass(pageUrl);
        const $ = cheerio.load(res.data);
        const siteHost = new URL(getTargetDomain()).hostname;

        // href="#options-N" -> span.server "Loadm -ITA" / "uqload -ITA" / "... -SUB"
        const optLangMap: Record<string, 'ITA' | 'SUB'> = {};
        $('.aa-tbs li a, .video-options ul li a').each((_, el) => {
            const href = $(el).attr('href');
            const serverSpan = $(el).find('span.server').text().toLowerCase();
            if (href && href.startsWith('#options-')) {
                if (serverSpan.includes('sub')) optLangMap[href.substring(1)] = 'SUB';
                else if (serverSpan.includes('ita')) optLangMap[href.substring(1)] = 'ITA';
            }
        });

        const pick = (doc: any, ifr: any) => normalizeIframeSrc(doc(ifr).attr('data-src')) || normalizeIframeSrc(doc(ifr).attr('src'));
        const players: { src: string, isSub: boolean }[] = [];
        const seen = new Set<string>();
        const add = (src: string | null, isSub: boolean) => { if (src && !seen.has(src)) { seen.add(src); players.push({ src, isSub }); } };

        let optionDivs = $('.video.aa-tb[id^="options-"]').toArray();
        const fromOptions = optionDivs.length > 0;
        if (!fromOptions) optionDivs = [$.root().get(0) as any];
        for (const optDiv of optionDivs) {
            const isSub = fromOptions && optLangMap[$(optDiv).attr('id') || ''] === 'SUB';
            for (const iframe of $(optDiv).find('iframe').toArray()) {
                const src = pick($, iframe);
                if (!src) continue;
                if (src.includes('trembed=')) {
                    // pagina intermedia del tema WordPress: contiene l'iframe vero (loadm/uqload/mload/vixsrc)
                    try {
                        const embedRes = await fetchWithBypass(src, { headers: { 'Referer': pageUrl } });
                        const $e = cheerio.load(embedRes.data);
                        $e('iframe').each((_, n) => add(pick($e, n), isSub));
                    } catch (e) {
                        console.error(`[Guardaflix] Failed to inspect embed: ${e}`);
                    }
                } else {
                    add(src, isSub);
                }
            }
        }
        console.log(`[Guardaflix] ${players.length} player: ${players.map(p => (p.src.match(/\/\/([^/]+)/) || [])[1]).join(', ')}`);

        for (const p of players) {
            const r = await resolveGuardoPlayer(p.src, pageUrl, siteHost);
            if (r) streams.push(buildGuardaflixStream(r, p.isSub, mfpUrl, mfpPsw));
            else if (isUqload(p.src) && mfpUrl) streams.push(buildUqloadMfpStream(p.src, mfpUrl, mfpPsw, p.isSub)); // ripiego vecchio
        }
    } catch (e) {
        console.error(`[Guardaflix] Resolve page failed: ${e}`);
    }
    return streams;
}

// --- HELPER: TMDB ---
// Keep using native fetch here too for consistency, or generic axios.
// TMDB API doesn't need proxy usually, but let's stick to simple fetch.
async function getTmdbTitle(type: string, paramId: string, tmdbApiKey?: string): Promise<{ name: string, year: string } | null> {
    try {
        const apiKey = tmdbApiKey || '40a9faa1f6741afb2c0c40238d85f8d0';
        const imdbId = paramId.split(':')[0];

        let url: string;
        if (paramId.startsWith('tmdb:')) {
            const tmdbId = paramId.replace('tmdb:', '');
            url = `https://api.themoviedb.org/3/${type === 'series' ? 'tv' : 'movie'}/${tmdbId}?api_key=${apiKey}&language=it-IT`;
        } else {
            url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id&language=it-IT`;
        }

        console.log(`[Guardaflix] Fetching TMDB info from: ${url}`);
        const res = await fetchWithTimeout(url, {}, 5000);
        const data: any = await res.json();

        if (paramId.startsWith('tmdb:')) {
            const name = data.title || data.name || data.original_title || data.original_name;
            const date = data.release_date || data.first_air_date || '';
            const year = date.split('-')[0];
            return { name, year };
        } else {
            const results = type === 'series' ? data.tv_results : data.movie_results;
            if (results && results.length > 0) {
                const first = results[0];
                const name = first.title || first.name || first.original_title || first.original_name;
                const date = first.release_date || first.first_air_date || '';
                const year = date.split('-')[0];
                return { name, year };
            }
        }

    } catch (e) {
        console.error(`[Guardaflix] TMDB fetch failed: ${e}`);
    }
    return null;
}

async function getCinemetaMeta(type: string, paramId: string): Promise<{ name: string, year: string } | null> {
    const imdbId = paramId.split(':')[0]; // tt12345
    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
        console.log(`[Guardaflix] Fetching Cinemeta from: ${url}`);
        const res = await fetchWithTimeout(url, {}, 5000);
        const data: any = await res.json();
        if (data && data.meta) {
            return {
                name: data.meta.name,
                year: data.meta.year || (data.meta.releaseInfo || '').split('-')[0]
            };
        }
    } catch (e) {
        console.error(`[Guardaflix] Cinemeta fetch failed: ${e}`);
    }
    return null;
}

// --- PUBLIC INTERFACE ---

export async function getGuardaflixStreams(type: string, id: string, tmdbApiKey?: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    return await getGuardaflixStreamsCore(type, id, tmdbApiKey, mfpUrl, mfpPsw);
}

async function getGuardaflixStreamsCore(type: string, id: string, tmdbApiKey?: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    // Only Movies supported for now
    if (type !== 'movie') return [];

    console.log(`[Guardaflix] Requesting: ${id} (${type})`);

    let imdbId = id;
    if (id.includes(':')) {
        imdbId = id.split(':')[0];
    }

    // Fetch Metadata (TMDB)
    const tmdbMeta = await getTmdbTitle(type, imdbId, tmdbApiKey);
    if (!tmdbMeta) {
        console.log(`[Guardaflix] Meta not found for ${imdbId}, skipping.`);
        return [];
    }

    const { name, year } = tmdbMeta;
    console.log(`[Guardaflix] TMDB (IT) found: ${name} (${year})`);

    const engMetaEarly = await getCinemetaMeta(type, imdbId);
    const titles = [name, engMetaEarly?.name || ''].filter(Boolean);
    const pageUrl = await searchGuardaflix(name, year, titles);
    if (!pageUrl) {
        console.log(`[Guardaflix] Not found on site (IT): ${name}`);

        // Fallback: Try English title if we used TMDB (IT)
        // Check cinemeta for english title
        if (tmdbMeta) {
            const engMeta = await getCinemetaMeta(type, imdbId);
            if (engMeta && engMeta.name !== name) {
                console.log(`[Guardaflix] Trying fallback with English title: ${engMeta.name}`);
                const engUrl = await searchGuardaflix(engMeta.name, year, titles);
                if (engUrl) {
                    console.log(`✅ [Guardaflix] Found with English title!`);
                    return await resolvePageStream(engUrl, mfpUrl, mfpPsw);
                }
            }
        }
        return [];
    }

    return await resolvePageStream(pageUrl, mfpUrl, mfpPsw);
}

// End of file
