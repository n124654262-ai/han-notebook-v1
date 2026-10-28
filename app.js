"use strict";

const DRAFT_PREFIX = "han-notebook-note:";
const DELETE_COUNTDOWN_SECONDS = 3;
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
const AUTHORIZED_EMAIL = "n124654262@gmail.com";
const DISPLAY_MODE_KEY = "han-notebook-display-mode";

function readDisplayMode() {
  try {
    return localStorage.getItem(DISPLAY_MODE_KEY) === "cards" ? "cards" : "list";
  } catch {
    return "list";
  }
}

function saveDisplayMode(mode) {
  try { localStorage.setItem(DISPLAY_MODE_KEY, mode); } catch {}
}

const state = {
  view: "inbox",
  displayMode: readDisplayMode(),
  inboxItems: [],
  todoItems: [],
  archiveItems: [],
  expandedIds: new Set(),
  archiveSelectedIds: new Set(),
  archiveDeleteConfirmation: null,
  renderDeferred: false,
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
    deleteConfirmation: null,
    drag: null,
    swipeStart: null,
  },
  resources: {
    documents: [],
    expandedId: null,
    details: new Map(),
    deleteConfirmations: new Map(),
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
  main: document.querySelector("main"),
  viewModeToggle: document.querySelector("#viewModeToggle"),
  viewModeButtons: [...document.querySelectorAll("[data-view-mode]")],
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
  calendarOpenItem: document.querySelector("#calendarOpenItem"),
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

function remoteDoc(data, documentId = "") {
  return { ...data, id: data.id || documentId };
}

function itemDisplayTitle(item) {
  const title = String(item?.object_name || "").trim();
  if (title) return title;
  const fallback = String(item?.subject || "").trim();
  return fallback || "未命名事項";
}

function compactDesktopTitle(value) {
  const text = String(value || "");
  if (!globalThis.matchMedia?.("(min-width: 761px)").matches) return text;
  const maxChars = globalThis.matchMedia("(min-width: 1200px)").matches ? 72 : 42;
  const characters = [...text];
  if (characters.length <= maxChars) return text;
  const visibleChars = maxChars - 1;
  const headCount = Math.ceil(visibleChars / 2);
  const tailCount = Math.floor(visibleChars / 2);
  return `${characters.slice(0, headCount).join("")}…${characters.slice(-tailCount).join("")}`;
}

function normalizedRemoteId(value) {
  if (value && typeof value === "object") {
    return String(value.id || value.path || value._key?.path?.segments?.at(-1) || "");
  }
  return String(value ?? "");
}

function calendarItemId(block) {
  return block?.item_id ?? block?.itemId ?? block?.itemID ?? block?.item_ref ?? block?.item ?? "";
}

function calendarItemForBlock(block) {
  const itemId = calendarItemId(block);
  return remote.items.find((candidate) => normalizedRemoteId(candidate.id) === normalizedRemoteId(itemId)) || null;
}

function calendarItemTitle(item) {
  const parts = [item?.object_name, item?.subject].map((value) => String(value || "").trim()).filter(Boolean);
  return parts.join("｜") || itemDisplayTitle(item);
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    const pinnedOrder = Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned));
    if (pinnedOrder !== 0) return pinnedOrder;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
}

