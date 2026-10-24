/* RingConn screenshot reader — local OCR, v1.5.
 * Image pixels are processed in the browser. On first use Tesseract.js and its
 * English model are downloaded; the screenshot is never uploaded by this code.
 * We deliberately leave uncertain values blank instead of guessing. */
const CDN='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let worker;
function script(src){return new Promise((ok,fail)=>{
 if(window.Tesseract?.createWorker){ok();return}
 const tag=document.createElement('script');tag.src=src;tag.crossOrigin='anonymous';tag.onload=ok;
 tag.onerror=()=>fail(new Error('تعذر تحميل محرك قراءة النص؛ يلزم اتصال بالإنترنت في المرة الأولى.'));
 document.head.appendChild(tag);
})}
async function ensureWorker(notify){
 if(worker)return worker;
 notify('تحميل محرك التعرف المحلي…');await script(CDN);
 if(!window.Tesseract?.createWorker)throw Error('محرك التعرف غير متاح');
 worker=await window.Tesseract.createWorker('eng',1,{logger:m=>{
  if(m.status==='recognizing text')notify(`استخراج النص ${Math.round((m.progress||0)*100)}%`);
 }});
 return worker;
}
function canvasCrop(bitmap,rect){
 const {width,height}=bitmap;const left=Math.max(0,Math.floor(width*rect[0]));
 const top=Math.max(0,Math.floor(height*rect[1]));
 const w=Math.min(width-left,Math.ceil(width*rect[2]));
 const h=Math.min(height-top,Math.ceil(height*rect[3]));
 const c=document.createElement('canvas');c.width=w;c.height=h;
 const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,left,top,w,h,0,0,w,h);
 return c;
}
// Position-aware OCR: Tesseract v5 can return line bounding boxes in blocks or
// TSV. Missing coordinates are a reason to leave a value blank, NOT to infer a
// fixed pixel row (the optional Nap tab shifts RingConn's layout).
function geometryLines(data){
 const found=[];
 for(const block of (Array.isArray(data?.blocks)?data.blocks:Array.isArray(data?.blocks?.blocks)?data.blocks.blocks:[])){
  for(const par of block.paragraphs||[]){
   for(const line of par.lines||[]){
    const t=String(line.text||(line.words||[]).map(w=>w.text||'').join(' ')).trim();
    const b=line.bbox||{};
    if(t&&Number.isFinite(b.y0)&&Number.isFinite(b.y1))found.push({text:t,y:(b.y0+b.y1)/2,x:(b.x0+b.x1)/2,confidence:line.confidence||0});
   }
  }
 }
 if(found.length)return found;
 // TSV output fallback for other Tesseract builds.
 const tsv=data?.tsv||'';
 if(typeof tsv==='string'&&tsv.includes('level')){
  const lines=tsv.split(/\r?\n/);const headers=lines.shift().split('\t');
  const groups=new Map();
  for(const line of lines){const cols=line.split('\t');if(cols.length<headers.length)continue;
   const cell=Object.fromEntries(headers.map((k,i)=>[k,cols[i]]));
   if(Number(cell.level)!==5||!cell.text?.trim())continue;
   const key=[cell.block_num,cell.par_num,cell.line_num].join('/');
   if(!groups.has(key))groups.set(key,[]);
   groups.get(key).push(cell);
  }
  for(const words of groups.values()){
   const x0=Math.min(...words.map(w=>Number(w.left))),x1=Math.max(...words.map(w=>+w.left + +w.width));
   const y0=Math.min(...words.map(w=>Number(w.top))),y1=Math.max(...words.map(w=>+w.top + +w.height));
   found.push({text:words.map(w=>w.text).join(' '),x:(x0+x1)/2,y:(y0+y1)/2,confidence:0});
  }
 }
 return found;
}
async function recognizeCanvas(w,c){
 const response=await w.recognize(c,{}, {text:true,blocks:true,tsv:true});
 return {text:response?.data?.text||'',confidence:response?.data?.confidence||0,lines:geometryLines(response?.data)};
}
function stageKey(text){
 const s=String(text||'').toLowerCase().replace(/[^a-z\s]/g,' ').replace(/\s+/g,' ').trim();
 if(/\bawake\b|\btime awake\b/.test(s))return 'awake';
 if(/\brem\b/.test(s))return 'rem';
 if(/\blight\s*sleep\b/.test(s))return 'light';
 if(/\bdeep\s*sleep\b/.test(s))return 'deep';
 return '';
}
// Uses label positions dynamically. Duration text sits slightly *below* the
// left label; it belongs to the region before the NEXT stage label.
export function pairStageRows(labelLines,valueLines,geometryHeight){
 const order=['awake','rem','light','deep'];
 const anchor=new Map();
 for(const line of (labelLines||[])){
  const key=stageKey(line.text);if(key&&!anchor.has(key))anchor.set(key,line.y);
 }
 const rows={};const issues=[];
 const all=[...anchor.entries()].sort((a,b)=>a[1]-b[1]);
 for(let i=0;i<all.length;i++){
  const [key,y]=all[i],nextY=all[i+1]?.[1]??Infinity;
  const candidates=(valueLines||[]).filter(v=>v.y>=y-geometryHeight*.015 && v.y<nextY-geometryHeight*.012)
   .map(v=>({text:v.text,time:rowDuration(v.text),distance:Math.abs(v.y-y)})).filter(v=>v.time);
  if(candidates.length===1){rows[key]=candidates[0].text;}
  else if(candidates.length>1)issues.push('أكثر من مدة محتملة عند '+key);
  else issues.push('تعذر ربط مدة مرحلة '+key+' بموقع عنوانها');
 }
 for(const key of order)if(!anchor.has(key))issues.push('عنوان مرحلة '+key+' غير واضح');
 return {rows,issues,anchors:Object.fromEntries(anchor)};
}
// The screenshot can have a Nap tab, moving the graph and stage rows. OCR the
// entire possible stage region as two columns instead of four fixed y-crops.
function cropScaled(bitmap,rect,scale=1.6){
 const raw=canvasCrop(bitmap,rect);if(scale===1)return raw;
 const c=document.createElement('canvas');c.width=Math.round(raw.width*scale);c.height=Math.round(raw.height*scale);
 const ctx=c.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.drawImage(raw,0,0,c.width,c.height);return c;
}
// Fallback for Tesseract builds without box/TSV support: align by row *order*
// only if all four labels and all four durations are unambiguous. A partial
// result is left blank, because the missing line can shift later values.
function pairStageText(labelText,valueText){
 const rawLabels=String(labelText||'').split(/\r?\n/).map(stageKey).filter(Boolean);
 const rawValues=String(valueText||'').split(/\r?\n/).map(x=>x.trim()).filter(x=>rowDuration(x));
 const order=['awake','rem','light','deep'];
 if(rawLabels.length!==4||rawValues.length!==4||order.some((k,i)=>rawLabels[i]!==k))return {};
 return Object.fromEntries(order.map((k,i)=>[k,rawValues[i]]));
}
function axisLine(textLines){
 const eligible=(textLines||[]).map(l=>({line:l.text,count:([...(String(l.text).matchAll(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g))]).length})).filter(x=>x.count>=3&&x.count<=5).sort((a,b)=>b.count-a.count);
 return eligible[0]?.line||'';
}
export async function recognizeLocal(file,onProgress=()=>{}){
 const w=await ensureWorker(onProgress);let bitmap;
 try{
  bitmap=await createImageBitmap(file);
  const portrait=bitmap.height>bitmap.width*1.45;
  if(!portrait){onProgress('قراءة الصورة…');const full=await recognizeCanvas(w,file);return {...full,sections:{full:full.text}}}
  onProgress('قراءة التاريخ المحدد وملخص النوم…');
  const head=await recognizeCanvas(w,cropScaled(bitmap,[0,.073,1,.31],1.3));
  // Center strip only: the adjacent days must not supply the sleep date.
  const selected=await recognizeCanvas(w,cropScaled(bitmap,[.345,.076,.31,.083],2.1));
  onProgress('قراءة محور أوقات النوم…');
  const graph=await recognizeCanvas(w,cropScaled(bitmap,[.025,.31,.95,.235],1.4));
  onProgress('تحديد مواقع أسماء مراحل النوم…');
  const rectY=.525,rectH=.42;
  const labels=await recognizeCanvas(w,cropScaled(bitmap,[.015,rectY,.53,rectH],1.8));
  onProgress('قراءة مدد المراحل من العمود المقابل…');
  const values=await recognizeCanvas(w,cropScaled(bitmap,[.775,rectY,.225,rectH],1.8));
  const dynamic=pairStageRows(labels.lines,values.lines,Math.round(bitmap.height*rectH*1.8));
  if(!labels.lines.length&&!values.lines.length){dynamic.rows=pairStageText(labels.text,values.text);if(Object.keys(dynamic.rows).length)dynamic.issues=[];}
  // Line-by-line text is a secondary fallback ONLY when stage geometry
  // is unavailable. If a label is missing, never assign the next stage's time.
  const allStageText=labels.text+'\n'+values.text;
  const combined=[head.text,selected.text,allStageText].filter(Boolean).join('\n');
  const axis=axisLine(graph.lines);
  return {text:combined,confidence:Math.round((head.confidence+labels.confidence+values.confidence)/3),sections:{
   header:head.text,selectedDate:selected.text,axis,stages:allStageText,
   stageRows:dynamic.rows,anchoredStages:true,stageWarnings:dynamic.issues,
   labelsText:labels.text,valuesText:values.text,
   // In nap-layout screenshots, the tab shows 'Nap HH:MM-HH:MM'.
   napHeader:head.text
  }};
 }finally{bitmap?.close?.()}
}
const normalize=x=>String(x||'')
 .replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
 .replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))
 .replace(/[：]/g,':').replace(/[–—]/g,'-')
 .replace(/\u00a0/g,' ')
 .replace(/\b(?:l|I)\s*(?=hr\b)/g,'1');
