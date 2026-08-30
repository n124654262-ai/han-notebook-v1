"use strict";

const DRAFT_PREFIX = "han-notebook-note:";
const currentMonth = new Date().toISOString().slice(0, 7);
const FIREBASE_CONFIG = globalThis.HAN_FIREBASE_CONFIG || {
  apiKey: "AIzaSyCjZtrVC4fpTpoffi-UcI_EObX102XCAwA",
  authDomain: "han-notebook-v1.firebaseapp.com",
  projectId: "han-notebook-v1",
  storageBucket: "han-notebook-v1.firebasestorage.app",
  messagingSenderId: "341013315221",
  appId: "1:341013315221:web:c7a7141d6bec9ff2e7259c",
};

const state = {
  view: "inbox",
  inboxItems: [],
  todoItems: [],
  expandedId: null,
  calendar: {
    month: currentMonth,
    blocks: [],
    availableItems: [],
    selectedItemId: null,
    drag: null,
  },
  resources: {
    documents: [],
    expandedId: null,
    details: new Map(),
    query: "",
  },
};

const elements = {
  syncState: document.querySelector("#syncState"),
  authButton: document.querySelector("#authButton"),
  inboxCount: document.querySelector("#inboxCount"),
  todoCount: document.querySelector("#todoCount"),
  manualEntry: document.querySelector("#manualEntry"),
  manualToggle: document.querySelector("#manualToggle"),
  manualForm: document.querySelector("#manualForm"),
  manualCancel: document.querySelector("#manualCancel"),
  notice: document.querySelector("#notice"),
  listSection: document.querySelector(".list-section"),
  listHeading: document.querySelector("#listHeading"),
  itemList: document.querySelector("#itemList"),
  emptyState: document.querySelector("#emptyState"),
  tabs: [...document.querySelectorAll(".tab-button")],
  calendarPanel: document.querySelector("#calendarPanel"),
  calendarPrevious: document.querySelector("#calendarPrevious"),
  calendarNext: document.querySelector("#calendarNext"),
  calendarHeading: document.querySelector("#calendarHeading"),
  calendarSelection: document.querySelector("#calendarSelection"),
  calendarSelectionText: document.querySelector("#calendarSelectionText"),
  calendarClearSelection: document.querySelector("#calendarClearSelection"),
  calendarItems: document.querySelector("#calendarItems"),
  calendarItemsEmpty: document.querySelector("#calendarItemsEmpty"),
  calendarGrid: document.querySelector("#calendarGrid"),
  resourcesPanel: document.querySelector("#resourcesPanel"),
  resourceSearch: document.querySelector("#resourceSearch"),
  resourceList: document.querySelector("#resourceList"),
  resourceEmpty: document.querySelector("#resourceEmpty"),
};

const saveTimers = new Map();
const savePromises = new Map();

// 公開網站使用 Firebase；本機開發仍保留原本的 Python API。
const remote = {
  enabled: false,
  app: null,
  auth: null,
  db: null,
  user: null,
  unsubscribers: [],
  items: [],
  blocks: [],
  documents: [],
};

function remoteCollection(name) {
  if (!remote.user) throw new Error("請先使用 Google 帳號登入");
  return remote.db.collection("users").doc(remote.user.uid).collection(name);
}

function remoteNow() {
  return new Date().toISOString();
}

function remoteId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function remoteDoc(data) {
  return { id: data.id, ...data };
}

