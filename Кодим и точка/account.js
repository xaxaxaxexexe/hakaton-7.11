(() => {
  const dialog=document.querySelector('#accountDialog'),form=document.querySelector('#accountForm'),button=document.querySelector('#accountButton');let user=null,register=false;
  function update(){button.textContent=user?user.email:'Войти / Регистрация';}
  function mode(value){register=value;document.querySelector('#accountTitle').textContent=value?'Регистрация':'Войти';document.querySelector('#accountSubmit').textContent=value?'Зарегистрироваться':'Войти';document.querySelector('#accountToggle').textContent=value?'Уже есть аккаунт? Войти':'Создать аккаунт';document.querySelector('#accountPassword').autocomplete=value?'new-password':'current-password';document.querySelector('#accountError').hidden=true;}
  async function request(path,data){const r=await fetch(path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});const result=await r.json();if(!r.ok)throw Error(result.error||'Не удалось выполнить запрос');return result;}
  button.addEventListener('click',async()=>{if(user){await request('/api/logout',{});user=null;update();return;}mode(false);form.reset();dialog.showModal();document.querySelector('#accountEmail').focus();});
  document.querySelector('#closeAccount').addEventListener('click',()=>dialog.close());document.querySelector('#accountToggle').addEventListener('click',()=>mode(!register));
  form.addEventListener('submit',async e=>{e.preventDefault();const submit=document.querySelector('#accountSubmit');submit.disabled=true;try{const r=await request(register?'/api/register':'/api/login',{email:document.querySelector('#accountEmail').value,password:document.querySelector('#accountPassword').value});user=r.user;update();form.reset();dialog.close();}catch(error){const el=document.querySelector('#accountError');el.textContent=error.message;el.hidden=false;}finally{submit.disabled=false;}});
  request('/api/me').then(r=>{user=r.user;update();}).catch(()=>{});
})();