function remoteItemList(view) {
  const flag = view === "todo" ? "in_todo" : view === "archive" ? "in_archive" : "in_inbox";
  return sortItems(remote.items
    .filter((item) => Boolean(item[flag]) && (view === "archive" || !item.in_archive)));
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
      const item = calendarItemForBlock(block);
      if (!item) return null;
      return {
        ...block,
        item_id: calendarItemId(block),
        object_name: item.object_name || "",
        subject: item.subject || "",
        in_inbox: Boolean(item.in_inbox),
        in_todo: Boolean(item.in_todo),
        in_archive: Boolean(item.in_archive),
        title: calendarItemTitle(item),
      };
    })
    .filter(Boolean)
    .filter((block) => !block.in_archive);
  const arranged = new Set(state.calendar.blocks.map((block) => normalizedRemoteId(calendarItemId(block))));
  state.calendar.availableItems = remote.items
    .filter((item) => (item.in_inbox || item.in_todo) && !arranged.has(normalizedRemoteId(item.id)))
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
      const item = remoteDoc(doc.data(), doc.id);
      publicSubmissionForItem(item);
      return item;
    });
    state.inboxItems = remoteItemList("inbox");
    state.todoItems = remoteItemList("todo");
    state.archiveItems = remoteItemList("archive");
    remoteRefreshCalendar();
    render();
    setConnection(true, "已同步");
  }, (error) => {
    setConnection(false, "同步中斷，稍後重試");
    showNotice(error.code === "permission-denied"
      ? `資料同步失敗：請使用 ${AUTHORIZED_EMAIL} 登入。`
      : `資料同步失敗：${error.message || "請稍後再試"}`, true);
  }));
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
          source_type: "external", is_pinned: false, in_inbox: true, in_todo: false, in_archive: false,
          note_revision: 0, created_at: submission.created_at || remoteNow(), updated_at: remoteNow(),
        };
        const itemRef = remoteCollection("items").doc(item.id);
        itemRef.get().then((existing) => existing.exists ? null : itemRef.set(item))
          .then(() => doc.ref.update({ imported_by: remote.user.uid, imported_at: remoteNow(), item_id: item.id }))
          .catch(() => {});
      });
    }, () => {}));
  remote.unsubscribers.push(remoteCollection("calendar_blocks").onSnapshot((snapshot) => {
    remote.blocks = snapshot.docs.map((doc) => remoteDoc(doc.data(), doc.id));
    remoteRefreshCalendar();
    render();
  }, () => setConnection(false, "同步中斷，稍後重試")));
  remote.unsubscribers.push(remoteCollection("documents").onSnapshot((snapshot) => {
    remote.documents = snapshot.docs.map((doc) => remoteDoc(doc.data(), doc.id));
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
        is_pinned: false,
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
      ...(Object.prototype.hasOwnProperty.call(body, "is_pinned")
        ? { is_pinned: Boolean(body.is_pinned) }
        : {}),
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
  if (parts[1] === "resources" && parts.length === 3 && method === "DELETE") {
    const ref = remoteCollection("documents").doc(parts[2]);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new Error("找不到正式文件");
    const documentData = remoteDoc(snapshot.data(), parts[2]);
    await ref.delete();
    return { document: documentData };
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
  const localPersistence = firebase.auth.Auth?.Persistence?.LOCAL;
  const persistenceReady = localPersistence
    ? remote.auth.setPersistence(localPersistence).catch(() => {})
    : Promise.resolve();
if (elements.authButton) elements.authButton.addEventListener("click", async () => {
    if (remote.user) {
      await remote.auth.signOut();
      return;
    }
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ login_hint: AUTHORIZED_EMAIL });
    try {
      await persistenceReady;
      await remote.auth.signInWithPopup(provider);
    } catch (error) {
      if (error.code === "auth/popup-blocked" || error.code === "auth/operation-not-supported-in-this-environment") {
        showNotice("手機瀏覽器擋住登入視窗，請允許彈出視窗後再按一次 n124登入。", true);
      } else if (error.code === "auth/popup-closed-by-user") {
        showNotice("登入視窗被瀏覽器擋住，請允許彈出視窗後再按一次登入。", true);
      } else showNotice(`登入失敗：${error.message}`, true);
    }
  });
  remote.auth.onAuthStateChanged((user) => {
    if (user && String(user.email || "").toLowerCase() !== AUTHORIZED_EMAIL) {
      void remote.auth.signOut();
      showNotice(`請使用 Google 帳號 ${AUTHORIZED_EMAIL} 登入。`, true);
      return;
    }
    remote.user = user;
    if (elements.authButton) {
      elements.authButton.hidden = Boolean(user);
      elements.authButton.textContent = "n124登入";
    }
    if (elements.syncState) elements.syncState.hidden = !user;
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

function deleteCountdownRemaining(pending) {
  if (!pending?.deleteAt) return 0;
  return Math.max(0, Math.ceil((pending.deleteAt - Date.now()) / 1000));
}

function clearDeleteCountdownTimers(pending) {
  if (!pending) return;
  if (pending.timer) window.clearTimeout(pending.timer);
  if (pending.uiTimer) window.clearInterval(pending.uiTimer);
  pending.timer = null;
  pending.uiTimer = null;
}

function applyDeleteButtonState(button, pending, {
  idleText,
  idleLabel,
  confirmText = "確定刪除？",
  confirmLabel,
  deletingLabel = "刪除中",
}) {
  if (!button) return;
  const confirming = pending?.phase === "confirm";
  const countingDown = pending?.phase === "countdown";
  const deleting = pending?.phase === "deleting";
  button.textContent = deleting
    ? "刪除中…"
    : countingDown
      ? `取消刪除（${deleteCountdownRemaining(pending)}）`
      : confirming ? confirmText : idleText;
  button.setAttribute("aria-label", deleting
    ? deletingLabel
    : countingDown
      ? `取消刪除（${deleteCountdownRemaining(pending)}）`
      : confirming ? (confirmLabel || idleLabel) : idleLabel);
  button.classList.toggle("is-confirming", Boolean(confirming || countingDown));
  button.disabled = deleting;
}

function reconcileDeleteCountdown(pending) {
  if (pending?.phase !== "countdown") return;
  if (Date.now() < pending.deleteAt) {
    pending.refresh?.();
    return;
  }
  pending.phase = "deleting";
  clearDeleteCountdownTimers(pending);
  pending.refresh?.();
  void pending.onExpire?.();
}

function startDeleteCountdown(pending, refresh, onExpire) {
  pending.deleteAt = Date.now() + DELETE_COUNTDOWN_SECONDS * 1000;
  pending.refresh = refresh;
  pending.onExpire = onExpire;
  pending.timer = window.setTimeout(() => reconcileDeleteCountdown(pending), DELETE_COUNTDOWN_SECONDS * 1000);
  pending.uiTimer = window.setInterval(() => reconcileDeleteCountdown(pending), 250);
  refresh();
}

function hasActiveDeleteOperation() {
  const isActive = (pending) => ["confirm", "countdown", "deleting"].includes(pending?.phase);
  return isActive(state.archiveDeleteConfirmation)
    || isActive(state.calendar.deleteConfirmation)
    || [...state.resources.deleteConfirmations.values()].some(isActive);
}

function flushDeferredRender() {
  if (!state.renderDeferred || hasActiveDeleteOperation()) return;
  state.renderDeferred = false;
  render({ force: true, preserveViewport: true });
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
  return [...state.inboxItems, ...state.todoItems, ...state.archiveItems]
    .find((item) => normalizedRemoteId(item.id) === normalizedRemoteId(itemId));
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
    if (state.calendar.deleteConfirmation
      && !state.calendar.blocks.some((block) => block.id === state.calendar.deleteConfirmation.blockId)) {
      cancelCalendarDeleteConfirmation();
    }
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

function render({ force = false, preserveViewport = false } = {}) {
  if (!force && hasActiveDeleteOperation()) {
    state.renderDeferred = true;
    return;
  }
  const previousScrollX = preserveViewport ? window.scrollX : 0;
  const previousScrollY = preserveViewport ? window.scrollY : 0;
  state.renderDeferred = false;
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
  const canChangeDisplayMode = isListView || state.view === "resources";
  elements.viewModeToggle.hidden = !canChangeDisplayMode;
  elements.main.classList.toggle("is-card-mode", canChangeDisplayMode && state.displayMode === "cards");
  for (const button of elements.viewModeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.viewMode === state.displayMode));
  }
  elements.manualEntry.hidden = state.view !== "inbox";
  elements.listSection.hidden = !isListView;
  elements.calendarPanel.hidden = state.view !== "calendar";
  elements.resourcesPanel.hidden = state.view !== "resources";
  updateDocumentTitle();
  if (isListView) renderList();
  if (state.view === "calendar") renderCalendar();
  if (state.view === "resources") renderResources();
  if (preserveViewport) {
    requestAnimationFrame(() => window.scrollTo(previousScrollX, previousScrollY));
  }
}

function renderList() {
  elements.listHeading.textContent = state.view === "inbox" ? "暫存區" : state.view === "todo" ? "待辦" : "封存區";
  elements.itemList.replaceChildren();
  const items = sortItems(activeItems());
  elements.emptyState.hidden = items.length !== 0;
  if (state.view === "archive") {
    const visibleIds = new Set(items.map((item) => item.id));
    state.archiveSelectedIds = new Set([...state.archiveSelectedIds].filter((id) => visibleIds.has(id)));
    if (state.archiveDeleteConfirmation
      && state.archiveDeleteConfirmation.ids.some((id) => !visibleIds.has(id))) {
      cancelArchiveDeleteConfirmation();
    }
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
      cancelArchiveDeleteConfirmation();
      state.archiveSelectedIds = new Set(items.map((item) => item.id));
      renderList();
    });
    const clearSelection = document.createElement("button");
    clearSelection.type = "button";
    clearSelection.className = "archive-selection-button";
    clearSelection.textContent = "清除選取";
    clearSelection.disabled = state.archiveSelectedIds.size === 0;
    clearSelection.addEventListener("click", () => {
      cancelArchiveDeleteConfirmation();
      state.archiveSelectedIds.clear();
      renderList();
    });
    const button = document.createElement("button");
    button.type = "button";
    button.className = "danger-button";
    button.id = "archiveDeleteButton";
    const pendingDelete = state.archiveDeleteConfirmation
      && state.archiveDeleteConfirmation.ids.join("\u0000") === [...state.archiveSelectedIds].join("\u0000")
      ? state.archiveDeleteConfirmation
      : null;
    applyDeleteButtonState(button, pendingDelete, {
      idleText: "批次刪除",
      idleLabel: "批次刪除",
      confirmText: "確定刪除？",
      confirmLabel: "確定刪除",
      deletingLabel: "刪除中",
    });
    button.disabled = state.archiveSelectedIds.size === 0 || button.disabled;
    button.addEventListener("click", () => void deleteSelectedArchiveItems());
    actions.append(count, selectAll, clearSelection, button);
    elements.listSection.append(actions);
  }
}

function createItemRow(item) {
  const row = document.createElement("li");
  row.className = "item-row";
  row.classList.toggle("is-external", item.source_type === "external");
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
      cancelArchiveDeleteConfirmation();
      if (checkbox.checked) state.archiveSelectedIds.add(item.id);
      else state.archiveSelectedIds.delete(item.id);
      renderList();
    });
    titleRow.append(checkbox);
  }
  const title = document.createElement("button");
  title.type = "button";
  title.className = "item-title";
  const titleText = document.createElement("span");
  titleText.className = "item-title-text";
  const fullTitle = itemDisplayTitle(item);
  titleText.textContent = compactDesktopTitle(fullTitle);
  title.title = fullTitle;
  title.setAttribute("aria-label", fullTitle);
  title.append(titleText);
  if (item.is_pinned) {
    const pinned = document.createElement("span");
    pinned.className = "item-pinned-dot";
    pinned.textContent = "●";
    pinned.title = "已釘選，會固定在清單上方";
    title.prepend(pinned);
  }
  const createdDate = formatCreatedShortDate(item.created_at);
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
  if (createdDate) {
    const created = document.createElement("span");
    created.className = "item-created-date";
    created.textContent = createdDate;
    titleRow.append(created);
  }
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
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "item-pin-button";
    pin.textContent = item.is_pinned ? "取消釘選" : "釘選";
    pin.setAttribute("aria-label", item.is_pinned ? `取消釘選 ${itemDisplayTitle(item)}` : `釘選 ${itemDisplayTitle(item)}`);
    pin.addEventListener("click", (event) => {
      event.stopPropagation();
      void togglePinnedItem(item);
    });
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "item-inline-edit";
    edit.textContent = "編輯";
    edit.addEventListener("click", () => {
      state.editingId = item.id;
      render();
    });
    titleRow.append(pin, edit);
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
  const replace = (items) => sortItems(items.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
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
      const currentItem = itemById(item.id) || item;
      if (!details.querySelector(".official-editor")) {
        details.append(createOfficialEditor(currentItem));
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

function createOfficialEditor(item) {
  const editor = document.createElement("section");
  editor.className = "official-editor";
  const heading = document.createElement("h3");
  heading.textContent = "升級：整理正式文件";
  const form = document.createElement("form");
  form.className = "official-form";
  const name = formField("文件名稱", "input", item.object_name || "", 200);
  name.control.required = true;
  const sourceContent = String(item.subject || item.original_message || "").trim();
  const formal = formField("正式內容", "textarea", sourceContent, 100000);
  formal.control.required = true;
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
  form.append(name.wrapper, formal.wrapper, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await api(`/api/items/${item.id}/document`, {
        method: "POST",
        body: JSON.stringify({
          document_name: name.control.value.trim(),
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
    if (labelText === "內容" || labelText === "正式內容") {
      control.classList.add("auto-grow-content");
      control.addEventListener("input", () => autoGrowContentTextarea(control));
      requestAnimationFrame(() => autoGrowContentTextarea(control));
    }
  }
  wrapper.append(label, control);
  return { wrapper, control };
}

function autoGrowContentTextarea(textarea) {
  const previousScrollTop = textarea.scrollTop;
  const wasAtBottom = textarea.scrollTop + textarea.clientHeight >= textarea.scrollHeight - 4;
  textarea.style.height = "auto";
  const isResourceContent = Boolean(textarea.closest(".resource-edit-form"));
  const maxHeight = isResourceContent
    ? Number.POSITIVE_INFINITY
    : Math.max(240, Math.min(560, Math.floor(window.innerHeight * 0.6)));
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, 84), maxHeight);
  textarea.style.height = `${nextHeight}px`;
  if (wasAtBottom) textarea.scrollTop = textarea.scrollHeight;
  else textarea.scrollTop = previousScrollTop;
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
  const pending = state.archiveDeleteConfirmation;
  const sameSelection = pending && pending.ids.join("\u0000") === itemIds.join("\u0000");
  if (!sameSelection) {
    state.archiveDeleteConfirmation = { ids: itemIds, phase: "confirm", timer: null, uiTimer: null };
    showNotice(`請再按一次「確定刪除？」確認刪除 ${itemIds.length} 筆封存資料。`);
    refreshArchiveDeleteButton(state.archiveDeleteConfirmation);
    return;
  }
  if (pending.phase === "confirm") {
    startArchiveDeleteCountdown(itemIds);
    return;
  }
  if (pending.phase === "countdown") {
    cancelArchiveDeleteConfirmation(true);
    return;
  }
  return;
}

function refreshArchiveDeleteButton(pending = state.archiveDeleteConfirmation) {
  const button = document.querySelector("#archiveDeleteButton");
  const selectedIds = [...state.archiveSelectedIds];
  const currentPending = pending && pending.ids.join("\u0000") === selectedIds.join("\u0000")
    ? pending
    : null;
  applyDeleteButtonState(button, currentPending, {
    idleText: "批次刪除",
    idleLabel: "批次刪除",
    confirmText: "確定刪除？",
    confirmLabel: "確定刪除",
    deletingLabel: "刪除中",
  });
  if (button) button.disabled = selectedIds.length === 0 || button.disabled;
}

function startArchiveDeleteCountdown(itemIds) {
  cancelArchiveDeleteConfirmation();
  const pending = { ids: [...itemIds], phase: "countdown", timer: null, uiTimer: null };
  state.archiveDeleteConfirmation = pending;
  showNotice(`刪除倒數 ${DELETE_COUNTDOWN_SECONDS} 秒；期間再按同一按鈕可取消。`);
  startDeleteCountdown(
    pending,
    () => refreshArchiveDeleteButton(pending),
    () => performArchiveDeletion(pending),
  );
}

function cancelArchiveDeleteConfirmation(showMessage = false) {
  const pending = state.archiveDeleteConfirmation;
  clearDeleteCountdownTimers(pending);
  state.archiveDeleteConfirmation = null;
  if (showMessage) {
    showNotice("已取消刪除，資料保留。");
    refreshArchiveDeleteButton(null);
    flushDeferredRender();
  }
}

async function performArchiveDeletion(pending) {
  const itemIds = pending.ids;
  clearDeleteCountdownTimers(pending);
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
    state.archiveDeleteConfirmation = null;
    showNotice(`已刪除 ${deletedIds.length} 筆封存資料`);
    render();
    await loadItems({ keepExpanded: false });
  } catch (error) {
    state.archiveDeleteConfirmation = null;
    showNotice(`批次刪除失敗：${error.message}`, true);
    renderList();
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
  return blocks.find((block) => normalizedRemoteId(calendarItemId(block)) === normalizedRemoteId(itemId)
    && block.start_date && block.end_date) || null;
}

async function togglePinnedItem(item) {
  const pinned = !Boolean(item.is_pinned);
  try {
    const data = await api(`/api/items/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        object_name: item.object_name || "",
        subject: item.subject || "",
        contact_name: item.contact_name || "",
        phone: item.phone || "",
        original_message: item.original_message || "",
        resource_location: item.resource_location || "",
        is_pinned: pinned,
      }),
    });
    replaceItem(data.item);
    showNotice(pinned ? "已釘選，事項移到最上方" : "已取消釘選");
    render();
  } catch (error) {
    showNotice(`釘選失敗：${error.message}`, true);
  }
}

function formatCalendarShortDate(value) {
  const match = String(value || "").match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}/${match[2]}` : String(value || "");
}

function formatCreatedShortDate(value) {
  const match = String(value || "").match(/^\d{4}-(\d{2})-(\d{2})/);
  return match ? `${match[1]}/${match[2]}` : "";
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
  const pending = state.calendar.deleteConfirmation;
  const sameBlock = pending && pending.blockId === block.id;
  if (!sameBlock) {
    state.calendar.deleteConfirmation = { blockId: block.id, phase: "confirm", timer: null, uiTimer: null };
    showNotice(`請再按一次「確定刪除？」刪除「${calendarBlockTitle(block)}」。`);
    refreshCalendarDeleteButton(state.calendar.deleteConfirmation);
    return;
  }
  if (pending.phase === "confirm") {
    startCalendarDeleteCountdown(block);
    return;
  }
  if (pending.phase === "countdown") {
    cancelCalendarDeleteConfirmation(true);
    return;
  }
  return;
}

function refreshCalendarDeleteButton(pending = state.calendar.deleteConfirmation) {
  applyDeleteButtonState(elements.calendarDeleteBlock, pending, {
    idleText: "刪除",
    idleLabel: "刪除行事曆安排",
    confirmText: "確定刪除？",
    confirmLabel: "確定刪除行事曆安排",
    deletingLabel: "刪除中",
  });
}

function startCalendarDeleteCountdown(block) {
  cancelCalendarDeleteConfirmation();
  const pending = { blockId: block.id, phase: "countdown", timer: null, uiTimer: null };
  state.calendar.deleteConfirmation = pending;
  showNotice(`刪除倒數 ${DELETE_COUNTDOWN_SECONDS} 秒；期間再按同一按鈕可取消。`);
  startDeleteCountdown(
    pending,
    () => {
      if (state.calendar.deleteConfirmation === pending) refreshCalendarDeleteButton(pending);
    },
    () => performCalendarDeletion(block, pending),
  );
}

function cancelCalendarDeleteConfirmation(showMessage = false) {
  const pending = state.calendar.deleteConfirmation;
  clearDeleteCountdownTimers(pending);
  state.calendar.deleteConfirmation = null;
  if (showMessage) {
    showNotice("已取消刪除，資料保留。");
    refreshCalendarDeleteButton(null);
    flushDeferredRender();
  }
}

function cancelAllDeleteConfirmations() {
  cancelArchiveDeleteConfirmation();
  for (const documentId of state.resources.deleteConfirmations.keys()) {
    cancelResourceDeleteConfirmation(documentId);
  }
  cancelCalendarDeleteConfirmation();
}

async function performCalendarDeletion(block, pending) {
  clearDeleteCountdownTimers(pending);
  try {
    await api(`/api/calendar/blocks/${block.id}`, { method: "DELETE" });
    state.calendar.deleteConfirmation = null;
    state.calendar.selectedBlockId = null;
    showNotice("已刪除行事曆安排");
    await loadCalendar();
  } catch (error) {
    state.calendar.deleteConfirmation = null;
    showNotice(`刪除行事曆安排失敗：${error.message}`, true);
    renderCalendar();
  }
}

function openSelectedCalendarItem() {
  const block = state.calendar.blocks.find((candidate) => candidate.id === state.calendar.selectedBlockId);
  if (!block) return;
  const itemId = calendarItemId(block);
  const item = calendarItemForBlock(block)
    || itemById(itemId)
    || state.calendar.availableItems.find((candidate) => normalizedRemoteId(candidate.id) === normalizedRemoteId(itemId));
  if (!item) {
    showNotice("找不到原本的事項", true);
    return;
  }
  cancelCalendarDeleteConfirmation();
  state.view = item.in_archive ? "archive" : item.in_todo ? "todo" : "inbox";
  state.expandedIds.clear();
  state.expandedIds.add(item.id);
  state.calendar.selectedItemId = null;
  state.calendar.selectedBlockId = null;
  state.calendar.drag = null;
  if (state.view !== "archive") state.archiveSelectedIds.clear();
  render();
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
  state.inboxItems = sortItems([item, ...state.inboxItems.filter((candidate) => candidate.id !== item.id)]);
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
  cancelCalendarDeleteConfirmation();
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
  elements.calendarSelectionText.replaceChildren();
  if (preview) {
    const previewText = document.createElement("span");
    previewText.className = "calendar-selection-date";
    previewText.textContent = `預覽：${preview.start_date}～${preview.end_date}`;
    elements.calendarSelectionText.append(previewText);
  } else if (selectedBlock) {
    const prefix = document.createElement("span");
    prefix.textContent = "已選取：";
    const title = document.createElement("strong");
    title.className = "calendar-selection-title";
    title.textContent = calendarBlockTitle(selectedBlock);
    const dates = document.createElement("span");
    dates.className = "calendar-selection-date";
    dates.textContent = `${selectedBlock.start_date}～${selectedBlock.end_date}`;
    elements.calendarSelectionText.append(prefix, title, dates);
  } else if (selectedTitle) {
    const pending = document.createElement("span");
    pending.className = "calendar-selection-title";
    pending.textContent = `準備安排：${selectedTitle}`;
    elements.calendarSelectionText.append(pending);
  }
  elements.calendarOpenItem.hidden = !selectedBlock || Boolean(state.calendar.drag);
  elements.calendarDeleteBlock.hidden = !selectedBlock || Boolean(state.calendar.drag);
  const pendingDelete = selectedBlock && state.calendar.deleteConfirmation?.blockId === selectedBlock.id
    ? state.calendar.deleteConfirmation
    : null;
  refreshCalendarDeleteButton(pendingDelete);
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
  const source = String(block.id || normalizedRemoteId(calendarItemId(block)) || block.title || "");
  let hash = 0;
  for (const character of source) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 8;
}

function calendarBlockTitle(block) {
  const itemId = calendarItemId(block);
  const item = calendarItemForBlock(block)
    || itemById(itemId)
    || state.calendar.availableItems.find((candidate) => normalizedRemoteId(candidate.id) === normalizedRemoteId(itemId));
  const blockFields = [block.object_name, block.subject, block.item_name, block.name, block.label]
    .map((value) => String(value || "").trim()).filter(Boolean);
  return block.title
    || (item ? calendarItemTitle(item) : blockFields.join("｜") || "未命名");
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
  bar.dataset.itemId = normalizedRemoteId(calendarItemId(block));
  bar.style.left = `${(startOffset / 7) * 100}%`;
  bar.style.width = `${(dayCount / 7) * 100}%`;
  const lane = calendarLane(row, block);
  bar.dataset.lane = String(lane);
  bar.style.top = `${22 + lane * 16}px`;
  const label = document.createElement("span");
  label.className = "calendar-block-label";
  const title = calendarBlockTitle(block);
  label.textContent = title;
  bar.setAttribute("aria-label", `${title}，${block.start_date}～${block.end_date}`);
  bar.append(label);
  if (!preview) {
    bar.addEventListener("pointerdown", (event) => beginCalendarBlock(event, block));
    bar.addEventListener("click", () => {
      if (state.calendar.deleteConfirmation?.blockId !== block.id) cancelCalendarDeleteConfirmation();
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
    || state.calendar.availableItems.find((candidate) => String(candidate.id) === String(state.calendar.selectedItemId));
  if (item) return calendarItemTitle(item);
  const block = state.calendar.blocks.find((candidate) => normalizedRemoteId(calendarItemId(candidate)) === normalizedRemoteId(state.calendar.selectedItemId));
  return block ? calendarBlockTitle(block) : "";
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
    if (state.calendar.deleteConfirmation?.blockId !== block.id) cancelCalendarDeleteConfirmation();
    state.calendar.selectedBlockId = block.id;
    state.calendar.selectedItemId = null;
    state.calendar.drag = null;
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (state.calendar.deleteConfirmation?.blockId !== block.id) cancelCalendarDeleteConfirmation();
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
    const meta = document.createElement("div");
    meta.className = "resource-card-meta";
    meta.textContent = documentData.document_date
      ? `正式文件 · ${documentData.document_date}`
      : "正式文件";
    row.append(title, meta);
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
  dateText.textContent = `建立日期：${documentData.document_date}`;
  const form = document.createElement("form");
  form.className = "resource-edit-form";
  const name = formField("文件名稱", "input", documentData.document_name, 200);
  const formal = formField("正式內容", "textarea", documentData.formal_content, 100000);
  const actions = document.createElement("div");
  actions.className = "form-actions";
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "danger-button";
  deleteButton.dataset.resourceDeleteId = String(documentData.id);
  const pendingDelete = state.resources.deleteConfirmations.get(String(documentData.id)) || null;
  applyDeleteButtonState(deleteButton, pendingDelete, {
    idleText: "刪除",
    idleLabel: "刪除正式文件",
    confirmText: "確定刪除？",
    confirmLabel: "確定刪除正式文件",
    deletingLabel: "刪除中",
  });
  deleteButton.addEventListener("click", () => void deleteResource(documentData));
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary-button";
  save.textContent = "保存修改";
  actions.append(deleteButton, save);
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
  details.append(dateText, form);
  return details;
}

async function deleteResource(documentData) {
  const documentId = String(documentData.id || "");
  if (!documentId) return;
  const pending = state.resources.deleteConfirmations.get(documentId);
  if (!pending) {
    const nextPending = { phase: "confirm", timer: null, uiTimer: null };
    state.resources.deleteConfirmations.set(documentId, nextPending);
    showNotice("請再按一次「確定刪除？」確認刪除正式文件。");
    refreshResourceDeleteButton(documentId, nextPending);
    return;
  }
  if (pending.phase === "confirm") {
    startResourceDeleteCountdown(documentData);
    return;
  }
  if (pending.phase === "countdown") {
    cancelResourceDeleteConfirmation(documentId, true);
  }
}

function refreshResourceDeleteButton(documentId, pending = state.resources.deleteConfirmations.get(String(documentId)) || null) {
  const button = document.querySelector(
    `button[data-resource-delete-id="${CSS.escape(String(documentId))}"]`,
  );
  applyDeleteButtonState(button, pending, {
    idleText: "刪除",
    idleLabel: "刪除正式文件",
    confirmText: "確定刪除？",
    confirmLabel: "確定刪除正式文件",
    deletingLabel: "刪除中",
  });
}

function startResourceDeleteCountdown(documentData) {
  const documentId = String(documentData.id || "");
  if (!documentId) return;
  cancelResourceDeleteConfirmation(documentId);
  const pending = { phase: "countdown", timer: null, uiTimer: null };
  state.resources.deleteConfirmations.set(documentId, pending);
  showNotice(`刪除倒數 ${DELETE_COUNTDOWN_SECONDS} 秒；期間再按同一按鈕可取消。`);
  startDeleteCountdown(
    pending,
    () => refreshResourceDeleteButton(documentId, pending),
    () => performResourceDeletion(documentData, pending),
  );
}

function cancelResourceDeleteConfirmation(documentId, showMessage = false) {
  const pending = state.resources.deleteConfirmations.get(String(documentId));
  clearDeleteCountdownTimers(pending);
  state.resources.deleteConfirmations.delete(String(documentId));
  if (showMessage) {
    showNotice("已取消刪除，資料保留。");
    refreshResourceDeleteButton(documentId, null);
    flushDeferredRender();
  }
}

async function performResourceDeletion(documentData, pending) {
  const documentId = String(documentData.id || "");
  clearDeleteCountdownTimers(pending);
  try {
    await api(`/api/resources/${documentId}`, { method: "DELETE" });
    state.resources.deleteConfirmations.delete(documentId);
    state.resources.details.delete(documentId);
    if (state.resources.expandedId === documentId) state.resources.expandedId = null;
    showNotice("已刪除正式文件");
    await loadResources();
  } catch (error) {
    state.resources.deleteConfirmations.delete(documentId);
    showNotice(`刪除正式文件失敗：${error.message}`, true);
    renderResources();
  }
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
elements.calendarOpenItem.addEventListener("click", () => openSelectedCalendarItem());
elements.calendarDeleteBlock.addEventListener("click", () => void deleteSelectedCalendarBlock());

function closeCalendarSelection() {
  if (state.view !== "calendar" || state.calendar.drag) return;
  if (!state.calendar.selectedItemId && !state.calendar.selectedBlockId) return;
  cancelCalendarDeleteConfirmation();
  state.calendar.selectedItemId = null;
  state.calendar.selectedBlockId = null;
  renderCalendar();
}

document.addEventListener("click", (event) => {
  if (state.view !== "calendar" || elements.calendarSelection.hidden) return;
  if (event.target.closest("#calendarSelection, .calendar-block, .calendar-day")) return;
  closeCalendarSelection();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeCalendarSelection();
});

for (const button of elements.viewModeButtons) {
  button.addEventListener("click", () => {
    const mode = button.dataset.viewMode === "cards" ? "cards" : "list";
    if (state.displayMode === mode) return;
    state.displayMode = mode;
    saveDisplayMode(mode);
    render({ preserveViewport: true });
  });
}

elements.resourceSearch.addEventListener("input", () => {
  state.resources.query = elements.resourceSearch.value;
  clearTimeout(elements.resourceSearch.searchTimer);
  elements.resourceSearch.searchTimer = setTimeout(() => void loadResources(), 250);
});

for (const tab of elements.tabs) {
  tab.addEventListener("click", () => {
    cancelAllDeleteConfirmations();
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
  if (document.visibilityState === "visible") {
    reconcileDeleteCountdown(state.archiveDeleteConfirmation);
    reconcileDeleteCountdown(state.calendar.deleteConfirmation);
    for (const pending of state.resources.deleteConfirmations.values()) {
      reconcileDeleteCountdown(pending);
    }
    return;
  }
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

"use strict";

(() => {
  const COMPANY_GMAIL = "han@jenfu.com.tw";
  const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
  const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
  const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
  const INTERACTIVE_TIMEOUT_MS = 20000;

  const elements = {
    openButton: document.querySelector("#gmailOpenButton"),
    enableButton: document.querySelector("#gmailReminderButton"),
    panel: document.querySelector("#gmailPanel"),
    panelClose: document.querySelector("#gmailPanelClose"),
    panelStatus: document.querySelector("#gmailPanelStatus"),
    panelUnread: document.querySelector("#gmailPanelUnread"),
    panelRefresh: document.querySelector("#gmailPanelRefresh"),
    panelList: document.querySelector("#gmailPanelList"),
    panelEmpty: document.querySelector("#gmailPanelEmpty"),
    panelError: document.querySelector("#gmailPanelError"),
    panelMessage: document.querySelector("#gmailPanelMessage"),
    panelBack: document.querySelector("#gmailPanelBack"),
    panelMessageSubject: document.querySelector("#gmailPanelMessageSubject"),
    panelMessageFrom: document.querySelector("#gmailPanelMessageFrom"),
    panelMessageDate: document.querySelector("#gmailPanelMessageDate"),
    panelMessageBody: document.querySelector("#gmailPanelMessageBody"),
  };

  if (!elements.openButton && !elements.panel && !elements.enableButton) return;
  elements.enableButton?.setAttribute("aria-label", "更新 Gmail 近 5 日未讀數");

  let accessToken = "";
  let tokenExpiresAt = 0;
  let tokenClient = null;
  let activeRequest = null;
  let lastCheckedAt = 0;
  let panelMessages = [];
  let panelLoading = false;

  function waitForGoogleIdentity() {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = () => {
        if (window.google?.accounts?.oauth2) {
          resolve();
          return;
        }
        if (Date.now() - startedAt >= 8000) {
          reject(new Error("Google 連接元件尚未載入"));
          return;
        }
        window.setTimeout(check, 100);
      };
      check();
    });
  }

  function setUnreadCount(count) {
    const safeCount = Math.max(0, Number(count) || 0);
    if (!elements.enableButton) return;
    elements.enableButton.classList.toggle("is-count", safeCount > 0);
    elements.enableButton.classList.toggle("is-zero", safeCount === 0);
    elements.enableButton.textContent = String(safeCount);
    elements.enableButton.hidden = false;
    elements.enableButton.disabled = false;
    elements.enableButton.removeAttribute("aria-busy");
    elements.enableButton.setAttribute("aria-label", `近 5 天未讀信件 ${safeCount} 封`);
    elements.enableButton.title = `近 5 天未讀信件 ${safeCount} 封`;
  }

  function showEnableButton(show) {
    if (!elements.enableButton) return;
    elements.enableButton.hidden = !show;
    elements.enableButton.disabled = false;
    elements.enableButton.removeAttribute("aria-busy");
    if (show) {
      elements.enableButton.classList.remove("is-count");
      elements.enableButton.classList.remove("is-zero");
      elements.enableButton.textContent = "更新";
      elements.enableButton.removeAttribute("title");
    }
  }

  function withTimeout(promise, timeoutMs, message) {
    let timer = 0;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]).finally(() => window.clearTimeout(timer));
  }

  async function createTokenClient() {
    await waitForGoogleIdentity();
    const clientId = document.querySelector('meta[name="google-oauth-client-id"]')?.content || "";
    if (!clientId) throw new Error("Google 連接設定尚未完成");
    if (tokenClient) return tokenClient;
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GMAIL_SCOPE,
      callback: () => {},
      error_callback: () => {},
    });
    return tokenClient;
  }

  async function connectViaFirebase() {
    if (!globalThis.firebase?.auth) throw new Error("Google 登入元件尚未載入，請重新整理頁面");
    const primaryApp = firebase.app();
    const appName = "gmail-readonly";
    const gmailApp = firebase.apps.find((app) => app.name === appName)
      || firebase.initializeApp(primaryApp.options, appName);
    const gmailAuth = gmailApp.auth();
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.addScope(GMAIL_SCOPE);
    provider.setCustomParameters({ login_hint: COMPANY_GMAIL });
    try {
      const result = await gmailAuth.signInWithPopup(provider);
      const credential = firebase.auth.GoogleAuthProvider.credentialFromResult(result);
      if (!credential?.accessToken) throw new Error("Google 尚未提供 Gmail 讀取授權");
      accessToken = credential.accessToken;
      tokenExpiresAt = Date.now() + 55 * 60 * 1000;
    } catch (error) {
      if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error?.code)) {
        throw new Error("手機瀏覽器擋住 Gmail 授權視窗，請允許彈出視窗後再試一次");
      }
      throw error;
    } finally {
      await gmailAuth.signOut().catch(() => {});
    }
    return accessToken;
  }

  async function requestToken(interactive) {
    if (!window.google?.accounts?.oauth2) {
      try {
        await waitForGoogleIdentity();
      } catch (error) {
        if (interactive) return connectViaFirebase();
        throw error;
      }
    }
    const client = await createTokenClient();
    return new Promise((resolve, reject) => {
      client.callback = (response) => {
        if (response?.access_token && !response.error) {
          accessToken = response.access_token;
          tokenExpiresAt = Date.now() + Math.max(30, Number(response.expires_in) || 3600) * 1000;
          resolve(accessToken);
          return;
        }
        reject(new Error(response?.error_description || response?.error || "Google 授權尚未完成"));
      };
      client.error_callback = (error) => {
        if (interactive && error?.type === "popup_failed_to_open") {
          void connectViaFirebase().then(resolve, reject);
          return;
        }
        reject(new Error(error?.type === "popup_failed_to_open"
          ? "瀏覽器擋住授權視窗，請允許彈出視窗後重試"
          : "Google 授權尚未完成"));
      };
      client.requestAccessToken({
        prompt: interactive ? "consent" : "none",
        login_hint: COMPANY_GMAIL,
      });
    });
  }

  async function gmailRequest(path, retried = false) {
    if (!accessToken || tokenExpiresAt <= Date.now() + 5000) await requestToken(false);
    const response = await fetch(`${GMAIL_API_BASE}${path}`, {
      cache: "no-store",
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 401 && !retried) {
      accessToken = "";
      tokenExpiresAt = 0;
      await requestToken(false);
      return gmailRequest(path, true);
    }
    if (!response.ok) throw new Error(`Gmail 讀取失敗（${response.status}）`);
    return response.json();
  }

  async function verifyCompanyAccount() {
    const profile = await gmailRequest("/profile");
    const email = String(profile?.emailAddress || "").toLowerCase();
    if (email !== COMPANY_GMAIL) {
      if (accessToken && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(accessToken, () => {});
      accessToken = "";
      tokenExpiresAt = 0;
      throw new Error(`請選擇公司帳號 ${COMPANY_GMAIL}`);
    }
  }

  async function ensureGmailAccess(interactive) {
    if (accessToken && tokenExpiresAt > Date.now() + 5000) return;
    try {
      await requestToken(false);
    } catch (error) {
      if (!interactive) throw error;
      await withTimeout(
        requestToken(true),
        INTERACTIVE_TIMEOUT_MS,
        "授權視窗沒有完成，請允許 Google 視窗後再試一次",
      );
    }
  }

  function setPanelStatus(message, isError = false) {
    if (!elements.panelStatus) return;
    elements.panelStatus.textContent = message;
    elements.panelStatus.classList.toggle("is-error", isError);
  }

  function setPanelError(message = "") {
    if (!elements.panelError) return;
    elements.panelError.textContent = message;
    elements.panelError.hidden = !message;
  }

  function decodeBase64Url(value) {
    if (!value) return "";
    try {
      const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return "";
    }
  }

  function messageHeader(message, name) {
    const header = (message?.payload?.headers || []).find((item) => String(item.name || "").toLowerCase() === name.toLowerCase());
    return String(header?.value || "").trim();
  }

  function messageBodyData(payload) {
    let htmlFallback = "";
    function visit(part) {
      if (!part) return "";
      const mimeType = String(part.mimeType || "").toLowerCase();
      if (mimeType === "text/plain" && part.body?.data) return part.body.data;
      if (mimeType === "text/html" && part.body?.data && !htmlFallback) htmlFallback = part.body.data;
      for (const child of part.parts || []) {
        const result = visit(child);
        if (result) return result;
      }
      return "";
    }
    const plain = visit(payload);
    return plain || htmlFallback;
  }

  function messageBodyText(message) {
    const bodyData = messageBodyData(message?.payload);
    const decoded = decodeBase64Url(bodyData);
    if (!decoded) return String(message?.snippet || "").trim();
    if (String(message?.payload?.mimeType || "").toLowerCase() === "text/html") {
      const parsed = new DOMParser().parseFromString(decoded, "text/html");
      return String(parsed.body?.textContent || "").trim();
    }
    return decoded.trim();
  }

  function formatPanelDate(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return String(value || "");
    return new Intl.DateTimeFormat("zh-TW", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function panelMessageSummary(message) {
    return {
      id: String(message?.id || ""),
      subject: messageHeader(message, "Subject") || "（無主旨）",
      from: messageHeader(message, "From") || "未知寄件者",
      date: messageHeader(message, "Date"),
      snippet: String(message?.snippet || "").trim(),
    };
  }

  function showPanelList() {
    elements.panelList.hidden = false;
    elements.panelMessage.hidden = true;
    elements.panelEmpty.hidden = panelMessages.length !== 0;
  }

  function renderPanelMessages() {
    elements.panelList.replaceChildren();
    showPanelList();
    for (const message of panelMessages) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gmail-panel-row";
      const subject = document.createElement("strong");
      subject.textContent = message.subject;
      const from = document.createElement("span");
      from.textContent = message.from;
      const date = document.createElement("span");
      date.textContent = formatPanelDate(message.date);
      const snippet = document.createElement("small");
      snippet.textContent = message.snippet || "點選查看內容";
      button.append(subject, from, date, snippet);
      button.addEventListener("click", () => void openPanelMessage(message));
      elements.panelList.append(button);
    }
  }

  async function openPanelMessage(message) {
    elements.panelList.hidden = true;
    elements.panelEmpty.hidden = true;
    elements.panelError.hidden = true;
    elements.panelMessage.hidden = false;
    elements.panelMessageSubject.textContent = message.subject;
    elements.panelMessageFrom.textContent = message.from;
    elements.panelMessageDate.textContent = formatPanelDate(message.date);
    elements.panelMessageBody.textContent = message.snippet || "讀取信件內容中…";
    setPanelStatus("讀取信件內容中…");
    try {
      const detail = await gmailRequest(`/messages/${encodeURIComponent(message.id)}?format=full`);
      elements.panelMessageSubject.textContent = messageHeader(detail, "Subject") || message.subject;
      elements.panelMessageFrom.textContent = messageHeader(detail, "From") || message.from;
      elements.panelMessageDate.textContent = formatPanelDate(messageHeader(detail, "Date") || message.date);
      elements.panelMessageBody.textContent = messageBodyText(detail) || "這封信沒有可顯示的文字內容。";
      setPanelStatus("已讀取信件");
    } catch (error) {
      setPanelStatus("信件內容讀取失敗", true);
      setPanelError(error?.message || "請稍後再試");
    }
  }

  async function loadPanelMessages({ interactive = false } = {}) {
    if (!elements.panel || panelLoading) return;
    panelLoading = true;
    elements.panelRefresh.disabled = true;
    elements.panelList.hidden = false;
    elements.panelMessage.hidden = true;
    elements.panelEmpty.hidden = true;
    setPanelError();
    setPanelStatus("讀取近 5 日未讀信件…");
    elements.panelList.replaceChildren();
    try {
      await ensureGmailAccess(interactive);
      await verifyCompanyAccount();
      const params = new URLSearchParams({
        maxResults: "20",
        includeSpamTrash: "false",
        q: "is:unread newer_than:5d",
      });
      const [unreadCount, list] = await Promise.all([
        countUnreadMessages(),
        gmailRequest(`/messages?${params.toString()}`),
      ]);
      setUnreadCount(unreadCount);
      elements.panelUnread.textContent = `近 5 日未讀：${unreadCount} 封`;
      const summaries = (list?.messages || []).map(panelMessageSummary);
      panelMessages = await Promise.all(summaries.map(async (summary) => {
        try {
          const detailParams = new URLSearchParams({
            format: "metadata",
            metadataHeaders: "From",
          });
          detailParams.append("metadataHeaders", "Subject");
          detailParams.append("metadataHeaders", "Date");
          const detail = await gmailRequest(`/messages/${encodeURIComponent(summary.id)}?${detailParams.toString()}`);
          return { ...summary, ...panelMessageSummary(detail) };
        } catch {
          return summary;
        }
      }));
      renderPanelMessages();
      setPanelStatus(panelMessages.length ? `顯示 ${panelMessages.length} 封未讀信件` : "近 5 日沒有未讀信件");
    } catch (error) {
      panelMessages = [];
      elements.panelList.replaceChildren();
      elements.panelEmpty.hidden = true;
      setPanelStatus("Gmail 讀取失敗", true);
      setPanelError(error?.message || "請重新按更新");
    } finally {
      panelLoading = false;
      elements.panelRefresh.disabled = false;
    }
  }

  function closeGmailPanel() {
    elements.panel.hidden = true;
    elements.openButton?.setAttribute("aria-expanded", "false");
  }

  function openGmailPanel() {
    elements.panel.hidden = false;
    elements.openButton?.setAttribute("aria-expanded", "true");
    void loadPanelMessages({ interactive: true });
  }

  async function countUnreadMessages() {
    let pageToken = "";
    let count = 0;
    do {
      const params = new URLSearchParams({
        maxResults: "100",
        includeSpamTrash: "false",
        q: "is:unread newer_than:5d",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const result = await gmailRequest(`/messages?${params.toString()}`);
      count += Array.isArray(result?.messages) ? result.messages.length : 0;
      pageToken = String(result?.nextPageToken || "");
      if (count >= 10000) return count;
    } while (pageToken);
    return count;
  }

  async function refreshUnreadCount({ interactive = false } = {}) {
    if (activeRequest && (!interactive || activeRequest.interactive)) return;
    const request = { interactive };
    activeRequest = request;
    if (interactive && elements.enableButton) {
      elements.enableButton.disabled = true;
      elements.enableButton.setAttribute("aria-busy", "true");
      elements.enableButton.textContent = "讀取中…";
      elements.enableButton.title = "正在讀取近 5 天未讀信件";
    }
    try {
      await ensureGmailAccess(interactive);
      await verifyCompanyAccount();
      const unreadCount = await countUnreadMessages();
      if (activeRequest !== request) return;
      setUnreadCount(unreadCount);
      lastCheckedAt = Date.now();
    } catch (error) {
      if (activeRequest !== request) return;
      showEnableButton(!accessToken || interactive);
      if (interactive && typeof showNotice === "function") {
        showNotice(`Gmail 更新失敗：${error?.message || "請重新按更新"}`, true);
      }
      lastCheckedAt = Date.now();
    } finally {
      if (activeRequest === request) activeRequest = null;
    }
  }

  elements.openButton?.addEventListener("click", openGmailPanel);
  elements.panelClose?.addEventListener("click", closeGmailPanel);
  elements.panelRefresh?.addEventListener("click", () => void loadPanelMessages({ interactive: true }));
  elements.panelBack?.addEventListener("click", showPanelList);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.panel && !elements.panel.hidden) closeGmailPanel();
  });
  elements.enableButton?.addEventListener("click", () => void refreshUnreadCount({ interactive: true }));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastCheckedAt > 5 * 60 * 1000) void refreshUnreadCount();
  });
  window.addEventListener("focus", () => {
    if (Date.now() - lastCheckedAt > 5 * 60 * 1000) void refreshUnreadCount();
  });
  window.setInterval(() => void refreshUnreadCount(), REFRESH_INTERVAL_MS);

  void refreshUnreadCount();
})();



