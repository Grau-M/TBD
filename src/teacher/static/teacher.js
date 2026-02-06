/* Webview client script for Teacher View - cleaned and defensive */
(function () {
  const vscode = acquireVsCodeApi();

  // state
  let logNamesCache = [];
  const defaults = { inactivity: 5, flight: 50, pasteLength: 50 };
  let currentSettings = { ...defaults };
  let currentTab = "dashboard";
  let requestedDashboardFile = null; // filename requested to show in dashboard per-file dropdown
  let expandedFile = null; // filename currently expanded in dashboard

  // Helper: Format milliseconds into human readable string
  function formatDuration(ms) {
    if (!ms || ms < 0) return "0m";
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  // Helper: Parse Log Timestamp "Feb-04-2026 17:51:19:284 EST" -> timestamp
  function parseLogTime(timeStr) {
    if (!timeStr) return null;
    // Remove time zone suffix if present (e.g. " EST")
    const cleanStr = timeStr.replace(/ [A-Z]{3,4}$/, "");
    const parts = cleanStr.split(" ");
    if (parts.length < 2) return null;

    const datePart = parts[0]; // "Feb-04-2026"
    const timePart = parts[1]; // "17:51:19:284"

    // Parse Month-Day-Year
    const dateSub = datePart.split("-");
    if (dateSub.length < 3) return null;

    const monthStr = dateSub[0];
    const months = {
      Jan: 0,
      Feb: 1,
      Mar: 2,
      Apr: 3,
      May: 4,
      Jun: 5,
      Jul: 6,
      Aug: 7,
      Sep: 8,
      Oct: 9,
      Nov: 10,
      Dec: 11,
    };
    const month =
      months[monthStr] !== undefined
        ? months[monthStr]
        : parseInt(monthStr) - 1;
    const day = parseInt(dateSub[1]);
    const year = parseInt(dateSub[2]);

    // Parse HH:MM:SS:MS
    const timeSub = timePart.split(":");
    const hr = parseInt(timeSub[0]);
    const min = parseInt(timeSub[1]);
    const sec = parseInt(timeSub[2]);
    const ms = timeSub[3] ? parseInt(timeSub[3]) : 0;

    return new Date(year, month, day, hr, min, sec, ms).getTime();
  }

  // wait for DOM to be ready
  window.addEventListener("DOMContentLoaded", () => {
    // element helpers
    const $ = (id) => document.getElementById(id);

    // DOM refs
    const searchInput = $("log-search-input");
    const dropdown = $("log-dropdown");
    const logCountLabel = $("log-count");
    const refreshBtn = $("refresh-logs");
    const status = $("status");

    const dashboardView = $("dashboard-view");
    const dashboardEmpty = $("dashboard-empty");
    const dashboardLogName = $("dashboard-log-name");

    const logsView = $("logs-view");
    const logsViewerContainer = $("logs-viewer-container");
    const logsLogName = $("logs-log-name");

    const inactivityInput = $("inactivityInput");
    const flightInput = $("flightInput");
    const pasteLengthInput = $("pasteLengthInput");
    const settingsMsg = $("settings-msg");

    const themeToggle = $("themeToggle");

    function switchTab(tabName) {
      document
        .querySelectorAll(".tab-pane")
        .forEach((el) => el.classList.remove("active"));
      document
        .querySelectorAll(".tab-btn")
        .forEach((el) => el.classList.remove("active"));
      const pane = document.getElementById(tabName + "-tab");
      if (pane) pane.classList.add("active");
      const btn = document.getElementById("nav-" + tabName);
      if (btn) btn.classList.add("active");
      currentTab = tabName;
    }

    function post(command, payload = {}) {
      try {
        vscode.postMessage(Object.assign({ command }, payload));
      } catch (e) {
        /* noop */
      }
    }

    // attach nav buttons
    const navDashboard = $("nav-dashboard");
    if (navDashboard)
      navDashboard.addEventListener("click", () => {
        switchTab("dashboard");
        post("analyzeLogs");
      });
    const navLogs = $("nav-logs");
    if (navLogs)
      navLogs.addEventListener("click", () => {
        switchTab("logs");
        post("listLogs");
      });
    const navSettings = $("nav-settings");
    if (navSettings)
      navSettings.addEventListener("click", () => {
        switchTab("settings");
      });
    const btnGotoLogs = $("btn-goto-logs");
    if (btnGotoLogs)
      btnGotoLogs.addEventListener("click", () => switchTab("logs"));

    const closeLogBtn = $("close-log");
    if (closeLogBtn)
      closeLogBtn.addEventListener("click", () => {
        if (logsViewerContainer) logsViewerContainer.style.display = "none";
        if (logsView) logsView.innerHTML = "";
        if (logsLogName) logsLogName.textContent = "";
        if (searchInput) searchInput.value = "";
      });

    // theme logic
    let isDark = false;
    try {
      const st =
        typeof vscode.getState === "function" ? vscode.getState() : undefined;
      if (st && st.theme === "dark") isDark = true;
      else if (document.documentElement.classList.contains("dark"))
        isDark = true;
      else if (
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
      )
        isDark = true;
    } catch (e) {
      isDark =
        document.documentElement.classList.contains("dark") ||
        (window.matchMedia &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);
    }
    if (isDark) document.documentElement.classList.add("dark");
    if (themeToggle) themeToggle.textContent = isDark ? "🌙" : "☀️";
    if (themeToggle)
      themeToggle.addEventListener("click", () => {
        document.documentElement.classList.toggle("dark");
        isDark = !isDark;
        themeToggle.textContent = isDark ? "🌙" : "☀️";
        if (vscode.setState)
          try {
            vscode.setState({ theme: isDark ? "dark" : "light" });
          } catch (e) {}
      });

    function renderDropdown(items) {
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
          openLogFile(name);
        });
        dropdown.appendChild(div);
      });
    }

    function openLogFile(filename) {
      if (searchInput) searchInput.value = filename;
      if (dropdown) dropdown.classList.remove("show");
      if (status) status.textContent = "Decrypting " + filename + "...";
      post("openLog", { filename });
    }

    // --- Helper: Filter Logs ---
    function filterLogs(term) {
      return logNamesCache.filter((n) => {
        const name = n.toLowerCase();
        return name.includes(term) && name.endsWith(".log");
      });
    }

    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        const term = ((e.target && e.target.value) || "").toLowerCase();
        const filtered = filterLogs(term);
        renderDropdown(filtered);
        if (dropdown) dropdown.classList.add("show");
      });
      searchInput.addEventListener("focus", () => {
        const term = (searchInput.value || "").toLowerCase();
        const filtered = filterLogs(term);
        renderDropdown(filtered);
        if (dropdown) dropdown.classList.add("show");
      });
    }

    document.addEventListener("click", (e) => {
      if (
        searchInput &&
        dropdown &&
        !searchInput.contains(e.target) &&
        !dropdown.contains(e.target)
      )
        dropdown.classList.remove("show");

      const filesSection = document.getElementById("per-file-section");
      if (filesSection) {
        const targetIsRow =
          e.target && e.target.closest && e.target.closest("[data-file-row]");
        const targetIsDropdown =
          e.target && e.target.closest && e.target.closest(".file-dropdown");
        if (!targetIsRow && !targetIsDropdown) {
          if (expandedFile) {
            const prev = document.querySelector(
              `[data-file-row="${expandedFile}"]`,
            );
            if (
              prev &&
              prev.nextSibling &&
              prev.nextSibling.classList &&
              prev.nextSibling.classList.contains("file-dropdown")
            )
              prev.nextSibling.remove();
            expandedFile = null;
          }
        }
      }
    });

    if (refreshBtn)
      refreshBtn.addEventListener("click", () => {
        if (status) status.textContent = "Refreshing list...";
        post("listLogs");
      });

    // --- RENDER LOGIC ---
    function renderParsedInLogs(parsed, filename) {
      if (logsView) logsView.innerHTML = "";
      if (dashboardEmpty) dashboardEmpty.style.display = "none";
      if (logsViewerContainer) logsViewerContainer.style.display = "block";
      if (logsLogName) logsLogName.textContent = "Event Log: " + filename;

      let totalEvents = 0,
        flaggedEvents = 0,
        integrityScore = 100;

      if (parsed && Array.isArray(parsed.events)) {
        totalEvents = parsed.events.length;
        parsed.events.forEach((e) => {
          let flagged = false;
          if (e.eventType === "paste") {
            const len =
              typeof e.length === "number"
                ? e.length
                : typeof e.pasteLength === "number"
                  ? e.pasteLength
                  : typeof e.pasteCharCount === "number"
                    ? e.pasteCharCount
                    : typeof e.text === "string"
                      ? e.text.length
                      : null;

            if (len !== null && len > currentSettings.pasteLength)
              flagged = true;
            else if (len === null) flagged = true;
          }
          if (
            e.eventType === "input" &&
            e.flightTime &&
            parseInt(e.flightTime) < currentSettings.flight
          )
            flagged = true;
          if (flagged) flaggedEvents++;
        });
        if (totalEvents > 0) {
          const ratio = flaggedEvents / totalEvents;
          integrityScore = Math.max(0, Math.round((1 - ratio) * 100));
        }
      }

      let scoreColor = "#10b981";
      if (integrityScore < 85) scoreColor = "#f59e0b";
      if (integrityScore < 50) scoreColor = "#ef4444";

      if (logsView) {
        const scoreDiv = document.createElement("div");
        scoreDiv.className = "card";
        scoreDiv.style.borderLeft = "6px solid " + scoreColor;
        scoreDiv.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <h2 style="margin:0; font-size:2rem; color:${scoreColor}">${integrityScore}%</h2>
              <div class="meta" style="font-size:1rem;">Integrity Score</div>
            </div>
            <div style="text-align:right;">
              <div style="font-weight:600; font-size:1.2rem;">${flaggedEvents} <span style="font-weight:400; color:var(--muted)">/ ${totalEvents}</span></div>
              <div class="meta">Flagged Events</div>
            </div>
          </div>
          <div class="meta" style="margin-top:12px; border-top:1px solid var(--border); padding-top:8px;">
            Score affected by <strong style="color:#f59e0b">Suspicious Pastes (&gt; ${currentSettings.pasteLength} chars)</strong> and <strong style="color:#8b5cf6">Fast Typing (&lt; ${currentSettings.flight}ms)</strong>.
          </div>
        `;
        logsView.appendChild(scoreDiv);

        if (parsed.sessionHeader) {
          const h = parsed.sessionHeader;
          const headerDiv = document.createElement("div");
          headerDiv.className = "card";
          headerDiv.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
              <div>
                <h2>Session ${h.sessionNumber || ""}</h2>
                <div class="meta">User: ${h.startedBy || "N/A"}</div>
                <div class="meta">Workspace: ${h.project || "N/A"}</div>
              </div>
              <div style="text-align:right; display:flex; flex-direction:column; gap:8px; align-items:flex-end;">
                <div class="meta">${h.startTime ? new Date(h.startTime).toLocaleString() : ""}</div>
                <div class="meta">VS Code: ${(h.metadata && h.metadata.vscodeVersion) || "N/A"}</div>
                <div class="btn-group" style="display:flex; gap:8px; margin-top:8px;">
                   <button class="btn btn-secondary" id="btn-export-json">Export JSON</button>
                   <button class="btn btn-primary" id="btn-export-csv">Export CSV</button>
                </div>
              </div>
            </div>
          `;
          logsView.appendChild(headerDiv);

          const btnCsv = headerDiv.querySelector("#btn-export-csv");
          const btnJson = headerDiv.querySelector("#btn-export-json");
          if (btnCsv)
            btnCsv.addEventListener("click", () => {
              if (status) status.textContent = "Exporting CSV...";
              post("exportLog", { format: "csv", filename: filename });
            });
          if (btnJson)
            btnJson.addEventListener("click", () => {
              if (status) status.textContent = "Exporting JSON...";
              post("exportLog", { format: "json", filename: filename });
            });
        }
      }

      if (logsView && parsed && Array.isArray(parsed.events)) {
        const container = document.createElement("div");

        // Helper to format file paths
        const formatFilePath = (p) => {
          if (!p || typeof p !== "string") return p;
          const project =
            (parsed && parsed.sessionHeader && parsed.sessionHeader.project) ||
            null;
          if (project) {
            const idx = p.indexOf(project);
            if (idx !== -1) {
              let rel = p.substring(idx + project.length);
              rel = rel.replace(/^\\+|^\/+/, "");
              return rel || project;
            }
          }
          const parts = p.split(/\\|\//);
          return parts[parts.length - 1] || p;
        };

        const inactivityLimitMs = (currentSettings.inactivity || 5) * 60 * 1000;

        // We need to process chronologically to check gaps, but display reversed (newest first).
        // Strategy: Process normal order, build row list, then reverse and append.
        const events = parsed.events;
        const rowElements = [];

        let previousTime = null;

        for (let i = 0; i < events.length; i++) {
          const e = events[i];
          const row = document.createElement("div");
          let className = "event";
          let flagReason = "";

          // --- INACTIVITY CHECK ---
          const currentTime = parseLogTime(e.time);
          if (previousTime !== null && currentTime !== null) {
            const gap = currentTime - previousTime;
            if (gap > inactivityLimitMs) {
              // Create a separate ALERT ROW for the inactivity gap
              const gapRow = document.createElement("div");
              gapRow.className = "event";
              gapRow.style.borderLeft = "4px solid #ef4444";
              gapRow.style.backgroundColor = "rgba(239, 68, 68, 0.1)"; // Light red bg
              gapRow.innerHTML = `
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <strong style="color:#ef4444">⚠️ Major Focus Away Time</strong>
                            <span class="meta" style="color:#ef4444; font-weight:bold;">${formatDuration(gap)}</span>
                        </div>
                        <div class="meta">Student was inactive for > ${currentSettings.inactivity} mins.</div>
                    `;
              rowElements.push(gapRow);
            }
          }
          if (currentTime) previousTime = currentTime;
          // ------------------------

          // 1. Paste Check
          if (e.eventType === "paste") {
            const len =
              typeof e.length === "number"
                ? e.length
                : typeof e.pasteLength === "number"
                  ? e.pasteLength
                  : typeof e.pasteCharCount === "number"
                    ? e.pasteCharCount
                    : typeof e.text === "string"
                      ? e.text.length
                      : null;

            if (len !== null && len > currentSettings.pasteLength) {
              className += " paste";
              flagReason = "(Large Paste)";
            } else if (len === null) {
              className += " paste";
            }
          }

          // 2. Flight Check
          if (
            e.eventType === "input" &&
            e.flightTime &&
            parseInt(e.flightTime) < currentSettings.flight
          ) {
            className += " fast";
            flagReason = "(Fast Input)";
          }

          row.className = className;
          let html = `<div style="display:flex; justify-content:space-between;"><div><strong>${e.eventType || "Unknown"}</strong> ${flagReason}</div><span class="meta">${e.time || ""}</span></div>`;

          // 3. Metadata Rendering
          Object.keys(e).forEach((k) => {
            if (["eventType", "time"].includes(k)) return;
            let val = e[k];
            if (
              k === "fileEdit" ||
              k === "fileView" ||
              k === "file" ||
              k === "filePath"
            ) {
              val = formatFilePath(val);
            }
            try {
              if (typeof val === "object") val = JSON.stringify(val);
            } catch (err) {}
            html += `<div class="meta">${k}: ${val}</div>`;
          });

          row.innerHTML = html;
          rowElements.push(row);
        }

        // Display Newest First (Reverse the chronological list we just built)
        rowElements.reverse().forEach((r) => container.appendChild(r));
        if (logsView) logsView.appendChild(container);
      }
    }

    function renderDashboardFileDropdown(parsed, filename) {
      const filesSection = document.getElementById("per-file-section");
      if (!filesSection) return;
      if (expandedFile && expandedFile !== filename) {
        const prev = document.querySelector(
          `[data-file-row="${expandedFile}"]`,
        );
        if (
          prev &&
          prev.nextSibling &&
          prev.nextSibling.classList &&
          prev.nextSibling.classList.contains("file-dropdown")
        )
          prev.nextSibling.remove();
      }
      expandedFile = filename;
      const row = document.querySelector(`[data-file-row="${filename}"]`);
      if (!row) return;
      const loadIndicator = row.querySelector(".meta.loading");
      if (loadIndicator) loadIndicator.remove();
      if (
        row.nextSibling &&
        row.nextSibling.classList &&
        row.nextSibling.classList.contains("file-dropdown")
      ) {
        row.nextSibling.remove();
        expandedFile = null;
        return;
      }
      const dropdown = document.createElement("div");
      dropdown.className = "file-dropdown card";
      dropdown.style.marginTop = "8px";
      let total = (parsed.events && parsed.events.length) || 0;
      let flagged = 0;
      if (parsed.events)
        parsed.events.forEach((e) => {
          if (e.eventType === "paste") {
            const len =
              typeof e.length === "number"
                ? e.length
                : typeof e.pasteLength === "number"
                  ? e.pasteLength
                  : typeof e.pasteCharCount === "number"
                    ? e.pasteCharCount
                    : typeof e.text === "string"
                      ? e.text.length
                      : null;
            if (len === null || len > currentSettings.pasteLength) flagged++;
          }
          if (
            e.eventType === "input" &&
            e.flightTime &&
            parseInt(e.flightTime) < currentSettings.flight
          )
            flagged++;
        });
      const score =
        total > 0 ? Math.max(0, Math.round((1 - flagged / total) * 100)) : 100;
      dropdown.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center;"><div><strong>${filename}</strong><div class='meta'>${total} events</div></div><div style='text-align:right'><div style='font-weight:700'>${score}%</div><div class='meta'>${flagged} flagged</div></div></div>`;
      row.parentNode.insertBefore(dropdown, row.nextSibling);
    }

    function renderDashboard(data) {
      const container = $("dashboard-view");
      if (container) container.innerHTML = "";
      if (dashboardEmpty) dashboardEmpty.style.display = "none";
      if (!data || !data.metrics) {
        if (container)
          container.innerHTML = '<div class="meta">No data available.</div>';
        return;
      }
      const m = data.metrics;

      const top = document.createElement("div");
      top.style.display = "grid";
      top.style.gridTemplateColumns = "1fr 1fr 1fr";
      top.style.gap = "12px";
      const makeCard = (title, value, subtitle) => {
        const c = document.createElement("div");
        c.className = "card";
        c.style.padding = "12px";
        c.innerHTML = `<div style="font-weight:700; font-size:1.1rem;">${value}</div><div class="meta">${title}${subtitle ? " • " + subtitle : ""}</div>`;
        return c;
      };
      top.appendChild(makeCard("AI Probability", m.aiProbability + "%"));
      top.appendChild(makeCard("Paste %", m.pasteRatio + "%", "of all events"));
      top.appendChild(
        makeCard("Delete %", m.deleteRatio + "%", "of all events"),
      );
      const statsRow = document.createElement("div");
      statsRow.style.display = "flex";
      statsRow.style.gap = "12px";
      statsRow.style.marginTop = "12px";
      statsRow.appendChild(
        makeCard("Avg Paste Length", m.avgPasteLength + " chars"),
      );
      statsRow.appendChild(
        makeCard(
          "Totals",
          data.totalLogs + " logs • " + data.totalEvents + " events",
        ),
      );
      const barCard = document.createElement("div");
      barCard.className = "card";
      barCard.style.padding = "12px";
      barCard.innerHTML =
        '<div style="font-weight:700; margin-bottom:8px;">AI Probability</div>';
      const barOuter = document.createElement("div");
      barOuter.style.background = "var(--bg)";
      barOuter.style.border = "1px solid var(--border)";
      barOuter.style.borderRadius = "8px";
      barOuter.style.height = "18px";
      const barInner = document.createElement("div");
      barInner.style.height = "100%";
      barInner.style.width = m.aiProbability + "%";
      barInner.style.background =
        "linear-gradient(90deg, var(--accent), var(--accent-2))";
      barInner.style.borderRadius = "8px";
      barOuter.appendChild(barInner);
      barCard.appendChild(barOuter);
      if (container) {
        container.appendChild(top);
        container.appendChild(statsRow);
        container.appendChild(barCard);
      }

      // per-file
      if (container) {
        const filesCard = document.createElement("div");
        filesCard.className = "card";
        filesCard.style.marginTop = "12px";
        filesCard.innerHTML = "<h2>Per-file breakdown</h2>";
        const filesSection = document.createElement("div");
        filesSection.id = "per-file-section";
        filesSection.style.marginTop = "8px";
        const header = document.createElement("div");
        header.style.display = "grid";
        header.style.gridTemplateColumns = "2fr 1fr 1fr 1fr";
        header.style.fontWeight = "700";
        header.style.gap = "8px";
        header.innerHTML =
          "<div>File</div><div>Events</div><div>Paste</div><div>Delete</div>";
        filesSection.appendChild(header);
        (data.perFile || []).forEach((f) => {
          const row = document.createElement("div");
          row.style.display = "grid";
          row.style.gridTemplateColumns = "2fr 1fr 1fr 1fr";
          row.style.gap = "8px";
          row.style.padding = "8px 4px";
          row.setAttribute("data-file-row", f.name || "");
          row.style.cursor = "pointer";
          const name = document.createElement("div");
          name.textContent = f.name || (f.error ? "(failed)" : "unknown");
          const ev = document.createElement("div");
          ev.textContent = f.events ? String(f.events) : "-";
          const p = document.createElement("div");
          p.textContent = f.events
            ? Math.round(((f.paste || 0) / Math.max(1, f.events)) * 1000) / 10 +
              "%"
            : f.error
              ? "err"
              : "-";
          const d = document.createElement("div");
          d.textContent = f.events
            ? Math.round(((f.delete || 0) / Math.max(1, f.events)) * 1000) /
                10 +
              "%"
            : f.error
              ? "err"
              : "-";
          row.appendChild(name);
          row.appendChild(ev);
          row.appendChild(p);
          row.appendChild(d);
          row.addEventListener("click", (evClick) => {
            evClick.stopPropagation();
            const fname = f.name;
            if (expandedFile === fname) {
              const prev = document.querySelector(
                `[data-file-row="${expandedFile}"]`,
              );
              if (
                prev &&
                prev.nextSibling &&
                prev.nextSibling.classList &&
                prev.nextSibling.classList.contains("file-dropdown")
              )
                prev.nextSibling.remove();
              expandedFile = null;
              return;
            }
            requestedDashboardFile = fname;
            const loading = document.createElement("div");
            loading.className = "meta loading";
            loading.textContent = "Loading...";
            const existing = document.querySelector(
              `[data-file-row="${fname}"] .meta.loading`,
            );
            if (!existing) name.appendChild(loading);
            post("openLog", { filename: fname });
          });
          filesSection.appendChild(row);
        });
        filesCard.appendChild(filesSection);
        container.appendChild(filesCard);
      }
    }

    function showDashboardLoading() {
      const container = $("dashboard-view");
      if (dashboardEmpty) dashboardEmpty.style.display = "none";
      if (!container) return;
      container.innerHTML = "";
      const card = document.createElement("div");
      card.className = "card";
      card.style.textAlign = "center";
      card.innerHTML =
        '<div style="font-weight:700; margin-bottom:8px;">Loading dashboard</div>';
      const spinner = document.createElement("div");
      spinner.className = "spinner";
      card.appendChild(spinner);
      container.appendChild(card);
    }

    // actions
    const refreshDashboardBtn = $("refreshDashboard");
    if (refreshDashboardBtn)
      refreshDashboardBtn.addEventListener("click", () => {
        if (status) status.textContent = "Analyzing logs...";
        showDashboardLoading();
        post("analyzeLogs");
      });
    const saveSettingsBtn = $("saveSettings");
    if (saveSettingsBtn)
      saveSettingsBtn.addEventListener("click", () => {
        const settings = {
          inactivityThreshold: parseInt(
            inactivityInput?.value || defaults.inactivity,
          ),
          flightTimeThreshold: parseInt(flightInput?.value || defaults.flight),
          pasteLengthThreshold: parseInt(
            pasteLengthInput?.value || defaults.pasteLength,
          ),
        };
        post("saveSettings", { settings });
      });
    const resetSettingsBtn = $("resetSettings");
    if (resetSettingsBtn)
      resetSettingsBtn.addEventListener("click", () => {
        if (inactivityInput) inactivityInput.value = defaults.inactivity;
        if (flightInput) flightInput.value = defaults.flight;
        if (pasteLengthInput) pasteLengthInput.value = defaults.pasteLength;
        post("saveSettings", { settings: defaults });
      });

    // messages from extension
    window.addEventListener("message", (event) => {
      const msg = event.data || {};
      switch (msg.command) {
        case "logList":
          logNamesCache = (msg.data || []).slice().sort().reverse();
          if (logCountLabel)
            logCountLabel.textContent = logNamesCache.length + " logs found";
          if (searchInput) {
            const term = (searchInput.value || "").toLowerCase();
            renderDropdown(filterLogs(term));
          } else {
            renderDropdown(filterLogs(""));
          }
          break;
        case "logData":
          if (
            requestedDashboardFile &&
            msg.filename === requestedDashboardFile &&
            currentTab === "dashboard"
          ) {
            try {
              renderDashboardFileDropdown(msg.data, msg.filename);
            } catch (e) {}
            requestedDashboardFile = null;
            if (status) status.textContent = "Loaded " + msg.filename;
            break;
          }
          try {
            renderParsedInLogs(msg.data, msg.filename);
          } catch (e) {}
          if (status) status.textContent = "Loaded " + msg.filename;
          break;
        case "dashboardData":
          renderDashboard(msg.data);
          if (dashboardLogName)
            dashboardLogName.textContent = "Viewing: All logs";
          if (status) status.textContent = "Dashboard updated";
          break;
        case "rawData":
          if (logsViewerContainer) logsViewerContainer.style.display = "block";
          if (logsView) logsView.innerHTML = "<pre>" + msg.data + "</pre>";
          if (dashboardView)
            dashboardView.innerHTML =
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
            };
            if (inactivityInput)
              inactivityInput.value = currentSettings.inactivity;
            if (flightInput) flightInput.value = currentSettings.flight;
            if (pasteLengthInput)
              pasteLengthInput.value = currentSettings.pasteLength;
          }
          break;
        case "settingsSaved":
          if (inactivityInput)
            currentSettings.inactivity = parseInt(inactivityInput.value);
          if (flightInput) currentSettings.flight = parseInt(flightInput.value);
          if (pasteLengthInput)
            currentSettings.pasteLength = parseInt(pasteLengthInput.value);
          if (settingsMsg) {
            settingsMsg.textContent = "Settings saved successfully!";
            setTimeout(() => (settingsMsg.textContent = ""), 3000);
          }
          break;
        case "error":
          if (status) status.textContent = "Error: " + (msg.message || "");
          break;
        case "success":
          if (status) {
            status.textContent = msg.message;
            setTimeout(() => (status.textContent = "Ready"), 3000);
          }
          break;
      }
    });

    // startup
    try {
      switchTab("dashboard");
    } catch (e) {}
    try {
      if (dashboardEmpty) dashboardEmpty.style.display = "none";
    } catch (e) {}
    try {
      if (typeof showDashboardLoading === "function") showDashboardLoading();
    } catch (e) {}
    post("clientReady");
    post("analyzeLogs");
    post("listLogs");
    post("getSettings");
  });
})();
