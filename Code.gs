const SPREADSHEET_ID = '1O_I2Qf9Gi6TSIi9Rb22JikNAed9N4DcqvlqCteUzPI0';
const SHEET_NAME = 'Sheet1';

/**
 * Verbose tracing for Executions / Cloud logs. Set false in production if desired.
 * Only console.* here: pairing Logger.log with console.log often duplicates each line in Cloud logging (Debug + Info).
 */
const CRM_VERBOSE_LOGGING = true;

/** Cap per-line JSON to keep logs readable and under platform limits. */
const CRM_LOG_MAX_JSON = 8000;

/** How far back to scan Google Calendar when matching attendee email (days). */
const CRM_CALENDAR_LOOKBACK_DAYS = 730;

/** Include upcoming events this far ahead when building the meeting list (days). */
const CRM_CALENDAR_LOOKAHEAD_DAYS = 365;

function crmLog_(message, data) {
  if (!CRM_VERBOSE_LOGGING) return;
  var line = '[CRM] ' + message;
  if (data !== undefined && data !== null) {
    try {
      var serialized =
        typeof data === 'string' ? data : JSON.stringify(data);
      if (serialized.length > CRM_LOG_MAX_JSON) {
        serialized = serialized.substring(0, CRM_LOG_MAX_JSON) + '...(truncated)';
      }
      line += ' | ' + serialized;
    } catch (ignore) {
      line += ' | [unserializable]';
    }
  }
  console.log(line);
}

function crmLogError_(where, err) {
  var msg = err && err.message ? err.message : String(err);
  var stack = err && err.stack ? String(err.stack) : '';
  console.error('[CRM ERROR] ' + where + ': ' + msg + (stack ? '\n' + stack : ''));
}

function safeJsonLength_(value) {
  try {
    return JSON.stringify(value).length;
  } catch (e) {
    return -1;
  }
}

function summarizeDetailPayload_(payload) {
  if (!payload || typeof payload !== 'object') {
    return { summary: 'non-object' };
  }
  var data = payload.data;
  var timeline = data && data._emailTimeline;
  return {
    type: payload.type,
    dataKeys: data && typeof data === 'object' ? Object.keys(data).length : 0,
    emailTimelineItems: Array.isArray(timeline) ? timeline.length : 0,
    approxSerializeChars: safeJsonLength_(payload)
  };
}

function testGetResultDetails() {
  const result = getResultDetails('spreadsheet', '2');
  Logger.log(JSON.stringify(result));
}

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('CRM Search')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function uniqueSortedNonEmpty_(flatValues) {
  const set = new Set();
  flatValues.forEach(function (v) {
    const s = String(v || '').trim();
    if (s) set.add(s);
  });
  return Array.from(set).sort(function (a, b) {
    return a.localeCompare(b);
  });
}

/**
 * Reads header row plus one column of display values (for filter dropdowns).
 * Avoids loading the full sheet on initial page load.
 */
function getInitialData() {
  const sheet = getSheet_();
  const dr = sheet.getDataRange();
  const numCols = dr.getNumColumns();
  const lastRow = dr.getLastRow();

  let headers = [];
  if (numCols >= 1) {
    headers = sheet
      .getRange(1, 1, 1, numCols)
      .getDisplayValues()[0]
      .map(function (h) {
        return String(h || '').trim();
      });
  }

  let labelOptions = [];
  let organizationOptions = [];
  if (lastRow >= 2 && numCols >= 1) {
    const labelIdx = headers.indexOf('Label');
    const orgIdx = headers.indexOf('Organization');
    if (labelIdx >= 0) {
      const c = labelIdx + 1;
      const vals = sheet.getRange(2, c, lastRow, c).getDisplayValues();
      labelOptions = uniqueSortedNonEmpty_(vals.map(function (r) {
        return r[0];
      }));
    }
    if (orgIdx >= 0) {
      const c = orgIdx + 1;
      const vals = sheet.getRange(2, c, lastRow, c).getDisplayValues();
      organizationOptions = uniqueSortedNonEmpty_(vals.map(function (r) {
        return r[0];
      }));
    }
  }

  return {
    headers: headers,
    labelOptions: labelOptions,
    organizationOptions: organizationOptions,
    tasksEnabled: isTasksServiceAvailable_()
  };
}

