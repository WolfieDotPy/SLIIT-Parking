const P=document.body.dataset.portal,K='tk_'+P,$=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>Number(n||0)+'/=',fmtD=d=>d?new Date(d).toISOString().slice(0,10):'-';
const COL={approved:'ok',paid:'ok',active:'ok',pending:'warn',draft:'warn',unpaid:'bad',rejected:'bad',expired:'bad'};
const st=s=>`<span class="${COL[s]||''}">${esc(s.charAt(0).toUpperCase()+s.slice(1))}</span>`;
const PASS={ACTIVE:['Active','ok'],EXPIRED:['Expired','bad'],NONE:['Inactive','bad']};
const kv=(a,c='')=>`<div class="kv2 ${c}">`+a.map(([k,v,cl])=>`<div><small>${esc(k)}</small><b class="${cl||''}">${esc(v??'-')||'-'}</b></div>`).join('')+'</div>';
const nowLocal=()=>{const d=new Date();return new Date(d-d.getTimezoneOffset()*6e4).toISOString().slice(0,16)};
const LOGO=`<img class="logo" src="/logo.png" alt="" onerror="this.outerHTML='<div class=crest>SLIIT</div>'">`;
$$('[data-logo]').forEach(e=>e.innerHTML=LOGO);
$$('[data-logo-sm]').forEach(e=>e.innerHTML=LOGO.replace('class="logo"','class="logo" style="height:36px"'));
function show(id){$$('.view').forEach(v=>v.classList.toggle('hidden',v.id!==id));scrollTo(0,0)}
function toast(m,err){const t=document.createElement('div');t.className='toast'+(err?' err':'');t.textContent=m;document.body.append(t);setTimeout(()=>t.remove(),3800)}
const portalToken=()=>sessionStorage.getItem('adminImpersonationToken')||localStorage[K]||'';
const adminPortalUrl=()=>{const h=location.hostname,local=h==='localhost'||h==='127.0.0.1',preview=h.endsWith('.vercel.app')&&h!=='sliit-parking-admin.vercel.app';return local||preview?location.origin+'/admin/':'https://sliit-parking-admin.vercel.app/admin/'};
function exitAdminMode(){
  const token=portalToken(),finish=()=>{sessionStorage.removeItem('adminImpersonationToken');sessionStorage.removeItem('adminImpersonation');location.href=adminPortalUrl()};
  if(!token)return finish();
  fetch('/api/'+P+'/impersonation/end',{method:'POST',headers:{Authorization:'Bearer '+token}}).catch(()=>{}).finally(finish);
}
const logout=()=>{if(sessionStorage.getItem('adminImpersonation'))return exitAdminMode();localStorage.removeItem(K);location.reload()};
function showAdminMode(){
  let data;try{data=JSON.parse(sessionStorage.getItem('adminImpersonation')||'null')}catch{return}
  if(!data)return;
  const banner=document.createElement('div');
  banner.style.cssText='position:sticky;top:0;z-index:9999;background:#8b2e22;color:#fff;padding:12px 16px;border-radius:12px;margin:8px 0 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 4px 14px #0002;font-size:13px';
  const label=document.createElement('strong');
  label.textContent='ADMIN MODE — Viewing '+(data.role==='student'?'student':'enforcer')+' '+(data.code||'')+' · '+(data.name||'');
  const button=document.createElement('button');
  button.className='pill';button.textContent='Exit & return to Admin';button.style.cssText='background:#fff;color:#8b2e22;white-space:nowrap';
  button.addEventListener('click',exitAdminMode);
  banner.append(label,button);
  (document.querySelector('.wrap')||document.body).prepend(banner);
}
async function consumeAdminHandoff(){
  const params=new URLSearchParams(location.hash.replace(/^#/,''));
  const handoff=params.get('admin-token');
  if(handoff){
    history.replaceState(history.state,'',location.pathname+location.search);
    try{
      const response=await fetch('/api/'+P+'/impersonation/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:handoff})});
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(result.error||'Could not start admin viewing session');
      sessionStorage.setItem('adminImpersonationToken',result.token);
      sessionStorage.setItem('adminImpersonation',JSON.stringify({sessionId:result.sessionId,role:result.role,code:result.code,name:result.name,expiresAt:result.expiresAt}));
      location.reload();
      return;
    }catch(error){toast(error.message,1)}
  }
  showAdminMode();
}
consumeAdminHandoff();
async function api(url,o={}){const h={};if(portalToken())h.Authorization='Bearer '+portalToken();
  if(o.json){h['Content-Type']='application/json';o.body=JSON.stringify(o.json)}
  const r=await fetch(url,{method:o.method,body:o.body,headers:h}),d=await r.json().catch(()=>({}));
  if(!r.ok){if(r.status===401&&portalToken())logout();throw new Error(d.error||'Something went wrong')}return d}
function openSlip(id){const w=window.open('','_blank');fetch(`/api/${P}/slip/${id}`,{headers:{Authorization:'Bearer '+portalToken()}})
  .then(r=>{if(!r.ok)throw 0;return r.blob()}).then(b=>w.location=URL.createObjectURL(b)).catch(()=>{w.close();toast('Could not open the file',1)})}
function tabs(sel,items,cb){const el=$(sel);el.className='tabs';el.innerHTML=items.map(([v,l],i)=>`<button data-v="${v}" class="${i?'':'on'}">${l}</button>`).join('');
  el.onclick=e=>{const b=e.target.closest('button');if(!b)return;[...el.children].forEach(x=>x.classList.toggle('on',x===b));cb(b.dataset.v)}}

function idCheck(i,m){const chk=()=>{const v=i.value.trim().toUpperCase().replace(/[\s-]/g,''),ok=/^[A-Z]{2}\d{8}$/.test(v);
  i.setCustomValidity(v&&!ok?'Student ID must be 2 letters followed by 8 digits (e.g. IT26123567)':'');
  m.textContent=!v?'2 letters + 8 digits, e.g. IT26123567':ok?'Valid ID format':'Must be exactly 2 letters followed by 8 digits';m.className='small '+(!v?'':ok?'ok':'bad')};i.addEventListener('input',chk);chk()}
function matchPw(f){const p=f.elements.password,c=f.elements.confirm,m=f.querySelector('.pwmsg');
  const chk=()=>{if(!c.value){c.setCustomValidity('');m.textContent='';return}const ok=p.value===c.value;
    c.setCustomValidity(ok?'':'Passwords do not match');m.textContent=ok?'Passwords match':'Passwords do not match';m.className='pwmsg small '+(ok?'ok':'bad')};
  p.addEventListener('input',chk);c.addEventListener('input',chk);f.addEventListener('reset',()=>setTimeout(chk,0))}

const fmtReg=v=>{const t=String(v||'').toUpperCase().replace(/\s/g,''),m=t.match(/^([A-Z0-9]{2,3})-?(\d{4})$/);return m?m[1]+'-'+m[2]:t};
function regCheck(i,m,plain){const ok=()=>/^[A-Z0-9]{2,3}-\d{4}$/.test(fmtReg(i.value)),chk=()=>{const e=!i.value.trim();
  i.setCustomValidity(!e&&!ok()?'Vehicle number must be like CAB-1234 or KS-9467':'');
  m.textContent=e?'2 or 3 letters/numbers, a dash, then 4 digits - e.g. CAB-1234':ok()?'Valid vehicle number':'Must be 2 or 3 letters/numbers, a dash, then 4 digits (e.g. KS-9467)';
  m.className='small '+(plain||e?'':ok()?'ok':'bad')};
  i.addEventListener('input',chk);i.addEventListener('blur',()=>{if(ok())i.value=fmtReg(i.value);chk()});chk()}
