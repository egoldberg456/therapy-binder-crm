/** Outreach tracker sheet sync (header-driven; columns discovered at runtime). */
const OUTREACH_SPREADSHEET_ID = "1O_I2Qf9Gi6TSIi9Rb22JikNAed9N4DcqvlqCteUzPI0";
// We discover column positions from the header row, so we read a wide range.
const OUTREACH_VALUE_RANGE = "A:ZZ";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CREATE_TASK") {
    (async () => {
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
});

async function getToken(interactive = true) {
  const tokenResult = await chrome.identity.getAuthToken({ interactive });
  return typeof tokenResult === "string" ? tokenResult : tokenResult.token;
}

async function getSenderEmailBestEffort() {
  try {
    const info = await chrome.identity.getProfileUserInfo();
    return String(info?.email || "").trim().toLowerCase();
  } catch (_) {
    return "";
  }
}

async function createGoogleTask({ title, dueISO, notes }) {
  const token = await getToken(true);

  const body = {
    title: title || "Follow up",
    due: dueISO,
    notes: notes || ""
  };

  const res = await fetch("https://tasks.googleapis.com/tasks/v1/lists/@default/tasks", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tasks API error ${res.status}: ${text}`);
  }

  return await res.json();
}

function normalizeSheetEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeSheetSubject(value) {
  return String(value || "").trim();
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

/**
 * Matches rows by recipient email + subject.
 * New row: Outreach 1 = send date (today); Outreach 2 = follow-up date from the task (modal).
 * Existing row: first empty "Outreach N Date of Send" = today (next send in sequence).
 */
async function syncOutreachSheetIfNeeded(payload) {
  const subject = normalizeSheetSubject(payload?.subject);
  const recipients = Array.isArray(payload?.recipients) ? payload.recipients : [];
  const label = String(payload?.label || "").trim();
  const sentDateISO = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const followUpDate = calendarDateFromDueISO(payload?.dueISO);
  const senderEmail =
    normalizeSheetEmail(payload?.senderEmail) || (await getSenderEmailBestEffort());

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

  function normalizeHeaderCell(v) {
    return String(v || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function findCol(headerName) {
    const target = normalizeHeaderCell(headerName);
    const idx = headerRow.findIndex((h) => normalizeHeaderCell(h) === target);
    return idx >= 0 ? idx : null;
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
  let outreachDateCols = findOutreachDateColumns();
  if (outreachDateCols.length === 0) {
    const legacy = findCol("Outreach 1 Date of Send");
    if (legacy != null) outreachDateCols = [{ n: 1, idx: legacy }];
  }
  const o2Header = findCol("Outreach 2 Date of Send");
  if (o2Header != null && !outreachDateCols.some((c) => c.idx === o2Header)) {
    outreachDateCols.push({ n: 2, idx: o2Header });
    outreachDateCols.sort((a, b) => a.n - b.n);
  }

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

  // Only ONE row per send: the first "To" recipient passed from the content script.
  const first = recipients[0];
  const emailNorm = normalizeSheetEmail(first?.email);
  if (!emailNorm) {
    return { ok: true, skipped: true, reason: "no primary recipient email" };
  }

  const matchIdx = findMatchingRowIndex(emailNorm, subject);

  // Existing row: set today's date on the first empty "Outreach N Date of Send" column.
  if (matchIdx >= 0) {
    if (outreachDateCols.length === 0) {
      return { ok: true, updated: 0, message: "no outreach date columns in header" };
    }
    const row = dataRows[matchIdx];
    let targetCol = null;
    for (const { idx } of outreachDateCols) {
      if (!String(row[idx] ?? "").trim()) {
        targetCol = idx;
        break;
      }
    }
    if (targetCol == null) {
      return {
        ok: true,
        updated: 0,
        message: "row exists and all outreach date columns are already filled"
      };
    }

    const sheetRow = 2 + matchIdx;
    const updates = [];

    // Always update the next outreach date cell.
    updates.push({ a1: `${columnIndexToA1(targetCol)}${sheetRow}`, value: sentDateISO });

    // If "Email Address Sent From" exists but is blank, backfill it for existing rows too.
    if (COL_SENT_FROM != null && senderEmail && !String(row[COL_SENT_FROM] ?? "").trim()) {
      updates.push({
        a1: `${columnIndexToA1(COL_SENT_FROM)}${sheetRow}`,
        value: senderEmail
      });
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
  const displayName = String(first?.name || "").trim();
  let appendWidth = headerRow.length;
  const bumpWidth = (idx) => {
    if (idx != null) appendWidth = Math.max(appendWidth, idx + 1);
  };
  bumpWidth(COL_NAME);
  bumpWidth(COL_SENT_FROM);
  bumpWidth(COL_RECIPIENT);
  bumpWidth(COL_LABEL);
  bumpWidth(COL_SUBJECT);
  for (const { idx } of outreachDateCols) bumpWidth(idx);

  const newRow = Array.from({ length: Math.max(1, appendWidth) }, () => "");
  newRow[COL_NAME] = displayName;
  if (COL_SENT_FROM != null) newRow[COL_SENT_FROM] = senderEmail;
  newRow[COL_RECIPIENT] = emailNorm;
  newRow[COL_SUBJECT] = subject;
  if (COL_LABEL != null) newRow[COL_LABEL] = label;

  const colOutreach1 = outreachDateCols.find((c) => c.n === 1) ?? outreachDateCols[0];
  if (colOutreach1 != null) newRow[colOutreach1.idx] = sentDateISO;
  const colOutreach2 = outreachDateCols.find((c) => c.n === 2);
  if (
    colOutreach2 != null &&
    followUpDate &&
    colOutreach2.idx !== colOutreach1?.idx
  ) {
    newRow[colOutreach2.idx] = followUpDate;
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