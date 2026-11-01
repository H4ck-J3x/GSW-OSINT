// GeoSleuth Web: upload a screenshot, run headless Claude Code with the geo-sleuth skill,
// stream its @@GEO markers to the browser as NDJSON.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = process.env.PORT || 8787;
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const MAX_BYTES = 20 * 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const MARKERS = `This run feeds a LIVE map UI. The UI ONLY updates when you print marker lines, and it shows them the moment you print them.
Marker = ONE line on its own in your normal text output (never inside a tool call), "@@GEO " + compact JSON:
@@GEO {"type":"clue","text":"<short clue, in French>","for":["UY"],"against":["AR"]}   ("for"/"against": ISO alpha-2 codes this clue points to / rules out; omit both for a clue that points to no country; write the text as "<what you see> -> <country>", e.g. "Ligne centrale jaune + rives blanches -> Uruguay")
@@GEO {"type":"countries","weights":{"FR":0.6,"BE":0.3,"CH":0.1}}   (ISO 3166-1 alpha-2, plausible countries only, weights sum ~1)
@@GEO {"type":"area","bbox":[south,west,north,east],"label":"<region/city>"}   (one per narrowing level)
@@GEO {"type":"area","alt":true,"bbox":[south,west,north,east],"label":"<country: region>"}   (best zone of a runner-up country you have not ruled out; shown on the map without moving the camera)
@@GEO {"type":"final","lat":0,"lon":0,"radius_m":50,"label":"<place>","confidence":"high|medium|low"}   (only if a point holds up under checking)
@@GEO {"type":"landmark","lat":0,"lon":0,"emoji":"🚇","label":"Entrée du tunnel de la Margineda","why":"<what in the photo it matches>","box":[x0,y0,x1,y1]}   (one per anchor that identified the place; box = where it appears in the input photo, as FRACTIONS 0-1 of width/height, e.g. [0.48,0.18,0.62,0.30]; measure it from your crops, omit box if the anchor is not visible in the photo)
If no point can be pinned, end with a range instead of final:
@@GEO {"type":"range","shape":"circle","lat":0,"lon":0,"radius_m":20000,"label":"...","missing":"<what info is missing>"}
@@GEO {"type":"range","shape":"polygon","points":[[lat,lon],...],"label":"...","missing":"..."}   (polygon for bands/corridors)
When a country drops out, simply leave it out of the next countries marker: the UI removes it and the clues that only pointed to it.
Write prose in French.`;

const QUICK_PROMPT = (file) => `Read ./${file} and give your fast GeoGuessr-style read of it: print one countries marker, 3-5 clue markers (vegetation, road, poles, terrain, language, architecture...) each with "for" (and "against" when it rules a country out), and one area marker for the most likely region if you have one. Markers only, no other text, no other tools.`;

const DEEP_RULES = `${MARKERS}
TIMING RULE (most important): after EVERY tool result that teaches you something (intake, OCR, reverse search, board rank, a lookup, a region-pack meta, a terrain or satellite scan), write a short text message with the updated markers BEFORE your next tool call. Markers printed only in the final summary are useless to the UI.`;