/** Spreadsheet portion of search (for parallel client calls). */
function searchSpreadsheetForClient(filters) {
  crmLog_('searchSpreadsheetForClient start', filters);
  const rowResults = searchSpreadsheetRows_(filters);
  crmLog_('searchSpreadsheetForClient done', { spreadsheetRows: rowResults.length });
  return { spreadsheetResults: rowResults };
}

/** Google Tasks portion of search (for parallel client calls). */
function searchTasksForClient(filters) {
  crmLog_('searchTasksForClient start', filters);
  let taskResults = [];
  let taskWarning = '';

  if (isTasksServiceAvailable_()) {
    try {
      taskResults = searchOpenTasks_(filters);
    } catch (err) {
      taskWarning = 'Google Tasks search is unavailable right now: ' + err.message;
      crmLogError_('searchTasksForClient', err);
    }
  } else {
    taskWarning = 'Google Tasks API is not enabled in this Apps Script project.';
  }

  crmLog_('searchTasksForClient done', {
    tasks: taskResults.length,
    taskWarning: taskWarning || null
  });

  return { taskResults: taskResults, taskWarning: taskWarning };
}

function searchAll(filters) {
  crmLog_('searchAll start', filters);
  const sheetPart = searchSpreadsheetForClient(filters);
  const tasksPart = searchTasksForClient(filters);
  const rowResults = sheetPart.spreadsheetResults || [];
  const taskResults = tasksPart.taskResults || [];
  const taskWarning = tasksPart.taskWarning || '';

  crmLog_('searchAll done', {
    spreadsheetRows: rowResults.length,
    tasks: taskResults.length,
    taskWarning: taskWarning || null
  });

  return {
    spreadsheetResults: rowResults,
    taskResults: taskResults,
    totalCount: rowResults.length + taskResults.length,
    taskWarning: taskWarning
  };
}

function getResultDetails(type, id) {
  crmLog_('getResultDetails start', { type: type, id: String(id) });

  try {
    if (type === 'spreadsheet') {
      const t0 = Date.now();
      const data = getSpreadsheetRowDetails_(id);
      crmLog_('getSpreadsheetRowDetails_ elapsedMs', Date.now() - t0);

      const out = {
        type: 'spreadsheet',
        data: data || {}
      };
      crmLog_('getResultDetails ok', summarizeDetailPayload_(out));
      return out;
    }

    if (type === 'task') {
      if (!isTasksServiceAvailable_()) {
        throw new Error('Google Tasks API is not enabled in this Apps Script project.');
      }

      const t0 = Date.now();
      const data = getTaskDetails_(id);
      crmLog_('getTaskDetails_ elapsedMs', Date.now() - t0);

      const out = {
        type: 'task',
        data: data || {}
      };
      crmLog_('getResultDetails ok', summarizeDetailPayload_(out));
      return out;
    }

    throw new Error('Unknown result type: ' + type);
  } catch (err) {
    crmLogError_('getResultDetails', err);
    const errOut = {
      type: 'error',
      data: {
        message: err && err.message ? err.message : String(err)
      }
    };
    crmLog_('getResultDetails returning error shape', errOut);
    return errOut;
  }
}

function completeTask(compoundId) {
  if (!isTasksServiceAvailable_()) {
    throw new Error('Google Tasks API is not enabled in this Apps Script project.');
  }

  const parts = String(compoundId || '').split(':::');
  if (parts.length !== 2) throw new Error('Invalid task ID.');

  const taskListId = parts[0];
  const taskId = parts[1];

  const existingTask = Tasks.Tasks.get(taskListId, taskId);

  const updatedTask = {
    id: taskId,
    status: 'completed',
    completed: new Date().toISOString()
  };

  if (existingTask.title) updatedTask.title = existingTask.title;
  if (existingTask.notes) updatedTask.notes = existingTask.notes;
  if (existingTask.due) updatedTask.due = existingTask.due;
  if (existingTask.parent) updatedTask.parent = existingTask.parent;
  if (existingTask.position) updatedTask.position = existingTask.position;

  Tasks.Tasks.update(updatedTask, taskListId, taskId);

  return {
    success: true,
    message: 'Task marked complete.'
  };
}

