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
const app={lastWaterTap:{ml:0,time:0},records:[],tab:'today',date:localDate(now()),month:localDate(now()).slice(0,7),period:30,analysisMode:'all_symptoms',settings:{theme:'system',waterCup:200,waterBottle:330,lastBackup:null},previewImage:null,editing:null,undo:null,filter:'all',search:'',toastTimer:null,ocrRunning:false};
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
function openModal(title,html,onReady=()=>{}){$('#modal-title').textContent=title;$('#modal-body').innerHTML=html;layer.hidden=false;document.body.style.overflow='hidden';onReady()}
function closeModal(){layer.hidden=true;document.body.style.overflow=''}
function formField(label,name,type='text',value='',extra=''){return `<div class="field"><label for="f-${E(name)}">${E(label)}</label><input id="f-${E(name)}" name="${E(name)}" type="${E(type)}" value="${E(value)}" ${extra}></div>`}
function selField(label,name,opts,value){return `<div class="field"><label for="f-${E(name)}">${E(label)}</label><select id="f-${E(name)}" name="${E(name)}">${opts.map(([v,t])=>`<option value="${E(v)}" ${String(value)===String(v)?'selected':''}>${E(t)}</option>`).join('')}</select></div>`}
function textareaField(label,name,value){return `<div class="field"><label for="f-${E(name)}">${E(label)}</label><textarea id="f-${E(name)}" name="${E(name)}">${E(value)}</textarea></div>`}
function getForm(form){return Object.fromEntries(new FormData(form).entries())}
function rTime(r){return asDateTime(r?.at||(app.entryDate?atDate(app.entryDate,'12:00'):now()))}
function intV(v){return Number.isFinite(+v)?+v:0}
function modalButtons(edit){return `<div class="btn-row"><button class="btn" type="submit">${edit?'حفظ التعديل':'حفظ'}</button><button class="btn ghost" type="button" data-close="modal">إلغاء</button></div>${edit?`<button class="btn danger small" style="margin-top:14px" type="button" data-delete="${E(edit.id)}">حذف التسجيل</button>`:''}`}
function manualEntry(type,edit=null){
 const r=edit||{},base=`${formField('وقت الحدث','at','datetime-local',rTime(r))}`,notes=textareaField('ملاحظة (اختياري)','notes',r.notes||'');let html='';
 if(type==='water')html=`${formField('الكمية بالمل','ml','number',r.ml||app.settings.waterCup,'min="1" step="1"')}${base}${notes}`;
 else if(type==='coffee')html=`${selField('النوع','name',['V60','قهوة سعودية','أمريكانو','إسبريسو','لاتيه','شاي','مشروب طاقة','عصير','مشروب آخر'].map(x=>[x,x]),r.name||'V60')}${formField('الحجم (مل) — اختياري','ml','number',r.ml||'', 'min="0"')}${formField('الكافيين (mg) — اختياري','caffeine','number',r.caffeine||'', 'min="0"')}${base}${selField('دقة وقت المشروب','timePrecision',[['confirmed','الوقت مؤكد'],['approximate','الوقت تقريبي']],r.timeApprox===true?'approximate':'confirmed')}${notes}`;
 else if(type==='food')html=`${formField('الوجبة أو الأصناف','name','text',r.name||'', 'required')}${selField('التصنيف','meal',[['breakfast','فطور'],['lunch','غداء'],['dinner','عشاء'],['snack','سناك'],['other','أخرى']],r.meal||'other')}${base}${selField('دقة وقت الوجبة','timePrecision',[['confirmed','الوقت مؤكد'],['approximate','الوقت تقريبي']],r.timeApprox===true?'approximate':'confirmed')}<p class="mini">حتى يدخل وقت الوجبة في مقارنة «الفطور بعد الاستيقاظ»، اختر التصنيف «فطور» وأكّد وقت الوجبة.</p>${notes}`;
 else if(type==='med')html=`${formField('اسم الدواء','name','text',r.name||'Ubrelvy', 'required')}${formField('الجرعة','dose','text',r.dose||'100 mg')}${base}${notes}`;
 else if(type==='sleep')html=`${formField('تاريخ الاستيقاظ','sleepDate','date',r.sleepDate||app.entryDate||localDate(now()),'required')}${formField('النوم الفعلي — Total Time Asleep (س:د)','duration','text',r.duration||'', 'placeholder="مثال: 08:08"')}${formField('بداية النوم الرئيسي','bedtime','time',clockInput(r.bedtime))}${formField('نهاية النوم الرئيسي','wakeTime','time',clockInput(r.wakeTime))}${selField('دقة بداية ونهاية النوم','timePrecision',[['confirmed','الأوقات مؤكدة'],['approximate','الأوقات تقريبية']],r.timeApprox===true?'approximate':'confirmed')}<p class="mini">الغفوة منفصلة بالتوقيت، ولا تُضاف مرة ثانية إلى مدة النوم الفعلي التي تظهر أعلى RingConn.</p><div class="form-grid">${formField('بداية الغفوة (اختياري)','napStart','time',clockInput(r.napStart))}${formField('نهاية الغفوة (اختياري)','napEnd','time',clockInput(r.napEnd))}</div>${notes}`;
 else if(type==='note')html=`${textareaField('الملاحظة','notes',r.notes||'')}${base}`;
 else if(type==='botox')html=`${formField('اسم العلاج الوقائي','name','text',r.name||'Botox')}${formField('الجرعة (اختياري)','dose','text',r.dose||'')}${base}${notes}`;
 else if(type==='headache')return headModal(edit);
 else return;
 openModal(edit?'تعديل '+types[type]:'إضافة '+types[type],`<form id="entry-form" data-entry="${E(type)}">${html}${modalButtons(edit)}</form>`);
 const form=$('#entry-form');app.entryDate=null;form.addEventListener('submit',async e=>{e.preventDefault();const v=getForm(form);if(type==='sleep'&&v.duration&&Number.isNaN(duration(v.duration))){toast('مدة النوم تحتاج صيغة مثل 06:38');return}if(type==='sleep'){if(!clockValid(v.bedtime)||!clockValid(v.wakeTime)){toast('راجع بداية ونهاية النوم');return}const nm=napMinutes(v.napStart,v.napEnd);if(Number.isNaN(nm)){toast('سجل بداية الغفوة ونهايتها معًا (بحد أقصى 4 ساعات)');return}v.nap=nm===null?(r.nap||''):String(nm);}const newR={...r,...v,type,at:type==='sleep'?atDate(v.sleepDate,'09:00'):iso(new Date(v.at)),id:r.id||uid()};if(['food','coffee','sleep'].includes(type)){newR.timeApprox=v.timePrecision==='approximate';delete newR.timePrecision;}if(type==='med'&&!r.id)newR.episodeId=activeEpisode(new Date(newR.at));if(type==='sleep'){newR.sleepDate=v.sleepDate;newR.source=r.source||'self-report';delete newR.atField;if(!r.id){const previous=app.records.find(x=>x.type==='sleep'&&x.sleepDate===v.sleepDate);if(previous){if(!confirm('يوجد تسجيل نوم لهذا اليوم. هل تريد تحديثه بدل إضافة تسجيل مكرر؟'))return;newR.id=previous.id}}}if(type==='water')newR.ml=+v.ml;if(type==='coffee'){newR.ml=v.ml===''?'':+v.ml;newR.caffeine=v.caffeine===''?'':+v.caffeine}await persist(newR);closeModal()});
}
function zonesSVG(selected){const c=id=>selected.includes(id)?'var(--accent)':'var(--muted)';const o=id=>selected.includes(id)?'.38':'.10';const point=(id,x,y,rad,label)=>`<g data-zone="${id}" class="head-point" style="cursor:pointer"><circle cx="${x}" cy="${y}" r="${rad}" fill="${c(id)}" fill-opacity="${o(id)}" stroke="${c(id)}" stroke-width="2"/><text x="${x}" y="${y+4}" font-size="12" text-anchor="middle" fill="currentColor">${label}</text></g>`;return `<div class="head-map"><svg viewBox="0 0 320 182" role="img" aria-label="رسم الرأس من الأمام والأعلى"><ellipse cx="84" cy="87" rx="55" ry="76" fill="none" stroke="currentColor" opacity=".35"/><path d="M42 94 Q56 83 71 94 M96 94 Q110 83 125 94 M81 101 L75 118 L88 118 M67 138 Q84 148 102 138" fill="none" stroke="currentColor" opacity=".33" stroke-width="2"/><ellipse cx="237" cy="86" rx="58" ry="69" fill="none" stroke="currentColor" opacity=".35"/><path d="M237 19 V154 M179 86 H295" stroke="currentColor" opacity=".16" stroke-dasharray="5 4"/>${point('A',84,111,11,'A')}${point('BR',59,86,12,'B')}${point('BL',108,86,12,'B')}${point('F',84,58,16,'F')}${point('C',237,86,23,'C')}<text x="84" y="179" text-anchor="middle" font-size="11" fill="currentColor">من الأمام</text><text x="237" y="168" text-anchor="middle" font-size="11" fill="currentColor">من الأعلى</text></svg></div>`}
function headModal(edit=null){const r=edit||{},chosen=new Set(Number(r.severity)===0?[]:(r.spots||['C']));let html=`<form id="head-form">${selField('نوع الحالة','kind',Object.entries(kinds),r.kind||'unknown')}<div class="field"><label for="f-severity">الشدة: <strong id="severity-out">${r.severity??8}%</strong></label><input id="f-severity" name="severity" type="range" min="0" max="100" value="${r.severity??8}" step="1"></div><p id="zero-tip" class="info" hidden>✅ انتهى الصداع: لا تحتاج تحديد مكان للألم عند تسجيل 0%.</p><div id="location-wrap"><label class="mini">أماكن الألم (يمكن تحديد أكثر من مكان)</label><div id="map-content"></div><div id="zones" class="zone-buttons"></div><div class="field"><label>الموقع الأقوى (اختياري)</label><select id="f-primary" name="primary"></select></div></div>${baseTime(edit)}${notesField(r)}${modalButtons(edit)}</form>`;
 openModal(edit?'تعديل قراءة الصداع':'تسجيل الصداع',html);app.entryDate=null;
 const zones=()=>{const selected=[...chosen];$('#map-content').innerHTML=zonesSVG(selected);$('#zones').innerHTML=Object.entries(spots).map(([id,label])=>`<button type="button" class="zone-btn ${chosen.has(id)?'active':''}" data-zone="${id}">${E(label)}</button>`).join('');$('#f-primary').innerHTML=`<option value="">غير محدد</option>`+selected.map(id=>`<option value="${id}" ${(r.primary||'C')===id?'selected':''}>${E(spots[id])}</option>`).join('')};zones();const updateZeroView=()=>{const zero=Number($('#f-severity').value)===0;$('#location-wrap').hidden=zero;$('#zero-tip').hidden=!zero;if(zero){chosen.clear();zones()}};updateZeroView();
 $('#head-form').addEventListener('click',e=>{const el=e.target.closest('[data-zone]');if(!el)return;const id=el.dataset.zone;chosen.has(id)?chosen.delete(id):chosen.add(id);zones()});
 $('#f-severity').oninput=e=>{$('#severity-out').textContent=e.target.value+'%';updateZeroView()};
 $('#head-form').onsubmit=async e=>{e.preventDefault();const v=getForm(e.target);if(+v.severity>0&&!chosen.size){toast('حدد مكان الألم أو اختر موقع آخر');return}const at=iso(new Date(v.at));const link=r.id?{episodeId:r.episodeId}:nextHeadLink(new Date(at),+v.severity);const newR={...r,...link,type:'headache',id:r.id||uid(),at,kind:v.kind,severity:+v.severity,spots:+v.severity===0?[]:[...chosen],primary:+v.severity===0?'':(chosen.has(v.primary)?v.primary:[...chosen][0]),notes:v.notes,episodeId:link.episodeId||r.episodeId};await persist(newR);closeModal()}
}
function baseTime(r){return formField('وقت القياس','at','datetime-local',rTime(r))}
function notesField(r){return textareaField('ملاحظات اختيارية','notes',r.notes||'')}
function quickWater(ml){const t=Date.now();if(app.lastWaterTap.ml===ml&&t-app.lastWaterTap.time<550)return;app.lastWaterTap={ml,time:t};persist({id:uid(),type:'water',at:iso(now()),ml,notes:''})}
function summary(r){switch(r.type){case 'water':return `ماء — ${r.ml} مل`;case 'coffee':return `${r.name||'مشروب'}${r.ml?' — '+r.ml+' مل':''}`;case 'food':return r.name||'وجبة';case 'med':return `${r.name||'دواء'}${r.dose?' '+r.dose:''}`;case 'sleep':return `نوم ${r.duration||'—'}${r.source==='ringconn'?' — RingConn':''}${r.napStart&&r.napEnd?' · غفوة '+r.napStart+'–'+r.napEnd:''}`;case 'headache':return Number(r.severity)===0?'انتهى الصداع — 0%':`${kinds[r.kind]||'أعراض الرأس'} ${r.severity}% — ${(r.spots||[]).map(s=>s==='O'?'أخرى':s).join(' + ')}`;case 'clear':return 'يوم بدون أعراض (مؤكد)';case 'note':return r.notes||'ملاحظة';case 'botox':return `${r.name||'علاج وقائي'} ${r.dose||''}`;default:return r.type}}
function detail(r){if(r.type==='sleep')return `تاريخ الاستيقاظ ${r.sleepDate}`;if(r.type==='headache'&&r.episodeId)return `${fmtTime(r.at)} · ${Number(r.severity)===0?'انتهى الألم':(r.relation==='possible_return_24h'?'عودة محتملة (نوبة مستقلة)':kinds[r.kind])}`;return fmtTime(r.at)}
function eventRow(r){return `<button class="list-row" data-open="${E(r.id)}"><span class="row-icon">${icons[r.type]||'•'}</span><span class="row-body"><strong>${E(summary(r))}</strong><small>${E(detail(r))}</small></span><span class="row-arrow">‹</span></button>`}
function renderToday(){const d=localDate(now()),v=valuesDay(d),h=v.current;return `<div class="view-title"><div><h1>يومي</h1><span class="sub">${E(fmtDay(d))}</span></div><span class="pill">محلي وخاص</span></div><div class="cards"><div class="stat"><span class="stat-name"><span class="symbol">◌</span>أعراض الرأس</span><b>${h?h.severity+'%':'—'}</b><span class="hint">${h?(Number(h.severity)===0?'انتهى الألم':E(kinds[h.kind]||'آخر قياس')):'لا توجد قراءة اليوم'}</span></div><div class="stat"><span class="stat-name"><span class="symbol">◉</span>الماء</span><b>${v.water.toLocaleString('en-US')}</b><span class="hint">مل مسجل اليوم</span></div><div class="stat"><span class="stat-name"><span class="symbol">☾</span>النوم</span><b>${E(v.sleep?.duration||'—')}</b><span class="hint">النوم الفعلي</span></div><div class="stat"><span class="stat-name"><span class="symbol">♨</span>القهوة والمشروبات</span><b>${v.coffee.length}</b><span class="hint">مرات مسجلة</span></div></div><div class="section-title"><strong>إضافة سريعة</strong></div><div class="quick-grid"><button class="quick-btn" data-quick="cup"><span class="q-ic">◉</span><span>كاسة</span></button><button class="quick-btn" data-quick="bottle"><span class="q-ic">◉</span><span>قارورة</span></button><button class="quick-btn" data-quick="headache"><span class="q-ic">◌</span><span>صداع</span></button><button class="quick-btn" data-quick="coffee"><span class="q-ic">♨</span><span>قهوة</span></button><button class="quick-btn" data-quick="food"><span class="q-ic">▤</span><span>أكل</span></button><button class="quick-btn" data-quick="med"><span class="q-ic">✚</span><span>دواء</span></button></div><div class="section-title"><strong>آخر الأحداث</strong><button class="btn ghost small" data-go="history">السجل ‹</button></div>${v.records.length?v.records.slice(0,7).map(eventRow).join(''):'<div class="empty">ما فيه تسجيلات لليوم بعد. ابدأ بكاسة ماء أو سجل أي ملاحظة.</div>'}<div class="section-title"><strong>خيارات إضافية</strong></div><div class="btn-row"><button class="btn secondary small" data-quick="sleep">☾ تسجيل النوم</button><button class="btn secondary small" data-quick="clear">✓ يوم بدون أعراض</button><button class="btn ghost small" data-quick="note">✎ ملاحظة</button><button class="btn ghost small" data-quick="botox">✣ علاج وقائي</button></div>`}
function moveMonth(delta){const [y,m]=app.month.split('-').map(Number);const d=new Date(y,m-1+delta,1);app.month=localDate(d).slice(0,7);app.date=`${app.month}-01`;render()}
function calendar(){const [y,m]=app.month.split('-').map(Number),first=new Date(y,m-1,1).getDay(),length=new Date(y,m,0).getDate(),prefix=first,suffix=(7-(prefix+length)%7)%7,rows=[];for(let i=0;i<prefix;i++)rows.push('<span></span>');for(let i=1;i<=length;i++){const date=`${app.month}-${String(i).padStart(2,'0')}`,has=app.records.some(r=>recordDate(r)===date),sel=app.date===date;rows.push(`<button data-date="${date}" class="${sel?'selected':''} ${has?'has':''}">${i}</button>`)}for(let i=0;i<suffix;i++)rows.push('<span></span>');return `<div class="panel"><div class="calendar-header"><button class="btn ghost small" data-month="-1">›</button><strong>${new Date(y,m-1,14).toLocaleDateString('ar-SA',{month:'long',year:'numeric',calendar:'gregory'})}</strong><button class="btn ghost small" data-month="1">‹</button></div><div class="cal">${['أحد','إثن','ثلا','أرب','خمي','جمع','سبت'].map(x=>`<span class="dow">${x}</span>`).join('')}${rows.join('')}</div></div>`}
function renderHistory(){const records=recordsDay(app.date).filter(r=>(app.filter==='all'||r.type===app.filter)&&(!app.search||summary(r).toLowerCase().includes(app.search.toLowerCase())||(r.notes||'').toLowerCase().includes(app.search.toLowerCase())));return `<div class="view-title"><div><h1>السجل</h1><span class="sub">التقويم والأحداث والتعديل</span></div></div>${calendar()}<div class="field"><label>بحث في تسجيلات اليوم</label><input id="search-field" type="search" value="${E(app.search)}" placeholder="Ubrelvy أو V60 أو كلمة في الملاحظات"></div><div class="segmented" id="history-filters">${[['all','الكل'],['headache','الرأس'],['water','الماء'],['med','الأدوية'],['sleep','النوم'],['food','الطعام']].map(([k,v])=>`<button data-filter="${k}" class="${app.filter===k?'active':''}">${v}</button>`).join('')}</div><div class="section-title"><strong>${E(fmtDay(app.date))}</strong><button class="btn secondary small" data-add-at-date="${app.date}">+ إضافة</button></div>${records.length?records.map(eventRow).join(''):'<div class="empty">لا توجد نتائج مطابقة في هذا اليوم.</div>'}`}
// A calendar period uses all dates; historic-year and all-data views include only
// recorded dates so a 2024/2026 gap cannot create invented zero-headache days.
function lastNDates(n){
 if(n==='all'||/^year-\d{4}$/.test(String(n))){
  const year=String(n).startsWith('year-')?String(n).slice(5):null;
  return [...new Set(app.records.map(recordDate).filter(d=>!year||d.startsWith(year+'-')))].filter(d=>d<=localDate(now())).sort((a,b)=>b.localeCompare(a));
 }
 const days=[],count=Number(n)||30;
 for(let i=0;i<count;i++){const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()-i);days.push(localDate(d))}
 return days;
}
function getAnalytics(){
 const days=lastNDates(app.period),r=app.records.filter(x=>days.includes(recordDate(x)));
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
 return `${legend}<div class="severity-layout"><div class="severity-y">${labels}</div><div class="severity-scroll" dir="ltr"><div class="severity-plot" style="--days:${visible.length}">${dayBars}</div></div></div>${chips}<p class="mini">لون العمود يوضح نوع الحالة المسجلة في ذلك اليوم، وارتفاعه يوضح أعلى شدة من كل القراءات. إذا سُجلت شقيقة وصداع في اليوم نفسه يظهر بلون الشقيقة ويُحسب اليوم مرة واحدة. اضغط التاريخ أو العمود للتفاصيل.</p>`;
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
 // A 0% record alone is a recovery marker, not a confirmed symptom-free day.
 if(group.some(r=>r.type==='clear'))return 'confirmed_clear';
 if(day>=today)return 'unknown';
 if(group.some(r=>r.type==='headache'))return 'unknown';
 // Only consider a carry-over within 24h of the midnight boundary.
 // An unresolved historical episode from months/years ago must not block all
 // subsequent days from being considered symptom-free.
 const beginning=dayStart(day),prior=sorted(app.records.filter(r=>r.type==='headache'&&new Date(r.at).getTime()<beginning))[0];
 if(prior&&Number(prior.severity)>0&&beginning-new Date(prior.at).getTime()<=86400000)return 'unknown';
 const hasRoutine=group.some(r=>['water','food','coffee','sleep'].includes(r.type));
 return hasRoutine?'inferred_clear':'unknown';
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
 const coffee=records.filter(isCoffee),foods=records.filter(x=>x.type==='food'&&x.meal==='breakfast');
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
 const events=factor==='breakfast'?r.filter(x=>x.type==='food'&&x.meal==='breakfast'):r.filter(isCoffee);
 if(!events.length)return factor==='breakfast'?(r.some(x=>x.type==='food')?'يوجد طعام لكنه غير مصنّف «فطور»':'لا توجد وجبة بتصنيف «فطور»'):'لا توجد قهوة مصنّفة كقهوة';
 const exact=events.filter(accurateAt);
 if(!exact.length)return factor==='breakfast'?'وقت الفطور ما زال معلّمًا بأنه تقريبي':'وقت أول قهوة ما زال معلّمًا بأنه تقريبي';
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
 const allHead=episodes.filter(ep=>ep.ms>=start&&ep.ms<end);
 const positive=app.records.some(r=>r.type==='headache'&&Number(r.severity)>0&&new Date(r.at)>=start&&new Date(r.at)<end);
 if(positive)return 'symptoms';
 if(allHead.some(ep=>!ep.valid))return 'unknown';
 const first=localDate(new Date(start)),last=localDate(new Date(end-1));
 // Require records in both calendar portions of the observation window;
 // don't infer a symptom-free period from an entirely blank diary. A headache
 // later on the same calendar date (after this window) does NOT disqualify it.
 // Numeric or descriptive symptoms with uncertain time on either touched date
 // prevent us from calling this a clean control window.
 const touched=[first,last];
 if(touched.some(d=>app.records.some(r=>recordDate(r)===d&&r.source==='retrospective-2024-diary')))return 'unknown';
 if(touched.some(d=>app.records.some(r=>recordDate(r)===d&&documentedHeadNote(r))))return 'unknown';
 const observed=touched.every(d=>app.records.some(r=>recordDate(r)===d&&(['water','food','coffee','sleep','clear'].includes(r.type))));
 return observed?'clear':'unknown';
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
 const lower=[];
 for(const day of a.days){
  const anchor=new Date(day+'T12:00:00').getTime();
  if(anchor+WATER_DAY>Date.now())continue;
  if(!Number.isFinite(anchor))continue;
  const start=anchor-WATER_DAY,finish=anchor+WATER_DAY;
  const water=water24Events(start,anchor);
  if(water.status!=='measured')continue;
  if(water24StatusForWindow(start,anchor,episodes)!=='clear')continue;
  // If an episode began before the observation window but an active reading
  // remains, don't count that continuation as a new onset or as a control.
  const futureReadings=app.records.filter(r=>r.type==='headache'&&Number(r.severity)>0&&new Date(r.at)>=anchor&&new Date(r.at)<finish);
  const futureStarts=episodes.filter(ep=>ep.ms>=anchor&&ep.ms<finish);
  const otherSymptoms=futureReadings.some(r=>r.kind==='unknown'||(app.analysisMode==='all_symptoms'?false:r.kind==='heavy'));
  const historicalUnknown=futureReadings.some(r=>!accurateAt(r));
  const target=futureStarts.some(ep=>ep.target&&ep.valid);
  const anyNonTarget=futureReadings.length&&!target;
  let outcome=null;
  if(historicalUnknown||otherSymptoms||anyNonTarget)outcome=null;
  else if(target)outcome=1;
  else if(water24StatusForWindow(anchor,finish,episodes)==='clear')outcome=0;
  if(outcome===null)continue;
  lower.push({day,water:water.water,low:water.water<cfg.waterMl,outcome});
 }
 const grouped=[lower.filter(x=>x.low),lower.filter(x=>!x.low)].map(rows=>({n:rows.length,head:rows.filter(x=>x.outcome===1).length,rate:rows.length?Math.round(100*rows.filter(x=>x.outcome===1).length/rows.length):null}));
 const [low,high]=grouped;
 const cases=lower.filter(x=>x.outcome===1).length,controls=lower.length-cases;
 const enough=low.n>=5&&high.n>=5&&cases>=5&&controls>=5;
 const difference=low.rate!==null&&high.rate!==null?low.rate-high.rate:null;
 const riskIndex=enough&&difference!==null&&Math.abs(difference)>=20?(difference>0?0:1):-1;
 return {upper,upperMeasured,upperLow,upperHigh,grouped,lower,enough,riskIndex,threshold:cfg.waterMl,excluded:upper.length-upperMeasured.length};
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
 return `<details class="routine-item water24-lower" open><summary>الماء — قبل النوبات بـ24 ساعة <small>${w.lower.length} فترات صالحة</small></summary><p class="mini">من منظور الروتين: نسجل ماء الـ24 ساعة المنتهية عند 12 ظهرًا، ثم نتابع ظهور نوبة جديدة خلال الـ24 ساعة التالية. الفترات بدون ماء مسجّل أو متابعة كافية تُستبعد. ويُعتمد وقت كل تسجيل ماء حتى لو كان تقديريًا.</p><div class="compare-grid">${half(low,0)}${half(high,1)}</div><div class="routine-conclusion">${E(desc)}</div><p class="mini">فترات اليوم الواحد قد تتداخل مع فترات مجاورة؛ النسب استكشافية. الماء المسجّل ليس بالضرورة كامل ما شربته، ولا يُعتبر غياب تسجيل ماء شربًا بصفر مل.</p></details>`;
}

