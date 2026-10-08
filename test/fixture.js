'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
function createFixture() {
  const output = path.join(__dirname, '..', 'test-output'); fs.mkdirSync(output, {recursive:true});
  const folder = fs.mkdtempSync(path.join(output,'media-'));
  const ffmpeg = require('ffmpeg-static');
  execFileSync(ffmpeg, ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','6','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','25','-c:a','aac','-movflags','+faststart',path.join(folder,'sample.mp4')], {windowsHide:true,timeout:30000});
  execFileSync(ffmpeg, ['-hide_banner','-loglevel','error','-i',path.join(folder,'sample.mp4'),'-c','copy','-hls_time','1','-hls_playlist_type','vod',path.join(folder,'sample.m3u8')], {windowsHide:true,timeout:30000});
  let playlistFailed = false, hits = 0; const sockets = new Set();
  const server = http.createServer((req,res)=>{
    hits++;
    const url = new URL(req.url,'http://fixture');
    const origin = `http://127.0.0.1:${server.address().port}`;
    if(url.pathname==='/slow.m3u') return; // Deliberately hangs until cancelled.
    if(url.pathname==='/fallback.m3u'){res.setHeader('Content-Type','audio/x-mpegurl');return res.end(`#EXTM3U\n#EXTINF:-1,Automatic compatibility sample\n${origin}/disguised.mp4\n`);}
    if(url.pathname==='/playlist.m3u' || url.pathname==='/second.m3u') {
      if(playlistFailed){res.writeHead(503);return res.end('Provider unavailable');}
      res.setHeader('Content-Type','audio/x-mpegurl');
      return res.end(`#EXTM3U\n#EXTINF:-1 tvg-id="demo" group-title="Test video" tvg-language="العربية",قناة الاختبار\nsample.m3u8\n#EXTINF:-1 group-title="Test video",Sample MP4\n${origin}/sample.mp4?token=PRIVATE_TEST_TOKEN\n#EXTINF:-1 group-title="Errors",Unavailable sample\n${origin}/missing.ts\n#EXTINF:-1 group-title="Errors",HTML is not video\n${origin}/fake\n`);
    }
    if(url.pathname==='/fake'){res.setHeader('Content-Type','text/html');return res.end('<html><body>Not a stream</body></html>');}
    const name=url.pathname==='/disguised.mp4'?'sample0.ts':path.basename(url.pathname);const file=path.join(folder,name);
    if(!['sample.mp4','sample.m3u8'].includes(name) && !/^sample\d+\.ts$/.test(name)){res.writeHead(404);return res.end('Missing');}
    if(!fs.existsSync(file)){res.writeHead(404);return res.end();}
    const size=fs.statSync(file).size;const type=name.endsWith('.mp4')?'video/mp4':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t';
    if(req.headers.range){const match=req.headers.range.match(/bytes=(\d+)-(\d*)/);const start=Number(match?.[1]||0),end=Math.min(Number(match?.[2]||size-1),size-1);res.writeHead(206,{'Content-Type':type,'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${size}`,'Accept-Ranges':'bytes'});fs.createReadStream(file,{start,end}).pipe(res);}
    else{res.writeHead(200,{'Content-Type':type,'Content-Length':size,'Accept-Ranges':'bytes'});fs.createReadStream(file).pipe(res);}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  // Keep generated media as inspectable test evidence. No user library is touched.
  return { server, folder, failPlaylist(value){playlistFailed=value;}, get hits(){return hits;}, async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));} };
}
module.exports={createFixture};
if(require.main===module){const fixture=createFixture();fixture.server.listen(8799,'127.0.0.1',()=>console.log('Fixture playlist: http://127.0.0.1:8799/playlist.m3u'));process.on('SIGINT',()=>fixture.close().then(()=>process.exit()));}