function searchSpreadsheetRows_(filters) {
  const sheet = getSheet_();
  const data = getSheetData_(sheet);
  const headers = data.headers;
  const rows = data.rows;

  const nameQuery = normalize_(filters.name || '');
  const emailQuery = normalize_(filters.email || '');
  const subjectQuery = normalize_(filters.subject || '');
  const labelQuery = normalize_(filters.label || '');
  const organizationQuery = normalize_(filters.organization || '');
  const anyTextQuery = normalize_(filters.anyText || '');

  const matchingRows = rows.filter(row => {
    const searchable = buildSearchableRow_(row, headers);

    if (nameQuery) {
      const nameValue = normalize_(row['Name'] || '');
      if (!nameValue.includes(nameQuery)) return false;
    }

    if (emailQuery) {
      const emailBlob = normalize_(getEmailBlob_(row, headers));
      if (!emailBlob.includes(emailQuery)) return false;
    }

    if (subjectQuery) {
      const subjectValue = normalize_(row['Subject Line'] || '');
      if (!subjectValue.includes(subjectQuery)) return false;
    }

    if (labelQuery) {
      const labelValue = normalize_(row['Label'] || '');
      if (labelValue !== labelQuery) return false;
    }

    if (organizationQuery) {
      const orgValue = normalize_(row['Organization'] || '');
      if (orgValue !== organizationQuery) return false;
    }

    if (anyTextQuery) {
      if (!searchable.includes(anyTextQuery)) return false;
    }

    return true;
  });

  return matchingRows.map(row => {
    const lastActionDate = row['Last Action Date of Send'] || '';
    return {
      type: 'spreadsheet',
      id: String(row._rowNumber),
      rowNumber: row._rowNumber,
      title: row['Name'] || '(No name)',
      subtitle: row['Subject Line'] || '',
      meta: {
        recipient: row['Email Address Recipient'] || '',
        sender: row['Email Address Sent From'] || '',
        label: row['Label'] || '',
        organization: row['Organization'] || '',
        lastAction: row['Last Action'] || '',
        lastActionDate: lastActionDate,
        daysSinceLastAction: computeDaysSinceDate_(lastActionDate)
      }
    };
  });
}

function searchOpenTasks_(filters) {
  const searchTerms = buildTaskSearchTerms_(filters);
  if (!searchTerms.length) return [];

  const results = [];
  const taskListsResp = Tasks.Tasklists.list({ maxResults: 100 });
  const taskLists = taskListsResp.items || [];

  taskLists.forEach(taskList => {
    let pageToken;

    do {
      const resp = Tasks.Tasks.list(taskList.id, {
        showCompleted: false,
        showHidden: false,
        showDeleted: false,
        maxResults: 100,
        pageToken: pageToken
      });

      const tasks = resp.items || [];

      tasks.forEach(task => {
        if (task.status && task.status !== 'needsAction') return;

        const searchableText = normalizeTaskSearchText_([
          task.title || '',
          task.notes || '',
          taskList.title || ''
        ].join('\n'));

        const isMatch = searchTerms.every(term => searchableText.includes(term));
        if (!isMatch) return;

        results.push({
          type: 'task',
          id: `${taskList.id}:::${task.id}`,
          taskId: task.id,
          taskListId: taskList.id,
          title: task.title || '(Untitled task)',
          subtitle: task.notes ? summarizeText_(task.notes, 140) : '',
          meta: {
            taskList: taskList.title || '',
            due: task.due || '',
            updated: task.updated || '',
            status: task.status || '',
            parent: task.parent || ''
          }
        });
      });

      pageToken = resp.nextPageToken;
    } while (pageToken);
  });

  results.sort((a, b) => {
    const aUpdated = a.meta.updated || '';
    const bUpdated = b.meta.updated || '';
    return bUpdated.localeCompare(aUpdated);
  });

  return results;
}

function buildTaskSearchTerms_(filters) {
  const rawValues = [
    filters.name,
    filters.email,
    filters.subject,
    filters.label,
    filters.organization,
    filters.anyText
  ];

  return Array.from(new Set(
    rawValues
      .map(v => normalizeTaskSearchText_(v || ''))
      .filter(v => v)
  ));
}

