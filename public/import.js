(function(root){
 'use strict';
 function extract(text){
  const found=new Set();let ignored=0;const input=String(text||'');const standaloneLines=new Set(input.split(/\r?\n/).map(line=>line.trim()));
  for(const match of input.matchAll(/https?:\/\/[^\s<>"'`|]+/gi)){
   let value=match[0].replace(/&amp;/gi,'&').replace(/&quot;.*$/i,'');
   value=value.replace(/([)\]}])[.,;:!،。]+$/g,'$1');
   if(!value.includes('?'))value=value.replace(/[.,;:!،。]+$/g,'');
   for(const [open,close] of [['(',')'],['[',']'],['{','}']])while(value.endsWith(close)&&value.split(close).length>value.split(open).length)value=value.slice(0,-1);
   if(!value.includes('?'))value=value.replace(/[.,;:!،。]+$/g,'');
   try{
    let url=new URL(value);if(url.username||url.password){ignored++;continue;}
    const pathname=url.pathname;
    const isPlaylist=/\.m3u8?(?:\.bak\d*)?$/i.test(pathname)||/^(m3u|m3u8|m3u_plus)$/i.test(url.searchParams.get('type')||'')||/m3u8?/i.test(url.searchParams.get('format')||'');
    const standalone=standaloneLines.has(match[0]);
    if(!isPlaylist&&!standalone){ignored++;continue;}
    if(url.hostname==='github.com'){
     const parts=pathname.split('/').filter(Boolean);
     if(parts.length>=5&&['blob','raw'].includes(parts[2]))url=new URL('https://raw.githubusercontent.com/'+[parts[0],parts[1],...parts.slice(3)].join('/')+url.search);
     else{ignored++;continue;}
    }
    if(/\.(png|jpe?g|gif|svg|webp|pdf|mp4|ts|xml)$/i.test(url.pathname)){ignored++;continue;}
    found.add(url.href);
   }catch{ignored++;}
  }
  return {urls:[...found],ignored};
 }
 const api={extract};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PlaylistImport=api;
})(typeof window==='undefined'?null:window);