const DEEP_PROMPT = (file) => `Geolocate ./${file} with the geo-sleuth skill (Skill tool), following its full process.
CITY FROM REVERSE SEARCH FIRST: after intake, read every label/tag line of intake.md, Yandex tags included. A city or place named by 2+ variants (e.g. "andorra la vieja" = Andorra la Vella) is your strongest lead even if the "City level" vote line says none: print it as an area marker right away, then confirm or reject it (poi.py / gazetteer, satellite, street view) BEFORE any generic search like tunnels or road networks.
LANDMARKS: once you print a final (or an area tighter than ~2 km), print a landmark marker for EVERY anchor that pinned the place: tunnel portals, the hotel/shop/restaurant with its real name, roundabouts, bridges, churches, peaks or ridges you matched, signs, pylons. Coordinates must come from a command output (osm.py, poi.py, gazetteer, a satellite tile you measured), never guessed; if an anchor has no verified position, leave it out. Pick a fitting emoji (🚇 tunnel, 🏨 hotel, 🔄 roundabout, 🌉 bridge, ⛪ church, ⛰️ peak, 🪧 sign, 🏪 shop, ⛽ fuel, 🚏 stop) and put the real name in the label.
CLUES ALWAYS POINT SOMEWHERE: every clue that favours or rules out a country carries "for"/"against" ISO codes, and its text reads "<what you see> -> <country>". Only pure scene description (weather, season) goes without.
TIE-BREAK BEFORE NARROWING: while a runner-up country has at least half the leader's weight, do NOT narrow below country level yet. For the leader and each close runner-up:
- run regions.py show <cc> when a pack exists, and read references/clues/global.md otherwise;
- compare what is visible in the photo, country by country: utility poles (material, shape, crossarms, insulators), roadside bollards and delineators, road markings (edge and centre line colour, dashed or solid, spacing), guardrails and their posts, chevrons, signs, kerbs, road surface, vegetation and geology;
- print one clue marker per discriminating feature (e.g. "Bornes blanches à bande noire : SI oui, BG non") and a fresh countries marker after each comparison;
- print an area marker with "alt":true for the best zone of every runner-up you keep.
Only commit to one country when a feature you actually see separates them. If nothing separates them, say so, keep the alt areas and narrow the leader while noting the runner-up. Keep the alt areas up to date as you go, and name the runner-up in the final summary.
Do NOT stop once you have a country or a broad zone. Keep digging level by level (country -> region -> province/district -> valley/corridor -> road -> point), printing an area marker at each level:
- region-pack metas (regions.py show <cc>): road markings, bollards, poles, guardrails, signs, plates, chevrons, vegetation by region;
- terrain: identify mountain ranges and skylines, terrain.py scan/view/fit to fix a ridge;
- corridors and infrastructure: osm.py route/along/near/intersect;
- satellite (sat_scan.py) and street view (gsv.py + match.py) on the narrowed zone.
There is no time limit: prefer a long run that narrows the zone to a long run that stops early. Only give up on a level once its discriminating tests are exhausted, then end with a range.`;

// Focus run: the user boxed one element of the photo and wants it dug into, alongside the main analysis.
const FOCUS_PROMPT = (file, box, note, ctx) => `The user selected a region of ./${file} to dig into: box [${box.join(', ')}] as FRACTIONS of width/height (x0, y0, x1, y1).
User note: "${note || 'none'}". Current state of the main analysis: ${ctx || 'unknown'}.
1. Crop that region with PIL (upscale it if small) and look at it. Run the geo-sleuth intake (Skill tool to load geo-sleuth, then intake.py with --box in PIXEL coordinates) for OCR and reverse search of that element; use clues.py lookups if it is a plate, phone number, sign or similar.
2. As soon as you know what the element is, print a focus marker, and print it again whenever you learn more:
@@GEO {"type":"focus","element":"<what it is, e.g. Panneau>","reads":"<text read or key detail>","chain":["<hop>","<hop>"],"verdict":"useful|weak|irrelevant","summary":"<one sentence in French: dig further thanks to it, or why it is not pertinent>"}
chain = the reasoning hops from the element to a place, e.g. ["Enseigne BUFET LLORENS", "Sant Julià de Lòria", "Andorre"].
3. If it is useful, follow it as far as it goes (poi.py on the name, osm.py, satellite, street view) and print clue / area / landmark / final markers as usual; clues carry for/against.
Stay on this element: do not redo the whole analysis.`;

// Every metadata field of the photo (meta.py), read before Claude starts: EXIF GPS gives the place directly.
function readMeta(file) {
  return new Promise((ok) => execFile('uv', ['run', '-q', '--with', 'pillow', 'python', '-I', path.join(__dirname, 'meta.py'), file],
    { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      try { ok(JSON.parse(stdout)); } catch { ok({ error: err ? err.message : 'meta.py: no output', tags: {} }); }
    }));
}
// What the prompts get to know about the metadata
function metaHint(meta) {
  const t = meta.tags || {}, cam = [t['Image.Make'], t['Image.Model']].filter(Boolean).join(' '), when = t['Exif.DateTimeOriginal'] || t['Image.DateTime'];
  const extra = [cam && `camera ${cam}`, when && `taken ${when}`].filter(Boolean).join(', ');
  if (!meta.gps) return `\nIMAGE METADATA (already read for you): no GPS in EXIF (normal for screenshots)${extra ? '; ' + extra : ''}.`;
  const g = meta.gps;
  return `\nIMAGE METADATA (already read for you): EXIF GPS ${g.lat}, ${g.lon}${g.alt != null ? `, altitude ${g.alt} m` : ''}${g.direction != null ? `, lens heading ${g.direction}°` : ''}${extra ? '; ' + extra : ''}.
Metadata can be edited or stripped, so check it against the image. If the image agrees, this IS the precise location: print the countries marker, a final marker there (radius_m about 30) and landmark markers for what you can match around it, then spend your effort confirming it rather than searching elsewhere. If the image contradicts it, say so in a clue marker and geolocate from the image.`;
}

