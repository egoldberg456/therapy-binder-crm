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
 * Reads B + F for all rows; for each recipient, if no row matches both email + subject, appends one row.
 * Column positions are discovered by reading the header row.
 */
async function syncOutreachSheetIfNeeded(payload) {
  const subject = normalizeSheetSubject(payload?.subject);
  const recipients = Array.isArray(payload?.recipients) ? payload.recipients : [];
  const label = String(payload?.label || "").trim();
  const sentDateISO = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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
  const COL_OUTREACH_1_DATE = findCol("Outreach 1 Date of Send");

  const missing = [];
  if (COL_NAME == null) missing.push("Name");
  if (COL_RECIPIENT == null) missing.push("Email Address Recepient");
  if (COL_SUBJECT == null) missing.push("Subject Line");
  if (missing.length) {
    throw new Error(`Sheets header missing required column(s): ${missing.join(", ")}`);
  }

  function rowMatches(emailNorm, subjNorm) {
    return dataRows.some((row) => {
      const rowEmail = normalizeSheetEmail(row[COL_RECIPIENT]);
      const rowSubject = normalizeSheetSubject(row[COL_SUBJECT]);
      return rowEmail === emailNorm && rowSubject === subjNorm;
    });
  }

  const rowsToAppend = [];
  // Only append ONE row per send: the first "To" recipient passed from the content script.
  const first = recipients[0];
  const emailNorm = normalizeSheetEmail(first?.email);
  if (emailNorm && !rowMatches(emailNorm, subject)) {
    const displayName = String(first?.name || "").trim();
    const newRow = Array.from({ length: Math.max(1, headerRow.length) }, () => "");
    newRow[COL_NAME] = displayName;
    if (COL_SENT_FROM != null) newRow[COL_SENT_FROM] = senderEmail;
    newRow[COL_RECIPIENT] = emailNorm;
    newRow[COL_SUBJECT] = subject;
    if (COL_LABEL != null) newRow[COL_LABEL] = label;
    if (COL_OUTREACH_1_DATE != null) newRow[COL_OUTREACH_1_DATE] = sentDateISO;

    rowsToAppend.push(newRow);
    dataRows.push(newRow);
  }

  if (rowsToAppend.length === 0) {
    return { ok: true, appended: 0, message: "all recipients already in sheet for this subject" };
  }

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