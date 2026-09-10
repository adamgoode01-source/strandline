/* Tests the parts that do not need the API: fraction parsing, bundle
   expansion, and the guards. The fixture is the real Prado Lofts POUR 1
   schedule off sheet PT-02A, so the expected answer is known: bundles 300
   through 420, which is 121 tendons. */

import { parseInches, toFraction, parseBundle, parseQtyFt, expandSchedule } from './expand.mjs';

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log('  FAIL ' + label + '\n    got  ' + JSON.stringify(got) + '\n    want ' + JSON.stringify(want)); }
};
const approx = (got, want, label) => {
  const ok = Math.abs(got - want) < 1e-9;
  if (ok) pass++; else { fail++; console.log('  FAIL ' + label + '  got ' + got + ' want ' + want); }
};

console.log('parseInches');
[['2 1/2',2.5],['2-1/2',2.5],['D = 2 1/2"',2.5],['Δ = 10 1/8"',10.125],
 ['13 5/8',13.625],['4 3/4',4.75],['3 7/8',3.875],['5/8',0.625],['4.5',4.5],
 ['2½',2.5],['4⅛',4.125]].forEach(([i,o])=>approx(parseInches(i),o,'parseInches '+i));
eq(isNaN(parseInches('')),true,'parseInches empty');
eq(isNaN(parseInches('abc')),true,'parseInches junk');

console.log('toFraction');
[[2.5,'2-1/2'],[10.125,'10-1/8'],[13.625,'13-5/8'],[0.625,'5/8'],[4,'4'],[3.875,'3-7/8']]
  .forEach(([i,o])=>eq(toFraction(i),o,'toFraction '+i));

console.log('parseBundle');
eq(parseBundle('300 THRU 308'),{kind:'range',prefix:'',from:300,to:308,count:9},'thru');
eq(parseBundle('372 AND 373'),{kind:'range',prefix:'',from:372,to:373,count:2},'adjacent and');
eq(parseBundle('312'),{kind:'range',prefix:'',from:312,to:312,count:1},'single');
eq(parseBundle('300-308'),{kind:'range',prefix:'',from:300,to:308,count:9},'dash');
eq(parseBundle('T300 THRU T302'),{kind:'range',prefix:'T',from:300,to:302,count:3},'prefixed');
eq(parseBundle('305 AND 309'),{kind:'list',prefix:'',marks:[305,309],count:2},'non-adjacent and');
eq(parseBundle('junk'),null,'unreadable');
eq(parseBundle('308 THRU 300'),null,'reversed range rejected');

console.log('parseQtyFt');
eq(parseQtyFt('9 X 34A'),{qty:9,feet:34,anchor:'A'},'qty x ft anchor');
eq(parseQtyFt('22 X 169B'),{qty:22,feet:169,anchor:'B'},'three digit');
eq(parseQtyFt('1 X 59B'),{qty:1,feet:59,anchor:'B'},'single');
eq(parseQtyFt('17 X 57A'),{qty:17,feet:57,anchor:'A'},'17');
eq(parseQtyFt('nonsense'),null,'unreadable');

// ---- the real sheet ----
const PRADO = [
  ['300 THRU 308','9 X 34A','Δ = 2 1/2"'],
  ['309 THRU 311','3 X 51A','Δ = 3 7/8"'],
  ['312','1 X 54A','Δ = 4 1/4"'],
  ['313 THRU 329','17 X 57A','Δ = 4 1/2"'],
  ['330','1 X 60A','Δ = 4 3/4"'],
  ['331 THRU 340','10 X 80A','Δ = 6 3/8"'],
  ['341 THRU 343','3 X 125A','Δ = 10 1/8"'],
  ['344 THRU 363','20 X 135B','Δ = 10 7/8"'],
  ['364 THRU 371','8 X 34A','Δ = 2 1/2"'],
  ['372 AND 373','2 X 49A','Δ = 3 3/4"'],
  ['374 THRU 379','6 X 55A','Δ = 4 1/4"'],
  ['380 AND 381','2 X 56A','Δ = 4 3/8"'],
  ['382 AND 383','2 X 58A','Δ = 4 5/8"'],
  ['384 AND 385','2 X 59A','Δ = 4 5/8"'],
  ['386','1 X 59B','Δ = 4 5/8"'],
  ['387 THRU 396','10 X 80A','Δ = 6 3/8"'],
  ['397 AND 398','2 X 96A','Δ = 7 3/4"'],
  ['399 THRU 420','22 X 169B','Δ = 13 5/8"']
].map(([bundle,qtyFt,elongation])=>({bundle,qtyFt,elongation,pour:'Pour 1'}));

console.log('Prado Lofts POUR 1');
const r = expandSchedule(PRADO);
eq(r.tendons.length,121,'121 tendons produced');
eq(r.stats.statedTotal,121,'stated quantities sum to 121');
eq(r.warnings.filter(w=>w.level==='error').length,0,'no errors');
eq(r.tendons[0],{mark:'300',loc:'',strands:1,len:'34',calc:'2-1/2',anchor:'A',grp:'Pour 1',notes:''},'first tendon');
eq(r.tendons[120],{mark:'420',loc:'',strands:1,len:'169',calc:'13-5/8',anchor:'B',grp:'Pour 1',notes:''},'last tendon');
eq(r.tendons.map(t=>t.mark).slice(0,3),['300','301','302'],'range expanded in order');
// marks must be contiguous 300..420 with no gaps or repeats
const marks=r.tendons.map(t=>+t.mark);
eq(marks.length,new Set(marks).size,'no duplicate marks');
eq(Math.min(...marks),300,'lowest mark 300');
eq(Math.max(...marks),420,'highest mark 420');
eq(marks.every((m,i)=>i===0||m===marks[i-1]+1),true,'contiguous 300 to 420');
// spot check a mid-range tendon inherits its bundle's values
const t357=r.tendons.find(t=>t.mark==='357');
eq({len:t357.len,calc:t357.calc,anchor:t357.anchor},{len:'135',calc:'10-7/8',anchor:'B'},'tendon 357 from the 344-363 bundle');
// anchorage split
const aCount=r.tendons.filter(t=>t.anchor==='A').length;
const bCount=r.tendons.filter(t=>t.anchor==='B').length;
eq(aCount+bCount,121,'every tendon carries an anchorage type');
console.log('  anchorage A: '+aCount+'   anchorage B: '+bCount);

console.log('guards');
const bad=expandSchedule([{bundle:'300 THRU 308',qtyFt:'10 X 34A',elongation:'2 1/2'}]);
eq(bad.warnings.some(w=>w.level==='error'&&/does not match/.test(w.msg)),true,'quantity mismatch flagged');
eq(bad.tendons.length,9,'range still governs the expansion');
const dup=expandSchedule([{bundle:'300 THRU 302',qtyFt:'3 X 34A',elongation:'2 1/2'},
                          {bundle:'301',qtyFt:'1 X 40A',elongation:'3'}]);
eq(dup.warnings.some(w=>/more than once/.test(w.msg)),true,'duplicate tendon flagged');
const noE=expandSchedule([{bundle:'300',qtyFt:'1 X 34A',elongation:'---'}]);
eq(noE.tendons[0].calc,'','unreadable elongation left blank not guessed');
eq(noE.warnings.some(w=>/elongation unreadable/.test(w.msg)),true,'blank elongation warned');

console.log('');
console.log(pass+' passed, '+fail+' failed');
process.exit(fail ? 1 : 0);