function normalizeTaskSearchText_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function getSpreadsheetRowDetails_(rowNumber) {
  crmLog_('getSpreadsheetRowDetails_ start', { rowNumber: String(rowNumber) });

  const sheet = getSheet_();
  const found = getSingleRowData_(sheet, rowNumber);
  if (!found) {
    crmLog_('getSpreadsheetRowDetails_ row not found', String(rowNumber));
    throw new Error('Spreadsheet row not found.');
  }
  crmLog_('getSingleRowData_ loaded', { rowNumber: found._rowNumber });

  crmLog_('getSpreadsheetRowDetails_ matched', {
    _rowNumber: found._rowNumber,
    namePreview: String(found['Name'] || '').substring(0, 80)
  });

  const result = Object.assign({}, found);

  result['Email Link'] = buildLinkedCellObject_(result, 'Email Link');
  result['Click Search'] = buildLinkedCellObject_(result, 'Click Search');

  const lastActionDate = result['Last Action Date of Send'] || '';
  result['Days Since Last Action'] = computeDaysSinceDate_(lastActionDate);

  const emailJsonRaw = result['Email Json'] || '';
  result['_emailTimeline'] = buildEmailTimelineFromJson_(
    emailJsonRaw,
    result['Email Address Sent From'] || '',
    result['Email Address Recipient'] || ''
  );
  result['_emailTimelineDaysSinceLast'] =
    computeDaysSinceLastTimelineEmail_(result['_emailTimeline']);
  crmLog_('email timeline built', {
    emailJsonRawChars: String(emailJsonRaw).length,
    timelineItems: result._emailTimeline ? result._emailTimeline.length : 0,
    daysSinceLastEmail: result._emailTimelineDaysSinceLast
  });

  const taskSummary = isTasksServiceAvailable_()
    ? findBestMatchingOpenTaskForRow_(result)
    : null;

  result['Open Task Due Date'] = taskSummary ? taskSummary.dueFormatted : '';
  result['Days Until Task Due'] = taskSummary ? taskSummary.daysUntilDue : '';
  result['_openTaskSummary'] = taskSummary || null;
  crmLog_('task summary for row', {
    hasOpenTaskSummary: !!taskSummary,
    taskSummaryJsonChars: taskSummary ? safeJsonLength_(taskSummary) : 0
  });

  const attendeeEmail = pickPrimaryContactEmail_(result['Email Address Recipient'] || '');
  const calendarSummary = findCalendarMeetingsWithAttendee_(attendeeEmail);
  result['Last Calendar Meeting With Contact'] = calendarSummary.lastPastDisplay || '';
  result['Next Calendar Meeting With Contact'] = calendarSummary.nextUpcomingDisplay || '';
  if (calendarSummary.note) {
    result['Calendar Lookup Note'] = calendarSummary.note;
  }
  crmLog_('calendar summary for row', {
    attendeeEmailPreview: String(attendeeEmail).substring(0, 80),
    matchCount: calendarSummary.matchCount,
    hasNote: !!calendarSummary.note
  });

  result['Clicks'] = result['Clicks'] || result['Outreach 1 Clicks'] || '';

  delete result._links;
  delete result._formulas;
  delete result['Email Json'];

  crmLog_('getSpreadsheetRowDetails_ done', summarizeDetailPayload_({ type: 'spreadsheet', data: result }));

  return result;
}

function findBestMatchingOpenTaskForRow_(row) {
  const terms = buildRowTaskTerms_(row);
  if (!terms.length) return null;

  const taskListsResp = Tasks.Tasklists.list({ maxResults: 100 });
  const taskLists = taskListsResp.items || [];

  let best = null;

  taskLists.forEach(taskList => {
    let pageToken;

    do {
      const resp = Tasks.Tasks.list(taskList.id, {
        showCompleted: false,
        showHidden: false,
        showDeleted: false,
        maxResults: 100,
        pageToken: pageToken
      });

      const tasks = resp.items || [];

      tasks.forEach(task => {
        if (task.status && task.status !== 'needsAction') return;

        const searchableText = normalizeTaskSearchText_([
          task.title || '',
          task.notes || '',
          taskList.title || ''
        ].join('\n'));

        let score = 0;
        terms.forEach(term => {
          if (searchableText.includes(term)) score += 1;
        });

        if (score <= 0) return;

        const dueDateObj = parseSpreadsheetDate_(task.due || '');
        const updatedObj = parseSpreadsheetDate_(task.updated || '');

        const candidate = {
          taskListTitle: taskList.title || '',
          taskListId: taskList.id,
          taskId: task.id || '',
          title: task.title || '',
          due: task.due || '',
          dueFormatted: dueDateObj
            ? Utilities.formatDate(dueDateObj, Session.getScriptTimeZone(), 'M/d/yyyy, h:mm:ss a')
            : '',
          daysUntilDue: dueDateObj ? computeDaysUntilDate_(dueDateObj) : '',
          updated: task.updated || '',
          updatedObj: updatedObj,
          score: score
        };

        if (!best) {
          best = candidate;
          return;
        }

        if (candidate.score > best.score) {
          best = candidate;
          return;
        }

        if (candidate.score === best.score) {
          const bestHasDue = !!best.due;
          const candHasDue = !!candidate.due;

          if (candHasDue && !bestHasDue) {
            best = candidate;
            return;
          }

          if (candHasDue && bestHasDue) {
            const candTime = dueDateObj ? dueDateObj.getTime() : Number.MAX_SAFE_INTEGER;
            const bestTime = parseSpreadsheetDate_(best.due) ? parseSpreadsheetDate_(best.due).getTime() : Number.MAX_SAFE_INTEGER;
            if (candTime < bestTime) {
              best = candidate;
              return;
            }
          }

          const candUpdated = updatedObj ? updatedObj.getTime() : 0;
          const bestUpdated = best.updatedObj ? best.updatedObj.getTime() : 0;
          if (candUpdated > bestUpdated) {
            best = candidate;
          }
        }
      });

      pageToken = resp.nextPageToken;
    } while (pageToken);
  });

  // google.script.run must receive JSON-serializable data only; nested Date objects
  // (updatedObj) can prevent the client from receiving the payload at all.
  if (best && best.updatedObj !== undefined) {
    delete best.updatedObj;
  }

  return best;
}

