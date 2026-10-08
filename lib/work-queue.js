'use strict';
// One growing queue per work type, with a shared concurrency limit across batches.
class WorkQueue {
  constructor({limit,onChange,onFinish}) { this.limit=limit;this.onChange=onChange;this.onFinish=onFinish;this.pending=[];this.outstanding=new Map();this.active=0;this.finished=false; }
  add(items, options={}) {
    let added=0;
    for(const item of items){const existing=this.outstanding.get(item.id);if(existing){existing.options.prepare ||= options.prepare;continue;}const entry={item,options:{...options}};this.pending.push(entry);this.outstanding.set(item.id,entry);added++;}
    return added;
  }
  start(job,worker){this.job=job;this.worker=worker;this.pump();}
  pump(){
    if(this.finished)return;
    const job=this.job;
    if(job.controller.signal.aborted)this.pending=[];
    while(!job.controller.signal.aborted&&this.active<this.limit()&&this.pending.length){
      const entry=this.pending.shift(),item=entry.item;this.active++;const active={id:item.id,name:item.name};job.active.push(active);
      Promise.resolve().then(()=>this.worker(item,job.controller.signal,entry.options)).then(message=>{if(!job.controller.signal.aborted){job.succeeded++;job.items.push({id:item.id,name:item.name,ok:true,message});}},error=>{if(!job.controller.signal.aborted){job.failed++;job.items.push({id:item.id,name:item.name,ok:false,message:error.message});}}).finally(()=>{
        if(!job.controller.signal.aborted)job.completed++;
        job.active=job.active.filter(item=>item!==active);this.active--;this.outstanding.delete(item.id);this.onChange?.();this.pump();
      });
    }
    if(!this.pending.length&&!this.active){this.finished=true;job.status=job.controller.signal.aborted?'cancelled':'finished';job.endedAt=Date.now();this.outstanding.clear();this.onFinish(job);}
  }
  cancel(){this.job.controller.abort();this.pump();}
}
module.exports={WorkQueue};
