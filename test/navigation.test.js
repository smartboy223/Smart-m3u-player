'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { candidate } = require('../public/navigation');
const channels = [{id:'a',test:{status:'working'}},{id:'bad',test:{status:'failed'}},{id:'b'},{id:'c',test:{status:'working'}}];
test('next and previous wrap around, skip failed checks, and start without a current channel',()=>{
 assert.equal(candidate(channels,'a',1),'b');assert.equal(candidate(channels,'a',-1),'c');assert.equal(candidate(channels,'c',1),'a');assert.equal(candidate(channels,null,1),'a');assert.equal(candidate(channels,null,-1),'c');
});
test('shuffle excludes current and failed channels and handles empty or single-channel filters',()=>{
 assert.equal(candidate(channels,'a','shuffle',()=>0),'b');assert.equal(candidate(channels,'a','shuffle',()=>.99),'c');assert.equal(candidate([{id:'a'}],'a','shuffle'),'a');assert.equal(candidate([],null,1),null);assert.equal(candidate([{id:'x',test:{status:'failed'}}],null,'shuffle'),null);
});
