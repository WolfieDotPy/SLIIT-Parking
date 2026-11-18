const P=document.body.dataset.portal,K='tk_'+P,$=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>Number(n||0)+'/=',fmtD=d=>d?new Date(d).toISOString().slice(0,10):'-';
const COL={approved:'ok',paid:'ok',active:'ok',pending:'warn',draft:'warn',unpaid:'bad',rejected:'bad',expired:'bad'};
const st=s=>`<span class="${COL[s]||''}">${esc(s.charAt(0).toUpperCase()+s.slice(1))}</span>`;
const PASS={ACTIVE:['Active','ok'],EXPIRED:['Expired','bad'],NONE:['No pass','bad']};
const kv=(a,c='')=>`<div class="kv2 ${c}">`+a.map(([k,v,cl])=>`<div><small>${esc(k)}</small><b class="${cl||''}">${esc(v??'-')||'-'}</b></div>`).join('')+'</div>';
const nowLocal=()=>{const d=new Date();return new Date(d-d.getTimezoneOffset()*6e4).toISOString().slice(0,16)};
const LOGO=`<img class="logo" src="/logo.png" alt="" onerror="this.outerHTML='<div class=crest>SLIIT</div>'">`;
$$('[data-logo]').forEach(e=>e.innerHTML=LOGO);
function show(id){$$('.view').forEach(v=>v.classList.toggle('hidden',v.id!==id));scrollTo(0,0)}
function toast(m,err){const t=document.createElement('div');t.className='toast'+(err?' err':'');t.textContent=m;document.body.append(t);setTimeout(()=>t.remove(),3800)}
const logout=()=>{localStorage.removeItem(K);location.reload()};
async function api(url,o={}){const h={};if(localStorage[K])h.Authorization='Bearer '+localStorage[K];
  if(o.json){h['Content-Type']='application/json';o.body=JSON.stringify(o.json)}
  const r=await fetch(url,{method:o.method,body:o.body,headers:h}),d=await r.json().catch(()=>({}));
  if(!r.ok){if(r.status===401&&localStorage[K])logout();throw new Error(d.error||'Something went wrong')}return d}
function openSlip(id){const w=window.open('','_blank');fetch(`/api/${P}/slip/${id}`,{headers:{Authorization:'Bearer '+localStorage[K]}})
  .then(r=>{if(!r.ok)throw 0;return r.blob()}).then(b=>w.location=URL.createObjectURL(b)).catch(()=>{w.close();toast('Could not open the file',1)})}
function tabs(sel,items,cb){const el=$(sel);el.className='tabs';el.innerHTML=items.map(([v,l],i)=>`<button data-v="${v}" class="${i?'':'on'}">${l}</button>`).join('');
  el.onclick=e=>{const b=e.target.closest('button');if(!b)return;[...el.children].forEach(x=>x.classList.toggle('on',x===b));cb(b.dataset.v)}}
