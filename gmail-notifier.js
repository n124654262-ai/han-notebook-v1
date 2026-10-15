"use strict";

(() => {
  const COMPANY_GMAIL = "han@jenfu.com.tw";
  const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
  const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
  const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
  const ENABLED_KEY = "han-gmail-five-day-reminder-enabled";

  const elements = {
    badge: document.querySelector("#gmailUnreadBadge"),
    enableButton: document.querySelector("#gmailReminderButton"),
  };

  if (!elements.badge || !elements.enableButton) return;

  let accessToken = "";
  let tokenExpiresAt = 0;
  let tokenClient = null;
  let loading = false;
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

  function setBadge(count) {
    const safeCount = Math.max(0, Number(count) || 0);
    elements.badge.textContent = safeCount > 99 ? "99+" : String(safeCount);
    elements.badge.hidden = safeCount === 0;
    elements.badge.setAttribute("aria-label", `近 5 天未讀信件 ${safeCount} 封`);
  }

  function showEnableButton(show) {
    elements.enableButton.hidden = !show;
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

  async function requestToken(interactive) {
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
      client.error_callback = (error) => reject(new Error(error?.type === "popup_failed_to_open"
        ? "瀏覽器擋住授權視窗，請允許彈出視窗後重試"
        : "Google 授權尚未完成"));
      client.requestAccessToken({
        prompt: interactive ? "consent" : "none",
        login_hint: COMPANY_GMAIL,
      });
    });
  }

  async function gmailRequest(path) {
    if (!accessToken || tokenExpiresAt <= Date.now() + 5000) await requestToken(false);
    const response = await fetch(`${GMAIL_API_BASE}${path}`, {
      cache: "no-store",
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 401) {
      accessToken = "";
      tokenExpiresAt = 0;
      await requestToken(false);
      return gmailRequest(path);
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

  async function refreshUnreadCount({ interactive = false } = {}) {
    if (loading) return;
    loading = true;
    try {
      if (interactive) await requestToken(true);
      else if (!accessToken || tokenExpiresAt <= Date.now() + 5000) await requestToken(false);
      await verifyCompanyAccount();
      const result = await gmailRequest("/messages?maxResults=1&includeSpamTrash=false&q=is%3Aunread%20newer_than%3A5d");
      setBadge(result?.resultSizeEstimate || 0);
      markEnabled(true);
      showEnableButton(false);
      lastCheckedAt = Date.now();
    } catch (error) {
      setBadge(0);
      showEnableButton(!accessToken || interactive || wasEnabled());
      lastCheckedAt = Date.now();
    } finally {
      loading = false;
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

  void refreshUnreadCount();
})();

