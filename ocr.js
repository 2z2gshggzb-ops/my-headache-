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
// RingConn OCR 1.8.11. Treat the four relevant regions independently.
// iPhone screenshots use light gray text against nearly black backgrounds.
// Making white OCR paper with dark glyphs improves recognition on that theme.
function legibleCrop(bitmap,rect,scale=2){
 const c=cropScaled(bitmap,rect,scale),ctx=c.getContext('2d',{willReadFrequently:true});
 const image=ctx.getImageData(0,0,c.width,c.height),a=image.data;
 let light=0,dark=0;
 for(let i=0;i<a.length;i+=4){const v=(a[i]*.21+a[i+1]*.72+a[i+2]*.07);if(v>160)light++;if(v<65)dark++}
 if(dark>light*.9){
  // Most RingConn screenshots are dark mode. Exclude red ink/highlights by
  // considering the green/blue channels rather than red brightness alone.
  for(let i=0;i<a.length;i+=4){
   const l=.25*a[i]+.5*a[i+1]+.25*a[i+2];
   const ink=Math.max(0,Math.min(255,(l-88)*3.0));
   a[i]=a[i+1]=a[i+2]=255-ink;a[i+3]=255;
  }
  ctx.putImageData(image,0,0);
 }
 return c;
}
function singleAxisClock(text){
 const clocks=[...new Set([...normalize(text).matchAll(/\b(?:[01]?\d|2[0-3])\s*:\s*[0-5]\d\b/g)].map(m=>m[0].replace(/\s/g,'').padStart(5,'0')))];
 return clocks.length===1?clocks[0]:'';
}
async function readRegion(worker,bitmap,rect,scale,better=true){
 const canvas=better?legibleCrop(bitmap,rect,scale):cropScaled(bitmap,rect,scale);
 return recognizeCanvas(worker,canvas);
}
// OCR fallback for a narrow, *single* row of Total Time Asleep.
// Alternate RingConn layouts move the main number vertically when Nap is shown.
// PSM 13 is single raw-line OCR, unlike the standard block-text mode.
async function readTightDurationRow(w,bitmap,rect){
 const crop=cropScaled(bitmap,rect,3);
 try{
  await w.setParameters({tessedit_pageseg_mode:'13'});
  return await recognizeCanvas(w,crop);
 }finally{
  await w.setParameters({tessedit_pageseg_mode:'6'});
 }
}
function cautiouslyNormalizeDurationOCR(s){
 // On some dark-mode screenshots OCR reads a bold 8 as the letter B.
 // This is only attempted for an isolated number row, never for arbitrary text.
 const t=normalize(s).replace(/\bB(?=\s*h(?:r|ours?)\b)/gi,'8')
   .replace(/(?<=\bh(?:r|ours?)\s*)B(?=\s*m(?:in)?\b)/gi,'8');
 const match=t.match(/\b(\d{1,2})\s*(?:h|hr|hrs|hours?)\s*(\d{1,2})\s*(?:m|min|mins|minutes?)\b/i);
 if(!match||+match[1]<1||+match[1]>16||+match[2]>=60)return '';
 return minutesToHHMM(+match[1]*60 + +match[2]);
}
// Read two narrow axis bands. Sleep Details appears higher when Nap is absent;
// selecting both clocks from the SAME band prevents unrelated clocks matching.
async function readAxisBand(w,bitmap,y){
 const l=await readRegion(w,bitmap,[.030,y,.240,.058],1.9,true);
 const r=await readRegion(w,bitmap,[.745,y,.240,.058],1.9,true);
 let left=singleAxisClock(l.text),right=singleAxisClock(r.text);
 if(!left||!right){
  const ll=!left?await readRegion(w,bitmap,[.030,y,.240,.058],1.55,false):l;
  const rr=!right?await readRegion(w,bitmap,[.745,y,.240,.058],1.55,false):r;
  left=left||singleAxisClock(ll.text);right=right||singleAxisClock(rr.text);
 }
 if(left&&right){
  const elapsed=(toMinutes(right)-toMinutes(left)+1440)%1440;
  if(elapsed>=90&&elapsed<=900)return {start:left,end:right};
 }
 return null;
}
export async function recognizeLocal(file,onProgress=()=>{}){
 const w=await ensureWorker(onProgress);let bitmap;
 try{
  bitmap=await createImageBitmap(file);
  if(bitmap.height<=bitmap.width*1.45){
   onProgress('قراءة الصورة…');const full=await recognizeCanvas(w,file);
   return {...full,sections:{full:full.text}};
  }
  onProgress('التعرف على تاريخ النوم…');
  const selected=await readRegion(w,bitmap,[.30,.075,.40,.105],2.15,false);
  onProgress('قراءة النوم الفعلي من أعلى الصورة…');
  const headerRect=[.015,.19,.65,.275];
  let header=await readRegion(w,bitmap,headerRect,1.8,true);
  let duration=readSleepDuration(header.text);
  if(!duration){
   const fallback=await readRegion(w,bitmap,headerRect,1.6,false);
   duration=readSleepDuration(fallback.text);
   header={...header,text:header.text+'\n'+fallback.text};
  }
  let tightDuration='',durationWarning='';
  if(!duration){
   onProgress('تجربة قراءة الرقم مباشرةً…');
   // The first layout has its duration at ~26% height, the other at ~34%.
   for(const rect of [[.045,.255,.25,.035],[.045,.334,.25,.045]]){
    const attempt=await readTightDurationRow(w,bitmap,rect);
    tightDuration=cautiouslyNormalizeDurationOCR(attempt.text);
    if(tightDuration){
     durationWarning='قراءة مدة النوم من سطر الأرقام مع تصحيح محتمل لحرف B/8؛ تحقق منها قبل الحفظ.';
     break;
    }
   }
  }
  onProgress('قراءة أوقات Sleep وNap…');
  const tabsRect=[.015,.405,.97,.27];
  let tabs=await readRegion(w,bitmap,tabsRect,1.8,true);
  if(!matchSleepInterval(tabs.text)||!matchNapInterval(tabs.text)){
   const other=await readRegion(w,bitmap,tabsRect,1.45,false);
   tabs={...tabs,text:tabs.text+'\n'+other.text};
  }
  let axisStart='',axisEnd='';
  if(!matchSleepInterval(tabs.text)){
   onProgress('قراءة أول وآخر ساعة أسفل الرسم…');
   // Two layouts: without Nap near 82%, with Nap near 89% of the image.
   for(const y of [.805,.865]){
    const band=await readAxisBand(w,bitmap,y);
    if(band){axisStart=band.start;axisEnd=band.end;break;}
   }
  }
  const sections={header:header.text,selectedDate:selected.text,tabs:tabs.text,
   axisStart,axisEnd,tightDuration,durationWarning};
  return {text:[selected.text,header.text,tabs.text,axisStart,axisEnd,tightDuration].join('\n'),
   confidence:Math.round((header.confidence+tabs.confidence)/2),sections};
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

// Accept only the value belonging to Total Time Asleep, NOT Time In Bed,
// Sleep Efficiency, the 8-hour goal, or the stage durations in the graph.
function readSleepDuration(text){
 const t=normalize(text).replace(/\r/g,'');
 const lines=t.split('\n').map(x=>x.trim()).filter(Boolean);
 const label=/\b(?:total\s*time\s*asleep|total\s*sleep|time\s*asleep|actual\s*sleep|sleep\s*duration)\b/i;
 const stop=/\b(?:time\s*in\s*bed|sleep\s*efficiency|sleep\s*details|awake|rem|light|deep)\b/i;
 let region='';
 for(let i=0;i<lines.length;i++){
  const m=label.exec(lines[i]);if(!m)continue;
  region=lines[i].slice(m.index+m[0].length);
  for(let j=i+1;j<Math.min(i+4,lines.length);j++){
   if(stop.test(lines[j]))break;
   region+=' '+lines[j];
  }
  break;
 }
 if(!region)return '';
 // The part after '/' is RingConn's TARGET (e.g. '/ 8hr'), not actual sleep.
 region=region.split('/')[0];
 // Prefer a pair of hours + minutes. The same line often contains '/ 8hr'
 // which is just the sleep target and MUST NOT replace actual sleep.
 const pair=region.match(/\b(\d{1,2})\s*(?:hours?|hrs?|hr|h)\s*(\d{1,2})\s*(?:minutes?|mins?|min|m)\b/i);
 if(pair){const dur=Number(pair[1])*60+Number(pair[2]);return dur>=60&&dur<=960&&Number(pair[2])<60?minutesToHHMM(dur):''}
 const first=region.match(/\b(\d{1,2})\s*(?:hours?|hrs?|hr|h)\b/i);
 if(first&&Number(first[1])>=1&&Number(first[1])<=16&&!/\b(?:\d+\s*(?:min|m))\b/i.test(region.slice(0,first.index)))return minutesToHHMM(Number(first[1])*60);
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
 duration:/\b(?:actual\s*sleep|total\s*time\s*asleep|total\s*sleep|sleep\s*duration|time\s*asleep)\b|النوم الفعلي|مدة النوم/i
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
 const s=normalize(text).replace(/\s+/g,' '),match=s.match(re);if(!match)return null;
 const one=Number(match[1])*60+Number(match[2]),two=Number(match[3])*60+Number(match[4]);
 if(Number(match[1])>23||Number(match[3])>23||Number(match[2])>59||Number(match[4])>59)return null;
 return {start:`${String(match[1]).padStart(2,'0')}:${match[2]}`,end:`${String(match[3]).padStart(2,'0')}:${match[4]}`,minutes:(two-one+1440)%1440};
}
function matchSleepInterval(s){
 // Only use times explicitly linked to the sleep tab; do not interpret graph ticks.
 return clockInterval(s,/\b(?:Sleep|S1eep|SIeep)\s*:?[ \t]*(\d{1,2})\s*[:.]\s*([0-5]\d)\s*[-–—~]+\s*(\d{1,2})\s*[:.]\s*([0-5]\d)/i);
}
function matchNapInterval(s){
 return clockInterval(s,/\bNap\s*:?[ \t]*(\d{1,2})\s*[:.]\s*([0-5]\d)\s*[-–—~]+\s*(\d{1,2})\s*[:.]\s*([0-5]\d)/i);
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
 const head=linesOf(sections.header||sections.full||'');
 const fields={sleepDate:'',duration:'',bedtime:'',wakeTime:'',napStart:'',napEnd:'',nap:''};
 const evidence={},warnings=[];
 fields.duration=readSleepDuration(sections.header||sections.full||'') || sections.tightDuration || '';
 if(sections.tightDuration && !readSleepDuration(sections.header||sections.full||''))warnings.push(sections.durationWarning||'مدة النوم مستخرجة من سطر الأرقام مباشرةً؛ تحقق منها قبل الحفظ.');
 if(fields.duration)evidence.duration='من خانة Total Time Asleep أعلى الصورة';
 else warnings.push('تعذر قراءة Total Time Asleep؛ أدخل مدة النوم يدويًا.');
 // Read the selected day only. Never take neighboring carousel dates.
 const selected=normalize(sections.selectedDate||'');
 if(/\bto\s*day\b/i.test(selected)){
  fields.sleepDate=asLocalISO(baseDate);
  evidence.sleepDate='Today في الصورة — تاريخ الجهاز الحالي؛ تأكد منه إن كانت الصورة قديمة';
  warnings.push('عند ظهور Today استخدمنا تاريخ الجهاز الحالي؛ راجع التاريخ إذا كانت الصورة قديمة.');
 }else{
  const detected=selectedDate(selected||sections.full||'',baseDate);
  if(detected){fields.sleepDate=detected.date;evidence.sleepDate=detected.yearInferred?'اليوم والشهر من الصورة، والسنة مقدرة':'من التاريخ المختار في الصورة';}
  else warnings.push('تعذر تحديد تاريخ الاستيقاظ؛ اختره يدويًا.');
 }
 const tabs=sections.tabs||sections.header||sections.full||'';
 const sleep=matchSleepInterval(tabs);
 if(sleep&&sleep.minutes>=90&&sleep.minutes<=900){
  fields.bedtime=sleep.start;fields.wakeTime=sleep.end;
  evidence.bedtime='من وقت Sleep المكتوب فوق الرسم';evidence.wakeTime='من وقت Sleep المكتوب فوق الرسم';
 }else{
  // Graph's first and last X-axis tick; never accept a middle tick.
  const l=singleAxisClock(sections.axisStart||sections.axisLeftText||'');
  const r=singleAxisClock(sections.axisEnd||sections.axisRightText||'');
  if(l&&r){
   const from=toMinutes(l),to=toMinutes(r),elapsed=(to-from+1440)%1440;
   if(elapsed>=90&&elapsed<=900){
    fields.bedtime=l;fields.wakeTime=r;
    evidence.bedtime='أول وقت أسفل الرسم';evidence.wakeTime='آخر وقت أسفل الرسم';
   }
  }
  // Direct plain-text OCR fallback: use an unambiguous axis of 3–5 ticks.
  if(!fields.bedtime&&sections.axis){
   const ticks=[...normalize(sections.axis).matchAll(/\b(?:[01]?\d|2[0-3])\s*:\s*[0-5]\d\b/g)].map(m=>m[0].replace(/\s/g,'').padStart(5,'0'));
   if(ticks.length>=3&&ticks.length<=5){
    const elapsed=(toMinutes(ticks.at(-1))-toMinutes(ticks[0])+1440)%1440;
    if(elapsed>=90&&elapsed<=900){fields.bedtime=ticks[0];fields.wakeTime=ticks.at(-1);evidence.bedtime='أول وقت في محور الرسم';evidence.wakeTime='آخر وقت في محور الرسم';}
   }
  }
 }
 if(!fields.bedtime||!fields.wakeTime)warnings.push('وقت بداية النوم أو نهايته غير واضح؛ راجعه يدويًا.');
 const nap=matchNapInterval(tabs);
 if(nap&&nap.minutes>0&&nap.minutes<=240){
  fields.napStart=nap.start;fields.napEnd=nap.end;fields.nap=String(nap.minutes);
  evidence.napStart='بداية الغفوة من خانة Nap';evidence.napEnd='نهاية الغفوة من خانة Nap';
 }
 if(fields.nap&&fields.duration)warnings.push('مدة Total Time Asleep من أعلى الشاشة قد تشمل الغفوة؛ حفظنا الغفوة منفصلة دون إضافتها إلى المجموع.');
 const rawText=Object.entries(sections).filter(([,v])=>typeof v==='string').map(([k,v])=>`[${k}]\n${v}`).join('\n\n');
 return {fields,evidence,warnings,rawText};
}