function remoteItemList(view) {
  const flag = view === "todo" ? "in_todo" : "in_inbox";
  return remote.items
    .filter((item) => Boolean(item[flag]))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function remoteRefreshCalendar() {
  const first = `${state.calendar.month}-01`;
  const monthDate = calendarMonthDate();
  const next = new Date(monthDate);
  next.setMonth(next.getMonth() + 1);
  const last = isoDate(addDays(next, -1));
  state.calendar.blocks = remote.blocks
    .filter((block) => block.end_date >= first && block.start_date <= last)
    .map((block) => {
      const item = remote.items.find((candidate) => candidate.id === block.item_id);
      return {
        ...block,
        object_name: item?.object_name || block.object_name || "",
        subject: item?.subject || block.subject || "",
        in_inbox: Boolean(item?.in_inbox ?? block.in_inbox),
        in_todo: Boolean(item?.in_todo ?? block.in_todo),
        title: item ? `${item.object_name}｜${item.subject}` : (block.title || ""),
      };
    });
  const arranged = new Set(remote.blocks.map((block) => block.item_id));
  state.calendar.availableItems = remote.items
    .filter((item) => (item.in_inbox || item.in_todo) && !arranged.has(item.id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function remoteRefreshDocuments() {
  const query = state.resources.query.trim().toLowerCase();
  state.resources.documents = remote.documents
    .filter((documentData) => !query
      || String(documentData.document_name).toLowerCase().includes(query)
      || String(documentData.document_date).includes(query))
    .sort((a, b) => `${b.document_date}${b.document_name}`.localeCompare(`${a.document_date}${a.document_name}`));
}

function attachRemoteListeners() {
  for (const unsubscribe of remote.unsubscribers) unsubscribe();
  remote.unsubscribers = [];
  remote.unsubscribers.push(remoteCollection("items").onSnapshot((snapshot) => {
    remote.items = snapshot.docs.map((doc) => remoteDoc(doc.data()));
    state.inboxItems = remoteItemList("inbox");
    state.todoItems = remoteItemList("todo");
    remoteRefreshCalendar();
    render();
    setConnection(true, "已同步");
  }, () => setConnection(false, "同步中斷，稍後重試")));
  remote.unsubscribers.push(remoteCollection("calendar_blocks").onSnapshot((snapshot) => {
    remote.blocks = snapshot.docs.map((doc) => remoteDoc(doc.data()));
    remoteRefreshCalendar();
    if (state.view === "calendar") render();
  }, () => setConnection(false, "同步中斷，稍後重試")));
  remote.unsubscribers.push(remoteCollection("documents").onSnapshot((snapshot) => {
    remote.documents = snapshot.docs.map((doc) => remoteDoc(doc.data()));
    remoteRefreshDocuments();
    if (state.view === "resources") render();
  }, () => setConnection(false, "同步中斷，稍後重試")));
}

async function remoteApi(path, options = {}) {
  const url = new URL(path, window.location.origin);
  const method = (options.method || "GET").toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const parts = url.pathname.split("/").filter(Boolean);
  const now = remoteNow();
  if (!remote.user) throw new Error("請先使用 Google 帳號登入");

  if (parts[1] === "items" && parts.length === 2) {
    if (method === "GET") return { items: remoteItemList(url.searchParams.get("view") || "inbox") };
    if (method === "POST") {
      const item = {
        id: remoteId(),
        object_name: String(body.object_name || "").trim(),
        subject: String(body.subject || "").trim(),
        contact_name: String(body.contact_name || "").trim(),
        phone: String(body.phone || "").trim(),
        original_message: String(body.original_message || "").trim(),
        resource_location: String(body.resource_location || "").trim(),
        my_notes: String(body.my_notes || ""),
        source_type: body.source_type === "line" ? "line" : "manual",
        in_inbox: true,
        in_todo: false,
        note_revision: 0,
        created_at: now,
        updated_at: now,
      };
      await remoteCollection("items").doc(item.id).set(item);
      return { item };
    }
  }

  if (parts[1] === "items" && parts.length === 4 && parts[3] === "notes" && method === "PATCH") {
    const itemRef = remoteCollection("items").doc(parts[2]);
    let updated;
    updated = await remote.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(itemRef);
      if (!snapshot.exists) throw new Error("找不到這筆事情");
      const current = remoteDoc(snapshot.data());
      if (Number(current.note_revision || 0) !== Number(body.revision || 0)) {
        const conflict = new Error("伺服器已有較新的我的紀錄");
        conflict.status = 409;
        conflict.item = current;
        throw conflict;
      }
      const next = { ...current, my_notes: String(body.my_notes || ""), note_revision: Number(current.note_revision || 0) + 1, updated_at: now };
      transaction.update(itemRef, { my_notes: next.my_notes, note_revision: next.note_revision, updated_at: now });
      return next;
    });
    return { item: updated };
  }

  if (parts[1] === "items" && parts.length === 4 && method === "POST") {
    const itemRef = remoteCollection("items").doc(parts[2]);
    const snapshot = await itemRef.get();
    if (!snapshot.exists) throw new Error("找不到這筆事情");
    const item = remoteDoc(snapshot.data());
    if (parts[3] === "todo") {
      await itemRef.update({ in_inbox: false, in_todo: true, updated_at: now });
      return { item: { ...item, in_inbox: false, in_todo: true, updated_at: now } };
    }
    if (parts[3] === "complete") {
      const completion = { id: remoteId(), title: `${item.object_name}｜${item.subject}`, completed_at: now };
      const blockSnapshot = await remoteCollection("calendar_blocks").where("item_id", "==", item.id).get();
      const batch = remote.db.batch();
      batch.set(remoteCollection("completions").doc(completion.id), completion);
      batch.delete(itemRef);
      blockSnapshot.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      return { completion };
    }
  }

  if (parts[1] === "calendar" && parts.length === 2 && method === "GET") {
    remoteRefreshCalendar();
    return { blocks: state.calendar.blocks, available_items: state.calendar.availableItems };
  }
  if (parts[1] === "calendar" && parts[2] === "blocks" && parts.length === 3 && method === "POST") {
    const start = String(body.start_date || "");
    const end = String(body.end_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) throw new Error("日期格式錯誤");
    const existing = await remoteCollection("calendar_blocks").where("item_id", "==", body.item_id).get();
    if (!existing.empty) throw new Error("這筆事情已經有行事曆安排");
    const block = { id: remoteId(), item_id: body.item_id, start_date: start, end_date: end, created_at: now, updated_at: now };
    await remoteCollection("calendar_blocks").doc(block.id).set(block);
    return { block };
  }
  if (parts[1] === "calendar" && parts[2] === "blocks" && parts.length === 4 && method === "PATCH") {
    const start = String(body.start_date || "");
    const end = String(body.end_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) throw new Error("日期格式錯誤");
    await remoteCollection("calendar_blocks").doc(parts[3]).update({ start_date: start, end_date: end, updated_at: now });
    return { block: { id: parts[3], ...body, updated_at: now } };
  }

  if (parts[1] === "resources" && parts.length === 2 && method === "GET") {
    remoteRefreshDocuments();
    return { documents: state.resources.documents };
  }
  if (parts[1] === "resources" && parts.length === 3 && method === "GET") {
    const snapshot = await remoteCollection("documents").doc(parts[2]).get();
    if (!snapshot.exists) throw new Error("找不到正式文件");
    return { document: remoteDoc(snapshot.data()) };
  }
  if (parts[1] === "resources" && parts.length === 3 && method === "PATCH") {
    const ref = remoteCollection("documents").doc(parts[2]);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new Error("找不到正式文件");
    const current = remoteDoc(snapshot.data());
    const updated = { ...current, document_name: String(body.document_name || "").trim(), formal_content: String(body.formal_content || ""), updated_at: now };
    if (!updated.document_name) throw new Error("文件名稱不能空白");
    await ref.update({ document_name: updated.document_name, formal_content: updated.formal_content, updated_at: now });
    return { document: updated };
  }
  if (parts[1] === "items" && parts.length === 4 && parts[3] === "document" && method === "POST") {
    const itemSnapshot = await remoteCollection("items").doc(parts[2]).get();
    if (!itemSnapshot.exists) throw new Error("找不到這筆事情");
    const item = remoteDoc(itemSnapshot.data());
    const documentName = String(body.document_name || "").trim();
    const documentDate = String(body.document_date || new Date().toISOString().slice(0, 10));
    if (!documentName) throw new Error("文件名稱不能空白");
    const safeName = documentName.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").trim().replace(/[ .]+$/g, "").slice(0, 100) || "正式文件";
    const documentData = { id: remoteId(), item_id: item.id, document_name: documentName.slice(0, 200), document_date: documentDate, file_name: `${documentDate}_${safeName}.md`, original_content: String(body.original_content || "").slice(0, 100000), my_notes: String(body.my_notes || "").slice(0, 100000), formal_content: String(body.formal_content || "").slice(0, 100000), created_at: now, updated_at: now };
    await remoteCollection("documents").doc(documentData.id).set(documentData);
    return { document: documentData };
  }
  throw new Error("找不到這個操作");
}

function initializeFirebase() {
  if (!globalThis.firebase) return false;
  remote.app = firebase.initializeApp(FIREBASE_CONFIG);
  remote.auth = firebase.auth();
  remote.db = firebase.firestore();
  remote.enabled = true;
  elements.authButton.addEventListener("click", async () => {
    if (remote.user) {
      await remote.auth.signOut();
      return;
    }
    try {
      await remote.auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    } catch (error) {
      if (error.code === "auth/popup-blocked" || error.code === "auth/popup-closed-by-user") {
        showNotice("登入視窗被瀏覽器擋住，請允許彈出視窗後再按一次登入。", true);
      } else showNotice(`登入失敗：${error.message}`, true);
    }
  });
  remote.auth.onAuthStateChanged((user) => {
    remote.user = user;
    elements.authButton.textContent = user ? `登出 ${user.email || "Google 帳號"}` : "使用 Google 帳號登入";
    if (!user) {
      for (const unsubscribe of remote.unsubscribers) unsubscribe();
      remote.unsubscribers = [];
      remote.items = [];
      remote.blocks = [];
      remote.documents = [];
      state.inboxItems = [];
      state.todoItems = [];
      setConnection(false, "請先登入");
      render();
      return;
    }
    setConnection(true, "正在同步");
    attachRemoteListeners();
    void loadItems({ keepExpanded: false });
  });
  return true;
}

function setConnection(online, text) {
  elements.syncState.textContent = text;
  elements.syncState.classList.toggle("is-online", online);
  elements.syncState.classList.toggle("is-offline", !online);
}

function showNotice(message, isError = false) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle("is-error", isError);
  elements.notice.hidden = !message;
}

async function api(path, options = {}) {
  if (remote.enabled) return remoteApi(path, options);
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  let data = {};
  try {
    data = await response.json();
  } catch (_error) {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data.error || `連線錯誤（${response.status}）`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function activeItems() {
  return state.view === "inbox" ? state.inboxItems : state.todoItems;
}

function itemById(itemId) {
  return [...state.inboxItems, ...state.todoItems].find((item) => item.id === itemId);
}

async function loadItems({ keepExpanded = true } = {}) {
  try {
    const [inbox, todo] = await Promise.all([
      api("/api/items?view=inbox"),
      api("/api/items?view=todo"),
    ]);
    state.inboxItems = inbox.items;
    state.todoItems = todo.items;
    if (!keepExpanded || !itemById(state.expandedId)) {
      state.expandedId = null;
    }
    setConnection(true, "已連線");
    render();
  } catch (error) {
    setConnection(false, "連線中斷");
    showNotice(`無法讀取資料：${error.message}`, true);
  }
}

async function loadCalendar() {
  try {
    const data = await api(`/api/calendar?month=${encodeURIComponent(state.calendar.month)}`);
    state.calendar.blocks = data.blocks;
    state.calendar.availableItems = data.available_items;
    setConnection(true, "已連線");
    render();
  } catch (error) {
    setConnection(false, "連線中斷");
    showNotice(`無法讀取行事曆：${error.message}`, true);
  }
}

async function loadResources() {
  try {
    const query = state.resources.query.trim();
    const data = await api(`/api/resources?q=${encodeURIComponent(query)}`);
    state.resources.documents = data.documents;
    setConnection(true, "已連線");
    render();
  } catch (error) {
    setConnection(false, "連線中斷");
    showNotice(`無法讀取資源庫：${error.message}`, true);
  }
}

function render() {
  elements.inboxCount.textContent = String(state.inboxItems.length);
  elements.todoCount.textContent = String(state.todoItems.length);
  for (const tab of elements.tabs) {
    const active = tab.dataset.view === state.view;
    tab.classList.toggle("is-active", active);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }

  const isListView = state.view === "inbox" || state.view === "todo";
  elements.manualEntry.hidden = state.view !== "inbox";
  elements.listSection.hidden = !isListView;
  elements.calendarPanel.hidden = state.view !== "calendar";
  elements.resourcesPanel.hidden = state.view !== "resources";
  if (isListView) renderList();
  if (state.view === "calendar") renderCalendar();
  if (state.view === "resources") renderResources();
}

function renderList() {
  elements.listHeading.textContent = state.view === "inbox" ? "暫存區" : "待辦";
  elements.itemList.replaceChildren();
  const items = activeItems();
  elements.emptyState.hidden = items.length !== 0;
  for (const item of items) elements.itemList.append(createItemRow(item));
}

function createItemRow(item) {
  const row = document.createElement("li");
  row.className = "item-row";
  row.dataset.itemId = item.id;
  const title = document.createElement("button");
  title.type = "button";
  title.className = "item-title";
  title.textContent = `${item.object_name}｜${item.subject}`;
  title.setAttribute("aria-expanded", String(state.expandedId === item.id));
  title.addEventListener("click", () => {
    state.expandedId = state.expandedId === item.id ? null : item.id;
    render();
  });
  row.append(title);
  if (state.expandedId === item.id) row.append(createDetails(item));
  return row;
}

function createDetails(item) {
  const details = document.createElement("div");
  details.className = "item-details";
  const list = document.createElement("dl");
  list.className = "detail-list";
  const pairs = [
    ["對象", item.object_name],
    ["事情", item.subject],
    ["聯絡人", item.contact_name],
    ["電話", item.phone],
    ["原始訊息", item.original_message],
    ["資料位置", item.resource_location],
  ];
  for (const [label, value] of pairs) {
    const wrapper = document.createElement("div");
    wrapper.className = "detail-pair";
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value || "—";
    wrapper.append(term, description);
    list.append(wrapper);
  }
  details.append(list);

  const notes = createNotesEditor(item);
  details.append(notes.wrapper);
  const actions = document.createElement("div");
  actions.className = "item-actions";
  actions.append(
    actionButton(item.in_todo ? "已在待辦" : "待辦", item.in_todo, async () => {
      if (!(await syncNote(item.id, notes.textarea, notes.status))) return;
      await runItemAction(item.id, "todo", "已移到待辦");
    }),
    actionButton("行事曆", false, () => openCalendarFor(item.id)),
    actionButton("升級", false, async () => {
      if (!(await syncNote(item.id, notes.textarea, notes.status))) return;
      if (!details.querySelector(".official-editor")) {
        details.append(createOfficialEditor(item, notes.textarea));
      }
    }),
    actionButton("完成", false, async () => {
      if (!(await syncNote(item.id, notes.textarea, notes.status))) {
        showNotice("我的紀錄還沒同步，為避免遺失，現在不能完成。", true);
        return;
      }
      await runItemAction(item.id, "complete", "已完成並移出工作清單");
      localStorage.removeItem(`${DRAFT_PREFIX}${item.id}`);
    }, "", "complete"),
  );
  details.append(actions);
  return details;
}

function createNotesEditor(item) {
  const wrapper = document.createElement("div");
  wrapper.className = "notes-block";
  const label = document.createElement("label");
  label.className = "notes-label";
  label.htmlFor = `notes-${item.id}`;
  label.textContent = "我的紀錄";
  const textarea = document.createElement("textarea");
  textarea.id = `notes-${item.id}`;
  textarea.className = "my-notes";
  textarea.maxLength = 20000;
  let draft = readDraft(item.id);
  if (draft && draft.text === item.my_notes) {
    localStorage.removeItem(`${DRAFT_PREFIX}${item.id}`);
    draft = null;
  }
  textarea.value = draft ? draft.text : item.my_notes;
  const status = document.createElement("span");
  status.className = "note-status";
  status.textContent = draft ? "已暫存在這支手機，等待同步" : "已同步保存";
  textarea.addEventListener("input", () => {
    const currentItem = itemById(item.id);
    if (!currentItem) return;
    localStorage.setItem(`${DRAFT_PREFIX}${item.id}`, JSON.stringify({
      text: textarea.value,
      revision: currentItem.note_revision,
      savedAt: new Date().toISOString(),
    }));
    status.textContent = "已暫存在這支手機";
    status.classList.remove("is-warning");
    scheduleNoteSave(item.id, textarea, status);
  });
  if (draft) scheduleNoteSave(item.id, textarea, status);
  wrapper.append(label, textarea, status);
  return { wrapper, textarea, status };
}

function createOfficialEditor(item, notesTextarea) {
  const editor = document.createElement("section");
  editor.className = "official-editor";
  const heading = document.createElement("h3");
  heading.textContent = "升級：整理正式文件";
  const form = document.createElement("form");
  form.className = "official-form";
  const name = formField("文件名稱", "input", `${item.object_name}｜${item.subject}`, 200);
  const original = formField("原始內容", "textarea", item.original_message, 100000);
  const notes = formField("我的紀錄", "textarea", notesTextarea.value, 100000);
  const formal = formField("正式內容", "textarea", "", 100000);
  const dateField = formField("文件日期", "input", new Date().toISOString().slice(0, 10), 10);
  dateField.control.type = "date";
  const actions = document.createElement("div");
  actions.className = "form-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary-button";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => editor.remove());
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary-button";
  submit.textContent = "建立正式文件";
  actions.append(cancel, submit);
  form.append(name.wrapper, dateField.wrapper, original.wrapper, notes.wrapper, formal.wrapper, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const synced = await syncNote(item.id, notesTextarea, null);
      if (!synced) throw new Error("我的紀錄尚未同步，請確認網路後再試");
      await api(`/api/items/${item.id}/document`, {
        method: "POST",
        body: JSON.stringify({
          document_name: name.control.value.trim(),
          document_date: dateField.control.value,
          original_content: original.control.value,
          my_notes: notes.control.value,
          formal_content: formal.control.value,
        }),
      });
      showNotice("已建立正式文件並存入資源庫");
      state.view = "resources";
      state.expandedId = null;
      await loadResources();
    } catch (error) {
      showNotice(`建立正式文件失敗：${error.message}`, true);
      submit.disabled = false;
    }
  });
  editor.append(heading, form);
  return editor;
}

