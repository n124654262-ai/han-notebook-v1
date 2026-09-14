"use strict";

const DRAFT_PREFIX = "han-notebook-note:";
const currentMonth = new Date().toISOString().slice(0, 7);
// 2028 先放主要節日；官方補班表公布後再更新。
const NATIONAL_HOLIDAYS = {
  "2026-01-01": "元旦", "2026-02-17": "春節", "2026-02-28": "和平紀念日", "2026-04-04": "兒童節", "2026-04-05": "清明節", "2026-05-01": "勞動節", "2026-06-19": "端午節", "2026-09-25": "中秋節", "2026-10-10": "國慶日",
  "2027-01-01": "元旦", "2027-02-06": "春節", "2027-02-28": "和平紀念日", "2027-04-04": "兒童節", "2027-04-05": "清明節", "2027-05-01": "勞動節", "2027-06-09": "端午節", "2027-09-15": "中秋節", "2027-10-10": "國慶日",
  "2028-01-01": "元旦", "2028-01-26": "春節", "2028-02-28": "和平紀念日", "2028-04-04": "清明節", "2028-05-01": "勞動節", "2028-05-28": "端午節", "2028-10-03": "中秋節", "2028-10-10": "國慶日",
};
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
  archiveItems: [],
  expandedIds: new Set(),
  archiveSelectedIds: new Set(),
  archiveDeleteConfirmation: null,
  completeConfirmations: new Set(),
  editingId: null,
  notesEditingIds: new Set(),
  itemEditDrafts: new Map(),
  calendar: {
    month: currentMonth,
    blocks: [],
    availableItems: [],
    selectedItemId: null,
    selectedBlockId: null,
    drag: null,
    swipeStart: null,
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
  archiveCount: document.querySelector("#archiveCount"),
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
  calendarQuickForm: document.querySelector("#calendarQuickForm"),
  calendarSelection: document.querySelector("#calendarSelection"),
  calendarSelectionText: document.querySelector("#calendarSelectionText"),
  calendarDateEdit: document.querySelector("#calendarDateEdit"),
  calendarEditStart: document.querySelector("#calendarEditStart"),
  calendarEditEnd: document.querySelector("#calendarEditEnd"),
  calendarSaveDates: document.querySelector("#calendarSaveDates"),
  calendarClearSelection: document.querySelector("#calendarClearSelection"),
  calendarDeleteBlock: document.querySelector("#calendarDeleteBlock"),
  calendarGrid: document.querySelector("#calendarGrid"),
  resourcesPanel: document.querySelector("#resourcesPanel"),
  resourceSearch: document.querySelector("#resourceSearch"),
  resourceList: document.querySelector("#resourceList"),
  resourceEmpty: document.querySelector("#resourceEmpty"),
};

const saveTimers = new Map();
const savePromises = new Map();
const VIEWED_EXTERNAL_ITEMS_KEY = "han-notebook-viewed-external-items";

