/** Outreach tracker sheet (columns A–F: Name, Email, Organization, Next Step, Label, Subject). */
const OUTREACH_SPREADSHEET_ID = "1O_I2Qf9Gi6TSIi9Rb22JikNAed9N4DcqvlqCteUzPI0";
const OUTREACH_VALUE_RANGE = "A:F";

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
 * Columns: A Name, B Email, C Organization (empty), D–E empty, F Subject.
 */
async function syncOutreachSheetIfNeeded(payload) {
  const subject = normalizeSheetSubject(payload?.subject);
  const recipients = Array.isArray(payload?.recipients) ? payload.recipients : [];

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
  const dataRows = values.slice(1);

  function rowMatches(emailNorm, subjNorm) {
    return dataRows.some((row) => {
      const rowEmail = normalizeSheetEmail(row[1]);
      const rowSubject = normalizeSheetSubject(row[5]);
      return rowEmail === emailNorm && rowSubject === subjNorm;
    });
  }

  const rowsToAppend = [];
  for (const r of recipients) {
    const emailNorm = normalizeSheetEmail(r?.email);
    if (!emailNorm) continue;
    if (rowMatches(emailNorm, subject)) continue;
    const displayName = String(r?.name || "").trim();
    rowsToAppend.push([displayName, emailNorm, "", "", "", subject]);
    dataRows.push([displayName, emailNorm, "", "", "", subject]);
  }

  if (rowsToAppend.length === 0) {
    return { ok: true, appended: 0, message: "all recipients already in sheet for this subject" };
  }

  const appendUrl = `${base}/${rangePath}/append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const appendRes = await fetch(withGoogleAccessToken(appendUrl, token), {
    method: "POST",
    body: JSON.stringify({ majorDimension: "ROWS", values: rowsToAppend })
  });

  if (!appendRes.ok) {
    const text = await appendRes.text();
    throw new Error(`Sheets append — ${describeGoogleApiError(appendRes.status, text)}`);
  }

  const appendBody = await appendRes.json();
  return { ok: true, appended: rowsToAppend.length, updates: appendBody };
}