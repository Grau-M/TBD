// teacher.js (FULL FILE as you shared it) + changes added for:
// 1) listening for "studentSummary" messages and rendering output in dashboard dropdown + logs view
// 2) optional status text updates
// NOTE: This file assumes renderers.js adds the dashboard dropdown button that posts:
// window.postTeacherMessage("generateStudentSummary", { filename })

/* Webview client script for Teacher View - strictly state and routing */
(function () {
  const vscode = acquireVsCodeApi();
  const UI = window.TeacherUI;

  // Application State
  let logNamesCache = [];
  const defaults = {
    inactivity: 5,
    flight: 50,
    pasteLength: 50,
    flagAiEvents: true,
  };
  let currentSettings = { ...defaults };
  let currentTab = "dashboard";
  let requestedDashboardFile = null;
  let expandedFile = null;
  let currentLogFilename = null;
  let dashboardDataCache = null;
  let currentClassId = null;
  let editingClassId = null;
  let currentClassAssignments = [];
  let currentAssignmentId = null;
  let currentAssignmentName = "";
  let currentClassDetailTab = "students";

  window.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);
    const status = $("status");
    const searchInput = $("log-search-input");
    const dropdown = $("log-dropdown");
    const themeToggle = $("themeToggle");
    const hamburgerBtn = $("hamburger");
    const sidebarEl = document.querySelector(".sidebar");

    function post(command, payload = {}) {
      try {
        vscode.postMessage(Object.assign({ command }, payload));
      } catch (e) {}
    }

    function installDatePickerBehavior() {
      const targetIds = new Set([
        "class-start-date",
        "class-end-date",
        "assignment-due-date",
      ]);

      const getTargetDateInput = (event) => {
        const el = event.target;
        if (!(el instanceof HTMLInputElement)) {
          return null;
        }
        if (el.type !== "date" || !targetIds.has(el.id)) {
          return null;
        }
        return el;
      };

      const tryShowPicker = (el) => {
        if (typeof el.showPicker === "function") {
          try {
            el.showPicker();
            return true;
          } catch (e) {
            return false;
          }
        }
        return false;
      };

      const onPointerDown = (event) => {
        const el = getTargetDateInput(event);
        if (!el) {
          return;
        }

        // Only suppress native text-segment focus when picker actually opens.
        const opened = tryShowPicker(el);
        if (opened) {
          el.dataset.pickerOpenedAt = String(Date.now());
          event.preventDefault();
          return;
        }

        // Fallback: allow default behavior; don't block user interaction.
        try {
          el.focus({ preventScroll: true });
        } catch (e) {
          el.focus();
        }
      };

      const onClick = (event) => {
        const el = getTargetDateInput(event);
        if (!el) {
          return;
        }

        const openedAt = Number(el.dataset.pickerOpenedAt || 0);
        if (openedAt && Date.now() - openedAt < 500) {
          return;
        }

        // Click-path fallback for environments that block mousedown-triggered picker.
        tryShowPicker(el);
      };

      // Capture phase ensures this runs before the browser applies text-segment selection.
      document.addEventListener("mousedown", onPointerDown, true);
      document.addEventListener("touchstart", onPointerDown, true);
      document.addEventListener("click", onClick, true);
    }

    installDatePickerBehavior();

    // Make post available globally for note handlers + student summary button
    window.postTeacherMessage = post;

    // --- UI & THEME TOGGLES ---
    let isDark = false;
    try {
      const st =
        typeof vscode.getState === "function" ? vscode.getState() : undefined;
      if (st && st.theme === "dark") {
        isDark = true;
      } else if (document.documentElement.classList.contains("dark")) {
        isDark = true;
      } else if (
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
      ) {
        isDark = true;
      }
    } catch (e) {
      isDark =
        document.documentElement.classList.contains("dark") ||
        (window.matchMedia &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);
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
        if (vscode.setState)
          try {
            vscode.setState({ theme: isDark ? "dark" : "light" });
          } catch (e) {}
      });
    }

    if (hamburgerBtn && sidebarEl) {
      let backdrop = null;
      hamburgerBtn.addEventListener("click", () => {
        const isOpen = sidebarEl.classList.toggle("open");
        if (isOpen) {
          backdrop = document.createElement("div");
          backdrop.id = "sidebar-backdrop";
          backdrop.className = "backdrop show";
          document.body.appendChild(backdrop);
          backdrop.addEventListener("click", () => {
            sidebarEl.classList.remove("open");
            try {
              backdrop.remove();
            } catch (e) {}
          });
        } else {
          const existing = document.getElementById("sidebar-backdrop");
          if (existing)
            try {
              existing.remove();
            } catch (e) {}
        }
      });
    }

    // --- NAVIGATION ---
    function switchTab(tabName) {
      document
        .querySelectorAll(".tab-pane")
        .forEach((el) => el.classList.remove("active"));
      document
        .querySelectorAll(".tab-btn")
        .forEach((el) => el.classList.remove("active"));
      if ($(`${tabName}-tab`)) {
        $(`${tabName}-tab`).classList.add("active");
      }
      if ($(`nav-${tabName}`)) {
        $(`nav-${tabName}`).classList.add("active");
      }
      currentTab = tabName;
    }

    function showDashboardLoading() {
      if ($("dashboard-empty")) {
        $("dashboard-empty").style.display = "none";
      }
      if ($("dashboard-loading")) {
        $("dashboard-loading").style.display = "block";
      }
      if ($("dashboard-view")) {
        $("dashboard-view").innerHTML = "";
      }
    }

    $("nav-dashboard")?.addEventListener("click", () => {
      switchTab("dashboard");
      if (dashboardDataCache && dashboardDataCache.metrics) {
        UI.renderDashboard(dashboardDataCache, handlers);
        if ($("dashboard-log-name"))
          $("dashboard-log-name").textContent = "Viewing: All logs";
        if (status) status.textContent = "Dashboard ready";
        return;
      }
      showDashboardLoading();
      post("analyzeLogs");
    });
    $("nav-logs")?.addEventListener("click", () => {
      switchTab("logs");
      post("listLogs");
    });
    $("nav-deletions")?.addEventListener("click", () => {
      switchTab("deletions");
      post("getDeletions");
    });
    $("nav-settings")?.addEventListener("click", () => switchTab("settings"));
    $("nav-class")?.addEventListener("click", () => {
      switchTab("class");
      loadClasses();
    });
    $("btn-goto-logs")?.addEventListener("click", () => switchTab("logs"));

    $("close-log")?.addEventListener("click", () => {
      if ($("logs-viewer-container"))
        $("logs-viewer-container").style.display = "none";
      if ($("logs-view")) $("logs-view").innerHTML = "";
      if ($("logs-log-name")) $("logs-log-name").textContent = "";
      if (searchInput) searchInput.value = "";
    });

    $("refresh-logs")?.addEventListener("click", () => {
      if (status) status.textContent = "Refreshing list...";
      // New/removed logs can change aggregate metrics.
      dashboardDataCache = null;
      post("listLogs");
    });
    $("refreshDeletions")?.addEventListener("click", () => {
      if (status) status.textContent = "Fetching deletions...";
      post("getDeletions");
    });

    // --- SETTINGS BUTTONS ---
    $("saveSettings")?.addEventListener("click", () => {
      const settings = {
        inactivityThreshold: parseInt(
          $("inactivityInput")?.value || defaults.inactivity,
        ),
        flightTimeThreshold: parseInt(
          $("flightInput")?.value || defaults.flight,
        ),
        pasteLengthThreshold: parseInt(
          $("pasteLengthInput")?.value || defaults.pasteLength,
        ),
        flagAiEvents: $("flagAiEvents")
          ? $("flagAiEvents").checked
          : defaults.flagAiEvents,
      };
      post("saveSettings", { settings });
    });
    $("resetSettings")?.addEventListener("click", () => {
      if ($("inactivityInput"))
        $("inactivityInput").value = defaults.inactivity;
      if ($("flightInput")) $("flightInput").value = defaults.flight;
      if ($("pasteLengthInput"))
        $("pasteLengthInput").value = defaults.pasteLength;
      if ($("flagAiEvents")) $("flagAiEvents").checked = defaults.flagAiEvents;
      post("saveSettings", { settings: defaults });
    });

    // --- SEARCH & DROPDOWN ---
    function renderSearchDropdown(items) {
      if (!dropdown) return;
      dropdown.innerHTML = "";
      if (!items || items.length === 0) {
        dropdown.innerHTML =
          '<div class="dropdown-item" style="cursor:default; color:var(--muted);">No logs found</div>';
        return;
      }
      items.forEach((name) => {
        const div = document.createElement("div");
        div.className = "dropdown-item";
        div.textContent = name;
        div.addEventListener("mousedown", (e) => {
          e.preventDefault();
          if (searchInput) searchInput.value = name;
          dropdown.classList.remove("show");
          if (status) status.textContent = "Decrypting " + name + "...";
          post("openLog", { filename: name });
        });
        dropdown.appendChild(div);
      });
    }

    function filterLogs(term) {
      return logNamesCache.filter(
        (n) => n.toLowerCase().includes(term) && n.endsWith(".log"),
      );
    }

    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        renderSearchDropdown(filterLogs((e.target.value || "").toLowerCase()));
        if (dropdown) dropdown.classList.add("show");
      });
      searchInput.addEventListener("focus", () => {
        renderSearchDropdown(
          filterLogs((searchInput.value || "").toLowerCase()),
        );
        if (dropdown) dropdown.classList.add("show");
      });
    }
    const clearSearchBtn = $("clear-search");
    if (clearSearchBtn) {
      clearSearchBtn.addEventListener("click", () => {
        if (searchInput) {
          searchInput.value = "";
          searchInput.focus();
        }
        if (dropdown) {
          dropdown.classList.remove("show");
        }
      });
    }

    document.addEventListener("click", (e) => {
      if (
        searchInput &&
        dropdown &&
        !searchInput.contains(e.target) &&
        !dropdown.contains(e.target)
      ) {
        dropdown.classList.remove("show");
      }
    });

    // --- HANDLERS TO PASS TO RENDERERS ---
    const handlers = {
      onGenerateTimeline: () => {
        const checks = document.querySelectorAll(".log-checkbox:checked");
        const filenames = Array.from(checks).map((c) => c.value);
        if (filenames.length === 0)
          return (status.textContent =
            "Error: Select at least 1 log to build a timeline.");
        status.textContent = "Generating Timeline...";
        post("generateTimeline", { filenames });
      },
      onGenerateProfile: () => {
        const checks = document.querySelectorAll(".log-checkbox:checked");
        const filenames = Array.from(checks).map((c) => c.value);
        if (filenames.length < 2)
          return (status.textContent =
            "Error: Select at least 2 logs to build a profile.");
        status.textContent = "Generating Profile...";
        post("generateProfile", { filenames });
      },
      onExportCsv: (filename) => {
        if (status) status.textContent = "Exporting CSV...";
        post("exportLog", { format: "csv", filename: filename });
      },
      onExportJson: (filename) => {
        if (status) status.textContent = "Exporting JSON...";
        post("exportLog", { format: "json", filename: filename });
      },
      onRowClick: (evClick, row, fname, checkCell, nameDiv) => {
        let clickedCell = evClick.target;
        while (clickedCell && clickedCell.parentNode !== row)
          clickedCell = clickedCell.parentNode;
        const cellIndex = Array.from(row.children).indexOf(clickedCell);

        if (cellIndex === 0 || cellIndex === 1) {
          const checkbox = checkCell.querySelector("input");
          if (evClick.target !== checkbox) checkbox.checked = !checkbox.checked;
          return;
        }

        // Remove other dropdowns
        document.querySelectorAll(".file-dropdown").forEach((d) => d.remove());
        document
          .querySelectorAll(".row-arrow")
          .forEach((a) => (a.textContent = "▼"));

        if (expandedFile === fname) {
          expandedFile = null;
          return;
        }

        expandedFile = fname;
        requestedDashboardFile = fname;
        const existing = document.querySelector(
          `[data-file-row="${fname}"] .meta.loading`,
        );
        if (!existing) {
          const l = document.createElement("div");
          l.className = "meta loading";
          l.textContent = "Loading...";
          nameDiv.appendChild(l);
        }
        post("openLog", { filename: fname });
      },
    };

    // helper to show summary text in both views
    function renderStudentSummaryToUI(filename, summaryText) {
      const safeId = String(filename || "").replace(/[^a-zA-Z0-9_-]/g, "_");

      // 1) Dashboard dropdown output (if open)
      const dashOut = document.getElementById(
        `student-summary-output-${safeId}`,
      );
      if (dashOut) {
        dashOut.innerHTML = `<pre style="white-space:pre-wrap; margin:0; padding:10px; border:1px solid var(--border); border-radius:6px; background:var(--bg);">${summaryText}</pre>`;
      }
    }

    // --- ROUTER (LISTEN FOR MESSAGES) ---
    window.addEventListener("message", (event) => {
      const msg = event.data || {};
      switch (msg.command) {
        case "logList":
          logNamesCache = (msg.data || []).slice().sort().reverse();
          if ($("log-count"))
            $("log-count").textContent = logNamesCache.length + " logs found";
          renderSearchDropdown(
            filterLogs((searchInput?.value || "").toLowerCase()),
          );
          break;

        case "dashboardData":
          dashboardDataCache = msg.data || null;
          UI.renderDashboard(msg.data, handlers);
          if ($("dashboard-log-name"))
            $("dashboard-log-name").textContent = "Viewing: All logs";
          if (status) status.textContent = "Dashboard updated";
          break;

        case "profileData":
          UI.renderProfile(msg.data);
          if (status) status.textContent = "Behavioral profile generated.";
          break;

        case "timelineData":
          UI.renderTimeline(msg.data);
          if (status) status.textContent = "Timeline generated.";
          break;

        case "logData":
          currentLogFilename = msg.filename;
          window.currentLogFilename = msg.filename;
          if (
            requestedDashboardFile &&
            msg.filename === requestedDashboardFile &&
            currentTab === "dashboard"
          ) {
            UI.renderDashboardFileDropdown(
              msg.data,
              msg.filename,
              currentSettings,
            );
            requestedDashboardFile = null;
            if (status) status.textContent = "Loaded " + msg.filename;
          } else {
            UI.renderParsedInLogs(
              msg.data,
              msg.filename,
              currentSettings,
              handlers,
            );
            // Load notes for this log file
            post("loadLogNotes", { filename: msg.filename });
            if (status) status.textContent = "Loaded " + msg.filename;
          }
          break;

        // ✅ NEW: Student Transparency Summary response handler
        case "studentSummary": {
          const filename = msg.filename || currentLogFilename || "";
          const summaryText =
            typeof msg.summary === "string"
              ? msg.summary
              : "No summary returned.";
          renderStudentSummaryToUI(filename, summaryText);
          if (status) status.textContent = "Student summary ready.";
          break;
        }

        case "logNotes":
          // Load notes into the event rows
          const notesMap = {};
          if (Array.isArray(msg.notes)) {
            msg.notes.forEach((note) => {
              notesMap[note.timestamp] = note.text;
            });
          }
          // Populate notes into the textareas and update visual indicators
          const eventRows = document.querySelectorAll(".event-notes-area");
          eventRows.forEach((area) => {
            const input = area.querySelector(".event-note-input");
            const eventRow = area.closest(".event");
            const timestamp = eventRow?.dataset.eventTime || "";
            if (input && notesMap[timestamp]) {
              input.value = notesMap[timestamp];
              // Update the note button visual indicator
              const noteBtn = eventRow?.querySelector(".btn-notes");
              if (noteBtn) {
                noteBtn.dataset.hasNote = "true";
                const emptyIcon = noteBtn.querySelector(".note-icon-empty");
                const filledIcon = noteBtn.querySelector(".note-icon-filled");
                if (emptyIcon && filledIcon) {
                  emptyIcon.style.display = "none";
                  filledIcon.style.display = "inline";
                }
              }
            }
          });
          break;

        case "rawData":
          if ($("logs-viewer-container"))
            $("logs-viewer-container").style.display = "block";
          if ($("logs-view"))
            $("logs-view").innerHTML = "<pre>" + msg.data + "</pre>";
          if ($("dashboard-view") && currentTab === "dashboard")
            $("dashboard-view").innerHTML =
              '<div class="card"><h2>Raw Data Only</h2><p class="meta">Score unavailable.</p></div>';
          if (status) status.textContent = "Loaded " + msg.filename;
          break;

        case "loadSettings":
          if (msg.settings) {
            currentSettings = {
              inactivity:
                msg.settings.inactivityThreshold || defaults.inactivity,
              flight: msg.settings.flightTimeThreshold || defaults.flight,
              pasteLength:
                msg.settings.pasteLengthThreshold || defaults.pasteLength,
              flagAiEvents:
                typeof msg.settings.flagAiEvents === "boolean"
                  ? msg.settings.flagAiEvents
                  : defaults.flagAiEvents,
            };
            if ($("inactivityInput"))
              $("inactivityInput").value = currentSettings.inactivity;
            if ($("flightInput"))
              $("flightInput").value = currentSettings.flight;
            if ($("pasteLengthInput"))
              $("pasteLengthInput").value = currentSettings.pasteLength;
            if ($("flagAiEvents"))
              $("flagAiEvents").checked = currentSettings.flagAiEvents;
          }
          break;

        case "settingsSaved":
          if ($("inactivityInput"))
            currentSettings.inactivity = parseInt($("inactivityInput").value);
          if ($("flightInput"))
            currentSettings.flight = parseInt($("flightInput").value);
          if ($("pasteLengthInput"))
            currentSettings.pasteLength = parseInt($("pasteLengthInput").value);
          if ($("flagAiEvents"))
            currentSettings.flagAiEvents = $("flagAiEvents").checked;
          if ($("settings-msg")) {
            $("settings-msg").textContent = "Settings saved successfully!";
            setTimeout(() => ($("settings-msg").textContent = ""), 3000);
          }
          dashboardDataCache = null;
          break;

        case "deletionData":
          try {
            const d = msg.data;
            const view = $("deletions-view");
            if (!view) break;
            if (typeof d === "string") {
              view.innerHTML = "<pre>" + d + "</pre>";
            } else {
              const records = Array.isArray(d)
                ? d
                : d && Array.isArray(d.deletions)
                  ? d.deletions
                  : null;
              const header = d && d.header ? d.header : null;
              if (header) {
                const hdrDiv = document.createElement("div");
                hdrDiv.className = "meta";
                hdrDiv.style.marginBottom = "8px";
                hdrDiv.innerHTML = `<div><strong>${header.note || "Deletion Log"}</strong></div><div class="meta">Created: ${
                  header.createdAt || header.created || ""
                }</div>`;
                view.innerHTML = "";
                view.appendChild(hdrDiv);
              } else {
                view.innerHTML = "";
              }

              if (!records || records.length === 0) {
                const empty = document.createElement("div");
                empty.className = "meta";
                empty.textContent = "No deletion records found.";
                view.appendChild(empty);
              } else {
                const list = document.createElement("div");
                list.style.display = "grid";
                list.style.gap = "10px";
                records.forEach((item) => {
                  const row = document.createElement("div");
                  row.className = "card deletion-row";
                  const inferActivityType = (entry) => {
                    if (entry.activityType)
                      return String(entry.activityType).toLowerCase();
                    if (
                      entry.deletedFile ||
                      entry.deletedAt ||
                      entry.lastKnownSize
                    )
                      return "deleted";
                    if (entry.modifiedFile || entry.modifiedAt)
                      return "modified";
                    const lowerNote = String(
                      entry.note || entry.reason || "",
                    ).toLowerCase();
                    if (
                      lowerNote.includes("manual edit") ||
                      lowerNote.includes("modified")
                    )
                      return "modified";
                    if (lowerNote.includes("deleted")) return "deleted";
                    return "activity";
                  };

                  const activityType = inferActivityType(item);
                  const actionLabel =
                    activityType === "deleted"
                      ? "Deleted"
                      : activityType === "modified"
                        ? "Modified"
                        : "Activity";
                  const time =
                    item.modifiedAt ||
                    item.deletedAt ||
                    item.time ||
                    item.timestamp ||
                    "";
                  const who =
                    item.user || item.startedBy || item.actor || "Unknown";
                  const file =
                    item.modifiedFile ||
                    item.deletedFile ||
                    item.file ||
                    item.path ||
                    item.filePath ||
                    "(unknown)";
                  const prevSize =
                    item.previousSize ||
                    item.oldSize ||
                    item.previous ||
                    item.lastKnownSize ||
                    "";
                  const newSize =
                    item.newSize ||
                    item.size ||
                    (activityType === "deleted" ? "0 KB" : "");
                  const note = item.note || item.reason || "";
                  row.innerHTML = `<div style="display:flex; flex-direction:column; gap:6px;"><div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;"><div style="font-weight:700;">${file}</div><div class="meta">${actionLabel} by ${who} • ${time}</div></div><div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">${
                    prevSize ? `<div class="meta">Prev: ${prevSize}</div>` : ""
                  }${
                    newSize ? `<div class="meta">Now: ${newSize}</div>` : ""
                  }${note ? `<div class="meta">${note}</div>` : ""}</div></div>`;
                  list.appendChild(row);
                });
                view.appendChild(list);
              }
            }
          } catch (err) {
            if ($("deletions-view"))
              $("deletions-view").textContent = "Failed to render deletions.";
          }
          if (status) status.textContent = "Deletions updated";
          break;

        case "error":
          if ($("btn-submit-class")) {
            $("btn-submit-class").disabled = false;
            $("btn-submit-class").textContent = editingClassId ? "Save Class Changes" : "Create Class";
          }
          if ($("btn-create-assignment")) {
            $("btn-create-assignment").disabled = false;
            $("btn-create-assignment").textContent = "Create Assignment";
          }
          if (status) status.textContent = "Error: " + (msg.message || "");
          if (
            msg.message &&
            (msg.message.toLowerCase().includes("mismatch") ||
              msg.message.toLowerCase().includes("sparse"))
          ) {
            alert(msg.message);
          }
          break;

        case "success":
          if (status) {
            status.textContent = msg.message;
            setTimeout(() => (status.textContent = "Ready"), 3000);
          }
          break;

        case "classList":
          renderClasses(msg.data || []);
          if (status) { status.textContent = (msg.data || []).length + " class(es) loaded"; }
          break;

        case "classCreated": {
          const btn = $("btn-submit-class");
          if (btn) { btn.disabled = false; btn.textContent = "Create Class"; }
          if ($("class-form-card")) { $("class-form-card").style.display = "none"; }
          ["class-course-name","class-course-code","class-teacher-name","class-meeting-time","class-start-date","class-end-date"].forEach((id) => { const el = $(id); if (el) { el.value = ""; } });
          if (status) { status.textContent = "Class created! Join code: " + (msg.data?.joinCode || ""); setTimeout(() => (status.textContent = "Ready"), 5000); }
          editingClassId = null;
          loadClasses();
          break;
        }

        case "classUpdated": {
          const btn = $("btn-submit-class");
          if (btn) { btn.disabled = false; btn.textContent = "Create Class"; }
          if ($("class-form-card")) { $("class-form-card").style.display = "none"; }
          ["class-course-name","class-course-code","class-teacher-name","class-meeting-time","class-start-date","class-end-date"].forEach((id) => { const el = $(id); if (el) { el.value = ""; } });
          editingClassId = null;
          if (status) { status.textContent = "Class updated successfully."; setTimeout(() => (status.textContent = "Ready"), 3000); }
          loadClasses();
          break;
        }

        case "classDetails": {
          renderClassDetails(msg.data || {});
          if (status) { status.textContent = "Class details loaded."; }
          break;
        }

        case "classAssignmentCreated": {
          const btn = $("btn-create-assignment");
          if (btn) { btn.disabled = false; btn.textContent = "Create Assignment"; }
          const errEl = $("assignment-form-error");
          if (errEl) { errEl.style.display = "none"; }
          if ($("assignment-name")) { $("assignment-name").value = ""; }
          if ($("assignment-description")) { $("assignment-description").value = ""; }
          if ($("assignment-due-date")) { $("assignment-due-date").value = ""; }
          if (currentClassId) {
            post("openClass", { classId: currentClassId });
          }
          if (status) { status.textContent = "Assignment created."; setTimeout(() => (status.textContent = "Ready"), 3000); }
          break;
        }

        case "assignmentWorkData": {
          renderAssignmentWork(msg.data || {});
          if (status) { status.textContent = "Assignment work loaded."; }
          break;
        }

        case "assignmentStudentSessions": {
          renderAssignmentStudentSessions(msg.data || {});
          if (status) { status.textContent = "Student sessions loaded."; }
          break;
        }

        case "classSessionLogData": {
          renderAssignmentSessionLog(msg.data || {});
          if (status) { status.textContent = "Session log loaded."; }
          break;
        }
      }
    });

    // --- CLASS TAB LOGIC ---
    function loadClasses() {
      const listView = $("class-list-view");
      const emptyEl = $("class-list-empty");
      const loadingEl = $("class-list-loading");
      if (loadingEl) { loadingEl.style.display = "block"; }
      if (emptyEl) { emptyEl.style.display = "none"; }
      if (listView) { listView.innerHTML = ""; }
      post("listClasses");
    }

    function setAssignmentFormVisible(show) {
      const formCard = $("assignment-form-card");
      if (!formCard) { return; }
      formCard.style.display = show ? "block" : "none";
      if (!show) {
        const errEl = $("assignment-form-error");
        if (errEl) { errEl.style.display = "none"; }
      }
    }

    function updateTopClassActionButton() {
      const btn = $("btn-new-class");
      if (!btn) { return; }

      const inClassDetail = $("class-detail-view")?.style.display === "block";
      if (inClassDetail && currentClassDetailTab === "assignments") {
        btn.textContent = "+ New Assignment";
        return;
      }

      btn.textContent = "+ New Class";
    }

    function renderClasses(classes) {
      const listView = $("class-list-view");
      const emptyEl = $("class-list-empty");
      const loadingEl = $("class-list-loading");
      const detailView = $("class-detail-view");
      if (loadingEl) { loadingEl.style.display = "none"; }
      if (detailView) { detailView.style.display = "none"; }
      currentClassDetailTab = "students";
      setAssignmentFormVisible(false);
      updateTopClassActionButton();
      if (!listView) { return; }
      listView.style.display = "grid";
      listView.innerHTML = "";
      if (!classes || classes.length === 0) {
        if (emptyEl) { emptyEl.style.display = "block"; }
        return;
      }
      if (emptyEl) { emptyEl.style.display = "none"; }
      classes.forEach((cls) => {
        const card = document.createElement("div");
        card.className = "card";
        card.style.cssText = "display:flex; flex-direction:column; gap:10px;";
        card.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div>
              <div style="font-weight:700; font-size:1rem;">${cls.courseName}</div>
              <div class="meta">${cls.courseCode} &bull; ${cls.teacherName}</div>
            </div>
            <div style="background:var(--accent); color:white; padding:4px 12px; border-radius:6px; font-size:0.8rem; font-weight:700; white-space:nowrap; letter-spacing:0.05em;">${cls.joinCode}</div>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:0.88rem;">
            <div><span style="color:var(--muted);">Meeting:</span> ${cls.meetingTime || '—'}</div>
            <div><span style="color:var(--muted);">Start:</span> ${cls.startDate || '—'}</div>
            <div></div>
            <div><span style="color:var(--muted);">End:</span> ${cls.endDate || '—'}</div>
          </div>
          <div class="meta" style="font-size:0.78rem;">Join Code: <strong style="font-family:monospace; font-size:0.9rem; color:var(--accent);">${cls.joinCode}</strong> &mdash; share this with students to link their workspace to this class.</div>
          <div style="display:flex; gap:8px; margin-top:2px;">
            <button class="btn btn-primary class-open-btn" style="padding:6px 10px;">Open Class</button>
            <button class="btn btn-secondary class-edit-btn" style="padding:6px 10px;">Edit</button>
          </div>
        `;
        const openBtn = card.querySelector(".class-open-btn");
        const editBtn = card.querySelector(".class-edit-btn");
        openBtn?.addEventListener("click", () => {
          currentClassId = cls.id;
          post("openClass", { classId: cls.id });
        });
        editBtn?.addEventListener("click", () => {
          editingClassId = cls.id;
          if ($("class-form-card")) { $("class-form-card").style.display = "block"; }
          if ($("class-course-name")) { $("class-course-name").value = cls.courseName || ""; }
          if ($("class-course-code")) { $("class-course-code").value = cls.courseCode || ""; }
          if ($("class-teacher-name")) { $("class-teacher-name").value = cls.teacherName || ""; }
          if ($("class-meeting-time")) { $("class-meeting-time").value = cls.meetingTime || ""; }
          if ($("class-start-date")) { $("class-start-date").value = cls.startDate || ""; }
          if ($("class-end-date")) { $("class-end-date").value = cls.endDate || ""; }
          const submitBtn = $("btn-submit-class");
          if (submitBtn) { submitBtn.textContent = "Save Class Changes"; }
          if (status) { status.textContent = "Editing class: " + cls.courseName; }
        });
        listView.appendChild(card);
      });
    }

    function renderClassDetails(payload) {
      const classInfo = payload.classInfo || null;
      const students = payload.students || [];
      const assignments = payload.assignments || [];
      if (!classInfo) { return; }

      currentClassId = classInfo.id;
      currentClassAssignments = assignments;

      if ($("class-list-view")) { $("class-list-view").style.display = "none"; }
      if ($("class-list-empty")) { $("class-list-empty").style.display = "none"; }
      if ($("class-detail-view")) { $("class-detail-view").style.display = "block"; }

      if ($("class-detail-title")) { $("class-detail-title").textContent = classInfo.courseName || "Class Detail"; }
      if ($("class-detail-meta")) {
        $("class-detail-meta").textContent = (classInfo.courseCode || "") + " • " + (classInfo.teacherName || "") + " • Join Code: " + (classInfo.joinCode || "");
      }

      if ($("assignment-work-view")) { $("assignment-work-view").style.display = "none"; }
      if ($("assignment-student-view")) { $("assignment-student-view").style.display = "none"; }
      if ($("assignment-session-log-view")) { $("assignment-session-log-view").style.display = "none"; }
      currentAssignmentId = null;
      currentAssignmentName = "";
      setAssignmentFormVisible(false);

      switchClassDetailTab("students");
      renderClassStudents(students);
      renderClassAssignments(assignments);
    }

    function switchClassDetailTab(tabName) {
      const studentsTab = $("class-detail-tab-students");
      const assignmentsTab = $("class-detail-tab-assignments");
      const studentsView = $("class-detail-students");
      const assignmentsView = $("class-detail-assignments");
      currentClassDetailTab = tabName;

      if (tabName === "students") {
        if (studentsView) { studentsView.style.display = "block"; }
        if (assignmentsView) { assignmentsView.style.display = "none"; }
        if (studentsTab) { studentsTab.style.background = "var(--accent)"; studentsTab.style.color = "white"; }
        if (assignmentsTab) { assignmentsTab.style.background = "var(--bg)"; assignmentsTab.style.color = "var(--muted)"; }
        setAssignmentFormVisible(false);
        updateTopClassActionButton();
        return;
      }

      if (studentsView) { studentsView.style.display = "none"; }
      if (assignmentsView) { assignmentsView.style.display = "block"; }
      if (assignmentsTab) { assignmentsTab.style.background = "var(--accent)"; assignmentsTab.style.color = "white"; }
      if (studentsTab) { studentsTab.style.background = "var(--bg)"; studentsTab.style.color = "var(--muted)"; }
      setAssignmentFormVisible(false);
      updateTopClassActionButton();
    }

    function renderClassStudents(students) {
      const table = $("class-students-table");
      const body = $("class-students-body");
      const empty = $("class-students-empty");
      if (!table || !body || !empty) { return; }

      body.innerHTML = "";
      const deduped = [];
      const seen = new Set();
      (students || []).forEach((s) => {
        const key = String(s.authUserId || "") || `${s.studentEmail || ""}|${s.studentName || ""}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(s);
        }
      });

      if (deduped.length === 0) {
        table.style.display = "none";
        empty.style.display = "block";
        return;
      }

      empty.style.display = "none";
      table.style.display = "table";

      deduped.forEach((s) => {
        const tr = document.createElement("tr");
        tr.style.borderBottom = "1px solid var(--border)";
        tr.innerHTML = `
          <td style="padding:8px;">
            <div style="font-weight:600;">${s.studentName || "Unknown Student"}</div>
            <div class="meta" style="font-size:0.78rem;">${s.studentEmail || ""}</div>
          </td>
          <td style="padding:8px;">${s.role || "Student"}</td>
        `;
        body.appendChild(tr);
      });
    }

    function renderClassAssignments(assignments) {
      const list = $("class-assignments-list");
      const empty = $("class-assignments-empty");
      if (!list || !empty) { return; }

      list.innerHTML = "";
      if (!assignments || assignments.length === 0) {
        empty.style.display = "block";
        return;
      }

      empty.style.display = "none";
      assignments.forEach((a) => {
        const card = document.createElement("div");
        card.className = "card";
        card.style.marginBottom = "0";
        card.style.padding = "12px";
        card.innerHTML = `
          <div style="font-weight:700;">${a.name}</div>
          <div class="meta" style="margin-top:4px;">${a.description || "No description"}</div>
          <div class="meta" style="margin-top:6px;">Due: ${a.dueDate || "No due date"}</div>
          <div style="margin-top:10px;">
            <button class="btn btn-primary assignment-work-btn" style="padding:6px 10px;">View Student Work</button>
          </div>
        `;
        const btn = card.querySelector(".assignment-work-btn");
        btn?.addEventListener("click", () => {
          if (!currentClassId) { return; }
          currentAssignmentId = a.id;
          currentAssignmentName = a.name || "Assignment";
          post("openAssignmentWork", { classId: currentClassId, assignmentId: a.id });
        });
        list.appendChild(card);
      });
    }

    function renderAssignmentWork(payload) {
      const assignment = payload.assignment || {};
      const students = payload.students || [];
      const view = $("assignment-work-view");
      const list = $("assignment-work-list");
      const empty = $("assignment-work-empty");
      const title = $("assignment-work-title");
      const meta = $("assignment-work-meta");
      const studentView = $("assignment-student-view");
      const logView = $("assignment-session-log-view");
      if (!view || !list || !empty || !title || !meta) { return; }

      currentAssignmentId = assignment.id || currentAssignmentId;
      currentAssignmentName = assignment.name || currentAssignmentName;

      view.style.display = "block";
      list.innerHTML = "";
      if (studentView) { studentView.style.display = "none"; }
      if (logView) { logView.style.display = "none"; }

      title.textContent = `Assignment Work: ${currentAssignmentName || "Assignment"}`;
      meta.textContent = `Students linked: ${students.length}`;

      if (!students.length) {
        empty.style.display = "block";
        return;
      }
      empty.style.display = "none";

      students.forEach((s) => {
        const card = document.createElement("button");
        card.className = "btn btn-secondary";
        card.style.cssText = "text-align:left; padding:10px; border:1px solid var(--border); background:var(--surface);";
        card.innerHTML = `
          <div style="font-weight:700;">${s.studentName || "Unknown Student"}</div>
          <div class="meta" style="font-size:0.8rem;">${s.studentEmail || ""}</div>
          <div style="margin-top:8px; display:flex; justify-content:space-between; gap:8px; font-size:0.85rem;">
            <span>Role: ${s.role || "Student"}</span>
            <span><strong>${s.sessionCount || 0}</strong> log(s)</span>
          </div>
        `;
        card.addEventListener("click", () => {
          if (!currentClassId || !currentAssignmentId) { return; }
          post("openAssignmentStudent", {
            classId: currentClassId,
            assignmentId: currentAssignmentId,
            studentAuthUserId: s.authUserId,
            studentName: s.studentName || "Unknown Student"
          });
        });
        list.appendChild(card);
      });
    }

    function renderAssignmentStudentSessions(payload) {
      const sessions = payload.sessions || [];
      const studentName = payload.studentName || "Student";
      const studentView = $("assignment-student-view");
      const title = $("assignment-student-title");
      const empty = $("assignment-student-sessions-empty");
      const list = $("assignment-student-sessions-list");
      const logView = $("assignment-session-log-view");
      if (!studentView || !title || !empty || !list) { return; }

      studentView.style.display = "block";
      title.textContent = `${studentName} - Session Logs`;
      list.innerHTML = "";
      if (logView) { logView.style.display = "none"; }

      if (!sessions.length) {
        empty.style.display = "block";
        return;
      }
      empty.style.display = "none";

      sessions.forEach((s) => {
        const row = document.createElement("button");
        row.className = "btn btn-secondary";
        row.style.cssText = "text-align:left; border:1px solid var(--border); background:var(--surface); padding:10px;";
        row.innerHTML = `
          <div style="font-weight:700;">${s.filename}</div>
          <div class="meta" style="font-size:0.8rem;">${s.workspaceName || ""} • ${s.startedAt || ""} • IDE user: ${s.ideUser || ""}</div>
        `;
        row.addEventListener("click", () => {
          post("loadClassSessionLog", { filename: s.filename });
        });
        list.appendChild(row);
      });
    }

    function renderAssignmentSessionLog(payload) {
      const title = $("assignment-session-log-title");
      const content = $("assignment-session-log-content");
      const view = $("assignment-session-log-view");
      if (!title || !content || !view) { return; }
      title.textContent = payload.filename || "Session Log";
      content.textContent = payload.text || "No log data available.";
      view.style.display = "block";
    }

    $("btn-new-class")?.addEventListener("click", () => {
      const inClassDetail = $("class-detail-view")?.style.display === "block";
      if (inClassDetail && currentClassDetailTab === "assignments") {
        setAssignmentFormVisible(true);
        return;
      }

      const classForm = $("class-form-card");
      if (classForm) {
        editingClassId = null;
        const submitBtn = $("btn-submit-class");
        if (submitBtn) { submitBtn.textContent = "Create Class"; }
        classForm.style.display = classForm.style.display === "none" ? "block" : "none";
      }
    });

    $("btn-cancel-class")?.addEventListener("click", () => {
      if ($("class-form-card")) { $("class-form-card").style.display = "none"; }
      editingClassId = null;
      const submitBtn = $("btn-submit-class");
      if (submitBtn) { submitBtn.textContent = "Create Class"; }
    });

    $("btn-back-to-classes")?.addEventListener("click", () => {
      if ($("class-detail-view")) { $("class-detail-view").style.display = "none"; }
      if ($("class-list-view")) { $("class-list-view").style.display = "grid"; }
      currentClassDetailTab = "students";
      setAssignmentFormVisible(false);
      updateTopClassActionButton();
      loadClasses();
    });

    $("btn-back-to-assignments")?.addEventListener("click", () => {
      if ($("assignment-work-view")) { $("assignment-work-view").style.display = "none"; }
      if ($("assignment-student-view")) { $("assignment-student-view").style.display = "none"; }
      if ($("assignment-session-log-view")) { $("assignment-session-log-view").style.display = "none"; }
    });

    $("btn-back-to-assignment-students")?.addEventListener("click", () => {
      if ($("assignment-student-view")) { $("assignment-student-view").style.display = "none"; }
      if ($("assignment-session-log-view")) { $("assignment-session-log-view").style.display = "none"; }
    });

    $("class-detail-tab-students")?.addEventListener("click", () => switchClassDetailTab("students"));
    $("class-detail-tab-assignments")?.addEventListener("click", () => switchClassDetailTab("assignments"));

    $("btn-create-assignment")?.addEventListener("click", () => {
      if (!currentClassId) {
        if (status) { status.textContent = "Open a class first."; }
        return;
      }

      const name = $("assignment-name")?.value?.trim();
      const description = $("assignment-description")?.value?.trim();
      const dueDate = $("assignment-due-date")?.value;
      const errEl = $("assignment-form-error");

      if (!name) {
        if (errEl) { errEl.textContent = "Assignment name is required."; errEl.style.display = "block"; }
        return;
      }

      if (errEl) { errEl.style.display = "none"; }
      const btn = $("btn-create-assignment");
      if (btn) { btn.disabled = true; btn.textContent = "Creating..."; }

      post("createClassAssignment", {
        classId: currentClassId,
        name,
        description: description || "",
        dueDate: dueDate || ""
      });
    });

    $("btn-submit-class")?.addEventListener("click", () => {
      const courseName = $("class-course-name")?.value?.trim();
      const courseCode = $("class-course-code")?.value?.trim();
      const teacherName = $("class-teacher-name")?.value?.trim();
      const meetingTime = $("class-meeting-time")?.value?.trim();
      const startDate = $("class-start-date")?.value;
      const endDate = $("class-end-date")?.value;
      const errEl = $("class-form-error");

      if (!courseName || !courseCode || !teacherName || !startDate || !endDate) {
        if (errEl) { errEl.textContent = "Course Name, Course Code, Teacher Name, Start Date, and End Date are required."; errEl.style.display = "block"; }
        return;
      }
      if (startDate > endDate) {
        if (errEl) { errEl.textContent = "End Date must be on or after Start Date."; errEl.style.display = "block"; }
        return;
      }
      if (errEl) { errEl.style.display = "none"; }

      const btn = $("btn-submit-class");
      if (btn) { btn.disabled = true; btn.textContent = "Creating..."; }
      if (editingClassId) {
        post("updateClass", { classId: editingClassId, courseName, courseCode, teacherName, meetingTime: meetingTime || '', startDate, endDate });
        if (btn) { btn.textContent = "Saving..."; }
      } else {
        post("createClass", { courseName, courseCode, teacherName, meetingTime: meetingTime || '', startDate, endDate });
      }
    });

    // --- STARTUP LOGIC ---
    switchTab("dashboard");
    showDashboardLoading();
    post("clientReady");
    post("analyzeLogs");
    post("listLogs");
    post("getSettings");
  });
})();
