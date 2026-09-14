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

    const TOAST_ICONS = { success: '✅', error: '⚠️', warning: '⚡', info: 'ℹ️' };

    function showToast(type, message, title, duration) {
        const container = getToastContainer();
        const el = document.createElement('div');
        el.className = `ms-toast ms-toast--${type}`;

        el.innerHTML = `
            <span class="ms-toast__icon" aria-hidden="true">${TOAST_ICONS[type] || 'ℹ️'}</span>
            <div class="ms-toast__body">
                ${title ? `<div class="ms-toast__title" dir="auto">${escapeHtml(title)}</div>` : ''}
                <div class="ms-toast__message" dir="auto">${escapeHtml(message)}</div>
            </div>
            <button class="ms-toast__close" aria-label="Dismiss">✕</button>
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
    function buildDialog({ title, message, confirmText, cancelText, danger }) {
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
                    <div class="ms-modal__footer">
                        ${cancelText ? `<button class="ms-btn ms-btn--secondary" data-action="cancel">${escapeHtml(cancelText)}</button>` : ''}
                        <button class="ms-btn ${confirmClass}" data-action="confirm">${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            `;

            function close(result) {
                document.removeEventListener('keydown', onKey);
                backdrop.remove();
                resolve(result);
            }

            function onKey(e) {
                if (e.key === 'Escape') close(false);
                if (e.key === 'Enter') close(true);
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
        danger: options.danger === true
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
    window.promptDialog = function (title, message, defaultValue = '') {
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
                        <input type="text" class="ms-input" dir="auto" value="${escapeHtml(defaultValue)}" />
                    </div>
                    <div class="ms-modal__footer">
                        <button class="ms-btn ms-btn--secondary" data-action="cancel">Cancel</button>
                        <button class="ms-btn ms-btn--primary" data-action="confirm">OK</button>
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
                if (e.key === 'Enter') close(input.value);
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
    window.renderEmptyState = function (container, { icon, title, message, actionLabel, onAction }) {
        container.innerHTML = `
            <div class="ms-empty">
                <div class="ms-empty__icon" aria-hidden="true">${icon || '📭'}</div>
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
