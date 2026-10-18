const VERSION = 'V1.05';
const STORAGE_KEY = 'struttura_projects_v104_jobs';
const OLD_STORAGE_KEYS = ['struttura_projects_v103_jobs','struttura_projects_v102_jobs','struttura_projects_v101_jobs'];
const CLOUD_STAMP_KEY = 'struttura_projects_cloud_stamp';
const LOCAL_STAMP_KEY = 'struttura_projects_local_stamp';
const CLOUD_DIRTY_KEY = 'struttura_projects_cloud_dirty';

const money = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 });

let jobs = loadJobs();
let currentRoute = 'dashboard';
let currentJobId = null;
let sb = null;
let session = null;
let authReady = false;
let cloudDirty = localStorage.getItem(CLOUD_DIRTY_KEY) === '1';
let syncInFlight = false;
let pushTimer = null;
let syncTimer = null;
let syncState = 'offline';

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function esc(v='') { return String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function sumEntries(entries=[]) { return entries.reduce((sum, item) => sum + n(item.amount), 0); }
function income(j) { return sumEntries(j.incomes); }
function costs(j) { return sumEntries(j.expenses); }
function profit(j) { return income(j) - costs(j); }
function margin(j) { return income(j) > 0 ? profit(j) / income(j) : 0; }
function totalArea(j) { return (j.areas||[]).reduce((sum, item) => sum + n(item.m2), 0); }
function pricePerM2(j) { return totalArea(j) > 0 ? income(j) / totalArea(j) : 0; }
function fmtDate(v) { if (!v) return '—'; const d = new Date(v + 'T12:00:00'); return d.toLocaleDateString('cs-CZ'); }
function statusClass(s) { return s === 'Dokončená' ? 'done' : s === 'Probíhá' ? 'active' : s === 'Reklamace' ? 'claim' : ''; }
function toast(msg) { const t=document.createElement('div'); t.className='toast'; t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),2600); }

function normalizeJob(j={}) {
  const out = { ...j };
  out.materials = Array.isArray(j.materials) ? j.materials : [];
  if (Array.isArray(j.areas)) out.areas = j.areas;
  else out.areas = n(j.area) ? [{ type:'Ostatní', specification:'Původní celková plocha', m2:n(j.area) }] : [];
  if (Array.isArray(j.incomes)) out.incomes = j.incomes;
  else out.incomes = n(j.price) ? [{ date:j.dateFrom||'', category:'Původní zakázka', description:'Původní rozsah zakázky', amount:n(j.price), note:'' }] : [];

  if (Array.isArray(j.expenses)) out.expenses = j.expenses;
  else {
    out.expenses = [];
    if (n(j.costMaterial)) out.expenses.push({date:j.dateFrom||'',category:'Materiál',description:'Materiál',amount:n(j.costMaterial),note:''});
    if (n(j.costTransport)) out.expenses.push({date:j.dateFrom||'',category:'PHM',description:'Doprava / PHM',amount:n(j.costTransport),note:''});
    if (n(j.costAccommodation)) out.expenses.push({date:j.dateFrom||'',category:'Ostatní',description:'Ubytování',amount:n(j.costAccommodation),note:''});
    if (n(j.costRental)) out.expenses.push({date:j.dateFrom||'',category:'Ostatní',description:'Pronájem strojů',amount:n(j.costRental),note:''});
    if (n(j.costOther)) out.expenses.push({date:j.dateFrom||'',category:'Ostatní',description:'Ostatní náklady',amount:n(j.costOther),note:''});
  }
  delete out.price; delete out.area; delete out.costMaterial; delete out.costTransport; delete out.costAccommodation; delete out.costRental; delete out.costOther;
  return out;
}

function loadJobs() {
  try {
    const fresh = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(fresh)) return fresh.map(normalizeJob);
    for (const key of OLD_STORAGE_KEYS) {
      const old = JSON.parse(localStorage.getItem(key) || '[]');
      if (Array.isArray(old) && old.length) {
        const migrated = old.map(normalizeJob);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    }
    return [];
  } catch { return []; }
}
function persistLocal() { localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs)); }
function latestJobStamp() {
  return jobs.reduce((latest, job) => {
    const stamp = String(job.updatedAt || job.createdAt || '');
    return stamp > latest ? stamp : latest;
  }, '');
}
function getLocalStamp() {
  return localStorage.getItem(LOCAL_STAMP_KEY) || latestJobStamp() || localStorage.getItem(CLOUD_STAMP_KEY) || '';
}
function setLocalStamp(stamp) { if (stamp) localStorage.setItem(LOCAL_STAMP_KEY, stamp); }
function setCloudDirty(value) {
  cloudDirty = !!value;
  localStorage.setItem(CLOUD_DIRTY_KEY, cloudDirty ? '1' : '0');
}
function persist() {
  persistLocal();
  const stamp = new Date().toISOString();
  setLocalStamp(stamp);
  setCloudDirty(true);
  if (session) queueCloudPush();
}

function setSyncState(state, label='') {
  syncState = state;
  const el = document.getElementById('cloudStatus');
  if (!el) return;
  el.className = `cloud-status ${state}`;
  const text = label || ({synced:'Synchronizováno',syncing:'Synchronizuji',error:'Chyba cloudu',offline:'Offline',auth:'Přihlášení'})[state] || 'Cloud';
  const labelEl = el.querySelector('.cloud-label'); if (labelEl) labelEl.textContent = text;
}

