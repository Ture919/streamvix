/**
 * MixDrop: controlla se il file esiste ancora prima di proporre lo stream.
 *
 * Su CB01 molti link MixDrop puntano a file cancellati: la pagina /e/<id>
 * (m1xdrop.net / mixdrop.ag / mixdrop.ps -> 302 -> mxdrop.click) risponde 200
 * con "WE ARE SORRY - We can't find the video". Il proxy poi risponde 404
 * "Video source not found" e l'utente vede uno stream che non parte.
 * Una sola GET per link (la stessa che il proxy farebbe al play), cache 6h.
 */

const MD_HOST_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:m[i1]{1,2}xdrop|mxdrop)[a-z0-9-]*\.[a-z]{2,}\//i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { ts: number; alive: boolean }>();

export function isMixdropUrl(url: string): boolean {
  return MD_HOST_RE.test(String(url || ''));
}

/** true = file presente, false = cancellato, null = non si sa (rete/timeout: si tiene lo stream). */
export async function mixdropAlive(url: string, timeoutMs = 8000): Promise<boolean | null> {
  const m = String(url || '').match(/^(https?:\/\/[^/]+)\/(?:e|f|emb|embed)\/([A-Za-z0-9]+)/i);
  if (!m) return null;
  const key = m[2].toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.alive;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${m[1]}/e/${m[2]}`, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': m[1] + '/' },
    });
    const html = await res.text();
    let alive: boolean | null = null;
    if (/WE ARE SORRY|can't find the video/i.test(html)) alive = false;
    else if (/eval\(function\(p,a,c,k,e,d\)|MDCore|wurl/i.test(html)) alive = true;
    if (alive !== null) cache.set(key, { ts: Date.now(), alive });
    return alive;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
