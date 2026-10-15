"use strict";

(() => {
  const COMPANY_GMAIL = "han@jenfu.com.tw";
  const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
  const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
  const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
  const ENABLED_KEY = "han-gmail-five-day-reminder-enabled";

  const elements = {
    enableButton: document.querySelector("#gmailReminderButton"),
  };

  if (!elements.enableButton) return;
  elements.enableButton.setAttribute("aria-label", "更新 Gmail 近 5 日未讀數");

  let accessToken = "";
  let tokenExpiresAt = 0;
  let tokenClient = null;
  let activeRequest = null;
  let lastCheckedAt = 0;

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

  function markEnabled(enabled) {
    try {
      if (enabled) localStorage.setItem(ENABLED_KEY, "1");
      else localStorage.removeItem(ENABLED_KEY);
    } catch {}
  }

  function wasEnabled() {
    try { return localStorage.getItem(ENABLED_KEY) === "1"; } catch { return false; }
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
    let redirecting = false;
    try {
      const result = await gmailAuth.signInWithPopup(provider);
      const credential = firebase.auth.GoogleAuthProvider.credentialFromResult(result);
      if (!credential?.accessToken) throw new Error("Google 尚未提供 Gmail 讀取授權");
      accessToken = credential.accessToken;
      tokenExpiresAt = Date.now() + 55 * 60 * 1000;
    } catch (error) {
      if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error?.code)) {
        redirecting = true;
        await gmailAuth.signInWithRedirect(provider);
        return new Promise(() => {});
      }
      throw error;
    } finally {
      if (!redirecting) await gmailAuth.signOut().catch(() => {});
    }
    return accessToken;
  }

  async function completeRedirectSignIn() {
    if (!globalThis.firebase?.auth) return false;
    const primaryApp = firebase.app();
    const appName = "gmail-readonly";
    const gmailApp = firebase.apps.find((app) => app.name === appName)
      || firebase.initializeApp(primaryApp.options, appName);
    const gmailAuth = gmailApp.auth();
    const result = await gmailAuth.getRedirectResult();
    const credential = firebase.auth.GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) return false;
    accessToken = credential.accessToken;
    tokenExpiresAt = Date.now() + 55 * 60 * 1000;
    await gmailAuth.signOut().catch(() => {});
    return true;
  }

  async function requestToken(interactive) {
    if (!window.google?.accounts?.oauth2) {
      if (interactive) return connectViaFirebase();
      throw new Error("Google 授權元件尚未載入");
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
    if (interactive) {
      elements.enableButton.disabled = true;
      elements.enableButton.setAttribute("aria-busy", "true");
      elements.enableButton.textContent = "讀取中…";
      elements.enableButton.title = "正在讀取近 5 天未讀信件";
    }
    try {
      if (interactive) await requestToken(true);
      else if (!accessToken || tokenExpiresAt <= Date.now() + 5000) await requestToken(false);
      await verifyCompanyAccount();
      const unreadCount = await countUnreadMessages();
      if (activeRequest !== request) return;
      setUnreadCount(unreadCount);
      markEnabled(true);
      lastCheckedAt = Date.now();
    } catch (error) {
      if (activeRequest !== request) return;
      showEnableButton(!accessToken || interactive || wasEnabled());
      if (interactive && typeof showNotice === "function") {
        showNotice(`Gmail 更新失敗：${error?.message || "請重新按更新"}`, true);
      }
      lastCheckedAt = Date.now();
    } finally {
      if (activeRequest === request) activeRequest = null;
    }
  }

  elements.enableButton.addEventListener("click", () => void refreshUnreadCount({ interactive: true }));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastCheckedAt > 5 * 60 * 1000) void refreshUnreadCount();
  });
  window.addEventListener("focus", () => {
    if (Date.now() - lastCheckedAt > 5 * 60 * 1000) void refreshUnreadCount();
  });
  window.setInterval(() => void refreshUnreadCount(), REFRESH_INTERVAL_MS);

  void (async () => {
    try { await completeRedirectSignIn(); } catch {}
    await refreshUnreadCount();
  })();
})();