function formField(labelText, type, value, maxLength) {
  const wrapper = document.createElement("label");
  const label = document.createElement("span");
  label.textContent = labelText;
  const control = document.createElement(type);
  control.maxLength = maxLength;
  control.value = value || "";
  if (type === "textarea") control.rows = 4;
  wrapper.append(label, control);
  return { wrapper, control };
}

function actionButton(text, disabled, handler, title = "", extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `action-button ${extraClass}`.trim();
  button.textContent = text;
  button.disabled = disabled;
  if (title) button.title = title;
  if (handler) button.addEventListener("click", handler);
  return button;
}

function readDraft(itemId) {
  const raw = localStorage.getItem(`${DRAFT_PREFIX}${itemId}`);
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw);
    if (typeof draft.text !== "string" || !Number.isInteger(draft.revision)) return null;
    return draft;
  } catch (_error) {
    return null;
  }
}

function scheduleNoteSave(itemId, textarea, status) {
  clearTimeout(saveTimers.get(itemId));
  saveTimers.set(itemId, setTimeout(() => {
    void syncNote(itemId, textarea, status);
  }, 650));
}

async function syncNote(itemId, textarea, status) {
  if (!textarea) return true;
  clearTimeout(saveTimers.get(itemId));
  const previous = savePromises.get(itemId) || Promise.resolve(true);
  const next = previous.then(() => performNoteSave(itemId, textarea, status));
  savePromises.set(itemId, next.catch(() => false));
  return next;
}

