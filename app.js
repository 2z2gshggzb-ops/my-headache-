import * as store from './storage.js';
import {recognizeLocal,parseSleepOCR} from './ocr.js';
const $=s=>document.querySelector(s);
const E=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>globalThis.crypto?.randomUUID?.()||`r_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const now=()=>new Date(), iso=d=>new Date(d).toISOString();
function localDate(d){d=new Date(d);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function asDateTime(d){d=new Date(d);return `${localDate(d)}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`}
function fmtTime(d){return new Date(d).toLocaleTimeString('ar-SA',{hour:'numeric',minute:'2-digit'})}
function fmtDay(d){return new Date(d+'T12:00:00').toLocaleDateString('ar-SA',{weekday:'long',day:'numeric',month:'long',year:'numeric',calendar:'gregory'})}
function fmtShort(d){return new Date(d+'T12:00:00').toLocaleDateString('ar-SA',{day:'numeric',month:'short',calendar:'gregory'})}
function duration(s){if(!s)return NaN;const m=String(s).match(/^(\d{1,2}):(\d{1,2})$/);return m?+m[1]*60+(+m[2]):NaN}
function clockValid(x){if(!x)return true;const m=String(x).match(/^([01]?\d|2[0-3]):([0-5]\d)$/);return Boolean(m)}
function clockInput(x){const m=String(x||'').match(/^([01]?\d|2[0-3]):([0-5]\d)$/);return m?m[1].padStart(2,'0')+':'+m[2]:''}
function napMinutes(start,end){if(!start&&!end)return null;if(!clockValid(start)||!clockValid(end)||!start||!end)return NaN;const a=start.split(':').map(Number),b=end.split(':').map(Number),min=((b[0]*60+b[1])-(a[0]*60+a[1])+1440)%1440;return min>0&&min<=240?min:NaN}
const fmtDuration=m=>Number.isFinite(m)?`${Math.floor(m/60)}:${String(Math.round(m%60)).padStart(2,'0')}`:'—';
const dayStart=d=>new Date(d+'T00:00:00').getTime();
const icons={water:'◉',coffee:'♨',food:'▤',sleep:'☾',med:'✚',headache:'◌',clear:'✓',note:'✎',botox:'✣'};
const types={water:'ماء',coffee:'قهوة أو مشروب',food:'وجبة',sleep:'نوم',med:'دواء',headache:'أعراض الرأس',clear:'يوم بدون أعراض',note:'ملاحظة',botox:'علاج وقائي'};
const spots={A:'بين الحاجبين',BR:'الحاجب الأيمن',BL:'الحاجب الأيسر',C:'أعلى منتصف الرأس',F:'منتصف الجبهة',O:'مكان آخر'};
const kinds={heavy:'ثقل خفيف',headache:'صداع',migraine:'شقيقة',unknown:'غير محدد'};
const app={lastWaterTap:{ml:0,time:0},lastQuickTap:{kind:'',time:0},records:[],tab:'today',date:localDate(now()),month:localDate(now()).slice(0,7),period:30,periodOffset:0,customStart:'',customEnd:'',analysisMode:'headache_only',severityView:'fit',botoxTrendScope:'12m',settings:{theme:'system',waterCup:200,waterBottle:330,lastBackup:null,excludeIncompleteDays:true},previewImage:null,editing:null,undo:null,filter:'all',search:'',toastTimer:null,ocrRunning:false};
const view=$('#view'),layer=$('#modal-layer');
function theme(){const t=app.settings.theme;document.documentElement.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;$('#theme-btn').textContent=document.documentElement.dataset.theme==='dark'?'☼':'☾'}
function recordDate(r){return r.type==='sleep'?(r.sleepDate||localDate(r.at)):localDate(r.at)}
function atDate(d,h='12:00'){return new Date(`${d}T${h}:00`).toISOString()}
function sorted(items){return [...items].sort((a,b)=>new Date(b.at)-new Date(a.at))}
function recordsDay(d){return sorted(app.records.filter(r=>recordDate(r)===d))}
function dateRecords(type){return app.records.filter(r=>r.type===type)}
function latestHeadache(){return sorted(dateRecords('headache'))[0]||null}
// A recorded 0% explicitly closes the current pain period; it must not silently
// keep the episode open for the following 24 hours.
function lastHeadAt(from=now()){return sorted(dateRecords('headache').filter(x=>new Date(x.at)<=new Date(from)))[0]||null}
function activeEpisode(from=now()){const h=lastHeadAt(from);return h&&Number(h.severity)>0&&(new Date(from)-new Date(h.at))<24*3600000?h.episodeId:null}
function recentResolution(from=now()){const h=lastHeadAt(from);return h&&Number(h.severity)===0&&(new Date(from)-new Date(h.at))>=0&&(new Date(from)-new Date(h.at))<24*3600000?h:null}
function nextHeadLink(at,severity){if(Number(severity)===0)return {episodeId:activeEpisode(at)||uid()};const active=activeEpisode(at);if(active)return {episodeId:active};const resolved=recentResolution(at);return resolved?{episodeId:uid(),relatedEpisodeId:resolved.episodeId,relation:'possible_return_24h'}:{episodeId:uid()}}
function valuesDay(d){const r=recordsDay(d),water=r.filter(x=>x.type==='water'&&x.kind!=='other').reduce((n,x)=>n+(+x.ml||0),0),coffee=r.filter(x=>x.type==='coffee'),heads=r.filter(x=>x.type==='headache'),sleep=r.find(x=>x.type==='sleep'),current=sorted(heads)[0];return {water,coffee,heads,sleep,current,records:r}}
function toast(msg,withUndo=false){const t=$('#toast');t.innerHTML=E(msg)+(withUndo?'<button id="toast-undo">تراجع</button>':'');t.hidden=false;clearTimeout(app.toastTimer);if(withUndo)$('#toast-undo').onclick=undo;app.toastTimer=setTimeout(()=>t.hidden=true,4500)}
async function persist(r,show=true){if(r.type==='headache'){const d=localDate(r.at);for(const x of app.records.filter(x=>x.type==='clear'&&recordDate(x)===d)){await store.remove(x.id);app.records=app.records.filter(y=>y.id!==x.id)}}const old=app.records.find(x=>x.id===r.id);app.undo={kind:old?'update':'add',previous:old||null,current:r};r.updatedAt=iso(now());try{await store.put(r);const i=app.records.findIndex(x=>x.id===r.id);if(i>=0)app.records[i]=r;else app.records.push(r);$('#save-status').textContent='✓ محفوظ';render();if(show)toast(old?'تم تحديث التسجيل':'تم الحفظ محليًا',true);return r}catch(e){toast('تعذّر الحفظ: '+e.message);throw e}}
async function erase(id){const r=app.records.find(x=>x.id===id);if(!r)return;await store.remove(id);app.records=app.records.filter(x=>x.id!==id);app.undo={kind:'delete',previous:r};closeModal();render();toast('تم حذف التسجيل',true)}
async function undo(){const u=app.undo;if(!u)return;app.undo=null;if(u.kind==='add'){await store.remove(u.current.id);app.records=app.records.filter(x=>x.id!==u.current.id)}else if(u.kind==='delete'){await store.put(u.previous);app.records.push(u.previous)}else if(u.kind==='batch'){for(const row of u.previous){await store.put(row);app.records=app.records.map(x=>x.id===row.id?row:x)}}else{await store.put(u.previous);app.records=app.records.map(x=>x.id===u.previous.id?u.previous:x)}render();toast('تم التراجع')}
function openModal(title,html,onReady=()=>{}){document.querySelector('.modal-header-time')?.remove();$('#modal-title').textContent=title;$('#modal-body').innerHTML=html;layer.hidden=false;document.body.style.overflow='hidden';onReady()}
function closeModal(){layer.hidden=true;document.body.style.overflow=''}
function formField(label,name,type='text',value='',extra=''){return `<div class="field"><label for="f-${E(name)}">${E(label)}</label><input id="f-${E(name)}" name="${E(name)}" type="${E(type)}" value="${E(value)}" ${extra}></div>`}
function selField(label,name,opts,value){return `<div class="field"><label for="f-${E(name)}">${E(label)}</label><select id="f-${E(name)}" name="${E(name)}">${opts.map(([v,t])=>`<option value="${E(v)}" ${String(value)===String(v)?'selected':''}>${E(t)}</option>`).join('')}</select></div>`}
function textareaField(label,name,value){return `<div class="field"><label for="f-${E(name)}">${E(label)}</label><textarea id="f-${E(name)}" name="${E(name)}">${E(value)}</textarea></div>`}
function getForm(form){return Object.fromEntries(new FormData(form).entries())}
function rTime(r){return asDateTime(r?.at||(app.entryDate?atDate(app.entryDate,'12:00'):now()))}
function intV(v){return Number.isFinite(+v)?+v:0}
function modalButtons(edit){return `<div class="btn-row"><button class="btn" type="submit">${edit?'حفظ التعديل':'حفظ'}</button><button class="btn ghost" type="button" data-close="modal">إلغاء</button></div>${edit?`<button class="btn danger small" style="margin-top:14px" type="button" data-delete="${E(edit.id)}">حذف التسجيل</button>`:''}`}
// Simple food tags, intentionally broad rather than a diagnostic trigger list.
const FOOD_TAGS=['دجاج','لحم','سمك','جبنة','شوكولاتة','شبس','مكسرات','بيض','رز','خبز','معكرونة','مقليات','وجبة سريعة','أطعمة حارة','مخللات','لحوم مصنّعة','ألبان','حمضيات','حلويات','تمر'];
const foodParts=name=>String(name||'').split(/[،,|]+/).map(s=>s.trim()).filter(Boolean);
const allFoodTags=()=>[...new Set([...FOOD_TAGS,...(Array.isArray(app.settings.customFoodTags)?app.settings.customFoodTags:[])])];
const activeFoodTags=()=>Array.isArray(app.settings.foodTags)?app.settings.foodTags:FOOD_TAGS;
const foodTagCounts=()=>{const tags=activeFoodTags(),counts=new Map(tags.map(t=>[t,0]));for(const r of app.records.filter(x=>x.type==='food')){const found=foodParts(r.name);for(const tag of tags)if(found.some(x=>x===tag||x.includes(tag)))counts.set(tag,counts.get(tag)+1)}return counts};
const foodIsSnack=meal=>meal==='snack'; // legacy breakfast/lunch/dinner/other are meals.
function choiceField(label,name,options,value){return `<div class="field"><label>${E(label)}</label><div class="two-choice" role="group" aria-label="${E(label)}">${options.map(([v,t])=>`<button type="button" class="choice-btn ${String(value)===String(v)?'active':''}" data-choice="${E(name)}" data-value="${E(v)}" aria-pressed="${String(value)===String(v)}">${E(t)}</button>`).join('')}</div><input type="hidden" name="${E(name)}" id="f-${E(name)}" value="${E(value)}"></div>`}
function wireChoices(form){form.addEventListener('click',e=>{const b=e.target.closest('[data-choice]');if(!b||!form.contains(b))return;const key=b.dataset.choice,field=form.querySelector(`[name="${key}"]`);if(!field)return;field.value=b.dataset.value;form.querySelectorAll(`[data-choice="${key}"]`).forEach(x=>{const selected=x===b;x.classList.toggle('active',selected);x.setAttribute('aria-pressed',String(selected))});if(key==='headGroup'){const t=form.querySelector('#migraine-option');if(t)t.hidden=field.value==='heavy'}})}
function headerEventTime(formId,value){
 const head=document.querySelector('.modal-head');
 if(!head)return;
 head.querySelector('.modal-header-time')?.remove();
 const label=document.createElement('label');label.className='modal-header-time';label.title='وقت الحدث';
 label.innerHTML=`<span class="sr-only">وقت الحدث</span><input aria-label="وقت الحدث" name="at" id="f-at" type="datetime-local" form="${formId}" value="${E(value)}" required>`;
 head.insertBefore(label,head.querySelector('[data-close]'));
}
function selectableClock(name,title,value='',optional=false){
 const parts=clockInput(value).split(':'),hh=parts.length===2?parts[0]:'',mm=parts.length===2?parts[1]:'00';
 const hours=(optional?'<option value="">—</option>':'')+Array.from({length:24},(_,i)=>{const v=String(i).padStart(2,'0');return `<option value="${v}" ${hh===v?'selected':''}>${v}</option>`}).join('');
 const minutes=Array.from({length:60},(_,i)=>{const v=String(i).padStart(2,'0');return `<option value="${v}" ${mm===v?'selected':''}>${v}</option>`}).join('');
 return `<div class="time-wheel"><strong>${E(title)}</strong><div class="time-wheel-select" dir="ltr"><select name="${name}H" aria-label="ساعة ${E(title)}" ${optional?'':'required'}>${hours}</select><span>:</span><select name="${name}M" aria-label="دقيقة ${E(title)}">${minutes}</select></div></div>`;
}
function clockFromWheels(v,name){const h=v[name+'H'],m=v[name+'M'];return h===''?'':`${h}:${m}`}
function elapsedClockMinutes(start,end,maxMinutes=24*60){const a=clockMinutes(start),b=clockMinutes(end);if(a===null||b===null)return null;const gap=(b-a+1440)%1440;return gap>0&&gap<=maxMinutes?gap:null}
function minsDuration(min){return `${String(Math.floor(min/60)).padStart(2,'0')}:${String(min%60).padStart(2,'0')}`}
function hoursForInput(value){const m=duration(value);return Number.isFinite(m)?String(Math.round(m/60*100)/100):''}
function hoursToDuration(value){const hrs=Number(value);if(!Number.isFinite(hrs)||hrs<=0||hrs>24)return null;const m=Math.round(hrs*60);return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`}
function manualEntry(type,edit=null){
 const r=edit||{},base=`${formField('وقت الحدث','at','datetime-local',rTime(r))}`,notes=textareaField('ملاحظة (اختياري)','notes',r.notes||'');let html='';
 if(type==='water')html=`${formField('الكمية بالمل','ml','number',r.ml||app.settings.waterCup,'min="1" step="1"')}${base}${notes}`;
 else if(type==='coffee')html=`${selField('النوع','name',['V60','قهوة سعودية','أمريكانو','إسبريسو','لاتيه','شاي','مشروب طاقة','عصير','مشروب آخر'].map(x=>[x,x]),r.name||'V60')}${formField('الحجم (مل) — اختياري','ml','number',r.ml||'', 'min="0"')}${formField('الكافيين (mg) — اختياري','caffeine','number',r.caffeine||'', 'min="0"')}${base}${selField('دقة وقت المشروب','timePrecision',[['confirmed','الوقت مؤكد'],['approximate','الوقت تقريبي']],r.timeApprox===true?'approximate':'confirmed')}${notes}`;
 else if(type==='food'){
  const parts=foodParts(r.name),tags=activeFoodTags(),selected=new Set(parts.filter(s=>tags.includes(s))),other=parts.filter(s=>!tags.includes(s)).join('، ');
  const counts=foodTagCounts(),sortedTags=[...tags].sort((a,b)=>((counts.get(b)||0)-(counts.get(a)||0))||(tags.indexOf(a)-tags.indexOf(b)));
  html=`${choiceField('نوع الأكل','meal',[['meal','وجبة'],['snack','سناك']],foodIsSnack(r.meal)?'snack':'meal')}<div class="field"><label>إيش أكلت؟ اختر أكثر من صنف</label><div class="food-tag-grid">${sortedTags.map(tag=>`<button type="button" class="food-tag ${selected.has(tag)?'active':''}" data-food-tag="${E(tag)}" aria-pressed="${selected.has(tag)}">${E(tag)}</button>`).join('')}</div><p class="mini">الأكثر تكرارًا يظهر أولًا. هذه أصناف للتسجيل والمقارنة، وليست محفزات مثبتة.</p></div>${formField('صنف آخر (اختياري)','name','text',other,'placeholder="مثلاً: صوص أو صنف غير موجود"')}<details class="entry-more"><summary>خيارات إضافية</summary>${selField('دقة وقت الأكل','timePrecision',[['confirmed','الوقت مؤكد'],['approximate','الوقت تقريبي']],r.timeApprox===true?'approximate':'confirmed')}${notes}</details>`;
 }
 else if(type==='med')html=`${formField('اسم الدواء','name','text',r.name||'Ubrelvy', 'required')}${formField('الجرعة','dose','text',(r.dose!==undefined?r.dose:(r.name==='Panadol Migraine'?'':'100 mg')))}${base}${notes}`;
 else if(type==='sleep')html=`<div class="sleep-day-row"><label for="f-sleepDate">تاريخ الاستيقاظ</label><input id="f-sleepDate" name="sleepDate" type="date" value="${E(r.sleepDate||app.entryDate||localDate(now()))}" required></div><div class="sleep-clock-grid">${selectableClock('bed','نمت',r.bedtime||'23:00')}${selectableClock('wake','صحيت',r.wakeTime||'07:00')}</div><div id="sleep-duration-preview" class="sleep-preview" aria-live="polite"></div><details class="entry-more nap-details" ${r.napStart||r.napEnd?'open':''}><summary>☾ إضافة غفوة (اختياري)</summary><div class="sleep-clock-grid">${selectableClock('napStart','نمت',r.napStart||'',true)}${selectableClock('napEnd','صحيت',r.napEnd||'',true)}</div><div id="nap-duration-preview" class="mini"></div></details>`;
 else if(type==='note')html=`${textareaField('الملاحظة','notes',r.notes||'')}${base}`;
 else if(type==='botox')html=`${formField('اسم العلاج الوقائي','name','text',r.name||'Botox')}${formField('الجرعة (اختياري)','dose','text',r.dose||'')}${base}${notes}`;
 else if(type==='headache')return headModal(edit);
 else return;
 openModal(edit?'تعديل '+types[type]:'إضافة '+types[type],`<form id="entry-form" data-entry="${E(type)}">${html}${modalButtons(edit)}</form>`);
 if(type==='food')headerEventTime('entry-form',rTime(r));
 const form=$('#entry-form');app.entryDate=null;wireChoices(form);
 const selectedFood=new Set(type==='food'?foodParts(r.name).filter(s=>activeFoodTags().includes(s)):[]);
 if(type==='food')form.addEventListener('click',e=>{const b=e.target.closest('[data-food-tag]');if(!b)return;const tag=b.dataset.foodTag;selectedFood.has(tag)?selectedFood.delete(tag):selectedFood.add(tag);b.classList.toggle('active',selectedFood.has(tag));b.setAttribute('aria-pressed',String(selectedFood.has(tag)))});
 if(type==='sleep'){
  const preview=()=>{const v=getForm(form),a=clockFromWheels(v,'bed'),b=clockFromWheels(v,'wake');const m=elapsedClockMinutes(a,b);$('#sleep-duration-preview').textContent=m===null?'اختر وقتين مختلفين للنوم والاستيقاظ':`مدة النوم: ${minsDuration(m)} (ساعة:دقيقة)`;
   const n1=clockFromWheels(v,'napStart'),n2=clockFromWheels(v,'napEnd'),n=elapsedClockMinutes(n1,n2,240);
   $('#nap-duration-preview').textContent=!n1&&!n2?'':n===null?'حدد بداية ونهاية الغفوة (بحد أقصى 4 ساعات)':`مدة الغفوة: ${minsDuration(n)} (ساعة:دقيقة)`;};
  form.addEventListener('change',preview);preview();
 }

 form.addEventListener('submit',async e=>{e.preventDefault();const v=getForm(form);
 if(type==='sleep'){
  v.bedtime=clockFromWheels(v,'bed');v.wakeTime=clockFromWheels(v,'wake');
  const total=elapsedClockMinutes(v.bedtime,v.wakeTime);if(total===null){toast('اختر وقت بداية النوم ونهايته؛ يجب أن يكونا مختلفين');return}
  v.duration=minsDuration(total);
  v.napStart=clockFromWheels(v,'napStart');v.napEnd=clockFromWheels(v,'napEnd');
  for(const k of ['bedH','bedM','wakeH','wakeM','napStartH','napStartM','napEndH','napEndM'])delete v[k];
 }
 if(type==='food'){const extras=foodParts(v.name);v.name=[...new Set([...selectedFood,...extras])].join('، ');if(!v.name.trim()){toast('اختر أو اكتب صنف أكل واحدًا على الأقل');return}}
 if(type==='sleep'){
  if(Boolean(v.napStart)!==Boolean(v.napEnd)){toast('حدد بداية الغفوة ونهايتها معًا');return}
  const nm=v.napStart?elapsedClockMinutes(v.napStart,v.napEnd,240):null;
  if(v.napStart&&nm===null){toast('مدة الغفوة يجب أن تكون من دقيقة إلى 4 ساعات');return}
  v.nap=nm===null?(!r.napStart&&!r.napEnd&&r.nap?r.nap:''):String(nm);v.timeApprox=false;
 }const newR={...r,...v,type,at:type==='sleep'?atDate(v.sleepDate,'09:00'):iso(new Date(v.at)),id:r.id||uid()};if(['food','coffee','sleep'].includes(type)){newR.timeApprox=v.timePrecision==='approximate';delete newR.timePrecision;}if(type==='med'&&!r.id)newR.episodeId=activeEpisode(new Date(newR.at));if(type==='sleep'){newR.sleepDate=v.sleepDate;newR.source=r.source||'self-report';delete newR.atField;if(!r.id){const previous=app.records.find(x=>x.type==='sleep'&&x.sleepDate===v.sleepDate);if(previous){if(!confirm('يوجد تسجيل نوم لهذا اليوم. هل تريد تحديثه بدل إضافة تسجيل مكرر؟'))return;newR.id=previous.id}}}if(type==='water')newR.ml=+v.ml;if(type==='coffee'){newR.ml=v.ml===''?'':+v.ml;newR.caffeine=v.caffeine===''?'':+v.caffeine}await persist(newR);closeModal()});
}
function zonesSVG(selected){const c=id=>selected.includes(id)?'var(--accent)':'var(--muted)';const o=id=>selected.includes(id)?'.38':'.10';const point=(id,x,y,rad,label)=>`<g data-zone="${id}" class="head-point" style="cursor:pointer"><circle cx="${x}" cy="${y}" r="${rad}" fill="${c(id)}" fill-opacity="${o(id)}" stroke="${c(id)}" stroke-width="2"/><text x="${x}" y="${y+4}" font-size="12" text-anchor="middle" fill="currentColor">${label}</text></g>`;return `<div class="head-map"><svg viewBox="0 0 320 182" role="img" aria-label="رسم الرأس من الأمام والأعلى"><ellipse cx="84" cy="87" rx="55" ry="76" fill="none" stroke="currentColor" opacity=".35"/><path d="M42 94 Q56 83 71 94 M96 94 Q110 83 125 94 M81 101 L75 118 L88 118 M67 138 Q84 148 102 138" fill="none" stroke="currentColor" opacity=".33" stroke-width="2"/><ellipse cx="237" cy="86" rx="58" ry="69" fill="none" stroke="currentColor" opacity=".35"/><path d="M237 19 V154 M179 86 H295" stroke="currentColor" opacity=".16" stroke-dasharray="5 4"/>${point('A',84,111,11,'A')}${point('BR',59,86,12,'B')}${point('BL',108,86,12,'B')}${point('F',84,58,16,'F')}${point('C',237,86,23,'C')}${point('O',285,136,10,'O')}<text x="84" y="179" text-anchor="middle" font-size="11" fill="currentColor">من الأمام</text><text x="237" y="168" text-anchor="middle" font-size="11" fill="currentColor">من الأعلى</text></svg></div>`}
function headModal(edit=null){
 const r=edit||{},isHeavy=r.kind==='heavy',selectedKind=isHeavy?'heavy':'headache';
 const chosen=new Set(Number(r.severity)===0?[]:(r.spots||['C']));
 const html=`<form id="head-form">${choiceField('نوع الحالة','headGroup',[['headache','صداع / شقيقة'],['heavy','ثقل خفيف']],selectedKind)}
 <div id="migraine-option" ${isHeavy?'hidden':''}><label class="migraine-toggle"><input type="checkbox" id="f-migraine" ${(!edit||r.kind==='migraine')?'checked':''}> هذه النوبة شقيقة</label></div>
 <div class="field severity-field"><div class="severity-label"><label for="f-severity">شدة الصداع</label><strong id="severity-out">${r.severity??20}%</strong></div>
 <input id="f-severity" class="severity-large" name="severity" type="range" min="0" max="100" value="${r.severity??20}" step="1" aria-label="الشدة من صفر إلى مئة"><div class="severity-ticks"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div><div class="severity-steppers"><button type="button" data-sev-step="-1" aria-label="إنقاص الشدة واحد">−</button><span aria-hidden="true">اضغط مطوّلًا</span><button type="button" data-sev-step="1" aria-label="زيادة الشدة واحد">+</button></div></div>
 <p id="zero-tip" class="info" hidden>✅ انتهى الصداع: لا تحتاج تحديد مكان للألم عند تسجيل 0%.</p>
 <div id="location-wrap"><label class="mini">اضغط على المكان في رسمة الرأس (يمكن اختيار أكثر من موضع)</label><div id="map-content"></div></div>
 <details class="entry-more"><summary>ملاحظات إضافية (اختياري)</summary>${notesField(r)}</details>${modalButtons(edit)}</form>`;
 openModal(edit?'تعديل قراءة الصداع':'تسجيل الصداع',html);headerEventTime('head-form',rTime(r));app.entryDate=null;
 const map=()=>{$('#map-content').innerHTML=zonesSVG([...chosen])};map();
 const updateZeroView=()=>{const value=Number($('#f-severity').value),zero=value===0;$('#severity-out').textContent=value+'%';$('#location-wrap').hidden=zero;$('#zero-tip').hidden=!zero;if(zero){chosen.clear();map()}};updateZeroView();
 wireChoices($('#head-form'));
 $('#head-form').addEventListener('click',e=>{
  const pt=e.target.closest('[data-zone]');if(pt){const id=pt.dataset.zone;chosen.has(id)?chosen.delete(id):chosen.add(id);map();return}
  const step=e.target.closest('[data-sev-step]');if(step&&e.detail===0){stepSeverity(Number(step.dataset.sevStep))}
 });
 let sevTimer=null,sevRepeater=null;
 const stopSeverity=()=>{clearTimeout(sevTimer);clearInterval(sevRepeater);sevTimer=null;sevRepeater=null};
 const stepSeverity=delta=>{const slider=$('#f-severity');slider.value=Math.max(0,Math.min(100,Number(slider.value)+delta));updateZeroView()};
 $('#head-form').querySelectorAll('[data-sev-step]').forEach(btn=>{
  btn.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();stopSeverity();const step=Number(btn.dataset.sevStep);stepSeverity(step);try{btn.setPointerCapture(e.pointerId)}catch(_){}sevTimer=setTimeout(()=>{sevRepeater=setInterval(()=>stepSeverity(step),65)},370)});
  for(const event of ['pointerup','pointercancel','lostpointercapture','pointerleave','blur'])btn.addEventListener(event,stopSeverity);
  btn.addEventListener('contextmenu',e=>e.preventDefault());
 });
 $('#f-severity').oninput=updateZeroView;
 $('#head-form').onsubmit=async e=>{e.preventDefault();const v=getForm(e.target);if(+v.severity>0&&!chosen.size){toast('حدد مكان الألم في الرسمة');return}
 const at=iso(new Date(v.at)),kind=v.headGroup==='heavy'?'heavy':($('#f-migraine').checked?'migraine':'headache');const link=r.id?{episodeId:r.episodeId}:nextHeadLink(new Date(at),+v.severity);
 const newR={...r,...link,type:'headache',id:r.id||uid(),at,kind,severity:+v.severity,spots:+v.severity===0?[]:[...chosen],primary:+v.severity===0?'':(chosen.has(r.primary)?r.primary:[...chosen][0]),notes:v.notes||'',episodeId:link.episodeId||r.episodeId};await persist(newR);closeModal();};
}
function baseTime(r){return formField('وقت القياس','at','datetime-local',rTime(r))}
function notesField(r){return textareaField('ملاحظات اختيارية','notes',r.notes||'')}
function quickWater(ml){const t=Date.now();if(app.lastWaterTap.ml===ml&&t-app.lastWaterTap.time<550)return;app.lastWaterTap={ml,time:t};persist({id:uid(),type:'water',at:iso(now()),ml,notes:''})}
function duplicateQuick(kind){const t=Date.now();if(app.lastQuickTap.kind===kind&&t-app.lastQuickTap.time<800)return true;app.lastQuickTap={kind,time:t};return false}
function quickCoffee(){
 if(duplicateQuick('coffee'))return;
 // Recorded now; users can edit type, volume, caffeine and timestamp in History.
 persist({id:uid(),type:'coffee',at:iso(now()),name:'لاتيه',ml:'',caffeine:'',notes:'',timeApprox:false});
}
function chooseQuickMed(){
 openModal('تسجيل دواء الآن',`<p class="info">اختر الدواء الذي تناولته بالفعل. سيتم حفظ وقت اختيارك تلقائيًا، ويمكن تغيير الجرعة أو الوقت لاحقًا من السجل.</p><div class="quick-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))"><button class="quick-btn" data-quick-med="ubrelvy"><span class="q-ic">✚</span><span>Ubrelvy</span><small>100 mg</small></button><button class="quick-btn" data-quick-med="panadol"><span class="q-ic">✚</span><span>Panadol Migraine</span><small>الجرعة غير محددة</small></button></div><p class="mini">التسجيل للتوثيق فقط؛ ليس توصية بتناول أي جرعة.</p>`);
}
function saveQuickMed(kind){
 const names={ubrelvy:{name:'Ubrelvy',dose:'100 mg'},panadol:{name:'Panadol Migraine',dose:''}};
 if(!names[kind]||duplicateQuick('med:'+kind))return;
 const t=now(),r={id:uid(),type:'med',at:iso(t),name:names[kind].name,dose:names[kind].dose,notes:'',episodeId:activeEpisode(t)};
 closeModal();persist(r);
}

