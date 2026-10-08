'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const { webUrl, parsePlaylist, rewriteManifest, readableText } = require('./lib/playlist');
const { extract: extractUrls } = require('./public/import');
const { WorkQueue } = require('./lib/work-queue');
const ROOT = __dirname, DATA = process.env.M3U_DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(path.join(DATA, 'thumbnails'), { recursive: true });
const DB = path.join(DATA, 'library.json');
const DELETED = path.join(DATA, 'deleted-playlists.json');
let clearingLibrary = false;
let db = { sources: [], favorites: [], tests: {}, history: [], collections: [], settings: {fetchConcurrency:6,testConcurrency:4,testTimeout:16000} };
if (fs.existsSync(DB)) {
  try { db = { ...db, ...JSON.parse(fs.readFileSync(DB, 'utf8')) }; }
  catch { console.error('The saved library could not be read. It has been preserved.'); process.exit(1); }
}
function save() { fs.writeFileSync(DB + '.tmp', JSON.stringify(db)); fs.renameSync(DB + '.tmp', DB); }
let ffmpeg, ffprobe;
try { ffmpeg = require('ffmpeg-static'); ffprobe = require('ffprobe-static').path; } catch {}
const mediaReady = Boolean(ffmpeg && ffprobe && fs.existsSync(ffmpeg) && fs.existsSync(ffprobe));
const jobs = []; const sessions = new Map(); const conversions = new Set(); let actualPort;
const mediaHints = new Map();
function allChannels() {
  const map = new Map();
  for (const source of db.sources) for (const channel of source.channels || []) {
    if (!map.has(channel.id)) map.set(channel.id, { ...channel, sourceIds: [], sourceNames: [] });
    map.get(channel.id).sourceIds.push(source.id); map.get(channel.id).sourceNames.push(source.name);
  }
  return [...map.values()];
}
function channelById(id) { return allChannels().find(channel => channel.id === id); }
function mergeSaved(previous) {
  const fresh=previous.sources.filter(source=>!db.sources.some(current=>current.url===source.url));
  if(db.sources.length+fresh.length>200)throw new Error('The maximum is 200 saved sources. Remove some playlists first.');
  db.sources.push(...structuredClone(fresh));
  const available=new Set(allChannels().map(channel=>channel.id));
  db.favorites=[...new Set([...db.favorites,...previous.favorites.filter(id=>available.has(id))])];
  for(const [id,result] of Object.entries(previous.tests))if(available.has(id)&&!db.tests[id])db.tests[id]=result;
  return fresh.length;
}
function publicJob(job) { const { controller, queue, ...result } = job; return {...result,queued:queue?.pending.length||0}; }
function state() {
  return {
    app: 'smart-m3u-player', mediaReady,
    settings: db.settings,
    canUndoDelete: fs.existsSync(DELETED),
    collections: db.collections.map(({id,tag,sources,savedAt})=>({id,tag,count:sources.length,savedAt})),
    sources: db.sources.map(({ url, channels, ...source }) => ({ ...source, host: new URL(url).host, count: channels?.length || 0 })),
    channels: allChannels().map(({ url, headers, logo, ...channel }) => ({ ...channel, name: readableText(channel.name), group: readableText(channel.group), language: readableText(channel.language), hasLogo: Boolean(logo), favorite: db.favorites.includes(channel.id), test: db.tests[channel.id] || null })),
    jobs: jobs.slice(-12).map(job=>{const value=publicJob(job);delete value.items;return value;}), history: db.history.slice(-12).reverse()
  };
}
function errorMessage(error) {
  if (error.name === 'AbortError') return 'Cancelled.';
  if (error.name === 'TimeoutError' || /timeout|timed out/i.test(error.message)) return 'The server did not respond before the time limit.';
  if (/HTTP \d{3}/.test(error.message)) return error.message.match(/HTTP \d{3}/)[0] + ' — the provider refused or could not serve this request.';
  if (/fetch failed|ENOTFOUND|ECONN/i.test(error.message)) return 'Could not connect to this server. Check the URL, network, or provider availability.';
  if (/playlist|M3U|supported|HTTP|stream header|Select|busy|maximum|required|source|channel|URL/i.test(error.message)) return error.message.slice(0, 200);
  return 'The operation could not complete. The provider may be unavailable or the content unsupported.';
}
async function remote(url, { signal, headers = {}, timeout = 15000, range, headerOnly = false } = {}) {
  let current = webUrl(url); const timeoutController = new AbortController();
  const timer = headerOnly ? setTimeout(() => timeoutController.abort(new DOMException('Request timed out.', 'TimeoutError')), timeout) : null;
  const timedSignal = headerOnly ? timeoutController.signal : AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal, timedSignal]) : timedSignal;
  let forwarded = { ...headers };
  try { for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(current, { signal: combined, redirect: 'manual', headers: { 'User-Agent': 'SmartM3U/1.0', ...forwarded, ...(range ? { Range: range } : {}) } });
    if ([301,302,303,307,308].includes(response.status) && response.headers.get('location')) {
      const next = webUrl(response.headers.get('location'), current); await response.body?.cancel();
      if (new URL(next).origin !== new URL(current).origin) forwarded = Object.fromEntries(Object.entries(forwarded).filter(([key]) => key.toLowerCase() === 'user-agent'));
      current = next; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    return { response, url: current };
  } } finally { if (timer) clearTimeout(timer); }
  throw new Error('The URL redirected too many times.');
}
async function limitedText(response, maximum = 16 * 1024 * 1024) {
  let length = 0; const chunks = [];
  for await (const chunk of response.body) { length += chunk.length; if (length > maximum) throw new Error('The playlist exceeds the maximum size of 16 MB.'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
function enqueue(type, items, worker, options={}) {
  let job=jobs.find(job=>job.type===type&&job.status==='running'&&!job.controller.signal.aborted);
  const fresh=!job;
  if(fresh){job={id:randomUUID(),type,status:'running',total:0,completed:0,succeeded:0,failed:0,active:[],startedAt:Date.now(),endedAt:null,items:[],controller:new AbortController()};job.queue=new WorkQueue({limit:()=>db.settings[type==='fetch'?'fetchConcurrency':'testConcurrency'],onFinish:job=>{const record=publicJob(job);delete record.items;db.history.push(record);db.history=db.history.slice(-100);save();}});jobs.push(job);if(jobs.length>20){const completed=jobs.findIndex(item=>item.status!=='running');if(completed>=0)jobs.splice(completed,1);}}
  job.total+=job.queue.add(items,options);
  if(fresh)job.queue.start(job,worker);else job.queue.pump();
  return job;
}
async function fetchSource(source, signal, options={}) {
  let fetched;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fetched = await remote(source.url, { signal }); break; }
    catch (error) { if (signal.aborted || attempt === 1 || /HTTP 4\d\d/.test(error.message)) { source.lastError = errorMessage(error); save(); throw error; } }
  }
  try {
    const text = await limitedText(fetched.response); const parsed = parsePlaylist(text, fetched.url);
    if (signal.aborted) throw signal.reason;
    if (!db.sources.includes(source)) throw new Error('This source has been removed.');
    source.channels = parsed.channels; source.warnings = parsed.warnings; source.lastFetched = new Date().toISOString(); source.lastError = null; save();
    if(options.prepare&&!signal.aborted){const channels=allChannels().filter(channel=>channel.sourceIds.includes(source.id));if(channels.length)enqueue('test',channels,testChannel);}
    return `${parsed.channels.length} channels loaded${parsed.warnings.length ? `; ${parsed.warnings.length} warnings` : ''}.`;
  } catch (error) { if (!signal.aborted) { source.lastError = errorMessage(error); save(); } throw error; }
}
function processMedia(binary, args, signal, timeout = 22000) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', diagnostic = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    const abort = () => child.kill(); signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { if (output.length < 2 * 1024 * 1024) output += chunk; });
    child.stderr.on('data', chunk => { if (diagnostic.length < 100000) diagnostic += chunk; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason); else if (timedOut) reject(new Error('Media test timed out.')); else if (code !== 0) {
        const status = diagnostic.match(/\b(401|403|404|410|429|500|502|503)\b/);
        reject(new Error(status ? `HTTP ${status[1]}` : 'Unsupported or unavailable media; no decodable sample was received.'));
      } else resolve(output);
    });
  });
}
function mediaInput(channel, timeout=12000) {
  const headers = Object.entries(channel.headers || {}).map(([key, value]) => `${key}: ${value}\r\n`).join('');
  return ['-protocol_whitelist', 'http,https,tcp,tls,crypto', '-rw_timeout', String(timeout*1000), ...(headers ? ['-headers', headers] : []), '-i', channel.url];
}
async function testChannel(channel, signal) {
  const began = Date.now(); let result;
  try {
    if (!mediaReady) {
      const { response } = await remote(channel.url, { headers: channel.headers, signal }); await response.body?.cancel();
      result = { status: 'inconclusive', message: 'Server responded. Media tools are missing, so decoding and quality have not been verified.', elapsedMs: Date.now() - began };
    } else {
      const timeout=db.settings.testTimeout;
      const output = await processMedia(ffprobe, ['-v', 'error', ...mediaInput(channel,timeout), '-analyzeduration', '3000000', '-probesize', '4000000', '-show_streams', '-show_format', '-of', 'json'], signal,timeout);
      const media = JSON.parse(output); const video = media.streams?.find(stream => stream.codec_type === 'video'); const audio = media.streams?.find(stream => stream.codec_type === 'audio');
      if (!video && !audio) throw new Error('No supported audio or video channel was found.');
      const thumb = path.join(DATA, 'thumbnails', channel.id + '.jpg');
      if (video) {
        try { fs.unlinkSync(thumb); } catch {}
        await processMedia(ffmpeg, ['-hide_banner','-loglevel','error', ...mediaInput(channel,timeout), '-map', '0:v:0', '-frames:v','1','-vf','scale=480:-2','-threads','2','-y', thumb], signal,timeout);
        if (!fs.existsSync(thumb) || fs.statSync(thumb).size === 0) throw new Error('No video frame could be decoded.');
      } else await processMedia(ffmpeg, ['-hide_banner','-loglevel','error', ...mediaInput(channel,timeout), '-map','0:a:0','-t','2','-f','null','-'], signal,timeout);
      const [numerator, denominator] = (video?.avg_frame_rate || video?.r_frame_rate || '0/1').split('/').map(Number);
      result = { status: 'working', message: video ? 'Video frame decoded successfully. Snapshot test; ongoing stability is not guaranteed.' : 'Audio sample decoded successfully.', mediaFormat: media.format?.format_name || null, resolution: video?.width ? `${video.width}×${video.height}` : null, fps: denominator && numerator ? Math.round(numerator / denominator * 100) / 100 : null, videoCodec: video?.codec_name || null, audioCodec: audio?.codec_name || null, bitrate: Number(media.format?.bit_rate || video?.bit_rate) || null, bitrateKind: 'Reported by media metadata', thumbnail: Boolean(video), elapsedMs: Date.now() - began };
    }
  } catch (error) { if (signal.aborted) throw error; result = { status: 'failed', message: errorMessage(error), elapsedMs: Date.now() - began }; }
  result.testedAt = new Date().toISOString();
  result.history = [...(db.tests[channel.id]?.history || []), { status: result.status, testedAt: result.testedAt, elapsedMs: result.elapsedMs }].slice(-10);
  db.tests[channel.id] = result; save();
  if (result.status === 'failed') throw new Error(result.message);
  return result.message;
}
function sessionFor(channel) {
  // Random, short-lived capability URLs avoid putting provider credentials into browser media URLs.
  const token = randomUUID(); const session = { token, channel, expires: Date.now() + 12 * 60 * 60 * 1000, urls: new Map(), reverse: new Map() };
  sessions.set(token, session); return session;
}
function relayUrl(session, url) {
  if (!session.reverse.has(url)) { const key = String(session.urls.size); session.urls.set(key, url); session.reverse.set(url, key); }
  return `/relay/${session.token}/${session.reverse.get(url)}`;
}
async function relay(req, res, session, key) {
  const target = session.urls.get(key); if (!target) return json(res, 404, { error: 'Media link expired.' });
  const controller = new AbortController(); res.on('close', () => controller.abort());
  const { response, url } = await remote(target, { signal: controller.signal, headers: session.channel.headers, range: req.headers.range, timeout: 45000, headerOnly: true });
  const type = response.headers.get('content-type') || 'application/octet-stream';
  const reader = response.body.getReader(); const first = await reader.read(); const initial = Buffer.from(first.value || []);
  if (/mpegurl/i.test(type) || initial.toString('utf8').trimStart().startsWith('#EXTM3U')) {
    if (target === session.channel.url) mediaHints.set(session.channel.id, { hls: true, checkedAt: Date.now() });
    const manifestTimer = setTimeout(() => controller.abort(), 20000);
    const chunks = [initial]; let size = initial.length;
    try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new Error('The playlist exceeds the maximum size.'); } chunks.push(Buffer.from(part.value)); }
    const manifest = rewriteManifest(Buffer.concat(chunks).toString('utf8'), url, link => relayUrl(session, link));
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }); res.end(manifest); return;
    } finally { clearTimeout(manifestTimer); }
  }
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (target === session.channel.url && /^(video\/(mp4|webm)|audio\/(mpeg|mp4|ogg|wav))/i.test(type)) mediaHints.set(session.channel.id, { hls: false, checkedAt: Date.now() });
  for (const name of ['content-length','content-range','accept-ranges']) if (response.headers.get(name)) headers[name] = response.headers.get(name);
  res.writeHead(response.status, headers);
  if (req.method === 'HEAD') { await reader.cancel(); res.end(); return; }
  async function* chunks() { if (initial.length) yield initial; while (true) { const part = await reader.read(); if (part.done) break; yield Buffer.from(part.value); } }
  const stream = Readable.from(chunks()); stream.on('error', () => res.destroy()); stream.pipe(res);
}
function transcode(req, res, session) {
  if (!mediaReady) return json(res, 503, { error: 'Media tools are unavailable. Run setup again.' });
  if (conversions.size >= 2) return json(res, 429, { error: 'The maximum of two conversion players is already running.' });
  const child = spawn(ffmpeg, ['-hide_banner','-loglevel','error', ...mediaInput(session.channel), '-map','0:v:0?','-map','0:a:0?','-sn','-dn','-c:v','libx264','-preset','veryfast','-tune','zerolatency','-vf','scale=w=1280:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-b:a','128k','-movflags','frag_keyframe+empty_moov+default_base_moof','-frag_duration','1000000','-f','mp4','pipe:1'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  conversions.add(child); child.stderr.resume(); let began = false;
  const timer = setTimeout(() => { if (!began) { child.kill(); if (!res.headersSent) json(res, 504, { error: 'No converted media arrived within 35 seconds.' }); } }, 35000);
  child.stdout.once('data', chunk => { began = true; clearTimeout(timer); res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' }); res.write(chunk); child.stdout.pipe(res); });
  res.on('close', () => child.kill());
  child.on('error', () => { if (!res.headersSent) json(res, 503, { error: 'The conversion tool could not start.' }); else res.destroy(); });
  child.on('close', () => { clearTimeout(timer); conversions.delete(child); if (!res.headersSent) json(res, 502, { error: 'The provider did not supply convertible media.' }); else res.end(); });
}
function json(res, code, body) { if (res.destroyed || res.writableEnded) return; res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
async function body(req) {
  let size = 0; const chunks = []; for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('The maximum request size is 1 MB.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('A valid JSON request is required.'); }
}
function file(res, target, type, cache = false) {
  if (!fs.existsSync(target)) return json(res, 404, { error: 'File not found.' });
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache ? 'private, max-age=3600' : 'no-store' }); const stream = fs.createReadStream(target); stream.on('error', () => res.destroy()); stream.pipe(res);
}
const server = http.createServer(async (req, res) => {
  try {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes((req.headers.host || '').replace(/:\d+$/, ''))) return json(res, 403, { error: 'Local access only.' });
    if (req.headers.origin && ![`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`].includes(req.headers.origin)) return json(res, 403, { error: 'Foreign origin rejected.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests rejected.' });
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src blob: 'self'; frame-ancestors 'none'");
    const url = new URL(req.url, 'http://localhost'); const route = url.pathname;
    if (req.method === 'GET' && route === '/api/state') return json(res, 200, state());
    if (clearingLibrary && ['POST','PATCH','DELETE'].includes(req.method)) throw new Error('The library is being cleared. Try again in a moment.');
    if(req.method==='POST'&&route==='/api/settings'){
      const input=await body(req);
      const allowedSettings={fetchConcurrency:[2,4,6,8],testConcurrency:[2,4,6,8],testTimeout:[8000,16000,30000]};
      for(const [key,allowed] of Object.entries(allowedSettings))if(input[key]!==undefined&&!allowed.includes(input[key]))throw new Error('Unsupported queue setting.');
      for(const key of Object.keys(allowedSettings))if(input[key]!==undefined)db.settings[key]=input[key];
      save();for(const job of jobs)if(job.status==='running')job.queue.pump();return json(res,200,db.settings);
    }
    if ((req.method === 'DELETE' && route === '/api/sources') || (req.method === 'POST' && route === '/api/sources/delete')) {
      const ids = req.method === 'POST' ? (await body(req)).ids : db.sources.map(source=>source.id);
      const selected = db.sources.filter(source=>ids?.includes(source.id));
      if (!selected.length) return json(res, 200, { removed: 0 });
      clearingLibrary = true;
      try {
        for (const job of jobs) if (job.status === 'running') job.controller.abort();
        while (jobs.some(job => job.status === 'running')) await new Promise(resolve => setTimeout(resolve, 25));
        const removed = selected.length;
        fs.writeFileSync(DELETED + '.tmp', JSON.stringify({ sources: selected, favorites: db.favorites, tests: db.tests }));
        fs.renameSync(DELETED + '.tmp', DELETED);
        db.sources = db.sources.filter(source=>!ids.includes(source.id));
        const retained = new Set(allChannels().map(channel=>channel.id));
        db.favorites = db.favorites.filter(id=>retained.has(id)); db.tests = Object.fromEntries(Object.entries(db.tests).filter(([id])=>retained.has(id)));
        sessions.clear(); mediaHints.clear(); for (const child of conversions) child.kill();
        save(); return json(res, 200, { removed });
      } finally { clearingLibrary = false; }
    }
    if (req.method === 'POST' && route === '/api/sources/restore') {
      if (!fs.existsSync(DELETED)) throw new Error('No deleted batch is available to restore.');
      const previous = JSON.parse(fs.readFileSync(DELETED, 'utf8'));
      const restored = mergeSaved(previous);
      save(); fs.unlinkSync(DELETED); return json(res, 200, { restored });
    }
    if (req.method === 'POST' && route === '/api/collections') {
      const input = await body(req); const tag = String(input.tag||'').trim().slice(0,100);
      const selected = db.sources.filter(source=>input.ids?.includes(source.id));
      if (!tag || !selected.length) throw new Error('Enter a tag and select at least one playlist.');
      const channelIds = new Set(selected.flatMap(source=>source.channels.map(channel=>channel.id)));
      db.collections.push({id:randomUUID(),tag,savedAt:new Date().toISOString(),sources:structuredClone(selected),favorites:db.favorites.filter(id=>channelIds.has(id)),tests:Object.fromEntries(Object.entries(db.tests).filter(([id])=>channelIds.has(id)))});
      save(); return json(res,200,{saved:selected.length});
    }
    if (req.method === 'POST' && route === '/api/collections/load') {
      const input=await body(req); const collection=db.collections.find(item=>item.id===input.id);
      if (!collection) throw new Error('Unknown saved collection.');
      const restored=mergeSaved(collection);save();return json(res,200,{restored});
    }
    if (req.method === 'POST' && route === '/api/sources') {
      const input = await body(req); const extracted = extractUrls(input.urls); const urls = extracted.urls;
      if (!urls.length) throw new Error('At least one playlist URL is required.');
      const validated = urls.map(value => webUrl(value)); const fresh=validated.filter(value=>!db.sources.some(source=>source.url===value));
      if (db.sources.length + fresh.length > 200) throw new Error('The maximum is 200 saved sources. Import fewer URLs or remove old sources.');
      let added = 0;
      for (const value of validated) { if (db.sources.some(source => source.url === value)) continue; db.sources.push({ id: randomUUID(), url: value, name: validated.length === 1 && input.name?.trim() ? input.name.trim().slice(0,100) : `Playlist ${db.sources.length + 1} · ${new URL(value).hostname}`, channels: [], warnings: [], lastError: null, lastFetched: null }); added++; }
      save(); return json(res, 200, { added, detected: validated.length, ignored: extracted.ignored, ids: db.sources.filter(source=>validated.includes(source.url)).map(source=>source.id) });
    }
    const sourceMatch = route.match(/^\/api\/sources\/([\w-]+)$/);
    if (sourceMatch && ['DELETE','PATCH'].includes(req.method)) {
      if (jobs.some(job => job.status === 'running' && job.type === 'fetch')) throw new Error('A source fetch is busy. Cancel it before editing sources.');
      const source = db.sources.find(item => item.id === sourceMatch[1]); if (!source) return json(res, 404, { error: 'Unknown source.' });
      if (req.method === 'DELETE') db.sources = db.sources.filter(item => item !== source);
      else { const input = await body(req); if (input.url) { source.url = webUrl(input.url); source.channels = []; source.lastFetched = null; source.lastError = null; } if (input.name?.trim()) source.name = input.name.trim().slice(0,100); }
      save(); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && route === '/api/fetch') {
      const input = await body(req); const selected = db.sources.filter(source => input.ids?.includes(source.id));
      if (!selected.length) throw new Error('Select at least one source.'); const job = enqueue('fetch',selected,fetchSource,{prepare:Boolean(input.prepare)});
      return json(res, 202, publicJob(job));
    }
    if (req.method === 'POST' && route === '/api/test') {
      const input = await body(req); const selected = allChannels().filter(channel => input.ids?.includes(channel.id));
      if (!selected.length) throw new Error('Select at least one channel.'); const job = enqueue('test',selected,testChannel); return json(res, 202, publicJob(job));
    }
    if (req.method === 'POST' && route === '/api/cancel') { const input = await body(req); const job = jobs.find(item => item.id === input.id); job?.queue.cancel(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && route === '/api/favorite') { const input = await body(req); if (!channelById(input.id)) throw new Error('Unknown channel.'); db.favorites = db.favorites.includes(input.id) ? db.favorites.filter(id => id !== input.id) : [...db.favorites, input.id]; save(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && route === '/api/play') {
      const input = await body(req); const channel = channelById(input.id); if (!channel) throw new Error('Unknown channel.');
      const session = sessionFor(channel); const mediaUrl = relayUrl(session, channel.url);
      const test = db.tests[channel.id]; const format = test?.mediaFormat || '';
      const hint = mediaHints.get(channel.id); const freshHint = hint && Date.now() - hint.checkedAt < 30 * 60 * 1000 ? hint : null;
      const suspectedHls = /\.m3u8(?:$|\?)/i.test(channel.url) || /\bhls\b/.test(format) || db.sources.some(source => source.url === channel.url);
      const knownDirect = /\.(mp4|m4v|webm|mp3|m4a|ogg|wav)(?:$|\?)/i.test(channel.url) || /mov,mp4|webm|mp3|wav|ogg/.test(format);
      const convert = !suspectedHls && (/\.(ts|mkv|avi|mpd)(?:$|\?)/i.test(channel.url) || /mpegts|matroska|dash/.test(format)) || test?.videoCodec && !['h264','av1','vp9'].includes(test.videoCodec);
      return json(res, 200, { url: mediaUrl, convertUrl: `/convert/${session.token}`, hls: freshHint ? freshHint.hls : suspectedHls ? true : knownDirect ? false : null, preferConvert: Boolean(convert && mediaReady) });
    }
    if (req.method === 'POST' && route === '/api/reveal') {
      const input = await body(req); const source = db.sources.find(item => item.id === input.sourceId); const channel = channelById(input.channelId);
      return json(res, 200, { url: source?.url || channel?.url || '' });
    }
    if (req.method === 'GET' && route === '/api/export') {
      res.setHeader('Content-Disposition', 'attachment; filename="m3u-test-report.json"');
      const exported = state(); delete exported.jobs; return json(res, 200, { exportedAt: new Date().toISOString(), ...exported });
    }
    const mediaMatch = route.match(/^\/(relay|convert)\/([\w-]+)(?:\/(\d+))?$/);
    if (mediaMatch && ['GET','HEAD'].includes(req.method)) {
      const session = sessions.get(mediaMatch[2]); if (!session || session.expires < Date.now()) return json(res, 404, { error: 'Media session expired. Press Play again.' });
      if (mediaMatch[1] === 'convert') return transcode(req, res, session); return await relay(req, res, session, mediaMatch[3]);
    }
    const thumbnailMatch = route.match(/^\/thumbnail\/([a-f0-9]{24})\.jpg$/);
    if (req.method === 'GET' && thumbnailMatch) return file(res, path.join(DATA, 'thumbnails', thumbnailMatch[1]+'.jpg'), 'image/jpeg');
    const logoMatch = route.match(/^\/logo\/([a-f0-9]{24})$/);
    if (req.method === 'GET' && logoMatch) {
      const channel = channelById(logoMatch[1]); if (!channel?.logo) return json(res, 404, { error: 'No logo.' });
      const { response } = await remote(channel.logo, { timeout: 7000 }); const type = response.headers.get('content-type');
      if (!/^image\/(png|jpeg|webp|gif)(?:;|$)/i.test(type || '')) { await response.body.cancel(); return json(res, 415, { error: 'Unsupported logo type.' }); }
      const chunks = []; let size = 0; for await (const chunk of response.body) { size += chunk.length; if (size > 2*1024*1024) throw new Error('Logo exceeds maximum size.'); chunks.push(chunk); }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control':'private, max-age=3600' }); res.end(Buffer.concat(chunks)); return;
    }
    const staticFiles = { '/': ['index.html','text/html; charset=utf-8'], '/favicon.svg':['favicon.svg','image/svg+xml'], '/app.js':['app.js','text/javascript; charset=utf-8'], '/navigation.js':['navigation.js','text/javascript; charset=utf-8'], '/import.js':['import.js','text/javascript; charset=utf-8'], '/style.css':['style.css','text/css; charset=utf-8'] };
    if (req.method === 'GET' && staticFiles[route]) return file(res, path.join(ROOT,'public',staticFiles[route][0]), staticFiles[route][1]);
    if (req.method === 'GET' && route === '/vendor/hls.js') return file(res, path.join(ROOT,'node_modules','hls.js','dist','hls.min.js'), 'text/javascript', true);
    return json(res, 404, { error: 'Not found.' });
  } catch (error) { if (!res.headersSent) json(res, 400, { error: errorMessage(error) }); else res.destroy(); }
});
function openBrowser(url) { if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); }
let port = Number(process.env.M3U_PORT || 8787);
server.on('error', async error => {
  if (error.code === 'EADDRINUSE' && !process.env.M3U_PORT) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) }); if ((await response.json()).app === 'smart-m3u-player') { if (process.argv.includes('--open')) openBrowser(`http://127.0.0.1:${port}`); console.log('Player is already running.'); process.exit(0); } } catch {}
    if (port < 8797) { server.listen(++port, '127.0.0.1'); return; }
  }
  console.error('Could not start the local server:', error.code); process.exit(1);
});
server.on('listening', () => { actualPort = server.address().port; console.log(`SignalDeck ready at http://127.0.0.1:${actualPort}`); console.log(mediaReady ? 'Media inspection and browser conversion are ready.' : 'Media tools missing: only basic reachability tests are available.'); if (process.argv.includes('--open')) openBrowser(`http://127.0.0.1:${actualPort}`); });
server.listen(port, '127.0.0.1');
const cleanup = setInterval(() => { for (const [token, session] of sessions) if (session.expires < Date.now()) sessions.delete(token); }, 60000); cleanup.unref();
function shutdown() { for (const job of jobs) job.controller.abort(); for (const child of conversions) child.kill(); server.close(); setTimeout(() => process.exit(0), 500).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