// "x0,y0,x1,y1" as fractions 0-1, ordered; null when invalid
function parseBox(str) {
  const b = String(str || '').split(',').map(Number);
  return b.length === 4 && b.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) && b[0] < b[2] && b[1] < b[3] ? b : null;
}

// Sent with --resume when the deep pass stops without a tight point.
const PUSH_PROMPT = `You stopped without a point within 1 km. Keep narrowing from where you are; do not restart.
List to yourself which branches you have NOT run yet on the current best zone (region-pack metas, terrain.py scan/view/fit on the skyline, osm.py corridors, sat_scan.py grid, gsv.py + match.py street view, sun.py) and run the most promising ones now.
Print markers after each step as before, and end with a tighter final or range. If every branch is truly exhausted, say which ones you ran and end with the same range.`;
const MAX_PUSHES = 2;

// The deep pass forgets the marker rule once deep in the skill; a PostToolUse hook re-injects it after every tool call.
const REMINDER = 'LIVE MAP REMINDER: if this result changed anything (countries, a clue, a zone, a city lead), write the updated @@GEO marker lines in a text message NOW, before your next tool call. Clues carry for/against country codes.';
const HOOK_SETTINGS = JSON.stringify({ hooks: { PostToolUse: [{ matcher: '', hooks: [{ type: 'command',
  command: `printf '%s' ${JSON.stringify(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: REMINDER } }))}` }] }] } });
const TIGHT_M = 1000; // a final point with a radius at or under this ends the run

const JOB_PREFIX = path.join(os.tmpdir(), 'geosleuth-');
// Claude Code keeps each session transcript under ~/.claude/projects/<cwd with non-alphanumerics as '-'>
const transcriptDir = (dir) => path.join(os.homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));

