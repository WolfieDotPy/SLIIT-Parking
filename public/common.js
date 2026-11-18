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
const adminPortalUrl=()=>{const h=location.hostname,local=h==='localhost'||h==='127.0.0.1',production=['sliit-parking-admin.vercel.app','sliit-parking-beta.vercel.app','sliit-parking-enforcer.vercel.app'].includes(h),preview=h.endsWith('.vercel.app')&&!production;return local||preview?location.origin+'/admin/':'https://sliit-parking-admin.vercel.app/admin/'};
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


// Shared theme control for Admin, Student and Enforcer portals.
(function initThemeToggle(){
  const root=document.documentElement,key='sliit-theme';
  const stored=localStorage.getItem(key);
  if(stored==='dark'||stored==='light')root.dataset.theme=stored;
  const button=document.createElement('button');
  button.type='button';button.className='pill theme-toggle';
  button.setAttribute('aria-pressed',root.dataset.theme==='dark'?'true':'false');
  function paint(){
    const dark=root.dataset.theme==='dark';
    button.textContent=dark?'☀ Light mode':'☾ Dark mode';
    button.setAttribute('aria-label',dark?'Switch to light mode':'Switch to dark mode');
    button.setAttribute('aria-pressed',dark?'true':'false');
  }
  button.addEventListener('click',()=>{
    const next=root.dataset.theme==='dark'?'light':'dark';
    root.dataset.theme=next;localStorage.setItem(key,next);paint();
  });
  document.body.append(button);paint();
})();