async function performNoteSave(itemId, textarea, status) {
  const draft = readDraft(itemId);
  if (!draft) return true;
  const item = itemById(itemId);
  if (!item) return false;
  try {
    const data = await api(`/api/items/${itemId}/notes`, {
      method: "PATCH",
      body: JSON.stringify({ my_notes: draft.text, revision: draft.revision }),
      keepalive: true,
    });
    Object.assign(item, data.item);
    const latestDraft = readDraft(itemId);
    if (latestDraft && latestDraft.text === draft.text) {
      localStorage.removeItem(`${DRAFT_PREFIX}${itemId}`);
      if (status) {
        status.textContent = "已同步保存";
        status.classList.remove("is-warning");
      }
    } else if (latestDraft) {
      latestDraft.revision = data.item.note_revision;
      localStorage.setItem(`${DRAFT_PREFIX}${itemId}`, JSON.stringify(latestDraft));
      scheduleNoteSave(itemId, textarea, status);
    }
    setConnection(true, "已連線");
    return true;
  } catch (error) {
    if (status) {
      status.classList.add("is-warning");
      status.textContent = error.status === 409
        ? "另一個裝置有較新紀錄，本機文字仍保留"
        : "尚未同步，文字已保存在這支手機";
    }
    if (error.status !== 409) setConnection(false, "連線中斷");
    return false;
  }
}

