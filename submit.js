(() => {
  const form = document.querySelector("#submitForm");
  const status = document.querySelector("#submitStatus");
  const config = window.HAN_FIREBASE_CONFIG;
  if (!form || !config || !globalThis.firebase) return;
  const app = firebase.initializeApp(config);
  const auth = firebase.auth();
  const db = firebase.firestore();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    status.textContent = "送出中…";
    try {
      const user = auth.currentUser || (await auth.signInAnonymously()).user;
      const values = Object.fromEntries(new FormData(form).entries());
      await db.collection("public_submissions").add({
        owner_email: "n124654262@gmail.com",
        object_name: String(values.object_name || "").trim(),
        subject: String(values.subject || "").trim(),
        contact_name: String(values.contact_name || "").trim(),
        phone: String(values.phone || "").trim(),
        requested_action: String(values.requested_action || "").trim(),
        resource_location: String(values.resource_location || "").trim(),
        sender_uid: user.uid,
        created_at: new Date().toISOString(),
      });
      form.reset();
      status.textContent = "已送出，負責人會在暫存區看到。";
    } catch (error) {
      status.textContent = `送出失敗：${error.message}`;
    } finally { button.disabled = false; }
  });
})();