// Cursor-driven ambient hue shift with frame-by-frame easing for smooth movement.
(function initCursorFlow(){
  const root=document.documentElement;
  const key='sliit-animations';
  const reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let enabled=localStorage.getItem(key)==='on'||(localStorage.getItem(key)!=='off'&&!reduced);
  const finePointer=window.matchMedia&&window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const button=document.createElement('button');
  button.type='button';button.className='pill animation-toggle';
  const ambient=document.createElement('div');
  ambient.className='ambient-flow-bg';ambient.setAttribute('aria-hidden','true');
  let targetX=50,targetY=50,currentX=50,currentY=50;
  let targetHue=220,currentHue=220,lastFrame=0,frameId=0;
  function paintButton(){
    root.dataset.animations=enabled?'on':'off';
    button.textContent=enabled?'✧ Effects on':'✧ Effects off';
    button.setAttribute('aria-pressed',enabled?'true':'false');
    button.setAttribute('aria-label',enabled?'Turn background animations off':'Turn background animations on');
    button.title=enabled?'Turn background animations off':'Turn background animations on';
  }
  function renderFrame(time){
    frameId=0;
    if(!enabled||!finePointer)return;
    const dt=lastFrame?Math.min(64,time-lastFrame):16;
    lastFrame=time;
    // Exponential easing keeps even sudden corner-to-corner pointer jumps fluid.
    const ease=1-Math.exp(-dt/1100);
    currentX+=(targetX-currentX)*ease;
    currentY+=(targetY-currentY)*ease;
    currentHue+=(targetHue-currentHue)*ease;
    ambient.style.setProperty('--flow-x',currentX.toFixed(2)+'%');
    ambient.style.setProperty('--flow-y',currentY.toFixed(2)+'%');
    ambient.style.filter='hue-rotate('+(currentHue-220).toFixed(2)+'deg)';
    if(Math.abs(targetX-currentX)>.04||Math.abs(targetY-currentY)>.04||Math.abs(targetHue-currentHue)>.04){
      frameId=requestAnimationFrame(renderFrame);
    }else{
      currentX=targetX;currentY=targetY;currentHue=targetHue;lastFrame=0;
    }
  }
  function requestFlowFrame(){
    if(enabled&&finePointer&&!frameId)frameId=requestAnimationFrame(renderFrame);
  }
  function setEnabled(value){
    enabled=value;localStorage.setItem(key,enabled?'on':'off');paintButton();
    if(!enabled){
      if(frameId)cancelAnimationFrame(frameId);
      frameId=0;lastFrame=0;
      ambient.style.filter='';
      targetX=currentX=50;targetY=currentY=50;targetHue=currentHue=220;
      ambient.style.setProperty('--flow-x','50%');
      ambient.style.setProperty('--flow-y','50%');
    }
  }
  button.addEventListener('click',()=>setEnabled(!enabled));
  document.body.append(button);
  document.body.insertBefore(ambient,document.body.firstChild);
  if(finePointer){
    // Browsers suspend animation frames in background tabs. Reset the frame
    // handle on return so the next pointer event always starts a fresh glide.
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden){
        if(frameId)cancelAnimationFrame(frameId);
        frameId=0;lastFrame=0;
      }
    });
    window.addEventListener('pointermove',e=>{
      if(!enabled||e.pointerType==='touch')return;
      targetX=Math.max(0,Math.min(100,e.clientX/Math.max(1,window.innerWidth)*100));
      targetY=Math.max(0,Math.min(100,e.clientY/Math.max(1,window.innerHeight)*100));
      targetHue=178+targetX*.62+targetY*.56;
      requestFlowFrame();
    },{passive:true});
  }
  paintButton();
})();
/* Floating student/admin support messenger. */
let supportStarted=false,supportOpen=false,supportConversationId=null,supportInbox=[];
function supportTime(value){if(!value)return '';const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}
function supportMessagesHtml(messages,role){
 if(!messages.length)return '<div class="support-empty">No messages yet. Send a message to get the conversation started.</div>';
 return messages.map(m=>'<div class="support-message '+(m.sender_role===role?'mine':'theirs')+'"><div class="support-bubble">'+esc(m.body).replace(/\n/g,'<br>')+'</div><small>'+esc(m.sender_role===role?'You':m.sender_name||'Admin')+' · '+esc(supportTime(m.created_at))+'</small></div>').join('');
}
function supportScrollBottom(){const area=$('#support-messages');if(area)area.scrollTop=area.scrollHeight;}
function supportSetBadge(count){const badge=$('#support-badge');if(!badge)return;const n=Number(count||0);badge.textContent=n>99?'99+':String(n);badge.classList.toggle('hidden',n<1);}
function supportBuild(){
 if($('#support-launcher'))return;
 const launcher=document.createElement('button');launcher.type='button';launcher.id='support-launcher';launcher.className='pill support-launcher';
 launcher.innerHTML=(P==='admin'?'💬 Student Messages':'💬 Message the Admin')+' <span id="support-badge" class="support-badge hidden"></span>';
 launcher.addEventListener('click',()=>supportToggle());
 const panel=document.createElement('section');panel.id='support-panel';panel.className='support-panel hidden';panel.setAttribute('aria-label',P==='admin'?'Student messages':'Message the Admin');
 if(P==='admin'){
  panel.innerHTML='<header class="support-head"><div><b>Student Messages</b><small>Conversations from students</small></div><button type="button" class="support-close" aria-label="Close">×</button></header><div id="support-inbox-view" class="support-inbox-view"><div id="support-inbox" class="support-inbox"></div></div><div id="support-thread-view" class="support-thread-view hidden"><div class="support-thread-head"><button id="support-back" type="button" class="support-back">‹ Inbox</button><div class="support-student-label"><b id="support-student-name"></b><small id="support-student-code"></small></div><button id="support-status" type="button" class="support-status"></button></div><div id="support-messages" class="support-messages"></div><form id="support-form" class="support-compose"><textarea id="support-input" maxlength="4000" rows="2" placeholder="Write a reply…" required></textarea><button class="pill green" type="submit">Send</button></form></div>';
 }else{
  panel.innerHTML='<header class="support-head"><div><b>Message the Admin</b><small>Chat with the SLIIT Parking administration</small></div><button type="button" class="support-close" aria-label="Close">×</button></header><div id="support-messages" class="support-messages"></div><form id="support-form" class="support-compose"><textarea id="support-input" maxlength="4000" rows="2" placeholder="Write your message…" required></textarea><button class="pill green" type="submit">Send</button></form>';
 }
 document.body.append(launcher,panel);
 $('.support-close').addEventListener('click',()=>supportToggle(false));
 $('#support-form').addEventListener('submit',supportSend);
 if(P==='admin'){
  $('#support-back').addEventListener('click',supportShowInbox);
  $('#support-status').addEventListener('click',supportToggleStatus);
 }
}
function supportToggle(force){
 supportOpen=typeof force==='boolean'?force:!supportOpen;
 $('#support-panel').classList.toggle('hidden',!supportOpen);
 if(supportOpen){if(P==='admin')supportLoadInbox();else supportLoadStudent();}
}
function supportShowInbox(){supportConversationId=null;$('#support-thread-view').classList.add('hidden');$('#support-inbox-view').classList.remove('hidden');supportLoadInbox();}
function supportRenderInbox(){
  const box=$('#support-inbox');if(!box)return;
  box.innerHTML=supportInbox.map(c=>'<div class="support-inbox-row"><button type="button" class="support-inbox-item '+(Number(c.id)===Number(supportConversationId)?'selected':'')+'" data-conversation="'+Number(c.id)+'"><span class="support-inbox-top"><b>'+esc(c.student_name||'Student')+'</b><span class="support-inbox-time">'+esc(supportTime(c.updated_at))+'</span></span><span class="support-inbox-code">'+esc(c.student_code||'')+'</span><span class="support-inbox-preview">'+esc(c.last_message||'No messages yet')+'</span><span class="support-inbox-meta"><span class="support-state '+(c.status==='resolved'?'resolved':'')+'">'+(c.status==='resolved'?'Resolved':'Open')+'</span>'+(Number(c.unread_count)>0?'<span class="support-unread">'+Number(c.unread_count)+'</span>':'')+'</span></button><button type="button" class="support-delete-chat" data-delete-conversation="'+Number(c.id)+'" aria-label="Permanently delete chat with '+esc(c.student_name||'student')+'" title="Permanently delete chat">🗑</button></div>').join('')||'<div class="support-empty">No student conversations yet.</div>';
  box.querySelectorAll('[data-conversation]').forEach(b=>b.addEventListener('click',()=>supportOpenConversation(Number(b.dataset.conversation))));
  box.querySelectorAll('[data-delete-conversation]').forEach(b=>b.addEventListener('click',()=>supportDeleteConversation(Number(b.dataset.deleteConversation),b)));
  supportSetBadge(supportInbox.reduce((n,c)=>n+Number(c.unread_count||0),0));
}
async function supportDeleteConversation(id,button){
  const chat=supportInbox.find(c=>Number(c.id)===Number(id));
  const label=chat?((chat.student_name||'Student')+' ('+(chat.student_code||'')+')'):'this student';
  if(!confirm('Permanently delete the entire conversation with '+label+', including every message? This cannot be undone.'))return;
  button.disabled=true;
  try{
    await api('/api/admin/support/conversations/'+id,{method:'DELETE'});
    supportInbox=supportInbox.filter(c=>Number(c.id)!==Number(id));
    supportRenderInbox();
    toast('Conversation permanently deleted');
  }catch(error){button.disabled=false;toast(error.message,1);}
}
async function supportLoadInbox(){
 if(P!=='admin'||!portalToken())return;
 try{supportInbox=await api('/api/admin/support/conversations');supportRenderInbox();}
 catch(error){if(error.message!=='Please log in')toast(error.message,1);}
}
async function supportOpenConversation(id){
 supportConversationId=id;$('#support-inbox-view').classList.add('hidden');$('#support-thread-view').classList.remove('hidden');await supportLoadAdminThread();
}
async function supportLoadAdminThread(){
 if(P!=='admin'||!supportConversationId)return;
 try{
  const r=await api('/api/admin/support/conversations/'+supportConversationId);
  $('#support-student-name').textContent=r.conversation.student_name||'Student';
  $('#support-student-code').textContent=r.conversation.student_code||'';
  const status=$('#support-status');status.textContent=r.conversation.status==='resolved'?'Reopen':'Mark resolved';status.dataset.status=r.conversation.status;
  const area=$('#support-messages'),nearBottom=area.scrollHeight-area.scrollTop-area.clientHeight<70;
  area.innerHTML=supportMessagesHtml(r.messages,'admin');if(nearBottom)supportScrollBottom();
  await supportLoadInbox();
 }catch(error){toast(error.message,1);supportShowInbox();}
}
async function supportLoadStudent(){
 if(P!=='student'||!portalToken()||sessionStorage.getItem('adminImpersonation'))return;
 try{
  const r=await api('/api/student/support');
  const area=$('#support-messages'),nearBottom=area.scrollHeight-area.scrollTop-area.clientHeight<70;
  area.innerHTML=supportMessagesHtml(r.messages,'student');if(nearBottom)supportScrollBottom();
  if(r.conversation)supportConversationId=r.conversation.id;
  const unread=await api('/api/student/support/unread');supportSetBadge(unread.unread);
 }catch(error){if(error.message!=='Please log in')toast(error.message,1);}
}
async function supportSend(event){
 event.preventDefault();const input=$('#support-input'),body=input.value.trim();if(!body)return;
 const button=event.submitter||event.target.querySelector('button');button.disabled=true;
 try{
  if(P==='admin'){
   if(!supportConversationId)throw new Error('Select a student conversation first');
   await api('/api/admin/support/conversations/'+supportConversationId+'/messages',{method:'POST',json:{body}});
   input.value='';await supportLoadAdminThread();
  }else{
   await api('/api/student/support/messages',{method:'POST',json:{body}});
   input.value='';await supportLoadStudent();
  }
 }catch(error){toast(error.message,1);}finally{button.disabled=false;input.focus();}
}
async function supportToggleStatus(){
 if(!supportConversationId)return;
 const current=$('#support-status').dataset.status,next=current==='resolved'?'open':'resolved';
 try{await api('/api/admin/support/conversations/'+supportConversationId+'/status',{method:'PATCH',json:{status:next}});await supportLoadAdminThread();}
 catch(error){toast(error.message,1);}
}
function initSupportChat(){
 if(supportStarted||!portalToken())return;
 if(P==='student'&&sessionStorage.getItem('adminImpersonation'))return;
 if(!['student','admin'].includes(P))return;
 supportStarted=true;supportBuild();
 const refresh=async()=>{
  if(!portalToken())return;
  if(supportOpen){if(P==='admin'){if(supportConversationId)await supportLoadAdminThread();else await supportLoadInbox();}else await supportLoadStudent();}
  else{try{const r=await api(P==='admin'?'/api/admin/support/unread':'/api/student/support/unread');supportSetBadge(r.unread);}catch{}}
 };
 refresh();setInterval(refresh,10000);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
}