async function runItemAction(itemId, action, successMessage) {
  try {
    await api(`/api/items/${itemId}/${action}`, { method: "POST", body: "{}" });
    state.expandedId = null;
    showNotice(successMessage);
    await loadItems({ keepExpanded: false });
  } catch (error) {
    showNotice(`操作失敗：${error.message}`, true);
  }
}

function countWeekdays(start, end) {
  let count = 0;
  for (let dateValue = new Date(`${start}T00:00:00`); isoDate(dateValue) <= end; dateValue = addDays(dateValue, 1)) {
    const day = dateValue.getDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

async function saveCalendarWorkdayNote(itemId, start, end) {
  const item = itemById(itemId) || remote.items.find((candidate) => candidate.id === itemId);
  if (!item) return;
  const line = `行事曆工作天數：${countWeekdays(start, end)} 天（${start.replaceAll("-", "/")}～${end.replaceAll("-", "/")}，不含六、日）`;
  const notes = String(item.my_notes || "").split("\n").filter((entry) => entry && !entry.startsWith("行事曆工作天數："));
  notes.push(line);
  let revision = Number(item.note_revision || 0);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await api(`/api/items/${itemId}/notes`, {
        method: "PATCH",
        body: JSON.stringify({ my_notes: notes.join("\n"), revision }),
      });
      Object.assign(item, data.item);
      return;
    } catch (error) {
      if (error.status !== 409 || !error.item) break;
      revision = Number(error.item.note_revision || 0);
      notes.splice(0, notes.length, ...String(error.item.my_notes || "").split("\n").filter((entry) => entry && !entry.startsWith("行事曆工作天數：")), line);
    }
  }
  showNotice("日期已更新，但工作天數文字尚未寫入我的紀錄。", true);
}

