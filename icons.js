/* ==========================================================================
   MindSync icon set
   --------------------------------------------------------------------------
   Stroke-based SVG icons, drawn on a 24x24 grid with a 1.75 stroke weight.
   These replace the emoji that were being used as UI iconography.

   Why this matters: emoji are font glyphs, not icons. They render completely
   differently on Windows / macOS / Linux, they can't inherit the text colour
   (so they stay bright in dark mode), they don't align to the text baseline,
   and their visual weight is inconsistent - one is flat, the next is a
   3D-shaded picture. A uniform stroke set is the single clearest signal that
   an interface was designed rather than assembled.

   Emoji still have a place: in empty-state illustrations and celebratory
   moments, where a picture is the point. Just not as button icons.

   Usage:
     icon('trash')                    -> SVG string
     icon('trash', { size: 20 })      -> custom size
     element.innerHTML = icon('plus');
   ========================================================================== */

(function () {
    'use strict';

    const PATHS = {
        // Navigation
        home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/><path d="M9.5 21v-6h5v6"/>',
        calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
        week: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M8 14h2M14 14h2M8 17.5h2M14 17.5h2"/>',
        check: '<path d="M20 6 9 17l-5-5"/>',
        checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5 11 15l4.5-5"/>',
        chart: '<path d="M3 3v18h18"/><path d="M7 15V11M12 15V7M17 15v-2"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
        library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',

        // Actions
        plus: '<path d="M12 5v14M5 12h14"/>',
        trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>',
        close: '<path d="M18 6 6 18M6 6l12 12"/>',
        edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
        upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 9 5-5 5 5"/><path d="M12 4v12"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
        refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/>',
        list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',

        // Objects
        file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
        folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        brain: '<path d="M12 5a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0-2 5.2A3 3 0 0 0 6 16a3 3 0 0 0 3 3 3 3 0 0 0 3-2z"/><path d="M12 5a3 3 0 0 1 3-3 3 3 0 0 1 3 3 3 3 0 0 1 2 5.2A3 3 0 0 1 18 16a3 3 0 0 1-3 3 3 3 0 0 1-3-2z"/><path d="M12 5v14"/>',
        sparkle: '<path d="M12 3.5 13.8 9 19 10.8 13.8 12.6 12 18l-1.8-5.4L5 10.8 10.2 9z"/><path d="M18.5 16.5 19 18l1.5.5L19 19l-.5 1.5L18 19l-1.5-.5L18 18z"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        flame: '<path d="M12 22c4 0 6.5-2.6 6.5-6 0-4.2-4-6-4.5-10-2 1.5-2.5 3.5-2.5 5C10 9 9 7.8 9 6.5 7 8.5 5.5 11 5.5 14c0 3.4 2.5 8 6.5 8z"/>',
        shield: '<path d="M12 3 5 6v6c0 4.3 2.9 7.9 7 9 4.1-1.1 7-4.7 7-9V6z"/>',
        cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.6 1.4A3.8 3.8 0 0 0 7 19z"/>',
        alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
        moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
        graduation: '<path d="m12 4 10 5-10 5L2 9z"/><path d="M6 11.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5"/>',
        user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
        wave: '<path d="M3 12c2.5-4 5-4 7.5 0s5 4 7.5 0"/><path d="M3 17c2.5-4 5-4 7.5 0s5 4 7.5 0"/>',
        chevronDown: '<path d="m6 9 6 6 6-6"/>',
        chevronRight: '<path d="m9 6 6 6-6 6"/>'
    };

    window.icon = function (name, options = {}) {
        const path = PATHS[name];
        if (!path) {
            console.warn(`icon(): unknown icon "${name}"`);
            return '';
        }
        const size = options.size || 18;
        const stroke = options.stroke || 1.75;
        const cls = options.className ? ` class="${options.className}"` : '';
        // currentColor is the whole point: icons inherit the surrounding text
        // colour, so they adapt to dark mode and to state changes for free.
        return `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
    };

    window.iconNames = Object.keys(PATHS);

    // Replaces any element carrying data-icon="name" with the matching SVG.
    // Lets the static HTML stay declarative instead of embedding SVG markup.
    window.hydrateIcons = function (root = document) {
        root.querySelectorAll('[data-icon]').forEach((el) => {
            const name = el.getAttribute('data-icon');
            const size = parseInt(el.getAttribute('data-icon-size') || '18', 10);
            if (PATHS[name]) el.innerHTML = window.icon(name, { size });
        });
    };

    document.addEventListener('DOMContentLoaded', () => window.hydrateIcons());
})();
