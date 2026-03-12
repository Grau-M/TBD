(function () {
  const vscode = acquireVsCodeApi();

  window.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);

    function post(command, payload) {
      try { vscode.postMessage(Object.assign({ command }, payload || {})); } catch (e) {}
    }

    function setVisible(el, show) {
      if (!el) return;
      el.classList.toggle("hidden", !show);
    }

    function clearMessages() {
      const err = $("account-error");
      const ok = $("account-success");
      if (err) { err.textContent = ""; setVisible(err, false); }
      if (ok) { ok.textContent = ""; setVisible(ok, false); }
    }

    function showError(msg) {
      const err = $("account-error");
      if (!err) return;
      err.textContent = msg;
      setVisible(err, true);
    }

    function showSuccess(msg) {
      const ok = $("account-success");
      if (!ok) return;
      ok.textContent = msg;
      setVisible(ok, true);
    }

    const data = window.__ACCOUNT_DATA__ || {};

    if ($("account-display-name")) $("account-display-name").value = data.displayName || "";
    if ($("account-role")) $("account-role").value = data.role || "";
    if ($("account-provider")) $("account-provider").value = data.provider || "";
    if ($("account-email")) $("account-email").value = data.email || "";
    if ($("account-ide-user")) $("account-ide-user").value = data.ideUser || "";
    if ($("account-workspace")) $("account-workspace").value = data.workspaceName || "";

    const themeToggle = $("account-theme-toggle");
    let isDark = false;
    try {
      const st = typeof vscode.getState === "function" ? vscode.getState() : undefined;
      if (st && st.theme === "dark") isDark = true;
      else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) isDark = true;
    } catch (e) {
      isDark = false;
    }
    if (isDark) document.documentElement.classList.add("dark");
    if (themeToggle) {
      themeToggle.textContent = isDark ? "🌙" : "☀️";
      themeToggle.addEventListener("click", () => {
        document.documentElement.classList.toggle("dark");
        isDark = !isDark;
        themeToggle.textContent = isDark ? "🌙" : "☀️";
        if (vscode.setState) {
          try { vscode.setState({ theme: isDark ? "dark" : "light" }); } catch (e) {}
        }
      });
    }

    const saveBtn = $("btn-save-account");
    saveBtn?.addEventListener("click", () => {
      clearMessages();
      const displayName = ($("account-display-name")?.value || "").trim();
      if (!displayName) {
        showError("Display name is required.");
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
      post("saveAccount", { displayName });
    });

    $("account-display-name")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveBtn?.click();
      }
    });

    window.addEventListener("message", (event) => {
      const msg = event.data || {};
      switch (msg.command) {
        case "accountSaved": {
          const save = $("btn-save-account");
          if (save) {
            save.disabled = false;
            save.textContent = "Save Display Name";
          }
          showSuccess("Display name updated successfully.");
          break;
        }
        case "accountError": {
          const save = $("btn-save-account");
          if (save) {
            save.disabled = false;
            save.textContent = "Save Display Name";
          }
          showError(msg.message || "Unable to update account info.");
          break;
        }
      }
    });
  });
})();
