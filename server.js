const express=require('express'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),multer=require('multer'),QRCode=require('qrcode'),crypto=require('crypto'),path=require('path'),fs=require('fs');
const {DatabaseSync}=require('node:sqlite');
const SECRET=process.env.JWT_SECRET||'change-this-secret';
const UP=path.join(__dirname,'uploads'),PUB=path.join(__dirname,'public');
fs.mkdirSync(UP,{recursive:true});
const DBF=path.join(__dirname,'sliit-parking.db'),raw=new DatabaseSync(DBF);
const db={exec:x=>raw.exec(x),prepare:x=>raw.prepare(x),transaction:f=>()=>{raw.exec('BEGIN');try{const r=f();raw.exec('COMMIT');return r}catch(e){raw.exec('ROLLBACK');throw e}}};
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,role TEXT NOT NULL,code TEXT UNIQUE,name TEXT,contact TEXT,password_hash TEXT,qr_token TEXT UNIQUE,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS vehicles(id INTEGER PRIMARY KEY,user_id INTEGER UNIQUE,reg_number TEXT UNIQUE,type TEXT);
CREATE TABLE IF NOT EXISTS passes(id INTEGER PRIMARY KEY,user_id INTEGER,start_date TEXT,end_date TEXT,payment_id INTEGER);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,user_id INTEGER,kind TEXT,fee_id INTEGER,vehicle_reg TEXT,vehicle_type TEXT,amount REAL,slip_file TEXT,status TEXT DEFAULT 'pending',reject_reason TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,reviewed_at TEXT);
CREATE TABLE IF NOT EXISTS fees(id INTEGER PRIMARY KEY,vehicle_reg TEXT,user_id INTEGER,enforcer_id INTEGER,start_time TEXT,end_time TEXT,hours INTEGER,amount REAL,status TEXT,reason TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);`);
const seed=(k,v)=>db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run(k,String(v));
seed('hourly_rate',100);seed('pass_price',5000);seed('grace_minutes',15);seed('plan_days',365);seed('bank_info','Bank details not set yet - admin can add them in Settings.');
if(!db.prepare("SELECT 1 FROM users WHERE role='admin'").get())db.prepare("INSERT INTO users(role,code,name,password_hash) VALUES('admin','ADMIN','Admin',?)").run(bcrypt.hashSync(process.env.ADMIN_PASSWORD||'admin123',10));

const S=()=>Object.fromEntries(db.prepare('SELECT * FROM settings').all().map(r=>[r.key,r.value]));
const fail=(m,c=400)=>{const e=new Error(m);e.status=c;throw e};
const wrap=f=>async(q,s)=>{try{await f(q,s)}catch(e){if(q.file)fs.unlink(q.file.path,()=>{});s.status(e.status||400).json({error:e.message})}};
const auth=role=>(q,s,n)=>{try{q.user=jwt.verify((q.headers.authorization||'').replace('Bearer ',''),SECRET)}catch{return s.status(401).json({error:'Please log in'})}
  if(q.user.role!==role)return s.status(403).json({error:'This account cannot use this portal'});n()};
const normReg=r=>(r||'').toUpperCase().replace(/\s/g,'');
const upload=multer({storage:multer.diskStorage({destination:UP,filename:(q,f,cb)=>cb(null,crypto.randomUUID()+path.extname(f.originalname).toLowerCase())}),
  limits:{fileSize:5*1024*1024},fileFilter:(q,f,cb)=>cb(null,/\.(jpe?g|png|pdf)$/i.test(f.originalname))});
const passOf=id=>{const e=db.prepare('SELECT MAX(end_date) e FROM passes WHERE user_id=?').get(id).e;return e?{status:new Date(e)>=new Date()?'ACTIVE':'EXPIRED',expiry:e}:{status:'NONE',expiry:null}};
const profile=id=>{const u=db.prepare('SELECT code,name,contact FROM users WHERE id=?').get(id);if(!u)return null;
  const v=db.prepare('SELECT reg_number reg,type FROM vehicles WHERE user_id=?').get(id)||{};
  const od=db.prepare("SELECT COUNT(*) n,COALESCE(SUM(amount),0) t FROM fees WHERE user_id=? AND status='unpaid'").get(id);
  return{code:u.code,name:u.name,contact:u.contact,reg:v.reg,type:v.type,...passOf(id),overdue:{n:od.n,total:od.t}}};
const enfInfo=id=>{const u=db.prepare('SELECT code,name,contact FROM users WHERE id=?').get(id);return u&&{...u,count:db.prepare("SELECT COUNT(*) n FROM fees WHERE enforcer_id=? AND status!='draft'").get(id).n}};
const slip=role=>wrap((q,s)=>{const p=db.prepare('SELECT slip_file,user_id FROM payments WHERE id=?').get(q.params.id);
  if(!p||(role==='student'&&p.user_id!==q.user.id))fail('Not found',404);s.sendFile(path.join(UP,p.slip_file))});

const app=express();app.use(express.json());
app.get('/',(q,s)=>s.redirect('/student/'));app.use(express.static(PUB));

// ---------- login (one endpoint per portal; each only accepts its own role)
const login=role=>wrap((q,s)=>{const code=role==='admin'?'ADMIN':(q.body.code||'').trim().toUpperCase().replace(/[\s-]/g,'');
  const u=db.prepare('SELECT * FROM users WHERE role=? AND code=?').get(role,code);
  if(!u||!bcrypt.compareSync(q.body.password||'',u.password_hash))fail(role==='admin'?'Wrong password':'Wrong ID or password',401);
  s.json({token:jwt.sign({id:u.id,role},SECRET,{expiresIn:'12h'}),name:u.name})});
['student','admin','enforcer'].forEach(r=>app.post(`/api/${r}/login`,login(r)));

// ---------- STUDENT
app.get('/api/student/info',wrap((q,s)=>{const c=S();s.json({pass_price:c.pass_price,bank_info:c.bank_info,plan_days:c.plan_days})}));
app.post('/api/student/register',upload.single('slip'),wrap((q,s)=>{
  const b=q.body,code=(b.code||'').trim().toUpperCase().replace(/[\s-]/g,''),reg=normReg(b.vehicle_reg);
  if(!/^[A-Z0-9]{6,12}$/.test(code))fail('Enter a valid student registration number (e.g. IT26123567)');
  if(!(b.name||'').trim()||!(b.contact||'').trim()||!reg||!b.vehicle_type)fail('Please fill in every field');
  if((b.password||'').length<6)fail('Password must be at least 6 characters');
  if(b.password!==b.confirm)fail('Passwords do not match');
  if(!q.file)fail('Please upload your payment slip (JPG, PNG or PDF, max 5MB)');
  if(db.prepare('SELECT 1 FROM users WHERE code=?').get(code))fail('This student number is already registered');
  if(db.prepare('SELECT 1 FROM vehicles WHERE reg_number=?').get(reg))fail('This vehicle number is already registered');
  db.transaction(()=>{const id=db.prepare("INSERT INTO users(role,code,name,contact,password_hash,qr_token) VALUES('student',?,?,?,?,?)").run(code,b.name.trim(),b.contact.trim(),bcrypt.hashSync(b.password,10),crypto.randomUUID()).lastInsertRowid;
    db.prepare('INSERT INTO vehicles(user_id,reg_number,type) VALUES(?,?,?)').run(id,reg,b.vehicle_type);
    db.prepare("INSERT INTO payments(user_id,kind,vehicle_reg,vehicle_type,amount,slip_file) VALUES(?,'pass',?,?,?,?)").run(id,reg,b.vehicle_type,S().pass_price,q.file.filename)})();
  s.json({ok:true})}));
app.get('/api/student/me',auth('student'),wrap((q,s)=>{
  s.json({...profile(q.user.id),
    pendingPass:!!db.prepare("SELECT 1 FROM payments WHERE user_id=? AND kind='pass' AND status='pending'").get(q.user.id),
    lastPass:db.prepare("SELECT status,reject_reason FROM payments WHERE user_id=? AND kind='pass' ORDER BY id DESC").get(q.user.id)||null})}));
app.get('/api/student/qr',auth('student'),wrap(async(q,s)=>{if(passOf(q.user.id).status==='NONE')fail('No pass yet',403);
  s.json({qr:await QRCode.toDataURL(db.prepare('SELECT qr_token FROM users WHERE id=?').get(q.user.id).qr_token,{width:300,margin:1})})}));
app.get('/api/student/payments',auth('student'),wrap((q,s)=>{s.json(db.prepare('SELECT id,kind,vehicle_reg,amount,status,reject_reason,created_at FROM payments WHERE user_id=? ORDER BY id DESC').all(q.user.id))}));
app.get('/api/student/fees',auth('student'),wrap((q,s)=>{s.json(db.prepare("SELECT id,vehicle_reg,amount,end_time FROM fees WHERE user_id=? AND status='unpaid' ORDER BY id DESC").all(q.user.id))}));
app.get('/api/student/fees/lookup',auth('student'),wrap((q,s)=>{s.json(db.prepare("SELECT id,vehicle_reg,amount,end_time FROM fees WHERE vehicle_reg=? AND status='unpaid' AND (user_id IS NULL OR user_id=?)").all(normReg(q.query.reg),q.user.id))}));
app.post('/api/student/pay',auth('student'),upload.single('slip'),wrap((q,s)=>{
  const uid=q.user.id,b=q.body;if(!q.file)fail('Please upload your payment slip (JPG, PNG or PDF, max 5MB)');
  if(b.kind==='fee'){const f=db.prepare("SELECT * FROM fees WHERE id=? AND status='unpaid'").get(b.fee_id);
    if(!f||(f.user_id&&f.user_id!==uid))fail('Fee not found or already paid');
    db.transaction(()=>{db.prepare("INSERT INTO payments(user_id,kind,fee_id,vehicle_reg,amount,slip_file) VALUES(?,'fee',?,?,?,?)").run(uid,f.id,f.vehicle_reg,f.amount,q.file.filename);
      db.prepare("UPDATE fees SET status='pending' WHERE id=?").run(f.id)})();
  }else if(b.kind==='pass'){const reg=normReg(b.vehicle_reg);if(!reg||!b.vehicle_type)fail('Vehicle number and type are required');
    if(db.prepare("SELECT 1 FROM payments WHERE user_id=? AND kind='pass' AND status='pending'").get(uid))fail('Your previous pass payment is still awaiting verification');
    if(db.prepare('SELECT 1 FROM vehicles WHERE reg_number=? AND user_id!=?').get(reg,uid))fail('That vehicle number belongs to another student');
    db.prepare("INSERT INTO payments(user_id,kind,vehicle_reg,vehicle_type,amount,slip_file) VALUES(?,'pass',?,?,?,?)").run(uid,reg,b.vehicle_type,S().pass_price,q.file.filename);
  }else fail('Invalid payment type');
  s.json({ok:true})}));
app.get('/api/student/slip/:id',auth('student'),slip('student'));

// ---------- ADMIN
const payRow=p=>{const f=p.fee_id?db.prepare('SELECT * FROM fees WHERE id=?').get(p.fee_id):null;
  return{...p,slip_file:undefined,student:profile(p.user_id),enforcer:f&&f.enforcer_id?enfInfo(f.enforcer_id):null}};
app.get('/api/admin/payments',auth('admin'),wrap((q,s)=>{let sql=`SELECT * FROM payments WHERE status ${q.query.view==='history'?'!=':'='} 'pending'`;const a=[];
  if(q.query.kind==='fee'||q.query.kind==='pass'){sql+=' AND kind=?';a.push(q.query.kind)}
  s.json(db.prepare(sql+' ORDER BY id DESC').all(...a).map(payRow))}));
app.patch('/api/admin/payments/:id/approve',auth('admin'),wrap((q,s)=>{
  const p=db.prepare("SELECT * FROM payments WHERE id=? AND status='pending'").get(q.params.id);if(!p)fail('Payment is not pending',404);
  db.transaction(()=>{const now=new Date();
    if(p.kind==='pass'){const cur=passOf(p.user_id),start=cur.expiry&&new Date(cur.expiry)>now?new Date(cur.expiry):now,end=new Date(start.getTime()+Number(S().plan_days)*864e5);
      db.prepare('UPDATE vehicles SET reg_number=?,type=? WHERE user_id=?').run(p.vehicle_reg,p.vehicle_type,p.user_id);
      db.prepare('INSERT INTO passes(user_id,start_date,end_date,payment_id) VALUES(?,?,?,?)').run(p.user_id,start.toISOString(),end.toISOString(),p.id)
    }else db.prepare("UPDATE fees SET status='paid' WHERE id=?").run(p.fee_id);
    db.prepare("UPDATE payments SET status='approved',reviewed_at=? WHERE id=?").run(now.toISOString(),p.id)})();
  s.json({ok:true})}));
app.patch('/api/admin/payments/:id/reject',auth('admin'),wrap((q,s)=>{
  const p=db.prepare("SELECT * FROM payments WHERE id=? AND status='pending'").get(q.params.id);if(!p)fail('Payment is not pending',404);
  db.transaction(()=>{db.prepare("UPDATE payments SET status='rejected',reject_reason=?,reviewed_at=? WHERE id=?").run(q.body.reason||'Rejected',new Date().toISOString(),p.id);
    if(p.fee_id)db.prepare("UPDATE fees SET status='unpaid' WHERE id=?").run(p.fee_id)})();s.json({ok:true})}));
app.get('/api/admin/slip/:id',auth('admin'),slip('admin'));
app.post('/api/admin/enforcers',auth('admin'),wrap((q,s)=>{const b=q.body;
  if(!(b.name||'').trim()||!(b.contact||'').trim())fail('Name and contact details are required');
  if((b.password||'').length<6)fail('Password must be at least 6 characters');if(b.password!==b.confirm)fail('Passwords do not match');
  const code=nextEnfCode();
  db.prepare("INSERT INTO users(role,code,name,contact,password_hash) VALUES('enforcer',?,?,?,?)").run(code,b.name.trim(),b.contact.trim(),bcrypt.hashSync(b.password,10));s.json({code})}));
app.get('/api/admin/settings',auth('admin'),wrap((q,s)=>s.json(S())));
app.put('/api/admin/settings',auth('admin'),wrap((q,s)=>{const b=q.body;
  for(const k of['hourly_rate','pass_price','grace_minutes','plan_days'])if(b[k]!==undefined){if(b[k]===''||isNaN(b[k])||b[k]<0)fail('Invalid value for '+k);db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k,String(b[k]))}
  if(b.bank_info!==undefined)db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('bank_info',String(b.bank_info));
  if(b.new_password){if(b.new_password.length<6)fail('New password must be at least 6 characters');db.prepare("UPDATE users SET password_hash=? WHERE role='admin'").run(bcrypt.hashSync(b.new_password,10))}
  s.json(S())}));
// ---------- ADMIN: full data access (view / edit / delete / export / backup)
const TABLES={
 students:{t:'users',w:"role='student'",cols:['code','name','contact'],sel:'id,code,name,contact,created_at'},
 enforcers:{t:'users',w:"role='enforcer'",cols:['code','name','contact'],sel:'id,code,name,contact,created_at'},
 vehicles:{t:'vehicles',cols:['reg_number','type'],sel:'id,user_id,reg_number,type'},
 passes:{t:'passes',cols:['start_date','end_date'],sel:'id,user_id,start_date,end_date,payment_id'},
 fees:{t:'fees',cols:['vehicle_reg','start_time','end_time','hours','amount','status','reason'],sel:'id,vehicle_reg,user_id,enforcer_id,start_time,end_time,hours,amount,status,reason,created_at'},
 payments:{t:'payments',cols:['kind','vehicle_reg','vehicle_type','amount','status','reject_reason'],sel:'id,user_id,kind,fee_id,vehicle_reg,vehicle_type,amount,status,reject_reason,created_at'}};
const tbl=n=>TABLES[n]||fail('Unknown table',404);
const DATES=['start_date','end_date','start_time','end_time'],NUMS=['hours','amount'];
app.get('/api/admin/table/:name',auth('admin'),wrap((q,s)=>{const T=tbl(q.params.name);
  s.json({cols:T.sel.split(','),editable:T.cols,rows:db.prepare(`SELECT ${T.sel} FROM ${T.t}${T.w?' WHERE '+T.w:''} ORDER BY id DESC`).all()})}));
const updateRow=(T,id,body)=>{const sets=[],vals=[];
  for(const c of T.cols){let v=body[c];if(v===undefined)continue;
    if(v===''||v===null)v=null;
    else if(DATES.includes(c)){const d=new Date(v);if(isNaN(d))fail('Invalid date in '+c);v=d.toISOString()}
    else if(NUMS.includes(c)){if(isNaN(v))fail(c+' must be a number');v=Number(v)}
    else if(c==='code')v=String(v).trim().toUpperCase();
    else if(c==='reg_number'||c==='vehicle_reg')v=normReg(v);
    sets.push(c+'=?');vals.push(v)}
  if(T.t==='users'&&body.new_password){if(body.new_password.length<6)fail('Password must be at least 6 characters');sets.push('password_hash=?');vals.push(bcrypt.hashSync(body.new_password,10))}
  if(!sets.length)fail('Nothing to change');
  let r;try{r=db.prepare(`UPDATE ${T.t} SET ${sets.join(',')} WHERE id=?${T.w?' AND '+T.w:''}`).run(...vals,id)}catch{fail('Could not save - a value is invalid or already in use')}
  if(!r.changes)fail('Row not found',404)};
app.put('/api/admin/table/:name/:id',auth('admin'),wrap((q,s)=>{updateRow(tbl(q.params.name),q.params.id,q.body);s.json({ok:true})}));
const addStudent=r=>{const code=String(r.code||'').trim().toUpperCase().replace(/[\s-]/g,''),reg=normReg(r.vehicle);
  if(!/^[A-Z0-9]{3,20}$/.test(code))fail('student number is missing or invalid (got "'+String(r.code||'')+'"; use letters and numbers only, 3-20 characters)');
  if(!String(r.name||'').trim())fail('name is required');
  const given=String(r.password||'').trim(),pw=given||code;if(given&&given.length<6)fail('password must be at least 6 characters');
  if(db.prepare('SELECT 1 FROM users WHERE code=?').get(code))fail('student '+code+' already exists');
  if(reg&&db.prepare('SELECT 1 FROM vehicles WHERE reg_number=?').get(reg))fail('vehicle '+reg+' is already registered');
  let end=null;if(r.pass_end){end=new Date(r.pass_end);if(isNaN(end))fail('pass_end is not a valid date (use YYYY-MM-DD)')}
  const id=db.prepare("INSERT INTO users(role,code,name,contact,password_hash,qr_token) VALUES('student',?,?,?,?,?)").run(code,String(r.name).trim(),String(r.contact||'').trim()||null,bcrypt.hashSync(pw,10),crypto.randomUUID()).lastInsertRowid;
  if(reg)db.prepare('INSERT INTO vehicles(user_id,reg_number,type) VALUES(?,?,?)').run(id,reg,r.vehicle_type||'Car');
  if(end)db.prepare('INSERT INTO passes(user_id,start_date,end_date) VALUES(?,?,?)').run(id,new Date(end.getTime()-Number(S().plan_days)*864e5).toISOString(),end.toISOString());return !String(r.password||'').trim()};
const studentId=c=>{const u=db.prepare("SELECT id FROM users WHERE role='student' AND code=?").get(String(c||'').trim().toUpperCase().replace(/[\s-]/g,''));if(!u)fail('student "'+(c||'')+'" not found - add the student first');return u.id};
const addVehicle=r=>{const id=studentId(r.student),reg=normReg(r.reg_number);if(!reg)fail('reg_number is required');
  if(db.prepare('SELECT 1 FROM vehicles WHERE user_id=?').get(id))fail('that student already has a vehicle - edit the existing row instead');
  if(db.prepare('SELECT 1 FROM vehicles WHERE reg_number=?').get(reg))fail('vehicle '+reg+' is already registered');
  db.prepare('INSERT INTO vehicles(user_id,reg_number,type) VALUES(?,?,?)').run(id,reg,r.type||'Car')};
const addPass=r=>{const id=studentId(r.student),end=new Date(r.end_date);if(!r.end_date||isNaN(end))fail('end_date is required (YYYY-MM-DD)');
  const start=r.start_date?new Date(r.start_date):new Date(end.getTime()-Number(S().plan_days)*864e5);
  if(isNaN(start)||end<=start)fail('start_date must be a valid date before end_date');
  db.prepare('INSERT INTO passes(user_id,start_date,end_date) VALUES(?,?,?)').run(id,start.toISOString(),end.toISOString())};
const nextEnfCode=()=>'EN'+String(Math.max(0,...db.prepare("SELECT code FROM users WHERE role='enforcer'").all().map(u=>parseInt(String(u.code).replace(/\D/g,''))||0))+1).padStart(3,'0');
const addEnforcer=r=>{if(!String(r.name||'').trim())fail('name is required');const pw=String(r.password||'').trim();if(pw.length<6)fail('password (at least 6 characters) is required');
  const code=String(r.code||'').trim().toUpperCase().replace(/[\s-]/g,'')||nextEnfCode();
  if(db.prepare('SELECT 1 FROM users WHERE code=?').get(code))fail('code '+code+' is already used');
  db.prepare("INSERT INTO users(role,code,name,contact,password_hash) VALUES('enforcer',?,?,?,?)").run(code,String(r.name).trim(),String(r.contact||'').trim()||null,bcrypt.hashSync(pw,10))};
const num=v=>v===''||v==null?null:Number(v);
const addFee=r=>{const reg=normReg(r.vehicle_reg);if(!reg)fail('vehicle_reg is required');
  const st=String(r.status||'unpaid').toLowerCase();if(!['unpaid','paid'].includes(st))fail('status must be unpaid or paid');
  const a=r.start_time?new Date(r.start_time):null,b=r.end_time?new Date(r.end_time):null;if((a&&isNaN(a))||(b&&isNaN(b)))fail('start_time / end_time is not a valid date');
  let hours=num(r.hours),amount=num(r.amount);if((hours!==null&&isNaN(hours))||(amount!==null&&isNaN(amount)))fail('hours and amount must be numbers');
  if(amount===null){if(!a||!b||b<=a)fail('amount is required (or give start_time and end_time so it can be calculated)');
    const c=S(),mins=(b-a)/6e4;hours=mins<=Number(c.grace_minutes)?0:Math.ceil(mins/60);amount=hours*Number(c.hourly_rate)}
  const v=db.prepare('SELECT user_id FROM vehicles WHERE reg_number=?').get(reg);let enf=null;
  if(String(r.enforcer||'').trim()){const e=db.prepare("SELECT id FROM users WHERE role='enforcer' AND code=?").get(String(r.enforcer).trim().toUpperCase());if(!e)fail('enforcer '+r.enforcer+' not found');enf=e.id}
  db.prepare('INSERT INTO fees(vehicle_reg,user_id,enforcer_id,start_time,end_time,hours,amount,status,reason) VALUES(?,?,?,?,?,?,?,?,?)').run(reg,v?v.user_id:null,enf,a?a.toISOString():null,b?b.toISOString():null,hours,amount,st,r.reason||(v?passOf(v.user_id).status:'UNREGISTERED'))};
const ADDERS={students:addStudent,enforcers:addEnforcer,vehicles:addVehicle,passes:addPass,fees:addFee};
// Import: rows whose id exists update that row; other rows are added as new (not possible for payments). All-or-nothing.
app.post('/api/admin/table/:name/import',auth('admin'),wrap((q,s)=>{const T=tbl(q.params.name),rows=q.body.rows,add=ADDERS[q.params.name];
  if(!Array.isArray(rows)||!rows.length)fail('No rows found in the file');let updated=0,added=0,defaulted=0;
  try{db.transaction(()=>{rows.forEach((r,i)=>{const hasId=r.id!==undefined&&String(r.id).trim()!=='';
    try{const exists=hasId&&db.prepare(`SELECT 1 FROM ${T.t} WHERE id=?${T.w?' AND '+T.w:''}`).get(r.id);
      if(exists){if(T.t==='users'&&r.password)r.new_password=r.password;if(!T.cols.some(c=>c in r)&&!r.new_password)return;updateRow(T,r.id,r);updated++}
      else if(add){if(add(r))defaulted++;added++}
      else fail(hasId?'id '+r.id+' does not exist in this table':'new rows cannot be added to this table (only existing rows can be updated)')}
    catch(e){e.message=`Row ${r._row||i+2}: `+e.message;throw e}})})()}
  catch(e){fail(e.message+' - nothing was changed')}
  s.json({updated,added,defaulted})}));
app.delete('/api/admin/table/:name/:id',auth('admin'),wrap((q,s)=>{const T=tbl(q.params.name),id=q.params.id;
  const row=db.prepare(`SELECT * FROM ${T.t} WHERE id=?${T.w?' AND '+T.w:''}`).get(id);if(!row)fail('Row not found',404);
  db.transaction(()=>{
    if(T.t==='users'&&row.role==='student'){
      db.prepare("UPDATE fees SET status='unpaid' WHERE id IN(SELECT fee_id FROM payments WHERE user_id=? AND status='pending' AND fee_id IS NOT NULL)").run(id);
      for(const t of['vehicles','passes','payments'])db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(id);
      db.prepare('UPDATE fees SET user_id=NULL WHERE user_id=?').run(id)}
    if(T.t==='payments'&&row.status==='pending'&&row.fee_id)db.prepare("UPDATE fees SET status='unpaid' WHERE id=?").run(row.fee_id);
    db.prepare(`DELETE FROM ${T.t} WHERE id=?`).run(id)})();s.json({ok:true})}));
app.post('/api/admin/passes',auth('admin'),wrap((q,s)=>{
  const u=db.prepare("SELECT id FROM users WHERE role='student' AND code=?").get((q.body.code||'').trim().toUpperCase());if(!u)fail('Student not found');
  const a=new Date(q.body.start_date||Date.now()),b=new Date(q.body.end_date);
  if(isNaN(a)||isNaN(b)||b<=a)fail('Enter a valid start date and an end date after it');
  db.prepare('INSERT INTO passes(user_id,start_date,end_date) VALUES(?,?,?)').run(u.id,a.toISOString(),b.toISOString());s.json({ok:true})}));
app.get('/api/admin/backup',auth('admin'),(q,s)=>s.download(DBF,'sliit-parking-backup.db'));

// ---------- ENFORCER
app.get('/api/enforcer/me',auth('enforcer'),wrap((q,s)=>s.json(db.prepare('SELECT code,name FROM users WHERE id=?').get(q.user.id))));
app.get('/api/enforcer/lookup',auth('enforcer'),wrap((q,s)=>{const t=(q.query.q||'').trim();if(!t)fail('Enter a student ID or vehicle number');
  const u=db.prepare("SELECT id FROM users WHERE role='student' AND (qr_token=? OR code=?)").get(t,t.toUpperCase())||db.prepare('SELECT user_id id FROM vehicles WHERE reg_number=?').get(normReg(t));
  s.json(u?{found:true,...profile(u.id)}:{found:false,reg:normReg(t)})}));
app.post('/api/enforcer/drafts',auth('enforcer'),wrap((q,s)=>{const reg=normReg(q.body.vehicle_reg),t=new Date(q.body.start_time);
  if(!reg||isNaN(t))fail('Vehicle number and start time are required');
  const v=db.prepare('SELECT user_id FROM vehicles WHERE reg_number=?').get(reg);
  if(v&&passOf(v.user_id).status==='ACTIVE')fail('This vehicle has an active pass - no fee can be added');
  if(db.prepare("SELECT 1 FROM fees WHERE vehicle_reg=? AND status='draft'").get(reg))fail('A draft already exists for this vehicle');
  db.prepare("INSERT INTO fees(vehicle_reg,user_id,enforcer_id,start_time,status) VALUES(?,?,?,?,'draft')").run(reg,v?v.user_id:null,q.user.id,t.toISOString());s.json({ok:true})}));
app.get('/api/enforcer/fees',auth('enforcer'),wrap((q,s)=>{const m=q.query.view;let w='enforcer_id=?';
  if(m==='draft')w+=" AND status='draft'";else{w+=" AND status!='draft'";if(m==='pending'||m==='unpaid')w+=` AND status='${m}'`}
  s.json(db.prepare(`SELECT id,vehicle_reg,start_time,end_time,hours,amount,status,created_at FROM fees WHERE ${w} ORDER BY id DESC`).all(q.user.id))}));
app.patch('/api/enforcer/fees/:id/finish',auth('enforcer'),wrap((q,s)=>{
  const f=db.prepare("SELECT * FROM fees WHERE id=? AND enforcer_id=? AND status='draft'").get(q.params.id,q.user.id);if(!f)fail('Draft not found',404);
  const a=new Date(f.start_time),b=new Date(q.body.end_time);if(isNaN(b)||b<=a)fail('Leave time must be after the start time');
  const c=S(),mins=(b-a)/6e4,hours=mins<=Number(c.grace_minutes)?0:Math.ceil(mins/60),amount=hours*Number(c.hourly_rate);
  if(!amount){db.prepare('DELETE FROM fees WHERE id=?').run(f.id);return s.json({hours:0,amount:0})}
  const v=db.prepare('SELECT user_id FROM vehicles WHERE reg_number=?').get(f.vehicle_reg);
  db.prepare("UPDATE fees SET end_time=?,hours=?,amount=?,status='unpaid',reason=? WHERE id=?").run(b.toISOString(),hours,amount,v?passOf(v.user_id).status:'UNREGISTERED',f.id);
  s.json({hours,amount})}));

app.listen(process.env.PORT||3000,()=>console.log('SLIIT Parking running. Open http://localhost:'+(process.env.PORT||3000)+'/student/  (serving '+PUB+')'));
