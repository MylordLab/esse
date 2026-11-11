'use strict';
// Provedor RedeFlixApi (redeflixapi.click). O site fica atrás de Cloudflare e
// emite tickets de reproducción vinculados ao navegador, então a página do
// player é aberta apenas em backend com Puppeteer através de proxies públicos.
// O vídeo final (MP4 direto do Cloudflare R2) é reproduzido nos controles do
// próprio Popplay — nenhum HTML/iframe do provedor vai para o frontend.
const puppeteer = require('puppeteer');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const BASE = 'https://redeflixapi.click';
const PAGE_HOST = 'redeflixapi.click';
// Hosts de vídeo permitidos (Cloudflare R2 direto, conforme documentação).
const VIDEO_HOSTS = new Set(['r2.cloudflarestorage.com', 'r2.dev']);
const VIDEO_HOST_SUFFIXES = ['.r2.cloudflarestorage.com', '.r2.dev'];
// Estado em globalThis: as rotas do Next podem carregar instâncias separadas
// do módulo no mesmo processo, e o cache/jobs precisam ser compartilhados.
const G = globalThis;
if (!G.__POPPLAY_STATE) {
  G.__POPPLAY_STATE = {
    cache: new Map(), pending: new Map(), jobs: new Map(),
    proxyCache: { expiry: 0, list: [] }, knownProxies: null,
    browserTasks: 0, queue: Promise.resolve(), jobCounter: 0
  };
}
const S = G.__POPPLAY_STATE;
const cache = S.cache, pending = S.pending, jobs = S.jobs;
const MAX_BROWSER_TASKS = 2;

