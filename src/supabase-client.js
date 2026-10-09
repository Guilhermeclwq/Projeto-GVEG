import { createClient } from '@supabase/supabase-js';

const authStatus=document.querySelector('#auth-status');
const recordStatus=document.querySelector('#record-status');
const authForm=document.querySelector('#auth-form');
const recordForm=document.querySelector('#record-form');
const recordButton=recordForm.querySelector('[type="submit"]');
const refreshButton=document.querySelector('#refresh');
const signupButton=document.querySelector('#signup');
const signoutButton=document.querySelector('#signout');
const recordsBody=document.querySelector('#records');
let client=null;
let activeUser=null;

function message(element,text,kind=''){element.textContent=text;element.className=`status ${kind}`.trim();}
function setAuthenticated(user){
  activeUser=user||null;
  recordButton.disabled=!activeUser;
  refreshButton.disabled=!activeUser;
  signupButton.hidden=Boolean(activeUser);
  signoutButton.hidden=!activeUser;
  authForm.elements.email.disabled=Boolean(activeUser);
  authForm.elements.password.disabled=Boolean(activeUser);
  message(authStatus,activeUser?`Conectado como ${activeUser.email} (${activeUser.id}).`:'Entre com sua conta Supabase ou crie um usuário.',activeUser?'success':'');
  if(activeUser)void loadRecords();
}
function displayRecords(items){
  recordsBody.replaceChildren();
  if(!items.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=4;td.textContent='Nenhum registro deste usuário.';tr.append(td);recordsBody.append(tr);return;}
  for(const item of items){const tr=document.createElement('tr');for(const value of [item.id,item.note,item.user_id,new Date(item.created_at).toLocaleString('pt-BR')]){const td=document.createElement('td');td.textContent=value;tr.append(td);}recordsBody.append(tr);}
}
async function loadRecords(){
  if(!client||!activeUser)return;
  message(recordStatus,'Consultando os registros permitidos pela política RLS…');
  const {data,error}=await client.from('supabase_connection_tests').select('id,user_id,note,created_at').order('created_at',{ascending:false}).limit(20);
  if(error){message(recordStatus,`Consulta não concluída: ${error.message}`,'error');return;}
  if(data.some(row=>row.user_id!==activeUser.id)){message(recordStatus,'A política RLS retornou um registro de outro usuário. Interrompido.','error');return;}
  displayRecords(data);
  message(recordStatus,`Consulta concluída: ${data.length} registro(s) visível(is), todos pertencentes ao usuário autenticado. Atualize a página para testar a persistência.`, 'success');
}
async function initialize(){try{
  const response=await fetch('/api/supabase-config');
  const config=await response.json();
  if(!response.ok)throw new Error(config.error||'Não foi possível obter a configuração.');
  if(!config.configured)throw new Error('Configure SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY no arquivo .env e reinicie o servidor.');
  client=createClient(config.url,config.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  const {data,error}=await client.auth.getSession();
  if(error)throw error;
  setAuthenticated(data.session?.user||null);
}catch(error){message(authStatus,error.message,'error');}}
void initialize();

authForm.addEventListener('submit',async event=>{
  event.preventDefault();if(!client)return;
  const button=authForm.querySelector('button[type="submit"]');button.disabled=true;
  const {email,password}=Object.fromEntries(new FormData(authForm));
  try{const {data,error}=await client.auth.signInWithPassword({email,password});if(error)throw error;setAuthenticated(data.user);}
  catch(error){message(authStatus,`Falha no login: ${error.message}`,'error');}
  finally{button.disabled=Boolean(activeUser);}
});
signupButton.addEventListener('click',async()=>{
  if(!client)return;
  const {email,password}=Object.fromEntries(new FormData(authForm));
  if(!email||!password){message(authStatus,'Preencha e-mail e senha para criar o usuário.','error');return;}
  signupButton.disabled=true;
  try{const {data,error}=await client.auth.signUp({email,password,options:{emailRedirectTo:location.origin}});if(error)throw error;if(data.session)setAuthenticated(data.user);else message(authStatus,'Cadastro enviado. Confirme o e-mail recebido e depois entre nesta página.','success');}
  catch(error){message(authStatus,`Cadastro não concluído: ${error.message}`,'error');}
  finally{signupButton.disabled=Boolean(activeUser);}
});
signoutButton.addEventListener('click',async()=>{const {error}=await client.auth.signOut();if(error){message(authStatus,`Não foi possível sair: ${error.message}`,'error');return;}setAuthenticated(null);});
recordForm.addEventListener('submit',async event=>{
  event.preventDefault();if(!client||!activeUser)return;
  recordButton.disabled=true;
  try{
    const note=String(new FormData(recordForm).get('note')||'').trim();
    const {data:inserted,error:insertError}=await client.from('supabase_connection_tests').insert({user_id:activeUser.id,note}).select('id,user_id,note,created_at').single();
    if(insertError)throw insertError;
    const {data:readBack,error:readError}=await client.from('supabase_connection_tests').select('id,user_id,note,created_at').eq('id',inserted.id).single();
    if(readError)throw readError;
    if(readBack.user_id!==activeUser.id||readBack.note!==note)throw new Error('O registro consultado não corresponde ao usuário ou aos dados inseridos.');
    message(recordStatus,'Inserção e consulta confirmadas pelo Supabase com a sessão autenticada. Agora atualize a página e confirme que o registro continua listado.','success');
    await loadRecords();
  }catch(error){message(recordStatus,`Gravação/consulta bloqueada: ${error.message}`,'error');}
  finally{recordButton.disabled=!activeUser;}
});
refreshButton.addEventListener('click',()=>void loadRecords());
