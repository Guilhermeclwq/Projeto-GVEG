import http from 'node:http';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTursoDatabase, verifyTursoSchema } from './src/turso-db.js';

const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
try{
  const envText=await readFile(path.join(root,'.env'),'utf8');
  for(const line of envText.replace(/^\uFEFF/,'').split(/\r?\n/)){const match=line.trim().match(/^([A-Z_]+)\s*=\s*(.*)$/);if(!match||!['HOST','PORT','NODE_ENV','SESSION_DAYS','TURSO_DATABASE_URL','TURSO_AUTH_TOKEN'].includes(match[1])||process.env[match[1]]!==undefined)continue;let value=match[2].trim();if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);process.env[match[1]]=value;}
}catch(error){if(error.code!=='ENOENT')throw error;}
function databaseFailureClass(error){const code=String(error?.code||'').toUpperCase();if(/ENOTFOUND|EAI_AGAIN|DNS/.test(code))return'DNS';if(/AUTH|401|403/.test(code))return'AUTH';if(/SSL|CERT|TLS/.test(code))return'TLS';if(/TIMEOUT|ETIMEDOUT|ABORT/.test(code))return'TIMEOUT';if(/ECONNREFUSED/.test(code))return'REFUSED';return'UNAVAILABLE';}
const db = openTursoDatabase();
try { await db.prepare('SELECT 1').get(); await verifyTursoSchema(db); }
catch (error) { console.error('Turso startup check failed:',databaseFailureClass(error)); await db.close(); process.exit(1); }

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const sessionDays = Math.max(1, Math.min(30, Number(process.env.SESSION_DAYS || 7)));
const loginAttempts = new Map();
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const cookieName = 'gveg_session';
const permissionModules=['products','materials','production','purchases','suppliers','sales','customers','finance','reports','receipts'];

function send(res, status, value, headers = {}) {
  const body = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value);
  const contentType=typeof value === 'string'?'text/plain; charset=utf-8':Buffer.isBuffer(value)?'application/octet-stream':'application/json; charset=utf-8';
  res.writeHead(status, { 'Content-Type':contentType, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...headers });
  res.end(body);
}
async function bodyJson(req) {
  let raw = '';
  for await (const part of req) { raw += part; if (raw.length > 20_000) throw new Error('Payload muito grande.'); }
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('Corpo JSON inválido.'); }
}
function cookie(req, name) {
  const found = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}