// pid -> children, from /proc. Claude's Bash tool starts each command in its own session,
// so killing claude or its process group leaves uv/python/headless Chrome running: walk the tree instead.
// shortcut: Linux only (/proc); elsewhere only the claude process itself is killed. Port to `ps -A -o pid,ppid` for macOS.
const PROCS = () => (fs.existsSync('/proc') ? fs.readdirSync('/proc') : []);
function descendants(root) {
  const kids = {};
  for (const p of PROCS()) {
    if (!/^\d+$/.test(p)) continue;
    try { const ppid = fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ')[1]; (kids[ppid] ||= []).push(+p); } catch {}
  }
  const out = [], todo = [root];
  while (todo.length) for (const c of kids[todo.pop()] || []) { out.push(c); todo.push(c); }
  return out;
}
function killTree(pid) {
  const all = [pid, ...descendants(pid)];
  const sig = (s) => all.forEach((p) => { try { process.kill(p, s); } catch {} });
  sig('SIGTERM');
  setTimeout(() => sig('SIGKILL'), 3000).unref(); // whatever ignored SIGTERM
}

// Startup sweep: kill processes still working in an old job dir (server crashed or was killed), then delete the dirs.
function sweep() {
  for (const p of PROCS()) {
    if (!/^\d+$/.test(p) || +p === process.pid) continue;
    try { if (fs.readlinkSync(`/proc/${p}/cwd`).startsWith(JOB_PREFIX)) killTree(+p); } catch {}
  }
  for (const d of fs.readdirSync(os.tmpdir())) {
    const dir = path.join(os.tmpdir(), d);
    if (dir.startsWith(JOB_PREFIX)) removeJobFiles(dir);
  }
}
function removeJobFiles(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(transcriptDir(dir), { recursive: true, force: true });
}

const jobs = new Set(); // cleanup functions of running jobs

// Pull every "@@GEO {...}" line out of a text block; bad JSON is reported, not thrown.
function parseMarkers(text) {
  const out = [];
  for (const m of text.matchAll(/@@GEO\s+(\{.*\})\s*$/gm)) {
    try { out.push(JSON.parse(m[1])); } catch { out.push({ type: 'log', text: 'marker JSON invalide: ' + m[1] }); }
  }
  return out;
}

function locate(req, res) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const focus = q.has('focus') ? parseBox(q.get('focus')) : undefined;
  if (focus === null) { res.writeHead(400).end('bad focus box'); return; }
  const ext = EXT[(req.headers['content-type'] || '').split(';')[0]];
  if (!ext) { res.writeHead(415).end('png/jpeg/webp only'); return; }
  const chunks = []; let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BYTES) { res.writeHead(413).end('image too large'); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    const dir = fs.mkdtempSync(JOB_PREFIX);
    const file = 'photo.' + ext;
    fs.writeFileSync(path.join(dir, file), Buffer.concat(chunks));
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    const send = (o) => res.writableEnded || res.write(JSON.stringify(o) + '\n');
    send({ type: 'log', text: `${focus ? 'Analyse ciblée' : 'Analyse'} lancée (${dir})` });

    // bypass needed: headless runs can't answer permission prompts. Jobs run in their own temp dir.
    const children = new Set();
    const run = (args, onClose, onMarker = () => {}) => {
      const child = spawn(CLAUDE, ['-p', ...args, '--output-format', 'stream-json', '--verbose',
        '--dangerously-skip-permissions', '--strict-mcp-config'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.session_id) child.sessionId = ev.session_id;
          if (ev.type !== 'assistant') continue;
          for (const b of ev.message?.content || []) {
            if (b.type === 'text') {
              parseMarkers(b.text).forEach((m) => { onMarker(m); send(m); });
              const prose = b.text.replace(/^@@GEO.*$/gm, '').trim();
              if (prose) send({ type: 'log', text: prose });
            } else if (b.type === 'tool_use') {
              send({ type: 'tool', text: b.name + ' ' + JSON.stringify(b.input).slice(0, 160) });
            }
          }
        }
      });
      child.stderr.on('data', (d) => send({ type: 'log', text: String(d).trim() }));
      child.on('error', (e) => send({ type: 'error', text: e.message }));
      children.add(child);
      child.on('close', (code) => { children.delete(child); onClose(code); });
      return child;
    };
    let stopped = false;
    if (focus) {
      run([FOCUS_PROMPT(file, focus, q.get('note')?.slice(0, 300), q.get('ctx')?.slice(0, 500)), '--append-system-prompt', DEEP_RULES, '--settings', HOOK_SETTINGS],
        (code) => { if (stopped) return; send({ type: 'done', code }); res.end(); cleanup(); });
    } else readMeta(path.join(dir, file)).then((meta) => {
    if (stopped) return;
    send({ type: 'meta', ...meta });
    const hint = metaHint(meta);
    // quick pass gives the map something within seconds; the deep pass refines it
    run([QUICK_PROMPT(file) + hint, '--model', 'sonnet', '--append-system-prompt', MARKERS], () => {});
    // the deep pass is resumed (same session) until it lands a tight point or runs out of pushes
    let deep, pushes = 0, tight = false;
    const track = (m) => { if (m.type === 'final') tight = (m.radius_m ?? Infinity) <= TIGHT_M; else if (m.type === 'range') tight = false; };
    const onDeepClose = (code) => {
      if (stopped) return;
      if (!tight && code === 0 && deep.sessionId && pushes < MAX_PUSHES && !res.writableEnded) {
        send({ type: 'push', n: ++pushes });
        deep = run(['--resume', deep.sessionId, PUSH_PROMPT, '--append-system-prompt', DEEP_RULES, '--settings', HOOK_SETTINGS], onDeepClose, track);
        return;
      }
      send({ type: 'done', code }); res.end(); cleanup();
    };
    deep = run([DEEP_PROMPT(file) + hint, '--append-system-prompt', DEEP_RULES, '--settings', HOOK_SETTINGS], onDeepClose, track);
    });

    // One cleanup for every way a job ends (done, page refresh/close, new upload, server shutdown):
    // kill both passes with their whole process tree, wait for them to exit, then delete the job dir and transcripts.
    const cleanup = () => {
      if (stopped) return; stopped = true;
      jobs.delete(cleanup);
      const exited = [...children].map((c) => new Promise((ok) => { c.once('close', ok); killTree(c.pid); }));
      return Promise.race([Promise.all(exited), new Promise((ok) => setTimeout(ok, 5000))]).then(() => removeJobFiles(dir));
    };
    jobs.add(cleanup);
    res.on('close', cleanup); // fires when the browser goes away mid-run
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/locate') return locate(req, res);
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); // always serve the latest UI
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  res.writeHead(404).end();
});

if (require.main === module) {
  sweep();
  server.listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}`));
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => {
    await Promise.all([...jobs].map((c) => c()));
    process.exit(0);
  });
}
module.exports = { readMeta, metaHint, parseBox, parseMarkers, server, jobs, JOB_PREFIX, transcriptDir, HOOK_SETTINGS };
