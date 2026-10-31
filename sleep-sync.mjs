// Yawmi sleep import from Apple Health/Shortcuts. No network calls in this module.
// The source must be verified by the user in Apple Health; Shortcuts' Source field
// is not reliable on all devices. Do not treat an automatic sleep day as a
// symptom-free diary day.
const SLEEP_STAGES = new Set(['Core', 'Deep', 'REM', 'Asleep']);
const ALL_STAGES = new Set([...SLEEP_STAGES, 'Awake', 'In Bed']);
const ISO_OFFSET = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/;
const minute = 60000;
const keyOf = p => `${p.start}|${p.end}|${p.stage}`;
const dateLocal = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const clockLocal = d => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
const hm = mins => `${Math.floor(mins/60)}:${String(mins%60).padStart(2,'0')}`;

export function parseSleepSamples(payload, {maxSamples=10000}={}) {
  if (typeof payload === 'string') payload = JSON.parse(payload);
  // The Shortcuts output is an array. Worker also responds {samples: [...]}.
  const rows = Array.isArray(payload) ? payload : payload && Array.isArray(payload.samples) ? payload.samples : null;
  if (!rows || rows.length > maxSamples) throw new Error('ملف النوم غير متوافق أو كبير جدًا');
  const unique = new Map();
  const maximum = Date.now() + 86400000;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !ALL_STAGES.has(row.stage)) continue;
    if (typeof row.start !== 'string' || typeof row.end !== 'string' || !ISO_OFFSET.test(row.start) || !ISO_OFFSET.test(row.end)) continue;
    const a = Date.parse(row.start), b = Date.parse(row.end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b || b - a > 86400000 || a < Date.UTC(2020,0,1) || b > maximum) continue;
    const item = { start: new Date(a).toISOString(), end: new Date(b).toISOString(), stage: row.stage };
    unique.set(keyOf(item), item);
  }
  return [...unique.values()].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
}

// Awake takes priority over sleep labels if sources overlap. In Bed never adds
// sleep time, and duplicated samples are not summed twice.
export function summarizeSleepSessions(rawSamples, {minMainMinutes=120}={}) {
  const samples = parseSleepSamples(rawSamples);
  const sleep = samples.filter(s=>SLEEP_STAGES.has(s.stage));
  const sessions=[];
  for(const p of sleep){
    const a=Date.parse(p.start),b=Date.parse(p.end),last=sessions.at(-1);
    if(!last || a-last.end > 120*minute){sessions.push({start:a,end:b,parts:[p]});}
    else {last.end=Math.max(last.end,b);last.parts.push(p);}
  }
  const byDay = new Map();
  for(const s of sessions){
    if(s.end-s.start>20*3600000) continue;
    const involved=samples.filter(p=>Date.parse(p.end)>s.start && Date.parse(p.start)<s.end && p.stage!=='In Bed');
    const points=[...new Set([s.start,s.end,...involved.flatMap(p=>[Math.max(s.start,Date.parse(p.start)),Math.min(s.end,Date.parse(p.end))])])].sort((a,b)=>a-b);
    const totals={Core:0,Deep:0,REM:0,Asleep:0,Awake:0};
    for(let i=0;i<points.length-1;i++){
      const a=points[i],b=points[i+1],stages=involved.filter(p=>Date.parse(p.start)<b && Date.parse(p.end)>a).map(p=>p.stage);
      const stage=['Awake','Deep','REM','Core','Asleep'].find(x=>stages.includes(x));
      if(stage)totals[stage]+=(b-a)/minute;
    }
    const active=totals.Core+totals.Deep+totals.REM+totals.Asleep;
    if(active<minMainMinutes)continue; // do not mistake a nap or three test rows for a full night
    const date=dateLocal(new Date(s.end));
    const prev=byDay.get(date);
    if(!prev || active>prev.total)byDay.set(date,{date,start:s.start,end:s.end,total:active,totals});
  }
  return [...byDay.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(s=>{
    const bed=new Date(s.start),wake=new Date(s.end),whole=(s.end-s.start)/minute;
    const total=Math.round(s.total);
    const deep=Math.round(s.totals.Deep),rem=Math.round(s.totals.REM);
    const light=Math.max(0,total-deep-rem);
    return {
      sleepDate:s.date, bedtime:clockLocal(bed), wakeTime:clockLocal(wake),
      duration:hm(total), timeInBed:hm(Math.round(whole)),
      deep:hm(deep), light:hm(light), rem:hm(rem),
      awake:hm(Math.max(0,Math.round(whole)-total)),
      efficiency:Math.min(100,Math.round((s.total/whole)*100)),
      source:'apple-health', syncOrigin:'apple-health-shortcuts', timeApprox:false,
      // Diagnostic values only; no raw stages are stored in the diary.
      sleepStart:bed.toISOString(), sleepEnd:wake.toISOString()
    };
  });
}

export function planSleepImport(raw, records){
  const sessions=summarizeSleepSessions(raw);
  const existing = new Map(records.filter(r=>r.type==='sleep'&&r.sleepDate).map(r=>[r.sleepDate,r]));
  const plan={rows:[],added:0,updated:0,protected:0,smaller:0,dates:sessions.map(s=>s.sleepDate),sessions:sessions.length};
  for(const s of sessions){
    const current=existing.get(s.sleepDate);
    if(current && current.syncOrigin!=='apple-health-shortcuts'){plan.protected++;continue;}
    if(current){
      const old=(String(current.duration||'').match(/^(\d+):(\d\d)$/)||[]);
      const was=old.length?Number(old[1])*60+Number(old[2]):0;
      const next=Number(s.duration.split(':')[0])*60+Number(s.duration.split(':')[1]);
      if(was>0 && next<was*0.8){plan.smaller++;continue;}
      const comparable=['duration','timeInBed','bedtime','wakeTime','deep','light','rem','awake','efficiency','sleepStart','sleepEnd'];
      if(comparable.every(k=>String(current[k]??'')===String(s[k]??''))) continue;
      plan.updated++;
    } else plan.added++;
    plan.rows.push({...current,...s,id:current?.id||`sleep-ringconn-health-${s.sleepDate}`,
      type:'sleep',at:new Date(`${s.sleepDate}T09:00:00`).toISOString()});
  }
  return plan;
}
