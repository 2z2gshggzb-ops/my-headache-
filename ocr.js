/* RingConn screenshot reader — local OCR, v1.2.
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
async function recognizeCanvas(w,c){const data=await w.recognize(c);return {text:data?.data?.text||'',confidence:data?.data?.confidence||0}}
/** Recognize bounded regions to avoid plot gridlines distracting the text engine.
 * For unfamiliar layouts, fall back to whole-image recognition.
 */
export async function recognizeLocal(file,onProgress=()=>{}){
 const w=await ensureWorker(onProgress);
 let bitmap;
 try{
  bitmap=await createImageBitmap(file);
  const portrait=bitmap.height>bitmap.width*1.45;
  if(!portrait){onProgress('قراءة الصورة…');const full=await recognizeCanvas(w,file);return {...full,sections:{full:full.text}}}
  onProgress('قراءة التاريخ وملخص النوم…');
  const head=await recognizeCanvas(w,canvasCrop(bitmap,[0,.075,1,.315]));
  onProgress('قراءة كفاءة النوم…');
  const efficiency=await recognizeCanvas(w,canvasCrop(bitmap,[.45,.12,.55,.135]));
  onProgress('قراءة تاريخ اليوم المحدد…');
  const selected=await recognizeCanvas(w,canvasCrop(bitmap,[.30,.10,.40,.085]));
  onProgress('قراءة مراحل النوم…');
  const stages=await recognizeCanvas(w,canvasCrop(bitmap,[0,.645,1,.33]));
  let combined=[head.text,selected.text,efficiency.text,stages.text].filter(Boolean).join('\n');
  const phaseCount=(combined.match(/\b(?:awake|rem|light\s*sleep|deep\s*sleep)\b/gi)||[]).length;
  if(phaseCount<2){
   onProgress('محاولة احتياطية لقراءة كامل الصورة…');
   const all=await recognizeCanvas(w,file);
   combined+='\n'+all.text;
   return {text:combined,confidence:Math.round((head.confidence+stages.confidence+all.confidence)/3),sections:{header:head.text,selectedDate:selected.text,efficiency:efficiency.text,stages:stages.text,full:all.text}};
  }
  return {text:combined,confidence:Math.round((head.confidence+stages.confidence)/2),sections:{header:head.text,selectedDate:selected.text,efficiency:efficiency.text,stages:stages.text}};
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
 for(const key of ['deep','light','rem','awake']){
  fields[key]=nearby(key,labels[key],stages);
  if(fields[key])evidence[key]='تم ربطه باسم المرحلة';
 }
 fields.timeInBed=nearby('timeInBed',labels.timeInBed,head);
 if(fields.timeInBed)evidence.timeInBed='مقروء من Time in Bed';
 fields.duration=nearby('duration',labels.duration,head);
 if(fields.duration)evidence.duration='مقروء مباشرة';
 fields.efficiency=nearbyEfficiency(linesOf(sections.efficiency||''))||nearbyEfficiency(head);
 if(fields.efficiency)evidence.efficiency='مقروء من Sleep Efficiency';
 const detected=selectedDate(sections.selectedDate||'',baseDate)
    ||selectedDate((sections.header||'').split(/\bTime\s*in\s*Bed\b/i)[0],baseDate);
 if(detected){fields.sleepDate=detected.date;evidence.sleepDate=detected.yearInferred?'الشهر واليوم مقروءان؛ السنة مقدرة':'التاريخ مقروء'}
 else warnings.push('لم نتمكن من قراءة التاريخ المحدد؛ اختره قبل الحفظ.');
 const wholeHeader=sections.header||sections.full||'';
 const sleep=matchSleepInterval(wholeHeader);
 if(sleep&&sleep.minutes>=90&&sleep.minutes<=900){fields.bedtime=sleep.start;fields.wakeTime=sleep.end;evidence.bedtime='من وقت Sleep الظاهر';evidence.wakeTime='من وقت Sleep الظاهر';}
 const nap=matchNapInterval(wholeHeader);
 if(nap&&nap.minutes>0&&nap.minutes<=240){fields.nap=String(nap.minutes);evidence.nap=`من وقت Nap ${nap.start}–${nap.end}`;}
 // Stage percentages may reveal a dropped leading hour in OCR (e.g. 1hr 25min -> 25min).
 const stageKeys=['awake','rem','light','deep'];
 const percents=Object.fromEntries(stageKeys.map(k=>[k,percentageFor(labels[k],stages)]).filter(([,v])=>v!==null));
 const times=Object.fromEntries(stageKeys.map(k=>[k,toMinutes(fields[k])]).filter(([,v])=>v!==null));
 const pctCount=Object.keys(percents).filter(k=>times[k]!==undefined).length;
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
 const values=['deep','light','rem'].map(k=>toMinutes(fields[k]));
 if(values.every(v=>v!==null)){
  const calculated=minutesToHHMM(values.reduce((a,b)=>a+b,0));
  if(!fields.duration){
   if(warnings.some(w=>w.includes('لا تتوافق مع النسب'))){warnings.push('لم نحسب إجمالي النوم تلقائيًا بسبب تعارض في قراءة المراحل.');}
   else {fields.duration=calculated;evidence.duration='محسوب من مجموع العميق والخفيف وREM';if(!Object.keys(percents).length)warnings.push('النوم الفعلي محسوب من المراحل دون نسب للتدقيق؛ تأكد أن OCR لم يسقط رقم ساعة.');}
  }else if(Math.abs(toMinutes(fields.duration)-toMinutes(calculated))>5)
   warnings.push(`إجمالي النوم ${fields.duration} لا يطابق مجموع المراحل ${calculated}؛ صحح القيم قبل الحفظ.`);
 }
 if(!fields.efficiency&&fields.timeInBed&&fields.duration){
  const total=toMinutes(fields.timeInBed),sleepMinutes=toMinutes(fields.duration);
  if(total>0&&sleepMinutes<=total){
   fields.efficiency=String(Math.round(100*sleepMinutes/total));
   evidence.efficiency='تقدير محسوب من النوم الفعلي ÷ وقت السرير، وليس قراءة مباشرة؛ راجع القيمة';
   warnings.push('كفاءة النوم تقديرية لأنها لم تُقرأ بوضوح من الصورة.');
  }
 }
 if(fields.timeInBed&&fields.duration&&toMinutes(fields.duration)>toMinutes(fields.timeInBed))warnings.push('النوم الفعلي أكبر من وقت السرير؛ راجع الأرقام.');
 if(fields.timeInBed&&fields.efficiency&&fields.duration){
  const implied=Math.round(100*toMinutes(fields.duration)/toMinutes(fields.timeInBed));
  if(Math.abs(implied-Number(fields.efficiency))>5)warnings.push('كفاءة النوم تختلف عن حساب المدد؛ راجع الأرقام.');
 }
 if(!['deep','light','rem'].every(k=>fields[k]))warnings.push('بعض مراحل النوم لم تُقرأ بوضوح؛ تركناها فارغة.');
 return {fields,evidence,warnings,rawText:Object.entries(sections).map(([k,v])=>`[${k}]\n${v}`).join('\n\n')};
}
