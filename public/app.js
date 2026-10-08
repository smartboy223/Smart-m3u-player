'use strict';
const $ = id => document.getElementById(id);
let state = { sources: [], channels: [], jobs: [], history: [] }, selectedSources = new Set(), selectedChannels = new Set();
let page = 0, favoritesOnly = false, current = null, hls = null, session = null, playbackGeneration = 0, lastRender = '', detailId = null, waitingTimer = null, retryCount = 0;
let sniffController = null, automaticFallback = null;
const PAGE_SIZE = 48;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const time = value => value ? new Date(value).toLocaleString() : 'Never';
function toast(message, error = false) { $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').style.display = 'block'; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').style.display = 'none', 5000); }
async function api(route, data, method = 'POST') {
  const response = await fetch('/api/' + route, { method, headers: { 'Content-Type':'application/json' }, ...(data === undefined ? {} : { body:JSON.stringify(data) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Request failed.'); return result;
}
async function action(fn) { try { await fn(); await refresh(true); } catch (error) { toast(error.message, true); } }
async function refresh(force = false) {
  try {
    const response = await fetch('/api/state'); if (!response.ok) throw new Error('Server unavailable'); const next = await response.json();
    const changed = JSON.stringify(next.channels) !== lastRender; state = next;
    selectedSources = new Set([...selectedSources].filter(id => state.sources.some(source => source.id === id)));
    selectedChannels = new Set([...selectedChannels].filter(id => state.channels.some(channel => channel.id === id)));
    renderSources(); renderJobs(); renderStats();
    if (force || changed) { renderFilters(); renderChannels(); lastRender = JSON.stringify(next.channels); }
    $('tools-status').textContent = state.mediaReady ? '● Media tools ready' : 'Media tools unavailable';
    $('test-filtered').disabled = !filtered().length;
    $('test-selected').disabled = !selectedChannels.size;
    $('test-all').disabled = !state.channels.length;
    $('fetch-selected').disabled = !selectedSources.size;
    $('fetch-all').disabled = !state.sources.length;
    if(document.activeElement?.tagName!=='SELECT'&&state.settings){$('fetch-concurrency').value=state.settings.fetchConcurrency;$('test-concurrency').value=state.settings.testConcurrency;$('test-timeout').value=state.settings.testTimeout;}
    $('delete-all').disabled = !state.sources.length;
    $('undo-delete').hidden = !state.canUndoDelete;
    $('undo-delete').disabled = false;
    $('delete-selected').disabled = !selectedSources.size;
    $('save-selected').disabled = !selectedSources.size;
    $('saved-collections').innerHTML = (state.collections||[]).map(item=>`<div class="saved-collection"><div><strong>${esc(item.tag)}</strong><span>${item.count} playlists · ${esc(time(item.savedAt))}</span></div><button class="button subtle" data-collection-load="${item.id}">Load saved</button></div>`).join('');
    if (detailId && $('detail-dialog').open) renderDetail();
  } catch { $('tools-status').textContent = 'Server disconnected'; }
}
function renderSources() {
  $('source-count').textContent = state.sources.length;
  const html = state.sources.map(source => {
    const channels = state.channels.filter(channel => channel.sourceIds.includes(source.id)); const working = channels.filter(channel => channel.test?.status === 'working').length;
    return `<div class="source-card ${$('source-filter').value === source.id ? 'active':''}"><div class="source-top"><input type="checkbox" aria-label="Select ${esc(source.name)}" data-source-select="${source.id}" ${selectedSources.has(source.id)?'checked':''}><button class="source-title" data-source-filter="${source.id}" dir="auto">${esc(source.name)}</button></div><div class="source-meta">${esc(source.host)} · ${source.count} channels<br>Last loaded: ${esc(time(source.lastFetched))}</div><div class="source-bottom"><span>${working} decoded</span><div><button data-source-edit="${source.id}" aria-label="Edit playlist">Edit</button><button data-source-fetch="${source.id}" aria-label="Fetch playlist">↻</button><button data-source-remove="${source.id}" aria-label="Remove playlist">✕</button></div></div>${source.lastError?`<p class="source-error">${esc(source.lastError)}</p>`:''}${source.warnings?.length?`<p class="source-error">${source.warnings.length} entries skipped</p>`:''}</div>`;
  }).join('');
  if ($('sources').innerHTML !== html) $('sources').innerHTML = html;
}
function renderFilters() {
  const previousSource = $('source-filter').value, previousGroup = $('group-filter').value;
  $('source-filter').innerHTML = '<option value="">All playlists</option>' + state.sources.map(source => `<option value="${source.id}">${esc(source.name)}</option>`).join('');
  $('source-filter').value = state.sources.some(source => source.id === previousSource) ? previousSource : '';
  const groups = [...new Set(state.channels.filter(channel => !previousSource || channel.sourceIds.includes(previousSource)).map(channel => channel.group))].sort((a,b) => a.localeCompare(b));
  $('group-filter').innerHTML = '<option value="">All categories</option>' + groups.map(group => `<option value="${esc(group)}">${esc(group)}</option>`).join('');
  $('group-filter').value = groups.includes(previousGroup) ? previousGroup : '';
}
function filtered() {
  const query = $('search').value.trim().toLocaleLowerCase(), source = $('source-filter').value, group = $('group-filter').value, status = $('status-filter').value;
  const channels = state.channels.filter(channel => (!query || `${channel.name} ${channel.group} ${channel.language} ${channel.sourceNames.join(' ')}`.toLocaleLowerCase().includes(query)) && (!source || channel.sourceIds.includes(source)) && (!group || channel.group === group) && (!status || (channel.test?.status || 'untested') === status) && (!favoritesOnly || channel.favorite));
  const sort = $('sort').value;
  return channels.sort((a,b) => {
    if (sort === 'quality') { const quality = channel => Number(channel.test?.resolution?.split('×')[1] || 0); return quality(b)-quality(a) || a.name.localeCompare(b.name); }
    if (sort === 'working') return Number(b.test?.status === 'working')-Number(a.test?.status === 'working') || a.name.localeCompare(b.name);
    if (sort === 'recent') return new Date(b.test?.testedAt || 0)-new Date(a.test?.testedAt || 0);
    return a.name.localeCompare(b.name);
  });
}
function badge(channel) {
  const status = channel.test?.status || 'untested'; const labels = { working:'● Decoded', failed:'● Failed', untested:'○ Untested', inconclusive:'◐ Inconclusive' };
  return `<span class="badge ${status}">${labels[status]}${channel.test?.resolution ? ` · ${esc(channel.test.resolution)}`:''}</span>`;
}
function renderChannels() {
  const channels = filtered(); page = Math.max(0, Math.min(page, Math.ceil(channels.length/PAGE_SIZE)-1)); const slice = channels.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
  const eligible = channels.filter(channel => channel.test?.status !== 'failed');
  for (const id of ['previous-channel','next-channel','shuffle-channel']) $(id).disabled = !eligible.length;
  $('switcher-summary').textContent = `${eligible.length.toLocaleString()} channels in your filters · failed checks skipped · keys N / P / S`;
  $('filter-summary').textContent = `${channels.length.toLocaleString()} shown · ${state.channels.length.toLocaleString()} unique channels across ${state.sources.length} playlists`;
  $('channels').innerHTML = slice.map(channel => `<article class="channel-card ${current?.id===channel.id?'playing':''}"><div class="card-top"><input type="checkbox" data-channel-select="${channel.id}" aria-label="Select ${esc(channel.name)}" ${selectedChannels.has(channel.id)?'checked':''}><button class="star ${channel.favorite?'favorite':''}" data-favorite="${channel.id}" aria-label="${channel.favorite?'Remove':'Add'} favorite">${channel.favorite?'★':'☆'}</button></div>${channel.test?.thumbnail?`<img class="card-thumb" src="/thumbnail/${channel.id}.jpg?v=${encodeURIComponent(channel.test.testedAt)}" alt="Decoded preview of ${esc(channel.name)}" loading="lazy">`:''}<button class="channel-main" data-play="${channel.id}"><div class="logo">${$('show-logos').checked && channel.hasLogo?`<img src="/logo/${channel.id}" alt="" loading="lazy">`:esc(channel.name.slice(0,2).toLocaleUpperCase())}</div><div><div class="channel-name" dir="auto">${esc(channel.name)}</div><div class="channel-group" dir="auto">${esc(channel.group)}${channel.language?' · '+esc(channel.language):''}</div></div></button><div class="card-bottom">${badge(channel)}<button class="details-button" data-detail="${channel.id}">Details ↗</button></div></article>`).join('');
  $('empty-library').hidden = channels.length > 0;
  $('empty-library').querySelector('h3').textContent = state.channels.length ? 'No matching channels' : 'Your channels will appear here';
  $('empty-library').querySelector('p').textContent = state.channels.length ? 'Try a different search or filter.' : 'Add a playlist URL on the left, then press Fetch & load.';
  $('page-label').textContent = `Page ${page+1} of ${Math.max(1,Math.ceil(channels.length/PAGE_SIZE))}`;
  $('prev-page').disabled = page === 0; $('next-page').disabled = (page+1)*PAGE_SIZE >= channels.length;
  $('selected-count').textContent = selectedChannels.size;
  $('select-page').checked = slice.length > 0 && slice.every(channel => selectedChannels.has(channel.id));
  $('test-filtered').disabled = !channels.length;
  $('test-selected').disabled = !selectedChannels.size;
}
function renderStats() {
  $('stat-channels').textContent = state.channels.length.toLocaleString();
  for (const [id,status] of [['working','working'],['failed','failed'],['untested','untested']]) $('stat-'+id).textContent = state.channels.filter(channel => (channel.test?.status || 'untested')===status).length.toLocaleString();
}
function renderJobs() {
  const running=state.jobs.filter(job=>job.status==='running');$('jobs').hidden=!running.length;
  const html=running.map(job=>`<div class="queue-row"><strong>${job.type==='fetch'?'Loading playlists':'Checking channels'}</strong><span>${job.completed}/${job.total} done · ${job.active.length} active · ${job.queued??Math.max(0,job.total-job.completed-job.active.length)} queued</span><progress value="${job.completed}" max="${job.total}"></progress><button class="button subtle" data-cancel="${job.id}">Stop queue</button></div>`).join('');
  if($('jobs').innerHTML!==html)$('jobs').innerHTML=html;
}
function playbackState(message) { $('playback-state').textContent = message; $('playback-state').classList.toggle('visible',Boolean(message)); }
function releasePlayer() { clearTimeout(waitingTimer); sniffController?.abort(); sniffController=null; automaticFallback=null; if (hls) { hls.destroy(); hls=null; } $('video').pause(); $('video').removeAttribute('src'); $('video').load(); }
async function play(id, keepRetries = false) {
  const generation = ++playbackGeneration; releasePlayer(); current = state.channels.find(channel => channel.id===id); if (!current) return;
  if (!keepRetries) retryCount=0;
  $('player-empty').hidden=true; $('playing-name').textContent=current.name; $('playing-meta').textContent=`${current.group} · ${current.sourceNames.join(', ')}`;
  $('retry').disabled=false; $('stop').disabled=false; $('quality').innerHTML='<option value="-1">Auto quality</option>'; playbackState('Connecting…'); renderChannels();
  try {
    session = await api('play',{id}); if (generation !== playbackGeneration) return;
    const video=$('video'); let converted=false;
    const startCompatibility = () => {
      if (generation !== playbackGeneration || converted || !state.mediaReady) return false;
      converted=true; clearTimeout(waitingTimer); sniffController?.abort();
      if(hls){hls.destroy();hls=null;}
      $('quality').innerHTML='<option value="-1">Automatic compatibility</option>';
      playbackState('Preparing browser-compatible media…'); video.src=session.convertUrl;
      video.play().catch(()=>{if(generation===playbackGeneration)playbackState('Preparing media. Press Play if playback does not start.');});
      waitingTimer=setTimeout(()=>{if(generation===playbackGeneration && video.readyState<2)playbackState('The stream did not become ready. Try another channel or inspect its test result.');},35000);
      return true;
    };
    if($('play-mode').value==='auto')automaticFallback=startCompatibility;
    if ($('play-mode').value==='convert' || session.preferConvert && $('play-mode').value==='auto') { startCompatibility(); }
    else {
      // Sniff the relayed first bytes as provider links often have no file extension.
      let isHls=session.hls;
      if(isHls===null){const controller=new AbortController();sniffController=controller;const timer=setTimeout(()=>controller.abort(),8000);try{const response=await fetch(session.url,{signal:controller.signal});const reader=response.body.getReader();const chunk=await reader.read();isHls=/mpegurl/i.test(response.headers.get('content-type')||'') || new TextDecoder().decode(chunk.value).trimStart().startsWith('#EXTM3U');await reader.cancel();}catch{}finally{clearTimeout(timer);controller.abort();if(sniffController===controller)sniffController=null;}}
      if (generation !== playbackGeneration) return;
      if(isHls && window.Hls?.isSupported()) {
        hls=new Hls({ enableWorker:true, backBufferLength:30, maxBufferLength:10, manifestLoadingTimeOut:15000, fragLoadingTimeOut:20000 });
        hls.on(Hls.Events.MANIFEST_PARSED,()=>{if(generation!==playbackGeneration)return;$('quality').innerHTML='<option value="-1">Auto quality</option>'+hls.levels.map((level,index)=>`<option value="${index}">${level.height?level.height+'p':`Level ${index+1}`}${level.bitrate?' · '+Math.round(level.bitrate/1000)+' kb/s':''}</option>`).join('');video.play().catch(()=>playbackState('Press Play on the video to begin.'));});
        let recoveries=0; hls.on(Hls.Events.ERROR,(_,data)=>{if(!data.fatal || generation!==playbackGeneration)return;if(recoveries++<2 && data.type===Hls.ErrorTypes.NETWORK_ERROR){playbackState('Connection interrupted. Retrying…');hls.startLoad();}else if(recoveries<3 && data.type===Hls.ErrorTypes.MEDIA_ERROR){hls.recoverMediaError();}else if(!automaticFallback?.())playbackState('Unable to play this stream. Test it for details or choose another channel.');});
        hls.loadSource(session.url); hls.attachMedia(video);
      } else { video.src=session.url; video.play().catch(()=>{if(generation===playbackGeneration && !converted)playbackState('Press Play to begin. Unsupported media will be converted automatically.');}); }
    }
    if(!converted)waitingTimer=setTimeout(()=>{if(generation===playbackGeneration && video.readyState<2 && !automaticFallback?.())playbackState('Still waiting for media. Run a stream test or choose another channel.');},15000);
  } catch(error){if(generation===playbackGeneration)playbackState(error.message);}
}
function renderDetail() {
  const channel=state.channels.find(item=>item.id===detailId);if(!channel){$('detail-dialog').close();return;}
  const test=channel.test;$('detail-name').textContent=channel.name;
  $('detail-content').innerHTML=`${test?.thumbnail?`<img src="/thumbnail/${channel.id}.jpg?v=${encodeURIComponent(test.testedAt)}" alt="Decoded video preview">`:''}<p>${test?esc(test.message):'This channel has not been tested yet.'}</p><div class="detail-grid"><div>Category<strong dir="auto">${esc(channel.group)}</strong></div><div>Playlists<strong>${esc(channel.sourceNames.join(', '))}</strong></div><div>Resolution / frame rate<strong>${esc(test?.resolution || 'Unknown')} · ${test?.fps?test.fps+' fps':'Unknown FPS'}</strong></div><div>Video / audio codec<strong>${esc(test?.videoCodec || 'Unknown')} / ${esc(test?.audioCodec || 'Unknown')}</strong></div><div>Reported bitrate<strong>${test?.bitrate?Math.round(test.bitrate/1000)+' kb/s':'Unknown'}</strong></div><div>Test duration<strong>${test?.elapsedMs?(test.elapsedMs/1000).toFixed(1)+' seconds':'Not tested'}</strong></div><div>Last tested<strong>${esc(time(test?.testedAt))}</strong></div><div>Language<strong>${esc(channel.language || 'Not supplied')}</strong></div></div>${test?.history?.length?`<p>Recent checks: ${test.history.map(item=>`${esc(item.status)} (${esc(time(item.testedAt))})`).join(' · ')}</p>`:''}`;
}
async function test(ids){if(!ids.length)return toast('Choose channels to test.',true);await api('test',{ids});toast(`Testing ${ids.length} channels. You can keep browsing.`);}
function previewImport(){const result=PlaylistImport.extract($('source-urls').value);$('import-summary').textContent=result.urls.length?`${result.urls.length} unique playlist links detected${result.ignored?` · ${result.ignored} other links ignored`:''}`:'No playlist links detected yet.';$('import-preview').hidden=!result.urls.length;$('import-links').textContent=result.urls.join('\n');$('import-load').disabled=!result.urls.length;return result;}
async function importSources(load){const extracted=previewImport();if(!extracted.urls.length)throw new Error('No playlist links detected. Include a direct M3U URL or put an endpoint URL on its own line.');const result=await api('sources',{urls:extracted.urls.join('\n'),name:$('source-name').value});for(const id of result.ids)selectedSources.add(id);if(load)await api('fetch',{ids:result.ids,prepare:$('prepare-after-load').checked});$('source-urls').value='';$('source-name').value='';previewImport();toast(load?`${result.detected} playlists queued for loading (${result.added} newly saved).`:`${result.added} playlists saved. ${result.detected} detected sources selected.`);}
$('source-form').addEventListener('submit',event=>{event.preventDefault();action(()=>importSources(false));});
$('import-load').onclick=()=>action(()=>importSources(true));
$('source-urls').addEventListener('input',previewImport);
$('source-urls').addEventListener('paste',event=>{const html=event.clipboardData?.getData('text/html');if(!html)return;const plain=event.clipboardData.getData('text/plain');const links=[...html.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(match=>match[1]||match[2]);const detected=PlaylistImport.extract(links.map(url=>'Link '+url).join('\n')).urls;if(!detected.length)return;event.preventDefault();const field=$('source-urls');field.setRangeText([plain,...detected].join('\n'),field.selectionStart,field.selectionEnd,'end');previewImport();});
const fetchSources = ids => api('fetch',{ids,prepare:$('prepare-after-load').checked});
$('fetch-selected').onclick=()=>action(()=>fetchSources([...selectedSources]));
$('fetch-all').onclick=()=>action(()=>fetchSources(state.sources.map(source=>source.id)));
$('delete-all').onclick=()=>action(async()=>{const result=await api('sources',undefined,'DELETE');$('stop').onclick();selectedSources.clear();selectedChannels.clear();favoritesOnly=false;$('favorites-only').setAttribute('aria-pressed','false');$('source-filter').value='';$('group-filter').value='';$('status-filter').value='';$('search').value='';page=0;if($('detail-dialog').open)$('detail-dialog').close();toast(`${result.removed} playlists deleted. Paste your next batch, or use Undo delete.`);});
$('undo-delete').onclick=()=>action(async()=>{const result=await api('sources/restore',{});toast(`${result.restored} playlists restored.`);});
$('delete-selected').onclick=()=>action(async()=>{const result=await api('sources/delete',{ids:[...selectedSources]});await refresh(true);if(current&&!state.channels.some(channel=>channel.id===current.id))$('stop').onclick();selectedSources.clear();selectedChannels.clear();page=0;toast(`${result.removed} selected playlists deleted. Undo delete can restore them.`);});
$('save-selected').onclick=()=>action(async()=>{const tag=$('collection-tag').value.trim();if(!tag)throw new Error('Enter a tag for these playlists.');const result=await api('collections',{ids:[...selectedSources],tag});$('collection-tag').value='';toast(`${result.saved} playlists preserved under “${tag}”.`);});
$('saved-collections').onclick=event=>{const id=event.target.closest('[data-collection-load]')?.dataset.collectionLoad;if(id)action(async()=>{const result=await api('collections/load',{id});toast(`${result.restored} playlists loaded from your saved collection. Existing playlists kept.`);});};
$('sources').addEventListener('change',event=>{const id=event.target.dataset.sourceSelect;if(id){event.target.checked?selectedSources.add(id):selectedSources.delete(id);refresh();}});
$('sources').addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;const data=button.dataset;
 if(data.sourceFilter){$('source-filter').value=data.sourceFilter;page=0;renderFilters();renderChannels();renderSources();}
 if(data.sourceFetch)action(()=>fetchSources([data.sourceFetch]));
 if(data.sourceRemove)action(async()=>{const source=state.sources.find(item=>item.id===data.sourceRemove);if(!confirm(`Remove "${source.name}" and its saved channels?`))return;await api('sources/'+source.id,undefined,'DELETE');toast('Playlist removed.');});
 if(data.sourceEdit)action(async()=>{const source=state.sources.find(item=>item.id===data.sourceEdit);const name=prompt('Playlist name:',source.name);if(name===null)return;const result=await api('reveal',{sourceId:source.id});const url=prompt('Replace M3U URL (changing it clears this source’s old channel list; fetch again):',result.url);if(url===null)return;await api('sources/'+source.id,{name,...(url!==result.url?{url}: {})},'PATCH');toast('Playlist updated. Fetch & load to refresh its content.');});
});
for(const id of ['search','source-filter','group-filter','status-filter','sort']) $(id).addEventListener(id==='search'?'input':'change',()=>{page=0;if(id==='source-filter')renderFilters();renderChannels();renderSources();});
$('show-logos').onchange=renderChannels;
$('favorites-only').onclick=()=>{favoritesOnly=!favoritesOnly;$('favorites-only').setAttribute('aria-pressed',favoritesOnly);page=0;renderChannels();};
$('prev-page').onclick=()=>{page--;renderChannels();};$('next-page').onclick=()=>{page++;renderChannels();};
$('select-page').onchange=()=>{for(const channel of filtered().slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE))$('select-page').checked?selectedChannels.add(channel.id):selectedChannels.delete(channel.id);renderChannels();};
$('channels').addEventListener('change',event=>{const id=event.target.dataset.channelSelect;if(id){event.target.checked?selectedChannels.add(id):selectedChannels.delete(id);renderChannels();}});
$('channels').addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.dataset.play)play(button.dataset.play);if(button.dataset.favorite)action(()=>api('favorite',{id:button.dataset.favorite}));if(button.dataset.detail){detailId=button.dataset.detail;renderDetail();$('detail-dialog').showModal();}});
$('test-filtered').onclick=()=>action(()=>test(filtered().map(channel=>channel.id)));$('test-selected').onclick=()=>action(()=>test([...selectedChannels]));
$('test-all').onclick=()=>action(()=>test(state.channels.map(channel=>channel.id)));
for(const [id,key] of [['fetch-concurrency','fetchConcurrency'],['test-concurrency','testConcurrency'],['test-timeout','testTimeout']])$(id).onchange=()=>action(()=>api('settings',{[key]:Number($(id).value)}));
$('jobs').addEventListener('click',event=>{const button=event.target.closest('[data-cancel]');if(button)action(()=>api('cancel',{id:button.dataset.cancel}));});
$('close-detail').onclick=()=>$('detail-dialog').close();$('detail-play').onclick=()=>{$('detail-dialog').close();play(detailId);};$('detail-test').onclick=()=>action(()=>test([detailId]));
$('detail-copy').onclick=()=>action(async()=>{const {url}=await api('reveal',{channelId:detailId});try{await navigator.clipboard.writeText(url);toast('Stream URL copied. It may contain provider credentials.');}catch{prompt('Copy stream URL:',url);}});
$('detail-download').onclick=event=>{event.preventDefault();action(async()=>{const {url}=await api('reveal',{channelId:detailId});const channel=state.channels.find(item=>item.id===detailId);const blob=new Blob([`#EXTM3U\n#EXTINF:-1,${channel.name.replace(/[\r\n]/g,' ')}\n${url}\n`],{type:'audio/x-mpegurl'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='channel.m3u';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),5000);toast('Open channel.m3u in VLC or another media player.');});};
$('retry').onclick=()=>current && play(current.id);$('stop').onclick=()=>{playbackGeneration++;releasePlayer();current=null;session=null;$('player-empty').hidden=false;$('playing-name').textContent='Choose a channel';$('playing-meta').textContent='Playback stopped.';$('retry').disabled=true;$('stop').disabled=true;playbackState('');renderChannels();};
$('play-mode').onchange=()=>current && play(current.id);$('quality').onchange=()=>{if(hls)hls.currentLevel=Number($('quality').value);};
function switchChannel(direction){const id=ChannelNavigation.candidate(filtered(),current?.id,direction);if(id)play(id);else toast('No eligible channels in these filters.',true);}
$('previous-channel').onclick=()=>switchChannel(-1);$('next-channel').onclick=()=>switchChannel(1);$('shuffle-channel').onclick=()=>switchChannel('shuffle');
$('video-fit').onchange=()=>{$('video-stage').dataset.fit=$('video-fit').value;};
$('theater').onclick=()=>{$('theater').setAttribute('aria-pressed',document.body.classList.toggle('theater'));};
$('fullscreen').onclick=()=>action(async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await $('video-stage').requestFullscreen();});
$('pip').onclick=()=>action(async()=>{if(document.pictureInPictureElement)await document.exitPictureInPicture();else if($('video').readyState>=2 && $('video').requestPictureInPicture)await $('video').requestPictureInPicture();else toast('Play a video first. Picture in picture depends on your browser.',true);});
$('video').addEventListener('playing',()=>{clearTimeout(waitingTimer);playbackState('');const video=$('video');if(current && video.videoWidth)$('playing-meta').textContent=`${current.group} · ${video.videoWidth}×${video.videoHeight} · ${current.sourceNames.join(', ')}`;});
$('video').addEventListener('waiting',()=>{if(current)playbackState('Buffering…');});
$('video').addEventListener('error',()=>{if(current && !automaticFallback?.())playbackState('This stream could not play. Run a quality test or choose another channel.');});
$('video').addEventListener('ended',()=>{if(!current)return;if(hls?.liveSyncPosition && retryCount++<2){playbackState('Live stream ended. Reconnecting…');play(current.id,true);}else playbackState('Playback ended.');});
document.addEventListener('keydown',event=>{if(/INPUT|TEXTAREA|SELECT|BUTTON/.test(event.target.tagName) || $('detail-dialog').open || event.ctrlKey || event.altKey)return;const video=$('video');if(event.code==='Space'&&current){event.preventDefault();video.paused?video.play().catch(()=>{}):video.pause();}if(event.key.toLowerCase()==='f')$('fullscreen').click();if(event.key.toLowerCase()==='m')video.muted=!video.muted;if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();video.volume=Math.max(0,Math.min(1,video.volume+(event.key==='ArrowUp'?.05:-.05)));}});
document.addEventListener('keydown',event=>{if(/INPUT|TEXTAREA|SELECT|BUTTON/.test(event.target.tagName)||$('detail-dialog').open||event.ctrlKey||event.altKey)return;const key=event.key.toLowerCase();if(['n','p','s'].includes(key)){event.preventDefault();switchChannel(key==='n'?1:key==='p'?-1:'shuffle');}});
try{$('prepare-after-load').checked=localStorage.getItem('prepare-after-load')!=='false';}catch{}
$('prepare-after-load').onchange=()=>{try{localStorage.setItem('prepare-after-load',$('prepare-after-load').checked);}catch{}};
previewImport();refresh(true);setInterval(()=>refresh(),1500);