function setManualForm(open) {
  elements.manualForm.hidden = !open;
  elements.manualToggle.setAttribute("aria-expanded", String(open));
  elements.manualToggle.textContent = open ? "－ 收合手動輸入" : "＋ 手動輸入";
  if (open) elements.manualForm.elements.object_name.focus();
}

function openCalendarFor(itemId) {
  state.view = "calendar";
  state.expandedId = null;
  state.calendar.selectedItemId = itemId;
  showNotice("已選取這筆事情，請在日期上按住拖曳");
  void loadCalendar();
}

function calendarMonthDate() {
  const [year, month] = state.calendar.month.split("-").map(Number);
  return new Date(year, month - 1, 1);
}

function changeMonth(delta) {
  const next = calendarMonthDate();
  next.setMonth(next.getMonth() + delta);
  state.calendar.month = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  state.calendar.selectedItemId = null;
  void loadCalendar();
}

function renderCalendar() {
  const monthDate = calendarMonthDate();
  elements.calendarHeading.textContent = `${monthDate.getFullYear()} 年 ${monthDate.getMonth() + 1} 月`;
  const selectedTitle = calendarSelectedTitle();
  elements.calendarSelection.hidden = !selectedTitle;
  elements.calendarSelectionText.textContent = selectedTitle ? `準備安排：${selectedTitle}` : "";
  elements.calendarItems.replaceChildren();
  elements.calendarItemsEmpty.hidden = state.calendar.availableItems.length !== 0;
  for (const item of state.calendar.availableItems) {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "calendar-item-button";
    button.textContent = `${item.object_name}｜${item.subject}`;
    button.classList.toggle("is-selected", state.calendar.selectedItemId === item.id);
    button.addEventListener("click", () => {
      state.calendar.selectedItemId = state.calendar.selectedItemId === item.id ? null : item.id;
      renderCalendar();
    });
    row.append(button);
    elements.calendarItems.append(row);
  }

  const grid = elements.calendarGrid;
  grid.replaceChildren();
  const weekdays = document.createElement("div");
  weekdays.className = "calendar-weekdays";
  for (const day of ["日", "一", "二", "三", "四", "五", "六"]) {
    const cell = document.createElement("div");
    cell.className = "calendar-weekday";
    cell.textContent = day;
    weekdays.append(cell);
  }
  grid.append(weekdays);
  const first = new Date(monthDate);
  first.setDate(1 - first.getDay());
  for (let week = 0; week < 6; week += 1) {
    const weekStart = addDays(first, week * 7);
    const row = document.createElement("div");
    row.className = "calendar-week-row";
    row.dataset.weekStart = isoDate(weekStart);
    const days = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const dayDate = addDays(weekStart, offset);
      const day = document.createElement("div");
      day.className = "calendar-day";
      day.dataset.date = isoDate(dayDate);
      if (dayDate.getMonth() !== monthDate.getMonth()) day.classList.add("is-outside");
      const number = document.createElement("span");
      number.className = "calendar-day-number";
      number.textContent = String(dayDate.getDate());
      day.append(number);
      day.addEventListener("pointerdown", (event) => beginCalendarCreate(event, day.dataset.date));
      row.append(day);
      days.push(day);
    }
    grid.append(row);
    renderCalendarBlocks(row, weekStart);
    if (state.calendar.drag?.kind === "create" && state.calendar.drag.rowStart === row.dataset.weekStart) {
      const start = minDate(state.calendar.drag.startDate, state.calendar.drag.currentDate);
      const end = maxDate(state.calendar.drag.startDate, state.calendar.drag.currentDate);
      appendCalendarBar(row, {
        id: "preview",
        item_id: state.calendar.selectedItemId,
        start_date: start,
        end_date: end,
        title: calendarSelectedTitle() || "新安排",
      }, weekStart, true);
    }
  }
}

function renderCalendarBlocks(row, weekStart) {
  for (const block of state.calendar.blocks) {
    const rowEnd = isoDate(addDays(weekStart, 6));
    if (block.end_date < row.dataset.weekStart || block.start_date > rowEnd) continue;
    appendCalendarBar(row, block, weekStart, false);
  }
}

function appendCalendarBar(row, block, weekStart, preview) {
  const visibleStart = maxDate(block.start_date, isoDate(weekStart));
  const visibleEnd = minDate(block.end_date, isoDate(addDays(weekStart, 6)));
  const startOffset = dateDiff(isoDate(weekStart), visibleStart);
  const dayCount = dateDiff(visibleStart, visibleEnd) + 1;
  const bar = document.createElement("button");
  bar.type = "button";
  bar.className = `calendar-block${preview ? " is-preview" : ""}`;
  bar.dataset.blockId = block.id;
  bar.style.left = `${(startOffset / 7) * 100}%`;
  bar.style.width = `${(dayCount / 7) * 100}%`;
  const lane = calendarLane(row, block);
  bar.dataset.lane = String(lane);
  bar.style.top = `${24 + lane * 24}px`;
  bar.textContent = block.title;
  if (!preview) {
    bar.addEventListener("pointerdown", (event) => beginCalendarBlock(event, block));
    const left = document.createElement("span");
    left.className = "calendar-resize-handle left";
    const right = document.createElement("span");
    right.className = "calendar-resize-handle right";
    bar.append(left, right);
  }
  row.append(bar);
}

