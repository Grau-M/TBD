(function () {
  const vscode = acquireVsCodeApi();

  window.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);

    function post(command, payload) {
      try {
        vscode.postMessage(Object.assign({ command }, payload || {}));
      } catch (e) {}
    }

    // ── Shared theme preference (set in Account page) ────────────
    const themePreference = String(
      window.__TBD_THEME_PREFERENCE__ || "system",
    ).toLowerCase();
    const shouldUseDark =
      themePreference === "dark" ||
      (themePreference === "system" &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", !!shouldUseDark);

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

    const consentGroup = $("register-consent-group");
    const consentCheckbox = $("register-consent");
    const consentModal = $("tracking-consent-modal");
    const consentMessage = $("tracking-consent-message");
    const consentContinueBtn = $("tracking-consent-continue");
    const consentCancelBtn = $("tracking-consent-cancel");
    let consentResolver = null;

    function setConsentModalOpen(isOpen, message) {
      if (consentModal) {
        consentModal.classList.toggle("hidden", !isOpen);
        consentModal.setAttribute("aria-hidden", String(!isOpen));
      }
      if (message && consentMessage) {
        consentMessage.textContent = message;
      }
      if (isOpen) {
        consentContinueBtn?.focus();
      }
    }

    function requestTrackingConsent() {
      return new Promise((resolve) => {
        consentResolver = resolve;
        setConsentModalOpen(
          true,
          "Are you sure you want to continue without tracking consent? Without it, you cannot send data to your class assignments.",
        );
      });
    }

    function finishTrackingConsent(approved) {
      if (consentResolver) {
        consentResolver(approved);
        consentResolver = null;
      }
      setConsentModalOpen(false);
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

    // ── Custom role dropdown ────────────────────────────────────
    const roleDropdown = $("register-role-dropdown");
    const roleTrigger = $("register-role-trigger");
    const roleMenu = $("register-role-menu");
    const roleInput = $("register-role");
    const roleLabel = $("register-role-label");
    const roleOptions = () =>
      Array.from(
        roleMenu?.querySelectorAll(".custom-dropdown-option") || [],
      );

    function setRole(value) {
      const nextValue = value || "Student";
      if (roleInput) {
        roleInput.value = nextValue;
      }
      if (roleLabel) {
        roleLabel.textContent = nextValue;
      }
      if (roleMenu) {
        roleMenu.querySelectorAll(".custom-dropdown-option").forEach((option) => {
          const isSelected = option.dataset.value === nextValue;
          option.setAttribute("aria-selected", String(isSelected));
        });
      }
      if (consentGroup) {
        const hideConsent = nextValue === "Teacher";
        consentGroup.classList.toggle("hidden", hideConsent);
        if (hideConsent && consentCheckbox) {
          consentCheckbox.checked = false;
        }
      }
    }

    function setRoleMenuOpen(isOpen) {
      if (roleTrigger) {
        roleTrigger.classList.toggle("open", isOpen);
        roleTrigger.setAttribute("aria-expanded", String(isOpen));
      }
      if (roleMenu) {
        roleMenu.classList.toggle("hidden", !isOpen);
      }
    }

    function focusRoleOption(index) {
      const options = roleOptions();
      if (!options.length) {
        return;
      }
      const normalizedIndex = (index + options.length) % options.length;
      options[normalizedIndex].focus();
    }

    function openRoleMenu({ focusSelected = false } = {}) {
      setRoleMenuOpen(true);
      if (!focusSelected) {
        return;
      }
      window.requestAnimationFrame(() => {
        const options = roleOptions();
        const selectedIndex = options.findIndex(
          (option) => option.getAttribute("aria-selected") === "true",
        );
        (options[selectedIndex >= 0 ? selectedIndex : 0] || roleTrigger)?.focus();
      });
    }

    roleTrigger?.addEventListener("click", (event) => {
      event.stopPropagation();
      const isOpen = roleTrigger.classList.contains("open");
      if (isOpen) {
        setRoleMenuOpen(false);
        return;
      }
      openRoleMenu({ focusSelected: true });
    });

    roleMenu?.querySelectorAll(".custom-dropdown-option").forEach((option) => {
      option.addEventListener("click", () => {
        setRole(option.dataset.value || "Student");
        setRoleMenuOpen(false);
        roleTrigger?.focus();
      });
    });

    document.addEventListener("click", (event) => {
      if (!roleDropdown || !roleTrigger || !roleMenu) {
        return;
      }
      if (!roleDropdown.contains(event.target)) {
        setRoleMenuOpen(false);
      }
    });

    roleTrigger?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const isOpen = roleTrigger.classList.contains("open");
        if (isOpen) {
          setRoleMenuOpen(false);
        } else {
          openRoleMenu({ focusSelected: true });
        }
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openRoleMenu({ focusSelected: true });
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        openRoleMenu({ focusSelected: true });
      }
      if (event.key === "Escape") {
        setRoleMenuOpen(false);
      }
    });

    roleMenu?.addEventListener("keydown", (event) => {
      const currentIndex = roleOptions().findIndex(
        (option) => option === document.activeElement,
      );
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusRoleOption(currentIndex + 1);
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        focusRoleOption(currentIndex - 1);
      }
      if (event.key === "Home") {
        event.preventDefault();
        focusRoleOption(0);
      }
      if (event.key === "End") {
        event.preventDefault();
        focusRoleOption(roleOptions().length - 1);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setRoleMenuOpen(false);
        roleTrigger?.focus();
      }
    });

    consentContinueBtn?.addEventListener("click", () => finishTrackingConsent(true));
    consentCancelBtn?.addEventListener("click", () => finishTrackingConsent(false));
    consentModal?.addEventListener("click", (event) => {
      if (
        event.target === consentModal ||
        (event.target instanceof HTMLElement &&
          event.target.classList.contains("custom-modal-backdrop"))
      ) {
        finishTrackingConsent(false);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (!consentModal || consentModal.classList.contains("hidden")) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        finishTrackingConsent(false);
      }
    });

    setRole(roleInput?.value || "Student");

    // ── Sign In ───────────────────────────────────────────────────
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
    [$("signin-email"), $("signin-password")].forEach((el) => {
      el?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          doSignIn();
        }
      });
    });

    // ── Register ──────────────────────────────────────────────────
    async function doRegister() {
      const displayName = ($("register-name")?.value || "").trim();
      const email = ($("register-email")?.value || "").trim().toLowerCase();
      const password = ($("register-password")?.value || "").trim();
      const confirm = ($("register-confirm")?.value || "").trim();
      const role = $("register-role")?.value || "Student";
      clearErrors();

      let trackingConsent = false;
      if (role === "Teacher") {
        trackingConsent = false;
      } else {
        trackingConsent = $("register-consent")?.checked || false;
        if (!trackingConsent) {
          const proceedWithoutConsent = await requestTrackingConsent();
          if (!proceedWithoutConsent) {
            return;
          }
        }
      }
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
      post("register", { displayName, email, password, role, trackingConsent });
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
          break;
        }
      }
    });

    // ── Focus first field on load ─────────────────────────────────
    $("signin-email")?.focus();
  });
})();