function buildRowTaskTerms_(row) {
  const subjectNormalized = normalizeTaskSearchText_(stripRePrefixes_(row['Subject Line'] || ''));
  const raw = [
    row['Name'],
    row['Email Address Recipient'],
    row['Email Address Sent From'],
    subjectNormalized
  ];

  return Array.from(new Set(
    raw
      .map(v => normalizeTaskSearchText_(v || ''))
      .filter(v => v)
  ));
}

function stripRePrefixes_(subject) {
  let s = String(subject || '').trim();
  while (/^(re|fwd):\s*/i.test(s)) {
    s = s.replace(/^(re|fwd):\s*/i, '');
  }
  return s;
}

function buildLinkedCellObject_(row, headerName) {
  const text = row[headerName] || '';
  const links = row._links || {};
  const formulas = row._formulas || {};

  const richUrl = links[headerName] || '';
  const formula = formulas[headerName] || '';
  const formulaUrl = extractUrlFromHyperlinkFormula_(formula);
  const fallbackUrl = extractUrlFromText_(text);
  const url = richUrl || formulaUrl || fallbackUrl || '';

  if (!text && !url) return '';

  return {
    text: text || url,
    url: url
  };
}

function extractUrlFromHyperlinkFormula_(formula) {
  const str = String(formula || '').trim();
  if (!str) return '';
  const match = str.match(/^=HYPERLINK\(\s*"([^"]+)"/i);
  return match ? match[1] : '';
}

function buildEmailTimelineFromJson_(rawJson, ownEmail, recipientEmail) {
  const raw = String(rawJson || '').trim();
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return [{
      error: true,
      message: 'Could not parse Email Json.'
    }];
  }

  if (!Array.isArray(parsed)) return [];

  const ownEmailNorm = normalizeEmailForCompare_(ownEmail);
  const recipientEmailNorm = normalizeEmailForCompare_(recipientEmail);

  const cleaned = parsed
    .map(item => {
      const dateStr = item && item.date ? String(item.date) : '';
      const sender = item && item.sender ? String(item.sender) : '';
      const dateObj = parseSpreadsheetDate_(dateStr);
      const senderNorm = normalizeTaskSearchText_(sender);
      const senderEmail = extractEmailFromSender_(sender);
      const senderEmailNorm = normalizeEmailForCompare_(senderEmail);

      let role = 'other';
      if (ownEmailNorm && senderEmailNorm && senderEmailNorm === ownEmailNorm) {
        role = 'mine';
      } else if (recipientEmailNorm && senderEmailNorm && senderEmailNorm === recipientEmailNorm) {
        role = 'recipient';
      } else if (ownEmailNorm && senderNorm.includes(ownEmailNorm)) {
        role = 'mine';
      }

      return {
        sender: sender,
        date: dateStr,
        _dateObj: dateObj,
        role: role
      };
    })
    .filter(item => item.sender || item.date);

  cleaned.sort((a, b) => {
    const aTime = a._dateObj ? a._dateObj.getTime() : 0;
    const bTime = b._dateObj ? b._dateObj.getTime() : 0;
    return aTime - bTime;
  });

  return cleaned.map((item, index) => {
    let daysSincePrevious = '';
    let hoursSincePrevious = '';
    let sincePreviousLabel = 'First email in thread';

    if (index > 0) {
      const prev = cleaned[index - 1];
      if (item._dateObj && prev._dateObj) {
        const diffMs = item._dateObj.getTime() - prev._dateObj.getTime();
        const days = diffMs / (1000 * 60 * 60 * 24);
        const hours = diffMs / (1000 * 60 * 60);

        daysSincePrevious = roundToOneDecimal_(days);
        hoursSincePrevious = roundToOneDecimal_(hours);

        if (days >= 2) {
          sincePreviousLabel = daysSincePrevious + ' days later';
        } else {
          sincePreviousLabel = hoursSincePrevious + ' hours later';
        }
      } else {
        sincePreviousLabel = 'Time delta unavailable';
      }
    }

    return {
      sender: item.sender,
      date: item.date,
      formattedDate: item._dateObj
        ? Utilities.formatDate(item._dateObj, Session.getScriptTimeZone(), 'M/d/yyyy, h:mm:ss a')
        : item.date,
      daysSincePrevious: daysSincePrevious,
      hoursSincePrevious: hoursSincePrevious,
      sincePreviousLabel: sincePreviousLabel,
      role: item.role
    };
  });
}