function calendarLane(row, block) {
  const rowStart = row.dataset.weekStart;
  const visibleStart = maxDate(block.start_date, rowStart);
  const visibleEnd = minDate(block.end_date, isoDate(addDays(new Date(`${rowStart}T00:00:00`), 6)));
  const startOffset = dateDiff(rowStart, visibleStart);
  const endOffset = dateDiff(rowStart, visibleEnd) + 1;
  const usedBars = [...row.querySelectorAll(".calendar-block:not(.is-preview)")];
  let lane = 0;
  while (usedBars.some((bar) => {
    if (Number.parseInt(bar.dataset.lane || "0", 10) !== lane) return false;
    const left = Number.parseFloat(bar.style.left) / 100 * 7;
    const right = left + Number.parseFloat(bar.style.width) / 100 * 7;
    return left < endOffset && right > startOffset;
  })) lane += 1;
  return lane;
}

function calendarSelectedTitle() {
  const item = itemById(state.calendar.selectedItemId)
    || state.calendar.availableItems.find((candidate) => candidate.id === state.calendar.selectedItemId);
  if (item) return `${item.object_name}｜${item.subject}`;
  const block = state.calendar.blocks.find((candidate) => candidate.item_id === state.calendar.selectedItemId);
  return block?.title || "";
}

function beginCalendarCreate(event, dateValue) {
  if (event.button !== 0 || !state.calendar.selectedItemId) return;
  event.preventDefault();
  state.calendar.drag = {
    kind: "create",
    pointerId: event.pointerId,
    rowStart: event.currentTarget.parentElement.dataset.weekStart,
    startDate: dateValue,
    currentDate: dateValue,
  };
  event.currentTarget.classList.add("is-dragging");
  document.addEventListener("pointermove", handleCalendarPointerMove);
  document.addEventListener("pointerup", finishCalendarPointer);
  renderCalendar();
}

function beginCalendarBlock(event, block) {
  event.preventDefault();
  event.stopPropagation();
  const day = dateFromPoint(event.clientX, event.clientY) || block.start_date;
  const target = event.target;
  const mode = target.classList.contains("left") ? "resize-start"
    : target.classList.contains("right") ? "resize-end" : "move";
  state.calendar.drag = {
    kind: "block",
    pointerId: event.pointerId,
    blockId: block.id,
    mode,
    originDate: day,
    startDate: block.start_date,
    endDate: block.end_date,
    currentDate: day,
  };
  document.addEventListener("pointermove", handleCalendarPointerMove);
  document.addEventListener("pointerup", finishCalendarPointer);
}

function handleCalendarPointerMove(event) {
  const drag = state.calendar.drag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const current = dateFromPoint(event.clientX, event.clientY);
  if (!current) return;
  drag.currentDate = current;
  renderCalendar();
}

async function finishCalendarPointer(event) {
  const drag = state.calendar.drag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  document.removeEventListener("pointermove", handleCalendarPointerMove);
  document.removeEventListener("pointerup", finishCalendarPointer);
  state.calendar.drag = null;
  if (drag.kind === "create") {
    const start = minDate(drag.startDate, drag.currentDate);
    const end = maxDate(drag.startDate, drag.currentDate);
    try {
      await api("/api/calendar/blocks", {
        method: "POST",
        body: JSON.stringify({ item_id: state.calendar.selectedItemId, start_date: start, end_date: end }),
      });
      await saveCalendarWorkdayNote(state.calendar.selectedItemId, start, end);
      state.calendar.selectedItemId = null;
      showNotice("已建立行事曆時間長條");
      await loadCalendar();
    } catch (error) {
      showNotice(`建立行事曆失敗：${error.message}`, true);
      renderCalendar();
    }
    return;
  }
  const delta = dateDiff(drag.originDate, drag.currentDate);
  let start = drag.startDate;
  let end = drag.endDate;
  if (drag.mode === "move") {
    start = isoDate(addDays(start, delta));
    end = isoDate(addDays(end, delta));
  } else if (drag.mode === "resize-start") {
    start = minDate(drag.currentDate, end);
  } else {
    end = maxDate(drag.currentDate, start);
  }
  try {
    await api(`/api/calendar/blocks/${drag.blockId}`, {
      method: "PATCH",
      body: JSON.stringify({ start_date: start, end_date: end }),
    });
    await saveCalendarWorkdayNote(drag.blockId ? state.calendar.blocks.find((block) => block.id === drag.blockId)?.item_id : null, start, end);
    showNotice("已更新行事曆時間");
    await loadCalendar();
  } catch (error) {
    showNotice(`更新行事曆失敗：${error.message}`, true);
    renderCalendar();
  }
}

function dateFromPoint(x, y) {
  const candidates = document.elementsFromPoint(x, y);
  for (const element of candidates) {
    const day = element.closest?.(".calendar-day");
    if (day?.dataset.date) return day.dataset.date;
  }
  return null;
}

function isoDate(value) {
  const dateValue = value instanceof Date ? value : new Date(value);
  return `${dateValue.getFullYear()}-${String(dateValue.getMonth() + 1).padStart(2, "0")}-${String(dateValue.getDate()).padStart(2, "0")}`;
}

