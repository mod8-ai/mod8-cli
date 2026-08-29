#!/usr/bin/env node
// One-time Meta (Facebook Pages + Instagram) OAuth for mod8's own brand pages.
// Usage: META_APP_SECRET=... node scripts/connect-meta.mjs   → opens http://localhost:8765/
// Saves per-Page tokens to ~/.config/mod8/meta-pages.json, then run:
//   mod8 connect add-adapter <slug> meta   (paste Page token + Page id)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';

const APP_ID = process.env.META_APP_ID || '1596201198788731';
const APP_SECRET = process.env.META_APP_SECRET;
if (!APP_SECRET) { console.error('Set META_APP_SECRET (Meta app "mod8 Social" → Settings → Basic).'); process.exit(1); }
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPES = ['pages_show_list','pages_read_engagement','pages_manage_posts','pages_manage_engagement','instagram_basic','instagram_content_publish','business_management'].join(',');
const OUT = path.join(os.homedir(), '.config', 'mod8', 'meta-pages.json');
const G = 'https://graph.facebook.com/v21.0';

async function gj(url) { const r = await fetch(url); const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j; }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === '/') {
    const auth = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${SCOPES}&response_type=code`;
    res.writeHead(302, { Location: auth }); return res.end();
  }
  if (u.pathname === '/callback') {
    try {
      const code = u.searchParams.get('code');
      if (!code) throw new Error(`no code: ${u.search}`);
      const short = await gj(`${G}/oauth/access_token?client_id=${APP_ID}&client_secret=${APP_SECRET}&redirect_uri=${encodeURIComponent(REDIRECT)}&code=${code}`);
      const long = await gj(`${G}/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${short.access_token}`);
      const acc = await gj(`${G}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${long.access_token}`);
      const pages = (acc.data || []).map(p => ({ pageId: p.id, pageName: p.name, accessToken: p.access_token, igUserId: p.instagram_business_account?.id ?? null }));
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify({ userToken: long.access_token, savedAt: new Date().toISOString(), pages }, null, 2), { mode: 0o600 });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h2>mod8 Social connected ✅</h2><p>Saved ${pages.length} page(s) to ${OUT}:</p><ul>${pages.map(p => `<li>${p.pageName} (${p.pageId})${p.igUserId ? ' + Instagram' : ''}</li>`).join('')}</ul><p>You can close this tab.</p>`);
      console.log(`\nSaved ${pages.length} page(s) → ${OUT}`);
      for (const p of pages) console.log(`  • ${p.pageName}  page=${p.pageId}${p.igUserId ? `  ig=${p.igUserId}` : ''}`);
      setTimeout(() => process.exit(0), 500);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(`Error: ${e.message}`); console.error(e.message);
    }
  }
});
server.listen(PORT, () => {
  console.log(`Open http://localhost:${PORT}/ and approve the Facebook dialog…`);
  exec(`open http://localhost:${PORT}/`);
});
