import { readFile } from 'node:fs/promises';
import path from 'node:path';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const html = await readFile(path.join(process.cwd(), 'index.html'), 'utf8');
    return new Response(html, {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
  } catch {
    return new Response('Erro ao carregar o player.', {status: 500});
  }
}