function viewedExternalItemIds() {
  try {
    const value = JSON.parse(localStorage.getItem(VIEWED_EXTERNAL_ITEMS_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch { return new Set(); }
}

function markExternalItemViewed(itemId) {
  const ids = viewedExternalItemIds();
  ids.add(String(itemId));
  try { localStorage.setItem(VIEWED_EXTERNAL_ITEMS_KEY, JSON.stringify([...ids])); } catch {}
}

function updateDocumentTitle() {
  const viewed = viewedExternalItemIds();
  const unread = state.inboxItems.filter((item) => item.source_type === "external" && !viewed.has(String(item.id))).length;
  document.title = unread > 0 ? `（${unread}）HAN 筆記本` : "HAN 筆記本";
}

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
  publicSubmissions: new Map(),
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

function itemDisplayTitle(item) {
  const title = String(item?.object_name || "").trim();
  if (title) return title;
  const fallback = String(item?.subject || "").trim();
  return fallback || "未命名事項";
}

function remoteItemList(view) {
  const flag = view === "todo" ? "in_todo" : view === "archive" ? "in_archive" : "in_inbox";
  return remote.items
    .filter((item) => Boolean(item[flag]) && (view === "archive" || !item.in_archive))
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
        in_archive: Boolean(item?.in_archive ?? block.in_archive),
        title: item ? `${item.object_name}｜${item.subject}` : (block.title || ""),
      };
    })
    .filter((block) => !block.in_archive);
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

function publicSubmissionForItem(item) {
  if (item.source_submission_id) return remote.publicSubmissions.get(item.source_submission_id) || null;
  for (const [submissionId, submission] of remote.publicSubmissions.entries()) {
    const sameSource = submission.item_id === item.id;
    const sameFields = String(submission.object_name || "") === String(item.object_name || "")
      && String(submission.subject || "") === String(item.subject || "")
      && String(submission.contact_name || "") === String(item.contact_name || "")
      && String(submission.phone || "") === String(item.phone || "")
      && String(submission.resource_location || "") === String(item.resource_location || "")
      && (!item.created_at || String(submission.created_at || "") === String(item.created_at));
    if (sameSource || sameFields) {
      item.source_submission_id = submissionId;
      return submission;
    }
  }
  return null;
}

function attachRemoteListeners() {
  for (const unsubscribe of remote.unsubscribers) unsubscribe();
  remote.unsubscribers = [];
  remote.unsubscribers.push(remoteCollection("items").onSnapshot((snapshot) => {
    remote.items = snapshot.docs.map((doc) => {
      const item = remoteDoc(doc.data());
      publicSubmissionForItem(item);
      return item;
    });
    state.inboxItems = remoteItemList("inbox");
    state.todoItems = remoteItemList("todo");
    state.archiveItems = remoteItemList("archive");
    remoteRefreshCalendar();
    render();
    setConnection(true, "已同步");
  }, () => setConnection(false, "同步中斷，稍後重試")));
  // 員工公開留言：由負責人登入的瀏覽器匯入自己的暫存區。
  remote.unsubscribers.push(firebase.firestore().collection("public_submissions")
    .where("owner_email", "==", remote.user.email).onSnapshot((snapshot) => {
      snapshot.docs.forEach((doc) => remote.publicSubmissions.set(doc.id, doc.data()));
      snapshot.docChanges().filter((change) => change.type === "added").forEach(({ doc }) => {
        const submission = doc.data();
        if (submission.imported_at) return;
        // 以公開留言文件 ID 作為固定的事情 ID，避免同步重試時重複建立資料。
        const itemId = `external-${doc.id}`;
        const item = {
          id: itemId, source_submission_id: doc.id, object_name: submission.object_name || "", subject: submission.subject || "",
          contact_name: submission.contact_name || "", phone: submission.phone || "",
          original_message: "員工公開留言", resource_location: submission.resource_location || "",
          my_notes: submission.requested_action ? `需要我做什麼：${submission.requested_action}` : "",
          source_type: "external", in_inbox: true, in_todo: false, in_archive: false,
          note_revision: 0, created_at: submission.created_at || remoteNow(), updated_at: remoteNow(),
        };
        const itemRef = remoteCollection("items").doc(item.id);
        itemRef.get().then((existing) => existing.exists ? null : itemRef.set(item))
          .then(() => doc.ref.update({ imported_by: remote.user.uid, imported_at: remoteNow(), item_id: item.id }))
          .catch(() => {});
      });
    }, () => {}));
  remote.unsubscribers.push(remoteCollection("calendar_blocks").onSnapshot((snapshot) => {
    remote.blocks = snapshot.docs.map((doc) => remoteDoc(doc.data()));
    remoteRefreshCalendar();
    render();
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

  if (parts[1] === "items" && parts[2] === "batch-delete" && parts.length === 3 && method === "POST") {
    const requestedIds = Array.isArray(body.item_ids)
      ? [...new Set(body.item_ids.map((id) => String(id)).filter(Boolean))].slice(0, 100)
      : [];
    if (!requestedIds.length) return { deleted_ids: [] };
    const refs = requestedIds.map((id) => remoteCollection("items").doc(id));
    const snapshots = await Promise.all(refs.map((ref) => ref.get()));
    const archivedSnapshots = snapshots
      .filter((snapshot) => snapshot.exists && Boolean(snapshot.data().in_archive))
    if (!archivedSnapshots.length) return { deleted_ids: [] };
    await Promise.all(archivedSnapshots.map((snapshot) => snapshot.ref.delete()));
    return { deleted_ids: archivedSnapshots.map((snapshot) => snapshot.id) };
  }

  if (parts[1] === "items" && parts.length === 3 && method === "PATCH") {
    const itemRef = remoteCollection("items").doc(parts[2]);
    const snapshot = await itemRef.get();
    if (!snapshot.exists) throw new Error("找不到這筆事情");
    const updated = {
      object_name: String(body.object_name || "").trim(),
      subject: String(body.subject || "").trim(),
      contact_name: String(body.contact_name || "").trim(),
      phone: String(body.phone || "").trim(),
      original_message: String(body.original_message || "").trim(),
      resource_location: String(body.resource_location || "").trim(),
      updated_at: now,
    };
    await itemRef.update(updated);
    return { item: { ...remoteDoc(snapshot.data()), id: parts[2], ...updated } };
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
      await itemRef.update({ in_inbox: false, in_todo: true, in_archive: false, updated_at: now });
      return { item: { ...item, in_inbox: false, in_todo: true, in_archive: false, updated_at: now } };
    }
    if (parts[3] === "restore") {
      await itemRef.update({ in_inbox: true, in_todo: false, in_archive: false, updated_at: now });
      return { item: { ...item, in_inbox: true, in_todo: false, in_archive: false, updated_at: now } };
    }
    if (parts[3] === "complete") {
      const completion = { id: remoteId(), title: `${item.object_name}｜${item.subject}`, completed_at: now };
      const batch = remote.db.batch();
      batch.set(remoteCollection("completions").doc(completion.id), completion);
      batch.update(itemRef, { in_inbox: false, in_todo: false, in_archive: true, updated_at: now });
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
  if (parts[1] === "calendar" && parts[2] === "blocks" && parts.length === 4 && method === "DELETE") {
    const blockRef = remoteCollection("calendar_blocks").doc(parts[3]);
    const snapshot = await blockRef.get();
    if (!snapshot.exists) throw new Error("找不到行事曆安排");
    const block = remoteDoc(snapshot.data());
    await blockRef.delete();
    return { block };
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
if (elements.authButton) elements.authButton.addEventListener("click", async () => {
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
    if (elements.authButton) elements.authButton.textContent = user ? `登出 ${user.email || "Google 帳號"}` : "使用 Google 帳號登入";
    if (!user) {
      for (const unsubscribe of remote.unsubscribers) unsubscribe();
      remote.unsubscribers = [];
      remote.items = [];
      remote.blocks = [];
      remote.documents = [];
      remote.publicSubmissions.clear();
      state.inboxItems = [];
      state.todoItems = [];
      state.archiveItems = [];
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
  if (state.view === "todo") return state.todoItems;
  if (state.view === "archive") return state.archiveItems;
  return state.inboxItems;
}

function itemById(itemId) {
  return [...state.inboxItems, ...state.todoItems, ...state.archiveItems].find((item) => item.id === itemId);
}

async function loadItems({ keepExpanded = true } = {}) {
  try {
    const [inbox, todo, archive] = await Promise.all([
      api("/api/items?view=inbox"),
      api("/api/items?view=todo"),
      api("/api/items?view=archive"),
    ]);
    state.inboxItems = inbox.items;
    state.todoItems = todo.items;
    state.archiveItems = archive.items;
    if (!keepExpanded) state.expandedIds.clear();
    else state.expandedIds = new Set([...state.expandedIds].filter((id) => itemById(id)));
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
  elements.archiveCount.textContent = String(state.archiveItems.length);
  for (const tab of elements.tabs) {
    const active = tab.dataset.view === state.view;
    tab.classList.toggle("is-active", active);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }

  const isListView = state.view === "inbox" || state.view === "todo" || state.view === "archive";
  elements.manualEntry.hidden = state.view !== "inbox";
  elements.listSection.hidden = !isListView;
  elements.calendarPanel.hidden = state.view !== "calendar";
  elements.resourcesPanel.hidden = state.view !== "resources";
  updateDocumentTitle();
  if (isListView) renderList();
  if (state.view === "calendar") renderCalendar();
  if (state.view === "resources") renderResources();
}

function renderList() {
  elements.listHeading.textContent = state.view === "inbox" ? "暫存區" : state.view === "todo" ? "待辦" : "封存區";
  elements.itemList.replaceChildren();
  const items = activeItems();
  elements.emptyState.hidden = items.length !== 0;
  if (state.view === "archive") {
    const visibleIds = new Set(items.map((item) => item.id));
    state.archiveSelectedIds = new Set([...state.archiveSelectedIds].filter((id) => visibleIds.has(id)));
  } else {
    state.archiveSelectedIds.clear();
  }
  for (const item of items) elements.itemList.append(createItemRow(item));
  elements.listSection.querySelector(".archive-batch-actions")?.remove();
  if (state.view === "archive") {
    const actions = document.createElement("div");
    actions.className = "archive-batch-actions";
    const count = document.createElement("span");
    count.textContent = `已選取 ${state.archiveSelectedIds.size} 筆`;
    const selectAll = document.createElement("button");
    selectAll.type = "button";
    selectAll.className = "archive-selection-button";
    selectAll.textContent = "全選";
    selectAll.addEventListener("click", () => {
      state.archiveSelectedIds = new Set(items.map((item) => item.id));
      state.archiveDeleteConfirmation = null;
      renderList();
    });
    const clearSelection = document.createElement("button");
    clearSelection.type = "button";
    clearSelection.className = "archive-selection-button";
    clearSelection.textContent = "清除選取";
    clearSelection.disabled = state.archiveSelectedIds.size === 0;
    clearSelection.addEventListener("click", () => {
      state.archiveSelectedIds.clear();
      state.archiveDeleteConfirmation = null;
      renderList();
    });
    const button = document.createElement("button");
    button.type = "button";
    button.className = "danger-button";
    const confirming = state.archiveDeleteConfirmation
      && state.archiveDeleteConfirmation.ids.join("\u0000") === [...state.archiveSelectedIds].join("\u0000")
      && state.archiveDeleteConfirmation.expiresAt > Date.now();
    button.textContent = confirming ? "確認刪除" : "批次刪除";
    button.setAttribute("aria-label", confirming ? "確認刪除選取的封存資料" : "批次刪除");
    button.classList.toggle("is-confirming", Boolean(confirming));
    button.disabled = state.archiveSelectedIds.size === 0;
    button.addEventListener("click", () => void deleteSelectedArchiveItems());
    actions.append(count, selectAll, clearSelection, button);
    elements.listSection.append(actions);
  }
}

function createItemRow(item) {
  const row = document.createElement("li");
  row.className = "item-row";
  row.dataset.itemId = item.id;
  const titleRow = document.createElement("div");
  titleRow.className = "item-title-row";
  const editing = state.editingId === item.id;
  titleRow.classList.toggle("is-editing", editing);
  if (state.view === "archive") {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "archive-select";
    checkbox.checked = state.archiveSelectedIds.has(item.id);
    checkbox.setAttribute("aria-label", `選取 ${itemDisplayTitle(item)}`);
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.archiveSelectedIds.add(item.id);
      else state.archiveSelectedIds.delete(item.id);
      state.archiveDeleteConfirmation = null;
      renderList();
    });
    titleRow.append(checkbox);
  }
  const title = document.createElement("button");
  title.type = "button";
  title.className = "item-title";
  title.textContent = itemDisplayTitle(item);
  title.setAttribute("aria-expanded", String(state.expandedIds.has(item.id)));
  title.addEventListener("click", () => {
    if (item.source_type === "external") markExternalItemViewed(item.id);
    const collapsing = state.expandedIds.has(item.id);
    if (collapsing) state.expandedIds.delete(item.id);
    else state.expandedIds.add(item.id);
    if (collapsing && state.editingId === item.id) state.editingId = null;
    render();
  });
  titleRow.append(title);
  const calendarBlock = calendarBlockForItem(item.id);
  if (calendarBlock) {
    const schedule = document.createElement("span");
    schedule.className = "item-calendar-meta";
    const range = document.createElement("span");
    range.className = "item-calendar-range";
    range.textContent = `${formatCalendarShortDate(calendarBlock.start_date)}～${formatCalendarShortDate(calendarBlock.end_date)}`;
    const countdown = document.createElement("span");
    countdown.className = "item-calendar-countdown";
    countdown.textContent = calendarCountdownShortText(calendarBlock);
    schedule.append(range, countdown);
    schedule.title = "行事曆安排與工作天數";
    titleRow.append(schedule);
  }
  if (state.expandedIds.has(item.id) && !editing) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "item-inline-edit";
    edit.textContent = "編輯";
    edit.addEventListener("click", () => {
      state.editingId = item.id;
      render();
    });
    titleRow.append(edit);
  } else if (editing) {
    const indicator = document.createElement("span");
    indicator.className = "item-editing-indicator";
    indicator.textContent = "編輯中";
    titleRow.append(indicator);
  }
  row.append(titleRow);
  if (state.expandedIds.has(item.id)) row.append(createDetails(item));
  return row;
}

function replaceItem(updated) {
  const replace = (items) => items.map((item) => item.id === updated.id ? { ...item, ...updated } : item);
  state.inboxItems = replace(state.inboxItems);
  state.todoItems = replace(state.todoItems);
  state.archiveItems = replace(state.archiveItems);
  if (remote.enabled) {
    remote.items = replace(remote.items);
    remoteRefreshCalendar();
  }
}

function createItemEditForm(item) {
  const form = document.createElement("form");
  form.className = "item-edit-form";
  const original = {
    object_name: item.object_name || "",
    subject: item.subject || "",
    contact_name: item.contact_name || "",
    phone: item.phone || "",
    resource_location: item.resource_location || "",
  };
  const values = { ...original, ...(state.itemEditDrafts.get(item.id) || {}) };
  const fields = [
    ["標題／事項", "object_name", "input"],
    ["聯絡人", "contact_name", "input"],
    ["電話", "phone", "input"],
    ["內容", "subject", "textarea"],
    ["資料位置", "resource_location", "input"],
  ];
  const controls = {};
  for (const [label, key, type] of fields) {
    const field = formField(label, type, values[key], label === "內容" ? 2000 : 240);
    controls[key] = field.control;
    field.control.addEventListener("input", () => {
      state.itemEditDrafts.set(item.id, Object.fromEntries(
        Object.entries(controls).map(([name, control]) => [name, control.value]),
      ));
    });
    form.append(field.wrapper);
  }
  const actions = document.createElement("div");
  actions.className = "form-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary-button";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => {
    state.itemEditDrafts.delete(item.id);
    state.editingId = null;
    render();
  });
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary-button";
  save.textContent = "儲存";
  actions.append(cancel, save);
  form.append(actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const data = await api(`/api/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify(Object.fromEntries(
          Object.entries(controls).map(([name, control]) => [name, control.value]),
        )),
      });
      replaceItem(data.item);
      state.itemEditDrafts.delete(item.id);
      state.editingId = null;
      showNotice("資料已儲存");
      render();
    } catch (error) {
      showNotice(`儲存資料失敗：${error.message}`, true);
      save.disabled = false;
    }
  });
  return form;
}

function createDetails(item) {
  const details = document.createElement("div");
  details.className = "item-details";
  const editing = state.editingId === item.id;
  let editForm = null;
  if (editing) {
    editForm = createItemEditForm(item);
  } else {
    const list = document.createElement("dl");
    list.className = "detail-list";
    const topRow = document.createElement("div");
    topRow.className = "detail-top-row";
    const topPairs = [
      ["標題／事項", item.object_name],
      ["聯絡人", item.contact_name],
      ["電話", item.phone],
    ];
    for (const [label, value] of topPairs) {
      const wrapper = document.createElement("div");
      wrapper.className = "detail-pair";
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = value || "—";
      wrapper.append(term, description);
      topRow.append(wrapper);
    }
    list.append(topRow);
    for (const [label, value] of [["內容", item.subject], ["資料位置", item.resource_location]]) {
      const wrapper = document.createElement("div");
      wrapper.className = "detail-pair detail-full-row";
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = value || "—";
      wrapper.append(term, description);
      list.append(wrapper);
    }
    details.append(list);
  }

  const notes = createNotesEditor(item);
  if (editing) {
    const actions = editForm.querySelector(".form-actions");
    editForm.insertBefore(notes.wrapper, actions);
    details.append(editForm);
    details.classList.add("is-editing");
    return details;
  }
  details.append(notes.wrapper);
  const actions = document.createElement("div");
  actions.className = "item-actions";
  if (item.in_archive) {
    actions.append(actionButton("復原", false, async () => {
      await runItemAction(item.id, "restore", "已復原到暫存區");
    }));
  } else actions.append(
    actionButton(item.in_todo ? "已在待辦" : "待辦", item.in_todo, async () => {
      if (!(await syncNote(item.id, notes.textarea, notes.status))) return;
      await runItemAction(item.id, "todo", "已移到待辦");
    }),
    actionButton("行事曆", false, () => openCalendarFor(item.id)),
    actionButton("升級資源庫", false, async () => {
      if (!(await syncNote(item.id, notes.textarea, notes.status))) return;
      const currentItem = itemById(item.id) || item;
      const notesText = notes.textarea?.value ?? readDraft(item.id)?.text ?? currentItem.my_notes ?? "";
      if (!details.querySelector(".official-editor")) {
        details.append(createOfficialEditor(currentItem, notesText));
      }
    }),
    actionButton(state.completeConfirmations.has(item.id) ? "再次完成" : "完成", false, async () => {
      if (!(await syncNote(item.id, notes.textarea, notes.status))) {
        showNotice("我的紀錄還沒同步，為避免遺失，現在不能完成。", true);
        return;
      }
      if (!state.completeConfirmations.has(item.id)) {
        state.completeConfirmations.add(item.id);
        showNotice("再按一次完成，才會移到封存區");
        render();
        return;
      }
      state.completeConfirmations.delete(item.id);
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
  const header = document.createElement("div");
  header.className = "notes-header";
  const label = document.createElement("span");
  label.className = "notes-label";
  label.textContent = "我的紀錄";
  let draft = readDraft(item.id);
  if (draft && draft.text === item.my_notes) {
    localStorage.removeItem(`${DRAFT_PREFIX}${item.id}`);
    draft = null;
  }
  const value = draft ? draft.text : (item.my_notes || "");
  const editing = state.notesEditingIds.has(item.id);
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "notes-edit-toggle";
  editButton.textContent = editing ? "完成" : "編輯紀錄";
  editButton.addEventListener("click", () => {
    if (editing) state.notesEditingIds.delete(item.id);
    else state.notesEditingIds.add(item.id);
    render();
    if (!editing) {
      requestAnimationFrame(() => document.getElementById(`notes-${item.id}`)?.focus());
    }
  });
  header.append(label, editButton);

  if (!editing) {
    const display = document.createElement("div");
    display.className = "my-notes-display";
    display.textContent = value || "尚無紀錄";
    display.classList.toggle("is-empty", !value);
    wrapper.append(header, display);
    if (draft) {
      const pending = document.createElement("span");
      pending.className = "note-status is-warning";
      pending.textContent = "尚待同步，文字已保存在這支手機";
      wrapper.append(pending);
    }
    return { wrapper, textarea: null, status: null };
  }

  const textarea = document.createElement("textarea");
  textarea.id = `notes-${item.id}`;
  textarea.className = "my-notes";
  textarea.rows = 3;
  textarea.maxLength = 20000;
  textarea.value = value;
  const status = document.createElement("span");
  status.className = "note-status";
  status.textContent = draft ? "已暫存在這支手機，等待同步" : "已同步保存";
  textarea.addEventListener("input", () => {
    autoGrowTextarea(textarea);
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
  wrapper.append(header, textarea, status);
  const grow = () => {
    if (textarea.isConnected) autoGrowTextarea(textarea);
    else requestAnimationFrame(grow);
  };
  grow();
  return { wrapper, textarea, status };
}

function autoGrowTextarea(textarea) {
  textarea.style.height = "auto";
  const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 24;
  textarea.style.height = `${textarea.scrollHeight + (lineHeight * 2)}px`;
}

function createOfficialEditor(item, notesText) {
  const editor = document.createElement("section");
  editor.className = "official-editor";
  const heading = document.createElement("h3");
  heading.textContent = "升級：整理正式文件";
  const form = document.createElement("form");
  form.className = "official-form";
  const name = formField("文件名稱", "input", `${item.object_name}｜${item.subject}`, 200);
  const original = formField("原始內容", "textarea", item.original_message, 100000);
  const notes = formField("我的紀錄", "textarea", notesText, 100000);
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
      state.expandedIds.clear();
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
  if (type === "textarea") {
    control.rows = 3;
    if (labelText === "內容") {
      control.classList.add("auto-grow-content");
      control.addEventListener("input", () => autoGrowContentTextarea(control));
      requestAnimationFrame(() => autoGrowContentTextarea(control));
    }
  }
  wrapper.append(label, control);
  return { wrapper, control };
}

function autoGrowContentTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(textarea.scrollHeight, 84)}px`;
}

function resetManualTextareaHeight() {
  const textarea = elements.manualForm.querySelector('textarea[name="issue"]');
  if (textarea) autoGrowContentTextarea(textarea);
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
  if (!textarea && !readDraft(itemId)) return true;
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
      if (textarea) scheduleNoteSave(itemId, textarea, status);
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
    state.expandedIds.clear();
    showNotice(successMessage);
    await loadItems({ keepExpanded: false });
  } catch (error) {
    showNotice(`操作失敗：${error.message}`, true);
  }
}

async function deleteSelectedArchiveItems() {
  const itemIds = [...state.archiveSelectedIds];
  if (!itemIds.length) return;
  const now = Date.now();
  const pending = state.archiveDeleteConfirmation;
  const sameSelection = pending && pending.ids.join("\u0000") === itemIds.join("\u0000");
  if (!sameSelection || pending.expiresAt <= now) {
    state.archiveDeleteConfirmation = { ids: itemIds, expiresAt: now + 8000 };
    showNotice(`請在 8 秒內再按一次「確認刪除」，共 ${itemIds.length} 筆；刪除後無法復原。`);
    renderList();
    return;
  }
  state.archiveDeleteConfirmation = null;
  try {
    const data = await api("/api/items/batch-delete", {
      method: "POST",
      body: JSON.stringify({ item_ids: itemIds }),
    });
    const deletedIds = Array.isArray(data?.deleted_ids) ? data.deleted_ids.map(String) : [];
    if (!deletedIds.length) throw new Error("選取的資料已不存在，或不是封存資料");
    state.archiveSelectedIds.clear();
    state.expandedIds.clear();
    const deleted = new Set(deletedIds);
    remote.items = remote.items.filter((item) => !deleted.has(String(item.id)));
    state.inboxItems = state.inboxItems.filter((item) => !deleted.has(String(item.id)));
    state.todoItems = state.todoItems.filter((item) => !deleted.has(String(item.id)));
    state.archiveItems = state.archiveItems.filter((item) => !deleted.has(String(item.id)));
    showNotice(`已刪除 ${deletedIds.length} 筆封存資料`);
    render();
    await loadItems({ keepExpanded: false });
  } catch (error) {
    showNotice(`批次刪除失敗：${error.message}`, true);
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

function calendarBlockForItem(itemId) {
  const blocks = remote.enabled ? remote.blocks : state.calendar.blocks;
  return blocks.find((block) => block.item_id === itemId && block.start_date && block.end_date) || null;
}

function formatCalendarShortDate(value) {
  const match = String(value || "").match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}/${match[2]}` : String(value || "");
}

function workdaysUntil(startDate) {
  const today = isoDate(new Date());
  if (startDate <= today) return 0;
  return countWeekdays(isoDate(addDays(today, 1)), startDate);
}

function calendarCountdownText(block) {
  const today = isoDate(new Date());
  if (block.end_date < today) return "已結束";
  if (block.start_date <= today) return "今天開始";
  return `距開始還有${workdaysUntil(block.start_date)}工作天`;
}

function calendarCountdownShortText(block) {
  const today = isoDate(new Date());
  if (block.end_date < today) return "已結束";
  if (block.start_date <= today) return "今天";
  return `剩${workdaysUntil(block.start_date)}天`;
}

async function deleteSelectedCalendarBlock() {
  if (isSmallCalendarScreen()) return;
  const block = state.calendar.blocks.find((candidate) => candidate.id === state.calendar.selectedBlockId);
  if (!block) return;
  if (!window.confirm(`確定刪除「${block.title}」的行事曆時間條？`)) return;
  try {
    await api(`/api/calendar/blocks/${block.id}`, { method: "DELETE" });
    state.calendar.selectedBlockId = null;
    showNotice("已刪除行事曆時間條");
    await loadCalendar();
  } catch (error) {
    showNotice(`刪除行事曆時間條失敗：${error.message}`, true);
  }
}

async function saveCalendarDates() {
  if (isSmallCalendarScreen()) return;
  const block = state.calendar.blocks.find((candidate) => candidate.id === state.calendar.selectedBlockId);
  if (!block) return;
  const start = String(elements.calendarEditStart.value || "");
  const end = String(elements.calendarEditEnd.value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    showNotice("請確認開始日與結束日", true);
    return;
  }
  elements.calendarSaveDates.disabled = true;
  try {
    await api(`/api/calendar/blocks/${block.id}`, {
      method: "PATCH",
      body: JSON.stringify({ start_date: start, end_date: end }),
    });
    showNotice("已更新行事曆時間");
    await loadCalendar();
  } catch (error) {
    showNotice(`更新行事曆失敗：${error.message}`, true);
    renderCalendar();
  } finally {
    elements.calendarSaveDates.disabled = false;
  }
}

function setManualForm(open) {
  elements.manualForm.hidden = !open;
  elements.manualToggle.setAttribute("aria-expanded", String(open));
  elements.manualToggle.textContent = open ? "－ 收合手動輸入" : "＋ 手動輸入";
}

function openCalendarFor(itemId) {
  state.view = "calendar";
  state.expandedIds.clear();
  state.calendar.selectedItemId = itemId;
  state.calendar.selectedBlockId = null;
  showNotice("已選取這筆事情，請在日期上按住拖曳");
  void loadCalendar();
}

function quickCalendarFields(value) {
  const text = String(value || "").trim();
  const separator = text.indexOf("｜");
  if (separator < 0) {
    return { object_name: "", subject: text, original_message: text };
  }
  return {
    object_name: text.slice(0, separator).trim(),
    subject: text.slice(separator + 1).trim(),
    original_message: text,
  };
}

function rememberCreatedItem(item) {
  if (!item?.id) return;
  if (remote.enabled) {
    remote.items = [item, ...remote.items.filter((candidate) => candidate.id !== item.id)];
    state.inboxItems = remoteItemList("inbox");
    state.todoItems = remoteItemList("todo");
    return;
  }
  state.inboxItems = [item, ...state.inboxItems.filter((candidate) => candidate.id !== item.id)];
}

async function createQuickCalendarIdea(event) {
  event.preventDefault();
  const formData = new FormData(elements.calendarQuickForm);
  const text = String(formData.get("title") || "").trim();
  if (!text) {
    showNotice("請輸入想法內容", true);
    return;
  }
  const fields = quickCalendarFields(text);
  try {
    const data = await api("/api/items", {
      method: "POST",
      body: JSON.stringify(fields),
    });
    rememberCreatedItem(data.item);
    elements.calendarQuickForm.reset();
    state.view = "calendar";
    state.expandedIds.clear();
    state.calendar.selectedItemId = data.item.id;
    state.calendar.selectedBlockId = null;
    showNotice("已新增行事曆想法，請在日期上按住拖曳");
    render();
    await loadCalendar();
  } catch (error) {
    showNotice(`無法新增行事曆想法：${error.message}`, true);
  }
}

function calendarMonthDate() {
  const [year, month] = state.calendar.month.split("-").map(Number);
  return new Date(year, month - 1, 1);
}

function isSmallCalendarScreen() {
  return window.matchMedia("(max-width: 420px)").matches;
}

function startCalendarSwipe(event) {
  if (!isSmallCalendarScreen()) return;
  const touch = event.touches[0];
  if (!touch) return;
  state.calendar.swipeStart = { x: touch.clientX, y: touch.clientY };
}

function finishCalendarSwipe(event) {
  const start = state.calendar.swipeStart;
  state.calendar.swipeStart = null;
  if (!isSmallCalendarScreen() || !start) return;
  const touch = event.changedTouches[0];
  if (!touch) return;
  const deltaX = touch.clientX - start.x;
  const deltaY = touch.clientY - start.y;
  if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;
  // 手機手勢：往左滑切到下個月，往右滑回上個月。
  changeMonth(deltaX < 0 ? 1 : -1);
}

function cancelCalendarSwipe() {
  state.calendar.swipeStart = null;
}

let calendarWheelTimer = null;

function handleCalendarWheel(event) {
  if (isSmallCalendarScreen() || !event.deltaY) return;
  event.preventDefault();
  if (calendarWheelTimer) return;
  calendarWheelTimer = window.setTimeout(() => {
    calendarWheelTimer = null;
  }, 220);
  // 電腦滾輪：往上看上個月，往下看下個月。
  changeMonth(event.deltaY < 0 ? -1 : 1);
}

function changeMonth(delta) {
  const next = calendarMonthDate();
  next.setMonth(next.getMonth() + delta);
  state.calendar.month = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  state.calendar.selectedItemId = null;
  state.calendar.selectedBlockId = null;
  void loadCalendar();
}

function renderCalendar() {
  const monthDate = calendarMonthDate();
  elements.calendarHeading.textContent = `${monthDate.getFullYear()} 年 ${monthDate.getMonth() + 1} 月`;
  if (isSmallCalendarScreen() && elements.notice.textContent === "已更新行事曆時間") showNotice("");
  const selectedTitle = calendarSelectedTitle();
  const selectedBlock = state.calendar.blocks.find((block) => block.id === state.calendar.selectedBlockId);
  const preview = calendarDragPreview();
  elements.calendarSelection.hidden = !selectedTitle && !selectedBlock && !preview;
  elements.calendarSelectionText.textContent = preview
    ? `預覽：${preview.start_date}～${preview.end_date}`
    : selectedBlock
      ? `已選取：${selectedBlock.title}（${selectedBlock.start_date}～${selectedBlock.end_date}）`
      : selectedTitle ? `準備安排：${selectedTitle}` : "";
  elements.calendarDeleteBlock.hidden = !selectedBlock || Boolean(state.calendar.drag);
  const dateEditing = Boolean(selectedBlock && !preview && !state.calendar.drag && !isSmallCalendarScreen());
  elements.calendarDateEdit.hidden = !dateEditing;
  if (dateEditing) {
    elements.calendarEditStart.value = selectedBlock.start_date;
    elements.calendarEditEnd.value = selectedBlock.end_date;
  }
  const grid = elements.calendarGrid;
  grid.replaceChildren();
  const weekdays = document.createElement("div");
  weekdays.className = "calendar-weekdays";
  for (const day of ["一", "二", "三", "四", "五", "六", "日"]) {
    const cell = document.createElement("div");
    cell.className = "calendar-weekday";
    cell.textContent = day;
    weekdays.append(cell);
  }
  grid.append(weekdays);
  const first = new Date(monthDate);
  const mondayOffset = (first.getDay() + 6) % 7;
  first.setDate(1 - mondayOffset);
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
      const dateKey = day.dataset.date;
      const holidayName = NATIONAL_HOLIDAYS[dateKey];
      if (dateKey === isoDate(new Date())) day.classList.add("is-today");
      if (holidayName) {
        day.classList.add("is-holiday");
        day.title = holidayName;
      }
      const number = document.createElement("span");
      number.className = "calendar-day-number";
      number.textContent = String(dayDate.getDate());
      day.append(number);
      if (holidayName) {
        const holiday = document.createElement("span");
        holiday.className = "calendar-holiday-name";
        holiday.textContent = holidayName;
        day.append(holiday);
      }
      day.addEventListener("pointerdown", (event) => beginCalendarCreate(event, day.dataset.date));
      row.append(day);
      days.push(day);
    }
    grid.append(row);
    const previewBlock = calendarDragPreview();
    renderCalendarBlocks(row, weekStart, previewBlock?.id);
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
    if (previewBlock && previewBlock.end_date >= row.dataset.weekStart
      && previewBlock.start_date <= isoDate(addDays(weekStart, 6))) {
      appendCalendarBar(row, previewBlock, weekStart, true);
    }
  }
}

function renderCalendarBlocks(row, weekStart, skipBlockId = "") {
  for (const block of state.calendar.blocks) {
    if (block.id === skipBlockId) continue;
    const rowEnd = isoDate(addDays(weekStart, 6));
    if (block.end_date < row.dataset.weekStart || block.start_date > rowEnd) continue;
    appendCalendarBar(row, block, weekStart, false);
  }
}

function calendarColorIndex(block) {
  const source = String(block.id || block.item_id || block.title || "");
  let hash = 0;
  for (const character of source) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 8;
}

function appendCalendarBar(row, block, weekStart, preview) {
  const visibleStart = maxDate(block.start_date, isoDate(weekStart));
  const visibleEnd = minDate(block.end_date, isoDate(addDays(weekStart, 6)));
  const startOffset = dateDiff(isoDate(weekStart), visibleStart);
  const dayCount = dateDiff(visibleStart, visibleEnd) + 1;
  const bar = document.createElement("button");
  bar.type = "button";
  bar.className = `calendar-block calendar-color-${calendarColorIndex(block)}${preview ? " is-preview" : ""}`;
  bar.dataset.blockId = block.id;
  bar.style.left = `${(startOffset / 7) * 100}%`;
  bar.style.width = `${(dayCount / 7) * 100}%`;
  const lane = calendarLane(row, block);
  bar.dataset.lane = String(lane);
  bar.style.top = `${22 + lane * 16}px`;
  const label = document.createElement("span");
  label.className = "calendar-block-label";
  label.textContent = block.title;
  bar.append(label);
  if (!preview) {
    bar.addEventListener("pointerdown", (event) => beginCalendarBlock(event, block));
    bar.addEventListener("click", () => {
      state.calendar.selectedBlockId = block.id;
      state.calendar.selectedItemId = null;
      renderCalendar();
    });
    const left = document.createElement("span");
    left.className = "calendar-resize-handle left";
    const right = document.createElement("span");
    right.className = "calendar-resize-handle right";
    bar.append(left, right);
  }
  row.append(bar);
}

function calendarDragPreview() {
  const drag = state.calendar.drag;
  if (!drag || drag.kind !== "block") return null;
  let start = drag.startDate;
  let end = drag.endDate;
  if (drag.mode === "move") {
    const delta = dateDiff(drag.originDate, drag.currentDate);
    start = isoDate(addDays(start, delta));
    end = isoDate(addDays(end, delta));
  } else if (drag.mode === "resize-start") {
    start = minDate(drag.currentDate, end);
  } else {
    end = maxDate(drag.currentDate, start);
  }
  const original = state.calendar.blocks.find((block) => block.id === drag.blockId);
  if (!original) return null;
  return { ...original, start_date: start, end_date: end };
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
  if (isSmallCalendarScreen() || event.button !== 0 || !state.calendar.selectedItemId) return;
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
  if (isSmallCalendarScreen()) {
    state.calendar.selectedBlockId = block.id;
    state.calendar.selectedItemId = null;
    state.calendar.drag = null;
    return;
  }
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
  state.calendar.selectedBlockId = block.id;
  state.calendar.selectedItemId = null;
  document.addEventListener("pointermove", handleCalendarPointerMove);
  document.addEventListener("pointerup", finishCalendarPointer);
  renderCalendar();
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
  state.calendar.drag = { ...drag, saving: true };
  renderCalendar();
  if (drag.kind === "create") {
    const start = minDate(drag.startDate, drag.currentDate);
    const end = maxDate(drag.startDate, drag.currentDate);
    try {
      await api("/api/calendar/blocks", {
        method: "POST",
        body: JSON.stringify({ item_id: state.calendar.selectedItemId, start_date: start, end_date: end }),
      });
      state.calendar.selectedItemId = null;
      state.calendar.drag = null;
      showNotice("已建立行事曆時間長條");
      await loadCalendar();
    } catch (error) {
      state.calendar.drag = null;
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
  if (start === drag.startDate && end === drag.endDate) {
    state.calendar.drag = null;
    renderCalendar();
    return;
  }
  try {
    await api(`/api/calendar/blocks/${drag.blockId}`, {
      method: "PATCH",
      body: JSON.stringify({ start_date: start, end_date: end }),
    });
    state.calendar.drag = null;
    showNotice("已更新行事曆時間");
    await loadCalendar();
  } catch (error) {
    state.calendar.drag = null;
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


const manualContentTextarea = elements.manualForm.querySelector('textarea[name="issue"]');
if (manualContentTextarea) {
  manualContentTextarea.classList.add("auto-grow-content");
  manualContentTextarea.addEventListener("input", () => autoGrowContentTextarea(manualContentTextarea));
  requestAnimationFrame(() => autoGrowContentTextarea(manualContentTextarea));
}

elements.manualToggle.addEventListener("click", () => setManualForm(elements.manualForm.hidden));
elements.manualCancel.addEventListener("click", () => {
  elements.manualForm.reset();
  resetManualTextareaHeight();
  setManualForm(false);
});

elements.manualForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(elements.manualForm);
  const issue = String(data.get("issue") || "").trim();
  const subject = issue;
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
    resetManualTextareaHeight();
    setManualForm(false);
    showNotice("已存入暫存區");
    await loadItems({ keepExpanded: false });
  } catch (error) {
    showNotice(`無法儲存：${error.message}`, true);
  }
});

elements.calendarPrevious.addEventListener("click", () => changeMonth(-1));
elements.calendarNext.addEventListener("click", () => changeMonth(1));
elements.calendarQuickForm.addEventListener("submit", (event) => void createQuickCalendarIdea(event));
elements.calendarSaveDates.addEventListener("click", () => void saveCalendarDates());
elements.calendarGrid.addEventListener("touchstart", startCalendarSwipe, { passive: true });
elements.calendarGrid.addEventListener("touchend", finishCalendarSwipe, { passive: true });
elements.calendarGrid.addEventListener("touchcancel", cancelCalendarSwipe, { passive: true });
elements.calendarGrid.addEventListener("wheel", handleCalendarWheel, { passive: false });
elements.calendarClearSelection.addEventListener("click", () => {
  state.calendar.selectedItemId = null;
  state.calendar.selectedBlockId = null;
  renderCalendar();
});
elements.calendarDeleteBlock.addEventListener("click", () => void deleteSelectedCalendarBlock());
elements.resourceSearch.addEventListener("input", () => {
  state.resources.query = elements.resourceSearch.value;
  clearTimeout(elements.resourceSearch.searchTimer);
  elements.resourceSearch.searchTimer = setTimeout(() => void loadResources(), 250);
});

for (const tab of elements.tabs) {
  tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    state.expandedIds.clear();
    if (state.view !== "archive") state.archiveSelectedIds.clear();
    state.editingId = null;
    showNotice("");
    if (state.view === "calendar") {
      state.calendar.month = new Date().toISOString().slice(0, 7);
      void loadCalendar();
    }
    else if (state.view === "resources") void loadResources();
    else render();
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  for (const itemId of state.expandedIds) {
    const textarea = document.querySelector(`#notes-${CSS.escape(itemId)}`);
    const status = textarea?.parentElement?.querySelector(".note-status");
    if (textarea && readDraft(itemId)) void syncNote(itemId, textarea, status);
  }
});

window.addEventListener("online", () => {
  setConnection(true, "重新連線");
  void loadItems();
});
window.addEventListener("offline", () => setConnection(false, "目前離線"));

if (!initializeFirebase()) void loadItems();
