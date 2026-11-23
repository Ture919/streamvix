
import axios from 'axios';
import * as cheerio from 'cheerio';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { Stream } from 'stremio-addon-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { buildUnifiedStreamName, providerLabel } from '../utils/unifiedNames';
import { getDomain } from '../utils/domains';
import { resolveGuardoPlayer, wrapWithMfp, normalizeIframeSrc, scoreTitle, HostResult } from './guardo-hosts';

// Config constants - dynamic domain from domains.json
const getTargetDomain = () => `https://${getDomain('guardoserie') || 'guardoserie.digital'}`;

const jar = new CookieJar();

function createClient() {
    const config = {
        jar,
        proxy: false as false,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Origin': getTargetDomain(),
            'Referer': `${getTargetDomain()}/`
        }
    };

    return wrapper(axios.create(config));
}

// Main client (direct)
const client = createClient();

function getClient() {
    return client;
}

/**
 * Get a proxied URL from a list of Cloudflare Worker proxies
 * Supports rotation/failover
 */
function getWorkerUrls(): string[] {
    const raw = process.env.CF_PROXY;
    if (!raw) return [];
    return raw.split(',').map(u => u.trim().replace(/,$/, '').trim()).filter(u => u.length > 0);
}

function getProxiedUrl(targetUrl: string, workerUrl: string): string {
    const separator = workerUrl.includes('?') ? '&' : '?';
    return `${workerUrl}${separator}url=${encodeURIComponent(targetUrl)}`;
}

// Helper to fetch with bypass (Direct -> CF_PROXY -> Warp)
async function fetchWithBypass(url: string, options: any = {}): Promise<any> {
    const workers = getWorkerUrls();
    const PROXY = process.env.PROXY;

    try {
        // 1. Try direct fetch (Fastest)
        return await getClient().get(url, {
            ...options,
            // 1 s era meno del tempo di risposta reale (~1-1,5 s, misurato 23/11/2026)
            timeout: parseInt(process.env.GUARDOSERIE_TIMEOUT_MS || '8000', 10)
        });
    } catch (e: any) {
        if (e.response?.status === 403 || e.response?.status === 400 || !e.response || e.code === 'ECONNABORTED' || e.message === 'timeout exceeded') {
            
            console.log(`[Guardoserie] Blocked or timeout on ${url} (${e.response?.status || e.code || 'TIMEOUT'}), trying bypass...`);
            
            const finalTargetUrl = buildUrlWithParams(url, options.params);

            // 2. PROXY (priority)
            if (PROXY) {
                console.log(`[Guardoserie] Trying PROXY for ${url}...`);
                try {
                    const proxyAgent = new HttpsProxyAgent(PROXY);
                    const proxyRes = await axios.get(finalTargetUrl, {
                        ...options,
                        httpsAgent: proxyAgent,
                        proxy: false,
                        timeout: 8000,
                        headers: {
                            ...options.headers,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                            'Origin': getTargetDomain(),
                            'Referer': `${getTargetDomain()}/`
                        }
                    });
                    console.log(`[Guardoserie] PROXY bypass success for ${url}`);
                    return proxyRes;
                } catch (err: any) {
                    console.warn(`[Guardoserie] PROXY bypass failed for ${url}: ${err.message}`);
                }
            }

            // 3. CF_PROXY Workers (fallback, with Rotation)
            if (workers.length > 0) {
                const startIndex = Math.floor(Math.random() * workers.length);
                
                for (let i = 0; i < workers.length; i++) {
                    const workerIndex = (startIndex + i) % workers.length;
                    const workerUrl = workers[workerIndex];
                    
                    console.log(`[Guardoserie] Trying CF Worker #${workerIndex + 1} for ${url}...`);
                    try {
                        const cfProxiedUrl = getProxiedUrl(finalTargetUrl, workerUrl);
                        const cfRes = await axios.get(cfProxiedUrl, {
                            ...options,
                            proxy: false,
                            timeout: 8000
                        });
                        console.log(`[Guardoserie] CF Worker #${workerIndex + 1} success for ${url}`);
                        return cfRes;
                    } catch (cfErr: any) {
                        console.error(`[Guardoserie] CF Worker #${workerIndex + 1} failed for ${url}: ${cfErr.message}`);
                    }
                }
            }

            throw e;
        }
        throw e;
    }
}

function buildUrlWithParams(url: string, params: any): string {
    if (!params) return url;
    try {
        const urlObj = new URL(url);
        for (const [key, value] of Object.entries(params)) {
            urlObj.searchParams.append(key, String(value));
        }
        return urlObj.toString();
    } catch {
        return url;
    }
}

// --- PLAYER -> STREAM (Uqload, LoadM: vedi guardo-hosts.ts) ---