function summary(r){switch(r.type){case 'water':return `ماء — ${r.ml} مل`;case 'coffee':return `${r.name||'مشروب'}${r.ml?' — '+r.ml+' مل':''}`;case 'food':return r.name||'وجبة';case 'med':return `${r.name||'دواء'}${r.dose?' '+r.dose:''}`;case 'sleep':return `نوم ${r.duration||'—'}${r.source==='ringconn'?' — RingConn':''}${r.napStart&&r.napEnd?' · غفوة '+r.napStart+'–'+r.napEnd:''}`;case 'headache':return Number(r.severity)===0?'انتهى الصداع — 0%':`${kinds[r.kind]||'أعراض الرأس'} ${r.severity}% — ${(r.spots||[]).map(s=>s==='O'?'أخرى':s).join(' + ')}`;case 'clear':return 'يوم بدون أعراض (مؤكد)';case 'note':return r.notes||'ملاحظة';case 'botox':return `${r.name||'علاج وقائي'} ${r.dose||''}`;default:return r.type}}
function detail(r){if(r.type==='sleep')return `تاريخ الاستيقاظ ${r.sleepDate}`;if(r.type==='headache'&&r.episodeId)return `${fmtTime(r.at)} · ${Number(r.severity)===0?'انتهى الألم':(r.relation==='possible_return_24h'?'عودة محتملة (نوبة مستقلة)':kinds[r.kind])}`;return fmtTime(r.at)}
function eventRow(r){return `<button class="list-row" data-open="${E(r.id)}"><span class="row-icon">${icons[r.type]||'•'}</span><span class="row-body"><strong>${E(summary(r))}</strong><small>${E(detail(r))}</small></span><span class="row-arrow">‹</span></button>`}
function dayCards(d,showMaximum=false){const v=valuesDay(d),maxHead=showMaximum&&v.heads.length?[...v.heads].filter(x=>Number.isFinite(Number(x.severity))).sort((a,b)=>Number(b.severity)-Number(a.severity))[0]:null,h=showMaximum?(maxHead||null):v.current;return `<div class="cards"><div class="stat"><span class="stat-name"><span class="symbol">◌</span>أعراض الرأس</span><b>${h?h.severity+'%':'—'}</b><span class="hint">${h?(showMaximum?'أعلى شدة خلال اليوم':(Number(h.severity)===0?'انتهى الألم':E(kinds[h.kind]||'آخر قياس'))):'لا توجد قراءة اليوم'}</span></div><div class="stat"><span class="stat-name"><span class="symbol">◉</span>الماء</span><b>${v.water.toLocaleString('en-US')}</b><span class="hint">مل مسجل اليوم</span></div><div class="stat"><span class="stat-name"><span class="symbol">☾</span>النوم</span><b>${E(v.sleep?.duration||'—')}</b><span class="hint">النوم الفعلي</span></div><div class="stat"><span class="stat-name"><span class="symbol">♨</span>القهوة والمشروبات</span><b>${v.coffee.length}</b><span class="hint">مرات مسجلة</span></div></div>`}
function renderToday(){const d=localDate(now()),v=valuesDay(d);return `<div class="view-title"><div><h1>يومي</h1><span class="sub">${E(fmtDay(d))}</span></div><span class="pill">محلي وخاص</span></div>${dayCards(d)}<div class="section-title"><strong>إضافة سريعة</strong></div><div class="quick-grid"><button class="quick-btn" data-quick="cup"><span class="q-ic">◉</span><span>كاسة</span></button><button class="quick-btn" data-quick="bottle"><span class="q-ic">◉</span><span>قارورة</span></button><button class="quick-btn" data-quick="headache"><span class="q-ic">◌</span><span>صداع</span></button><button class="quick-btn" data-quick="coffee"><span class="q-ic">♨</span><span>قهوة</span></button><button class="quick-btn" data-quick="food"><span class="q-ic">▤</span><span>أكل</span></button><button class="quick-btn" data-quick="sleep"><span class="q-ic">☾</span><span>نوم</span></button></div><div class="section-title"><strong>آخر الأحداث</strong><button class="btn ghost small" data-go="history">السجل ‹</button></div>${v.records.length?v.records.slice(0,7).map(eventRow).join(''):'<div class="empty">ما فيه تسجيلات لليوم بعد. ابدأ بكاسة ماء أو سجل أي ملاحظة.</div>'}<div class="section-title"><strong>خيارات إضافية</strong></div><div class="btn-row"><button class="btn secondary small" data-quick="med">✚ تسجيل الدواء</button><button class="btn secondary small" data-quick="clear">✓ يوم بدون أعراض</button><button class="btn ghost small" data-quick="note">✎ ملاحظة</button></div>`}
function moveMonth(delta){const [y,m]=app.month.split('-').map(Number);const d=new Date(y,m-1+delta,1);app.month=localDate(d).slice(0,7);app.date=`${app.month}-01`;render()}
function calendar(){const [y,m]=app.month.split('-').map(Number),first=new Date(y,m-1,1).getDay(),length=new Date(y,m,0).getDate(),prefix=first,suffix=(7-(prefix+length)%7)%7,rows=[];for(let i=0;i<prefix;i++)rows.push('<span></span>');for(let i=1;i<=length;i++){const date=`${app.month}-${String(i).padStart(2,'0')}`,has=app.records.some(r=>recordDate(r)===date),sel=app.date===date;rows.push(`<button data-date="${date}" class="${sel?'selected':''} ${has?'has':''}">${i}</button>`)}for(let i=0;i<suffix;i++)rows.push('<span></span>');return `<div class="panel"><div class="calendar-header"><button class="btn ghost small" data-month="-1">›</button><strong>${new Date(y,m-1,14).toLocaleDateString('ar-SA',{month:'long',year:'numeric',calendar:'gregory'})}</strong><button class="btn ghost small" data-month="1">‹</button></div><div class="cal">${['أحد','إثن','ثلا','أرب','خمي','جمع','سبت'].map(x=>`<span class="dow">${x}</span>`).join('')}${rows.join('')}</div></div>`}
function renderHistory(){const records=recordsDay(app.date).filter(r=>(app.filter==='all'||r.type===app.filter)&&(!app.search||summary(r).toLowerCase().includes(app.search.toLowerCase())||(r.notes||'').toLowerCase().includes(app.search.toLowerCase())));return `<div class="view-title"><div><h1>السجل</h1><span class="sub">التقويم والأحداث والتعديل</span></div></div>${calendar()}${dayCards(app.date,true)}<div class="field"><label>بحث في تسجيلات اليوم</label><input id="search-field" type="search" value="${E(app.search)}" placeholder="Ubrelvy أو V60 أو كلمة في الملاحظات"></div><div class="segmented" id="history-filters">${[['all','الكل'],['headache','الرأس'],['water','الماء'],['med','الأدوية'],['sleep','النوم'],['food','الطعام']].map(([k,v])=>`<button data-filter="${k}" class="${app.filter===k?'active':''}">${v}</button>`).join('')}</div><div class="section-title"><strong>${E(fmtDay(app.date))}</strong><button class="btn secondary small" data-add-at-date="${app.date}">+ إضافة</button></div>${records.length?records.map(eventRow).join(''):'<div class="empty">لا توجد نتائج مطابقة في هذا اليوم.</div>'}`}
// A calendar period uses all dates; historic-year and all-data views include only
// recorded dates so a 2024/2026 gap cannot create invented zero-headache days.
function shiftLocalDate(day,delta){const d=new Date(day+'T12:00:00');d.setDate(d.getDate()+delta);return localDate(d)}
function previousCompleteDay(){return shiftLocalDate(localDate(now()),-1)}
function fixedPeriod(n){return typeof n==='number'||/^\d+$/.test(String(n))}
function periodDateRange(n=app.period){
 const yesterday=previousCompleteDay();
 if(n==='custom'){
  const start=app.customStart||shiftLocalDate(yesterday,-29),end=app.customEnd||yesterday;
  const count=Math.max(1,Math.round((dayStart(end)-dayStart(start))/86400000)+1);
  const offset=app.periodOffset*count;
  return {start:shiftLocalDate(start,-offset),end:shiftLocalDate(end,-offset)};
 }
 if(n==='botox'){
  const all=app.records.filter(r=>r.type==='botox'||(r.type==='med'&&/botox|بوتوكس/i.test(r.name||''))).map(recordDate).filter(d=>d<=yesterday).sort();
  return {start:all.at(-1)||shiftLocalDate(yesterday,-29),end:yesterday};
 }
 if(fixedPeriod(n)){
  const count=Number(n)||30,offset=String(n)===String(app.period)?app.periodOffset:0,end=shiftLocalDate(yesterday,-offset*count);
  return {start:shiftLocalDate(end,1-count),end};
 }
 if(/^year-\d{4}$/.test(String(n)))return {start:n.slice(5)+'-01-01',end:((n.slice(5)+'-12-31')<yesterday?(n.slice(5)+'-12-31'):yesterday)};
 if(n==='all'){const dates=app.records.map(recordDate).filter(d=>d<=yesterday).sort();return {start:dates[0]||yesterday,end:yesterday}}
 return {start:shiftLocalDate(yesterday,-29),end:yesterday};
}
function lastNDates(n){
 const yesterday=previousCompleteDay(),{start,end}=periodDateRange(n);
 if(n==='all'||/^year-\d{4}$/.test(String(n)))return [...new Set(app.records.map(recordDate).filter(d=>d>=start&&d<=end&&d<=yesterday))].sort((a,b)=>b.localeCompare(a));
 if(!/^\d{4}-\d\d-\d\d$/.test(start)||!/^\d{4}-\d\d-\d\d$/.test(end)||start>end)return [];
 const result=[],cur=new Date(start+'T12:00:00'),last=new Date((end<yesterday?end:yesterday)+'T12:00:00');
 for(let i=0;cur<=last&&i<1462;i++,cur.setDate(cur.getDate()+1))result.push(localDate(cur));
 return result.reverse();
}
function getAnalytics(){
 const windowDays=lastNDates(app.period),recorded=new Set(app.records.map(recordDate)),days=app.settings.excludeIncompleteDays!==false?windowDays.filter(d=>recorded.has(d)):windowDays,r=app.records.filter(x=>days.includes(recordDate(x)));
 const heads=r.filter(x=>x.type==='headache'),positiveHeads=heads.filter(x=>Number.isFinite(Number(x.severity))&&Number(x.severity)>0);
 const numericDays=new Set(positiveHeads.map(x=>recordDate(x)));
 const describedDays=new Set(r.filter(documentedHeadNote).map(x=>recordDate(x)));
 const symptomDays=new Set([...numericDays,...describedDays]);
 const headacheDays=new Set([...positiveHeads.filter(x=>x.kind==='headache'||x.kind==='migraine').map(x=>recordDate(x)),...describedDays]);
 const migraineEpisodes=new Set(positiveHeads.filter(x=>x.kind==='migraine').map(x=>x.episodeId));
 const medDays=new Set(r.filter(x=>x.type==='med').map(x=>recordDate(x)));
 const clearDays=new Set(r.filter(x=>x.type==='clear').map(x=>recordDate(x)));
 const waterDays=days.map(day=>({day,sum:r.filter(x=>x.type==='water'&&recordDate(x)===day&&x.kind!=='other').reduce((n,x)=>n+(+x.ml||0),0)})).filter(x=>x.sum>0);
 const sleep=r.filter(x=>x.type==='sleep'&&Number.isFinite(duration(x.duration)));
 const daily=days.slice().reverse().map(day=>{
  const h=positiveHeads.filter(x=>recordDate(x)===day),status=dayHeadStatus(day);
  // A day may have several readings. Colour by its most specific recorded
  // clinical label, while the column still shows the day's MAXIMUM intensity.
  // Migraine wins over headache; descriptive headache wins over heavy/unknown.
  const kind=h.some(x=>x.kind==='migraine')?'migraine':
   h.some(x=>x.kind==='headache')||describedDays.has(day)?'headache':
   h.some(x=>x.kind==='heavy')?'heavy':h.length?'unknown':'clear';
  return {day,kind,maximum:h.length?Math.max(...h.map(x=>+x.severity||0)):(describedDays.has(day)?null:((day<localDate(now())&&['confirmed_clear','inferred_clear'].includes(status))?0:null)),described:describedDays.has(day)};
 });
 return {r,heads,symptomDays,headacheDays,migraineEpisodes,medDays,clearDays,waterDays,sleep,daily,days};
}
// Headache severity history: fixed 0–100% scale and explicit per-day dates.
function chartSvg(daily){
 const visible=daily;
 const labels=[100,75,50,25,0].map(x=>`<span>${x}%</span>`).join('');
 const kindLabels={migraine:'شقيقة',headache:'صداع',heavy:'ثقل',unknown:'غير محدد'};
 const countMigraine=visible.filter(x=>x.kind==='migraine').length;
 const countHeadache=visible.filter(x=>x.kind==='headache').length;
 const countOther=visible.filter(x=>x.kind==='heavy').length;
 const countUnknown=visible.filter(x=>x.kind==='unknown').length;
 const found=visible.filter(x=>x.kind==='migraine'||x.kind==='headache');
 const dayBars=visible.map(row=>{
   const d=row.day.split('-'),date=`${Number(d[2])}/${Number(d[1])}`;
   const valid=row.maximum!==null;
   const severity=valid?Math.max(0,Math.min(100,Number(row.maximum)||0)):null;
   const kindLabel=kindLabels[row.kind]||'';
   const content=valid?(severity===0?'<span class="severity-zero" aria-hidden="true"></span>':`<span class="severity-column" style="height:${severity}%" aria-hidden="true"></span>`):row.described?'<span class="severity-described">•</span>':'<span class="severity-missing">—</span>';
   const reading=valid?`${severity}%`:row.described?'صداع موثق وصفياً، بلا نسبة':'لا توجد قراءة';
   const label=kindLabel?`${kindLabel} — أعلى شدة ${reading}`:reading;
   const tag=kindLabel?`<span class="severity-kind-label" aria-hidden="true">${E(kindLabel)}</span>`:'<span class="severity-kind-placeholder" aria-hidden="true"></span>';
   return `<button type="button" class="severity-day kind-${row.kind}" data-chart-day="${row.day}" title="${E(date)}: ${E(label)}" aria-label="${E(date)} — ${E(label)}"><span class="severity-track">${content}${valid&&severity>0?`<span class="severity-point" style="bottom:calc(${severity}% + 3px)">${severity}%</span>`:''}</span><span class="severity-date" dir="ltr">${date}</span>${tag}</button>`;
 }).join('');
 const legend=`<div class="severity-legend" aria-label="دليل ألوان أنواع أعراض الرأس"><span><i class="sev-swatch kind-migraine" aria-hidden="true"></i>شقيقة (${countMigraine})</span><span><i class="sev-swatch kind-headache" aria-hidden="true"></i>صداع (${countHeadache})</span><span><i class="sev-swatch kind-heavy" aria-hidden="true"></i>ثقل (${countOther})</span>${countUnknown?`<span><i class="sev-swatch kind-unknown" aria-hidden="true"></i>غير محدد (${countUnknown})</span>`:''}</div>`;
 const chips=found.length?`<div class="severity-jump"><span>أيام الصداع والشقيقة (${found.length}):</span>${found.map(row=>{const d=row.day.split('-');return `<button type="button" data-chart-jump="${row.day}" class="severity-jump-date kind-${row.kind}" aria-label="اذهب إلى ${kindLabels[row.kind]} يوم ${Number(d[2])}/${Number(d[1])}">${Number(d[2])}/${Number(d[1])}</button>`}).join('')}</div>`:'<p class="mini">ما فيه أيام صداع أو شقيقة مصنفة ضمن الفترة المختارة.</p>';
 const fit=app.severityView==='fit',short=visible.length<=9;
 const range=visible.length?`${E(fmtShort(visible[0].day))} — ${E(fmtShort(visible[visible.length-1].day))}`:'لا توجد أيام';
 const switcher=`<div class="severity-view-toolbar"><div class="severity-view-switch" role="group" aria-label="طريقة عرض شدة الصداع"><button type="button" data-severity-view="fit" class="${fit?'active':''}" aria-pressed="${fit}">Fit · الفترة كاملة</button><button type="button" data-severity-view="normal" class="${!fit?'active':''}" aria-pressed="${!fit}">عادي · تمرير</button></div><span class="severity-view-range">${range}</span></div>`;
 return `${legend}${switcher}<div class="severity-layout ${fit?'is-fit':''} ${short?'is-short':''}"><div class="severity-y">${labels}</div><div class="severity-scroll" dir="ltr"><div class="severity-plot" style="--days:${visible.length||1}">${dayBars}</div></div></div>${chips}<p class="mini">لون العمود يوضح نوع الحالة المسجلة في ذلك اليوم، وارتفاعه يوضح أعلى شدة من كل القراءات. إذا سُجلت شقيقة وصداع في اليوم نفسه يظهر بلون الشقيقة ويُحسب اليوم مرة واحدة. اضغط التاريخ أو العمود للتفاصيل. في Fit تظهر كل الفترة، وللقراءة اليومية التفصيلية استخدم «عادي · تمرير».</p>`;
}
// User-defined symptom diary convention: 150 minutes after each dose, no logged
// improvement = "no response recorded" (not a clinical determination).
const MED_WINDOW=150*60*1000;
// Keep the earlier 24-hour lookback to find the baseline headache reading.
// This does NOT extend the window for post-dose response.
const MED_BASELINE_WINDOW=24*60*60*1000;
function normalizedDrugName(x){return String(x||'دواء غير محدد').trim().replace(/\s+/g,' ').toLocaleLowerCase();}
function medicationResponseRows(a,atTime=Date.now()){
 const doses=[...a.r.filter(r=>r.type==='med')].sort((a,b)=>new Date(a.at)-new Date(b.at));
 const headaches=app.records.filter(r=>r.type==='headache'&&Number.isFinite(Number(r.severity)))
   .sort((a,b)=>new Date(a.at)-new Date(b.at));
 return doses.map(m=>{
  const doseTime=new Date(m.at).getTime(),validTime=Number.isFinite(doseTime);
  const next=doses.find(other=>other!==m&&new Date(other.at)>doseTime&&(m.episodeId&&other.episodeId===m.episodeId));
  const end=Math.min(doseTime+MED_WINDOW,next?new Date(next.at).getTime():Infinity);
  const related=h=>m.episodeId?Boolean(h.episodeId&&h.episodeId===m.episodeId):
    Boolean(!h.episodeId&&Math.abs(new Date(h.at).getTime()-doseTime)<=MED_BASELINE_WINDOW);
  const before=headaches.filter(h=>related(h)&&new Date(h.at).getTime()<=doseTime&&new Date(h.at).getTime()>=doseTime-MED_BASELINE_WINDOW);
  const baseline=before.length?Number(before[before.length-1].severity):null;
  const after=headaches.filter(h=>related(h)&&new Date(h.at).getTime()>doseTime&&new Date(h.at).getTime()<=end);
  const fully=after.find(h=>Number(h.severity)===0);
  // Explicitly documented partial relief in a medication note counts as a
  // recorded improvement even when the old diary lacks numeric follow-up.
  // Avoid vague phrases and explicit negation to limit false positives.
  const medNotes=String(m.notes||'');
  const documentedRelief=/(?:تحسن(?:اً)? مؤقت(?:اً)?|التحسن كان مؤقت|تحسن جزئي|خف(?:ّ)? (?:الصداع|الألم) بعد)/.test(medNotes)&&!/(?:لم يتحسن|لم يخف|ما تحسن|بدون تحسن|لم يكن فعال)/.test(medNotes);
  const partially=documentedRelief||(baseline!==null&&baseline>0&&after.some(h=>Number(h.severity)>0&&Number(h.severity)<baseline));
  let outcome=null,minutes=null;
  if(validTime&&doseTime+MED_WINDOW<=atTime){
   outcome=fully?'full':partially?'partial':'none';
   if(fully)minutes=Math.round((new Date(fully.at).getTime()-doseTime)/60000);
  }
  return {m,outcome,minutes,baseline,after:after.length};
 });
}
function medicationResponseHtml(a){
 const all=medicationResponseRows(a);
 if(!all.length)return `<div class="panel medicine-panel"><h3>✚ الاستجابة لأدوية الصداع</h3><p class="mini">ما فيه جرعات مسجلة في هذه الفترة.</p></div>`;
 const map=new Map();
 for(const row of all){const key=normalizedDrugName(row.m.name);if(!map.has(key))map.set(key,{name:row.m.name||'دواء غير محدد',rows:[]});map.get(key).rows.push(row);}
 const groups=[...map.values()].sort((a,b)=>b.rows.length-a.rows.length);
 const legend='<div class="med-legend"><span><i class="med-dot med-full"></i>اختفاء كامل</span><span><i class="med-dot med-partial"></i>تحسن جزئي</span><span><i class="med-dot med-none"></i>بدون استجابة مسجّلة</span></div>';
 const cards=groups.map(g=>{
  const eligible=g.rows.filter(r=>r.outcome),pending=g.rows.length-eligible.length;
  const counts={full:eligible.filter(r=>r.outcome==='full').length,partial:eligible.filter(r=>r.outcome==='partial').length,none:eligible.filter(r=>r.outcome==='none').length};
  const n=eligible.length,pct=n?Math.round(100*counts.full/n):null;
  const times=eligible.filter(r=>r.outcome==='full'&&r.minutes!==null).map(r=>r.minutes);
  const avg=times.length?fmtDuration(Math.round(times.reduce((x,y)=>x+y,0)/times.length)):'—';
  const bar=n?`<div class="med-stacked-chart" role="img" aria-label="${E(g.name)}: ${counts.full} اختفاء كامل، ${counts.partial} تحسن جزئي، ${counts.none} بدون استجابة مسجلة">${[['full','med-full'],['partial','med-partial'],['none','med-none']].map(([key,cls])=>counts[key]?`<span class="${cls}" style="width:${counts[key]*100/n}%" title="${key}: ${counts[key]}"></span>`:'').join('')}</div>`:'<div class="med-stacked-empty">لا توجد جرعة مضى عليها ساعتان ونصف</div>';
  const entries=g.rows.slice().reverse().map(r=>{
    const category=r.outcome==='full'?'اختفاء كامل':r.outcome==='partial'?'تحسن جزئي':r.outcome==='none'?'بدون استجابة مسجّلة':'بانتظار مرور ساعتين ونصف';
    const className=r.outcome?`med-text-${r.outcome}`:'med-pending';
    return `<div class="med-dose-entry"><span>${E(fmtShort(recordDate(r.m)))} · ${E(fmtTime(r.m.at))}</span><b class="${className}">${category}${r.minutes!==null?' · '+E(fmtDuration(r.minutes)):''}</b></div>`;
   }).join('');
  return `<div class="medicine-row"><div class="med-head"><strong>${E(g.name)}</strong><small>${n} جرعات قابلة للتقييم${pending?' · '+pending+' جرعة حديثة':''}</small></div>${bar}<div class="med-stat-grid"><span class="med-text-full">${counts.full} اختفاء كامل</span><span class="med-text-partial">${counts.partial} جزئي</span><span class="med-text-none">${counts.none} بدون استجابة</span></div><p class="mini">الاختفاء الكامل: <b>${pct===null?'—':pct+'%'}</b> من الجرعات المكتملة · متوسط وقت الاختفاء: ${avg}</p><details class="med-dose-details"><summary>تفاصيل الجرعات</summary>${entries}</details></div>`;
 }).join('');
 return `<div class="panel medicine-panel"><h3>✚ الاستجابة لأدوية الصداع</h3><p class="mini">الرسم يقارن كل دواء حسب تسجيلات الشدة بعد الجرعة. نعتمد الاختفاء الكامل 0%، أو انخفاضًا مسجّلًا في الشدة، أو تحسنًا جزئيًا موثّقًا في الملاحظات. إذا مرّت ساعتان ونصف ولم تُسجّل استجابة، تُصنّف «بدون استجابة مسجّلة» حسب طريقتك، وليس كدليل طبي مؤكد. الجرعات التي لم تكمل ساعتين ونصف لا تدخل النسب بعد.</p>${legend}${cards}<p class="mini">التصنيف لا يثبت أن الدواء وحده تسبب في التحسن؛ النتيجة تعتمد على وقت الجرعة ودقة سجل الأعراض.</p></div>`;
}
function medicationSummary(a){const meds=sorted(a.r.filter(x=>x.type==='med'));if(!meds.length)return '<p class="info">لا توجد جرعات مسجلة ضمن الفترة.</p>';const names=[...new Set(meds.map(x=>x.name||'دواء غير محدد'))];return names.map(name=>{const group=meds.filter(x=>(x.name||'دواء غير محدد')===name),results=group.map(m=>{if(!m.episodeId)return null;const zero=sorted(app.records.filter(h=>h.type==='headache'&&h.episodeId===m.episodeId&&h.severity===0&&new Date(h.at)>=new Date(m.at)&&new Date(h.at)-new Date(m.at)<=86400000)).reverse()[0];return zero?Math.round((new Date(zero.at)-new Date(m.at))/60000):null}).filter(x=>x!==null),avg=results.length?fmtDuration(Math.round(results.reduce((n,x)=>n+x,0)/results.length)):null;return `<div class="kv"><div><strong>${E(name)}</strong><small style="display:block">${group.length} جرعات مسجلة · ${results.length} حالات وصلت إلى 0% بعد الجرعة</small></div><strong>${avg||'—'}</strong></div>`}).join('')+'<p class="mini">الوقت محسوب من الجرعة إلى أول قراءة صفر مسجلة، ولا يثبت سببية الدواء.</p>'}
function preventiveSummary(a){const preventive=sorted(a.r.filter(x=>x.type==='botox'));if(!preventive.length)return '<p class="info">لم تُسجَّل جلسات وقائية في هذه الفترة. يمكنك إضافتها من صفحة «يومي».</p>';return preventive.slice(0,7).map(x=>`<div class="kv"><div><strong>${E(x.name||'علاج وقائي')}</strong><small style="display:block">${E(fmtShort(recordDate(x)))}</small></div><span class="mini">${E(x.dose||'جرعة غير مسجلة')}</span></div>`).join('')+'<p class="mini">مقارنة النتائج بين الدورات الوقائية تتطلب متابعة أيام كافية وبيانات مكتملة.</p>'}

