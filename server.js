const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const port = process.env.PORT || 3000;

// ---- config: set these as Railway environment variables ----
const TRIGGER_URL    = process.env.TRIGGER_URL    || 'http://srv1525980.hstgr.cloud:8090';
const TRIGGER_TOKEN  = process.env.TRIGGER_TOKEN  || '';   // the VPS .trigger_token value (kept server-side)
const APP_PASSPHRASE = process.env.APP_TRIGGER_PASSPHRASE || ''; // team passphrase the button asks for

const MON_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MON_FULL  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function ymParts(ym){ const m = /^(\d{4})-(\d{2})$/.exec(ym||''); return m ? { y:+m[1], mi:(+m[2])-1 } : null; }
function shortMonth(ym){ const p=ymParts(ym); return p ? MON_SHORT[p.mi]+' '+p.y : null; }
function fullMonth(ym){ const p=ymParts(ym); return p ? MON_FULL[p.mi]+' '+p.y : null; }

// call the VPS trigger endpoint (adds the secret token server-side)
function vps(method, pathname, query, bodyObj){
  return new Promise((resolve, reject) => {
    const url = new URL(TRIGGER_URL + pathname);
    if (query) for (const k in query) if (query[k] != null) url.searchParams.set(k, query[k]);
    const lib = url.protocol === 'https:' ? https : http;
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = Object.assign({ 'x-trigger-token': TRIGGER_TOKEN },
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {});
    const r = lib.request(url, { method, headers, timeout: 30000 }, resp => {
      const chunks = []; resp.on('data', c => chunks.push(c));
      resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('VPS request timed out')));
    if (data) r.write(data);
    r.end();
  });
}
function json(res, code, obj){ res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function parse(buf){ try { return JSON.parse(buf.toString() || '{}'); } catch (e) { return { raw: buf.toString() }; } }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    // trigger a pull: browser -> here (checks passphrase, adds token) -> VPS
    if (req.method === 'POST' && u.pathname === '/run-pulls') {
      let body = ''; for await (const c of req) body += c;
      let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) {}
      if (!APP_PASSPHRASE || j.passphrase !== APP_PASSPHRASE) return json(res, 401, { error: 'wrong passphrase' });
      const month = j.ym ? shortMonth(j.ym) : null;
      if (j.ym && !month) return json(res, 400, { error: 'bad month format (expect YYYY-MM)' });
      const r = await vps('POST', '/run-pulls', null, { month, only: j.only || null });
      return json(res, r.status, parse(r.buf));
    }
    if (req.method === 'GET' && u.pathname === '/pull-status') {
      const r = await vps('GET', '/status'); return json(res, r.status, parse(r.buf));
    }
    if (req.method === 'GET' && u.pathname === '/pull-manifest') {
      const full = fullMonth(u.searchParams.get('ym'));
      const r = await vps('GET', '/manifest', full ? { month: full } : null);
      return json(res, r.status, parse(r.buf));
    }
    if (req.method === 'GET' && u.pathname === '/pull-files') {
      const short = shortMonth(u.searchParams.get('ym'));
      if (!short) return json(res, 400, { error: 'ym required (YYYY-MM)' });
      const r = await vps('GET', '/files', { month: short }); return json(res, r.status, parse(r.buf));
    }
    if (req.method === 'GET' && u.pathname === '/pull-file') {
      const short = shortMonth(u.searchParams.get('ym'));
      const proc = u.searchParams.get('proc'), name = u.searchParams.get('name');
      if (!short || !proc || !name) return json(res, 400, { error: 'ym, proc, name required' });
      const r = await vps('GET', '/file', { month: short, proc, name });
      res.writeHead(r.status, { 'Content-Type': r.headers['content-type'] || 'application/octet-stream' });
      return res.end(r.buf);
    }
    // ---- Series 12 Simple Summary: browser -> here (passphrase + token) -> VPS ----
    if (req.method === 'POST' && u.pathname === '/series12-summary') {
      let body = ''; for await (const c of req) body += c;
      let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) {}
      if (!APP_PASSPHRASE || j.passphrase !== APP_PASSPHRASE) return json(res, 401, { error: 'wrong passphrase' });
      const month = j.ym ? shortMonth(j.ym) : null;
      if (!month) return json(res, 400, { error: 'bad month format (expect YYYY-MM)' });
      const r = await vps('POST', '/series12-summary', null, { month });
      return json(res, r.status, parse(r.buf));
    }
    if (req.method === 'GET' && u.pathname === '/series12-summary-status') {
      const r = await vps('GET', '/series12-summary-status'); return json(res, r.status, parse(r.buf));
    }
    if (req.method === 'GET' && u.pathname === '/series12-summary-file') {
      const short = shortMonth(u.searchParams.get('ym'));
      if (!short) return json(res, 400, { error: 'ym required (YYYY-MM)' });
      const r = await vps('GET', '/series12-summary-file', { month: short });
      return json(res, r.status, parse(r.buf));
    }
    // ---- daily transaction pulls ----
    if (req.method === 'POST' && u.pathname === '/run-daily') {
      let body = ''; for await (const c of req) body += c;
      let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) {}
      if (!APP_PASSPHRASE || j.passphrase !== APP_PASSPHRASE) return json(res, 401, { error: 'wrong passphrase' });
      if (!j.date || !/^\d{4}-\d{2}-\d{2}$/.test(j.date)) return json(res, 400, { error: 'date required (YYYY-MM-DD)' });
      const r = await vps('POST', '/run-daily', null, { date: j.date, only: j.only || null });
      return json(res, r.status, parse(r.buf));
    }
    if (req.method === 'GET' && u.pathname === '/daily-status') {
      const r = await vps('GET', '/daily-status'); return json(res, r.status, parse(r.buf));
    }
    if (req.method === 'GET' && u.pathname === '/daily-manifest') {
      const date = u.searchParams.get('date');
      const r = await vps('GET', '/daily-manifest', date ? { date } : null);
      return json(res, r.status, parse(r.buf));
    }
    // default: serve the app
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  } catch (e) {
    json(res, 502, { error: 'could not reach the pull server', detail: e && e.errors ? e.errors.map(x => (x.code || x) + '@' + (x.address || '?')).join(', ') : String(e) });
  }
});
server.listen(port, () => console.log('IR tool serving on ' + port));
