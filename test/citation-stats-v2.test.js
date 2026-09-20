import test from 'node:test';
import assert from 'node:assert/strict';
import { sprtDecline, detectChangepoint, changepointPosterior, rollingRate, confidenceSequence, compareEpochs, wilsonInterval, smoothedRate, tallyOutcomes } from '../src/citations/stats.js';

const rng = seed => () => { seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296; };
const close=(a,b,tolerance=1e-12)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`);

test('SPRT uses conservative exact likelihood-ratio boundaries and never claims stability',()=>{
  assert.equal(sprtDecline(3,10,0.8).decision,'decline');
  assert.equal(sprtDecline(8,10,0.8).decision,'baseline_supported');
  assert.equal(sprtDecline(5,10,0.8).decision,'continue');
  assert.equal(sprtDecline(0,0,0.8).decision,'continue');
  close(sprtDecline(3,10,0.8).upper,Math.log(20));
  for(const args of [[-1,2,.8],[1.5,2,.8],[3,2,.8],[1,2,0],[1,2,1],[1,2,.4,.8],[1,2,.8,.4,0]])assert.throws(()=>sprtDecline(...args),RangeError);
});

test('SPRT exact path-mass enumeration respects both error budgets through 300 looks',()=>{
  for(const [p,wrong,bound] of [[.8,'decline',.05],[.4,'baseline_supported',.1]]){
    let states=new Map([[0,1]]),error=0;
    for(let n=1;n<=300;n++){
      const next=new Map();
      for(const [k,mass] of states)for(const [x,weight] of [[0,1-p],[1,p]]){
        const sum=k+x,probability=mass*weight,decision=sprtDecline(sum,n,.8,.4).decision;
        if(decision===wrong)error+=probability;
        if(decision==='continue')next.set(sum,(next.get(sum)??0)+probability);
      }
      states=next;
    }
    assert.ok(error>0,'enumeration must exercise a wrong-boundary event');assert.ok(error<=bound,`${wrong} mass ${error} exceeds ${bound}`);
  }
});

test('fixed-epoch primitives reject invalid counts and unknown outcomes never become misses',()=>{
  for(const [k,n] of [[-.1,5],[1.5,3],[4,3],[1,NaN],[0,-1]]) {assert.equal(wilsonInterval(k,n),null);assert.equal(smoothedRate(k,n),null);}
  assert.equal(wilsonInterval(1,10,-2),null);
  assert.deepEqual(tallyOutcomes(['cited','not_cited','mentioned',null,'unknown']),{k:1,n:3,unknowns:2,mentioned:1});
  assert.throws(()=>tallyOutcomes(['unexpected']),RangeError);
});

test('confidence sequences are nested, symmetric, panel-adjusted and unchanged by unknown gaps',()=>{
  const samples=Array.from({length:1000},(_,i)=>i%3===0?1:0);
  const sequence=confidenceSequence(samples),many=confidenceSequence(samples,{comparisons:100});
  const inverse=confidenceSequence(samples.map(x=>1-x));
  let low=0,high=1;
  for(let i=0;i<sequence.length;i++){
    const [a,b]=sequence[i].interval;assert.ok(a>=low-1e-15&&b<=high+1e-15);low=a;high=b;
    close(a,1-inverse[i].interval[1]);close(b,1-inverse[i].interval[0]);
    assert.ok(many[i].interval[0]<=a&&many[i].interval[1]>=b);
  }
  assert.ok(high-low<.25,'not a vacuous [0,1] interval at n=1000');
  const gapped=confidenceSequence([null,'unknown',...samples.flatMap(x=>[x,null])]);
  assert.equal(gapped[0].interval,null);assert.deepEqual(gapped.at(-1).interval,sequence.at(-1).interval);assert.equal(gapped.at(-1).unknowns,1002);
  assert.throws(()=>confidenceSequence([2]),RangeError);assert.throws(()=>confidenceSequence([1],{comparisons:0}),RangeError);
});

test('confidence sequence deterministic simulations check simultaneous coverage across every look',()=>{
  const random=rng(455319),trials=1000,n=500;
  for(const p of [.01,.1,.5,.9,.99]){
    let failures=0;
    for(let trial=0;trial<trials;trial++){
      const samples=Array.from({length:n},()=>random()<p?1:0);
      if(confidenceSequence(samples).some(row=>!row.interval||row.interval[0]>p||row.interval[1]<p))failures++;
    }
    assert.ok(failures/trials<=.05,`p=${p}: simultaneous miss fraction ${failures/trials}`);
  }
});

test('fixed-n differences account for both epochs and the planned comparison family',()=>{
  assert.equal(compareEpochs({k:0,n:0},{k:50,n:100}).verdict,'insufficient_data');
  const drop=compareEpochs({k:10,n:100},{k:90,n:100});assert.equal(drop.verdict,'declined');assert.ok(drop.interval[1]<0);
  const growth=compareEpochs({k:90,n:100},{k:10,n:100});assert.equal(growth.verdict,'grown');close(drop.interval[0],-growth.interval[1]);
  const weak=compareEpochs({k:3,n:10},{k:8,n:10});assert.equal(weak.verdict,'not_distinguishable');
  const corrected=compareEpochs({k:10,n:100},{k:90,n:100},{comparisons:100});assert.ok(corrected.interval[0]<=drop.interval[0]&&corrected.interval[1]>=drop.interval[1]);
});

test('BOCD posterior matches brute-force enumeration of all latent segmentations',()=>{
  const xs=[1,1,0,0],h=.1,n=xs.length,expected=Array(n+1).fill(0);
  const factorial=n=>n<2?1:n*factorial(n-1);
  for(let mask=0;mask<2**n;mask++){
    let start=0,last=0,weight=1;
    for(let i=0;i<n;i++){
      const cut=Boolean(mask&(1<<i));weight*=cut?h:1-h;
      if(cut||i===n-1){const segment=xs.slice(start,i+1),k=segment.reduce((a,b)=>a+b,0),length=segment.length;weight*=factorial(k)*factorial(length-k)/factorial(length+1);start=i+1;}
      if(cut)last=i+1;
    }
    expected[n-last]+=weight;
  }
  const total=expected.reduce((a,b)=>a+b,0),actual=changepointPosterior(xs,{hazard:h}).run_length_posterior;
  expected.forEach((value,i)=>close(actual[i],value/total));close(actual[0],h);
});

test('BOCD recovers a known synthetic boundary while retaining an exploratory location interval',()=>{
  const xs=[...Array(40).fill(1),...Array(40).fill(0)],result=changepointPosterior(xs);
  assert.equal(result.interpretation,'exploratory');assert.equal(result.candidate.index,40);assert.ok(result.location_interval[0]<=40&&result.location_interval[1]>=40);
  close(result.run_length_posterior.reduce((a,b)=>a+b,0),1);
  assert.equal(detectChangepoint(Array(80).fill(1)),null);assert.equal(detectChangepoint([1,0]),null);
  assert.equal(detectChangepoint([...Array(6).fill(1),...Array(6).fill(0)]),null,'twelve observations do not force a confident change');
  const gapped=changepointPosterior([...Array(40).fill(1),null,null,...Array(40).fill(0)]);
  assert.equal(gapped.candidate.index,42);assert.deepEqual(gapped.run_length_posterior,result.run_length_posterior);assert.equal(gapped.unknowns,2);
  assert.throws(()=>changepointPosterior([1,0],{hazard:0}),RangeError);
});

test('rolling rates preserve original-position windows and exclude unknown denominators',()=>{
  assert.deepEqual(rollingRate([null,'unknown']),[null,null]);
  assert.deepEqual(rollingRate([1,null,0,null,null],2),[2/3,2/3,1/3,1/3,null]);
  const rates=rollingRate([...Array(5).fill(1),...Array(5).fill(0)],5);assert.ok(rates[4]>.8&&rates[9]<.2);
  assert.throws(()=>rollingRate([1],0),RangeError);assert.throws(()=>rollingRate([2]),RangeError);
});

test('stationarity contradictions produce an explicit empty confidence sequence',()=>{
 const rows=confidenceSequence([...Array(300).fill(1),...Array(300).fill(0)]);
 assert.equal(rows.at(-1).status,'model_conflict');assert.equal(rows.at(-1).interval,null);
});

test('fixed-n difference exact binomial null calculation stays within its family error budget',()=>{
 const n=30,probabilities=[];let probability=2**(-n);probabilities.push(probability);
 for(let k=1;k<=n;k++){probability*=((n-k+1)/k);probabilities.push(probability);}
 let falseAlarm=0;
 for(let a=0;a<=n;a++)for(let b=0;b<=n;b++)if(['declined','grown'].includes(compareEpochs({k:a,n},{k:b,n}).verdict))falseAlarm+=probabilities[a]*probabilities[b];
 assert.ok(falseAlarm>0);assert.ok(falseAlarm<=.05,`${falseAlarm} exceeds alpha`);
});
