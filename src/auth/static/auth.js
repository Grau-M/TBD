(function () {
  const vscode = acquireVsCodeApi();

  window.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);

    function post(command, payload) {
      try {
        vscode.postMessage(Object.assign({ command }, payload || {}));
      } catch (e) {}
    }

    // ── Theme toggle ──────────────────────────────────────────────
    const themeToggle = $("auth-theme-toggle");
    let isDark = false;
    try {
      const st =
        typeof vscode.getState === "function" ? vscode.getState() : undefined;
      if (st && st.theme === "dark") {
        isDark = true;
      } else if (
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
      ) {
        isDark = true;
      }
    } catch (e) {
      isDark = !!(
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
      );
    }
    if (isDark) {
      document.documentElement.classList.add("dark");
    }
    if (themeToggle) {
      themeToggle.textContent = isDark ? "🌙" : "☀️";
      themeToggle.addEventListener("click", () => {
        document.documentElement.classList.toggle("dark");
        isDark = !isDark;
        themeToggle.textContent = isDark ? "🌙" : "☀️";
        try {
          vscode.setState({ theme: isDark ? "dark" : "light" });
        } catch (e) {}
      });
    }

    // ── Tab switching ─────────────────────────────────────────────
    function switchTab(tab) {
      ["signin", "register"].forEach((t) => {
        const btn = $(`auth-tab-${t}`);
        const panel = $(`auth-${t}-panel`);
        if (btn) {
          btn.classList.toggle("active", t === tab);
        }
        if (panel) {
          panel.classList.toggle("hidden", t !== tab);
        }
      });
      clearErrors();
    }

    $("auth-tab-signin")?.addEventListener("click", () => switchTab("signin"));
    $("auth-tab-register")?.addEventListener("click", () =>
      switchTab("register"),
    );
    $("go-to-register")?.addEventListener("click", () => {
      switchTab("register");
      $("register-name")?.focus();
    });
    $("go-to-signin")?.addEventListener("click", () => {
      switchTab("signin");
      $("signin-email")?.focus();
    });

    // ── Error helpers ──────────────────────────────────────────────
    function clearErrors() {
      ["signin-error", "register-error"].forEach((id) => {
        const el = $(id);
        if (el) {
          el.textContent = "";
          el.classList.add("hidden");
        }
      });
    }

    function showError(id, msg) {
      const el = $(id);
      if (el) {
        el.textContent = msg;
        el.classList.remove("hidden");
      }
    }

    // ── Password visibility toggles ───────────────────────────────
    document.querySelectorAll(".toggle-pw").forEach((btn) => {
      btn.addEventListener("click", () => {
        const input = $(btn.dataset.target);
        if (!input) {
          return;
        }
        input.type = input.type === "password" ? "text" : "password";
        btn.textContent = input.type === "password" ? "👁" : "🙈";
      });
    });

    // ── Sign In ───────────────────────────────────────────────────
    function setOAuthBusyState(isBusy, label) {
      const msBtn = $("btn-signin-microsoft");
      const ggBtn = $("btn-signin-google");
      if (msBtn) {
        msBtn.disabled = isBusy;
        msBtn.textContent =
          isBusy && label === "microsoft"
            ? "Signing in with Microsoft..."
            : "Continue with Microsoft";
      }
      if (ggBtn) {
        ggBtn.disabled = isBusy;
        ggBtn.textContent =
          isBusy && label === "google"
            ? "Signing in with Google..."
            : "Continue with Google";
      }
    }

    function doSignIn() {
      const email = ($("signin-email")?.value || "").trim().toLowerCase();
      const password = ($("signin-password")?.value || "").trim();
      clearErrors();
      if (!email) {
        showError("signin-error", "Email address is required.");
        return;
      }
      if (!password) {
        showError("signin-error", "Password is required.");
        return;
      }

      const btn = $("btn-signin");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Signing in…";
      }
      post("signIn", { email, password });
    }

    $("btn-signin")?.addEventListener("click", doSignIn);
    $("btn-signin-microsoft")?.addEventListener("click", () => {
      clearErrors();
      setOAuthBusyState(true, "microsoft");
      post("oauthSignIn", { provider: "microsoft" });
    });
    $("btn-signin-google")?.addEventListener("click", () => {
      clearErrors();
      setOAuthBusyState(true, "google");
      post("oauthSignIn", { provider: "google" });
    });
    [$("signin-email"), $("signin-password")].forEach((el) => {
      el?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          doSignIn();
        }
      });
    });

    // ── Register ──────────────────────────────────────────────────
    function doRegister() {
      const displayName = ($("register-name")?.value || "").trim();
      const email = ($("register-email")?.value || "").trim().toLowerCase();
      const password = ($("register-password")?.value || "").trim();
      const confirm = ($("register-confirm")?.value || "").trim();
      const role = $("register-role")?.value || "Student";
      clearErrors();

      if (!displayName) {
        showError("register-error", "Display name is required.");
        return;
      }
      if (!email) {
        showError("register-error", "Email address is required.");
        return;
      }
      if (!email.includes("@")) {
        showError("register-error", "Please enter a valid email address.");
        return;
      }
      if (!password) {
        showError("register-error", "Password is required.");
        return;
      }
      if (password.length < 4) {
        showError("register-error", "Password must be at least 4 characters.");
        return;
      }
      if (password !== confirm) {
        showError("register-error", "Passwords do not match.");
        return;
      }

      const btn = $("btn-register");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Creating account…";
      }
      post("register", { displayName, email, password, role });
    }

    $("btn-register")?.addEventListener("click", doRegister);
    [
      $("register-name"),
      $("register-email"),
      $("register-password"),
      $("register-confirm"),
    ].forEach((el) => {
      el?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          doRegister();
        }
      });
    });

    // ── Message router ────────────────────────────────────────────
    window.addEventListener("message", (event) => {
      const msg = event.data || {};

      switch (msg.command) {
        case "authSuccess": {
          // Hide forms, show success
          ["auth-signin-panel", "auth-register-panel", "auth-tabs"].forEach(
            (id) => {
              const el = $(id);
              if (el) {
                el.classList.add("hidden");
              }
            },
          );
          const successPanel = $("auth-success-panel");
          if (successPanel) {
            successPanel.classList.remove("hidden");
          }

          const title = $("auth-success-title");
          if (title) {
            title.textContent = `Welcome, ${msg.displayName || "User"}!`;
          }

          const sub = $("auth-success-msg");
          if (sub) {
            sub.textContent = `Signed in as ${msg.role || "User"}. This window will close shortly.`;
          }
          break;
        }

        case "authError": {
          const errorId =
            msg.form === "register" ? "register-error" : "signin-error";
          showError(
            errorId,
            msg.message || "An unexpected error occurred. Please try again.",
          );

          const signinBtn = $("btn-signin");
          if (signinBtn) {
            signinBtn.disabled = false;
            signinBtn.textContent = "Sign In";
          }
          const registerBtn = $("btn-register");
          if (registerBtn) {
            registerBtn.disabled = false;
            registerBtn.textContent = "Create Account";
          }
          setOAuthBusyState(false);
          break;
        }
      }
    });

    // ── Focus first field on load ─────────────────────────────────
    $("signin-email")?.focus();
  });
})();
