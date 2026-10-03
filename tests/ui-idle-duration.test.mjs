import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('./real-idle-duration.mjs', import.meta.url), 'utf8');
async function exercise(step) {
  let wall = 0, mono = 0;
  const context = vm.createContext({Date:{now:()=>wall},performance:{now:()=>mono},Math,Error});
  vm.runInContext(source.replaceAll('export ', '')+';globalThis.run=waitForMinimumIdle',context);
  const delays=[];
  const result=await context.run(async ms=>{delays.push(ms);const change=step(delays.length,ms);wall+=change.wall;mono+=change.mono;});
  return {result:JSON.parse(JSON.stringify(result)),delays};
}
test('idle gate retains exact 60500ms wall and monotonic minimum after an early timer',async()=>{
  const {result,delays}=await exercise((n,ms)=>({wall:ms-(n===1?1:0),mono:ms-(n===1?1:0)}));
  assert.deepEqual(delays,[60500,1]);assert.equal(result.elapsedMs,60500);assert.equal(result.monotonicElapsedMs,60500);assert.equal(result.minimumMs,60500);
});
test('wall-clock correction extends observation rather than reducing its minimum',async()=>{
  const {result,delays}=await exercise((n,ms)=>({wall:ms-(n===1?1000:0),mono:ms}));
  assert.deepEqual(delays,[60500,1000]);assert.equal(result.elapsedMs,60500);assert.equal(result.monotonicElapsedMs,61500);
});
test('unmet wall gate is a bounded explicit failure with actual clock values',async()=>{
  await assert.rejects(exercise((n,ms)=>({wall:0,mono:ms})),/wall=0, monotonic=121000/);
});
test('actual UI driver records both clocks before preserving zero-mutation assertions',()=>{
  const driver=readFileSync(new URL('./generic-chat-ui.mjs',import.meta.url),'utf8');
  assert.ok(driver.includes('waitForMinimumIdle(ms=>page.waitForTimeout(ms))'));
  assert.ok(driver.includes('idleTiming.monotonicElapsedMs>=MINIMUM_IDLE_MS'));
  assert.ok(driver.includes('idleElapsedMs>=MINIMUM_IDLE_MS'));
  assert.ok(driver.includes('assert.equal(idle.mutations,0)'));
  assert.ok(driver.indexOf("await writeFile(join(out,'idle-observation.json')")<driver.indexOf('assert.ok(idleElapsedMs>=MINIMUM_IDLE_MS'));
});