function extractEmailFromSender_(sender) {
  const match = String(sender || '').match(/<([^>]+)>/);
  return match ? match[1].trim() : '';
}

function normalizeEmailForCompare_(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Picks the first plausible email from the recipient cell (handles multiple addresses).
 */
function pickPrimaryContactEmail_(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const parts = raw
    .split(/[,;\n]+/)
    .map(function (s) {
      return String(s || '').trim();
    })
    .filter(function (s) {
      return !!s;
    });

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].indexOf('@') !== -1) return parts[i];
  }

  return parts[0] || '';
}

/**
 * Scans calendars you own for events that list the given address as a guest, then
 * returns human-readable strings for the most recent past occurrence and next upcoming.
 */
function findCalendarMeetingsWithAttendee_(attendeeEmail) {
  const empty = {
    lastPastDisplay: '',
    nextUpcomingDisplay: '',
    note: '',
    matchCount: 0
  };

  const targetNorm = normalizeEmailForCompare_(attendeeEmail);
  if (!targetNorm) return empty;

  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const startSearch = new Date(now.getTime());
  startSearch.setDate(startSearch.getDate() - CRM_CALENDAR_LOOKBACK_DAYS);
  const endSearch = new Date(now.getTime());
  endSearch.setDate(endSearch.getDate() + CRM_CALENDAR_LOOKAHEAD_DAYS);

  const seenEventKeys = {};
  const matches = [];

  try {
    let calendars = [];
    try {
      calendars = CalendarApp.getAllOwnedCalendars() || [];
    } catch (ignore) {
      calendars = [];
    }

    if (!calendars.length) {
      calendars = [CalendarApp.getDefaultCalendar()];
    }

    for (let c = 0; c < calendars.length; c++) {
      const cal = calendars[c];
      let events;
      try {
        events = cal.getEvents(startSearch, endSearch);
      } catch (err) {
        crmLogError_('findCalendarMeetingsWithAttendee_ getEvents', err);
        continue;
      }

      if (!events || !events.length) continue;

      for (let e = 0; e < events.length; e++) {
        const ev = events[e];
        if (!eventHasAttendeeEmail_(ev, targetNorm)) continue;

        const calId = typeof cal.getId === 'function' ? String(cal.getId() || '') : '';
        const evId = typeof ev.getId === 'function' ? String(ev.getId() || '') : '';
        let dedupeKey = calId + '::' + evId;
        if (!dedupeKey || dedupeKey === '::') {
          dedupeKey =
            'fb:' +
            String(ev.getStartTime().getTime()) +
            '|' +
            String(ev.getTitle() || '') +
            '|' +
            String(cal.getName && cal.getName() ? cal.getName() : '');
        }
        if (seenEventKeys[dedupeKey]) continue;
        seenEventKeys[dedupeKey] = true;

        const title = ev.getTitle() ? String(ev.getTitle()) : '(No title)';
        const start = ev.getStartTime();
        const end = ev.getEndTime();
        if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) continue;

        matches.push({
          title: title,
          startMs: start.getTime(),
          endMs: end.getTime(),
          rangeLabel: formatCalendarEventRange_(start, end, tz),
          calendarName: cal.getName ? String(cal.getName() || '') : ''
        });
      }
    }
  } catch (err) {
    crmLogError_('findCalendarMeetingsWithAttendee_', err);
    return {
      lastPastDisplay: '',
      nextUpcomingDisplay: '',
      note: 'Calendar lookup failed: ' + (err && err.message ? err.message : String(err)),
      matchCount: 0
    };
  }

  if (!matches.length) {
    return {
      lastPastDisplay: '',
      nextUpcomingDisplay: '',
      note: '',
      matchCount: 0
    };
  }

  matches.sort(function (a, b) {
    return a.startMs - b.startMs;
  });

  let lastPast = null;
  let nextUpcoming = null;

  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].endMs <= now.getTime()) {
      lastPast = matches[i];
      break;
    }
  }

  for (let j = 0; j < matches.length; j++) {
    if (matches[j].startMs >= now.getTime()) {
      nextUpcoming = matches[j];
      break;
    }
  }

  const lastPastDisplay = lastPast
    ? lastPast.rangeLabel + ' — ' + lastPast.title +
      (lastPast.calendarName ? ' (' + lastPast.calendarName + ')' : '')
    : '';

  const nextUpcomingDisplay = nextUpcoming
    ? nextUpcoming.rangeLabel + ' — ' + nextUpcoming.title +
      (nextUpcoming.calendarName ? ' (' + nextUpcoming.calendarName + ')' : '')
    : '';

  return {
    lastPastDisplay: lastPastDisplay,
    nextUpcomingDisplay: nextUpcomingDisplay,
    note: '',
    matchCount: matches.length
  };
}