function queueCloudPush(delay=350) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushCloudData(), delay);
}

async function pushCloudData({silent=false}={}) {
  if (!sb || !session) return false;
  if (syncInFlight) {
    if (cloudDirty) queueCloudPush(700);
    return false;
  }
  syncInFlight = true;
  setSyncState('syncing');

  // Zachytíme přesně tu verzi dat, kterou právě odesíláme. Pokud uživatel
  // během uploadu něco změní, novější lokální verze zůstane označená jako dirty.
  const payload = jobs.map(job => JSON.parse(JSON.stringify(job)));
  const stamp = getLocalStamp() || new Date().toISOString();
  if (!getLocalStamp()) setLocalStamp(stamp);

  const { error } = await sb.from('user_data').upsert({
    user_id: session.user.id,
    jobs: payload,
    updated_at: stamp
  }, { onConflict: 'user_id' });

  syncInFlight = false;
  if (error) {
    setSyncState(navigator.onLine ? 'error' : 'offline');
    if (!silent) toast('Cloud se nepodařilo uložit. Data zůstala bezpečně v tomto zařízení.');
    if (cloudDirty) queueCloudPush(2500);
    return false;
  }

  localStorage.setItem(CLOUD_STAMP_KEY, stamp);
  if (getLocalStamp() === stamp) {
    setCloudDirty(false);
    setSyncState('synced');
  } else {
    // Během uploadu vznikla další změna. Nikdy ji neoznačíme za synchronizovanou.
    setCloudDirty(true);
    setSyncState('syncing');
    queueCloudPush(500);
  }
  return true;
}

async function pullCloudData({silent=true}={}) {
  if (!sb || !session) return;
  if (syncInFlight) return;

  // Nejdřív vždy zachráníme neodeslanou lokální změnu. Starší cloud ji nesmí přepsat.
  if (cloudDirty) {
    queueCloudPush(150);
    return;
  }

  // Zapamatujeme si stav před downloadem. Když uživatel během čekání něco uloží,
  // výsledek staršího downloadu zahodíme a pošleme novou lokální verzi do cloudu.
  const pullStartStamp = getLocalStamp();
  syncInFlight = true;
  setSyncState('syncing');
  const { data, error } = await sb.from('user_data').select('jobs,updated_at').eq('user_id', session.user.id).maybeSingle();
  syncInFlight = false;

  if (cloudDirty || getLocalStamp() !== pullStartStamp) {
    queueCloudPush(100);
    return;
  }

  if (error) {
    setSyncState(navigator.onLine ? 'error' : 'offline');
    if (!silent) toast('Cloudová data se nepodařilo načíst.');
    return;
  }

  if (!data) {
    setCloudDirty(true);
    if (!getLocalStamp()) setLocalStamp(new Date().toISOString());
    await pushCloudData({silent});
    return;
  }

  const remoteJobs = Array.isArray(data.jobs) ? data.jobs.map(normalizeJob) : [];
  const remoteStamp = String(data.updated_at || '');
  const localStamp = getLocalStamp();
  localStorage.setItem(CLOUD_STAMP_KEY, remoteStamp);

  // Pokud je lokální kopie novější než cloud (např. po výpadku), pošleme ji nahoru.
  if (localStamp && remoteStamp && localStamp > remoteStamp) {
    setCloudDirty(true);
    await pushCloudData({silent});
    return;
  }

  if (JSON.stringify(remoteJobs) !== JSON.stringify(jobs)) {
    jobs = remoteJobs;
    persistLocal();
    setLocalStamp(remoteStamp || latestJobStamp());
    if (authReady) render();
    if (!silent) toast('Data z cloudu byla aktualizována.');
  } else if (remoteStamp && (!localStamp || remoteStamp > localStamp)) {
    setLocalStamp(remoteStamp);
  }

  setCloudDirty(false);
  setSyncState('synced');
}

function startSyncLoop() {
  clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      if (cloudDirty) queueCloudPush(100);
      else pullCloudData();
    }
  }, 7000);
}
function stopSyncLoop() { clearInterval(syncTimer); syncTimer = null; }

async function initApp() {
  const cfg = window.STRUTTURA_CONFIG || {};
  if (!window.supabase || !cfg.supabaseUrl || !cfg.supabasePublishableKey) {
    authReady = true; render(); return;
  }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const { data } = await sb.auth.getSession();
  session = data.session || null;
  if (session) { if (cloudDirty) await pushCloudData({silent:true}); else await pullCloudData(); }
  authReady = true;
  if (session) startSyncLoop();
  render();
  sb.auth.onAuthStateChange(async (event, newSession) => {
    const wasSignedIn = !!session;
    session = newSession || null;
    if (session && !wasSignedIn) {
      if (cloudDirty) await pushCloudData({silent:false}); else await pullCloudData({silent:false});
      startSyncLoop();
      currentRoute='dashboard'; currentJobId=null;
    }
    if (!session) { stopSyncLoop(); setSyncState('auth'); currentRoute='dashboard'; currentJobId=null; }
    render();
  });
}