// Historic entries sometimes document a headache in prose without a numeric
// measurement. Recognize only explicit episode-onset/continuation descriptions,
// not generic notes mentioning headaches or preventive therapy.
function documentedHeadNote(r){return r.type==='note'&&
 /^(بداية صداع|استمرار صداع|صداع بدأ|صداع مستمر)/.test(String(r.notes||'').trim());}
function dayHasNumericSymptoms(day){return recordsDay(day).some(r=>r.type==='headache'&&Number.isFinite(Number(r.severity))&&Number(r.severity)>0)}
function dayHasDescriptiveHead(day){return recordsDay(day).some(documentedHeadNote)}
function dayHeadStatus(day){
 const today=localDate(now()),group=recordsDay(day);
 if(dayHasNumericSymptoms(day)||dayHasDescriptiveHead(day))return 'headache';
 if(group.some(r=>r.type==='clear'))return 'confirmed_clear';
 // Diary convention selected by the user: once a calendar day is complete,
 // no positive headache entry means a symptom-free day, even with no other
 // routine entries. Do not manufacture headache records or water amounts.
 if(day>=today)return 'unknown';
 return 'inferred_clear';
}
// --- v1.6: conservative, explainable routine analyses; no model or network dependency. ---
const analyticsDefaults={sleepHours:7,waterMl:1500,timingMinutes:60,routineDeviation:90,wakeTolerance:45};
function analysisConfig(){return {...analyticsDefaults,...(app.settings.analytics||{})}}
function isCoffee(r){return r.type==='coffee'&&/قهو|coffee|v60|أمريكانو|اسبرسو|إسبريسو|لاتيه|كابتشينو|cappuccino|espresso/i.test(r.name||'')}
function accurateAt(r){return r?.at&&!r.timeApprox&&!r.aggregate&&r.timeExact!==false}
function clockMinutes(str){if(!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(str||'')))return null;const [h,m]=str.split(':').map(Number);return h*60+m}
function clockDelta(a,b){return ((a-b+720+1440)%1440)-720}
function clockMedian(arr){if(!arr.length)return null;return arr.reduce((best,x)=>{const score=arr.reduce((s,y)=>s+Math.abs(clockDelta(y,x)),0);return !best||score<best.score?{score,minute:x}:best},null).minute}
function routineBaseline(day){
 const end=dayStart(day),first=end-14*86400000;
 const prior=app.records.filter(x=>x.type==='sleep'&&x.sleepDate&&dayStart(x.sleepDate)>=first&&dayStart(x.sleepDate)<end&&!x.timeApprox);
 const selected=new Map();for(const r of prior.sort((a,b)=>new Date(b.updatedAt||b.at)-new Date(a.updatedAt||a.at)))if(!selected.has(r.sleepDate)&&clockMinutes(r.bedtime)!==null&&clockMinutes(r.wakeTime)!==null)selected.set(r.sleepDate,r);
 const rows=[...selected.values()];if(rows.length<7)return null;
 return {bed:clockMedian(rows.map(x=>clockMinutes(x.bedtime))),wake:clockMedian(rows.map(x=>clockMinutes(x.wakeTime))),n:rows.length};
}
function headacheStartOn(day){const at=app.records.filter(r=>r.type==='headache'&&Number(r.severity)>0&&!r.timeApprox&&recordDate(r)===day).map(r=>new Date(r.at).getTime()).filter(Number.isFinite);return at.length?Math.min(...at):null}
function safeEventAfterWake(r,wake,headacheStart){if(!accurateAt(r)||wake===null)return null;
 const actual=new Date(r.at),time=actual.getHours()*60+actual.getMinutes();const delta=time-wake;
 if(delta<0||delta>12*60)return null;
 if(headacheStart!==null&&actual.getTime()>=headacheStart)return null;
 return delta;
}
function analyticsRows(a){const cfg=analysisConfig();return a.days.map(day=>{
 const status=dayHeadStatus(day),records=app.records.filter(x=>recordDate(x)===day);
 const symptomatic=records.filter(x=>x.type==='headache'&&Number(x.severity)>0);
 // Heavy/unknown symptom days are never treated as headache-free controls.
 const kind=symptomatic.some(r=>r.kind==='headache'||r.kind==='migraine')||records.some(documentedHeadNote)?'headache':symptomatic.length?'symptoms_only':(['confirmed_clear','inferred_clear'].includes(status)?'clear':'unknown');
 const sl=records.filter(x=>x.type==='sleep'&&Number.isFinite(duration(x.duration))).sort((x,y)=>new Date(y.updatedAt||y.at)-new Date(x.updatedAt||x.at))[0];
 const baseline=routineBaseline(day);
 const baselineReady=Boolean(sl&&baseline&&clockMinutes(sl.bedtime)!==null&&clockMinutes(sl.wakeTime)!==null);
 const bedtime=sl?clockMinutes(sl.bedtime):null,wake=sl?clockMinutes(sl.wakeTime):null;
 const coffee=records.filter(isCoffee),foods=records.filter(x=>x.type==='food'&&!foodIsSnack(x.meal));
 const onset=headacheStartOn(day);
 // A symptom day without a reliable first headache timestamp can still
 // describe same-day breakfast/coffee timing. It does NOT establish that
 // the event preceded the symptoms; mark that limitation in the report.
 const bdelay=foods.map(r=>safeEventAfterWake(r,wake,onset)).filter(v=>v!==null);
 const cdelay=coffee.map(r=>safeEventAfterWake(r,wake,onset)).filter(v=>v!==null);
 const waterRows=records.filter(x=>x.type==='water'&&x.kind!=='other'&&Number.isFinite(+x.ml)&&+x.ml>0);
 const water=waterRows.length?waterRows.reduce((s,r)=>s+Number(r.ml),0):null;
 const slMinutes=sl?duration(sl.duration):null;
 const bedDiff=baselineReady?Math.abs(clockDelta(bedtime,baseline.bed)):null;
 const wakeDiff=baselineReady?clockDelta(wake,baseline.wake):null;
 return {day,kind,status,records,unspecifiedSymptoms:symptomatic.some(r=>r.kind==='unknown'),sleep:slMinutes,water,waterPartial:waterRows.some(x=>x.timeApprox||x.aggregate),coffee:coffee.length?coffee.length:null,breakfastDelay:bdelay.length?Math.min(...bdelay):null,coffeeDelay:cdelay.length?Math.min(...cdelay):null,headacheClockUnknown:kind!=='clear'&&onset===null,changedRoutine:baselineReady?(bedDiff>cfg.routineDeviation||Math.abs(wakeDiff)>cfg.routineDeviation):null,wakeShift:wakeDiff===null?null:(wakeDiff>cfg.wakeTolerance?'late':wakeDiff<(-cfg.wakeTolerance)?'early':null)};
 });}

function timingDayReason(row, factor){
 const r=row.records;
 const sl=r.filter(x=>x.type==='sleep'&&Number.isFinite(duration(x.duration))).sort((a,b)=>new Date(b.updatedAt||b.at)-new Date(a.updatedAt||a.at))[0];
 if(!sl)return 'لا يوجد نوم مسجّل بتاريخ الاستيقاظ';
 const wake=clockMinutes(sl.wakeTime);
 if(wake===null)return 'وقت الاستيقاظ غير موجود أو غير صالح';
 const events=factor==='breakfast'?r.filter(x=>x.type==='food'&&!foodIsSnack(x.meal)):r.filter(isCoffee);
 if(!events.length)return factor==='breakfast'?'لا توجد وجبة مسجّلة (السناك لا يُحتسب كأول وجبة)':'لا توجد قهوة مصنّفة كقهوة';
 const exact=events.filter(accurateAt);
 if(!exact.length)return factor==='breakfast'?'وقت أول وجبة ما زال معلّمًا بأنه تقريبي':'وقت أول قهوة ما زال معلّمًا بأنه تقريبي';
 const first=headacheStartOn(row.day);
 if(exact.some(x=>safeEventAfterWake(x,wake,first)!==null))return row.headacheClockUnknown?'احتُسب كتزامن يومي؛ وقت الصداع غير مؤكد':'احتُسب في المقارنة';
 if(first!==null&&exact.every(x=>new Date(x.at)>=new Date(first)))return 'الحدث بعد أول قراءة صداع موثوقة؛ لا يُستخدم كعامل سابق لها';
 return 'وقت الحدث قبل الاستيقاظ أو بعده بأكثر من 12 ساعة؛ راجع التاريخ والساعة';
}

// --- v1.8.3: Factor-days stay fixed when changing symptom scope. ---
// A recorded factor-day is observable independently of the headache outcome.
// In headache-only mode, days with UNKNOWN positive symptoms (and no known
// headache/migraine) are EXCLUDED rather than falsely treated as controls.
// Unknown-outcome days and case-only 2024 diaries are NOT considered controls.
function isCaseOnlyRetrospective(row){
 return row.records.some(r=>r.source==='retrospective-2024-diary');
}
function selectedSymptom(row){
 return row.kind==='headache'||(app.analysisMode==='all_symptoms'&&row.kind==='symptoms_only');
}
function hasKnownOutcome(row){
 if(row.kind==='headache')return true;
 if(app.analysisMode==='headache_only'&&row.unspecifiedSymptoms)return false;
 return row.kind==='symptoms_only'||row.kind==='clear';
}

// --- v1.8.9: ISOLATED water-only, time-ordered exploratory comparisons. ---
// Neither other factor definitions nor the existing daily routine comparisons change.
const WATER_DAY=24*60*60*1000;
function water24Episodes(){
 const groups=new Map();
 for(const r of app.records){
  if(r.type!=='headache'||!Number.isFinite(Number(r.severity))||Number(r.severity)<=0)continue;
  const key=r.episodeId||('single-'+r.id);
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(r);
 }
 return [...groups.entries()].map(([key,all])=>{
  all.sort((x,y)=>new Date(x.at)-new Date(y.at));
  const first=all[0],ms=new Date(first.at).getTime();
  const target=app.analysisMode==='all_symptoms'||all.some(r=>r.kind==='headache'||r.kind==='migraine');
  // Water-only policy chosen by the user: use the recorded clock even when
  // the historical entry carries timeApprox. Keep its original provenance.
  // The selectively collected 2024 diary stays out of quantified comparisons.
  return {key,first,ms,target,valid:Number.isFinite(ms)&&!all.some(r=>r.source==='retrospective-2024-diary')};
 }).sort((a,b)=>a.ms-b.ms);
}
function water24Events(start,end){
 // Water-only user preference: treat every recorded event clock as accepted,
 // including timeApprox, aggregate and retrospective message timestamps.
 // Preserve those flags in the source data; do not affect other analytics.
 const valid=app.records.filter(r=>r.type==='water'&&r.kind!=='other'&&Number.isFinite(+r.ml)&&+r.ml>0&&r.at&&Number.isFinite(new Date(r.at).getTime())&&new Date(r.at).getTime()>=start&&new Date(r.at).getTime()<end);
 if(!valid.length)return {status:'missing',water:null,events:0};
 return {status:'measured',water:valid.reduce((n,r)=>n+Number(r.ml),0),events:valid.length};
}
function water24StatusForWindow(start,end,episodes){
 // No recorded symptom onset in a COMPLETED window = healthy, even when the
 // user logged no other routine during those 24 hours. A descriptive headache
 // with an unknown clock is treated as uncertain rather than healthy.
 const positive=app.records.some(r=>r.type==='headache'&&Number(r.severity)>0&&new Date(r.at)>=start&&new Date(r.at)<end);
 if(positive)return 'symptoms';
 if(episodes.some(ep=>ep.ms>=start&&ep.ms<end&&!ep.valid))return 'unknown';
 const first=localDate(new Date(start)),last=localDate(new Date(end-1));
 const touched=[...new Set([first,last])];
 if(touched.some(d=>app.records.some(r=>recordDate(r)===d&&r.source==='retrospective-2024-diary')))return 'unknown';
 if(touched.some(d=>app.records.some(r=>recordDate(r)===d&&documentedHeadNote(r))))return 'unknown';
 return 'clear';
}
// Water must be OBSERVED during the preceding 24 hours. We do not require
// unrelated sleep/coffee/food entries or a previous 0% headache reading.
// Lack of water records is still MISSING WATER, never zero millilitres.
function water24BaselineReady(start,end){
 const first=localDate(new Date(start)),last=localDate(new Date(end-1));
 return ![...new Set([first,last])].some(d=>app.records.some(r=>recordDate(r)===d&&r.source==='retrospective-2024-diary'));
}
function water24Model(a){
 const cfg=analysisConfig(),days=new Set(a.days);
 const episodes=water24Episodes();
 const accepted=episodes.filter(ep=>ep.target&&ep.valid&&days.has(localDate(new Date(ep.ms)))&&ep.ms<=Date.now());
 const upper=accepted.map(ep=>({...ep,water:water24Events(ep.ms-WATER_DAY,ep.ms)}));
 const upperMeasured=upper.filter(ep=>ep.water.status==='measured');
 const upperLow=upperMeasured.filter(ep=>ep.water.water<cfg.waterMl).length;
 const upperHigh=upperMeasured.length-upperLow;
 // Fixed daily reference points, independent of the appearance of a headache:
 // water in the previous 24h (12:00-12:00), followed prospectively by a
 // 24h observation window. Restrict to completed follow-up intervals.
 const lower=[],audits=[];
 for(const day of a.days){
  const anchor=new Date(day+'T12:00:00').getTime();
  if(!Number.isFinite(anchor))continue;
  if(anchor+WATER_DAY>Date.now()){audits.push({day,reason:'لم تكتمل 24 ساعة المتابعة'});continue;}
  const start=anchor-WATER_DAY,finish=anchor+WATER_DAY;
  const water=water24Events(start,anchor);
  if(water.status!=='measured'){audits.push({day,reason:'لا يوجد ماء مسجّل في فترة القياس'});continue;}
  if(!water24BaselineReady(start,anchor)){audits.push({day,reason:'بيانات الروتين غير مكتملة أو أعراض سابقة لم يُسجّل انتهاؤها'});continue;}
  // If an episode began before the observation window but an active reading
  // remains, don't count that continuation as a new onset or as a control.
  const futureReadings=app.records.filter(r=>r.type==='headache'&&Number(r.severity)>0&&new Date(r.at)>=anchor&&new Date(r.at)<finish);
  const futureStarts=episodes.filter(ep=>ep.ms>=anchor&&ep.ms<finish);
  const otherSymptoms=futureReadings.some(r=>r.kind==='unknown'||(app.analysisMode==='all_symptoms'?false:r.kind==='heavy'));
  const target=futureStarts.some(ep=>ep.target&&ep.valid);
  const anyNonTarget=futureReadings.length&&!target;
  let outcome=null;
  // A known migraine/headache in the follow-up wins over earlier "unknown"
  // readings belonging to the same episode. Otherwise unspecified positive
  // symptoms remain excluded from headache-only comparisons.
  if(target)outcome=1;
  else if(otherSymptoms||anyNonTarget)outcome=null;
  else if(water24StatusForWindow(anchor,finish,episodes)==='clear')outcome=0;
  if(outcome===null){audits.push({day,reason:'حالة الأعراض التالية غير مؤكدة'});continue;}
  lower.push({day,water:water.water,low:water.water<cfg.waterMl,outcome});
 }
 const grouped=[lower.filter(x=>x.low),lower.filter(x=>!x.low)].map(rows=>({n:rows.length,head:rows.filter(x=>x.outcome===1).length,rate:rows.length?Math.round(100*rows.filter(x=>x.outcome===1).length/rows.length):null}));
 const [low,high]=grouped;
 const cases=lower.filter(x=>x.outcome===1).length,controls=lower.length-cases;
 const enough=low.n>=5&&high.n>=5&&cases>=5&&controls>=5;
 const difference=low.rate!==null&&high.rate!==null?low.rate-high.rate:null;
 const riskIndex=enough&&difference!==null&&Math.abs(difference)>=20?(difference>0?0:1):-1;
 return {upper,upperMeasured,upperLow,upperHigh,grouped,lower,audits,enough,riskIndex,threshold:cfg.waterMl,excluded:upper.length-upperMeasured.length};
}
function water24UpperHtml(w){
 const measured=w.upperMeasured.length,pct=measured?Math.round(100*w.upperLow/measured):null;
 const highlighted=w.riskIndex===0;
 const message=measured
  ?`في ${w.upperLow} من ${measured} نوبات لها ماء مسجّل بأوقات اعتمدتها، كان الإجمالي أقل من ${w.threshold} مل خلال الـ24 ساعة السابقة.`
  :'لا توجد نوبات لها وقت بداية وماء مسجّل في الـ24 ساعة السابقة.';
 const episodeRows=[...w.upperMeasured].sort((a,b)=>b.ms-a.ms).map(ep=>{
  const onset=fmtShort(localDate(new Date(ep.ms)))+'، '+fmtTime(ep.ms);
  const amount=ep.water.water;
  return `<div class="water24-episode-row"><span>${E(onset)}</span><b>${amount.toLocaleString('ar-SA')} مل</b><small>${amount<w.threshold?'أقل من الحد المحدد':'عند الحد المحدد أو أعلى'}</small></div>`;
 }).join('');
 const details=measured?`<details class="water24-episodes"><summary>شوف كمية الموية قبل كل نوبة (${measured})</summary>${episodeRows}</details>`:'';
 return `<div class="panel water24-panel"><h3>◉ الماء قبل النوبة — آخر 24 ساعة</h3><p class="mini">من منظور الصداع: نرجع 24 ساعة قبل بداية النوبة المسجلة، ولا نحسب الماء بعدها.</p><div class="water24-summary ${highlighted?'risk-emphasis':''}"><strong>${pct===null?'—':pct+'%'}</strong><div><b>ماء مسجّل أقل من ${w.threshold} مل</b><small>${E(message)}</small></div></div>${details}<p class="mini">${w.excluded} نوبات أخرى لم تدخل لعدم وجود ماء أو وقت بداية مسجل. تُعتمد الأوقات التقديرية حسب اختيارك، لكنها لا تثبت أن الشرب حصل في نفس الدقيقة أو أنه سبب الصداع.</p></div>`;
}
function water24LowerHtml(w){
 const [low,high]=w.grouped;
 const half=(g,i)=>`<div class="compare-half ${w.riskIndex===i?'risk-emphasis':''}"><span>${i===0?'ماء مسجّل أقل من '+w.threshold+' مل':'ماء مسجّل '+w.threshold+' مل فأكثر'}</span><strong>${g.rate===null?'—':g.rate+'%'}</strong><div class="compare-track"><span style="width:${g.rate??0}%"></span></div><small>${g.head} فترات تبعتها أعراض من ${g.n} فترات صالحة للمقارنة</small></div>`;
 let desc='البيانات غير كافية للحكم؛ لن نبرز أي نسبة بالأحمر.';
 if(w.riskIndex!==-1)desc=`معدل الأعراض أعلى بعد «${w.riskIndex===0?'الماء الأقل':'الماء الأكثر'}» بفارق ${Math.abs(low.rate-high.rate)} نقطة مئوية، ويستحق المتابعة دون إثبات سبب.`;
 else if(w.enough)desc='المقارنة متاحة، لكن لا يظهر فرق كبير بما يكفي لتمييز عامل محدد.';
 const auditRows=[...w.lower.map(r=>({day:r.day,reason:`احتُسبت: ${r.water} مل، ${r.outcome?'تبعتها نوبة':'لم تتبعها نوبة'}`})),...(w.audits||[])].sort((a,b)=>b.day.localeCompare(a.day));
 const audit=`<details class="timing-audit"><summary>لماذا احتُسبت أو استُبعدت كل فترة؟</summary><div class="timing-audit-list">${auditRows.map(r=>`<div><b dir="ltr">${E(r.day)}</b> — ${E(r.reason)}</div>`).join('')}</div></details>`;
 return `<details class="routine-item water24-lower" open><summary>الماء — قبل النوبات بـ24 ساعة <small>${w.lower.length} فترات صالحة</small></summary><p class="mini">من منظور الروتين: نسجل ماء الـ24 ساعة المنتهية عند 12 ظهرًا، ثم نتابع ظهور نوبة جديدة خلال الـ24 ساعة التالية. الفترات بدون ماء مسجّل أو متابعة كافية تُستبعد. ويُعتمد وقت كل تسجيل ماء حتى لو كان تقديريًا.</p><div class="compare-grid">${half(low,0)}${half(high,1)}</div><div class="routine-conclusion">${E(desc)}</div><p class="mini">حسب قاعدة يومي الجديدة: إذا اكتملت 24 ساعة المتابعة ولم تُسجّل نوبة، تُحسب فترة سليمة حتى لو لم تُسجّل روتينًا خلالها. عدم تسجيل الماء في فترة القياس لا يعني شرب 0 مل. الحالات ذات الأعراض المسجّلة لكن غير المصنفة قد تُستبعد حسب الفلتر. الماء المسجّل قد لا يمثّل كل ما شربته.</p>${audit}</details>`;
}