function eventHasAttendeeEmail_(event, normalizedTargetEmail) {
  try {
    const guests = event.getGuestList();
    if (!guests || !guests.length) return false;

    for (let i = 0; i < guests.length; i++) {
      const email = guests[i].getEmail && guests[i].getEmail();
      if (email && normalizeEmailForCompare_(email) === normalizedTargetEmail) {
        return true;
      }
    }
  } catch (ignore) {
    return false;
  }

  return false;
}

function formatCalendarEventRange_(start, end, timeZone) {
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();

  const dayFmt = 'M/d/yyyy';
  const timeFmt = 'h:mm a';

  if (sameDay) {
    return (
      Utilities.formatDate(start, timeZone, dayFmt + ', ' + timeFmt) +
      ' – ' +
      Utilities.formatDate(end, timeZone, timeFmt)
    );
  }

  return (
    Utilities.formatDate(start, timeZone, dayFmt + ', ' + timeFmt) +
    ' – ' +
    Utilities.formatDate(end, timeZone, dayFmt + ', ' + timeFmt)
  );
}

function roundToOneDecimal_(num) {
  return Math.round(num * 10) / 10;
}

function getTaskDetails_(compoundId) {
  const parts = String(compoundId || '').split(':::');
  if (parts.length !== 2) throw new Error('Invalid task ID.');

  const taskListId = parts[0];
  const taskId = parts[1];

  const task = Tasks.Tasks.get(taskListId, taskId);
  const taskList = Tasks.Tasklists.get(taskListId);

  return {
    taskListTitle: taskList.title || '',
    taskListId: taskListId,
    id: task.id || '',
    title: task.title || '',
    notes: task.notes || '',
    status: task.status || '',
    due: task.due || '',
    updated: task.updated || '',
    completed: task.completed || '',
    deleted: task.deleted || false,
    hidden: task.hidden || false,
    parent: task.parent || '',
    position: task.position || '',
    selfLink: task.selfLink || '',
    webViewLink: buildGoogleTasksLink_(taskListId)
  };
}

function buildGoogleTasksLink_(taskListId) {
  return `https://tasks.google.com/embed/list/${encodeURIComponent(taskListId)}`;
}

function isTasksServiceAvailable_() {
  try {
    return typeof Tasks !== 'undefined' &&
           Tasks &&
           Tasks.Tasklists &&
           typeof Tasks.Tasklists.list === 'function';
  } catch (e) {
    return false;
  }
}

function getSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`Sheet "${SHEET_NAME}" not found.`);
  return sheet;
}

function buildRowObject_(headers, rowArr, richRowArr, formulaRowArr, sheetRowNumber) {
  const rowObj = { _rowNumber: sheetRowNumber, _links: {}, _formulas: {} };
  headers.forEach((header, colIdx) => {
    rowObj[header] = rowArr[colIdx] || '';

    const richText = richRowArr[colIdx];
    const richLink = getRichTextLink_(richText);
    if (richLink) rowObj._links[header] = richLink;

    const formula = formulaRowArr[colIdx] || '';
    if (formula) rowObj._formulas[header] = formula;
  });
  return rowObj;
}

