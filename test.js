// Self-check: marker parser + full HTTP stream with a fake claude binary.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const fake = path.join(os.tmpdir(), 'fake-claude.sh');
fs.writeFileSync(fake, `#!/bin/sh
echo '{"type":"system","session_id":"s1"}'
if [ "$FAKE_MODE" = hang ]; then setsid sleep 300 & echo $! > ${process.env.PIDFILE = path.join(os.tmpdir(), 'fake-claude-hang.pid')}; sleep 300; fi
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Je regarde.\\n@@GEO {\\"type\\":\\"countries\\",\\"weights\\":{\\"FR\\":0.7,\\"BE\\":0.3}}"}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}'
if [ "$FAKE_MODE" = range ]; then
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"@@GEO {\\"type\\":\\"range\\",\\"shape\\":\\"circle\\",\\"lat\\":1,\\"lon\\":2,\\"radius_m\\":20000}"}]}}'
else
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"@@GEO {\\"type\\":\\"final\\",\\"lat\\":48.85,\\"lon\\":2.35,\\"radius_m\\":50}"}]}}'
fi
`, { mode: 0o755 });
process.env.CLAUDE_BIN = fake;
const { parseMarkers, parseBox, readMeta, metaHint, server, transcriptDir } = require('./server');
assert.deepStrictEqual(parseBox('0.1,0.2,0.5,0.6'), [0.1, 0.2, 0.5, 0.6]);
for (const bad of ['0.5,0.2,0.1,0.6', '0,0,2,1', '1,2,3', 'a,b,c,d', '']) assert.strictEqual(parseBox(bad), null, bad);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const jobDir = (text) => text.match(/Analyse lancée \((.*)\)/)[1];
assert.deepStrictEqual(parseMarkers('x\n@@GEO {"type":"clue","text":"a"}\ny'), [{ type: 'clue', text: 'a' }]);
assert.strictEqual(parseMarkers('@@GEO {bad}')[0].type, 'log');
const hookCmd = JSON.parse(require('./server').HOOK_SETTINGS).hooks.PostToolUse[0].hooks[0].command;
assert.ok(JSON.parse(require('child_process').execSync(hookCmd, { shell: '/bin/sh' }).toString()).hookSpecificOutput.additionalContext);
server.listen(0, async () => {
  // metadata: a JPEG with EXIF GPS gives decimal coordinates, and the prompts get them
  const gpsJpg = path.join(os.tmpdir(), 'geosleuth-test-gps.jpg');
  require('child_process').execFileSync('python3', ['-c', `from PIL import Image
im = Image.new('RGB', (32, 24)); ex = Image.Exif(); ex[0x8825] = {1: 'N', 2: (42.0, 28.0, 39.36), 3: 'E', 4: (1.0, 29.0, 21.48)}; ex[0x0110] = 'Pixel 8'
im.save('${gpsJpg}', exif=ex)`]);
  const meta = await readMeta(gpsJpg);
  fs.rmSync(gpsJpg);
  assert.deepStrictEqual(meta.gps, { lat: 42.4776, lon: 1.4893 });
  assert.strictEqual(meta.tags['Image.Model'], 'Pixel 8');
  assert.ok(metaHint(meta).includes('42.4776, 1.4893'));
  assert.ok(metaHint({ tags: {} }).includes('no GPS'));

  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/locate`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('x') });
  const body = await r.text();
  const types = body.trim().split('\n').map(l => JSON.parse(l).type);
  await wait(200);
  assert.strictEqual(fs.existsSync(jobDir(body)), false, 'job dir removed after a normal run');
  // quick + deep pass both run the fake, so each marker shows up twice; done must come last
  assert.strictEqual(types.filter(t => t === 'countries').length, 2);
  assert.strictEqual(types.filter(t => t === 'final').length, 2);
  assert.strictEqual(types.at(-1), 'done');
  const bad = await fetch(`http://127.0.0.1:${server.address().port}/api/locate`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.strictEqual(bad.status, 415);
  // a run that only reaches a range gets resumed MAX_PUSHES (2) times, then ends
  process.env.FAKE_MODE = 'range';
  const r2 = await fetch(`http://127.0.0.1:${server.address().port}/api/locate`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('x') });
  const t2 = (await r2.text()).trim().split('\n').map(l => JSON.parse(l).type);
  assert.strictEqual(t2.filter(t => t === 'push').length, 2);
  assert.strictEqual(t2.at(-1), 'done');
  assert.strictEqual(types.includes('push'), false); // tight final: no push

  // focus run: one pass only (no quick pass, no push), bad boxes rejected
  process.env.FAKE_MODE = '';
  const base = `http://127.0.0.1:${server.address().port}/api/locate`;
  const r4 = await fetch(base + '?focus=0.1,0.1,0.4,0.5&note=panneau', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('x') });
  const t4 = (await r4.text()).trim().split('\n').map(l => JSON.parse(l).type);
  assert.strictEqual(t4.filter(t => t === 'countries').length, 1);
  assert.strictEqual(t4.at(-1), 'done');
  assert.strictEqual((await fetch(base + '?focus=0.5,0,0.1,1', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('x') })).status, 400);

  // page refresh mid-run: the server must kill the whole tree (even a child in its own session) and delete the files
  process.env.FAKE_MODE = 'hang';
  const ac = new AbortController();
  const r3 = await fetch(`http://127.0.0.1:${server.address().port}/api/locate`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('x'), signal: ac.signal });
  const first = new TextDecoder().decode((await r3.body.getReader().read()).value);
  const dir = jobDir(first);
  fs.mkdirSync(transcriptDir(dir), { recursive: true }); // stand-in for the session transcript claude would write
  await wait(500);
  const orphan = +fs.readFileSync(process.env.PIDFILE, 'utf8');
  assert.ok(alive(orphan), 'detached child started');
  ac.abort();
  await wait(1500);
  assert.strictEqual(alive(orphan), false, 'detached child killed');
  assert.strictEqual(fs.existsSync(dir), false, 'job dir removed');
  assert.strictEqual(fs.existsSync(transcriptDir(dir)), false, 'transcript removed');
  console.log('ok'); server.close();
});