function authView() {
  if (!window.supabase || !window.STRUTTURA_CONFIG?.supabaseUrl) return `<div class="auth-wrap"><div class="auth-card"><div class="eyebrow">STRUTTURA Projects ${VERSION}</div><h1>Cloud není nastaven</h1><p class="muted">Chybí cloudová konfigurace aplikace.</p></div></div>`;
  return `<div class="auth-wrap"><div class="auth-card">
    <img src="assets/logo_vertical_light.svg" class="auth-logo" alt="STRUTTURA" />
    <div class="eyebrow">STRUTTURA Projects ${VERSION}</div><h1>Přihlášení</h1>
    <p class="muted">Stejná data na Macu i mobilu. Přihlas se stejným účtem na obou zařízeních.</p>
    <form id="authForm" class="auth-form">
      <label>E-mail<input type="email" name="authEmail" autocomplete="email" required placeholder="tvuj@email.cz" /></label>
      <label>Heslo<input type="password" name="authPassword" autocomplete="current-password" minlength="6" required placeholder="Minimálně 6 znaků" /></label>
      <button class="primary-btn" type="submit">Přihlásit</button>
      <button class="secondary-btn" type="button" id="signUpBtn">Vytvořit účet</button>
      <div class="auth-message" id="authMessage"></div>
    </form>
  </div></div>`;
}

async function signIn(e) {
  e.preventDefault();
  const f=e.currentTarget, fd=new FormData(f), email=String(fd.get('authEmail')||'').trim(), password=String(fd.get('authPassword')||'');
  setAuthMessage('Přihlašuji…');
  const { error } = await sb.auth.signInWithPassword({email,password});
  if (error) setAuthMessage(error.message, true);
}
async function signUp() {
  const f=document.getElementById('authForm'); if(!f)return;
  const fd=new FormData(f), email=String(fd.get('authEmail')||'').trim(), password=String(fd.get('authPassword')||'');
  if(!email || password.length<6){setAuthMessage('Vyplň e-mail a heslo alespoň 6 znaků.',true);return;}
  setAuthMessage('Vytvářím účet…');
  const redirectTo = window.location.origin + window.location.pathname;
  const { data, error } = await sb.auth.signUp({email,password,options:{emailRedirectTo:redirectTo}});
  if(error){setAuthMessage(error.message,true);return;}
  if(data.session) setAuthMessage('Účet je vytvořený a jsi přihlášen.');
  else setAuthMessage('Účet vytvořen. Zkontroluj e-mail a potvrď registraci. Pak se vrať sem a přihlas se.');
}
function setAuthMessage(msg,isError=false){const el=document.getElementById('authMessage');if(el){el.textContent=msg;el.classList.toggle('error',isError);}}

async function signOut() {
  if (cloudDirty) await pushCloudData({silent:true});
  if (sb) await sb.auth.signOut();
}
function nextId() {
  const year = new Date().getFullYear();
  const nums = jobs.map(j => String(j.id||'').match(new RegExp(`STR-${year}-(\\d{4})`))).filter(Boolean).map(m => Number(m[1]));
  return `STR-${year}-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4,'0')}`;
}

function navigate(route, id=null) {
  currentRoute = route; currentJobId = id;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.route === (route==='detail'||route==='edit'?'jobs':route)));
  render(); window.scrollTo({top:0,behavior:'smooth'});
}

document.querySelector('.bottom-nav').addEventListener('click', e => { const b=e.target.closest('[data-route]'); if(b) navigate(b.dataset.route); });
document.getElementById('backupBtn').addEventListener('click', exportBackup);

function render() {
  const app=document.getElementById('app');
  document.body.classList.toggle('auth-mode', !session);
  document.getElementById('backupBtn').style.display = session ? '' : 'none';
  if (!authReady) { app.innerHTML='<div class="auth-wrap"><div class="auth-card"><div class="loading-line"></div><p class="muted">Načítám STRUTTURA Projects…</p></div></div>'; return; }
  if (!session) { app.innerHTML=authView(); bindAuthEvents(); setSyncState('auth'); return; }
  if(currentRoute==='dashboard') app.innerHTML=dashboardView();
  if(currentRoute==='jobs') app.innerHTML=jobsView();
  if(currentRoute==='new') app.innerHTML=formView();
  if(currentRoute==='edit') app.innerHTML=formView(jobs.find(j=>j.id===currentJobId));
  if(currentRoute==='detail') app.innerHTML=detailView(jobs.find(j=>j.id===currentJobId));
  if(currentRoute==='finance') app.innerHTML=financeView();
  if(currentRoute==='settings') app.innerHTML=settingsView();
  bindDynamicEvents();
  setSyncState(syncState);
}

function bindAuthEvents(){
 const f=document.getElementById('authForm'); if(f) f.addEventListener('submit',signIn);
 const s=document.getElementById('signUpBtn'); if(s) s.addEventListener('click',signUp);
}

