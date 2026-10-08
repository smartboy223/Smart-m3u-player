'use strict';
const { createHash } = require('node:crypto');
const parser = require('iptv-playlist-parser');
function webUrl(value, base) {
  const cleaned = String(value ?? '').trim();
  if (!cleaned) throw new Error('A URL is required.');
  const url = new URL(cleaned, base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
  if (url.username || url.password) throw new Error('Use provider token URLs instead of embedded HTTP username/password.');
  return url.href;
}
function idFor(url) { return createHash('sha256').update(url).digest('hex').slice(0, 24); }
function readableText(value) {
  let text = String(value ?? '');
  // Decode labels only. Never decode a signed stream URL or change its query string.
  try { if (/%[0-9a-f]{2}/i.test(text)) text = decodeURIComponent(text); } catch {}
  const entities = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, key) => {
    if (key[0] !== '#') return entities[key.toLowerCase()] || match;
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2),16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  }).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
}
function parsePlaylist(text, base) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!lines.some(line => line.trim().startsWith('#EXTM3U'))) throw new Error('This URL did not return an M3U playlist.');
  // A stream manifest is also M3U, but its segments are not separate channels.
  if (lines.some(line => /^#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE|VERSION):/.test(line.trim()))) {
    return { channels: [{ id: idFor(base), url: base, name: 'HLS stream', group: 'Direct streams', logo: '', language: '', headers: {} }], warnings: [] };
  }
  const channels = new Map(); const warnings = [];
  // Established IPTV parser handles provider tags; this adapter adds URL validation,
  // relative URL resolution, header normalization and source-level deduplication.
  const headerIndex = lines.findIndex(line => line.trim().startsWith('#EXTM3U'));
  let pendingInfo = false; const prepared = [];
  for (const raw of lines.slice(headerIndex)) {
    const line = raw.trim(); if (!line) continue;
    if (line.startsWith('#EXTINF:')) pendingInfo = true;
    else if (!line.startsWith('#')) { if (!pendingInfo) prepared.push(`#EXTINF:-1,Channel ${prepared.length}`); pendingInfo = false; }
    prepared.push(line);
  }
  const normalized = prepared.join('\n');
  const entries = parser.parse(normalized).items;
  for (const entry of entries) {
    try {
      if (!entry.url) throw new Error('Missing stream URL');
      const [stream, encodedHeaders] = entry.url.split('|', 2); const url = webUrl(stream, base); const headers = {};
      if (entry.http?.['user-agent']) headers['User-Agent'] = entry.http['user-agent'];
      if (entry.http?.referrer) headers.Referer = entry.http.referrer;
      if (encodedHeaders) for (const [key, value] of new URLSearchParams(encodedHeaders)) { if (/^(user-agent|referer|origin)$/i.test(key)) headers[key] = value; }
      for (const value of Object.values(headers)) if (/[\r\n]/.test(value)) throw new Error('Invalid stream header');
      let logo = ''; try { if (entry.tvg?.logo) logo = webUrl(entry.tvg.logo, base); } catch {}
      const language = entry.lang || entry.raw?.match(/tvg-language="([^"]+)"/i)?.[1] || '';
      if (!channels.has(url)) channels.set(url, { id: idFor(url), url, name: readableText(entry.name || entry.tvg?.name) || `Channel ${channels.size + 1}`, group: readableText(entry.group?.title) || 'Uncategorized', logo, language: readableText(language), tvgId: entry.tvg?.id || '', headers });
    } catch { if (warnings.length < 20) warnings.push('Skipped an unsupported or invalid stream entry.'); }
  }
  if (!channels.size) throw new Error('The playlist contains no supported HTTP/HTTPS channels.');
  return { channels: [...channels.values()], warnings };
}
function rewriteManifest(text, base, relay) {
  return text.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${relay(webUrl(uri, base))}"`);
    return relay(webUrl(line.trim(), base));
  }).join('\n');
}
module.exports = { webUrl, idFor, parsePlaylist, rewriteManifest, readableText };
