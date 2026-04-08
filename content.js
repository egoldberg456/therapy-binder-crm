(function () {
  if (window.__gmailFollowupLoaded) return;
  window.__gmailFollowupLoaded = true;

  console.log("Gmail Follow-up extension loaded");

  let lastFocusedCompose = null;
  let lastTriggerAt = 0;
  let suppressSendClickUntil = 0;
  /** True from the moment we commit to the post-send flow until the modal closes (incl. cancel). Prevents a second modal while getSentEmailUrl is still waiting. */
  let outreachFlowActive = false;
  const DEBUG_SEND_PATH = true;
  let lastTabAt = 0;
  let lastEnterAt = 0;

  function debugSend(...args) {
    if (!DEBUG_SEND_PATH) return;
    console.log("[Gmail Follow-up][send-detect]", ...args);
  }

  function summarizeEl(el) {
    if (!el || el.nodeType !== 1) return { type: typeof el };
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
    return {
      tag: el.tagName?.toLowerCase?.(),
      id,
      cls,
      role: el.getAttribute?.("role") || null,
      ariaLabel: el.getAttribute?.("aria-label") || null,
      title: el.getAttribute?.("title") || null,
      tooltip: el.getAttribute?.("data-tooltip") || null
    };
  }

  function getButtonLabel(button) {
    if (!button) return "";
    return [
      button.innerText || "",
      button.getAttribute("aria-label") || "",
      button.getAttribute("data-tooltip") || "",
      button.getAttribute("title") || ""
    ]
      .join(" | ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isSendButton(button, context = {}) {
    if (!button) {
      debugSend("isSendButton=false (no button)", context);
      return false;
    }
    const label = getButtonLabel(button);
    const meta = { ...context, label, el: summarizeEl(button) };
    if (!label) {
      debugSend("isSendButton=false (empty label)", meta);
      return false;
    }
    // But never treat discard as send.
    if (/discard draft/i.test(label)) {
      debugSend("isSendButton=false (matched discard)", meta);
      return false;
    }
    const ok = /\bsend\b/i.test(label);
    debugSend(`isSendButton=${ok}`, meta);
    return ok;
  }

  function closestButtonFromNode(node) {
    const el = node && node.nodeType === 1 ? node : node?.parentElement;
    return el?.closest?.('div[role="button"], button') || null;
  }

  function findSendButtonInEvent(e) {
    debugSend("findSendButtonInEvent:start", {
      target: summarizeEl(e?.target),
      currentTarget: summarizeEl(e?.currentTarget),
      type: e?.type
    });
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    debugSend("event.composedPath length", path.length);
    for (const n of path) {
      const b = closestButtonFromNode(n);
      if (!b) continue;
      debugSend("candidate button from path", { from: summarizeEl(n), button: summarizeEl(b), label: getButtonLabel(b) });
      if (isSendButton(b, { via: "composedPath" })) {
        debugSend("findSendButtonInEvent:found via composedPath", { button: summarizeEl(b), label: getButtonLabel(b) });
        return b;
      }
    }
    const fallback = closestButtonFromNode(e.target);
    debugSend("fallback button from target.closest", { button: summarizeEl(fallback), label: getButtonLabel(fallback) });
    if (fallback && isSendButton(fallback, { via: "target.closest" })) {
      debugSend("findSendButtonInEvent:found via fallback", { button: summarizeEl(fallback), label: getButtonLabel(fallback) });
      return fallback;
    }
    debugSend("findSendButtonInEvent:none");
    return null;
  }

  function isDiscardButton(button) {
    const label = getButtonLabel(button);
    return /discard draft/i.test(label);
  }

  function findSendButtonInCompose(compose) {
    if (!compose) return null;
    const candidates = compose.querySelectorAll('div[role="button"], button');
    for (const b of candidates) {
      if (isSendButton(b, { via: "compose-scan" })) return b;
    }
    return null;
  }

  document.addEventListener(
    "focusin",
    (e) => {
      const compose = findComposeFromNode(e.target);
      if (compose) {
        lastFocusedCompose = compose;
        console.log("Focused compose detected:", compose);
      }
    },
    true
  );

  document.addEventListener(
    "click",
    function (e) {
      // If we programmatically clicked "Send" (e.g. discard→send redirect),
      // that synthetic click can re-enter this listener and double-trigger the modal.
      if (suppressSendClickUntil && Date.now() < suppressSendClickUntil) {
        const maybeSend = findSendButtonInEvent(e);
        if (maybeSend) {
          debugSend("click:suppressed (synthetic send)", {
            until: suppressSendClickUntil,
            now: Date.now(),
            button: summarizeEl(maybeSend),
            label: getButtonLabel(maybeSend)
          });
          return;
        }
      }

      const clickedButton = closestButtonFromNode(e.target);
      const clickedLabel = getButtonLabel(clickedButton);
      debugSend("click:capture", {
        cancelable: !!e.cancelable,
        defaultPrevented: !!e.defaultPrevented,
        detail: e.detail,
        clickedButton: summarizeEl(clickedButton),
        clickedLabel,
        activeElement: summarizeEl(document.activeElement),
        sinceTabMs: lastTabAt ? Date.now() - lastTabAt : null,
        sinceEnterMs: lastEnterAt ? Date.now() - lastEnterAt : null
      });

      // Gmail sometimes activates Discard when the user is keyboard-sending.
      // If Discard was keyboard-activated (detail === 0), redirect it to Send within the same compose.
      const looksKeyboardActivated = e.detail === 0;
      const looksLikeRecentTabEnter =
        lastTabAt &&
        lastEnterAt &&
        Date.now() - lastTabAt < 2000 &&
        Date.now() - lastEnterAt < 2000;

      if (clickedButton && isDiscardButton(clickedButton) && (looksKeyboardActivated || looksLikeRecentTabEnter)) {
        const compose =
          findComposeFromNode(clickedButton) ||
          findComposeFromNode(document.activeElement) ||
          lastFocusedCompose ||
          findAnyVisibleCompose();

        const sendInCompose = findSendButtonInCompose(compose);
        debugSend("click:discard-redirect-candidate", {
          looksKeyboardActivated,
          looksLikeRecentTabEnter,
          compose: summarizeEl(compose),
          sendInCompose: summarizeEl(sendInCompose),
          sendLabel: getButtonLabel(sendInCompose)
        });

        if (sendInCompose) {
          debugSend("redirecting discard → send", {
            discard: summarizeEl(clickedButton),
            send: summarizeEl(sendInCompose)
          });
          try {
            if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
            if (typeof e.stopPropagation === "function") e.stopPropagation();
            if (typeof e.preventDefault === "function") e.preventDefault();
          } catch (_) {
            /* ignore */
          }
          try {
            suppressSendClickUntil = Date.now() + 1200;
            sendInCompose.click();
          } catch (err) {
            debugSend("sendInCompose.click failed", String(err));
          }
          // Also run our handler explicitly so we can show the modal even if Gmail's click handler is finicky.
          handleSendAttempt(sendInCompose, "tab-enter-redirect");
          return;
        }
      }

      const sendButton = findSendButtonInEvent(e);
      if (!sendButton) {
        const anyButton = closestButtonFromNode(e.target);
        if (anyButton) {
          const label = getButtonLabel(anyButton);
          console.log("Clicked button label:", label);
          debugSend("click:not-send", { button: summarizeEl(anyButton), label, target: summarizeEl(e.target) });
        } else {
          debugSend("click:no-button", { target: summarizeEl(e.target) });
        }
        return;
      }

      console.log("Matched send-like button:", getButtonLabel(sendButton));
      debugSend("click:send-detected", {
        button: summarizeEl(sendButton),
        label: getButtonLabel(sendButton),
        activeElement: summarizeEl(document.activeElement)
      });
      handleSendAttempt(sendButton, "click");
    },
    true
  );

  document.addEventListener(
    "keydown",
    function (e) {
      if (e.key === "Tab") {
        lastTabAt = Date.now();
        debugSend("tab:keydown", { activeElement: summarizeEl(document.activeElement) });
      }
      if (e.key === "Enter") lastEnterAt = Date.now();

      debugSend("keydown", {
        key: e.key,
        metaKey: !!e.metaKey,
        ctrlKey: !!e.ctrlKey,
        shiftKey: !!e.shiftKey,
        altKey: !!e.altKey,
        activeElement: summarizeEl(document.activeElement)
      });

      // Tab → Enter usually triggers a click on the focused button (no meta/ctrl).
      // If focus is currently on Gmail's Send button, treat Enter as a send attempt.
      if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
        const focusedButton = closestButtonFromNode(document.activeElement);
        debugSend("enter:no-modifiers", {
          focusedButton: summarizeEl(focusedButton),
          focusedLabel: getButtonLabel(focusedButton)
        });
        if (focusedButton && isSendButton(focusedButton, { via: "keydown-enter", noModifiers: true })) {
          console.log("Detected Enter on focused send button");
          debugSend("enter:send-confirmed", { button: summarizeEl(focusedButton), label: getButtonLabel(focusedButton) });
          handleSendAttempt(focusedButton, "keyboard-enter");
          return;
        }
        debugSend("enter:no-modifiers:not-send");
      }

      if (!(e.key === "Enter" && (e.metaKey || e.ctrlKey))) return;

      console.log("Detected keyboard send shortcut");
      debugSend("enter:meta/ctrl-send-shortcut", {
        activeElement: summarizeEl(document.activeElement),
        lastFocusedCompose: summarizeEl(lastFocusedCompose)
      });

      const compose = findComposeFromNode(document.activeElement) || lastFocusedCompose || findAnyVisibleCompose();
      if (!compose) {
        console.log("No compose found for keyboard send");
        return;
      }

      handleCompose(compose, "keyboard");
    },
    true
  );

  function handleSendAttempt(button, source) {
    debugSend("handleSendAttempt:start", { source, button: summarizeEl(button), label: getButtonLabel(button) });
    const compose =
      findComposeFromNode(button) ||
      lastFocusedCompose ||
      findAnyVisibleCompose();

    if (!compose) {
      console.log("No compose found for send button", { source, button });
      debugSend("handleSendAttempt:no-compose", { source, button: summarizeEl(button) });
      return;
    }

    debugSend("handleSendAttempt:compose-found", { source, compose: summarizeEl(compose) });
    handleCompose(compose, source);
  }

  function handleCompose(compose, source) {
    if (outreachFlowActive) {
      debugSend("handleCompose:skip (outreach flow already active)", { source });
      return;
    }
    const now = Date.now();
    if (now - lastTriggerAt < 2500) {
      console.log("Skipping duplicate trigger");
      return;
    }
    lastTriggerAt = now;

    outreachFlowActive = true;
    let draftData;
    let defaultTitle;
    try {
      draftData = extractDraftData(compose);
      defaultTitle = GmailFollowupOutreachModal.buildDefaultTitle(
        draftData.subject,
        draftData.recipients
      );
    } catch (e) {
      outreachFlowActive = false;
      throw e;
    }

    console.log("Draft data:", draftData, "source:", source);

    setTimeout(async () => {
      try {
        const emailUrl = await getSentEmailUrl(draftData.subject, draftData.recipients);

        const result = await GmailFollowupOutreachModal.showTaskModal({
          defaultTitle,
          defaultWorkingDays: 5,
          subject: draftData.subject,
          recipients: draftData.recipients,
          recipientDetails: draftData.recipientDetails,
          emailUrl,
          onNotify: (message, durationMs) => showToast(message, durationMs ?? 4000)
        });

        if (!result) return;

        const due = GmailFollowupOutreachModal.addWorkingDays(new Date(), result.workingDays);
        due.setHours(9, 0, 0, 0);

        const notesLines = [];
        if (draftData.recipients.length) notesLines.push(`To: ${draftData.recipients.join(", ")}`);
        if (draftData.subject) notesLines.push(`Subject: ${draftData.subject}`);
        if (emailUrl) notesLines.push(`Email link: ${emailUrl}`);
        const taskNotes =
          typeof result.taskDescription === "string"
            ? result.taskDescription
            : notesLines.join("\n");

        const runtime = globalThis.chrome?.runtime;
        if (!runtime?.sendMessage) {
          alert(
            "Gmail Follow-up lost connection to the extension (often after an extension reload). Refresh this Gmail tab, then try again."
          );
          return;
        }

        const sheetPayload = {
          dueISO: due.toISOString(),
          subject: draftData.subject,
          recipients: draftData.recipientDetails,
          label: result.label,
          senderEmail: draftData.senderEmail,
          mappedSheetRowNumber: result.mappedSheetRowNumber || null,
          lastAction: result.lastAction ?? "",
          sheetRecipientName: result.sheetRecipientName ?? "",
          organization: result.organization ?? ""
        };

        function handleSheetSyncOutcome(sheetSync, { successMessage, sheetFailLeadIn, sheetOnly }) {
          const failPrefix = sheetFailLeadIn ?? successMessage;
          if (sheetSync && sheetSync.ok === false) {
            const detail = sheetSync.error || "Unknown error";
            console.error("[Gmail Follow-up] Spreadsheet sync failed — full error:\n", detail);
            const clipped = detail.length > 280 ? `${detail.slice(0, 277)}…` : detail;
            showToast(
              `${failPrefix} Sheet sync failed:\n${clipped}\n\n(Full text is in this tab’s console: DevTools → Console.)`,
              14000
            );
            return;
          }
          if (sheetSync && sheetSync.skipped) {
            const msg = sheetOnly
              ? `Sheet was not updated (${sheetSync.reason || "skipped"}).`
              : `${successMessage} Sheet was not updated (${sheetSync.reason || "skipped"}).`;
            showToast(msg, 6000);
            return;
          }
          showToast(successMessage);
        }

        if (result.action === "sheetOnly") {
          runtime.sendMessage(
            {
              type: "SYNC_SHEET",
              payload: sheetPayload
            },
            (response) => {
              if (runtime.lastError) {
                console.error("Runtime error:", runtime.lastError.message);
                alert("Extension error: " + runtime.lastError.message);
                return;
              }

              if (!response?.ok) {
                alert("Could not update sheet: " + (response?.error || "Unknown error"));
                return;
              }

              handleSheetSyncOutcome(response.sheetSync, {
                successMessage: "Outreach sheet updated.",
                sheetOnly: true
              });
            }
          );
          return;
        }

        runtime.sendMessage(
          {
            type: "CREATE_TASK",
            payload: {
              title: result.title.trim() || defaultTitle,
              dueISO: sheetPayload.dueISO,
              notes: taskNotes,
              subject: sheetPayload.subject,
              recipients: sheetPayload.recipients,
              label: sheetPayload.label,
              senderEmail: sheetPayload.senderEmail,
              mappedSheetRowNumber: sheetPayload.mappedSheetRowNumber,
              lastAction: sheetPayload.lastAction,
              sheetRecipientName: sheetPayload.sheetRecipientName,
              organization: sheetPayload.organization
            }
          },
          (response) => {
            if (runtime.lastError) {
              console.error("Runtime error:", runtime.lastError.message);
              alert("Extension error: " + runtime.lastError.message);
              return;
            }

            if (!response?.ok) {
              alert("Could not create task: " + (response?.error || "Unknown error"));
              return;
            }

            handleSheetSyncOutcome(response.sheetSync, {
              successMessage: "Google Task created.",
              sheetFailLeadIn: "Task saved."
            });
          }
        );
      } catch (err) {
        console.error("handleCompose error:", err);
        alert("Error: " + err.message);
      } finally {
        outreachFlowActive = false;
      }
    }, 700);
  }

  function findComposeFromNode(node) {
    if (!node) return null;

    return (
      node.closest('div[role="dialog"]') ||
      node.closest('.M9') ||
      node.closest('.aoI') ||
      node.closest('.AD') ||
      node.closest('[gh="rc"]') ||
      null
    );
  }

  function findAnyVisibleCompose() {
    const candidates = [
      ...document.querySelectorAll('div[role="dialog"]'),
      ...document.querySelectorAll('.M9'),
      ...document.querySelectorAll('.aoI'),
      ...document.querySelectorAll('[gh="rc"]')
    ];

    for (const el of candidates.reverse()) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return el;
    }

    return null;
  }

  function extractDraftData(compose) {
    const recipientDetails = getRecipientDetails(compose);
    const toRecipientDetails = getToRecipientDetails(compose, recipientDetails);
    const senderEmail = getSenderEmailFromComposeBestEffort(compose);
    const filteredToRecipientDetails = filterOutSenderFromRecipients(toRecipientDetails, senderEmail);
    const primaryRecipientDetails = pickPrimaryRecipient(filteredToRecipientDetails);
    return {
      subject: getSubject(compose),
      recipients: primaryRecipientDetails.map((r) => r.email),
      recipientDetails: primaryRecipientDetails,
      senderEmail
    };
  }

  function getRecipientDetails(compose) {
    const byEmail = new Map();

    function add(email, name) {
      const e = String(email || "").trim();
      if (!isEmail(e)) return;
      const key = e.toLowerCase();
      const n = String(name || "").trim();
      const existing = byEmail.get(key);
      if (!existing) {
        byEmail.set(key, { email: key, name: n });
      } else if (n && !existing.name) {
        existing.name = n;
      }
    }

    compose.querySelectorAll("[email]").forEach((el) => {
      const email = el.getAttribute("email");
      const nameAttr = (el.getAttribute("name") || "").trim();
      add(email, nameAttr || displayNameFromChip(el, email));
    });

    compose.querySelectorAll("[data-hovercard-id]").forEach((el) => {
      const email = el.getAttribute("data-hovercard-id");
      add(email, displayNameFromChip(el, email));
    });

    compose.querySelectorAll("input, textarea, span, div").forEach((el) => {
      const raw =
        el.value ||
        el.getAttribute("value") ||
        el.getAttribute("aria-label") ||
        el.textContent ||
        "";
      extractEmails(raw).forEach((em) => add(em, ""));
    });

    return [...byEmail.values()];
  }

  function getToRecipientDetails(compose, fallbackRecipientDetails) {
    const toContainer = findAddressFieldContainer(compose, "To");
    if (!toContainer) return Array.isArray(fallbackRecipientDetails) ? fallbackRecipientDetails : [];

    const byEmail = new Map();

    function add(email, name) {
      const e = String(email || "").trim();
      if (!isEmail(e)) return;
      const key = e.toLowerCase();
      const n = String(name || "").trim();
      const existing = byEmail.get(key);
      if (!existing) {
        byEmail.set(key, { email: key, name: n });
      } else if (n && !existing.name) {
        existing.name = n;
      }
    }

    toContainer.querySelectorAll("[email]").forEach((el) => {
      const email = el.getAttribute("email");
      const nameAttr = (el.getAttribute("name") || "").trim();
      add(email, nameAttr || displayNameFromChip(el, email));
    });

    toContainer.querySelectorAll("[data-hovercard-id]").forEach((el) => {
      const email = el.getAttribute("data-hovercard-id");
      add(email, displayNameFromChip(el, email));
    });

    // Avoid scanning arbitrary text nodes inside the compose UI. Gmail contains hidden strings
    // like "ccbcc...draft" that can get concatenated and mis-detected as recipients.
    // If we couldn't find chips, fall back to the To input value only.
    if (byEmail.size === 0) {
      const toInput =
        toContainer.querySelector('input[aria-label^="To"], textarea[aria-label^="To"]') ||
        compose.querySelector('input[aria-label^="To"], textarea[aria-label^="To"]') ||
        compose.querySelector('input[name="to"], textarea[name="to"]');
      const v = (toInput && (toInput.value || toInput.getAttribute("value") || "")) || "";
      extractEmails(v).forEach((em) => add(em, ""));
    }

    const result = [...byEmail.values()];
    return result.length ? result : (Array.isArray(fallbackRecipientDetails) ? fallbackRecipientDetails : []);
  }

  function findAddressFieldContainer(compose, fieldName) {
    const target = String(fieldName || "").trim().toLowerCase();
    if (!target) return null;

    const candidates = [...compose.querySelectorAll("[aria-label]")];
    let firstLabelMatch = null;
    for (const el of candidates) {
      const label = String(el.getAttribute("aria-label") || "").trim().toLowerCase();
      if (!label) continue;
      if (label === target || label.startsWith(`${target} `) || label.startsWith(`${target},`) || label.startsWith(`${target}:`)) {
        // Prefer the element that actually contains recipient chips.
        if (el.querySelector?.("[email], [data-hovercard-id]")) return el;
        if (!firstLabelMatch) firstLabelMatch = el;
      }
    }
    if (firstLabelMatch) return firstLabelMatch;

    const textNodes = [...compose.querySelectorAll("span, div, label")];
    for (const el of textNodes) {
      const text = String(el.textContent || "").trim().toLowerCase();
      if (text === target) {
        const container = el.closest("div, label, td, tr");
        if (container) return container;
      }
    }

    return null;
  }

  function getSenderEmailFromComposeBestEffort(compose) {
    function extractFirstEmailFromElement(el) {
      if (!el) return "";
      const attrsToTry = [
        "email",
        "data-hovercard-id",
        "data-email",
        "data-tooltip",
        "title",
        "aria-label",
        "value"
      ];
      for (const a of attrsToTry) {
        const v = el.getAttribute?.(a);
        if (!v) continue;
        const found = extractEmails(String(v));
        if (found.length) return String(found[0]).trim().toLowerCase();
      }
      const txt = String(el.textContent || "").trim();
      const foundTxt = extractEmails(txt);
      if (foundTxt.length) return String(foundTxt[0]).trim().toLowerCase();
      return "";
    }

    const fromContainer = findAddressFieldContainer(compose, "From");
    if (fromContainer) {
      const chip = fromContainer.querySelector("[email]") || fromContainer.querySelector("[data-hovercard-id]");
      const attrEmail = chip?.getAttribute?.("email") || chip?.getAttribute?.("data-hovercard-id");
      if (attrEmail && isEmail(attrEmail.trim())) return attrEmail.trim().toLowerCase();

      const raw = (fromContainer.textContent || "").trim();
      const found = extractEmails(raw);
      if (found.length) return String(found[0]).trim().toLowerCase();
    }

    // Gmail sometimes renders the From picker without a traditional input/select.
    // Try common "From" labelled elements inside the compose and extract emails from their attributes/text.
    const fromLabelled = [
      ...compose.querySelectorAll('[aria-label^="From"], [aria-label*=" From"]'),
      ...compose.querySelectorAll('[role="combobox"][aria-label*="From"]'),
      ...compose.querySelectorAll('[role="button"][aria-label*="From"]')
    ];
    for (const el of fromLabelled) {
      const email = extractFirstEmailFromElement(el);
      if (email) return email;
      const chip = el.querySelector?.("[email], [data-hovercard-id]");
      const email2 = extractFirstEmailFromElement(chip);
      if (email2) return email2;
    }

    const fromInput =
      compose.querySelector('input[name="from"], textarea[name="from"], select[name="from"]') ||
      compose.querySelector('input[aria-label^="From"], textarea[aria-label^="From"], select[aria-label^="From"]');
    const v = (fromInput && (fromInput.value || fromInput.getAttribute("value") || "")) || "";
    const found2 = extractEmails(v);
    if (found2.length) return String(found2[0]).trim().toLowerCase();

    // Last resort: take the signed-in Google account email from the page header.
    // (This won't reflect an alias, but fixes blank values when From isn't shown.)
    const acctAnchor = document.querySelector('a[aria-label^="Google Account:"]');
    const acctEmail = extractFirstEmailFromElement(acctAnchor);
    if (acctEmail) return acctEmail;

    return "";
  }

  function filterOutSenderFromRecipients(recipients, senderEmail) {
    const s = String(senderEmail || "").trim().toLowerCase();
    if (!Array.isArray(recipients) || recipients.length === 0) return [];
    if (!s) return recipients;
    return recipients.filter((r) => String(r?.email || "").trim().toLowerCase() !== s);
  }

  function pickPrimaryRecipient(recipients) {
    if (!Array.isArray(recipients) || recipients.length === 0) return [];
    const blockedDomains = new Set(["mailsuite.com"]);
    const blockedEmails = new Set(["reminders@mailsuite.com"]);

    const cleaned = recipients
      .map((r) => ({
        email: String(r?.email || "").trim().toLowerCase(),
        name: String(r?.name || "").trim()
      }))
      .filter((r) => isEmail(r.email));

    for (const r of cleaned) {
      if (blockedEmails.has(r.email)) continue;
      const domain = r.email.split("@")[1] || "";
      if (blockedDomains.has(domain)) continue;
      return [r];
    }
    return cleaned.length ? [cleaned[0]] : [];
  }

  function displayNameFromChip(el, email) {
    if (!email) return "";
    const text = (el.textContent || "").trim();
    if (!text) return "";
    const lower = text.toLowerCase();
    if (lower === email.toLowerCase()) return "";
    const angle = text.match(/^(.+?)\s*<\s*[^>]+\s*>$/);
    if (angle) return angle[1].replace(/^["']|["']$/g, "").trim();
    return text;
  }

  function getSubject(compose) {
    const subjectInput = compose.querySelector('input[name="subjectbox"]');
    if (subjectInput?.value?.trim()) return subjectInput.value.trim();

    const threadSubject =
      document.querySelector('h2[data-thread-perm-id]') ||
      document.querySelector('h2.hP') ||
      document.querySelector('.hP');

    if (threadSubject?.textContent?.trim()) return threadSubject.textContent.trim();

    const pageTitle = document.title.replace(/\s*-\s*Gmail\s*$/, "").trim();
    return pageTitle || "(no subject)";
  }

  async function getSentEmailUrl(subject, recipients) {
    const snackbarLink = await waitForViewMessageLink(4000);
    if (snackbarLink) return snackbarLink;

    const queryParts = ["in:sent"];
    if (subject) queryParts.push(`subject:"${subject.replace(/"/g, '\\"')}"`);
    if (recipients.length === 1) queryParts.push(`to:${recipients[0]}`);

    return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(queryParts.join(" "))}`;
  }

  function waitForViewMessageLink(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();

      const check = () => {
        const links = [...document.querySelectorAll("a[href]")];
        const match = links.find((a) => /view message/i.test((a.textContent || "").trim()));
        if (match) {
          resolve(match.href.startsWith("http") ? match.href : new URL(match.href, location.origin).href);
          return true;
        }
        return false;
      };

      if (check()) return;

      const observer = new MutationObserver(() => {
        if (check()) {
          observer.disconnect();
        } else if (Date.now() - start > timeoutMs) {
          observer.disconnect();
          resolve(null);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  function extractEmails(text) {
    return String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  }

  function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function showToast(message, durationMs = 2500) {
    const existing = document.getElementById("gmail-followup-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "gmail-followup-toast";
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #202124;
      color: white;
      padding: 12px 16px;
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      z-index: 2147483647;
      font-family: Arial, sans-serif;
      font-size: 13px;
      line-height: 1.35;
      max-width: min(440px, calc(100vw - 40px));
      white-space: pre-wrap;
      word-break: break-word;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), durationMs);
  }
})();