function comparisonModel(a){
 const cfg=analysisConfig(),rows=analyticsRows(a);
 // Crucially this cohort is independent of the selected symptom filter.
 const eligibleAll=rows.filter(hasKnownOutcome);
 const definitions=[
  {id:'sleep',title:'مدة النوم',note:'النوم الفعلي في ليلة الاستيقاظ؛ لا نعتمد القيلولة ضمن هذه المدة',groups:[`أقل من ${cfg.sleepHours} ساعات`,`${cfg.sleepHours} ساعات فأكثر`],summaryGroups:[`نوم أقل من ${cfg.sleepHours} ساعات`,`نوم ${cfg.sleepHours} ساعات فأكثر`],get:r=>r.sleep===null?null:(r.sleep<cfg.sleepHours*60?0:1)},
  {id:'coffee',title:'عدد مرات القهوة',note:'تسجيلات القهوة فقط؛ عدم تسجيل قهوة لا يعني عدم شربها',groups:['مرة واحدة','مرتان فأكثر'],summaryGroups:['قهوة واحدة','قهوتان فأكثر'],get:r=>r.coffee===null?null:(r.coffee===1?0:1)},
  {id:'breakfast',title:'أول وجبة بعد الاستيقاظ',note:'وقت أول وجبة والاستيقاظ مؤكدان. إذا لم يُعرف وقت الصداع، فهذه مقارنة تزامن خلال اليوم وليست دليلًا أن الوجبة سبقته',groups:[`خلال ${cfg.timingMinutes} دقيقة`,`بعد ${cfg.timingMinutes} دقيقة`],summaryGroups:[`أول وجبة خلال ${cfg.timingMinutes} دقيقة من الاستيقاظ`,`أول وجبة بعد ${cfg.timingMinutes} دقيقة من الاستيقاظ`],get:r=>r.breakfastDelay===null?null:(r.breakfastDelay<=cfg.timingMinutes?0:1)},
  {id:'coffeeTime',title:'أول قهوة بعد الاستيقاظ',note:'وقت القهوة والاستيقاظ مؤكدان. إذا لم يُعرف وقت الصداع، فهذه مقارنة تزامن خلال اليوم وليست دليلًا أن القهوة سبقته',groups:[`خلال ${cfg.timingMinutes} دقيقة`,`بعد ${cfg.timingMinutes} دقيقة`],summaryGroups:[`أول قهوة خلال ${cfg.timingMinutes} دقيقة من الاستيقاظ`,`أول قهوة بعد ${cfg.timingMinutes} دقيقة من الاستيقاظ`],get:r=>r.coffeeDelay===null?null:(r.coffeeDelay<=cfg.timingMinutes?0:1)},
  {id:'routine',title:'تغيّر موعد النوم',note:'مقارنة موعد النوم أو الاستيقاظ بآخر 14 يومًا مع توافر 7 ليالٍ مكتملة على الأقل',groups:['قريب من المعتاد','تغيّر واضح'],summaryGroups:['موعد نوم واستيقاظ قريبان من المعتاد','تغيّر واضح في موعد النوم أو الاستيقاظ'],get:r=>r.changedRoutine===null?null:(r.changedRoutine?1:0)},
  {id:'wake',title:'وقت الاستيقاظ',note:'مقارنة بموعد الاستيقاظ المعتاد؛ الوقت القريب من المعتاد لا يوضع في أيّ مجموعة',groups:['أبكر من المعتاد','متأخر عن المعتاد'],summaryGroups:['استيقاظ أبكر من المعتاد','استيقاظ متأخر عن المعتاد'],get:r=>r.wakeShift===null?null:(r.wakeShift==='early'?0:1)}
 ];
 const result=definitions.map(def=>{
  // All days with a measured factor, even if headache outcome is missing.
  const measured=rows.filter(r=>def.get(r)!==null);
  // Same risk-comparison cohort in both filter modes; case-only diaries and
  // outcome-unknown days never turn into symptom-free controls.
  const observed=eligibleAll.filter(r=>def.get(r)!==null);
  const known=observed.filter(r=>!isCaseOnlyRetrospective(r));
  const unknownOnset=known.filter(r=>selectedSymptom(r)&&r.headacheClockUnknown).length;
  const timingDetails=['breakfast','coffeeTime'].includes(def.id)?rows.filter(r=>r.records.some(x=>x.type==='sleep'||(def.id==='breakfast'?x.type==='food'&&!foodIsSnack(x.meal):isCoffee(x)))).map(r=>({day:r.day,reason:r.kind==='unknown'?(r.day===localDate(now())?'اليوم الحالي لم ينتهِ؛ يُفحص بعد اكتماله':'حالة الصداع أو خلو اليوم منه غير محددة، لذلك لا يدخل في المقارنة'):timingDayReason(r,def.id==='breakfast'?'breakfast':'coffeeTime')})).sort((a,b)=>b.day.localeCompare(a.day)):[];
  const symptomAll=observed.filter(selectedSymptom);
  const symptomComparable=known.filter(selectedSymptom),controlComparable=known.filter(r=>!selectedSymptom(r));
  const counts=group=>{
   const arr=known.filter(r=>def.get(r)===group);
   const head=arr.filter(selectedSymptom).length;
   return {n:arr.length,head,clear:arr.length-head,rate:arr.length?Math.round(100*head/arr.length):null};
  };
  const g0=counts(0),g1=counts(1);
  const totals=[0,1].map(group=>{
   const n=measured.filter(r=>def.get(r)===group).length;
   const eligible=known.filter(r=>def.get(r)===group).length;
   return {n,eligible,unassessed:n-eligible};
  });
  const hints=[0,1].map((group,i)=>{
   const count=symptomAll.filter(r=>def.get(r)===group).length;
   const headTotal=symptomAll.length;
   const pct=headTotal?Math.round(100*count/headTotal):null;
   const overall=measured.length?Math.round(100*totals[i].n/measured.length):null;
   const inComparableHead=symptomComparable.filter(r=>def.get(r)===group).length;
   const pH=symptomComparable.length?100*inComparableHead/symptomComparable.length:null;
   const pC=controlComparable.length?100*controlComparable.filter(r=>def.get(r)===group).length/controlComparable.length:null;
   const self=[g0,g1][i],other=[g0,g1][1-i];
   const rateDifference=self.rate!==null&&other.rate!==null?self.rate-other.rate:null;
   const comparativeReady=symptomComparable.length>=5&&controlComparable.length>=5&&self.n>=5&&other.n>=5;
   const qualified=comparativeReady&&rateDifference>=20&&pH!==null&&pC!==null&&pH-pC>=20;
   return {title:def.groups[i],summaryTitle:def.summaryGroups[i],count,pct,overall,headTotal,totalDays:measured.length,
    pH:pH===null?null:Math.round(pH),pC:pC===null?null:Math.round(pC),
    rateDifference,qualified,comparativeReady,groupIndex:i};
  });
  const preferred=hints.slice().sort((a,b)=>(b.pct??-1)-(a.pct??-1)||b.count-a.count)[0];
  const hasRetrospective=observed.some(isCaseOnlyRetrospective);
  return {...def,available:measured.length,groupTotals:totals,known:known.length,
   described:observed.length,excluded:eligibleAll.length-observed.length,
   excludedStatus:observed.length-known.length,unknownOutcome:measured.length-observed.length,
   unknownOnset,timingDetails,counts:[g0,g1],hints,preferred,hasRetrospective,
   heavyControls:known.filter(r=>r.kind==='symptoms_only').length,
   sample:{head:symptomComparable.length,clear:controlComparable.length},
   summarySupported:preferred.headTotal>=3&&preferred.count>=3&&preferred.pct>50};
 });
 const recurring=result.filter(f=>f.summarySupported).sort((a,b)=>{
  const aq=a.hints.some(x=>x.qualified)?1:0,bq=b.hints.some(x=>x.qualified)?1:0;
  return bq-aq||b.preferred.count-a.preferred.count||b.preferred.pct-a.preferred.pct;
 }).slice(0,5);
 const strong=result.flatMap(f=>f.hints.filter(x=>x.qualified).map(x=>({...x,factor:f.title,id:f.id})))
  .sort((a,b)=>(b.rateDifference??0)-(a.rateDifference??0));
 return {result,recurring,strong,rows,eligible:eligibleAll,mode:app.analysisMode};
}
function keyInsightsHtml(model){
 const desc=model.mode==='all_symptoms'?'أيام أعراض الرأس':'أيام الصداع والشقيقة';
 if(!model.recurring.length)return `<div class="panel"><h3>ما الذي تكرر مع الصداع؟</h3><div class="empty">نحتاج أيام أعراض أكثر مع بيانات روتين حتى نعرض نمطًا متكررًا (3 أيام على الأقل).</div><p class="mini">وجود عامل في أيام الصداع وحده لا يعني أنه سببه. الأيام المنتهية دون تسجيل صداع تُحسب سليمة حسب اختيارك، لكن عدم تسجيل الروتين لا يُعد قيمة صفرية له.</p></div>`;
 return `<div class="panel"><h3>ما الذي تكرر مع الصداع؟</h3><p class="mini">الرقم الكبير هو حصة الروتين من أيام الأعراض التي سُجلت فيها بيانات هذا العامل، وليس احتمال إصابتك بالصداع.</p><div class="insights">${model.recurring.map(f=>{
 const v=f.preferred,signal=f.hints.find(x=>x.qualified),clear=f.sample.clear;
 let message='متكرر في أيام الأعراض، لكن لا توجد بيانات سليمة كافية لمعرفة إن كان عاملًا مميزًا.';
 if(signal&&signal.groupIndex===v.groupIndex) message='ظهر معه معدل أعراض أعلى من المجموعة الأخرى؛ ارتباط يستحق المتابعة.';
 else if(v.comparativeReady&&v.rateDifference!==null&&Math.abs(v.rateDifference)<10)message='شائع في أيامك عمومًا، ولا يظهر فرق واضح في معدّل الصداع.';
 else if(v.comparativeReady&&v.rateDifference!==null&&v.rateDifference<=0)message='متكرر في أيام الأعراض، لكن معدل الصداع ليس أعلى معه.';
 else if(v.comparativeReady)message='متكرر، لكن الفرق ما زال غير حاسم.';
 const retro=f.hasRetrospective?' · تشمل مذكرات قديمة انتقائية؛ لا تُستخدم لحساب معدل الصداع.':'';
 return `<div class="insight ${signal&&signal.groupIndex===v.groupIndex?'risk-emphasis':''}"><div class="insight-top"><strong dir="ltr">${v.pct}%</strong><span>${E(v.summaryTitle)}</span></div><div class="insight-track"><span style="width:${v.pct}%"></span></div><div class="insight-meta">${v.count} من ${v.headTotal} ${E(desc)} لديها بيانات ${E(f.title)} · وُجد هذا الروتين في ${v.overall}% من جميع أيام ${E(f.title)} المسجلة.</div><p class="insight-verdict">${E(message)}</p>${retro?`<p class="mini">${E(retro)}</p>`:''}</div>`;
 }).join('')}</div>${model.strong.length?`<p class="mini"><strong>أولوية للمتابعة:</strong> ${model.strong.map(x=>E(x.summaryTitle)).join('، ')}. هذه ارتباطات وليست إثباتًا للسبب.</p>`:'<p class="mini">التكرار يوضح ما يصاحب الأعراض، وليس بالضرورة ما يرفع احتمالها. انظر المقارنة أدناه.</p>'}</div>`;
}
function comparisonHtml(model,water24){
 const symptomLabel=model.mode==='all_symptoms'?'أعراض رأس':'صداع/شقيقة';
 const noTargetLabel=model.mode==='all_symptoms'?'بلا أعراض رأس':'بلا صداع/شقيقة مسجّلة';
 const heavyContext=model.mode==='headache_only'?'في فلتر «الصداع والشقيقة فقط»، أيام الثقل وحده تُحسب ضمن الأيام التي لم يُسجّل فيها صداع أو شقيقة، وليست بالضرورة خالية من أعراض الرأس.':'';
 return `<div class="panel"><h3>هل ${model.mode==='all_symptoms'?'أعراض الرأس':'الصداع والشقيقة'} أكثر مع هذا الروتين؟</h3><p class="mini">عدد الأيام المسجلة لكل مجموعة ثابت عند تبديل الفلتر. نسبة الصداع تعتمد فقط على الأيام ذات الحالة المعروفة. في وضع «الصداع والشقيقة» تُستبعد أيام «غير محدد» من النسبة، ولا تُعامل كأيام سليمة.</p>${[['sleep','النوم',['sleep','routine','wake']],['coffee','القهوة',['coffee','coffeeTime']],['food','الأكل',['breakfast']],['water','الموية',[]]].map(([groupId,groupTitle,ids])=>{const chosen=model.result.filter(f=>ids.includes(f.id));const risk=groupId==='water'?water24.riskIndex!==-1:chosen.some(f=>f.hints?.some(h=>h.qualified));const cards=groupId==='water'?water24LowerHtml(water24):chosen.map(f=>{
  const p=f.preferred,[g0,g1]=f.counts;
  const one=(g,i)=>{
   const tot=f.groupTotals[i];
   return `<div class="compare-half ${f.hints.some(x=>x.qualified&&x.groupIndex===i)?'risk-emphasis':''}"><span>${E(f.groups[i])}</span><div class="factor-total"><b>${tot.n}</b> أيام مسجلة لهذا الروتين <span>· ثابتة عند تغيير نوع الأعراض</span></div><strong>${g.rate===null?'—':g.rate+'%'}</strong><div class="compare-track"><span style="width:${g.rate||0}%"></span></div><small>${g.head} يوم ${E(symptomLabel)} من ${g.n} يوم صالح للمقارنة${g.n>0&&g.n<5?' · عينة صغيرة':''}${g.n===0?' · لا تتوفر أيام صالحة':''}</small>${tot.unassessed?`<small>${tot.unassessed} يوم خارج حساب النسبة: حالة غير محسومة أو مذكرات انتقائية</small>`:''}</div>`;
  };
  const strongest=f.hints.find(x=>x.qualified);
  const enough=f.sample.head>=5&&f.sample.clear>=5&&g0.n>=5&&g1.n>=5;
  let verdict='لا يمكن الحكم بعد؛ المقارنة تحتاج أيامًا أكثر مع الأعراض المختارة وبدونها في كل مجموعة.';
  if(enough&&strongest)verdict=`الأعراض المختارة أكثر مع «${strongest.title}»؛ فرق المعدل ${Math.round(strongest.rateDifference)} نقطة مئوية. ارتباط يستحق المتابعة، وليس سببًا مثبتًا.`;
  else if(enough&&g0.rate!==null&&g1.rate!==null&&Math.abs(g0.rate-g1.rate)<10)verdict='الروتين موجود في أيام الأعراض المختارة والأيام الأخرى، ولا يظهر فرق واضح في معدّلها.';
  else if(enough)verdict='توجد فروق، لكنها غير كافية لوصف العامل بأنه مرتبط بالأعراض بوضوح.';
  const retrospective=f.excludedStatus?' · استُبعدت '+f.excludedStatus+' من أيام المذكرات الانتقائية القديمة من حساب المعدل':'';
  const unverified=(f.id==='breakfast'||f.id==='coffeeTime')&&f.unknownOnset?' · '+f.unknownOnset+' أيام أعراض بوقت بداية صداع غير مؤكد: تحليل تزامن يومي فقط':'';
  const timingAudit=f.timingDetails?.length?`<details class="timing-audit"><summary>تفاصيل الأيام: لماذا احتُسب كل يوم أو استُبعد؟</summary><div class="timing-audit-list">${f.timingDetails.map(x=>`<div><b dir="ltr">${E(x.day)}</b> — ${E(x.reason)}</div>`).join('')}</div></details>`:'';
  return `<details class="routine-item" ${f.id==='sleep'?'open':''}><summary>${E(f.title)} <small>${f.available} يوم فيه بيانات · ثابت</small></summary>${p.headTotal?`<div class="routine-frequency"><strong>${p.pct}%</strong><div><b>${E(p.title)}</b><small>في ${p.count} من ${p.headTotal} يوم ${E(symptomLabel)} معروفة بيانات هذا العامل</small></div></div>`:'<p class="mini">لا توجد أيام أعراض مختارة ذات بيانات لهذا العامل.</p>'}<div class="compare-grid">${one(g0,0)}${one(g1,1)}</div><div class="routine-conclusion">${E(verdict)}</div><p class="mini">${E(f.note)} · ${f.known} يوم صالح للمقارنة (${f.sample.head} مع ${E(symptomLabel)}، و${f.sample.clear} ${E(noTargetLabel)})${f.unknownOutcome?' · '+f.unknownOutcome+' أيام مسجلة حالتها غير محسومة':''}${E(retrospective)}${E(unverified)}</p>${timingAudit}</details>`;
 }).join('');return `<details class="routine-group ${risk?'has-risk':''}"><summary><span>${E(groupTitle)}</span><span class="group-summary-meta">${risk?'<b class="group-risk">تنبيه للمراجعة</b>':''}<span>التفاصيل ⌄</span></span></summary><div class="routine-group-inner">${cards}</div></details>`}).join('')}<p class="mini">${E(heavyContext)} مذكرات 2024 الانتقائية لا تُستخدم لتقدير معدل الأعراض. غياب تسجيل القهوة لا يعني عدم شربها، ولا تُستخدم الأوقات التقريبية في مقارنة التوقيت. إذا لم يُعرف وقت بداية الصداع فالعلاقة تزامن في اليوم نفسه فقط، وليس دليلًا على السبب.</p></div>`;
}
function analyticsSettingsHtml(){const c=analysisConfig();return `<details class="panel analytic-settings"><summary>تعديل حدود المقارنة (اختياري)</summary><div class="form-grid">${[['sleepHours','النوم (ساعة)',c.sleepHours,4,12],['waterMl','الماء (مل)',c.waterMl,200,5000],['timingMinutes','بعد الاستيقاظ (دقيقة)',c.timingMinutes,15,240],['routineDeviation','تغيّر الروتين (دقيقة)',c.routineDeviation,30,240],['wakeTolerance','تغيّر الاستيقاظ (دقيقة)',c.wakeTolerance,15,180]].map(([key,title,val,min,max])=>`<label class="field"><span>${title}</span><input type="number" data-analytic-config="${key}" min="${min}" max="${max}" step="${key==='waterMl'?100:5}" value="${val}"></label>`).join('')}</div><p class="mini">تُطبّق التغييرات مباشرة بعد مغادرة الخانة، ولا تغيّر السجلات الأصلية.</p></details>`}
function renderAnalytics(){
  const a=getAnalytics(),model=comparisonModel(a),water24=water24Model(a);
  const endedDays=a.days.filter(d=>d<localDate(now()));
  const filteredHeadDays=app.analysisMode==='headache_only'?a.headacheDays:a.symptomDays;
  const symptomCount=endedDays.filter(d=>filteredHeadDays.has(d)).length;
  const clearDays=endedDays.length-symptomCount;
  const symptomsTitle=app.analysisMode==='headache_only'?'أيام الصداع والشقيقة':'أيام أعراض الرأس';
  const clearTitle=app.analysisMode==='headache_only'?'أيام بدون صداع أو شقيقة':'أيام بدون أعراض الرأس';
 const symptomOnly=model.rows.filter(x=>x.kind==='symptoms_only').length;
 const avgWater=a.waterDays.length?Math.round(a.waterDays.reduce((s,x)=>s+x.sum,0)/a.waterDays.length):null;
 const sleepAvg=a.sleep.length?fmtDuration(Math.round(a.sleep.reduce((n,s)=>n+duration(s.duration),0)/a.sleep.length)):null;
 return `<div class="view-title analysis-title"><div><h1>التحليل</h1><span class="sub">اعرف الروتينات المرتبطة بالصداع بسرعة</span></div><label class="exclude-untracked"><input id="exclude-incomplete" type="checkbox" ${app.settings.excludeIncompleteDays!==false?'checked':''}><span>استبعاد الأيام غير المكتملة</span></label></div>
  <div class="period-primary segmented">${[[7,'7 أيام'],[10,'10 أيام'],[30,'30 يوم'],['botox','من آخر بوتوكس'],['custom','فترة محددة']].map(([n,v])=>`<button data-period="${n}" class="${app.period===n?'active':''}">${v}</button>`).join('')}</div>
  <div class="period-navigator"><button type="button" data-period-shift="-1" class="period-arrow" ${app.periodOffset===0||!(['custom'].includes(app.period)||fixedPeriod(app.period))?'disabled':''} aria-label="الفترة التالية">‹</button><div><strong dir="ltr">${E(periodDateRange().start)} — ${E(periodDateRange().end)}</strong><small>الفترة المعروضة · أيام مكتملة حتى أمس</small></div><button type="button" data-period-shift="1" class="period-arrow" ${!(['custom'].includes(app.period)||fixedPeriod(app.period))?'disabled':''} aria-label="الفترة السابقة">›</button></div>
  ${app.period==='custom'?`<div class="panel" style="margin-top:12px"><div class="form-grid"><div class="field"><label for="analysis-start">من تاريخ</label><input id="analysis-start" type="date" value="${E(app.customStart)}" max="${previousCompleteDay()}"></div><div class="field"><label for="analysis-end">إلى تاريخ</label><input id="analysis-end" type="date" value="${E(app.customEnd)}" max="${previousCompleteDay()}"></div></div><details class="entry-more"><summary>فترات إضافية (السنوات والكل)</summary><div class="segmented period-advanced">${[['year-2026','2026'],['year-2024','2024'],['all','الكل']].map(([n,v])=>`<button data-period="${n}">${v}</button>`).join('')}</div></details></div>`:''}
  <div class="analysis-scope"><span>احتساب الأعراض في المقارنات</span><div class="segmented">${[['all_symptoms','كل أعراض الرأس'],['headache_only','الصداع والشقيقة فقط']].map(([k,v])=>`<button data-analysis-mode="${k}" class="${app.analysisMode===k?'active':''}">${v}</button>`).join('')}</div></div>
  <div class="card-grid" style="margin-top:14px"><div class="metric"><span>${symptomsTitle}</span><b>${symptomCount}</b><small>أيام مدخلة ضمن الفترة</small></div><div class="metric"><span>${clearTitle}</span><b>${clearDays}</b><small>أيام مسجّلة بلا صداع</small></div><div class="metric"><span>متوسط ساعات النوم</span><b>${sleepAvg||'—'}</b><small>من ${a.sleep.length} يوم مسجل</small></div><div class="metric"><span>متوسط شرب الماء</span><b>${avgWater===null?'—':avgWater.toLocaleString('en-US')+' مل'}</b><small>من ${a.waterDays.length} يوم مسجل</small></div></div>
 ${keyInsightsHtml(model)}${water24UpperHtml(water24)}${comparisonHtml(model,water24)}
 <div class="panel"><div class="severity-heading"><h3>أعلى شدة مسجلة يوميًا</h3><span class="mini">مقياس من 0 إلى 100%</span></div>${chartSvg(a.daily)}<p class="mini">النقطة = يوم صداع وصفي بلا نسبة. العلامة (—) = لا توجد قراءة. عند اختيار سنة أو «الكل» تظهر الأيام ذات التسجيل فقط.</p></div>
 ${medicationResponseHtml(a)}
 ${analyticsSettingsHtml()}
 <details class="panel details-more"><summary>التحليل التفصيلي والتقارير</summary><div class="kv"><span>نوبات شقيقة مصنفة</span><strong>${a.migraineEpisodes.size}</strong></div><div class="kv"><span>أيام أعراض غير مصنفة كصداع</span><strong>${symptomOnly}</strong></div><div class="kv"><span>متوسط النوم المسجل</span><strong>${sleepAvg||'—'}</strong></div><div class="kv"><span>متوسط الماء بالأيام المسجلة</span><strong>${avgWater===null?'—':avgWater+' مل'}</strong></div><p class="info">عند تفعيل استبعاد الأيام غير المكتملة لا تدخل الأيام الخالية من أي تسجيل في الأرقام أو المقارنات. اليوم الذي فيه بيانات روتين دون تسجيل صداع يُستنتج أنه خالٍ من الصداع لأغراض المتابعة فقط، وليس تأكيدًا طبيًا. لا نفترض أن عدم تسجيل الماء يعني صفر مل. في وضع «كل أعراض الرأس» تدخل أيام الثقل والصداع والشقيقة ضمن المقارنة، بينما يمكن حصرها بالصداع والشقيقة فقط من أعلى الصفحة. الصداع الموثق بملاحظة وصفية يُحتسب دون اختراع شدته.</p><h3>الاستجابة للأدوية</h3><p class="mini">الرسم البياني والتفاصيل ظاهرة فوق هذا القسم.</p><div class="btn-row"><button class="btn secondary" data-export="csv">تصدير CSV</button><button class="btn ghost" data-report="1">تقرير للطبيب / PDF</button></div></details>`;
}