function buildGuardoserieStream(res: HostResult, isSub: boolean, mfpUrl?: string, mfpPsw?: string): Stream {
    const viaMfp = !!mfpUrl && res.hls;
    return {
        name: providerLabel('guardoserie'),
        title: buildUnifiedStreamName({
            baseTitle: res.player,
            isSub,
            proxyOn: viaMfp,
            provider: 'guardoserie',
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

// --- SEARCH & SCRAPE ---

async function getGuardoserieStreamsCore(type: string, id: string, tmdbApiKey?: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    if (type !== 'series' && type !== 'movie') return [];
    const isMovie = type === 'movie';

    console.log(`[Guardoserie] Requesting: ${id} (${type})`);

    let imdbId = id;
    let season = 1;
    let episode = 1;

    if (id.includes(':')) {
        const p = id.split(':');
        imdbId = p[0];
        season = parseInt(p[1]);
        episode = parseInt(p[2]);
    }

    let name = '';
    let year = '';

    const tmdbMeta = await getTmdbTitle(type, imdbId, tmdbApiKey);
    if (tmdbMeta) {
        name = tmdbMeta.name;
        year = tmdbMeta.year;
        console.log(`[Guardoserie] TMDB (IT) found: ${name} (${year})`);
    } else {
        const meta = await getCinemetaMeta(type, imdbId);
        if (meta) {
            name = meta.name;
            year = meta.year ? (String(meta.year).match(/\d{4}/)?.[0] || '') : '';
            console.log(`[Guardoserie] Cinemeta (Fallback) found: ${name} (${year})`);
        }
    }

    if (!name) {
        console.log(`[Guardoserie] Meta not found for ${imdbId}, skipping.`);
        return [];
    }

    const engMetaEarly = await getCinemetaMeta(type, imdbId);
    const titles = [name, engMetaEarly?.name || ''].filter(Boolean);
    const seriesUrl = await searchGuardoserie(name, year, isMovie, titles);
    if (!seriesUrl) {
        console.log(`[Guardoserie] Not found on site (IT): ${name}`);

        if (tmdbMeta) {
            const engMeta = await getCinemetaMeta(type, imdbId);
            if (engMeta && engMeta.name !== name) {
                console.log(`[Guardoserie] Trying fallback with English title: ${engMeta.name}`);
                const engUrl = await searchGuardoserie(engMeta.name, year, isMovie, titles);
                if (engUrl) {
                    console.log(`✅ [Guardoserie] Found with English title!`);
                    const targetUrl = type === 'series'
                        ? (await getEpisodeLink(engUrl, season, episode)) || engUrl
                        : engUrl;
                    return await resolvePageStream(targetUrl, mfpUrl, mfpPsw);
                }
            }
        }
        return [];
    }

    let targetUrl = seriesUrl;
    if (type === 'series') {
        const epLink = await getEpisodeLink(seriesUrl, season, episode);
        if (!epLink) {
            console.log(`[Guardoserie] Episode not found: S${season}E${episode}`);
            return [];
        }
        targetUrl = epLink;
    }

    return await resolvePageStream(targetUrl, mfpUrl, mfpPsw);
}

export async function getGuardoserieStreams(type: string, id: string, tmdbApiKey?: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    return await getGuardoserieStreamsCore(type, id, tmdbApiKey, mfpUrl, mfpPsw);
}

async function searchGuardoserie(query: string, year: string, isMovie: boolean, titles: string[] = []): Promise<string | null> {
    try {
        const base = getTargetDomain();
        const searchUrl = `${base}/?s=${encodeURIComponent(query)}`;
        console.log('[Guardoserie] Direct search:', searchUrl);

        const res = await fetchWithBypass(searchUrl);
        const $ = cheerio.load(res.data);
        const wantYear = parseInt(year, 10) || 0;
        const wanted = titles.length ? titles : [query];

        let best: { href: string, score: number } | null = null;
        $('.ml-item').each((_, el) => {
            const a = $(el).find('a[href]').first();
            const href = a.attr('href') || '';
            if (!href.startsWith(base)) return;
            const path = href.slice(base.length).split('/').filter(Boolean);
            const isSerie = path[0] === 'serie' && path.length === 2;
            const isFilm = path.length === 1 && path[0] !== 'serie' && path[0] !== 'episodio';
            if (isMovie ? !isFilm : !isSerie) return;
            const title = a.attr('oldtitle') || $(el).find('h2').first().text() || '';
            const yHit = ($(el).html() || '').match(/release-year\/(\d{4})/);
            const score = scoreTitle(title, yHit ? parseInt(yHit[1], 10) : 0, wanted, wantYear);
            if (!best || score > best.score) best = { href, score };
        });
        const chosen = best as { href: string, score: number } | null;
        if (chosen && chosen.score >= 5) {
            console.log(`[Guardoserie] Match ${chosen.href} (score ${chosen.score})`);
            return chosen.href;
        }
        console.log(`[Guardoserie] Nessun risultato affidabile per "${query}" (miglior score ${chosen ? chosen.score : 'n/d'})`);
    } catch (e) {
        console.error(`[Guardoserie] Search failed: ${e}`);
    }
    return null;
}

async function getEpisodeLink(seriesUrl: string, season: number, episode: number): Promise<string | null> {
    const slug = (seriesUrl.match(/\/serie\/([^/]+)/) || [])[1];
    if (slug) {
        const direct = `${getTargetDomain()}/episodio/${slug}-stagione-${season}-episodio-${episode}/`;
        try {
            const r = await fetchWithBypass(direct);
            if (r.status === 200 && /id="player2"|<iframe/i.test(String(r.data))) return direct;
        } catch { /* fallback sotto */ }
    }
    try {
        const res = await fetchWithBypass(seriesUrl);
        const $ = cheerio.load(res.data);
        const seasons = $('div.les-content');
        if (seasons.length < season) return null;

        const seasonDiv = seasons.eq(season - 1);
        const episodeLinks = seasonDiv.find('a');
        if (episodeLinks.length < episode) return null;

        return episodeLinks.eq(episode - 1).attr('href') || null;
    } catch (e) {
        console.error(`[Guardoserie] Get episode failed: ${e}`);
    }
    return null;
}

async function resolvePageStream(pageUrl: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    const streams: Stream[] = [];
    try {
        const res = await fetchWithBypass(pageUrl);
        const $ = cheerio.load(res.data);
        const siteHost = new URL(getTargetDomain()).hostname;

        const tabLangMap: Record<string, 'ITA' | 'SUB'> = {};
        $('a[href^="#tab"]').each((_, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().toLowerCase();
            const tabId = href.substring(1);
            if (text.includes('sub')) tabLangMap[tabId] = 'SUB';
            else if (text.includes('ita')) tabLangMap[tabId] = 'ITA';
        });

        const players: { src: string, isSub: boolean }[] = [];
        const seen = new Set<string>();
        const pick = (ifr: any) => normalizeIframeSrc($(ifr).attr('data-src')) || normalizeIframeSrc($(ifr).attr('src'));
        $('#player2 > div[id^="tab"]').each((_, tabDiv) => {
            const isSub = tabLangMap[$(tabDiv).attr('id') || ''] === 'SUB';
            // Uqload usa <IFRAME SRC=...>, gli altri data-src (lazyload): cheerio normalizza il maiuscolo
            $(tabDiv).find('iframe').each((__, ifr) => {
                const src = pick(ifr);
                if (src && !seen.has(src)) { seen.add(src); players.push({ src, isSub }); }
            });
        });
        if (players.length === 0) {
            $('iframe').each((_, ifr) => {
                const src = pick(ifr);
                if (src && !seen.has(src)) { seen.add(src); players.push({ src, isSub: false }); }
            });
        }
        console.log(`[Guardoserie] ${players.length} player: ${players.map(p => (p.src.match(/\/\/([^/]+)/) || [])[1]).join(', ')}`);

        const results = await Promise.all(players.map(p => resolveGuardoPlayer(p.src, pageUrl, siteHost)));
        results.forEach((r, i) => { if (r) streams.push(buildGuardoserieStream(r, players[i].isSub, mfpUrl, mfpPsw)); });
    } catch (e) {
        console.error(`[Guardoserie] Resolve page failed: ${e}`);
    }
    return streams;
}

async function getTmdbTitle(type: string, imdbId: string, tmdbApiKey?: string): Promise<{ name: string, year: string } | null> {
    try {
        const apiKey = tmdbApiKey || '40a9faa1f6741afb2c0c40238d85f8d0';
        const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id&language=it-IT`;
        const res = await axios.get(url, { timeout: 5000 });
        const results = type === 'series' ? res.data.tv_results : res.data.movie_results;
        if (results && results.length > 0) {
            const data = results[0];
            return {
                name: data.title || data.name || data.original_title || data.original_name,
                year: (data.release_date || data.first_air_date || '').split('-')[0]
            };
        }
    } catch (e) {}
    return null;
}

async function getCinemetaMeta(type: string, imdbId: string): Promise<{ name: string, year: string } | null> {
    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
        const res = await axios.get(url, { timeout: 5000 });
        if (res.data && res.data.meta) {
            return {
                name: res.data.meta.name,
                year: (res.data.meta.year || (res.data.meta.releaseInfo || '').split('-')[0] || '').toString()
            };
        }
    } catch (e) {}
    return null;
}
