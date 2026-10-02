/* ==========================================================================
   MindSync UI helpers - drop-in replacements for alert() / confirm()
   --------------------------------------------------------------------------
   Why this exists: native alert() and confirm() render as OS dialogs that
   look like Windows 95, block the entire renderer thread, and can't be
   styled. They are the single strongest visual signal of an unpolished
   desktop app. These replacements are async, themed, and non-blocking.

   Usage:
     toast.success('Task saved');
     toast.error('Could not reach the server', 'Connection failed');
     const ok = await confirmDialog('Delete this task?', 'This cannot be undone.');
     await alertDialog('Something went wrong', 'Details here');

   Load this BEFORE renderer.js.
   ========================================================================== */

(function () {
    'use strict';

    // ---- Toast container (created once, lazily) ----
    let toastContainer = null;
    function getToastContainer() {
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.className = 'ms-toast-container';
            toastContainer.setAttribute('role', 'status');
            toastContainer.setAttribute('aria-live', 'polite');
            document.body.appendChild(toastContainer);
        }
        return toastContainer;
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Line icons from icons.js, tinted by status in CSS. (These were emoji,
    // which look different on every OS and don't follow the text colour.)
    const TOAST_ICONS = { success: 'checkCircle', error: 'alert', warning: 'alert', info: 'info' };
    const svg = (name, size) => (window.icon ? window.icon(name, { size }) : '');

    function showToast(type, message, title, duration) {
        const container = getToastContainer();
        const el = document.createElement('div');
        el.className = `ms-toast ms-toast--${type}`;

        el.innerHTML = `
            <span class="ms-toast__icon" aria-hidden="true">${svg(TOAST_ICONS[type] || 'info', 16)}</span>
            <div class="ms-toast__body">
                ${title ? `<div class="ms-toast__title" dir="auto">${escapeHtml(title)}</div>` : ''}
                <div class="ms-toast__message" dir="auto">${escapeHtml(message)}</div>
            </div>
            <button class="ms-toast__close" aria-label="Dismiss">${svg('close', 14)}</button>
        `;

        function dismiss() {
            if (el.classList.contains('ms-toast--leaving')) return;
            el.classList.add('ms-toast--leaving');
            setTimeout(() => el.remove(), 200);
        }

        el.querySelector('.ms-toast__close').onclick = dismiss;
        container.appendChild(el);

        // Errors stay longer - the user needs time to actually read them.
        const life = duration || (type === 'error' ? 7000 : 4000);
        setTimeout(dismiss, life);

        return dismiss;
    }

    window.toast = {
        success: (message, title) => showToast('success', message, title),
        error:   (message, title) => showToast('error', message, title),
        warning: (message, title) => showToast('warning', message, title),
        info:    (message, title) => showToast('info', message, title)
    };

    // ---- Modal dialogs ----
    // Returns a Promise so calling code reads almost the same as before:
    //   if (!await confirmDialog(...)) return;
    // `checkbox` (a label) adds one tick box under the message; confirming then
    // resolves to { checked } instead of true.
    function buildDialog({ title, message, confirmText, cancelText, danger, checkbox }) {
        return new Promise((resolve) => {
            const backdrop = document.createElement('div');
            backdrop.className = 'ms-modal-backdrop';
            backdrop.setAttribute('role', 'dialog');
            backdrop.setAttribute('aria-modal', 'true');

            const confirmClass = danger ? 'ms-btn--danger' : 'ms-btn--primary';

            backdrop.innerHTML = `
                <div class="ms-modal">
                    <div class="ms-modal__header">
                        <h3 class="ms-modal__title" dir="auto">${escapeHtml(title)}</h3>
                    </div>
                    ${message ? `<div class="ms-modal__body" dir="auto">${escapeHtml(message)}</div>` : ''}
                    ${checkbox ? `<label class="ms-modal__check" dir="auto"><input type="checkbox" data-role="check"> <span>${escapeHtml(checkbox)}</span></label>` : ''}
                    <div class="ms-modal__footer">
                        ${cancelText ? `<button class="ms-btn ms-btn--secondary" data-action="cancel">${escapeHtml(cancelText)}</button>` : ''}
                        <button class="ms-btn ${confirmClass}" data-action="confirm">${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            `;

            function close(result) {
                document.removeEventListener('keydown', onKey);
                const check = backdrop.querySelector('[data-role="check"]');
                backdrop.remove();
                resolve(result && check ? { checked: check.checked } : result);
            }

            function onKey(e) {
                if (e.key === 'Escape') close(false);
                // Enter on a focused button presses THAT button (30/9: Enter
                // on a focused "Cancel" used to confirm - e.g. delete).
                if (e.key === 'Enter') {
                    if (e.target && (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT')) return;
                    e.preventDefault();
                    close(true);
                }
            }

            backdrop.querySelector('[data-action="confirm"]').onclick = () => close(true);
            const cancelBtn = backdrop.querySelector('[data-action="cancel"]');
            if (cancelBtn) cancelBtn.onclick = () => close(false);

            // Clicking the backdrop itself (not the modal) cancels.
            backdrop.onclick = (e) => { if (e.target === backdrop) close(false); };
            document.addEventListener('keydown', onKey);

            document.body.appendChild(backdrop);
            backdrop.querySelector('[data-action="confirm"]').focus();
        });
    }

    window.confirmDialog = (title, message, options = {}) => buildDialog({
        title,
        message,
        confirmText: options.confirmText || 'Confirm',
        cancelText: options.cancelText || 'Cancel',
        danger: options.danger === true,
        checkbox: options.checkbox || null
    });

    window.alertDialog = (title, message) => buildDialog({
        title,
        message,
        confirmText: 'OK',
        cancelText: null,
        danger: false
    });

    // ---- Prompt replacement ----
    // Electron does not implement window.prompt() at all - it returns
    // undefined rather than a string, which silently breaks any code that
    // depends on it. This is a real, styled replacement.
    // options: { type: 'password', confirmText, danger } - all optional.
    window.promptDialog = function (title, message, defaultValue = '', options = {}) {
        return new Promise((resolve) => {
            const backdrop = document.createElement('div');
            backdrop.className = 'ms-modal-backdrop';
            backdrop.setAttribute('role', 'dialog');
            backdrop.setAttribute('aria-modal', 'true');

            backdrop.innerHTML = `
                <div class="ms-modal">
                    <div class="ms-modal__header">
                        <h3 class="ms-modal__title" dir="auto">${escapeHtml(title)}</h3>
                    </div>
                    <div class="ms-modal__body">
                        ${message ? `<div style="margin-bottom: var(--space-3);" dir="auto">${escapeHtml(message)}</div>` : ''}
                        <input type="${options.type === 'password' ? 'password' : 'text'}" class="ms-input" dir="auto" value="${escapeHtml(defaultValue)}" ${options.type === 'password' ? 'autocomplete="current-password"' : ''} />
                    </div>
                    <div class="ms-modal__footer">
                        <button class="ms-btn ms-btn--secondary" data-action="cancel">Cancel</button>
                        <button class="ms-btn ${options.danger ? 'ms-btn--danger' : 'ms-btn--primary'}" data-action="confirm">${escapeHtml(options.confirmText || 'OK')}</button>
                    </div>
                </div>
            `;

            const input = backdrop.querySelector('input');

            function close(result) {
                document.removeEventListener('keydown', onKey);
                backdrop.remove();
                resolve(result);
            }
            function onKey(e) {
                if (e.key === 'Escape') close(null);
                if (e.key === 'Enter') {
                    if (e.target && e.target.tagName === 'BUTTON') return;   // see buildDialog
                    e.preventDefault();
                    close(input.value);
                }
            }

            backdrop.querySelector('[data-action="confirm"]').onclick = () => close(input.value);
            backdrop.querySelector('[data-action="cancel"]').onclick = () => close(null);
            backdrop.onclick = (e) => { if (e.target === backdrop) close(null); };
            document.addEventListener('keydown', onKey);

            document.body.appendChild(backdrop);
            input.focus();
            input.select();
        });
    };

    // ---- Empty state + skeleton builders ----
    // `icon` is an icon name from icons.js ('calendar', 'search', ...).
    window.renderEmptyState = function (container, { icon, title, message, actionLabel, onAction }) {
        const iconName = window.iconNames && window.iconNames.includes(icon) ? icon : 'file';
        container.innerHTML = `
            <div class="ms-empty">
                <div class="ms-empty__icon" aria-hidden="true">${svg(iconName, 20)}</div>
                <div class="ms-empty__title" dir="auto">${escapeHtml(title)}</div>
                ${message ? `<div class="ms-empty__message" dir="auto">${escapeHtml(message)}</div>` : ''}
                ${actionLabel ? `<button class="ms-btn ms-btn--primary ms-empty__action">${escapeHtml(actionLabel)}</button>` : ''}
            </div>
        `;
        if (actionLabel && onAction) {
            container.querySelector('.ms-empty__action').onclick = onAction;
        }
    };

    window.renderSkeleton = function (container, count = 3) {
        container.innerHTML = Array.from({ length: count })
            .map(() => '<div class="ms-skeleton ms-skeleton--card"></div>')
            .join('');
    };
})();