// Botox follow-up is a separate, infrequently used page. It never creates
// symptoms from missing data and uses existing headache and medication records.
const BOTOX_MONTHS=3;
const utcDay=d=>Date.parse(d+'T00:00:00Z');
const daysBetween=(a,b)=>Math.round((utcDay(b)-utcDay(a))/86400000);
function shiftedCalendarMonths(date,months){
 const [y,m,d]=date.split('-').map(Number);
 const first=new Date(Date.UTC(y,m-1+months,1));
 const monthDays=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
 first.setUTCDate(Math.min(d,monthDays));
 return first.toISOString().slice(0,10);
}
function plusDays(date,days){return new Date(utcDay(date)+days*86400000).toISOString().slice(0,10)}
function isBotox(r){return r.type==='botox'&&/(?:botox|بوتوكس|botulinum)/i.test(String(r.name||'Botox'))}
function botoxSessions(){return [...app.records.filter(isBotox)].filter(r=>!Number.isNaN(new Date(r.at).getTime())).sort((a,b)=>new Date(a.at)-new Date(b.at));}
function botoxNext(last){
 if(!last)return {expected:'',date:'',confirmed:false};
 const expected=shiftedCalendarMonths(recordDate(last),BOTOX_MONTHS);
 const confirmed=app.settings.botoxAppointmentFor===last.id&&/^\d{4}-\d\d-\d\d$/.test(app.settings.botoxAppointment||'')&&app.settings.botoxAppointment>=recordDate(last);
 return {expected,date:confirmed?app.settings.botoxAppointment:expected,confirmed};
}
function botoxDayFacts(day){
 const records=app.records.filter(r=>r.type!=='botox'&&recordDate(r)===day);
 const heads=records.filter(r=>r.type==='headache'&&Number(r.severity)>0);
 const described=records.some(r=>documentedHeadNote(r));
 const head=heads.some(r=>r.kind==='headache'||r.kind==='migraine')||described;
 const migraine=heads.some(r=>r.kind==='migraine');
 const allSymptom=heads.length>0||described;
 const max=heads.length?Math.max(...heads.map(r=>Number(r.severity))):null;
 const acute=records.some(r=>r.type==='med');
 return {logged:records.length>0,head,migraine,allSymptom,max,acute};
}
function botoxInterval(start,end){
 const today=localDate(now()),stop=end<today?end:today; // today is not yet a completed day
 const dayCount=Math.max(0,daysBetween(start,stop));
 let logged=0,head=0,migraine=0,allSymptom=0,acute=0;
 const intensities=[];
 for(let i=0;i<dayCount;i++){
  const f=botoxDayFacts(plusDays(start,i));
  if(f.logged)logged++;
  if(f.head)head++;
  if(f.migraine)migraine++;
  if(f.allSymptom)allSymptom++;
  if(f.acute)acute++;
  if(f.max!==null)intensities.push(f.max);
 }
 // A missing headache means healthy under the user's convention during active
 // follow-up. But historic gaps (e.g. 2 months with no diary at all) cannot be
 // assumed healthy; suppress comparative rates unless data coverage is adequate.
 const sufficient=dayCount>=14&&logged>=Math.ceil(dayCount*.5);
 const per28=sufficient?Math.round(head/dayCount*280)/10:null;
 return {start,end,dayCount,logged,head,migraine,allSymptom,acute,per28,sufficient,
  meanSeverity:intensities.length?Math.round(intensities.reduce((a,b)=>a+b,0)/intensities.length):null,
  coverage:dayCount?Math.round(logged*100/dayCount):0};
}
function botoxCycle(session,nextSession=null){
 const start=recordDate(session),expected=shiftedCalendarMonths(start,3);
 const end=nextSession?recordDate(nextSession):expected;
 // Avoid backward or same-day intervals from duplicate entries.
 const limits=[start,shiftedCalendarMonths(start,1),shiftedCalendarMonths(start,2),shiftedCalendarMonths(start,3)];
 const months=[];
 for(let i=0;i<3;i++){
  const e=end<limits[i+1]?end:limits[i+1];
  months.push(e>limits[i]?botoxInterval(limits[i],e):botoxInterval(limits[i],limits[i]));
 }
 const late=end>expected?botoxInterval(expected,end):null;
 const overall=botoxInterval(start,end);
 return {session,nextSession,start,end,expected,months,late,overall};
}
// The comparison can cover the latest 12 calendar months, all recorded
// injections, or any number of most recent actual injections. Thirty-day
// windows start at an injection, reset at the next injection, and retain
// historical gaps as missing rather than inventing headache-free days.
function botoxRollingWindows(today=localDate(now()),scope=app.botoxTrendScope){
 const all=[...new Set(botoxSessions().map(recordDate))].filter(d=>d<=today).sort();
 const requested=String(scope||'12m');
 const amount=/^last-(\d+)$/.exec(requested);
 const cutoff=amount&&all.length?all[Math.max(0,all.length-Math.max(1,+amount[1]))]:
  requested==='all'&&all.length?all[0]:shiftedCalendarMonths(today,-12);
 const injections=all.filter(d=>d>=cutoff);
 const previous=all.filter(d=>d<cutoff).at(-1);
 // Before the first known injection, align backward in 30-day increments.
 let anchor=previous||injections[0]||cutoff;
 const ranges=[];let cursor=cutoff,stop=today;
 const maxIterations=Math.max(90,Math.ceil(Math.max(0,daysBetween(cutoff,stop))/7)+10);
 for(let guard=0;cursor<stop&&guard<maxIterations;guard++){
  if(injections.includes(cursor))anchor=cursor;
  const nextShot=injections.find(d=>d>cursor);
  const nextBoundary=plusDays(anchor,(Math.floor(daysBetween(anchor,cursor)/30)+1)*30);
  let end=[nextBoundary,nextShot||stop,stop].sort()[0];
  if(end<=cursor)end=plusDays(cursor,1);
  const facts=botoxInterval(cursor,end);
  const fullThirty=daysBetween(cursor,end)===30;
  const monitored=facts.dayCount>=14&&facts.logged>=Math.ceil(facts.dayCount*.5);
  ranges.push({...facts,rawDays:daysBetween(cursor,end),monitored,
    fullThirty,partial:!fullThirty,shots:injections.filter(d=>d>=cursor&&d<end)});
  cursor=end;
 }
 return {cutoff,now:today,windows:ranges,shots:injections,scope:requested};
}
function botoxTrendScopeControls(){
 const total=[...new Set(botoxSessions().map(recordDate))].length;
 const options=[['12m','آخر 12 شهرًا']];
 for(let n=1;n<=total;n++)options.push([`last-${n}`,n===1?'آخر جرعة':n===2?'آخر جرعتين':`آخر ${n} جرعات`]);
 if(total)options.push(['all','كل الجرعات المسجلة']);
 if(!options.some(([v])=>v===app.botoxTrendScope))app.botoxTrendScope='12m';
 return `<div class="botox-trend-filter"><label for="botox-trend-scope">الفترة المعروضة</label><select id="botox-trend-scope" aria-label="اختر عدد جرعات البوتوكس المعروضة">${options.map(([value,title])=>`<option value="${E(value)}" ${value===app.botoxTrendScope?'selected':''}>${E(title)}</option>`).join('')}</select></div>`;
}
// Monthly headache-DAY average for each injection-to-injection interval.
// This intentionally matches the graph's unit (headache days, not independent
// headache episodes). For the latest injection, only completed days to today
// are included. Historic gaps never become assumed headache-free days.
function botoxDoseAverages(model){
 const visible=[...model.shots].sort();
 return visible.map((start,i)=>{
  const end=visible[i+1]||model.now;
  const facts=botoxInterval(start,end);
  const monthly=facts.sufficient&&facts.dayCount>=14
   ?Math.round((facts.head/facts.dayCount)*300)/10:null;
  return {start,end,...facts,monthly};
 });
}
function botoxAnnualSvg(){
 const model=botoxRollingWindows(),windows=model.windows;
 const controls=botoxTrendScopeControls();
 if(!windows.length)return controls+'<p class="empty">لا توجد فترة مكتملة للرسم بعد.</p>';
 const reliable=windows.filter(w=>w.monitored&&w.fullThirty);
 const displayed=windows.filter(w=>(w.monitored||w.head>0));
 const maxValue=Math.max(5,...displayed.map(w=>w.head));
 const ceiling=Math.ceil(maxValue/5)*5;
 // Keep labels readable on iPhones; long ranges scroll horizontally.
 const W=Math.max(455,windows.length*43+62,model.shots.length*128+62),H=324,L=37,R=15,T=99,B=64,PW=W-L-R,PH=H-T-B;
 const time0=utcDay(model.cutoff),span=Math.max(1,daysBetween(model.cutoff,model.now)),
  xDate=d=>L+(utcDay(d)-time0)/86400000/span*PW,
  x=w=>(xDate(w.start)+xDate(w.end))/2,
  y=v=>T+PH-PH*Math.min(ceiling,v)/ceiling;
 const grid=[0,1,2,3,4].map(k=>{const v=Math.round(ceiling*k/4);
  return `<line x1="${L}" x2="${W-R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--line)"/><text x="${L-8}" y="${(y(v)+4).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="12">${v}</text>`;
 }).join('');
 const points=windows.map((w,i)=>({...w,i,xx:x(w),yy:y(w.head),trusted:w.monitored&&w.fullThirty}));
 const connected=[];
 // Solid continuous trend ONLY between consecutive comparable 30-day windows.
 for(let i=1;i<points.length;i++){
  const a=points[i-1],b=points[i];
  if(a.trusted&&b.trusted){
   connected.push(`<line class="botox-trend-segment" x1="${a.xx.toFixed(1)}" y1="${a.yy.toFixed(1)}" x2="${b.xx.toFixed(1)}" y2="${b.yy.toFixed(1)}" stroke="var(--accent)" stroke-width="3.6" stroke-linecap="round"/>`);
  }else if((a.trusted||a.head>0)&&(b.trusted||b.head>0)){
   // The user can see how successive recorded points change, but a dashed
   // connector explicitly warns that at least one count is incomplete.
   connected.push(`<line class="botox-trend-uncertain" x1="${a.xx.toFixed(1)}" y1="${a.yy.toFixed(1)}" x2="${b.xx.toFixed(1)}" y2="${b.yy.toFixed(1)}" stroke="var(--accent)" stroke-opacity=".55" stroke-width="2.3" stroke-dasharray="3 5" stroke-linecap="round"/>`);
  }
 }
 // A new injection may interrupt a 30-day window by 1–7 days.
 // Link the two complete windows on either side with a DASHED connector,
 // not an invented data point; never bridge historic periods with no diary.
 for(let i=0;i<points.length-2;i++){
  const a=points[i],gap=points[i+1],b=points[i+2];
  const shortDoseRemainder=gap.partial&&gap.rawDays<=7&&gap.head===0&&
     model.shots.some(d=>d===gap.end);
  if(a.trusted&&b.trusted&&shortDoseRemainder){
   connected.push(`<line class="botox-trend-bridge" x1="${a.xx.toFixed(1)}" y1="${a.yy.toFixed(1)}" x2="${b.xx.toFixed(1)}" y2="${b.yy.toFixed(1)}" stroke="var(--accent)" stroke-opacity=".6" stroke-width="2.6" stroke-dasharray="5 5" stroke-linecap="round"><title>ربط توضيحي بين فترتين مكتملتين عبر أيام قصيرة فصلتها جلسة بوتوكس؛ لا توجد قيمة مقاسة للفاصل</title></line>`);
  }
 }
 const dots=points.map(p=>{
  if(!p.monitored&&p.head===0)return '';
  const title=`${p.start} إلى ${plusDays(p.end,-1)}: ${p.head} يوم صداع/شقيقة مسجّل، ${p.logged} يوم فيه تسجيل من ${p.dayCount} يوم مكتمل${p.partial?'، فترة أقل من 30 يومًا':''}`;
  return `<g class="botox-trend-point"><circle cx="${p.xx.toFixed(1)}" cy="${p.yy.toFixed(1)}" r="${p.trusted?5.1:4.7}" fill="${p.trusted?'var(--accent)':'var(--surface)'}" stroke="${p.trusted?'var(--accent)':'var(--muted)'}" stroke-width="2"><title>${E(title)}${p.trusted?'':'، عدد جزئي لا يصلح للمقارنة'}</title></circle><text x="${p.xx.toFixed(1)}" y="${(p.yy-11).toFixed(1)}" fill="${p.trusted?'var(--ink)':'var(--muted)'}" font-size="12" text-anchor="middle" font-weight="700">${p.head}${p.trusted?'':'*'}</text></g>`;
 }).join('');
 // One contextual average banner per actual Botox interval, positioned
 // between the two red dose lines (or from the last dose to today).
 // For a single selected injection this naturally fills the chart width.
 const doseAverages=botoxDoseAverages(model);
 const monthlyBanners=doseAverages.map(c=>{
  const left=xDate(c.start),right=xDate(c.end),width=Math.max(0,right-left);
  if(width<9)return ''; // A same-day/very short course cannot fit a banner.
  const bx=left+3,bw=Math.max(1,width-6),cx=left+width/2;
  const isNarrow=bw<96;
  const value=c.monthly===null?'—':c.monthly.toFixed(1).replace(/\.0$/,'');
  const summary=c.monthly===null?'بيانات غير كافية':`${value} يوم`;
  const explanation=`${c.start} إلى ${plusDays(c.end,-1)}: ${c.head} يوم صداع/شقيقة، ${c.logged} يوم فيه تسجيل من ${c.dayCount} يوم مكتمل. ${c.monthly===null?'لا يمكن حساب متوسط شهري موثوق بعد.':`متوسط ${value} يوم صداع لكل 30 يومًا.`}`;
  const firstLine=isNarrow?'متوسط':'المتوسط / 30 يوم';
  return `<g class="botox-dose-average"><title>${E(explanation)}</title><rect x="${bx.toFixed(1)}" y="11" width="${bw.toFixed(1)}" height="58" rx="9" fill="var(--surface2)" stroke="var(--line)" stroke-width="1.2"/><text x="${cx.toFixed(1)}" y="30" font-size="${isNarrow?11:13}" font-weight="600" fill="var(--muted)" text-anchor="middle">${firstLine}</text><text x="${cx.toFixed(1)}" y="52" font-size="${c.monthly===null?(isNarrow?11:15):(isNarrow?16:20)}" font-weight="750" fill="${c.monthly===null?'var(--muted)':'var(--accent)'}" text-anchor="middle">${E(summary)}</text></g>`;
 }).join('');
 const marks=model.shots.map(d=>{
  const xx=xDate(d);
  return `<g class="botox-injection-mark"><line x1="${xx.toFixed(1)}" y1="${T-2}" x2="${xx.toFixed(1)}" y2="${H-B+2}" stroke="#d64b4b" stroke-dasharray="4 4" stroke-width="1.6" stroke-opacity=".82"/><circle cx="${xx.toFixed(1)}" cy="${T-13}" r="5.8" fill="#d64b4b" stroke="var(--surface)" stroke-width="2"><title>جلسة بوتوكس: ${E(d)}</title></circle></g>`;
 }).join('');
 let lastLabelX=-100;
 const dates=points.map(p=>{
  const displayedWidth=points.length<=16?Math.max(290,Math.min(window.innerWidth-70,600)):W;
  const labelGap=38*Math.max(1,W/displayedWidth);
  if(p.xx-lastLabelX<labelGap)return '';
  lastLabelX=p.xx;
  return `<text x="${p.xx.toFixed(1)}" y="${H-33}" fill="var(--muted)" font-size="11" text-anchor="middle">${E(p.start.slice(5).replace('-','/'))}</text>`;
 }).join('');
 const status=reliable.length;
 const averagesInfo=doseAverages.length?`<details class="botox-dose-average-details"><summary>متوسط كل دورة بالأرقام والتواريخ</summary><div class="botox-dose-average-summary" aria-label="ملخص متوسط أيام الصداع بين جرعات البوتوكس">${doseAverages.map(c=>{const value=c.monthly===null?'بيانات غير كافية':`${c.monthly.toFixed(1).replace(/\.0$/,'')} يوم/30 يوم`;return `<span><b>${E(fmtShort(c.start))}${c.end!==model.now?' – '+E(fmtShort(c.end)):' – اليوم'}:</b> ${E(value)}</span>`;}).join('')}</div></details>`:'';
 const shotLegend=`<div class="botox-chart-legend"><span><i class="botox-chart-dot"></i>تاريخ جرعة البوتوكس</span><span><i class="botox-chart-teal"></i>اتجاه أيام الصداع لكل 30 يومًا</span><span>* فترة جزئية؛ لا نصل فترات المتابعة المفقودة بخط يوحي بوجود بيانات</span></div>`;
 const rangeText=model.scope==='12m'?'آخر 12 شهرًا':model.scope==='all'?'من أول جلسة مسجلة':Number(model.scope.slice(5))===1?'من آخر جرعة':Number(model.scope.slice(5))===2?'من آخر جرعتين':`من تاريخ أقدم جلسة ضمن آخر ${Number(model.scope.slice(5))} جرعات`;
 const table=windows.map(w=>`<tr><td dir="ltr">${E(fmtShort(w.start))} – ${E(fmtShort(plusDays(w.end,-1)))}</td><td>${w.head}</td><td>${w.monitored?(w.fullThirty?'30 يومًا':'جزئية ('+w.dayCount+' يومًا)'):'بيانات غير كافية'}</td></tr>`).join('');
 return `${controls}<p class="mini">${E(rangeText)}: من ${E(fmtShort(model.cutoff))} إلى ${E(fmtShort(model.now))}. كل فترة 30 يومًا تبدأ من يوم الجرعة ويُعاد الحساب عند الجرعة التالية. عدد جلسات البوتوكس الظاهرة: ${model.shots.length}.</p>${shotLegend}<div class="botox-annual-plot" tabindex="0" aria-label="رسم اتجاه الصداع، يمكن سحبه أفقيًا عند عرض جلسات كثيرة"><svg viewBox="0 0 ${W} ${H}" style="width:${windows.length<=16?'100%':`max(100%, ${W}px)`}" role="img" aria-label="خط اتجاه عدد أيام الصداع لكل 30 يومًا مع علامات حمراء لتواريخ الحقن">${grid}${connected.join('')}${dots}${marks}${monthlyBanners}${dates}<text x="${W/2}" y="${H-10}" text-anchor="middle" fill="var(--muted)" font-size="12">بداية فترة الـ30 يومًا (يوم/شهر)</text></svg></div>${averagesInfo}<p class="mini">المستطيل أعلى كل دورة يوضح متوسط <b>أيام الصداع لكل 30 يومًا</b> من تاريخ جرعة إلى الجرعة التالية (أو إلى اليوم إذا كانت آخر جرعة). هذا مقياس لأيام الصداع، وليس عدد النوبات المنفصلة. لا نعرض متوسطًا إذا كانت التغطية التاريخية غير كافية.</p><p class="mini">تظهر الفترة المختارة كاملة عند إمكانية عرضها بوضوح، ويمكن السحب يمينًا ويسارًا للفترات الطويلة. الخط المتصل يربط فترات 30 يومًا القابلة للمقارنة؛ والمتقطع يربط نقاطًا جزئية موثقة أو يتجاوز أيامًا قليلة فصلتها جرعة جديدة. لا نصل فترات بلا بيانات. عدد الفترات الكاملة ذات البيانات الكافية: ${status}.</p><details class="botox-trend-audit"><summary>تفاصيل فترات الـ30 يومًا</summary><div class="botox-table-scroll"><table class="botox-table"><thead><tr><th>الفترة</th><th>أيام الصداع</th><th>حالة البيانات</th></tr></thead><tbody>${table}</tbody></table></div></details><p class="mini">الفترات التاريخية بلا تسجيلات كافية لا تُعرض كصفر صداع. هذا التحليل وصفي ولا يثبت سبب التغير.</p>`;
}
function botoxMonthHtml(m,i){
 const title=['الشهر الأول','الشهر الثاني','الشهر الثالث'][i];
 if(m.end<=m.start)return `<div class="botox-month"><strong>${title}</strong><p class="mini">لم تبدأ هذه الفترة ضمن الدورة الحالية.</p></div>`;
 const percent=Math.max(0,Math.min(100,m.dayCount?m.head/m.dayCount*100:0));
 const rate=m.sufficient?`${m.per28} يوم / 28 يومًا`:'بيانات غير كافية';
 return `<div class="botox-month"><div class="botox-month-title"><strong>${title}</strong><span>${E(fmtShort(m.start))} – ${E(fmtShort(plusDays(m.end,-1)))}</span></div><div class="botox-month-count"><strong>${E(rate)}</strong><small>${m.logged?m.head+' يوم صداع/شقيقة · '+m.migraine+' يوم شقيقة · ':''}${m.logged}/${m.dayCount} يوم فيه تسجيل</small></div><div class="botox-month-track"><span style="width:${m.sufficient?percent:0}%"></span></div>${!m.sufficient?'<p class="mini">لن نعتبر الأيام غير المتابعة خالية من الصداع أو نستنتج تحسنًا من هذه الفترة.</p>':''}</div>`;
}
function botoxTrend(cycle){
 const ms=cycle.months;
 if(!ms.every(x=>x.sufficient))return 'لا يمكن تحديد أفضل شهر أو تراجع المفعول بعد، لأن بيانات الأشهر الثلاثة غير مكتملة.';
 const rates=ms.map(m=>m.per28);
 const min=Math.min(...rates),best=rates.indexOf(min)+1;
 const ending=rates[2]-rates[1];
 const tail=ending>=1?'ارتفع معدل أيام الصداع في الشهر الثالث مقارنة بالثاني؛ قد يستحق النقاش مع الطبيب لاحتمال تراجع الفعالية قرب الموعد.':ending<=-1?'انخفض معدل أيام الصداع في الشهر الثالث مقارنة بالثاني.':'كان معدل أيام الصداع متقاربًا في الشهرين الثاني والثالث.';
 return `أفضل معدل كان في الشهر ${['الأول','الثاني','الثالث'][best-1]}. ${tail} هذه مقارنة وصفية لا تثبت السبب.`;
}
function renderBotox(){
 const sessions=botoxSessions(),last=sessions.at(-1),n=botoxNext(last),today=localDate(now());
 const diff=last?daysBetween(today,n.date):null;
 const headline=!last?'لا توجد جلسة مسجلة':diff>0?`باقي ${diff} يوم`:diff===0?'اليوم موعد الجلسة المتوقع':`تجاوز الموعد المتوقع بـ${Math.abs(diff)} يوم`;
 const reminder=last?`<div class="botox-next"><span>الموعد ${n.confirmed?'المدخل':'المتوقع'} للجلسة القادمة</span><strong>${E(fmtDay(n.date))}</strong><b>${E(headline)}</b><small>${n.confirmed?'تم إدخاله يدويًا':'محسوب من تاريخ آخر جلسة + 3 أشهر تقويمية، وليس موعد حجز مؤكد'}</small></div><div class="botox-progress"><span style="width:${Math.max(0,Math.min(100,Math.round(daysBetween(recordDate(last),today)/Math.max(1,daysBetween(recordDate(last),n.expected))*100)))}%"></span></div>`:'<p class="info">سجل أول جلسة لتظهر مواعيد الجرعات القادمة وتبدأ المقارنات.</p>';
 const appointment=last?`<form id="botox-appointment" class="botox-appointment"><label class="field"><span>موعد الطبيب المؤكد (اختياري)</span><input type="date" name="appointment" value="${n.confirmed?E(n.date):''}" min="${E(recordDate(last))}"></label><button class="btn secondary small" type="submit">حفظ الموعد</button><button class="btn ghost small" type="button" data-botox-reset="1">العودة إلى الموعد المتوقع</button></form><div class="btn-row"><button type="button" class="btn secondary" data-botox-calendar="1">إضافة الموعد للتقويم مع تنبيهات</button></div><p class="mini">تنبيهات التقويم قبل 30 و14 و7 أيام من الموعد. داخل «يومي» يظهر العدّاد عند فتح هذه الصفحة؛ التطبيق لا يرسل إشعارات تلقائية وهو مغلق.</p>`:'';
 const cycles=sessions.map((s,i)=>botoxCycle(s,sessions[i+1]||null));
 const latest=cycles.at(-1);
 const comparisons=cycles.length?cycles.map((cycle,i)=>{
  const r=cycle.overall,label=`الجلسة ${i+1}`;
  const rate=r.sufficient?`${r.per28} يوم / 28`:'غير كافٍ';
  const severe=r.meanSeverity===null?'—':r.meanSeverity+'%';
  const status=r.sufficient?'صالح للمقارنة':`البيانات ${r.logged}/${r.dayCount} يوم`;
  return `<tr><td><button class="botox-link" data-botox-focus="${E(cycle.session.id)}">${E(label)}<small>${E(fmtShort(cycle.start))}</small></button></td><td>${E(rate)}</td><td>${r.migraine}</td><td>${r.acute}</td><td>${severe}<small>${E(status)}</small></td></tr>`;
 }).join(''):'';
 const comparisonNote=cycles.length>1&&cycles.at(-1).overall.sufficient&&cycles.at(-2).overall.sufficient?(()=>{
  const latest=cycles.at(-1).overall,prev=cycles.at(-2).overall,difference=Math.round((latest.per28-prev.per28)*10)/10;
  return `الفرق عن الدورة السابقة: ${difference===0?'دون تغير':difference>0?'زيادة '+difference:'انخفاض '+Math.abs(difference)} يوم صداع أو شقيقة لكل 28 يومًا. هذا لا يثبت أن البوتوكس هو السبب.`;
 })():'المقارنة الموضوعية بين الجلسات تحتاج دورتين على الأقل مع تسجيلات كافية. يمكن عرض الأرقام حتى لو لم تكتمل المقارنة.';
 const details=latest?`<div class="panel" id="botox-current"><h3>تغيّر الأعراض خلال آخر دورة</h3><p class="mini">من ${E(fmtDay(latest.start))} إلى ${E(fmtDay(plusDays(latest.end,-1)))}. معدل أيام الصداع والشقيقة موحّد لكل 28 يومًا للمقارنة العادلة بين الأشهر.</p><div class="botox-months">${latest.months.map(botoxMonthHtml).join('')}${latest.late?`<div class="info">توجد فترة بين الموعد المتوقع والجلسة التالية؛ فيها ${latest.late.head} يوم صداع/شقيقة، وتُعرض منفصلة عن الأشهر الثلاثة الأساسية.</div>`:''}</div><div class="botox-trend">${E(botoxTrend(latest))}</div></div>`:'';
 const past=sessions.length?`<div class="panel"><h3>سجل الجلسات</h3>${[...sessions].reverse().map((s,i)=>`<div class="kv"><div><strong>${E(fmtDay(recordDate(s)))}</strong><small style="display:block">${E(s.dose||'الجرعة غير مسجلة')}</small></div><button class="btn ghost small" data-open="${E(s.id)}">تعديل</button></div>`).join('')}</div>`:'';
 return `<div class="view-title"><div><h1>✣ متابعة البوتوكس</h1><span class="sub">صفحة مستقلة للعلاج الوقائي · دورة كل 3 أشهر تقويمية</span></div></div><div class="panel botox-main"><div class="botox-last"><div><small>آخر جلسة مسجلة</small><strong>${last?E(fmtDay(recordDate(last))):'—'}</strong></div><button class="btn secondary small" data-botox-add="1">+ تسجيل جلسة</button></div>${reminder}${appointment}</div>${sessions.length?`<div class="panel"><h3>مقارنة الاستجابة بين الجلسات</h3><div class="botox-table-scroll"><table class="botox-table"><thead><tr><th>الجلسة</th><th>الصداع/الشقيقة</th><th>أيام الشقيقة</th><th>أيام دواء النوبات</th><th>متوسط أعلى شدة</th></tr></thead><tbody>${comparisons}</tbody></table></div><p class="mini">أيام الشقيقة وأيام استخدام الأدوية المعروضة هي الأعداد المسجلة خلال كل دورة، وقد تكون الدورة الحالية غير مكتملة.</p><p class="info">${E(comparisonNote)}</p></div>${sessions.length?`<div class="panel botox-annual-panel"><h3>اتجاه الصداع بعد جلسات البوتوكس</h3>${botoxAnnualSvg()}</div>`:''}${details}${past}`:''}<div class="panel soft"><h3>كيف نقرأ النتيجة؟</h3><p class="info">نقارن الأيام المسجلة للشقيقة والصداع، وأيام أدوية النوبات، ومتوسط أعلى شدة يومية. إذا ما سجلت صداعًا في يوم تتم متابعته فاليوم سليم حسب إعداداتك، لكن لا نملأ فجوات الأشهر التاريخية بصفر. لا نعرض معدلًا موثوقًا إذا كانت الأيام المكتملة أقل من 14 أو نشاط التسجيل في أقل من نصفها. التراجع قرب موعد الجلسة احتمال يُناقَش مع الطبيب، وليس تشخيصًا آليًا.</p><p class="mini">موعد الأشهر الثلاثة تقويمي للتذكير في التطبيق، بينما توقيت العلاج الفعلي والجرعة يحددهما طبيبك.</p></div>`;
}
function exportBotoxCalendar(){
 const last=botoxSessions().at(-1);if(!last){toast('سجّل جلسة البوتوكس أولًا');return}
 const {date}=botoxNext(last);if(date<localDate(now())){toast('هذا الموعد مضى؛ سجل الجلسة الجديدة أو عدّل الموعد أولاً');return}
 const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
 const start=date.replace(/-/g,''),end=plusDays(date,1).replace(/-/g,'');
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Yawmi//Botox Reminder//AR','CALSCALE:GREGORIAN','BEGIN:VEVENT','UID:botox-'+last.id+'@yawmi.local','DTSTAMP:'+stamp,'DTSTART;VALUE=DATE:'+start,'DTEND;VALUE=DATE:'+end,'SUMMARY:موعد جلسة البوتوكس - تذكير يومي','DESCRIPTION:موعد جلسة البوتوكس في يومي. يرجى تأكيده مع الطبيب.'];
 for(const d of [30,14,7])lines.push('BEGIN:VALARM','ACTION:DISPLAY','DESCRIPTION:تبقى '+d+' يوماً على موعد البوتوكس','TRIGGER:-P'+d+'D','END:VALARM');
 lines.push('END:VEVENT','END:VCALENDAR');output(`yawmi-botox-${date}.ics`,lines.join('\r\n')+'\r\n','text/calendar;charset=utf-8');toast('تم تجهيز ملف التقويم؛ افتحه وأضف الحدث في التقويم');
}
function renderSettings(){const diff=app.settings.lastBackup?Math.floor((now()-new Date(app.settings.lastBackup))/86400000):null,warn=diff===null?'لم تُنشئ نسخة احتياطية بعد':diff>=30?`مر ${diff} يومًا على آخر نسخة احتياطية`:`آخر نسخة احتياطية قبل ${diff} يومًا`;return `<div class="view-title"><div><h1>الإعدادات</h1><span class="sub">الخصوصية والتخصيص · v1.9.1 (تسجيل أسهل)</span></div></div><div class="panel soft"><h3>البيانات على الآيفون</h3><p class="info">كل التسجيلات في قاعدة بيانات الجهاز IndexedDB. لا يوجد حساب أو مزامنة. يجب حفظ نسخ احتياطية خارج التطبيق لتجنب فقدان البيانات عند حذف التطبيق أو بيانات Safari.</p></div><div class="panel"><h3>النسخ الاحتياطي</h3><p class="info">${E(warn)} ${diff===null||diff>=30?'— تذكير هادئ داخل الإعدادات.':''}</p><div class="btn-row"><button class="btn" data-export="json">حفظ JSON</button><button class="btn secondary" data-import="1">استعادة JSON</button></div><p class="mini">تتضمن النسخة السجلات والأدوية والمفضلة والإعدادات. صور RingConn لا تُحفظ.</p></div><div class="panel"><h3>الإدخال والتخصيص</h3><div class="form-grid"><div class="field"><label>حجم الكاسة (مل)</label><input id="cup-setting" type="number" min="1" value="${app.settings.waterCup}"></div><div class="field"><label>حجم القارورة (مل)</label><input id="bottle-setting" type="number" min="1" value="${app.settings.waterBottle}"></div></div><button class="btn secondary small" data-save-settings="1">حفظ الأحجام</button><div class="field"><label>المظهر</label><select id="theme-setting"><option value="system" ${app.settings.theme==='system'?'selected':''}>حسب الجهاز</option><option value="light" ${app.settings.theme==='light'?'selected':''}>فاتح</option><option value="dark" ${app.settings.theme==='dark'?'selected':''}>داكن</option></select></div></div><div class="panel food-settings-panel"><h3>أصناف الأكل الظاهرة في التسجيل</h3><p class="mini">اختر المربعات التي تريد ظهورها. إخفاء صنف لا يحذف تسجيلاته القديمة.</p><div class="food-setting-grid">${allFoodTags().map(tag=>`<label class="food-setting-item"><input type="checkbox" data-food-setting="${E(tag)}" ${activeFoodTags().includes(tag)?'checked':''}><span>${E(tag)}</span></label>`).join('')}</div><div class="food-add-row"><input id="new-food-tag" type="text" maxlength="32" placeholder="أضف صنفًا جديدًا"><button type="button" class="btn secondary small" data-add-food-setting>إضافة</button></div><button type="button" class="btn secondary small" data-save-food-settings>حفظ قائمة الأكل</button></div><div class="panel"><h3>حالة النسخة الأولية</h3><p class="info">منفذ الآن: تسجيلات يومية، صداع ومواقع الرأس، ربط النوبات مبدئيًا، إدخال النوم المختصر، الحفظ المحلي، تقويم، تحليلات أساسية، نسخ JSON، تصدير CSV.</p><p class="info">بحاجة لاستكمال/اختبار: دمج وفصل النوبات يدويًا بواجهة كاملة، استيراد Excel، تحليلات المحفزات المتقدمة، تصدير PDF منسق مخصص، ومزامنة RingConn المباشرة (غير معتمدة).</p></div>`}
// Keep per-tab vertical position, open <details>, and horizontal chart position.
// A rerender (filters, records, tab changes) must not silently collapse panels.
const viewMemory={renderedTab:null,tabs:Object.create(null),generation:0};
function snapshotView(){
 const tab=viewMemory.renderedTab;if(!tab)return;
 const prior=viewMemory.tabs[tab]||{};
 const details=[...view.querySelectorAll('details')].map((el,i)=>({i,open:el.open}));
 const chart=view.querySelector('.severity-scroll');
 const chartX=tab==='analytics'&&chart&&!view.querySelector('.severity-layout')?.classList.contains('is-fit')?chart.scrollLeft:prior.chartX;
 viewMemory.tabs[tab]={...prior,scrollY:window.scrollY||document.documentElement.scrollTop||0,details,chartX};
}
function render(){
 snapshotView();
 const target=app.tab,state=viewMemory.tabs[target];
 view.innerHTML=target==='today'?renderToday():target==='history'?renderHistory():target==='analytics'?renderAnalytics():target==='botox'?renderBotox():renderSettings();
 document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.go===target));
 document.querySelectorAll('.botox-top-btn').forEach(b=>b.classList.toggle('is-active',target==='botox'));
 if(state?.details){const all=view.querySelectorAll('details');for(const d of state.details){if(all[d.i])all[d.i].open=d.open}}
 const chart=target==='analytics'?view.querySelector('.severity-scroll'):null;
 if(chart&&app.severityView==='normal')chart.scrollLeft=state?.chartX??chart.scrollWidth;
 viewMemory.renderedTab=target;
 const id=++viewMemory.generation,restoreY=state?.scrollY??0;
 requestAnimationFrame(()=>{if(id===viewMemory.generation&&app.tab===target)window.scrollTo({top:restoreY,behavior:'instant'})});
}
// --- Input and screenshot workflow ---
function textNumbers(s){return s.replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))}
function normalized(s){return textNumbers(s).trim().toLowerCase().replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه')}
function relativeAt(t){const d=now(),s=normalized(t);const h=s.match(/قبل\s*(\d+)\s*ساع/),m=s.match(/قبل\s*(\d+)\s*دقيق/);if(h)d.setHours(d.getHours()-Number(h[1]));if(m)d.setMinutes(d.getMinutes()-Number(m[1]));return iso(d)}
function parseCommand(value){const raw=value.trim(),s=normalized(raw),at=relativeAt(raw);if(!s)return null;
 // Water words, with count or explicit ml. No implicit consumption of coffee/juice.
 if(/(?:كاس|كوب|قارور|موية|مويه|ماء|مل\b)/.test(s)&& !/قهوه|شاي/.test(s)){
  const numeric=s.match(/(\d+)\s*مل/);if(numeric)return {type:'water',ml:+numeric[1],at};
  const bottle=/قارور/.test(s),unit=bottle?app.settings.waterBottle:app.settings.waterCup;
  const n=s.match(/(\d+)\s*(?:كاس|كوب|قارور)/)||s.match(/(?:كاس|كوب|قارور)\s*(\d+)/);
  const qty=n?+n[1]:/(?:كاستين|كوبين|كاسين|قارورتين)/.test(s)?2:/ثلاث\s*(?:كاسات|اكواب|قوارير)/.test(s)?3:1;
  if(qty<1||qty>20)return {clarify:'كمية الماء غير واضحة'};
  return {type:'water',ml:unit*qty,at};
 }
 const pct=s.match(/(\d{1,3})\s*%/), zero=(pct&&Number(pct[1])===0)||/^(?:اختفي|اختفى|انتهي|راح الصداع|الصداع راح|انتهى)$/i.test(raw.trim())||/اختف[يى]|انته[يى] الصداع/.test(s);
 if(/صداع|شقيقه|ثقل|الجبه|الحاجب|الراس|\b[a-c]\b/i.test(s)||pct||zero){
  const prior=latestHeadache();let loc=[];
  if(/\bA\b/i.test(raw)||/بين الحاجبين|بين الحواجب|جذر الانف/.test(s))loc.push('A');
  if(/\bB\b/i.test(raw)||/الحاجب/.test(s))loc.push(/ايسر|اليسار|شمال/.test(s)?'BL':'BR');
  if(/\bC\b/i.test(raw)||/اعلي الراس|اعلى الراس|فوق الراس|قمه الراس/.test(s))loc.push('C');
  if(/\bF\b/i.test(raw)||/الجبه|منتصف الجبه/.test(s))loc.push('F');
  loc=[...new Set(loc)];if(!zero&&!loc.length){const ongoing=activeEpisode(new Date(at));if(ongoing&&prior?.episodeId===ongoing)loc=prior.spots||[];else return {clarify:'حدد مكان الصداع أو استخدم زر الصداع'}};if(zero)loc=[];
  if(pct&&(+pct[1]>100))return {clarify:'شدة الصداع أكبر من 100%'};
  if(!pct&&!zero)return {clarify:'حدد شدة الصداع بالنسبة المئوية'};
  let kind=/شقيقه/.test(s)?'migraine':/ثقل/.test(s)?'heavy':/صداع/.test(s)?'headache':prior?.kind||'unknown';
  return {type:'headache',severity:zero?0:+pct[1],kind,spots:loc,primary:loc[0]||'',at,...nextHeadLink(new Date(at),zero?0:+pct[1])};
 }
 if(/اخذت|اخدت|اخذ[ت]?|حب[هة]|دواء|حبوب|ابرلفي|اوبرلفي|ubrelvy|panadol/i.test(s)){
  const drug=/ubrelvy|اوبرلفي|ابرلفي/.test(s)?'Ubrelvy':/panadol|بنادول/.test(s)?'Panadol Migraine':'';
  if(!drug)return {clarify:'ما اسم الدواء الذي أخذته؟'};
  const dose=s.match(/(\d+)\s*(?:mg|ملجم|مجم)/i);return {type:'med',name:drug,dose:dose?dose[1]+' mg':'',at,episodeId:activeEpisode(new Date(at))||null};
 }
 if(/قهوه|v60|اسبرسو|لاتيه|امريكانو|شاي|عصير/.test(s)){
  let name=/v60/.test(s)?'V60':/سعود/.test(s)?'قهوة سعودية':/امريكانو/.test(s)?'أمريكانو':/اسبرسو/.test(s)?'إسبريسو':/لاتيه/.test(s)?'لاتيه':/شاي/.test(s)?'شاي':/عصير/.test(s)?'عصير':'';
  if(!name)return {clarify:'ما نوع القهوة أو المشروب؟'};
  return {type:'coffee',name,at,ml:'',caffeine:''};
 }
 if(/اكلت|اتغديت|اتعشيت|فطرت|فطور|غداء|عشاء|سناك|ساندويش|اكل/.test(s)){
  const meal=/فطرت|فطور/.test(s)?'breakfast':/اتغديت|غداء/.test(s)?'lunch':/اتعشيت|عشاء/.test(s)?'dinner':/سناك/.test(s)?'snack':'other';
  const name=raw.replace(/^(اكلت|أكلت|اتغديت|أتغديت|اتعشيت|فطرت|فطور|الغداء|غداء|عشاء|سناك)\s*/i,'').replace(/قبل\s*\d+\s*(?:ساعة|ساعات|دقيقة|دقائق)/g,'').trim();
  if(!name)return {clarify:'وش أكلت؟'};
  return {type:'food',name,meal,at};
 }
 return {type:'note',notes:raw,at,needsConfirmation:true};
}
async function submitText(){const el=$('#quick-text'),s=el.value.trim();if(!s)return;const parsed=parseCommand(s);if(!parsed)return;if(parsed.clarify){openModal('توضيح التسجيل',`<p class="info">${E(parsed.clarify)}</p><p class="panel soft">${E(s)}</p><div class="btn-row"><button class="btn" id="clarify-edit">تسجيل يدوي</button><button class="btn ghost" data-close="modal">إلغاء</button></div>`);$('#clarify-edit').onclick=()=>{closeModal();manualEntry(/دواء|حب|اخذ|ابلرفي|اوبرلفي/.test(normalized(s))?'med':/اكل|اتغدي|فطور/.test(normalized(s))?'food':/قهوه/.test(normalized(s))?'coffee':'headache')};return}if(parsed.needsConfirmation){openModal('هل أحفظها كملاحظة؟',`<p class="panel soft">${E(s)}</p><div class="btn-row"><button class="btn" id="note-save">حفظ ملاحظة</button><button class="btn ghost" data-close="modal">إلغاء</button></div>`);$('#note-save').onclick=async()=>{await persist({id:uid(),...parsed});el.value='';closeModal()};return}el.value='';await persist({id:uid(),...parsed})}
function quickAction(type){if(type==='cup'){quickWater(app.settings.waterCup);return}if(type==='bottle'){quickWater(app.settings.waterBottle);return}if(type==='coffee'){quickCoffee();return}if(type==='med'){chooseQuickMed();return}if(type==='clear'){if(recordsDay(localDate(now())).some(r=>r.type==='headache')){toast('سُجلت أعراض اليوم؛ لا يمكن تأكيده خاليًا منها');return}const existing=recordsDay(localDate(now())).find(r=>r.type==='clear');if(existing)toast('سبق تأكيد اليوم بدون أعراض');else persist({type:'clear',id:uid(),at:iso(now())});return}manualEntry(type)}
async function imageFromClipboard(){if(!navigator.clipboard?.read){toast('اضغط مطولًا داخل خانة الكتابة ثم اختر «لصق»؛ أو استخدم اختيار صورة');$('#image-picker').click();return}try{const items=await navigator.clipboard.read();for(const item of items){const k=item.types.find(t=>t.startsWith('image/'));if(k){await imagePreview(await item.getType(k));return}}toast('لا توجد صورة في الحافظة. جرّب اللصق المطول.') }catch(e){toast('تعذّر الوصول للحافظة. جرّب اللصق المطول.');$('#quick-text').focus()}}
function imagePreview(blob){if(!blob)return;const url=URL.createObjectURL(blob);const html=`<p class="info">تم استقبال الصورة من الحافظة. لن نحفظها داخل سجلك. يمكنك تجربة قراءة النص محليًا ثم مراجعة البيانات قبل الحفظ.</p><img id="ocr-preview" class="screenshot-preview" src="${url}" alt="صورة النوم الملصوقة"><div id="ocr-status" class="mini">محرك قراءة النص تجريبي ويتطلب الإنترنت لتنزيل مكوناته أول مرة.</div><div class="btn-row" style="margin-top:13px"><button id="run-ocr" class="btn">قراءة الصورة</button><button id="manual-sleep" class="btn secondary">إدخال يدوي</button></div>`;openModal('سكرينشوت RingConn',html,()=>{$('#run-ocr').onclick=async()=>{if(app.ocrRunning)return;app.ocrRunning=true;$('#run-ocr').disabled=true;try{const {text,confidence,sections}=await recognizeLocal(blob,x=>{const s=$('#ocr-status');if(s)s.textContent=x});if(!text.trim()){toast('لم نستطع قراءة النص');showSleepReview({},'',blob);return}const parsed=parseSleepOCR({text,sections});showSleepReview(parsed.fields,parsed.rawText,blob,confidence,parsed)}catch(err){showSleepReview({},'',blob);toast(err.message+' — يمكن الإدخال يدويًا')}finally{app.ocrRunning=false}};$('#manual-sleep').onclick=()=>{closeModal();manualEntry('sleep')}});
 // Release temporary URL after preview closes, not before.
 setTimeout(()=>URL.revokeObjectURL(url),300000)
}
function showSleepReview(fields={},raw='',blob=null,confidence=null,parsed=null){
 const f={sleepDate:fields.sleepDate||'',duration:fields.duration||'',bedtime:fields.bedtime||'',wakeTime:fields.wakeTime||'',napStart:fields.napStart||'',napEnd:fields.napEnd||''};
 const names={sleepDate:'التاريخ',duration:'النوم الفعلي',bedtime:'بداية النوم',wakeTime:'نهاية النوم',napStart:'بداية الغفوة',napEnd:'نهاية الغفوة'};
 const evidence=parsed?.evidence||{},warnings=parsed?.warnings||[];
 const extracted=Object.values(f).filter(Boolean).length;
 const badges=Object.entries(f).filter(([,value])=>value).map(([key,value])=>`<div class="mini" style="padding:4px 0"><strong>${E(names[key])}: ${E(value)}</strong> — ${E(evidence[key]||'راجع القيمة')}</div>`).join('');
 const html=`<div class="${extracted>=2?'info':'warning'}">${extracted>=2?`استخرجنا ${extracted} بيانات. راجعها قبل الحفظ.`:extracted===1?'تعرفنا على التاريخ فقط؛ أوقات النوم لم تُستخرج. يمكنك إكمالها يدويًا، وفتح «النص المقروء للمراجعة» لمعرفة أين تعثرت القراءة.':'تعذر قراءة قيم مؤكدة؛ أكملها يدويًا.'}</div>${badges?`<details style="margin:10px 0"><summary class="mini">مصدر كل قيمة</summary>${badges}</details>`:''}${warnings.map(w=>`<p class="warning">${E(w)}</p>`).join('')}<form id="ocr-form">
 ${formField('تاريخ الاستيقاظ','sleepDate','date',f.sleepDate,'required')}
 ${formField('النوم الفعلي من أعلى الصورة (س:د)','duration','text',f.duration,'placeholder="مثال 08:08"')}
 ${formField('بداية النوم الرئيسي','bedtime','time',clockInput(f.bedtime))}
 ${formField('نهاية النوم الرئيسي','wakeTime','time',clockInput(f.wakeTime))}
 <p class="mini">الغفوة تُحفظ منفصلة بالتوقيت، ولا تُجمع ثانيةً مع إجمالي النوم من أعلى الصورة.</p>
 <div class="form-grid">${formField('بداية الغفوة (اختياري)','napStart','time',clockInput(f.napStart))}${formField('نهاية الغفوة (اختياري)','napEnd','time',clockInput(f.napEnd))}</div>
 ${textareaField('ملاحظة اختيارية','notes','')}
 <div class="btn-row"><button class="btn" type="submit">اعتماد وحفظ النوم</button><button class="btn ghost" type="button" data-close="modal">إلغاء</button></div></form>
 ${raw?`<details style="margin-top:12px"><summary class="mini">النص المقروء للمراجعة (لا يُحفظ)</summary><pre style="white-space:pre-wrap;direction:ltr;text-align:left;font-size:11px">${E(raw.slice(0,3000))}</pre></details>`:''}`;
 openModal('مراجعة بيانات النوم',html);
 $('#ocr-form').onsubmit=async e=>{
  e.preventDefault();const v=getForm(e.target);
  if(v.duration&&(!Number.isFinite(duration(v.duration))||duration(v.duration)>1440)){toast('اكتب مدة النوم مثل 08:08');return}
  if(!clockValid(v.bedtime)||!clockValid(v.wakeTime)){toast('راجع وقت بداية النوم ونهايته');return}
  const nm=napMinutes(v.napStart,v.napEnd);
  if(Number.isNaN(nm)){toast('أدخل وقت بداية الغفوة ونهايتها معًا (بحد أقصى 4 ساعات)');return}
  v.nap=nm===null?'':String(nm);
  if(!v.sleepDate){toast('حدد تاريخ الاستيقاظ قبل حفظ النوم');return}
  const previous=app.records.find(x=>x.type==='sleep'&&x.sleepDate===v.sleepDate);
  if(previous&&!confirm('يوجد نوم مسجل بهذا التاريخ. هل تريد تحديثه بدل إضافة تسجيل مكرر؟'))return;
  const R={...previous,id:previous?.id||uid(),type:'sleep',at:atDate(v.sleepDate,'09:00'),sleepDate:v.sleepDate,...v,source:'ringconn',confidence:confidence===null?null:confidence,timeApprox:false};
  delete R.rawText;await persist(R);closeModal();
 };
}
function openEvent(id){const r=app.records.find(x=>x.id===id);if(!r)return;if(r.type==='clear'){openModal('يوم بدون أعراض',`<p class="info">تم تأكيد أن هذا اليوم كان بدون أعراض بالرأس.</p><button class="btn danger" data-delete="${E(id)}">حذف التأكيد</button>`);return}if(r.type!=='headache'){manualEntry(r.type,r);return}const group=sorted(app.records.filter(x=>x.type==='headache'&&x.episodeId===r.episodeId)).reverse();openModal('تفاصيل قراءة الصداع',`<div class="panel soft"><strong>${E(summary(r))}</strong><p class="mini">${E(fmtDay(localDate(r.at)))} — ${E(fmtTime(r.at))}</p><p class="info">${E(r.notes||'')}</p>${r.relation==='possible_return_24h'?'<p class="info">قد تكون عودة للأعراض خلال 24 ساعة؛ هذا سجل مستقل عن النوبة السابقة.</p>':''}</div><h3>القراءات المرتبطة بنفس النوبة</h3>${group.map(x=>`<button class="list-row" data-edit-head="${E(x.id)}"><span class="row-icon">${x.severity}%</span><span class="row-body"><strong>${E(kinds[x.kind]||'غير محدد')}</strong><small>${E(fmtTime(x.at))} — ${E((x.spots||[]).join('+'))}</small></span></button>`).join('')}<div class="btn-row" style="margin-top:10px"><button class="btn secondary" data-edit-head="${E(r.id)}">تعديل القراءة</button><button class="btn ghost" data-split-head="${E(r.id)}">فصل من هذه القراءة</button></div><div class="btn-row" style="margin-top:9px"><button class="btn ghost" data-merge-head="${E(r.id)}">دمج مع نوبة سابقة</button><button class="btn danger" data-delete="${E(r.id)}">حذف القراءة</button></div><p class="mini">0% يغلق فترة الألم. إذا عاد الألم خلال 24 ساعة يُسجّل كنوبة مستقلة مع إشارة إلى عودة محتملة؛ وليس تشخيصًا طبيًا.</p>`)}
async function splitEpisode(id){const r=app.records.find(x=>x.id===id);if(!r)return;const newId=uid();const group=app.records.filter(x=>x.type==='headache'&&x.episodeId===r.episodeId&&new Date(x.at)>=new Date(r.at));if(group.length<1)return;app.undo={kind:'batch',previous:group.map(x=>({...x}))};for(const x of group){x.episodeId=newId;await store.put(x)}closeModal();render();toast('تم فصل النوبة',true)}
async function mergeEpisode(id){const r=app.records.find(x=>x.id===id);if(!r)return;const prior=sorted(app.records.filter(x=>x.type==='headache'&&x.episodeId!==r.episodeId&&new Date(x.at)<new Date(r.at)))[0];if(!prior){toast('لا توجد نوبة سابقة للدمج');return}const group=app.records.filter(x=>x.type==='headache'&&x.episodeId===r.episodeId);app.undo={kind:'batch',previous:group.map(x=>({...x}))};for(const x of group){x.episodeId=prior.episodeId;await store.put(x)}closeModal();render();toast('تم دمج النوبة مع السابقة',true)}
function output(name,contents,mime){const blob=new Blob([contents],{type:mime});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),120000)}
async function backup(){const settings={...app.settings,lastBackup:iso(now())};const payload={format:'DailyHealth-PWA',version:1,createdAt:iso(now()),records:app.records,settings};output(`daily-health-backup-${localDate(now())}.json`,JSON.stringify(payload,null,2),'application/json;charset=utf-8');app.settings.lastBackup=settings.lastBackup;await store.setMeta('settings',settings);render();toast('تم تجهيز النسخة. احفظ الملف في «الملفات» أو iCloud Drive.')}
function validBackup(payload){return payload&&payload.format==='DailyHealth-PWA'&&payload.version===1&&Array.isArray(payload.records)&&payload.records.every(r=>r&&typeof r.id==='string'&&r.id.length<130&&typeof r.type==='string'&&typeof r.at==='string'&&!Number.isNaN(Date.parse(r.at)))&&payload.records.length<150000}
async function receiveBackup(file){try{const p=JSON.parse(await file.text());if(!validBackup(p))throw Error('ملف غير متوافق أو تالف');const exists=new Set(app.records.map(r=>r.id)),n=p.records.filter(r=>!exists.has(r.id)).length,conflicts=p.records.filter(r=>exists.has(r.id)&&JSON.stringify(app.records.find(x=>x.id===r.id))!==JSON.stringify(r)).length;
 openModal('معاينة استعادة البيانات',`<div class="panel soft"><div class="kv"><span>سجلات في الملف</span><b>${p.records.length}</b></div><div class="kv"><span>سجلات جديدة عند الدمج</span><b>${n}</b></div><div class="kv"><span>معرفات لها بيانات مختلفة</span><b>${conflicts}</b></div><p class="mini">الدمج لا يستبدل السجلات المتعارضة؛ يبقي بيانات الجهاز. الاستبدال يحذف جميع البيانات الحالية ويضع بيانات الملف مكانها.</p></div><div class="btn-row"><button class="btn" id="merge-backup">دمج</button><button class="btn danger" id="replace-backup">استبدال كامل</button></div>`);
 $('#merge-backup').onclick=async()=>{const result=await store.mergeAll(p.records);app.records=await store.getAll();closeModal();render();toast(`تمت إضافة ${result.added} سجلات. التعارضات: ${result.conflicts.length}`)};
 $('#replace-backup').onclick=async()=>{if(!confirm('سيُستبدل كامل سجل الجهاز. يُفضّل حفظ نسخة احتياطية أولًا. هل تريد الاستمرار؟'))return;await store.replaceAll(p.records,{settings:p.settings||app.settings});app.records=await store.getAll();app.settings={...app.settings,...p.settings};theme();closeModal();render();toast('تم استبدال البيانات من النسخة الاحتياطية')};
 }catch(e){toast('تعذّر قراءة النسخة: '+e.message)}}
