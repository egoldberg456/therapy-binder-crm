/** Outreach tracker sheet sync (header-driven; columns discovered at runtime). */
const OUTREACH_SPREADSHEET_ID = "1O_I2Qf9Gi6TSIi9Rb22JikNAed9N4DcqvlqCteUzPI0";

/** Set to false to silence verbose task-routing logs (service worker console / chrome://extensions → Inspect views). */
const DEBUG_TASKS_ROUTING = true;

function tasksLog(...args) {
  if (!DEBUG_TASKS_ROUTING) return;
  console.log("[GmailFollowup:Tasks]", ...args);
}

function tasksWarn(...args) {
  if (!DEBUG_TASKS_ROUTING) return;
  console.warn("[GmailFollowup:Tasks]", ...args);
}
// We discover column positions from the header row, so we read a wide range.
const OUTREACH_VALUE_RANGE = "A:ZZ";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_OUTREACH_SHEET_ROWS") {
    (async () => {
      const result = await getOutreachSheetRows();
      sendResponse({ ok: true, result });
    })().catch((error) => {
      console.error("GET_OUTREACH_SHEET_ROWS failed:", error);
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }

  if (message.type === "CREATE_TASK") {
    (async () => {
      tasksLog("CREATE_TASK message received", {
        hasPayload: !!message.payload,
        payloadSenderEmail: message.payload?.senderEmail ?? "(missing)",
        payloadSenderEmailNorm: normalizeSheetEmail(message.payload?.senderEmail) || "(empty)",
        subjectPreview: String(message.payload?.subject || "").slice(0, 80)
      });
      const task = await createGoogleTask(message.payload);
      let sheetSync = null;
      try {
        sheetSync = await syncOutreachSheetIfNeeded(message.payload);
      } catch (e) {
        console.error("Outreach sheet sync failed:", e);
        sheetSync = { ok: false, error: String(e) };
      }
      sendResponse({ ok: true, result: task, sheetSync });
    })().catch((error) => {
      console.error("CREATE_TASK failed:", error);
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }

  if (message.type === "SYNC_SHEET") {
    (async () => {
      let sheetSync;
      try {
        sheetSync = await syncOutreachSheetIfNeeded(message.payload);
      } catch (e) {
        console.error("SYNC_SHEET failed:", e);
        sendResponse({ ok: false, error: String(e), sheetSync: { ok: false, error: String(e) } });
        return;
      }
      sendResponse({ ok: true, sheetSync });
    })().catch((error) => {
      console.error("SYNC_SHEET failed:", error);
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }

  if (message.type === "GET_OPEN_GOOGLE_TASKS") {
    (async () => {
      const tasks = await listOpenGoogleTasks();
      sendResponse({ ok: true, tasks });
    })().catch((error) => {
      console.error("GET_OPEN_GOOGLE_TASKS failed:", error);
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }

  if (message.type === "COMPLETE_GOOGLE_TASKS") {
    (async () => {
      const ids = Array.isArray(message.taskIds) ? message.taskIds : [];
      const result = await completeGoogleTasks(ids);
      sendResponse({ ok: true, result });
    })().catch((error) => {
      console.error("COMPLETE_GOOGLE_TASKS failed:", error);
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
});

/**
 * @param {boolean} interactive
 * @param {{ tasksDebug?: boolean }} [opts] — set tasksDebug true from task APIs to log token acquisition (avoids noise from Sheets).
 */
async function getToken(interactive = true, opts = {}) {
  const tokenResult = await chrome.identity.getAuthToken({ interactive });
  const token = typeof tokenResult === "string" ? tokenResult : tokenResult.token;
  if (opts.tasksDebug) {
    tasksLog("getAuthToken", {
      interactive,
      ok: !!token,
      tokenLength: token ? String(token).length : 0
    });
  }
  return token;
}

async function getSenderEmailBestEffort() {
  try {
    const info = await chrome.identity.getProfileUserInfo();
    const email = String(info?.email || "").trim().toLowerCase();
    tasksLog("getProfileUserInfo (Chrome profile — may differ from Gmail “From”)", {
      email: email || "(empty — add identity.email permission or sign into Chrome with Google)",
      id: info?.id ? `${String(info.id).slice(0, 6)}…` : "(empty)",
      rawEmailLength: String(info?.email || "").length
    });
    return email;
  } catch (e) {
    tasksWarn("getProfileUserInfo threw", e);
    return "";
  }
}

/** When signed in as this account, new tasks and task list UI use this named Google Task list. */
const OUTREACH_TASKS_USER_EMAIL = "egoldberg456@gmail.com";
const OUTREACH_TASKS_LIST_TITLE = "Therapy Binder Customer Outreach";

/** @type {{ email: string, listId: string } | null} */
let cachedTasksListResolution = null;

function tasksCollectionUrl(listId) {
  const segment = listId === "@default" ? "@default" : encodeURIComponent(listId);
  return `https://tasks.googleapis.com/tasks/v1/lists/${segment}/tasks`;
}

/**
 * Default list for everyone; for OUTREACH_TASKS_USER_EMAIL, the list titled OUTREACH_TASKS_LIST_TITLE if it exists.
 * @param {string} [hintSenderFromPayload] — Gmail compose “from” (for logs; routing still uses Chrome profile email today).
 * @param {string} [operation] — e.g. "create" | "listOpen" | "complete"
 */
async function resolveTasksListId(token, hintSenderFromPayload, operation = "resolve") {
  const profileEmail = normalizeSheetEmail(await getSenderEmailBestEffort());
  const hintNorm = normalizeSheetEmail(hintSenderFromPayload);
  const targetNorm = normalizeSheetEmail(OUTREACH_TASKS_USER_EMAIL);

  tasksLog(`resolveTasksListId start [${operation}]`, {
    OUTREACH_TASKS_USER_EMAIL,
    OUTREACH_TASKS_LIST_TITLE,
    profileEmail: profileEmail || "(empty)",
    hintSenderFromPayload: hintNorm || "(none)",
    profileMatchesTarget: profileEmail === targetNorm,
    hintMatchesTarget: hintNorm === targetNorm,
    note:
      "Task list routing uses profileEmail only. If profile is empty/wrong but hint matches, add identity.email or align Chrome sign-in."
  });

  const email = profileEmail;
  if (email !== OUTREACH_TASKS_USER_EMAIL) {
    tasksLog(`resolveTasksListId → @default [${operation}]`, {
      reason: "profile email !== OUTREACH_TASKS_USER_EMAIL",
      profileEmail: email || "(empty)",
      expected: OUTREACH_TASKS_USER_EMAIL
    });
    return "@default";
  }
  if (cachedTasksListResolution?.email === email) {
    tasksLog(`resolveTasksListId cache hit [${operation}]`, {
      email,
      listId: cachedTasksListResolution.listId
    });
    return cachedTasksListResolution.listId;
  }

  tasksLog(`resolveTasksListId fetching task lists from API [${operation}]`);

  let pageToken = "";
  let foundId = null;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);

    const listUrl = `https://tasks.googleapis.com/tasks/v1/users/@me/lists?${params}`;
    tasksLog(`task lists page ${page}`, { listUrl: listUrl.split("?")[0], hasPageToken: !!pageToken });

    const res = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      const text = await res.text();
      tasksWarn("task lists fetch failed", { status: res.status, bodyPreview: text.slice(0, 500) });
      throw new Error(`Tasks list discovery error ${res.status}: ${text}`);
    }

    const body = await res.json();
    const items = Array.isArray(body.items) ? body.items : [];
    const titles = items.map((l) => ({
      id: l.id,
      title: String(l.title || ""),
      titleLen: String(l.title || "").length
    }));
    tasksLog(`task lists page ${page} response`, {
      itemCount: items.length,
      hasNextPageToken: !!body.nextPageToken,
      titles
    });

    const match = items.find((l) => String(l.title || "").trim() === OUTREACH_TASKS_LIST_TITLE);
    if (match?.id) {
      foundId = match.id;
      tasksLog("matched OUTREACH task list by exact title", {
        id: foundId,
        title: match.title
      });
      break;
    }

    const nearMisses = items.filter((l) =>
      String(l.title || "")
        .toLowerCase()
        .includes(OUTREACH_TASKS_LIST_TITLE.toLowerCase().slice(0, 12))
    );
    if (nearMisses.length) {
      tasksLog("possible title near-misses (substring match on first 12 chars of target title)", nearMisses);
    }

    pageToken = body.nextPageToken || "";
    if (!pageToken) break;
  }

  const listId = foundId || "@default";
  if (!foundId) {
    tasksWarn(
      `List "${OUTREACH_TASKS_LIST_TITLE}" not found for ${OUTREACH_TASKS_USER_EMAIL}; using default list.`,
      { searchedPages: "see prior logs", finalListId: listId }
    );
  } else {
    tasksLog("resolveTasksListId resolved named list", { listId, title: OUTREACH_TASKS_LIST_TITLE });
  }
  cachedTasksListResolution = { email, listId };
  return listId;
}

async function createGoogleTask(payload) {
  const { title, dueISO, notes, senderEmail: payloadSender } = payload || {};
  const token = await getToken(true, { tasksDebug: true });
  const listId = await resolveTasksListId(token, payloadSender, "create");
  const insertUrl = tasksCollectionUrl(listId);

  const body = {
    title: title || "Follow up",
    due: dueISO,
    notes: notes || ""
  };

  tasksLog("createGoogleTask POST", {
    insertUrl,
    listId,
    bodyTitle: body.title,
    bodyDue: body.due,
    notesLength: String(body.notes || "").length
  });

  const res = await fetch(insertUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    tasksWarn("createGoogleTask failed", { status: res.status, bodyPreview: text.slice(0, 800) });
    throw new Error(`Tasks API error ${res.status}: ${text}`);
  }

  const created = await res.json();
  tasksLog("createGoogleTask success", {
    taskId: created?.id,
    taskListFromResponse: created?.parent || "(not in response)",
    title: created?.title
  });
  return created;
}

async function listOpenGoogleTasks() {
  const token = await getToken(true, { tasksDebug: true });
  const listId = await resolveTasksListId(token, undefined, "listOpen");
  const tasksListUrl = tasksCollectionUrl(listId);
  tasksLog("listOpenGoogleTasks", { listId, tasksListUrl });
  const collected = [];
  let pageToken = "";

  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({
      showCompleted: "false",
      showHidden: "false",
      maxResults: "100"
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`${tasksListUrl}?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      const text = await res.text();
      tasksWarn("listOpenGoogleTasks page fetch failed", {
        listId,
        status: res.status,
        bodyPreview: text.slice(0, 500)
      });
      throw new Error(`Tasks list error ${res.status}: ${text}`);
    }

    const body = await res.json();
    const items = Array.isArray(body.items) ? body.items : [];
    tasksLog(`listOpenGoogleTasks page ${page}`, { rawItemCount: items.length });
    for (const t of items) {
      if (t.status === "needsAction") {
        collected.push({
          id: t.id,
          title: t.title || "",
          notes: t.notes || "",
          due: t.due || null
        });
      }
    }

    pageToken = body.nextPageToken || "";
    if (!pageToken) break;
  }

  tasksLog("listOpenGoogleTasks done", { listId, needsActionCount: collected.length });
  return collected;
}

async function completeGoogleTasks(taskIds) {
  const unique = [...new Set(taskIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (unique.length === 0) return { completed: 0, failed: [] };

  const token = await getToken(true, { tasksDebug: true });
  const listId = await resolveTasksListId(token, undefined, "complete");
  const tasksListUrl = tasksCollectionUrl(listId);
  tasksLog("completeGoogleTasks", { listId, taskIdCount: unique.length, sampleIds: unique.slice(0, 3) });
  const failed = [];

  for (const id of unique) {
    const url = `${tasksListUrl}/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ status: "completed" })
    });

    if (!res.ok) {
      const text = await res.text();
      tasksWarn("completeGoogleTasks PATCH failed", {
        id,
        status: res.status,
        bodyPreview: text.slice(0, 300)
      });
      failed.push({ id, error: `HTTP ${res.status}: ${text}` });
    }
  }

  const result = { completed: unique.length - failed.length, failed };
  tasksLog("completeGoogleTasks done", result);
  return result;
}

function normalizeSheetEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeSheetSubject(value) {
  return String(value || "").trim();
}

/** Last Action cell: one leading date (sync day); strip modal's YYYY-MM-DD — prefix to avoid doubling. */
function formatLastActionSheetValue(sentDateISO, note) {
  const raw = String(note ?? "").trim();
  if (!raw) return sentDateISO;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return sentDateISO;
  const withoutLeading = raw.replace(/^\d{4}-\d{2}-\d{2}\s*(?:—|-)\s*/, "").trim();
  if (!withoutLeading) return sentDateISO;
  return `${sentDateISO} — ${withoutLeading}`;
}

/** YYYY-MM-DD in local time (today on the sender's machine). */
function todayLocalISODate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD in local time (matches the task due shown in Google Tasks after setHours). */
function calendarDateFromDueISO(dueISO) {
  if (!dueISO || typeof dueISO !== "string") return null;
  const d = new Date(dueISO);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Sheets calls use access_token in the URL (no Authorization header, no application/json on POST).
 * That keeps requests "simple" so they are not blocked by CORS when the environment mis-treats them.
 * @see https://cloud.google.com/docs/authentication/rest
 */
function withGoogleAccessToken(url, token) {
  const joiner = url.includes("?") ? "&" : "?";
  return `${url}${joiner}access_token=${encodeURIComponent(token)}`;
}

/** Pull a readable message from Google API JSON error bodies. */
function describeGoogleApiError(status, bodyText) {
  try {
    const j = JSON.parse(bodyText);
    const msg =
      j.error?.message ||
      (Array.isArray(j.error?.errors) && j.error.errors.map((e) => e.message || e.reason).join("; "));
    if (msg) return `HTTP ${status}: ${msg}`;
  } catch (_) {
    /* ignore */
  }
  return `HTTP ${status}: ${bodyText || "(empty body)"}`;
}

function normalizeHeaderCell(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findHeaderIndex(headerRow, headerName) {
  const target = normalizeHeaderCell(headerName);
  const idx = headerRow.findIndex((h) => normalizeHeaderCell(h) === target);
  return idx >= 0 ? idx : null;
}

async function getOutreachSheetRows() {
  const token = await getToken(true);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${OUTREACH_SPREADSHEET_ID}/values`;
  const rangePath = encodeURIComponent(OUTREACH_VALUE_RANGE);

  const readRes = await fetch(withGoogleAccessToken(`${base}/${rangePath}`, token));
  if (!readRes.ok) {
    const text = await readRes.text();
    throw new Error(`Sheets read — ${describeGoogleApiError(readRes.status, text)}`);
  }

  const { values = [] } = await readRes.json();
  const headerRow = Array.isArray(values[0]) ? values[0] : [];
  const dataRows = values.slice(1);

  const COL_NAME = findHeaderIndex(headerRow, "Name");
  const COL_ORGANIZATION = findHeaderIndex(headerRow, "Organization");
  const COL_RECIPIENT =
    findHeaderIndex(headerRow, "Email Address Recepient") ??
    findHeaderIndex(headerRow, "Email Address Recipient") ??
    findHeaderIndex(headerRow, "Sending Email Address");
  const COL_SUBJECT = findHeaderIndex(headerRow, "Subject Line");

  if (COL_NAME == null || COL_RECIPIENT == null || COL_SUBJECT == null) {
    return {
      headerRow,
      rows: [],
      missingHeaders: [
        COL_NAME == null ? "Name" : null,
        COL_RECIPIENT == null ? "Email Address Recepient" : null,
        COL_SUBJECT == null ? "Subject Line" : null
      ].filter(Boolean)
    };
  }

  const rows = dataRows.map((row, i) => {
    const sheetRowNumber = 2 + i;
    return {
      sheetRowNumber,
      name: String(row[COL_NAME] ?? "").trim(),
      organization:
        COL_ORGANIZATION != null ? String(row[COL_ORGANIZATION] ?? "").trim() : "",
      recipientEmail: normalizeSheetEmail(row[COL_RECIPIENT]),
      subject: String(row[COL_SUBJECT] ?? "").trim(),
      raw: row
    };
  });

  return { headerRow, rows, missingHeaders: [] };
}

/**
 * Matches rows by recipient email + subject.
 * New row: sole outreach date column gets next date; if multiple applicable columns exist, Outreach 1 = send day.
 * Outreach sequence numbers 2 and 3 are excluded from slot-finding and writes.
 * Optional "Last Action" column (falls back to legacy "Next Steps" header): formatted via
 * formatLastActionSheetValue (modal default includes date; sync replaces it with the send day).
 * Existing row: first empty applicable "Outreach N Date of Send" = task follow-up date from payload (dueISO)
 * when present, else send day; Last Action is
 * always overwritten when that column exists (including mapped rows and full outreach columns).
 * A valid "map to row" selection uses that row even when the primary To email is missing, so Last Action and
 * other cell updates still apply to the chosen row. When the recipient email cell is empty, it is filled from
 * the sent message's To address (same normalization as new-row appends).
 */
async function syncOutreachSheetIfNeeded(payload) {
  const subject = normalizeSheetSubject(payload?.subject);
  const recipients = Array.isArray(payload?.recipients) ? payload.recipients : [];
  const label = String(payload?.label || "").trim();
  const sentDateISO = todayLocalISODate(); // YYYY-MM-DD (local calendar day)
  const senderEmail =
    normalizeSheetEmail(payload?.senderEmail) || (await getSenderEmailBestEffort());
  const mappedSheetRowNumber = Number(payload?.mappedSheetRowNumber || 0);

  if (!subject || recipients.length === 0) {
    return { ok: true, skipped: true, reason: "missing subject or recipients" };
  }

  const token = await getToken(true);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${OUTREACH_SPREADSHEET_ID}/values`;
  const rangePath = encodeURIComponent(OUTREACH_VALUE_RANGE);

  const readRes = await fetch(withGoogleAccessToken(`${base}/${rangePath}`, token));

  if (!readRes.ok) {
    const text = await readRes.text();
    throw new Error(`Sheets read — ${describeGoogleApiError(readRes.status, text)}`);
  }

  const { values = [] } = await readRes.json();

  const headerRow = Array.isArray(values[0]) ? values[0] : [];
  const dataRows = values.slice(1);

  function findCol(headerName) {
    return findHeaderIndex(headerRow, headerName);
  }

  /** Columns named "Outreach N Date of Send" (any N), sorted by N. */
  function findOutreachDateColumns() {
    const re = /^outreach #?(\d+) date of send$/;
    const cols = [];
    headerRow.forEach((h, idx) => {
      const m = normalizeHeaderCell(h).match(re);
      if (m) cols.push({ n: parseInt(m[1], 10), idx });
    });
    cols.sort((a, b) => a.n - b.n);
    return cols;
  }

  function columnIndexToA1(colIndex) {
    let n = colIndex;
    let s = "";
    while (n >= 0) {
      s = String.fromCharCode((n % 26) + 65) + s;
      n = Math.floor(n / 26) - 1;
    }
    return s;
  }

  const COL_NAME = findCol("Name");
  const COL_SENT_FROM = findCol("Email Address Sent From");
  // Sheet header has a typo in the user's example ("Recepient"). Support both spellings.
  const COL_RECIPIENT =
    findCol("Email Address Recepient") ??
    findCol("Email Address Recipient") ??
    findCol("Sending Email Address");
  // "Label" is the only label column we write to.
  const COL_LABEL = findCol("Label");
  const COL_SUBJECT = findCol("Subject Line");
  const COL_ORGANIZATION = findCol("Organization");
  const COL_LAST_ACTION = findCol("Last Action") ?? findCol("Next Steps");
  const COL_EMAIL_JSON = findCol("Email Json");
  const organization = String(payload?.organization ?? "").trim();
  const lastActionNote = String(payload?.lastAction ?? "").trim();
  const lastActionCell = formatLastActionSheetValue(sentDateISO, lastActionNote);
  let outreachDateCols = findOutreachDateColumns();
  if (outreachDateCols.length === 0) {
    const legacy = findCol("Outreach 1 Date of Send");
    if (legacy != null) outreachDateCols = [{ n: 1, idx: legacy }];
  }
  outreachDateCols = outreachDateCols.filter((c) => c.n !== 2 && c.n !== 3);

  const missing = [];
  if (COL_NAME == null) missing.push("Name");
  if (COL_RECIPIENT == null) missing.push("Email Address Recepient");
  if (COL_SUBJECT == null) missing.push("Subject Line");
  if (missing.length) {
    throw new Error(`Sheets header missing required column(s): ${missing.join(", ")}`);
  }

  function findMatchingRowIndex(emailNorm, subjNorm) {
    return dataRows.findIndex((row) => {
      const rowEmail = normalizeSheetEmail(row[COL_RECIPIENT]);
      const rowSubject = normalizeSheetSubject(row[COL_SUBJECT]);
      return rowEmail === emailNorm && rowSubject === subjNorm;
    });
  }

  /** 1-based sheet row (header = 1). When in range, this row wins over email+subject match. */
  let mappedRowDataIdx = null;
  if (mappedSheetRowNumber && Number.isFinite(mappedSheetRowNumber) && mappedSheetRowNumber >= 2) {
    const idx = mappedSheetRowNumber - 2;
    if (idx >= 0 && idx < dataRows.length) mappedRowDataIdx = idx;
  }

  // Only ONE row per send: the first "To" recipient from the content script, unless a valid mapped row is chosen.
  const first = recipients[0];
  const emailNorm = normalizeSheetEmail(first?.email);
  if (!emailNorm && mappedRowDataIdx == null) {
    return { ok: true, skipped: true, reason: "no primary recipient email" };
  }

  const matchIdx =
    mappedRowDataIdx != null ? mappedRowDataIdx : findMatchingRowIndex(emailNorm, subject);

  // Existing row: first empty applicable outreach date column = send day; always overwrite Last Action when present.
  if (matchIdx >= 0) {
    const row = dataRows[matchIdx];
    const sheetRow = 2 + matchIdx;
    const updates = [];

    if (outreachDateCols.length > 0) {
      let targetCol = null;
      for (const { idx } of outreachDateCols) {
        if (!String(row[idx] ?? "").trim()) {
          targetCol = idx;
          break;
        }
      }
      if (targetCol != null) {
        updates.push({ a1: `${columnIndexToA1(targetCol)}${sheetRow}`, value: sentDateISO });
      }
    }

    // If "Email Address Sent From" exists but is blank, backfill it for existing rows too.
    if (COL_SENT_FROM != null && senderEmail && !String(row[COL_SENT_FROM] ?? "").trim()) {
      updates.push({
        a1: `${columnIndexToA1(COL_SENT_FROM)}${sheetRow}`,
        value: senderEmail
      });
    }

    // Recipient column empty (e.g. mapped row): fill from the send's primary To address.
    if (COL_RECIPIENT != null && emailNorm && !String(row[COL_RECIPIENT] ?? "").trim()) {
      updates.push({
        a1: `${columnIndexToA1(COL_RECIPIENT)}${sheetRow}`,
        value: emailNorm
      });
    }

    if (COL_EMAIL_JSON != null && !String(row[COL_EMAIL_JSON] ?? "").trim()) {
      updates.push({
        a1: `${columnIndexToA1(COL_EMAIL_JSON)}${sheetRow}`,
        value: "[]"
      });
    }

    // Always overwrite Last Action (mapped row or auto-matched), even if all outreach slots are full.
    if (COL_LAST_ACTION != null) {
      updates.push({
        a1: `${columnIndexToA1(COL_LAST_ACTION)}${sheetRow}`,
        value: lastActionCell
      });
    }

    if (COL_ORGANIZATION != null && organization) {
      updates.push({
        a1: `${columnIndexToA1(COL_ORGANIZATION)}${sheetRow}`,
        value: organization
      });
    }

    if (updates.length === 0) {
      const allOutreachFilled =
        outreachDateCols.length > 0 &&
        outreachDateCols.every(({ idx }) => String(row[idx] ?? "").trim());
      let message = "no changes needed for existing row";
      if (outreachDateCols.length === 0 && COL_LAST_ACTION == null) {
        message = "no outreach date columns in header";
      } else if (allOutreachFilled && COL_LAST_ACTION == null) {
        message = "row exists and all outreach date columns are already filled";
      }
      return { ok: true, updated: 0, message };
    }

    const updateBodies = [];
    for (const u of updates) {
      const cellPath = encodeURIComponent(u.a1);
      const updateUrl = `${base}/${cellPath}?valueInputOption=USER_ENTERED`;
      const updateRes = await fetch(withGoogleAccessToken(updateUrl, token), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[u.value]] })
      });

      if (!updateRes.ok) {
        const text = await updateRes.text();
        throw new Error(`Sheets update — ${describeGoogleApiError(updateRes.status, text)}`);
      }

      updateBodies.push(await updateRes.json());
    }
    return {
      ok: true,
      appended: 0,
      updated: updates.length,
      updatedRange: updates.map((u) => u.a1).join(", "),
      updates: updateBodies
    };
  }

  const rowsToAppend = [];
  const fromModal = String(payload?.sheetRecipientName ?? "").trim();
  const displayName =
    fromModal || String(first?.name || "").trim() || emailNorm;
  let appendWidth = headerRow.length;
  const bumpWidth = (idx) => {
    if (idx != null) appendWidth = Math.max(appendWidth, idx + 1);
  };
  bumpWidth(COL_NAME);
  bumpWidth(COL_SENT_FROM);
  bumpWidth(COL_RECIPIENT);
  bumpWidth(COL_LABEL);
  bumpWidth(COL_SUBJECT);
  bumpWidth(COL_ORGANIZATION);
  bumpWidth(COL_LAST_ACTION);
  bumpWidth(COL_EMAIL_JSON);
  for (const { idx } of outreachDateCols) bumpWidth(idx);

  const newRow = Array.from({ length: Math.max(1, appendWidth) }, () => "");
  newRow[COL_NAME] = displayName;
  if (COL_SENT_FROM != null) newRow[COL_SENT_FROM] = senderEmail;
  newRow[COL_RECIPIENT] = emailNorm;
  newRow[COL_SUBJECT] = subject;
  if (COL_LABEL != null) newRow[COL_LABEL] = label;
  if (COL_ORGANIZATION != null) newRow[COL_ORGANIZATION] = organization;
  if (COL_LAST_ACTION != null) newRow[COL_LAST_ACTION] = lastActionCell;
  if (COL_EMAIL_JSON != null) newRow[COL_EMAIL_JSON] = "[]";

  const colOutreach1 = outreachDateCols.find((c) => c.n === 1) ?? outreachDateCols[0];
  if (colOutreach1 != null) {
    // "Date of Send" columns should always reflect the actual send day.
    newRow[colOutreach1.idx] = sentDateISO;
  }

  rowsToAppend.push(newRow);

  // Sheets API uses `:append` (colon), not `/append` (slash).
  const appendUrl = `${base}/${rangePath}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const appendRes = await fetch(withGoogleAccessToken(appendUrl, token), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ majorDimension: "ROWS", values: rowsToAppend })
  });

  if (!appendRes.ok) {
    const text = await appendRes.text();
    throw new Error(`Sheets append — ${describeGoogleApiError(appendRes.status, text)}`);
  }

  const appendBody = await appendRes.json();
  return { ok: true, appended: rowsToAppend.length, updates: appendBody };
}