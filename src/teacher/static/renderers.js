window.TeacherUI = {
  formatDuration(ms) {
    if (!ms || ms < 0) return "0m";
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  },

  parseLogTime(timeStr) {
    if (!timeStr) return null;
    const cleanStr = timeStr.replace(/ [A-Z]{3,4}$/, "");
    const parts = cleanStr.split(" ");
    if (parts.length < 2) return null;
    const dateSub = parts[0].split("-");
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
    const timeSub = parts[1].split(":");
    const hr = parseInt(timeSub[0]);
    const min = parseInt(timeSub[1]);
    const sec = parseInt(timeSub[2]);
    const ms = timeSub[3] ? parseInt(timeSub[3]) : 0;
    return new Date(year, month, day, hr, min, sec, ms).getTime();
  },

  renderDashboard(data, handlers) {
    const container = document.getElementById("dashboard-view");
    const empty = document.getElementById("dashboard-empty");
    if (container) container.innerHTML = "";
    if (empty) empty.style.display = "none";
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

    let efficiency =
      data.totalWallTime > 0
        ? Math.round((data.totalActiveTime / data.totalWallTime) * 100)
        : 0;
    top.appendChild(
      makeCard("Active Time", this.formatDuration(data.totalActiveTime)),
    );
    top.appendChild(
      makeCard("Wall Time", this.formatDuration(data.totalWallTime)),
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

      const titleDiv = document.createElement("div");
      titleDiv.style.display = "flex";
      titleDiv.style.alignItems = "center";
      titleDiv.style.gap = "12px";
      titleDiv.innerHTML = `<h2 style="margin:0;">Per-file breakdown</h2>`;

      const btnClear = document.createElement("button");
      btnClear.className = "btn btn-secondary";
      btnClear.textContent = "Clear Selection";
      btnClear.style.padding = "2px 8px";
      btnClear.style.fontSize = "0.85rem";
      btnClear.addEventListener("click", () =>
        document
          .querySelectorAll(".log-checkbox")
          .forEach((cb) => (cb.checked = false)),
      );
      titleDiv.appendChild(btnClear);

      const actionBtnsDiv = document.createElement("div");
      actionBtnsDiv.style.display = "flex";
      actionBtnsDiv.style.gap = "8px";

      const btnTimeline = document.createElement("button");
      btnTimeline.className = "btn btn-primary";
      btnTimeline.textContent = "Create Timeline";
      btnTimeline.addEventListener("click", handlers.onGenerateTimeline);
      actionBtnsDiv.appendChild(btnTimeline);

      const btnAnalyze = document.createElement("button");
      btnAnalyze.className = "btn btn-primary";
      btnAnalyze.textContent = "Analyze Behavioral Patterns";
      btnAnalyze.addEventListener("click", handlers.onGenerateProfile);
      actionBtnsDiv.appendChild(btnAnalyze);

      filesHeaderRow.appendChild(titleDiv);
      filesHeaderRow.appendChild(actionBtnsDiv);
      filesCard.appendChild(filesHeaderRow);

      const filesSection = document.createElement("div");
      filesSection.id = "per-file-section";
      filesSection.style.marginTop = "16px";
      filesSection.innerHTML = `<div style="display:grid; grid-template-columns:40px 2fr 1fr 1fr 1fr 1fr 40px; font-weight:700; gap:8px;"><div></div><div>File</div><div>Events</div><div>Active</div><div>Paste</div><div>Delete</div><div></div></div>`;

      (data.perFile || []).forEach((f) => {
        const row = document.createElement("div");
        row.style.display = "grid";
        row.style.gridTemplateColumns = "40px 2fr 1fr 1fr 1fr 1fr 40px";
        row.style.gap = "8px";
        row.style.padding = "8px 4px";
        row.style.cursor = "pointer";
        row.setAttribute("data-file-row", f.name || "");

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
          ? this.formatDuration(f.activeTime)
          : "-";
        const p = document.createElement("div");
        p.textContent = f.events
          ? Math.round(((f.paste || 0) / Math.max(1, f.events)) * 1000) / 10 +
            "%"
          : "-";
        const d = document.createElement("div");
        d.textContent = f.events
          ? Math.round(((f.delete || 0) / Math.max(1, f.events)) * 1000) / 10 +
            "%"
          : "-";
        const arrowCell = document.createElement("div");
        arrowCell.className = "row-arrow meta";
        arrowCell.textContent = "▼";
        arrowCell.style.textAlign = "center";

        row.append(checkCell, name, ev, active, p, d, arrowCell);
        row.addEventListener("click", (evClick) =>
          handlers.onRowClick(evClick, row, f.name, checkCell, name),
        );
        filesSection.appendChild(row);
      });
      filesCard.appendChild(filesSection);
      container.appendChild(filesCard);
    }
  },

  renderDashboardFileDropdown(parsed, filename, currentSettings) {
    const row = document.querySelector(`[data-file-row="${filename}"]`);
    if (!row) return;

    // Clean up any existing loading text
    const loadIndicator = row.querySelector(".meta.loading");
    if (loadIndicator) loadIndicator.remove();

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
  },

  renderTimeline(data) {
    let tCard = document.getElementById("timeline-card");
    if (!tCard) {
      tCard = document.createElement("div");
      tCard.id = "timeline-card";
      tCard.className = "card";
      tCard.style.borderLeft = "6px solid var(--accent)";
      tCard.style.marginTop = "12px";
      const filesSection = document.getElementById("per-file-section");
      if (filesSection)
        filesSection.parentElement.insertAdjacentElement("beforebegin", tCard);
    }

    let html = `<div style="display:flex; justify-content:space-between; align-items:center;"><div><h2 style="margin:0; color:var(--accent);">Assignment Timeline: ${data.user}</h2><div class="meta">Project: ${data.project} &nbsp;|&nbsp; Total Analyzed Events: ${data.totalEvents}</div></div><button id="close-timeline" class="btn btn-secondary" style="padding:4px 8px;">Close</button></div><div style="margin-top: 16px;">`;

    if (data.sparse || !data.periods || data.periods.length === 0) {
      html += `<div class="meta" style="color: #f59e0b; padding:12px; border:1px solid #f59e0b; border-radius:4px;"><strong>Sparse Activity Detected:</strong> The timeline is incomplete because there are not enough recorded events.</div>`;
    } else {
      const formatTime = (ts) =>
        new Date(ts).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      data.periods.forEach((p, index) => {
        const durMs = p.endTime - p.startTime;
        html += `<div style="display:flex; flex-direction:column; gap:4px; margin-bottom: 8px;"><div style="display:flex; justify-content:space-between; background: var(--bg); padding: 12px 16px; border: 1px solid var(--border); border-radius: 6px; border-left: 4px solid var(--accent);"><div><strong style="font-size:1.1rem;">Work Period ${index + 1}</strong><div class="meta" style="margin-top:4px;">${formatTime(p.startTime)} &rarr; ${formatTime(p.endTime)}</div></div><div style="text-align: right;"><div style="font-weight:bold;">${durMs < 60000 ? "< 1m" : this.formatDuration(durMs)}</div><div class="meta">${p.eventCount} logged events</div></div></div></div>`;
        if (index < data.periods.length - 1) {
          const gapMs = data.periods[index + 1].startTime - p.endTime;
          if (gapMs > 4 * 60 * 60 * 1000)
            html += `<div class="meta" style="text-align:center; padding: 8px 0; color: #f59e0b;">⟐ <strong>Significant Gap: ${this.formatDuration(gapMs)}</strong> (Potential unrecorded offline work, crash, or extended break) ⟐</div>`;
          else
            html += `<div class="meta" style="text-align:center; padding: 6px 0;">↓ Gap: ${this.formatDuration(gapMs)} ↓</div>`;
        }
      });
    }
    html += `</div>`;
    tCard.innerHTML = html;
    document
      .getElementById("close-timeline")
      .addEventListener("click", () => tCard.remove());
  },

  renderProfile(data) {
    let pCard = document.getElementById("profile-card");
    if (!pCard) {
      pCard = document.createElement("div");
      pCard.id = "profile-card";
      pCard.className = "card";
      pCard.style.borderLeft = "6px solid var(--accent-2)";
      pCard.style.marginTop = "12px";
      const filesSection = document.getElementById("per-file-section");
      if (filesSection)
        filesSection.parentElement.insertAdjacentElement("beforebegin", pCard);
    }
    pCard.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center;"><div><h2 style="margin:0; color:var(--accent-2);">Behavioral Profile: ${data.user}</h2><div class="meta">Project: ${data.project} | Sessions Analyzed: ${data.sessionsAnalyzed} | Active Time: ${data.totalActiveMins} mins | Total Time in VS Code: ${data.totalWallMins} mins</div></div><button id="close-profile" class="btn btn-secondary" style="padding:4px 8px;">Close</button></div><div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:16px; margin-top:20px;"><div><div style="font-weight:700; font-size:1.5rem;">${data.wpm}</div><div class="meta">Avg WPM</div></div><div><div style="font-weight:700; font-size:1.5rem;">${data.editRate}</div><div class="meta">Edits/min (Code Churn)</div></div><div><div style="font-weight:700; font-size:1.5rem;">${data.pasteFreq}</div><div class="meta">Pastes/hr</div></div><div><div style="font-weight:700; font-size:1.5rem;">${data.avgPauseMs > 0 ? (data.avgPauseMs / 1000).toFixed(1) + "s" : "N/A"}</div><div class="meta">Avg Micro-Pause (Thinking Time)</div></div><div><div style="font-weight:700; font-size:1.5rem;">${data.internalPasteRatio}% <span style="font-size:1rem; color:var(--muted)">Int</span> / ${data.externalPasteRatio}% <span style="font-size:1rem; color:var(--muted)">Ext</span></div><div class="meta">Internal vs External Paste Ratio</div></div><div><div style="font-weight:700; font-size:1.5rem;">${data.debugRunFreq}</div><div class="meta">Terminal Runs/hr (Testing Freq)</div></div></div><div class="meta" style="margin-top:16px; border-top:1px solid var(--border); padding-top:12px;"><strong>Pedagogical Insight:</strong> This establishes the student's unique workflow.</div>`;
    document
      .getElementById("close-profile")
      .addEventListener("click", () => pCard.remove());
  },

  renderParsedInLogs(parsed, filename, currentSettings, handlers) {
    const logsView = document.getElementById("logs-view");
    const logsViewerContainer = document.getElementById(
      "logs-viewer-container",
    );
    const logsLogName = document.getElementById("logs-log-name");

    if (logsView) logsView.innerHTML = "";
    if (document.getElementById("dashboard-empty"))
      document.getElementById("dashboard-empty").style.display = "none";
    if (logsViewerContainer) logsViewerContainer.style.display = "block";
    if (logsLogName) logsLogName.textContent = "Event Log: " + filename;

    let totalEvents = 0,
      flaggedEvents = 0,
      integrityScore = 100;
    let focusAwayCount = 0,
      largePasteCount = 0,
      fastInputCount = 0,
      deleteCount = 0,
      replaceCount = 0;

    if (parsed && Array.isArray(parsed.events)) {
      totalEvents = parsed.events.length;
      parsed.events.forEach((e) => {
        let flagged = false;
        const et = (e.eventType || "").toLowerCase();

        if (et === "delete" || et === "backspace") deleteCount++;
        if (et === "replace") replaceCount++;

        if (et === "paste" || et === "clipboard" || et === "pasteevent") {
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
            flagged = true;
            largePasteCount++;
          } else if (len === null) {
            flagged = true;
            largePasteCount++;
          }
        }
        if (
          et === "input" &&
          e.flightTime &&
          parseInt(e.flightTime) < currentSettings.flight
        ) {
          flagged = true;
          fastInputCount++;
        }
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
                    <div><h2 style="margin:0; font-size:2rem; color:${scoreColor}">${integrityScore}%</h2><div class="meta" style="font-size:1rem;">Integrity Score</div></div>
                    <div style="text-align:right;"><div style="font-weight:600; font-size:1.2rem;">${flaggedEvents} <span style="font-weight:400; color:var(--muted)">/ ${totalEvents}</span></div><div class="meta">Flagged Events</div></div>
                </div>
            `;
      logsView.appendChild(scoreDiv);

      if (parsed.sessionHeader) {
        const h = parsed.sessionHeader;
        const headerDiv = document.createElement("div");
        headerDiv.className = "card";
        headerDiv.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div><h2>Session ${h.sessionNumber || ""}</h2><div class="meta">User: ${h.startedBy || "N/A"}</div><div class="meta">Workspace: ${h.project || "N/A"}</div></div>
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
        headerDiv
          .querySelector("#btn-export-csv")
          ?.addEventListener("click", () => handlers.onExportCsv(filename));
        headerDiv
          .querySelector("#btn-export-json")
          ?.addEventListener("click", () => handlers.onExportJson(filename));
      }

      const controlsDiv = document.createElement("div");
      controlsDiv.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin: 16px 0 8px 0;">
                    <div class="btn-group" style="display:flex; gap:8px;">
                        <button class="btn btn-primary" id="btn-tab-events">Raw Events</button>
                        <button class="btn btn-secondary" id="btn-tab-report">Integrity Report</button>
                    </div>
                    <div id="filter-wrapper" style="display:flex; align-items:center; gap:8px;">
                        <span class="meta">Filter:</span>
                        <select id="log-event-filter" style="padding:4px 8px; border-radius:4px; background:var(--bg); color:var(--fg); border:1px solid var(--border);">
                            <option value="all">All Events</option>
                            <option value="focus-away">Focus Away Times</option>
                            <option value="flagged-paste">Flagged Pastes</option>
                            <option value="flagged-fast">Flagged Fast Inputs</option>
                            <option value="input">Normal Inputs</option>
                            <option value="delete">Deletions</option>
                            <option value="replace">Replacements</option>
                        </select>
                    </div>
                </div>
            `;
      logsView.appendChild(controlsDiv);

      const eventsContainer = document.createElement("div");
      eventsContainer.id = "events-container";
      const reportContainer = document.createElement("div");
      reportContainer.id = "report-container";
      reportContainer.style.display = "none";
      logsView.appendChild(eventsContainer);
      logsView.appendChild(reportContainer);

      if (parsed && Array.isArray(parsed.events)) {
        const formatFilePath = (p) => {
          if (!p || typeof p !== "string") return p;
          const project =
            (parsed && parsed.sessionHeader && parsed.sessionHeader.project) ||
            null;
          if (project) {
            const idx = p.indexOf(project);
            if (idx !== -1) {
              let rel = p.substring(idx + project.length);
              return rel.replace(/^\\+|^\/+/, "") || project;
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
          let filterCat = "other";

          const et = (e.eventType || "").toLowerCase();

          const currentTime = this.parseLogTime(e.time);
          if (previousTime !== null && currentTime !== null) {
            const gap = currentTime - previousTime;
            if (gap > inactivityLimitMs) {
              focusAwayCount++;
              const gapRow = document.createElement("div");
              gapRow.className = "event";
              gapRow.style.borderLeft = "4px solid #ef4444";
              gapRow.style.backgroundColor = "rgba(239, 68, 68, 0.1)";
              gapRow.dataset.filterCategory = "focus-away";
              gapRow.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center;"><strong style="color:#ef4444">⚠️ Major Focus Away Time</strong><span class="meta" style="color:#ef4444; font-weight:bold;">${this.formatDuration(gap)}</span></div><div class="meta">Student was inactive for > ${currentSettings.inactivity} mins.</div>`;
              rowElements.push(gapRow);
            }
          }
          if (currentTime) previousTime = currentTime;

          if (et === "input" || et === "key" || et === "keystroke")
            filterCat = "input";
          if (et === "delete" || et === "backspace") filterCat = "delete";
          if (et === "replace") filterCat = "replace";

          if (et === "paste" || et === "clipboard" || et === "pasteevent") {
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
              filterCat = "flagged-paste";
            } else if (len === null) {
              className += " paste";
              filterCat = "flagged-paste";
            } else {
              filterCat = "paste";
            }
          }

          if (
            et === "input" &&
            e.flightTime &&
            parseInt(e.flightTime) < currentSettings.flight
          ) {
            className += " fast";
            flagReason = "(Fast Input)";
            filterCat = "flagged-fast";
          }

          row.className = className;
          row.dataset.filterCategory = filterCat;
          row.dataset.eventTime = e.time || '';
          let html = `<div style="display:flex; justify-content:space-between; align-items:center;"><div style="display:flex; gap:8px; align-items:center;"><strong>${e.eventType || "Unknown"}</strong> ${flagReason}<button class="btn-notes" data-has-note="false" style="background:none; border:none; cursor:pointer; font-size:1.1rem; padding:0 4px; position:relative;" title="Add/view notes"><span class="note-icon-empty" style="filter: grayscale(100%) opacity(0.5);">📝</span><span class="note-icon-filled" style="display:none;">📝</span></button></div><span class="meta">${e.time || ""}</span></div>`;

          Object.keys(e).forEach((k) => {
            if (["eventType", "time"].includes(k)) return;
            let val = e[k];
            if (
              k === "fileEdit" ||
              k === "fileView" ||
              k === "file" ||
              k === "filePath"
            )
              val = formatFilePath(val);
            try {
              if (typeof val === "object") val = JSON.stringify(val);
            } catch (err) {}
            html += `<div class="meta">${k}: ${val}</div>`;
          });

          html += `<div class="event-notes-area" style="display:none; margin-top:12px; padding-top:8px; border-top:1px solid var(--border);"><textarea class="event-note-input" placeholder="Add private instructor notes for this event..." style="width:100%; min-height:60px; padding:8px; border:1px solid var(--border); border-radius:4px; background:var(--bg); color:var(--fg); font-family:monospace; font-size:0.9rem;" rows="3"></textarea><div style="display:flex; gap:8px; margin-top:8px;"><button class="btn-save-note" style="background:var(--accent); color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:0.9rem;">Save Note</button><button class="btn-close-notes" style="background:var(--border); color:var(--fg); border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:0.9rem;">Cancel</button></div></div>`;

          row.innerHTML = html;
          rowElements.push(row);
        }
        rowElements.reverse().forEach((r) => eventsContainer.appendChild(r));
      }

      const churnRate =
        totalEvents > 0 ? (deleteCount + replaceCount) / totalEvents : 0;
      let churnText =
        "A healthy amount of editing indicates normal problem-solving and iteration.";
      if (churnRate < 0.05 && totalEvents > 100)
        churnText =
          "<strong>Warning:</strong> A very low edit rate combined with high output suggests code was pre-written or copied perfectly without trial and error.";
      let pasteText = "Good, no massive code dumps detected.";
      if (largePasteCount > 0)
        pasteText = `<strong>Warning:</strong> ${largePasteCount} pastes exceeded the limit. This significantly lowers the integrity score, as large un-typed blocks are highly unusual unless the student is refactoring their own code.`;
      let focusText = "Consistent work session with no major gaps.";
      if (focusAwayCount > 0)
        focusText = `Detected ${focusAwayCount} instances of extended inactivity. While taking breaks is normal, excessive gaps followed immediately by large pastes may indicate copying from an external source.`;
      let fastInputText = "Normal human typing cadence detected.";
      if (fastInputCount > 0)
        fastInputText = `<strong>Warning:</strong> ${fastInputCount} keystrokes registered suspiciously fast. This indicates potential auto-typing scripts or pasting disguised as typing events.`;

      reportContainer.innerHTML = `
                <div class="card" style="margin-top: 12px; line-height: 1.6;">
                    <h2 style="margin-top:0; border-bottom:1px solid var(--border); padding-bottom:8px;">Descriptive Integrity Summary</h2>
                    <p><strong>Overall Session Score: <span style="color:${scoreColor}">${integrityScore}%</span></strong></p>
                    <p class="meta">This score evaluates the likelihood that this work represents natural human coding behavior based on a deep analysis of ${totalEvents} logged events.</p>
                    <ul style="padding-left: 20px; margin-top: 16px;">
                        <li style="margin-bottom: 12px;"><strong>Code Churn (Delete/Replace):</strong> The student made ${deleteCount} deletions and ${replaceCount} replacements.<br><span class="meta">${churnText}</span></li>
                        <li style="margin-bottom: 12px;"><strong>Suspicious Pastes:</strong> Evaluated based on the >${currentSettings.pasteLength} character threshold.<br><span class="meta">${pasteText}</span></li>
                        <li style="margin-bottom: 12px;"><strong>Fast Inputs:</strong> Evaluated based on <${currentSettings.flight}ms flight time.<br><span class="meta">${fastInputText}</span></li>
                        <li style="margin-bottom: 12px;"><strong>Focus & Inactivity:</strong> Evaluated based on >${currentSettings.inactivity} min pauses.<br><span class="meta">${focusText}</span></li>
                    </ul>
                </div>
            `;

      const btnTabEvents = document.getElementById("btn-tab-events");
      const btnTabReport = document.getElementById("btn-tab-report");
      const filterSelect = document.getElementById("log-event-filter");
      const filterWrapper = document.getElementById("filter-wrapper");

      btnTabEvents.addEventListener("click", () => {
        btnTabEvents.className = "btn btn-primary";
        btnTabReport.className = "btn btn-secondary";
        eventsContainer.style.display = "block";
        reportContainer.style.display = "none";
        filterWrapper.style.display = "flex";
      });

      btnTabReport.addEventListener("click", () => {
        btnTabReport.className = "btn btn-primary";
        btnTabEvents.className = "btn btn-secondary";
        reportContainer.style.display = "block";
        eventsContainer.style.display = "none";
        filterWrapper.style.display = "none";
      });

      filterSelect.addEventListener("change", (e) => {
        const val = e.target.value;
        const rows = eventsContainer.querySelectorAll(".event");
        rows.forEach((r) => {
          if (val === "all") r.style.display = "";
          else r.style.display = r.dataset.filterCategory === val ? "" : "none";
        });
      });

      // Setup notes button listeners
      const notesButtons = eventsContainer.querySelectorAll(".btn-notes");
      const saveNoteButtons = eventsContainer.querySelectorAll(".btn-save-note");
      const closeNoteButtons = eventsContainer.querySelectorAll(".btn-close-notes");

      notesButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const eventRow = btn.closest(".event");
          const notesArea = eventRow?.querySelector(".event-notes-area");
          if (notesArea) {
            const isVisible = notesArea.style.display !== "none";
            notesArea.style.display = isVisible ? "none" : "block";
            if (!isVisible) {
              const textarea = notesArea.querySelector(".event-note-input");
              if (textarea) textarea.focus();
            }
          }
        });
      });

      saveNoteButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const eventRow = btn.closest(".event");
          const notesArea = eventRow?.querySelector(".event-notes-area");
          const textarea = notesArea?.querySelector(".event-note-input");
          const timestamp = eventRow?.dataset.eventTime || "";
          const noteText = textarea?.value || "";

          if (!window.currentLogFilename) return;

          // Prepare notes array
          const allNotes = [];
          document.querySelectorAll(".event").forEach((row) => {
            const area = row.querySelector(".event-notes-area");
            const input = area?.querySelector(".event-note-input");
            const ts = row.dataset.eventTime || "";
            const text = input?.value || "";
            if (ts && text) {
              allNotes.push({ timestamp: ts, text });
            }
          });

          // Send save command to backend
          if (window.postTeacherMessage) {
            window.postTeacherMessage("saveLogNotes", { filename: window.currentLogFilename, notes: allNotes });
          }
          
          // Update visual indicator for this event
          const noteBtn = eventRow?.querySelector(".btn-notes");
          if (noteBtn) {
            const isEmpty = !noteText || noteText.trim() === "";
            noteBtn.dataset.hasNote = isEmpty ? "false" : "true";
            const emptyIcon = noteBtn.querySelector(".note-icon-empty");
            const filledIcon = noteBtn.querySelector(".note-icon-filled");
            if (emptyIcon && filledIcon) {
              emptyIcon.style.display = isEmpty ? "inline" : "none";
              filledIcon.style.display = isEmpty ? "none" : "inline";
            }
          }
          
          // Close the notes area
          if (notesArea) notesArea.style.display = "none";
        });
      });

      closeNoteButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const eventRow = btn.closest(".event");
          const notesArea = eventRow?.querySelector(".event-notes-area");
          if (notesArea) notesArea.style.display = "none";
        });
      });
    }
  },
};