function exportCSV(){const keys=['id','type','at','sleepDate','severity','kind','spots','episodeId','ml','name','dose','duration','timeInBed','bedtime','wakeTime','deep','light','rem','awake','efficiency','nap','caffeine','meal','notes'];const esc=x=>'"'+String(Array.isArray(x)?x.join('|'):x??'').replace(/"/g,'""')+'"';const rows=[keys.join(','),...sorted(app.records).map(r=>keys.map(k=>esc(r[k])).join(','))];output(`daily-health-${localDate(now())}.csv`,'\ufeff'+rows.join('\r\n'),'text/csv;charset=utf-8');toast('تم تجهيز ملف CSV')}
// Doctor-ready, locally generated visit summary. Separate from analysis filters:
// 90 completed calendar days by default; user may choose another interval.
// No personal medical data is uploaded when the report is created or printed.
function doctorReportModel(scope='90'){
 const today=localDate(now());
 const days=lastNDates(scope==='analysis'?app.period:Number(scope)).filter(d=>d<today).sort();
 const inScope=new Set(days);
 const all=app.records.filter(r=>inScope.has(recordDate(r)));
 const clinical=all.filter(r=>r.type!=='botox');
 const activeDates=clinical.map(recordDate).sort();
 const first=activeDates[0]||null;
 // Count only completed days following the first actual diary entry; earlier
 // months with no diary cannot be manufactured as symptom-free.
 const observed=first?days.filter(d=>d>=first):[];
 const within=new Set(observed);
 const records=clinical.filter(r=>within.has(recordDate(r)));
 const recordedDays=new Set(records.map(recordDate));
 const observedCount=observed.length;
 const coverage=observedCount?Math.round(recordedDays.size/observedCount*100):0;
 const plausibleRate=observedCount>=28&&coverage>=50;
 const positives=records.filter(r=>r.type==='headache'&&Number(r.severity)>0);
 const describedDays=new Set(records.filter(documentedHeadNote).map(recordDate));
 const allSymptoms=new Set([...positives.map(recordDate),...describedDays]);
 const headaches=new Set([...positives.filter(r=>['headache','migraine'].includes(r.kind)).map(recordDate),...describedDays]);
 const migraines=new Set(positives.filter(r=>r.kind==='migraine').map(recordDate));
 const otherSymptomDays=new Set([...allSymptoms].filter(d=>!headaches.has(d)));
 const clearCount=Math.max(0,observedCount-allSymptoms.size);
 const severityDays=[...headaches].map(d=>Math.max(0,...positives.filter(r=>recordDate(r)===d).map(r=>Number(r.severity)))).filter(n=>n>0);
 const severityMax=severityDays.length?Math.max(...severityDays):null;
 const meanMax=severityDays.length?Math.round(severityDays.reduce((n,x)=>n+x,0)/severityDays.length):null;
 const episodeKeys=new Set(positives.filter(x=>['headache','migraine'].includes(x.kind)).map(r=>r.episodeId||r.id));
 // Episode duration is only measured when the diary explicitly contains 0%
 // after a known first positive reading in the same episode. Never estimate
 // duration from the absence of further entries.
 const episodeDurations=[];
 for(const key of episodeKeys){
  const entries=app.records.filter(r=>r.type==='headache'&&(r.episodeId||r.id)===key)
   .filter(r=>Number.isFinite(Date.parse(r.at))).sort((a,b)=>new Date(a.at)-new Date(b.at));
  const firstPositive=entries.find(r=>Number(r.severity)>0);
  if(!firstPositive||!within.has(recordDate(firstPositive)))continue;
  const ended=entries.find(r=>Number(r.severity)===0&&new Date(r.at)>new Date(firstPositive.at));
  if(ended)episodeDurations.push(Math.round((new Date(ended.at)-new Date(firstPositive.at))/60000));
 }
 const medications=records.filter(r=>r.type==='med');
 const medDays=new Set(medications.map(recordDate));
 const medResponses=medicationResponseRows({r:medications});
 const medGroups=new Map();
 for(const r of medResponses){
  const name=(r.m.name||'دواء غير محدد').trim();
  const key=normalizedDrugName(name);
  if(!medGroups.has(key))medGroups.set(key,{name,count:0,full:0,partial:0,none:0,pending:0});
  const row=medGroups.get(key);row.count++;row[r.outcome||'pending']++;
 }
 const sleeping=new Map();
 for(const r of records.filter(r=>r.type==='sleep'&&Number.isFinite(duration(r.duration))).sort((a,b)=>new Date(b.updatedAt||b.at)-new Date(a.updatedAt||a.at))){
  if(!sleeping.has(recordDate(r)))sleeping.set(recordDate(r),duration(r.duration));
 }
 const sleepValues=[...sleeping.values()];
 const waterDays=[];
 for(const d of observed){const waters=records.filter(r=>r.type==='water'&&recordDate(r)===d&&r.kind!=='other'&&Number(r.ml)>0);if(waters.length)waterDays.push(waters.reduce((n,r)=>n+Number(r.ml),0));}
 const avg=arr=>arr.length?Math.round(arr.reduce((n,x)=>n+x,0)/arr.length):null;
 const monthly=plausibleRate?Math.round(headaches.size/observedCount*300)/10:null;
 const meanDuration=episodeDurations.length?Math.round(episodeDurations.reduce((sum,n)=>sum+n,0)/episodeDurations.length):null;
 const monthlyMigraine=plausibleRate?Math.round(migraines.size/observedCount*300)/10:null;
 const firstDay=observed[0]||null,lastDay=observed.at(-1)||null;
 // Keep a brief clinical timeline of headache days, not hundreds of rows.
 const recent=[...headaches].sort().reverse().slice(0,8).map(d=>{
  const dayRecords=positives.filter(r=>recordDate(r)===d);
  const hasMigraine=dayRecords.some(r=>r.kind==='migraine');
  const max=dayRecords.length?Math.max(...dayRecords.map(r=>Number(r.severity))):null;
  return {date:d,kind:hasMigraine?'شقيقة':'صداع',maximum:max};
 });
 const sessions=botoxSessions().filter(r=>recordDate(r)<=today);
 const lastSession=sessions.at(-1)||null;
 const next=lastSession?botoxNext(lastSession):null;
 const cycles=sessions.slice(-3).map((r)=>{
  const i=sessions.indexOf(r);
  const cycle=botoxCycle(r,sessions[i+1]||null),start=recordDate(r);
  const bound=cycle.end;
  const bins=[];
  for(let j=0;j<3;j++){
   const from=plusDays(start,j*30),to=plusDays(start,(j+1)*30);
   if(from>=bound)break;
   const result=botoxInterval(from,to<bound?to:bound);
   bins.push({index:j+1,days:result.dayCount,logged:result.logged,sufficient:result.sufficient,rate:result.sufficient?Math.round(result.head/result.dayCount*300)/10:null});
  }
  const overall=cycle.overall;
  return {start,overall,rate:overall.sufficient?Math.round(overall.head/overall.dayCount*300)/10:null,bins,partial:!sessions[i+1]&&today<bound};
 });
 return {scope,days,firstDay,lastDay,selectedStart:days[0]||null,selectedEnd:days.at(-1)||null,observedCount,recordedCount:recordedDays.size,coverage,plausibleRate,headacheCount:headaches.size,migraineCount:migraines.size,allSymptomCount:allSymptoms.size,otherSymptomCount:otherSymptomDays.size,clearCount,meanMax,severityMax,episodeCount:episodeKeys.size,meanDuration,resolvedEpisodeCount:episodeDurations.length,medCount:medications.length,medDayCount:medDays.size,medGroups:[...medGroups.values()].sort((a,b)=>b.count-a.count),sleepAvg:avg(sleepValues),sleepCount:sleepValues.length,waterAvg:avg(waterDays),waterCount:waterDays.length,monthly,monthlyMigraine,recent,lastSession,next,cycles,descriptionCount:describedDays.size};
}
function reportMetric(label,value,detail=''){
 return `<div class="dr-metric"><span>${E(label)}</span><strong>${E(value)}</strong>${detail?`<small>${E(detail)}</small>`:''}</div>`;
}
function doctorReportHtml(m){
 const n=v=>v===null?'غير كافٍ':String(v);
 const period=m.selectedStart?`${E(fmtShort(m.selectedStart))} – ${E(fmtShort(m.selectedEnd))}`:'لا توجد أيام مكتملة';
 const tracking=m.firstDay?`${E(fmtShort(m.firstDay))} – ${E(fmtShort(m.lastDay))}`:'لا توجد بيانات يومية في الفترة';
 const monthlyNote=m.plausibleRate?'تقدير موحّد لكل 30 يومًا، وليس عدد نوبات منفصلة':'لا يُعرض المعدل الشهري قبل وجود 28 يوم متابعة وبيانات في نصف أيامها على الأقل';
 const drugs=m.medGroups.length?m.medGroups.map(g=>`<tr><td>${E(g.name)}</td><td>${g.count}</td><td>${g.full}</td><td>${g.partial}</td><td>${g.none}</td><td>${g.pending||'—'}</td></tr>`).join(''):'<tr><td colspan="6">لا توجد جرعات مسجلة في الفترة.</td></tr>';
 const botox=m.lastSession?`<div class="dr-botox-lead"><b>آخر جلسة:</b> ${E(fmtDay(recordDate(m.lastSession)))} ${m.lastSession.dose?'· الجرعة المسجلة: '+E(m.lastSession.dose):'· كمية الجرعة غير مدونة'}<br><b>الجلسة القادمة:</b> ${E(fmtDay(m.next.date))} <span>(${m.next.confirmed?'موعد أدخله المستخدم':'تقديري بعد 3 أشهر تقويمية، غير مؤكد'})</span></div>
  <table class="dr-table"><thead><tr><th>تاريخ الجلسة</th><th>أول 30 يومًا</th><th>ثاني 30 يومًا</th><th>ثالث 30 يومًا</th><th>متوسط الدورة</th></tr></thead><tbody>${m.cycles.map(c=>`<tr><td>${E(fmtShort(c.start))}${c.partial?'<small>دورة جارية</small>':''}</td>${[0,1,2].map(i=>`<td>${c.bins[i]?c.bins[i].rate===null?'—':E(c.bins[i].rate+' يوم'):'—'}</td>`).join('')}<td>${c.rate===null?'—':E(c.rate+' يوم')}</td></tr>`).join('')}</tbody></table><p class="dr-caption">أيام الصداع والشقيقة لكل 30 يومًا بعد كل حقنة، وليس عدد النوبات. «—» يعني بيانات غير كافية أو فترة لم تكتمل. مقارنة الجلسات وصفية ولا تثبت سبب التحسن أو التراجع.</p>`:'<p class="dr-muted">لا توجد جلسة بوتوكس مسجلة.</p>';
 const timeline=m.recent.length?`<table class="dr-table dr-timeline"><thead><tr><th>اليوم</th><th>التصنيف</th><th>أعلى شدة مسجلة</th></tr></thead><tbody>${m.recent.map(x=>`<tr><td>${E(fmtShort(x.date))}</td><td>${E(x.kind)}</td><td>${x.maximum===null?'موثق وصفيًا':E(x.maximum+'%')}</td></tr>`).join('')}</tbody></table>`:'<p class="dr-muted">لم تُسجّل أيام صداع أو شقيقة في الجزء المتاح من هذه الفترة.</p>';
 return `<article class="doctor-report" lang="ar" dir="rtl">
 <header class="dr-header"><div><small>يومي · سجل صحي شخصي</small><h2>ملخص الصداع والشقيقة للطبيب</h2><p>تقرير متابعة ذاتية يساعد في مراجعة العلاج الوقائي وعلاج النوبات</p></div><div class="dr-generated">تاريخ الإنشاء<br><b>${E(fmtDay(localDate(now())))}</b></div></header>
 <div class="dr-period"><b>الفترة المطلوبة:</b> ${period}<span>بداية المتابعة اليومية المرصودة: ${tracking}</span></div>
 <section class="dr-section"><h3>1. المؤشرات الأساسية</h3><div class="dr-grid">
 ${reportMetric('أيام الصداع والشقيقة',m.headacheCount,'في الأيام المكتملة المرصودة')}
 ${reportMetric('أيام الشقيقة تحديدًا',m.migraineCount)}
 ${reportMetric('أيام جميع أعراض الرأس',m.allSymptomCount,'تشمل الثقل والأعراض غير المصنّفة')}
 ${reportMetric('أيام بدون أعراض',m.firstDay?m.clearCount:'—','بعد بداية المتابعة فقط')}
 ${reportMetric('أيام الصداع / 30 يومًا',m.monthly===null?'—':m.monthly,'معدل تقديري مشروط بكفاية البيانات')}
 ${reportMetric('متوسط أعلى شدة في يوم الصداع',m.meanMax===null?'—':m.meanMax+'%','أعلى شدة مسجلة: '+(m.severityMax===null?'—':m.severityMax+'%'))}
 </div><p class="dr-caption">${E(monthlyNote)}. النوبات المستقلة التي تحمل معرّفًا في السجل: ${m.episodeCount}؛ هذا العدد يعتمد على ربط المستخدم للقراءات وقد لا يعكس عدد النوبات سريريًا. متوسط مدة النوبات التي سُجّل انتهاؤها صراحةً: <b>${m.meanDuration===null?'—':E(fmtDuration(m.meanDuration))+' ساعة:دقيقة'}</b> (${m.resolvedEpisodeCount} نوبات لها بداية ونهاية موثقتان). لا نقدّر مدة النوبات التي لم يُسجّل انتهاؤها.</p>
 <div class="dr-quality"><b>جودة التغطية:</b> ${m.observedCount?`${m.recordedCount} يومًا فيه تسجيل من أصل ${m.observedCount} يومًا مكتملًا بعد بدء التتبع (${m.coverage}%).`:'لا تتوفر متابعة يومية للفترة المطلوبة.'} ${m.coverage<50?'تغطية غير كافية لاستنتاج معدل الصداع الشهري أو تأكيد استقرار الأعراض.':'اليوم دون تسجيل صداع يُعد خاليًا من الصداع وفق طريقة متابعة المستخدم، خلال فترة التتبع النشط فقط.'} ${m.descriptionCount?'بعض أيام الصداع موثقة وصفياً بدون شدة رقمية.':''}</div>
 </section>
 <section class="dr-section"><h3>2. استخدام أدوية النوبات والاستجابة المسجّلة</h3><p class="dr-summary">أيام استخدام دواء للنوبات: <b>${m.medDayCount}</b> · عدد الجرعات المسجلة: <b>${m.medCount}</b></p><table class="dr-table"><thead><tr><th>الدواء</th><th>جرعات</th><th>اختفاء</th><th>تحسن جزئي</th><th>لا تحسن مسجّل</th><th>قيد الانتظار</th></tr></thead><tbody>${drugs}</tbody></table><p class="dr-caption">الاستجابة محسوبة خلال <b>150 دقيقة</b> من كل جرعة وفق تسجيلات الشدة أو ملاحظة تحسن صريحة. «لا تحسن مسجّل» لا يعني فشل الدواء طبيًا، والتحسن بعد الجرعة لا يثبت السببية. تُقيّم الجرعة الثانية بصورة مستقلة.</p></section>
 <section class="dr-section"><h3>3. متابعة البوتوكس الوقائي</h3>${botox}</section>
 <section class="dr-section"><h3>4. أحدث أيام الصداع والشقيقة</h3>${timeline}</section>
 <section class="dr-section"><h3>5. معلومات مساعدة ونقاط للنقاش</h3><div class="dr-grid dr-grid-small">${reportMetric('متوسط النوم المسجّل',m.sleepAvg===null?'—':fmtDuration(m.sleepAvg),'من '+m.sleepCount+' يوم نوم مسجّل')}${reportMetric('متوسط الماء المسجّل',m.waterAvg===null?'—':m.waterAvg+' مل','من '+m.waterCount+' يوم شرب ماء مسجّل')}</div><p class="dr-caption">متوسط النوم والماء يعتمد فقط على الأيام التي تحتوي تسجيلات؛ لا يُفترض أن اليوم غير المسجل يساوي صفرًا. هذه الأرقام لا تثبت وجود محفّز للصداع.</p><div class="dr-discussion"><b>يُستكمل مع الطبيب:</b> هل تراجع أثر البوتوكس قرب موعد الجلسة؟ هل تغيرت القدرة على العمل والنشاط؟ هل توجد آثار جانبية للحقن؟ هل توجد حاجة لمراجعة أدوية النوبات أو خطة الوقاية؟<br><span>HIT-6، أثر الصداع على الأداء، والآثار الجانبية لا تُعرض كقيم لأن التطبيق لا يملك قياسًا موحدًا مسجلًا لها.</span></div></section>
 <footer class="dr-footer">تقرير شخصي مستخرج محليًا من «يومي» وليس ملفًا طبيًا معتمدًا أو تشخيصًا. التاريخ والأوقات كما سجلها المستخدم، وبعض السجلات قد تكون تقريبية أو مسترجعة. <b>لا تُفسّر الفجوات التاريخية على أنها غياب للصداع.</b></footer>
 </article>`;
}
function doctorReportCopyText(m){
 const d=m.selectedStart?`${m.selectedStart} إلى ${m.selectedEnd}`:'لا توجد فترة مكتملة';
 const lines=[`ملخص «يومي» لمراجعة طبيب الأعصاب — ${d}`,`الأيام المرصودة: ${m.observedCount}، أيام فيها تسجيل: ${m.recordedCount} (${m.coverage}%).`,`أيام الصداع والشقيقة: ${m.headacheCount}؛ أيام الشقيقة: ${m.migraineCount}؛ جميع أعراض الرأس: ${m.allSymptomCount}.`,`أيام خالية من أعراض الرأس بعد بدء المتابعة: ${m.firstDay?m.clearCount:'غير متاح'}.`,`أيام الصداع لكل 30 يومًا: ${m.monthly===null?'بيانات غير كافية':m.monthly}.`,`متوسط أعلى شدة: ${m.meanMax===null?'غير متاح':m.meanMax+'%'}، أعلى شدة: ${m.severityMax===null?'غير متاح':m.severityMax+'%'}.`,`متوسط مدة النوبات المكتملة التسجيل: ${m.meanDuration===null?'غير متاح':fmtDuration(m.meanDuration)} (${m.resolvedEpisodeCount} نوبات).`,`أيام أدوية النوبات: ${m.medDayCount}، جرعات مسجلة: ${m.medCount}.`,...m.medGroups.map(g=>`${g.name}: ${g.count} جرعات؛ اختفاء كامل ${g.full}، تحسن جزئي ${g.partial}، بدون تحسن مسجل ${g.none}، قيد الانتظار ${g.pending}.`),m.lastSession?`آخر بوتوكس: ${recordDate(m.lastSession)}. القادم ${m.next.date} (${m.next.confirmed?'مدخل يدويًا':'تقديري'}).`:'لا توجد جلسة بوتوكس مسجلة.',...m.cycles.map(c=>`جلسة ${c.start}: ${c.bins.map(b=>`الفترة ${b.index}: ${b.rate===null?'بيانات غير كافية':b.rate+' يوم صداع / 30 يومًا'}`).join('، ')}.`),`متوسط النوم المسجل: ${m.sleepAvg===null?'—':fmtDuration(m.sleepAvg)}؛ متوسط الماء المسجل: ${m.waterAvg===null?'—':m.waterAvg+' مل'}.`,'التقييم الذاتي للدواء خلال 150 دقيقة. عدم تسجيل تحسن ليس إثباتًا لعدم فعالية الدواء. الفجوات التاريخية لا تعني أيامًا سليمة.'];
 return lines.join('\n');
}
function doctorReportPrintStyles(){return `@page{size:A4;margin:13mm}*{box-sizing:border-box}body{margin:0;background:#fff;color:#20333d;font:12px/1.65 Arial,Tahoma,sans-serif;direction:rtl} .doctor-report{max-width:none;margin:0;padding:0}.dr-header{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #227b85;padding-bottom:12px;align-items:start}.dr-header h2{font-size:20px;margin:0 0 3px}.dr-header small,.dr-header p,.dr-generated{color:#506975;margin:0}.dr-generated{min-width:145px;text-align:left;font-size:10px}.dr-period{padding:10px 12px;background:#eff6f7;margin:12px 0;border-radius:8px}.dr-period span{display:block;color:#607681}.dr-section{margin:14px 0;break-inside:avoid-page;page-break-inside:avoid}.dr-section h3{font-size:14px;border-bottom:1px solid #d5e3e6;padding-bottom:4px;margin:0 0 9px}.dr-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.dr-grid-small{grid-template-columns:repeat(2,minmax(0,1fr))}.dr-metric{padding:9px;border:1px solid #d3e2e5;border-radius:7px;min-width:0}.dr-metric span,.dr-metric small{display:block;color:#607681;font-size:10px}.dr-metric strong{display:block;font-size:18px;line-height:1.3;margin:4px 0}.dr-caption{font-size:10px;line-height:1.6;color:#586b72;margin:7px 0}.dr-quality,.dr-discussion{background:#f0f6f7;padding:9px;border-radius:6px;font-size:11px}.dr-discussion span{color:#5b6d76}.dr-table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:10px}.dr-table th{background:#e8f2f4}.dr-table th,.dr-table td{border:1px solid #d7e1e4;padding:5px 4px;text-align:right;overflow-wrap:anywhere}.dr-table small{display:block;color:#607681}.dr-summary{font-size:11px}.dr-botox-lead{font-size:11px;margin-bottom:7px}.dr-botox-lead span{color:#677782}.dr-muted,.dr-footer{font-size:10px;color:#61747c}.dr-footer{padding-top:8px;border-top:1px solid #cfdee0;margin-top:12px}.dr-timeline{max-width:100%}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}`;}
function doctorReport(){
 const periodOptions=[['90','آخر 90 يومًا (افتراضيًا)'],['30','آخر 30 يومًا'],['180','آخر 180 يومًا'],['365','آخر 365 يومًا'],['analysis','حسب فترة التحليل الحالية']];
 openModal('تقرير الطبيب',`<div class="dr-report-controls"><label class="field"><span>فترة تقرير الزيارة</span><select id="doctor-report-period">${periodOptions.map(([k,label])=>`<option value="${k}">${label}</option>`).join('')}</select></label><p class="mini">التقرير يُعد محليًا من بياناتك، ويُحدّث عند تغيير الفترة دون تعديل أي سجل.</p></div><div id="medical-report"></div><div class="dr-report-actions"><button class="btn" id="print-report" type="button">طباعة / حفظ PDF</button><button class="btn secondary" id="copy-report" type="button">نسخ الملخص</button></div>`,()=>{
  let model=doctorReportModel('90');
  const refresh=()=>{model=doctorReportModel($('#doctor-report-period').value);$('#medical-report').innerHTML=doctorReportHtml(model)};
  $('#doctor-report-period').addEventListener('change',refresh);
  refresh();
  $('#copy-report').onclick=async()=>{
   const text=doctorReportCopyText(model);
   try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);toast('تم نسخ ملخص الطبيب');return;}}catch(e){}
   // Older iOS PWA versions may block clipboard; show selectable text.
   openModal('ملخص الطبيب للنسخ',`<textarea rows="14" class="dr-copy-area" readonly>${E(text)}</textarea><p class="mini">اضغط مطولًا على النص ثم اختر تحديد الكل والنسخ.</p>`);
  };
  $('#print-report').onclick=()=>{
   const html=doctorReportHtml(model);
   // Opening directly from the click keeps mobile Safari's popup restrictions happy.
   const printWindow=window.open('','_blank');
   if(!printWindow){toast('اسمح بفتح نافذة الطباعة من Safari');return;}
   printWindow.document.open();
   printWindow.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>تقرير يومي للطبيب - ${E(localDate(now()))}</title><style>${doctorReportPrintStyles()}</style></head><body>${html}<script>window.addEventListener('load',()=>{setTimeout(()=>window.print(),350)});<\/script></body></html>`);
   printWindow.document.close();
  };
 });
}
function setTab(tab){
 if(tab===app.tab){window.scrollTo({top:0,behavior:'instant'});const memory=viewMemory.tabs[tab];if(memory)memory.scrollY=0;return}
 app.tab=tab;render();
}
function bind(){
 document.addEventListener('click',async e=>{
  const go=e.target.closest('[data-go]');if(go){setTab(go.dataset.go);return}
  const addFood=e.target.closest('[data-add-food-setting]');if(addFood){
   const input=$('#new-food-tag'),name=input?.value.trim().replace(/[،,|]/g,' ').slice(0,32);
   if(!name){toast('اكتب اسم الصنف أولًا');return}if(allFoodTags().includes(name)){toast('الصنف موجود');return}
   const enabled=Array.from(document.querySelectorAll('[data-food-setting]:checked')).map(x=>x.dataset.foodSetting);
   app.settings.customFoodTags=[...(app.settings.customFoodTags||[]),name];app.settings.foodTags=[...enabled,name];
   await store.setMeta('settings',app.settings);render();toast('تمت إضافة الصنف');return;
  }
  const saveFood=e.target.closest('[data-save-food-settings]');if(saveFood){
   app.settings.foodTags=Array.from(document.querySelectorAll('[data-food-setting]:checked')).map(x=>x.dataset.foodSetting);
   await store.setMeta('settings',app.settings);toast('تم حفظ أصناف الأكل');return;
  }
  if(e.target.closest('[data-close]')){closeModal();return}
  if(e.target.closest('[data-botox-add]')){manualEntry('botox');return}
  if(e.target.closest('[data-botox-calendar]')){exportBotoxCalendar();return}
  if(e.target.closest('[data-botox-reset]')){
   app.settings.botoxAppointment='';app.settings.botoxAppointmentFor='';
   await store.setMeta('settings',app.settings);render();toast('تم اعتماد الموعد التقديري');return;
  }
  const focus=e.target.closest('[data-botox-focus]');if(focus){view.querySelector('#botox-current')?.scrollIntoView({behavior:'smooth'});return}
  const quickMed=e.target.closest('[data-quick-med]');if(quickMed){saveQuickMed(quickMed.dataset.quickMed);return}
   const quick=e.target.closest('[data-quick]');if(quick){quickAction(quick.dataset.quick);return}
  const edit=e.target.closest('[data-open]');if(edit){openEvent(edit.dataset.open);return}
  const del=e.target.closest('[data-delete]');if(del){if(confirm('حذف هذا التسجيل؟'))await erase(del.dataset.delete);return}
  const edh=e.target.closest('[data-edit-head]');if(edh){const r=app.records.find(x=>x.id===edh.dataset.editHead);if(r)headModal(r);return}
  const spl=e.target.closest('[data-split-head]');if(spl){await splitEpisode(spl.dataset.splitHead);return}
  const mer=e.target.closest('[data-merge-head]');if(mer){await mergeEpisode(mer.dataset.mergeHead);return}
  const filter=e.target.closest('[data-filter]');if(filter){app.filter=filter.dataset.filter;render();return}
  const shift=e.target.closest('[data-period-shift]');if(shift){app.periodOffset=Math.max(0,app.periodOffset+Number(shift.dataset.periodShift));render();return}
  const period=e.target.closest('[data-period]');if(period){
    if(period.dataset.period==='custom'&&(!app.customStart||!app.customEnd)){
      const end=previousCompleteDay();app.customEnd=end;app.customStart=shiftLocalDate(end,-29);
    }
    app.period=/^\d+$/.test(period.dataset.period)?Number(period.dataset.period):period.dataset.period;app.periodOffset=0;render();return}
  const analysisMode=e.target.closest('[data-analysis-mode]');if(analysisMode){app.analysisMode=analysisMode.dataset.analysisMode;render();return}
  const sev=e.target.closest('[data-severity-view]');if(sev){
    const next=sev.dataset.severityView;
    if(next!==app.severityView){
      // Capture previous normal-mode scroll before switching to Fit.
      snapshotView();app.severityView=next;render();
    }
    return;
  }
  const jump=e.target.closest('[data-chart-jump]');if(jump){
    const d=jump.dataset.chartJump;
    if(app.severityView==='fit'){snapshotView();app.severityView='normal';render()}
    const plot=view.querySelector('.severity-scroll'),target=[...view.querySelectorAll('[data-chart-day]')].find(x=>x.dataset.chartDay===d);
    if(plot&&target){plot.scrollTo({left:Math.max(0,target.offsetLeft-plot.clientWidth/2+target.clientWidth/2),behavior:'smooth'});view.querySelectorAll('.severity-day').forEach(x=>x.classList.toggle('severity-focused',x===target))}
    return;
  }
  const chart=e.target.closest('[data-chart-day]');if(chart){const date=chart.dataset.chartDay;const rows=app.records.filter(r=>r.type==='headache'&&Number(r.severity)>0&&recordDate(r)===date);const mx=rows.length?Math.max(...rows.map(r=>Number(r.severity)||0)):0;const st=dayHeadStatus(date),described=dayHasDescriptiveHead(date);const label=rows.some(r=>r.kind==='migraine')?'شقيقة':rows.some(r=>r.kind==='headache')||described?'صداع':rows.some(r=>r.kind==='heavy')?'ثقل':rows.length?'غير محدد':'';openModal('تفاصيل شدة الصداع',`<div class="panel soft"><strong>${E(fmtDay(date))}</strong>${label?`<p>نوع الحالة: <strong>${E(label)}</strong></p>`:''}<p>${rows.length?'أقصى شدة مسجلة خلال اليوم: '+mx+'%':described?'صداع موثق وصفياً — الشدة الرقمية غير مسجلة':st==='unknown'?'لا توجد بيانات مؤكدة':'0% — يوم بدون أعراض (مؤكد أو مفترض)'}</p><p class="mini">${rows.map(r=>E(kinds[r.kind])+' '+r.severity+'%').join(' · ')}</p></div>`);return}
  const d=e.target.closest('[data-date]');if(d){app.date=d.dataset.date;render();return}
  const mon=e.target.closest('[data-month]');if(mon){moveMonth(+mon.dataset.month);return}
  const added=e.target.closest('[data-add-at-date]');if(added){openModal('إضافة إلى '+fmtShort(added.dataset.addAtDate),`<div class="quick-grid">${['headache','water','sleep','coffee','food','med','note'].map(x=>`<button class="quick-btn" data-past-type="${x}" data-past-date="${added.dataset.addAtDate}"><span class="q-ic">${icons[x]}</span><span>${types[x]}</span></button>`).join('')}</div>`);return}
  const past=e.target.closest('[data-past-type]');if(past){app.entryDate=past.dataset.pastDate;manualEntry(past.dataset.pastType);return}
  if(e.target.closest('[data-export="json"]')){await backup();return}
  if(e.target.closest('[data-export="csv"]')){exportCSV();return}
  if(e.target.closest('[data-import]')){$('#json-picker').click();return}
  if(e.target.closest('[data-pick-image]')){$('#image-picker').click();return}
  if(e.target.closest('[data-report]')){doctorReport();return}
  if(e.target.closest('[data-save-settings]')){const cup=+$('#cup-setting').value,bottle=+$('#bottle-setting').value;if(cup<=0||bottle<=0){toast('حدد كمية أكبر من صفر');return}app.settings.waterCup=cup;app.settings.waterBottle=bottle;await store.setMeta('settings',app.settings);render();toast('تم حفظ الأحجام');return}
 });
 document.addEventListener('submit',async e=>{
  if(e.target.id!=='botox-appointment')return;
  e.preventDefault();
  const last=botoxSessions().at(-1);if(!last)return;
  const date=e.target.elements.appointment.value;
  if(!/^\d{4}-\d\d-\d\d$/.test(date)||date<recordDate(last)){toast('اختر موعدًا صحيحًا بعد آخر جلسة');return}
  app.settings.botoxAppointment=date;app.settings.botoxAppointmentFor=last.id;
  await store.setMeta('settings',app.settings);render();toast('حُفظ الموعد في هذا الجهاز');
 });
 document.addEventListener('change',e=>{
   if(e.target.id==='botox-trend-scope'){app.botoxTrendScope=e.target.value;render();return}
   if(e.target.id!=='analysis-start'&&e.target.id!=='analysis-end')return;
   const start=(e.target.id==='analysis-start'?e.target.value:document.querySelector('#analysis-start')?.value)||'';
   const end=(e.target.id==='analysis-end'?e.target.value:document.querySelector('#analysis-end')?.value)||'';
   if(!start||!end||start>end){toast('تأكد أن تاريخ البداية يسبق أو يساوي تاريخ النهاية');return}
   const diff=(new Date(end+'T12:00:00')-new Date(start+'T12:00:00'))/86400000;
   if(diff>1461){toast('الحد الأقصى للفترة المحددة هو أربع سنوات');return}
   app.customStart=start;app.customEnd=end;app.period='custom';app.periodOffset=0;render();
 });
 document.addEventListener('input',e=>{if(e.target.id==='search-field'){const pos=e.target.selectionStart;app.search=e.target.value;const match=recordsDay(app.date).filter(r=>(app.filter==='all'||r.type===app.filter)&&(!app.search||summary(r).toLowerCase().includes(app.search.toLowerCase())||(r.notes||'').toLowerCase().includes(app.search.toLowerCase())));const title=document.querySelector('.section-title');const following=title?.nextElementSibling;let el=following;while(el){const next=el.nextElementSibling;el.remove();el=next}if(title)title.insertAdjacentHTML('afterend',match.length?match.map(eventRow).join(''):'<div class="empty">لا توجد نتائج مطابقة.</div>')}});
 document.addEventListener('change',async e=>{if(e.target.id==='exclude-incomplete'){app.settings.excludeIncompleteDays=e.target.checked;await store.setMeta('settings',app.settings);render();return}if(e.target.id==='theme-setting'){app.settings.theme=e.target.value;theme();await store.setMeta('settings',app.settings)}if(e.target.dataset.analyticConfig){const key=e.target.dataset.analyticConfig,mins={sleepHours:4,waterMl:200,timingMinutes:15,routineDeviation:30,wakeTolerance:15},maxs={sleepHours:12,waterMl:5000,timingMinutes:240,routineDeviation:240,wakeTolerance:180},n=Number(e.target.value);if(!Number.isFinite(n)||n<mins[key]||n>maxs[key]){toast('القيمة خارج النطاق المقبول');return}app.settings.analytics={...analysisConfig(),[key]:n};await store.setMeta('settings',app.settings);render();toast('تم تحديث معيار المقارنة')}});
 $('#json-picker').onchange=e=>{const f=e.target.files?.[0];if(f)receiveBackup(f);e.target.value=''};
 $('#theme-btn').onclick=async()=>{app.settings.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';theme();await store.setMeta('settings',app.settings)};
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!layer.hidden)closeModal()});
}
async function main(){try{app.records=await store.getAll();app.settings={...app.settings,...await store.getMeta('settings',{})};$('#save-status').textContent='✓ محفوظ محليًا'}catch(e){$('#save-status').textContent='خطأ في التخزين';toast('التخزين المحلي غير متاح. افتح التطبيق عبر HTTPS أو localhost.')}
 theme();bind();render();if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost'))navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
main();
