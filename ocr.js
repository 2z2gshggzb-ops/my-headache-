/* Optional in-browser OCR: Tesseract.js runs its OCR engine on-device.
   Engine dependencies are fetched on first use from CDN; images are NOT uploaded.
   The rest of the PWA continues to work offline if OCR is not installed. */
const CDN='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let ocrWorker=null;
function addScript(src){return new Promise((resolve,reject)=>{if(window.Tesseract){resolve();return}const s=document.createElement('script');s.src=src;s.crossOrigin='anonymous';s.onload=resolve;s.onerror=()=>reject(new Error('تعذر تحميل محرك التعرف. يتطلب الإنترنت أول مرة.'));document.head.appendChild(s)})}
export async function recognizeLocal(file,onProgress=()=>{}){
 if(!ocrWorker){onProgress('جاري تهيئة قراءة الصورة على الجهاز…');await addScript(CDN);
 if(!window.Tesseract?.createWorker)throw new Error('محرك التعرف غير متاح');
 ocrWorker=await window.Tesseract.createWorker('eng',1,{logger:m=>{if(m.status==='recognizing text')onProgress(`قراءة الصورة ${Math.round((m.progress||0)*100)}%`);else if(m.status)onProgress(m.status)}});
 }
 const url=URL.createObjectURL(file);
 try{const {data}=await ocrWorker.recognize(url);return {text:data.text||'',confidence:data.confidence||0}}
 finally{URL.revokeObjectURL(url)}
}
export function parseSleepOCR(original){
 const text=String(original||'').replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[：]/g,':').replace(/[–—]/g,'-');
 const lines=text.split(/\n/).map(s=>s.trim()).filter(Boolean);
 const normalized=text.toLowerCase();
 function dur(s){if(!s)return '';s=s.toLowerCase();let m=s.match(/(\d{1,2})\s*[:h]\s*(\d{1,2})\b/);if(m&&+m[2]<60)return `${m[1].padStart(2,'0')}:${m[2].padStart(2,'0')}`;m=s.match(/(\d{1,2})\s*(?:h|hr|hour|ساعة|ساعات)\s*(\d{1,2})?\s*(?:m|min|دقيقة)?/);if(m)return `${m[1].padStart(2,'0')}:${String(m[2]||0).padStart(2,'0')}`;m=s.match(/(\d{1,3})\s*(?:min|m|دقيقة)/);if(m)return `${String(Math.floor(+m[1]/60)).padStart(2,'0')}:${String(+m[1]%60).padStart(2,'0')}`;return ''}
 const extract=(patterns)=>{for(const reg of patterns){for(let i=0;i<lines.length;i++){if(reg.test(lines[i].toLowerCase())){let same=lines[i].replace(reg,'');let x=dur(same);if(x)return x;for(let j=i+1;j<Math.min(i+3,lines.length);j++){x=dur(lines[j]);if(x)return x}}}}return ''};
 const fields={duration:extract([/total sleep|sleep duration|time asleep|actual sleep|sleep time|إجمالي النوم|مدة النوم|النوم الفعلي|sleep score/]),deep:extract([/deep sleep|deep\b|نوم عميق|العميق/]),light:extract([/light sleep|light\b|نوم خفيف|الخفيف/]),rem:extract([/rem sleep|\brem\b|حركة العين السريعة/]),awake:extract([/awake|wake time|وقت الاستيقاظ|مستيقظ/])};
 const ef=normalized.match(/(?:efficiency|كفاءة النوم)\s*[:\-]?\s*(\d{2,3})\s*%?/);
 if(ef)fields.efficiency=ef[1];
 const times=[...text.matchAll(/\b(\d{1,2}):([0-5]\d)\s*(am|pm)?\b/gi)].map(m=>m[0]);
 // Do not guess bedtime/wake time from unrelated screenshot labels.
 return {fields,rawText:text,lines,times};
}
