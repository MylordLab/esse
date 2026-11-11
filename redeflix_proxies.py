#!/usr/bin/env python3
"""Descoberta de proxies públicos para acessar redeflixapi.click (Cloudflare bloqueia o IP do servidor).
Imprime um JSON com a lista de proxies que responderam HTTP 200 na raiz do domínio.
Nenhuma credencial é enviada; TLS do destino permanece verificado."""
import json, random, re, sys, concurrent.futures as cf

LISTAS = [
    # Listas definidas pelo usuário
    'https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/main/all_proxies.txt',
    'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/refs/heads/main/all.json',
    'https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/all/data.json',
    'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/refs/heads/main/live.json',
    'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.json',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
]
CHECK_URL = 'https://redeflixapi.click/'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
MAX_SAMPLE = 4000
MAX_OUT = 40

def carregar_proxies():
    from curl_cffi import requests as cr
    proxies = set()
    for url in LISTAS:
        try:
            texto = cr.get(url, timeout=20, impersonate='chrome').text
        except Exception:
            continue
        if texto.lstrip().startswith('[') or texto.lstrip().startswith('{'):
            try:
                dados = json.loads(texto)
                itens = dados if isinstance(dados, list) else dados.get('proxies') or dados.get('data') or []
                for it in itens:
                    if isinstance(it, dict):
                        p = it.get('proxy') or (f"{it.get('ip')}:{it.get('port')}" if it.get('ip') else None)
                        proto = str(it.get('protocol') or it.get('type') or 'http').lower()
                    else:
                        p, proto = str(it), 'http'
                    if p and ':' in p:
                        proxies.add(('https' if 'https' in proto or 'socks5h' in proto else 'http') + '://' + p)
            except Exception:
                pass
        else:
            for linha in texto.splitlines():
                m = re.match(r'^(?:(\w+)://)?([\d.]+:\d+|\[[0-9a-f:]+\]:\d+)$', linha.strip())
                if m:
                    proxies.add((m.group(1) or 'http') + '://' + m.group(2))
    return list(proxies)

def checar(p):
    try:
        from curl_cffi import requests as cr
        r = cr.get(CHECK_URL, proxies={'http': p, 'https': p}, timeout=6,
                   impersonate=random.choice(['chrome', 'chrome124', 'safari17_0']),
                   headers={'User-Agent': UA, 'Accept': '*/*'})
        if r.status_code == 200 and len(r.text) > 1000:
            return p
    except Exception:
        pass
    return None

def main():
    random.seed()
    proxies = carregar_proxies()
    random.shuffle(proxies)
    vivos = []
    with cf.ThreadPoolExecutor(max_workers=60) as ex:
        for res in ex.map(checar, proxies[:MAX_SAMPLE]):
            if res:
                vivos.append(res)
                if len(vivos) >= MAX_OUT:
                    break
    print(json.dumps({'ok': True, 'proxies': vivos}))

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
        sys.exit(1)