async function sessionUser(req) {
  const token = cookie(req, cookieName);
  if (!token) return null;
  const row = await db.prepare(`SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(hashToken(token), Date.now());
  return row || null;
}
const cookieOptions = (maxAge) => `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
function validOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
async function createSession(res, userId) {
  await db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
  const token = randomBytes(32).toString('base64url');
  await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), userId, Date.now() + sessionDays * 86400_000);
  const cookieValue = `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDays * 86400}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookieValue);
}
function fail(res, code, message) { return send(res, code, { error: message }); }
function textField(value,max=200) { return String(value??'').trim().slice(0,max); }
function parseMoneyCents(value) {
  const amount=typeof value==='number'?value:Number(String(value??'').replace(',','.'));
  return Number.isFinite(amount)&&amount>=0&&amount<=10_000_000?Math.round(amount*100):null;
}
function validDate(value,allowBlank=false) { const date=String(value??'');if(allowBlank&&!date)return '';if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return null;const parsed=new Date(`${date}T00:00:00Z`);return !Number.isNaN(parsed.valueOf())&&parsed.toISOString().slice(0,10)===date?date:null; }
function validQty(value) { const n=Number(value); return Number.isFinite(n)&&n>=0&&n<=1_000_000_000?n:null; }
const todayLocalIso = () => new Date().toISOString().slice(0,10);
async function audit(userId,action,entity,entityId,details={}) { await db.prepare('INSERT INTO audit_logs(id,user_id,action,entity,entity_id,details) VALUES(?,?,?,?,?,?)').run(randomUUID(),userId,action,entity,entityId,JSON.stringify(details)); }
async function permissionsFor(user){if(user.role==='owner')return Object.fromEntries(permissionModules.map(module=>[module,true]));const rows=await db.prepare("SELECT module,allowed FROM role_permissions WHERE role='manager'").all();return Object.fromEntries(rows.map(row=>[row.module,Boolean(row.allowed)]));}
function moduleForPath(pathname){if(pathname.startsWith('/recibos'))return'receipts';if(pathname.startsWith('/api/products'))return'products';if(pathname.startsWith('/api/materials'))return'materials';if(pathname.startsWith('/api/production'))return'production';if(pathname.startsWith('/api/purchases')||pathname==='/api/material-cost-history')return'purchases';if(pathname.startsWith('/api/suppliers'))return'suppliers';if(pathname.startsWith('/api/sales'))return'sales';if(pathname.startsWith('/api/customers'))return'customers';if(pathname.startsWith('/api/expenses')||pathname==='/api/dashboard')return'finance';if(pathname.startsWith('/api/reports/'))return'reports';return null;}

const server = http.createServer((req, res) => db.withRequest(async () => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { return fail(res, 400, 'Endereço inválido.'); }
  let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{return fail(res,400,'Endereço inválido.');}
  try {
    if (req.method === 'GET' && pathname === '/api/setup-status') return send(res, 200, { needsSetup: (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n === 0 });
    if (['POST','PUT','PATCH','DELETE'].includes(req.method) && pathname.startsWith('/api/')) {
      if (!validOrigin(req)) return fail(res, 403, 'Origem da solicitação inválida.');
    }
    if (req.method === 'POST' && pathname === '/api/setup') {
      if ((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n !== 0) return fail(res, 409, 'A configuração inicial já foi concluída.');
      const input = await bodyJson(req);
      const name = String(input.name || '').trim().slice(0, 100);
      const email = String(input.email || '').trim().toLowerCase().slice(0, 254);
      const password = String(input.password || '');
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) return fail(res, 400, 'Informe nome, e-mail válido e senha com pelo menos 12 caracteres.');
      const salt = randomBytes(16).toString('hex');
      const digest = await scrypt(password, salt, 64);
      const userId = randomUUID();
      const insertOwner = db.prepare("INSERT INTO users(id,name,email,password_hash,password_salt,role) VALUES(?,?,?,?,?,'owner')");
      await db.exec('BEGIN IMMEDIATE');
      try { if ((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n !== 0) throw new Error('SETUP_DONE'); await insertOwner.run(userId,name,email,digest.toString('hex'),salt); await db.exec('COMMIT'); }
      catch (error) { await db.exec('ROLLBACK'); if (error.message === 'SETUP_DONE') return fail(res,409,'A configuração inicial já foi concluída.'); throw error; }
      await createSession(res,userId);
      const user={id:userId,name,email,role:'owner'};return send(res,201,{user,permissions:await permissionsFor(user)});
    }
    if (req.method === 'POST' && pathname === '/api/login') {
      const ip = req.socket.remoteAddress || 'local';
      const attempts = loginAttempts.get(ip) || { count:0, until:0 };
      if (attempts.until > Date.now() && attempts.count >= 8) return fail(res,429,'Muitas tentativas. Aguarde alguns minutos e tente novamente.');
      const input = await bodyJson(req);
      const email = String(input.email || '').trim().toLowerCase().slice(0,254);
      const password = String(input.password || '');
      const user = await db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
      const salt = user?.password_salt || 'gveg-login-salt';
      const actual = await scrypt(password, salt, 64);
      const expected = user ? Buffer.from(user.password_hash,'hex') : Buffer.alloc(64);
      const good = timingSafeEqual(actual, expected) && Boolean(user);
      if (!good) {
        const updated = attempts.until > Date.now() ? { ...attempts, count:attempts.count+1 } : { count:1, until:Date.now()+10*60_000 };
        loginAttempts.set(ip,updated);
        return fail(res,401,'E-mail ou senha incorretos.');
      }
      loginAttempts.delete(ip);
      await createSession(res,user.id);
      const loggedIn={id:user.id,name:user.name,email:user.email,role:user.role};return send(res,200,{user:loggedIn,permissions:await permissionsFor(loggedIn)});
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      const token = cookie(req,cookieName);
      if (token) await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
      res.setHeader('Set-Cookie',cookieOptions(0));
      return send(res,200,{ok:true});
    }

    const user = await sessionUser(req);
    if(user&&req.method==='GET'&&pathname==='/api/me')return send(res,200,{user,permissions:await permissionsFor(user)});
    const requiredModule=moduleForPath(pathname);if(user&&requiredModule&&user.role!=='owner'&&!(await permissionsFor(user))[requiredModule])return fail(res,403,'O proprietário não liberou este módulo para o seu perfil.');
    if (pathname.startsWith('/api/') && pathname !== '/api/me') {
      if (!user) return fail(res,401,'Sua sessão expirou. Entre novamente.');
    }
    if (req.method === 'GET' && pathname === '/api/me') return user ? send(res,200,{user,permissions:await permissionsFor(user)}) : fail(res,401,'Não autenticado.');
    if (pathname.startsWith('/api/') && user) {
      if(pathname==='/api/role-permissions'&&user.role!=='owner')return fail(res,403,'Somente o proprietário pode configurar permissões.');
      if(req.method==='GET'&&pathname==='/api/role-permissions'){const permissions=await permissionsFor({role:'manager'});return send(res,200,{modules:permissionModules.map(module=>({module,allowed:permissions[module]||false}))});}
      if(req.method==='GET'&&pathname==='/api/permissions')return send(res,200,{permissions:await permissionsFor(user)});
      if(req.method==='PATCH'&&pathname==='/api/role-permissions'){
        const input=await bodyJson(req);if(!input.modules||typeof input.modules!=='object'||Array.isArray(input.modules))return fail(res,400,'Lista de permissões inválida.');
        await db.exec('BEGIN IMMEDIATE');try{for(const [module,allowed] of Object.entries(input.modules)){if(!permissionModules.includes(module)||typeof allowed!=='boolean')throw new Error('PERMISSIONS_INVALID');await db.prepare("INSERT INTO role_permissions(role,module,allowed,updated_at) VALUES('manager',?,?,CURRENT_TIMESTAMP) ON CONFLICT(role,module) DO UPDATE SET allowed=excluded.allowed,updated_at=CURRENT_TIMESTAMP").run(module,allowed?1:0);}await audit(user.id,'permissions.manager.updated','role','manager',{modules:Object.keys(input.modules)});await db.exec('COMMIT');}catch(error){if(db.isTransaction)await db.exec('ROLLBACK');if(error.message==='PERMISSIONS_INVALID')return fail(res,400,'Permissão ou valor inválido.');throw error;}return send(res,200,{permissions:await permissionsFor({role:'manager'})});
      }
      if (req.method === 'GET' && pathname === '/api/users') {
        if(user.role!=='owner') return fail(res,403,'Somente o proprietário pode administrar usuários.');
        return send(res,200,{items:await db.prepare('SELECT id,name,email,role,active,created_at FROM users ORDER BY created_at').all()});
      }
      if (req.method === 'POST' && pathname === '/api/users') {
        if(user.role!=='owner') return fail(res,403,'Somente o proprietário pode administrar usuários.');
        const input=await bodyJson(req),name=textField(input.name,100),email=textField(input.email,254).toLowerCase(),password=String(input.password||''),role=input.role;
        if(name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<12||!['owner','manager'].includes(role)) return fail(res,400,'Confira nome, e-mail, perfil e senha (mínimo de 12 caracteres).');
        const salt=randomBytes(16).toString('hex'),digest=await scrypt(password,salt,64),id=randomUUID();
        await db.prepare('INSERT INTO users(id,name,email,password_hash,password_salt,role) VALUES(?,?,?,?,?,?)').run(id,name,email,digest.toString('hex'),salt,role);
        await audit(user.id,'user.created','user',id,{role});
        return send(res,201,{item:await db.prepare('SELECT id,name,email,role,active,created_at FROM users WHERE id=?').get(id)});
      }
      if (req.method === 'PATCH' && /^\/api\/users\/[0-9a-f-]+$/.test(pathname)) {
        if(user.role!=='owner') return fail(res,403,'Somente o proprietário pode administrar usuários.');
        const id=pathname.split('/').at(-1),input=await bodyJson(req),active=input.active===true?1:input.active===false?0:null;
        if(active===null||id===user.id&&active===0) return fail(res,400,'Não é possível desativar esta conta.');
        const existing=await db.prepare('SELECT id FROM users WHERE id=?').get(id);if(!existing)return fail(res,404,'Usuário não encontrado.');
        await db.prepare('UPDATE users SET active=? WHERE id=?').run(active,id);await audit(user.id,active?'user.activated':'user.deactivated','user',id);
        return send(res,200,{ok:true});
      }
      if (req.method === 'GET' && pathname === '/api/audit') {
        if(user.role!=='owner') return fail(res,403,'Somente o proprietário pode consultar a auditoria.');
        const items=await db.prepare('SELECT a.*,u.name AS user_name FROM audit_logs a JOIN users u ON u.id=a.user_id ORDER BY created_at DESC LIMIT 250').all();
        return send(res,200,{items});
      }
      if (req.method === 'GET' && pathname === '/api/customers') return send(res,200,{items:await db.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE').all()});
      if (req.method === 'POST' && pathname === '/api/customers') {
        const input=await bodyJson(req),name=textField(input.name,160),document=textField(input.document,32),email=textField(input.email,254).toLowerCase();
        if(name.length<2||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))return fail(res,400,'Informe o nome do cliente e um e-mail válido, se aplicável.');
        const id=randomUUID();await db.prepare('INSERT INTO customers(id,name,document,email,phone,address,notes) VALUES(?,?,?,?,?,?,?)').run(id,name,document,email,textField(input.phone,32),textField(input.address,300),textField(input.notes,2000));await audit(user.id,'customer.created','customer',id);
        return send(res,201,{item:await db.prepare('SELECT * FROM customers WHERE id=?').get(id)});
      }
      if(req.method==='PATCH'&&/^\/api\/customers\/[0-9a-f-]+$/.test(pathname)){
        const id=pathname.split('/').at(-1),input=await bodyJson(req),name=textField(input.name,160),document=textField(input.document,32),email=textField(input.email,254).toLowerCase();if(name.length<2||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))||typeof input.active!=='boolean')return fail(res,400,'Confira os dados do cliente.');
        const exists=await db.prepare('SELECT id FROM customers WHERE id=?').get(id);if(!exists)return fail(res,404,'Cliente não encontrado.');await db.prepare('UPDATE customers SET name=?,document=?,email=?,phone=?,address=?,notes=?,active=? WHERE id=?').run(name,document,email,textField(input.phone,32),textField(input.address,300),textField(input.notes,2000),input.active?1:0,id);await audit(user.id,'customer.updated','customer',id,{active:input.active});return send(res,200,{item:await db.prepare('SELECT * FROM customers WHERE id=?').get(id)});
      }
      const salesQuery=`SELECT s.*,c.name AS customer_name,s.historical_received_cents+COALESCE((SELECT SUM(p.amount_cents) FROM sale_payments p WHERE p.sale_id=s.id),0) AS received_cents FROM sales s LEFT JOIN customers c ON c.id=s.customer_id`;
      if (req.method === 'GET' && pathname === '/api/sales') return send(res,200,{items:await db.prepare(`${salesQuery} ORDER BY s.sale_date DESC,s.created_at DESC`).all()});
      if (req.method === 'POST' && pathname === '/api/sales') {
        const input=await bodyJson(req),saleDate=validDate(input.saleDate),dueDate=validDate(input.dueDate,true),requestKey=textField(input.requestKey,60);
        if(!saleDate||dueDate===null||!requestKey||!Array.isArray(input.items)||!input.items.length||input.items.length>100)return fail(res,400,'Confira a data, os itens da venda e o identificador da operação.');
        const previous=await db.prepare(`${salesQuery} WHERE s.request_key=?`).get(requestKey);if(previous)return send(res,200,{item:previous,replayed:true});
        const customerId=textField(input.customerId,60)||null;if(customerId&&!await db.prepare('SELECT id FROM customers WHERE id=? AND active=1').get(customerId))return fail(res,400,'Cliente não encontrado ou inativo.');
        const items=[];let subtotal=0;
        for(const item of input.items){
          const qty=Number(item.quantity);if(!Number.isFinite(qty)||qty<=0||qty>10000)return fail(res,400,'As quantidades precisam ser maiores que zero.');
          const productId=textField(item.productId,60)||null;const product=productId?await db.prepare('SELECT id,name,sku,active FROM products WHERE id=?').get(productId):null;
          if(productId&&(!product||!product.active))return fail(res,400,'Um dos modelos selecionados não está disponível.');
          const name=product?.name||textField(item.name,160),sku=product?.sku||textField(item.sku,60),price=parseMoneyCents(item.unitPrice),cost=productId?((await db.prepare("SELECT unit_cost_cents FROM production_orders WHERE product_id=? AND status='completed' AND unit_cost_cents IS NOT NULL ORDER BY completed_at DESC LIMIT 1").get(productId))?.unit_cost_cents??null):null;
          if(name.length<2||price===null)return fail(res,400,'Confira o modelo e o preço de cada item.');
          const line=Math.round(qty*price);subtotal+=line;items.push({productId,name,sku,color:textField(item.color,80),qty,price,cost,line});
        }
        const discount=parseMoneyCents(input.discount??0),initial=parseMoneyCents(input.initialReceived??0);
        if(discount===null||initial===null||discount>subtotal||initial>subtotal-discount)return fail(res,400,'Desconto ou valor recebido não pode ultrapassar o total da venda.');
        if(input.historical!==undefined&&typeof input.historical!=='boolean')return fail(res,400,'O indicador de venda histórica deve ser verdadeiro ou falso.');
        if(subtotal>0){let allocatedDiscount=0;items.forEach((item,index)=>{const part=index===items.length-1?discount-allocatedDiscount:Math.floor(discount*item.line/subtotal);item.line-=part;allocatedDiscount+=part;});}
        const total=subtotal-discount,method=textField(input.paymentMethod,40)||'Não informado',paidDate=input.paidDate?validDate(input.paidDate):saleDate;if(!paidDate)return fail(res,400,'Data do recebimento inválida.');
        const id=randomUUID();await db.exec('BEGIN IMMEDIATE');
        try {
          const seq=(await db.prepare("SELECT COUNT(*) AS n FROM sales WHERE substr(sale_date,1,4)=?").get(saleDate.slice(0,4))).n+1,number=`V-${saleDate.slice(0,4)}-${String(seq).padStart(5,'0')}`;
          const historical=Boolean(input.historical);
          await db.prepare('INSERT INTO sales(id,number,request_key,customer_id,sale_date,due_date,subtotal_cents,discount_cents,total_cents,historical,historical_received_cents,status,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,number,requestKey,customerId,saleDate,dueDate,subtotal,discount,total,historical?1:0,historical?initial:0,initial===total?'paid':'open',textField(input.notes,2000),user.id);
          for(const item of items){await db.prepare('INSERT INTO sale_items(id,sale_id,product_id,product_name,sku,color,quantity,unit_price_cents,unit_cost_cents,line_total_cents) VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,item.productId,item.name,item.sku,item.color,item.qty,item.price,item.cost,item.line);if(item.productId&&!historical){const stock=(await db.prepare('SELECT quantity FROM product_stock WHERE product_id=?').get(item.productId))?.quantity||0;if(stock<item.qty){await db.exec('ROLLBACK');return fail(res,409,`Estoque insuficiente de ${item.name}.`);}await db.prepare('UPDATE product_stock SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=?').run(item.qty,item.productId);}}
          if(initial>0&&!historical)await db.prepare('INSERT INTO sale_payments(id,request_key,sale_id,amount_cents,paid_at,method,note,user_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),randomUUID(),id,initial,paidDate,method,'Recebimento informado na venda',user.id);
          await audit(user.id,input.historical?'sale.historical.created':'sale.created','sale',id,{number,total_cents:total});await db.exec('COMMIT');
        }catch(error){if(db.isTransaction)await db.exec('ROLLBACK');throw error;}
        return send(res,201,{item:await db.prepare(`${salesQuery} WHERE s.id=?`).get(id)});
      }
      if (req.method === 'GET' && /^\/api\/sales\/[0-9a-f-]+$/.test(pathname)) {
        const id=pathname.split('/').at(-1),sale=await db.prepare(`${salesQuery} WHERE s.id=?`).get(id);if(!sale)return fail(res,404,'Venda não encontrada.');
        return send(res,200,{item:sale,items:await db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(id),payments:await db.prepare('SELECT * FROM sale_payments WHERE sale_id=? ORDER BY paid_at').all(id)});
      }
      if (req.method === 'POST' && /^\/api\/sales\/[0-9a-f-]+\/payments$/.test(pathname)) {
        const id=pathname.split('/')[3],input=await bodyJson(req),amount=parseMoneyCents(input.amount),paidAt=validDate(input.paidAt),method=textField(input.method,40),note=textField(input.note,250),requestKey=textField(input.requestKey,60);
        if(amount===null||amount<=0||!paidAt||method.length<2||!requestKey)return fail(res,400,'Informe valor, data, forma de pagamento e chave da operação.');
        const prior=await db.prepare('SELECT sale_id FROM sale_payments WHERE request_key=?').get(requestKey);if(prior)return prior.sale_id===id?send(res,200,{item:await db.prepare(`${salesQuery} WHERE s.id=?`).get(id),replayed:true}):fail(res,409,'A chave já foi usada em outro recebimento.');
        await db.exec('BEGIN IMMEDIATE');try{
          const sale=await db.prepare(`${salesQuery} WHERE s.id=?`).get(id);if(!sale||sale.status==='cancelled'){await db.exec('ROLLBACK');return fail(res,404,'Venda ativa não encontrada.');}
          if(sale.received_cents+amount>sale.total_cents){await db.exec('ROLLBACK');return fail(res,409,'O recebimento excede o saldo pendente.');}
          await db.prepare('INSERT INTO sale_payments(id,request_key,sale_id,amount_cents,paid_at,method,note,user_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),requestKey,id,amount,paidAt,method,note,user.id);
          const received=sale.received_cents+amount;await db.prepare("UPDATE sales SET status=? WHERE id=?").run(received===sale.total_cents?'paid':'open',id);await audit(user.id,'sale.payment.recorded','sale',id,{amount_cents:amount,paid_at:paidAt});await db.exec('COMMIT');
        }catch(error){if(db.isTransaction)await db.exec('ROLLBACK');throw error;}
        return send(res,201,{item:await db.prepare(`${salesQuery} WHERE s.id=?`).get(id)});
      }
      if (req.method === 'POST' && /^\/api\/sales\/[0-9a-f-]+\/cancel$/.test(pathname)) {
        const id=pathname.split('/')[3],input=await bodyJson(req),reason=textField(input.reason,250);if(reason.length<3)return fail(res,400,'Informe o motivo do cancelamento.');
        await db.exec('BEGIN IMMEDIATE');try{const sale=await db.prepare(`${salesQuery} WHERE s.id=?`).get(id);if(!sale||sale.status==='cancelled'){await db.exec('ROLLBACK');return fail(res,404,'Venda ativa não encontrada.');}if(sale.received_cents>0){await db.exec('ROLLBACK');return fail(res,409,'Esta venda já tem recebimentos. Registre a devolução antes de cancelar.');}if(!sale.historical)for(const item of await db.prepare('SELECT product_id,quantity FROM sale_items WHERE sale_id=? AND product_id IS NOT NULL').all(id))await db.prepare('UPDATE product_stock SET quantity=quantity+?,updated_at=CURRENT_TIMESTAMP WHERE product_id=?').run(item.quantity,item.product_id);await db.prepare("UPDATE sales SET status='cancelled' WHERE id=?").run(id);await audit(user.id,'sale.cancelled','sale',id,{reason});await db.exec('COMMIT');}catch(error){if(db.isTransaction)await db.exec('ROLLBACK');throw error;}return send(res,200,{ok:true});
      }
      if (req.method === 'GET' && pathname === '/api/expenses') return send(res,200,{items:await db.prepare(`SELECT e.*,COALESCE((SELECT SUM(p.amount_cents) FROM expense_payments p WHERE p.expense_id=e.id),0) AS paid_cents FROM expenses e ORDER BY e.expense_date DESC,e.created_at DESC`).all()});
      if (req.method === 'POST' && pathname === '/api/expenses') {
        const input=await bodyJson(req),description=textField(input.description,180),category=textField(input.category,80),amount=parseMoneyCents(input.amount),expenseDate=validDate(input.expenseDate),dueDate=validDate(input.dueDate,true);
        if(description.length<2||!category||amount===null||amount<=0||!expenseDate||dueDate===null)return fail(res,400,'Confira descrição, categoria, valor e datas da despesa.');
        const id=randomUUID();await db.prepare('INSERT INTO expenses(id,description,category,amount_cents,expense_date,due_date,notes,created_by) VALUES(?,?,?,?,?,?,?,?)').run(id,description,category,amount,expenseDate,dueDate,textField(input.notes,2000),user.id);await audit(user.id,'expense.created','expense',id,{amount_cents:amount,category});return send(res,201,{item:await db.prepare('SELECT * FROM expenses WHERE id=?').get(id)});
      }
      const purchasesQuery='SELECT b.*,s.name AS supplier_name,COALESCE((SELECT SUM(p.amount_cents) FROM purchase_payments p WHERE p.purchase_id=b.id),0) AS paid_cents FROM purchases b JOIN suppliers s ON s.id=b.supplier_id';
      if(req.method==='GET'&&pathname==='/api/purchases')return send(res,200,{items:await db.prepare(`${purchasesQuery} ORDER BY b.purchase_date DESC,b.created_at DESC`).all()});
      if(req.method==='POST'&&pathname==='/api/purchases'){
        const input=await bodyJson(req),requestKey=textField(input.requestKey,60),supplierId=textField(input.supplierId,60),purchaseDate=validDate(input.purchaseDate),dueDate=validDate(input.dueDate,true);
        if(!requestKey||!supplierId||!purchaseDate||dueDate===null||!Array.isArray(input.items)||!input.items.length||input.items.length>100)return fail(res,400,'Confira fornecedor, data e itens da compra.');
        const prior=await db.prepare(`${purchasesQuery} WHERE b.request_key=?`).get(requestKey);if(prior)return send(res,200,{item:prior,replayed:true});if(!await db.prepare('SELECT id FROM suppliers WHERE id=? AND active=1').get(supplierId))return fail(res,400,'Fornecedor não encontrado ou inativo.');
        const items=[];let subtotal=0;const uniqueMaterials=new Set();for(const row of input.items){const materialId=textField(row.materialId,60),qty=Number(row.quantity),price=parseMoneyCents(row.unitCost),material=await db.prepare('SELECT id,name,unit_cost_cents,supplier_id,last_purchase_date FROM materials WHERE id=? AND active=1').get(materialId);if(!material||uniqueMaterials.has(materialId)||!Number.isFinite(qty)||qty<=0||qty>1e9||price===null)return fail(res,400,'Confira materiais sem repetição, quantidades e custos unitários.');uniqueMaterials.add(materialId);const line=Math.round(qty*price);subtotal+=line;items.push({materialId,name:material.name,qty,price,line,previousCost:material.unit_cost_cents,previousSupplier:material.supplier_id,previousDate:material.last_purchase_date});}
        const freight=parseMoneyCents(input.freight??0),discount=parseMoneyCents(input.discount??0),initial=parseMoneyCents(input.initialPaid??0);if(freight===null||discount===null||initial===null||discount>subtotal||initial>subtotal+freight-discount)return fail(res,400,'Frete, desconto ou pagamento inicial inválido.');const total=subtotal+freight-discount;if(total<=0)return fail(res,400,'O total da compra deve ser maior que zero.');
        const id=randomUUID();await db.exec('BEGIN IMMEDIATE');try{const seq=(await db.prepare("SELECT COUNT(*) n FROM purchases WHERE substr(purchase_date,1,4)=?").get(purchaseDate.slice(0,4))).n+1,number=`C-${purchaseDate.slice(0,4)}-${String(seq).padStart(5,'0')}`;await db.prepare('INSERT INTO purchases(id,number,request_key,supplier_id,purchase_date,due_date,freight_cents,discount_cents,total_cents,status,notes,user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,number,requestKey,supplierId,purchaseDate,dueDate,freight,discount,total,initial===total?'paid':'open',textField(input.notes,2000),user.id);for(const item of items){await db.prepare('INSERT INTO purchase_items(id,purchase_id,material_id,quantity,unit_cost_cents,total_cost_cents,previous_unit_cost_cents,previous_supplier_id,previous_purchase_date) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,item.materialId,item.qty,item.price,item.line,item.previousCost,item.previousSupplier,item.previousDate);await db.prepare('UPDATE materials SET quantity=quantity+?,unit_cost_cents=?,supplier_id=?,last_purchase_date=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(item.qty,item.price,supplierId,purchaseDate,item.materialId);await db.prepare("INSERT INTO inventory_movements(id,material_id,user_id,kind,quantity_delta,reason) VALUES(?,?,?,'purchase',?,?)").run(randomUUID(),item.materialId,user.id,item.qty,`Entrada da compra ${number}`);await db.prepare('INSERT INTO material_cost_history(id,material_id,supplier_id,purchase_id,unit_cost_cents,purchase_date) VALUES(?,?,?,?,?,?)').run(randomUUID(),item.materialId,supplierId,id,item.price,purchaseDate);await audit(user.id,'stock.purchase','material',item.materialId,{purchase_number:number,quantity:item.qty,cost_cents:item.price});}if(initial>0)await db.prepare('INSERT INTO purchase_payments(id,request_key,purchase_id,amount_cents,paid_at,method,user_id) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),randomUUID(),id,initial,purchaseDate,textField(input.paymentMethod,40)||'Não informado',user.id);await audit(user.id,'purchase.created','purchase',id,{number,total_cents:total});await db.exec('COMMIT');}catch(error){if(db.isTransaction)await db.exec('ROLLBACK');throw error;}
        return send(res,201,{item:await db.prepare(`${purchasesQuery} WHERE b.id=?`).get(id)});
      }
      if(req.method==='POST'&&/^\/api\/purchases\/[0-9a-f-]+\/payments$/.test(pathname)){
        const id=pathname.split('/')[3],input=await bodyJson(req),amount=parseMoneyCents(input.amount),paidAt=validDate(input.paidAt),method=textField(input.method,40),requestKey=textField(input.requestKey,60);if(amount===null||amount<=0||!paidAt||method.length<2||!requestKey)return fail(res,400,'Informe valor, data, forma de pagamento e chave da operação.');const prior=await db.prepare('SELECT purchase_id FROM purchase_payments WHERE request_key=?').get(requestKey);if(prior)return prior.purchase_id===id?send(res,200,{item:await db.prepare(`${purchasesQuery} WHERE b.id=?`).get(id),replayed:true}):fail(res,409,'A chave já foi usada em outro pagamento.');await db.exec('BEGIN IMMEDIATE');try{const purchase=await db.prepare(`${purchasesQuery} WHERE b.id=?`).get(id);if(!purchase||purchase.status==='cancelled'){await db.exec('ROLLBACK');return fail(res,404,'Compra ativa não encontrada.');}if(purchase.paid_cents+amount>purchase.total_cents){await db.exec('ROLLBACK');return fail(res,409,'O pagamento excede o saldo pendente.');}await db.prepare('INSERT INTO purchase_payments(id,request_key,purchase_id,amount_cents,paid_at,method,user_id) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),requestKey,id,amount,paidAt,method,user.id);await db.prepare('UPDATE purchases SET status=? WHERE id=?').run(purchase.paid_cents+amount===purchase.total_cents?'paid':'open',id);await audit(user.id,'purchase.payment.recorded','purchase',id,{amount_cents:amount,paid_at:paidAt});await db.exec('COMMIT');}catch(error){if(db.isTransaction)await db.exec('ROLLBACK');throw error;}return send(res,201,{item:await db.prepare(`${purchasesQuery} WHERE b.id=?`).get(id)});
      }
      if(req.method==='POST'&&/^\/api\/purchases\/[0-9a-f-]+\/cancel$/.test(pathname)){
        const id=pathname.split('/')[3],input=await bodyJson(req),reason=textField(input.reason,250);if(reason.length<3)return fail(res,400,'Informe o motivo do cancelamento.');await db.exec('BEGIN IMMEDIATE');try{const purchase=await db.prepare(`${purchasesQuery} WHERE b.id=?`).get(id);if(!purchase||purchase.status==='cancelled'){await db.exec('ROLLBACK');return fail(res,404,'Compra ativa não encontrada.');}if(purchase.paid_cents>0){await db.exec('ROLLBACK');return fail(res,409,'Compra com pagamentos não pode ser cancelada sem estorno.');}for(const item of await db.prepare('SELECT * FROM purchase_items WHERE purchase_id=? ORDER BY rowid DESC').all(id)){const material=await db.prepare('SELECT quantity,name FROM materials WHERE id=?').get(item.material_id);if(material.quantity<item.quantity){await db.exec('ROLLBACK');return fail(res,409,`O estoque de ${material.name} já foi consumido; não é possível reverter esta compra.`);}await db.prepare('UPDATE materials SET quantity=quantity-?,unit_cost_cents=?,supplier_id=?,last_purchase_date=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(item.quantity,item.previous_unit_cost_cents,item.previous_supplier_id,item.previous_purchase_date,item.material_id);await db.prepare("INSERT INTO inventory_movements(id,material_id,user_id,kind,quantity_delta,reason) VALUES(?,?,?,'adjustment',?,?)").run(randomUUID(),item.material_id,user.id,-item.quantity,`Reversão da compra ${purchase.number}: ${reason}`);}await db.prepare("UPDATE purchases SET status='cancelled' WHERE id=?").run(id);await audit(user.id,'purchase.cancelled','purchase',id,{reason});await db.exec('COMMIT');}catch(error){if(db.isTransaction)await db.exec('ROLLBACK');throw error;}return send(res,200,{ok:true});
      }
      if(req.method==='GET'&&pathname==='/api/material-cost-history')return send(res,200,{items:await db.prepare('SELECT h.*,m.name AS material_name,s.name AS supplier_name,b.status AS purchase_status FROM material_cost_history h JOIN materials m ON m.id=h.material_id JOIN suppliers s ON s.id=h.supplier_id JOIN purchases b ON b.id=h.purchase_id ORDER BY purchase_date DESC').all()});
      if (req.method === 'POST' && /^\/api\/expenses\/[0-9a-f-]+\/payments$/.test(pathname)) {
        const id=pathname.split('/')[3],input=await bodyJson(req),amount=parseMoneyCents(input.amount),paidAt=validDate(input.paidAt),method=textField(input.method,40),note=textField(input.note,250),requestKey=textField(input.requestKey,60);
        if(amount===null||amount<=0||!paidAt||method.length<2||!requestKey)return fail(res,400,'Informe valor, data, forma de pagamento e chave da operação.');const prior=await db.prepare('SELECT expense_id FROM expense_payments WHERE request_key=?').get(requestKey);if(prior)return prior.expense_id===id?send(res,200,{replayed:true}):fail(res,409,'A chave já foi usada em outro pagamento.');
        await db.exec('BEGIN IMMEDIATE');try{const expense=await db.prepare('SELECT e.*,COALESCE((SELECT SUM(p.amount_cents) FROM expense_payments p WHERE p.expense_id=e.id),0) AS paid_cents FROM expenses e WHERE e.id=?').get(id);if(!expense||expense.status==='cancelled'){await db.exec('ROLLBACK');return fail(res,404,'Despesa ativa não encontrada.');}if(expense.paid_cents+amount>expense.amount_cents){await db.exec('ROLLBACK');return fail(res,409,'O pagamento excede o saldo pendente.');}await db.prepare('INSERT INTO expense_payments(id,request_key,expense_id,amount_cents,paid_at,method,note,user_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),requestKey,id,amount,paidAt,method,note,user.id);const paid=expense.paid_cents+amount;await db.prepare('UPDATE expenses SET status=? WHERE id=?').run(paid===expense.amount_cents?'paid':'open',id);await audit(user.id,'expense.payment.recorded','expense',id,{amount_cents:amount,paid_at:paidAt});await db.exec('COMMIT');}catch(error){if(db.isTransaction)await db.exec('ROLLBACK');throw error;}
        return send(res,201,{item:await db.prepare('SELECT * FROM expenses WHERE id=?').get(id)});
      }
      if (req.method === 'POST' && /^\/api\/expenses\/[0-9a-f-]+\/cancel$/.test(pathname)) {
        const id=pathname.split('/')[3],input=await bodyJson(req),reason=textField(input.reason,250);if(reason.length<3)return fail(res,400,'Informe o motivo do cancelamento.');
        const expense=await db.prepare('SELECT e.*,COALESCE((SELECT SUM(p.amount_cents) FROM expense_payments p WHERE p.expense_id=e.id),0) AS paid_cents FROM expenses e WHERE e.id=?').get(id);
        if(!expense||expense.status==='cancelled')return fail(res,404,'Despesa ativa não encontrada.');if(expense.paid_cents>0)return fail(res,409,'Esta despesa já tem pagamentos.');
        await db.prepare("UPDATE expenses SET status='cancelled' WHERE id=?").run(id);await audit(user.id,'expense.cancelled','expense',id,{reason});return send(res,200,{ok:true});
      }
      if (req.method === 'GET' && pathname === '/api/dashboard') {
        const from=validDate(url.searchParams.get('from')),to=validDate(url.searchParams.get('to'));if(!from||!to||from>to||Date.parse(to)-Date.parse(from)>365*86400_000)return fail(res,400,'Informe um intervalo de até um ano com datas válidas.');
        const billed=(await db.prepare("SELECT COALESCE(SUM(total_cents),0) n FROM sales WHERE status<>'cancelled' AND sale_date BETWEEN ? AND ?").get(from,to)).n;
        const received=(await db.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE s.status<>'cancelled' AND p.paid_at BETWEEN ? AND ?").get(from,to)).n;
        const expenses=(await db.prepare("SELECT (SELECT COALESCE(SUM(amount_cents),0) FROM expenses WHERE status<>'cancelled' AND expense_date BETWEEN ? AND ?)+(SELECT COALESCE(SUM(total_cents),0) FROM purchases WHERE status<>'cancelled' AND purchase_date BETWEEN ? AND ?) n").get(from,to,from,to)).n;
        const paid=(await db.prepare('SELECT (SELECT COALESCE(SUM(amount_cents),0) FROM expense_payments WHERE paid_at BETWEEN ? AND ?)+(SELECT COALESCE(SUM(amount_cents),0) FROM purchase_payments p JOIN purchases b ON b.id=p.purchase_id WHERE b.status<>\'cancelled\' AND p.paid_at BETWEEN ? AND ?) n').get(from,to,from,to)).n;
        const receivable=(await db.prepare("SELECT COALESCE(SUM(s.total_cents-s.historical_received_cents-COALESCE((SELECT SUM(p.amount_cents) FROM sale_payments p WHERE p.sale_id=s.id),0)),0) n FROM sales s WHERE s.status='open'").get()).n;
        const payable=(await db.prepare("SELECT (SELECT COALESCE(SUM(e.amount_cents-COALESCE((SELECT SUM(p.amount_cents) FROM expense_payments p WHERE p.expense_id=e.id),0)),0) FROM expenses e WHERE e.status='open')+(SELECT COALESCE(SUM(b.total_cents-COALESCE((SELECT SUM(p.amount_cents) FROM purchase_payments p WHERE p.purchase_id=b.id),0)),0) FROM purchases b WHERE b.status='open') n").get()).n;
        const stock=await db.prepare('SELECT COALESCE(SUM(quantity*unit_cost_cents),0) AS cents,SUM(CASE WHEN quantity<=minimum_quantity THEN 1 ELSE 0 END) AS low FROM materials WHERE active=1').get();
        const units=(await db.prepare("SELECT COALESCE(SUM(i.quantity),0) n FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.status<>'cancelled' AND s.sale_date BETWEEN ? AND ?").get(from,to)).n;
        const models=await db.prepare("SELECT i.product_name AS name,SUM(i.quantity) AS quantity FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.status<>'cancelled' AND s.sale_date BETWEEN ? AND ? GROUP BY i.product_name ORDER BY quantity DESC LIMIT 5").all(from,to);
        const categories=await db.prepare("SELECT category,SUM(amount_cents) AS amount_cents FROM (SELECT category,amount_cents FROM expenses WHERE status<>'cancelled' AND expense_date BETWEEN ? AND ? UNION ALL SELECT 'Compras de materiais' AS category,total_cents AS amount_cents FROM purchases WHERE status<>'cancelled' AND purchase_date BETWEEN ? AND ?) GROUP BY category ORDER BY amount_cents DESC LIMIT 6").all(from,to,from,to);
        const daily=await db.prepare("WITH RECURSIVE d(day) AS (SELECT date(?) UNION ALL SELECT date(day,'+1 day') FROM d WHERE day<date(?)) SELECT d.day,COALESCE(r.amount,0) AS received_cents,COALESCE(e.amount,0) AS paid_expenses_cents FROM d LEFT JOIN (SELECT p.paid_at AS day,SUM(p.amount_cents) AS amount FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE s.status<>'cancelled' AND p.paid_at BETWEEN ? AND ? GROUP BY p.paid_at) r ON r.day=d.day LEFT JOIN (SELECT paid_at AS day,SUM(amount_cents) AS amount FROM (SELECT paid_at,amount_cents FROM expense_payments UNION ALL SELECT p.paid_at,p.amount_cents FROM purchase_payments p JOIN purchases b ON b.id=p.purchase_id WHERE b.status<>'cancelled') WHERE paid_at BETWEEN ? AND ? GROUP BY paid_at) e ON e.day=d.day ORDER BY d.day").all(from,to,from,to,from,to);
        const produced=(await db.prepare("SELECT COALESCE(SUM(approved_quantity),0) n FROM production_orders WHERE status='completed' AND completed_at BETWEEN ? AND ?").get(from,to)).n;
        const gross=await db.prepare("SELECT COALESCE(SUM(line_total_cents-ROUND(quantity*unit_cost_cents)),0) AS amount,COUNT(*) AS coverage FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.status<>'cancelled' AND s.sale_date BETWEEN ? AND ? AND i.unit_cost_cents IS NOT NULL").get(from,to);
        return send(res,200,{from,to,billed_cents:billed,received_cents:received,expenses_cents:expenses,paid_expenses_cents:paid,receivable_cents:receivable,payable_cents:payable,inventory_value_cents:Math.round(stock.cents),low_stock_count:stock.low||0,units_sold:units,units_produced:produced,gross_profit_estimate_cents:gross.amount,gross_profit_coverage:gross.coverage,top_models:models,expense_categories:categories,daily});
      }
      if(req.method==='GET'&&pathname==='/api/reports/financial'){
        const from=validDate(url.searchParams.get('from')),to=validDate(url.searchParams.get('to'));if(!from||!to||from>to||Date.parse(to)-Date.parse(from)>365*86400_000)return fail(res,400,'Informe um intervalo válido de até um ano.');
        const items=await db.prepare(`SELECT * FROM (
          SELECT s.sale_date AS date,'Venda emitida' AS kind,s.number AS description,s.total_cents AS amount_cents,0 AS cash_effect_cents,s.historical AS historical FROM sales s WHERE s.status<>'cancelled'
          UNION ALL SELECT p.paid_at,'Recebimento de venda',s.number,p.amount_cents,p.amount_cents,s.historical FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE s.status<>'cancelled'
          UNION ALL SELECT e.expense_date,'Despesa registrada',e.description,e.amount_cents,0,0 FROM expenses e WHERE e.status<>'cancelled'
          UNION ALL SELECT p.paid_at,'Pagamento de despesa',e.description,p.amount_cents,-p.amount_cents,0 FROM expense_payments p JOIN expenses e ON e.id=p.expense_id WHERE e.status<>'cancelled'
          UNION ALL SELECT b.purchase_date,'Compra de materiais',b.number,b.total_cents,0,0 FROM purchases b WHERE b.status<>'cancelled'
          UNION ALL SELECT p.paid_at,'Pagamento de compra',b.number,p.amount_cents,-p.amount_cents,0 FROM purchase_payments p JOIN purchases b ON b.id=p.purchase_id WHERE b.status<>'cancelled'
        ) WHERE date BETWEEN ? AND ? ORDER BY date DESC,kind`).all(from,to);
        return send(res,200,{from,to,items});
      }
      if(req.method==='GET'&&pathname==='/api/reports/production'){
        const from=validDate(url.searchParams.get('from')),to=validDate(url.searchParams.get('to'));if(!from||!to||from>to)return fail(res,400,'Informe um intervalo válido.');
        return send(res,200,{items:await db.prepare(`${productionQuery} WHERE o.status='completed' AND date(o.completed_at) BETWEEN ? AND ? ORDER BY o.completed_at DESC`).all(from,to)});
      }
      if(req.method==='GET'&&pathname==='/api/reports/inventory'){
        const from=validDate(url.searchParams.get('from')),to=validDate(url.searchParams.get('to'));if(!from||!to||from>to)return fail(res,400,'Informe um intervalo válido.');
        return send(res,200,{items:await db.prepare('SELECT m.name AS material_name,m.unit,v.quantity_delta,v.kind,v.reason,date(v.created_at) AS date,u.name AS user_name FROM inventory_movements v JOIN materials m ON m.id=v.material_id JOIN users u ON u.id=v.user_id WHERE date(v.created_at) BETWEEN ? AND ? ORDER BY v.created_at DESC').all(from,to)});
      }
      if (req.method === 'GET' && /^\/api\/products\/[0-9a-f-]+\/materials$/.test(pathname)) {
        const id=pathname.split('/')[3];return send(res,200,{items:await db.prepare('SELECT pm.material_id,pm.quantity_per_unit,m.name,m.unit,m.unit_cost_cents FROM product_materials pm JOIN materials m ON m.id=pm.material_id WHERE pm.product_id=? ORDER BY m.name').all(id)});
      }
      if(req.method==='GET'&&/^\/api\/products\/[0-9a-f-]+\/price-history$/.test(pathname)){
        const id=pathname.split('/')[3];return send(res,200,{items:await db.prepare('SELECT h.*,u.name AS user_name FROM product_price_history h JOIN users u ON u.id=h.user_id WHERE product_id=? ORDER BY created_at DESC').all(id)});
      }
      if (req.method === 'PUT' && /^\/api\/products\/[0-9a-f-]+\/materials$/.test(pathname)) {
        const id=pathname.split('/')[3],input=await bodyJson(req);if(!await db.prepare('SELECT id FROM products WHERE id=?').get(id))return fail(res,404,'Modelo não encontrado.');if(!Array.isArray(input.materials))return fail(res,400,'A lista de materiais é inválida.');
        const rows=[],seen=new Set();for(const row of input.materials){const materialId=textField(row.materialId,60),qty=Number(row.quantityPerUnit);if(!materialId||!Number.isFinite(qty)||qty<=0||seen.has(materialId)||!await db.prepare('SELECT id FROM materials WHERE id=? AND active=1').get(materialId))return fail(res,400,'Confira os materiais e suas quantidades previstas.');seen.add(materialId);rows.push({materialId,qty});}
        await db.exec('BEGIN IMMEDIATE');try{await db.prepare('DELETE FROM product_materials WHERE product_id=?').run(id);for(const row of rows)await db.prepare('INSERT INTO product_materials(product_id,material_id,quantity_per_unit) VALUES(?,?,?)').run(id,row.materialId,row.qty);await audit(user.id,'product.bom.updated','product',id,{materials:rows.length});await db.exec('COMMIT');}catch(error){if(db.isTransaction)await db.exec('ROLLBACK');throw error;}
        return send(res,200,{items:await db.prepare('SELECT pm.material_id,pm.quantity_per_unit,m.name,m.unit FROM product_materials pm JOIN materials m ON m.id=pm.material_id WHERE pm.product_id=?').all(id)});
      }
      if (req.method === 'GET' && pathname === '/api/settings') {
        if(user.role!=='owner')return fail(res,403,'Somente o proprietário pode consultar os custos padrão.');
        return send(res,200,{labor_cost_per_bag_cents:Number((await db.prepare("SELECT value FROM system_settings WHERE key='labor_cost_per_bag_cents'").get()).value),weekly_seamstress_cost_cents:Number((await db.prepare("SELECT value FROM system_settings WHERE key='weekly_seamstress_cost_cents'").get()).value)});
      }
      if (req.method === 'GET' && pathname === '/api/production/defaults') return send(res,200,{labor_cost_per_bag_cents:Number((await db.prepare("SELECT value FROM system_settings WHERE key='labor_cost_per_bag_cents'").get()).value)});
      if (req.method === 'PATCH' && pathname === '/api/settings') {
        if(user.role!=='owner')return fail(res,403,'Somente o proprietário pode alterar os custos padrão.');
        const input=await bodyJson(req),labor=parseMoneyCents(input.laborCostPerBag),weekly=parseMoneyCents(input.weeklySeamstressCost);if(labor===null||weekly===null)return fail(res,400,'Informe custos válidos.');
        await db.prepare("UPDATE system_settings SET value=? WHERE key='labor_cost_per_bag_cents'").run(String(labor));await db.prepare("UPDATE system_settings SET value=? WHERE key='weekly_seamstress_cost_cents'").run(String(weekly));await audit(user.id,'settings.costs.updated','settings','production-costs',{labor,weekly});return send(res,200,{ok:true});
      }
      const productionQuery='SELECT o.*,p.name AS product_name,p.sku FROM production_orders o JOIN products p ON p.id=o.product_id';
      if(req.method==='GET'&&pathname==='/api/production')return send(res,200,{items:await db.prepare(`${productionQuery} ORDER BY o.start_date DESC,o.created_at DESC`).all()});
      if(req.method==='POST'&&pathname==='/api/production'){
        const input=await bodyJson(req),requestKey=textField(input.requestKey,60),productId=textField(input.productId,60),planned=validQty(input.plannedQuantity),startDate=validDate(input.startDate),dueDate=validDate(input.dueDate,true);
        if(!requestKey||!productId||planned===null||planned<=0||!startDate||dueDate===null)return fail(res,400,'Confira modelo, quantidade planejada e datas.');
        const existing=await db.prepare(`${productionQuery} WHERE o.request_key=?`).get(requestKey);if(existing)return send(res,200,{item:existing,replayed:true});
        if(!await db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(productId))return fail(res,400,'Modelo não encontrado ou inativo.');
        const id=randomUUID(),seq=(await db.prepare("SELECT COUNT(*) n FROM production_orders WHERE substr(start_date,1,4)=?").get(startDate.slice(0,4))).n+1,number=`OP-${startDate.slice(0,4)}-${String(seq).padStart(5,'0')}`;
        await db.prepare("INSERT INTO production_orders(id,number,request_key,product_id,planned_quantity,status,start_date,due_date,responsible,notes,user_id) VALUES(?,?,?,?,?,'planned',?,?,?,?,?)").run(id,number,requestKey,productId,planned,startDate,dueDate,textField(input.responsible,120),textField(input.notes,2000),user.id);await audit(user.id,'production.created','production_order',id,{number,planned});return send(res,201,{item:await db.prepare(`${productionQuery} WHERE o.id=?`).get(id)});
      }
      if(req.method==='GET'&&/^\/api\/production\/[0-9a-f-]+\/consumptions$/.test(pathname)){
        const id=pathname.split('/')[3];if(!await db.prepare('SELECT id FROM production_orders WHERE id=?').get(id))return fail(res,404,'Ordem de produção não encontrada.');return send(res,200,{items:await db.prepare('SELECT c.*,m.name,m.unit FROM production_consumptions c JOIN materials m ON m.id=c.material_id WHERE order_id=? ORDER BY m.name').all(id)});
      }
      if(req.method==='PATCH'&&/^\/api\/production\/[0-9a-f-]+$/.test(pathname)){
        const id=pathname.split('/').at(-1),input=await bodyJson(req),order=await db.prepare(`${productionQuery} WHERE o.id=?`).get(id);if(!order)return fail(res,404,'Ordem de produção não encontrada.');
        if(input.status==='cancelled'){if(order.status==='completed'||order.status==='cancelled')return fail(res,409,'Esta ordem não pode ser cancelada.');const reason=textField(input.reason,250);if(reason.length<3)return fail(res,400,'Informe o motivo do cancelamento.');await db.prepare("UPDATE production_orders SET status='cancelled' WHERE id=?").run(id);await audit(user.id,'production.cancelled','production_order',id,{reason});return send(res,200,{item:await db.prepare(`${productionQuery} WHERE o.id=?`).get(id)});}
        if(input.status==='in_progress'&&order.status==='planned'){await db.prepare("UPDATE production_orders SET status='in_progress' WHERE id=?").run(id);await audit(user.id,'production.started','production_order',id);return send(res,200,{item:await db.prepare(`${productionQuery} WHERE o.id=?`).get(id)});}
        if(input.status!=='completed')return fail(res,409,'Transição de status não permitida.');if(order.status==='completed')return send(res,200,{item:order,replayed:true});if(order.status==='cancelled')return fail(res,409,'Ordem cancelada não pode ser concluída.');
        const produced=validQty(input.producedQuantity),approved=validQty(input.approvedQuantity),defective=validQty(input.defectiveQuantity),additional=parseMoneyCents(input.additionalCost??0),completedDate=input.completedDate?validDate(input.completedDate):todayLocalIso(),settings=await db.prepare("SELECT value FROM system_settings WHERE key='labor_cost_per_bag_cents'").get();
        const labor=input.laborCost===undefined?Math.round(Number(settings.value)*Number(approved||0)):parseMoneyCents(input.laborCost);
        if(produced===null||approved===null||defective===null||produced<=0||Math.abs(produced-approved-defective)>0.0001||additional===null||labor===null||!completedDate)return fail(res,400,'A quantidade produzida deve ser igual a aprovada mais a defeituosa. Confira custos, data e quantidades.');
        let consumptions=input.consumptions;
        if(!Array.isArray(consumptions))consumptions=await db.prepare('SELECT material_id,quantity_per_unit*? AS quantity FROM product_materials WHERE product_id=?').all(produced,order.product_id);
        if(consumptions.length>100)return fail(res,400,'Há materiais demais nesta ordem.');
        const used=[],seen=new Set();for(const row of consumptions){const materialId=textField(row.materialId,60),qty=validQty(row.quantity);if(!materialId||qty===null||qty<=0||seen.has(materialId))return fail(res,400,'Confira os materiais consumidos.');seen.add(materialId);used.push({materialId,qty});}
        await db.exec('BEGIN IMMEDIATE');try{
          let materialsTotal=0;for(const item of used){const material=await db.prepare('SELECT id,name,quantity,unit_cost_cents FROM materials WHERE id=? AND active=1').get(item.materialId);if(!material||material.quantity<item.qty){await db.exec('ROLLBACK');return fail(res,409,`Estoque insuficiente de ${material?.name||'um material'} para concluir a ordem.`);}const cost=Math.round(item.qty*material.unit_cost_cents);materialsTotal+=cost;await db.prepare('UPDATE materials SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(item.qty,item.materialId);await db.prepare('INSERT INTO inventory_movements(id,material_id,user_id,kind,quantity_delta,reason) VALUES(?,?,? ,\'production\',?,?)').run(randomUUID(),item.materialId,user.id,-item.qty,`Consumo na ordem ${order.number}`);await db.prepare('INSERT INTO production_consumptions(id,order_id,material_id,quantity,unit_cost_cents,total_cost_cents) VALUES(?,?,?,?,?,?)').run(randomUUID(),id,item.materialId,item.qty,material.unit_cost_cents,cost);await audit(user.id,'stock.production','material',item.materialId,{order_number:order.number,quantity:-item.qty});}
          const unitCost=approved>0?Math.round((materialsTotal+labor+additional)/approved):null;await db.prepare("UPDATE production_orders SET status='completed',produced_quantity=?,approved_quantity=?,defective_quantity=?,completed_at=?,labor_cost_cents=?,additional_cost_cents=?,material_cost_cents=?,unit_cost_cents=? WHERE id=?").run(produced,approved,defective,completedDate,labor,additional,materialsTotal,unitCost,id);
          if(approved>0)await db.prepare('INSERT INTO product_stock(product_id,quantity) VALUES(?,?) ON CONFLICT(product_id) DO UPDATE SET quantity=quantity+excluded.quantity,updated_at=CURRENT_TIMESTAMP').run(order.product_id,approved);
          await audit(user.id,'production.completed','production_order',id,{produced,approved,defective,materials_cents:materialsTotal,labor_cents:labor,additional_cents:additional});await db.exec('COMMIT');
        }catch(error){if(db.isTransaction)await db.exec('ROLLBACK');throw error;}
        return send(res,200,{item:await db.prepare(`${productionQuery} WHERE o.id=?`).get(id),consumptions:await db.prepare('SELECT * FROM production_consumptions WHERE order_id=?').all(id)});
      }
      if (req.method === 'GET' && pathname === '/api/products') return send(res,200,{items:await db.prepare('SELECT p.*,COALESCE(s.quantity,0) AS stock_quantity FROM products p LEFT JOIN product_stock s ON s.product_id=p.id ORDER BY p.name COLLATE NOCASE').all()});
      if (req.method === 'POST' && pathname === '/api/products') {
        const input=await bodyJson(req), name=textField(input.name,120), sku=textField(input.sku,60).toUpperCase();
        const price=parseMoneyCents(input.price);
        if(name.length<2||!sku||price===null) return fail(res,400,'Informe nome, código/SKU e preço válido.');
        const id=randomUUID();
        await db.prepare('INSERT INTO products(id,name,sku,description,category,color,size,price_cents) VALUES(?,?,?,?,?,?,?,?)').run(id,name,sku,textField(input.description,2000),textField(input.category,80),textField(input.color,80),textField(input.size,80),price);
        await db.prepare("INSERT INTO product_price_history(id,product_id,user_id,new_price_cents,reason) VALUES(?,?,?,?,'Preço inicial')").run(randomUUID(),id,user.id,price);
        await audit(user.id,'product.created','product',id,{sku});
        return send(res,201,{item:await db.prepare('SELECT * FROM products WHERE id=?').get(id)});
      }
      if (req.method === 'PATCH' && /^\/api\/products\/[0-9a-f-]+$/.test(pathname)) {
        const id=pathname.split('/').at(-1), input=await bodyJson(req), name=textField(input.name,120), sku=textField(input.sku,60).toUpperCase(), price=parseMoneyCents(input.price);
        if(name.length<2||!sku||price===null) return fail(res,400,'Informe nome, código/SKU e preço válido.');
        const prior=await db.prepare('SELECT price_cents FROM products WHERE id=?').get(id);if(!prior)return fail(res,404,'Modelo não encontrado.');
        await db.prepare("UPDATE products SET name=?,sku=?,description=?,category=?,color=?,size=?,price_cents=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(name,sku,textField(input.description,2000),textField(input.category,80),textField(input.color,80),textField(input.size,80),price,input.active===false?0:1,id);
        if(prior.price_cents!==price)await db.prepare('INSERT INTO product_price_history(id,product_id,user_id,previous_price_cents,new_price_cents,reason) VALUES(?,?,?,?,?,?)').run(randomUUID(),id,user.id,prior.price_cents,price,textField(input.priceReason,250)||'Alteração de preço');
        const item=await db.prepare('SELECT * FROM products WHERE id=?').get(id); await audit(user.id,'product.updated','product',id,{sku}); return send(res,200,{item});
      }
      if (req.method === 'GET' && pathname === '/api/suppliers') return send(res,200,{items:await db.prepare('SELECT * FROM suppliers ORDER BY name COLLATE NOCASE').all()});
      if (req.method === 'POST' && pathname === '/api/suppliers') {
        const input=await bodyJson(req), name=textField(input.name,160), email=textField(input.email,254).toLowerCase();
        if(name.length<2||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return fail(res,400,'Informe o nome do fornecedor e um e-mail válido, se aplicável.');
        const id=randomUUID(); await db.prepare('INSERT INTO suppliers(id,name,document,email,phone,notes) VALUES(?,?,?,?,?,?)').run(id,name,textField(input.document,32),email,textField(input.phone,32),textField(input.notes,2000)); await audit(user.id,'supplier.created','supplier',id);
        return send(res,201,{item:await db.prepare('SELECT * FROM suppliers WHERE id=?').get(id)});
      }
      if(req.method==='PATCH'&&/^\/api\/suppliers\/[0-9a-f-]+$/.test(pathname)){
        const id=pathname.split('/').at(-1),input=await bodyJson(req),name=textField(input.name,160),email=textField(input.email,254).toLowerCase();if(name.length<2||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))||typeof input.active!=='boolean')return fail(res,400,'Confira os dados do fornecedor.');const exists=await db.prepare('SELECT id FROM suppliers WHERE id=?').get(id);if(!exists)return fail(res,404,'Fornecedor não encontrado.');await db.prepare('UPDATE suppliers SET name=?,document=?,email=?,phone=?,notes=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name,textField(input.document,32),email,textField(input.phone,32),textField(input.notes,2000),input.active?1:0,id);await audit(user.id,'supplier.updated','supplier',id,{active:input.active});return send(res,200,{item:await db.prepare('SELECT * FROM suppliers WHERE id=?').get(id)});
      }
      if (req.method === 'GET' && pathname === '/api/materials') return send(res,200,{items:await db.prepare('SELECT m.*,s.name AS supplier_name FROM materials m LEFT JOIN suppliers s ON s.id=m.supplier_id ORDER BY m.name COLLATE NOCASE').all()});
      if (req.method === 'POST' && pathname === '/api/materials') {
        const input=await bodyJson(req), name=textField(input.name,160), code=textField(input.code,60).toUpperCase(), unit=textField(input.unit,30);
        const quantity=validQty(input.quantity??0), min=validQty(input.minimumQuantity??0), cost=parseMoneyCents(input.unitCost??0);
        const supplierId=textField(input.supplierId,60)||null;
        if(name.length<2||!unit||quantity===null||min===null||cost===null) return fail(res,400,'Confira nome, unidade, estoque e custo.');
        if(supplierId&&!await db.prepare('SELECT id FROM suppliers WHERE id=? AND active=1').get(supplierId)) return fail(res,400,'Fornecedor selecionado não encontrado.');
        const id=randomUUID(); await db.exec('BEGIN IMMEDIATE');
        try {
          await db.prepare('INSERT INTO materials(id,name,code,unit,quantity,minimum_quantity,unit_cost_cents,supplier_id,last_purchase_date,notes) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,name,code,unit,quantity,min,cost,supplierId,textField(input.lastPurchaseDate,10),textField(input.notes,2000));
          if(quantity>0) await db.prepare("INSERT INTO inventory_movements(id,material_id,user_id,kind,quantity_delta,reason) VALUES(?,?,?,'opening',?,'Saldo inicial informado no cadastro')").run(randomUUID(),id,user.id,quantity);
          await audit(user.id,'material.created','material',id,{code,opening_quantity:quantity});
          await db.exec('COMMIT');
        } catch(e) { await db.exec('ROLLBACK'); throw e; }
        return send(res,201,{item:await db.prepare('SELECT m.*,s.name AS supplier_name FROM materials m LEFT JOIN suppliers s ON s.id=m.supplier_id WHERE m.id=?').get(id)});
      }
      if(req.method==='PATCH'&&/^\/api\/materials\/[0-9a-f-]+$/.test(pathname)){
        const id=pathname.split('/').at(-1),input=await bodyJson(req),name=textField(input.name,160),code=textField(input.code,60).toUpperCase(),unit=textField(input.unit,30),min=validQty(input.minimumQuantity),supplierId=textField(input.supplierId,60)||null;
        if(name.length<2||!unit||min===null||typeof input.active!=='boolean')return fail(res,400,'Confira os dados do material e o estoque mínimo.');if(supplierId&&!await db.prepare('SELECT id FROM suppliers WHERE id=? AND active=1').get(supplierId))return fail(res,400,'Fornecedor não encontrado ou inativo.');
        const exists=await db.prepare('SELECT id FROM materials WHERE id=?').get(id);if(!exists)return fail(res,404,'Material não encontrado.');await db.prepare('UPDATE materials SET name=?,code=?,unit=?,minimum_quantity=?,supplier_id=?,last_purchase_date=?,notes=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name,code,unit,min,supplierId,textField(input.lastPurchaseDate,10),textField(input.notes,2000),input.active?1:0,id);await audit(user.id,'material.updated','material',id,{code,active:input.active});return send(res,200,{item:await db.prepare('SELECT * FROM materials WHERE id=?').get(id)});
      }
      if (req.method === 'POST' && /^\/api\/materials\/[0-9a-f-]+\/movements$/.test(pathname)) {
        const id=pathname.split('/')[3], input=await bodyJson(req), qty=validQty(input.quantity), kind=textField(input.kind,20), reason=textField(input.reason,250);
        const direction=kind==='adjustment'?(input.direction==='out'?-1:input.direction==='in'?1:0):({return:1,purchase:1,loss:-1,production:-1}[kind]||0);
        if(qty===null||qty<=0||!direction||reason.length<3) return fail(res,400,'Informe quantidade positiva, motivo e tipo de movimentação.');
        await db.exec('BEGIN IMMEDIATE');
        try {
          const material=await db.prepare('SELECT quantity FROM materials WHERE id=? AND active=1').get(id); if(!material){await db.exec('ROLLBACK');return fail(res,404,'Material não encontrado.');}
          const delta=qty*direction; if(material.quantity+delta<0){await db.exec('ROLLBACK');return fail(res,409,'A movimentação deixaria o estoque negativo.');}
          await db.prepare('UPDATE materials SET quantity=quantity+?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(delta,id);
          await db.prepare('INSERT INTO inventory_movements(id,material_id,user_id,kind,quantity_delta,reason) VALUES(?,?,?,?,?,?)').run(randomUUID(),id,user.id,kind,delta,reason);
          await audit(user.id,`stock.${kind}`,'material',id,{quantity:delta,reason});
          await db.exec('COMMIT');
        } catch(e){ if(db.isTransaction)await db.exec('ROLLBACK'); throw e; }
        return send(res,201,{item:await db.prepare('SELECT * FROM materials WHERE id=?').get(id)});
      }
      if (req.method === 'GET' && /^\/api\/materials\/[0-9a-f-]+\/movements$/.test(pathname)) {
        const id=pathname.split('/')[3]; return send(res,200,{items:await db.prepare('SELECT m.*,u.name AS user_name FROM inventory_movements m JOIN users u ON u.id=m.user_id WHERE material_id=? ORDER BY created_at DESC').all(id)});
      }
    }
    if (!user) {
      if (pathname.startsWith('/recibos')) return send(res,302,'',{Location:'/'});
      if(req.method==='GET'&&['/assets/app.js','/assets/app.css'].includes(pathname))return send(res,200,await readFile(path.join(root,'public','assets',path.basename(pathname))),{'Content-Type':mime[path.extname(pathname)]||'application/octet-stream'});
      if (pathname.startsWith('/assets/')) return fail(res,401,'Não autenticado.');
      if (req.method === 'GET' && pathname === '/') return send(res,200,await readFile(path.join(root,'public','index.html'),'utf8'),{ 'Content-Type':'text/html; charset=utf-8', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'" });
      return fail(res,404,'Não encontrado.');
    }
    if (req.method === 'GET' && pathname === '/') return send(res,200,await readFile(path.join(root,'public','index.html'),'utf8'),{ 'Content-Type':'text/html; charset=utf-8', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'" });
    if (req.method === 'GET' && pathname === '/recibos/ferramenta') {
      const receiptPath = path.join(root,'Recibo_pdf','recibo_auto.html');
      await stat(receiptPath);
      let receiptHtml=await readFile(receiptPath,'utf8');
      const saleId=url.searchParams.get('sale');
      if(saleId){
        const sale=await db.prepare('SELECT s.*,c.name AS customer_name FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=? AND s.status<>\'cancelled\'').get(saleId);
        if(!sale)return fail(res,404,'Venda não encontrada para preencher o recibo.');
        const items=await db.prepare('SELECT product_name,sku,color,quantity,unit_price_cents FROM sale_items WHERE sale_id=?').all(saleId);
        const receiptData=JSON.stringify({customer:sale.customer_name||'',date:sale.sale_date,items}).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
        const bridge=`<script>addEventListener('DOMContentLoaded',()=>{const data=${receiptData};const customer=document.getElementById('clienteInput');if(customer)customer.value=data.customer;const date=document.getElementById('dataInput');if(date){date.value=data.date;atualizarDataPrint()}for(const item of data.items){refEl.value=String(item.sku||'').replace(/[<>]/g,'');corEl.value=String(item.product_name+(item.color?' · '+item.color:'')).replace(/[<>]/g,'');qtdEl.value=item.quantity;valorEl.value=(item.unit_price_cents/100).toFixed(2);addItem()}})</script>`;
        receiptHtml=receiptHtml.replace('</body>',`${bridge}</body>`);
      }
      return send(res,200,receiptHtml,{ 'Content-Type':'text/html; charset=utf-8', 'Content-Security-Policy':"default-src 'self' https://cdn.tailwindcss.com; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com; style-src 'unsafe-inline' https://cdn.tailwindcss.com; img-src 'self' data:; frame-ancestors 'self'; base-uri 'self'" });
    }
    if (req.method === 'GET' && pathname.startsWith('/assets/')) {
      const file = path.basename(pathname);
      const filePath = path.join(root,'public','assets',file);
      return send(res,200,await readFile(filePath),{ 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    }
    return fail(res,404,'Não encontrado.');
  } catch (error) {
    console.error('Request failed:',databaseFailureClass(error));
    if(error.message==='Payload muito grande.')return fail(res,413,error.message);
    if(error.message==='Corpo JSON inválido.')return fail(res,400,error.message);
    if (error.code === 'ENOENT') return fail(res,404,'Arquivo não encontrado.');
    if (/CONSTRAINT.*(UNIQUE|PRIMARYKEY)/i.test(String(error.code||''))) return fail(res,409,'Já existe um usuário com esse e-mail.');
    return fail(res,500,'Erro interno. Consulte o registro do servidor.');
  }
}));

server.listen(port,host,()=>console.log(`GVEG Gestão disponível em http://${host}:${port}`));
let shuttingDown=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(shuttingDown)return;
  shuttingDown=true;
  server.close(()=>{db.close();process.exit(0);});
});