function comparisonModel(a){
 const cfg=analysisConfig(),rows=analyticsRows(a);
 // Crucially this cohort is independent of the selected symptom filter.
 const eligibleAll=rows.filter(hasKnownOutcome);
 const definitions=[
  {id:'sleep',title:'مدة النوم',note:'النوم الفعلي في ليلة الاستيقاظ؛ لا نعتمد القيلولة ضمن هذه المدة',groups:[`أقل من ${cfg.sleepHours} ساعات`,`${cfg.sleepHours} ساعات فأكثر`],summaryGroups:[`نوم أقل من ${cfg.sleepHours} ساعات`,`نوم ${cfg.sleepHours} ساعات فأكثر`],get:r=>r.sleep===null?null:(r.sleep<cfg.sleepHours*60?0:1)},
  {id:'coffee',title:'عدد مرات القهوة',note:'تسجيلات القهوة فقط؛ عدم تسجيل قهوة لا يعني عدم شربها',groups:['مرة واحدة','مرتان فأكثر'],summaryGroups:['قهوة واحدة','قهوتان فأكثر'],get:r=>r.coffee===null?null:(r.coffee===1?0:1)},
  {id:'breakfast',title:'الفطور بعد الاستيقاظ',note:'وقت الفطور والاستيقاظ مؤكدان. إذا لم يُعرف وقت الصداع، فهذه مقارنة تزامن خلال اليوم وليست دليلًا أن الفطور سبقه',groups:[`خلال ${cfg.timingMinutes} دقيقة`,`بعد ${cfg.timingMinutes} دقيقة`],summaryGroups:[`فطور خلال ${cfg.timingMinutes} دقيقة من الاستيقاظ`,`فطور بعد ${cfg.timingMinutes} دقيقة من الاستيقاظ`],get:r=>r.breakfastDelay===null?null:(r.breakfastDelay<=cfg.timingMinutes?0:1)},
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
  const timingDetails=['breakfast','coffeeTime'].includes(def.id)?rows.filter(r=>r.records.some(x=>x.type==='sleep'||(def.id==='breakfast'?x.type==='food'&&x.meal==='breakfast':isCoffee(x)))).map(r=>({day:r.day,reason:r.kind==='unknown'?(r.day===localDate(now())?'اليوم الحالي لم ينتهِ؛ يُفحص بعد اكتماله':'حالة الصداع أو خلو اليوم منه غير محددة، لذلك لا يدخل في المقارنة'):timingDayReason(r,def.id==='breakfast'?'breakfast':'coffeeTime')})).sort((a,b)=>b.day.localeCompare(a.day)):[];
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
 if(!model.recurring.length)return `<div class="panel"><h3>ما الذي تكرر مع الصداع؟</h3><div class="empty">نحتاج أيام أعراض أكثر مع بيانات روتين حتى نعرض نمطًا متكررًا (3 أيام على الأقل).</div><p class="mini">وجود عامل في أيام الصداع وحده لا يعني أنه سببه. لا تُعتبر الأيام غير المسجلة أيامًا سليمة.</p></div>`;
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
 return `<div class="panel"><h3>هل ${model.mode==='all_symptoms'?'أعراض الرأس':'الصداع والشقيقة'} أكثر مع هذا الروتين؟</h3><p class="mini">عدد الأيام المسجلة لكل مجموعة ثابت عند تبديل الفلتر. نسبة الصداع تعتمد فقط على الأيام ذات الحالة المعروفة. في وضع «الصداع والشقيقة» تُستبعد أيام «غير محدد» من النسبة، ولا تُعامل كأيام سليمة.</p>${water24LowerHtml(water24)}${model.result.map(f=>{
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
 }).join('')}<p class="mini">${E(heavyContext)} مذكرات 2024 الانتقائية لا تُستخدم لتقدير معدل الأعراض. غياب تسجيل القهوة لا يعني عدم شربها، ولا تُستخدم الأوقات التقريبية في مقارنة التوقيت. إذا لم يُعرف وقت بداية الصداع فالعلاقة تزامن في اليوم نفسه فقط، وليس دليلًا على السبب.</p></div>`;
}
function analyticsSettingsHtml(){const c=analysisConfig();return `<details class="panel analytic-settings"><summary>تعديل حدود المقارنة (اختياري)</summary><div class="form-grid">${[['sleepHours','النوم (ساعة)',c.sleepHours,4,12],['waterMl','الماء (مل)',c.waterMl,200,5000],['timingMinutes','بعد الاستيقاظ (دقيقة)',c.timingMinutes,15,240],['routineDeviation','تغيّر الروتين (دقيقة)',c.routineDeviation,30,240],['wakeTolerance','تغيّر الاستيقاظ (دقيقة)',c.wakeTolerance,15,180]].map(([key,title,val,min,max])=>`<label class="field"><span>${title}</span><input type="number" data-analytic-config="${key}" min="${min}" max="${max}" step="${key==='waterMl'?100:5}" value="${val}"></label>`).join('')}</div><p class="mini">تُطبّق التغييرات مباشرة بعد مغادرة الخانة، ولا تغيّر السجلات الأصلية.</p></details>`}
function renderAnalytics(){
 const a=getAnalytics(),model=comparisonModel(a),water24=water24Model(a),clearDays=a.days.filter(d=>['confirmed_clear','inferred_clear'].includes(dayHeadStatus(d))).length;
 const symptomOnly=model.rows.filter(x=>x.kind==='symptoms_only').length;
 const avgWater=a.waterDays.length?Math.round(a.waterDays.reduce((s,x)=>s+x.sum,0)/a.waterDays.length):null;
 const sleepAvg=a.sleep.length?fmtDuration(Math.round(a.sleep.reduce((n,s)=>n+duration(s.duration),0)/a.sleep.length)):null;
 return `<div class="view-title"><div><h1>التحليل</h1><span class="sub">اعرف الروتينات المرتبطة بالصداع بسرعة</span></div></div>
 <div class="segmented">${[[7,'7 أيام'],[30,'30 يوم'],[90,'90 يوم'],['year-2026','2026'],['year-2024','2024'],['all','الكل']].map(([n,v])=>`<button data-period="${n}" class="${app.period===n?'active':''}">${v}</button>`).join('')}</div><div class="analysis-scope"><span>احتساب الأعراض في المقارنات</span><div class="segmented">${[['all_symptoms','كل أعراض الرأس'],['headache_only','الصداع والشقيقة فقط']].map(([k,v])=>`<button data-analysis-mode="${k}" class="${app.analysisMode===k?'active':''}">${v}</button>`).join('')}</div></div>
 <div class="card-grid" style="margin-top:14px"><div class="metric"><span>أيام الصداع والشقيقة</span><b>${a.headacheDays.size}</b></div><div class="metric"><span>أيام بدون صداع (مؤكد/تلقائي)</span><b>${clearDays}</b></div><div class="metric"><span>أيام أعراض الرأس (بما فيها الثقل)</span><b>${a.symptomDays.size}</b></div><div class="metric"><span>أيام استخدام دواء</span><b>${a.medDays.size}</b></div></div>
 ${keyInsightsHtml(model)}${water24UpperHtml(water24)}${comparisonHtml(model,water24)}
 <div class="panel"><div class="severity-heading"><h3>أعلى شدة مسجلة يوميًا</h3><span class="mini">مقياس من 0 إلى 100%</span></div>${chartSvg(a.daily)}<p class="mini">النقطة = يوم صداع وصفي بلا نسبة. العلامة (—) = لا توجد قراءة. عند اختيار سنة أو «الكل» تظهر الأيام ذات التسجيل فقط.</p></div>
 ${analyticsSettingsHtml()}
 <details class="panel details-more"><summary>التحليل التفصيلي والتقارير</summary><div class="kv"><span>نوبات شقيقة مصنفة</span><strong>${a.migraineEpisodes.size}</strong></div><div class="kv"><span>أيام أعراض غير مصنفة كصداع</span><strong>${symptomOnly}</strong></div><div class="kv"><span>متوسط النوم المسجل</span><strong>${sleepAvg||'—'}</strong></div><div class="kv"><span>متوسط الماء بالأيام المسجلة</span><strong>${avgWater===null?'—':avgWater+' مل'}</strong></div><p class="info">اليوم المنتهي الذي تسجّل فيه روتينًا دون أعراض رأس يُصنّف تلقائيًا يومًا بلا صداع؛ الأيام بلا تسجيل لا تُعد أيامًا سليمة. في وضع «كل أعراض الرأس» تدخل أيام الثقل والصداع والشقيقة ضمن المقارنة، بينما يمكن حصرها بالصداع والشقيقة فقط من أعلى الصفحة. الصداع الموثق بملاحظة وصفية يُحتسب دون اختراع شدته.</p><h3>استجابة أدوية النوبات</h3>${medicationSummary(a)}<h3 style="margin-top:18px">العلاج الوقائي</h3>${preventiveSummary(a)}<div class="btn-row"><button class="btn secondary" data-export="csv">تصدير CSV</button><button class="btn ghost" data-report="1">تقرير للطبيب / PDF</button></div></details>`;
}
function renderSettings(){const diff=app.settings.lastBackup?Math.floor((now()-new Date(app.settings.lastBackup))/86400000):null,warn=diff===null?'لم تُنشئ نسخة احتياطية بعد':diff>=30?`مر ${diff} يومًا على آخر نسخة احتياطية`:`آخر نسخة احتياطية قبل ${diff} يومًا`;return `<div class="view-title"><div><h1>الإعدادات</h1><span class="sub">الخصوصية والتخصيص · v1.8.10 (موية 24 ساعة بالأوقات المعتمدة + تنبيه الألوان)</span></div></div><div class="panel soft"><h3>البيانات على الآيفون</h3><p class="info">كل التسجيلات في قاعدة بيانات الجهاز IndexedDB. لا يوجد حساب أو مزامنة. يجب حفظ نسخ احتياطية خارج التطبيق لتجنب فقدان البيانات عند حذف التطبيق أو بيانات Safari.</p></div><div class="panel"><h3>النسخ الاحتياطي</h3><p class="info">${E(warn)} ${diff===null||diff>=30?'— تذكير هادئ داخل الإعدادات.':''}</p><div class="btn-row"><button class="btn" data-export="json">حفظ JSON</button><button class="btn secondary" data-import="1">استعادة JSON</button></div><p class="mini">تتضمن النسخة السجلات والأدوية والمفضلة والإعدادات. صور RingConn لا تُحفظ.</p></div><div class="panel"><h3>الإدخال والتخصيص</h3><div class="form-grid"><div class="field"><label>حجم الكاسة (مل)</label><input id="cup-setting" type="number" min="1" value="${app.settings.waterCup}"></div><div class="field"><label>حجم القارورة (مل)</label><input id="bottle-setting" type="number" min="1" value="${app.settings.waterBottle}"></div></div><button class="btn secondary small" data-save-settings="1">حفظ الأحجام</button><div class="field"><label>المظهر</label><select id="theme-setting"><option value="system" ${app.settings.theme==='system'?'selected':''}>حسب الجهاز</option><option value="light" ${app.settings.theme==='light'?'selected':''}>فاتح</option><option value="dark" ${app.settings.theme==='dark'?'selected':''}>داكن</option></select></div></div><div class="panel"><h3>صور RingConn</h3><p class="info">ألصق الصورة من حافظة الآيفون أو افتح صورة من الجهاز. المعالجة تتم داخل المتصفح؛ محرك OCR التجريبي يحتاج تنزيل مكوناته أول مرة عند توفر الإنترنت، وقد لا يعمل دون اتصال قبل اكتمال تنزيلها.</p><button class="btn secondary full" data-pick-image="1">تجربة صورة RingConn</button></div><div class="panel"><h3>حالة النسخة الأولية</h3><p class="info">منفذ الآن: تسجيلات يومية، صداع ومواقع الرأس، ربط النوبات مبدئيًا، إدخال نصي، لصق الصور، مراجعة النوم، الحفظ المحلي، تقويم، تحليلات أساسية، نسخ JSON، تصدير CSV.</p><p class="info">بحاجة لاستكمال/اختبار: دقة OCR على RingConn والآيفون، دمج وفصل النوبات يدويًا بواجهة كاملة، استيراد Excel، تحليلات المحفزات المتقدمة، تصدير PDF منسق مخصص، ومزامنة RingConn المباشرة (غير معتمدة).</p></div>`}
function render(){const target=app.tab;view.innerHTML=target==='today'?renderToday():target==='history'?renderHistory():target==='analytics'?renderAnalytics():renderSettings();document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.go===target));if(target==='analytics'){const chart=view.querySelector('.severity-scroll');if(chart)chart.scrollLeft=chart.scrollWidth}}
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
function quickAction(type){if(type==='cup'){quickWater(app.settings.waterCup);return}if(type==='bottle'){quickWater(app.settings.waterBottle);return}if(type==='clear'){if(recordsDay(localDate(now())).some(r=>r.type==='headache')){toast('سُجلت أعراض اليوم؛ لا يمكن تأكيده خاليًا منها');return}const existing=recordsDay(localDate(now())).find(r=>r.type==='clear');if(existing)toast('سبق تأكيد اليوم بدون أعراض');else persist({type:'clear',id:uid(),at:iso(now())});return}manualEntry(type)}
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
 const html=`<div class="${extracted?'info':'warning'}">${extracted?`استخرجنا ${extracted} بيانات. راجعها قبل الحفظ.`:'تعذر قراءة قيم مؤكدة؛ أكملها يدويًا.'}</div>${badges?`<details style="margin:10px 0"><summary class="mini">مصدر كل قيمة</summary>${badges}</details>`:''}${warnings.map(w=>`<p class="warning">${E(w)}</p>`).join('')}<form id="ocr-form">
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
function doctorReport(){const a=getAnalytics(),dt=fmtDay(localDate(now())),h=sorted(a.heads);const items=h.map(x=>`<tr><td>${E(fmtShort(recordDate(x)))}</td><td>${E(kinds[x.kind])}</td><td>${x.severity}%</td><td>${E((x.spots||[]).join(','))}</td></tr>`).join('');const meds=sorted(a.r.filter(r=>r.type==='med')).map(r=>`<tr><td>${E(fmtShort(recordDate(r)))}</td><td>${E(r.name)}</td><td>${E(r.dose)}</td></tr>`).join('');openModal('تقرير مختصر للطبيب',`<div id="medical-report"><h3>Daily Health — متابعة ${app.period} يومًا</h3><p>${E(dt)}</p><p>أيام أعراض الرأس: ${a.symptomDays.size} — أيام صداع/شقيقة: ${a.headacheDays.size} — أيام استخدام علاج: ${a.medDays.size}</p><h4>القراءات</h4><table style="width:100%;font-size:11px"><tr><th>التاريخ</th><th>الحالة</th><th>الشدة</th><th>المواقع</th></tr>${items||'<tr><td colspan="4">لا توجد بيانات</td></tr>'}</table><h4>الأدوية</h4><table style="width:100%;font-size:11px"><tr><th>التاريخ</th><th>الدواء</th><th>الجرعة</th></tr>${meds||'<tr><td colspan="3">لا توجد بيانات</td></tr>'}</table><p class="mini">هذا تقرير تسجيل ذاتي وليس تشخيصًا.</p></div><button class="btn full" id="print-report">طباعة / حفظ PDF</button>`);$('#print-report').onclick=()=>{const html=$('#medical-report').innerHTML;const p=window.open('','_blank');if(!p){toast('اسمح بالنوافذ المنبثقة للطباعة');return}p.document.write(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>Daily Health Report</title><style>body{font-family:Arial;padding:25px;color:#23303c}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd2d6;padding:8px;text-align:right}p{line-height:1.7}</style>${html}<script>window.onload=()=>window.print()<\/script></html>`);p.document.close()}}
function setTab(tab){app.tab=tab;render();scrollTo({top:0,behavior:'instant'})}
function bind(){
 document.addEventListener('click',async e=>{
  const go=e.target.closest('[data-go]');if(go){setTab(go.dataset.go);return}
  if(e.target.closest('[data-close]')){closeModal();return}
  const quick=e.target.closest('[data-quick]');if(quick){quickAction(quick.dataset.quick);return}
  const edit=e.target.closest('[data-open]');if(edit){openEvent(edit.dataset.open);return}
  const del=e.target.closest('[data-delete]');if(del){if(confirm('حذف هذا التسجيل؟'))await erase(del.dataset.delete);return}
  const edh=e.target.closest('[data-edit-head]');if(edh){const r=app.records.find(x=>x.id===edh.dataset.editHead);if(r)headModal(r);return}
  const spl=e.target.closest('[data-split-head]');if(spl){await splitEpisode(spl.dataset.splitHead);return}
  const mer=e.target.closest('[data-merge-head]');if(mer){await mergeEpisode(mer.dataset.mergeHead);return}
  const filter=e.target.closest('[data-filter]');if(filter){app.filter=filter.dataset.filter;render();return}
  const period=e.target.closest('[data-period]');if(period){app.period=/^\d+$/.test(period.dataset.period)?Number(period.dataset.period):period.dataset.period;render();return}
  const analysisMode=e.target.closest('[data-analysis-mode]');if(analysisMode){app.analysisMode=analysisMode.dataset.analysisMode;render();return}
  const jump=e.target.closest('[data-chart-jump]');if(jump){const d=jump.dataset.chartJump;const plot=view.querySelector('.severity-scroll'),target=[...view.querySelectorAll('[data-chart-day]')].find(x=>x.dataset.chartDay===d);if(plot&&target){plot.scrollTo({left:Math.max(0,target.offsetLeft-plot.clientWidth/2+target.clientWidth/2),behavior:'smooth'});view.querySelectorAll('.severity-day').forEach(x=>x.classList.toggle('severity-focused',x===target))}return}
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
 document.addEventListener('input',e=>{if(e.target.id==='search-field'){const pos=e.target.selectionStart;app.search=e.target.value;const match=recordsDay(app.date).filter(r=>(app.filter==='all'||r.type===app.filter)&&(!app.search||summary(r).toLowerCase().includes(app.search.toLowerCase())||(r.notes||'').toLowerCase().includes(app.search.toLowerCase())));const title=document.querySelector('.section-title');const following=title?.nextElementSibling;let el=following;while(el){const next=el.nextElementSibling;el.remove();el=next}if(title)title.insertAdjacentHTML('afterend',match.length?match.map(eventRow).join(''):'<div class="empty">لا توجد نتائج مطابقة.</div>')}});
 document.addEventListener('change',async e=>{if(e.target.id==='theme-setting'){app.settings.theme=e.target.value;theme();await store.setMeta('settings',app.settings)}if(e.target.dataset.analyticConfig){const key=e.target.dataset.analyticConfig,mins={sleepHours:4,waterMl:200,timingMinutes:15,routineDeviation:30,wakeTolerance:15},maxs={sleepHours:12,waterMl:5000,timingMinutes:240,routineDeviation:240,wakeTolerance:180},n=Number(e.target.value);if(!Number.isFinite(n)||n<mins[key]||n>maxs[key]){toast('القيمة خارج النطاق المقبول');return}app.settings.analytics={...analysisConfig(),[key]:n};await store.setMeta('settings',app.settings);render();toast('تم تحديث معيار المقارنة')}});
 $('#send-btn').onclick=submitText;$('#quick-text').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submitText()}});
 $('#paste-btn').onclick=imageFromClipboard;
 document.addEventListener('paste',async e=>{const items=e.clipboardData?.items||[];for(const item of items){if(item.type?.startsWith('image/')){e.preventDefault();imagePreview(item.getAsFile());return}}});
 $('#image-picker').onchange=e=>{const f=e.target.files?.[0];if(f)imagePreview(f);e.target.value=''};
 $('#json-picker').onchange=e=>{const f=e.target.files?.[0];if(f)receiveBackup(f);e.target.value=''};
 $('#theme-btn').onclick=async()=>{app.settings.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';theme();await store.setMeta('settings',app.settings)};
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!layer.hidden)closeModal()});
}
async function main(){try{app.records=await store.getAll();app.settings={...app.settings,...await store.getMeta('settings',{})};$('#save-status').textContent='✓ محفوظ محليًا'}catch(e){$('#save-status').textContent='خطأ في التخزين';toast('التخزين المحلي غير متاح. افتح التطبيق عبر HTTPS أو localhost.')}
 theme();bind();render();if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost'))navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
main();