function addDays(value, days) {
  const result = value instanceof Date ? new Date(value) : new Date(`${value}T00:00:00`);
  result.setDate(result.getDate() + days);
  return result;
}

function dateDiff(start, end) {
  return Math.round((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 86400000);
}

function minDate(first, second) {
  return first <= second ? first : second;
}

function maxDate(first, second) {
  return first >= second ? first : second;
}

function renderResources() {
  elements.resourceSearch.value = state.resources.query;
  elements.resourceList.replaceChildren();
  elements.resourceEmpty.hidden = state.resources.documents.length !== 0;
  for (const documentData of state.resources.documents) {
    const row = document.createElement("li");
    row.className = "resource-row";
    const title = document.createElement("button");
    title.type = "button";
    title.className = "resource-title";
    title.textContent = documentData.document_name;
    title.setAttribute("aria-expanded", String(state.resources.expandedId === documentData.id));
    title.addEventListener("click", () => toggleResource(documentData.id, row));
    row.append(title);
    if (state.resources.expandedId === documentData.id) {
      const details = state.resources.details.get(documentData.id);
      if (details) row.append(createResourceDetails(details));
    }
    elements.resourceList.append(row);
  }
}

async function toggleResource(documentId) {
  state.resources.expandedId = state.resources.expandedId === documentId ? null : documentId;
  if (state.resources.expandedId && !state.resources.details.has(documentId)) {
    try {
      const data = await api(`/api/resources/${documentId}`);
      state.resources.details.set(documentId, data.document);
    } catch (error) {
      showNotice(`無法開啟正式文件：${error.message}`, true);
    }
  }
  renderResources();
}

function createResourceDetails(documentData) {
  const details = document.createElement("div");
  details.className = "resource-details";
  const dateText = document.createElement("p");
  dateText.className = "resource-date";
  dateText.textContent = `日期：${documentData.document_date}　檔案：${documentData.file_name}`;
  const source = document.createElement("div");
  source.className = "detail-list";
  for (const [label, value] of [["原始內容", documentData.original_content], ["我的紀錄", documentData.my_notes]]) {
    const pair = document.createElement("div");
    pair.className = "detail-pair";
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value || "—";
    pair.append(term, description);
    source.append(pair);
  }
  const form = document.createElement("form");
  form.className = "resource-edit-form";
  const name = formField("文件名稱", "input", documentData.document_name, 200);
  const formal = formField("正式內容", "textarea", documentData.formal_content, 100000);
  const actions = document.createElement("div");
  actions.className = "form-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary-button";
  save.textContent = "保存修改";
  actions.append(save);
  form.append(name.wrapper, formal.wrapper, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const data = await api(`/api/resources/${documentData.id}`, {
        method: "PATCH",
        body: JSON.stringify({ document_name: name.control.value, formal_content: formal.control.value }),
      });
      state.resources.details.set(documentData.id, data.document);
      showNotice("正式文件已保存");
      await loadResources();
    } catch (error) {
      showNotice(`保存正式文件失敗：${error.message}`, true);
      save.disabled = false;
    }
  });
  details.append(dateText, source, form);
  return details;
}

elements.manualToggle.addEventListener("click", () => setManualForm(elements.manualForm.hidden));
elements.manualCancel.addEventListener("click", () => {
  elements.manualForm.reset();
  setManualForm(false);
});

elements.manualForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(elements.manualForm);
  const issue = String(data.get("issue") || "").trim();
  const requestedAction = String(data.get("requested_action") || "").trim();
  const subject = [issue, requestedAction].filter(Boolean).join("－");
  try {
    await api("/api/items", {
      method: "POST",
      body: JSON.stringify({
        object_name: String(data.get("object_name") || "").trim(),
        subject,
        contact_name: String(data.get("contact_name") || "").trim(),
        phone: String(data.get("phone") || "").trim(),
        original_message: String(data.get("original_message") || "").trim(),
        resource_location: String(data.get("resource_location") || "").trim(),
      }),
    });
    elements.manualForm.reset();
    setManualForm(false);
    showNotice("已存入暫存區");
    await loadItems({ keepExpanded: false });
  } catch (error) {
    showNotice(`無法儲存：${error.message}`, true);
  }
});

elements.calendarPrevious.addEventListener("click", () => changeMonth(-1));
elements.calendarNext.addEventListener("click", () => changeMonth(1));
elements.calendarClearSelection.addEventListener("click", () => {
  state.calendar.selectedItemId = null;
  renderCalendar();
});
elements.resourceSearch.addEventListener("input", () => {
  state.resources.query = elements.resourceSearch.value;
  clearTimeout(elements.resourceSearch.searchTimer);
  elements.resourceSearch.searchTimer = setTimeout(() => void loadResources(), 250);
});

for (const tab of elements.tabs) {
  tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    state.expandedId = null;
    showNotice("");
    if (state.view === "calendar") void loadCalendar();
    else if (state.view === "resources") void loadResources();
    else render();
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden" || !state.expandedId) return;
  const textarea = document.querySelector(`#notes-${CSS.escape(state.expandedId)}`);
  const status = textarea?.parentElement?.querySelector(".note-status");
  if (textarea && readDraft(state.expandedId)) void syncNote(state.expandedId, textarea, status);
});

window.addEventListener("online", () => {
  setConnection(true, "重新連線");
  void loadItems();
});
window.addEventListener("offline", () => setConnection(false, "目前離線"));

if (!initializeFirebase()) void loadItems();

