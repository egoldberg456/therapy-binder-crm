/**
 * Shared "Log outreach" modal + date helpers — loaded by content.js and dev-modal-preview.html.
 * @file
 */
(function (global) {
  "use strict";

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildDefaultTitle(subject, recipients) {
    const safeSubject = subject || "(no subject)";
    if (recipients.length === 1) return `[${recipients[0]}] ${safeSubject}`;
    return safeSubject;
  }

  /**
   * Default for the sheet "Name" column: display name from the primary To recipient, else email.
   * @param {{ email?: string, name?: string }[]} [recipientDetails]
   * @param {string[]} [recipientEmailsFallback] — plain email strings when details are missing
   */
  function defaultSheetRecipientName(recipientDetails, recipientEmailsFallback) {
    const first =
      Array.isArray(recipientDetails) && recipientDetails.length ? recipientDetails[0] : null;
    if (first) {
      const name = String(first.name || "").trim();
      const email = String(first.email || "").trim();
      return name || email;
    }
    const emails = Array.isArray(recipientEmailsFallback) ? recipientEmailsFallback : [];
    return String(emails[0] || "").trim();
  }

  /** Same YYYY-MM-DD as sheet sync (local calendar day). */
  function todayISODateForLastAction() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function ordinalWord(n) {
    const k = Number(n) || 1;
    if (k <= 1) return "first";
    if (k === 2) return "second";
    if (k === 3) return "third";
    return `${k}th`;
  }

  function chainNoResponseNote(outgoingOrdinal, isFirstInThread) {
    if (isFirstInThread) return "This is your first email in this thread.";
    const ord = ordinalWord(outgoingOrdinal);
    return `This is the ${ord} email you've sent without a response.`;
  }

  function normalizeThreadChain(raw) {
    const prior = Array.isArray(raw?.priorCorrespondences) ? raw.priorCorrespondences : [];
    const outgoingOrdinal =
      typeof raw?.outgoingOrdinal === "number" && raw.outgoingOrdinal >= 1
        ? raw.outgoingOrdinal
        : prior.length + 1;
    const isFirstInThread =
      typeof raw?.isFirstInThread === "boolean"
        ? raw.isFirstInThread
        : prior.length === 0;
    return { priorCorrespondences: prior.slice(-3), outgoingOrdinal, isFirstInThread };
  }

  function parseGmailDateBestEffort(dateText) {
    const raw = String(dateText || "").trim();
    if (!raw) return null;

    // Gmail often uses a title like:
    // "Wed, Apr 15, 2026 at 9:14 AM" which Date.parse usually understands.
    // Some locales may include extra words; we try a few normalizations.
    const candidates = [
      raw,
      raw.replace(/\s+at\s+/i, " "),
      raw.replace(/[–—]/g, "-")
    ];

    for (const c of candidates) {
      const ms = Date.parse(c);
      if (!Number.isNaN(ms)) return new Date(ms);
    }
    return null;
  }

  function diffWholeDays(earlier, later) {
    if (!(earlier instanceof Date) || !(later instanceof Date)) return null;
    const a = earlier.getTime();
    const b = later.getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const msPerDay = 24 * 60 * 60 * 1000;
    return Math.max(0, Math.floor((b - a) / msPerDay));
  }

  function buildThreadChainCardInnerHtml(threadChain) {
    const chain = normalizeThreadChain(threadChain);
    if (chain.isFirstInThread) {
      return `
        <div style="font-size: 13px; font-weight: 600; color: #202124; margin-bottom: 6px;">Email chain</div>
        <div style="font-size: 12px; color: #5f6368; line-height: 1.45;">
          <strong>First outreach in this thread.</strong> No reply yet.
        </div>
      `;
    }

    const parsedDates = chain.priorCorrespondences.map((row) =>
      parseGmailDateBestEffort(row?.date || "")
    );
    const now = new Date();
    const lastIdx = chain.priorCorrespondences.length - 1;
    const daysSinceLast =
      lastIdx >= 0 && parsedDates[lastIdx] ? diffWholeDays(parsedDates[lastIdx], now) : null;

    const items = chain.priorCorrespondences
      .map((row, idx) => {
        const from = escapeHtml(String(row?.from || "(unknown sender)").trim() || "(unknown sender)");
        const date = escapeHtml(String(row?.date || "").trim());
        const snippet = escapeHtml(String(row?.snippet || "").trim() || "—");
        const thisDate = parsedDates[idx];
        const prevDate = idx > 0 ? parsedDates[idx - 1] : null;
        const gapDays = idx > 0 ? diffWholeDays(prevDate, thisDate) : null;
        const showSinceLast = idx === lastIdx && daysSinceLast !== null;

        const gapLabel =
          gapDays === null
            ? ""
            : ` <span style="font-weight: 400; color: #80868b;">· +${gapDays}d</span>`;
        const sinceLastLabel = showSinceLast
          ? ` <span style="font-weight: 400; color: #80868b;">· ${daysSinceLast}d ago</span>`
          : "";

        const meta = date
          ? `${from} · ${date}${gapLabel}${sinceLastLabel}`
          : `${from}${gapLabel}${sinceLastLabel}`;
        const topRule = idx ? "border-top: 1px solid #e8eaed;" : "";
        return `
          <div style="padding: 10px 0; ${topRule}">
            <div style="font-size: 12px; font-weight: 600; color: #202124; line-height: 1.35;">${meta}</div>
            <div style="font-size: 12px; color: #5f6368; line-height: 1.4; margin-top: 4px;">${snippet}</div>
          </div>
        `;
      })
      .join("");

    return `
      <div style="font-size: 13px; font-weight: 600; color: #202124; margin-bottom: 2px;">Last ${chain.priorCorrespondences.length} emails in chain</div>
      <div style="font-size: 11px; color: #80868b; line-height: 1.35; margin-bottom: 4px;">Most recent emails shown, oldest first.</div>
      <div style="margin-top: 2px;">${items}</div>
    `;
  }

  function buildDefaultLastAction(subject, threadChain) {
    const sentDateISO = todayISODateForLastAction();
    const s = String(subject || "").trim();
    const short = s.length > 60 ? `${s.slice(0, 57)}…` : s;
    const body = short ? `Email sent — ${short}` : "Email sent.";
    const chain = normalizeThreadChain(threadChain);
    const chainNote = chainNoResponseNote(chain.outgoingOrdinal, chain.isFirstInThread);
    return `${sentDateISO} — ${body} — ${chainNote}`;
  }

  /** Same lines as Google Task notes when no custom description is used. */
  function buildDefaultTaskDescription(subject, recipients, emailUrl) {
    const lines = [];
    const recips = Array.isArray(recipients) ? recipients : [];
    if (recips.length) lines.push(`To: ${recips.join(", ")}`);
    const s = String(subject || "").trim();
    if (s) lines.push(`Subject: ${s}`);
    const url = String(emailUrl || "").trim();
    if (url) lines.push(`Email link: ${url}`);
    return lines.join("\n");
  }

  /**
   * Value written to the "Last Action" sheet column: always uses the sync day's date once.
   * If the modal text already starts with YYYY-MM-DD — (our default), that prefix is replaced
   * so the date is not doubled when syncing.
   */
  function formatLastActionSheetValue(sentDateISO, note) {
    const raw = String(note ?? "").trim();
    if (!raw) return sentDateISO;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return sentDateISO;
    const withoutLeading = raw.replace(/^\d{4}-\d{2}-\d{2}\s*(?:—|-)\s*/, "").trim();
    if (!withoutLeading) return sentDateISO;
    return `${sentDateISO} — ${withoutLeading}`;
  }

  function isWeekend(date) {
    const day = date.getDay();
    return day === 0 || day === 6;
  }

  function addWorkingDays(startDate, workingDays) {
    const date = new Date(startDate);

    if (workingDays === 0) {
      while (isWeekend(date)) date.setDate(date.getDate() + 1);
      return date;
    }

    let added = 0;
    while (added < workingDays) {
      date.setDate(date.getDate() + 1);
      if (!isWeekend(date)) added += 1;
    }
    return date;
  }

  function primaryButtonStyle() {
    return "border:none;background:#1a73e8;color:white;border-radius:999px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;";
  }

  function secondaryButtonStyle() {
    return "border:1px solid #dadce0;background:#fff;color:#202124;border-radius:999px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;";
  }

  function quickDayButton(days) {
    return `<button type="button" data-days="${days}" style="border:1px solid #dadce0;background:#fff;color:#202124;border-radius:999px;padding:8px 12px;font-size:12px;cursor:pointer;">${days} ${days === 1 ? "day" : "days"}</button>`;
  }

  async function loadSheetRowsViaExtension() {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) {
      return { rows: [], missingHeaders: [] };
    }
    try {
      const sheetResp = await new Promise((res) => {
        runtime.sendMessage({ type: "GET_OUTREACH_SHEET_ROWS" }, res);
      });
      if (runtime.lastError) throw new Error(runtime.lastError.message);
      if (sheetResp?.ok && sheetResp?.result) {
        return {
          rows: Array.isArray(sheetResp.result.rows) ? sheetResp.result.rows : [],
          missingHeaders: Array.isArray(sheetResp.result.missingHeaders)
            ? sheetResp.result.missingHeaders
            : []
        };
      }
    } catch (e) {
      console.warn("[Gmail Follow-up] Could not load sheet rows:", e);
    }
    return { rows: [], missingHeaders: [] };
  }

  async function loadOpenTasksViaExtension(senderEmail) {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) {
      return { tasks: [], error: "Extension runtime not available" };
    }
    return new Promise((resolve) => {
      runtime.sendMessage({ type: "GET_OPEN_GOOGLE_TASKS", senderEmail }, (response) => {
        if (runtime.lastError) {
          resolve({ tasks: [], error: runtime.lastError.message });
          return;
        }
        if (!response?.ok) {
          resolve({ tasks: [], error: response?.error || "Unknown error" });
          return;
        }
        resolve({ tasks: Array.isArray(response.tasks) ? response.tasks : [] });
      });
    });
  }

  /**
   * @param {string[]} taskKeys
   * @returns {Promise<{ ok: boolean, error?: string, result?: { completed: number, failed: { id: string, error: string }[] } }>}
   */
  async function completeTasksViaExtension(taskKeys, senderEmail) {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) {
      return { ok: false, error: "Extension runtime not available" };
    }
    return new Promise((resolve) => {
      runtime.sendMessage({ type: "COMPLETE_GOOGLE_TASKS", taskIds: taskKeys, senderEmail }, (response) => {
        if (runtime.lastError) {
          resolve({ ok: false, error: runtime.lastError.message });
          return;
        }
        if (!response?.ok) {
          resolve({ ok: false, error: response?.error || "Unknown error" });
          return;
        }
        resolve({ ok: true, result: response.result || { completed: 0, failed: [] } });
      });
    });
  }

  function taskNotesMatchTokens(task, tokens) {
    if (!tokens.length) return false;
    const hay = String(task?.notes || "").toLowerCase();
    return tokens.every((t) => hay.includes(t));
  }

  /**
   * @param {object} options
   * @param {string} options.defaultTitle
   * @param {number} options.defaultWorkingDays
   * @param {string} options.subject
   * @param {string[]} options.recipients
   * @param {{ email?: string, name?: string }[]} [options.recipientDetails] — primary To chip data; used to default sheet Name
   * @param {string} [options.emailUrl]
   * @param {string} [options.senderEmail] — Gmail “From”; used for task-list routing in the extension service worker
   * @param {{ priorCorrespondences?: { from?: string, date?: string, snippet?: string }[], outgoingOrdinal?: number }} [options.threadChain]
   * @param {string} [options.defaultTaskDescription] — overrides buildDefaultTaskDescription(subject, recipients, emailUrl)
   * @param {() => Promise<{ rows?: object[], missingHeaders?: string[] }>} [options.loadSheetRows] — defaults to GET_OUTREACH_SHEET_ROWS via the extension runtime
   * @param {() => Promise<{ tasks?: { id: string, title: string, notes: string, due?: string|null }[], error?: string }>} [options.loadOpenTasks]
   * @param {(taskIds: string[]) => Promise<{ ok: boolean, error?: string, result?: { completed: number, failed: { id: string, error: string }[] } }>} [options.completeOpenTasks]
   * @param {(message: string, durationMs?: number) => void} [options.onNotify]
   */
  function showTaskModal(options) {
    const {
      defaultTitle,
      defaultWorkingDays,
      subject,
      recipients,
      recipientDetails = [],
      emailUrl,
      threadChain: threadChainRaw = null,
      defaultTaskDescription,
      senderEmail: modalSenderEmail,
      loadSheetRows = loadSheetRowsViaExtension,
      loadOpenTasks: loadOpenTasksOption,
      completeOpenTasks: completeOpenTasksOption,
      onNotify = null
    } = options;

    const loadOpenTasks =
      loadOpenTasksOption ?? (() => loadOpenTasksViaExtension(modalSenderEmail));
    const completeOpenTasks =
      completeOpenTasksOption ?? ((taskKeys) => completeTasksViaExtension(taskKeys, modalSenderEmail));

    return new Promise((resolve) => {
      (async () => {
        const existing = document.getElementById("gmail-followup-modal-overlay");
        if (existing) existing.remove();

        const overlay = document.createElement("div");
        overlay.id = "gmail-followup-modal-overlay";
        overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.45);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: Arial, sans-serif;
      `;

        const modal = document.createElement("div");
        modal.style.cssText = `
        width: 760px;
        max-width: calc(100vw - 32px);
        max-height: calc(100vh - 40px);
        background: #fff;
        color: #202124;
        border-radius: 16px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.25);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      `;

        let sheetRows = [];
        let sheetMissingHeaders = [];
        let openTasks = [];
        let tasksLoadError = "";

        const defaultTaskNotesFilter = String(recipients[0] || "").trim();
        const defaultSheetName = defaultSheetRecipientName(recipientDetails, recipients);
        const taskDescriptionDefault =
          typeof defaultTaskDescription === "string"
            ? defaultTaskDescription
            : buildDefaultTaskDescription(subject, recipients, emailUrl);
        const threadChain = normalizeThreadChain(threadChainRaw);
        const defaultLastAction = buildDefaultLastAction(subject, threadChain);

        modal.innerHTML = `
        <div style="padding: 18px 20px 12px 20px; border-bottom: 1px solid #e8eaed;">
          <div style="font-size: 20px; font-weight: 600; margin-bottom: 4px;">Log outreach</div>
          <div style="font-size: 13px; color: #5f6368; line-height: 1.4;">Update your outreach tracker, add a Google Task, or both. Follow-up date below sets the task due date and the sheet’s next applicable outreach date column.</div>
        </div>

        <div style="padding: 18px 20px; display: grid; gap: 14px; overflow-y: auto; flex: 1; min-height: 0;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start;">
            <div style="display: grid; gap: 14px;">
              <div style="font-size: 12px; color: #5f6368; line-height: 1.45;">
            <div><strong>To:</strong> ${escapeHtml(recipients.length ? recipients.join(", ") : "None found")}</div>
            <div style="margin-top: 4px;"><strong>Subject:</strong> ${escapeHtml(subject || "(no subject)")}</div>
          </div>

          <label style="display: grid; gap: 6px;">
            <span style="font-size: 13px; font-weight: 600;">Name (spreadsheet)</span>
            <input
              id="gmail-followup-sheet-name"
              type="text"
              value="${escapeHtml(defaultSheetName)}"
              placeholder="Recipient name or email"
              style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #dadce0; border-radius: 10px; font-size: 14px; outline: none;"
            />
          </label>

          <label style="display: grid; gap: 6px;">
            <span style="font-size: 13px; font-weight: 600;">Organization (spreadsheet)</span>
            <input
              id="gmail-followup-organization"
              type="text"
              value=""
              placeholder="Company, school, or other org"
              style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #dadce0; border-radius: 10px; font-size: 14px; outline: none;"
            />
          </label>

          <label style="display: grid; gap: 6px;">
            <span style="font-size: 13px; font-weight: 600;">Task title</span>
            <input
              id="gmail-followup-title"
              type="text"
              value="${escapeHtml(defaultTitle)}"
              style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #dadce0; border-radius: 10px; font-size: 14px; outline: none;"
            />
          </label>

          <label style="display: grid; gap: 6px;">
            <span style="font-size: 13px; font-weight: 600;">Task description</span>
            <textarea
              id="gmail-followup-task-description"
              rows="4"
              placeholder="To, subject, and email link appear here by default."
              style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #dadce0; border-radius: 10px; font-size: 14px; outline: none; resize: vertical; font-family: inherit; line-height: 1.4;"
            >${escapeHtml(taskDescriptionDefault)}</textarea>
          </label>
          <div style="font-size: 12px; color: #5f6368; line-height: 1.4; margin-top: -6px;">
            This becomes the Google Task description (notes). Edit before creating the task.
          </div>

          <label style="display: grid; gap: 6px;">
            <span style="font-size: 13px; font-weight: 600;">Label</span>
            <select
              id="gmail-followup-label"
              style="width: 100%; max-width: 280px; box-sizing: border-box; padding: 10px 12px; border: 1px solid #dadce0; border-radius: 10px; font-size: 14px; outline: none; background: #fff; color: #202124;"
            >
              <option value="Potential Customer">Potential Customer</option>
              <option value="Existing Customer">Existing Customer</option>
              <option value="Advisor">Advisor</option>
              <option value="VC">VC</option>
              <option value="Grant">Grant</option>
            </select>
          </label>

          <label style="display: grid; gap: 6px;">
            <span style="font-size: 13px; font-weight: 600;">Working days from now</span>
            <input
              id="gmail-followup-days"
              type="number"
              min="0"
              step="1"
              value="${defaultWorkingDays}"
              style="width: 140px; box-sizing: border-box; padding: 10px 12px; border: 1px solid #dadce0; border-radius: 10px; font-size: 14px; outline: none;"
            />
          </label>

          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            ${quickDayButton(1)}
            ${quickDayButton(3)}
            ${quickDayButton(5)}
            ${quickDayButton(7)}
          </div>

          <div id="gmail-followup-due-preview" style="font-size: 12px; color: #5f6368; line-height: 1.45;"></div>

          <label style="display: grid; gap: 6px;">
            <span style="font-size: 13px; font-weight: 600;">Last Action (spreadsheet)</span>
            <textarea
              id="gmail-followup-last-action"
              rows="3"
              style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #dadce0; border-radius: 10px; font-size: 14px; outline: none; resize: vertical; font-family: inherit;"
            >${escapeHtml(defaultLastAction)}</textarea>
          </label>

            </div>

            <div style="display: grid; gap: 10px;">
              <div style="font-size: 13px; font-weight: 600;">Map to existing spreadsheet row</div>
              <div style="font-size: 12px; color: #5f6368; line-height: 1.35;">
                Search columns: <strong>Name</strong>, <strong>Email Address Recepient</strong>, <strong>Subject Line</strong>.
              </div>
              <div
                id="gmail-followup-thread-chain"
                style="border: 1px solid #e8eaed; border-radius: 12px; padding: 12px 14px; background: #fafafa; box-sizing: border-box;"
              ></div>
              <div id="gmail-followup-sheet-missing"></div>
              <input
                id="gmail-followup-sheet-filter"
                type="text"
                placeholder="Type to filter rows…"
                disabled
                style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #dadce0; border-radius: 10px; font-size: 14px; outline: none;"
              />
              <div
                id="gmail-followup-sheet-results"
                style="border: 1px solid #e8eaed; border-radius: 12px; overflow: hidden; max-height: 280px; overflow-y: auto;"
              >
                <div style="padding: 10px 12px; font-size: 12px; color: #5f6368;">
                  Loading rows…
                </div>
              </div>
              <input id="gmail-followup-mapped-row" type="hidden" value="" />
              <div id="gmail-followup-sheet-hint" style="font-size: 12px; color: #5f6368;">
                Tip: click a row to select it (optional).
              </div>
            </div>
          </div>

          <div style="padding-top: 14px; border-top: 1px solid #e8eaed;">
            <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px;">
              <div style="font-size: 13px; font-weight: 600;">Existing open tasks</div>
              <button type="button" id="gmail-followup-close-tasks" disabled style="${secondaryButtonStyle()}opacity:0.5;cursor:default;">Close selected tasks</button>
            </div>
            <div style="font-size: 12px; color: #5f6368; line-height: 1.35; margin-bottom: 10px;">
              Search matches text in the task <strong>notes</strong> (description). The default is the primary recipient email when available.
            </div>
            <div id="gmail-followup-tasks-error"></div>
            <input
              id="gmail-followup-tasks-filter"
              type="text"
              placeholder="Search task notes…"
              value="${escapeHtml(defaultTaskNotesFilter)}"
              disabled
              style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #dadce0; border-radius: 10px; font-size: 14px; outline: none; margin-bottom: 10px;"
            />
            <div
              id="gmail-followup-tasks-results"
              style="border: 1px solid #e8eaed; border-radius: 12px; overflow: hidden; max-height: 220px; overflow-y: auto;"
            >
              <div style="padding: 10px 12px; font-size: 12px; color: #5f6368;">Loading tasks…</div>
            </div>
            <div id="gmail-followup-tasks-hint" style="font-size: 12px; color: #5f6368; margin-top: 8px;">
              Select one or more tasks, then click Close selected tasks. This does not update the sheet or create a new task.
            </div>
          </div>
        </div>

        <div style="padding: 14px 20px 18px 20px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; border-top: 1px solid #e8eaed; flex-shrink: 0;">
          <button type="button" id="gmail-followup-cancel" style="${secondaryButtonStyle()}">Cancel</button>
          <div style="display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end;">
            <button type="button" id="gmail-followup-sheet-only" style="${secondaryButtonStyle()}">Update sheet only</button>
            <button type="button" id="gmail-followup-create-task-only" style="${secondaryButtonStyle()}">Create Task</button>
            <button type="button" id="gmail-followup-create" style="${primaryButtonStyle()}">Create task and update spreadsheet</button>
          </div>
        </div>
      `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const threadChainEl = modal.querySelector("#gmail-followup-thread-chain");
        if (threadChainEl) {
          threadChainEl.innerHTML = buildThreadChainCardInnerHtml(threadChain);
        }

        const sheetNameInput = modal.querySelector("#gmail-followup-sheet-name");
        const organizationInput = modal.querySelector("#gmail-followup-organization");
        const titleInput = modal.querySelector("#gmail-followup-title");
        const taskDescriptionInput = modal.querySelector("#gmail-followup-task-description");
        const labelSelect = modal.querySelector("#gmail-followup-label");
        const daysInput = modal.querySelector("#gmail-followup-days");
        const lastActionInput = modal.querySelector("#gmail-followup-last-action");
        const sheetFilter = modal.querySelector("#gmail-followup-sheet-filter");
        const sheetResults = modal.querySelector("#gmail-followup-sheet-results");
        const mappedRowInput = modal.querySelector("#gmail-followup-mapped-row");
        const duePreviewEl = modal.querySelector("#gmail-followup-due-preview");
        const sheetMissingEl = modal.querySelector("#gmail-followup-sheet-missing");
        const tasksErrorEl = modal.querySelector("#gmail-followup-tasks-error");

        function updateFollowUpDatePreview() {
          if (!duePreviewEl) return;
          const n = parseInt(daysInput.value, 10);
          if (isNaN(n) || n < 0) {
            duePreviewEl.textContent = "Enter a valid number of working days to see the follow-up date.";
            return;
          }
          const due = addWorkingDays(new Date(), n);
          due.setHours(9, 0, 0, 0);
          const formatted = due.toLocaleDateString(undefined, {
            weekday: "short",
            year: "numeric",
            month: "short",
            day: "numeric"
          });
          duePreviewEl.textContent = `Follow-up date: ${formatted}`;
        }

        modal.querySelectorAll("[data-days]").forEach((btn) => {
          btn.addEventListener("click", () => {
            daysInput.value = btn.getAttribute("data-days");
            updateFollowUpDatePreview();
          });
        });

        daysInput.addEventListener("input", updateFollowUpDatePreview);
        updateFollowUpDatePreview();

        function tokenizeQuery(q) {
          return String(q || "")
            .trim()
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
        }

        function rowMatchesTokens(row, tokens) {
          if (!tokens.length) return true;
          const hay = `${row.name || ""} ${row.recipientEmail || ""} ${row.subject || ""}`.toLowerCase();
          return tokens.every((t) => hay.includes(t));
        }

        function renderSheetRows(filtered, selectedRowNumber) {
          if (!sheetResults) return;
          if (sheetMissingHeaders.length) return;

          const max = 50;
          const rows = filtered.slice(0, max);
          const selectedNum = Number(selectedRowNumber) || 0;
          const header = `
          <div style="display:grid; grid-template-columns: 92px 1fr; gap: 10px; padding: 10px 12px; background: #f8f9fa; border-bottom: 1px solid #e8eaed; font-size: 12px; color: #5f6368;">
            <div><strong>Row</strong></div>
            <div><strong>Match</strong></div>
          </div>
        `;
          const body =
            rows.length === 0
              ? `<div style="padding: 10px 12px; font-size: 12px; color: #5f6368;">No matches.</div>`
              : rows
                  .map((r) => {
                    const isSelected = selectedNum === Number(r.sheetRowNumber);
                    const bg = isSelected ? "#e8f0fe" : "#fff";
                    return `
                    <button
                      type="button"
                      data-sheet-row="${escapeHtml(String(r.sheetRowNumber))}"
                      style="width:100%; text-align:left; display:grid; grid-template-columns: 92px 1fr; gap: 10px; padding: 10px 12px; border:none; border-bottom: 1px solid #f1f3f4; background:${bg}; cursor:pointer;"
                    >
                      <div style="font-size: 12px; color: #5f6368;">
                        ${escapeHtml(String(r.sheetRowNumber))}
                      </div>
                      <div style="font-size: 13px; color: #202124;">
                        <div style="font-weight: 600; line-height: 1.25;">${escapeHtml(
                          r.name || "(no name)"
                        )}</div>
                        <div style="font-size: 12px; color: #5f6368; line-height: 1.35; margin-top: 1px;">${escapeHtml(
                          `${r.recipientEmail || "(no email)"} • ${r.subject || "(no subject)"}`
                        )}</div>
                      </div>
                    </button>
                  `;
                  })
                  .join("");

          sheetResults.innerHTML = `
          <div>
            ${header}
            ${body}
            ${
              filtered.length > max
                ? `<div style="padding: 10px 12px; font-size: 12px; color: #5f6368; border-top: 1px solid #e8eaed;">Showing first ${max} of ${filtered.length} matches.</div>`
                : ""
            }
          </div>
        `;

          sheetResults.querySelectorAll("button[data-sheet-row]").forEach((btn) => {
            btn.addEventListener("click", () => {
              const n = Number(btn.getAttribute("data-sheet-row") || 0);
              mappedRowInput.value = n ? String(n) : "";
              const picked = sheetRows.find((r) => Number(r.sheetRowNumber) === n);
              if (organizationInput && picked) {
                organizationInput.value = String(picked.organization ?? "");
              }
              if (labelSelect && picked) {
                const pickedLabel = String(picked.label ?? "").trim();
                if (pickedLabel) {
                  const hasOption = Array.from(labelSelect.options).some(
                    (o) => String(o.value) === pickedLabel
                  );
                  if (!hasOption) {
                    const opt = document.createElement("option");
                    opt.value = pickedLabel;
                    opt.textContent = pickedLabel;
                    labelSelect.appendChild(opt);
                  }
                  labelSelect.value = pickedLabel;
                }
              }
              const tokens = tokenizeQuery(sheetFilter?.value || "");
              const f = sheetRows.filter((r) => rowMatchesTokens(r, tokens));
              renderSheetRows(f, mappedRowInput.value);
            });
          });
        }

        if (sheetFilter) {
          sheetFilter.addEventListener("input", () => {
            const tokens = tokenizeQuery(sheetFilter.value);
            const filtered = sheetRows.filter((r) => rowMatchesTokens(r, tokens));
            renderSheetRows(filtered, mappedRowInput.value);
          });
        }

        const tasksFilter = modal.querySelector("#gmail-followup-tasks-filter");
        const tasksResults = modal.querySelector("#gmail-followup-tasks-results");
        const closeTasksBtn = modal.querySelector("#gmail-followup-close-tasks");
        const tasksHintEl = modal.querySelector("#gmail-followup-tasks-hint");
        const selectedTaskKeys = new Set();
        let closingTasks = false;

        function updateCloseTasksButton() {
          if (!closeTasksBtn) return;
          const n = selectedTaskKeys.size;
          const dis = n === 0 || closingTasks || !!tasksLoadError;
          closeTasksBtn.disabled = dis;
          closeTasksBtn.style.opacity = dis ? "0.5" : "1";
          closeTasksBtn.style.cursor = dis ? "default" : "pointer";
          closeTasksBtn.textContent = closingTasks ? "Closing…" : "Close selected tasks";
        }

        function notesSnippet(notes, maxLen) {
          const oneLine = String(notes || "")
            .replace(/\s+/g, " ")
            .trim();
          if (oneLine.length <= maxLen) return oneLine;
          return `${oneLine.slice(0, maxLen - 1)}…`;
        }

        function renderOpenTaskRows() {
          if (!tasksResults) return;

          if (tasksLoadError) {
            tasksResults.innerHTML = `<div style="padding: 10px 12px; font-size: 12px; color: #5f6368;">Could not load tasks. Fix the error above, reload the extension if needed, then try again.</div>`;
            if (tasksHintEl) {
              tasksHintEl.textContent =
                "Closing tasks is unavailable until tasks load. You can still update the sheet or create a task.";
            }
            updateCloseTasksButton();
            return;
          }

          const tokens = tokenizeQuery(tasksFilter?.value || "");
          if (!tokens.length) {
            tasksResults.innerHTML = `<div style="padding: 10px 12px; font-size: 12px; color: #5f6368;">Type in the search box to list tasks. Matches must appear in the task notes (description).</div>`;
            if (tasksHintEl) {
              tasksHintEl.textContent = `${openTasks.length} open task(s) loaded. Select tasks to close them without using Create task and update spreadsheet, Create Task, or Update sheet only.`;
            }
            updateCloseTasksButton();
            return;
          }

          const filtered = openTasks.filter((t) => taskNotesMatchTokens(t, tokens));
          const max = 50;
          const slice = filtered.slice(0, max);

          if (tasksHintEl) {
            const extra =
              filtered.length > max ? ` Showing first ${max} of ${filtered.length} matches.` : "";
            tasksHintEl.textContent = `${openTasks.length} open task(s) loaded.${extra} Select one or many, then Close selected tasks.`;
          }

          if (slice.length === 0) {
            tasksResults.innerHTML = `<div style="padding: 10px 12px; font-size: 12px; color: #5f6368;">No open tasks whose notes contain that text.</div>`;
            updateCloseTasksButton();
            return;
          }

          const header = `
            <div style="display:grid; grid-template-columns: 36px 1fr; gap: 8px; padding: 10px 12px; background: #f8f9fa; border-bottom: 1px solid #e8eaed; font-size: 12px; color: #5f6368; align-items: center;">
              <div></div>
              <div><strong>Task</strong> (title & notes preview)</div>
            </div>`;

          const body = slice
            .map((t) => {
              const id = String(t.id || "");
              const listId = String(t.listId || "");
              const listTitle = String(t.listTitle || "");
              const taskKey = listId ? `${listId}::${id}` : id;
              const checked = selectedTaskKeys.has(taskKey) ? " checked" : "";
              const dueStr = t.due
                ? new Date(t.due).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric"
                  })
                : "";
              const dueLine = dueStr
                ? `<div style="font-size: 11px; color: #80868b; margin-top: 2px;">Due ${escapeHtml(dueStr)}</div>`
                : "";
              const listLine =
                listTitle
                  ? `<div style="font-size: 11px; color: #80868b; margin-top: 2px;">List: ${escapeHtml(
                      listTitle
                    )}</div>`
                  : "";
              return `
                <label style="display:grid; grid-template-columns: 36px 1fr; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #f1f3f4; background: #fff; cursor: pointer; margin: 0; align-items: start;">
                  <input type="checkbox" data-task-key="${escapeHtml(taskKey)}"${checked} style="width: 18px; height: 18px; margin-top: 2px; flex-shrink: 0;" />
                  <span style="min-width: 0;">
                    <span style="font-size: 13px; font-weight: 600; color: #202124; line-height: 1.3; display: block;">${escapeHtml(
                      t.title || "(no title)"
                    )}</span>
                    <span style="font-size: 12px; color: #5f6368; line-height: 1.35; margin-top: 2px; display: block; word-break: break-word;">${escapeHtml(
                      notesSnippet(t.notes, 140) || "(empty notes)"
                    )}</span>
                    ${dueLine}
                    ${listLine}
                  </span>
                </label>`;
            })
            .join("");

          tasksResults.innerHTML = `<div>${header}${body}</div>`;

          tasksResults.querySelectorAll("input[type=checkbox][data-task-key]").forEach((input) => {
            input.addEventListener("change", () => {
              const key = input.getAttribute("data-task-key") || "";
              if (!key) return;
              if (input.checked) selectedTaskKeys.add(key);
              else selectedTaskKeys.delete(key);
              updateCloseTasksButton();
            });
          });

          updateCloseTasksButton();
        }

        if (tasksFilter && !tasksLoadError) {
          tasksFilter.addEventListener("input", () => {
            renderOpenTaskRows();
          });
        }

        if (closeTasksBtn) {
          closeTasksBtn.addEventListener("click", async () => {
            const keys = [...selectedTaskKeys];
            if (!keys.length || closingTasks || tasksLoadError) return;
            closingTasks = true;
            updateCloseTasksButton();
            try {
              const resp = await completeOpenTasks(keys);
              closingTasks = false;
              updateCloseTasksButton();
              if (!resp?.ok) {
                alert(resp?.error || "Could not complete tasks.");
                return;
              }
              const failed = Array.isArray(resp.result?.failed) ? resp.result.failed : [];
              const failedSet = new Set(failed.map((f) => String(f.id)));
              const succeeded = keys.filter((k) => !failedSet.has(k));
              const succeededSet = new Set(succeeded);
              openTasks = openTasks.filter((t) => {
                const id = String(t.id || "");
                const listId = String(t.listId || "");
                const key = listId ? `${listId}::${id}` : id;
                return !succeededSet.has(key);
              });
              succeeded.forEach((k) => selectedTaskKeys.delete(k));
              renderOpenTaskRows();
              if (typeof onNotify === "function") {
                const detail = failed.map((f) => `${f.id}: ${f.error}`).join("\n");
                if (failed.length === 0) {
                  onNotify(`Closed ${succeeded.length} task(s).`, 4500);
                } else if (succeeded.length === 0) {
                  onNotify(`Could not close tasks.\n${detail}`, 12000);
                } else {
                  onNotify(
                    `Closed ${succeeded.length} task(s). ${failed.length} failed:\n${detail}`,
                    12000
                  );
                }
              }
            } catch (e) {
              closingTasks = false;
              updateCloseTasksButton();
              alert(String(e?.message || e));
            }
          });
        }

        // Load sheet rows + open tasks after rendering so the modal appears immediately.
        (async () => {
          // Sheet rows
          try {
            const loaded = await loadSheetRows();
            sheetRows = Array.isArray(loaded?.rows) ? loaded.rows : [];
            sheetMissingHeaders = Array.isArray(loaded?.missingHeaders) ? loaded.missingHeaders : [];
          } catch (e) {
            console.warn("[Gmail Follow-up] Could not load sheet rows:", e);
            sheetRows = [];
            sheetMissingHeaders = [];
          }

          if (sheetMissingEl) {
            sheetMissingEl.innerHTML = sheetMissingHeaders.length
              ? `<div style="font-size: 12px; color: #b3261e; background: #fce8e6; padding: 10px 12px; border-radius: 10px; border: 1px solid #fad2cf;">
                  Spreadsheet headers missing: ${escapeHtml(sheetMissingHeaders.join(", "))}. Row mapping search is disabled.
                </div>`
              : "";
          }

          if (sheetResults) {
            sheetResults.innerHTML = `<div style="padding: 10px 12px; font-size: 12px; color: #5f6368;">
              ${sheetMissingHeaders.length ? "Not available." : `${sheetRows.length} rows loaded.`}
            </div>`;
          }

          if (sheetFilter) {
            sheetFilter.disabled = !!sheetMissingHeaders.length;
            if (!sheetFilter.disabled) {
              const seed = recipients.length === 1 ? recipients[0] : subject || "";
              if (!sheetFilter.value) sheetFilter.value = seed;
              const tokens = tokenizeQuery(sheetFilter.value);
              const filtered = sheetRows.filter((r) => rowMatchesTokens(r, tokens));
              renderSheetRows(filtered, mappedRowInput.value);
            }
          }

          // Open tasks
          try {
            const taskLoaded = await loadOpenTasks();
            openTasks = Array.isArray(taskLoaded?.tasks) ? taskLoaded.tasks : [];
            tasksLoadError = taskLoaded?.error ? String(taskLoaded.error) : "";
          } catch (e) {
            console.warn("[Gmail Follow-up] Could not load open tasks:", e);
            openTasks = [];
            tasksLoadError = String(e?.message || e);
          }

          if (tasksErrorEl) {
            tasksErrorEl.innerHTML = tasksLoadError
              ? `<div style="font-size: 12px; color: #b3261e; background: #fce8e6; padding: 10px 12px; border-radius: 10px; border: 1px solid #fad2cf; margin-bottom: 10px;">${escapeHtml(
                  tasksLoadError
                )}</div>`
              : "";
          }

          if (tasksFilter) {
            tasksFilter.disabled = !!tasksLoadError;
          }

          renderOpenTaskRows();
        })();

        function cleanup(value) {
          overlay.remove();
          document.removeEventListener("keydown", onKeyDown, true);
          resolve(value);
        }

        function onKeyDown(ev) {
          if (ev.key === "Escape") {
            ev.preventDefault();
            cleanup(null);
          } else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
            ev.preventDefault();
            submitCreateTask();
          }
        }

        function submitCreateTask() {
          const title = titleInput.value.trim();
          const workingDays = parseInt(daysInput.value, 10);
          if (!title) return titleInput.focus();
          if (isNaN(workingDays) || workingDays < 0) return daysInput.focus();
          const mappedSheetRowNumber = Number(mappedRowInput?.value || 0) || null;
          cleanup({
            title,
            workingDays,
            label: labelSelect.value,
            action: "createTask",
            mappedSheetRowNumber,
            lastAction: lastActionInput ? lastActionInput.value.trim() : "",
            sheetRecipientName: sheetNameInput ? sheetNameInput.value.trim() : "",
            organization: organizationInput ? organizationInput.value.trim() : "",
            taskDescription: taskDescriptionInput ? taskDescriptionInput.value : ""
          });
        }

        function submitCreateTaskOnly() {
          const title = titleInput.value.trim();
          const workingDays = parseInt(daysInput.value, 10);
          if (!title) return titleInput.focus();
          if (isNaN(workingDays) || workingDays < 0) return daysInput.focus();
          const mappedSheetRowNumber = Number(mappedRowInput?.value || 0) || null;
          cleanup({
            title,
            workingDays,
            label: labelSelect.value,
            action: "createTaskOnly",
            mappedSheetRowNumber,
            lastAction: lastActionInput ? lastActionInput.value.trim() : "",
            sheetRecipientName: sheetNameInput ? sheetNameInput.value.trim() : "",
            organization: organizationInput ? organizationInput.value.trim() : "",
            taskDescription: taskDescriptionInput ? taskDescriptionInput.value : ""
          });
        }

        function submitSheetOnly() {
          const title = titleInput.value.trim();
          const workingDays = parseInt(daysInput.value, 10);
          if (isNaN(workingDays) || workingDays < 0) return daysInput.focus();
          const mappedSheetRowNumber = Number(mappedRowInput?.value || 0) || null;
          cleanup({
            title: title || defaultTitle,
            workingDays,
            label: labelSelect.value,
            action: "sheetOnly",
            mappedSheetRowNumber,
            lastAction: lastActionInput ? lastActionInput.value.trim() : "",
            sheetRecipientName: sheetNameInput ? sheetNameInput.value.trim() : "",
            organization: organizationInput ? organizationInput.value.trim() : "",
            taskDescription: taskDescriptionInput ? taskDescriptionInput.value : ""
          });
        }

        modal.querySelector("#gmail-followup-cancel").addEventListener("click", () => cleanup(null));
        modal.querySelector("#gmail-followup-sheet-only").addEventListener("click", submitSheetOnly);
        modal.querySelector("#gmail-followup-create-task-only").addEventListener("click", submitCreateTaskOnly);
        modal.querySelector("#gmail-followup-create").addEventListener("click", submitCreateTask);
        document.addEventListener("keydown", onKeyDown, true);

        setTimeout(() => {
          titleInput.focus();
          titleInput.select();
        }, 0);
      })().catch((err) => {
        console.error("showTaskModal failed:", err);
        resolve(null);
      });
    });
  }

  const api = {
    showTaskModal,
    addWorkingDays,
    buildDefaultTitle,
    defaultSheetRecipientName,
    buildDefaultLastAction,
    buildDefaultTaskDescription,
    formatLastActionSheetValue,
    todayISODateForLastAction,
    loadSheetRowsViaExtension,
    loadOpenTasksViaExtension,
    completeTasksViaExtension
  };

  global.GmailFollowupOutreachModal = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
