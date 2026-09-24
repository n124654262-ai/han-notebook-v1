(function () {
  "use strict";
  const localKey = "han_life_items";
  const form = document.querySelector("#lifeForm");
  const input = document.querySelector("#lifeInput");
  const list = document.querySelector("#lifeList");
  const empty = document.querySelector("#lifeEmpty");
  const status = document.querySelector("#lifeStatus");
  const voice = document.querySelector("#voiceButton");
  let items = loadLocal();
  let user = null;
  let lifeCollection = null;
  let unsubscribe = null;

  function loadLocal() {
    try {
      const value = JSON.parse(localStorage.getItem(localKey) || "[]");
      return Array.isArray(value) ? value.filter((item) => item && item.id && item.text) : [];
    } catch (_) { return []; }
  }
  function saveLocal() { try { localStorage.setItem(localKey, JSON.stringify(items)); } catch (_) {} }
  function message(text, error) { status.textContent = text; status.classList.toggle("is-error", Boolean(error)); }
  function makeId() { return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

  function render() {
    list.replaceChildren();
    empty.hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement("li");
      row.className = `life-item${item.done ? " is-done" : ""}`;
      const check = document.createElement("input");
      check.type = "checkbox"; check.checked = Boolean(item.done);
      check.setAttribute("aria-label", `完成：${item.text}`);
      check.addEventListener("change", () => updateItem(item.id, { done: check.checked }));
      const text = document.createElement("span"); text.className = "life-text"; text.textContent = item.text;
      const del = document.createElement("button"); del.type = "button"; del.className = "delete-button"; del.textContent = "刪除";
      del.addEventListener("click", () => deleteItem(item.id));
      row.append(check, text, del); list.append(row);
    }
  }

  async function updateItem(id, changes) {
    const item = items.find((candidate) => candidate.id === id); if (!item) return;
    Object.assign(item, changes, { updated_at: new Date().toISOString() }); render();
    if (!lifeCollection) { saveLocal(); return; }
    try { await lifeCollection.doc(id).update(changes); } catch (_) { message("同步失敗，請稍後再試。", true); }
  }
  async function deleteItem(id) {
    items = items.filter((item) => item.id !== id); render();
    if (!lifeCollection) { saveLocal(); return; }
    try { await lifeCollection.doc(id).delete(); } catch (_) { message("刪除同步失敗，請稍後再試。", true); }
  }

  async function migrateLocalItems(localItems) {
    if (!lifeCollection || !localItems.length) return;
    const marker = `han_life_migrated_${user.uid}`; if (localStorage.getItem(marker)) return;
    try {
      const snapshot = await lifeCollection.get(); const existingIds = new Set(snapshot.docs.map((doc) => doc.id));
      const batch = firebase.firestore().batch();
      for (const item of localItems) if (!existingIds.has(item.id)) batch.set(lifeCollection.doc(item.id), { id: item.id, text: String(item.text).slice(0, 240), done: Boolean(item.done), created_at: item.created_at || new Date().toISOString(), updated_at: item.updated_at || new Date().toISOString() });
      await batch.commit(); localStorage.setItem(marker, "1");
    } catch (_) { message("生活資料同步準備失敗，請稍後再試。", true); }
  }

  function startSync(nextUser) {
    if (unsubscribe) unsubscribe(); unsubscribe = null; user = nextUser;
    if (!user) { lifeCollection = null; message("請先登入 HAN 筆記本，再使用生活雜事。", true); render(); return; }
    const localItems = items.slice();
    lifeCollection = firebase.firestore().collection("users").doc(user.uid).collection("life_items");
    message("同步中……");
    unsubscribe = lifeCollection.orderBy("created_at", "desc").onSnapshot((snapshot) => {
      items = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })); saveLocal(); render(); message("已同步");
    }, () => message("同步中斷，請稍後再試。", true));
    void migrateLocalItems(localItems);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault(); const text = input.value.trim();
    if (!text) { message("請先輸入生活雜事。", true); input.focus(); return; }
    const item = { id: makeId(), text: text.slice(0, 240), done: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (!lifeCollection) { items.unshift(item); saveLocal(); render(); input.value = ""; message("已暫存，登入後才會同步"); input.focus(); return; }
    try { await lifeCollection.doc(item.id).set(item); input.value = ""; message("已新增並同步"); input.focus(); }
    catch (_) { message("新增失敗，請稍後再試。", true); }
  });

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) voice.addEventListener("click", () => message("此瀏覽器目前不支援語音輸入，請改用文字輸入。", true));
  else {
    const recognition = new SpeechRecognition(); recognition.lang = "zh-TW"; recognition.interimResults = false; recognition.continuous = false;
    recognition.onstart = () => { voice.textContent = "🎤 聆聽中"; message("請開始說話"); };
    recognition.onresult = (event) => { input.value = event.results[0][0].transcript; message("語音已轉成文字，請確認後按新增"); input.focus(); };
    recognition.onerror = () => message("語音輸入失敗，請改用文字輸入。", true); recognition.onend = () => { voice.textContent = "🎤 語音"; };
    voice.addEventListener("click", () => { try { recognition.start(); } catch (_) {} });
  }
  if (window.firebase && window.HAN_FIREBASE_CONFIG) {
    const app = firebase.apps.length ? firebase.apps[0] : firebase.initializeApp(window.HAN_FIREBASE_CONFIG);
    app.auth().onAuthStateChanged(startSync);
  } else { message("目前無法連線同步，資料只會保留在此裝置。", true); render(); }
})();
