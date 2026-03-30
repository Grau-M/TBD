(function () {
  const vscode = acquireVsCodeApi();

  window.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);
    const state = {
      activeView: "account",
      classesLoaded: false,
      loadingClasses: false,
      loadingAssignments: false,
      linkingAssignmentId: null,
      selectedClassId: null,
      classes: [],
      assignmentsByClassId: Object.create(null),
      joinPanelOpen: false,
      joinOutsideHandler: null,
    };

    function post(command, payload) {
      try {
        vscode.postMessage(Object.assign({ command }, payload || {}));
      } catch (e) {}
    }

    function setVisible(el, show) {
      if (!el) {
        return;
      }
      el.classList.toggle("hidden", !show);
    }

    function setJoinPanelOpen(isOpen) {
      const panel = $("join-class-panel");
      const input = $("join-class-input");
      const open = !!isOpen;
      state.joinPanelOpen = open;
      setVisible(panel, open);
      panel?.setAttribute("aria-hidden", String(!open));
      if (open) {
        window.requestAnimationFrame(() => {
          input?.focus();
          if (input && typeof input.select === "function") {
            input.select();
          }
        });
        return;
      }
      if (input) {
        input.value = "";
      }
      const joinError = $("student-classes-error");
      if (joinError) {
        joinError.textContent = "";
        setVisible(joinError, false);
      }
    }

    function closeJoinPanel() {
      setJoinPanelOpen(false);
    }

    function submitJoinCode() {
      const joinInput = $("join-class-input");
      const joinCode = String(joinInput?.value || "").trim();
      if (!joinCode) {
        showClassesError("Enter a class join code.");
        joinInput?.focus();
        return;
      }
      clearMessages();
      const joinBtn = $("btn-submit-join-class");
      if (joinBtn) {
        joinBtn.disabled = true;
        joinBtn.textContent = "Joining...";
      }
      post("joinStudentClass", { joinCode });
    }

    function normalizeThemePreference(value) {
      const v = String(value || "")
        .trim()
        .toLowerCase();
      if (v === "light" || v === "dark" || v === "system") {
        return v;
      }
      return "system";
    }

    function applyThemePreference(pref) {
      const normalized = normalizeThemePreference(pref);
      const shouldUseDark =
        normalized === "dark" ||
        (normalized === "system" &&
          window.matchMedia &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.classList.toggle("dark", !!shouldUseDark);
    }

    const themeDropdown = $("account-theme-dropdown");
    const themeTrigger = $("account-theme-trigger");
    const themeMenu = $("account-theme-menu");
    const themeInput = $("account-theme-preference");
    const themeLabel = $("account-theme-label");

    function themeOptions() {
      return Array.from(themeMenu?.querySelectorAll(".custom-dropdown-option") || []);
    }

    function setThemePreference(value) {
      const normalized = normalizeThemePreference(value);
      if (themeInput) {
        themeInput.value = normalized;
      }
      if (themeLabel) {
        themeLabel.textContent = normalized.charAt(0).toUpperCase() + normalized.slice(1);
      }
      if (themeMenu) {
        themeMenu.querySelectorAll(".custom-dropdown-option").forEach((option) => {
          option.setAttribute("aria-selected", String(option.dataset.value === normalized));
        });
      }
    }

    function setThemeMenuOpen(isOpen) {
      if (themeTrigger) {
        themeTrigger.classList.toggle("open", isOpen);
        themeTrigger.setAttribute("aria-expanded", String(isOpen));
      }
      if (themeMenu) {
        themeMenu.classList.toggle("hidden", !isOpen);
      }
    }

    function focusThemeOption(index) {
      const options = themeOptions();
      if (!options.length) {
        return;
      }
      const normalizedIndex = (index + options.length) % options.length;
      options[normalizedIndex].focus();
    }

    function openThemeMenu(focusSelected = false) {
      setThemeMenuOpen(true);
      if (!focusSelected) {
        return;
      }
      window.requestAnimationFrame(() => {
        const options = themeOptions();
        const selectedIndex = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
        (options[selectedIndex >= 0 ? selectedIndex : 0] || themeTrigger)?.focus();
      });
    }

    themeTrigger?.addEventListener("click", (event) => {
      event.stopPropagation();
      const isOpen = themeTrigger.classList.contains("open");
      if (isOpen) {
        setThemeMenuOpen(false);
        return;
      }
      openThemeMenu(true);
    });

    themeMenu?.querySelectorAll(".custom-dropdown-option").forEach((option) => {
      option.addEventListener("click", () => {
        setThemePreference(option.dataset.value || "system");
        setThemeMenuOpen(false);
        themeTrigger?.focus();
      });
    });

    document.addEventListener("click", (event) => {
      if (!themeDropdown || !themeTrigger || !themeMenu) {
        return;
      }
      if (!themeDropdown.contains(event.target)) {
        setThemeMenuOpen(false);
      }
    });

    themeTrigger?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const isOpen = themeTrigger.classList.contains("open");
        if (isOpen) {
          setThemeMenuOpen(false);
        } else {
          openThemeMenu(true);
        }
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openThemeMenu(true);
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        openThemeMenu(true);
      }
      if (event.key === "Escape") {
        setThemeMenuOpen(false);
      }
    });

    themeMenu?.addEventListener("keydown", (event) => {
      const currentIndex = themeOptions().findIndex((option) => option === document.activeElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusThemeOption(currentIndex + 1);
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        focusThemeOption(currentIndex - 1);
      }
      if (event.key === "Home") {
        event.preventDefault();
        focusThemeOption(0);
      }
      if (event.key === "End") {
        event.preventDefault();
        focusThemeOption(themeOptions().length - 1);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setThemeMenuOpen(false);
        themeTrigger?.focus();
      }
    });

    function clearMessages() {
      const err = $("account-error");
      const ok = $("account-success");
      if (err) {
        err.textContent = "";
        setVisible(err, false);
      }
      if (ok) {
        ok.textContent = "";
        setVisible(ok, false);
      }
      const classesErr = $("student-classes-error");
      const classesOk = $("student-classes-status");
      if (classesErr) {
        classesErr.textContent = "";
        setVisible(classesErr, false);
      }
      if (classesOk) {
        classesOk.textContent = "";
        setVisible(classesOk, false);
      }
    }

    function showError(msg) {
      const err = $("account-error");
      if (!err) {
        return;
      }
      err.textContent = msg;
      setVisible(err, true);
    }

    function showSuccess(msg) {
      const ok = $("account-success");
      if (!ok) {
        return;
      }
      ok.textContent = msg;
      setVisible(ok, true);
    }

    function showClassesError(msg) {
      const err = $("student-classes-error");
      if (!err) {
        return;
      }
      err.classList.remove("account-error-banner", "account-offline-banner");
      err.innerHTML = "";
      err.textContent = msg;
      setVisible(err, true);
    }

    function showClassesOfflineBanner() {
      const err = $("student-classes-error");
      if (!err) {
        return;
      }
      err.classList.add("account-error-banner", "account-offline-banner");
      err.innerHTML = `
        <div class="account-offline-banner" role="status" aria-live="polite">
          <h3 class="account-offline-banner-title">Server unreachable</h3>
          <p class="account-offline-banner-copy">The server could not be reached at this time. If you are enrolled in classes, they will be displayed shortly.</p>
        </div>
      `;
      setVisible(err, true);
    }

    function showClassesSuccess(msg) {
      const ok = $("student-classes-status");
      if (!ok) {
        return;
      }
      ok.textContent = msg;
      setVisible(ok, true);
    }

    function buildErrorMessage(msg, fallback) {
      const lines = [];
      const primary = String(msg?.message || fallback || "").trim();
      if (primary) {
        lines.push(primary);
      }
      if (msg?.status) {
        lines.push(`HTTP ${msg.status}`);
      }
      const detail = String(msg?.detail || "").trim();
      if (detail) {
        lines.push(detail);
      }
      return lines.join("\n");
    }

    function getOfflineClassesMessage() {
      return "Server unreachable\nThe server could not be reached at this time. If you are enrolled in classes, they will be displayed shortly.";
    }

    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function formatDate(value) {
      if (!value) {
        return "No date set";
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return value;
      }
      return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }

    function formatClassMeta(item) {
      const parts = [];
      if (item.courseCode) {
        parts.push(item.courseCode);
      }
      if (item.teacherName) {
        parts.push(`Teacher: ${item.teacherName}`);
      }
      if (item.meetingTime) {
        parts.push(item.meetingTime);
      }
      return parts.join(" • ");
    }

    function parseDueDate(value) {
      if (!value) {
        return null;
      }
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        return null;
      }
      return parsed;
    }

    function isPastDueAssignment(assignment) {
      const dueDate = parseDueDate(assignment?.dueDate);
      if (!dueDate) {
        return false;
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      dueDate.setHours(0, 0, 0, 0);
      return dueDate.getTime() < today.getTime();
    }

    function setNavVisibility(data) {
      const classesNav = $("nav-classes");
      const showClasses = !!data.canViewClasses;
      setVisible(classesNav, showClasses);
    }

    function setActiveView(viewName) {
      state.activeView = viewName;
      ["account", "classes"].forEach((name) => {
        const nav = $(`nav-${name}`);
        const view = $(`view-${name}`);
        if (nav) {
          nav.classList.toggle("active", name === viewName);
        }
        if (view) {
          setVisible(view, name === viewName);
        }
      });

      if (
        viewName === "classes" &&
        data.canViewClasses &&
        !state.classesLoaded &&
        !state.loadingClasses
      ) {
        loadClasses();
      }
    }

    function renderClassButtons() {
      const list = $("student-classes-list");
      const emptyState = $("student-classes-empty");
      const loadingState = $("student-classes-loading");
      if (!list) {
        return;
      }

      const hasClasses = state.classes.length > 0;
      setVisible(emptyState, !hasClasses && !state.loadingClasses);
      setVisible(loadingState, !!state.loadingClasses);

      if (!hasClasses) {
        list.innerHTML = "";
        return;
      }

      list.innerHTML = state.classes
        .map(
          (item) => `
        <button class="class-list-btn${state.selectedClassId === item.id ? " active" : ""}" type="button" data-class-id="${item.id}">
          <div class="class-list-label-row">
            <strong>${escapeHtml(item.courseName || "Untitled Class")}</strong>
            <span class="pill">${escapeHtml(item.courseCode || "Class")}</span>
          </div>
          <span>${escapeHtml(formatClassMeta(item))}</span>
        </button>
      `,
        )
        .join("");

      list.querySelectorAll("[data-class-id]").forEach((button) => {
        button.addEventListener("click", () => {
          const classId = Number(button.getAttribute("data-class-id"));
          if (!Number.isFinite(classId)) {
            return;
          }
          selectClass(classId);
        });
      });
    }

    function renderSelectedClass() {
      const detail = $("student-class-detail");
      const placeholder = $("student-class-detail-placeholder");
      const emptyAssignments = $("student-assignments-empty");
      const assignmentList = $("student-assignment-list");
      const loadingAssignments = $("student-assignments-loading");

      const selected = state.classes.find(
        (item) => item.id === state.selectedClassId,
      );
      if (
        !selected ||
        !detail ||
        !placeholder ||
        !assignmentList ||
        !emptyAssignments ||
        !loadingAssignments
      ) {
        if (detail) {
          setVisible(detail, false);
        }
        if (placeholder) {
          setVisible(placeholder, true);
        }
        return;
      }

      setVisible(detail, true);
      setVisible(placeholder, false);
      $("student-class-title").textContent =
        selected.courseName || "Selected Class";
      $("student-class-meta").textContent = [
        selected.courseCode,
        selected.teacherName ? `Teacher: ${selected.teacherName}` : "",
        selected.joinCode ? `Join Code: ${selected.joinCode}` : "",
      ]
        .filter(Boolean)
        .join(" • ");

      const assignments = state.assignmentsByClassId[selected.id];
      setVisible(loadingAssignments, state.loadingAssignments);
      if (!assignments || state.loadingAssignments) {
        assignmentList.innerHTML = "";
        setVisible(emptyAssignments, false);
        return;
      }

      if (assignments.length === 0) {
        assignmentList.innerHTML = "";
        setVisible(emptyAssignments, true);
        return;
      }

      setVisible(emptyAssignments, false);

      const currentAssignments = assignments.filter(
        (assignment) => !isPastDueAssignment(assignment),
      );
      const previousAssignments = assignments.filter((assignment) =>
        isPastDueAssignment(assignment),
      );

      const renderAssignmentCard = (assignment) => {
        const started = !!(
          assignment.workspaceName ||
          assignment.workspaceRootPath ||
          assignment.linkedAt
        );
        const isLinking = state.linkingAssignmentId === assignment.assignmentId;
        const pastDue = isPastDueAssignment(assignment);
        const dueLabel = pastDue
          ? `Past Due: ${formatDate(assignment.dueDate)}`
          : `Due: ${formatDate(assignment.dueDate)}`;
        return `
          <article class="assignment-card${pastDue ? " past-due" : ""}">
            <div class="assignment-status-row">
              <div>
                <strong class="assignment-card-title">${escapeHtml(assignment.assignmentName || "Untitled Assignment")}</strong>
                <span class="assignment-card-copy">${escapeHtml(assignment.description || "No assignment description was provided.")}</span>
              </div>
              <span class="assignment-status ${pastDue ? "past-due" : started ? "started" : "not-started"}">${pastDue ? dueLabel : started ? "Workspace attached" : "Not yet started"}</span>
            </div>
            <div class="assignment-meta">
              <div><strong>Due:</strong> ${escapeHtml(formatDate(assignment.dueDate))}</div>
              <div><strong>Workspace:</strong> ${escapeHtml(assignment.workspaceName || "Not yet started")}</div>
              <div><strong>Path:</strong> ${escapeHtml(assignment.workspaceRootPath || "No workspace linked yet")}</div>
            </div>
            ${
              started
                ? ""
                : `
              <div style="margin-top:12px;">
                <button
                  type="button"
                  class="btn-secondary"
                  data-link-workspace-assignment-id="${assignment.assignmentId}"
                  ${isLinking ? "disabled" : ""}
                >${isLinking ? "Linking workspace..." : "Select Workspace"}</button>
              </div>
            `
            }
          </article>
        `;
      };

      const renderSection = (title, items) => {
        if (!items.length) {
          return "";
        }
        return `
          <section class="assignment-section">
            <h4 class="assignment-section-title">${escapeHtml(title)}</h4>
            <div class="assignment-list-group">
              ${items.map(renderAssignmentCard).join("")}
            </div>
          </section>
        `;
      };

      assignmentList.innerHTML = [
        renderSection("Current Assignments", currentAssignments),
        renderSection("Previous assignments", previousAssignments),
      ]
        .filter(Boolean)
        .join("");

      assignmentList
        .querySelectorAll("[data-link-workspace-assignment-id]")
        .forEach((button) => {
          button.addEventListener("click", () => {
            const assignmentId = Number(
              button.getAttribute("data-link-workspace-assignment-id"),
            );
            if (!Number.isFinite(assignmentId) || !state.selectedClassId) {
              return;
            }
            clearMessages();
            state.linkingAssignmentId = assignmentId;
            renderSelectedClass();
            post("linkStudentAssignmentWorkspace", {
              classId: state.selectedClassId,
              assignmentId,
            });
          });
        });
    }

    function renderStudentClasses(classes) {
      state.classes = Array.isArray(classes) ? classes : [];
      state.classesLoaded = true;
      state.loadingClasses = false;

      setVisible($("student-classes-loading"), false);
      renderClassButtons();

      if (!state.classes.some((item) => item.id === state.selectedClassId)) {
        state.selectedClassId = state.classes[0] ? state.classes[0].id : null;
      }

      renderSelectedClass();
      if (
        state.selectedClassId &&
        !state.assignmentsByClassId[state.selectedClassId]
      ) {
        loadAssignments(state.selectedClassId);
      }
    }

    function loadClasses() {
      clearMessages();
      state.loadingClasses = true;
      setVisible($("student-classes-loading"), true);
      post("loadStudentClasses");
    }

    function loadAssignments(classId) {
      state.selectedClassId = classId;
      state.loadingAssignments = true;
      renderClassButtons();
      renderSelectedClass();
      post("loadStudentClassAssignments", { classId });
    }

    function selectClass(classId) {
      state.selectedClassId = classId;
      renderClassButtons();
      if (state.assignmentsByClassId[classId]) {
        state.loadingAssignments = false;
        renderSelectedClass();
        return;
      }
      loadAssignments(classId);
    }

    const data = window.__ACCOUNT_DATA__ || {};
    const isApiUnavailable = !!data.apiUnavailable;

    function setAccountInteractionState() {
      const displayNameInput = $("account-display-name");
      if (displayNameInput) {
        displayNameInput.disabled = isApiUnavailable;
        displayNameInput.style.cursor = isApiUnavailable ? "default" : "";
      }

      const consentCheckbox = $("account-tracking-consent");
      if (consentCheckbox) {
        consentCheckbox.disabled = isApiUnavailable;
      }

      const consentLabel = document.querySelector(".account-consent-label");
      if (consentLabel) {
        consentLabel.classList.toggle("account-control-disabled", isApiUnavailable);
        consentLabel.style.cursor = isApiUnavailable ? "default" : "pointer";
      }

      const joinButton = $("btn-join-class");
      if (joinButton) {
        joinButton.disabled = isApiUnavailable;
        joinButton.style.cursor = isApiUnavailable ? "default" : "";
      }
    }

    function syncSaveButtonState() {
      const save = $("btn-save-account");
      if (!save) {
        return;
      }

      if (isApiUnavailable) {
        save.disabled = true;
        save.setAttribute("aria-disabled", "true");
        save.title = "API unreachable, try later.";
        return;
      }

      save.disabled = false;
      save.removeAttribute("aria-disabled");
      save.title = "";
    }

    const apiWarning = $("account-api-warning");
    if (apiWarning && data.apiUnavailable) {
      apiWarning.classList.remove("hidden");
    }

    if ($("account-display-name")) {
      $("account-display-name").value = data.displayName || "";
    }
    if ($("account-role")) {
      $("account-role").value = data.role || "";
    }
   if (data.role === "Student") {
      const consentGroup = $("account-consent-group");
      if (consentGroup) { 
          consentGroup.classList.remove("hidden"); 
      }

      if ($("account-tracking-consent")) {
        $("account-tracking-consent").checked = !!data.trackingConsent;
      }
    }
    setThemePreference(data.themePreference);
    if ($("account-email")) {
      $("account-email").value = data.email || "";
    }
    setAccountInteractionState();
    setNavVisibility(data);
    applyThemePreference(data.themePreference);
    syncSaveButtonState();

    $("nav-account")?.addEventListener("click", () => setActiveView("account"));
    $("nav-classes")?.addEventListener("click", () => setActiveView("classes"));
    $("btn-join-class")?.addEventListener("click", () => {
      if (isApiUnavailable) {
        return;
      }
      clearMessages();
      if (state.joinPanelOpen) {
        closeJoinPanel();
        return;
      }
      setJoinPanelOpen(true);
    });

    $("btn-submit-join-class")?.addEventListener("click", submitJoinCode);
    $("btn-close-join-class")?.addEventListener("click", closeJoinPanel);

    $("join-class-input")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitJoinCode();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeJoinPanel();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.joinPanelOpen) {
        closeJoinPanel();
      }
    });

    setActiveView("account");

    const saveBtn = $("btn-save-account");
    saveBtn?.addEventListener("click", () => {
      if (isApiUnavailable) {
        return;
      }
      clearMessages();
      const displayName = ($("account-display-name")?.value || "").trim();
      const trackingConsent = $("account-tracking-consent")?.checked || false;
      if (!displayName) {
        showError("Display name is required.");
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
      post("saveAccount", {
        displayName,
        themePreference: $("account-theme-preference")?.value || "system",
        trackingConsent,
      });
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
          syncSaveButtonState();
          const save = $("btn-save-account");
          if (save && !isApiUnavailable) {
            save.textContent = "Save";
          }
          showSuccess("Your data has been successfully updated.");
          break;
        }
        case "themePreferenceApplied": {
          setThemePreference(msg.themePreference);
          applyThemePreference(msg.themePreference);
          break;
        }
        case "accountError": {
          state.loadingClasses = false;
          state.loadingAssignments = false;
          state.linkingAssignmentId = null;
          setVisible($("student-classes-loading"), false);
          setVisible($("student-classes-empty"), state.classes.length === 0);
          setVisible($("student-assignments-loading"), false);
          renderSelectedClass();
          syncSaveButtonState();
          const save = $("btn-save-account");
          if (save && !isApiUnavailable) {
            save.textContent = "Save";
          }
          const joinBtn = $("btn-join-class");
          if (joinBtn) {
            joinBtn.disabled = false;
            joinBtn.textContent = "Join Class";
          }
          const submitJoinBtn = $("btn-submit-join-class");
          if (submitJoinBtn) {
            submitJoinBtn.disabled = false;
            submitJoinBtn.textContent = "Submit";
          }
          const isClassesView = state.activeView === "classes";
          const errorMessage = buildErrorMessage(
                msg,
                isClassesView
                  ? "Unable to load classes."
                  : "Unable to update account info.",
              );
          if (isClassesView) {
            if (isApiUnavailable) {
              const classesError = $("student-classes-error");
              if (classesError) {
                classesError.classList.remove("account-error-banner", "account-offline-banner");
                classesError.innerHTML = "";
                setVisible(classesError, false);
              }
            } else {
              showClassesError(errorMessage);
            }
          } else {
            showError(errorMessage);
          }
          break;
        }
        case "studentClassesData": {
          const classesError = $("student-classes-error");
          if (classesError) {
            classesError.classList.remove("account-error-banner", "account-offline-banner");
            classesError.innerHTML = "";
          }
          renderStudentClasses(msg.data);
          break;
        }
        case "studentClassAssignmentsData": {
          const payload = msg.data || {};
          if (!Number.isFinite(payload.classId)) {
            break;
          }
          state.loadingAssignments = false;
          state.linkingAssignmentId = null;
          state.assignmentsByClassId[payload.classId] = Array.isArray(
            payload.assignments,
          )
            ? payload.assignments
            : [];
          if (state.selectedClassId === payload.classId) {
            renderSelectedClass();
          }
          break;
        }
        case "studentAssignmentWorkspaceLinked": {
          const payload = msg.data || {};
          if (!Number.isFinite(payload.classId)) {
            state.linkingAssignmentId = null;
            renderSelectedClass();
            break;
          }

          state.linkingAssignmentId = null;
          const currentAssignments = Array.isArray(payload.assignments)
            ? payload.assignments
            : [];
          const linked = payload.linkedAssignment || {};
          const linkedAssignmentId = Number(
            linked.assignmentId || linked.AssignmentId || payload.assignmentId || 0,
          );
          const linkedWorkspaceName =
            linked.workspaceName ||
            linked.WorkspaceName ||
            payload.workspaceName ||
            "";
          const linkedWorkspaceRootPath =
            linked.workspaceRootPath ||
            linked.WorkspaceRootPath ||
            payload.workspaceRootPath ||
            "";
          const linkedWorkspaceId =
            linked.workspaceId ||
            linked.WorkspaceId ||
            payload.workspaceId ||
            payload.WorkspaceId ||
            "";
          const mergedAssignments = currentAssignments.map((assignment) => {
            const assignmentId = Number(assignment.assignmentId || assignment.id || 0);
            if (!linkedAssignmentId || assignmentId !== linkedAssignmentId) {
              return assignment;
            }

            return {
              ...assignment,
              ...linked,
              assignmentId: linkedAssignmentId,
              id: linkedAssignmentId,
              assignmentName:
                linked.assignmentName || linked.name || assignment.assignmentName,
              name: linked.name || linked.assignmentName || assignment.name,
              description: linked.description || assignment.description,
              workspaceId: linkedWorkspaceId || assignment.workspaceId,
              workspaceName:
                linkedWorkspaceName || assignment.workspaceName,
              workspaceRootPath:
                linkedWorkspaceRootPath || assignment.workspaceRootPath,
              linkedAt: linked.linkedAt || linked.LinkedAt || assignment.linkedAt,
            };
          });

          if (linkedAssignmentId && mergedAssignments.length === currentAssignments.length) {
            const foundMatch = mergedAssignments.some((assignment) => {
              return Number(assignment.assignmentId || assignment.id || 0) === linkedAssignmentId;
            });
            if (!foundMatch) {
              mergedAssignments.unshift({
                assignmentId: linkedAssignmentId,
                id: linkedAssignmentId,
                assignmentName: linked.assignmentName || linked.name || payload.assignmentName || "Untitled Assignment",
                name: linked.name || linked.assignmentName || payload.assignmentName || "Untitled Assignment",
                description: linked.description || payload.description || "No assignment description was provided.",
                dueDate: linked.dueDate || payload.dueDate || "",
                workspaceId: linkedWorkspaceId,
                workspaceName: linkedWorkspaceName,
                workspaceRootPath: linkedWorkspaceRootPath,
                linkedAt: linked.linkedAt || linked.LinkedAt || payload.linkedAt || ""
              });
            }
          }

          state.assignmentsByClassId[payload.classId] = mergedAssignments;
          if (state.selectedClassId === payload.classId) {
            renderSelectedClass();
          }
          showClassesSuccess("Workspace linked to assignment successfully.");
          post('refreshStatusBar');
          break;
        }
        case "studentClassJoinResult": {
          const submitJoinBtn = $("btn-submit-join-class");
          if (submitJoinBtn) {
            submitJoinBtn.disabled = false;
            submitJoinBtn.textContent = "Submit";
          }
          if (msg.joined) {
            state.classesLoaded = false;
            closeJoinPanel();
            if (msg.message) {
              showClassesSuccess(msg.message);
            } else {
              showClassesSuccess("Class added successfully.");
            }
          } else if (msg.message) {
            showClassesError(msg.message);
            setJoinPanelOpen(true);
          }
          break;
        }
        case "setActiveView": {
          if (msg.view === "classes") {
            setActiveView("classes");
          } else {
            setActiveView("account");
          }
          break;
        }
        case "openJoinClass": {
          setActiveView("classes");
          setJoinPanelOpen(true);
          break;
        }
      }
    });
  });
})();
