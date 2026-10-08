'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {spawn}=require('node:child_process');const {createFixture}=require('./fixture');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('full server workflow: explicit fetch, decoded checks, relay, cancel, privacy, persistence and conversion', {timeout:120000}, async()=>{
 const fixture=createFixture();await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${fixture.server.address().port}`;
 const data=fs.mkdtempSync(path.join(__dirname,'..','test-output','library-'));let child,base,childOutput='';
 async function start(){child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),windowsHide:true,env:{...process.env,M3U_PORT:'0',M3U_DATA_DIR:data},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',chunk=>log+=chunk);child.stderr.on('data',chunk=>{log+=chunk;childOutput+=chunk;});for(let i=0;i<80;i++){const match=log.match(/ready at (http:\/\/127.0.0.1:\d+)/);if(match){base=match[1];return;}await delay(100);}throw new Error('Server did not start: '+log);}
 async function stop(){if(!child || child.exitCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}
 async function api(route,input,method='POST'){const response=await fetch(base+'/api/'+route,{method,headers:{'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});return {response,body:await response.json()};}
 async function state(){return(await api('state',undefined,'GET')).body;}
 async function waitJob(id){for(let i=0;i<600;i++){const job=(await state()).jobs.find(item=>item.id===id);if(job?.status!=='running')return job;await delay(100);}throw new Error('Job timeout');}
 try{
  await start();assert.equal((await state()).mediaReady,true);
  assert.equal((await api('settings',{fetchConcurrency:2,testConcurrency:4,testTimeout:8000})).response.status,200);assert.equal((await api('settings',{testConcurrency:100})).response.status,400);
  assert.equal((await fetch(base+'/favicon.svg')).status,200);
  const before=fixture.hits;const imported=await api('sources',{urls:`My copied page:\nMain playlist: ${origin}/playlist.m3u  \n| Backup | ${origin}/second.m3u |\n[Duplicate](${origin}/playlist.m3u)\nNotes: test these later.`});assert.equal(imported.body.detected,2);assert.equal(imported.body.ids.length,2);assert.equal(fixture.hits,before,'Saving never fetches');let library=await state();assert.equal(library.sources.length,2);assert.equal(library.channels.length,0);assert.equal((await api('sources',{urls:`  ${origin}/playlist.m3u  `})).body.added,0);
  const fetchJob=(await api('fetch',{ids:library.sources.map(source=>source.id)})).body;const fetched=await waitJob(fetchJob.id);assert.equal(fetched.succeeded,2);library=await state();assert.equal(library.channels.length,4);assert.equal(library.channels[0].sourceIds.length,2);assert.equal(library.channels[0].name,'قناة الاختبار');
  const testing=(await api('test',{ids:library.channels.map(channel=>channel.id)})).body;const tested=await waitJob(testing.id);assert.equal(tested.succeeded,2);assert.equal(tested.failed,2);assert.equal(tested.completed,4);library=await state();const good=library.channels.find(channel=>channel.name==='Sample MP4');assert.equal(good.test.status,'working');assert.equal(good.test.resolution,'640×360');assert.equal(good.test.videoCodec,'h264');assert.ok(good.test.thumbnail);
  const thumb=await fetch(base+`/thumbnail/${good.id}.jpg`);assert.equal(thumb.status,200);assert.ok((await thumb.arrayBuffer()).byteLength>1000);
  const favorite=await api('favorite',{id:good.id});assert.equal(favorite.response.status,200);
  const play=(await api('play',{id:good.id})).body;assert.equal(play.hls,false,'Known MP4 skips format sniffing');assert.equal(play.preferConvert,false);const relayed=await fetch(base+play.url,{headers:{Range:'bytes=0-100'}});assert.equal(relayed.status,206);assert.equal((await relayed.arrayBuffer()).byteLength,101);
  const hls=library.channels.find(channel=>channel.name==='قناة الاختبار');const hs=(await api('play',{id:hls.id})).body;const manifest=await(await fetch(base+hs.url)).text();assert.match(manifest,/\/relay\//);assert.ok(!manifest.includes(origin));const segment=manifest.split('\n').find(line=>line.startsWith('/relay/'));assert.ok((await(await fetch(base+segment)).arrayBuffer()).byteLength>1000);
  const converted=await fetch(base+play.convertUrl);assert.equal(converted.status,200);const bytes=Buffer.from(await converted.arrayBuffer());assert.ok(bytes.includes(Buffer.from('ftyp')));assert.ok(bytes.includes(Buffer.from('moof')));assert.ok(bytes.length>10000);
  const exported=(await api('export',undefined,'GET')).body;assert.ok(!JSON.stringify(exported).includes('PRIVATE_TEST_TOKEN'));assert.ok(!JSON.stringify(library).includes('PRIVATE_TEST_TOKEN'));
  const denied=await fetch(base+'/api/state',{headers:{Origin:'https://unrelated.example'}});assert.equal(denied.status,403);
  fixture.failPlaylist(true);const failed=(await api('fetch',{ids:[library.sources[0].id]})).body;assert.equal((await waitJob(failed.id)).failed,1);assert.equal((await state()).channels.length,4,'Failed refresh preserves library');fixture.failPlaylist(false);
  await api('sources',{urls:origin+'/slow.m3u'});library=await state();const slow=library.sources.find(source=>source.count===0);const pending=(await api('fetch',{ids:[slow.id]})).body;
  const repeated=await api('fetch',{ids:[slow.id]});assert.equal(repeated.response.status,202);assert.equal(repeated.body.id,pending.id);assert.equal(repeated.body.total,1,'Already pending source is deduplicated');
  const appended=await api('fetch',{ids:[library.sources[1].id]});assert.equal(appended.body.id,pending.id);assert.equal(appended.body.total,2,'New source joins active queue');
  for(let i=0;i<100&&(await state()).jobs.find(job=>job.id===pending.id).completed<1;i++)await delay(20);
  assert.equal((await state()).jobs.find(job=>job.id===pending.id).completed,1,'New playlist loads alongside a slow source');
  assert.equal((await api('sources/'+slow.id,{name:'Changed'},'PATCH')).response.status,400,'Mutation during fetch rejected');await api('cancel',{id:pending.id});const cancelled=await waitJob(pending.id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.completed,1);assert.equal(cancelled.active.length,0);
  await stop();await start();library=await state();assert.equal(library.channels.length,4);assert.ok(library.channels.find(channel=>channel.id===good.id).favorite);assert.equal(library.channels.find(channel=>channel.id===good.id).test.status,'working');
  assert.equal(library.settings.testTimeout,8000,'Queue settings survive restart');
  await api('sources/'+library.sources[0].id,{url:'  '+origin+'/sample.m3u8  '},'PATCH');library=await state();assert.equal(library.sources[0].count,0);const direct=(await api('fetch',{ids:[library.sources[0].id],prepare:true})).body;assert.equal((await waitJob(direct.id)).succeeded,1);library=await state();assert.equal(library.sources[0].count,1);const preparation=library.jobs.find(job=>job.type==='test');assert.ok(preparation,'Fetch requested background decoding');assert.equal((await waitJob(preparation.id)).succeeded,1);assert.equal((await state()).channels.find(channel=>channel.sourceIds.includes(library.sources[0].id)).test.status,'working');
  library=await state();const savedCount=library.sources.length;const loadedCount=library.channels.length;
  assert.equal((await api('collections',{tag:'  Keep these  ',ids:library.sources.map(source=>source.id)})).body.saved,savedCount);
  const collection=(await state()).collections[0];assert.equal(collection.tag,'Keep these');assert.ok(!JSON.stringify((await state()).collections).includes('PRIVATE_TEST_TOKEN'));
  const clearingFetch=(await api('fetch',{ids:[slow.id],prepare:true})).body;
  const clearingTest=(await api('test',{ids:library.channels.map(channel=>channel.id)})).body;
  const cleared=await api('sources',undefined,'DELETE');assert.equal(cleared.body.removed,savedCount);
  library=await state();assert.equal(library.sources.length,0);assert.equal(library.channels.length,0);assert.ok(library.canUndoDelete);
  assert.equal(library.collections.length,1,'Saved collection survives delete all');
  assert.equal(library.jobs.find(job=>job.id===clearingFetch.id).status,'cancelled');assert.notEqual(library.jobs.find(job=>job.id===clearingTest.id).status,'running');
  await delay(100);assert.equal((await state()).channels.length,0,'Cancelled work cannot repopulate the cleared library');
  await stop();await start();assert.ok((await state()).canUndoDelete,'Undo survives restart');
  const restored=await api('sources/restore',{});assert.equal(restored.body.restored,savedCount);library=await state();assert.equal(library.channels.length,loadedCount);assert.ok(library.channels.find(channel=>channel.id===good.id).favorite);assert.equal(library.canUndoDelete,false);
  assert.equal((await api('sources/restore',{})).response.status,400,'Restore cannot overwrite a current batch');
  const chosen=library.sources[0];const others=library.sources.slice(1).map(source=>source.id);
  assert.equal((await api('sources/delete',{ids:[chosen.id]})).body.removed,1);
  library=await state();assert.deepEqual(library.sources.map(source=>source.id),others,'Selected deletion preserves unselected playlists');
  assert.equal((await api('sources/restore',{})).body.restored,1,'Undo merges selected playlists back into the remaining library');
  await api('sources',undefined,'DELETE');await stop();await start();
  assert.equal((await api('collections/load',{id:collection.id})).body.restored,savedCount,'Preserved collection survives clearing and restart');
  assert.equal((await state()).channels.length,loadedCount);
  assert.equal((await api('collections/load',{id:collection.id})).body.restored,0,'Loading a collection twice does not duplicate sources');
 }catch(error){console.error('Child process exit:',child?.exitCode,childOutput);throw error;}finally{await stop();await fixture.close();}
});

