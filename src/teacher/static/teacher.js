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
  let currentTeacherClasses = [];
  let currentClassId = null;
  let editingClassId = null;
  let currentClassAssignments = [];
  let classRefreshAnimationTimer = null;
  let currentAssignmentId = null;
  let currentAssignmentName = "";
  let currentClassDetailTab = "assignments";
  let currentClassDisplayName = "";
  let currentAssignmentStudents = [];
  let selectedComparisonStudentIds = [];
  let currentAssignmentComparison = null;
  let currentComparisonFilters = {
    input: true,
    edit: true,
    paste: true,
    ai: true,
    focus: true,
    run: true,
    other: true,
  };

  window.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);
    const status = $("status");
    const searchInput = $("log-search-input");
    const dropdown = $("log-dropdown");
    const hamburgerBtn = $("hamburger");
    const sidebarEl = document.querySelector(".sidebar");
    const assignSearchInput = $("assignment-student-search");
    const assignSearchClear = $("assignment-search-clear");
    const assignSearchDropdown = $("assignment-student-dropdown");
    const assignSortSelect = $("assignment-student-sort");

    // Helper to draw and filter the autocomplete dropdown
    function updateAssignmentSearchDropdown() {
      if (!assignSearchDropdown || !assignSearchInput) {
        return;
      }
      const term = assignSearchInput.value.toLowerCase();

      // Toggle "X" clear button
      if (assignSearchClear) {
        assignSearchClear.style.display = term ? "block" : "none";
      }

      assignSearchDropdown.innerHTML = "";
      const students = currentAssignmentStudents || [];
      const filtered = students.filter((s) => {
        const name = (s.studentName || "").toLowerCase();
        const email = (s.studentEmail || "").toLowerCase();
        return name.includes(term) || email.includes(term);
      });

      if (filtered.length === 0) {
        assignSearchDropdown.innerHTML =
          '<div style="padding: 10px 14px; color: var(--muted); font-size: 0.9rem;">No students found</div>';
      } else {
        filtered.forEach((s) => {
          const div = document.createElement("div");
          div.style.cssText =
            "padding: 10px 14px; cursor: pointer; border-bottom: 1px solid var(--border); font-size: 0.9rem;";
          div.innerHTML = `<strong>${s.studentName || "Unknown"}</strong> <span class="meta" style="font-size: 0.8rem; margin-left: 6px;">${s.studentEmail || ""}</span>`;

          // Hover effect
          div.onmouseover = () => (div.style.background = "var(--bg)");
          div.onmouseout = () => (div.style.background = "transparent");

          // On click: set value, hide dropdown, and update UI
          div.addEventListener("mousedown", (e) => {
            e.preventDefault(); // Prevents input from losing focus
            assignSearchInput.value = s.studentName || s.studentEmail || "";
            assignSearchDropdown.style.display = "none";
            if (assignSearchClear) {
              assignSearchClear.style.display = "block";
            }
            renderAssignmentStudentCards();
          });
          assignSearchDropdown.appendChild(div);
        });
      }
      assignSearchDropdown.style.display = "block";
    }

    // Attach listeners for Search Input
    if (assignSearchInput) {
      assignSearchInput.addEventListener(
        "focus",
        updateAssignmentSearchDropdown,
      );
      assignSearchInput.addEventListener("input", () => {
        updateAssignmentSearchDropdown();
        renderAssignmentStudentCards();
      });
    }

    // Attach listeners for "X" Clear Button
    if (assignSearchClear) {
      assignSearchClear.addEventListener("click", () => {
        if (assignSearchInput) {
          assignSearchInput.value = "";
          assignSearchInput.focus();
        }
        assignSearchClear.style.display = "none";
        updateAssignmentSearchDropdown();
        renderAssignmentStudentCards();
      });
    }

    // Attach listeners for Sort Dropdown
    if (assignSortSelect) {
      assignSortSelect.addEventListener("change", renderAssignmentStudentCards);
    }

    // Close the autocomplete dropdown if the user clicks anywhere else on the screen
    document.addEventListener("click", (e) => {
      if (
        assignSearchInput &&
        assignSearchDropdown &&
        !assignSearchInput.contains(e.target) &&
        !assignSearchDropdown.contains(e.target)
      ) {
        assignSearchDropdown.style.display = "none";
      }
    });

    function post(command, payload = {}) {
      try {
        vscode.postMessage(Object.assign({ command }, payload));
      } catch (e) {}
    }

    const meetingDays = [
      { key: "mon", label: "Mon" },
      { key: "tue", label: "Tue" },
      { key: "wed", label: "Wed" },
      { key: "thu", label: "Thu" },
      { key: "fri", label: "Fri" },
      { key: "sat", label: "Sat" },
      { key: "sun", label: "Sun" },
    ];

    function clearMeetingScheduleInputs() {
      meetingDays.forEach((day) => {
        const box = $(`class-day-${day.key}`);
        if (box) {
          box.checked = false;
        }
      });
      if ($("class-meeting-start")) {
        $("class-meeting-start").value = "";
        $("class-meeting-start").dataset.timeValue = "";
      }
      if ($("class-meeting-end")) {
        $("class-meeting-end").value = "";
        $("class-meeting-end").dataset.timeValue = "";
      }
      if ($("class-meeting-time")) {
        $("class-meeting-time").value = "";
      }
    }

    function formatTimeTo12Hour(value) {
      const input = String(value || "").trim();
      const match = input.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) {
        return input;
      }

      let hours = Number(match[1]);
      const minutes = match[2];
      if (!Number.isFinite(hours)) {
        return input;
      }

      const period = hours >= 12 ? "PM" : "AM";
      hours = hours % 12;
      if (hours === 0) {
        hours = 12;
      }
      return `${hours}:${minutes} ${period}`;
    }

    function parseDisplayTimeTo24Hour(value) {
      const input = String(value || "").trim();
      if (!input) {
        return "";
      }

      // Already 24h
      if (/^\d{1,2}:\d{2}$/.test(input)) {
        const [h, m] = input.split(":").map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) {
          return "";
        }
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      }

      // 12h format (h:mm AM/PM)
      const match = input.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!match) {
        return "";
      }
      let hours = Number(match[1]);
      const minutes = Number(match[2]);
      const meridian = String(match[3] || "").toUpperCase();

      if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 1 || hours > 12 || minutes < 0 || minutes > 59) {
        return "";
      }
      if (meridian === "AM") {
        if (hours === 12) {
          hours = 0;
        }
      } else if (meridian === "PM") {
        if (hours !== 12) {
          hours += 12;
        }
      }

      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    }

    function getCanonicalTimeValue(inputEl) {
      if (!inputEl) {
        return "";
      }
      const dataValue = String(inputEl.dataset.timeValue || "").trim();
      if (dataValue) {
        return dataValue;
      }
      return parseDisplayTimeTo24Hour(inputEl.value || "");
    }

    function buildMeetingScheduleText() {
      const selectedDays = meetingDays
        .filter((day) => !!$(`class-day-${day.key}`)?.checked)
        .map((day) => day.label);
      const start = getCanonicalTimeValue($("class-meeting-start"));
      const end = getCanonicalTimeValue($("class-meeting-end"));

      if (!selectedDays.length || !start || !end) {
        return "";
      }
      return `${selectedDays.join(", ")} | ${start}-${end}`;
    }

    function applyMeetingScheduleText(meetingTimeRaw) {
      clearMeetingScheduleInputs();
      const meetingTime = String(meetingTimeRaw || "").trim();
      if (!meetingTime) {
        return;
      }

      if ($("class-meeting-time")) {
        $("class-meeting-time").value = meetingTime;
      }

      const [daysPart, timePart] = meetingTime.split("|").map((s) => String(s || "").trim());
      if (daysPart) {
        const selected = daysPart.split(",").map((s) => s.trim().toLowerCase());
        meetingDays.forEach((day) => {
          const box = $(`class-day-${day.key}`);
          if (box) {
            box.checked = selected.includes(day.label.toLowerCase());
          }
        });
      }

      if (timePart && timePart.includes("-")) {
        const [start, end] = timePart.split("-").map((s) => s.trim());
        if ($("class-meeting-start")) {
          $("class-meeting-start").dataset.timeValue = start || "";
          $("class-meeting-start").value = start ? formatTimeTo12Hour(start) : "";
        }
        if ($("class-meeting-end")) {
          $("class-meeting-end").dataset.timeValue = end || "";
          $("class-meeting-end").value = end ? formatTimeTo12Hour(end) : "";
        }
      }
    }

    function formatTimeTo12Hour(value) {
      const input = String(value || "").trim();
      const match = input.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) {
        return input;
      }

      let hours = Number(match[1]);
      const minutes = match[2];
      if (!Number.isFinite(hours)) {
        return input;
      }

      const period = hours >= 12 ? "PM" : "AM";
      hours = hours % 12;
      if (hours === 0) {
        hours = 12;
      }
      return `${hours}:${minutes} ${period}`;
    }

    function formatMeetingTimeDisplay(meetingTimeRaw) {
      const meetingTime = String(meetingTimeRaw || "").trim();
      if (!meetingTime) {
        return "—";
      }

      const [daysPart, timePart] = meetingTime
        .split("|")
        .map((segment) => String(segment || "").trim());

      if (!timePart || !timePart.includes("-")) {
        return meetingTime;
      }

      const [start, end] = timePart.split("-").map((segment) => String(segment || "").trim());
      const start12 = formatTimeTo12Hour(start);
      const end12 = formatTimeTo12Hour(end);
      if (!daysPart) {
        return `${start12}-${end12}`;
      }
      return `${daysPart} | ${start12}-${end12}`;
    }

    function formatClassDateDisplay(dateValueRaw) {
      const input = String(dateValueRaw || "").trim();
      if (!input) {
        return "—";
      }

      // Treat yyyy-mm-dd and full ISO as calendar dates to avoid timezone day shifting.
      const short = input.slice(0, 10);
      const parts = short.split("-").map((part) => Number(part));
      if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) {
        const [year, month, day] = parts;
        const localDate = new Date(year, month - 1, day);
        return localDate.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      }

      const fallback = new Date(input);
      if (Number.isNaN(fallback.getTime())) {
        return input;
      }
      return fallback.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }

    function parseCalendarDate(dateValueRaw) {
      const input = String(dateValueRaw || "").trim();
      if (!input) {
        return null;
      }

      const short = input.slice(0, 10);
      const parts = short.split("-").map((part) => Number(part));
      if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) {
        const [year, month, day] = parts;
        const localDate = new Date(year, month - 1, day);
        if (!Number.isNaN(localDate.getTime())) {
          return localDate;
        }
      }

      const fallback = new Date(input);
      return Number.isNaN(fallback.getTime()) ? null : fallback;
    }

    function normalizeDateForInput(dateValueRaw) {
      const input = String(dateValueRaw || "").trim();
      if (!input) {
        return "";
      }

      const short = input.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(short)) {
        return short;
      }

      const parsed = new Date(input);
      if (Number.isNaN(parsed.getTime())) {
        return "";
      }

      return parsed.toISOString().slice(0, 10);
    }

    function installDatePickerBehavior() {
      const targetIds = new Set([
        "class-start-date",
        "class-end-date",
        "class-meeting-start",
        "class-meeting-end",
        "assignment-due-date",
      ]);

      const getTargetDateInput = (event) => {
        const el = event.target;
        if (!(el instanceof HTMLInputElement)) {
          return null;
        }
        if ((el.type !== "date" && el.type !== "time") || !targetIds.has(el.id)) {
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

    function installTimePickerOnlyBehavior() {
      const targetIds = ["class-meeting-start", "class-meeting-end"];

      const times = [];
      for (let hour = 0; hour < 24; hour++) {
        for (const minute of [0, 15, 30, 45]) {
          const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
          times.push({ value, label: formatTimeTo12Hour(value) });
        }
      }

      let dropdown = null;
      let activeInput = null;
      let highlightedIndex = -1;
      let currentVisibleTimes = times.slice();
      let renderedButtons = [];
      const lastSuggestedByInputId = new Map();

      const closeDropdown = () => {
        if (dropdown) {
          dropdown.style.display = "none";
        }
        activeInput = null;
        highlightedIndex = -1;
        currentVisibleTimes = times.slice();
        renderedButtons = [];
      };

      const ensureDropdown = () => {
        if (dropdown) {
          return dropdown;
        }
        dropdown = document.createElement("div");
        dropdown.id = "class-time-dropdown";
        dropdown.style.position = "fixed";
        dropdown.style.zIndex = "500";
        dropdown.style.maxHeight = "220px";
        dropdown.style.overflowY = "auto";
        dropdown.style.minWidth = "210px";
        dropdown.style.padding = "6px";
        dropdown.style.border = "1px solid var(--border)";
        dropdown.style.borderRadius = "10px";
        dropdown.style.background = "var(--surface)";
        dropdown.style.boxShadow = "0 12px 28px rgba(0,0,0,0.25)";
        dropdown.style.display = "none";
        document.body.appendChild(dropdown);
        return dropdown;
      };

      const positionDropdown = (inputEl) => {
        if (!dropdown || !inputEl) {
          return;
        }
        const rect = inputEl.getBoundingClientRect();
        dropdown.style.left = `${Math.max(8, rect.left)}px`;
        dropdown.style.top = `${Math.min(window.innerHeight - 230, rect.bottom + 4)}px`;
        dropdown.style.width = `${Math.max(180, rect.width)}px`;
      };

      const getGhostEl = (inputEl) => {
        if (!(inputEl instanceof HTMLInputElement) || !inputEl.id) {
          return null;
        }
        const el = document.getElementById(`${inputEl.id}-ghost`);
        return el instanceof HTMLElement ? el : null;
      };

      const hideGhost = (inputEl) => {
        const ghost = getGhostEl(inputEl);
        if (!ghost) {
          return;
        }
        ghost.style.display = "none";
        ghost.innerHTML = "";
      };

      const syncGhostTypography = (inputEl) => {
        const ghost = getGhostEl(inputEl);
        if (!ghost || !(inputEl instanceof HTMLInputElement)) {
          return;
        }
        const computed = window.getComputedStyle(inputEl);
        ghost.style.font = computed.font;
        ghost.style.fontSize = computed.fontSize;
        ghost.style.lineHeight = computed.lineHeight;
        ghost.style.letterSpacing = computed.letterSpacing;
        ghost.style.textTransform = computed.textTransform;
        ghost.style.padding = computed.padding;
      };

      const updateGhost = (inputEl) => {
        const ghost = getGhostEl(inputEl);
        if (!ghost || activeInput !== inputEl || highlightedIndex < 0 || highlightedIndex >= currentVisibleTimes.length) {
          hideGhost(inputEl);
          return;
        }

        const suggestion = String(currentVisibleTimes[highlightedIndex]?.label || "");
        const typed = String(inputEl.value || "");
        if (!suggestion || !typed || !suggestion.toLowerCase().startsWith(typed.toLowerCase())) {
          hideGhost(inputEl);
          return;
        }

        syncGhostTypography(inputEl);
        ghost.innerHTML = "";

        const typedSpan = document.createElement("span");
        typedSpan.textContent = typed;
        typedSpan.style.visibility = "hidden";

        const suffixSpan = document.createElement("span");
        suffixSpan.textContent = suggestion.slice(typed.length);
        suffixSpan.style.color = "var(--muted)";
        suffixSpan.style.opacity = "0.85";

        if (!suffixSpan.textContent) {
          hideGhost(inputEl);
          return;
        }

        ghost.appendChild(typedSpan);
        ghost.appendChild(suffixSpan);
        ghost.style.display = "block";
      };

      const getStrictMinuteDigits = (value) => {
        const input = String(value || "").toUpperCase();
        const match = input.match(/^\s*\d{1,2}:(\d{2})(?:\s*[AP]M?)?\s*$/);
        return match ? String(match[1] || "") : "";
      };

      const getPeriodPriorityFromQuery = (query) => {
        const raw = String(query || "").trim().toUpperCase();
        if (!raw) {
          return null;
        }

        const numericMatch = raw.match(/^(\d{1,2})/);
        if (!numericMatch) {
          return null;
        }

        const hour = Number(numericMatch[1]);
        if (!Number.isFinite(hour) || hour < 1 || hour > 12) {
          return null;
        }

        if (hour === 12) {
          return "PM";
        }

        if (hour >= 9 && hour <= 11) {
          return "AM";
        }
        if (hour >= 1 && hour <= 8) {
          return "PM";
        }
        return null;
      };

      const getPeriodFromEntry = (entry) => {
        const canonical = String(entry?.value || "");
        const hour24 = Number(canonical.split(":")[0]);
        if (!Number.isFinite(hour24)) {
          return "";
        }
        return hour24 >= 12 ? "PM" : "AM";
      };

      const reorderByPeriodPreference = (entries, query) => {
        const preferred = getPeriodPriorityFromQuery(query);
        if (!preferred || !Array.isArray(entries) || entries.length <= 1) {
          return entries;
        }

        return entries.slice().sort((a, b) => {
          const aPreferred = getPeriodFromEntry(a) === preferred ? 0 : 1;
          const bPreferred = getPeriodFromEntry(b) === preferred ? 0 : 1;
          if (aPreferred !== bPreferred) {
            return aPreferred - bPreferred;
          }
          return times.indexOf(a) - times.indexOf(b);
        });
      };

      const getPreferredPeriodFromHour12 = (hour12) => {
        const hour = Number(hour12);
        if (!Number.isFinite(hour) || hour < 1 || hour > 12) {
          return "AM";
        }
        if (hour === 12) {
          return "PM";
        }
        if (hour >= 9 && hour <= 11) {
          return "AM";
        }
        return "PM";
      };

      const reorderForBlankInput = (entries, query) => {
        if (!Array.isArray(entries) || entries.length <= 1 || String(query || "").trim()) {
          return entries;
        }
        const startIndex = entries.findIndex((entry) => String(entry?.value || "") === "08:00");
        if (startIndex <= 0) {
          return entries;
        }
        return entries.slice(startIndex).concat(entries.slice(0, startIndex));
      };

      const normalizeTimeSearch = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

      const getHour12FromCanonical = (canonical) => {
        const parts = String(canonical || "").split(":");
        const hour24 = Number(parts[0]);
        if (!Number.isFinite(hour24)) {
          return "";
        }
        let hour12 = hour24 % 12;
        if (hour12 === 0) {
          hour12 = 12;
        }
        return String(hour12);
      };

      const getTimeSearchTokens = (entry) => {
        const tokens = [];
        const canonical = String(entry.value || "");
        const label = String(entry.label || "");
        const labelLower = label.toLowerCase();

        tokens.push(labelLower);
        tokens.push(canonical);
        tokens.push(labelLower.replace(/\s+/g, ""));

        const parts = canonical.split(":");
        const hour = Number(parts[0]);
        const minute = String(parts[1] || "00");
        if (Number.isFinite(hour)) {
          const period = hour >= 12 ? "pm" : "am";
          let hour12 = hour % 12;
          if (hour12 === 0) {
            hour12 = 12;
          }
          const hourText = String(hour12);
          tokens.push(`${hourText}${period}`);
          tokens.push(`${hourText}:${minute}${period}`);
          tokens.push(`${hourText}:${minute} ${period}`);
        }

        return tokens;
      };

      const entryMatchesQuery = (entry, query) => {
        const raw = String(query || "").trim().toLowerCase();
        if (!raw) {
          return true;
        }

        const hourMinutePrefixMatch = raw.match(/^(\d{1,2}):(\d{0,2})$/);
        if (hourMinutePrefixMatch) {
          const queryHour = String(Number(hourMinutePrefixMatch[1]));
          const queryMinutePrefix = String(hourMinutePrefixMatch[2] || "");

          const canonical = String(entry.value || "");
          const [hour24Text, minuteText = ""] = canonical.split(":");
          const hour24 = Number(hour24Text);
          if (!Number.isFinite(hour24)) {
            return false;
          }

          let hour12 = hour24 % 12;
          if (hour12 === 0) {
            hour12 = 12;
          }

          if (String(hour12) !== queryHour) {
            return false;
          }
          return minuteText.startsWith(queryMinutePrefix);
        }

        // Pure hour typing should match hour semantics, not normalized text prefixes.
        if (/^\d{1,2}$/.test(raw)) {
          const hourText = getHour12FromCanonical(entry.value);
          if (!hourText) {
            return false;
          }
          if (raw.length === 1) {
            if (raw === "1") {
              return hourText === "1" || hourText === "10" || hourText === "11" || hourText === "12";
            }
            return hourText === raw;
          }
          return hourText === raw;
        }

        const normalizedQuery = normalizeTimeSearch(raw);
        return getTimeSearchTokens(entry).some((token) => {
          const tokenLower = String(token || "").toLowerCase();
          const normalizedToken = normalizeTimeSearch(tokenLower);
          return tokenLower.startsWith(raw) || normalizedToken.startsWith(normalizedQuery);
        });
      };

      const sanitizeMinuteDigits = (minuteDigitsRaw) => {
        const minuteDigits = String(minuteDigitsRaw || "").replace(/\D/g, "").slice(0, 2);
        if (!minuteDigits) {
          return "";
        }
        if (minuteDigits.length === 1) {
          return Number(minuteDigits[0]) <= 5 ? minuteDigits : "";
        }
        if (Number(minuteDigits[0]) > 5) {
          return minuteDigits[1] ? minuteDigits[1] : "";
        }
        return minuteDigits;
      };

      const normalizeTypedTimeInput = (rawValue) => {
        let raw = String(rawValue || "");
        raw = raw.toUpperCase().replace(/[^\d:APM\s]/g, "");
        if (!raw) {
          return "";
        }

        const meridianLetters = raw.replace(/[^APM]/g, "");
        let meridian = "";
        if (meridianLetters.startsWith("AM")) {
          meridian = "AM";
        } else if (meridianLetters.startsWith("PM")) {
          meridian = "PM";
        } else if (meridianLetters.startsWith("A")) {
          meridian = "A";
        } else if (meridianLetters.startsWith("P")) {
          meridian = "P";
        }

        raw = raw.replace(/[^\d:]/g, "");

        const firstColon = raw.indexOf(":");
        let hasColon = firstColon >= 0;
        let hourPart = hasColon ? raw.slice(0, firstColon) : raw;
        let minutePart = hasColon ? raw.slice(firstColon + 1).replace(/:/g, "") : "";
        hourPart = hourPart.replace(/\D/g, "");

        if (!hourPart) {
          return "";
        }

        const first = hourPart[0];
        if (first === "0") {
          const next = hourPart[1] || "";
          if (!next || next === "0") {
            return "";
          }
          hourPart = next;
        }

        if (!hourPart) {
          return "";
        }

        if (!hasColon) {
          if (first === "1") {
            if (hourPart.length === 1) {
              return "1";
            }
            const second = hourPart[1];
            if (!["0", "1", "2"].includes(second)) {
              return "1";
            }
            const minuteDigits = sanitizeMinuteDigits(hourPart.slice(2));
            const base = minuteDigits ? `1${second}:${minuteDigits}` : `1${second}:`;
            return meridian ? `${base} ${meridian}` : base;
          }

          if (/^[2-9]$/.test(first)) {
            const minuteDigits = sanitizeMinuteDigits(hourPart.slice(1));
            const base = minuteDigits ? `${first}:${minuteDigits}` : `${first}:`;
            return meridian ? `${base} ${meridian}` : base;
          }

          return "";
        }

        if (hourPart[0] === "1") {
          if (hourPart.length > 2) {
            hourPart = hourPart.slice(0, 2);
          }
          if (hourPart.length === 2 && !["0", "1", "2"].includes(hourPart[1])) {
            hourPart = "1";
          }
        } else if (/^[2-9]/.test(hourPart[0])) {
          hourPart = hourPart[0];
        } else {
          return "";
        }

        minutePart = sanitizeMinuteDigits(minutePart);
        const base = `${hourPart}:${minutePart}`;
        return meridian ? `${base} ${meridian}` : base;
      };

      const syncInputTimeValue = (inputEl, keepTypedText = false) => {
        if (!(inputEl instanceof HTMLInputElement)) {
          return;
        }
        const normalized = normalizeTypedTimeInput(inputEl.value || "");
        if (normalized !== inputEl.value) {
          inputEl.value = normalized;
        }

        let canonical = "";
        if (normalized) {
          // Interpret naked 12h input as AM by default for storage until a concrete selection occurs.
          const maybe12Hour = `${normalized} AM`;
          canonical = parseDisplayTimeTo24Hour(maybe12Hour) || parseDisplayTimeTo24Hour(normalized) || "";
        }

        inputEl.dataset.timeValue = canonical;

        if (!keepTypedText && canonical) {
          inputEl.value = formatTimeTo12Hour(canonical);
        }

        if (!keepTypedText) {
          hideGhost(inputEl);
        }
      };

      const tryFinalizeCustomTimeOnBlur = (inputEl) => {
        if (!(inputEl instanceof HTMLInputElement)) {
          return "";
        }

        const normalized = normalizeTypedTimeInput(inputEl.value || "");
        const match = normalized.match(/^\s*(\d{1,2}):(\d{1,2})(?:\s*(AM|PM|A|P))?\s*$/i);
        if (!match) {
          return "";
        }

        const hour12 = Number(match[1]);
        if (!Number.isFinite(hour12) || hour12 < 1 || hour12 > 12) {
          return "";
        }

        let minute = String(match[2] || "");
        if (minute.length === 1) {
          minute = `${minute}0`;
        }
        if (minute.length !== 2) {
          return "";
        }

        let period = String(match[3] || "").toUpperCase();
        if (period === "A") {
          period = "AM";
        } else if (period === "P") {
          period = "PM";
        }
        if (!period) {
          period = getPreferredPeriodFromHour12(hour12);
        }

        const canonical = parseDisplayTimeTo24Hour(`${hour12}:${minute} ${period}`);
        if (!canonical) {
          return "";
        }

        inputEl.dataset.timeValue = canonical;
        inputEl.value = formatTimeTo12Hour(canonical);
        return canonical;
      };

      const setInputToEntry = (inputEl, entry) => {
        if (!(inputEl instanceof HTMLInputElement) || !entry) {
          return;
        }
        inputEl.dataset.timeValue = entry.value;
        inputEl.value = entry.label;
      };

      const coerceTypedTime = (inputEl) => {
        if (!(inputEl instanceof HTMLInputElement)) {
          return "";
        }
        const customFinalized = tryFinalizeCustomTimeOnBlur(inputEl);
        if (customFinalized) {
          hideGhost(inputEl);
          return customFinalized;
        }
        syncInputTimeValue(inputEl, false);
        const canonical = String(inputEl.dataset.timeValue || "");
        if (!canonical) {
          inputEl.dataset.timeValue = "";
          return "";
        }
        return canonical;
      };

      const refreshHighlightStyles = () => {
        renderedButtons.forEach((button, index) => {
          const active = index === highlightedIndex;
          button.style.background = active ? "var(--accent)" : "transparent";
          button.style.color = active ? "white" : "var(--fg)";
        });

        if (
          activeInput &&
          activeInput.id &&
          highlightedIndex >= 0 &&
          highlightedIndex < currentVisibleTimes.length
        ) {
          lastSuggestedByInputId.set(activeInput.id, currentVisibleTimes[highlightedIndex]);
        }

        if (activeInput) {
          updateGhost(activeInput);
        }
      };

      const renderDropdown = (inputEl, filterText, preserveHighlight = false) => {
        if (!(inputEl instanceof HTMLInputElement)) {
          return;
        }

        activeInput = inputEl;
        const panel = ensureDropdown();
        panel.innerHTML = "";
        renderedButtons = [];

        const filter = String(filterText ?? inputEl.value ?? "");
        const strictMinute = getStrictMinuteDigits(filter);
        if (strictMinute && !["00", "15", "30", "45"].includes(strictMinute)) {
          closeDropdown();
          hideGhost(inputEl);
          return;
        }

        const filtered = reorderForBlankInput(
          reorderByPeriodPreference(
            times.filter((entry) => entryMatchesQuery(entry, filter)),
            filter,
          ),
          filter,
        );
        currentVisibleTimes = filtered.length ? filtered : [];

        if (!currentVisibleTimes.length && String(filter || "").trim()) {
          closeDropdown();
          hideGhost(inputEl);
          return;
        }

        const current = getCanonicalTimeValue(inputEl);
        let preferredIndex = currentVisibleTimes.findIndex((entry) => entry.value === current);
        if (preferredIndex < 0) {
          preferredIndex = currentVisibleTimes.length ? 0 : -1;
        }

        if (!preserveHighlight || highlightedIndex < 0 || highlightedIndex >= currentVisibleTimes.length) {
          highlightedIndex = preferredIndex;
        }

        if (!currentVisibleTimes.length) {
          const empty = document.createElement("div");
          empty.textContent = "No matching times";
          empty.style.padding = "8px 10px";
          empty.style.color = "var(--muted)";
          empty.style.fontSize = "12px";
          panel.appendChild(empty);
        }

        currentVisibleTimes.forEach((entry, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = entry.label;
          button.style.width = "100%";
          button.style.textAlign = "left";
          button.style.padding = "8px 10px";
          button.style.border = "none";
          button.style.borderRadius = "8px";
          button.style.cursor = "pointer";

          button.addEventListener("mouseenter", () => {
            highlightedIndex = index;
            refreshHighlightStyles();
          });

          button.addEventListener("mousedown", (event) => {
            event.preventDefault();
            setInputToEntry(inputEl, entry);
            closeDropdown();
          });

          panel.appendChild(button);
          renderedButtons.push(button);
        });

        refreshHighlightStyles();

        positionDropdown(inputEl);
        panel.style.display = "block";

        if (highlightedIndex >= 0 && panel.children[highlightedIndex]) {
          panel.children[highlightedIndex].scrollIntoView({ block: "nearest" });
        }
        updateGhost(inputEl);
      };

      const openDropdown = (inputEl, filterText, preserveHighlight = false) => {
        renderDropdown(inputEl, filterText, preserveHighlight);
      };

      targetIds.forEach((id) => {
        const el = $(id);
        if (!(el instanceof HTMLInputElement)) {
          return;
        }

        el.addEventListener("keydown", (event) => {
          const isCharKey = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
          if (isCharKey) {
            const caretStart = Number(el.selectionStart ?? el.value.length);
            const meridianStart = el.value.indexOf(" ");
            const inMeridian = meridianStart >= 0 && caretStart > meridianStart;
            const hasMinuteSection = /^\d{1,2}:\d{1,2}/.test(el.value);

            if (/\d/.test(event.key)) {
              if (inMeridian) {
                event.preventDefault();
                return;
              }
            } else if (/[apmAPM]/.test(event.key)) {
              const canTypeMeridian = hasMinuteSection && (inMeridian || caretStart >= el.value.length - 1);
              if (!canTypeMeridian) {
                event.preventDefault();
                return;
              }
            } else if (event.key !== ":") {
              event.preventDefault();
              return;
            }
          }

          if (event.key === "Backspace") {
            const start = Number(el.selectionStart ?? 0);
            const end = Number(el.selectionEnd ?? 0);
            if (start === end && start > 0 && el.value[start - 1] === ":") {
              event.preventDefault();
              const nextChar = el.value[start] || "";
              const removeCount = nextChar === "1" ? 1 : (nextChar ? 2 : 1);
              const newValue = `${el.value.slice(0, start - 1)}${el.value.slice(start - 1 + removeCount)}`;
              el.value = normalizeTypedTimeInput(newValue);
              const newCaret = Math.max(0, start - 1);
              window.requestAnimationFrame(() => {
                try {
                  el.setSelectionRange(newCaret, newCaret);
                } catch (e) {}
                syncInputTimeValue(el, true);
                openDropdown(el, el.value);
              });
              return;
            }
          }

          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (dropdown?.style.display !== "block") {
              openDropdown(el, el.value);
            }
            if (!currentVisibleTimes.length) {
              return;
            }
            const delta = event.key === "ArrowDown" ? 1 : -1;
            const next = highlightedIndex + delta;
            if (next < 0) {
              highlightedIndex = currentVisibleTimes.length - 1;
            } else if (next >= currentVisibleTimes.length) {
              highlightedIndex = 0;
            } else {
              highlightedIndex = next;
            }
            renderDropdown(el, el.value, true);
            return;
          }

          if (event.key === "Enter") {
            if (dropdown?.style.display === "block" && highlightedIndex >= 0 && highlightedIndex < currentVisibleTimes.length) {
              event.preventDefault();
              setInputToEntry(el, currentVisibleTimes[highlightedIndex]);
              closeDropdown();
              hideGhost(el);
              return;
            }
            coerceTypedTime(el);
            closeDropdown();
            hideGhost(el);
            return;
          }

          if (event.key === "Escape") {
            closeDropdown();
            return;
          }

          if (event.key === "Tab") {
            if (!String(el.dataset.timeValue || "") && highlightedIndex >= 0 && highlightedIndex < currentVisibleTimes.length) {
              setInputToEntry(el, currentVisibleTimes[highlightedIndex]);
            }
            coerceTypedTime(el);
            closeDropdown();
            hideGhost(el);
          }
        });

        el.addEventListener("input", () => {
          syncInputTimeValue(el, true);
          openDropdown(el, el.value);
        });

        const openFromGesture = (event) => {
          openDropdown(el, el.value);
        };

        el.addEventListener("mousedown", openFromGesture, true);
        el.addEventListener("click", openFromGesture, true);
        el.addEventListener("focus", () => {
          syncGhostTypography(el);
          openDropdown(el, el.value);
        });
        el.addEventListener("blur", () => {
          const lastSuggested = el.id ? lastSuggestedByInputId.get(el.id) : null;
          if (!String(el.dataset.timeValue || "") && lastSuggested) {
            const typed = String(el.value || "").trim().toLowerCase();
            const suggestedLabel = String(lastSuggested.label || "").trim().toLowerCase();
            const suggestedCanonical = String(lastSuggested.value || "").trim();
            const suggested12 = formatTimeTo12Hour(suggestedCanonical).toLowerCase();
            if (!typed || suggestedLabel.startsWith(typed) || suggested12.startsWith(typed)) {
              setInputToEntry(el, lastSuggested);
            }
          }
          coerceTypedTime(el);
          hideGhost(el);
        });
      });

      document.addEventListener(
        "mousedown",
        (event) => {
          const target = event.target;
          if (!activeInput) {
            return;
          }
          const clickedInput = target instanceof HTMLElement && target.closest("#class-meeting-start, #class-meeting-end");
          const clickedDropdown = dropdown && target instanceof Node && dropdown.contains(target);
          if (!clickedInput && !clickedDropdown) {
            closeDropdown();
          }
        },
        true,
      );

      window.addEventListener("resize", () => {
        if (activeInput) {
          positionDropdown(activeInput);
        }
      });
    }

    installDatePickerBehavior();
    installTimePickerOnlyBehavior();

    // Make post available globally for note handlers + student summary button
    window.postTeacherMessage = post;

    // --- Shared theme preference (set in Account page) ---
    const themePreference = String(window.__TBD_THEME_PREFERENCE__ || "system").toLowerCase();
    const shouldUseDark = themePreference === "dark" ||
      (themePreference === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", !!shouldUseDark);

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
          if (existing) {
            try {
              existing.remove();
            } catch (e) {}
          }
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
        if ($("dashboard-log-name")) {
          $("dashboard-log-name").textContent = "Viewing: All logs";
        }
        if (status) {
          status.textContent = "Dashboard ready";
        }
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
      if ($("logs-viewer-container")) {
        $("logs-viewer-container").style.display = "none";
      }
      if ($("logs-view")) {
        $("logs-view").innerHTML = "";
      }
      if ($("logs-log-name")) {
        $("logs-log-name").textContent = "";
      }
      if (searchInput) {
        searchInput.value = "";
      }
    });

    $("refresh-logs")?.addEventListener("click", () => {
      if (status) {
        status.textContent = "Refreshing list...";
      }
      // New/removed logs can change aggregate metrics.
      dashboardDataCache = null;
      post("listLogs");
    });
    $("refreshDeletions")?.addEventListener("click", () => {
      if (status) {
        status.textContent = "Fetching deletions...";
      }
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
      if ($("inactivityInput")) {
        $("inactivityInput").value = defaults.inactivity;
      }
      if ($("flightInput")) {
        $("flightInput").value = defaults.flight;
      }
      if ($("pasteLengthInput")) {
        $("pasteLengthInput").value = defaults.pasteLength;
      }
      if ($("flagAiEvents")) {
        $("flagAiEvents").checked = defaults.flagAiEvents;
      }
      post("saveSettings", { settings: defaults });
    });

    // --- SEARCH & DROPDOWN ---
    function renderSearchDropdown(items) {
      if (!dropdown) {
        return;
      }
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
          if (searchInput) {
            searchInput.value = name;
          }
          dropdown.classList.remove("show");
          if (status) {
            status.textContent = "Decrypting " + name + "...";
          }
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
        if (dropdown) {
          dropdown.classList.add("show");
        }
      });
      searchInput.addEventListener("focus", () => {
        renderSearchDropdown(
          filterLogs((searchInput.value || "").toLowerCase()),
        );
        if (dropdown) {
          dropdown.classList.add("show");
        }
      });
    }
    const clearSearchBtn = $("clear-search");
    if (clearSearchBtn) {
      clearSearchBtn.addEventListener("click", () => {
        if (searchInput) {
          searchInput.value = "";
          searchInput.focus();
          renderSearchDropdown(filterLogs(""));
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
        if (filenames.length === 0) {
          return (status.textContent =
            "Error: Select at least 1 log to build a timeline.");
        }
        status.textContent = "Generating Timeline...";
        post("generateTimeline", { filenames });
      },
      onGenerateProfile: () => {
        const checks = document.querySelectorAll(".log-checkbox:checked");
        const filenames = Array.from(checks).map((c) => c.value);
        if (filenames.length < 2) {
          return (status.textContent =
            "Error: Select at least 2 logs to build a profile.");
        }
        status.textContent = "Generating Profile...";
        post("generateProfile", { filenames });
      },
      onExportCsv: (filename) => {
        if (status) {
          status.textContent = "Exporting CSV...";
        }
        post("exportLog", { format: "csv", filename: filename });
      },
      onExportJson: (filename) => {
        if (status) {
          status.textContent = "Exporting JSON...";
        }
        post("exportLog", { format: "json", filename: filename });
      },
      onRowClick: (evClick, row, fname, checkCell, nameDiv) => {
        let clickedCell = evClick.target;
        while (clickedCell && clickedCell.parentNode !== row) {
          clickedCell = clickedCell.parentNode;
        }
        const cellIndex = Array.from(row.children).indexOf(clickedCell);

        if (cellIndex === 0 || cellIndex === 1) {
          const checkbox = checkCell.querySelector("input");
          if (evClick.target !== checkbox) {
            checkbox.checked = !checkbox.checked;
          }
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
          if ($("log-count")) {
            $("log-count").textContent = logNamesCache.length + " logs found";
          }
          renderSearchDropdown(
            filterLogs((searchInput?.value || "").toLowerCase()),
          );
          break;

        case "dashboardData":
          dashboardDataCache = msg.data || null;
          UI.renderDashboard(msg.data, handlers);
          if ($("dashboard-log-name")) {
            $("dashboard-log-name").textContent = "Viewing: All logs";
          }
          if (status) {
            status.textContent = "Dashboard updated";
          }
          break;

        case "profileData":
          UI.renderProfile(msg.data);
          if (status) {
            status.textContent = "Behavioral profile generated.";
          }
          break;

        case "timelineData":
          UI.renderTimeline(msg.data);
          if (status) {
            status.textContent = "Timeline generated.";
          }
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
            if (status) {
              status.textContent = "Loaded " + msg.filename;
            }
          } else {
            UI.renderParsedInLogs(
              msg.data,
              msg.filename,
              currentSettings,
              handlers,
            );
            // Load notes for this log file
            post("loadLogNotes", { filename: msg.filename });
            if (status) {
              status.textContent = "Loaded " + msg.filename;
            }
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
          if (status) {
            status.textContent = "Student summary ready.";
          }
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
          if ($("logs-viewer-container")) {
            $("logs-viewer-container").style.display = "block";
          }
          if ($("logs-view")) {
            $("logs-view").innerHTML = "<pre>" + msg.data + "</pre>";
          }
          if ($("dashboard-view") && currentTab === "dashboard") {
            $("dashboard-view").innerHTML =
              '<div class="card"><h2>Raw Data Only</h2><p class="meta">Score unavailable.</p></div>';
          }
          if (status) {
            status.textContent = "Loaded " + msg.filename;
          }
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
                msg.settings.flagAiEvents !== undefined
                  ? msg.settings.flagAiEvents
                  : defaults.flagAiEvents,
            };
            if ($("inactivityInput")) {
              $("inactivityInput").value = currentSettings.inactivity;
            }
            if ($("flightInput")) {
              $("flightInput").value = currentSettings.flight;
            }
            if ($("pasteLengthInput")) {
              $("pasteLengthInput").value = currentSettings.pasteLength;
            }
            if ($("flagAiEvents")) {
              $("flagAiEvents").checked = currentSettings.flagAiEvents;
            }
          }
          break;

        case "settingsSaved":
          if ($("inactivityInput")) {
            currentSettings.inactivity = parseInt($("inactivityInput").value);
          }
          if ($("flightInput")) {
            currentSettings.flight = parseInt($("flightInput").value);
          }
          if ($("pasteLengthInput")) {
            currentSettings.pasteLength = parseInt($("pasteLengthInput").value);
          }
          if ($("flagAiEvents")) {
            currentSettings.flagAiEvents = $("flagAiEvents").checked;
          }
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
            if (!view) {
              break;
            }
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
                    if (entry.activityType) {
                      return String(entry.activityType).toLowerCase();
                    }
                    if (
                      entry.deletedFile ||
                      entry.deletedAt ||
                      entry.lastKnownSize
                    ) {
                      return "deleted";
                    }
                    if (entry.modifiedFile || entry.modifiedAt) {
                      return "modified";
                    }
                    const lowerNote = String(
                      entry.note || entry.reason || "",
                    ).toLowerCase();
                    if (
                      lowerNote.includes("manual edit") ||
                      lowerNote.includes("modified")
                    ) {
                      return "modified";
                    }
                    if (lowerNote.includes("deleted")) {
                      return "deleted";
                    }
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
            if ($("deletions-view")) {
              $("deletions-view").textContent = "Failed to render deletions.";
            }
          }
          if (status) {
            status.textContent = "Deletions updated";
          }
          break;

        case "error":
          if ($("btn-submit-class")) {
            $("btn-submit-class").disabled = false;
            $("btn-submit-class").textContent = editingClassId
              ? "Save Class Changes"
              : "Create Class";
          }
          if ($("btn-create-assignment")) {
            $("btn-create-assignment").disabled = false;
            $("btn-create-assignment").textContent = "Create Assignment";
          }
          if (status) {
            status.textContent = "Error: " + (msg.message || "");
          }
          if ($("class-form-card")?.style.display === "block") {
            const errEl = $("class-form-error");
            if (errEl) {
              errEl.textContent = msg.message || "Unable to save class. Please try again.";
              errEl.style.display = "block";
            }
          }
          // If class loading fails, stop spinner and show empty state instead of hanging.
          if (currentTab === "class" && $("class-detail-view")?.style.display !== "block") {
            setClassRefreshLoading(false);
            const loadingEl = $("class-list-loading");
            const emptyEl = $("class-list-empty");
            const listView = $("class-list-view");
            if (loadingEl) {
              loadingEl.style.display = "none";
            }
            if (listView) {
              listView.innerHTML = "";
            }
            if (emptyEl) {
              emptyEl.style.display = "block";
            }
          }
          const compareMessage = $("assignment-compare-message");
          const isCompareLoading =
            !!compareMessage &&
            compareMessage.style.display !== "none" &&
            /loading/i.test(compareMessage.textContent || "");
          if (
            isCompareLoading ||
            (msg.message && msg.message.toLowerCase().includes("compare"))
          ) {
            showAssignmentCompareMessage(
              `Comparison failed: ${msg.message || "Unknown error."}`,
              "error",
            );
          }
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
          {
            const classes = Array.isArray(msg.data)
              ? msg.data
              : Array.isArray(msg.data?.classes)
                ? msg.data.classes
                : [];
            if (classes.length > 0) {
              currentTeacherClasses = classes.slice();
              renderClasses(currentTeacherClasses);
            } else {
              renderClasses(currentTeacherClasses);
            }
            if (status) {
              status.textContent = (classes.length || currentTeacherClasses.length) + " class(es) loaded";
            }
          }
          break;

        case "classCreated": {
          const btn = $("btn-submit-class");
          if (btn) {
            btn.disabled = false;
            btn.textContent = "Create Class";
          }
          if ($("class-form-card")) {
            $("class-form-card").style.display = "none";
          }
          [
            "class-course-name",
            "class-course-code",
            "class-teacher-name",
            "class-meeting-time",
            "class-start-date",
            "class-end-date",
          ].forEach((id) => {
            const el = $(id);
            if (el) {
              el.value = "";
            }
          });
          clearMeetingScheduleInputs();
          if (msg.data && typeof msg.data === "object") {
            const newClass = msg.data;
            currentTeacherClasses = [
              newClass,
              ...currentTeacherClasses.filter((cls) => Number(cls.id || 0) !== Number(newClass.id || 0)),
            ];
            renderClasses(currentTeacherClasses);
          }
          if (status) {
            status.textContent =
              "Class created! Join code: " + (msg.data?.joinCode || "");
            setTimeout(() => (status.textContent = "Ready"), 5000);
          }
          editingClassId = null;
          loadClasses();
          break;
        }

        case "classUpdated": {
          const btn = $("btn-submit-class");
          if (btn) {
            btn.disabled = false;
            btn.textContent = "Create Class";
          }
          if ($("class-form-card")) {
            $("class-form-card").style.display = "none";
          }
          [
            "class-course-name",
            "class-course-code",
            "class-teacher-name",
            "class-meeting-time",
            "class-start-date",
            "class-end-date",
          ].forEach((id) => {
            const el = $(id);
            if (el) {
              el.value = "";
            }
          });
          clearMeetingScheduleInputs();
          editingClassId = null;
          if (status) {
            status.textContent = "Class updated successfully.";
            setTimeout(() => (status.textContent = "Ready"), 3000);
          }
          loadClasses();
          break;
        }

        case "classDetails": {
          switchTab("class");
          renderClassDetails(msg.data || {});
          if (status) {
            status.textContent = "Class details loaded.";
          }
          break;
        }

        case "classEditData": {
          fillClassEditForm(msg.data || {});
          if (status) {
            status.textContent = "Editing class loaded from database.";
          }
          break;
        }

        case "classAssignmentCreated": {
          const btn = $("btn-create-assignment");
          if (btn) {
            btn.disabled = false;
            btn.textContent = "Create Assignment";
          }
          const errEl = $("assignment-form-error");
          if (errEl) {
            errEl.style.display = "none";
          }
          if ($("assignment-name")) {
            $("assignment-name").value = "";
          }
          if ($("assignment-description")) {
            $("assignment-description").value = "";
          }
          if ($("assignment-due-date")) {
            $("assignment-due-date").value = "";
          }
          if (currentClassId) {
            post("openClass", { classId: currentClassId });
          }
          if (status) {
            status.textContent = "Assignment created.";
            setTimeout(() => (status.textContent = "Ready"), 3000);
          }
          break;
        }

        case "assignmentWorkData": {
          renderAssignmentWork(msg.data || {});
          if (status) {
            status.textContent = "Assignment work loaded.";
          }
          break;
        }

        case "assignmentStudentSessions": {
          renderAssignmentStudentSessions(msg.data || {});
          if (status) {
            status.textContent = "Student sessions loaded.";
          }
          break;
        }

        case "assignmentComparisonData": {
          renderAssignmentComparison(msg.data || {});
          showAssignmentCompareMessage(
            msg.data &&
              msg.data.missingStudents &&
              msg.data.missingStudents.length
              ? "Comparison loaded with warnings. Review the notice cards before drawing conclusions."
              : "Comparison loaded.",
          );
          if (status) {
            status.textContent = "Student comparison loaded.";
          }
          break;
        }

        case "classSessionLogData": {
          renderAssignmentSessionLog(msg.data || {});
          if (status) {
            status.textContent = "Session log loaded.";
          }
          break;
        }
      }
    });

    // --- CLASS TAB LOGIC ---
    function loadClasses() {
      const listView = $("class-list-view");
      const emptyEl = $("class-list-empty");
      const loadingEl = $("class-list-loading");
      if (loadingEl) {
        loadingEl.style.display = "block";
      }
      if (emptyEl) {
        emptyEl.style.display = "none";
      }
      if (listView) {
        listView.innerHTML = "";
      }
      post("listClasses");
    }

    function setAssignmentFormVisible(show) {
      const formCard = $("assignment-form-card");
      if (!formCard) {
        return;
      }
      formCard.style.display = show ? "block" : "none";
      if (!show) {
        const errEl = $("assignment-form-error");
        if (errEl) {
          errEl.style.display = "none";
        }
      }
    }

    function defaultComparisonFilters() {
      return {
        input: true,
        edit: true,
        paste: true,
        ai: true,
        focus: true,
        run: true,
        other: true,
      };
    }

    function showAssignmentCompareMessage(message, tone = "neutral") {
      const el = $("assignment-compare-message");
      if (!el) {
        return;
      }
      if (!message) {
        el.style.display = "none";
        el.textContent = "";
        el.style.borderColor = "var(--border)";
        return;
      }

      el.style.display = "block";
      el.textContent = message;
      if (tone === "warning") {
        el.style.borderColor = "#f59e0b";
      } else if (tone === "error") {
        el.style.borderColor = "#ef4444";
      } else {
        el.style.borderColor = "var(--border)";
      }
    }

    function clearAssignmentComparisonSelection(options = {}) {
      const preserveMessage = options.preserveMessage === true;
      selectedComparisonStudentIds = [];
      currentAssignmentComparison = null;
      currentComparisonFilters = defaultComparisonFilters();

      document
        .querySelectorAll(".assignment-compare-filter")
        .forEach((input) => {
          input.checked = true;
        });

      if (!preserveMessage) {
        showAssignmentCompareMessage("");
      }
      if ($("assignment-compare-view")) {
        $("assignment-compare-view").style.display = "none";
      }
      if ($("assignment-compare-panels")) {
        $("assignment-compare-panels").innerHTML = "";
      }
      if ($("assignment-compare-warnings")) {
        $("assignment-compare-warnings").innerHTML = "";
      }
      if ($("assignment-compare-summary")) {
        $("assignment-compare-summary").textContent = "";
      }
    }

    function selectedComparisonStudents() {
      return currentAssignmentStudents.filter((student) =>
        selectedComparisonStudentIds.includes(Number(student.authUserId)),
      );
    }

    function updateAssignmentComparisonControls() {
      const statusEl = $("assignment-compare-selection-status");
      const compareBtn = $("btn-compare-assignment-students");
      const clearBtn = $("btn-clear-assignment-compare");
      const selectedStudents = selectedComparisonStudents();
      const selectedCount = selectedStudents.length;

      if (statusEl) {
        if (selectedCount === 0) {
          statusEl.textContent =
            "Select up to 2 students to compare their sessions side by side.";
        } else {
          statusEl.textContent = `Selected ${selectedCount}/2: ${selectedStudents.map((student) => student.studentName || "Student").join(" and ")}`;
        }
      }
      if (compareBtn) {
        compareBtn.disabled = selectedCount !== 2;
      }
      if (clearBtn) {
        clearBtn.disabled = selectedCount === 0;
      }

      document
        .querySelectorAll("[data-assignment-student-id]")
        .forEach((node) => {
          const studentId = Number(
            node.getAttribute("data-assignment-student-id"),
          );
          const selected = selectedComparisonStudentIds.includes(studentId);
          node.style.outline = selected ? "2px solid var(--accent)" : "none";
          node.style.boxShadow = selected
            ? "0 0 0 1px rgba(37,99,235,0.2)"
            : "none";

          const checkbox = node.querySelector(".assignment-compare-checkbox");
          if (checkbox) {
            checkbox.checked = selected;
            checkbox.disabled = !selected && selectedCount >= 2;
          }
        });
    }

    function toggleAssignmentStudentSelection(studentId, shouldSelect) {
      const normalized = Number(studentId);
      if (!Number.isFinite(normalized) || normalized <= 0) {
        return false;
      }

      if (shouldSelect) {
        if (!selectedComparisonStudentIds.includes(normalized)) {
          if (selectedComparisonStudentIds.length >= 2) {
            showAssignmentCompareMessage(
              "You can compare up to 2 students at a time.",
              "warning",
            );
            updateAssignmentComparisonControls();
            return false;
          }
          selectedComparisonStudentIds =
            selectedComparisonStudentIds.concat(normalized);
        }
      } else {
        selectedComparisonStudentIds = selectedComparisonStudentIds.filter(
          (id) => id !== normalized,
        );
      }

      if (currentAssignmentComparison) {
        currentAssignmentComparison = null;
        if ($("assignment-compare-view")) {
          $("assignment-compare-view").style.display = "none";
        }
      }

      if (selectedComparisonStudentIds.length === 2) {
        showAssignmentCompareMessage("Ready to compare the selected students.");
      } else if (selectedComparisonStudentIds.length === 0) {
        showAssignmentCompareMessage("");
      }

      updateAssignmentComparisonControls();
      return true;
    }

    function formatComparisonOffset(offsetMs) {
      const totalSeconds = Math.max(0, Math.round((offsetMs || 0) / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `+${minutes}m ${seconds.toString().padStart(2, "0")}s`;
    }

    function renderAssignmentComparison(payload) {
      const view = $("assignment-compare-view");
      const summary = $("assignment-compare-summary");
      const warnings = $("assignment-compare-warnings");
      const panels = $("assignment-compare-panels");
      if (!view || !summary || !warnings || !panels) {
        return;
      }

      currentAssignmentComparison = payload;
      warnings.innerHTML = "";
      panels.innerHTML = "";
      view.style.display = "block";

      const similarity = payload.similarity;
      const summaryParts = [];
      if (similarity) {
        summaryParts.push(`Similarity ${similarity.overall}%`);
        summaryParts.push(`Event mix ${similarity.distribution}%`);
        summaryParts.push(`Sequence ${similarity.sequence}%`);
        summaryParts.push(`Pacing ${similarity.cadence}%`);
      }
      if (payload.summary) {
        summaryParts.push(payload.summary);
      }
      summary.textContent = summaryParts.join(" • ");

      (payload.warnings || []).forEach((warningText) => {
        const warning = document.createElement("div");
        warning.className = "meta";
        warning.style.cssText =
          "padding:10px; border:1px solid #f59e0b; border-radius:8px; background:rgba(245,158,11,0.08);";
        warning.textContent = warningText;
        warnings.appendChild(warning);
      });

      const maxOffsetMs = Math.max(1, Number(payload.maxOffsetMs || 0));
      (payload.students || []).forEach((student) => {
        const panel = document.createElement("div");
        panel.className = "card";
        panel.style.marginBottom = "0";
        panel.style.padding = "12px";

        const title = document.createElement("div");
        title.style.display = "flex";
        title.style.justifyContent = "space-between";
        title.style.gap = "8px";
        title.style.alignItems = "flex-start";
        title.innerHTML = `
          <div>
            <div style="font-weight:700;">${student.studentName || "Student"}</div>
            <div class="meta" style="font-size:0.8rem; margin-top:4px;">${student.sessionCount || 0} session(s) • ${student.totalEvents || 0} event(s)</div>
          </div>
          <div class="meta" style="font-size:0.8rem; text-align:right;">${student.extensionVersions && student.extensionVersions.length ? student.extensionVersions.join(", ") : "Unknown extension version"}</div>
        `;
        panel.appendChild(title);

        if (!student.synced) {
          const missing = document.createElement("div");
          missing.className = "meta";
          missing.style.cssText =
            "margin-top:12px; padding:12px; border:1px solid var(--border); border-radius:8px;";
          missing.textContent =
            "No synced session data is available for this student yet. Request a sync and try again.";
          panel.appendChild(missing);
          panels.appendChild(panel);
          return;
        }

        const stats = document.createElement("div");
        stats.style.cssText =
          "display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-top:12px;";
        stats.innerHTML = `
          <div><div style="font-weight:700;">${student.totalPasteEvents || 0}</div><div class="meta">Paste Events</div></div>
          <div><div style="font-weight:700;">${student.suspiciousPasteCount || 0}</div><div class="meta">Flagged Pastes</div></div>
          <div><div style="font-weight:700;">${Math.round((student.activeSpanMs || 0) / 60000)} min</div><div class="meta">Active Span</div></div>
          <div><div style="font-weight:700;">${Math.round((student.averageGapMs || 0) / 1000)}s</div><div class="meta">Average Gap</div></div>
        `;
        panel.appendChild(stats);

        const strip = document.createElement("div");
        strip.style.cssText =
          "position:relative; height:42px; margin-top:12px; border:1px solid var(--border); border-radius:8px; background:linear-gradient(90deg, rgba(37,99,235,0.04), rgba(37,99,235,0)); overflow:hidden;";
        const filteredEvents = (student.timelineEvents || []).filter(
          (event) => currentComparisonFilters[event.category] !== false,
        );
        filteredEvents.forEach((event) => {
          const marker = document.createElement("span");
          const left = Math.min(
            100,
            Math.max(0, ((event.offsetMs || 0) / maxOffsetMs) * 100),
          );
          const colors = {
            input: "#2563eb",
            edit: "#0891b2",
            paste: event.suspiciousPaste ? "#dc2626" : "#f59e0b",
            ai: "#7c3aed",
            focus: "#10b981",
            run: "#1d4ed8",
            other: "#6b7280",
          };
          marker.style.cssText = `position:absolute; left:${left}%; top:10px; width:8px; height:8px; border-radius:999px; background:${colors[event.category]}; transform:translateX(-50%);`;
          marker.title = `${event.eventType} ${formatComparisonOffset(event.offsetMs)} ${event.sessionLabel}`;
          strip.appendChild(marker);
        });
        panel.appendChild(strip);

        const rows = document.createElement("div");
        rows.style.cssText =
          "display:grid; gap:8px; margin-top:12px; max-height:360px; overflow:auto;";
        filteredEvents.slice(0, 60).forEach((event) => {
          const row = document.createElement("div");
          row.style.cssText =
            "border:1px solid var(--border); border-radius:8px; padding:8px; background:var(--surface);";
          row.innerHTML = `
            <div style="display:flex; justify-content:space-between; gap:8px; align-items:center;">
              <strong>${event.eventType}</strong>
              <span class="meta">${formatComparisonOffset(event.offsetMs)}</span>
            </div>
            <div class="meta" style="margin-top:4px; font-size:0.78rem;">${event.sessionLabel}${event.fileName ? ` • ${event.fileName}` : ""}</div>
            <div class="meta" style="margin-top:4px; font-size:0.78rem;">${event.category === "paste" ? `Paste length: ${event.pasteLength || 0}` : ""}${event.possibleAiDetection ? ` • ${event.possibleAiDetection}` : ""}</div>
          `;
          rows.appendChild(row);
        });

        if (filteredEvents.length > 60) {
          const more = document.createElement("div");
          more.className = "meta";
          more.textContent = `Showing first 60 matching events of ${filteredEvents.length}.`;
          rows.appendChild(more);
        }

        if (!filteredEvents.length) {
          const noMatches = document.createElement("div");
          noMatches.className = "meta";
          noMatches.textContent =
            "No events match the active filters for this student.";
          rows.appendChild(noMatches);
        }

        panel.appendChild(rows);
        panels.appendChild(panel);
      });
    }

    function restoreAssignmentListVisibility() {
      const list = $("class-assignments-list");
      const empty = $("class-assignments-empty");
      if (list) {
        list.style.display = "block";
      }
      if (empty) {
        empty.style.display =
          currentClassAssignments.length === 0 ? "block" : "none";
      }
    }

    function setClassRefreshLoading(isLoading) {
      const btn = $("btn-refresh-students");
      if (!btn) {
        return;
      }

      if (!isLoading) {
        if (classRefreshAnimationTimer) {
          clearInterval(classRefreshAnimationTimer);
          classRefreshAnimationTimer = null;
        }
        btn.disabled = false;
        btn.textContent = "↻ Refresh";
        return;
      }

      if (classRefreshAnimationTimer) {
        return;
      }

      const frames = ["↻ Refresh.", "↻ Refresh..", "↻ Refresh..."];
      let frameIndex = 0;
      btn.disabled = true;
      btn.textContent = frames[frameIndex];
      classRefreshAnimationTimer = window.setInterval(() => {
        frameIndex = (frameIndex + 1) % frames.length;
        btn.textContent = frames[frameIndex];
      }, 250);
    }

    function updateTopClassActionButton() {
      const btn = $("btn-new-class");
      if (!btn) {
        return;
      }

      const inClassDetail = $("class-detail-view")?.style.display === "block";
      if (inClassDetail) {
        btn.textContent = "Back to Classes";
        return;
      }

      btn.textContent = "+ New Class";
    }

    function updateClassPrimaryActionButton() {
      const btn = $("btn-new-assignment");
      if (!btn) {
        return;
      }

      const inClassDetail = $("class-detail-view")?.style.display === "block";
      btn.style.display = inClassDetail && currentClassDetailTab === "assignments" ? "inline-flex" : "none";
    }

    function isInClassFlowView() {
      return (
        $("class-detail-view")?.style.display === "block" ||
        $("assignment-work-view")?.style.display === "block" ||
        $("assignment-student-view")?.style.display === "block" ||
        $("assignment-session-log-view")?.style.display === "block"
      );
    }

    function updateClassTabHeading() {
      const heading = document.querySelector("#class-tab .header-row h1");
      if (!heading) {
        return;
      }

      const inClassDetail = $("class-detail-view")?.style.display === "block";
      if (inClassDetail && currentClassDisplayName) {
        heading.textContent = `🏫 ${currentClassDisplayName}`;
        return;
      }

      heading.textContent = "🏫 My Classes";
    }

    function fillClassEditForm(classInfo) {
      if (!classInfo) {
        return;
      }

      if ($("class-form-card")) {
        $("class-form-card").style.display = "block";
      }
      if ($("class-course-name")) {
        $("class-course-name").value = classInfo.courseName || "";
      }
      if ($("class-course-code")) {
        $("class-course-code").value = classInfo.courseCode || "";
      }
      if ($("class-teacher-name")) {
        $("class-teacher-name").value = classInfo.teacherName || "";
      }
      if ($("class-meeting-time")) {
        $("class-meeting-time").value = classInfo.meetingTime || "";
      }
      applyMeetingScheduleText(classInfo.meetingTime || "");
      if ($("class-start-date")) {
        $("class-start-date").value = normalizeDateForInput(classInfo.startDate);
      }
      if ($("class-end-date")) {
        $("class-end-date").value = normalizeDateForInput(classInfo.endDate);
      }

      const submitBtn = $("btn-submit-class");
      if (submitBtn) {
        submitBtn.textContent = "Save Class Changes";
      }
    }

    function renderClasses(classes) {
      const listView = $("class-list-view");
      const emptyEl = $("class-list-empty");
      const loadingEl = $("class-list-loading");
      const detailView = $("class-detail-view");
      const nextClasses = Array.isArray(classes) ? classes : [];
      const classesToRender = nextClasses.length > 0 ? nextClasses : currentTeacherClasses;

      if (loadingEl) {
        loadingEl.style.display = "none";
      }
      if (detailView) {
        detailView.style.display = "none";
      }
      currentClassDetailTab = "students";
      currentClassDisplayName = "";

      setAssignmentFormVisible(false);
      updateTopClassActionButton();
      updateClassTabHeading();
      if (!listView) {
        return;
      }
      listView.style.display = "grid";
      listView.innerHTML = "";
      if (classesToRender.length === 0) {
        if (emptyEl) {
          emptyEl.style.display = "block";
        }
        return;
      }
      if (emptyEl) {
        emptyEl.style.display = "none";
      }

      if (nextClasses.length > 0) {
        currentTeacherClasses = nextClasses.slice();
      }

      classesToRender.forEach((cls) => {
        const card = document.createElement("div");
        card.className = "card";
        card.style.cssText = "display:flex; flex-direction:column;";
        card.style.marginBottom = "10px";
        card.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div>
              <div style="font-weight:700; font-size:1rem;">${cls.courseName}</div>
              <div class="meta">${cls.courseCode} &bull; ${cls.teacherName}</div>
            </div>
            <div style="background:var(--accent); color:white; padding:4px 12px; border-radius:6px; font-size:0.8rem; font-weight:700; white-space:nowrap; letter-spacing:0.05em;">${cls.joinCode}</div>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:0.88rem;">
            <div><span style="color:var(--muted);">Meeting:</span> ${formatMeetingTimeDisplay(cls.meetingTime)}</div>
            <div><span style="color:var(--muted);">Start:</span> ${formatClassDateDisplay(cls.startDate)}</div>
            <div></div>
            <div><span style="color:var(--muted);">End:</span> ${formatClassDateDisplay(cls.endDate)}</div>
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
          currentClassDetailTab = "assignments";
          switchTab("class");
          post("openClass", { classId: cls.id });
        });
        editBtn?.addEventListener("click", () => {
          editingClassId = cls.id;
          fillClassEditForm(cls);
          post("getClassForEdit", { classId: cls.id });
          if (status) {
            status.textContent = "Editing class: " + cls.courseName;
          }
        });
        listView.appendChild(card);
      });

      if (classesToRender.length === 0 && emptyEl) {
        emptyEl.style.display = "block";
      }
    }

    function renderClassDetails(payload) {
      const classInfo = payload.classInfo || null;
      const students = payload.students || [];
      const assignments = payload.assignments || [];
      if (!classInfo) {
        return;
      }

      currentClassId = classInfo.id;
      currentClassDisplayName = classInfo.courseName || "Class Detail";
      currentClassAssignments = assignments;
      currentAssignmentStudents = [];
      setClassRefreshLoading(false);

      if ($("class-list-view")) {
        $("class-list-view").style.display = "none";
      }
      if ($("class-list-empty")) {
        $("class-list-empty").style.display = "none";
      }
      if ($("class-detail-view")) {
        $("class-detail-view").style.display = "block";
      }
      if ($("class-detail-meta")) {
        $("class-detail-meta").textContent =
          (classInfo.courseCode || "") +
          " • " +
          (classInfo.teacherName || "") +
          " • Join Code: " +
          (classInfo.joinCode || "");
      }

      if ($("assignment-work-view")) {
        $("assignment-work-view").style.display = "none";
      }
      if ($("assignment-student-view")) {
        $("assignment-student-view").style.display = "none";
      }
      if ($("assignment-session-log-view")) {
        $("assignment-session-log-view").style.display = "none";
      }
      currentAssignmentId = null;
      currentAssignmentName = "";
      clearAssignmentComparisonSelection();
      setAssignmentFormVisible(false);

      updateClassTabHeading();
      switchClassDetailTab(currentClassDetailTab || "assignments");
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
        if (studentsView) {
          studentsView.style.display = "block";
        }
        if (assignmentsView) {
          assignmentsView.style.display = "none";
        }
        if (studentsTab) {
          studentsTab.style.background = "var(--accent)";
          studentsTab.style.color = "white";
        }
        if (assignmentsTab) {
          assignmentsTab.style.background = "var(--bg)";
          assignmentsTab.style.color = "var(--muted)";
        }
        setAssignmentFormVisible(false);
        updateTopClassActionButton();
        updateClassTabHeading();
        updateClassPrimaryActionButton();
        return;
      }

      if (studentsView) {
        studentsView.style.display = "none";
      }
      if (assignmentsView) {
        assignmentsView.style.display = "block";
      }
      if (assignmentsTab) {
        assignmentsTab.style.background = "var(--accent)";
        assignmentsTab.style.color = "white";
      }
      if (studentsTab) {
        studentsTab.style.background = "var(--bg)";
        studentsTab.style.color = "var(--muted)";
      }
      setAssignmentFormVisible(false);
      updateTopClassActionButton();
      updateClassTabHeading();
      updateClassPrimaryActionButton();
    }

    function renderClassStudents(students) {
      const table = $("class-students-table");
      const body = $("class-students-body");
      const empty = $("class-students-empty");
      if (!table || !body || !empty) {
        return;
      }

      body.innerHTML = "";
      const deduped = [];
      const seen = new Set();
      (students || []).forEach((s) => {
        const key =
          String(s.authUserId || "") ||
          `${s.studentEmail || ""}|${s.studentName || ""}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(s);
        }
      });

      if (deduped.length === 0) {
        table.style.display = "none";
        empty.textContent = "This class has no students yet.";
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
      if (!list || !empty) {
        return;
      }

      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "10px";
      list.innerHTML = "";
      if (!assignments || assignments.length === 0) {
        empty.textContent = "This class has no assignments yet.";
        empty.style.display = "block";
        return;
      }

      empty.style.display = "none";

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const normalized = (assignments || [])
        .map((assignment) => {
          const dueDate = parseCalendarDate(assignment.dueDate);
          const isPastDue = !!dueDate && dueDate.getTime() < today.getTime();
          return { ...assignment, dueDate, isPastDue };
        })
        .sort((left, right) => {
          const leftTime = left.dueDate ? left.dueDate.getTime() : Number.POSITIVE_INFINITY;
          const rightTime = right.dueDate ? right.dueDate.getTime() : Number.POSITIVE_INFINITY;
          if (left.isPastDue !== right.isPastDue) {
            return left.isPastDue ? 1 : -1;
          }
          return leftTime - rightTime;
        });

      const activeAssignments = normalized.filter((assignment) => !assignment.isPastDue);
      const pastAssignments = normalized.filter((assignment) => assignment.isPastDue);

      const buildAssignmentCard = (assignment, isPastDue) => {
        const card = document.createElement("div");
        card.className = "card";
        card.style.marginBottom = "0";
        card.style.padding = "12px";
        card.innerHTML = `
          <div style="font-weight:700;">${assignment.name}</div>
          <div class="meta" style="margin-top:4px;">${assignment.description || "No description"}</div>
          <div class="meta" style="margin-top:6px;">
            ${isPastDue
              ? `<span style="display:inline-flex; align-items:center; padding:4px 10px; border-radius:999px; background:rgba(239, 68, 68, 0.16); color:#f87171; border:1px solid rgba(239, 68, 68, 0.45); font-weight:700;">Past Due: ${formatClassDateDisplay(assignment.dueDate)}</span>`
              : `Due: ${assignment.dueDate ? formatClassDateDisplay(assignment.dueDate) : "No due date"}`}
          </div>
          <div style="margin-top:10px;">
            <button class="btn btn-primary assignment-work-btn" style="padding:6px 10px;">View Student Work</button>
          </div>
        `;
        const btn = card.querySelector(".assignment-work-btn");
        btn?.addEventListener("click", () => {
          if (!currentClassId) {
            return;
          }
          currentAssignmentId = assignment.id;
          currentAssignmentName = assignment.name || "Assignment";
          post("openAssignmentWork", {
            classId: currentClassId,
            assignmentId: assignment.id,
          });
        });
        return card;
      };

      activeAssignments.forEach((assignment) => {
        list.appendChild(buildAssignmentCard(assignment, false));
      });

      if (pastAssignments.length > 0) {
        const pastHeader = document.createElement("div");
        pastHeader.style.cssText = "margin: 8px 0 10px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.8rem;";
        pastHeader.textContent = "Past Assignments";
        list.appendChild(pastHeader);

        pastAssignments.forEach((assignment) => {
          list.appendChild(buildAssignmentCard(assignment, true));
        });
      }
    }

    function renderAssignmentWork(payload) {
      const assignment = payload.assignment || {};
      const students = Array.isArray(payload.students) ? payload.students : [];

      const view = $("assignment-work-view");

      // If there are duplicate IDs from a dirty merge, force it to use the LAST one (the visible one)
      const allLists = document.querySelectorAll("#assignment-work-list");
      const list = allLists.length > 0 ? allLists[allLists.length - 1] : null;

      const empty = $("assignment-work-empty");
      const title = $("assignment-work-title");
      const meta = $("assignment-work-meta");
      const studentView = $("assignment-student-view");
      const logView = $("assignment-session-log-view");
      const classDetailView = $("class-detail-view");

      if (!view || !list || !empty || !title || !meta) {
        return;
      }

      currentAssignmentId = assignment.id || currentAssignmentId;
      currentAssignmentName = assignment.name || currentAssignmentName;
      currentAssignmentStudents = students;
      clearAssignmentComparisonSelection();

      // Hide previous views
    // Hide previous views
      if (classDetailView) { classDetailView.style.display = "none"; }
      if ($("class-assignments-list")) {
        $("class-assignments-list").style.display = "none";
      }
      if ($("class-assignments-empty")) {
        $("class-assignments-empty").style.display = "none";
      }
      if (studentView) { studentView.style.display = "none"; }
      if (logView) { logView.style.display = "none"; }

      view.style.display = "block";
      list.innerHTML = "";

      title.textContent = `Assignment Details: ${currentAssignmentName || "Assignment"}`;
      meta.textContent = `Students who started: ${students.length || 0}`;

      // Reset search and sort when opening a new assignment
      if ($("assignment-student-search")) {
        $("assignment-student-search").value = "";
      }
      if ($("assignment-student-sort")) {
        $("assignment-student-sort").value = "nameAsc";
      }

      renderAssignmentStudentCards();
    } // <--- THIS CLOSING BRACE IS SUPER IMPORTANT!

    // Handles filtering, sorting, and drawing the actual cards
    function renderAssignmentStudentCards() {
      // BULLETPROOF FIX 1: If there are duplicate IDs from a dirty merge, force it to use the LAST one
      const allLists = document.querySelectorAll("#assignment-work-list");
      const list = allLists.length > 0 ? allLists[allLists.length - 1] : null;
      const empty = $("assignment-work-empty");

      if (!list || !empty) {
        return;
      }
      list.innerHTML = "";

      if (
        !currentAssignmentStudents ||
        currentAssignmentStudents.length === 0
      ) {
        empty.style.display = "block";
        empty.textContent = "No students have started this assignment yet.";
        updateAssignmentComparisonControls();
        return;
      }

      // 1. Apply Search
      const searchTerm = (
        $("assignment-student-search")?.value || ""
      ).toLowerCase();
      let filtered = currentAssignmentStudents.filter((s) => {
        const name = (s.studentName || "").toLowerCase();
        const email = (s.studentEmail || "").toLowerCase();
        return name.includes(searchTerm) || email.includes(searchTerm);
      });

      // 2. Apply Sorting
      const sortVal = $("assignment-student-sort")?.value || "nameAsc";
      filtered.sort((a, b) => {
        if (sortVal === "nameAsc") {
          return (a.studentName || "").localeCompare(b.studentName || "");
        }
        if (sortVal === "nameDesc") {
          return (b.studentName || "").localeCompare(a.studentName || "");
        }
        if (sortVal === "sessionsDesc") {
          return (b.sessionCount || 0) - (a.sessionCount || 0);
        }
        if (sortVal === "eventsDesc") {
          return (b.totalEvents || 0) - (a.totalEvents || 0);
        }
        if (sortVal === "timeDesc" || sortVal === "timeAsc") {
          const timeA = a.lastActive ? new Date(a.lastActive).getTime() : 0;
          const timeB = b.lastActive ? new Date(b.lastActive).getTime() : 0;
          const validA = !isNaN(timeA) ? timeA : 0;
          const validB = !isNaN(timeB) ? timeB : 0;
          return sortVal === "timeDesc" ? validB - validA : validA - validB;
        }
        return 0;
      });

      // 3. Handle Empty Filter Results
      if (!filtered.length) {
        empty.style.display = "block";
        empty.textContent = "No students match the search filter.";
        updateAssignmentComparisonControls();
        return;
      }
      empty.style.display = "none";

      // 4. Draw Cards (Notice we use `filtered.forEach` now, not `students.forEach`)
      filtered.forEach((s) => {
        try {
          if (!s) {
            return;
          }

          const card = document.createElement("div");
          card.className = "card";
          card.setAttribute(
            "data-assignment-student-id",
            String(s.authUserId || 0),
          );
          card.style.cssText =
            "padding:16px; border:1px solid var(--border); background:var(--surface); display:flex; flex-direction:column; gap:14px;";

          // Calculate AI / External Paste Probability
          const aiProb =
            s.totalEvents > 0
              ? Math.round((s.aiEventCount / s.totalEvents) * 100)
              : 0;
          let aiColor = "var(--fg)";
          let aiBadgeBg = "var(--bg)";
          if (aiProb > 15) {
            aiColor = "#f59e0b";
            aiBadgeBg = "rgba(245, 158, 11, 0.1)";
          }
          if (aiProb >= 40) {
            aiColor = "#ef4444";
            aiBadgeBg = "rgba(239, 68, 68, 0.1)";
          }

          // Safe date parsing to prevent Chromium RangeError crashes
          let lastActiveStr = "Never Started";
          if (s.lastActive) {
            const parsedDate = new Date(s.lastActive);
            if (!isNaN(parsedDate.getTime())) {
              lastActiveStr = parsedDate.toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });
            }
          }

          const pathStr = s.workspaceRootPath || "No workspace linked";

          card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:flex-start; width:100%;">
              <div>
                <div style="font-weight:800; font-size:1.15rem; color:var(--accent);">${s.studentName || "Unknown Student"}</div>
                <div class="meta" style="font-size:0.85rem; margin-top:2px;">${s.studentEmail || ""} &bull; ${s.role || "Student"}</div>
              </div>
              <div style="text-align:right; display:flex; flex-direction:column; align-items:flex-end; gap:8px;">
                <div style="font-size:0.85rem; font-weight:700; padding:6px 10px; background:${aiBadgeBg}; color:${aiColor}; border-radius:6px; border:1px solid ${aiColor};">
                  AI Likelihood: ${aiProb}%
                </div>
                <label class="meta" style="font-size:0.8rem; display:flex; align-items:center; gap:6px; cursor:pointer;">
                  <input type="checkbox" class="assignment-compare-checkbox" /> Compare
                </label>
              </div>
            </div>

            <div class="meta" style="font-size:0.85rem; font-family:monospace; background:var(--bg); padding:8px 12px; border-radius:4px; border:1px solid var(--border); word-break:break-all;">
              📁 ${pathStr}
            </div>

            <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; font-size:0.9rem; background:var(--bg); padding:12px; border-radius:6px; border:1px solid var(--border);">
              <div style="display:flex; flex-direction:column; align-items:center; border-right:1px solid var(--border);">
                <span class="meta" style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.5px;">Sessions</span>
                <strong style="font-size:1.2rem; color:var(--fg);">${s.sessionCount || 0}</strong>
              </div>
              <div style="display:flex; flex-direction:column; align-items:center; border-right:1px solid var(--border);">
                <span class="meta" style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.5px;">Total Events</span>
                <strong style="font-size:1.2rem; color:var(--fg);">${s.totalEvents || 0}</strong>
              </div>
              <div style="display:flex; flex-direction:column; align-items:center;">
                <span class="meta" style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.5px;">Last Active</span>
                <strong style="font-size:0.9rem; margin-top:4px; color:var(--fg); text-align:center;">${lastActiveStr}</strong>
              </div>
            </div>
            
            <div style="margin-top:2px;">
              <button class="btn btn-secondary assignment-open-student-btn" style="width:100%; padding:10px;">View Sessions</button>
            </div>
          `;

          const openButton = card.querySelector(".assignment-open-student-btn");
          const checkbox = card.querySelector(".assignment-compare-checkbox");

          openButton?.addEventListener("click", () => {
            if (!currentClassId || !currentAssignmentId) {
              return;
            }
            post("openAssignmentStudent", {
              classId: currentClassId,
              assignmentId: currentAssignmentId,
              studentAuthUserId: s.authUserId,
              studentName: s.studentName || "Unknown Student",
            });
          });

          checkbox?.addEventListener("change", (event) => {
            const selected = toggleAssignmentStudentSelection(
              s.authUserId,
              !!event.target.checked,
            );
            if (!selected) {
              event.target.checked = false;
            }
          });

          list.appendChild(card);
        } catch (err) {
          console.error("Failed to render student card:", err);
        }
      });

      updateAssignmentComparisonControls();
    }

    function renderAssignmentStudentSessions(payload) {
      const sessions = payload.sessions || [];
      const studentName = payload.studentName || "Student";
      const studentView = $("assignment-student-view");
      const title = $("assignment-student-title");
      const empty = $("assignment-student-sessions-empty");
      const list = $("assignment-student-sessions-list");
      const logView = $("assignment-session-log-view");
      const workView = $("assignment-work-view");
      if (!studentView || !title || !empty || !list) {
        return;
      }
      // Hide the parent view (student list)
      if (workView) {
        workView.style.display = "none";
      }
      studentView.style.display = "block";
      title.textContent = `${studentName} - Session Logs`;
      list.innerHTML = "";
      if (logView) {
        logView.style.display = "none";
      }

      if (!sessions.length) {
        empty.style.display = "block";
        return;
      }
      empty.style.display = "none";

      sessions.forEach((s) => {
        const row = document.createElement("button");
        row.className = "btn btn-secondary";
        row.style.cssText =
          "text-align:left; border:1px solid var(--border); background:var(--surface); padding:10px;";
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
      if (!title || !content || !view) {
        return;
      }
      title.textContent = payload.filename || "Session Log";
      content.textContent = payload.text || "No log data available.";
      view.style.display = "block";
    }

    $("btn-new-class")?.addEventListener("click", () => {
      if (isInClassFlowView()) {
        if ($("class-detail-view")) {
          $("class-detail-view").style.display = "none";
        }
        if ($("assignment-work-view")) {
          $("assignment-work-view").style.display = "none";
        }
        if ($("assignment-student-view")) {
          $("assignment-student-view").style.display = "none";
        }
        if ($("assignment-session-log-view")) {
          $("assignment-session-log-view").style.display = "none";
        }
        if ($("class-list-view")) {
          $("class-list-view").style.display = "grid";
        }
        currentClassDetailTab = "students";
        currentClassDisplayName = "";
        setAssignmentFormVisible(false);
        setClassRefreshLoading(false);
        updateTopClassActionButton();
        updateClassTabHeading();
        loadClasses();
        return;
      }

      const classForm = $("class-form-card");
      if (classForm) {
        editingClassId = null;
        const submitBtn = $("btn-submit-class");
        if (submitBtn) {
          submitBtn.textContent = "Create Class";
        }
        classForm.style.display =
          classForm.style.display === "none" ? "block" : "none";
      }
    });

    $("btn-new-assignment")?.addEventListener("click", () => {
      if (currentClassDetailTab === "assignments") {
        setAssignmentFormVisible(true);
      }
    });

    $("btn-cancel-class")?.addEventListener("click", () => {
      if ($("class-form-card")) {
        $("class-form-card").style.display = "none";
      }
      clearMeetingScheduleInputs();
      editingClassId = null;
      const submitBtn = $("btn-submit-class");
      if (submitBtn) {
        submitBtn.textContent = "Create Class";
      }
    });

    $("btn-back-to-classes")?.addEventListener("click", () => {
      if ($("class-detail-view")) {
        $("class-detail-view").style.display = "none";
      }
      if ($("class-list-view")) {
        $("class-list-view").style.display = "grid";
      }
      currentClassDetailTab = "students";
      currentClassDisplayName = "";
      setAssignmentFormVisible(false);
      updateTopClassActionButton();
      updateClassTabHeading();
      updateClassPrimaryActionButton();
      loadClasses();
    });

    $("btn-back-to-assignments")?.addEventListener("click", () => {
      if ($("assignment-student-view")) {
        $("assignment-student-view").style.display = "none";
      }
      if ($("assignment-session-log-view")) {
        $("assignment-session-log-view").style.display = "none";
      }
      if ($("class-detail-view")) {
        $("class-detail-view").style.display = "block";
      }
      if ($("assignment-work-view")) {
        $("assignment-work-view").style.display = "none";
      }
      clearAssignmentComparisonSelection();
      restoreAssignmentListVisibility();
    });

    $("btn-back-to-assignment-students")?.addEventListener("click", () => {
      if ($("assignment-student-view")) {
        $("assignment-student-view").style.display = "none";
      }
      if ($("assignment-session-log-view")) {
        $("assignment-session-log-view").style.display = "none";
      }
      if ($("assignment-work-view")) {
        $("assignment-work-view").style.display = "block";
      }
    });

    $("class-detail-tab-students")?.addEventListener("click", () =>
      switchClassDetailTab("students"),
    );
    $("class-detail-tab-assignments")?.addEventListener("click", () =>
      switchClassDetailTab("assignments"),
    );

    $("btn-refresh-students")?.addEventListener("click", () => {
      if (currentClassId) {
        setClassRefreshLoading(true);
        post("openClass", { classId: currentClassId });
      }
    });

    $("btn-clear-assignment-compare")?.addEventListener("click", () => {
      clearAssignmentComparisonSelection();
      updateAssignmentComparisonControls();
    });

    $("btn-compare-assignment-students")?.addEventListener("click", () => {
      if (!currentClassId || !currentAssignmentId) {
        showAssignmentCompareMessage("Open an assignment first.", "error");
        return;
      }

      const selectedStudents = selectedComparisonStudents();
      if (selectedStudents.length !== 2) {
        showAssignmentCompareMessage(
          "Select exactly 2 students to compare.",
          "warning",
        );
        return;
      }

      //Check if either student has 0 sessions
      const unstartedStudents = selectedStudents.filter(
        (s) => !s.sessionCount || s.sessionCount === 0,
      );
      if (unstartedStudents.length > 0) {
        const names = unstartedStudents
          .map((s) => s.studentName || s.studentEmail || "A selected student")
          .join(" and ");
        showAssignmentCompareMessage(
          `Cannot compare: ${names} has not started any sessions yet.`,
          "error",
        );
        // Hide the comparison view if it was previously open
        if ($("assignment-compare-view")) {
          $("assignment-compare-view").style.display = "none";
        }
        return;
      }
      showAssignmentCompareMessage("Loading synchronized comparison view...");
      post("compareAssignmentStudents", {
        classId: currentClassId,
        assignmentId: currentAssignmentId,
        students: selectedStudents.map((student) => ({
          studentAuthUserId: student.authUserId,
          studentName: student.studentName || "Student",
        })),
      });
    });

    document.querySelectorAll(".assignment-compare-filter").forEach((input) => {
      input.addEventListener("change", () => {
        currentComparisonFilters[input.dataset.category] = !!input.checked;
        if (currentAssignmentComparison) {
          renderAssignmentComparison(currentAssignmentComparison);
        }
      });
    });

    $("btn-create-assignment")?.addEventListener("click", () => {
      if (!currentClassId) {
        if (status) {
          status.textContent = "Open a class first.";
        }
        return;
      }

      const name = $("assignment-name")?.value?.trim();
      const description = $("assignment-description")?.value?.trim();
      const dueDate = $("assignment-due-date")?.value;
      const errEl = $("assignment-form-error");

      if (!name) {
        if (errEl) {
          errEl.textContent = "Assignment name is required.";
          errEl.style.display = "block";
        }
        return;
      }

      if (errEl) {
        errEl.style.display = "none";
      }
      const btn = $("btn-create-assignment");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Creating...";
      }

      post("createClassAssignment", {
        classId: currentClassId,
        name,
        description: description || "",
        dueDate: dueDate || "",
      });
    });

    $("btn-submit-class")?.addEventListener("click", () => {
      const courseName = $("class-course-name")?.value?.trim();
      const courseCode = $("class-course-code")?.value?.trim();
      const teacherName = $("class-teacher-name")?.value?.trim();
      const meetingTime = buildMeetingScheduleText();
      const startDate = $("class-start-date")?.value;
      const endDate = $("class-end-date")?.value;
      const errEl = $("class-form-error");

      if ($("class-meeting-time")) {
        $("class-meeting-time").value = meetingTime;
      }

      if (
        !courseName ||
        !courseCode ||
        !teacherName ||
        !meetingTime ||
        !startDate ||
        !endDate
      ) {
        if (errEl) {
          errEl.textContent =
            "Course Name, Course Code, Teacher Name, Meeting Schedule, Start Date, and End Date are required.";
          errEl.style.display = "block";
        }
        return;
      }
      if (startDate > endDate) {
        if (errEl) {
          errEl.textContent = "End Date must be on or after Start Date.";
          errEl.style.display = "block";
        }
        return;
      }
      if (errEl) {
        errEl.style.display = "none";
      }

      const btn = $("btn-submit-class");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Creating...";
      }
      if (editingClassId) {
        post("updateClass", {
          classId: editingClassId,
          courseName,
          courseCode,
          teacherName,
          meetingTime: meetingTime || "",
          startDate,
          endDate,
        });
        if (btn) {
          btn.textContent = "Saving...";
        }
      } else {
        post("createClass", {
          courseName,
          courseCode,
          teacherName,
          meetingTime: meetingTime || "",
          startDate,
          endDate,
        });
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
