'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {WorkQueue}=require('../lib/work-queue');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function job(){return{controller:new AbortController(),active:[],items:[],succeeded:0,failed:0,completed:0,status:'running'};}
test('growing queue deduplicates outstanding work, obeys a shared limit and accepts new batches',async()=>{
 let limit=2,finished=0;const releases=new Map(),started=[];const state=job();const queue=new WorkQueue({limit:()=>limit,onFinish:()=>finished++});
 assert.equal(queue.add([{id:'a'},{id:'b'},{id:'c'}]),3);
 queue.start(state,async(item,signal,options)=>{started.push(item.id);await new Promise(resolve=>releases.set(item.id,resolve));return options.prepare?'prepared':'loaded';});await tick();
 assert.deepEqual(started,['a','b']);assert.equal(queue.pending.length,1);
 assert.equal(queue.add([{id:'a'},{id:'d'}],{prepare:true}),1);queue.pump();await tick();assert.equal(state.active.length,2);
 limit=3;queue.pump();await tick();assert.deepEqual(started,['a','b','c']);
 releases.get('a')();await tick();assert.ok(started.includes('d'));assert.equal(state.items.find(item=>item.id==='a').message,'prepared');
 for(const id of ['b','c','d'])releases.get(id)();await tick();assert.equal(state.completed,4);assert.equal(finished,1);assert.equal(state.status,'finished');
});
test('cancel discards queued work and finishes after active work stops',async()=>{
 const state=job();let calls=0;const queue=new WorkQueue({limit:()=>1,onFinish:()=>{}});queue.add([{id:'a'},{id:'b'}]);queue.start(state,async(item,signal)=>{calls++;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw new Error('cancelled');});await tick();queue.cancel();await tick();assert.equal(calls,1);assert.equal(state.status,'cancelled');assert.equal(state.completed,0);assert.equal(state.active.length,0);assert.equal(queue.pending.length,0);
});
