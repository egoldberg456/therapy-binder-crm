(function () {
  if (window.__gmailFollowupLoaded) return;
  window.__gmailFollowupLoaded = true;

  console.log("Gmail Follow-up extension loaded");

  let lastFocusedCompose = null;
  let lastTriggerAt = 0;
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
    const now = Date.now();
    if (now - lastTriggerAt < 2500) {
      console.log("Skipping duplicate trigger");
      return;
    }
    lastTriggerAt = now;

    const draftData = extractDraftData(compose);
    console.log("Draft data:", draftData, "source:", source);

    const defaultTitle = buildDefaultTitle(draftData.subject, draftData.recipients);

    setTimeout(async () => {
      try {
        const emailUrl = await getSentEmailUrl(draftData.subject, draftData.recipients);

        const result = await showTaskModal({
          defaultTitle,
          defaultWorkingDays: 5,
          subject: draftData.subject,
          recipients: draftData.recipients,
          emailUrl
        });

        if (!result) return;

        const due = addWorkingDays(new Date(), result.workingDays);
        due.setHours(9, 0, 0, 0);

        const notesLines = [];
        if (draftData.recipients.length) notesLines.push(`To: ${draftData.recipients.join(", ")}`);
        if (draftData.subject) notesLines.push(`Subject: ${draftData.subject}`);
        if (emailUrl) notesLines.push(`Email link: ${emailUrl}`);

        const runtime = globalThis.chrome?.runtime;
        if (!runtime?.sendMessage) {
          alert(
            "Gmail Follow-up lost connection to the extension (often after an extension reload). Refresh this Gmail tab, then try again."
          );
          return;
        }

        runtime.sendMessage(
          {
            type: "CREATE_TASK",
            payload: {
              title: result.title.trim() || defaultTitle,
              dueISO: due.toISOString(),
              notes: notesLines.join("\n"),
              subject: draftData.subject,
              recipients: draftData.recipientDetails,
              label: result.label
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

            if (response.sheetSync && response.sheetSync.ok === false) {
              const detail = response.sheetSync.error || "Unknown error";
              console.error("[Gmail Follow-up] Spreadsheet sync failed — full error:\n", detail);
              const clipped = detail.length > 280 ? `${detail.slice(0, 277)}…` : detail;
              showToast(
                `Task saved. Sheet sync failed:\n${clipped}\n\n(Full text is in this tab’s console: DevTools → Console.)`,
                14000
              );
            } else {
              showToast("Google Task created.");
            }
          }
        );
      } catch (err) {
        console.error("handleCompose error:", err);
        alert("Error: " + err.message);
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
    return {
      subject: getSubject(compose),
      recipients: recipientDetails.map((r) => r.email),
      recipientDetails
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

  function buildDefaultTitle(subject, recipients) {
    const safeSubject = subject || "(no subject)";
    if (recipients.length === 1) return `[${recipients[0]}] ${safeSubject}`;
    return safeSubject;
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

  function isWeekend(date) {
    const day = date.getDay();
    return day === 0 || day === 6;
  }

  function extractEmails(text) {
    return String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  }

  function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function showTaskModal({ defaultTitle, defaultWorkingDays, subject, recipients, emailUrl }) {
    return new Promise((resolve) => {
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
        width: 440px;
        max-width: calc(100vw - 32px);
        background: #fff;
        color: #202124;
        border-radius: 16px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.25);
        overflow: hidden;
      `;

      modal.innerHTML = `
        <div style="padding: 18px 20px 12px 20px; border-bottom: 1px solid #e8eaed;">
          <div style="font-size: 20px; font-weight: 600; margin-bottom: 4px;">Create follow-up task</div>
          <div style="font-size: 13px; color: #5f6368;">This will add a task to Google Tasks.</div>
        </div>

        <div style="padding: 18px 20px; display: grid; gap: 14px;">
          <div style="font-size: 12px; color: #5f6368; line-height: 1.45;">
            <div><strong>To:</strong> ${escapeHtml(recipients.length ? recipients.join(", ") : "None found")}</div>
            <div style="margin-top: 4px;"><strong>Subject:</strong> ${escapeHtml(subject || "(no subject)")}</div>
          </div>

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
            <span style="font-size: 13px; font-weight: 600;">Label</span>
            <select
              id="gmail-followup-label"
              style="width: 100%; max-width: 280px; box-sizing: border-box; padding: 10px 12px; border: 1px solid #dadce0; border-radius: 10px; font-size: 14px; outline: none; background: #fff; color: #202124;"
            >
              <option value="Potential Customer">Potential Customer</option>
              <option value="Advisor">Advisor</option>
              <option value="VC">VC</option>
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

          ${emailUrl ? `<div style="font-size: 12px; color: #5f6368;">A link to this email will be included in the task details.</div>` : ""}
        </div>

        <div style="padding: 14px 20px 18px 20px; display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid #e8eaed;">
          <button id="gmail-followup-cancel" style="${secondaryButtonStyle()}">Cancel</button>
          <button id="gmail-followup-create" style="${primaryButtonStyle()}">Create task</button>
        </div>
      `;

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const titleInput = modal.querySelector("#gmail-followup-title");
      const labelSelect = modal.querySelector("#gmail-followup-label");
      const daysInput = modal.querySelector("#gmail-followup-days");

      modal.querySelectorAll("[data-days]").forEach((btn) => {
        btn.addEventListener("click", () => {
          daysInput.value = btn.getAttribute("data-days");
        });
      });

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
          submit();
        }
      }

      function submit() {
        const title = titleInput.value.trim();
        const workingDays = parseInt(daysInput.value, 10);
        if (!title) return titleInput.focus();
        if (isNaN(workingDays) || workingDays < 0) return daysInput.focus();
        cleanup({ title, workingDays, label: labelSelect.value });
      }

      overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay) cleanup(null);
      });

      modal.querySelector("#gmail-followup-cancel").addEventListener("click", () => cleanup(null));
      modal.querySelector("#gmail-followup-create").addEventListener("click", submit);
      document.addEventListener("keydown", onKeyDown, true);

      setTimeout(() => {
        titleInput.focus();
        titleInput.select();
      }, 0);
    });
  }

  function quickDayButton(days) {
    return `<button type="button" data-days="${days}" style="border:1px solid #dadce0;background:#fff;color:#202124;border-radius:999px;padding:8px 12px;font-size:12px;cursor:pointer;">${days} ${days === 1 ? "day" : "days"}</button>`;
  }

  function primaryButtonStyle() {
    return `border:none;background:#1a73e8;color:white;border-radius:999px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;`;
  }

  function secondaryButtonStyle() {
    return `border:1px solid #dadce0;background:#fff;color:#202124;border-radius:999px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;`;
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

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();