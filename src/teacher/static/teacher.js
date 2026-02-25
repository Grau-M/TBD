/* Webview client script for Teacher View - cleaned and defensive */
(function () {
  const vscode = acquireVsCodeApi();

  // state
  let logNamesCache = [];
  const defaults = { inactivity: 5, flight: 50, pasteLength: 50 };
  let currentSettings = { ...defaults };
  let currentTab = "dashboard";
  let requestedDashboardFile = null;
  let expandedFile = null;

  function formatDuration(ms) {
    if (!ms || ms < 0) return "0m";
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  function parseLogTime(timeStr) {
    if (!timeStr) return null;
    const cleanStr = timeStr.replace(/ [A-Z]{3,4}$/, "");
    const parts = cleanStr.split(" ");
    if (parts.length < 2) return null;

    const datePart = parts[0];
    const timePart = parts[1];

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

    const timeSub = timePart.split(":");
    const hr = parseInt(timeSub[0]);
    const min = parseInt(timeSub[1]);
    const sec = parseInt(timeSub[2]);
    const ms = timeSub[3] ? parseInt(timeSub[3]) : 0;

    return new Date(year, month, day, hr, min, sec, ms).getTime();
  }

  // wait for DOM to be ready
  window.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);

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

    // Deletions View
    const deletionsView = $("deletions-view");

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
      } catch (e) {}
    }

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

    const navDeletions = $("nav-deletions");
    if (navDeletions)
      navDeletions.addEventListener("click", () => {
        switchTab("deletions");
        post("getDeletions");
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

    const refreshDeletionsBtn = $("refreshDeletions");
    if (refreshDeletionsBtn)
      refreshDeletionsBtn.addEventListener("click", () => {
        if (status) status.textContent = "Fetching deletions...";
        post("getDeletions");
      });

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

    function filterLogs(term) {
      return logNamesCache.filter((n) => {
        const name = n.toLowerCase();
        return name.includes(term) && name.endsWith(".log");
      });
    }

    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        const term = ((e.target && e.target.value) || "").toLowerCase();
        renderDropdown(filterLogs(term));
        if (dropdown) dropdown.classList.add("show");
      });
      searchInput.addEventListener("focus", () => {
        const term = (searchInput.value || "").toLowerCase();
        renderDropdown(filterLogs(term));
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
            if (prev) {
              const arrowCell = prev.querySelector(".row-arrow");
              if (arrowCell) arrowCell.textContent = "▼";
              if (
                prev.nextSibling &&
                prev.nextSibling.classList &&
                prev.nextSibling.classList.contains("file-dropdown")
              )
                prev.nextSibling.remove();
            }
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

    // --- RENDER LOGS TAB ---
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
        const events = parsed.events;
        const rowElements = [];
        let previousTime = null;

        for (let i = 0; i < events.length; i++) {
          const e = events[i];
          const row = document.createElement("div");
          let className = "event";
          let flagReason = "";

          const currentTime = parseLogTime(e.time);
          if (previousTime !== null && currentTime !== null) {
            const gap = currentTime - previousTime;
            if (gap > inactivityLimitMs) {
              const gapRow = document.createElement("div");
              gapRow.className = "event";
              gapRow.style.borderLeft = "4px solid #ef4444";
              gapRow.style.backgroundColor = "rgba(239, 68, 68, 0.1)";
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

        rowElements.reverse().forEach((r) => container.appendChild(r));
        if (logsView) logsView.appendChild(container);
      }
    }

    // --- BEHAVIORAL PROFILE RENDERER ---
    function renderProfile(data) {
      let pCard = document.getElementById("profile-card");
      if (!pCard) {
        pCard = document.createElement("div");
        pCard.id = "profile-card";
        pCard.className = "card";
        pCard.style.borderLeft = "6px solid var(--accent-2)";
        pCard.style.marginTop = "12px";

        const dashboardView = $("dashboard-view");
        const filesSection = document.getElementById("per-file-section");
        if (dashboardView && filesSection) {
          dashboardView.insertBefore(pCard, filesSection.parentElement);
        } else if (dashboardView) {
          dashboardView.appendChild(pCard);
        }
      }

      pCard.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <h2 style="margin:0; color:var(--accent-2);">Behavioral Profile: ${data.user}</h2>
                    <div class="meta">Project: ${data.project} &nbsp;|&nbsp; Sessions Analyzed: ${data.sessionsAnalyzed} &nbsp;|&nbsp; Active Time: ${data.totalActiveMins} mins &nbsp;|&nbsp; <strong>Total Time in VS Code: ${data.totalWallMins} mins</strong></div>
                </div>
                <button id="close-profile" class="btn btn-secondary" style="padding:4px 8px;">Close</button>
            </div>
            
            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:16px; margin-top:20px;">
                <div>
                    <div style="font-weight:700; font-size:1.5rem;">${data.wpm}</div>
                    <div class="meta">Avg WPM</div>
                </div>
                <div>
                    <div style="font-weight:700; font-size:1.5rem;">${data.editRate}</div>
                    <div class="meta">Edits/min (Code Churn)</div>
                </div>
                <div>
                    <div style="font-weight:700; font-size:1.5rem;">${data.pasteFreq}</div>
                    <div class="meta">Pastes/hr</div>
                </div>
                
                <div>
                    <div style="font-weight:700; font-size:1.5rem;">${data.avgPauseMs > 0 ? (data.avgPauseMs / 1000).toFixed(1) + "s" : "N/A"}</div>
                    <div class="meta">Avg Micro-Pause (Thinking Time)</div>
                </div>
                <div>
                    <div style="font-weight:700; font-size:1.5rem;">${data.internalPasteRatio}% <span style="font-size:1rem; color:var(--muted)">Int</span> / ${data.externalPasteRatio}% <span style="font-size:1rem; color:var(--muted)">Ext</span></div>
                    <div class="meta">Internal vs External Paste Ratio</div>
                </div>
                <div>
                    <div style="font-weight:700; font-size:1.5rem;">${data.debugRunFreq}</div>
                    <div class="meta">Terminal Runs/hr (Testing Freq)</div>
                </div>
            </div>
            
            <div class="meta" style="margin-top:16px; border-top:1px solid var(--border); padding-top:12px;">
                <strong>Pedagogical Insight:</strong> This establishes the student's unique workflow. Frequent terminal runs indicate iterative testing. High internal paste ratio indicates normal refactoring, while high external paste ratio indicates sourcing outside code.
            </div>
        `;

      document
        .getElementById("close-profile")
        .addEventListener("click", () => pCard.remove());
    }

    // --- DASHBOARD AGGREGATE RENDERER ---
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
      top.style.gridTemplateColumns = "1fr 1fr 1fr 1fr";
      top.style.gap = "12px";
      const makeCard = (title, value, subtitle) => {
        const c = document.createElement("div");
        c.className = "card";
        c.style.padding = "12px";
        c.innerHTML = `<div style="font-weight:700; font-size:1.1rem;">${value}</div><div class="meta">${title}${subtitle ? " • " + subtitle : ""}</div>`;
        return c;
      };

      let efficiency = 0;
      if (data.totalWallTime > 0)
        efficiency = Math.round(
          (data.totalActiveTime / data.totalWallTime) * 100,
        );

      top.appendChild(
        makeCard("Active Time", formatDuration(data.totalActiveTime)),
      );
      top.appendChild(
        makeCard("Wall Time", formatDuration(data.totalWallTime)),
      );
      top.appendChild(makeCard("Efficiency", efficiency + "%", "Active/Total"));
      top.appendChild(makeCard("AI Probability", m.aiProbability + "%"));

      const statsRow = document.createElement("div");
      statsRow.style.display = "flex";
      statsRow.style.gap = "12px";
      statsRow.style.marginTop = "12px";
      statsRow.appendChild(
        makeCard("Paste %", m.pasteRatio + "%", "of all events"),
      );
      statsRow.appendChild(
        makeCard("Avg Paste Length", m.avgPasteLength + " chars"),
      );
      statsRow.appendChild(
        makeCard(
          "Totals",
          data.totalLogs + " logs • " + data.totalEvents + " events",
        ),
      );

      if (container) {
        container.appendChild(top);
        container.appendChild(statsRow);
      }

      if (container) {
        const filesCard = document.createElement("div");
        filesCard.className = "card";
        filesCard.style.marginTop = "12px";

        const filesHeaderRow = document.createElement("div");
        filesHeaderRow.style.display = "flex";
        filesHeaderRow.style.justifyContent = "space-between";
        filesHeaderRow.style.alignItems = "center";
        filesHeaderRow.innerHTML = `<h2 style="margin:0;">Per-file breakdown</h2>`;

        const btnAnalyze = document.createElement("button");
        btnAnalyze.className = "btn btn-primary";
        btnAnalyze.textContent = "Analyze Behavioral Patterns";
        btnAnalyze.addEventListener("click", () => {
          const checks = document.querySelectorAll(".log-checkbox:checked");
          const filenames = Array.from(checks).map((c) => c.value);
          if (filenames.length < 2) {
            if (status)
              status.textContent =
                "Error: Select at least 2 logs to build a profile.";
            return;
          }
          if (status) status.textContent = "Generating Profile...";
          post("generateProfile", { filenames });
        });
        filesHeaderRow.appendChild(btnAnalyze);
        filesCard.appendChild(filesHeaderRow);

        const filesSection = document.createElement("div");
        filesSection.id = "per-file-section";
        filesSection.style.marginTop = "16px";

        const header = document.createElement("div");
        header.style.display = "grid";
        header.style.gridTemplateColumns = "40px 2fr 1fr 1fr 1fr 1fr 40px";
        header.style.fontWeight = "700";
        header.style.gap = "8px";
        header.innerHTML =
          "<div></div><div>File</div><div>Events</div><div>Active</div><div>Paste</div><div>Delete</div><div></div>";
        filesSection.appendChild(header);

        (data.perFile || []).forEach((f) => {
          const row = document.createElement("div");
          row.style.display = "grid";
          row.style.gridTemplateColumns = "40px 2fr 1fr 1fr 1fr 1fr 40px";
          row.style.gap = "8px";
          row.style.padding = "8px 4px";
          row.setAttribute("data-file-row", f.name || "");
          row.style.cursor = "pointer";

          const checkCell = document.createElement("div");
          const check = document.createElement("input");
          check.type = "checkbox";
          check.className = "log-checkbox";
          check.value = f.name;
          check.addEventListener("click", (e) => e.stopPropagation());
          checkCell.appendChild(check);

          const name = document.createElement("div");
          name.textContent = f.name || (f.error ? "(failed)" : "unknown");
          const ev = document.createElement("div");
          ev.textContent = f.events ? String(f.events) : "-";
          const active = document.createElement("div");
          active.textContent = f.activeTime
            ? formatDuration(f.activeTime)
            : "-";
          const p = document.createElement("div");
          p.textContent = f.events
            ? Math.round(((f.paste || 0) / Math.max(1, f.events)) * 1000) / 10 +
              "%"
            : "-";
          const d = document.createElement("div");
          d.textContent = f.events
            ? Math.round(((f.delete || 0) / Math.max(1, f.events)) * 1000) /
                10 +
              "%"
            : "-";

          const arrowCell = document.createElement("div");
          arrowCell.className = "row-arrow meta";
          arrowCell.textContent = expandedFile === f.name ? "▲" : "▼";
          arrowCell.style.textAlign = "center";

          row.appendChild(checkCell);
          row.appendChild(name);
          row.appendChild(ev);
          row.appendChild(active);
          row.appendChild(p);
          row.appendChild(d);
          row.appendChild(arrowCell);

          // NEW ROW CLICK LOGIC
          row.addEventListener("click", (evClick) => {
            evClick.stopPropagation();

            // Figure out which cell was clicked
            let clickedCell = evClick.target;
            while (clickedCell && clickedCell.parentNode !== row) {
              clickedCell = clickedCell.parentNode;
            }
            const cellNodes = Array.from(row.children);
            const cellIndex = cellNodes.indexOf(clickedCell);

            // Left Area clicked: Checkbox (0) or File Name (1) -> Select the log
            if (cellIndex === 0 || cellIndex === 1) {
              const checkbox = checkCell.querySelector("input");
              // Toggle if user didn't click the checkbox directly
              if (evClick.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
              }
              return; // Stop here, don't expand
            }

            // Right Area clicked: Events (2) onwards -> Expand the Integrity Score
            const fname = f.name;

            if (expandedFile === fname) {
              const prev = document.querySelector(
                `[data-file-row="${expandedFile}"]`,
              );
              if (prev) {
                const arr = prev.querySelector(".row-arrow");
                if (arr) arr.textContent = "▼";
                if (
                  prev.nextSibling &&
                  prev.nextSibling.classList &&
                  prev.nextSibling.classList.contains("file-dropdown")
                )
                  prev.nextSibling.remove();
              }
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

    // --- DASHBOARD EXPANDED ROW LOGIC ---
    function renderDashboardFileDropdown(parsed, filename) {
      const filesSection = document.getElementById("per-file-section");
      if (!filesSection) return;

      if (expandedFile && expandedFile !== filename) {
        const prev = document.querySelector(
          `[data-file-row="${expandedFile}"]`,
        );
        if (prev) {
          const arrowCell = prev.querySelector(".row-arrow");
          if (arrowCell) arrowCell.textContent = "▼";
          if (
            prev.nextSibling &&
            prev.nextSibling.classList &&
            prev.nextSibling.classList.contains("file-dropdown")
          )
            prev.nextSibling.remove();
        }
      }

      expandedFile = filename;
      const row = document.querySelector(`[data-file-row="${filename}"]`);
      if (!row) return;

      const arrowCell = row.querySelector(".row-arrow");

      const loadIndicator = row.querySelector(".meta.loading");
      if (loadIndicator) loadIndicator.remove();

      if (
        row.nextSibling &&
        row.nextSibling.classList &&
        row.nextSibling.classList.contains("file-dropdown")
      ) {
        row.nextSibling.remove();
        if (arrowCell) arrowCell.textContent = "▼";
        expandedFile = null;
        return;
      }

      if (arrowCell) arrowCell.textContent = "▲";

      const dropdown = document.createElement("div");
      dropdown.className = "file-dropdown card";
      dropdown.style.marginTop = "8px";

      let total = (parsed.events && parsed.events.length) || 0;
      let flagged = 0;
      if (parsed.events) {
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
      }
      const score =
        total > 0 ? Math.max(0, Math.round((1 - flagged / total) * 100)) : 100;

      let scoreColor = "#10b981";
      if (score < 85) scoreColor = "#f59e0b";
      if (score < 50) scoreColor = "#ef4444";

      dropdown.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:16px;">
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="width:6px; height:72px; background:${scoreColor}; border-radius:6px 0 0 6px;"></div>
            <div style="padding:8px 12px;">
              <div style="font-size:2rem; font-weight:700; color:${scoreColor};">${score}%</div>
              <div class="meta">Integrity Score</div>
            </div>
          </div>
          <div style="text-align:right; min-width:140px;">
            <div style="font-weight:700; font-size:1.2rem;">${flagged} / ${total}</div>
            <div class="meta">Flagged Events</div>
          </div>
        </div>
        <div style="margin-top:12px; border-top:1px solid var(--border); padding-top:12px;">
      `;

      try {
        const affected = new Set();
        if (parsed && Array.isArray(parsed.events)) {
          parsed.events.forEach((ev) => {
            if (!ev || !ev.eventType) return;
            const et = ev.eventType;
            if (
              et === "input" &&
              ev.flightTime &&
              parseInt(ev.flightTime) < currentSettings.flight
            )
              affected.add(`Fast Typing (< ${currentSettings.flight}ms)`);
            if (
              et === "paste" ||
              et === "ai-paste" ||
              et === "replace" ||
              et === "ai-replace"
            ) {
              const plen =
                typeof ev.pasteCharCount === "number"
                  ? ev.pasteCharCount
                  : typeof ev.pasteLength === "number"
                    ? ev.pasteLength
                    : typeof ev.length === "number"
                      ? ev.length
                      : null;
              if (plen === null || plen > currentSettings.pasteLength)
                affected.add(
                  `Suspicious Pastes (> ${currentSettings.pasteLength} chars)`,
                );
            }
          });
        }

        let affectedHtml = "";
        if (affected.size === 0)
          affectedHtml = '<div class="meta">No notable factors detected.</div>';
        else {
          const items = Array.from(affected).map((item) => {
            if (item.startsWith("Suspicious"))
              return `<strong style='color:#f59e0b'>${item}</strong>`;
            if (item.startsWith("Fast Typing"))
              return `<strong style='color:#8b5cf6'>${item}</strong>`;
            return `<strong>${item}</strong>`;
          });
          affectedHtml = `<div class="meta">Score affected by ${items.join(" and ")}.</div>`;
        }
        dropdown.innerHTML += affectedHtml;
      } catch (err) {
        dropdown.innerHTML += `<div class="meta">Score factors unavailable.</div>`;
      }
      row.parentNode.insertBefore(dropdown, row.nextSibling);
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
        case "profileData":
          renderProfile(msg.data);
          if (status) status.textContent = "Behavioral profile generated.";
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

        case "deletionData":
          try {
            const d = msg.data;
            if (!deletionsView) break;
            if (typeof d === "string") {
              deletionsView.innerHTML = "<pre>" + d + "</pre>";
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
                hdrDiv.innerHTML = `<div><strong>${header.note || "Deletion Log"}</strong></div><div class="meta">Created: ${header.createdAt || header.created || ""}</div>`;
                deletionsView.innerHTML = "";
                deletionsView.appendChild(hdrDiv);
              } else {
                deletionsView.innerHTML = "";
              }
              if (!records || records.length === 0) {
                const empty = document.createElement("div");
                empty.className = "meta";
                empty.textContent = "No deletion records found.";
                deletionsView.appendChild(empty);
              } else {
                const list = document.createElement("div");
                list.style.display = "grid";
                list.style.gap = "10px";
                records.forEach((item) => {
                  const row = document.createElement("div");
                  row.className = "card deletion-row";
                  const time =
                    item.modifiedAt || item.time || item.timestamp || "";
                  const who =
                    item.user || item.startedBy || item.actor || "Unknown";
                  const file =
                    item.modifiedFile ||
                    item.file ||
                    item.path ||
                    item.filePath ||
                    "(unknown)";
                  const prevSize =
                    item.previousSize || item.oldSize || item.previous || "";
                  const newSize = item.newSize || item.size || "";
                  const note = item.note || item.reason || "";
                  row.innerHTML = `
                    <div style="display:flex; flex-direction:column; gap:6px;">
                      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
                        <div style="font-weight:700;">${file}</div>
                        <div class="meta">Deleted by ${who} • ${time}</div>
                      </div>
                      <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
                        ${prevSize ? `<div class="meta">Prev: ${prevSize}</div>` : ""}
                        ${newSize ? `<div class="meta">Now: ${newSize}</div>` : ""}
                        ${note ? `<div class="meta">${note}</div>` : ""}
                      </div>
                    </div>
                  `;
                  list.appendChild(row);
                });
                deletionsView.appendChild(list);
              }
            }
          } catch (err) {
            if (deletionsView)
              deletionsView.textContent = "Failed to render deletions.";
          }
          if (status) status.textContent = "Deletions updated";
          break;
      }
    });

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