/**
 * Loads one sheet row (display, rich links, formulas) without scanning the whole sheet.
 * Used for the details panel only.
 */
function getSingleRowData_(sheet, rowNumber) {
  const numRow = Number(rowNumber);
  if (!numRow || numRow < 2) return null;

  const dr = sheet.getDataRange();
  const lastRow = dr.getLastRow();
  const numCols = dr.getNumColumns();
  if (numCols < 1 || numRow > lastRow) return null;

  const headers = sheet
    .getRange(1, 1, 1, numCols)
    .getDisplayValues()[0]
    .map(h => String(h).trim());
  if (!headers.length) return null;

  const rowArr = sheet.getRange(numRow, 1, numRow, numCols).getDisplayValues()[0];
  const richRowArr = sheet.getRange(numRow, 1, numRow, numCols).getRichTextValues()[0];
  const formulaRowArr = sheet.getRange(numRow, 1, numRow, numCols).getFormulas()[0];

  return buildRowObject_(headers, rowArr, richRowArr, formulaRowArr, numRow);
}

function getSheetData_(sheet) {
  const range = sheet.getDataRange();
  const values = range.getDisplayValues();
  const richTextValues = range.getRichTextValues();
  const formulas = range.getFormulas();

  if (!values || values.length < 2) {
    return { headers: [], rows: [] };
  }

  const headers = values[0].map(h => String(h).trim());
  const rows = [];

  for (let i = 1; i < values.length; i++) {
    const rowArr = values[i];
    const richRowArr = richTextValues[i] || [];
    const formulaRowArr = formulas[i] || [];
    const rowObj = buildRowObject_(headers, rowArr, richRowArr, formulaRowArr, i + 1);

    const hasAnyValue = headers.some(header => String(rowObj[header] || '').trim() !== '');
    if (hasAnyValue) rows.push(rowObj);
  }

  return { headers, rows };
}

function getRichTextLink_(richTextValue) {
  if (!richTextValue) return '';

  try {
    const directLink = richTextValue.getLinkUrl();
    if (directLink) return directLink;

    const runs = richTextValue.getRuns() || [];
    for (let i = 0; i < runs.length; i++) {
      const link = runs[i].getLinkUrl();
      if (link) return link;
    }
  } catch (e) {}

  return '';
}

function getEmailBlob_(row, headers) {
  const emailHeaders = headers.filter(h => /email/i.test(h));
  return emailHeaders.map(h => row[h] || '').join(' | ');
}

function buildSearchableRow_(row, headers) {
  return normalize_(headers.map(h => row[h] || '').join(' | '));
}

function normalize_(value) {
  return String(value || '').toLowerCase().trim();
}

function summarizeText_(text, maxLen) {
  const str = String(text || '').replace(/\s+/g, ' ').trim();
  return str.length <= maxLen ? str : str.slice(0, maxLen - 1) + '…';
}

function computeDaysSinceLastTimelineEmail_(timelineItems) {
  if (!Array.isArray(timelineItems) || !timelineItems.length) return '';
  for (let i = timelineItems.length - 1; i >= 0; i--) {
    const item = timelineItems[i];
    if (!item || item.error) continue;
    const dateStr = item.date;
    if (!String(dateStr || '').trim()) continue;
    return computeDaysSinceDate_(dateStr);
  }
  return '';
}

function computeDaysSinceDate_(value) {
  if (!value) return '';
  const parsed = parseSpreadsheetDate_(value);
  if (!parsed) return '';

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());

  const diffMs = startOfToday.getTime() - startOfDate.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function computeDaysUntilDate_(value) {
  const parsed = parseSpreadsheetDate_(value);
  if (!parsed) return '';

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());

  const diffMs = startOfDate.getTime() - startOfToday.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function parseSpreadsheetDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return value;
  }

  const str = String(value || '').trim();
  if (!str) return null;

  let d = new Date(str);
  if (!isNaN(d.getTime())) return d;

  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const month = parseInt(m[1], 10) - 1;
    const day = parseInt(m[2], 10);
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;

    d = new Date(year, month, day);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

function extractUrlFromText_(text) {
  const match = String(text || '').match(/https?:\/\/\S+/i);
  return match ? match[0] : '';
}