const minutesToHHMM=minutes=>Number.isFinite(minutes)&&minutes>=0&&minutes<1440
 ?`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`:'';
function durationValue(s){
 s=normalize(s).toLowerCase();
 // Crucial: recognize "hr" BEFORE "h". Old version incorrectly read 1hr 28min as 01:00.
 let m=s.match(/\b(\d{1,2})\s*(?:hours?|hrs?|hr|h)\.?\s*(\d{1,2})\s*(?:minutes?|mins?|min|m)\b/i);
 if(m&&+m[2]<60)return minutesToHHMM(+m[1]*60+(+m[2]));
 m=s.match(/\b(\d{1,2})\s*(?:hours?|hrs?|hr|h)\b/i);
 if(m)return minutesToHHMM(+m[1]*60);
 m=s.match(/\b(\d{1,3})\s*(?:minutes?|mins?|min)\b/i);
 if(m)return minutesToHHMM(+m[1]);
 // Only allow hh:mm when it occurs in a labelled value region, never in the whole page.
 m=s.match(/\b(\d{1,2})\s*:\s*([0-5]\d)\b/);
 if(m)return minutesToHHMM(+m[1]*60+(+m[2]));
 return '';
}

// ROI reading is accepted only if it contains exactly one time duration.
// Percentages and other stray figures cannot turn into sleep minutes.
function rowDuration(source){
 const s=normalize(source).replace(/\d{1,3}(?:[.,]\d+)?\s*%/g,' ').trim();
 const found=[...s.matchAll(/\b(?:\d{1,2}\s*(?:hours?|hrs?|hr|h)(?:\s*\d{1,2}\s*(?:minutes?|mins?|min|m))?|\d{1,3}\s*(?:minutes?|mins?|min))\b/gi)];
 if(found.length!==1)return '';
 return durationValue(found[0][0]);
}
const asLocalISO=baseDate=>{
 const d=new Date(baseDate||Date.now());
 return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const labels={
 awake:/\b(?:awake|time\s*awake|wake\s*duration)\b|الاستيقاظ|مستيقظ/i,
 rem:/\brem\b|حركة العين السريعة/i,
 light:/\blight\s*sleep\b|النوم الخفيف/i,
 deep:/\bdeep\s*sleep\b|النوم العميق/i,
 timeInBed:/\btime\s*in\s*bed\b/i,
 efficiency:/\bsleep\s*efficiency\b|كفاءة النوم/i,
 duration:/\b(?:actual\s*sleep|total\s*sleep|sleep\s*duration|time\s*asleep)\b|النوم الفعلي|مدة النوم/i
};
const anyLabel=new RegExp(Object.values(labels).map(re=>`(?:${re.source})`).join('|'),'i');
function labelledFragment(re,lines){
 for(let i=0;i<lines.length;i++){
  const m=lines[i].match(re);if(!m)continue;
  let fragment=lines[i].slice(m.index+m[0].length);
  const otherLabel=fragment.search(anyLabel);if(otherLabel>=0)fragment=fragment.slice(0,otherLabel);
  for(let j=i+1;j<Math.min(i+4,lines.length);j++){
   if(anyLabel.test(lines[j]))break;
   fragment+=' '+lines[j];
  }
  return fragment.trim();
 }
 return '';
}
function nearby(label,re,lines){
 const fragment=labelledFragment(re,lines);
 return fragment?durationValue(fragment):'';
}
function percentageFor(re,lines){
 const fragment=labelledFragment(re,lines);
 const m=fragment.match(/(?:^|\s)(\d{1,3}(?:[.,]\d{1,2})?)\s*%/);
 if(!m)return null;
 const p=Number(m[1].replace(',','.'));
 return Number.isFinite(p)&&p>=0&&p<=100?p:null;
}
function nearbyEfficiency(lines){
 for(let i=0;i<lines.length;i++)if(labels.efficiency.test(lines[i])){
  for(let j=i;j<Math.min(i+4,lines.length);j++){
   if(j>i&&anyLabel.test(lines[j]))break;
   const after=j===i?lines[j].replace(labels.efficiency,''):lines[j];
   let m=after.match(/\b(\d{2,3})\s*%/);if(!m)m=after.trim().match(/^(\d{2,3})$/);
   if(m&&+m[1]<=100)return m[1];
  }
 }
 return '';
}
function clockInterval(text,re){
 const s=normalize(text),match=s.match(re);if(!match)return null;
 const one=Number(match[1])*60+Number(match[2]),two=Number(match[3])*60+Number(match[4]);
 if(Number(match[1])>23||Number(match[3])>23||Number(match[2])>59||Number(match[4])>59)return null;
 return {start:`${String(match[1]).padStart(2,'0')}:${match[2]}`,end:`${String(match[3]).padStart(2,'0')}:${match[4]}`,minutes:(two-one+1440)%1440};
}
function matchSleepInterval(s){
 // Only use times explicitly linked to the sleep tab; do not interpret graph ticks.
 return clockInterval(s,/\bSleep\s+(\d{1,2})\s*:\s*([0-5]\d)\s*[-–—]\s*(\d{1,2})\s*:\s*([0-5]\d)/i);
}
function matchNapInterval(s){
 return clockInterval(s,/\bNap\s+(\d{1,2})\s*:\s*([0-5]\d)\s*[-–—]\s*(\d{1,2})\s*:\s*([0-5]\d)/i);
}
function stagePercentMismatch(times,percents){
 const total=Object.values(times).reduce((acc,x)=>acc+x,0);
 if(!total)return Infinity;
 return Object.entries(percents).reduce((worst,[k,p])=>Math.max(worst,Math.abs(100*times[k]/total-p)),0);
}
const months={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
function selectedDate(text,baseDate){
 const s=normalize(text);
 const re=/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s*[.,]?\s*(\d{1,2})(?:\s*,?\s*(20\d{2}))?\b/i;
 const matches=[...s.matchAll(new RegExp(re.source,'gi'))];if(!matches.length)return null;
 // Selected-date crop normally contains just the centered day; if not, prefer last date.
 const m=matches[matches.length-1],month=months[m[1].slice(0,3).toLowerCase()],day=+m[2];
 const base=new Date(baseDate||Date.now());const yrs=m[3]?[+m[3]]:[base.getFullYear()-1,base.getFullYear(),base.getFullYear()+1];
 const possible=yrs.map(y=>new Date(y,month-1,day,12)).filter(d=>d.getMonth()===month-1&&d.getDate()===day).sort((a,b)=>Math.abs(a-base)-Math.abs(b-base));
 if(!possible.length)return null;
 const dt=possible[0];return {date:`${dt.getFullYear()}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,yearInferred:!m[3]};
}
function toMinutes(s){if(!/^\d{2}:\d{2}$/.test(s||''))return null;const [h,m]=s.split(':').map(Number);return 60*h+m}
/** Pure parser: accepts a Tesseract text string OR a section bundle. */
export function parseSleepOCR(source,baseDate=new Date()){
 const sections=typeof source==='string'?{full:source}:source?.sections||{full:source?.text||''};
 const linesOf=s=>normalize(s).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 const stages=linesOf(sections.stages||sections.full||''),head=linesOf(sections.header||sections.full||'');
 const fields={duration:'',deep:'',light:'',rem:'',awake:'',efficiency:'',timeInBed:'',sleepDate:'',bedtime:'',wakeTime:'',nap:''};
 const evidence={},warnings=[];
 if(sections.anchoredStages){warnings.push(...(sections.stageWarnings||[]).filter(w=>!w.includes('تعذر ربط')&&!w.includes('غير واضح')).slice(0,2).map(w=>'OCR: '+w));}
 for(const key of ['deep','light','rem','awake']){
  const fromRow=rowDuration(sections.stageRows?.[key]||'');
  fields[key]=fromRow||(!sections.anchoredStages?nearby(key,labels[key],stages):'');
  if(fields[key])evidence[key]=fromRow?'مقروء من صف المرحلة مباشرة':'مربوط باسم المرحلة في النص';
 }
 fields.timeInBed=nearby('timeInBed',labels.timeInBed,head);
 if(fields.timeInBed)evidence.timeInBed='مقروء من Time in Bed';
 fields.duration=nearby('duration',labels.duration,head);
 if(fields.duration)evidence.duration='مقروء مباشرة';
 fields.efficiency=nearbyEfficiency(head);
 if(fields.efficiency)evidence.efficiency='مقروء من Sleep Efficiency';
 // The neighboring day (e.g. Oct 23) must NEVER substitute for the
 // centered selected day ('Today'). Trust the tighter selected-date crop only.
 const selected=normalize(sections.selectedDate||'');
 if(/\bto\s*day\b/i.test(selected)){
  fields.sleepDate=asLocalISO(baseDate);
  evidence.sleepDate='Today: تاريخ الجهاز الحالي وقت قراءة الصورة؛ راجعه إذا كانت الصورة قديمة';
  warnings.push('اخترنا تاريخ اليوم من كلمة Today؛ إذا كانت الصورة ملتقطة في يوم سابق، صحح التاريخ.');
 }else{
  const detected=selectedDate(selected,baseDate);
  if(detected){fields.sleepDate=detected.date;evidence.sleepDate=detected.yearInferred?'الشهر واليوم مقروءان؛ السنة مقدّرة':'التاريخ المحدد مقروء';}
  else warnings.push('لم يُقرأ التاريخ المحدد في منتصف الشريط؛ تركناه فارغًا بدل اختيار تاريخ اليوم المجاور.');
 }
 const wholeHeader=sections.header||sections.full||'';
 const sleep=matchSleepInterval(wholeHeader);
 if(sleep&&sleep.minutes>=90&&sleep.minutes<=900){fields.bedtime=sleep.start;fields.wakeTime=sleep.end;evidence.bedtime='من وقت Sleep الظاهر';evidence.wakeTime='من وقت Sleep الظاهر';}
 // If RingConn shows no explicit 'Sleep 04:09–12:06' tab, use the
 // time-axis end ticks. Never select the central ticks as bed/wake times.
 if(!fields.bedtime&&sections.axis){
  const tickText=normalize(sections.axis);
  const ticks=[...tickText.matchAll(/\b([01]?\d|2[0-3])\s*:\s*([0-5]\d)\b/g)]
   .map(m=>`${String(Number(m[1])).padStart(2,'0')}:${m[2]}`);
  if(ticks.length>=2&&ticks.length<=5){
   const start=toMinutes(ticks[0]),end=toMinutes(ticks[ticks.length-1]);
   const elapsed=(end-start+1440)%1440,bedTime=toMinutes(fields.timeInBed);
   if(elapsed>=90&&elapsed<=900&&(bedTime===null||Math.abs(elapsed-bedTime)<=25)){
    fields.bedtime=ticks[0];fields.wakeTime=ticks[ticks.length-1];
    evidence.bedtime='أول علامة زمنية في محور النوم';evidence.wakeTime='آخر علامة زمنية في محور النوم';
   }
  }
 }
 const nap=matchNapInterval(sections.napHeader||wholeHeader)||matchNapInterval(wholeHeader);
 if(nap&&nap.minutes>0&&nap.minutes<=240){fields.nap=String(nap.minutes);evidence.nap=`من وقت Nap ${nap.start}–${nap.end}`;}
 // Stage percentages may reveal a dropped leading hour in OCR (e.g. 1hr 25min -> 25min).
 const stageKeys=['awake','rem','light','deep'];
 const percents=sections.anchoredStages?{}:Object.fromEntries(stageKeys.map(k=>[k,percentageFor(labels[k],stages)]).filter(([,v])=>v!==null));
 const times=Object.fromEntries(stageKeys.map(k=>[k,toMinutes(fields[k])]).filter(([,v])=>v!==null));
 const pctCount=Object.keys(percents).filter(k=>times[k]!==undefined).length;
 // Stage duration that contradicts its own percentage is almost always OCR
 // text bleeding over from another row. Blank it rather than silently guessing.
 // This also catches the reported 'Awake = 02:00' when RingConn says 3.2% / 15min.
 if(fields.timeInBed){
  const bedMinutes=toMinutes(fields.timeInBed);
  for(const key of stageKeys){
   if(times[key]===undefined||percents[key]===undefined||!bedMinutes)continue;
   // RingConn percentages are based on the sum of stages, not necessarily
   // all 'time in bed', so allow generous tolerance for detection only.
   const largestExpected=bedMinutes*(percents[key]/100)+18;
   if(times[key]>largestExpected+30){
    fields[key]='';delete times[key];
    evidence[key]='';
    warnings.push(`قراءة ${key} لا تتفق مع نسبة المرحلة؛ تركناها فارغة بدل حفظ مدة خاطئة.`);
   }
  }
 }
 if(pctCount>=3&&stageKeys.every(k=>times[k]!==undefined)){
  const measured=Object.fromEntries(stageKeys.filter(k=>percents[k]!==undefined).map(k=>[k,percents[k]]));
  const baseline=stagePercentMismatch(times,measured);
  if(baseline>1.2){
   const possibilities=stageKeys.flatMap(k=>{
    if(times[k]>=60)return [];
    const candidate={...times,[k]:times[k]+60};
    const mismatch=stagePercentMismatch(candidate,measured);
    return mismatch<=1.2?[{k,candidate,mismatch}]:[];
   });
   if(possibilities.length===1){
    const match=possibilities[0];
    fields[match.k]=minutesToHHMM(match.candidate[match.k]);
    evidence[match.k]='ساعة مستعادة من توافق نسب المراحل؛ راجع القيمة قبل الحفظ';
    warnings.push('تم اقتراح تصحيح ساعة مفقودة في قراءة إحدى المراحل بناءً على النسب الظاهرة؛ راجعها قبل الحفظ.');
   }else warnings.push('مدد المراحل لا تتوافق مع النسب الظاهرة؛ راجع القيم قبل الحفظ.');
  }
 }
 if(!fields.rem&&fields.awake&&fields.timeInBed&&toMinutes(fields.awake)>Math.max(75,toMinutes(fields.timeInBed)*0.22)){
  fields.awake='';evidence.awake='';
  warnings.push('مدة الاستيقاظ غير منطقية مع غياب REM؛ تركناها فارغة لمراجعتها.');
 }
 const values=['deep','light','rem'].map(k=>toMinutes(fields[k]));
 if(values.every(v=>v!==null)){
  const calculated=minutesToHHMM(values.reduce((a,b)=>a+b,0));
  if(!fields.duration){
   if(warnings.some(w=>w.includes('لا تتوافق مع النسب'))){warnings.push('لم نحسب إجمالي النوم تلقائيًا بسبب تعارض في قراءة المراحل.');}
   else {fields.duration=calculated;evidence.duration='محسوب من مجموع العميق والخفيف وREM';if(!Object.keys(percents).length)warnings.push('النوم الفعلي محسوب من المراحل دون نسب للتدقيق؛ تأكد أن OCR لم يسقط رقم ساعة.');}
  }else if(Math.abs(toMinutes(fields.duration)-toMinutes(calculated))>5)
   warnings.push(`إجمالي النوم ${fields.duration} لا يطابق مجموع المراحل ${calculated}؛ صحح القيم قبل الحفظ.`);
 }
 if(fields.timeInBed&&fields.duration&&toMinutes(fields.duration)>toMinutes(fields.timeInBed))warnings.push('النوم الفعلي أكبر من وقت السرير؛ راجع الأرقام.');
 if(fields.timeInBed&&fields.efficiency&&fields.duration){
  const implied=Math.round(100*toMinutes(fields.duration)/toMinutes(fields.timeInBed));
  if(Math.abs(implied-Number(fields.efficiency))>5)warnings.push('كفاءة النوم تختلف عن حساب المدد؛ راجع الأرقام.');
 }
 if(!['deep','light','rem'].every(k=>fields[k]))warnings.push('بعض مراحل النوم لم تُقرأ بوضوح؛ تركناها فارغة.');
 return {fields,evidence,warnings,rawText:Object.entries(sections).map(([k,v])=>`[${k}]\n${v}`).join('\n\n')};
}
