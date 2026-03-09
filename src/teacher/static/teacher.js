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
