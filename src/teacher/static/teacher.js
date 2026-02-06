/* Webview client script for Teacher View - cleaned and defensive */
(function () {
  const vscode = acquireVsCodeApi();

  // state
  let logNamesCache = [];
  const defaults = { inactivity: 5, flight: 50, pasteLength: 50 };
  let currentSettings = { ...defaults };
  let currentTab = 'dashboard';
  let requestedDashboardFile = null; // filename requested to show in dashboard per-file dropdown
  let expandedFile = null; // filename currently expanded in dashboard

  // wait for DOM to be ready
  window.addEventListener('DOMContentLoaded', () => {
    // element helpers
    const $ = id => document.getElementById(id);

    // DOM refs (may be null if fragment missing)
    const searchInput = $('log-search-input');
    const dropdown = $('log-dropdown');
    const logCountLabel = $('log-count');
    const refreshBtn = $('refresh-logs');
    const status = $('status');

    const dashboardView = $('dashboard-view');
    const dashboardEmpty = $('dashboard-empty');
    const dashboardLogName = $('dashboard-log-name');

    const logsView = $('logs-view');
    const logsViewerContainer = $('logs-viewer-container');
    const logsLogName = $('logs-log-name');

    const inactivityInput = $('inactivityInput');
    const flightInput = $('flightInput');
    const pasteLengthInput = $('pasteLengthInput');
    const flagAiCheckbox = $('flagAiEvents');
    const settingsMsg = $('settings-msg');

    const themeToggle = $('themeToggle');

    // create a small clear button next to the search input if one doesn't exist
    let clearSearchBtn = $('clear-search');
    if (!clearSearchBtn && searchInput) {
      try {
        clearSearchBtn = document.createElement('button');
        clearSearchBtn.id = 'clear-search';
        clearSearchBtn.type = 'button';
        clearSearchBtn.className = 'btn clear-btn';
        clearSearchBtn.title = 'Clear search';
        clearSearchBtn.textContent = '✖';
        // insert after the input
        if (searchInput.parentNode) searchInput.parentNode.insertBefore(clearSearchBtn, searchInput.nextSibling);
        else searchInput.insertAdjacentElement('afterend', clearSearchBtn);
      } catch (e) { clearSearchBtn = null; }
    }
    if (clearSearchBtn) {
      clearSearchBtn.addEventListener('click', () => {
        try {
          if (searchInput) searchInput.value = '';
          if (dropdown) { renderDropdown(logNamesCache); dropdown.classList.remove('show'); }
          if (searchInput) searchInput.focus();
        } catch (err) { /* noop */ }
      });
    }

    function switchTab(tabName) {
      document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      const pane = document.getElementById(tabName + '-tab');
      if (pane) pane.classList.add('active');
      const btn = document.getElementById('nav-' + tabName);
      if (btn) btn.classList.add('active');
      currentTab = tabName;
    }

    function post(command, payload = {}) {
      try { vscode.postMessage(Object.assign({ command }, payload)); } catch (e) { /* noop */ }
    }

    // attach nav buttons defensively
    const navDashboard = $('nav-dashboard'); if (navDashboard) navDashboard.addEventListener('click', () => { switchTab('dashboard'); post('analyzeLogs'); });
    const navLogs = $('nav-logs'); if (navLogs) navLogs.addEventListener('click', () => { switchTab('logs'); post('listLogs'); });
    const navSettings = $('nav-settings'); if (navSettings) navSettings.addEventListener('click', () => { switchTab('settings'); });
    const btnGotoLogs = $('btn-goto-logs'); if (btnGotoLogs) btnGotoLogs.addEventListener('click', () => switchTab('logs'));

    const closeLogBtn = $('close-log'); if (closeLogBtn) closeLogBtn.addEventListener('click', () => {
      if (logsViewerContainer) logsViewerContainer.style.display = 'none';
      if (logsView) logsView.innerHTML = '';
      if (logsLogName) logsLogName.textContent = '';
      if (searchInput) searchInput.value = '';
    });

    // theme
    // Safely try to read persisted state (getState is a function)
    let isDark = false;
    try {
      const st = (typeof vscode.getState === 'function') ? vscode.getState() : undefined;
      if (st && st.theme === 'dark') isDark = true;
      else if (document.documentElement.classList.contains('dark')) isDark = true;
      else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) isDark = true;
    } catch (e) {
      isDark = document.documentElement.classList.contains('dark') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    if (isDark) document.documentElement.classList.add('dark');
    if (themeToggle) themeToggle.textContent = isDark ? '🌙' : '☀️';
    if (themeToggle) themeToggle.addEventListener('click', () => {
      document.documentElement.classList.toggle('dark');
      isDark = !isDark;
      themeToggle.textContent = isDark ? '🌙' : '☀️';
      if (vscode.setState) try { vscode.setState({ theme: isDark ? 'dark' : 'light' }); } catch (e) {}
    });

    function renderDropdown(items) {
      if (!dropdown) return;
      dropdown.innerHTML = '';
      if (!items || items.length === 0) {
        dropdown.innerHTML = '<div class="dropdown-item" style="cursor:default; color:var(--muted);">No logs found</div>';
        return;
      }
      items.forEach(name => {
        const div = document.createElement('div');
        div.className = 'dropdown-item';
        div.textContent = name;
        div.addEventListener('mousedown', (e) => { e.preventDefault(); openLogFile(name); });
        dropdown.appendChild(div);
      });
    }

    function openLogFile(filename) {
      if (searchInput) searchInput.value = filename;
      if (dropdown) dropdown.classList.remove('show');
      if (status) status.textContent = 'Decrypting ' + filename + '...';
      post('openLog', { filename });
    }

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const term = (e.target && e.target.value || '').toLowerCase();
        const filtered = logNamesCache.filter(n => n.toLowerCase().includes(term));
        renderDropdown(filtered);
        if (dropdown) dropdown.classList.add('show');
      });
      searchInput.addEventListener('focus', () => {
        const term = (searchInput.value || '').toLowerCase();
        const filtered = logNamesCache.filter(n => n.toLowerCase().includes(term));
        renderDropdown(filtered);
        if (dropdown) dropdown.classList.add('show');
      });
    }

    document.addEventListener('click', (e) => {
      if (searchInput && dropdown && !searchInput.contains(e.target) && !dropdown.contains(e.target)) dropdown.classList.remove('show');
      // close any expanded per-file dropdown when clicking outside the per-file section
      const filesSection = document.getElementById('per-file-section');
      if (filesSection) {
        const targetIsRow = e.target && (e.target.closest && e.target.closest('[data-file-row]'));
        const targetIsDropdown = e.target && (e.target.closest && e.target.closest('.file-dropdown'));
        if (!targetIsRow && !targetIsDropdown) {
          // remove open dropdown
          if (expandedFile) {
            const prev = document.querySelector(`[data-file-row="${expandedFile}"]`);
            if (prev && prev.nextSibling && prev.nextSibling.classList && prev.nextSibling.classList.contains('file-dropdown')) prev.nextSibling.remove();
            expandedFile = null;
          }
        }
      }
    });

    if (refreshBtn) refreshBtn.addEventListener('click', () => { if (status) status.textContent = 'Refreshing list...'; post('listLogs'); });

    // render logic
    // Render parsed log into the Logs pane only (do not touch dashboard)
    function renderParsedInLogs(parsed, filename) {
      if (logsView) logsView.innerHTML = '';
      if (dashboardEmpty) dashboardEmpty.style.display = 'none';
      if (logsViewerContainer) logsViewerContainer.style.display = 'block';
      if (logsLogName) logsLogName.textContent = 'Event Log: ' + filename;

      let totalEvents = 0, flaggedEvents = 0, integrityScore = 100;
          if (parsed && Array.isArray(parsed.events)) {
        totalEvents = parsed.events.length;
        parsed.events.forEach(e => {
          let flagged = false;
          const et = (e.eventType || '').toString().toLowerCase();
          // prefer pasteCharCount when available
          const len = (typeof e.pasteCharCount === 'number') ? e.pasteCharCount : ((typeof e.length === 'number') ? e.length : (typeof e.pasteLength === 'number' ? e.pasteLength : null));
          if (et === 'paste' || et === 'clipboard' || et === 'pasteevent') {
            if (len === null || len > currentSettings.pasteLength) flagged = true;
          }
          if (et === 'input' && e.flightTime && parseInt(e.flightTime) < currentSettings.flight) flagged = true;
          // flag AI-detected events if the setting is enabled
          try {
            if (currentSettings.flagAiEvents && (et.startsWith('ai-') || e.possibleAiDetection)) flagged = true;
          } catch (err) {}
          if (flagged) flaggedEvents++;
        });
        if (totalEvents > 0) {
          const ratio = flaggedEvents / totalEvents;
          integrityScore = Math.max(0, Math.round((1 - ratio) * 100));
        }
      }

      let scoreColor = '#10b981';
      if (integrityScore < 85) scoreColor = '#f59e0b';
      if (integrityScore < 50) scoreColor = '#ef4444';

      if (logsView) {
        const scoreDiv = document.createElement('div');
        scoreDiv.className = 'card';
        scoreDiv.style.borderLeft = '6px solid ' + scoreColor;
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
        dashboardView.appendChild(scoreDiv);

        if (parsed.sessionHeader) {
          const h = parsed.sessionHeader;
          const headerDiv = document.createElement('div');
          headerDiv.className = 'card';
          headerDiv.innerHTML = `
            <div style="display:flex; justify-content:space-between;">
              <div>
                <h2>Session ${h.sessionNumber || ''}</h2>
                <div class="meta">User: ${h.startedBy || 'N/A'}</div>
                <div class="meta">Workspace: ${h.project || 'N/A'}</div>
              </div>
              <div style="text-align:right;">
                <div class="meta">${h.startTime ? new Date(h.startTime).toLocaleString() : ''}</div>
                <div class="meta">VS Code: ${ (h.metadata && h.metadata.vscodeVersion) || 'N/A'}</div>
              </div>
            </div>
          `;
          if (logsView) logsView.appendChild(headerDiv);
        }
      }

      if (logsView && parsed && Array.isArray(parsed.events)) {
        const container = document.createElement('div');
        parsed.events.slice().reverse().forEach(e => {
          const row = document.createElement('div');
          let className = 'event';
          let flagReason = '';
          const et = (e.eventType || '').toString().toLowerCase();
          const len2 = (typeof e.pasteCharCount === 'number') ? e.pasteCharCount : ((typeof e.length === 'number') ? e.length : (typeof e.pasteLength === 'number' ? e.pasteLength : null));
          if (et === 'paste' || et === 'clipboard' || et === 'pasteevent') {
            if (len2 !== null && len2 > currentSettings.pasteLength) { className += ' paste'; flagReason = '(Large Paste)'; }
            else if (len2 === null) { className += ' paste'; }
          }
          if (et === 'input' && e.flightTime && parseInt(e.flightTime) < currentSettings.flight) { className += ' fast'; flagReason = '(Fast Input)'; }
          try { if (currentSettings.flagAiEvents && (et.startsWith('ai-') || e.possibleAiDetection)) { className += ' ai'; flagReason = '(AI-detected)'; } } catch (err) {}
          row.className = className;
          let html = `<div style="display:flex; justify-content:space-between;"><div><strong>${e.eventType || 'Unknown'}</strong> ${flagReason}</div><span class="meta">${e.time || ''}</span></div>`;
          // Helper to format file paths relative to the session workspace if possible
          const formatFilePath = (p) => {
            if (!p || typeof p !== 'string') return p;
            // try to use sessionHeader.project as workspace root
            const project = (parsed && parsed.sessionHeader && parsed.sessionHeader.project) || null;
            if (project) {
              const idx = p.indexOf(project);
              if (idx !== -1) {
                let rel = p.substring(idx + project.length);
                // strip leading path separators
                rel = rel.replace(/^\\+|^\/+/, '');
                // if empty, return project
                return rel || project;
              }
            }
            // fallback to basename
            const parts = p.split(/\\|\//);
            return parts[parts.length - 1] || p;
          };

          Object.keys(e).forEach(k => {
            if (['eventType','time'].includes(k)) return;
            let val = e[k];
            if (k === 'fileEdit' || k === 'fileView' || k === 'file' || k === 'filePath') {
              val = formatFilePath(val);
            }
            try {
              // stringify other complex values
              if (typeof val === 'object') val = JSON.stringify(val);
            } catch (err) {}
            html += `<div class="meta">${k}: ${val}</div>`;
          });
          row.innerHTML = html;
          container.appendChild(row);
        });
        if (logsView) logsView.appendChild(container);
      }
    }

    // Render parsed log as an expanded dropdown inside the dashboard per-file section
    function renderDashboardFileDropdown(parsed, filename) {
      // find the per-file container
      const filesSection = document.getElementById('per-file-section');
      if (!filesSection) return;
      // close previous
      if (expandedFile && expandedFile !== filename) {
        const prev = document.querySelector(`[data-file-row="${expandedFile}"]`);
        if (prev && prev.nextSibling && prev.nextSibling.classList && prev.nextSibling.classList.contains('file-dropdown')) prev.nextSibling.remove();
      }
      expandedFile = filename;
      const row = document.querySelector(`[data-file-row="${filename}"]`);
      if (!row) return;
      // remove any loading indicator on this row
      const loadIndicator = row.querySelector('.meta.loading');
      if (loadIndicator) loadIndicator.remove();
      // if already open, toggle close
      if (row.nextSibling && row.nextSibling.classList && row.nextSibling.classList.contains('file-dropdown')) {
        row.nextSibling.remove(); expandedFile = null; return;
      }
      const dropdown = document.createElement('div');
      dropdown.className = 'file-dropdown card';
      dropdown.style.marginTop = '8px';
      // simple rendering: reuse parts of parsed rendering
      let total = (parsed.events && parsed.events.length) || 0;
      let flagged = 0;
      if (parsed.events) parsed.events.forEach(e => {
        const et = (e.eventType || '').toString().toLowerCase();
        const len = (typeof e.pasteCharCount === 'number') ? e.pasteCharCount : ((typeof e.length === 'number') ? e.length : (typeof e.pasteLength === 'number' ? e.pasteLength : null));
        if (et === 'paste' || et === 'clipboard' || et === 'pasteevent') {
          if (len === null || len > currentSettings.pasteLength) flagged++;
        }
        if (et === 'input' && e.flightTime && parseInt(e.flightTime) < currentSettings.flight) flagged++;
        // flag AI-detected events when the setting is enabled
        try {
          if (currentSettings.flagAiEvents && (et.startsWith('ai-') || e.possibleAiDetection)) flagged++;
        } catch (err) {}
      });
      const score = total>0? Math.max(0, Math.round((1 - (flagged/total)) * 100)) : 100;
      // color based on score thresholds
      let scoreColor = '#10b981';
      if (score < 85) scoreColor = '#f59e0b';
      if (score < 50) scoreColor = '#ef4444';

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

      // compute specific affected factors for this file
      try {
        const affected = new Set();
        const getPasteLen = (ev) => {
          if (!ev) return null;
          if (typeof ev.pasteCharCount === 'number') return ev.pasteCharCount;
          if (typeof ev.pasteLength === 'number') return ev.pasteLength;
          if (typeof ev.length === 'number') return ev.length;
          return null;
        };
            if (parsed && Array.isArray(parsed.events)) {
          parsed.events.forEach(ev => {
            if (!ev || !ev.eventType) return;
            const et = (ev.eventType || '').toString().toLowerCase();
            if (et === 'input' && ev.flightTime && parseInt(ev.flightTime) < currentSettings.flight) affected.add(`Fast Typing (< ${currentSettings.flight}ms)`);
            if (et === 'paste' || et === 'ai-paste' || et === 'replace' || et === 'ai-replace') {
              const plen = getPasteLen(ev);
              if (plen === null || plen > currentSettings.pasteLength) affected.add(`Suspicious Pastes (> ${currentSettings.pasteLength} chars)`);
            }
            // Only list AI-assisted edits as affecting factors if flagging of AI events is enabled
            if (currentSettings.flagAiEvents && (et.startsWith('ai-') || et === 'ai-paste' || et === 'ai-replace' || et === 'ai-delete' || ev.possibleAiDetection)) affected.add('AI-assisted edits');
          });
        }

        let affectedHtml = '';
        if (affected.size === 0) affectedHtml = '<div class="meta">No notable factors detected.</div>';
        else {
          const items = Array.from(affected).map(item => {
            if (item.startsWith('Suspicious')) return `<strong style='color:#f59e0b'>${item}</strong>`;
            if (item.startsWith('Fast Typing')) return `<strong style='color:#8b5cf6'>${item}</strong>`;
            if (item.includes('AI')) return `<strong style='color:#60a5fa'>${item}</strong>`;
            return `<strong>${item}</strong>`;
          });
          affectedHtml = `<div class="meta">Score affected by ${items.join(' and ')}.</div>`;
        }
        dropdown.innerHTML += affectedHtml;
      } catch (err) {
        dropdown.innerHTML += `<div class="meta">Score factors unavailable.</div>`;
      }
      row.parentNode.insertBefore(dropdown, row.nextSibling);
    }
    function renderDashboard(data) {
      const container = $('dashboard-view');
      if (container) container.innerHTML = '';
      if (dashboardEmpty) dashboardEmpty.style.display = 'none';
      if (!data || !data.metrics) { if (container) container.innerHTML = '<div class="meta">No data available.</div>'; return; }
      const m = data.metrics;

      const top = document.createElement('div'); top.style.display = 'grid'; top.style.gridTemplateColumns = '1fr 1fr 1fr'; top.style.gap = '12px';
      const makeCard = (title, value, subtitle) => { const c = document.createElement('div'); c.className='card'; c.style.padding='12px'; c.innerHTML = `<div style="font-weight:700; font-size:1.1rem;">${value}</div><div class="meta">${title}${subtitle? ' • '+subtitle: ''}</div>`; return c; };
      top.appendChild(makeCard('AI Probability', m.aiProbability + '%'));
      top.appendChild(makeCard('Paste %', m.pasteRatio + '%', 'of all events'));
      top.appendChild(makeCard('Delete %', m.deleteRatio + '%', 'of all events'));
      const statsRow = document.createElement('div'); statsRow.style.display='flex'; statsRow.style.gap='12px'; statsRow.style.marginTop='12px';
      statsRow.appendChild(makeCard('Avg Paste Length', m.avgPasteLength + ' chars'));
      statsRow.appendChild(makeCard('Totals', data.totalLogs + ' logs • ' + data.totalEvents + ' events'));
      const barCard = document.createElement('div'); barCard.className='card'; barCard.style.padding='12px'; barCard.innerHTML = '<div style="font-weight:700; margin-bottom:8px;">AI Probability</div>';
      const barOuter = document.createElement('div'); barOuter.style.background='var(--bg)'; barOuter.style.border='1px solid var(--border)'; barOuter.style.borderRadius='8px'; barOuter.style.height='18px';
      const barInner = document.createElement('div'); barInner.style.height='100%'; barInner.style.width = m.aiProbability + '%'; barInner.style.background='linear-gradient(90deg, var(--accent), var(--accent-2))'; barInner.style.borderRadius='8px'; barOuter.appendChild(barInner); barCard.appendChild(barOuter);
      if (container) { container.appendChild(top); container.appendChild(statsRow); container.appendChild(barCard); }

      // per-file
      if (container) {
        const filesCard = document.createElement('div'); filesCard.className='card'; filesCard.style.marginTop='12px'; filesCard.innerHTML = '<h2>Per-file breakdown</h2>';
        const filesSection = document.createElement('div'); filesSection.id = 'per-file-section'; filesSection.style.marginTop = '8px';
        // header row
        const header = document.createElement('div'); header.style.display='grid'; header.style.gridTemplateColumns='2fr 1fr 1fr 1fr 1fr'; header.style.fontWeight='700'; header.style.gap='8px'; header.innerHTML = '<div>File</div><div>Events</div><div>Paste</div><div>AI Probability</div><div>Delete</div>';
        filesSection.appendChild(header);
        (data.perFile || []).forEach(f => {
          const row = document.createElement('div'); row.style.display='grid'; row.style.gridTemplateColumns='2fr 1fr 1fr 1fr 1fr'; row.style.gap='8px'; row.style.padding='8px 4px'; row.setAttribute('data-file-row', f.name || '');
          row.style.cursor = 'pointer';
          const name = document.createElement('div'); name.textContent = f.name || (f.error ? '(failed)' : 'unknown');
          const ev = document.createElement('div'); ev.textContent = f.events ? String(f.events) : '-';
          const p = document.createElement('div'); p.textContent = f.events ? (Math.round((f.paste||0)/Math.max(1,f.events)*1000)/10) + '%' : (f.error ? 'err' : '-');
          // AI probability value (provided by host as f.aiProbability or f.metrics.aiProbability)
          const aiVal = (typeof f.aiProbability === 'number') ? f.aiProbability : (f.metrics && typeof f.metrics.aiProbability === 'number' ? f.metrics.aiProbability : null);
          const ai = document.createElement('div'); ai.textContent = (aiVal === null || aiVal === undefined) ? (f.error ? 'err' : '-') : (String(aiVal) + '%');
          // color tiers: low=green, medium=amber, high=red
          try {
            if (aiVal !== null && aiVal !== undefined) {
              if (aiVal >= 75) ai.style.color = '#ef4444';
              else if (aiVal >= 40) ai.style.color = '#f59e0b';
              else ai.style.color = '#10b981';
            }
          } catch (err) {}
          const d = document.createElement('div'); d.textContent = f.events ? (Math.round((f.delete||0)/Math.max(1,f.events)*1000)/10) + '%' : (f.error ? 'err' : '-');
          row.appendChild(name); row.appendChild(ev); row.appendChild(p); row.appendChild(ai); row.appendChild(d);
          // click to expand per-file dropdown in dashboard
          row.addEventListener('click', (evClick) => {
            evClick.stopPropagation();
            const fname = f.name;
            // If already expanded, collapse
            if (expandedFile === fname) {
              const prev = document.querySelector(`[data-file-row="${expandedFile}"]`);
              if (prev && prev.nextSibling && prev.nextSibling.classList && prev.nextSibling.classList.contains('file-dropdown')) prev.nextSibling.remove();
              expandedFile = null;
              return;
            }
            requestedDashboardFile = fname;
            // visual feedback while loading
            const loading = document.createElement('div'); loading.className = 'meta loading'; loading.textContent = 'Loading...';
            // remove any existing temp loaders
            const existing = document.querySelector(`[data-file-row="${fname}"] .meta.loading`);
            if (!existing) name.appendChild(loading);
            post('openLog', { filename: fname });
          });
          filesSection.appendChild(row);
        });
        filesCard.appendChild(filesSection);
        container.appendChild(filesCard);
      }
    }

    function showDashboardLoading() { const container = $('dashboard-view'); if (dashboardEmpty) dashboardEmpty.style.display='none'; if (!container) return; container.innerHTML=''; const card=document.createElement('div'); card.className='card'; card.style.textAlign='center'; card.innerHTML = '<div style="font-weight:700; margin-bottom:8px;">Loading dashboard</div>'; const spinner=document.createElement('div'); spinner.className='spinner'; card.appendChild(spinner); container.appendChild(card); }

    // actions
    const refreshDashboardBtn = $('refreshDashboard'); if (refreshDashboardBtn) refreshDashboardBtn.addEventListener('click', () => { if (status) status.textContent='Analyzing logs...'; showDashboardLoading(); post('analyzeLogs'); });
    const saveSettingsBtn = $('saveSettings'); if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', () => {
      const settings = {
        inactivityThreshold: parseInt(inactivityInput?.value||defaults.inactivity),
        flightTimeThreshold: parseInt(flightInput?.value||defaults.flight),
        pasteLengthThreshold: parseInt(pasteLengthInput?.value||defaults.pasteLength),
        flagAiEvents: !!(flagAiCheckbox && flagAiCheckbox.checked)
      };
      post('saveSettings', { settings });
    });
    const resetSettingsBtn = $('resetSettings'); if (resetSettingsBtn) resetSettingsBtn.addEventListener('click', () => { if (inactivityInput) inactivityInput.value = defaults.inactivity; if (flightInput) flightInput.value = defaults.flight; if (pasteLengthInput) pasteLengthInput.value = defaults.pasteLength; if (flagAiCheckbox) flagAiCheckbox.checked = true; post('saveSettings', { settings: { inactivityThreshold: defaults.inactivity, flightTimeThreshold: defaults.flight, pasteLengthThreshold: defaults.pasteLength, flagAiEvents: true } }); });

    // messages from extension
    window.addEventListener('message', event => {
      const msg = event.data || {};
      switch (msg.command) {
        case 'logList': logNamesCache = (msg.data||[]).slice().sort().reverse(); if (logCountLabel) logCountLabel.textContent = logNamesCache.length + ' logs found'; renderDropdown(logNamesCache); break;
        case 'logData':
          // If we requested this file for the dashboard per-file dropdown, and we are on dashboard, render it there
          if (requestedDashboardFile && msg.filename === requestedDashboardFile && currentTab === 'dashboard') {
            try { renderDashboardFileDropdown(msg.data, msg.filename); } catch (e) {}
            requestedDashboardFile = null;
            if (status) status.textContent = 'Loaded ' + msg.filename;
            break;
          }
          // otherwise render into the logs pane
          try { renderParsedInLogs(msg.data, msg.filename); } catch (e) {}
          if (status) status.textContent = 'Loaded ' + msg.filename;
          break;
        case 'dashboardData':
          renderDashboard(msg.data);
          // Dashboard is an aggregate over all logs — show that to the user
          if (dashboardLogName) dashboardLogName.textContent = 'Viewing: All logs';
          if (status) status.textContent = 'Dashboard updated';
          break;
        case 'rawData': if (logsViewerContainer) logsViewerContainer.style.display='block'; if (logsView) logsView.innerHTML = '<pre>' + msg.data + '</pre>'; if (dashboardView) dashboardView.innerHTML = '<div class="card"><h2>Raw Data Only</h2><p class="meta">Score unavailable.</p></div>'; if (status) status.textContent = 'Loaded ' + msg.filename; break;
        case 'loadSettings': if (msg.settings) {
            currentSettings = {
              inactivity: msg.settings.inactivityThreshold || defaults.inactivity,
              flight: msg.settings.flightTimeThreshold || defaults.flight,
              pasteLength: msg.settings.pasteLengthThreshold || defaults.pasteLength,
              flagAiEvents: (typeof msg.settings.flagAiEvents === 'boolean') ? msg.settings.flagAiEvents : true
            };
            if (inactivityInput) inactivityInput.value = currentSettings.inactivity;
            if (flightInput) flightInput.value = currentSettings.flight;
            if (pasteLengthInput) pasteLengthInput.value = currentSettings.pasteLength;
            if (flagAiCheckbox) flagAiCheckbox.checked = !!currentSettings.flagAiEvents;
          } break;
        case 'settingsSaved':
          if (inactivityInput) currentSettings.inactivity = parseInt(inactivityInput.value);
          if (flightInput) currentSettings.flight = parseInt(flightInput.value);
          if (pasteLengthInput) currentSettings.pasteLength = parseInt(pasteLengthInput.value);
          if (flagAiCheckbox) currentSettings.flagAiEvents = !!flagAiCheckbox.checked;
          if (settingsMsg) { settingsMsg.textContent = 'Settings saved successfully!'; setTimeout(()=>settingsMsg.textContent='',3000); }
          break;
        case 'error': if (status) status.textContent = 'Error: ' + (msg.message || ''); break;
      }
    });

    // startup
    try { switchTab('dashboard'); } catch (e) {}
    try { if (dashboardEmpty) dashboardEmpty.style.display = 'none'; } catch (e) {}
    try { if (typeof showDashboardLoading === 'function') showDashboardLoading(); } catch (e) {}
    // ping extension that client loaded, request dashboard + logs + settings
    post('clientReady');
    post('analyzeLogs');
    post('listLogs');
    post('getSettings');
  });

})();
