(function () {
  "use strict";
  const key="han_life_items", form=document.querySelector("#lifeForm"), input=document.querySelector("#lifeInput"), list=document.querySelector("#lifeList"), empty=document.querySelector("#lifeEmpty"), status=document.querySelector("#lifeStatus"), voice=document.querySelector("#voiceButton");
  let items=load(), recognition=null;
  function load(){ try { const v=JSON.parse(localStorage.getItem(key)||"[]"); return Array.isArray(v)?v.filter(x=>x&&x.id&&x.text):[]; } catch(_){ return []; } }
  function save(){ localStorage.setItem(key,JSON.stringify(items)); }
  function message(text,error){ status.textContent=text; status.classList.toggle("is-error",Boolean(error)); }
  function render(){ list.replaceChildren(); empty.hidden=items.length>0; for(const item of items){ const row=document.createElement("li"); row.className=`life-item${item.done?" is-done":""}`; const check=document.createElement("input"); check.type="checkbox"; check.checked=Boolean(item.done); check.setAttribute("aria-label",`完成：${item.text}`); check.addEventListener("change",()=>{item.done=check.checked;save();render();}); const text=document.createElement("span"); text.className="life-text"; text.textContent=item.text; const del=document.createElement("button"); del.type="button"; del.className="delete-button"; del.textContent="刪除"; del.addEventListener("click",()=>{items=items.filter(x=>x.id!==item.id);save();render();}); row.append(check,text,del); list.append(row); } }
  form.addEventListener("submit",e=>{ e.preventDefault(); const text=input.value.trim(); if(!text){message("請先輸入生活雜事",true);input.focus();return;} items.unshift({id:crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`,text,done:false}); save(); input.value=""; message("已新增"); render(); input.focus(); });
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR) voice.addEventListener("click",()=>message("此瀏覽器目前不支援語音輸入，請改用文字輸入。",true)); else { recognition=new SR(); recognition.lang="zh-TW"; recognition.interimResults=false; recognition.continuous=false; recognition.onstart=()=>{voice.textContent="🎤 聆聽中";message("請開始說話");}; recognition.onresult=e=>{input.value=e.results[0][0].transcript;message("語音已轉成文字，請確認後按新增");input.focus();}; recognition.onerror=()=>message("語音輸入失敗，請改用文字輸入。",true); recognition.onend=()=>{voice.textContent="🎤 語音";}; voice.addEventListener("click",()=>{try{recognition.start();}catch(_){}}); }
  render();
})();
