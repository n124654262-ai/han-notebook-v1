"use strict";

(() => {
  const COMPANY_GMAIL = "han@jenfu.com.tw";
  const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
  const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
  const MESSAGE_LIMIT = 8;

  const elements = {
    openButton: document.querySelector("#gmailOpenButton"),
    dialog: document.querySelector("#gmailReaderDialog"),
    closeButton: document.querySelector("#gmailCloseButton"),
    status: document.querySelector("#gmailReaderStatus"),
    connectPanel: document.querySelector("#gmailConnectPanel"),
    connectButton: document.querySelector("#gmailConnectButton"),
    listPanel: document.querySelector("#gmailListPanel"),
    refreshButton: document.querySelector("#gmailRefreshButton"),
    messageCount: document.querySelector("#gmailMessageCount"),
    messageList: document.querySelector("#gmailMessageList"),
    messagePanel: document.querySelector("#gmailMessagePanel"),
    backButton: document.querySelector("#gmailBackButton"),
    messageSubject: document.querySelector("#gmailMessageSubject"),
    messageFrom: document.querySelector("#gmailMessageFrom"),
    messageDate: document.querySelector("#gmailMessageDate"),
    messageBody: document.querySelector("#gmailMessageBody"),
  };

  if (!elements.openButton || !elements.dialog) return;

  let accessToken = "";
  let loading = false;

  function setStatus(message, isError = false) {
    elements.status.textContent = message;
    elements.status.classList.toggle("is-error", isError);
  }

  function setBusy(busy) {
    loading = busy;
    elements.connectButton.disabled = busy;
    elements.refreshButton.disabled = busy;
  }

  function showConnect() {
    elements.connectPanel.hidden = false;
    elements.listPanel.hidden = true;
    elements.messagePanel.hidden = true;
  }

  function showList() {
    elements.connectPanel.hidden = true;
    elements.listPanel.hidden = false;
    elements.messagePanel.hidden = true;
  }

  function showMessage() {
    elements.connectPanel.hidden = true;
    elements.listPanel.hidden = true;
    elements.messagePanel.hidden = false;
  }

  async function waitForGoogleIdentity() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (window.google?.accounts?.oauth2) return;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    throw new Error("Google 登入元件尚未載入，請確認網路後重試");
  }

  async function gmailRequest(path) {
    if (!accessToken) throw new Error("Gmail 尚未連接");
    const response = await fetch(`${GMAIL_API_BASE}${path}`, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (response.status === 401) {
      accessToken = "";
      showConnect();
      throw new Error("Google 登入已失效，請重新連接");
    }
    if (!response.ok) throw new Error(`Gmail 讀取失敗（${response.status}）`);
    return response.json();
  }

  async function connectGmail() {
    await waitForGoogleIdentity();
    const clientId = document.querySelector('meta[name="google-oauth-client-id"]')?.content || "";
    if (!clientId) throw new Error("Google 連接設定尚未完成");

    const token = await new Promise((resolve, reject) => {
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: GMAIL_SCOPE,
        callback: (response) => {
          if (response?.access_token && !response.error) resolve(response.access_token);
          else reject(new Error(response?.error_description || response?.error || "Google 驗證未完成"));
        },
        error_callback: (error) => {
          const message = error?.type === "popup_failed_to_open"
            ? "瀏覽器擋住 Google 登入視窗，請允許彈出視窗後重試"
            : "Google 登入視窗已關閉或未完成";
          reject(new Error(message));
        },
      });
      tokenClient.requestAccessToken({ prompt: "select_account" });
    });

    accessToken = token;
    try {
      const profile = await gmailRequest("/profile");
      const email = String(profile?.emailAddress || "").toLowerCase();
      if (email !== COMPANY_GMAIL) {
        window.google.accounts.oauth2.revoke(accessToken, () => {});
        accessToken = "";
        throw new Error(`請選擇公司帳號 ${COMPANY_GMAIL}`);
      }
    } catch (error) {
      accessToken = "";
      throw error;
    }
  }

  function headerValue(payload, name) {
    return String(payload?.headers?.find((header) => String(header.name).toLowerCase() === name.toLowerCase())?.value || "");
  }

  function formatDate(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-TW", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function decodeBody(value) {
    if (!value) return "";
    const normalized = String(value).replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = window.atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function findPart(part, mimeType) {
    if (!part) return "";
    if (part.mimeType === mimeType && part.body?.data) return decodeBody(part.body.data);
    for (const child of part.parts || []) {
      const content = findPart(child, mimeType);
      if (content) return content;
    }
    return "";
  }

  function findReadableBody(payload) {
    const plainText = findPart(payload, "text/plain");
    if (plainText) return plainText.trim();
    const html = findPart(payload, "text/html");
    if (!html) return "（此信件沒有可顯示的文字內容）";
    const documentData = new DOMParser().parseFromString(html, "text/html");
    return String(documentData.body?.textContent || "").replace(/\n{3,}/g, "\n\n").trim()
      || "（此信件沒有可顯示的文字內容）";
  }

  function normalizeMessage(message) {
    const payload = message?.payload || {};
    return {
      id: String(message?.id || ""),
      subject: headerValue(payload, "Subject") || "（無主旨）",
      from: headerValue(payload, "From") || "（寄件者不明）",
      receivedAt: headerValue(payload, "Date") || Number(message?.internalDate || 0),
      snippet: String(message?.snippet || ""),
    };
  }

  async function fetchMessageMetadata(messageId) {
    const fields = "id,internalDate,snippet,payload(headers)";
    const headers = ["Subject", "From", "Date"].map((name) => `metadataHeaders=${encodeURIComponent(name)}`).join("&");
    const message = await gmailRequest(`/messages/${encodeURIComponent(messageId)}?format=metadata&${headers}&fields=${encodeURIComponent(fields)}`);
    return normalizeMessage(message);
  }

  async function listMessages() {
    const response = await gmailRequest(`/messages?labelIds=INBOX&maxResults=${MESSAGE_LIMIT}`);
    const messages = await Promise.all((response.messages || []).map((message) => fetchMessageMetadata(message.id)));
    return messages;
  }

  function renderMessages(messages) {
    elements.messageList.replaceChildren();
    elements.messageCount.textContent = `收件匣 ${messages.length} 封`;
    if (!messages.length) {
      const empty = document.createElement("li");
      empty.className = "gmail-reader-empty";
      empty.textContent = "目前沒有信件";
      elements.messageList.append(empty);
      return;
    }

    for (const message of messages) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gmail-reader-item";
      const subject = document.createElement("strong");
      subject.textContent = message.subject;
      const meta = document.createElement("span");
      meta.textContent = `${message.from}　${formatDate(message.receivedAt)}`;
      const snippet = document.createElement("span");
      snippet.className = "gmail-reader-snippet";
      snippet.textContent = message.snippet;
      button.append(subject, meta, snippet);
      button.addEventListener("click", () => void openMessage(message));
      item.append(button);
      elements.messageList.append(item);
    }
  }

  async function refreshMessages() {
    if (loading) return;
    setBusy(true);
    showList();
    setStatus("正在讀取收件匣…");
    elements.messageList.replaceChildren();
    try {
      const messages = await listMessages();
      renderMessages(messages);
      setStatus(`已連接 ${COMPANY_GMAIL}`);
    } catch (error) {
      setStatus(error.message, true);
      if (accessToken) {
        const item = document.createElement("li");
        item.className = "gmail-reader-empty";
        item.textContent = "目前無法載入信件，請稍後再試。";
        elements.messageList.append(item);
      }
    } finally {
      setBusy(false);
    }
  }

  async function openMessage(message) {
    if (loading) return;
    setBusy(true);
    showMessage();
    elements.messageSubject.textContent = message.subject;
    elements.messageFrom.textContent = message.from;
    elements.messageDate.textContent = formatDate(message.receivedAt);
    elements.messageBody.textContent = "正在讀取信件…";
    try {
      const detail = await gmailRequest(`/messages/${encodeURIComponent(message.id)}?format=full`);
      const normalized = normalizeMessage(detail);
      elements.messageSubject.textContent = normalized.subject;
      elements.messageFrom.textContent = normalized.from;
      elements.messageDate.textContent = formatDate(normalized.receivedAt);
      elements.messageBody.textContent = findReadableBody(detail.payload);
      setStatus(`已連接 ${COMPANY_GMAIL}`);
    } catch (error) {
      elements.messageBody.textContent = `目前無法讀取這封信：${error.message}`;
      setStatus(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  elements.openButton.addEventListener("click", () => {
    if (!elements.dialog.open) elements.dialog.showModal();
    if (accessToken) void refreshMessages();
    else {
      showConnect();
      setStatus("尚未連接");
    }
  });

  elements.closeButton.addEventListener("click", () => elements.dialog.close());
  elements.dialog.addEventListener("click", (event) => {
    if (event.target === elements.dialog) elements.dialog.close();
  });
  elements.connectButton.addEventListener("click", async () => {
    if (loading) return;
    setBusy(true);
    setStatus("正在連接公司 Gmail…");
    try {
      await connectGmail();
      setBusy(false);
      await refreshMessages();
    } catch (error) {
      setStatus(error.message, true);
      showConnect();
      setBusy(false);
    }
  });
  elements.refreshButton.addEventListener("click", () => void refreshMessages());
  elements.backButton.addEventListener("click", showList);
})();