function kpi(label,value,sub){return `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;}
function empty(text,cta=''){return `<div class="empty"><p>${text}</p>${cta?`<button class="primary-btn" data-go="new">${cta}</button>`:''}</div>`;}
function drow(k,v){return `<div class="detail-row"><span>${k}</span><strong>${v}</strong></div>`;}

function dashboardView() {
  const turnover=jobs.reduce((s,j)=>s+income(j),0);
  const totalCosts=jobs.reduce((s,j)=>s+costs(j),0);
  const totalProfit=turnover-totalCosts;
  const recent=[...jobs].sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,4);
  return `
    <div class="page-head"><div><div class="eyebrow">STRUTTURA Projects ${VERSION}</div><h1>Přehled</h1></div><button class="primary-btn" data-go="new">+ Nová zakázka</button></div>
    <div class="kpi-grid">
      ${kpi('Zakázky',jobs.length,'celkem')}
      ${kpi('Příjmy',money.format(turnover),'součet všech příjmů')}
      ${kpi('Náklady',money.format(totalCosts),'součet všech nákladů')}
      ${kpi('Zisk',money.format(totalProfit), turnover ? `${(totalProfit/turnover*100).toFixed(1).replace('.',',')} % marže` : '—')}
    </div>
    <section class="section"><div class="page-head"><div><div class="eyebrow">Poslední</div><h2>Zakázky</h2></div><button class="text-btn" data-go="jobs">Zobrazit vše →</button></div>
      ${recent.length ? `<div class="job-list">${recent.map(jobCard).join('')}</div>` : empty('Zatím tu není žádná zakázka.','Vytvořit první zakázku')}
    </section>`;
}

function jobsView() {
  return `<div class="page-head"><div><div class="eyebrow">Evidence realizací</div><h1>Zakázky</h1></div><button class="primary-btn" data-go="new">+ Nová</button></div>
    <div class="search-row"><input id="jobSearch" placeholder="Hledat klienta, město, materiál nebo odstín…" /></div>
    <div id="jobList" class="job-list">${jobs.length?jobs.map(jobCard).join(''):empty('Zatím tu není žádná zakázka.','Vytvořit první zakázku')}</div>`;
}

function jobCard(j){
  const mats=(j.materials||[]).map(m=>[m.manufacturer,m.product,m.color].filter(Boolean).join(' ')).join(' • ');
  return `<article class="job-card" data-job-card data-search="${esc([j.name,j.client,j.city,j.address,mats].join(' ').toLowerCase())}">
    <div class="job-card-top"><div><div class="job-title">${esc(j.name||'Bez názvu')}</div><div class="job-meta">${esc(j.client||'Bez klienta')} · ${esc(j.city||'Bez města')} · ${esc(j.id)}</div></div><span class="badge ${statusClass(j.status)}">${esc(j.status||'Plánovaná')}</span></div>
    <div class="job-card-bottom">
      <div class="mini-stat"><small>Plocha</small><strong>${number.format(totalArea(j))} m²</strong></div>
      <div class="mini-stat"><small>Příjmy</small><strong>${money.format(income(j))}</strong></div>
      <div class="mini-stat"><small>Zisk</small><strong>${money.format(profit(j))}</strong></div>
    </div>
    <button class="secondary-btn" data-open-job="${esc(j.id)}">Otevřít zakázku</button>
  </article>`;
}

function input(label,name,value='',placeholder='',required=false,type='text',step=''){return `<label>${label}<input type="${type}" name="${name}" value="${esc(value??'')}" placeholder="${esc(placeholder)}" ${required?'required':''} ${step?`step="${step}"`:''}/></label>`;}
function selectField(label,name,opts,value){return `<label>${label}<select name="${name}">${opts.map(o=>`<option ${o===value?'selected':''}>${o}</option>`).join('')}</select></label>`;}

function materialEditor(m={}) { return `<div class="editor-card material-editor-card">
  <div class="editor-head"><strong>Materiál</strong><button type="button" class="text-btn danger remove-material">Odstranit</button></div>
  <div class="form-grid two">
    <label>Výrobce<input name="materialManufacturer" value="${esc(m.manufacturer||'')}" placeholder="např. Oikos" /></label>
    <label>Produkt<input name="materialProduct" value="${esc(m.product||'')}" placeholder="např. Travertino Romano" /></label>
    <label>Odstín / barva<input name="materialColor" value="${esc(m.color||'')}" placeholder="např. TV 134 / TT6000-N" /></label>
    <label>Část realizace<input name="materialArea" value="${esc(m.area||'')}" placeholder="např. stěny koupelny" /></label>
  </div></div>`; }

function areaEditor(item={type:'Podlaha'}) { return `<div class="editor-card area-editor-card">
  <div class="editor-head"><strong>Plocha realizace</strong><button type="button" class="text-btn danger remove-area">Odstranit</button></div>
  <div class="form-grid two">
    ${selectField('Typ plochy','areaType',['Podlaha','Stěny','Strop','Schody','Ostatní'],item.type||'Podlaha')}
    ${input('Plocha m²','areaM2',item.m2||'','0','','number','0.01')}
  </div>
  <label class="editor-note">Specifikace<input name="areaSpecification" value="${esc(item.specification||'')}" placeholder="např. koupelna, krb, recepční pult…" /></label>
</div>`; }

function incomeEditor(item={category:'Původní zakázka'}) { return `<div class="editor-card income-editor-card">
  <div class="editor-head"><strong>Příjem</strong><button type="button" class="text-btn danger remove-income">Odstranit</button></div>
  <div class="form-grid two">
    ${input('Datum','incomeDate',item.date||'','','','date')}
    ${selectField('Kategorie','incomeCategory',['Původní zakázka','Vícepráce','Ostatní'],item.category||'Původní zakázka')}
    ${input('Popis','incomeDescription',item.description||'','např. Původní rozsah / schody navíc')}
    ${input('Částka','incomeAmount',item.amount||'','0','','number','1')}
  </div>
  <label class="editor-note">Poznámka<input name="incomeNote" value="${esc(item.note||'')}" placeholder="volitelné" /></label>
</div>`; }

function expenseEditor(item={category:'Materiál'}) { return `<div class="editor-card expense-editor-card">
  <div class="editor-head"><strong>Náklad</strong><button type="button" class="text-btn danger remove-expense">Odstranit</button></div>
  <div class="form-grid two">
    ${input('Datum','expenseDate',item.date||'','','','date')}
    ${selectField('Kategorie','expenseCategory',['Materiál','PHM','Spotřební materiál','Ostatní'],item.category||'Materiál')}
    ${input('Popis','expenseDescription',item.description||'','např. Oikos materiál / nafta / brusivo')}
    ${input('Částka','expenseAmount',item.amount||'','0','','number','1')}
  </div>
  <label class="editor-note">Poznámka<input name="expenseNote" value="${esc(item.note||'')}" placeholder="volitelné" /></label>
</div>`; }

function formView(job=null){
  const edit=Boolean(job); const j=normalizeJob(job||{status:'Plánovaná',areas:[],materials:[],incomes:[],expenses:[]});
  return `<div class="page-head"><div><div class="eyebrow">${edit?esc(j.id):'Nová realizace'}</div><h1>${edit?'Upravit zakázku':'Nová zakázka'}</h1></div></div>
    <form id="jobForm">
      <section class="form-card"><h2>Základ</h2><div class="form-grid two">
        ${input('Název zakázky','name',j.name,'např. Koupelna – Brno',true)}
        ${selectField('Stav','status',['Plánovaná','Probíhá','Dokončená','Reklamace','Archiv'],j.status)}
        ${input('Klient','client',j.client,'Jméno / firma')}
        ${input('Město','city',j.city,'Brno')}
        ${input('Adresa','address',j.address,'Ulice a číslo')}
        ${input('Datum od','dateFrom',j.dateFrom,'','','date')}
        ${input('Datum do','dateTo',j.dateTo,'','','date')}
        ${input('Telefon','phone',j.phone,'+420…')}
        ${input('E-mail','email',j.email,'klient@email.cz','','email')}
      </div></section>

      <section class="form-card"><div class="page-head compact"><div><div class="eyebrow">Rozsah realizace</div><h2>Plochy</h2></div><button type="button" class="secondary-btn" id="addArea">+ Přidat plochu</button></div>
        <div id="areasEditor">${(j.areas||[]).map(areaEditor).join('')}</div>
        ${(j.areas||[]).length?'':'<p class="muted editor-hint" id="areaHint">Přidej podlahu, stěny, strop, schody nebo vlastní specifikaci. Celková plocha se sečte automaticky.</p>'}
        <div class="area-total" id="areaTotal"></div>
      </section>

      <section class="form-card"><div class="page-head compact"><div><div class="eyebrow">Použité na realizaci</div><h2>Materiály a barvy</h2></div><button type="button" class="secondary-btn" id="addMaterial">+ Přidat</button></div>
        <div id="materialsEditor">${(j.materials||[]).map(materialEditor).join('')}</div>
        ${(j.materials||[]).length?'':'<p class="muted editor-hint" id="materialHint">Přidej libovolný počet použitých materiálů a odstínů.</p>'}
      </section>

      <section class="form-card"><div class="page-head compact"><div><div class="eyebrow">Zakázka a vícepráce</div><h2>Příjmy</h2></div><button type="button" class="secondary-btn" id="addIncome">+ Přidat příjem</button></div>
        <div id="incomesEditor">${(j.incomes||[]).map(incomeEditor).join('')}</div>
        ${(j.incomes||[]).length?'':'<p class="muted editor-hint" id="incomeHint">Přidej původní cenu zakázky a později jakékoli vícepráce.</p>'}
      </section>

      <section class="form-card"><div class="page-head compact"><div><div class="eyebrow">Výdaje zakázky</div><h2>Náklady</h2></div><button type="button" class="secondary-btn" id="addExpense">+ Přidat náklad</button></div>
        <div id="expensesEditor">${(j.expenses||[]).map(expenseEditor).join('')}</div>
        ${(j.expenses||[]).length?'':'<p class="muted editor-hint" id="expenseHint">Kategorie: Materiál, PHM, Spotřební materiál a Ostatní.</p>'}
      </section>

      <section class="form-card"><div class="eyebrow">Automatický výpočet</div><h2>Výsledek zakázky</h2><div id="liveFinance"></div></section>

      <section class="form-card"><h2>Poznámka</h2><label>Interní poznámka<textarea name="notes" placeholder="Cokoli důležitého k realizaci…">${esc(j.notes||'')}</textarea></label></section>
      <input type="hidden" name="id" value="${esc(j.id||'')}" />
      <div class="form-actions"><button type="button" class="secondary-btn" data-go="${edit?'detail':'jobs'}" ${edit?`data-id="${esc(j.id)}"`:''}>Zrušit</button><button class="primary-btn" type="submit">${edit?'Uložit změny':'Uložit zakázku'}</button></div>
    </form>`;
}

function detailView(j){
  if(!j) return empty('Zakázka nebyla nalezena.');
  j=normalizeJob(j); const areas=j.areas||[], mats=j.materials||[], ins=j.incomes||[], exs=j.expenses||[];
  return `<div class="page-head"><div><div class="eyebrow">${esc(j.id)}</div><h1>${esc(j.name)}</h1><div class="job-meta">${esc(j.client||'')} ${j.city?'· '+esc(j.city):''}</div></div><span class="badge ${statusClass(j.status)}">${esc(j.status)}</span></div>
  <div class="detail-grid two-col">
    <div>
      <section class="detail-card"><h2>Zakázka</h2>
        ${drow('Klient',esc(j.client||'—'))}${drow('Adresa',esc([j.address,j.city].filter(Boolean).join(', ')||'—'))}${drow('Telefon',esc(j.phone||'—'))}${drow('E-mail',esc(j.email||'—'))}${drow('Celková plocha',`${number.format(totalArea(j))} m²`)}${drow('Termín',`${fmtDate(j.dateFrom)} – ${fmtDate(j.dateTo)}`)}
      </section>
      <section class="detail-card section"><div class="page-head compact"><div><div class="eyebrow">Rozsah realizace</div><h2>Plochy</h2></div><span class="count-chip">${areas.length}</span></div>
        ${areas.length?`<div class="entry-list">${areas.map(a=>`<div class="entry-row"><div><strong>${esc(a.type||'Plocha')}</strong><small>${esc(a.specification||'Bez specifikace')}</small></div><strong>${number.format(n(a.m2))} m²</strong></div>`).join('')}</div>`:'<div class="empty compact-empty">Bez zadaných ploch.</div>'}
      </section>
      <section class="detail-card section"><div class="page-head compact"><div><div class="eyebrow">Použito na realizaci</div><h2>Materiály a barvy</h2></div></div>
        ${mats.length?`<div class="material-list">${mats.map(m=>`<div class="material-pill"><strong>${esc([m.manufacturer,m.product].filter(Boolean).join(' · ')||'Materiál')}</strong><small>${esc([m.color,m.area].filter(Boolean).join(' · ')||'Bez odstínu')}</small></div>`).join('')}</div>`:'<div class="empty">Bez zadaných materiálů.</div>'}
      </section>
      ${j.notes?`<section class="detail-card section"><h2>Poznámka</h2><div class="muted pre-line">${esc(j.notes)}</div></section>`:''}
    </div>
    <div>
      <section class="detail-card"><div class="eyebrow">Profitabilita</div><h2>Finance</h2>${drow('Příjmy celkem',money.format(income(j)))}${drow('Náklady celkem',money.format(costs(j)))}${drow('Zisk',money.format(profit(j)))}${drow('Marže',(margin(j)*100).toFixed(1).replace('.',',')+' %')}${drow('Příjmy / m²',money.format(pricePerM2(j)))}</section>
      <section class="detail-card section"><div class="page-head compact"><h2>Příjmy</h2><span class="count-chip">${ins.length}</span></div>${entryList(ins,'income')}</section>
      <section class="detail-card section"><div class="page-head compact"><h2>Náklady</h2><span class="count-chip">${exs.length}</span></div>${entryList(exs,'expense')}</section>
      <div class="section form-grid two"><button class="secondary-btn" data-edit-job="${esc(j.id)}">Upravit</button><button class="secondary-btn danger" data-delete-job="${esc(j.id)}">Smazat</button></div>
    </div>
  </div>`;
}

function entryList(items,type){
  if(!items.length) return '<div class="empty compact-empty">Žádné položky.</div>';
  return `<div class="entry-list">${items.map(x=>`<div class="entry-row"><div><strong>${esc(x.description||x.category||'Položka')}</strong><small>${esc(x.category||'')} ${x.date?'· '+fmtDate(x.date):''}${x.note?' · '+esc(x.note):''}</small></div><strong class="${type==='income'?'positive':''}">${money.format(n(x.amount))}</strong></div>`).join('')}</div>`;
}

function financeView(){
 const turnover=jobs.reduce((s,j)=>s+income(j),0), c=jobs.reduce((s,j)=>s+costs(j),0), p=turnover-c;
 const sorted=[...jobs].sort((a,b)=>profit(b)-profit(a));
 return `<div class="page-head"><div><div class="eyebrow">Výsledky realizací</div><h1>Finance</h1></div></div>
 <div class="kpi-grid">${kpi('Příjmy',money.format(turnover),'všechny zakázky')}${kpi('Náklady',money.format(c),'všechny zakázky')}${kpi('Zisk',money.format(p),'celkem')}${kpi('Marže',turnover?`${(p/turnover*100).toFixed(1).replace('.',',')} %`:'0 %','celková')}</div>
 <section class="section"><h2>Zisk podle zakázky</h2>${sorted.length?`<div class="finance-table">${sorted.map(j=>`<button class="finance-row" data-open-job="${esc(j.id)}"><span><strong>${esc(j.name)}</strong><br><small class="muted">${esc(j.id)} · ${esc(j.city||'')}</small></span><strong>${money.format(profit(j))}<br><small class="muted">${(margin(j)*100).toFixed(1).replace('.',',')} %</small></strong></button>`).join('')}</div>`:empty('Finance se zobrazí po přidání první zakázky.')}</section>`;
}

function settingsView(){return `<div class="page-head"><div><div class="eyebrow">STRUTTURA Projects</div><h1>Více</h1></div></div>
 <div class="settings-card"><div class="page-head compact"><div><div class="eyebrow">Cloud</div><h2>Synchronizace</h2></div><span class="badge active">${esc(session?.user?.email||'')}</span></div>
   <p class="muted">Zakázky se ukládají lokálně i do zabezpečeného Supabase cloudu. Na Macu i mobilu používej stejný účet.</p>
   <div class="form-grid two"><button class="primary-btn" id="syncNowBtn">Synchronizovat teď</button><button class="secondary-btn" id="logoutBtn">Odhlásit</button></div>
 </div>
 <div class="settings-card"><h2>Záloha dat</h2><p class="muted">Ruční JSON záloha zůstává jako další pojistka. Obsahuje zakázky, plochy, materiály, příjmy i náklady.</p><div class="form-grid two"><button class="secondary-btn" id="exportBtn">Exportovat zálohu</button><label class="secondary-btn file-label">Importovat zálohu<input id="importInput" type="file" accept="application/json" hidden></label></div></div>
 <div class="settings-card"><h2>Verze</h2>${drow('Aplikace',VERSION)}${drow('Zakázek',jobs.length)}<p class="muted">V1.05: bezpečnější cloudová synchronizace – neodeslaná lokální změna se zachová, zápis se při kolizi zopakuje a starší cloud nesmí přepsat novější lokální data. Všechny funkce a data z V1.04 zůstávají beze změny.</p></div>`;}

function bindDynamicEvents(){
 document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.go,b.dataset.id||currentJobId)));
 document.querySelectorAll('[data-open-job]').forEach(b=>b.addEventListener('click',()=>navigate('detail',b.dataset.openJob)));
 document.querySelectorAll('[data-edit-job]').forEach(b=>b.addEventListener('click',()=>navigate('edit',b.dataset.editJob)));
 document.querySelectorAll('[data-delete-job]').forEach(b=>b.addEventListener('click',()=>deleteJob(b.dataset.deleteJob)));
 const search=document.getElementById('jobSearch'); if(search) search.addEventListener('input',()=>{const q=search.value.trim().toLowerCase(); document.querySelectorAll('[data-job-card]').forEach(c=>c.style.display=c.dataset.search.includes(q)?'':'none');});
 const addArea=document.getElementById('addArea'); if(addArea) addArea.addEventListener('click',()=>addEditor('areasEditor',areaEditor(),'areaHint'));
 const addMaterial=document.getElementById('addMaterial'); if(addMaterial) addMaterial.addEventListener('click',()=>addEditor('materialsEditor',materialEditor(),'materialHint'));
 const addIncome=document.getElementById('addIncome'); if(addIncome) addIncome.addEventListener('click',()=>addEditor('incomesEditor',incomeEditor({category:document.querySelectorAll('.income-editor-card').length?'Vícepráce':'Původní zakázka'}),'incomeHint'));
 const addExpense=document.getElementById('addExpense'); if(addExpense) addExpense.addEventListener('click',()=>addEditor('expensesEditor',expenseEditor(),'expenseHint'));
 bindRemoveEditors();
 const form=document.getElementById('jobForm'); if(form){form.addEventListener('submit',saveJob); form.addEventListener('input',renderLiveFinance); renderLiveFinance();}
 const ex=document.getElementById('exportBtn'); if(ex) ex.addEventListener('click',exportBackup);
 const im=document.getElementById('importInput'); if(im) im.addEventListener('change',importBackup);
 const sn=document.getElementById('syncNowBtn'); if(sn) sn.addEventListener('click',async()=>{ if(cloudDirty) await pushCloudData({silent:false}); else await pullCloudData({silent:false}); });
 const lo=document.getElementById('logoutBtn'); if(lo) lo.addEventListener('click',signOut);
}

function addEditor(targetId,html,hintId){ const wrap=document.getElementById(targetId); wrap.insertAdjacentHTML('beforeend',html); const hint=document.getElementById(hintId); if(hint) hint.remove(); bindRemoveEditors(); renderLiveFinance(); }
function bindRemoveEditors(){
 document.querySelectorAll('.remove-area').forEach(b=>b.onclick=()=>{b.closest('.area-editor-card').remove(); renderLiveFinance();});
 document.querySelectorAll('.remove-material').forEach(b=>b.onclick=()=>{b.closest('.material-editor-card').remove(); renderLiveFinance();});
 document.querySelectorAll('.remove-income').forEach(b=>b.onclick=()=>{b.closest('.income-editor-card').remove(); renderLiveFinance();});
 document.querySelectorAll('.remove-expense').forEach(b=>b.onclick=()=>{b.closest('.expense-editor-card').remove(); renderLiveFinance();});
}

function collectAreas(f){
 const types=[...f.querySelectorAll('[name="areaType"]')], specs=[...f.querySelectorAll('[name="areaSpecification"]')], m2s=[...f.querySelectorAll('[name="areaM2"]')];
 return types.map((el,i)=>({type:el.value,specification:specs[i]?.value.trim()||'',m2:n(m2s[i]?.value)})).filter(a=>a.m2||a.specification);
}

function collectMaterials(f){
 const manufacturers=[...f.querySelectorAll('[name="materialManufacturer"]')], products=[...f.querySelectorAll('[name="materialProduct"]')], colors=[...f.querySelectorAll('[name="materialColor"]')], areas=[...f.querySelectorAll('[name="materialArea"]')];
 return manufacturers.map((el,i)=>({manufacturer:el.value.trim(),product:products[i].value.trim(),color:colors[i].value.trim(),area:areas[i].value.trim()})).filter(m=>Object.values(m).some(Boolean));
}
function collectEntries(f,prefix){
 const dates=[...f.querySelectorAll(`[name="${prefix}Date"]`)];
 const categories=[...f.querySelectorAll(`[name="${prefix}Category"]`)];
 const descriptions=[...f.querySelectorAll(`[name="${prefix}Description"]`)];
 const amounts=[...f.querySelectorAll(`[name="${prefix}Amount"]`)];
 const notes=[...f.querySelectorAll(`[name="${prefix}Note"]`)];
 return dates.map((el,i)=>({date:el.value,category:categories[i]?.value||'',description:descriptions[i]?.value.trim()||'',amount:n(amounts[i]?.value),note:notes[i]?.value.trim()||''})).filter(x=>x.description||x.amount||x.note);
}

function renderLiveFinance(){
 const f=document.getElementById('jobForm'), box=document.getElementById('liveFinance'); if(!f||!box)return;
 const temp={ areas:collectAreas(f), incomes:collectEntries(f,'income'), expenses:collectEntries(f,'expense') };
 const areaBox=document.getElementById('areaTotal'); if(areaBox) areaBox.innerHTML=drow('Celková plocha',`${number.format(totalArea(temp))} m²`);
 box.innerHTML=`<div class="finance-live-grid"><div>${drow('Příjmy celkem',money.format(income(temp)))}${drow('Náklady celkem',money.format(costs(temp)))}</div><div>${drow('Zisk',money.format(profit(temp)))}${drow('Marže',(margin(temp)*100).toFixed(1).replace('.',',')+' %')}${drow('Příjmy / m²',money.format(pricePerM2(temp)))}</div></div>`;
}

function saveJob(e){
 e.preventDefault(); const f=e.currentTarget, fd=new FormData(f); const id=fd.get('id')||nextId();
 const old=jobs.find(j=>j.id===id);
 const job={
   id,
   name:fd.get('name').trim(), status:fd.get('status'), client:fd.get('client').trim(), city:fd.get('city').trim(), address:fd.get('address').trim(),
   areas:collectAreas(f), dateFrom:fd.get('dateFrom'), dateTo:fd.get('dateTo'), phone:fd.get('phone').trim(), email:fd.get('email').trim(),
   materials:collectMaterials(f), incomes:collectEntries(f,'income'), expenses:collectEntries(f,'expense'), notes:fd.get('notes').trim(),
   createdAt:old?.createdAt||new Date().toISOString(), updatedAt:new Date().toISOString()
 };
 const idx=jobs.findIndex(j=>j.id===id); if(idx>=0) jobs[idx]=job; else jobs.push(job);
 persist(); toast(idx>=0?'Zakázka upravena':'Zakázka uložena'); navigate('detail',id);
}

function deleteJob(id){ if(!confirm('Opravdu chceš tuto zakázku smazat?'))return; jobs=jobs.filter(j=>j.id!==id); persist(); toast('Zakázka smazána'); navigate('jobs'); }
function exportBackup(){ const blob=new Blob([JSON.stringify({version:VERSION,exportedAt:new Date().toISOString(),jobs},null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`STRUTTURA_Projects_backup_${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(a.href); }
function importBackup(e){ const file=e.target.files?.[0]; if(!file)return; const r=new FileReader(); r.onload=()=>{try{const data=JSON.parse(r.result); if(!Array.isArray(data.jobs)) throw new Error(); if(confirm(`Načíst ${data.jobs.length} zakázek a nahradit současná data?`)){jobs=data.jobs.map(normalizeJob);persist();toast('Záloha obnovena');navigate('dashboard');}}catch{alert('Soubor není platná záloha STRUTTURA Projects.');}}; r.readAsText(file); }

window.addEventListener('online',()=>{ if(session){ setSyncState('syncing'); if(cloudDirty) queueCloudPush(100); else pullCloudData(); } });
window.addEventListener('offline',()=>setSyncState('offline'));
window.addEventListener('focus',()=>{ if(session){ if(cloudDirty) queueCloudPush(100); else pullCloudData(); } });
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible' && session){ if(cloudDirty) queueCloudPush(100); else pullCloudData(); } });

if('serviceWorker' in navigator) window.addEventListener('load',async()=>{
  try {
    const reg=await navigator.serviceWorker.register('./sw.js?v=105',{updateViaCache:'none'});
    reg.update();
  } catch {}
});
render();
initApp();