// Proxies que já funcionaram antes são tentados primeiro e persistidos em
// arquivo temporário local (nunca entra no ZIP; não contém nenhum dado de vídeo).
function loadKnownProxies() {
  try {
    const data = JSON.parse(require('node:fs').readFileSync(path.join(process.cwd(), '.proxy-temp.json'), 'utf8'));
    return Array.isArray(data.proxies) ? data.proxies.filter(p => /^https?:\/\//.test(p)) : [];
  } catch { return [] }
}
function rememberProxy(proxy) {
  if (!proxy) return;
  // Marca o proxy como bom e mantém só os 10 melhores para sempre usar primeiro.
  S.knownProxies = [proxy, ...(S.knownProxies || []).filter(p => p !== proxy)].slice(0, 10);
  S.knownProxies = S.knownProxies;
  try { require('node:fs').writeFileSync(path.join(process.cwd(), '.proxy-temp.json'), JSON.stringify({ proxies: S.knownProxies, atualizadoEm: new Date().toISOString() })); } catch {}
}
const delay = ms => new Promise(r => setTimeout(r, ms));
if (S.knownProxies === null) S.knownProxies = loadKnownProxies();

function pageUrl(kind, id, season, episode) {
  if (kind === 'serie') return `${BASE}/serie/${id}/${season}/${episode}`;
  return `${BASE}/filme/${id}`;
}

// Valida candidatos de URL de vídeo: HTTPS, sem credenciais, host público
// permitido e caminho de vídeo direto.
function candidate(raw, type = '') {
  try {
    if (typeof raw !== 'string') return null;
    const u = new URL(raw.trim().replace(/\\\//g, '/').replace(/&amp;/g, '&'));
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !host) return null;
    if (net.isIP(host.replace(/^\[|\]$/g, '')) || host === 'localhost' || /\.(?:localhost|local|internal|lan)$/.test(host)) return null;
    if (u.href.length > 4096) return null;
    const allowed = VIDEO_HOSTS.has(host) || VIDEO_HOST_SUFFIXES.some(s => host.endsWith(s));
    if (!allowed) return null;
    const hls = /mpegurl|hls/i.test(type) || /\.m3u8(?:[?#]|$)/i.test(u.pathname);
    const mp4 = /video\/mp4|video\/webm/i.test(type) || /\.(mp4|webm)(?:[?#]|$)/i.test(u.pathname);
    if (!hls && !mp4) return null;
    return { url: u.href, format: hls ? 'HLS' : 'MP4' };
  } catch { return null }
}

// Confirma que a fonte responde (GET com Range; o R2 recusa HEAD com 403).
async function validateSource(url) {
  try {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Range': 'bytes=0-0' },
      signal: ctl.signal, redirect: 'follow'
    });
    clearTimeout(timer);
    if (![200, 206].includes(res.status)) return false;
    try { await res.body?.cancel(); } catch {}
    const type = (res.headers.get('content-type') || '').toLowerCase();
    return type.includes('video') || res.headers.get('content-range') || res.status === 206;
  } catch { return false }
}

// Descoberta de proxies públicos vivos (Cloudflare bloqueia o IP direto do servidor).
async function discoverProxies() {
  S.proxyCache = S.proxyCache;
  if (S.proxyCache.list.length && S.proxyCache.expiry > Date.now()) return S.proxyCache.list;
  if (process.env.POPPLAY_PROXIES === '0') return [];
  if (process.env.POPPLAY_PROXY_LIST) {
    const list = process.env.POPPLAY_PROXY_LIST.split(',').map(s => s.trim()).filter(s => /^https?:\/\//.test(s));
    S.proxyCache = S.proxyCache = { expiry: Date.now() + 60000, list };
    return list;
  }
  const script = path.join(process.cwd(), 'redeflix_proxies.py');
  const seen = new Set(); const list = [];
  // A Cloudflare bloqueia a maioria dos proxies públicos; repetimos a varredura
  // para acumular proxies vivos o suficiente para o navegador de backend.
  for (let round = 0; round < 2 && list.length < 8; round++) {
    try {
      const { stdout } = await execFileAsync(process.env.PYTHON_EXECUTABLE || 'python3', [script], { timeout: 110000, maxBuffer: 1 << 20, windowsHide: true });
      const data = JSON.parse(stdout.trim());
      const found = Array.isArray(data.proxies) ? data.proxies : [];
      for (const p of found) if (typeof p === 'string' && /^https?:\/\//.test(p) && !seen.has(p)) { seen.add(p); list.push(p); }
    } catch { break }
    if (list.length >= 10) break;
    await delay(1000);
  }
  S.proxyCache = S.proxyCache = { expiry: Date.now() + (list.length ? 45000 : 10000), list };
  return list;
}

// Abre a página do provedor em backend via proxy, clica no servidor (Dublado
// primeiro) e captura a URL direta devolvida por playerkys/source.php.
async function extractViaBrowser(url, proxy) {
  let browser;
  try {
    const args = ['--autoplay-policy=no-user-gesture-required'];
    if (proxy) args.push('--proxy-server=' + proxy);
    if (process.env.PUPPETEER_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
    browser = await puppeteer.launch({ headless: 'new', args, timeout: 25000 });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' });
    await page.setViewport({ width: 1280, height: 720 });
    // A propaganda (popunder) abre em nova aba ao clicar no botão: fechamos popups
    // e bloqueamos o script de anúncio, além de não trafegar mídia/imagem pelo proxy.
    page.on('popup', pop => pop.close().catch(() => {}));
    let sourcePayload = null;
    const videoReqs = new Map();
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      try {
        const c = candidate(u, req.resourceType() === 'media' ? 'video/mp4' : '');
        if (c) videoReqs.set(c.url, c);
      } catch {}
      const type = req.resourceType();
      if (type === 'script' && /player-popunder|popunder|\/ads?\//i.test(u)) req.abort().catch(() => {});
      else if (['media', 'image', 'font', 'stylesheet'].includes(type)) req.abort().catch(() => {});
      else req.continue().catch(() => {});
    });
    page.on('response', async res => {
      const u = res.url();
      if (/playerkys\/source\.php|playback-resolve\.php/i.test(u) && res.status() === 200) {
        try {
          const text = await res.text();
          if (text.length < 8192) { const d = JSON.parse(text); if (d && typeof d.url === 'string') sourcePayload = d; }
        } catch {}
      }
      const c = candidate(u, res.headers()['content-type'] || '');
      if (c) videoReqs.set(c.url, c);
    });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const status = response ? response.status() : 0;
    if (!response || status >= 400) return { status, error: status ? `HTTP ${status}` : 'Sem resposta' };
    await delay(1200);
    const html = await page.content();
    if (/just a moment|attention required|cf-chl-|checking your browser/i.test(html)) return { status, error: 'Verificação de acesso do provedor' };
    const title = await page.title().catch(() => '');

    // Caminho principal (sem clicar no botão, evitando a propaganda): a própria
    // página traz os tickets; chamamos os endpoints do provedor no contexto da
    // página, com o fingerprint do navegador — é exatamente o que o player faz.
    const inPage = await page.evaluate(async () => {
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Requested-With': 'RedeFlixPlayer' };
      const post = async (path, body) => {
        const r = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers, body: JSON.stringify(body) });
        let json = null; try { json = await r.json(); } catch {}
        return { status: r.status, json };
      };
      const out = { tried: [] };
      for (const server of ['default', 'legendado']) {
        const fast = (window.fastLaunchTickets && window.fastLaunchTickets[server]) || '';
        if (fast) {
          const r = await post('/playerkys/source.php', { ticket: fast });
          out.tried.push(['source(fast:' + server + ')', r.status]);
          if (r.status === 200 && r.json && r.json.url) { out.url = r.json.url; out.subtitle = r.json.subtitle || ''; return out; }
        }
      }
      const tick = window.playbackResolveTicket || '';
      if (tick) {
        for (const server of ['default', 'legendado']) {
          const r = await post('/playback-resolve.php', { ticket: tick, server });
          out.tried.push(['resolve(' + server + ')', r.status]);
          if (r.status === 200 && r.json) {
            if (r.json.url) { out.url = r.json.url; out.subtitle = r.json.subtitle || ''; return out; }
            if (r.json.launchTicket) {
              const r2 = await post('/playerkys/source.php', { ticket: r.json.launchTicket });
              out.tried.push(['source(launch:' + server + ')', r2.status]);
              if (r2.status === 200 && r2.json && r2.json.url) { out.url = r2.json.url; out.subtitle = r2.json.subtitle || ''; return out; }
            }
          }
        }
      }
      return out;
    }).catch(e => ({ error: String(e).slice(0, 120) }));
    let link = null, subtitle = '';
    if (inPage && inPage.url) {
      const c = candidate(inPage.url, /\.m3u8(?:[?#]|$)/i.test(inPage.url) ? 'application/vnd.apple.mpegurl' : 'video/mp4');
      if (c) { link = c; subtitle = inPage.subtitle || ''; }
    }

    // Fallback: clicar no botão do servidor (Dublado primeiro) e capturar a resposta.
    if (!link) {
      const pills = await page.$$('button.server-pill');
      for (let i = 0; i < Math.min(pills.length, 3) && !sourcePayload && videoReqs.size === 0; i++) {
        try { await pills[i].click(); } catch { try { await page.evaluate(idx => document.querySelectorAll('button.server-pill')[idx]?.click(), i); } catch {} }
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !sourcePayload && videoReqs.size === 0) await delay(400);
        if (sourcePayload || videoReqs.size) break;
      }
      if (!link && sourcePayload) {
        const c = candidate(sourcePayload.url, /\.m3u8(?:[?#]|$)/i.test(sourcePayload.url || '') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
        if (c) { link = c; subtitle = typeof sourcePayload.subtitle === 'string' ? sourcePayload.subtitle : ''; }
      }
      if (!link && videoReqs.size) link = [...videoReqs.values()].sort((a, b) => (a.format === 'MP4' ? 0 : 1) - (b.format === 'MP4' ? 0 : 1))[0];
    }
    return { status, title, link, subtitle, tried: inPage && inPage.tried, error: link ? undefined : 'Nenhuma fonte direta retornada pelo player' };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'Tempo esgotado ao abrir o player' : 'Falha ao abrir o player do provedor' };
  } finally { if (browser) await browser.close().catch(() => {}); }
}

function saveResult(key, data, ttl) {
  if (cache.size >= 300 && !cache.has(key)) cache.delete(cache.keys().next().value);
  cache.set(key, { expiry: Date.now() + ttl, data });
}

async function resolve(kind, id, season = 1, episode = 1) {
  if (!/^\d{1,12}$/.test(id)) throw new Error('ID inválido');
  if (kind === 'serie') {
    if (!/^\d{1,4}$/.test(String(season)) || !/^\d{1,4}$/.test(String(episode))) throw new Error('Temporada ou episódio inválido');
  }
  const key = kind === 'serie' ? `serie:${id}:${season}:${episode}` : `filme:${id}`;
  const cached = cache.get(key);
  if (cached && cached.expiry > Date.now()) return cached.data;
  if (pending.has(key)) return pending.get(key);
  const promise = (async () => {
    const url = pageUrl(kind, id, season, episode);
    const diagnostics = [];
    let lastError = 'Nenhum proxy público disponível no momento';
    let attempts = 0;
    const deadlineAll = Date.now() + (Number(process.env.POPPLAY_RESOLVE_TIMEOUT) || 170000);
    const tryOne = async proxy => {
      if (S.browserTasks >= MAX_BROWSER_TASKS) return null;
      attempts++; S.browserTasks = S.browserTasks++;
      let result;
      try { result = await extractViaBrowser(url, proxy); }
      finally { S.browserTasks = --S.browserTasks; }
      diagnostics.push({ method: 'Puppeteer', proxy: proxy ? proxy.replace(/\/\/.*@/, '//***@') : 'direto', status: result.status, error: result.error, found: !!result.link });
      if (!result.link) { lastError = result.error || lastError; return null; }
      if (!(await validateSource(result.link.url))) { lastError = 'Fonte retornada não respondeu à validação direta'; return null; }
      if (proxy) rememberProxy(proxy);
      const title = (result.title || '').replace(/\s*-\s*RedeFlixApi\s*$/i, '').trim() || (kind === 'serie' ? `Série TMDB ${id} — T${season}E${episode}` : `Filme TMDB ${id}`);
      return { title, links: [result.link], source: 'redeflixapi', subtitle: result.subtitle || undefined, diagnostics };
    };
    const prior = S.queue; let release; S.queue = S.queue = new Promise(r => { release = r; });
    await prior;
    try {
      // 1) Acesso direto: em IP residencial (servidor Node do usuário) costuma funcionar.
      let data = await tryOne(null);
      if (data) { saveResult(key, data, 300000); return data; }
      // 2) Proxies que já funcionaram nesta sessão/servidor.
      for (const proxy of S.knownProxies) {
        if (attempts >= 8 || Date.now() > deadlineAll) break;
        data = await tryOne(proxy);
        if (data) { saveResult(key, data, 300000); return data; }
      }
      // 3) Descoberta de proxies públicos vivos agora (Cloudflare bloqueia IP de datacenter).
      const discovered = await discoverProxies();
      diagnostics.push({ method: 'Proxies', found: discovered.length });
      for (const proxy of discovered) {
        if (attempts >= 8 || Date.now() > deadlineAll) break;
        data = await tryOne(proxy);
        if (data) { saveResult(key, data, 300000); return data; }
      }
      const fail = { title: kind === 'serie' ? `Série TMDB ${id} — T${season}E${episode}` : `Filme TMDB ${id}`, links: [], source: 'redeflixapi', diagnostics, error: `Não foi possível obter o vídeo do RedeFlixApi: ${lastError}. Os proxies públicos são instáveis; tente novamente.` };
      saveResult(key, fail, 5000);
      return fail;
    } finally { release(); }
  })().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

function resolveMovie(id) { return resolve('filme', id); }
function resolveSerie(id, season, episode) { return resolve('serie', id, season, episode); }

// Tarefas assíncronas: a resolução pode levar minutos (proxies instáveis), então
// a API devolve um job imediatamente e o frontend faz polling curto — nenhuma
// requisição fica pendurada tempo suficiente para estourar o proxy da prévia.
function enqueue(kind, id, season = 1, episode = 1) {
  const key = kind === 'serie' ? `serie:${id}:${season}:${episode}` : `filme:${id}`;
  const cached = cache.get(key);
  if (cached && cached.expiry > Date.now()) return { status: 'ready', data: cached.data };
  for (const job of jobs.values()) if (job.key === key && job.status === 'pending') return { status: 'pending', job: job.jobId };
  const jobId = `j${Date.now().toString(36)}${(S.jobCounter++).toString(36)}`;
  const job = { jobId, key, kind, tmdbId: id, season, episode, status: 'pending', createdAt: Date.now(), data: null, error: null };
  jobs.set(jobId, job);
  if (jobs.size > 100) jobs.delete(jobs.keys().next().value);
  resolve(kind, id, season, episode)
    .then(data => { job.status = 'ready'; job.data = data; })
    .catch(e => { job.status = 'error'; job.error = e.message; });
  return { status: 'pending', job: jobId };
}
function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return { status: job.status, data: job.data, error: job.error };
}

module.exports = { resolveMovie, resolveSerie, resolve, enqueue, getJob, pageUrl, candidate, validateSource, discoverProxies, extractViaBrowser, BASE };
