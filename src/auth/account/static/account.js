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
      err.textContent = msg;
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
      if (!list) {
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
      assignmentList.innerHTML = assignments
        .map((assignment) => {
          const started = !!(
            assignment.workspaceName ||
            assignment.workspaceRootPath ||
            assignment.linkedAt
          );
          const isLinking =
            state.linkingAssignmentId === assignment.assignmentId;
          return `
          <article class="assignment-card">
            <div class="assignment-status-row">
              <div>
                <strong class="assignment-card-title">${escapeHtml(assignment.assignmentName || "Untitled Assignment")}</strong>
                <span class="assignment-card-copy">${escapeHtml(assignment.description || "No assignment description was provided.")}</span>
              </div>
              <span class="assignment-status ${started ? "started" : "not-started"}">${started ? "Workspace attached" : "Not yet started"}</span>
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
        })
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
            showClassesSuccess("");
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
      setVisible($("student-classes-empty"), state.classes.length === 0);
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

    if ($("account-display-name")) {
      $("account-display-name").value = data.displayName || "";
    }
    if ($("account-role")) {
      $("account-role").value = data.role || "";
    }
    if (data.role === "Student") {
      const consentGroup = $("account-consent-group");
      if (consentGroup) consentGroup.classList.remove("hidden");

      if ($("account-tracking-consent")) {
        $("account-tracking-consent").checked = !!data.trackingConsent;
      }
    }
    if ($("account-theme-preference")) {
      $("account-theme-preference").value = normalizeThemePreference(
        data.themePreference,
      );
    }
    if ($("account-email")) {
      $("account-email").value = data.email || "";
    }
    setNavVisibility(data);
    applyThemePreference(data.themePreference);

    $("nav-account")?.addEventListener("click", () => setActiveView("account"));
    $("nav-classes")?.addEventListener("click", () => setActiveView("classes"));
    $("btn-join-class")?.addEventListener("click", () => {
      clearMessages();
      const joinBtn = $("btn-join-class");
      if (joinBtn) {
        joinBtn.disabled = true;
        joinBtn.textContent = "Joining...";
      }
      post("joinStudentClass");
    });
    setActiveView("account");

    const saveBtn = $("btn-save-account");
    saveBtn?.addEventListener("click", () => {
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
          const save = $("btn-save-account");
          if (save) {
            save.disabled = false;
            save.textContent = "Save";
          }
          showSuccess("Your data has been successfully updated.");
          break;
        }
        case "themePreferenceApplied": {
          applyThemePreference(msg.themePreference);
          break;
        }
        case "accountError": {
          state.loadingClasses = false;
          state.loadingAssignments = false;
          state.linkingAssignmentId = null;
          setVisible($("student-classes-loading"), false);
          setVisible($("student-assignments-loading"), false);
          renderSelectedClass();
          const save = $("btn-save-account");
          if (save) {
            save.disabled = false;
            save.textContent = "Save";
          }
          const joinBtn = $("btn-join-class");
          if (joinBtn) {
            joinBtn.disabled = false;
            joinBtn.textContent = "Join Class";
          }
          if (state.activeView === "classes") {
            showClassesError(msg.message || "Unable to load classes.");
          } else {
            showError(msg.message || "Unable to update account info.");
          }
          break;
        }
        case "studentClassesData": {
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
          state.assignmentsByClassId[payload.classId] = Array.isArray(
            payload.assignments,
          )
            ? payload.assignments
            : [];
          if (state.selectedClassId === payload.classId) {
            renderSelectedClass();
          }
          showClassesSuccess("Workspace linked to assignment successfully.");
          break;
        }
        case "studentClassJoinResult": {
          const joinBtn = $("btn-join-class");
          if (joinBtn) {
            joinBtn.disabled = false;
            joinBtn.textContent = "Join Class";
          }
          if (msg.joined) {
            state.classesLoaded = false;
            showClassesSuccess("Class added successfully.");
          }
          break;
        }
      }
    });
  });
})();
