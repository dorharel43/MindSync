// Language (i18n.js, loaded before this file). If it's missing, English.
if (!window.I18N) window.I18N = { lang: 'en', isRtl: false, t: (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m)) : s), setLang() {}, translate() {} };
if (!window.t) window.t = window.I18N.t;

// Safety net (30/9): an error nobody caught used to fail silently - a
// button that did nothing. Now it says so (at most once every few seconds).
let lastUnhandledToast = 0;
window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled:', e.reason);
    if (Date.now() - lastUnhandledToast < 4000 || !window.toast) return;
    lastUnhandledToast = Date.now();
    const msg = (e.reason && e.reason.message) || String(e.reason || '');
    window.toast.error(msg && msg.length < 200 ? msg : 'Please try again.', 'Something didn\'t work');
});
const { ipcRenderer, clipboard } = require('electron');

// A task's urgency is classified by AI in the background now (see main.js's
// add-smart-task) so creating a task doesn't wait on it. This is how the
// main process tells us the classification landed, so the list picks up
// the real urgency instead of staying on the "Normal" default forever.
// A finished/deleted task's planned blocks were just removed in main.js -
// refresh the board so they don't linger on screen.
ipcRenderer.on('events-changed', () => {
    if (typeof loadAndRenderWeeklyBoard === 'function') loadAndRenderWeeklyBoard();
    if (typeof loadAndRenderHome === 'function') loadAndRenderHome();
});

ipcRenderer.on('tasks-changed', () => {
    if (typeof loadAndRenderTasks === 'function') loadAndRenderTasks();
});

// ==========================================
// 0. Auth
// ==========================================
// AUTH: the app boots hidden behind #auth-screen (see index.html's default
// body.auth-pending class) until a session is confirmed. Everything else in
// this file still runs immediately as before - it'll get empty lists/401s
// in the background while the login screen is up, which is harmless since
// none of it is visible. bootApp() re-runs the real loads once we have a
// confirmed, authenticated user.
const authScreen = document.getElementById('auth-screen');
const authLoading = document.getElementById('auth-loading');
const authFormWrap = document.getElementById('auth-form-wrap');
const authForm = document.getElementById('auth-form');
const authTitle = document.getElementById('auth-title');
const authSubtitle = document.getElementById('auth-subtitle');
const authNameField = document.getElementById('auth-name-field');
const authDegreeField = document.getElementById('auth-degree-field');
const authNameInput = document.getElementById('auth-name-input');
const authDegreeInput = document.getElementById('auth-degree-input');
const authEmailInput = document.getElementById('auth-email-input');
const authPasswordInput = document.getElementById('auth-password-input');
const authPasswordHint = document.getElementById('auth-password-hint');
const authError = document.getElementById('auth-error');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const authToggleText = document.getElementById('auth-toggle-text');
const authToggleLink = document.getElementById('auth-toggle-link');

let authMode = 'login'; // 'login' | 'register'

// "Forgot password?" (30/9): the reset happens on the website - on the web
// version in this tab, on desktop in the browser (the emailed link opens
// there anyway).
// Links to the website's pages (terms, privacy) - 30/9. Web: a new tab;
// desktop: the browser.
document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-site-page]');
    if (!a) return;
    e.preventDefault();
    const page = a.getAttribute('data-site-page');
    if (window.MINDSYNC_WEB) window.open(page, '_blank', 'noopener');
    else ipcRenderer.invoke('open-site-page', page).catch(() => {});
});

const authForgotLink = document.getElementById('auth-forgot-link');
if (authForgotLink) authForgotLink.onclick = (e) => {
    e.preventDefault();
    if (window.MINDSYNC_WEB) location.href = '/reset-password';
    else ipcRenderer.invoke('open-reset-password').catch(() => {});
};

// Letters (any language), spaces, hyphens, apostrophes - covers real names
// like "דור-אל" or "O'Brian" while rejecting digits and symbols. Used for
// both the registration form and the Edit Profile modal, client-side; the
// real enforcement is the matching validator on User.name in the server
// model, since a client-side check alone can always be bypassed.
const NAME_PATTERN = /^[\p{L}\p{M}\s'\-׳״־]+$/u; // \p{M} vowel marks (שָׁלוֹם), ׳ ״ ־ (ג׳וני) - 30/9
function isValidName(name) {
    return name.length > 0 && name.length <= 100 && NAME_PATTERN.test(name);
}

function setAuthMode(mode) {
    authMode = mode;
    if (authError) authError.hidden = true;
    if (mode === 'register') {
        authTitle.textContent = 'Create an account';
        authSubtitle.textContent = 'A few seconds, then you\'re in.';
        authNameField.hidden = false;
        authDegreeField.hidden = false;
        authPasswordHint.hidden = false;
        authSubmitBtn.textContent = 'Create account';
        authToggleText.textContent = 'Already have an account?';
        if (authForgotLink) authForgotLink.hidden = true;
        const termsLine = document.getElementById('auth-terms'); if (termsLine) termsLine.hidden = false;
        authToggleLink.textContent = 'Log in';
    } else {
        authTitle.textContent = 'Log in';
        authSubtitle.textContent = 'Welcome back.';
        authNameField.hidden = true;
        authDegreeField.hidden = true;
        authPasswordHint.hidden = true;
        authSubmitBtn.textContent = 'Log in';
        authToggleText.textContent = "Don't have an account?";
        if (authForgotLink) authForgotLink.hidden = false;
        const termsLine = document.getElementById('auth-terms'); if (termsLine) termsLine.hidden = true;
        authToggleLink.textContent = 'Create one';
    }
}

if (authToggleLink) {
    authToggleLink.onclick = (e) => {
        e.preventDefault();
        setAuthMode(authMode === 'login' ? 'register' : 'login');
    };
}
// The website's "Create an account" button opens /app/#signup (30/9): straight
// to the sign-up form, not the login a new student has to find a way out of.
if (/(^|[#&])signup(&|$)/.test(location.hash || '')) {
    setAuthMode('register');
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* old browser */ }
}

// Called once, either immediately (a saved session was still valid) or
// after a successful login/register. Reveals the app and re-runs the loads
// that may have fired with empty/401 results while the login screen was up.
let currentUserId = null;
let currentProfile = { name: '', degree: '' };   // from loadProfile (30/9) // used to keep per-user UI preferences apart on a shared machine

// Arrived from "Open MindSync" on the email-confirmed page (web, 30/9):
// /app/#verified=<account id>. This browser may be logged in to ANOTHER
// account (a phone that has the main account open) - then say so, instead
// of silently showing an account that isn't the one just confirmed.
function handleVerifiedLink(user) {
    if (!window.MINDSYNC_WEB) return;
    const m = /(?:^|[#&])verified=([a-f0-9]{24})(?:&|$)/i.exec(location.hash || '');
    if (!m) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* old browser */ }
    if (m[1] === currentUserId) {
        toast.success('Your email is confirmed.');
        return;
    }
    const who = user && user.email ? user.email : '';
    setTimeout(() => showActionToast(
        `${t('The email you just confirmed belongs to a different account.')}${who ? ` ${t('You\'re logged in here as {email}.', { email: isolate(who) })}` : ''}`,
        t('Log in to the other account'),
        () => { const b = document.getElementById('auth-logout-btn'); if (b) b.click(); },
        { title: t('Email confirmed'), duration: 30000 }
    ), 400);
}

// "Was logged in on this device" - read by i18n.js before the page shows.
function rememberSession(on, { keepFlag = false } = {}) {
    try {
        if (on) localStorage.setItem('mindsync.session', '1');
        else if (!keepFlag) localStorage.removeItem('mindsync.session');
    } catch (e) { /* storage blocked */ }
    if (!on) document.documentElement.classList.remove('has-session');
}

function bootApp(user) {
    rememberSession(true);
    document.body.classList.remove('auth-pending');
    currentUserId = user && (user.id || user._id) ? String(user.id || user._id) : null;
    handleVerifiedLink(user);
    if (typeof refreshOnboarding === 'function') refreshOnboarding();

    // Full profile fields (including the Settings page ones) come from
    // loadProfile() - it's one IPC round-trip, now safe since we're
    // authenticated, and keeps a single source of truth instead of this
    // function partially duplicating what loadProfile() already does.
    if (typeof loadProfile === 'function') loadProfile();

    // These are declared with `function` further down, so they're hoisted
    // and safe to call from here regardless of where in the file this runs.
    if (typeof loadAndRenderHome === 'function') loadAndRenderHome();
    if (typeof loadAndRenderTasks === 'function') loadAndRenderTasks();
    if (typeof loadAndRenderEvents === 'function') loadAndRenderEvents();
    if (typeof loadAndRenderWeeklyBoard === 'function') loadAndRenderWeeklyBoard();
    if (typeof loadStudyHome === 'function') loadStudyHome();
    if (typeof loadAiSettings === 'function') loadAiSettings();
    // Materials and the focus list used to load only once, at start-up -
    // before the login, so they stayed empty until a restart (30/9).
    if (typeof loadAndRenderFolders === 'function') loadAndRenderFolders();
    if (typeof loadAndRenderFiles === 'function') loadAndRenderFiles();
    if (typeof loadAndRenderBlockedApps === 'function' && !IS_WEB) loadAndRenderBlockedApps();
    if (IS_WEB) refreshGoogleState();
}

if (authForm) {
    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        authError.hidden = true;
        authSubmitBtn.disabled = true;
        authSubmitBtn.textContent = authMode === 'login' ? 'Logging in...' : 'Creating account...';

        try {
            const email = authEmailInput.value.trim();
            const password = authPasswordInput.value;

            if (authMode === 'register') {
                const name = authNameInput.value.trim();
                if (!isValidName(name)) {
                    authError.textContent = 'Name can only contain letters (no numbers or symbols).';
                    authError.hidden = false;
                    return;
                }
            }

            const res = authMode === 'register'
                ? await ipcRenderer.invoke('auth-register', {
                    email, password,
                    name: authNameInput.value.trim(),
                    degree: authDegreeInput.value.trim(),
                    lang: (window.I18N && I18N.lang) || 'en'   // the welcome email's language
                  })
                : await ipcRenderer.invoke('auth-login', { email, password });

            if (res && res.error) {
                authError.textContent = res.error;
                authError.hidden = false;
                return;
            }

            bootApp(res.user);
        } catch (err) {
            authError.textContent = 'Something went wrong. Please try again.';
            authError.hidden = false;
        } finally {
            authSubmitBtn.disabled = false;
            authSubmitBtn.textContent = authMode === 'login' ? 'Log in' : 'Create account';
        }
    });
}

// Reverses bootApp(): drops the session, hides the app again, and resets
// the form to a clean login screen so the next person on this machine
// doesn't see anything left over from this session.
const authLogoutBtn = document.getElementById('auth-logout-btn');
if (authLogoutBtn) {
    authLogoutBtn.onclick = async () => {
        await ipcRenderer.invoke('auth-logout');
        rememberSession(false);
        // Start clean (30/9): the screens kept the previous account's data -
        // the next person to log in on this computer saw its folders, files
        // and even an open question. A reload clears everything.
        location.reload();
    };
}

// Delete account: one dialog that says what goes and asks the password.
// A wrong password keeps you logged in and lets you try again.
const authDeleteBtn = document.getElementById('auth-delete-account-btn');
if (authDeleteBtn) {
    authDeleteBtn.onclick = async () => {
        for (;;) {
            const password = await promptDialog(
                'Delete your account?',
                'This deletes your account and everything in it: tasks, calendar items, files, summaries and questions. It can\'t be undone.' +
                (IS_WEB ? ' Google Calendar is disconnected; what was already added there stays in your Google account.' : '') +
                ' Enter your password to confirm.',
                '', { type: 'password', confirmText: 'Delete account', danger: true });
            if (password === null) return;           // cancelled
            if (!password) continue;                 // empty: ask again
            authDeleteBtn.disabled = true;
            const res = await ipcRenderer.invoke('auth-delete-account', password).catch(e => ({ error: e.message }));
            authDeleteBtn.disabled = false;
            if (res && res.success) {
                toast.success('Your account and its data were deleted.', 'Account deleted');
                // A clean page (review fix 30/9): the account's screens stayed
                // filled behind the login form. Same as logging out.
                rememberSession(false);
                // (The website goes to its home page by itself - web-shim.)
                if (!window.MINDSYNC_WEB) setTimeout(() => location.reload(), 1200);
                if (authForm) authForm.reset();
                setAuthMode('register');
                if (authLoading) authLoading.hidden = true;
                if (authFormWrap) authFormWrap.hidden = false;
                document.body.classList.add('auth-pending');
                return;
            }
            toast.error((res && res.error) || 'Please try again.', 'Could not delete the account');
            if (!/password/i.test((res && res.error) || '')) return;
        }
    };
}

// Change password (30/9): current, then new twice; other devices are logged out.
const authChangePwBtn = document.getElementById('auth-change-password-btn');
if (authChangePwBtn) {
    authChangePwBtn.onclick = async () => {
        const current = await promptDialog(t('Change password'), t('Your current password:'), '', { type: 'password', confirmText: t('Next') });
        if (!current) return;
        const next = await promptDialog(t('Change password'), t('The new password (at least 8 characters). Every other device will be logged out.'), '', { type: 'password', confirmText: t('Next') });
        if (!next) return;
        if (next.length < 8) { toast.error(t('Password must be at least 8 characters.')); return; }
        const again = await promptDialog(t('Change password'), t('The new password again:'), '', { type: 'password', confirmText: t('Change password') });
        if (again === null) return;
        if (again !== next) { toast.error(t('The two new passwords are different. Nothing was changed.')); return; }
        authChangePwBtn.disabled = true;
        const res = await ipcRenderer.invoke('auth-change-password', { currentPassword: current, newPassword: next }).catch(e => ({ error: e.message }));
        authChangePwBtn.disabled = false;
        if (res && res.success) toast.success(t('Every other device was logged out.'), t('Password changed'));
        else toast.error((res && res.error) || t('Please try again.'), t('Password not changed'));
    };
}

// A saved token isn't proof it still works, so this asks the server rather
// than trusting the file existing - see main.js's auth-get-session handler.
(async () => {
    try {
        const session = await ipcRenderer.invoke('auth-get-session');
        if (session && session.loggedIn) {
            bootApp(session.user);
            return;
        }
        // Really logged out: forget "was logged in here".
        rememberSession(false, { keepFlag: !!(session && session.offline) });
    } catch (err) {
        console.error('auth-get-session failed:', err.message);
        // Couldn't ask (offline): show the form now, but keep the flag - the
        // next load, online, should still skip the login screen.
        rememberSession(false, { keepFlag: true });
    }
    // Not logged in (or the check itself failed) - swap the spinner for the
    // actual form instead of leaving the person staring at "Checking...".
    if (authLoading) authLoading.hidden = true;
    if (authFormWrap) authFormWrap.hidden = false;
})();

// ==========================================
// 0b. Google Calendar - web version
// ==========================================
// Desktop: unchanged - the app signs in to Google the first time something
// is synced. Web (window.MINDSYNC_WEB, set by web-shim.js): every account
// connects its own Google Calendar once. Until then the "Also add to Google
// Calendar" boxes start unticked, and ticking one opens Google's page right
// there - nobody has to find the setting first.
const IS_WEB = !!window.MINDSYNC_WEB;
let googleState = IS_WEB ? null : { configured: true, connected: true };

async function refreshGoogleState() {
    if (!IS_WEB) return googleState;
    googleState = await ipcRenderer.invoke('google-status').catch(() => null) || { configured: false, connected: false };
    renderGoogleCard();
    return googleState;
}
const googleConnected = () => !!(googleState && googleState.connected);

// Must run straight from a click (it opens Google's window). Resolves to
// true once connected.
async function connectGoogle() {
    const res = await ipcRenderer.invoke('google-connect');
    googleState = res || googleState;
    renderGoogleCard();
    if (googleConnected()) toast.success('Your MindSync events can now go to Google Calendar too.', 'Google Calendar connected');
    else if (res && res.error) toast.error(res.error, 'Could not connect Google Calendar');
    return googleConnected();
}

// A "also add to Google Calendar" checkbox: ticking it while not connected
// connects first; if that doesn't happen, the box goes back to unticked.
function wireGoogleCheckbox(box) {
    if (!IS_WEB || !box) return;
    box.addEventListener('change', async () => {
        if (!box.checked || googleConnected()) return;
        if (googleState && !googleState.configured) {
            box.checked = false;
            toast.info('Google Calendar isn\'t available yet.');
            return;
        }
        box.checked = await connectGoogle();
    });
}

function renderGoogleCard() {
    const label = document.getElementById('google-status-label');
    const connectBtn = document.getElementById('google-connect-btn');
    const disconnectBtn = document.getElementById('google-disconnect-btn');
    if (!IS_WEB || !label) return;
    const s = googleState;
    if (!s) { label.textContent = 'Checking…'; return; }
    label.textContent = !s.configured ? 'Not available yet.'
        : s.connected ? `Connected${s.email ? ' as ' + s.email : ''} ✓`
        : 'Not connected.';
    if (connectBtn) connectBtn.hidden = !s.configured || s.connected;
    if (disconnectBtn) disconnectBtn.hidden = !s.connected;
}

if (IS_WEB) {
    const connectBtn = document.getElementById('google-connect-btn');
    const disconnectBtn = document.getElementById('google-disconnect-btn');
    if (connectBtn) connectBtn.onclick = () => connectGoogle();
    if (disconnectBtn) disconnectBtn.onclick = async () => {
        const sure = await confirmDialog('Disconnect Google Calendar?',
            'New events won\'t be added to Google anymore. What is already there stays - you can delete the "MindSync" calendar in Google Calendar if you don\'t want it.',
            { confirmText: 'Disconnect' });
        if (!sure) return;
        const res = await ipcRenderer.invoke('google-disconnect');
        if (res && res.error) toast.error(res.error);
        await refreshGoogleState();
    };
    // Connected in another tab (or the Google window finished).
    ipcRenderer.on('google-changed', () => refreshGoogleState());
    // Came back from Google in the same tab (pop-ups were blocked).
    const back = new URLSearchParams(location.search).get('google');
    if (back) {
        history.replaceState(null, '', location.pathname + location.hash);
        setTimeout(() => {
            if (back === 'connected') toast.success('Your MindSync events can now go to Google Calendar too.', 'Google Calendar connected');
            else toast.error('Google Calendar was not connected. You can try again in Settings.');
        }, 800);
    }
}

// ==========================================
// 1. Navigation
// ==========================================
const menuItems = document.querySelectorAll('.menu-item');
const views = document.querySelectorAll('.view-section');

// ---- Phone: the side menu is a drawer (CSS under 760px) ----
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const mobileScrim = document.getElementById('mobile-scrim');
function setMobileMenu(open) {
    document.body.classList.toggle('mobile-menu-open', open);
    if (mobileScrim) mobileScrim.hidden = !open;
    if (mobileMenuBtn) mobileMenuBtn.setAttribute('aria-expanded', String(open));
}
if (mobileMenuBtn) mobileMenuBtn.onclick = () => setMobileMenu(!document.body.classList.contains('mobile-menu-open'));
if (mobileScrim) mobileScrim.onclick = () => setMobileMenu(false);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('mobile-menu-open')) setMobileMenu(false); });
const profileTrigger = document.getElementById('sidebar-profile-trigger');
if (profileTrigger) profileTrigger.addEventListener('click', () => setMobileMenu(false));

menuItems.forEach(item => {
    item.addEventListener('click', () => {
        // Phone: picking a screen closes the drawer and names the screen.
        setMobileMenu(false);
        const topTitle = document.getElementById('mobile-topbar-title');
        if (topTitle) topTitle.textContent = item.textContent.replace(/\d+/g, '').trim();
        // Floating bars are attached to the body, not to a view, so switching
        // screens has to take them down explicitly or they hover over
        // whatever comes next.
        if (typeof clearManageSelection === 'function') clearManageSelection();
        if (typeof selectedTaskIds !== 'undefined' && item.id !== 'nav-tasks') {
            selectedTaskIds.clear();
            const taskBar = document.getElementById('bulk-action-bar');
            if (taskBar) taskBar.remove();
        }

        menuItems.forEach(btn => btn.classList.remove('active'));
        views.forEach(view => view.style.display = 'none');

        item.classList.add('active');
        // The board can show tasks now, which change on other screens -
        // refresh it on arrival instead of showing a stale copy.
        if (item.id === 'nav-weekly' && typeof loadAndRenderWeeklyBoard === 'function') {
            loadAndRenderWeeklyBoard();
        }
        const targetViewId = item.id.replace('nav-', 'view-');
        const targetView = document.getElementById(targetViewId);
        if(targetView) {
            targetView.style.display = 'block';
        }
    });
});

// ==========================================
// 2. Dark Mode
// ==========================================
const themeBtnSidebar = document.getElementById('theme-toggle-btn');
const darkToggleSettings = document.getElementById('settings-dark-toggle');

// Preferences live in localStorage rather than the server: they're per-device
// (the same person may want dark mode on a laptop and light on a desktop),
// and they must apply instantly on boot without waiting for a network call.
const THEME_KEY = 'mindsync.theme';
const DARK_KEY = 'mindsync.darkMode';
// Colour themes (themes.css). 'blue' is the default added with the 2026
// redesign; ink / paper / slate are the earlier three, rebuilt on it.
const VALID_THEMES = ['blue', 'ink', 'paper', 'slate'];

function applyTheme(themeName) {
    if (!VALID_THEMES.includes(themeName)) themeName = 'blue';
    document.documentElement.setAttribute('data-theme', themeName);
    localStorage.setItem(THEME_KEY, themeName);

    document.querySelectorAll('.theme-option').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.themeValue === themeName);
    });
}

function applyDarkMode(isDark) {
    document.body.classList.toggle('dark-mode', isDark);
    localStorage.setItem(DARK_KEY, isDark ? '1' : '0');
    // Swap the sidebar icon so it shows what clicking will do next.
    if (themeBtnSidebar && window.icon) {
        themeBtnSidebar.innerHTML = window.icon(isDark ? 'sun' : 'moon', { size: 17 });
    }
}

// Appearance: Light / Dark / System. The three colour themes (Ink / Paper /
// Slate) are gone - one considered palette in light and dark is what real
// products ship. 'System' follows the computer's own light/dark setting.
const APPEARANCE_KEY = 'mindsync.appearance';
const systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function currentAppearance() {
    const saved = localStorage.getItem(APPEARANCE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    return localStorage.getItem(DARK_KEY) === '1' ? 'dark' : 'light'; // older setting
}

function setAppearance(mode) {
    localStorage.setItem(APPEARANCE_KEY, mode);
    applyDarkMode(mode === 'dark' || (mode === 'system' && !!(systemDark && systemDark.matches)));
    document.querySelectorAll('[data-appearance]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.appearance === mode);
    });
}

function toggleTheme() {
    setAppearance(document.body.classList.contains('dark-mode') ? 'light' : 'dark');
}

if (themeBtnSidebar) themeBtnSidebar.addEventListener('click', toggleTheme);
if (darkToggleSettings) darkToggleSettings.addEventListener('click', toggleTheme);
document.querySelectorAll('[data-appearance]').forEach((btn) => {
    btn.addEventListener('click', () => setAppearance(btn.dataset.appearance));
});

// Language (i18n.js): switching reloads the page in the other language.
// The sidebar's language button offers the other language (30/9).
const sidebarLangBtn = document.getElementById('sidebar-lang-btn');
if (sidebarLangBtn) {
    const other = I18N.lang === 'he' ? 'en' : 'he';
    sidebarLangBtn.dataset.lang = other;
    sidebarLangBtn.lang = other;
    sidebarLangBtn.dir = other === 'he' ? 'rtl' : 'ltr';
    document.getElementById('sidebar-lang-name').textContent = other === 'he' ? 'עברית' : 'English';
    // translate="no" keeps the NAME as written; the tooltip is in the page's language.
    sidebarLangBtn.title = other === 'he' ? 'Switch to Hebrew' : t('Switch to English');
}
document.querySelectorAll('[data-lang]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === I18N.lang);
    btn.addEventListener('click', () => { if (btn.dataset.lang !== I18N.lang) I18N.setLang(btn.dataset.lang); });
});
document.querySelectorAll('.theme-option').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeValue));
});
if (systemDark && systemDark.addEventListener) {
    systemDark.addEventListener('change', () => { if (currentAppearance() === 'system') setAppearance('system'); });
}

// Restore saved preferences on boot.
// One-time: with the redesign, everyone starts on the new default (Blue)
// once; a previously chosen theme is one click away in Settings.
if (!localStorage.getItem('mindsync.themeV2')) {
    localStorage.setItem(THEME_KEY, 'blue');
    localStorage.setItem('mindsync.themeV2', '1');
}
applyTheme(localStorage.getItem(THEME_KEY) || 'blue');
setAppearance(currentAppearance());

// ==========================================
// 3. Focus Mode
// ==========================================
const focusBtn = document.getElementById('focus-btn');
let isFocusMode = false;

// Focus mode CLOSES apps (Discord, Steam...) - testers pressed it without
// knowing that, and a program vanishing unasked breaks trust in everything
// else. Starting it now asks first and names exactly which apps will close.
function setFocusButtonState(on) {
    focusBtn.classList.toggle('is-focus-on', on);
    focusBtn.innerHTML = icon('shield') + (on ? ' Stop focus mode' : ' Start focus mode');
    focusBtn.title = on ? 'Focus mode is on - listed apps are being closed' : 'Closes distracting apps while you study';
}

if (focusBtn) {
    focusBtn.title = 'Closes distracting apps while you study';
    focusBtn.addEventListener('click', async () => {
        if (isFocusMode) {
            isFocusMode = false;
            ipcRenderer.send('toggle-blocking', false);
            setFocusButtonState(false);
            toast.info('Focus mode is off.');
            return;
        }

        const apps = (await ipcRenderer.invoke('get-blocked-apps').catch(() => [])) || [];
        if (!apps.length) {
            toast.info('No apps are on the focus list yet. Add some in Settings → Focus mode.');
            return;
        }
        const names = apps.map(a => String(a).replace(/\.exe$/i, '')).join(', ');
        const ok = await confirmDialog(
            'Start focus mode?',
            `While it's on, these apps will be closed if you open them: ${names}.\n\nSave anything open in them first. You can change the list in Settings.`,
            { confirmText: 'Start focus mode' }
        );
        if (!ok) return;

        isFocusMode = true;
        ipcRenderer.send('toggle-blocking', true);
        setFocusButtonState(true);
    });
}

// ==========================================
// 4. AI Materials
// ==========================================
const uploadBtn = document.querySelector('.btn-upload');
const filesListContainer = document.querySelector('.files-list');

// The AI summary used to be a small modal here. It now lives in its own
// window (summary.html / summary.js) - see 'open-summary-window' in main.js.
// When that window saves a summary, refresh the list so the button reads
// "View summary" instead of "Summarize".
ipcRenderer.on('files-changed', () => {
    if (typeof loadAndRenderFiles === 'function') loadAndRenderFiles();
});

// ==========================================
// 5. Schedule & Weekly Plan
// ==========================================
const addEventBtn = document.getElementById('add-event-btn'); 
const triggerAddEventWeekly = document.getElementById('trigger-add-event'); 
const addEventModal = document.getElementById('add-event-modal');
const cancelEventBtn = document.getElementById('cancel-event-btn');
const saveEventBtn = document.getElementById('save-event-btn');
const scheduleList = document.querySelector('.daily-schedule-list');

function openAddEventModal() {
    // After an edit the box still held that item's sentence - "Add" then
    // added it a second time (30/9). A new add starts empty.
    const wasEditing = !!editingEvent;
    setEventModalMode(null);
    addEventModal.style.display = 'flex';
    const box = document.getElementById('smart-event-input');
    if (box) { if (wasEditing) box.value = ''; box.focus(); }
}
if(addEventBtn) addEventBtn.addEventListener('click', openAddEventModal);
if(triggerAddEventWeekly) triggerAddEventWeekly.addEventListener('click', openAddEventModal);
if(cancelEventBtn) cancelEventBtn.addEventListener('click', closeAddEventModal);

const typeStyles = {
    // Reference the shared tokens so these can't drift from the legend.
    lesson:   { bg: 'color-mix(in srgb, var(--event-lesson) 15%, transparent)',   border: 'var(--event-lesson)' },
    exam:     { bg: 'color-mix(in srgb, var(--event-exam) 20%, transparent)',     border: 'var(--event-exam)' },
    study:    { bg: 'color-mix(in srgb, var(--event-study) 15%, transparent)',    border: 'var(--event-study)' },
    personal: { bg: 'color-mix(in srgb, var(--event-personal) 15%, transparent)', border: 'var(--event-personal)' }
};

const weeklyClassMap = {
    lesson: 'task-lesson',
    exam: 'task-exam',
    study: 'task-free',
    personal: 'task-personal'
};

// UX: same "jump to related content" idea as tasks (see getLearningDestination
// below), but for calendar events. Events have no category field, just a
// title and a type, so a lesson matches by the folder name appearing inside
// its title (lesson titles tend to name the course), while study/exam events
// go straight to Study since that's what preparing for them means.
function getEventLearningDestination(evt, folders) {
    const title = (evt.title || '').toLowerCase();
    const folder = folders.find(f => f.name && title.includes(f.name.trim().toLowerCase()));
    if (folder) return { type: 'materials', folderName: folder.name };
    if (evt.type === 'study' || evt.type === 'exam') return { type: 'study' };
    return null;
}

// Shared by both the task list and the calendar views below.
function goToLearningDestination(dest) {
    if (!dest) return;
    if (dest.type === 'materials') {
        document.getElementById('nav-materials').click();
        currentActiveFolder = dest.folderName;
        loadAndRenderFolders();
        loadAndRenderFiles();
    } else {
        document.getElementById('nav-study').click();
    }
}

// Builds one event row - shared by every day group below, so each one
// looks and behaves identically (same delete button, same "go to related"
// button) without duplicating the markup per group.
function buildScheduleRow(evt, folders) {
    const style = typeStyles[evt.type] || typeStyles.lesson;
    const dest = getEventLearningDestination(evt, folders);
    const div = document.createElement('div');
    div.className = 'schedule-bar';
    div.style.backgroundColor = style.bg;
    div.style.borderLeft = `4px solid ${style.border}`;

    div.innerHTML = `
        <div class="schedule-info">
            <div class="schedule-circle" style="border-color: ${style.border}; ${evt.type === 'exam' ? `background-color: ${style.border};` : ''}"></div>
            <div class="schedule-time">${escapeHtml(evt.time)}</div>
            <div class="schedule-title" ${evt.type === 'exam' || evt.type === 'study' ? 'style="font-weight: bold;"' : ''}>${escapeHtml(evt.title)}</div>
        </div>
        ${dest ? `<button class="go-to-related-btn" title="${dest.type === 'materials' ? `Open Materials — ${escapeHtml(dest.folderName)}` : 'Open in Study'}" aria-label="Go to related content">${icon(dest.type === 'materials' ? 'library' : 'brain')}</button>` : ''}
        <button class="btn-icon btn-icon--danger delete-event-btn" title="Delete event" aria-label="Delete event">${icon('trash')}</button>
    `;

    const goToRelatedBtn = div.querySelector('.go-to-related-btn');
    if (goToRelatedBtn) {
        goToRelatedBtn.onclick = (e) => {
            e.stopPropagation();
            goToLearningDestination(dest);
        };
    }

    const deleteBtn = div.querySelector('.delete-event-btn');
    deleteBtn.addEventListener('mouseenter', () => deleteBtn.style.opacity = '1');
    deleteBtn.addEventListener('mouseleave', () => deleteBtn.style.opacity = '0.5');

    deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        deleteBtn.disabled = true;
        const delRes = await ipcRenderer.invoke('delete-event', evt.id).catch(err => ({ error: err.message }));
        if (delRes && delRes.error) { deleteBtn.disabled = false; toast.error(delRes.error, t('Could not delete')); return; }
        await loadAndRenderEvents();
        await loadAndRenderWeeklyBoard();
        await loadAndRenderHome();
    });

    return div;
}

// BUG FIX: this used to render every event in one flat list, sorted only by
// clock time (that's all the server's GET /events does) - never by day. So
// a Sunday 09:00 event showed before a Wednesday 20:00 one, and "My Day"
// read as an unsorted dump rather than "today, then what's coming". This
// groups by day starting from today and wrapping through the week, each
// group sorted by time within itself - so today is first and complete,
// Saturday shows up clearly under its own heading instead of buried
// somewhere in time order, and the redundant "(day)" label per row is gone
// now that the heading already says which day it is.
async function loadAndRenderEvents() {
    // The "My Day" list this renders into was folded into Weekly Plan. Kept
    // as a no-op so existing callers don't need touching, but it no longer
    // fetches events for a list that isn't on the page.
    if (!scheduleList) return;
    const events = await ipcRenderer.invoke('get-events');
    const folders = await ipcRenderer.invoke('get-folders').catch(() => []);
    if (scheduleList) scheduleList.innerHTML = '';

    if (events.length === 0 && scheduleList) {
        renderEmptyState(scheduleList, {
            icon: 'calendar',
            title: 'Your schedule is empty',
            message: 'Add your lessons, exams and study blocks to see your week at a glance.'
        });
        return;
    }

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayIndex = new Date().getDay();

    for (let offset = 0; offset < 7; offset++) {
        const dayName = dayNames[(todayIndex + offset) % 7];
        const dayEvents = events
            .filter(e => e.day === dayName)
            .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

        if (dayEvents.length === 0) continue;

        if (scheduleList) {
            const heading = document.createElement('div');
            heading.className = 'schedule-day-heading';
            heading.textContent = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : dayName;
            scheduleList.appendChild(heading);

            dayEvents.forEach(evt => scheduleList.appendChild(buildScheduleRow(evt, folders)));
        }
    }
}

// ---- Dates on events ----
// An event WITH a date happens once, on that date. An event without one
// repeats every week on its day (classes). Before dates existed, every
// event repeated - an exam, or "submit on 26/10", landed on this week's
// weekday and came back every week. One helper decides "does this event
// happen on this day?" so the board, Home and reminders can't disagree.
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Local YYYY-MM-DD (toISOString is UTC - in Israel that's "yesterday"
// for the first hours of every day).
function localIsoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The other weekly classes added by the same timetable upload. Ones added
// before uploads had an importId (October 2026 - the cut-off leaves time for
// the change to ship): those that end on the same day
// (one semester's end date is given to the whole upload) - only lessons with
// an end date, and only from then: a class added by a sentence has no
// importId either, and isn't part of any upload.
const IMPORT_ID_SINCE = '2026-10-15';
function timetableSiblings(evt, events) {
    if (evt.date || evt.type !== 'lesson') return [];
    const legacy = (e) => !e.importId && !!e.until && String(e.createdAt || '') < IMPORT_ID_SINCE;
    return (events || []).filter(e => e.id !== evt.id && !e.date && e.type === 'lesson' &&
        (evt.importId ? e.importId === evt.importId : (legacy(evt) && legacy(e) && e.until === evt.until)));
}

function eventOccursOn(evt, date) {
    if (evt.date) return evt.date === localIsoDate(date);
    // Weekly: every week on its day, up to and including `until` if it has
    // one, and from `from` (a semester that hasn't begun yet) if it has one.
    const iso = localIsoDate(date);
    if (evt.until && iso > evt.until) return false;
    if (evt.from && iso < evt.from) return false;
    return evt.day === WEEKDAY_NAMES[date.getDay()];
}

// "20 / 25" kept left to right (LRI...PDI): in a Hebrew line the slash
// flipped it to "25 / 20".
const outOfLabel = (got, max) => `\u2066${got} / ${max}\u2069`;

// el.textContent = text, with its formulas drawn (math.js; plain text if it
// isn't loaded). Not for code - its $ are never maths.
const setMathText = (el, text) => { if (window.MathText) window.MathText.setText(el, text); else el.textContent = String(text == null ? '' : text); };

// "2027-01-15" -> "15 Jan" / "15 בינו׳" when it's within the coming year (no
// doubt which one is meant, and it fits a narrow Planner column), else with
// the year. The month in words: "15/1" reads as the 1st of month 15 to
// anyone used to month-first dates, and English is month-first.
const UNTIL_MONTHS = {
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    he: ['בינו׳', 'בפבר׳', 'במרץ', 'באפר׳', 'במאי', 'ביוני', 'ביולי', 'באוג׳', 'בספט׳', 'באוק׳', 'בנוב׳', 'בדצמ׳']
};
function untilLabel(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    const days = (new Date(y, m - 1, d) - new Date()) / 86400000;
    const month = UNTIL_MONTHS[I18N.lang === 'he' ? 'he' : 'en'][m - 1] || m;
    return days > -60 && days < 330 ? `${d} ${month}` : `${d} ${month} ${y}`;
}

// Sunday of the week `offset` weeks away from this one (0 = this week).
function weekStartFor(offset) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay() + offset * 7);
    return d;
}

// Tasks carry a real date (DD/MM/YYYY string, or a dueDate). Returns null
// for "Not set" / unparseable.
function parseTaskDueDate(task) {
    if (task.dueDate) {
        const d = new Date(task.dueDate);
        if (!isNaN(d)) return d;
    }
    if (!task.date || task.date === 'Not set') return null;
    const parts = String(task.date).split('/').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    const [dd, mm, yyyy] = parts;
    const d = new Date(yyyy, mm - 1, dd);
    return isNaN(d) ? null : d;
}

const WEEKLY_SHOW_TASKS_KEY = 'mindsync.weeklyShowTasks';
const weeklyShowTasksToggle = document.getElementById('weekly-show-tasks');
if (weeklyShowTasksToggle) {
    weeklyShowTasksToggle.checked = localStorage.getItem(WEEKLY_SHOW_TASKS_KEY) === '1';
    weeklyShowTasksToggle.addEventListener('change', () => {
        localStorage.setItem(WEEKLY_SHOW_TASKS_KEY, weeklyShowTasksToggle.checked ? '1' : '0');
        // Tasks are already downloaded - just redraw.
        if (weeklyData) renderWeeklyBoard(); else loadAndRenderWeeklyBoard();
    });
}

// BUG FIX: when two refreshes overlap (a delete finishing while another
// refresh is still waiting for the server - more likely with Google sync,
// where each action takes longer), the one that ASKED first could ANSWER
// last and draw the older data over the newer. The board then showed a
// deleted event, or missed an added one, until a manual refresh. Each call
// now takes a ticket; a call whose ticket isn't the latest one any more
// throws its (stale) data away instead of drawing it.
let weeklyRenderTicket = 0;

// Which week the board shows: 0 = this week, 1 = next, -1 = last.
// BUG FIX: the board could only ever show this week, so a task due 27/10
// (or anything dated) had nowhere to appear.
let weeklyWeekOffset = 0;

// PERFORMANCE: moving between weeks used to re-download every event, task
// and folder from the server on each click - a visible lag per click (more
// on a Render cold start). The data doesn't change when you change weeks,
// only the part of it on screen does. So the last download is kept here and
// the arrows redraw from it instantly; a real download happens only when
// something changed (add / delete / plan / arriving on this screen).
let weeklyData = null; // { events, folders, tasks }

// Jumps the board to the week containing `date`. Optional `highlightId`
// makes that card flash once it's drawn, so the eye finds it.
function showWeekOf(date, highlightId = null) {
    const start = weekStartFor(0);
    const target = new Date(date); target.setHours(0, 0, 0, 0);
    weeklyWeekOffset = Math.floor(Math.round((target - start) / 86400000) / 7);
    weeklyHighlightId = highlightId;
    if (!weeklyData) return loadAndRenderWeeklyBoard();
    renderWeeklyBoard();
    return Promise.resolve();
}
let weeklyHighlightId = null;

const weekPrevBtn = document.getElementById('week-prev');
const weekNextBtn = document.getElementById('week-next');
const weekTodayBtn = document.getElementById('week-today');
function changeWeek(to) {
    weeklyWeekOffset = to;
    if (weeklyData) renderWeeklyBoard(); else loadAndRenderWeeklyBoard();
}
if (weekPrevBtn) weekPrevBtn.onclick = () => changeWeek(weeklyWeekOffset - 1);
if (weekNextBtn) weekNextBtn.onclick = () => changeWeek(weeklyWeekOffset + 1);
if (weekTodayBtn) weekTodayBtn.onclick = () => changeWeek(0);

const shortDate = (d) => `${d.getDate()}/${d.getMonth() + 1}`;

function renderWeekNav(weekStart, weekEnd) {
    const label = document.getElementById('week-label');
    if (label) {
        const name = weeklyWeekOffset === 0 ? 'This week' : weeklyWeekOffset === 1 ? 'Next week' : weeklyWeekOffset === -1 ? 'Last week' : '';
        label.textContent = `${name ? name + ' · ' : ''}${shortDate(weekStart)} – ${shortDate(weekEnd)}`;
    }
    // "Back to today" is always shown (it used to appear only away from the
    // current week, and was easy to miss). Marked when you're already there.
    if (weekTodayBtn) weekTodayBtn.classList.toggle('is-current', weeklyWeekOffset === 0);

    renderUpcoming();
}

// ---- "Coming up": a quick way to reach what you've added ----
// Paging week by week to find something a month away is slow. This list
// shows the next one-time items (exams, deadlines, dated events) and open
// tasks with a due date, soonest first; clicking one jumps straight to its
// week and flashes the card. Weekly items (↻) are everywhere already, and
// blocks the planner placed are its own, so neither is listed.
const upcomingBtn = document.getElementById('week-upcoming-btn');
const upcomingPanel = document.getElementById('week-upcoming-panel');
const UPCOMING_LIMIT = 15;

function collectUpcoming() {
    if (!weeklyData) return [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const items = [];
    weeklyData.events.forEach(e => {
        if (!e.date || e.autoScheduled) return;
        const [y, m, d] = e.date.split('-').map(Number);
        const date = new Date(y, m - 1, d);
        if (date < today) return;
        items.push({ id: e.id, date, time: e.time || '', title: e.title, kind: EVENT_TYPE_LABELS[e.type] || 'Personal', isTask: false });
    });
    weeklyData.tasks.forEach(t => {
        if (t.status === 'completed') return;
        const due = parseTaskDueDate(t);
        if (!due) return;
        due.setHours(0, 0, 0, 0);
        if (due < today) return; // overdue ones already sit in today's column
        items.push({ id: t.id, date: due, time: '', title: t.title, kind: 'Task', isTask: true });
    });
    return items
        .sort((a, b) => (a.date - b.date) || a.time.localeCompare(b.time))
        .slice(0, UPCOMING_LIMIT);
}

function renderUpcoming() {
    if (!upcomingBtn) return;
    const items = collectUpcoming();
    upcomingBtn.innerHTML = (items.length ? `Coming up (${items.length}${items.length === UPCOMING_LIMIT ? '+' : ''})` : 'Coming up')
        + icon('chevronDown', { size: 14 });
    if (!upcomingPanel || upcomingPanel.hidden) return;

    upcomingPanel.innerHTML = '';
    if (!items.length) {
        upcomingPanel.innerHTML = '<div class="week-upcoming__empty">Nothing dated coming up. Exams, deadlines and tasks with a date will show here.</div>';
        return;
    }
    items.forEach(it => {
        const row = document.createElement('button');
        row.className = 'week-upcoming__row';
        const day = WEEKDAY_NAMES[it.date.getDay()].slice(0, 3);
        row.innerHTML = `
            <span class="week-upcoming__date">${day} ${shortDate(it.date)}${it.time ? ' · ' + escapeHtml(it.time) : ''}</span>
            <span class="week-upcoming__title" dir="auto">${escapeHtml(it.title)}</span>
            <span class="week-upcoming__kind week-upcoming__kind--${it.isTask ? 'task' : it.kind.toLowerCase().replace(/\s+/g, '-')}">${it.kind}</span>`;
        row.onclick = () => {
            closeUpcoming();
            // A task is only on the board with "Show tasks" on - turn it on
            // rather than jump to a week where the task isn't drawn.
            if (it.isTask && weeklyShowTasksToggle && !weeklyShowTasksToggle.checked) {
                weeklyShowTasksToggle.checked = true;
                localStorage.setItem(WEEKLY_SHOW_TASKS_KEY, '1');
            }
            showWeekOf(it.date, it.id);
        };
        upcomingPanel.appendChild(row);
    });
}

function closeUpcoming() {
    if (upcomingPanel) upcomingPanel.hidden = true;
    if (upcomingBtn) upcomingBtn.setAttribute('aria-expanded', 'false');
}
if (upcomingBtn && upcomingPanel) {
    upcomingBtn.setAttribute('aria-expanded', 'false');
    upcomingBtn.onclick = (e) => {
        e.stopPropagation();
        const opening = upcomingPanel.hidden;
        upcomingPanel.hidden = !opening;
        upcomingBtn.setAttribute('aria-expanded', String(opening));
        if (opening) renderUpcoming();
    };
    upcomingPanel.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', closeUpcoming);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUpcoming(); });
}

// Downloads fresh data, then draws. Every existing caller (after an add,
// a delete, a plan, arriving on the screen) keeps using this one.
async function loadAndRenderWeeklyBoard() {
    if (!document.querySelectorAll('.day-column').length) return;

    const myTicket = ++weeklyRenderTicket;
    // Tasks are always fetched now (cheap), so "Show tasks" and the Coming
    // up list work instantly without another trip to the server.
    const [events, folders, tasks] = await Promise.all([
        ipcRenderer.invoke('get-events'),
        ipcRenderer.invoke('get-folders').catch(() => []),
        ipcRenderer.invoke('get-tasks').catch(() => [])
    ]);
    if (myTicket !== weeklyRenderTicket) return; // a newer refresh is on its way
    weeklyData = { events: events || [], folders: folders || [], tasks: tasks || [] };
    renderWeeklyBoard();
}

// Draws the viewed week from the last download. No server call - this is
// what the week arrows use, so they're instant.
function renderWeeklyBoard() {
    const dayColumns = document.querySelectorAll('.day-column');
    if (!dayColumns.length || !weeklyData) return;
    const showTasks = !!(weeklyShowTasksToggle && weeklyShowTasksToggle.checked);
    const { events, folders } = weeklyData;
    const tasks = showTasks ? weeklyData.tasks : [];

    const legendTask = document.getElementById('legend-task');
    // visibility, not hidden/display: the item keeps its space either way,
    // so toggling doesn't shift the toggle or the rest of the row.
    if (legendTask) legendTask.style.visibility = showTasks ? 'visible' : 'hidden';

    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    // Sunday to Saturday of the week being viewed. Each column gets its
    // real date, so a task due on the 18th has an obvious place to go.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekStart = weekStartFor(weeklyWeekOffset);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
    renderWeekNav(weekStart, weekEnd);

    dayColumns.forEach((column, index) => {
        const colDate = new Date(weekStart);
        colDate.setDate(weekStart.getDate() + index);
        const isToday = colDate.getTime() === today.getTime();

        column.innerHTML = '';
        column.classList.toggle('is-today', isToday);

        const header = document.createElement('div');
        header.className = 'day-header';
        // "MON 28" like a calendar; today's number sits in an accent circle.
        header.title = `${days[index]} ${colDate.getDate()}/${colDate.getMonth() + 1}${isToday ? ' (today)' : ''}`;
        header.innerHTML = `
            <div class="day-header__name">${days[index].slice(0, 3)}</div>
            <div class="day-header__date">${colDate.getDate()}</div>`;
        column.appendChild(header);

        // Sorted by time - the server only ever returned them in insertion
        // order within a day, so 18:00 could sit above 09:00.
        const dayEvents = events
            .filter(e => eventOccursOn(e, colDate))
            .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

        dayEvents.forEach(evt => {
            const dest = getEventLearningDestination(evt, folders);
            const taskCard = document.createElement('div');
            taskCard.className = `task-card ${weeklyClassMap[evt.type] || 'task-lesson'}`;
            taskCard.style.position = 'relative';
            taskCard.dataset.id = evt.id;

            // ↻ marks the weekly ones, so it's obvious which cards are "every
            // Monday" and which are "this Monday only".
            const weekly = !evt.date;
            taskCard.innerHTML = `
                <div class="task-card__actions">
                    <button class="btn-icon edit-weekly-btn" title="${weekly ? 'Edit - changes it in every week' : 'Edit'}" aria-label="Edit">${icon('edit')}</button>
                    <button class="btn-icon btn-icon--danger delete-weekly-btn" title="${weekly ? 'Delete - removes it from every week' : 'Delete from calendar'}" aria-label="Delete from calendar">${icon('trash')}</button>
                </div>
                <div class="task-time">${escapeHtml(evt.time)}${weekly ? ` <span class="task-repeat" title="${escapeHtml(evt.until ? t('Every week until {d}', { d: untilLabel(evt.until) }) : t('Every week'))}">↻${evt.until ? ` ${escapeHtml(t('until {d}', { d: untilLabel(evt.until) }))}` : ''}</span>` : ''}</div>
                <div class="task-card__title" dir="auto">${escapeHtml(evt.title)}</div>
                ${evt.location ? `<div class="task-card__location" dir="auto" title="${escapeHtml(evt.location)}">${escapeHtml(evt.location)}</div>` : ''}
            `;

            // Clicking a study/exam event (or one whose title names a
            // Materials folder) jumps straight to the relevant place.
            if (dest) {
                taskCard.style.cursor = 'pointer';
                taskCard.title = dest.type === 'materials' ? `Open Materials — ${dest.folderName}` : 'Open in Study';
                taskCard.onclick = () => goToLearningDestination(dest);
            }

            const editBtn = taskCard.querySelector('.edit-weekly-btn');
            editBtn.onclick = (e) => {
                e.stopPropagation(); // the card itself may open Study/Materials
                openEditEventModal(evt);
            };

            // (Hover opacity now lives in CSS, for both buttons.)
            const delBtn = taskCard.querySelector('.delete-weekly-btn');
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                // Asked first (30/9): a weekly class goes from EVERY week.
                // A class from a timetable upload can take the rest of that
                // upload with it - a wrong upload was 12 deletes, one by one.
                const siblings = weekly ? timetableSiblings(evt, events) : [];
                const ok = await confirmDialog(
                    weekly ? t('Delete "{name}" from every week?', { name: evt.title }) : t('Delete "{name}"?', { name: evt.title }),
                    evt.googleEventId ? t('It is removed from Google Calendar too.') : '',
                    {
                        confirmText: t('Delete'), danger: true,
                        checkbox: siblings.length ? t(siblings.length === 1 ? 'Also delete the other class from the same timetable' : `Also delete the other ${siblings.length} classes from the same timetable`) : null
                    });
                if (!ok) return;
                delBtn.disabled = true;
                const all = !!ok.checked;
                const delRes = all
                    ? await ipcRenderer.invoke('delete-events', [evt.id, ...siblings.map(e => e.id)]).catch(err => ({ error: err.message }))
                    : await ipcRenderer.invoke('delete-event', evt.id).catch(err => ({ error: err.message }));
                if (delRes && delRes.error) { delBtn.disabled = false; toast.error(delRes.error, t('Could not delete')); return; }
                if (all && delRes.errors && delRes.errors.length) {
                    toast.warning(delRes.errors[0], t(`${delRes.errors.length} classes could not be deleted`));
                }
                await loadAndRenderWeeklyBoard();
                await loadAndRenderHome();
            };

            column.appendChild(taskCard);
        });

        if (showTasks) {
            // Open tasks due on this column's date. Overdue ones (due before
            // today, still open) go in TODAY's column, flagged - otherwise
            // anything missed simply disappeared from the week.
            const dayTasks = tasks.filter(t => {
                if (t.status === 'completed') return false;
                const due = parseTaskDueDate(t);
                if (!due) return false;
                due.setHours(0, 0, 0, 0);
                if (isToday && due < today) return true;
                return due.getTime() === colDate.getTime();
            });

            dayTasks.forEach(t => {
                const due = parseTaskDueDate(t);
                if (due) due.setHours(0, 0, 0, 0);
                const overdue = !!(due && due < today);
                const urgency = String(t.urgency || 'Normal').toLowerCase();

                const card = document.createElement('div');
                card.className = `board-task board-task--${urgency}${overdue ? ' is-overdue' : ''}`;
                card.dataset.id = t.id;
                card.title = `${t.urgency && t.urgency !== 'Normal' ? t.urgency + ' urgency · ' : ''}Open in Tasks`;
                card.innerHTML = `
                    <span class="board-task__check" aria-hidden="true"></span>
                    <span class="board-task__body">
                        <span class="board-task__title" dir="auto">${escapeHtml(t.title)}</span>
                        ${overdue ? `<span class="board-task__meta">Overdue · ${due.getDate()}/${due.getMonth() + 1}</span>` : ''}
                    </span>`;
                card.onclick = () => document.getElementById('nav-tasks').click();
                column.appendChild(card);
            });
        }

        if (column.children.length === 1) {
            const empty = document.createElement('div');
            empty.className = 'day-empty';
            empty.textContent = 'Free';
            column.appendChild(empty);
        }
    });

    // Arrived here from "Coming up" (or right after adding): flash the card.
    if (weeklyHighlightId) {
        const wanted = String(weeklyHighlightId);
        const target = [...document.querySelectorAll('.weekly-board [data-id]')].find(el => el.dataset.id === wanted);
        weeklyHighlightId = null;
        if (target) {
            if (target.scrollIntoView) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            target.classList.add('is-flash');
            setTimeout(() => target.classList.remove('is-flash'), 1600);
        }
    }
}

// ---- Add to calendar: AI only ----
// Write it the way you'd say it; it's read and saved in one go. There used
// to be a second step with editable name/day/time/type fields - removed on
// purpose: the point of the app is "say it and it's handled", and a form
// after every sentence undoes that. The safety net is the toast instead: it
// spells out exactly what was understood, and Undo takes it all back
// (including the Google Calendar copy).
const EVENT_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EVENT_TYPE_LABELS = { lesson: 'Class', exam: 'Exam', study: 'Study block', personal: 'Personal' };

function closeAddEventModal() {
    addEventModal.style.display = 'none';
    const t = document.getElementById('smart-event-input');
    if (t) t.value = '';
    setEventModalMode(null);
}

// ---- Edit a calendar item: AI only, like adding ----
// The item is written back into the box as a sentence - "שיעור סטטיסטיקה
// כל יום שני ב-10:00" or "מבחן ב-26.10.2026 ב-09:00" - you change the words
// (another time, day or date, a new name) and the AI reads it again. No
// pickers, same as adding. The toast says what it understood, with Undo.
const HEBREW_DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
let editingEvent = null;
let addModeSyncChecked = true; // remembered while the box is in edit mode

// The sentence the parser reads back as exactly this event. The year is
// always written: without it, a date that has already passed would be read
// as next year's.
function eventToSentence(evt) {
    const at = `ב-${evt.time}`;
    if (evt.date) {
        const [y, m, d] = String(evt.date).split('-').map(Number);
        return `${evt.title} ב-${d}.${m}.${y} ${at}`;
    }
    const dayIdx = EVENT_DAYS.indexOf(evt.day);
    // The year is always written, so a date early next year isn't misread.
    const until = evt.until ? (() => { const [y, m, d] = evt.until.split('-').map(Number); return ` עד ${d}.${m}.${y}`; })() : '';
    return `${evt.title} כל יום ${HEBREW_DAY_NAMES[dayIdx >= 0 ? dayIdx : 0]} ${at}${until}`;
}

// Switches the one modal between "add" (evt = null) and "edit this item".
function setEventModalMode(evt) {
    const title = document.getElementById('event-modal-title');
    const help = document.getElementById('event-modal-help');
    const syncLabel = document.getElementById('sync-google-label');
    const syncCheck = document.getElementById('sync-google-check');

    if (evt && !editingEvent && syncCheck) addModeSyncChecked = syncCheck.checked;
    if (!evt && editingEvent && syncCheck) syncCheck.checked = addModeSyncChecked;
    editingEvent = evt || null;

    if (title) title.textContent = evt ? 'Edit' : 'Add to your calendar';
    if (help) {
        help.textContent = !evt
            ? 'A class, an exam, anything at a set time - write it the way you\'d say it.'
            : evt.date
                ? 'Change the words - a new time, date or name - and save.'
                : 'This repeats every week, so a change applies to every week. Change the words - a new time, day or name, or "עד 15.1" to stop it on a date - and save.';
    }
    if (syncLabel) syncLabel.textContent = evt ? 'Also in Google Calendar' : 'Also add to Google Calendar';
    if (evt && syncCheck) syncCheck.checked = !!evt.googleEventId;
    // Web, not connected yet: start unticked (ticking it connects - see wireGoogleCheckbox).
    if (IS_WEB && !evt && syncCheck && !googleConnected()) syncCheck.checked = false;
    if (saveEventBtn) saveEventBtn.textContent = evt ? 'Save changes' : 'Add';
}

function openEditEventModal(evt) {
    setEventModalMode(evt);
    addEventModal.style.display = 'flex';
    const t = document.getElementById('smart-event-input');
    if (t) {
        t.value = eventToSentence(evt);
        t.focus();
        t.setSelectionRange(t.value.length, t.value.length);
    }
}

async function saveEventEdit(text) {
    const before = editingEvent;
    const syncCheck = document.getElementById('sync-google-check');
    const syncToGoogle = !!(syncCheck && syncCheck.checked);

    const originalText = saveEventBtn.textContent;
    saveEventBtn.textContent = 'Reading…';
    saveEventBtn.disabled = true;

    let res;
    try {
        let parsed = JSON.parse(await ipcRenderer.invoke('parse-smart-event', text));
        if (parsed && parsed.error) { toast.error(parsed.error); return; }
        if (Array.isArray(parsed)) parsed = parsed[0];
        if (!parsed || !String(parsed.title || '').trim() || !EVENT_DAYS.includes(parsed.day) || !/^\d{2}:\d{2}$/.test(parsed.time || '')) {
            toast.error('Could not tell what or when. Keep the day or date and the time in the sentence, e.g. "ביום שלישי ב-18:00".');
            return;
        }

        const newTitle = String(parsed.title).trim();
        const changes = {
            title: newTitle,
            day: parsed.day,
            date: parsed.date || null,
            until: parsed.until || null,
            time: parsed.time,
            // Same name -> same type. Re-classifying an unchanged title could
            // only turn a correct type into a wrong one.
            type: newTitle === before.title ? before.type : (EVENT_TYPE_LABELS[parsed.type] ? parsed.type : 'personal')
        };

        const unchanged = ['title', 'day', 'time', 'type'].every(k => changes[k] === before[k])
            && (changes.date || null) === (before.date || null)
            && (changes.until || null) === (before.until || null)
            && syncToGoogle === !!before.googleEventId;
        if (unchanged) {
            closeAddEventModal();
            toast.info('Nothing to change.');
            return;
        }

        saveEventBtn.textContent = 'Saving…';
        res = await ipcRenderer.invoke('update-event', before.id, changes, { syncToGoogle });
        if (!res || res.error) {
            toast.error((res && res.error) || 'Please try again.', 'Could not save the change');
            return;
        }
    } catch (e) {
        toast.error('Something went wrong reading that. Please try again.');
        console.error(e);
        return;
    } finally {
        saveEventBtn.textContent = originalText;
        saveEventBtn.disabled = false;
    }

    closeAddEventModal();
    const after = res.event;
    // A one-time item moved to another week: go there, the way adding does.
    if (after.date) {
        const [y, m, d] = after.date.split('-').map(Number);
        weeklyWeekOffset = Math.floor(Math.round((new Date(y, m - 1, d) - weekStartFor(0)) / 86400000) / 7);
    }
    weeklyHighlightId = after.id;
    await loadAndRenderWeeklyBoard();
    await loadAndRenderHome();

    showUndoToast(`Changed: ${describeEvent(after)}`, async () => {
        const p = res.previous;
        const undo = await ipcRenderer.invoke('update-event', p.id, {
            title: p.title,
            day: p.day,
            date: p.date || null,
            until: p.until || null,
            time: p.time,
            type: p.type,
            durationMinutes: p.durationMinutes ?? null,
            autoScheduled: !!p.autoScheduled
        }, { syncToGoogle: !!p.googleEventId });
        if (undo && undo.error) toast.error(undo.error, 'Could not undo');
        await loadAndRenderWeeklyBoard();
        await loadAndRenderHome();
    });
    if (res.googleSyncError) toast.warning(`Changed in MindSync, but not in Google Calendar: ${res.googleSyncError}`);
}

function describeEvent(evt) {
    // Says plainly whether it's once (with the date) or every week.
    let when = `every ${evt.day}${evt.until ? ` until ${untilLabel(evt.until)}` : ''}`;
    if (evt.date) {
        const [y, m, d] = evt.date.split('-').map(Number);
        when = `${evt.day} ${shortDate(new Date(y, m - 1, d))}`;
    }
    return `${evt.title} · ${when} ${evt.time} · ${EVENT_TYPE_LABELS[evt.type] || 'Personal'}`;
}

if (saveEventBtn) {
    saveEventBtn.addEventListener('click', async () => {
        const textInput = document.getElementById('smart-event-input');
        const text = textInput ? textInput.value.trim() : '';
        if (!text) { toast.warning('Write what you have planned first.'); return; }
        if (editingEvent) { await saveEventEdit(text); return; }

        const syncCheck = document.getElementById('sync-google-check');
        const syncToGoogle = !!(syncCheck && syncCheck.checked);

        const originalText = saveEventBtn.innerText;
        saveEventBtn.innerText = 'Reading…';
        saveEventBtn.disabled = true;

        const saved = [];
        const saveErrors = [];
        const syncErrors = [];
        try {
            const response = await ipcRenderer.invoke('parse-smart-event', text);
            let parsed = JSON.parse(response);
            if (parsed && parsed.error) { toast.error(parsed.error); return; }
            if (!Array.isArray(parsed)) parsed = [parsed];

            // Only rows the parser actually filled in; the server would
            // reject the rest anyway.
            const events = parsed
                .filter(e => e && String(e.title || '').trim() && EVENT_DAYS.includes(e.day) && /^\d{2}:\d{2}$/.test(e.time || ''))
                .map(e => ({ ...e, title: String(e.title).trim(), type: EVENT_TYPE_LABELS[e.type] ? e.type : 'personal' }));
            if (!events.length) {
                toast.error('Could not tell what or when. Try including the day and the time, e.g. "ביום שלישי ב-18:00".');
                return;
            }

            saveEventBtn.innerText = syncToGoogle ? 'Saving and syncing…' : 'Saving…';
            for (const evt of events) {
                if (syncToGoogle) {
                    const result = await ipcRenderer.invoke('add-to-google-calendar', evt);
                    if (result && result.success) evt.googleEventId = result.eventId;
                    else syncErrors.push(result ? result.error : 'unknown error');
                }
                const res = await ipcRenderer.invoke('save-event', evt);
                if (res && res.error) saveErrors.push(res.error);
                else saved.push({ ...evt, id: res && (res.id || res._id) });
            }
        } catch (e) {
            toast.error('Something went wrong reading that. Please try again.');
            console.error(e);
            return;
        } finally {
            saveEventBtn.innerText = originalText;
            saveEventBtn.disabled = false;
        }

        if (!saved.length) {
            toast.error(saveErrors[0] || 'Please try again.', 'Nothing was added');
            return;
        }

        closeAddEventModal();
        // Show the week it landed in - "26/10" added while looking at
        // September should be seen, not just announced.
        if (saved[0].date) {
            const [y, m, d] = saved[0].date.split('-').map(Number);
            const dt = new Date(y, m - 1, d);
            const start = weekStartFor(0);
            weeklyWeekOffset = Math.floor(Math.round((dt - start) / 86400000) / 7);
        }
        weeklyHighlightId = saved[0].id;
        await loadAndRenderWeeklyBoard(); // fresh data - the new item has to be in it
        await loadAndRenderHome();
        if (typeof refreshOnboarding === 'function') refreshOnboarding();

        const summary = saved.length === 1
            ? `Added: ${describeEvent(saved[0])}`
            : `Added ${saved.length}: ${saved.map(describeEvent).join('  |  ')}`;
        showUndoToast(summary, async () => {
            // delete-event removes the Google copy too (googleEventId is on the saved record).
            for (const evt of saved) if (evt.id) await ipcRenderer.invoke('delete-event', evt.id);
            await loadAndRenderWeeklyBoard();
            await loadAndRenderHome();
        });

        if (saveErrors.length) toast.error(saveErrors[0], `${saveErrors.length} item(s) could not be saved`);
        if (syncToGoogle && syncErrors.length) toast.warning(`Saved in MindSync, but not in Google Calendar: ${syncErrors[0]}`);
    });
}

loadAndRenderEvents();
loadAndRenderWeeklyBoard();

// ==========================================
// 6. Task Manager
// ==========================================
const triggerAddTaskBtn = document.getElementById('trigger-add-task');
const addTaskModal = document.getElementById('add-task-modal');
const cancelTaskBtn = document.getElementById('cancel-task-btn');
const saveSmartTaskBtn = document.getElementById('save-smart-task-btn');
const smartTaskInput = document.getElementById('smart-task-input');

if (triggerAddTaskBtn) triggerAddTaskBtn.onclick = async () => {
    addTaskModal.style.display = 'flex';
    smartTaskInput.focus();
    // Populate the datalist so you can reuse an existing category instead of
    // retyping it (and accidentally creating "Exam" vs "exam" duplicates).
    const datalist = document.getElementById('existing-categories');
    if (datalist) {
        const cats = await ipcRenderer.invoke('get-task-categories');
        datalist.innerHTML = (cats || []).map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
    }
};
// ---- Add task: AI only ----
// Same idea as Add to calendar: one step. The AI reads the sentence, the
// task is saved, and the toast says what was understood (name, due date,
// length) with Undo. The old confirm step with a date picker and a length
// menu is gone on purpose. Editing an existing task (the pencil on its
// card) is unchanged.
function closeAddTaskModal() {
    addTaskModal.style.display = 'none';
    smartTaskInput.value = '';
    const categoryInput = document.getElementById('smart-task-category');
    if (categoryInput) categoryInput.value = '';
}

if (cancelTaskBtn) cancelTaskBtn.onclick = closeAddTaskModal;

function describeTask(t) {
    const parts = [t.title];
    if (t.date && t.date !== 'Not set') {
        const [dd, mm] = String(t.date).split('/');
        parts.push(`due ${Number(dd)}/${Number(mm)}`);
    }
    if (t.estimatedMinutes) {
        const m = Number(t.estimatedMinutes);
        parts.push(m % 60 === 0 ? `~${m / 60}h` : m > 60 ? `~${Math.floor(m / 60)}h ${m % 60}m` : `~${m} min`);
    }
    if (t.category) parts.push(t.category);
    return parts.join(' · ');
}

if (saveSmartTaskBtn) {
    saveSmartTaskBtn.onclick = async () => {
        const text = smartTaskInput.value.trim();
        if (!text) {
            toast.warning('Write what needs to be done first.');
            return;
        }

        const categoryInput = document.getElementById('smart-task-category');
        const category = categoryInput ? categoryInput.value.trim() : '';

        const originalText = saveSmartTaskBtn.innerText;
        saveSmartTaskBtn.innerText = 'Adding…';
        saveSmartTaskBtn.disabled = true;

        let preview;
        let created;
        try {
            // Still two calls under the hood (read, then save) so the toast
            // can say exactly what was saved - but no stop for the user.
            const response = await ipcRenderer.invoke('add-smart-task', text, category, { previewOnly: true });
            const result = JSON.parse(response);
            if (result.error || !result.preview || !String(result.preview.title || '').trim()) {
                toast.error(result.error || 'Could not read that. Try writing it a bit differently.');
                return;
            }
            preview = result.preview;
            created = await ipcRenderer.invoke('create-confirmed-task', {
                title: String(preview.title).trim(),
                date: preview.date || 'Not set',
                estimatedMinutes: preview.estimatedMinutes || null,
                category: preview.category || category,
                urgency: 'Normal'
            });
            if (created && created.error) { toast.error(created.error, 'Could not add the task'); return; }
        } catch (e) {
            toast.error('Something went wrong reading that. Please try again.');
            console.error(e);
            return;
        } finally {
            saveSmartTaskBtn.innerText = originalText;
            saveSmartTaskBtn.disabled = false;
        }

        closeAddTaskModal();
        await refreshTasksData();
        await loadAndRenderHome();
        showUndoToast(`Added: ${describeTask({ ...preview, category: preview.category || category })}`, async () => {
            if (created && created.id) await ipcRenderer.invoke('delete-task', created.id);
            await refreshTaskViews();
        });
    };
}

// Escapes user-entered text before it goes into innerHTML, so a task titled
// e.g. "<b>test</b>" renders as literal text instead of injecting markup.
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Progress comes from the server as a virtual field, but we recompute it
// here too so the bar updates instantly on a click without a full refetch.
// Urgency colours come from the design tokens (tokens.css), not literals.
const URGENCY_COLORS = {
    Urgent: 'var(--urgency-urgent)',
    High: 'var(--urgency-high)',
    Medium: 'var(--urgency-medium)',
    Normal: 'var(--text-secondary)'
};

function computeProgress(task) {
    if (!task.subtasks || task.subtasks.length === 0) {
        return { percent: task.status === 'completed' ? 100 : 0, done: 0, total: 0 };
    }
    const done = task.subtasks.filter(s => s.completed).length;
    return { percent: Math.round((done / task.subtasks.length) * 100), done, total: task.subtasks.length };
}


// ==========================================
// Shared task-view helpers
// ==========================================
// One call to refresh everything a task change can affect, so no view is
// ever left showing stale numbers after an edit.
// Re-fetches because the data really changed (add/edit/delete/complete a
// task), but - unlike loadAndRenderTasks() - never shows the skeleton in
// between. For a sub-second refetch, blanking the list and redrawing it a
// moment later reads as flicker, not useful loading feedback; this refills
// the cache and re-renders directly from it, same as a pure filter change.
async function refreshTasksData() {
    const tasksListContainer = document.querySelector('.tasks-list');
    if (!tasksListContainer) return;
    cachedTasksData = await ipcRenderer.invoke('get-tasks') || [];
    cachedFoldersData = await ipcRenderer.invoke('get-folders').catch(() => []) || [];
    renderTasksList();
}

async function refreshTaskViews() {
    await refreshTasksData();
    await loadAndRenderHome();
    await loadAndRenderProgress();
}

// A toast with one action button ("Add exams & deadlines", "Make
// questions"): the app suggesting the next step instead of the user having
// to find it. Stays longer than a normal toast, since it asks something.
// The sentence is English (LTR); wrap Hebrew names in isolate() so a name at
// the start doesn't flip the whole sentence right-to-left.
const isolate = (text) => `\u2068${text}\u2069`;
function showActionToast(message, actionLabel, actionFn, { title = '', duration = 15000 } = {}) {
    const container = document.querySelector('.ms-toast-container') || (() => {
        const c = document.createElement('div');
        c.className = 'ms-toast-container';
        document.body.appendChild(c);
        return c;
    })();
    const el = document.createElement('div');
    el.className = 'ms-toast ms-toast--info';
    el.innerHTML = `
        <span class="ms-toast__icon">${icon('info', { size: 18 })}</span>
        <div class="ms-toast__body">
            ${title ? '<div class="ms-toast__title"></div>' : ''}
            <div class="ms-toast__message" dir="auto"></div>
            <button class="btn-primary btn-sm toast-action-btn"></button>
        </div>
        <button class="ms-toast__close" aria-label="Dismiss">&#10005;</button>
    `;
    if (title) el.querySelector('.ms-toast__title').textContent = title;
    el.querySelector('.ms-toast__message').textContent = message;
    const btn = el.querySelector('.toast-action-btn');
    btn.textContent = actionLabel;

    let done = false;
    const dismiss = () => {
        if (done) return;
        done = true;
        el.classList.add('ms-toast--leaving');
        setTimeout(() => el.remove(), 200);
    };
    btn.onclick = () => { dismiss(); actionFn(); };
    el.querySelector('.ms-toast__close').onclick = dismiss;
    container.appendChild(el);
    setTimeout(dismiss, duration);
    return dismiss;
}

// A toast with an Undo button. Destructive actions should always be
// reversible for a few seconds rather than requiring a confirmation dialog
// for every single one - it's faster to use and safer at the same time.
function showUndoToast(message, undoFn, duration = 8000) {
    const container = document.querySelector('.ms-toast-container') || (() => {
        const c = document.createElement('div');
        c.className = 'ms-toast-container';
        document.body.appendChild(c);
        return c;
    })();

    const el = document.createElement('div');
    el.className = 'ms-toast ms-toast--success';
    el.innerHTML = `
        <span class="ms-toast__icon">${icon('checkCircle', { size: 18 })}</span>
        <div class="ms-toast__body">
            <div class="ms-toast__message" dir="auto"></div>
        </div>
        <button class="btn-secondary undo-btn">Undo</button>
        <button class="ms-toast__close" aria-label="Dismiss">&#10005;</button>
    `;
    el.querySelector('.ms-toast__message').textContent = message;

    let done = false;
    function dismiss() {
        if (done) return;
        done = true;
        el.classList.add('ms-toast--leaving');
        setTimeout(() => el.remove(), 200);
    }

    el.querySelector('.undo-btn').onclick = async () => {
        dismiss();
        try {
            await undoFn();
            toast.info('Undone.');
        } catch (e) {
            toast.error('Could not undo that.');
        }
    };
    el.querySelector('.ms-toast__close').onclick = dismiss;

    container.appendChild(el);
    setTimeout(dismiss, duration);
}

let activeTaskCategory = 'All';
// Tracks which tasks are ticked for bulk actions. Held as a Set of ids so it
// survives re-renders (filtering, searching) without losing the selection.
const selectedTaskIds = new Set();
let activeTaskStatusFilter = 'all';   // all | today | urgent
let taskSearchQuery = '';

// Wire the toolbar. These controls existed in the markup but were never
// connected to anything - the search box in particular was decorative.
const taskSearchInput = document.getElementById('task-search-input');
const taskSearchClear = document.getElementById('task-search-clear');
const taskSearchBox = taskSearchInput ? taskSearchInput.closest('.search-box') : null;

if (taskSearchInput) {
    let searchDebounce;
    taskSearchInput.addEventListener('input', (e) => {
        taskSearchQuery = e.target.value.trim().toLowerCase();
        if (taskSearchBox) taskSearchBox.classList.toggle('has-value', taskSearchQuery.length > 0);
        // Debounced so we don't re-render the whole list on every keystroke.
        // No network call needed - renderTasksList() just re-filters the
        // already-fetched data.
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => renderTasksList(), 180);
    });
}

if (taskSearchClear) {
    taskSearchClear.addEventListener('click', () => {
        taskSearchQuery = '';
        if (taskSearchInput) taskSearchInput.value = '';
        if (taskSearchBox) taskSearchBox.classList.remove('has-value');
        renderTasksList();
    });
}

document.querySelectorAll('#task-status-filters .filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
        document.querySelectorAll('#task-status-filters .filter-chip')
            .forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        activeTaskStatusFilter = chip.dataset.filter;
        renderTasksList();
    });
});

// Returns true if the task survives the currently active search + filter.
function matchesTaskFilters(task) {
    // Completed tasks are archived, not deleted, so they must be hidden from
    // the working views - otherwise the list grows forever - but still be
    // reachable through the "Done" filter.
    if (activeTaskStatusFilter === 'done') {
        if (task.status !== 'completed') return false;
    } else if (task.status === 'completed') {
        return false;
    }

    if (taskSearchQuery) {
        const haystack = [task.title, task.category, task.date]
            .filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(taskSearchQuery)) return false;
    }

    if (activeTaskStatusFilter === 'urgent') {
        if (task.urgency !== 'Urgent' && task.urgency !== 'High') return false;
    } else if (activeTaskStatusFilter === 'today') {
        if (!task.date || task.date === 'Not set') return false;
        // task.date is stored as DD/MM/YYYY (see resolveDueDate in main.js)
        const [d, m, y] = task.date.split('/').map(Number);
        if (!d || !m || !y) return false;
        const due = new Date(y, m - 1, d);
        const today = new Date();
        if (due.toDateString() !== today.toDateString()) return false;
    }

    return true;
}

// UX: lets a task jump straight to the Materials folder or Study deck it's
// related to, instead of making you go find it yourself. A folder-name match
// is checked first (specific and reliable); a general "this is learning
// related" keyword list - same spirit as classifyEventByKeywords in main.js -
// catches everything else study-related, sending it to Study.
const LEARNING_KEYWORDS = [
    'ללמוד', 'לימוד', 'למידה', 'חזרה', 'להתכונן', 'הכנה', 'שיעורי בית',
    'תרגיל', 'תרגילים', 'סיכום', 'מבחן', 'בחינה', 'בוחן', 'שיעור', 'הרצאה',
    'תרגול', 'מעבדה', 'סמינר', 'קורס',
    'study', 'revise', 'revision', 'homework', 'exam', 'test', 'quiz',
    'lecture', 'lesson', 'class', 'seminar', 'lab', 'tutorial'
];

function getLearningDestination(task, folders) {
    const category = (task.category || '').trim();
    if (category) {
        const folder = folders.find(f => (f.name || '').trim().toLowerCase() === category.toLowerCase());
        if (folder) return { type: 'materials', folderName: folder.name };
    }
    const haystack = `${task.title || ''} ${category}`.toLowerCase();
    if (LEARNING_KEYWORDS.some(w => haystack.includes(w.toLowerCase()))) {
        return { type: 'study' };
    }
    return null;
}

// Cache of the last fetch, so switching a filter/category/search doesn't
// need a fresh round-trip to the server - filtering is a pure client-side
// concept. Previously every filter chip click called the full fetch-and-
// render function (2 network round-trips: tasks + folders), which is why
// switching filters had a visible 1-2s delay on every click.
let cachedTasksData = [];
let cachedFoldersData = [];

async function loadAndRenderTasks() {
    const tasksListContainer = document.querySelector('.tasks-list');
    if (!tasksListContainer) return;

    // Skeleton first: a blank region during a fetch is indistinguishable
    // from "you have nothing", which is misleading and feels broken.
    renderSkeleton(tasksListContainer, 3);

    // Strict (30/9): "couldn't load" must not look like "no tasks".
    const loaded = await ipcRenderer.invoke('get-tasks', { strict: true }).catch(e => ({ error: e.message }));
    if (!Array.isArray(loaded)) {
        renderEmptyState(tasksListContainer, {
            icon: 'alert', title: t('Couldn\'t load your tasks'),
            message: t('MindSync didn\'t answer. Your tasks are safe - try again in a moment.'),
            actionLabel: t('Try again'), onAction: () => loadAndRenderTasks()
        });
        return;
    }
    cachedTasksData = loaded;
    cachedFoldersData = await ipcRenderer.invoke('get-folders').catch(() => []) || [];

    renderTasksList();
}

// Re-renders from the cached data only - no network call. Use this for
// anything that's a pure filter/search/category change; use
// loadAndRenderTasks() (or refreshTaskViews()) when the underlying data
// itself changed (add/edit/delete/complete a task).
function renderTasksList() {
    const tasksListContainer = document.querySelector('.tasks-list');
    if (!tasksListContainer) return;

    const tasks = cachedTasksData;
    const folders = cachedFoldersData;

    tasksListContainer.innerHTML = '';

    if (!tasks || tasks.length === 0) {
        renderEmptyState(tasksListContainer, {
            icon: 'checkCircle',
            title: 'No tasks right now',
            message: 'You are all caught up. Add a task, or upload study material and let the AI pull tasks out of it.'
        });
        return;
    }

    // ---- Category filter bar ----
    const categories = [...new Set(tasks.map(t => (t.category || '').trim()).filter(Boolean))].sort();
    if (categories.length > 0) {
        const filterBar = document.createElement('div');
        filterBar.className = 'category-filter-bar';
        const allCats = ['All', ...categories, 'Uncategorized'];
        filterBar.innerHTML = allCats.map(cat =>
            `<button class="category-chip ${activeTaskCategory === cat ? 'active' : ''}" data-cat="${escapeHtml(cat)}"${cat === 'All' || cat === 'Uncategorized' ? '' : ' translate="no"'}>${escapeHtml(cat)}</button>`
        ).join('');
        filterBar.querySelectorAll('.category-chip').forEach(chip => {
            chip.onclick = () => {
                activeTaskCategory = chip.dataset.cat;
                renderTasksList();
            };
        });
        tasksListContainer.appendChild(filterBar);
    }

    let visibleTasks = tasks;
    if (activeTaskCategory === 'Uncategorized') {
        visibleTasks = tasks.filter(t => !(t.category || '').trim());
    } else if (activeTaskCategory !== 'All') {
        visibleTasks = tasks.filter(t => (t.category || '').trim() === activeTaskCategory);
    }

    visibleTasks = visibleTasks.filter(matchesTaskFilters);

    if (visibleTasks.length === 0) {
        const empty = document.createElement('div');
        // Tell the user *why* nothing is showing - an unexplained empty list
        // after typing in a search box looks like a bug.
        if (taskSearchQuery) {
            renderEmptyState(empty, {
                icon: 'search',
                title: 'No matches',
                message: `Nothing matches "${taskSearchQuery}". Try a different search.`
            });
        } else if (activeTaskStatusFilter !== 'all') {
            // The chip's own words, not the internal key ("urgent" showed
            // up in English in the Hebrew app - review fix 30/9).
            const chipLabel = (document.querySelector(`#task-status-filters [data-filter="${activeTaskStatusFilter}"]`) || {}).textContent || activeTaskStatusFilter;
            renderEmptyState(empty, {
                icon: 'plus',
                title: 'Nothing here',
                message: t('No tasks in "{f}" right now.', { f: chipLabel.trim() })
            });
        } else if (activeTaskCategory === 'All') {
            // Everything done (the list only shows open tasks): say so.
            renderEmptyState(empty, {
                icon: 'checkCircle',
                title: tasks.length ? 'All done' : 'No tasks yet',
                message: tasks.length ? 'No open tasks. Nice.' : 'Add one above - write it in your own words.'
            });
        } else {
            renderEmptyState(empty, {
                icon: 'folder',
                title: 'No tasks in this category',
                message: 'Pick a different category, or add a task here.'
            });
        }
        tasksListContainer.appendChild(empty);
        return;
    }

    // Select-all row: lets you grab an entire filtered set in one click, which
    // is the whole point after a bulk import produces 19 tasks at once.
    const selectAllRow = document.createElement('div');
    selectAllRow.className = 'select-all-row';
    const allSelected = visibleTasks.length > 0 && visibleTasks.every(t => selectedTaskIds.has(t.id));
    selectAllRow.innerHTML = `
        <label class="select-all-label">
            <input type="checkbox" ${allSelected ? 'checked' : ''} />
            <span>Select all ${visibleTasks.length} shown</span>
        </label>
    `;
    selectAllRow.querySelector('input').onchange = (e) => {
        const checked = e.target.checked;
        visibleTasks.forEach(t => checked ? selectedTaskIds.add(t.id) : selectedTaskIds.delete(t.id));

        // Update the rows in place. Calling loadAndRenderTasks() here meant a
        // full reload - skeleton and all - so ticking "select all" made the
        // whole list vanish for a moment and come back, which reads as a bug.
        // Nothing about the list changed; only the selection did.
        tasksListContainer.querySelectorAll('.task-select__box').forEach(box => {
            box.checked = checked;
            const card = box.closest('.task-card-full');
            if (card) card.classList.toggle('is-selected', checked);
        });
        updateBulkBar();
    };
    tasksListContainer.appendChild(selectAllRow);

    visibleTasks.forEach((task) => {
        const urgencyColor = URGENCY_COLORS[task.urgency] || URGENCY_COLORS.Normal;

        const { percent, done, total } = computeProgress(task);
        const hasChecklist = total > 0;
        const dest = getLearningDestination(task, folders);

        const taskCard = document.createElement('div');
        taskCard.className = 'card task-card-full' + (task.status === 'completed' ? ' is-done' : '');

        taskCard.innerHTML = `
            <div class="task-main-row">
                <label class="task-select" title="Select for bulk actions">
                    <input type="checkbox" class="task-select__box" ${selectedTaskIds.has(task.id) ? 'checked' : ''} />
                    <span class="ms-sr-only">Select task</span>
                </label>
                <div class="task-info-col">
                    <div class="task-title-text" dir="auto">${escapeHtml(task.title)}</div>
                    <div class="task-meta-line">
                        <span class="task-meta-date">${icon('calendar')} ${escapeHtml(task.date || 'Not set')}</span>
                        <select class="urgency-select" style="color: ${urgencyColor};" title="How urgent - tap to change" aria-label="How urgent">
                            <option value="Normal" ${task.urgency === 'Normal' ? 'selected' : ''}>Normal</option>
                            <option value="Medium" ${task.urgency === 'Medium' ? 'selected' : ''}>Medium</option>
                            <option value="High" ${task.urgency === 'High' ? 'selected' : ''}>High</option>
                            <option value="Urgent" ${task.urgency === 'Urgent' ? 'selected' : ''}>Urgent</option>
                        </select>
                        ${task.category ? `<span class="task-category-tag">${escapeHtml(task.category)}</span>` : ''}
                    </div>
                    ${hasChecklist ? `
                    <div class="progress-row">
                        <div class="progress-track"><div class="progress-fill" style="width: ${percent}%;"></div></div>
                        <span class="progress-label">${done}/${total} • ${percent}%</span>
                    </div>` : ''}
                </div>
                <div class="task-actions-col">
                    ${dest ? `<button class="go-to-related-btn" title="${dest.type === 'materials' ? `Open Materials — ${escapeHtml(dest.folderName)}` : 'Open in Study'}" aria-label="Go to related content">${icon(dest.type === 'materials' ? 'library' : 'brain')}</button>` : ''}
                    <button class="edit-task-btn" title="Edit task" aria-label="Edit task">${icon('edit')}</button>
                    <button class="toggle-checklist-btn" title="${hasChecklist ? 'Show the steps' : 'Split into steps'}" aria-label="${hasChecklist ? 'Show the steps' : 'Split into steps'}">${hasChecklist ? icon('list') : icon('plus')}</button>
                    <button class="complete-task-btn">${icon('check')} ${task.status === 'completed' ? 'Reopen' : 'Done'}</button>
                    <button class="delete-task-btn" title="Delete Task">${icon('trash')}</button>
                </div>
            </div>
            <div class="checklist-panel" style="display: none;">
                <div class="checklist-items"></div>
                <div class="add-subtask-row">
                    <input type="text" class="new-subtask-input input-field" placeholder="Add a step (e.g. שאלה 1)..." />
                    <button class="add-subtask-btn btn-secondary">Add</button>
                </div>
            </div>
        `;

        const checklistPanel = taskCard.querySelector('.checklist-panel');
        const checklistItems = taskCard.querySelector('.checklist-items');

        const goToRelatedBtn = taskCard.querySelector('.go-to-related-btn');
        if (goToRelatedBtn && dest) {
            goToRelatedBtn.onclick = (e) => {
                e.stopPropagation();
                goToLearningDestination(dest);
            };
        }

        function renderChecklist() {
            checklistItems.innerHTML = '';
            if (!task.subtasks || task.subtasks.length === 0) {
                checklistItems.innerHTML = '<div class="checklist-empty">No steps yet. Add one below to start tracking progress.</div>';
                return;
            }
            task.subtasks.forEach((sub) => {
                const row = document.createElement('div');
                row.className = 'checklist-item';
                row.innerHTML = `
                    <label>
                        <input type="checkbox" ${sub.completed ? 'checked' : ''} />
                        <span dir="auto" class="${sub.completed ? 'subtask-done' : ''}">${escapeHtml(sub.title)}</span>
                    </label>
                    <button class="delete-subtask-btn" title="Remove step" aria-label="Remove step">${icon('close', { size: 14 })}</button>
                `;

                row.querySelector('input[type="checkbox"]').onchange = async (e) => {
                    const newValue = e.target.checked;
                    const updated = await ipcRenderer.invoke('toggle-subtask', task.id, sub._id, newValue);
                    if (updated && updated.error) {
                        toast.error('Could not update step: ' + updated.error);
                        e.target.checked = !newValue; // revert the checkbox, the server rejected it
                        return;
                    }
                    if (await applySubtaskResult(updated)) return;
                    refreshProgressUI();
                    renderChecklist();
                };

                row.querySelector('.delete-subtask-btn').onclick = async () => {
                    const updated = await ipcRenderer.invoke('delete-subtask', task.id, sub._id);
                    if (updated && updated.error) { toast.error('Could not remove step: ' + updated.error); return; }
                    if (await applySubtaskResult(updated)) return;
                    refreshProgressUI();
                    renderChecklist();
                };

                checklistItems.appendChild(row);
            });
        }

        // BUG FIX: ticking the last step makes the SERVER mark the whole
        // task completed (and unticking one reopens it). The card, the
        // counts on Home and the sidebar never heard about it - the card
        // kept its "Done" button and the sidebar kept saying "1 open task".
        // When the status flips, redraw everything; otherwise (the common
        // case) keep the quick in-place update so the checklist stays open.
        // Returns true when it did the full refresh.
        async function applySubtaskResult(updated) {
            const statusChanged = updated.status !== task.status;
            task.subtasks = updated.subtasks;
            task.status = updated.status;
            if (!statusChanged) return false;
            if (updated.status === 'completed') toast.success('All steps done - task completed.');
            await refreshTaskViews();
            return true;
        }

        // Updates the progress bar in place instead of re-rendering the whole
        // list, so the checklist panel doesn't collapse on every click.
        function refreshProgressUI() {
            const p = computeProgress(task);
            let progressRow = taskCard.querySelector('.progress-row');
            if (!progressRow && p.total > 0) {
                progressRow = document.createElement('div');
                progressRow.className = 'progress-row';
                progressRow.innerHTML = `<div class="progress-track"><div class="progress-fill"></div></div><span class="progress-label"></span>`;
                taskCard.querySelector('.task-info-col').appendChild(progressRow);
            }
            if (progressRow) {
                if (p.total === 0) { progressRow.remove(); return; }
                progressRow.querySelector('.progress-fill').style.width = p.percent + '%';
                progressRow.querySelector('.progress-label').textContent = `${p.done}/${p.total} • ${p.percent}%`;
            }
        }

        const toggleBtn = taskCard.querySelector('.toggle-checklist-btn');
        toggleBtn.onclick = () => {
            const isHidden = checklistPanel.style.display === 'none';
            checklistPanel.style.display = isHidden ? 'block' : 'none';
            if (isHidden) renderChecklist();
        };

        const subtaskInput = taskCard.querySelector('.new-subtask-input');
        const addSubtaskBtn = taskCard.querySelector('.add-subtask-btn');

        async function addSubtask() {
            const title = subtaskInput.value.trim();
            // Busy = ignore (30/9): Enter twice while saving added the step twice.
            if (!title || addSubtaskBtn.disabled) return;
            addSubtaskBtn.disabled = true;
            let updated;
            try { updated = await ipcRenderer.invoke('add-subtask', task.id, title); }
            catch (e) { updated = { error: e.message }; }
            finally { addSubtaskBtn.disabled = false; }
            if (!updated || updated.error) { toast.error('Could not add step: ' + ((updated && updated.error) || 'no connection')); return; }
            task.subtasks = updated.subtasks;
            task.status = updated.status;
            subtaskInput.value = '';
            refreshProgressUI();
            renderChecklist();
        }

        addSubtaskBtn.onclick = addSubtask;
        subtaskInput.onkeydown = (e) => { if (e.key === 'Enter') addSubtask(); };

        const editBtn = taskCard.querySelector('.edit-task-btn');
        if (editBtn) {
            editBtn.onclick = async () => {
                const updated = await editTaskDialog(task);
                if (!updated) return;
                const res = await ipcRenderer.invoke('update-task', task.id, updated);
                if (res && res.error) { toast.error(res.error, 'Could not save'); return; }
                toast.success('Task updated.');
                await refreshTaskViews();
            };
        }

        const selectBox = taskCard.querySelector('.task-select__box');
        if (selectBox) {
            selectBox.onchange = (e) => {
                if (e.target.checked) selectedTaskIds.add(task.id);
                else selectedTaskIds.delete(task.id);
                taskCard.classList.toggle('is-selected', e.target.checked);
                updateBulkBar();
            };
            if (selectedTaskIds.has(task.id)) taskCard.classList.add('is-selected');
        }

        const urgencySelect = taskCard.querySelector('.urgency-select');
        if (urgencySelect) {
            urgencySelect.onchange = async (e) => {
                const newUrgency = e.target.value;
                const previous = task.urgency;
                const result = await ipcRenderer.invoke('update-task', task.id, { urgency: newUrgency });
                if (result && result.error) {
                    toast.error('Could not update urgency: ' + result.error);
                    e.target.value = previous; // revert, the server rejected it
                    return;
                }
                task.urgency = newUrgency;
                e.target.style.color = URGENCY_COLORS[newUrgency] || URGENCY_COLORS.Normal;
            };
        }

        const deleteBtn = taskCard.querySelector('.delete-task-btn');
        deleteBtn.onclick = async () => {
            // Keep a copy so Undo can recreate it. The id will differ after
            // restore, which is fine - the content is what the user cares about.
            // BUG FIX: dueDate and estimatedMinutes weren't copied, so an
            // undone delete came back without them (the planner then treated
            // it as a one-hour task).
            const snapshot = {
                title: task.title,
                date: task.date,
                dueDate: task.dueDate,
                estimatedMinutes: task.estimatedMinutes,
                category: task.category,
                urgency: task.urgency,
                subtasks: (task.subtasks || []).map(st => ({ title: st.title, completed: st.completed }))
            };

            const res = await ipcRenderer.invoke('delete-task', task.id);
            if (res && res.error) { toast.error(res.error, 'Could not delete'); return; }

            selectedTaskIds.delete(task.id);
            await refreshTaskViews();

            showUndoToast(`Deleted "${task.title}".`, async () => {
                await ipcRenderer.invoke('save-task', snapshot);
                await refreshTaskViews();
            });
        };

        const completeBtn = taskCard.querySelector('.complete-task-btn');
        const titleText = taskCard.querySelector('.task-title-text');

        completeBtn.onclick = async () => {
            // Already-done tasks get a reopen action instead, so the Done view
            // isn't a dead end.
            if (task.status === 'completed') {
                const res = await ipcRenderer.invoke('update-task', task.id, { status: 'open' });
                if (res && res.error) { toast.error(res.error, 'Could not reopen'); return; }
                toast.success('Task reopened.');
                await refreshTaskViews();
                return;
            }

            // Guard: finishing a task that still has unchecked steps is
            // usually a misclick, so confirm rather than silently discarding
            // the remaining checklist.
            const p = computeProgress(task);
            if (p.total > 0 && p.done < p.total) {
                const proceed = await confirmDialog("Finish this task?", `It still has ${p.total - p.done} unfinished step(s).`, { confirmText: "Mark as done" });
                if (!proceed) return;
            }

            taskCard.classList.add('is-completing');
            completeBtn.disabled = true;

            // Archive rather than delete. Completing a task used to remove it
            // permanently, which threw away all history - you could never see
            // what you'd finished, and "Done this week" could never count
            // anything. The schema already had status:'completed'; it just
            // wasn't being used.
            const res = await ipcRenderer.invoke('update-task', task.id, { status: 'completed' });
            if (res && res.error) {
                toast.error(res.error, 'Could not complete task');
                taskCard.classList.remove('is-completing');
                completeBtn.disabled = false;
                return;
            }

            showUndoToast(
                'Task marked as done.',
                async () => {
                    await ipcRenderer.invoke('update-task', task.id, { status: 'open' });
                    await refreshTaskViews();
                }
            );

            await refreshTaskViews();
        };

        tasksListContainer.appendChild(taskCard);
    });

    // Static data-icon spans inside freshly rendered markup need hydrating.
    if (window.hydrateIcons) hydrateIcons(tasksListContainer);

    // Drop selections for tasks that no longer exist, then refresh the bar.
    const liveIds = new Set(tasks.map(t => t.id));
    [...selectedTaskIds].forEach(id => { if (!liveIds.has(id)) selectedTaskIds.delete(id); });
    updateBulkBar();
}

loadAndRenderTasks();

// ==========================================
// 7. Materials Manager
// ==========================================
const materialsGrid = document.querySelector('.materials-grid');
const uploadModal = document.getElementById('upload-file-modal');
const uploadFolderSelect = document.getElementById('upload-folder-select');
const addFolderModal = document.getElementById('add-folder-modal');

let currentActiveFolder = 'All';

async function loadAndRenderFolders() {
    if (!materialsGrid) return;
    const folders = await ipcRenderer.invoke('get-folders');
    materialsGrid.innerHTML = '';

    const allFolder = document.createElement('div');
    allFolder.className = 'card folder-card' + (currentActiveFolder === 'All' ? ' is-active' : '');
    allFolder.innerHTML = `<div class="folder-icon">${icon('library')}</div><div class="folder-name">${escapeHtml(t('All files'))}</div>`;
    allFolder.onclick = () => {
        currentActiveFolder = 'All';
        loadAndRenderFolders();
        loadAndRenderFiles();
    };
    materialsGrid.appendChild(allFolder);

    folders.forEach((folder) => {
        const folderCard = document.createElement('div');
        folderCard.className = 'card folder-card' + (currentActiveFolder === folder.name ? ' is-active' : '');
        
        folderCard.innerHTML = `
            <div class="folder-icon">${icon('folder')}</div>
            <div class="folder-name" dir="auto">${escapeHtml(folder.name)}</div>
            <button class="btn-icon btn-icon--danger delete-folder-btn" title="Delete folder" aria-label="Delete folder">${icon('trash')}</button>
        `;
        
        folderCard.onclick = (e) => {
            if (e.target.classList.contains('delete-folder-btn')) return;
            currentActiveFolder = folder.name;
            loadAndRenderFolders();
            loadAndRenderFiles();
        };

        const delBtn = folderCard.querySelector('.delete-folder-btn');
        delBtn.onclick = async (e) => {
            e.stopPropagation();
            // Asked first (30/9) - it was one click, no undo.
            if (!await confirmDialog(t('Delete the folder "{name}"?', { name: folder.name }),
                t('The files in it are not deleted - they move to "No folder".'), { confirmText: t('Delete folder'), danger: true })) return;
            const result = await ipcRenderer.invoke('delete-folder', folder.id); // Fixed: Pass ID instead of index
            if (result && result.error) { toast.error('Could not delete folder: ' + result.error); return; }
            if (currentActiveFolder === folder.name) currentActiveFolder = 'All';
            await loadAndRenderFolders();
            await loadAndRenderFiles();
        };

        materialsGrid.appendChild(folderCard);
    });

    const addBtn = document.createElement('div');
    addBtn.className = 'card folder-card add-folder';
    addBtn.innerHTML = `<div class="folder-icon">${icon('plus')}</div><div class="folder-name">${escapeHtml(t('New folder'))}</div>`;
    addBtn.onclick = () => addFolderModal.style.display = 'flex';
    materialsGrid.appendChild(addBtn);

    if (uploadFolderSelect) {
        // Built with DOM nodes, not an HTML string: a folder name is user text,
        // and this used to put it into innerHTML raw - an injection point.
        uploadFolderSelect.innerHTML = '';
        uploadFolderSelect.appendChild(new Option('No Folder', 'No Folder'));
        folders.forEach(f => uploadFolderSelect.appendChild(new Option(f.name, f.name)));
    }
}

async function loadAndRenderFiles() {
    if (!filesListContainer) return;
    const files = await ipcRenderer.invoke('get-files', { strict: true }).catch(e => ({ error: e.message }));
    filesListContainer.innerHTML = '';
    if (!Array.isArray(files)) {   // 30/9: not "No files here yet" when the server didn't answer
        renderEmptyState(filesListContainer, {
            icon: 'alert', title: t('Couldn\'t load your files'),
            message: t('MindSync didn\'t answer. Your files are safe - try again in a moment.'),
            actionLabel: t('Try again'), onAction: () => loadAndRenderFiles()
        });
        return;
    }

    const filteredFiles = currentActiveFolder === 'All' 
        ? files 
        : files.filter(f => f.folder === currentActiveFolder);

    if (filteredFiles.length === 0) {
        renderEmptyState(filesListContainer, {
            icon: 'file',
            title: 'No files here yet',
            message: 'Upload a PDF, summary or exercise sheet to summarize it, practise from it, or pull out its exams and deadlines.'
        });
        return;
    }

    filteredFiles.forEach(file => {
        const fileItem = document.createElement('div');
        fileItem.className = 'card file-item';
        fileItem.innerHTML = `
            <div class="file-info">
                <div class="file-icon">${icon('file')}</div>
                <div>
                    <div class="file-name" dir="auto" title="${escapeHtml(file.name)}">${escapeHtml(fileLabel(file.name))}</div>
                    <div class="file-meta">${escapeHtml(file.folder)}</div>
                </div>
            </div>
            <div class="file-actions" style="display:flex; gap:8px; flex-wrap:wrap;">
                <button class="btn-secondary btn-sm btn-extract" title="Reads a syllabus or assignment sheet: exams go to the Planner, submissions to Tasks">Exams & deadlines</button>
                <button class="btn-secondary btn-sm btn-ai">${file.summary ? 'View summary' : 'Summarize'}</button>
                <button class="btn-secondary btn-sm btn-questions" title="Makes practice questions from this file - you check them before they go into Study">Questions</button>
                <button class="btn-icon btn-icon--danger delete-file-btn" title="Delete file" aria-label="Delete file">${icon('trash')}</button>
            </div>
        `;

        // Opens (or brings to front) a separate, resizable summary window.
        // A saved summary shows instantly; otherwise it's generated there.
        fileItem.querySelector('.btn-ai').onclick = () => ipcRenderer.invoke('open-summary-window', file.id, file.name);
        // Questions from here too - the file you're looking at is the obvious
        // place to ask for them; before, it was only in Study.
        fileItem.querySelector('.btn-questions').onclick = (e) => generateQuestionsFor(file, e.currentTarget);
        
        fileItem.querySelector('.delete-file-btn').onclick = async () => {
            // Asked first (30/9): this also deletes its summary and the uploaded original.
            if (!await confirmDialog(t('Delete "{name}"?', { name: fileLabel(file.name) }),
                t('Its summary and the uploaded file go too. Practice questions made from it stay.'), { confirmText: t('Delete file'), danger: true })) return;
            const result = await ipcRenderer.invoke('delete-file', file.id); // Fixed: Pass ID directly without searching
            if (result && result.error) { toast.error('Could not delete file: ' + result.error); return; }
            await loadAndRenderFiles();
        };

        const extractBtn = fileItem.querySelector('.btn-extract');
        if (extractBtn) extractBtn.onclick = () => openSyllabusImport(file, extractBtn);

        filesListContainer.appendChild(fileItem);
    });
}

// ---- Upload: one file, many files, or a whole folder ----
// Before, the picker took a single file and there was no way to add a folder
// of lecture notes except one file at a time. Now: pick files (several at
// once) or a folder, review the list, choose where they go, and they upload
// one by one with a status next to each - so a batch of 20 PDFs visibly
// progresses instead of looking frozen.
const uploadTitle = document.getElementById('upload-title');
const uploadSummary = document.getElementById('upload-summary');
const uploadList = document.getElementById('upload-file-list');
const confirmUploadBtn = document.getElementById('confirm-upload-btn');
const cancelUploadBtn = document.getElementById('cancel-upload-btn');
const NEW_FOLDER_PREFIX = '__new__:';

let uploadBatch = null; // { files, folderName, running, stopRequested, done }

function setUploadRowStatus(index, state, text) {
    const row = uploadList.querySelector(`[data-index="${index}"]`);
    if (!row) return;
    row.dataset.state = state;
    row.querySelector('.upload-row__status').textContent = text;
    if (state === 'working') row.scrollIntoView({ block: 'nearest' });
}

async function openUploadPicker(mode) {
    const picked = await ipcRenderer.invoke('select-upload-files', mode);
    if (!picked) return; // cancelled the picker - not an error
    if (!picked.files.length) {
        toast.warning(mode === 'folder'
            ? `No supported files in that folder. Supported: ${picked.supported.join(', ')}.`
            : 'None of those files are a supported type.');
        return;
    }

    uploadBatch = { files: picked.files, folderName: picked.folderName, running: false, stopRequested: false, done: false };

    uploadTitle.textContent = picked.folderName ? `Upload folder "${picked.folderName}"` : 'Upload files';
    uploadSummary.textContent = `${picked.files.length} file${picked.files.length === 1 ? '' : 's'} ready to upload.`
        + (picked.truncated ? ` Only the first ${picked.maxFiles} are included - upload the rest in another batch.` : '');

    uploadList.innerHTML = '';
    picked.files.forEach((f, i) => {
        const row = document.createElement('div');
        row.className = 'upload-row';
        row.dataset.index = i;
        row.dataset.state = 'pending';
        const name = document.createElement('span');
        name.className = 'upload-row__name';
        name.dir = 'auto';
        name.textContent = f.name;
        const status = document.createElement('span');
        status.className = 'upload-row__status';
        row.append(name, status);
        uploadList.appendChild(row);
    });

    // Destination: existing folders, plus - for a folder upload - an option
    // to create a matching folder here (selected by default, since that's
    // almost always what uploading "Statistics" means).
    const folders = await ipcRenderer.invoke('get-folders').catch(() => []) || [];
    uploadFolderSelect.innerHTML = '';
    uploadFolderSelect.appendChild(new Option('No Folder', 'No Folder'));
    folders.forEach(f => uploadFolderSelect.appendChild(new Option(f.name, f.name)));

    const existingMatch = picked.folderName && folders.find(f => f.name.trim() === picked.folderName.trim());
    if (picked.folderName && !existingMatch) {
        const opt = new Option(`New folder: ${picked.folderName}`, NEW_FOLDER_PREFIX + picked.folderName);
        uploadFolderSelect.insertBefore(opt, uploadFolderSelect.options[1] || null);
        uploadFolderSelect.value = opt.value;
    } else if (existingMatch) {
        uploadFolderSelect.value = existingMatch.name;
    } else {
        uploadFolderSelect.value = currentActiveFolder !== 'All' ? currentActiveFolder : 'No Folder';
    }

    uploadFolderSelect.disabled = false;
    confirmUploadBtn.disabled = false;
    confirmUploadBtn.textContent = picked.files.length === 1 ? 'Upload' : `Upload ${picked.files.length} files`;
    cancelUploadBtn.textContent = 'Cancel';
    uploadModal.style.display = 'flex';
}

async function runUploadBatch() {
    const batch = uploadBatch;
    if (!batch || batch.running) return;
    batch.running = true;
    uploadFolderSelect.disabled = true;
    confirmUploadBtn.disabled = true;
    cancelUploadBtn.textContent = 'Stop';

    // Resolve the destination, creating the folder first if asked to.
    let folder = uploadFolderSelect.value;
    if (folder.startsWith(NEW_FOLDER_PREFIX)) {
        folder = folder.slice(NEW_FOLDER_PREFIX.length);
        const created = await ipcRenderer.invoke('save-folder', { name: folder });
        if (created && created.error && !/duplicate|exists|E11000/i.test(created.error)) {
            toast.error(`Could not create the folder "${folder}": ${created.error}`);
            batch.running = false;
            uploadFolderSelect.disabled = false;
            confirmUploadBtn.disabled = false;
            cancelUploadBtn.textContent = 'Cancel';
            return;
        }
    }

    // Uploading the same folder twice shouldn't duplicate it: a file whose
    // name already exists in the destination is skipped, not re-added.
    const existing = await ipcRenderer.invoke('get-files-light').catch(() => []) || [];
    const alreadyThere = new Set(existing.filter(f => (f.folder || 'No Folder') === folder).map(f => f.name));

    let uploaded = 0, skipped = 0, failed = 0;
    const uploadedNow = [];
    for (let i = 0; i < batch.files.length; i++) {
        if (batch.stopRequested) {
            for (let j = i; j < batch.files.length; j++) setUploadRowStatus(j, 'skipped', 'Not uploaded');
            break;
        }
        const f = batch.files[i];
        uploadSummary.textContent = `Uploading ${i + 1} of ${batch.files.length}…`;

        if (alreadyThere.has(f.name)) {
            skipped++;
            setUploadRowStatus(i, 'skipped', 'Already uploaded');
            continue;
        }

        setUploadRowStatus(i, 'working', 'Reading…');
        const read = await ipcRenderer.invoke('read-upload-file', f.path);
        if (!read || read.error) {
            failed++;
            // Web: the server's reason ("too large", "storage is full"...) is
            // already a plain sentence - show it instead of a generic one.
            setUploadRowStatus(i, 'failed', IS_WEB && read && read.error ? read.error : "Couldn't read this file");
            continue;
        }
        const saved = await ipcRenderer.invoke('save-file', {
            // The picker's name (unique within the batch - see select-upload-files).
            name: f.name || read.fileName,
            content: read.fileContent,
            sourcePath: read.filePath || '',
            folder
        });
        if (saved && saved.error) {
            failed++;
            setUploadRowStatus(i, 'failed', /large|limit|413/i.test(saved.error) ? 'Too large' : 'Upload failed');
            continue;
        }
        uploaded++;
        uploadedNow.push({ name: read.fileName, content: read.fileContent || '' });
        alreadyThere.add(f.name);
        // Web, storage full: the text was saved but not the PDF itself (30/9).
        setUploadRowStatus(i, 'done', read.warning ? t('Uploaded as text only (storage is full)') : 'Uploaded');
    }

    batch.running = false;
    batch.done = true;
    const notUploaded = batch.files.length - uploaded - skipped - failed; // stopped early
    const parts = [`${uploaded} uploaded`];
    if (skipped) parts.push(`${skipped} already there`);
    if (failed) parts.push(`${failed} failed`);
    if (notUploaded) parts.push(`${notUploaded} not uploaded`);
    const resultText = parts.join(' · ');
    const where = folder === 'No Folder' ? '' : ` to "${folder}"`;

    if (failed === 0) {
        // Nothing needs the user's attention - close the window by itself and
        // say what happened in a toast. (uploadBatch === batch: only close the
        // window that belongs to THIS batch.)
        if (uploadBatch === batch) {
            uploadModal.style.display = 'none';
            uploadBatch = null;
        }
        if (uploaded === 0 && !notUploaded) {
            toast.info(skipped === 1 ? 'This file is already uploaded here.' : `All ${skipped} files are already uploaded here.`);
        } else if (uploaded === 1 && parts.length === 1) {
            toast.success(`Uploaded ${batch.files[0].name}${where}.`);
        } else {
            const title = notUploaded ? 'Upload stopped'
                : folder === 'No Folder' ? 'Upload finished' : `Uploaded to ${folder}`;
            toast.success(resultText + '.', title);
        }
    } else {
        // Some files failed - keep the window open so the user can see WHICH
        // ones (the status next to each row).
        uploadSummary.textContent = resultText + '.';
        cancelUploadBtn.textContent = 'Close';
        confirmUploadBtn.textContent = 'Done';
        confirmUploadBtn.disabled = false;
        toast.warning(`${failed} file${failed === 1 ? '' : 's'} couldn't be uploaded - see the list.`);
    }

    if (folder !== 'No Folder') currentActiveFolder = folder;
    await loadAndRenderFolders();
    await loadAndRenderFiles();
    if (typeof refreshOnboarding === 'function') refreshOnboarding();
    offerNextStepsAfterUpload(uploadedNow).catch(err => console.warn('upload suggestions failed:', err));
}

// ---- After an upload: suggest the obvious next step ----
// Most people will never find "Exams & deadlines" on a file row, or "Make
// questions from a file" on another screen. So right after uploading, the
// app says what it can do with what was just uploaded:
//   - a file that reads like a syllabus -> add its exams and deadlines;
//   - ONE lecture file -> make practice questions from it.
// (A batch of 20 lectures gets no offer: 20 AI requests at once would use a
// free key's whole day.)
// Recognised with plain word matching - no AI request just to decide.
// A syllabus is recognised by its STRUCTURE - many have no dates at all
// ("מבחן סוף סמסטר", homework without due dates). Three of these phrases is
// a syllabus; a lecture rarely has even one. (Plain words like "מבחן" or
// "הגשה" are left out: "מבחני התכנסות" is maths, not an exam.)
const SYLLABUS_WORDS = [
    'סילבוס', 'שם הקורס', 'קוד הקורס', 'מספר הקורס', 'נ"ז', 'נקודות זכות', 'שעות קבלה', 'שם המרצה', 'שם המתרגל',
    'דרישות הקורס', 'חובות הקורס', 'מטרות הקורס', 'תפוקות למידה', 'נושאי הקורס', 'תנאי קדם', 'דרישות קדם',
    'חישוב הציון', 'הרכב הציון', 'מרכיבי הציון', 'ביבליוגרפיה', 'רשימת קריאה', 'מבחן סוף', 'בחינה סופית', 'מבחן סופי',
    'מועד א', 'מועד ב', 'מועדי ההרצאה', 'מועד התרגול',
    'syllabus', 'course code', 'office hours', 'prerequisite', 'grading', 'bibliography', 'learning outcomes', 'course requirements', 'final exam'
];
function looksLikeSyllabus(text) {
    const t = String(text || '').toLowerCase();
    if (t.length < 200) return false;
    return SYLLABUS_WORDS.filter(w => t.includes(w.toLowerCase())).length >= 3;
}

async function offerNextStepsAfterUpload(uploadedNow) {
    if (!uploadedNow || !uploadedNow.length) return;
    const all = await ipcRenderer.invoke('get-files').catch(() => []) || [];
    // The newest record with each name (a re-upload keeps the old one too).
    const byName = (name) => [...all].reverse().find(f => f.name === name);

    const syllabi = uploadedNow.filter(u => looksLikeSyllabus(u.content)).map(u => byName(u.name)).filter(Boolean);
    syllabi.slice(0, 2).forEach(file => {
        showActionToast(`${isolate(file.name)} looks like a syllabus. Add its exams and deadlines to your Planner and Tasks?`,
            'Add exams & deadlines', () => openSyllabusImport(file, null), { title: 'Syllabus found' });
    });

    const others = uploadedNow.filter(u => !looksLikeSyllabus(u.content));
    if (uploadedNow.length === 1 && others.length === 1) {
        const file = byName(others[0].name);
        if (file && (file.content || file.sourcePath)) {
            showActionToast(`Make practice questions from ${isolate(file.name)}?`, 'Make questions',
                () => generateQuestionsFor(file), { title: 'Next step' });
        }
    }
}

document.querySelectorAll('.btn-upload').forEach(btn => {
    btn.onclick = () => openUploadPicker(btn.dataset.uploadMode || 'files');
});

if (confirmUploadBtn) {
    confirmUploadBtn.onclick = () => {
        if (uploadBatch && uploadBatch.done) { uploadModal.style.display = 'none'; uploadBatch = null; return; }
        runUploadBatch();
    };
}

if (cancelUploadBtn) {
    cancelUploadBtn.onclick = () => {
        // Mid-upload, "Stop" finishes the current file and stops - closing
        // the window outright would hide a batch that's still running.
        if (uploadBatch && uploadBatch.running) {
            uploadBatch.stopRequested = true;
            cancelUploadBtn.textContent = 'Stopping…';
            return;
        }
        uploadModal.style.display = 'none';
        uploadBatch = null;
    };
}

// ==========================================
// Exams & deadlines from a syllabus
// ==========================================
// Replaces "Find deadlines", which added everything it found as tasks, at
// once. Now: the AI reads the file (read-syllabus in main.js), this window
// lists what it found - exams go to the Planner, submissions to Tasks - and
// only what stays ticked is added (import-syllabus-items), with Undo.
const syllabusModal = document.getElementById('syllabus-modal');
const syllabusList = document.getElementById('syllabus-list');
const syllabusIntro = document.getElementById('syllabus-intro');
const syllabusCourse = document.getElementById('syllabus-course');
const syllabusGoogle = document.getElementById('syllabus-google');
const syllabusGoogleRow = document.getElementById('syllabus-google-row');
wireGoogleCheckbox(syllabusGoogle);
wireGoogleCheckbox(document.getElementById('sync-google-check'));
const syllabusConfirm = document.getElementById('syllabus-confirm');
const syllabusCancel = document.getElementById('syllabus-cancel');
let syllabusState = null; // { file, items, saving }

const SYLLABUS_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SYLLABUS_DAY_SHORT = { Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat' };
function syllabusDateLabel(item) {
    if (item.kind === 'class') {
        return `Every ${SYLLABUS_DAY_SHORT[item.weekday] || item.weekday} ${item.time}${item.endTime ? `–${item.endTime}` : ''}${item.until ? ` until ${untilLabel(item.until)}` : ''}`;
    }
    if (!item.date) return 'No date in the file';
    const [y, m, d] = item.date.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    let label = `${SYLLABUS_WEEKDAYS[dt.getDay()]} ${d}/${m}/${y}`;
    if (item.kind === 'exam') label += item.time ? ` · ${item.time}` : ' · 09:00 (no time in the file)';
    return label;
}

// Why an item starts unticked (or can't be ticked at all), in words.
function syllabusNote(item) {
    // An exam with no date gets a box to write it in (see renderSyllabusList)
    // - blocked only until a date is written.
    if (item.kind === 'exam' && !item.date) {
        return item.dateError
            ? { text: item.dateError, blocked: true, askDate: true }
            : { text: "Not in the syllabus. Write it if you know it - or leave it, and you'll be asked later.", blocked: true, askDate: true, soft: true };
    }
    // Homework with no dates: ten empty tasks would help nobody.
    if (item.kind === 'assignment' && !item.date) return { text: 'The dates aren\'t in the syllabus - add each one when it\'s published.', blocked: true };
    if (item.kind === 'class') {
        if (item.alreadyExists) return { text: 'Already in your Planner at that time' };
        // The file says when the semester ends: ticked, and it stops then -
        // unless that date has passed (an old syllabus).
        if (item.until && item.until < localIsoDate(new Date())) {
            return { text: `These classes ended on ${untilLabel(item.until)} - this looks like an older semester.`, soft: true };
        }
        if (item.until) return null;
        // No end date in the file: not ticked by default - a weekly class
        // with no end fills every week from now on. One box to say until when.
        if (item.untilError) return { text: item.untilError, soft: true, askUntil: true };
        return { text: 'Repeats every week. Write until when (e.g. "15.1"), or just tick it to keep it with no end date.', soft: true, askUntil: true };
    }
    if (item.alreadyExists) return { text: 'Already in MindSync' };
    if (item.isPast) return { text: 'Already passed' };
    if (item.needsCheck) return { text: "This date isn't written like this in the file - check it" };
    return null;
}

function updateSyllabusConfirm() {
    if (!syllabusState) return;
    if (syllabusState.mode === 'timetable') { updateTimetableConfirm(); return; }
    const picked = syllabusState.items.filter(i => i.checked);
    const exams = picked.filter(i => i.kind === 'exam').length;
    const classes = picked.filter(i => i.kind === 'class').length;
    const tasks = picked.length - exams - classes;
    syllabusConfirm.disabled = picked.length === 0 || syllabusState.saving;
    syllabusConfirm.textContent = picked.length === 0 ? 'Add'
        : `Add ${picked.length} item${picked.length === 1 ? '' : 's'}`;
    if (syllabusGoogleRow) syllabusGoogleRow.hidden = exams + classes === 0;
    // "1 weekly class and 2 exams to the Planner, 1 submission to Tasks."
    const plannerPart = [classes ? `${classes} weekly class${classes === 1 ? '' : 'es'}` : '',
                         exams ? `${exams} exam${exams === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    syllabusIntro.textContent = picked.length === 0
        ? 'Tick what you want to add.'
        : [plannerPart ? `${plannerPart} to the Planner` : '', tasks ? `${tasks} submission${tasks === 1 ? '' : 's'} to Tasks` : '']
            .filter(Boolean).join(', ') + '.';
}

function renderSyllabusList() {
    if (syllabusState && syllabusState.mode === 'timetable') { renderTimetableList(); return; }
    syllabusList.innerHTML = '';
    syllabusState.items.forEach((item, index) => {
        const note = syllabusNote(item);
        const asks = note && (note.askDate || note.askUntil);
        const row = document.createElement(asks ? 'div' : 'label');
        row.className = 'syllabus-row' + (note && note.blocked ? ' is-blocked' : '');

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!item.checked;
        box.disabled = !!(note && note.blocked);
        box.onchange = () => { item.checked = box.checked; updateSyllabusConfirm(); };

        const body = document.createElement('span');
        body.className = 'syllabus-row__body';
        const top = document.createElement('span');
        top.className = 'syllabus-row__top';
        const kind = document.createElement('span');
        kind.className = `syllabus-kind syllabus-kind--${item.kind}`;
        kind.textContent = item.kind === 'exam' ? 'Exam' : item.kind === 'class' ? 'Class' : 'Submission';
        const title = document.createElement('span');
        title.className = 'syllabus-row__title';
        title.dir = 'auto';
        title.textContent = item.title;
        top.append(kind, title);

        const meta = document.createElement('span');
        meta.className = 'syllabus-row__meta';
        meta.textContent = `${syllabusDateLabel(item)} · ${item.kind === 'assignment' ? 'Tasks' : 'Planner'}`;
        body.append(top, meta);

        if (note) {
            const n = document.createElement('span');
            n.className = 'syllabus-row__note' + (note.soft ? ' syllabus-row__note--soft' : '');
            n.textContent = note.text;
            body.append(n);
        }
        // Exam with no date: write it right here, in your own words ("12.2",
        // "מועד א 12.2 מועד ב 5.3") - read the same way as everywhere else.
        if (asks) {
            const wrap = document.createElement('span');
            wrap.className = 'syllabus-row__date';
            const input = document.createElement('input');
            input.className = 'input-field';
            input.dir = 'auto';
            input.maxLength = 200;
            input.placeholder = note.askUntil ? 'עד: לדוגמה 15.1' : 'לדוגמה: 12.2';
            input.value = (note.askUntil ? item.untilText : item.dateText) || '';
            const set = document.createElement('button');
            set.className = 'btn-secondary btn-sm';
            set.type = 'button';
            set.textContent = note.askUntil ? 'Set end' : 'Set date';
            const apply = async () => {
                const text = input.value.trim();
                if (!text) return;
                if (note.askUntil) {
                    item.untilText = text;
                    set.disabled = true;
                    const r = await ipcRenderer.invoke('parse-exam-dates', text).catch(e => ({ error: e.message }));
                    set.disabled = false;
                    if (!r || r.error || !r.exams || !r.exams.length) {
                        item.untilError = (r && r.error) || 'Couldn\'t tell the date. Try writing it like "15.1".';
                    } else {
                        item.until = r.exams[0].date;
                        item.untilError = null;
                        item.checked = true;
                    }
                    renderSyllabusList();
                    return;
                }
                item.dateText = text;
                set.disabled = true;
                const r = await ipcRenderer.invoke('parse-exam-dates', text).catch(e => ({ error: e.message }));
                set.disabled = false;
                if (!r || r.error || !r.exams || !r.exams.length) {
                    item.dateError = (r && r.error) || 'Couldn\'t tell the date. Try writing it like "12.2".';
                } else {
                    item.date = r.exams[0].date;
                    item.time = r.exams[0].time || item.time;
                    item.dateError = null;
                    item.checked = true;
                }
                renderSyllabusList();
            };
            set.onclick = (e) => { e.preventDefault(); apply(); };
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
            wrap.append(input, set);
            body.append(wrap);
        }
        if (item.sourceQuote) {
            const q = document.createElement('span');
            q.className = 'syllabus-row__quote';
            q.dir = 'auto';
            q.textContent = `“${item.sourceQuote}”`;
            q.title = 'Where it says so in the file';
            body.append(q);
        }
        row.dataset.index = index;
        row.append(box, body);
        syllabusList.appendChild(row);
    });
    updateSyllabusConfirm();
}

function closeSyllabusModal() {
    if (syllabusState && syllabusState.saving) return;
    syllabusModal.style.display = 'none';
    syllabusState = null;
    setSyllabusMode('syllabus');
    // A syllabus or timetable that finished reading while this window was in
    // use opens now (the window is shared - it never replaces an open review).
    // One at a time, in the order they finished.
    const next = pendingSyllabusReviews.shift();
    if (next) next();
}
const pendingSyllabusReviews = [];
// Every close goes through closeSyllabusModal, so a review in hand (even one
// still getting ready to show) means the window is taken.
const syllabusWindowBusy = () => !!syllabusState;

async function openSyllabusImport(file, btn) {
    const originalText = btn ? btn.textContent : '';
    if (btn) { btn.textContent = 'Reading…'; btn.disabled = true; }
    let res;
    try {
        res = await ipcRenderer.invoke('read-syllabus', {
            name: file.name, content: file.content || '', sourcePath: file.sourcePath || ''
        });
    } catch (e) {
        res = { error: e.message };
    } finally {
        if (btn) { btn.textContent = originalText; btn.disabled = false; }
    }
    if (!res || res.error) {
        toast.error((res && res.error) || 'Please try again.', 'Could not read the file');
        return;
    }
    if (!res.items.length) {
        toast.info('No exams or submission dates in this file. This works on a syllabus, a course schedule or an assignment sheet.', 'Nothing found');
        return;
    }

    if (syllabusWindowBusy()) {
        pendingSyllabusReviews.push(() => showSyllabusReview(file, res));
        toast.info(t('It opens when you close the window that is open now.'), t('The file is read'));
        return;
    }
    await showSyllabusReview(file, res);
}

async function showSyllabusReview(file, res) {
    // Ticked by default: everything that can go in and doesn't need a look.
    const items = res.items.map(i => {
        const note = syllabusNote(i);
        return { ...i, checked: !note };   // classes carry a (soft) note -> unticked
    });
    setSyllabusMode('syllabus');
    syllabusState = { file, items, saving: false };
    document.getElementById('syllabus-file').textContent = file.name;
    // Folder first, then the course named in the syllabus (matched to one
    // the user already has), then the file name - so the exams link to the
    // right questions without the user knowing anything about it.
    syllabusCourse.value = resolveCourse(file, res.course, await knownCourses().catch(() => []));
    if (syllabusGoogle) syllabusGoogle.checked = false;
    renderSyllabusList();
    syllabusModal.style.display = 'flex';
}

async function confirmSyllabusImport() {
    const state = syllabusState;
    if (!state || state.saving) return;
    const picked = state.items.filter(i => i.checked);
    if (!picked.length) return;
    const timetable = state.mode === 'timetable';
    if (timetable) {
        // A date typed but not applied yet (no Enter, straight to Add): apply it first.
        const typed = syllabusUntilText ? syllabusUntilText.value.trim() : '';
        // Clicking Add also blurs the field, whose change event may have
        // started reading it already - wait for that read too.
        const typedFrom = syllabusFromText ? syllabusFromText.value.trim() : '';
        const fromWaiting = (typedFrom && typedFrom !== state.fromTextApplied) || state.fromPending;
        if ((typed && typed !== state.untilTextApplied && !state.noEnd) || state.untilPending || fromWaiting) {
            state.saving = true;
            syllabusConfirm.disabled = true;
            syllabusCancel.disabled = true;   // no closing half way: Add was clicked
            const reads = [];
            if (typed && typed !== state.untilTextApplied && !state.noEnd) reads.push(applyTimetableUntil(typed));
            if (typedFrom && typedFrom !== state.fromTextApplied) reads.push(applyTimetableFrom(typedFrom));
            await Promise.all(reads);
            while (state.untilPending || state.fromPending) await (state.untilPending || state.fromPending);
            state.saving = false;
            syllabusCancel.disabled = false;
            if (syllabusState !== state) return;
        }
        // The start just read can change which classes are already in the
        // Planner, and so their ticks - the student sees that before adding.
        // By time, not by comparing ticks: a start read locally lands between
        // the press and the click, before `picked` was taken.
        if (state.ticksChangedAt && Date.now() - state.ticksChangedAt < 1000) {
            state.ticksChangedAt = 0;
            updateSyllabusConfirm();
            toast.info(t('The start date changed which classes are ticked - check them and press Add again.'));
            return;
        }
        if (!state.until && !state.noEnd) { updateSyllabusConfirm(); return; }
        if (state.fromError || timetableEndsBeforeStart(state)) { updateSyllabusConfirm(); return; }
    }
    const course = timetable ? '' : syllabusCourse.value.trim();
    const syncToGoogle = !!(syllabusGoogle && syllabusGoogle.checked && picked.some(i => i.kind === 'exam' || i.kind === 'class'));

    state.saving = true;
    syllabusConfirm.disabled = true;
    syllabusCancel.disabled = true;
    syllabusConfirm.textContent = syncToGoogle ? 'Adding and syncing…' : 'Adding…';
    let res;
    try {
        res = await ipcRenderer.invoke('import-syllabus-items',
            timetable ? picked.map(i => timetableImportItem(i, state))
                : picked.map(({ kind, title, date, until, time, durationMinutes, weekday, endTime }) => ({ kind, title, date, until, time, durationMinutes, weekday, endTime })),
            { course, syncToGoogle });
    } catch (e) {
        res = { created: { events: [], tasks: [] }, errors: [e.message], syncErrors: [] };
    }
    state.saving = false;
    syllabusCancel.disabled = false;

    const events = (res && res.created && res.created.events) || [];
    const tasks = (res && res.created && res.created.tasks) || [];
    if (!events.length && !tasks.length) {
        if (syllabusState === state) updateSyllabusConfirm();
        toast.error((res && res.errors && res.errors[0]) || 'Please try again.', 'Nothing was added');
        return;
    }
    if (syllabusState === state) closeSyllabusModal();

    await loadAndRenderTasks();
    await loadAndRenderWeeklyBoard();
    await loadAndRenderHome();
    if (typeof refreshOnboarding === 'function') refreshOnboarding();

    const parts = [];
    const classCount = events.filter(e => e.type === 'lesson').length;
    const examCount = events.length - classCount;
    const plannerBits = [classCount ? `${classCount} weekly class${classCount === 1 ? '' : 'es'}` : '',
                         examCount ? `${examCount} exam${examCount === 1 ? '' : 's'}` : ''].filter(Boolean);
    if (plannerBits.length) parts.push(`${plannerBits.join(' and ')} to the Planner`);
    if (tasks.length) parts.push(`${tasks.length} submission${tasks.length === 1 ? '' : 's'} to Tasks`);
    showUndoToast(`Added ${parts.join(' and ')}.`, async () => {
        // delete-event also removes the Google copy.
        for (const e of events) if (e.id) await ipcRenderer.invoke('delete-event', e.id);
        for (const t of tasks) if (t.id) await ipcRenderer.invoke('delete-task', t.id);
        await loadAndRenderTasks();
        await loadAndRenderWeeklyBoard();
        await loadAndRenderHome();
    }, 10000);

    if (res.errors && res.errors.length) toast.warning(res.errors[0], `${res.errors.length} item(s) could not be added`);
    if (syncToGoogle && res.syncErrors && res.syncErrors.length) toast.warning(`Added in MindSync, but not in Google Calendar: ${res.syncErrors[0]}`);
}

if (syllabusConfirm) syllabusConfirm.onclick = confirmSyllabusImport;
if (syllabusCancel) syllabusCancel.onclick = closeSyllabusModal;

// ---- Weekly timetable from a photo (1/10) ----
// The student picks a photo / screenshot (or a PDF) of their weekly timetable;
// it is shrunk here (a phone photo is 4-8MB, the web server takes 3MB), the
// AI lists the classes (read-timetable in main.js), and the syllabus window
// opens in "timetable" mode: a course, day and hours per row, one end date
// for all. Adding goes through import-syllabus-items, with Undo.
const timetableBtn = document.getElementById('timetable-photo-btn');
const timetableFileInput = document.getElementById('timetable-file');
const syllabusUntilWrap = document.getElementById('syllabus-until-wrap');
const syllabusUntilText = document.getElementById('syllabus-until-text');
const syllabusUntilDate = document.getElementById('syllabus-until-date');
const syllabusUntilHint = document.getElementById('syllabus-until-hint');
const syllabusNoEnd = document.getElementById('syllabus-no-end');
const syllabusFromText = document.getElementById('syllabus-from-text');
const syllabusFromDate = document.getElementById('syllabus-from-date');
const syllabusFromHint = document.getElementById('syllabus-from-hint');
const TIMETABLE_MAX_BYTES = 2100 * 1024;   // ~2.8MB once base64 - under the server's 3MB
const TIMETABLE_TYPE_LABEL = {
    lecture: ['Lecture', 'הרצאה'], tutorial: ['Tutorial', 'תרגול'], lab: ['Lab', 'מעבדה'],
    seminar: ['Seminar', 'סמינר'], other: ['Class', 'שיעור']
};
const TIMETABLE_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The window is shared with the syllabus import; these are its two faces.
function setSyllabusMode(mode) {
    const timetable = mode === 'timetable';
    const heading = document.getElementById('syllabus-heading');
    if (heading) heading.textContent = timetable ? t('Weekly timetable') : t('Exams & deadlines');
    const courseWrap = document.getElementById('syllabus-course-wrap');
    if (courseWrap) courseWrap.hidden = timetable;
    if (syllabusUntilWrap) syllabusUntilWrap.hidden = !timetable;
}

// "Statistics (Tutorial)" / "למידה סטטיסטית (תרגול)" - in the course's language.
function timetableTitle(item) {
    const course = String(item.course || '').trim();
    if (item.classType === 'other') return course;
    const [en, he] = TIMETABLE_TYPE_LABEL[item.classType] || TIMETABLE_TYPE_LABEL.other;
    return `${course} (${/[\u0590-\u05FF]/.test(course) ? he : en})`;
}
const timeToMin = (hm) => { const m = /^(\d\d):(\d\d)$/.exec(hm || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
function timetableImportItem(item, state) {
    const s = timeToMin(item.time), e = timeToMin(item.endTime);
    const len = s !== null && e !== null && e > s ? e - s : null;
    return {
        kind: 'class', title: timetableTitle(item), course: String(item.course || '').trim(),
        weekday: item.weekday, time: item.time, endTime: item.endTime || null,
        durationMinutes: len && len >= 15 && len <= 720 ? len : null,
        until: state.noEnd ? null : state.until, from: state.from || null, location: item.location || ''
    };
}

function readAsBase64(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = () => reject(new Error(t('The file could not be read.')));
        r.readAsDataURL(blob);
    });
}
function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
        img.src = url;
    });
}
// A picture -> a JPEG of at most 2000px on its long side (text stays
// readable, a phone photo drops from megabytes to a few hundred KB).
async function timetablePayload(file) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
        if (file.size > TIMETABLE_MAX_BYTES) throw new Error(t('This PDF is too large. Take a screenshot of the timetable instead.'));
        return { mimeType: 'application/pdf', data: await readAsBase64(file) };
    }
    return shrinkPhoto(file, {
        maxBytes: TIMETABLE_MAX_BYTES,
        tooLarge: t('The picture is too large. Take a screenshot instead, or crop it to the timetable.'),
        cantOpen: t('This picture can\'t be opened here. Take a screenshot of it and choose that instead.')
    });
}

// A photo as a JPEG made here, in the browser (white behind transparency):
// the first of `steps` (longest side, quality) that fits `maxBytes`. A format
// this browser can't draw (HEIC on Chrome) goes as it is, if small enough.
async function shrinkPhoto(file, { maxBytes, tooLarge, cantOpen, steps = [[2000, 0.9]] }) {
    try {
        const img = await loadImage(file);
        let blob = null;
        for (const [edge, quality] of steps) {
            const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';   // a transparent PNG would turn black as a JPEG
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
            if (!blob) throw new Error('encode');
            if (blob.size <= maxBytes) break;
        }
        if (blob.size > maxBytes) throw new Error(tooLarge);
        return { mimeType: 'image/jpeg', data: await readAsBase64(blob) };
    } catch (err) {
        if (err.message !== 'decode' && err.message !== 'encode') throw err;
        if (/^image\/(png|jpeg|webp|heic|heif)$/.test(file.type) && file.size <= maxBytes) {
            return { mimeType: file.type, data: await readAsBase64(file) };
        }
        throw new Error(cantOpen);
    }
}

async function openTimetableImport(file, btn) {
    const originalHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.textContent = t('Reading…'); btn.disabled = true; }
    let res;
    let known = [];
    try {
        const payload = await timetablePayload(file);
        known = await knownCourses().catch(() => []);
        res = await ipcRenderer.invoke('read-timetable', { ...payload, knownCourses: known });
    } catch (e) {
        res = { error: e.message };
    } finally {
        if (btn) { btn.innerHTML = originalHTML; btn.disabled = false; }
    }
    if (!res || res.error) {
        toast.error((res && res.error) || t('Please try again.'), t('Could not read the timetable'));
        return;
    }
    if (!res.items.length) {
        toast.info(t('No classes found in this picture. Try a clearer screenshot of the whole week.'), t('Nothing found'));
        return;
    }
    if (syllabusWindowBusy()) {
        pendingSyllabusReviews.push(() => showTimetableReview(file, res, known));
        toast.info(t('It opens when you close the window that is open now.'), t('The timetable is read'));
        return;
    }
    showTimetableReview(file, res, known);
}

function showTimetableReview(file, res, known) {
    setSyllabusMode('timetable');
    syllabusState = {
        mode: 'timetable', file: { name: file.name }, saving: false,
        // Ticked unless already in the Planner or not every week.
        items: res.items.map(i => ({ ...i, checked: !i.alreadyExists && i.everyWeek !== false })),
        until: res.suggestedUntil || null, noEnd: false, untilError: null, untilTextApplied: '',
        untilSuggested: !!res.suggestedUntil,   // offered, not chosen - a later start clears it
        // The first day of classes - empty = already started (from today).
        from: res.suggestedFrom || null, fromError: null, fromNote: null, fromTextApplied: ''
    };
    document.getElementById('syllabus-file').textContent = file.name;
    const list = document.getElementById('syllabus-courses');
    if (list) {
        list.innerHTML = '';
        for (const k of known) { const o = document.createElement('option'); o.value = k; list.appendChild(o); }
    }
    if (syllabusUntilText) syllabusUntilText.value = '';
    if (syllabusUntilDate) syllabusUntilDate.value = syllabusState.until || '';
    if (syllabusFromText) syllabusFromText.value = '';
    if (syllabusFromDate) syllabusFromDate.value = syllabusState.from || '';
    if (syllabusNoEnd) syllabusNoEnd.checked = false;
    if (syllabusGoogle) syllabusGoogle.checked = false;
    renderSyllabusList();
    syllabusModal.style.display = 'flex';
}

function timetableNote(item) {
    if (item.alreadyExists) return { text: t('Already in your Planner at that time') };
    if (item.everyWeek === false) return { text: t('Not every week - check it before adding'), soft: true };
    if (item.note) return { text: item.note, soft: true, user: true };
    return null;
}

function renderTimetableList() {
    const state = syllabusState;
    syllabusList.innerHTML = '';
    state.items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'syllabus-row timetable-row';

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!item.checked;
        box.setAttribute('aria-label', t('Add this class'));
        box.onchange = () => { item.checked = box.checked; updateSyllabusConfirm(); };

        const body = document.createElement('span');
        body.className = 'syllabus-row__body';
        const top = document.createElement('span');
        top.className = 'syllabus-row__top';
        const kind = document.createElement('span');
        kind.className = 'syllabus-kind syllabus-kind--class';
        kind.textContent = t((TIMETABLE_TYPE_LABEL[item.classType] || TIMETABLE_TYPE_LABEL.other)[0]);
        top.append(kind);
        if (item.matched && item.printedCourse && item.printedCourse !== item.course) {
            const was = document.createElement('span');
            was.className = 'syllabus-row__meta';
            was.textContent = t('In the timetable: {name}', { name: item.printedCourse });
            top.append(was);
        }

        const fields = document.createElement('span');
        fields.className = 'timetable-row__fields';
        const course = document.createElement('input');
        course.className = 'input-field timetable-row__course';
        course.dir = 'auto';
        course.maxLength = 80;
        course.value = item.course || '';
        course.setAttribute('list', 'syllabus-courses');
        course.setAttribute('aria-label', t('Course'));
        course.oninput = () => { item.course = course.value; updateSyllabusConfirm(); };
        const day = document.createElement('select');
        day.className = 'input-field timetable-row__day';
        day.setAttribute('aria-label', t('Day'));
        for (const d of TIMETABLE_DAYS) {
            const o = document.createElement('option');
            o.value = d;
            o.textContent = t(d);
            day.appendChild(o);
        }
        day.value = item.weekday;
        day.onchange = () => { item.weekday = day.value; };
        const start = document.createElement('input');
        start.type = 'time';
        start.className = 'input-field timetable-row__time';
        start.value = item.time || '';
        start.setAttribute('aria-label', t('Starts'));
        start.onchange = () => { item.time = start.value; updateSyllabusConfirm(); };
        const dash = document.createElement('span');
        dash.className = 'timetable-row__dash';
        dash.textContent = '–';
        const end = document.createElement('input');
        end.type = 'time';
        end.className = 'input-field timetable-row__time';
        end.value = item.endTime || '';
        end.setAttribute('aria-label', t('Ends'));
        end.onchange = () => { item.endTime = end.value; };
        const hours = document.createElement('span');
        hours.className = 'timetable-row__hours';   // start and end wrap together on a phone
        hours.append(start, dash, end);
        fields.append(course, day, hours);
        body.append(top, fields);

        const where = [item.location, item.lecturer].filter(Boolean).join(' · ');
        if (where) {
            const meta = document.createElement('span');
            meta.className = 'syllabus-row__meta timetable-row__where';
            meta.dir = 'auto';
            meta.textContent = where;
            body.append(meta);
        }
        const note = timetableNote(item);
        if (note) {
            const n = document.createElement('span');
            n.className = 'syllabus-row__note' + (note.soft ? ' syllabus-row__note--soft' : '') + (note.user ? ' timetable-row__ai-note' : '');
            if (note.user) n.dir = 'auto';
            n.textContent = note.text;
            body.append(n);
        }
        row.append(box, body);
        syllabusList.appendChild(row);
    });
    updateSyllabusConfirm();
}

function updateTimetableConfirm() {
    const state = syllabusState;
    const picked = state.items.filter(i => i.checked);
    // A ticked class needs a course and a start time.
    const incomplete = picked.filter(i => !String(i.course || '').trim() || !/^\d\d:\d\d$/.test(i.time || '')).length;
    const typed = syllabusUntilText ? syllabusUntilText.value.trim() : '';
    const endsBeforeStart = timetableEndsBeforeStart(state);
    const startBad = !!state.fromError || endsBeforeStart;
    const ready = !!(state.until || state.noEnd || (typed && typed !== state.untilTextApplied)) && !startBad;
    syllabusConfirm.disabled = picked.length === 0 || !ready || incomplete > 0 || state.saving;
    if (syllabusFromHint) {
        syllabusFromHint.textContent = state.fromError ? state.fromError
            : endsBeforeStart ? t('The semester can\'t end before it starts.')
            : state.fromNote ? state.fromNote
            : state.from ? t('The classes start on {d}.', { d: untilLabel(state.from) })
            : t('Already started? Leave it empty.');
    }
    syllabusConfirm.textContent = picked.length === 0 ? t('Add') : t(picked.length === 1 ? 'Add 1 item' : `Add ${picked.length} items`);
    if (syllabusGoogleRow) syllabusGoogleRow.hidden = picked.length === 0;
    if (syllabusUntilHint) {
        syllabusUntilHint.textContent = state.untilError ? state.untilError
            : state.until ? t('The classes repeat every week until {d}.', { d: untilLabel(state.until) })
            : t('The classes repeat every week until this day.');
    }
    syllabusIntro.textContent = picked.length === 0 ? t('Tick what you want to add.')
        : incomplete ? t('Every ticked class needs a course and a start time.')
        : startBad ? t('Check when the semester starts.')
        : !ready ? t('Write when the semester ends - or tick "I don\'t know yet".')
        : t(picked.length === 1 ? '1 weekly class to the Planner' : `${picked.length} weekly classes to the Planner`) + '.';
}

// The one end date: a typed "15.2" (read like every date in the app) or the date picker.
async function applyTimetableUntil(text) {
    const state = syllabusState;
    if (!state || state.mode !== 'timetable' || text === state.untilTextApplied) return;
    state.untilTextApplied = text;   // Enter and the field's change both fire - read it once
    const pending = ipcRenderer.invoke('parse-exam-dates', text).catch(e => ({ error: e.message }));
    state.untilPending = pending;
    const r = await pending;
    if (state.untilPending === pending) state.untilPending = null;
    if (!syllabusState || syllabusState !== state || state.untilTextApplied !== text) return;
    const date = r && !r.error && r.exams && r.exams.length ? r.exams[0].date : null;
    if (!date) {
        state.until = null;   // never keep an older date behind an error
        state.untilError = (r && r.error) || t('Couldn\'t tell the date. Try writing it like "15.2".');
    } else if (date < localIsoDate(new Date())) {
        state.until = null;
        state.untilError = t('That day has already passed.');
    } else {
        state.until = date;
        state.untilSuggested = false;
        state.untilError = null;
        if (syllabusUntilDate) syllabusUntilDate.value = date;
    }
    updateSyllabusConfirm();
}
// The semester's first day - typed ("11.10", read like every date in the app)
// or picked. Optional: empty means it has already started.
async function applyTimetableFrom(text) {
    const state = syllabusState;
    if (!state || state.mode !== 'timetable' || text === state.fromTextApplied) return;
    state.fromTextApplied = text;   // Enter and the field's change both fire - read it once
    const pending = ipcRenderer.invoke('parse-exam-dates', text, { start: true }).catch(e => ({ error: e.message }));
    state.fromPending = pending;
    const r = await pending;
    if (state.fromPending === pending) state.fromPending = null;
    if (!syllabusState || syllabusState !== state || state.fromTextApplied !== text) return;
    const date = r && !r.error && r.exams && r.exams.length ? r.exams[0].date : null;
    setTimetableFrom(state, date, date ? null : ((r && r.error) || t('Couldn\'t tell the date. Try writing it like "11.10".')));
}
// (Typed text is read in "start" mode: a date with no year that passed
// lately - "1.10" on 2/10 - stays this year's, and comes back as passed.)
function setTimetableFrom(state, date, error) {
    state.from = null; state.fromError = null; state.fromNote = null;
    const now = new Date();
    const latest = localIsoDate(new Date(now.getFullYear() + 1, now.getMonth() + 3, now.getDate()));
    if (!date) state.fromError = error;
    // A start that has passed isn't a mistake: the semester began already.
    else if (date <= localIsoDate(now)) state.fromNote = t('That day has passed - the classes start from today.');
    else if (date > latest) state.fromError = t('That date is too far ahead.');
    else state.from = date;
    // The end offered from the classes already in the Planner is the current
    // semester's: before a later start, it's not this one's end.
    if (state.from && state.untilSuggested && state.until && state.until < state.from) {
        state.until = null;
        state.untilSuggested = false;
        if (syllabusUntilDate) syllabusUntilDate.value = '';
    }
    if (syllabusFromDate) syllabusFromDate.value = state.from || '';
    refreshTimetableExisting(state);
    updateSyllabusConfirm();
}
// "Already in your Planner" depends on the start: the same class from
// semester A, ending before semester B starts, isn't already there. A row
// whose answer changes gets the matching tick.
function refreshTimetableExisting(state) {
    const at = state.from || localIsoDate(new Date());
    let changed = false;
    for (const item of state.items) {
        const exists = !!item.existingUntil && item.existingUntil >= at;
        if (exists === !!item.alreadyExists) continue;
        item.alreadyExists = exists;
        item.checked = !exists && item.everyWeek !== false;
        changed = true;
    }
    if (changed) { state.ticksChangedAt = Date.now(); renderSyllabusList(); }
}
function timetableEndsBeforeStart(state) {
    return !!(state.from && state.until && !state.noEnd && state.until < state.from);
}
// Typing a date means "this date", not "no end date".
function typedTimetableUntil() {
    if (!syllabusState || syllabusState.mode !== 'timetable') return;
    syllabusState.noEnd = false;
    syllabusState.untilError = null;   // an error about the old text, not this one
    syllabusState.untilTextApplied = '';   // new text: read it again
    if (syllabusNoEnd) syllabusNoEnd.checked = false;
}
if (syllabusUntilText) {
    syllabusUntilText.addEventListener('input', () => { typedTimetableUntil(); updateSyllabusConfirm(); });
    syllabusUntilText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const v = syllabusUntilText.value.trim(); if (v) applyTimetableUntil(v); }
    });
    syllabusUntilText.addEventListener('change', () => { const v = syllabusUntilText.value.trim(); if (v) applyTimetableUntil(v); });
}
if (syllabusFromText) {
    syllabusFromText.addEventListener('input', () => {
        const state = syllabusState;
        if (!state || state.mode !== 'timetable') return;
        state.fromError = null; state.fromNote = null;   // about the old text, not this one
        state.fromTextApplied = '';                      // new text: read it again
        // Emptied: no start date - the classes start from today.
        if (!syllabusFromText.value.trim()) {
            state.from = null; state.fromTextApplied = '';
            if (syllabusFromDate) syllabusFromDate.value = '';
            refreshTimetableExisting(state);   // judged at today again
        }
        updateSyllabusConfirm();
    });
    syllabusFromText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const v = syllabusFromText.value.trim(); if (v) applyTimetableFrom(v); }
    });
    syllabusFromText.addEventListener('change', () => { const v = syllabusFromText.value.trim(); if (v) applyTimetableFrom(v); });
}
if (syllabusFromDate) {
    syllabusFromDate.addEventListener('change', () => {
        const state = syllabusState;
        if (!state || state.mode !== 'timetable') return;
        const v = syllabusFromDate.value;
        // The picker wins over text typed before it.
        if (syllabusFromText) syllabusFromText.value = '';
        state.fromTextApplied = '';
        setTimetableFrom(state, /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null, null);
    });
}
if (syllabusUntilDate) {
    syllabusUntilDate.addEventListener('change', () => {
        const state = syllabusState;
        if (!state || state.mode !== 'timetable') return;
        const v = syllabusUntilDate.value;
        if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v < localIsoDate(new Date())) {
            state.until = null;
            state.untilError = t('That day has already passed.');
        } else {
            state.until = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
            state.untilSuggested = false;
            state.untilError = null;
            if (state.until) { state.noEnd = false; if (syllabusNoEnd) syllabusNoEnd.checked = false; }
        }
        // The picker wins over text typed before it.
        if (syllabusUntilText) syllabusUntilText.value = '';
        state.untilTextApplied = '';
        updateSyllabusConfirm();
    });
}
if (syllabusNoEnd) {
    syllabusNoEnd.addEventListener('change', () => {
        if (!syllabusState || syllabusState.mode !== 'timetable') return;
        syllabusState.noEnd = syllabusNoEnd.checked;
        updateSyllabusConfirm();
    });
}
if (timetableBtn && timetableFileInput) {
    timetableBtn.onclick = () => { timetableFileInput.value = ''; timetableFileInput.click(); };
    timetableFileInput.onchange = () => {
        const f = timetableFileInput.files && timetableFileInput.files[0];
        if (f) openTimetableImport(f, timetableBtn);
    };
}

const saveFolderBtnFinal = document.getElementById('save-folder-btn');
if (saveFolderBtnFinal) {
    saveFolderBtnFinal.onclick = async () => {
        const name = document.getElementById('folder-name-input').value;
        if (!name) return toast.error('Folder name is required!');
        const result = await ipcRenderer.invoke('save-folder', { name: name });
        if (result && result.error) { toast.error('Could not save folder: ' + result.error); return; }
        document.getElementById('folder-name-input').value = '';
        addFolderModal.style.display = 'none';
        await loadAndRenderFolders();
    };
}

const cancelFolderBtnFinal = document.getElementById('cancel-folder-btn');
if (cancelFolderBtnFinal) {
    cancelFolderBtnFinal.onclick = () => {
        addFolderModal.style.display = 'none';
    };
}

loadAndRenderFolders();
loadAndRenderFiles();

// ==========================================
// 8. Settings - App Blocker
// ==========================================
window.addNewAppBlocker = async function() {
    const input = document.getElementById('blocked-app-input');
    if (!input) return;
    
    let val = input.value.trim();
    if (!val) {
        toast.error("You didn't type anything! Please enter an app name (e.g., chrome.exe)");
        return;
    }
    
    if (!val.toLowerCase().endsWith('.exe')) {
        val += '.exe';
    }
    
    await ipcRenderer.invoke('add-blocked-app', val);
    input.value = ''; 
    await loadAndRenderBlockedApps();
};

async function loadAndRenderBlockedApps() {
    const list = document.getElementById('blocked-apps-list');
    if (!list) return;
    
    const apps = await ipcRenderer.invoke('get-blocked-apps');
    list.innerHTML = '';
    
    if (!apps || apps.length === 0) {
        list.innerHTML = '<div class="blocked-empty">Nothing is being blocked yet.</div>';
        return;
    }

    apps.forEach(appName => {
        // Rendered as a chip rather than a full-width row: the list is short
        // strings, so rows left a huge gap between the name and its button,
        // which is why the Remove control looked detached.
        const item = document.createElement('div');
        item.className = 'blocked-app';
        item.innerHTML = `
            <span class="blocked-app__name" dir="ltr"></span>
            <button class="blocked-app__remove" aria-label="Stop blocking ${escapeHtml(appName)}" title="Remove">${icon('close', { size: 14 })}</button>
        `;
        item.querySelector('.blocked-app__name').textContent = appName;

        item.querySelector('.blocked-app__remove').onclick = async () => {
            await ipcRenderer.invoke('remove-blocked-app', appName);
            await loadAndRenderBlockedApps();
            toast.info(`${appName} removed from the block list.`);
        };

        list.appendChild(item);
    });
}

loadAndRenderBlockedApps();

// No inline onclick="" in index.html (30/9): the web version's security
// policy (CSP) blocks inline script, so these are wired here.
document.querySelectorAll('[data-go]').forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); const nav = document.getElementById(el.dataset.go); if (nav) nav.click(); });
});
// Screen explanations (30/9): each grey help list is now a small foldable
// "How this screen works" line. Open until the user closes it once - that
// choice is remembered per screen, so the regulars get their space back.
document.querySelectorAll('ul.screen-help').forEach((list) => {
    const view = list.closest('.view-section');
    const key = `mindsync.help.${view ? view.id : 'screen'}`;
    const box = document.createElement('details');
    box.className = 'screen-help-box';
    let closed = false;
    try { closed = localStorage.getItem(key) === 'closed'; } catch (e) { /* no storage - stays open */ }
    box.open = !closed;
    const summary = document.createElement('summary');
    summary.className = 'screen-help-box__toggle';
    summary.innerHTML = `${window.icon('info', { size: 15 })}<span>How this screen works</span>`;
    list.replaceWith(box);
    box.append(summary, list);
    box.addEventListener('toggle', () => {
        try { localStorage.setItem(key, box.open ? 'open' : 'closed'); } catch (e) { /* ignore */ }
    });
});
const blockedAppInput = document.getElementById('blocked-app-input');
if (blockedAppInput) blockedAppInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.addNewAppBlocker(); });
const blockedAppAddBtn = document.getElementById('blocked-app-add-btn');
if (blockedAppAddBtn) blockedAppAddBtn.addEventListener('click', () => window.addNewAppBlocker());

// ==========================================
// 9. Modals closing
// ==========================================
// Closing by a click outside or Escape (30/9): respects what the window is
// doing - an upload or a syllabus import in progress isn't hidden half way -
// and closes the calendar box the proper way (it left an edit behind).
function modalIsBusy(modal) {
    if (modal === uploadModal && uploadBatch && uploadBatch.running) return true;
    if (modal === syllabusModal && syllabusCancel && syllabusCancel.disabled) return true;
    return false;
}
function closeModalSafely(modal) {
    if (modalIsBusy(modal)) return;
    // An edit is closed properly (cleared); a new item being typed keeps its draft.
    if (modal === addEventModal && editingEvent) { closeAddEventModal(); return; }
    // The import window: closed properly, so a review waiting for it opens.
    if (modal === syllabusModal) { closeSyllabusModal(); return; }
    modal.style.display = 'none';
}
document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModalSafely(modal);
    });
});

// ==========================================
// 10. Progress & Stats
// ==========================================
// BUG FIX: this used to fetch /stats first and bail out (return) if it came
// back empty - which it always does now, since XP/levels/streak were removed
// server-side. That early return meant the ENTIRE Progress page rendered
// nothing, including the category breakdown and "needs attention" list
// below, which only ever needed the task list and never depended on stats
// at all. Gamification is gone by design, so this no longer tries to load
// it - it goes straight to the part that actually works.
async function loadAndRenderProgress() {
    const progressView = document.getElementById('view-progress');
    if (!progressView) return;
    await Promise.all([renderLearningProgress(), renderProgressInsights()]);
}

// Learning part of Progress (30/9): exam readiness per course, then the
// panels about how well you judge what you know (moved here from Study).
async function renderLearningProgress() {
    const stats = await ipcRenderer.invoke('get-study-stats').catch(() => null);
    if (!stats || stats.error) return;
    renderReadiness(stats.subjects || []);
    renderSidebarCourses(stats.subjects || []);
    renderCalibration(stats.calibration, stats.reviewsAllTime, stats.trendByConfidence);
    renderConfidentlyWrong(stats.confidentlyWrong);
    renderAttentionList('underconfident-panel', stats.underconfidentItems,
        'Nothing here yet — no pattern of doubting yourself on things you actually know.', 'good');
    renderAttentionList('genuine-difficulty-panel', stats.genuineDifficultyItems,
        'Nothing flagged as genuinely hard right now.', 'warn');
    updateStudyPanelsVisibility(stats);
}

// "Exam in 6 days · Thu 8/10" - shared by Study's course rows and Progress.
function examChipText(exam) {
    const [y, m, d] = exam.date.split('-').map(Number);
    const when = exam.daysLeft === 0 ? 'Exam today' : exam.daysLeft === 1 ? 'Exam tomorrow' : `Exam in ${exam.daysLeft} days`;
    return `${when} · ${WEEKDAY_NAMES[new Date(y, m - 1, d).getDay()].slice(0, 3)} ${d}/${m}`;
}

// ---- Readiness, in words (30/9, reworked) ----------------------------------
// The server (routes/study.js readinessOf) gives each course a status from
// two separate things: how much of it was practiced, and how much of THAT
// is known. Too little practice gets no verdict - "Just started", not "12%".
const READINESS_STATUS = {
    not_started: { label: 'Not started', tip: 'No question in this course was answered yet.' },
    too_early:   { label: 'Just started', tip: 'Too few answers to judge yet - practice a few more.' },
    building:    { label: 'In progress', tip: "You're practicing, but a good part of what you practiced isn't known yet." },
    on_track:    { label: 'On track', tip: 'Most of what you practiced, you know. Keep going.' },
    at_risk:     { label: 'At risk', tip: "The exam is close and there's a lot left." },
    ready:       { label: 'Ready', tip: 'You practiced most of the course and know most of it.' }
};
// An older server sends no status: work one out from the old numbers.
function readinessStatus(r) {
    if (r.status && READINESS_STATUS[r.status]) return r.status;
    return r.unseen === r.total ? 'not_started' : 'building';
}
// "Practiced 12 of 40 · you know 9 of them." (known includes fading ones -
// they were answered right; the fading ones are said separately).
function readinessFacts(r) {
    const practiced = r.practiced != null ? r.practiced : r.total - r.unseen;
    const know = (r.known || 0) + (r.fading || 0);
    return `Practiced ${practiced} of ${r.total} · you know ${know} of them.`;
}

// What the numbers mean, in words - the student shouldn't have to work out
// what "12 / 3 / 5 / 10" says about next Thursday.
function readinessSentence(s) {
    const r = s.readiness;
    const status = readinessStatus(r);
    const parts = [];
    const days = s.exam ? s.exam.daysLeft : null;
    if (status === 'not_started' || r.unseen === r.total) {
        parts.push('You haven\'t practiced this course yet.');
        if (s.exam && r.perDay > 1) parts.push(days <= 1
            ? `Before the exam, try as many of the ${r.unseen} as you can.`
            : `About ${r.perDay} questions a day covers it before the exam.`);
    } else {
        parts.push(readinessFacts(r));
        if (r.sureWrong) parts.push(r.sureWrong === 1
            ? '1 you were sure about turned out wrong - it comes first in practice.'
            : `${r.sureWrong} you were sure about turned out wrong - they come first in practice.`);
        if (r.shaky) parts.push(`${r.shaky} ${r.shaky === 1 ? 'is' : 'are'} shaky (partly right, or right by guessing).`);
        if (r.fading) parts.push(r.fading === 1
            ? '1 needs a refresh (answered right, but a while ago).'
            : `${r.fading} need a refresh (answered right, but a while ago).`);
        if (r.unseen) {
            // A pace only when it says something ("about 1 a day" for 1 left doesn't).
            if (s.exam && r.perDay > 1 && days > 1) parts.push(`${r.unseen} not practiced yet - about ${r.perDay} a day before the exam.`);
            else if (s.exam && days <= 1) parts.push(`${r.unseen} not practiced yet - try as many as you can before the exam.`);
            else parts.push(`${r.unseen} not practiced yet.`);
        }
        if (status === 'too_early') parts.push('A few more answers and this shows how ready you are.');
        if (status === 'at_risk' && r.reason === 'knowledge') parts.push('Go over the ones you got wrong first.');
        if (status === 'ready' && s.exam) parts.push('Keep it fresh until the exam.');
    }
    if (s.lastMock) parts.push(`Last mock exam: ${s.lastMock.score} out of 100.`);
    if (!s.exam) parts.push('No exam date yet - add it (Study or Planner) and practice is timed to it.');
    if (r.filesWithoutQuestions) parts.push(r.filesWithoutQuestions === 1
        ? '1 file in this course has no questions yet.'
        : `${r.filesWithoutQuestions} files in this course have no questions yet.`);
    return parts.join(' ');
}

function readinessPill(r) {
    const status = readinessStatus(r);
    const pill = document.createElement('span');
    pill.className = `rd-status rd-status--${status}`;
    pill.textContent = READINESS_STATUS[status].label;
    pill.title = status === 'at_risk' && r.reason === 'knowledge'
        ? "The exam is close and much of what you practiced isn't known yet."
        : status === 'at_risk' ? "The exam is close and much of the course isn't practiced yet."
        : READINESS_STATUS[status].tip;
    return pill;
}

// Set by "Details" in the sidebar: the course to scroll to in Progress.
let readinessFocus = null;

function renderReadiness(subjects) {
    const list = document.getElementById('readiness-list');
    const legend = document.getElementById('readiness-legend');
    if (!list) return;
    list.innerHTML = '';
    const withQuestions = subjects.filter(s => s.readiness && s.readiness.total > 0);
    if (legend) legend.hidden = withQuestions.length === 0;
    if (withQuestions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'readiness-empty';
        const p = document.createElement('p');
        p.className = 'ms-muted ms-text-sm';
        p.textContent = 'No practice questions yet. Make them from a course file, practice a little, and this shows how ready you are for each exam.';
        const btn = document.createElement('button');
        btn.className = 'btn-primary btn-sm';
        btn.textContent = 'Make questions';
        btn.onclick = () => goAndClick('nav-study', 'generate-study-btn');
        empty.append(p, btn);
        list.append(empty);
        readinessFocus = null;
        return;
    }
    let focusRow = null;
    withQuestions.forEach(s => {
        const r = s.readiness;
        const row = document.createElement('div');
        row.className = 'readiness-row';
        if (readinessFocus === s.category) focusRow = row;

        const head = document.createElement('div');
        head.className = 'readiness-row__head';
        const name = document.createElement('span');
        name.className = 'readiness-row__name';
        name.dir = 'auto';
        name.textContent = s.category === 'Uncategorized' ? t('No course') : s.category;
        head.append(name);
        if (s.exam) {
            const exam = document.createElement('span');
            exam.className = 'study-course__exam' + (s.exam.daysLeft <= 7 ? ' is-soon' : '');
            exam.textContent = examChipText(s.exam);
            exam.title = s.exam.title;
            head.append(exam);
        }
        head.append(readinessPill(r));

        const bar = document.createElement('div');
        bar.className = 'readiness-bar';
        [['known', 'rd-known', 'Know it'], ['fading', 'rd-fading', 'Needs a refresh'], ['shaky', 'rd-shaky', 'Shaky'],
         ['notKnown', 'rd-not', 'Don\'t know yet'], ['unseen', 'rd-unseen', 'Not practiced']]
            .forEach(([key, cls, label]) => {
                if (!r[key]) return;
                const seg = document.createElement('span');
                seg.className = `readiness-bar__seg ${cls}`;
                seg.style.width = `${(r[key] / r.total) * 100}%`;
                seg.title = `${label}: ${r[key]}`;
                bar.append(seg);
            });

        const text = document.createElement('p');
        text.className = 'readiness-row__text';
        text.textContent = readinessSentence(s);

        const practice = document.createElement('button');
        practice.className = (r.sureWrong || r.notKnown || s.due) ? 'btn-primary btn-sm' : 'btn-secondary btn-sm';
        practice.textContent = 'Practice this course';
        practice.onclick = () => practiceCourse(s.category, name.textContent);

        const foot = document.createElement('div');
        foot.className = 'readiness-row__foot';
        const buttons = document.createElement('div');
        buttons.className = 'readiness-row__buttons';
        // Mock exam (30/9): the evidence behind "how ready am I".
        if ((r.total || 0) >= 5) {
            const mock = document.createElement('button');
            mock.className = 'btn-secondary btn-sm';
            mock.textContent = t('Mock exam');
            mock.onclick = () => { document.getElementById('nav-study').click(); setTimeout(() => openExamSetup(s.category, name.textContent, r.total), 60); };
            buttons.append(mock);
        }
        buttons.append(practice);
        foot.append(text, buttons);
        row.append(head, bar, foot);
        list.append(row);
    });
    if (focusRow) {
        focusRow.classList.add('is-focus');
        focusRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(() => focusRow.classList.remove('is-focus'), 2200);
    }
    readinessFocus = null;
}

// Study -> a session of one course (from Progress and the sidebar).
function practiceCourse(category, label) {
    document.getElementById('nav-study').click();
    setTimeout(() => startStudySession(null, { category, label }), 60);
}

// ---- Sidebar: "My courses" (30/9) -----------------------------------------
// The space under "Up next" shows each course: a dot for its status, the
// exam countdown, and - on a click - the facts and a Practice button. Filled
// from the same stats Study and Progress load; Home asks for them itself.
const SIDEBAR_COURSES_SHOWN = 5;
const sidebarCoursesKey = 'mindsync.sidebarCourses.collapsed';
let sidebarCoursesOpen = null;      // the course whose details are open
let sidebarCoursesAll = false;      // "Show all" pressed
let sidebarSubjects = [];

function sidebarCoursesCollapsed() {
    try { return localStorage.getItem(sidebarCoursesKey) === '1'; } catch (e) { return false; }
}

function renderSidebarCourses(subjects) {
    const box = document.getElementById('sidebar-courses');
    const list = document.getElementById('sidebar-courses-list');
    const toggle = document.getElementById('sidebar-courses-toggle');
    if (!box || !list) return;
    if (Array.isArray(subjects)) sidebarSubjects = subjects.filter(s => s.readiness && s.readiness.total > 0);
    const courses = sidebarSubjects;
    box.hidden = false;
    const collapsed = sidebarCoursesCollapsed();
    box.classList.toggle('is-collapsed', collapsed);
    if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
    list.hidden = collapsed;
    list.innerHTML = '';
    if (collapsed) return;

    if (courses.length === 0) {
        const hint = document.createElement('button');
        hint.type = 'button';
        hint.className = 'sb-courses-empty';
        hint.textContent = 'Your courses show up here once you make practice questions.';
        hint.onclick = () => document.getElementById('nav-study').click();
        list.append(hint);
        return;
    }
    if (!courses.some(s => s.category === sidebarCoursesOpen)) sidebarCoursesOpen = null;

    const shown = sidebarCoursesAll ? courses : courses.slice(0, SIDEBAR_COURSES_SHOWN);
    shown.forEach(s => {
        const r = s.readiness;
        const status = readinessStatus(r);
        const isOpen = sidebarCoursesOpen === s.category;
        const label = s.category === 'Uncategorized' ? t('No course') : s.category;

        const item = document.createElement('div');
        item.className = 'sb-course' + (isOpen ? ' is-open' : '');

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'sb-course__row';
        row.setAttribute('aria-expanded', String(isOpen));
        const dot = document.createElement('i');
        dot.className = `sb-dot rd-status--${status}`;
        dot.setAttribute('aria-hidden', 'true');
        const textBox = document.createElement('span');
        textBox.className = 'sb-course__text';
        const name = document.createElement('span');
        name.className = 'sb-course__name';
        name.dir = 'auto';
        name.textContent = label;
        const meta = document.createElement('span');
        meta.className = 'sb-course__meta';
        const when = !s.exam ? '' : s.exam.daysLeft === 0 ? 'Exam today' : s.exam.daysLeft === 1 ? 'Exam tomorrow' : `Exam in ${s.exam.daysLeft} days`;
        meta.textContent = when ? `${when} · ${READINESS_STATUS[status].label}` : READINESS_STATUS[status].label;
        if (s.exam && s.exam.daysLeft <= 7) meta.classList.add('is-soon');
        textBox.append(name, meta);
        row.title = READINESS_STATUS[status].tip;
        row.append(dot, textBox);
        row.onclick = () => {
            sidebarCoursesOpen = isOpen ? null : s.category;
            renderSidebarCourses();
        };
        item.append(row);

        if (isOpen) {
            const detail = document.createElement('div');
            detail.className = 'sb-course__detail';
            const facts = document.createElement('p');
            facts.textContent = r.unseen === r.total ? 'You haven\'t practiced this course yet.' : readinessFacts(r);
            detail.append(facts);
            const next = sidebarNextStep(s);
            if (next) {
                const p = document.createElement('p');
                p.className = 'sb-course__next';
                p.textContent = next;
                detail.append(p);
            }
            const actions = document.createElement('div');
            actions.className = 'sb-course__actions';
            const practice = document.createElement('button');
            practice.type = 'button';
            practice.className = 'btn-primary btn-sm';
            practice.textContent = 'Practice';
            practice.onclick = () => practiceCourse(s.category, label);
            const details = document.createElement('button');
            details.type = 'button';
            details.className = 'sb-course__link';
            details.textContent = 'Details';
            details.onclick = () => {
                readinessFocus = s.category;
                document.getElementById('nav-progress').click();
            };
            actions.append(practice, details);
            detail.append(actions);
            item.append(detail);
        }
        list.append(item);
    });

    if (courses.length > SIDEBAR_COURSES_SHOWN) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'sb-courses-more';
        more.textContent = sidebarCoursesAll ? 'Show fewer' : `Show all (${courses.length})`;
        more.onclick = () => { sidebarCoursesAll = !sidebarCoursesAll; renderSidebarCourses(); };
        list.append(more);
    }
}

// One line: the most useful thing to do next in this course.
function sidebarNextStep(s) {
    const r = s.readiness;
    const days = s.exam ? s.exam.daysLeft : null;
    if (r.sureWrong) return r.sureWrong === 1 ? '1 you were sure about was wrong.' : `${r.sureWrong} you were sure about were wrong.`;
    if (r.unseen && s.exam && r.perDay > 1 && days > 1) return `About ${r.perDay} new a day until the exam.`;
    if (r.fading) return r.fading === 1 ? '1 needs a refresh.' : `${r.fading} need a refresh.`;
    if (r.notKnown) return `${r.notKnown} still to learn.`;
    if (r.unseen) return `${r.unseen} not practiced yet.`;
    return '';
}

// Home (and start-up) fetch the stats themselves; Study and Progress pass
// theirs to renderSidebarCourses directly. One request at a time.
let sidebarCoursesLoading = null;
function refreshSidebarCourses() {
    if (sidebarCoursesLoading) return sidebarCoursesLoading;
    sidebarCoursesLoading = ipcRenderer.invoke('get-study-stats')
        .then(stats => { if (stats && !stats.error && Array.isArray(stats.subjects)) renderSidebarCourses(stats.subjects); })
        .catch(() => { /* leave the list as it was */ })
        .finally(() => { sidebarCoursesLoading = null; });
    return sidebarCoursesLoading;
}

const sidebarCoursesToggle = document.getElementById('sidebar-courses-toggle');
if (sidebarCoursesToggle) sidebarCoursesToggle.onclick = () => {
    const collapsed = !sidebarCoursesCollapsed();
    try { localStorage.setItem(sidebarCoursesKey, collapsed ? '1' : '0'); } catch (e) { /* storage blocked */ }
    renderSidebarCourses();
};

// Builds the two lower panels of the Progress view from the task list. This
// is what turns the page from three lonely numbers into something worth
// opening: where the workload actually sits, and what needs attention first.
async function renderProgressInsights() {
    const tasks = (await ipcRenderer.invoke('get-tasks')) || [];

    const openTasks = tasks.filter(t => t.status !== 'completed');
    const openEl = document.getElementById('metric-open-tasks');
    if (openEl) openEl.textContent = openTasks.length;

    // "Done this week" = completed in the last 7 days. completedAt is stamped
    // by the server (30/9); updatedAt was used before, so renaming an old
    // finished task counted it again. Older tasks have no completedAt yet.
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const weekDone = tasks.filter(t => {
        if (t.status !== 'completed') return false;
        const when = t.completedAt || t.updatedAt;
        return when && new Date(when).getTime() >= weekAgo;
    }).length;
    const weekEl = document.getElementById('metric-week-done');
    if (weekEl) weekEl.textContent = weekDone;

    // ---- Workload by category ----
    // Courses that still have open tasks. "Done" counts the course's finished
    // tasks too (it used to look at open tasks only, so it said "0% done" for
    // a course with 9 of 10 finished), plus ticked steps of open ones. The bar
    // is how much is done, matching the words next to it.
    const catEl = document.getElementById('category-breakdown');
    if (catEl) {
        const keyOf = t => (t.category || '').trim() || 'Uncategorized';
        const groups = {};
        tasks.forEach(t => {
            const key = keyOf(t);
            if (!groups[key]) groups[key] = { total: 0, open: 0, done: 0 };
            const g = groups[key];
            g.total++;
            if (t.status === 'completed') g.done += 1;
            else {
                g.open++;
                if (t.subtasks && t.subtasks.length) {
                    g.done += t.subtasks.filter(st => st.completed).length / t.subtasks.length;
                }
            }
        });

        const entries = Object.entries(groups).filter(([, v]) => v.open > 0)
            .sort((a, b) => b[1].open - a[1].open || a[0].localeCompare(b[0]));
        if (entries.length === 0) {
            catEl.innerHTML = '<div class="ms-muted ms-text-sm">No open tasks to break down yet.</div>';
        } else {
            catEl.innerHTML = entries.map(([name, v]) => {
                const pct = Math.round((v.done / v.total) * 100);
                return `
                    <div class="cat-row">
                        <div class="cat-row__head">
                            <span class="cat-row__name" dir="auto">${escapeHtml(name === 'Uncategorized' ? t(name) : name)}</span>
                            <span class="cat-row__count">${v.open} open of ${v.total} · ${pct}% done</span>
                        </div>
                        <div class="cat-row__track">
                            <div class="cat-row__fill" style="width: ${pct}%"></div>
                        </div>
                    </div>`;
            }).join('');
        }
    }

    // ---- Needs attention ----
    // Most urgent first, then the nearest deadline (the help text always
    // promised this; it used to sort by urgency only). Past deadlines say so.
    const attEl = document.getElementById('attention-list');
    if (attEl) {
        const rank = { Urgent: 0, High: 1, Medium: 2, Normal: 3 };
        const colors = {
            Urgent: 'var(--status-danger)',
            High: 'var(--status-warning)',
            Medium: 'var(--status-info)',
            Normal: 'var(--text-tertiary)'
        };
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const dueOf = t => { const d = parseTaskDueDate(t); return d ? d.getTime() : Infinity; };
        const top = [...openTasks]
            .sort((a, b) => (rank[a.urgency] ?? 3) - (rank[b.urgency] ?? 3) || dueOf(a) - dueOf(b))
            .slice(0, 6);

        if (top.length === 0) {
            attEl.innerHTML = '<div class="ms-muted ms-text-sm">Nothing pending. Nice work.</div>';
        } else {
            attEl.innerHTML = top.map(t => {
                const due = parseTaskDueDate(t);
                const overdue = due && due < today;
                const meta = [t.urgency, t.date && t.date !== 'Not set' ? t.date : 'No deadline']
                    .filter(Boolean).join(' · ');
                return `
                    <div class="attention-item">
                        <span class="attention-item__dot" style="background: ${colors[t.urgency] || colors.Normal}"></span>
                        <div class="attention-item__body">
                            <div class="attention-item__title" dir="auto">${escapeHtml(t.title)}</div>
                            <div class="attention-item__meta">${escapeHtml(meta)}${overdue ? ' · <span class="attention-item__late">past the deadline</span>' : ''}</div>
                        </div>
                    </div>`;
            }).join('');
        }
    }
}

const progressNavBtn = document.getElementById('nav-progress');
if (progressNavBtn) {
    progressNavBtn.addEventListener('click', loadAndRenderProgress);
}

loadAndRenderProgress();

// ==========================================
// 11. Profile Settings (edit-only - see the Edit Profile modal above)
// ==========================================
// BUG FIX: this used to run unconditionally at boot and auto-open the modal
// whenever the profile came back empty. Now that name/degree are collected
// at registration (see the auth section up top), the only time this should
// still come back empty is before login exists - which, with the auth
// screen in front of everything, is exactly when this must NOT pop open a
// second modal on top of it. So this is now edit-only: it populates the
// fields, and only loadEditProfileFields() (called from bootApp) or the
// "Edit Profile" button ever shows the modal.
async function loadProfile() {
    const profile = await ipcRenderer.invoke('get-profile');
    if (!profile) return;

    const nameEl = document.getElementById('sidebar-profile-name');
    const degreeEl = document.getElementById('sidebar-profile-degree');
    const picEl = document.getElementById('sidebar-profile-pic');
    const homeGreetingName = document.getElementById('home-greeting-name');

    const settingsName = document.getElementById('settings-profile-name');
    const settingsMeta = document.getElementById('settings-profile-meta');
    const settingsPic = document.getElementById('settings-profile-pic');

    // Kept for the Edit dialog (30/9): it used to read the names back from
    // the screen, where "Guest"/"Student" (or their Hebrew) could be taken
    // for real values and saved as the degree.
    currentProfile = { name: profile.name || '', degree: profile.degree || '' };
    const name = profile.name || t('Guest');
    if (nameEl) nameEl.innerText = name;
    if (degreeEl) degreeEl.innerText = profile.degree || t('Student');
    if (picEl) picEl.innerText = name.charAt(0).toUpperCase();
    if (homeGreetingName) homeGreetingName.innerText = name;

    if (settingsName) settingsName.innerText = name;
    if (settingsMeta) settingsMeta.innerText = profile.degree || t('Student');
    if (settingsPic) settingsPic.innerText = name.charAt(0).toUpperCase();
    const settingsEmail = document.getElementById('settings-profile-email');
    if (settingsEmail) settingsEmail.textContent = profile.email || '';

    // Email not confirmed yet (30/9): one quiet row in Settings, only when
    // the server can send email at all.
    const verifyRow = document.getElementById('email-verify-row');
    const unconfirmed = !!(profile.mailEnabled && profile.emailVerified === false);
    if (verifyRow) verifyRow.hidden = !unconfirmed;
    // ...and on Home too (30/9): until it's confirmed the AI does only a few
    // file actions a day, and a student who never opens Settings didn't know why.
    const homeVerify = document.getElementById('home-verify');
    if (homeVerify) homeVerify.hidden = !unconfirmed;
    // The server writes our emails in the app's language - keep it in step.
    const lang = (window.I18N && I18N.lang) || 'en';
    if (profile.lang && profile.lang !== lang) ipcRenderer.invoke('save-profile', { lang }).catch(() => {});
}

async function resendVerification(btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
        const res = await ipcRenderer.invoke('auth-resend-verification').catch(e => ({ error: e.message }));
        if (res && res.alreadyVerified) {
            toast.success('Your email is already confirmed.');
            document.getElementById('email-verify-row').hidden = true;
            const hv = document.getElementById('home-verify'); if (hv) hv.hidden = true;
        } else if (res && res.sent) {
            toast.success('Sent. Check your inbox (and the spam folder).', 'Confirmation email');
        } else {
            toast.error((res && res.error) || 'Please try again later.', 'Couldn\'t send it');
        }
    } finally {
        btn.disabled = false;
    }
}
const emailResendBtn = document.getElementById('email-resend-btn');
if (emailResendBtn) emailResendBtn.onclick = () => resendVerification(emailResendBtn);
const homeVerifyBtn = document.getElementById('home-verify-btn');
if (homeVerifyBtn) homeVerifyBtn.onclick = () => resendVerification(homeVerifyBtn);

const finishOnboardBtn = document.getElementById('finish-onboard-btn');
if (finishOnboardBtn) {
    finishOnboardBtn.onclick = async () => {
        const nameInput = document.getElementById('onboard-name').value.trim();
        const degreeInput = document.getElementById('onboard-degree').value.trim();

        if (!nameInput) {
            toast.error('Name is required to continue!');
            return;
        }
        if (!isValidName(nameInput)) {
            toast.error('Name can only contain letters (no numbers or symbols).');
            return;
        }

        finishOnboardBtn.innerText = 'Saving…';

        await ipcRenderer.invoke('save-profile', { name: nameInput, degree: degreeInput });
        await loadProfile();
        document.getElementById('onboarding-screen').style.display = 'none';
        finishOnboardBtn.innerText = 'Save changes';
    };
}

const settingsEditBtn = document.getElementById('settings-edit-btn');
if (settingsEditBtn) {
    settingsEditBtn.onclick = () => {
        const onboardScreen = document.getElementById('onboarding-screen');
        if (onboardScreen) {
            // Pre-fill with the current values rather than opening blank -
            // this is an edit form now, not a first-run questionnaire.
            document.getElementById('onboard-name').value = currentProfile.name;
            document.getElementById('onboard-degree').value = currentProfile.degree;
            onboardScreen.style.display = 'flex';
        }
    };
}

// ==========================================
// 12. Dynamic Home & Hard Reset
// ==========================================
// Same "latest refresh wins" ticket as the weekly board above.
let homeRenderTicket = 0;

async function loadAndRenderHome() {
    const myTicket = ++homeRenderTicket;
    refreshSidebarCourses();   // the sidebar's "My courses" - doesn't hold Home up
    // BUG FIX: completed tasks are archived (status 'completed'), not
    // deleted - so counting every task made the sidebar say "1 open task"
    // and Home's "Open Tasks" stat stay at 1 after the task was done.
    // Everything below only ever wants the open ones.
    const allTasks = await ipcRenderer.invoke('get-tasks') || [];
    const tasks = allTasks.filter(t => t.status !== 'completed');
    const events = await ipcRenderer.invoke('get-events') || [];
    if (myTicket !== homeRenderTicket) return;
    
    const statTasks = document.getElementById('home-stat-tasks');
    const statExams = document.getElementById('home-stat-exams');
    const statEvents = document.getElementById('home-stat-events');
    const statLessons = document.getElementById('home-stat-lessons');

    // Dated events only count where they belong: an exam that's over isn't
    // "upcoming", and 26/10 isn't "this week".
    const todayIso = localIsoDate(new Date());
    const wkStart = localIsoDate(weekStartFor(0));
    const wkEndDate = weekStartFor(0); wkEndDate.setDate(wkEndDate.getDate() + 6);
    const wkEnd = localIsoDate(wkEndDate);
    // A weekly class counts in a week it happens in - not after the semester
    // ends (`until`), not before it starts (`from`).
    const inThisWeek = (e) => {
        if (e.date) return e.date >= wkStart && e.date <= wkEnd;
        const on = weekStartFor(0); on.setDate(on.getDate() + WEEKDAY_NAMES.indexOf(e.day));
        return eventOccursOn(e, on);
    };

    if (statTasks) statTasks.innerText = tasks.length;
    if (statExams) statExams.innerText = events.filter(e => e.type === 'exam' && (!e.date || e.date >= todayIso)).length;
    if (statEvents) statEvents.innerText = events.filter(inThisWeek).length;
    if (statLessons) statLessons.innerText = events.filter(e => e.type === 'lesson' && inThisWeek(e)).length;

    // The next exam on the calendar, in the Today panel (30/9 redesign):
    // "Next exam  Statistics  In 2 days · Thu 2/10".
    const examBox = document.getElementById('home-next-exam');
    if (examBox) {
        const nextExam = events
            .filter(e => e.type === 'exam' && e.date && e.date >= todayIso)
            .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))[0];
        examBox.hidden = !nextExam;
        if (nextExam) {
            const [y, m, d] = nextExam.date.split('-').map(Number);
            const today0 = new Date(); today0.setHours(0, 0, 0, 0);
            const daysLeft = Math.round((new Date(y, m - 1, d) - today0) / 864e5);
            document.getElementById('home-next-exam-name').textContent = nextExam.title;
            const when = daysLeft === 0 ? 'Today' : daysLeft === 1 ? 'Tomorrow' : `In ${daysLeft} days`;
            document.getElementById('home-next-exam-when').textContent = `${when} · ${WEEKDAY_NAMES[new Date(y, m - 1, d).getDay()].slice(0, 3)} ${d}/${m}`;
        }
    }

    
    const todayEvents = events.filter(e => eventOccursOn(e, new Date())).sort((a, b) => a.time.localeCompare(b.time));
    
    const timelineList = document.getElementById('home-timeline-list');
    const nextTitle = document.getElementById('home-next-title');
    const nextTime = document.getElementById('home-next-time');
    const sidebarNextTitle = document.getElementById('sidebar-next-title');
    const sidebarNextMeta = document.getElementById('sidebar-next-meta');
    
    if (timelineList) timelineList.innerHTML = '';
    
    if (todayEvents.length === 0) {
        if (timelineList) timelineList.innerHTML = '<div class="timeline-empty">Nothing on your calendar today.</div>';
        if (nextTitle) nextTitle.innerText = t('Nothing scheduled');
        if (nextTime) nextTime.innerText = 'No classes or exams on your calendar today.';
        if (sidebarNextTitle) sidebarNextTitle.innerText = t('Nothing scheduled today');
        if (sidebarNextMeta) sidebarNextMeta.innerText = tasks.length > 0 ? `${tasks.length} open task${tasks.length === 1 ? '' : 's'}` : '';
    } else {
        const now = new Date();
        const currentTime = now.getHours().toString().padStart(2, '0') + ":" + now.getMinutes().toString().padStart(2, '0');
        
        let nextEventFound = false;

        todayEvents.forEach((evt) => {
            const isNext = !nextEventFound && evt.time >= currentTime;
            if (isNext) {
                nextEventFound = true;
                if (nextTitle) nextTitle.innerText = evt.title;
                if (nextTime) nextTime.innerText = `Today at ${evt.time}`;
                if (sidebarNextTitle) sidebarNextTitle.innerText = evt.title;
                if (sidebarNextMeta) sidebarNextMeta.innerText = `${evt.time} today`;
            }
            
            let dotColor = 'var(--timeline-dot)';
            if (evt.type === 'exam') dotColor = 'var(--event-exam)';
            if (evt.type === 'lesson') dotColor = 'var(--event-lesson)';
            if (evt.type === 'study') dotColor = 'var(--event-study)';
            if (evt.type === 'personal') dotColor = 'var(--event-personal)';
            
            const div = document.createElement('div');
            div.className = `timeline-item ${isNext ? 'active-task' : ''}`;
            div.innerHTML = `
                <div class="timeline-content">
                    <div class="dot ${isNext ? 'active' : ''}" style="${isNext ? '' : `background-color: ${dotColor};`}"></div>
                    <span class="timeline-title" dir="auto">${escapeHtml(evt.title)}</span>
                    ${isNext ? '<span class="tag-active" style="margin-inline-start:8px;">Next</span>' : ''}
                </div>
                <div class="timeline-time">${escapeHtml(evt.time)}</div>
            `;
            if (timelineList) timelineList.appendChild(div);
        });

        if (!nextEventFound) {
            // "Done for today" read oddly with open tasks on the same screen.
            if (nextTitle) nextTitle.innerText = t('Nothing more on the calendar today');
            if (nextTime) nextTime.innerText = "Today's classes and events are over.";
            if (sidebarNextTitle) sidebarNextTitle.innerText = t('Nothing more on the calendar today');
            if (sidebarNextMeta) sidebarNextMeta.innerText = tasks.length > 0 ? `${tasks.length} open task${tasks.length === 1 ? '' : 's'}` : '';
        }
    }
    
    const hour = new Date().getHours();
    // No "Good night" (review fix 30/9): in Hebrew "לילה טוב" is a goodbye.
    let greeting = "Good evening";
    if (hour >= 5 && hour < 12) greeting = "Good morning";
    else if (hour >= 12 && hour < 17) greeting = "Good afternoon";
    
    const greetingEl = document.getElementById('home-greeting-time');
    if (greetingEl) greetingEl.innerText = greeting;
    const dateEl = document.getElementById('home-date');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString(I18N.lang === 'he' ? 'he-IL' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

const navHomeBtn = document.getElementById('nav-home');
if (navHomeBtn) {
    navHomeBtn.addEventListener('click', loadAndRenderHome);
}

const sidebarHighlight = document.getElementById('sidebar-highlight');
if (sidebarHighlight) {
    sidebarHighlight.style.cursor = 'pointer';
    sidebarHighlight.title = 'Open Planner';
    sidebarHighlight.onclick = () => document.getElementById('nav-weekly').click();
}

loadAndRenderHome();

// ==========================================
// Getting started (Home)
// ==========================================
// Testers landed on a Home full of zeros with nothing telling them where to
// begin, and the setup the app most depends on (the AI key) was buried in
// Settings. This checklist walks a new user through the core loop one step
// at a time: only the current step is open, with one short sentence and a
// button that goes straight to the right place and opens the right dialog.
const onboardingEl = document.getElementById('onboarding');
const onboardingStepsEl = document.getElementById('onboarding-steps');
const onboardingBarEl = document.getElementById('onboarding-bar');
const onboardingKey = (name) => `mindsync.onboarding.${name}.${currentUserId || 'anon'}`;

// Switches screen, then clicks a button on it once it's visible.
function goAndClick(navId, buttonId) {
    document.getElementById(navId).click();
    if (buttonId) setTimeout(() => { const b = document.getElementById(buttonId); if (b) b.click(); }, 60);
}

const ONBOARDING_STEPS = [
    {
        id: 'ai',
        title: 'Connect the AI',
        text: 'The AI reads your files and writes your practice questions. It needs a free Google key - about a minute, no credit card.',
        // Web: the AI key lives on the server - there is nothing to paste,
        // so the step never shows (even if the server has no key).
        isDone: (st) => IS_WEB || st.hasKey || localStorage.getItem(onboardingKey('skipAi')) === '1',
        render: (body) => {
            body.innerHTML = `
                <div class="onboarding__key-row">
                    <button class="btn-secondary" data-act="get-key">1. Get a free key</button>
                    <input type="password" class="input-field onboarding__key-input" placeholder="2. Paste the key here" autocomplete="off">
                    <button class="btn-primary" data-act="save-key">Connect</button>
                </div>
                <div class="onboarding__note" data-role="msg"></div>
                <button class="onboarding__skip" data-act="skip-ai">Skip for now</button>`;
            const input = body.querySelector('.onboarding__key-input');
            const msg = body.querySelector('[data-role="msg"]');
            body.querySelector('[data-act="get-key"]').onclick = () =>
                require('electron').shell.openExternal('https://aistudio.google.com/apikey');
            const saveBtn = body.querySelector('[data-act="save-key"]');
            const save = async () => {
                const key = input.value.trim();
                if (!key) { msg.textContent = 'Paste the key into the box first.'; msg.className = 'onboarding__note is-error'; return; }
                saveBtn.disabled = true;
                saveBtn.textContent = 'Checking…';
                msg.textContent = '';
                const test = await ipcRenderer.invoke('test-gemini-key', key);
                if (!test || !test.ok) {
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Connect';
                    msg.textContent = "That key didn't work. Copy it again from the Google page and paste it here.";
                    msg.className = 'onboarding__note is-error';
                    return;
                }
                await ipcRenderer.invoke('save-ai-config', { geminiKey: key });
                if (typeof loadAiSettings === 'function') loadAiSettings();
                toast.success('The AI is connected.', 'All set');
                refreshOnboarding();
            };
            saveBtn.onclick = save;
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
            body.querySelector('[data-act="skip-ai"]').onclick = () => {
                localStorage.setItem(onboardingKey('skipAi'), '1');
                toast.info('You can connect it later in Settings. Until then, summaries and questions won\'t work well.');
                refreshOnboarding();
            };
        }
    },
    {
        id: 'upload',
        title: 'Add your course files',
        text: 'Lecture notes, summaries or exercises for one course - a single file or a whole folder.',
        isDone: (st) => st.files > 0,
        actions: [
            { label: 'Upload files', primary: true, run: () => { document.getElementById('nav-materials').click(); setTimeout(() => openUploadPicker('files'), 60); } },
            { label: 'Upload a folder', run: () => { document.getElementById('nav-materials').click(); setTimeout(() => openUploadPicker('folder'), 60); } }
        ]
    },
    {
        id: 'questions',
        title: 'Make practice questions',
        text: 'Pick a file and the AI writes questions from it. You look them over before they\'re added.',
        isDone: (st) => st.questions > 0,
        actions: [{ label: 'Make questions', primary: true, run: () => goAndClick('nav-study', 'generate-study-btn') }]
    },
    {
        id: 'practice',
        title: 'Answer your first questions',
        text: 'Before each answer you say how sure you are. That\'s how MindSync learns what you really know - and what you only think you know.',
        isDone: (st) => st.reviews > 0,
        actions: [{ label: 'Start practicing', primary: true, run: () => goAndClick('nav-study', 'start-study-btn') }]
    },
    {
        id: 'week',
        title: 'Add your classes and exams',
        text: 'Just write it the way you\'d say it, e.g. "מבחן בסטטיסטיקה ביום חמישי ב-9".',
        isDone: (st) => st.calendarItems > 0,
        actions: [{ label: 'Add to calendar', primary: true, run: () => goAndClick('nav-weekly', 'trigger-add-event') }]
    }
];
// Web: no key to paste - the AI step is not part of the guide at all.
if (IS_WEB) ONBOARDING_STEPS.splice(ONBOARDING_STEPS.findIndex(st => st.id === 'ai'), 1);

function renderOnboarding(status) {
    const hiddenHere = localStorage.getItem(onboardingKey('hidden')) === '1';
    const doneFlags = ONBOARDING_STEPS.map(step => step.isDone(status));
    const doneCount = doneFlags.filter(Boolean).length;

    // Finished once (or hidden) = gone for good, saved on the account. The
    // steps are worked out from what exists NOW, so without this deleting
    // every question brought the whole guide back (30/9).
    if (!status.guideDone && (hiddenHere || doneCount === ONBOARDING_STEPS.length)) {
        status.guideDone = true;
        ipcRenderer.invoke('mark-guide-done', true).catch(() => {});
    }
    if (status.guideDone) { onboardingEl.hidden = true; return; }
    onboardingEl.hidden = false;
    onboardingBarEl.style.width = `${Math.round((doneCount / ONBOARDING_STEPS.length) * 100)}%`;

    const currentIndex = doneFlags.indexOf(false);
    onboardingStepsEl.innerHTML = '';
    ONBOARDING_STEPS.forEach((step, i) => {
        const state = doneFlags[i] ? 'done' : (i === currentIndex ? 'current' : 'todo');
        const li = document.createElement('li');
        li.className = `onboarding__step is-${state}`;
        li.innerHTML = `
            <span class="onboarding__marker">${state === 'done' ? '✓' : i + 1}</span>
            <div class="onboarding__content">
                <div class="onboarding__step-title"></div>
                <div class="onboarding__body"></div>
            </div>`;
        li.querySelector('.onboarding__step-title').textContent = step.title;

        // Only the current step is expanded - one thing to do at a time.
        if (state === 'current') {
            const body = li.querySelector('.onboarding__body');
            const text = document.createElement('p');
            text.className = 'onboarding__text';
            text.dir = 'auto';
            text.textContent = step.text;
            body.appendChild(text);
            if (step.render) {
                const custom = document.createElement('div');
                body.appendChild(custom);
                step.render(custom);
            } else if (step.actions) {
                const row = document.createElement('div');
                row.className = 'onboarding__actions';
                step.actions.forEach(a => {
                    const btn = document.createElement('button');
                    btn.className = a.primary ? 'btn-primary' : 'btn-secondary';
                    btn.textContent = a.label;
                    btn.onclick = a.run;
                    row.appendChild(btn);
                });
                body.appendChild(row);
            }
        }
        onboardingStepsEl.appendChild(li);
    });
}

async function refreshOnboarding() {
    if (!onboardingEl || !currentUserId) return;
    const status = await ipcRenderer.invoke('get-onboarding-status').catch(() => null);
    if (!status || status.error) return; // couldn't check - leave it as it was
    renderOnboarding(status);
    renderHomeStudy(status);
}

// The Study line on Home - only when the guide is gone (while it's there,
// its own steps already say "make questions" / "start practicing").
function renderHomeStudy(status) {
    const box = document.getElementById('home-study');
    if (!box) return;
    box.hidden = !onboardingEl.hidden;
    if (box.hidden) return;
    const title = document.getElementById('home-study-title');
    const sub = document.getElementById('home-study-sub');
    const btn = document.getElementById('home-study-btn');
    btn.className = 'btn-primary home-hero__btn';
    if (!status.questions) {
        title.textContent = 'No practice questions yet';
        if (!status.files) {
            sub.textContent = 'Upload a course file first - the AI writes practice questions from it.';
            btn.textContent = 'Upload files';
            btn.onclick = () => { document.getElementById('nav-materials').click(); setTimeout(() => openUploadPicker('files'), 60); };
        } else {
            sub.textContent = 'Pick one of your files and the AI writes questions from it. You look them over before they\'re added.';
            btn.textContent = 'Make questions';
            btn.onclick = () => goAndClick('nav-study', 'generate-study-btn');
        }
    } else if (status.dueCount > 0) {
        title.textContent = `${status.dueCount} question${status.dueCount === 1 ? '' : 's'} ready to practice`;
        sub.textContent = 'Smart practice picks what\'s due and what\'s closest to an exam.';
        btn.textContent = 'Start practicing';
        btn.onclick = () => goAndClick('nav-study', 'start-study-btn');
    } else {
        title.textContent = 'All caught up';
        sub.textContent = 'Nothing to practice right now - questions come back on the day they\'re due.';
        btn.textContent = 'Open Study';
        btn.className = 'btn-secondary home-hero__btn';
        btn.onclick = () => document.getElementById('nav-study').click();
    }
}

const onboardingHideBtn = document.getElementById('onboarding-hide');
if (onboardingHideBtn) {
    onboardingHideBtn.onclick = () => {
        localStorage.setItem(onboardingKey('hidden'), '1');
        ipcRenderer.invoke('mark-guide-done', true).catch(() => {});
        onboardingEl.hidden = true;
        refreshOnboarding();   // the Study line takes its place
        toast.info('Hidden. You can bring it back from Settings.');
    };
}

const showOnboardingBtn = document.getElementById('settings-show-onboarding-btn');
if (showOnboardingBtn) {
    showOnboardingBtn.onclick = async () => {
        localStorage.removeItem(onboardingKey('hidden'));
        localStorage.removeItem(onboardingKey('skipAi'));
        await ipcRenderer.invoke('mark-guide-done', false).catch(() => {});
        document.getElementById('nav-home').click();
        await refreshOnboarding();
        if (onboardingEl.hidden) toast.success("You've already done every step - nothing left in the guide.");
    };
}

// Coming back to Home re-checks progress, so a step done elsewhere (a file
// uploaded, a session finished) is ticked off without a restart.
const navHomeForOnboarding = document.getElementById('nav-home');
if (navHomeForOnboarding) navHomeForOnboarding.addEventListener('click', refreshOnboarding);

// Web version: feedback goes to the server (POST /api/feedback, via the
// 'send-feedback' channel). The desktop app has "Copy error log" instead.
const feedbackBtn = document.getElementById('feedback-send-btn');
if (feedbackBtn) {
    feedbackBtn.onclick = async () => {
        const box = document.getElementById('feedback-text');
        const text = box ? box.value.trim() : '';
        if (!text) { toast.info('Write something first.'); return; }
        feedbackBtn.disabled = true;
        try {
            const res = await ipcRenderer.invoke('send-feedback', text);
            if (res && res.error) throw new Error(res.error);
            box.value = '';
            toast.success('Thanks - it was sent.', 'Feedback');
        } catch (err) {
            toast.error(err.message, 'Could not send');
        } finally {
            feedbackBtn.disabled = false;
        }
    };
}

const copyLogBtn = document.getElementById('settings-copy-log-btn');
if (copyLogBtn) {
    copyLogBtn.onclick = async () => {
        const originalText = copyLogBtn.innerHTML;
        copyLogBtn.disabled = true;
        try {
            const log = await ipcRenderer.invoke('get-diagnostic-log');
            clipboard.writeText(log);
            toast.success('Copied. Paste it wherever you\'re reporting the issue.', 'Diagnostic log copied');
        } catch (err) {
            toast.error('Could not read the log: ' + err.message);
        } finally {
            copyLogBtn.disabled = false;
            copyLogBtn.innerHTML = originalText;
        }
    };
}

const resetBtn = document.getElementById('settings-hard-reset-btn');
if (resetBtn) {
    resetBtn.onclick = async () => {
        const sure = await confirmDialog("Reset everything?", "This deletes all tasks, calendar events, folders and files, and all your practice questions, answers and mock exams. Your account is kept. This cannot be undone.", { confirmText: "Reset everything", danger: true });
        if (sure) {
            const res = await ipcRenderer.invoke('hard-reset').catch(e => ({ error: e.message }));
            // Said "done" even when it failed (review fix 30/9).
            if (res && res.error) { toast.error(res.error, t('Nothing was reset')); return; }
            toast.success("A new semester begins!", "System reset");
            location.reload();
        }
    };
}

// ==========================================
// 13. AI Weekly Planner (With Google Sync!)
// ==========================================
const generateWeeklyAiBtn = document.getElementById('generate-weekly-ai-btn');
if (generateWeeklyAiBtn) {
    generateWeeklyAiBtn.onclick = async () => {
        // Busy first (30/9): a double click used to start two plans at once
        // and add every study block twice.
        if (generateWeeklyAiBtn.disabled) return;
        const originalText = generateWeeklyAiBtn.innerHTML;
        generateWeeklyAiBtn.innerHTML = t('Planning…');
        generateWeeklyAiBtn.disabled = true;

        try {
            // Strict: if the calendar can't be loaded, stop - planning on an
            // "empty" week would ignore your classes and keep the old plan.
            const [tasks, loadedEvents] = await Promise.all([
                ipcRenderer.invoke('get-tasks', { strict: true }).catch(e => ({ error: e.message })),
                ipcRenderer.invoke('get-events', { strict: true }).catch(e => ({ error: e.message }))
            ]);
            if (!Array.isArray(tasks) || !Array.isArray(loadedEvents)) {
                toast.error('Couldn\'t load your calendar and tasks right now. Nothing was changed - try again in a minute.', 'Could not plan');
                return;
            }
            let events = loadedEvents;
            if (!tasks.some(t => t.status !== 'completed')) {
                toast.info('No open tasks to plan.');
                return;
            }

            // BUG FIX: every click used to ADD a fresh set of blocks on top of
            // the previous plan, so planning twice duplicated everything.
            // Blocks the planner placed last time are removed first (through
            // delete-event, so their Google Calendar copies go too); events
            // the user added themselves are never touched.
            // The new plan is built FIRST, around everything except the old
            // plan's blocks; only when it came back are those removed (review
            // fix 30/9 - a failed plan used to leave the student with none).
            const previousPlan = events.filter(e => e.autoScheduled);
            if (previousPlan.length) events = events.filter(e => !e.autoScheduled);

            const aiResponse = await ipcRenderer.invoke('generate-weekly-plan', tasks, events);
            const parsed = JSON.parse(aiResponse);
            const newPlan = Array.isArray(parsed) ? parsed : (parsed.plan || []);
            const unplaced = (parsed && parsed.unplaced) || [];
            if (!parsed.error && newPlan.length > 0) {
                for (const old of previousPlan) await ipcRenderer.invoke('delete-event', old.id);
            }

            if (parsed.error) {
                toast.error("Could not build a plan: " + parsed.error);
            } else if (newPlan.length > 0) {
                
                // Web, not connected: don't ask - the blocks just stay in MindSync.
                const syncToGoogle = (IS_WEB && !googleConnected())
                    ? false
                    : await confirmDialog("Sync to Google Calendar?", "The new study blocks will also be added to your Google Calendar.", { confirmText: "Sync", cancelText: "Skip" });
                let syncErrors = [];
                let saveFailures = 0;   // 30/9: failures used to go to the console only

                for (const planEvent of newPlan) {
                    planEvent.type = planEvent.type || 'study';
                    
                    if (syncToGoogle) {
                        const result = await ipcRenderer.invoke('add-to-google-calendar', planEvent);
                        if (result.success) {
                            planEvent.googleEventId = result.eventId;
                        } else {
                            console.error("Google Sync Error for", planEvent.title, ":", result.error);
                            syncErrors.push(result.error);
                        }
                    }
                    
                    const planRes = await ipcRenderer.invoke('save-event', planEvent);
                    if (!planRes || planRes.error) { saveFailures += 1; console.error('Save plan event failed:', planRes && planRes.error, planEvent); }
                }
                
                await loadAndRenderEvents();
                await loadAndRenderWeeklyBoard();
                await loadAndRenderHome();

                if (saveFailures > 0) {
                    toast.error(t('{n} of {total} study blocks could not be saved.', { n: saveFailures, total: newPlan.length }), t('Could not plan'));
                } else if (syncToGoogle && syncErrors.length > 0) {
                    toast.error(`${syncErrors.length} out of ${newPlan.length} study blocks failed to sync to Google Calendar.\n\nReason: ${syncErrors[0]}\n\nThe blocks were still saved in MindSync itself.`);
                } else {
                    toast.success(`Added ${newPlan.length} blocks to your calendar${previousPlan.length ? ', replacing the previous plan' : ''}.`, 'Study plan ready');
                }
                if (unplaced.length) {
                    toast.info(`No free slot before the deadline for: ${unplaced.join(', ')}.`, 'Some tasks didn\'t fit');
                }
            } else {
                await loadAndRenderWeeklyBoard();
                toast.info(unplaced.length
                    ? `No free slot before the deadline for: ${unplaced.join(', ')}.`
                    : 'Nothing to add - your week has no open tasks to plan.');
            }
        } catch (e) {
            toast.error("Error parsing the plan from the AI.");
            console.error(e);
        } finally {
            generateWeeklyAiBtn.innerHTML = originalText;
            generateWeeklyAiBtn.disabled = false;
        }
    };
}

// ==========================================
// 14. Hybrid Notification System
// ==========================================

// פונקציה להצגת התראה (פנימית ו/או ווינדוס)
function showNotification(title, message) {    // 1. התראה פנימית - now uses the same toast system as the rest of the app,
    // instead of the old separate #toast-container markup which had drifted
    // out of sync with the current styles.
    window.toast.info(message, title);

    // 2. התראת Windows (מופעלת רק אם החלון ממוזער או מוסתר)
    // Only where it exists and is allowed (30/9): on phones the constructor
    // throws, which made the same toast repeat every 30 seconds.
    if (document.hidden && typeof Notification === 'function' && Notification.permission === 'granted') {
        try { new Notification(title, { body: message }); } catch (e) { /* not supported here */ }
    }
}

// זיכרון קצר ששומר מזהים של אירועים שכבר קפצה עליהם התראה
let notifiedEvents = new Set();

// BUG FIX (two small ones in this timer):
// - It asked the server for events every 30s even on the login screen,
//   where every call is a guaranteed 401.
// - An app left open past midnight kept showing yesterday as "today" (Home,
//   sidebar, the highlighted column), and the already-notified list was
//   never reset, so a weekly class never notified again in the same session.
let notifierDayKey = new Date().toDateString();

// בודקים כל 30 שניות כדי לא לפספס אירועים קרובים
setInterval(async () => {
    if (document.body.classList.contains('auth-pending')) return;

    const dayKey = new Date().toDateString();
    if (dayKey !== notifierDayKey) {
        notifierDayKey = dayKey;
        notifiedEvents.clear();
        loadAndRenderHome();
        loadAndRenderWeeklyBoard();
    }

    const events = await ipcRenderer.invoke('get-events') || [];
    if (events.length === 0) return;

    const now = new Date();

    events.forEach(evt => {
        // בודקים רק אירועים של היום (weekly ones by day, dated ones by date)
        if (eventOccursOn(evt, now)) {
            // ממירים את שעת האירוע לאובייקט זמן של ג'אווה-סקריפט
            const [evtHour, evtMin] = evt.time.split(':').map(Number);
            const eventTime = new Date();
            eventTime.setHours(evtHour, evtMin, 0, 0);

            // מחשבים כמה דקות נשארו בדיוק עד לאירוע
            const diffMinutes = (eventTime.getTime() - now.getTime()) / 60000;

            // אם נשארו בין 0 ל-10 דקות, ועוד לא התרענו - תקפיץ התראה!
            if (diffMinutes > 0 && diffMinutes <= 10 && !notifiedEvents.has(evt.id)) {
                showNotification(t('Starting soon'), t(`${evt.title} starts at ${evt.time}`));
                notifiedEvents.add(evt.id); // מסמנים שהתרענו כדי לא להציק שוב
            }
        }
    });
}, 30000);

// ==========================================
// Bulk actions on tasks
// ==========================================
// Shown only when something is selected, so it never takes up space the rest
// of the time. Sits fixed at the bottom so it stays reachable in a long list.
function updateBulkBar() {
    let bar = document.getElementById('bulk-action-bar');

    if (selectedTaskIds.size === 0) {
        if (bar) bar.remove();
        return;
    }

    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'bulk-action-bar';
        bar.className = 'bulk-bar';
        document.body.appendChild(bar);
    }

    bar.innerHTML = `
        <span class="bulk-bar__count"><strong>${selectedTaskIds.size}</strong> selected</span>
        <div class="bulk-bar__actions">
            <button class="btn-secondary" data-bulk="complete">Mark done</button>
            <button class="btn-secondary" data-bulk="urgency">Set urgency</button>
            <button class="btn-secondary" data-bulk="category">Set category</button>
            <button class="btn-secondary bulk-danger" data-bulk="delete">Delete</button>
            <button class="btn-icon" data-bulk="clear" aria-label="Clear selection">${icon('close', { size: 16 })}</button>
        </div>
    `;

    bar.querySelector('[data-bulk="clear"]').onclick = () => {
        selectedTaskIds.clear();
        updateBulkBar();
        // No data changed - just the selection - so this re-renders from
        // the existing cache instead of refetching and reflashing.
        renderTasksList();
    };

    bar.querySelector('[data-bulk="delete"]').onclick = async () => {
        const count = selectedTaskIds.size;
        const ok = await confirmDialog(
            `Delete ${count} task${count === 1 ? '' : 's'}?`,
            'This cannot be undone.',
            { confirmText: 'Delete', danger: true }
        );
        if (!ok) return;

        // Snapshot every selected task before deleting so the whole batch can
        // be restored in one go.
        // From a strict fetch, falling back to what's on screen (30/9): a
        // failed fetch used to give an empty snapshot - Undo restored nothing.
        // dueDate and the time estimate are kept too, like a single delete.
        const fresh = await ipcRenderer.invoke('get-tasks', { strict: true }).catch(() => null);
        const allTasks = Array.isArray(fresh) ? fresh : (cachedTasksData || []);
        const snapshots = allTasks
            .filter(t => selectedTaskIds.has(t.id))
            .map(t => ({
                title: t.title, date: t.date, dueDate: t.dueDate, estimatedMinutes: t.estimatedMinutes,
                category: t.category, urgency: t.urgency,
                subtasks: (t.subtasks || []).map(st => ({ title: st.title, completed: st.completed }))
            }));
        if (snapshots.length < count && !await confirmDialog(t('Undo won\'t be available'),
            t('The tasks couldn\'t be loaded to keep a copy. Delete anyway?'), { confirmText: t('Delete'), danger: true })) return;

        await runBulk(id => ipcRenderer.invoke('delete-task', id), `Deleted ${count} task(s).`);

        showUndoToast(`Deleted ${count} task(s).`, async () => {
            for (const snap of snapshots) await ipcRenderer.invoke('save-task', snap);
            await refreshTaskViews();
        });
    };

    bar.querySelector('[data-bulk="complete"]').onclick = async () => {
        const count = selectedTaskIds.size;
        await runBulk(
            id => ipcRenderer.invoke('update-task', id, { status: 'completed' }),
            `Marked ${count} task(s) as done.`
        );
    };

    bar.querySelector('[data-bulk="urgency"]').onclick = async () => {
        const level = await pickOption('Set urgency', ['Normal', 'Medium', 'High', 'Urgent']);
        if (!level) return;
        await runBulk(
            id => ipcRenderer.invoke('update-task', id, { urgency: level }),
            `Urgency set to ${level}.`
        );
    };

    bar.querySelector('[data-bulk="category"]').onclick = async () => {
        const cat = await promptDialog('Set category', 'Applies to all selected tasks.', '');
        if (cat === null) return;
        await runBulk(
            id => ipcRenderer.invoke('update-task', id, { category: cat.trim() }),
            `Category updated.`
        );
    };
}

// Runs an action over every selected task, reporting partial failure rather
// than silently dropping some of them.
async function runBulk(actionFn, successMessage) {
    const ids = [...selectedTaskIds];
    let failed = 0;

    const results = await Promise.all(ids.map(async (id) => {
        try {
            const r = await actionFn(id);
            return !(r && r.error);
        } catch { return false; }
    }));
    failed = results.filter(ok => !ok).length;

    selectedTaskIds.clear();
    updateBulkBar();
    await refreshTasksData();
    await loadAndRenderHome();
    await loadAndRenderProgress();

    if (failed > 0) toast.warning(`${failed} of ${ids.length} did not update.`, 'Partly finished');
    else toast.success(successMessage);
}

// Small single-choice modal, used by the bulk urgency action.
function pickOption(title, options) {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'ms-modal-backdrop';
        backdrop.innerHTML = `
            <div class="ms-modal">
                <div class="ms-modal__header"><h3 class="ms-modal__title"></h3></div>
                <div class="ms-modal__body ms-modal__body--structured">
                    <div class="option-list"></div>
                </div>
                <div class="ms-modal__footer">
                    <button class="btn-secondary" data-action="cancel">Cancel</button>
                </div>
            </div>`;
        // BUG FIX: the names were pasted into the HTML, so a file called
        // 'סיכום חדו"א.pdf' broke the data-value="..." attribute at the " and
        // picking it did nothing. Text is now set as text.
        backdrop.querySelector('.ms-modal__title').textContent = title;
        const list = backdrop.querySelector('.option-list');
        function close(v) { backdrop.remove(); resolve(v); }
        options.forEach(o => {
            const b = document.createElement('button');
            b.className = 'option-row';
            b.dir = 'auto';
            b.textContent = o;
            b.onclick = () => close(o);
            list.appendChild(b);
        });
        backdrop.querySelector('[data-action="cancel"]').onclick = () => close(null);
        backdrop.onclick = (e) => { if (e.target === backdrop) close(null); };
        document.body.appendChild(backdrop);
    });
}

// Edit dialog for a single task. Until now the only way to fix a typo in a
// title was to delete the task and recreate it, which also lost its checklist.
// The Edit dialog's date box accepted any text and saved it verbatim, so
// "20/9", "מחר" or a typo got stored in a form nothing else can read - and
// the task quietly dropped off the Weekly Plan. This turns the common forms
// into the DD/MM/YYYY the rest of the app uses. Returns 'Not set' for an
// empty box, and null for something it can't understand.
function normalizeTaskDateInput(raw) {
    const text = String(raw || '').trim();
    if (!text || /^not set$/i.test(text)) return 'Not set';
    const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (text === 'היום') return fmt(today);
    if (text === 'מחר') { const d = new Date(today); d.setDate(d.getDate() + 1); return fmt(d); }
    if (text === 'מחרתיים') { const d = new Date(today); d.setDate(d.getDate() + 2); return fmt(d); }
    const m = text.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/);
    if (!m) return null;
    const dd = +m[1], mm = +m[2];
    let yyyy = m[3] ? +m[3] : today.getFullYear();
    if (yyyy < 100) yyyy += 2000;
    let d = new Date(yyyy, mm - 1, dd);
    if (d.getDate() !== dd || d.getMonth() !== mm - 1) return null; // 31/2, 40/13...
    // No year and well in the past = next year (30/9: "5/1" typed in
    // December was saved as last January - overdue at once).
    if (!m[3] && (today - d) / 86400000 > 60) {
        const next = new Date(yyyy + 1, mm - 1, dd);
        if (next.getDate() === dd) d = next;
    }
    return fmt(d);
}

function editTaskDialog(task) {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'ms-modal-backdrop';
        backdrop.setAttribute('role', 'dialog');
        backdrop.setAttribute('aria-modal', 'true');

        const urgencies = ['Normal', 'Medium', 'High', 'Urgent'];

        backdrop.innerHTML = `
            <div class="ms-modal">
                <div class="ms-modal__header"><h3 class="ms-modal__title">Edit task</h3></div>
                <div class="ms-modal__body ms-modal__body--structured">
                    <div class="form-field">
                        <label class="form-label" for="edit-title">Title</label>
                        <input id="edit-title" type="text" class="input-field" dir="auto" />
                    </div>
                    <div class="form-row">
                        <div class="form-field">
                            <label class="form-label" for="edit-date">Due date</label>
                            <input id="edit-date" type="text" class="input-field" placeholder="DD/MM/YYYY or Not set" dir="auto" />
                        </div>
                        <div class="form-field">
                            <label class="form-label" for="edit-urgency">Urgency</label>
                            <select id="edit-urgency" class="input-field">
                                ${urgencies.map(u => `<option value="${u}">${u}</option>`).join('')}
                            </select>
                        </div>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="edit-category">Category</label>
                        <input id="edit-category" type="text" class="input-field" dir="auto" placeholder="Optional" />
                    </div>
                </div>
                <div class="ms-modal__footer">
                    <button class="btn-secondary" data-action="cancel">Cancel</button>
                    <button class="btn-primary" data-action="save">Save changes</button>
                </div>
            </div>`;

        const titleInput = backdrop.querySelector('#edit-title');
        const dateInput = backdrop.querySelector('#edit-date');
        const urgencySel = backdrop.querySelector('#edit-urgency');
        const catInput = backdrop.querySelector('#edit-category');

        // Set values as properties, not in the HTML string, so nothing needs
        // escaping and quotes in a title can't break the markup.
        titleInput.value = task.title || '';
        dateInput.value = task.date || '';
        urgencySel.value = task.urgency || 'Normal';
        catInput.value = task.category || '';

        function close(result) {
            document.removeEventListener('keydown', onKey);
            backdrop.remove();
            resolve(result);
        }
        function save() {
            const title = titleInput.value.trim();
            if (!title) { toast.warning('A task needs a title.'); titleInput.focus(); return; }
            const date = normalizeTaskDateInput(dateInput.value);
            if (date === null) {
                toast.warning('Use a date like 20/9, 20/9/2026, היום or מחר - or leave it empty.');
                dateInput.focus();
                return;
            }
            close({
                title,
                date,
                urgency: urgencySel.value,
                category: catInput.value.trim()
            });
        }
        function onKey(e) {
            if (e.key === 'Escape') close(null);
            if (e.key === 'Enter' && e.target.tagName !== 'SELECT') save();
        }

        backdrop.querySelector('[data-action="save"]').onclick = save;
        backdrop.querySelector('[data-action="cancel"]').onclick = () => close(null);
        backdrop.onclick = (e) => { if (e.target === backdrop) close(null); };
        document.addEventListener('keydown', onKey);

        document.body.appendChild(backdrop);
        titleInput.focus();
        titleInput.select();
    });
}

// ==========================================
// Keyboard shortcuts
// ==========================================
// Deliberately few and unsurprising. Shortcuts are only worth having if they
// don't fire while you're typing, so every handler bails inside inputs.
document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

    // Escape closes the topmost modal, wherever you are.
    if (e.key === 'Escape') {
        const openModal = document.querySelector('.modal-overlay[style*="flex"], .ms-modal-backdrop');
        if (openModal && openModal.classList.contains('modal-overlay')) {
            closeModalSafely(openModal);
            return;
        }
    }

    if (typing) {
        // Ctrl/Cmd+Enter submits from inside a textarea.
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            const modal = e.target.closest('.modal-overlay, .ms-modal-backdrop');
            const primary = modal && modal.querySelector('.btn-primary, [data-action="save"], [data-action="confirm"]');
            if (primary) { e.preventDefault(); primary.click(); }
        }
        return;
    }

    // NOTE: all shortcuts below match on e.code (the PHYSICAL key) rather than
    // e.key (the character produced). With a Hebrew keyboard layout, pressing
    // the N key yields "מ" in e.key, so every shortcut silently stopped
    // working. e.code is layout-independent and stays "KeyN" either way.

    // Ctrl/Cmd+K focuses search (a near-universal convention).
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault();
        const nav = document.getElementById('nav-tasks');
        if (nav) nav.click();
        const search = document.getElementById('task-search-input');
        if (search) { search.focus(); search.select(); }
        return;
    }

    // "n" creates a new task.
    if (e.code === 'KeyN' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const btn = document.getElementById('trigger-add-task');
        if (btn) { e.preventDefault(); btn.click(); }
        return;
    }

    // Escape clears any bulk selection.
    if (e.key === 'Escape' && selectedTaskIds.size > 0) {
        selectedTaskIds.clear();
        updateBulkBar();
        // No data changed - just the selection.
        renderTasksList();
    }
});

// ---- Focus Mode: adding apps without typing filenames ----
const browseAppBtn = document.getElementById('browse-app-btn');
const suggestAppBtn = document.getElementById('suggest-app-btn');

async function addBlockedApp(name) {
    const current = (await ipcRenderer.invoke('get-blocked-apps')) || [];
    if (current.some(a => a.toLowerCase() === name.toLowerCase())) {
        toast.info(`${name} is already on the list.`);
        return false;
    }
    const res = await ipcRenderer.invoke('add-blocked-app', name);
    if (res && res.error) { toast.error(res.error, 'Could not add app'); return false; }
    await loadAndRenderBlockedApps();
    toast.success(`${name} will be blocked during Focus Mode.`);
    return true;
}

if (browseAppBtn) {
    browseAppBtn.onclick = async () => {
        const picked = await ipcRenderer.invoke('pick-application');
        if (!picked) return; // user cancelled the dialog
        await addBlockedApp(picked.name);
    };
}

if (suggestAppBtn) {
    suggestAppBtn.onclick = async () => {
        const suggestions = (await ipcRenderer.invoke('get-suggested-apps')) || [];
        const blocked = (await ipcRenderer.invoke('get-blocked-apps')) || [];
        const available = suggestions.filter(
            sug => !blocked.some(b => b.toLowerCase() === sug.value.toLowerCase())
        );

        if (available.length === 0) {
            toast.info('All the common apps are already on your list.');
            return;
        }

        const chosen = await pickMultiple('Block common apps', available);
        if (!chosen || chosen.length === 0) return;

        let added = 0;
        for (const value of chosen) {
            const ok = await addBlockedApp(value);
            if (ok) added++;
        }
        if (added > 1) toast.success(`Added ${added} apps to the block list.`);
    };
}

// Multi-select modal - lets you tick several presets and add them in one go,
// instead of reopening the picker for each one.
function pickMultiple(title, options) {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'ms-modal-backdrop';
        backdrop.innerHTML = `
            <div class="ms-modal">
                <div class="ms-modal__header"><h3 class="ms-modal__title">${escapeHtml(title)}</h3></div>
                <div class="ms-modal__body ms-modal__body--structured">
                    <div class="option-list">
                        ${options.map(o => `
                            <label class="checkbox-field checkbox-field--compact">
                                <input type="checkbox" value="${escapeHtml(o.value)}">
                                <span class="checkbox-field__text">
                                    <span class="checkbox-field__label">${escapeHtml(o.label)}</span>
                                    <span class="checkbox-field__hint">${escapeHtml(o.value)}</span>
                                </span>
                            </label>`).join('')}
                    </div>
                </div>
                <div class="ms-modal__footer">
                    <button class="btn-secondary" data-action="cancel">Cancel</button>
                    <button class="btn-primary" data-action="add">Add selected</button>
                </div>
            </div>`;

        function close(v) {
            document.removeEventListener('keydown', onKey);
            backdrop.remove();
            resolve(v);
        }
        function onKey(e) { if (e.key === 'Escape') close(null); }

        backdrop.querySelector('[data-action="add"]').onclick = () => {
            const values = [...backdrop.querySelectorAll('input:checked')].map(i => i.value);
            close(values);
        };
        backdrop.querySelector('[data-action="cancel"]').onclick = () => close(null);
        backdrop.onclick = (e) => { if (e.target === backdrop) close(null); };
        document.addEventListener('keydown', onKey);
        document.body.appendChild(backdrop);
    });
}

// ==========================================
// 15. Study - spaced repetition with confidence calibration
// ==========================================
// The core loop is deliberately ordered: question -> state confidence ->
// reveal answer -> self-grade. Asking for confidence BEFORE the answer is
// what makes the data meaningful; asked afterwards, everyone reports having
// known it all along.

const studyState = {
    queue: [],
    index: 0,
    confidence: null,
    startedAt: null,
    session: { reviewed: 0, correct: 0, lucky: 0, overconfident: 0 }
};

// Sessions survive leaving the screen and closing the app.
//
// Reviews are already saved to the server one at a time, so no answer was ever
// lost - but the PLACE in the queue was, so stopping at question 5 of 20 meant
// starting from the top next time. For a 20-item session that's enough friction
// to stop people opening it at all.
// Per user (30/9): on a shared computer the next student saw - and could
// wipe - the previous student's paused session.
const sessionKey = () => `mindsync.activeSession.${currentUserId || 'anon'}`;

function saveSessionProgress() {
    if (!studyState.queue.length || studyState.index >= studyState.queue.length) {
        try { localStorage.removeItem(sessionKey()); } catch (e) { /* storage unavailable */ }
        return;
    }
    try {
        localStorage.setItem(sessionKey(), JSON.stringify({
            // Only ids are stored; the items themselves are re-fetched so a
            // resumed session never shows stale content.
            ids: studyState.queue.map(i => i.id),
            index: studyState.index,
            session: studyState.session,
            scope: studyState.scope || null,
            savedAt: Date.now()
        }));
    } catch (e) { /* storage full or unavailable - not worth failing over */ }
}

function readSessionProgress() {
    try {
        const raw = localStorage.getItem(sessionKey());
        if (!raw) return null;
        const data = JSON.parse(raw);

        // A day-old session is stale: the schedule has moved on and different
        // items are due, so resuming it would be reviewing the wrong things.
        if (Date.now() - data.savedAt > 24 * 60 * 60 * 1000) {
            localStorage.removeItem(sessionKey());
            return null;
        }
        return data;
    } catch { return null; }
}

function clearSessionProgress() {
    try { localStorage.removeItem(sessionKey()); } catch (e) { /* storage unavailable */ }
}

// Outcome vocabulary differs per mode because the modes measure different
// things. "solved/stuck" fits a maths problem; "got it/missed" does not.
const OUTCOMES_BY_MODE = {
    recall: [
        { value: 'got_it',  label: 'Got it',     hint: 'Recalled it correctly' },
        { value: 'partial', label: 'Partly',     hint: 'Some of it' },
        { value: 'missed',  label: 'Missed it',  hint: 'Could not recall' }
    ],
    practice: [
        { value: 'solved', label: 'Solved it',  hint: 'Worked it through' },
        { value: 'stuck',  label: 'Got stuck',  hint: 'Needed a hint' },
        { value: 'wrong',  label: 'Wrong',      hint: 'Wrong approach' }
    ],
    explain: [
        { value: 'got_it',  label: 'Explained well', hint: 'Covered the key points' },
        { value: 'partial', label: 'Gaps',           hint: 'Missed some points' },
        { value: 'missed',  label: 'Could not',      hint: 'Could not explain it' }
    ]
};

const MODE_LABELS = { recall: 'Remember', practice: 'Solve', explain: 'Explain' };
const MODE_PROMPTS = {
    recall: 'How sure are you? This also checks your answer.',
    practice: 'How sure are you? This also checks your result.',
    explain: 'How sure are you? This also checks your explanation.'
};
const TYPE_PLACEHOLDERS = {
    recall: 'Write your answer - a sentence or two is enough',
    practice: 'Your final result (the working can stay on paper)',
    explain: 'Explain it in a few sentences'
};
// The AI's verdict -> the outcome the server's schedule understands.
const VERDICT_TO_OUTCOME = {
    recall:   { correct: 'got_it', partial: 'partial', wrong: 'missed' },
    practice: { correct: 'solved', partial: 'stuck',   wrong: 'wrong' },
    explain:  { correct: 'got_it', partial: 'partial', wrong: 'missed' }
};
const VERDICT_TITLES = { correct: 'Correct', partial: 'Partly right', wrong: 'Not quite' };
const ANSWER_PROMPTS = {
    recall: 'How did you do?',
    practice: 'Solve it on paper, then tell the truth:',
    explain: 'Compare your explanation to the answer:'
};

async function loadStudyHome() {
    // The question list (light: no review history) comes with the stats, for
    // the per-file rows under each course. Kept for "My questions" too, so
    // that screen opens without waiting.
    const [stats, items] = await Promise.all([
        ipcRenderer.invoke('get-study-stats'),
        ipcRenderer.invoke('get-study-items', { light: true }).catch(() => null)
    ]);
    if (Array.isArray(items)) studyItemsCache = items;
    if (!stats) return;
    // Today's due questions get their new versions written now, while the
    // student looks at this screen (1/10).
    if (stats.dueCount > 0) prepareVersions('today');

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('study-due-count', stats.dueCount);
    set('study-total-count', stats.totalItems);
    set('study-reviews-count', stats.reviewsAllTime);

    // Sidebar badge - the only nudge to come back, so it only appears when
    // there is genuinely something to do.
    const badge = document.getElementById('study-due-badge');
    if (badge) {
        badge.textContent = stats.dueCount;
        badge.hidden = stats.dueCount === 0;
    }

    // Offer to pick up where you left off, before anything else on the page.
    const resume = readSessionProgress();
    const banner = document.getElementById('resume-banner');
    if (banner) {
        if (resume && resume.ids && resume.index < resume.ids.length) {
            banner.hidden = false;
            const remaining = resume.ids.length - resume.index;
            document.getElementById('resume-banner-detail').textContent =
                `${resume.scope ? `${resume.scope.label}: ` : 'Smart practice: '}you stopped at question ${resume.index + 1} of ${resume.ids.length} — ${remaining} left.`;
        } else {
            banner.hidden = true;
        }
    }

    renderStudyExams(stats.subjects || []);
    renderStudyCourses(stats.subjects || [], studyItemsCache || []);
    renderSidebarCourses(stats.subjects || []);
    const startBtn = document.getElementById('start-study-btn');
    if (startBtn) startBtn.textContent = 'Start smart practice';   // the count is the panel's title now
    renderCalibration(stats.calibration, stats.reviewsAllTime, stats.trendByConfidence);
    renderConfidentlyWrong(stats.confidentlyWrong);
    renderAttentionList('underconfident-panel', stats.underconfidentItems,
        'Nothing here yet — no pattern of doubting yourself on things you actually know.', 'good');
    renderAttentionList('genuine-difficulty-panel', stats.genuineDifficultyItems,
        'Nothing flagged as genuinely hard right now.', 'warn');
    updateStudyPanelsVisibility(stats);
    fixFileNamedCourses().catch(err => console.warn('course fix skipped:', err));
}

// Exams on the Study screen: one line per course with an exam, and - when a
// course has questions but no exam - ONE question: "When is your X exam?".
// That answer is what lets the server time reviews before the exam; asking
// for it here, at the moment it matters, beats hoping the user finds the
// Planner or "Exams & deadlines" on their own.
const noExamKey = () => `mindsync.noExam.${currentUserId || 'anon'}`;
function readNoExamCourses() {
    try { return JSON.parse(localStorage.getItem(noExamKey()) || '[]'); } catch { return []; }
}
let examAskCourse = null;

function renderStudyExams(subjects) {
    const box = document.getElementById('study-exams');
    const list = document.getElementById('study-exams-list');
    const ask = document.getElementById('study-exam-ask');
    if (!box || !list) return;
    // An older server (before exam-aware scheduling) sends no `exam` field
    // at all - nothing to show, and nothing to ask.
    if (!subjects.some(s => 'exam' in s)) { box.hidden = true; examAskCourse = null; return; }

    const withExam = subjects.filter(s => s.exam);
    list.innerHTML = '';
    withExam.forEach(s => {
        const [y, m, d] = s.exam.date.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        const when = s.exam.daysLeft === 0 ? 'Exam today' : s.exam.daysLeft === 1 ? 'Exam tomorrow' : `Exam in ${s.exam.daysLeft} days`;
        const row = document.createElement('div');
        row.className = 'study-exam-row' + (s.exam.daysLeft <= 7 ? ' is-soon' : '');
        row.title = s.exam.title;
        const name = document.createElement('span');
        name.className = 'study-exam-row__course';
        name.dir = 'auto';
        name.textContent = s.category;
        const whenEl = document.createElement('span');
        whenEl.className = 'study-exam-row__when';
        whenEl.textContent = `${when} · ${WEEKDAY_NAMES[dt.getDay()].slice(0, 3)} ${d}/${m}`;
        row.append(name, whenEl);
        list.appendChild(row);
    });
    // The exam dates now show on each course in "Practice one course"; this
    // card only asks about a missing one.
    list.hidden = true;

    // The course to ask about: most questions first; never "Uncategorized",
    // never one the user said has no exam.
    const skip = new Set(readNoExamCourses());
    const next = subjects
        .filter(s => !s.exam && s.items > 0 && s.category !== 'Uncategorized' && !skip.has(s.category))
        .sort((a, b) => b.items - a.items)[0];
    examAskCourse = next ? next.category : null;
    if (ask) {
        ask.hidden = !next;
        if (next) document.getElementById('study-exam-ask-q').textContent = `When is your ${isolate(next.category)} exam?`;
    }
    box.hidden = !next;
}

// ---- "Practice one course" -------------------------------------------------
// One row per course: when its exam is, what's ready now, a Practice button,
// and its files (practice just one). Courses come from the server's stats
// (nearest exam first); files from the question list.
let studyItemsCache = null;
const studyCourseOf = (i) => String(i.category || '').trim() || 'Uncategorized';
// "תרגול 2.pdf" -> "תרגול 2". Hebrew next to ".pdf" flips on screen
// ("pdf.2 תרגול"), and the extension says nothing anyway.
function fileLabel(name) { return String(name || '').replace(/\.(pdf|txt|md|docx?|pptx?)$/i, ''); }
const openStudyCourses = new Set();   // which courses have their files open

function renderStudyCourses(subjects, items) {
    const box = document.getElementById('study-courses');
    const list = document.getElementById('study-courses-list');
    if (!box || !list) return;
    list.innerHTML = '';
    box.hidden = subjects.length === 0;

    subjects.forEach(s => {
        const row = document.createElement('div');
        row.className = 'study-course';

        const top = document.createElement('div');
        top.className = 'study-course__top';
        const name = document.createElement('span');
        name.className = 'study-course__name';
        name.dir = 'auto';
        name.textContent = s.category === 'Uncategorized' ? t('No course') : s.category;
        top.append(name);
        if (s.exam) {
            const exam = document.createElement('span');
            exam.className = 'study-course__exam' + (s.exam.daysLeft <= 7 ? ' is-soon' : '');
            exam.textContent = examChipText(s.exam);
            exam.title = s.exam.title;
            top.append(exam);
        }

        const meta = document.createElement('div');
        meta.className = 'study-course__meta';
        const ready = s.due || 0;
        meta.textContent = `${ready ? `${ready} ready now` : 'Nothing due now'} · ${s.items} question${s.items === 1 ? '' : 's'}`;
        meta.title = ready ? `${s.dueReviews || 0} to review again, ${s.newToday || 0} new for today` : 'Everything here was practiced recently - you can still practice it anyway.';

        const practice = document.createElement('button');
        practice.className = ready ? 'btn-primary btn-sm' : 'btn-secondary btn-sm';
        practice.textContent = 'Practice';
        practice.onclick = () => startStudySession(null, { category: s.category, label: name.textContent });

        // Files of this course, most questions first.
        const files = new Map();
        items.filter(i => studyCourseOf(i) === s.category).forEach(i => {
            const f = i.sourceFile || '';
            files.set(f, (files.get(f) || 0) + 1);
        });
        const fileList = [...files.entries()].sort((a, b) => b[1] - a[1]);

        const actions = document.createElement('div');
        actions.className = 'study-course__actions';
        if (fileList.length > 1 || (fileList.length === 1 && fileList[0][0])) {
            const toggle = document.createElement('button');
            toggle.className = 'study-course__files-btn';
            const isOpen = openStudyCourses.has(s.category);
            toggle.textContent = `${isOpen ? '▾' : '▸'} By file (${fileList.length})`;
            toggle.setAttribute('aria-expanded', String(isOpen));
            toggle.onclick = () => {
                if (openStudyCourses.has(s.category)) openStudyCourses.delete(s.category); else openStudyCourses.add(s.category);
                renderStudyCourses(subjects, items);
            };
            actions.append(toggle);
        }
        // Mock exam (30/9) - once there's enough to make an exam of.
        if ((s.items || 0) >= 5) {
            const mock = document.createElement('button');
            mock.className = 'btn-secondary btn-sm';
            mock.textContent = t('Mock exam');
            mock.onclick = () => openExamSetup(s.category, name.textContent, s.items);
            actions.append(mock);
        }
        const full = document.createElement('button');
        full.className = 'btn-secondary btn-sm';
        full.textContent = t('Full exam');
        full.onclick = () => openFullExam(s.category);
        actions.append(full);
        actions.append(practice);
        if (s.lastMock) {
            const m = document.createElement('span');
            m.className = 'study-course__mock';
            m.textContent = `${t('Last mock exam:')} ${s.lastMock.score} \u2066±${s.lastMock.margin}\u2069`;
            meta.append(document.createTextNode(' · '), m);
        }

        const main = document.createElement('div');
        main.className = 'study-course__main';
        const info = document.createElement('div');
        info.append(top, meta);
        main.append(info, actions);
        row.append(main);

        if (openStudyCourses.has(s.category)) {
            const fl = document.createElement('div');
            fl.className = 'study-course__files';
            fileList.forEach(([file, count]) => {
                const fr = document.createElement('div');
                fr.className = 'study-file';
                const fn = document.createElement('span');
                fn.className = 'study-file__name';
                fn.dir = 'auto';
                fn.textContent = file ? fileLabel(file) : t('Written by hand');
                fn.title = file || '';
                const fc = document.createElement('span');
                fc.className = 'study-file__count';
                fc.textContent = `${count} question${count === 1 ? '' : 's'}`;
                const fb = document.createElement('button');
                fb.className = 'btn-secondary btn-sm';
                fb.textContent = 'Practice';
                fb.onclick = () => startStudySession(null, { category: s.category, sourceFile: file, label: file ? fileLabel(file) : name.textContent });
                fr.append(fn, fc, fb);
                fl.append(fr);
            });
            row.append(fl);
        }
        list.append(row);
    });
}

async function saveExamAnswer() {
    const course = examAskCourse;
    const input = document.getElementById('study-exam-input');
    const btn = document.getElementById('study-exam-save');
    // Busy = ignore (30/9): Enter twice used to add the same exam twice.
    if (!course || !input || btn.disabled) return;
    const text = input.value.trim();
    if (!text) { toast.warning('Write when the exam is, e.g. "12.2".'); return; }

    btn.disabled = true;
    try { await saveExamAnswerNow(course, input, text); }
    finally { btn.disabled = false; }
}

async function saveExamAnswerNow(course, input, text) {
    const res = await ipcRenderer.invoke('parse-exam-dates', text).catch(e => ({ error: e.message }));
    if (!res || res.error) {
        toast.error((res && res.error) || 'Please try again.', 'Couldn\'t read that');
        return;
    }
    const saved = [];
    for (const e of res.exams) {
        const [y, m, d] = e.date.split('-').map(Number);
        const evt = {
            // The course name in the title is what links the exam to the
            // questions (server: examMatchesCourse).
            title: `${e.label || 'מבחן'} - ${course}`,
            day: WEEKDAY_NAMES[new Date(y, m - 1, d).getDay()],
            date: e.date,
            time: e.time || '09:00',
            type: 'exam'
        };
        const r = await ipcRenderer.invoke('save-event', evt).catch(e => ({ error: e.message }));
        if (r && !r.error) saved.push({ ...evt, id: r.id || r._id });
    }
    if (!saved.length) { toast.error('Could not save it. Please try again.'); return; }
    input.value = '';

    const label = saved.map(e => { const [, m, d] = e.date.split('-').map(Number); return `${isolate(e.title)} · ${d}/${m}`; }).join(', ');
    showUndoToast(`Added to the Planner: ${label}. Practice is now timed for it.`, async () => {
        for (const e of saved) if (e.id) await ipcRenderer.invoke('delete-event', e.id);
        await loadStudyHome();
        await loadAndRenderWeeklyBoard();
    });
    await loadStudyHome();
    loadAndRenderWeeklyBoard();
    loadAndRenderHome();
}

const examSaveBtn = document.getElementById('study-exam-save');
if (examSaveBtn) examSaveBtn.onclick = saveExamAnswer;
const examInput = document.getElementById('study-exam-input');
if (examInput) examInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveExamAnswer(); });
const examNoneBtn = document.getElementById('study-exam-none');
if (examNoneBtn) examNoneBtn.onclick = async () => {
    const course = examAskCourse;
    if (!course) return;
    try { localStorage.setItem(noExamKey(), JSON.stringify([...new Set([...readNoExamCourses(), course])])); } catch { /* not worth failing over */ }
    toast.info(`Got it - no exam in ${isolate(course)}.`);
    await loadStudyHome();
};

// Panels that have nothing to say yet stay out of the way. A new user sees
// the practice button and their exams, not four empty boxes.
function updateStudyPanelsVisibility(stats) {
    const show = {
        'calibration-panel': (stats.reviewsAllTime || 0) >= 8,
        'confidently-wrong-panel': (stats.confidentlyWrong || []).length > 0,
        'underconfident-panel': (stats.underconfidentItems || []).length > 0,
        'genuine-difficulty-panel': (stats.genuineDifficultyItems || []).length > 0
    };
    let any = false;
    Object.entries(show).forEach(([id, visible]) => {
        const el = document.getElementById(id);
        const card = el && el.closest('.card');
        if (card) card.hidden = !visible;
        any = any || visible;
    });
    const panels = document.getElementById('study-panels');
    if (panels) panels.hidden = !any;
    const hint = document.getElementById('study-panels-hint');
    if (hint) hint.hidden = any || !(stats.reviewsAllTime > 0);
    // Progress: the section title only when there's something under it.
    const title = document.getElementById('judgement-title');
    if (title) title.hidden = !any && (!hint || hint.hidden);
}

const studyToProgressLink = document.getElementById('study-to-progress-link');
if (studyToProgressLink) studyToProgressLink.onclick = (e) => { e.preventDefault(); document.getElementById('nav-progress').click(); };

// One-time fix for questions made before the course came from the folder:
// their course is the FILE's name ("הרצאה 3 - התפלגות נורמלית"), which never
// matches an exam. When that file sits in a folder, move them to the folder.
let courseFixDone = false;
async function fixFileNamedCourses() {
    if (courseFixDone) return;
    courseFixDone = true;
    // Once per account (30/9): it ran on EVERY launch, and a course the user
    // had deliberately named like a file ("Statistics" for Statistics.pdf in
    // "Semester A") was moved back into the folder each time.
    const doneKey = `mindsync.courseFix.${currentUserId || 'anon'}`;
    try { if (localStorage.getItem(doneKey) === '1') return; } catch (e) { return; }
    const [cats, files] = await Promise.all([
        ipcRenderer.invoke('get-study-categories').catch(() => null),
        ipcRenderer.invoke('get-files-light').catch(() => null)
    ]);
    // Marked done only after a real look (review fix): offline, or before the
    // question list loaded, it would have been "done" without doing anything.
    if (!Array.isArray(cats) || !Array.isArray(files) || !Array.isArray(studyItemsCache)) return;
    try { localStorage.setItem(doneKey, '1'); } catch (e) { /* ignore */ }
    let moved = 0;
    for (const cat of cats || []) {
        const file = (files || []).find(f => f.name && f.name.replace(/\.[^.]+$/, '').trim() === String(cat).trim() && realFolder(f));
        if (!file) continue;
        // Only a course that is really "the questions of that one file" (the
        // old bug) - not one the user filled from other files too.
        const inCourse = (studyItemsCache || []).filter(i => (i.category || '') === cat);
        if (!inCourse.length || inCourse.some(i => (i.sourceFile || '') !== file.name)) continue;
        const r = await ipcRenderer.invoke('recategorize-study-items', cat, realFolder(file));
        if (r && r.updated) moved += r.updated;
    }
    if (moved) await loadStudyHome();
}

function renderCalibration(cal, totalReviews, trendByConfidence) {
    const el = document.getElementById('calibration-panel');
    if (!el) return;

    // Below a handful of reviews this says nothing real, and a misleading
    // number here would undermine the whole point of the feature.
    if (!cal || totalReviews < 8) {
        el.innerHTML = `<div class="ms-muted ms-text-sm">Answer about ${Math.max(0, 8 - (totalReviews || 0))} more questions and this will show how reliable your sense of "I know this" actually is.</div>`;
        return;
    }

    const rows = [
        { key: 'sure',     label: 'Said "I\'m sure"',  ideal: 95 },
        { key: 'think_so', label: 'Said "I think so"', ideal: 70 },
        { key: 'guessing', label: 'Said "guessing"',   ideal: 35 }
    ];

    el.innerHTML = rows.map(r => {
        const b = cal[r.key];
        if (!b || b.accuracy === null) {
            return `<div class="cal-row"><div class="cal-row__head"><span>${r.label}</span><span class="ms-muted ms-text-xs">no data</span></div></div>`;
        }
        const off = Math.abs(b.accuracy - r.ideal);
        const tone = off <= 12 ? 'good' : off <= 25 ? 'ok' : 'bad';

        // Is this confidence level's judgement getting more reliable over
        // time? Was only ever shown for "sure" before - the same question
        // matters just as much for the ambiguous "think so" middle ground.
        const trend = trendByConfidence && trendByConfidence[r.key];
        const trendNote = trend
            ? `<div class="cal-row__trend ms-text-xs ms-muted">${trend.earlier}% → ${trend.recent}% over your last ${trend.earlierCount + trend.recentCount} of these</div>`
            : '';

        return `
            <div class="cal-row">
                <div class="cal-row__head">
                    <span>${r.label}</span>
                    <span class="cal-row__value cal-${tone}">${b.accuracy}% right</span>
                </div>
                <div class="cal-track">
                    <div class="cal-fill cal-${tone}" style="width:${b.accuracy}%"></div>
                    <div class="cal-ideal" style="inset-inline-start:${r.ideal}%" title="Well-calibrated: about ${r.ideal}%"></div>
                </div>
                <div class="cal-row__note ms-text-xs ms-muted">${b.correct} of ${b.total}</div>
                ${trendNote}
            </div>`;
    }).join('');

    const gap = cal.overconfidenceGap;
    if (gap !== null && gap > 15) {
        el.innerHTML += `<div class="cal-verdict cal-verdict--warn">When you feel certain, you're wrong about ${100 - cal.sure.accuracy}% of the time. That gap is where marks get lost — slow down on the ones that feel obvious.</div>`;
    } else if (gap !== null) {
        el.innerHTML += `<div class="cal-verdict cal-verdict--good">Your sense of what you know is reliable. Trust it.</div>`;
    }
}

function renderConfidentlyWrong(items) {
    renderAttentionList('confidently-wrong-panel', items,
        'Nothing here yet — nothing you were certain about has turned out wrong.', 'danger');
}

// Shared by all three "items worth looking at" panels (confidently wrong,
// underconfident, genuinely hard) - same card shape, different tone/color
// and copy, so a change to the layout only has to happen once.
const ATTENTION_TONE_COLOR = {
    danger: 'var(--status-danger)',
    warn: 'var(--status-warning)',
    good: 'var(--status-success)'
};
function renderAttentionList(panelId, items, emptyMessage, tone) {
    const el = document.getElementById(panelId);
    if (!el) return;
    if (!items || items.length === 0) {
        el.innerHTML = `<div class="ms-muted ms-text-sm">${escapeHtml(emptyMessage)}</div>`;
        return;
    }
    const dotColor = ATTENTION_TONE_COLOR[tone] || ATTENTION_TONE_COLOR.danger;
    el.innerHTML = items.map(i => `
        <div class="attention-item">
            <span class="attention-item__dot" style="background: ${dotColor}"></span>
            <div class="attention-item__body">
                <div class="attention-item__title" dir="auto">${escapeHtml(i.question)}</div>
                <div class="attention-item__meta">${escapeHtml(i.category || 'Uncategorized')} · ${escapeHtml(MODE_LABELS[i.mode] || i.mode)}${i.accuracy !== undefined ? ` · ${i.accuracy}% (${i.reviewCount})` : ''}</div>
            </div>
        </div>`).join('');
}

// ---- Session flow ----
// scope: null = smart practice (everything, the app decides), or
// { category, sourceFile?, label } = one course / one file.
async function startStudySession(resume = null, scope = null) {
    let items;
    if (resume && resume.scope) scope = resume.scope;

    // Don't silently throw away what's on the screen (30/9): new questions
    // waiting for review cost an AI call, and a session in the middle is work.
    const reviewEl = document.getElementById('study-review');
    if (reviewEl && !reviewEl.hidden && reviewDraft && reviewDraft.length) {
        const ok = await confirmDialog(t('Discard the new questions?'),
            t('The questions from your file are still waiting for you to look them over. Starting practice now discards them.'),
            { confirmText: t('Discard and practice'), danger: true });
        if (!ok) return;
        closeReviewScreen();
    }
    if (!(await stopExam())) return;   // a mock exam on screen: ask first
    const sessionEl = document.getElementById('study-session');
    if (!resume && sessionEl && !sessionEl.hidden && studyState.queue && studyState.index < studyState.queue.length) {
        const ok = await confirmDialog(t('Leave this session?'),
            t('You are in the middle of a practice session. Start the new one instead?'),
            { confirmText: t('Start the new one') });
        if (!ok) return;
    }

    if (resume && Array.isArray(resume.ids)) {
        // Re-fetch by id rather than trusting a stored copy: an item may have
        // been edited or deleted since the session was paused.
        // Strict (30/9): offline used to look like "all deleted" and the
        // paused session was thrown away.
        const all = await ipcRenderer.invoke('get-study-items', { strict: true }).catch(e => ({ error: e.message }));
        if (!Array.isArray(all)) {
            toast.error(t('Couldn\'t load your questions right now. Your paused session is kept - try again in a moment.'));
            return;
        }
        const byId = new Map(all.map(i => [i.id, i]));
        // Answered part and the rest kept apart (30/9): a question deleted
        // from the answered part used to shift the place by one, skipping one.
        const before = resume.ids.slice(0, resume.index).map(id => byId.get(id)).filter(Boolean);
        const rest = resume.ids.slice(resume.index).map(id => byId.get(id)).filter(Boolean);
        items = before.concat(rest);
        resume = { ...resume, index: before.length };

        if (rest.length === 0) {
            toast.info('Those questions are no longer available. Starting fresh.');
            clearSessionProgress();
            return startStudySession();
        }
    } else if (scope && Array.isArray(scope.ids)) {
        // Chosen questions (30/9: "Practice what I missed" after a mock exam).
        const all = await ipcRenderer.invoke('get-study-items', { strict: true }).catch(e => ({ error: e.message }));
        if (!Array.isArray(all)) { toast.error(t('Couldn\'t load your questions right now. Check the connection and try again.')); return; }
        const byId = new Map(all.map(i => [i.id, i]));
        items = scope.ids.map(id => byId.get(id)).filter(Boolean);
        if (!items.length) { toast.info('There are no questions here yet.'); return; }
    } else {
        const filter = scope ? { category: scope.category, ...(scope.sourceFile !== undefined ? { sourceFile: scope.sourceFile } : {}) } : {};
        items = await ipcRenderer.invoke('get-due-study-items', { limit: 20, strict: true, ...filter }).catch(e => ({ error: e.message }));
        if (!Array.isArray(items)) {
            toast.error(t('Couldn\'t load your questions right now. Check the connection and try again.'));
            return;
        }
        if (items.length === 0 && scope) {
            // Nothing DUE in this course/file - say why, and offer the rest.
            const ok = await confirmDialog(
                `Nothing to practice in ${scope.label} right now`,
                'You practiced these recently, so none is due yet. Spacing questions out is what makes you remember them longer. You can still go over them now - handy right before an exam.',
                { confirmText: 'Practice anyway', cancelText: 'Not now' });
            if (!ok) return;
            items = await ipcRenderer.invoke('get-due-study-items', { limit: 20, all: true, strict: true, ...filter }).catch(e => ({ error: e.message }));
            if (!Array.isArray(items)) {
                toast.error(t('Couldn\'t load your questions right now. Check the connection and try again.'));
                return;
            }
        }
        if (!items || items.length === 0) {
            toast.info(scope
                ? 'There are no questions here yet.'
                : 'Nothing is due right now - you\'re up to date. Come back tomorrow, practice one course below, or make questions from a new file.', 'All caught up');
            return;
        }
    }

    studyState.queue = items.map(withNextVersion);
    studyState.scope = scope;
    const scopeLabel = document.getElementById('study-scope-label');
    if (scopeLabel) scopeLabel.textContent = scope ? `· ${scope.label}` : '· Smart practice';
    studyState.index = resume ? Math.min(resume.index, items.length - 1) : 0;
    studyState.session = resume ? resume.session : { reviewed: 0, correct: 0, lucky: 0, overconfident: 0 };
    if (!Array.isArray(studyState.session.sureWrong)) studyState.session.sureWrong = [];
    studyState.checkOff = null;           // AI allowance ran out this session (reason)
    studyState.shortAnswers = new Map();  // "I don't know" answers already fetched

    clearManageSelection();
    document.getElementById('study-exam').hidden = true;
    document.getElementById('study-home').hidden = true;
    document.getElementById('study-summary').hidden = true;
    document.getElementById('study-review').hidden = true;
    document.getElementById('study-manage').hidden = true;
    document.getElementById('study-session').hidden = false;

    renderStudyCard();
}

// A question answered before comes back as a NEW version when one is ready
// (1/10): same idea or method, other numbers or situation - written ahead by
// prepareVersions(). The card shows it; the review says so, so the server
// files it as a past version and counts the answer as "fresh".
function withNextVersion(item) {
    const v = item && item.nextVariant;
    if (!v || !v.question || !v.answer) return item;
    return { ...item, question: v.question, answer: v.answer, solutionSource: v.solutionSource || 'ai', mySolution: '', variantShown: true };
}

// Writes the versions ahead: today's queue when Study opens, tomorrow's at the
// end of a session. Quiet, at most every 20 minutes per kind, never twice at once.
let prepareVersionsBusy = false;
async function prepareVersions(when) {
    if (prepareVersionsBusy) return;
    const key = `mindsync.versions.${when}.${currentUserId || 'anon'}`;
    try { if (Date.now() - Number(localStorage.getItem(key) || 0) < 20 * 60 * 1000) return; } catch (e) { /* storage off */ }
    prepareVersionsBusy = true;
    try {
        try { localStorage.setItem(key, String(Date.now())); } catch (e) { /* storage off */ }
        await withTimeout(ipcRenderer.invoke('prepare-variants', { when }).catch(() => null), 600000);
    } finally {
        prepareVersionsBusy = false;
    }
}

function renderStudyCard() {
    const item = studyState.queue[studyState.index];
    if (!item) return endStudySession();

    studyState.confidence = null;
    studyState.sureNoteShown = false;
    studyState.answerId = null;
    document.querySelectorAll('#study-confidence-step .confidence-btn.is-picked').forEach(b => b.classList.remove('is-picked'));
    studyState.startedAt = Date.now();
    studyState.aiOutcome = null;
    studyState.aiChecked = null;
    const typed = document.getElementById('study-typed-answer');
    if (typed) {
        typed.value = '';
        typed.placeholder = TYPE_PLACEHOLDERS[item.mode] || TYPE_PLACEHOLDERS.recall;
        typed.disabled = false;
    }
    document.querySelectorAll('#study-confidence-step .confidence-btn, #study-dont-know-btn').forEach(b => { b.disabled = false; });

    const total = studyState.queue.length;
    document.getElementById('study-position').textContent = outOfLabel(studyState.index + 1, total);
    document.getElementById('study-progress-fill').style.width = `${(studyState.index / total) * 100}%`;

    document.getElementById('study-mode-badge').textContent = MODE_LABELS[item.mode] || item.mode;
    const catBadge = document.getElementById('study-category-badge');
    // For a practice item the skill is more useful than the course name -
    // it's what the repetition is actually over.
    const badgeText = (item.mode === 'practice' && item.skillTag) ? item.skillTag : item.category;
    if (badgeText) { catBadge.textContent = badgeText; catBadge.hidden = false; }
    else catBadge.hidden = true;
    const twinBadge = document.getElementById('study-twin-badge');
    if (twinBadge) twinBadge.hidden = !item.twinOf || !!item.variantShown;
    const versionBadge = document.getElementById('study-version-badge');
    if (versionBadge) versionBadge.hidden = !item.variantShown;

    setMathText(document.getElementById('study-question'), item.question);
    // Last time: sure, and wrong. Say so - that's the whole point of the list.
    const last = Array.isArray(item.reviews) && item.reviews.length ? item.reviews[item.reviews.length - 1] : null;
    let sureFlag = document.getElementById('study-sure-flag');
    if (!sureFlag) {
        sureFlag = document.createElement('div');
        sureFlag.id = 'study-sure-flag';
        sureFlag.className = 'study-sure-flag';
        document.getElementById('study-question').before(sureFlag);
    }
    sureFlag.textContent = 'Last time you were sure about this - and got it wrong.';
    sureFlag.hidden = !(last && last.confidence === 'sure' && last.wasCorrect === false);
    document.getElementById('study-confidence-prompt').textContent = MODE_PROMPTS[item.mode] || MODE_PROMPTS.recall;

    document.getElementById('study-confidence-step').hidden = false;
    // The explanation fades out by itself after a user's first few answers.
    const hint = document.getElementById('study-confidence-hint');
    if (hint) hint.hidden = Number(localStorage.getItem(confidenceHintKey()) || 0) >= CONFIDENCE_HINT_TIMES;
    document.getElementById('study-answer-step').hidden = true;
}

const CONFIDENCE_HINT_TIMES = 5;
function confidenceHintKey() { return `mindsync.confidenceHintSeen.${currentUserId || 'anon'}`; }

// Step 1 -> 2: confidence is locked in before anything is revealed.
document.querySelectorAll('#study-confidence-step .confidence-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        const seen = Number(localStorage.getItem(confidenceHintKey()) || 0);
        if (seen < CONFIDENCE_HINT_TIMES) localStorage.setItem(confidenceHintKey(), String(seen + 1));
        studyState.confidence = btn.dataset.confidence;
        document.querySelectorAll('#study-confidence-step .confidence-btn').forEach(b => b.classList.toggle('is-picked', b === btn));
        const item = studyState.queue[studyState.index];
        const typed = document.getElementById('study-typed-answer');
        const text = typed ? typed.value.trim() : '';
        if (!item || !text) { revealAnswer(); return; }   // answered in the head
        // The AI allowance ran out earlier in this session: straight to
        // marking yourself, with the reason - not another wait for a "no".
        if (studyState.checkOff) { revealAnswer({ failed: studyState.checkOff, typed: text }); return; }

        // Typed: the AI checks it. The buttons stay put (no jump), just busy.
        const buttons = document.querySelectorAll('#study-confidence-step .confidence-btn, #study-dont-know-btn');
        buttons.forEach(b => { b.disabled = true; });
        typed.disabled = true;
        const prompt = document.getElementById('study-confidence-prompt');
        const promptText = prompt.textContent;
        prompt.textContent = 'Checking your answer…';
        const res = await withTimeout(ipcRenderer.invoke('grade-study-answer', {
            question: item.question, expected: item.answer || item.mySolution || '', mode: item.mode, userAnswer: text,
            solutionSource: item.solutionSource || 'document'
        }).catch(e => ({ error: e.message })), CHECK_TIMEOUT_MS);
        prompt.textContent = promptText;
        if (studyState.queue[studyState.index] !== item) return;   // stopped meanwhile
        if (res && res.error && isAiLimit(res.error)) studyState.checkOff = res.error;   // no point asking again this session
        revealAnswer(res && !res.error ? { ...res, typed: text } : { failed: (res && res.error) || 'no answer', typed: text });
    });
});

// "I don't know": straight to the answer. No check (nothing to check), and no
// "How did you do?" - it's already known how it went. Saved as not known
// (missed / wrong), so it comes back soon.
// The check waits at most this long (30/9): the server may retry an
// overloaded AI for over a minute, with every button greyed out.
const CHECK_TIMEOUT_MS = 25000;
function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve({ error: 'timeout' }), ms))]);
}
// "You've used today's AI allowance" and the like - a reason, not a glitch.
const isAiLimit = (msg) => /resets at midnight|confirm your email|quota|resource_exhausted|\b429\b|daily limit/i.test(String(msg || ''));

const dontKnowBtn = document.getElementById('study-dont-know-btn');
if (dontKnowBtn) dontKnowBtn.onclick = () => {
    const item = studyState.queue[studyState.index];
    if (!item) return;
    studyState.confidence = 'dont_know';
    revealAnswer({ dontKnow: true });
    // The stored answer is a quote from the material - often long, with an
    // intro. Ask for the short direct one (or a solution when there's none).
    const stored = (item.answer || item.mySolution || '').trim();
    if ((!stored || stored.length > SHORT_ENOUGH) && !studyState.checkOff) fetchShortAnswer(item);
};
const SHORT_ENOUGH = 200;

async function fetchShortAnswer(item) {
    const index = studyState.index;
    const box = document.getElementById('study-short-answer');
    const text = document.getElementById('study-short-answer-text');
    if (!box || !text) return;
    box.hidden = false;
    // Asked once per question (30/9) - it comes back after "I don't know"
    // often, and each ask used a bit of the day's AI allowance.
    studyState.shortAnswers = studyState.shortAnswers || new Map();
    const cached = studyState.shortAnswers.get(`${item.id}|${item.question}`);   // per text: a version has its own answer
    if (cached) {
        text.textContent = cached;
        document.getElementById('study-answer').classList.add('study-answer--source');
        return;
    }
    box.classList.add('is-loading');
    text.textContent = t('Getting a short answer…');
    const res = await withTimeout(ipcRenderer.invoke('grade-study-answer', {
        question: item.question, expected: item.answer || item.mySolution || '', mode: item.mode, explainOnly: true
    }).catch(() => null), CHECK_TIMEOUT_MS);
    if (res && res.error && isAiLimit(res.error)) studyState.checkOff = res.error;
    if (res && res.answer) studyState.shortAnswers.set(`${item.id}|${item.question}`, res.answer);
    if (studyState.index !== index || studyState.queue[index] !== item) return;   // moved on meanwhile
    box.classList.remove('is-loading');
    if (res && res.answer) {
        setMathText(text, res.answer);
        document.getElementById('study-answer').classList.add('study-answer--source');
    } else {
        box.hidden = true;   // the material's answer below is still there
    }
}

// check: null (answered in the head), { verdict, feedback, typed } from the
// AI, { failed, typed } when the check couldn't run (then: mark yourself),
// or { dontKnow: true } ("I don't know" - no check, no self-marking).
function revealAnswer(check = null) {
    const item = studyState.queue[studyState.index];
    if (!item) return;
    const verdictBox = document.getElementById('study-verdict');
    const nextRow = document.getElementById('study-next-row');
    const dontKnow = !!(check && check.dontKnow);
    const outcomeMap = VERDICT_TO_OUTCOME[item.mode] || VERDICT_TO_OUTCOME.recall;
    // A check that says it isn't sure (30/9) is shown, but nothing is
    // pre-selected - the student decides.
    const unsure = !!(check && check.verdict && check.sure === false);
    studyState.aiOutcome = dontKnow ? outcomeMap.wrong
        : (check && check.verdict && !unsure ? outcomeMap[check.verdict] : null);
    // Only a real AI verdict is sent with the answer ("I don't know" wasn't
    // checked) - the server counts how often students overrule the check.
    studyState.aiChecked = !dontKnow && check && check.verdict ? outcomeMap[check.verdict] : null;
    if (verdictBox) {
        verdictBox.hidden = !check || dontKnow;
        verdictBox.className = 'study-verdict' + (check && check.verdict ? ` study-verdict--${check.verdict}` : '');
        if (check) {
            document.getElementById('study-verdict-title').textContent = check.verdict
                ? (unsure ? `${t(VERDICT_TITLES[check.verdict])} ${t('(the check is not sure - you decide)')}` : VERDICT_TITLES[check.verdict])
                : 'Couldn\'t check it right now - mark yourself below';
            // Why it couldn't (30/9): "used today's allowance" / "confirm your
            // email" is something the student can act on; a timeout isn't.
            const why = !check.verdict && check.failed
                ? (isAiLimit(check.failed) ? check.failed : check.failed === 'timeout' ? t('The check took too long.') : '')
                : '';
            setMathText(document.getElementById('study-verdict-feedback'), check.verdict ? (check.feedback || '') : why);
            document.getElementById('study-verdict-yours').textContent = `${t('You wrote:')} ${check.typed}`;
        }
        // The core moment, said right where it happens (same words as the
        // login screen's example): sure + the check says wrong.
        const sureNote = document.getElementById('study-verdict-sure');
        studyState.sureNoteShown = !!(check && check.verdict === 'wrong' && studyState.confidence === 'sure');
        if (sureNote) sureNote.hidden = !studyState.sureNoteShown;
    }
    const shortBox = document.getElementById('study-short-answer');
    if (shortBox) {
        const short = check && check.verdict && check.answer ? check.answer : '';
        shortBox.hidden = !short;
        shortBox.classList.remove('is-loading');
        setMathText(document.getElementById('study-short-answer-text'), short);
    }
    // With a short answer above, the material's quote is the source - smaller.
    document.getElementById('study-answer').classList.toggle('study-answer--source', !!(check && check.answer));

    const answerEl = document.getElementById('study-answer');
    const labelEl = document.getElementById('study-material-label');

    // Practice items: show the student's own saved solution if there is one,
    // and always offer the editor. "Work it through on paper" with nothing
    // else was a dead end - the question came back with no way to check it.
    const solutionBlock = document.getElementById('study-solution-block');
    const solutionInput = document.getElementById('study-solution-input');
    const solutionLabel = document.getElementById('study-solution-label');

    if (item.mode === 'practice' && solutionBlock && !item.variantShown) {
        solutionBlock.hidden = false;
        solutionInput.value = item.mySolution || '';
        solutionLabel.textContent = item.mySolution
            ? 'Your solution from last time'
            : 'Your solution (saved for next time)';
    } else if (solutionBlock) {
        solutionBlock.hidden = true;
    }

    if (item.answer && item.answer.trim()) {
        setMathText(answerEl, item.answer);
        answerEl.classList.remove('study-answer--none');
        answerEl.classList.toggle('study-answer--ai', item.solutionSource === 'ai');

        // Say plainly who wrote the answer. A passage from the lecturer's own
        // slides and a solution an AI worked out deserve very different levels
        // of trust, and hiding that difference would undercut the one thing
        // this app promises: telling you the truth about what you know.
        if (labelEl) {
            if (item.solutionSource === 'ai') {
                labelEl.innerHTML = `<span class="ai-answer-flag">${icon('info', { size: 13 })} AI-generated solution — worth checking</span>`;
            } else {
                labelEl.textContent = 'From your material';
                if (item.sourceFile) {
                    // <bdi>: a Hebrew name inside an English line keeps its order
                    // ("הרצאה 3", not "3 הרצאה").
                    const b = document.createElement('bdi');
                    b.textContent = fileLabel(item.sourceFile);
                    labelEl.append(' — ', b);
                }
            }
        }
    } else {
        answerEl.textContent = t(item.mode === 'practice'
            ? (item.mySolution
                ? 'Compare what you did against your saved solution below.'
                : 'No stored solution yet. Solve it, then save your working below so it\'s here next time.')
            : 'No passage was stored for this one — check your notes.');
        answerEl.classList.add('study-answer--none');
        if (labelEl) labelEl.textContent = item.mode === 'practice' ? 'How to check' : 'No stored answer';
    }

    document.getElementById('study-outcome-prompt').textContent = ANSWER_PROMPTS[item.mode] || ANSWER_PROMPTS.recall;

    const outcomes = OUTCOMES_BY_MODE[item.mode] || OUTCOMES_BY_MODE.recall;
    const row = document.getElementById('study-outcome-row');
    row.innerHTML = outcomes.map(o => `
        <button class="outcome-btn" data-outcome="${o.value}">
            <strong>${o.label}</strong><span>${o.hint}</span>
        </button>`).join('');

    row.querySelectorAll('.outcome-btn').forEach(b => {
        b.onclick = () => submitReview(b.dataset.outcome);
        // The AI's call is marked; "Next" accepts it, any button overrides it.
        b.classList.toggle('is-suggested', b.dataset.outcome === studyState.aiOutcome);
    });
    setOutcomeButtonsDisabled(false);
    if (nextRow) nextRow.hidden = !studyState.aiOutcome;
    const outcomePrompt = document.getElementById('study-outcome-prompt');
    if (studyState.aiOutcome) outcomePrompt.textContent = 'The check says:';
    // "I don't know": nothing to choose - "Got it" would make no sense.
    row.hidden = dontKnow;
    const overrideHint = document.getElementById('study-override-hint');
    if (overrideHint) overrideHint.hidden = dontKnow;
    if (dontKnow) outcomePrompt.textContent = 'Marked as "didn\'t know" - it comes back tomorrow.';

    document.getElementById('study-confidence-step').hidden = true;
    document.getElementById('study-answer-step').hidden = false;
}

// One answer is saved at a time (30/9): a double click on "Next" or an
// outcome used to save the answer twice and skip the next question.
let reviewInFlight = false;
function setOutcomeButtonsDisabled(disabled) {
    document.querySelectorAll('#study-outcome-row .outcome-btn, #study-next-btn').forEach(b => { b.disabled = disabled; });
}

async function submitReview(outcome) {
    const item = studyState.queue[studyState.index];
    if (!item || reviewInFlight) return;
    reviewInFlight = true;
    setOutcomeButtonsDisabled(true);
    const index = studyState.index;

    const secondsSpent = Math.round((Date.now() - studyState.startedAt) / 1000);
    let res;
    try {
        // One id per shown card - a retry of the same answer is saved once.
        if (!studyState.answerId) studyState.answerId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        res = await ipcRenderer.invoke('submit-study-review', item.id, {
            confidence: studyState.confidence,
            outcome,
            secondsSpent,
            clientId: studyState.answerId,
            ...(item.variantShown ? { variantShown: true } : {}),
            ...(studyState.aiChecked ? { aiSuggested: studyState.aiChecked } : {})
        });
    } catch (err) {
        res = { error: (err && err.message) || 'No connection. Try again.' };
    } finally {
        reviewInFlight = false;
    }
    // Stopped, or moved on, while it was saving: nothing more to do here.
    if (studyState.queue[index] !== item || studyState.index !== index || document.getElementById('study-session').hidden) return;

    // Deleted meanwhile (another tab or device, 30/9): every button kept
    // failing on it. Skip to the next one.
    if (res && res.error && /not found|404/i.test(res.error)) {
        toast.info(t('This question was deleted - skipping it.'));
        studyState.index += 1;
        saveSessionProgress();
        if (studyState.index >= studyState.queue.length) endStudySession(); else renderStudyCard();
        return;
    }
    if (!res || res.error) {
        setOutcomeButtonsDisabled(false);
        toast.error((res && res.error) || 'Please try again.', 'Could not save review');
        return;
    }

    studyState.session.reviewed += 1;
    if (res.item && res.item.reviews) {
        const last = res.item.reviews[res.item.reviews.length - 1];
        // Right while guessing = luck, not knowledge: counted apart, so
        // "Knew it" only holds what you actually knew.
        if (last && last.wasCorrect) {
            if (studyState.confidence === 'guessing') studyState.session.lucky = (studyState.session.lucky || 0) + 1;
            else studyState.session.correct += 1;
        }
    }

    // Name the overconfidence at the moment it happens. Buried in a stats
    // screen a week later it teaches nothing.
    if (res.wasOverconfident) {
        studyState.session.overconfident += 1;
        if (!studyState.session.sureWrong.includes(item.question)) studyState.session.sureWrong.push(item.question);
        // Already said on the card when the check found it - no second message.
        if (!studyState.sureNoteShown) toast.warning('You were sure about that one. It will come back soon.', 'Sure but wrong');
    }

    // The mistake loop: not known -> a twin question on the same idea.
    const lastReview = res.item && res.item.reviews ? res.item.reviews[res.item.reviews.length - 1] : null;
    if (lastReview && lastReview.wasCorrect === false) makeTwin(item);

    // A same-session retry (interval 0) goes back in the queue rather than
    // being lost until tomorrow.
    if (res.nextInterval === 0) {
        // The item as saved just now (30/9) - with this answer in its
        // history, so the card says "last time you were sure - and wrong".
        studyState.queue.push(res.item ? { ...item, ...res.item, id: item.id, variantShown: false } : { ...item, variantShown: false });
    }

    studyState.index += 1;
    saveSessionProgress();

    if (studyState.index >= studyState.queue.length) endStudySession();
    else renderStudyCard();
}


// ==========================================
// Mock exams (30/9)
// ==========================================
// One course under exam conditions: typed answers, a clock, nothing checked
// or shown until the end - then every answer is checked (the same AI check as
// practice), and one score comes back with its margin. The latest score is
// shown with the course as "Last mock exam" - evidence, not a feeling. Every
// checked answer also counts as practice on the server (routes/study.js).
const examState = { course: '', label: '', count: 15, timed: true, items: [], answers: [], index: 0, startedAt: 0, limitSec: 0, timer: null, running: false, checking: false, runId: 0 };

// Another screen wants Study while an exam is running or being checked
// (review fix 30/9): ask, then stop it for real - the clock and any checking
// in flight - instead of it carrying on out of sight and saving a run later.
async function stopExam(ask = true) {
    // A full exam on screen (1/10) is asked about first.
    const fullBox = document.getElementById('study-full');
    if (fullBox && !fullBox.hidden && !(await stopFullExam(ask))) return false;
    if (!examState.running && !examState.checking) return true;
    if (ask) {
        const ok = await confirmDialog(t('Leave the mock exam?'), t('The answers you wrote in it are not saved.'), { confirmText: t('Leave the exam'), danger: true });
        if (!ok) return false;
    }
    clearInterval(examState.timer);
    examState.running = false;
    examState.checking = false;
    examState.runId += 1;          // anything still checking belongs to the old run
    const box = document.getElementById('study-exam');
    if (box) box.hidden = true;
    return true;
}
const PAST_EXAM_FILE = /מבחן|בחינה|מועד|בוחן|\bexams?\b|midterm|quiz|final exam/i;

function showExamPart(part) {
    ['exam-setup', 'exam-run', 'exam-checking', 'exam-result'].forEach(id => { document.getElementById(id).hidden = id !== part; });
}

async function openExamSetup(course, label, total) {
    if (!(await stopExam())) return;
    examState.course = course;
    examState.label = label || course;
    ['study-home', 'study-session', 'study-summary', 'study-review', 'study-manage'].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
    document.getElementById('study-exam').hidden = false;
    document.getElementById('exam-course-name').textContent = examState.label;
    // Question counts that make sense for this course: 10 always, 15 and 25
    // only when there are that many. The default is the largest up to 15.
    const n = total || 0;
    let chosen = null;
    document.querySelectorAll('#exam-count .filter-chip').forEach(b => {
        const c = Number(b.dataset.count);
        b.hidden = c > 10 && c > n;
        if (!b.hidden && c <= 15) chosen = b;
    });
    document.querySelectorAll('#exam-count .filter-chip').forEach(b => b.classList.toggle('active', b === chosen));
    renderExamTimeChips();
    const past = (studyItemsCache || []).some(i => studyCourseOf(i) === course && !i.twinOf && PAST_EXAM_FILE.test(i.sourceFile || ''));
    document.getElementById('exam-past-note').hidden = !past;
    showExamPart('exam-setup');
    window.scrollTo(0, 0);
}

document.querySelectorAll('#exam-count .filter-chip').forEach(b => {
    b.addEventListener('click', () => {
        b.parentElement.querySelectorAll('.filter-chip').forEach(x => x.classList.toggle('active', x === b));
        renderExamTimeChips();
    });
});

// One clock for the whole exam (1/10). Three lengths that fit the chosen
// number of questions (about 1, 2 and 3 minutes a question, rounded to 5),
// "Set my own" (5-300 minutes) and "No limit". The choice (which of them)
// stays when the number of questions changes.
function examTimeOptions(count) {
    const round5 = (m) => Math.max(5, Math.ceil(m / 5) * 5);
    return [round5(count), round5(count * 2), round5(count * 3)];
}
function renderExamTimeChips() {
    const group = document.getElementById('exam-time');
    if (!group) return;
    const activeChip = document.querySelector('#exam-count .filter-chip.active');
    const count = activeChip ? Number(activeChip.dataset.count) : 15;
    const before = group.querySelector('.filter-chip.active');
    const pick = before ? before.dataset.pick : 'p1';
    const chips = examTimeOptions(count).map((m, i) => ({ pick: `p${i}`, minutes: m, label: t('{n} minutes').replace('{n}', m) }));
    chips.push({ pick: 'own', label: t('Set my own') }, { pick: 'none', label: t('No limit') });
    group.textContent = '';
    for (const c of chips) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `filter-chip${c.pick === pick ? ' active' : ''}`;
        b.dataset.pick = c.pick;
        if (c.minutes) b.dataset.minutes = String(c.minutes);
        b.textContent = c.label;
        b.addEventListener('click', () => {
            group.querySelectorAll('.filter-chip').forEach(x => x.classList.toggle('active', x === b));
            syncExamMinutesBox();
        });
        group.appendChild(b);
    }
    syncExamMinutesBox();
}
function syncExamMinutesBox() {
    const chosen = document.querySelector('#exam-time .filter-chip.active');
    const own = !!chosen && chosen.dataset.pick === 'own';
    const wrap = document.getElementById('exam-minutes-wrap');
    const input = document.getElementById('exam-minutes-input');
    if (wrap) wrap.hidden = !own;
    if (own && input && !input.value) {
        const activeChip = document.querySelector('#exam-count .filter-chip.active');
        input.value = String(examTimeOptions(activeChip ? Number(activeChip.dataset.count) : 15)[1]);
    }
}
// The whole exam's time in seconds, 0 = no limit; null = a bad "own" value.
function chosenExamSeconds() {
    const chosen = document.querySelector('#exam-time .filter-chip.active');
    if (!chosen || chosen.dataset.pick === 'none') return 0;
    if (chosen.dataset.pick === 'own') {
        const m = Math.round(Number((document.getElementById('exam-minutes-input') || {}).value));
        return Number.isFinite(m) && m >= 5 && m <= 300 ? m * 60 : null;
    }
    return Number(chosen.dataset.minutes) * 60;
}

function leaveExam() {
    stopExam(false);
    document.getElementById('study-exam').hidden = true;
    document.getElementById('study-home').hidden = false;
    loadStudyHome();
}
document.getElementById('exam-cancel-btn').onclick = leaveExam;
document.getElementById('exam-done-btn').onclick = leaveExam;

document.getElementById('exam-start-btn').onclick = async () => {
    const btn = document.getElementById('exam-start-btn');
    const active = document.querySelector('#exam-count .filter-chip.active');
    examState.count = active ? Number(active.dataset.count) : 15;
    const seconds = chosenExamSeconds();
    if (seconds === null) { toast.info(t('Set the time as a number of minutes, from 5 to 300.')); return; }
    examState.timed = seconds > 0;
    btn.disabled = true;
    const qs = await ipcRenderer.invoke('study-exam-questions', examState.course, examState.count).catch(e => ({ error: e.message }));
    btn.disabled = false;
    if (!Array.isArray(qs)) { toast.error((qs && qs.error) || t('Couldn\'t load your questions right now. Check the connection and try again.')); return; }
    if (qs.length < 3) { toast.info(t('A mock exam needs at least 3 questions in this course.')); return; }
    examState.items = qs;
    examState.answers = qs.map(() => ({ typed: '', confidence: 'none', done: false }));
    examState.index = 0;
    // Fewer questions in the course than chosen: a preset length shrinks with
    // them (5 minutes at least); "Set my own" stays as the student set it.
    const picked = document.querySelector('#exam-time .filter-chip.active');
    examState.limitSec = seconds && picked && picked.dataset.pick !== 'own' && qs.length < examState.count
        ? Math.max(300, Math.round((seconds * qs.length) / examState.count / 60) * 60)
        : seconds;
    examState.startedAt = Date.now();
    examState.running = true;
    clearInterval(examState.timer);
    examState.timer = setInterval(tickExam, 1000);
    tickExam();
    showExamPart('exam-run');
    renderExamCard();
};

function tickExam() {
    const el = document.getElementById('exam-timer');
    if (!examState.running) return;
    const used = Math.floor((Date.now() - examState.startedAt) / 1000);
    const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    if (!examState.limitSec) { el.textContent = fmt(used); el.classList.remove('is-low'); return; }
    const left = Math.max(0, examState.limitSec - used);
    el.textContent = `${t('Time left')} ${fmt(left)}`;
    el.classList.toggle('is-low', left <= 60);
    if (left === 0) finishExam(true);
}

function renderExamCard() {
    const i = examState.index;
    const item = examState.items[i];
    const n = examState.items.length;
    document.getElementById('exam-position').textContent = outOfLabel(i + 1, n);
    document.getElementById('exam-progress-fill').style.width = `${(i / n) * 100}%`;
    document.getElementById('exam-course-badge').textContent = examState.label;
    document.getElementById('exam-past-badge').hidden = !item.fromPastExam;
    setMathText(document.getElementById('exam-question'), item.question);
    const box = document.getElementById('exam-answer');
    box.value = examState.answers[i].typed;
    box.placeholder = t(item.mode === 'practice' ? 'Your solution - the steps and the result' : 'Your answer');
    box.focus();
}

function storeMockAnswer(confidence) {
    const a = examState.answers[examState.index];
    a.typed = document.getElementById('exam-answer').value.trim();
    a.confidence = a.typed ? confidence : 'none';
    a.done = true;
}
document.querySelectorAll('.exam-conf').forEach(b => {
    b.addEventListener('click', () => {
        if (!examState.running) return;
        if (!document.getElementById('exam-answer').value.trim()) {
            toast.info(t('Write an answer first - or press "Skip" if you don\'t know it.'));
            return;
        }
        storeMockAnswer(b.dataset.confidence);
        nextExamCard();
    });
});
document.getElementById('exam-skip-btn').onclick = () => {
    if (!examState.running) return;
    document.getElementById('exam-answer').value = '';
    storeMockAnswer('none');
    nextExamCard();
};
function nextExamCard() {
    if (examState.index + 1 >= examState.items.length) return finishExam(false);
    examState.index += 1;
    renderExamCard();
}
document.getElementById('exam-finish-btn').onclick = async () => {
    const left = examState.answers.filter(a => !a.done).length;
    if (left > 0) {
        const ok = await confirmDialog(t('Finish the exam now?'),
            t('{n} questions have no answer yet - they count as wrong.', { n: left }),
            { confirmText: t('Finish and check') });
        if (!ok) return;
    }
    finishExam(false);
};

async function finishExam(timeUp) {
    if (!examState.running) return;
    examState.running = false;
    examState.checking = true;
    clearInterval(examState.timer);
    // What's typed on the current card counts, even without a button press.
    const cur = examState.answers[examState.index];
    if (cur && !cur.done) { cur.typed = document.getElementById('exam-answer').value.trim(); cur.confidence = cur.typed ? 'think_so' : 'none'; }
    const usedSec = Math.round((Date.now() - examState.startedAt) / 1000);
    // This run's own copy: a new exam started meanwhile can't mix into it.
    const run = { id: examState.runId, items: examState.items, answers: examState.answers, course: examState.course, startedAt: examState.startedAt, limitSec: examState.limitSec,
        clientRunId: `${examState.startedAt.toString(36)}${Math.random().toString(36).slice(2, 8)}` };
    const stale = () => examState.runId !== run.id;
    if (timeUp) toast.info(t('Time is up - checking what you wrote.'));
    showExamPart('exam-checking');
    const text = document.getElementById('exam-checking-text');

    // Check, three at a time. A used-up AI allowance stops the checking: the
    // rest is "not checked" (left out of the score), and the result says so.
    const results = run.items.map(() => null);
    let next = 0, done = 0, stopReason = null;
    const toCheck = run.answers.filter(a => a.typed).length;
    const worker = async () => {
        while (next < run.items.length && !stale()) {
            const i = next++;
            const item = run.items[i];
            const a = run.answers[i];
            if (!a.typed) { results[i] = { verdict: 'blank' }; continue; }
            if (stopReason) { results[i] = { verdict: 'unchecked' }; continue; }
            const res = await withTimeout(ipcRenderer.invoke('grade-study-answer', {
                question: item.question, expected: item.answer || '', mode: item.mode, userAnswer: a.typed, solutionSource: item.solutionSource || 'document'
            }).catch(e => ({ error: e.message })), CHECK_TIMEOUT_MS);
            if (res && res.verdict) results[i] = res;
            else {
                results[i] = { verdict: 'unchecked', error: res && res.error };
                if (res && res.error && isAiLimit(res.error)) stopReason = res.error;
            }
            done += 1;
            if (!stale()) text.textContent = t('Checking your answers… {done} of {total}', { done, total: toCheck });
        }
    };
    text.textContent = t('Checking your answers… {done} of {total}', { done: 0, total: toCheck });
    await Promise.all([worker(), worker(), worker()]);
    if (stale()) return;   // left the exam while it was being checked

    const answers = run.items.map((item, i) => ({ itemId: item.id, confidence: run.answers[i].confidence, verdict: results[i].verdict }));
    const saved = await ipcRenderer.invoke('study-exam-save', {
        course: run.course, startedAt: new Date(run.startedAt).toISOString(), limitSec: run.limitSec, usedSec, answers, clientRunId: run.clientRunId
    }).catch(e => ({ error: e.message }));
    if (stale()) return;
    examState.checking = false;
    if (saved && saved.error) toast.error(t('The result couldn\'t be saved - it is shown here, but won\'t be in your history.'));
    renderExamResult(saved && !saved.error ? saved : null, results, stopReason, run);
}

function renderExamResult(saved, results, stopReason, run) {
    const items = run.items;
    const answers = run.answers;
    // Same arithmetic as the server (routes/study.js examScore) - used when saving failed.
    const inScore = results.filter(r => r.verdict !== 'unchecked');
    const points = inScore.reduce((n, r) => n + (r.verdict === 'correct' ? 1 : r.verdict === 'partial' ? 0.5 : 0), 0);
    const p = inScore.length ? points / inScore.length : 0;
    const score = saved ? saved.score : Math.round(p * 100);
    const margin = saved ? saved.margin : Math.round(100 * Math.sqrt(Math.max(p * (1 - p), 0.04) / Math.max(1, inScore.length)));
    document.getElementById('exam-score').textContent = inScore.length ? score : '-';
    document.getElementById('exam-margin').textContent = inScore.length ? ` ±${margin}` : '';
    const count = (v) => results.filter(r => r.verdict === v).length;
    document.getElementById('exam-n-correct').textContent = count('correct');
    document.getElementById('exam-n-partial').textContent = count('partial');
    document.getElementById('exam-n-wrong').textContent = count('wrong') + count('blank');
    const sureWrong = results.filter((r, i) => answers[i].confidence === 'sure' && (r.verdict === 'wrong' || r.verdict === 'partial')).length;
    document.getElementById('exam-n-surewrong').textContent = sureWrong;
    const unchecked = count('unchecked');
    document.getElementById('exam-score-text').textContent = [
        t('Out of 100, from {n} checked answers. {m} because a short exam is a rough measure - more questions give a tighter number.', { n: inScore.length, m: `\u2066±${margin}\u2069` }),
        unchecked ? t('{n} answers couldn\'t be checked and are left out.', { n: unchecked }) + (stopReason && isAiLimit(stopReason) ? ` ${stopReason}` : '') : ''
    ].filter(Boolean).join(' ');

    // By topic: the skill, else the file - weakest first.
    const topics = new Map();
    items.forEach((item, i) => {
        const r = results[i];
        if (r.verdict === 'unchecked') return;
        const key = item.skillTag || (item.sourceFile ? fileLabel(item.sourceFile) : t('General'));
        const tp = topics.get(key) || { n: 0, pts: 0 };
        tp.n += 1; tp.pts += r.verdict === 'correct' ? 1 : r.verdict === 'partial' ? 0.5 : 0;
        topics.set(key, tp);
    });
    const topicRows = [...topics.entries()].map(([k, v]) => ({ k, n: v.n, pct: Math.round((v.pts / v.n) * 100) })).sort((a, b) => a.pct - b.pct || b.n - a.n);
    const topicsEl = document.getElementById('exam-topics');
    topicsEl.innerHTML = '';
    topicRows.forEach(r => {
        const row = document.createElement('div');
        row.className = 'exam-topic';
        row.innerHTML = `<div class="exam-topic__head"><bdi class="exam-topic__name"></bdi><span class="exam-topic__pct ms-tabular">${r.pct}%</span></div><div class="exam-topic__bar"><div style="width:${r.pct}%"></div></div><div class="exam-topic__n"></div>`;
        row.querySelector('.exam-topic__name').textContent = r.k;
        row.querySelector('.exam-topic__n').textContent = r.n === 1 ? t('1 question') : t('{n} questions', { n: r.n });
        row.classList.toggle('is-weak', r.pct < 50);
        topicsEl.append(row);
    });

    const VERDICT_LABELS = { correct: 'Right', partial: 'Half right', wrong: 'Wrong', blank: 'Skipped', unchecked: 'Not checked' };
    const CONF_LABELS = { sure: 'I\'m sure', think_so: 'I think so', guessing: 'Guessing', none: '' };
    const list = document.getElementById('exam-answers');
    list.innerHTML = '';
    items.forEach((item, i) => {
        const r = results[i];
        const a = answers[i];
        const el = document.createElement('div');
        el.className = `exam-answer is-${r.verdict}`;
        el.innerHTML = `
            <div class="exam-answer__top"><span class="exam-answer__verdict"></span><span class="exam-answer__conf"></span></div>
            <div class="exam-answer__q" dir="auto" translate="no"></div>
            <div class="exam-answer__line"><span class="exam-answer__label"></span> <span class="exam-answer__yours" dir="auto" translate="no"></span></div>
            <div class="exam-answer__feedback" dir="auto" translate="no"></div>
            <div class="exam-answer__line exam-answer__right"><span class="exam-answer__label"></span> <span class="exam-answer__correct" dir="auto" translate="no"></span></div>`;
        el.querySelector('.exam-answer__verdict').textContent = t(VERDICT_LABELS[r.verdict]);
        el.querySelector('.exam-answer__conf').textContent = a.confidence !== 'none' ? `${t('You said:')} ${t(CONF_LABELS[a.confidence])}` : '';
        setMathText(el.querySelector('.exam-answer__q'), item.question);
        el.querySelectorAll('.exam-answer__label')[0].textContent = t('Your answer:');
        el.querySelector('.exam-answer__yours').textContent = a.typed || '-';
        setMathText(el.querySelector('.exam-answer__feedback'), r.feedback || '');
        el.querySelectorAll('.exam-answer__label')[1].textContent = t('The answer:');
        const right = r.answer || String(item.answer || '').slice(0, 400);
        setMathText(el.querySelector('.exam-answer__correct'), right);
        el.querySelector('.exam-answer__right').hidden = !right || r.verdict === 'correct';
        list.append(el);
    });

    const missed = items.filter((it, i) => ['wrong', 'partial', 'blank'].includes(results[i].verdict)).map(it => it.id);
    const btn = document.getElementById('exam-practice-missed-btn');
    btn.hidden = missed.length === 0;
    btn.onclick = () => {
        document.getElementById('study-exam').hidden = true;
        startStudySession(null, { category: run.course, label: t('Missed in the mock exam'), ids: missed });
    };
    showExamPart('exam-result');
    window.scrollTo(0, 0);
}

// ---- The mistake loop (30/9) ------------------------------------------------
// After a wrong / half / "I don't know" answer, the AI writes a TWIN: the same
// idea from another angle (or the same method with other numbers). It's
// saved to the deck and comes up a few cards later in this session. Getting
// the twin right is evidence of understanding - the original's answer was
// just on screen, so getting the original right again proves little.
// A few per session (each is a small AI job); never a twin of a twin.
const MAX_TWINS_PER_SESSION = 5;
async function makeTwin(item) {
    const session = studyState.session;
    if (!session || item.twinOf || studyState.checkOff) return;
    const base = String(item.answer || item.mySolution || '').trim();
    if (!base) return;
    // An array, not a Set: the session is saved as JSON (to resume it).
    if (!Array.isArray(session.twinsAsked)) session.twinsAsked = [];
    if (session.twinsAsked.includes(item.id) || session.twinsAsked.length >= MAX_TWINS_PER_SESSION) return;
    session.twinsAsked.push(item.id);
    const queue = studyState.queue;
    const res = await withTimeout(ipcRenderer.invoke('make-twin-question', {
        question: item.question, answer: base, mode: item.mode, solutionSource: item.solutionSource || 'document'
    }).catch(e => ({ error: e.message })), 50000);
    if (!res || res.error || !res.question) {
        if (res && res.error && isAiLimit(res.error)) studyState.checkOff = res.error;
        return;
    }
    const saved = await ipcRenderer.invoke('save-study-items', [{
        question: res.question, answer: res.answer, mode: item.mode, solutionSource: 'ai',
        skillTag: item.skillTag || '', category: item.category || '', sourceFile: item.sourceFile || '', twinOf: item.id, kind: item.kind || ''
    }]).catch(() => null);
    const twin = saved && Array.isArray(saved.items) && saved.items[0];
    if (!twin) return;
    const withId = { ...twin, id: twin.id || twin._id, twinOf: twin.twinOf || item.id };
    session.twins = (session.twins || 0) + 1;
    // Still the same session on screen: slot it in a few cards ahead.
    const sessionOn = !document.getElementById('study-session').hidden && studyState.queue === queue;
    if (sessionOn) {
        const at = Math.min(queue.length, studyState.index + 3);
        queue.splice(at, 0, withId);
        saveSessionProgress();
        const pos = document.getElementById('study-position');
        if (pos) pos.textContent = outOfLabel(studyState.index + 1, queue.length);
        if (session.twins === 1) toast.info(t('A new question on the idea you missed was added - it comes up in a few questions.'), t('Same idea, new question'));
    } else if (!document.getElementById('study-summary').hidden && studyState.session === session) {
        showTwinSummary(session.twins);
    }
}

// The summary's "N new questions" line - also refreshed when a twin for the
// last card arrives after the summary is already up.
function showTwinSummary(n) {
    const el = document.getElementById('summary-twins');
    if (!el) return;
    el.hidden = n === 0;
    el.textContent = n === 1
        ? t('1 new question was written on an idea you missed. It stays in your deck and comes back with the rest.')
        : t('{n} new questions were written on ideas you missed. They stay in your deck and come back with the rest.', { n });
}

function endStudySession() {
    clearSessionProgress();
    // Tomorrow's questions get their new versions now, while the app is open.
    prepareVersions('tomorrow');
    document.getElementById('study-session').hidden = true;
    document.getElementById('study-summary').hidden = false;

    const s = studyState.session;
    document.getElementById('summary-reviewed').textContent = s.reviewed;
    document.getElementById('summary-correct').textContent = s.correct;
    const luckyEl = document.getElementById('summary-lucky');
    if (luckyEl) {
        const n = s.lucky || 0;
        luckyEl.hidden = n === 0;
        luckyEl.textContent = n === 1
            ? '1 more was right while you were guessing. That doesn\'t count as knowing it - it comes back tomorrow to check.'
            : `${n} more were right while you were guessing. That doesn't count as knowing them - they come back tomorrow to check.`;
    }
    document.getElementById('summary-overconfident').textContent = s.overconfident;
    showTwinSummary(s.twins || 0);

    const swBox = document.getElementById('summary-surewrong');
    const swList = document.getElementById('summary-surewrong-list');
    const sureWrong = s.sureWrong || [];
    if (swBox && swList) {
        swList.innerHTML = '';
        sureWrong.forEach(q => { const li = document.createElement('li'); li.dir = 'auto'; li.textContent = q; swList.append(li); });
        swBox.hidden = sureWrong.length === 0;
    }

    const msg = document.getElementById('summary-message');
    if (s.reviewed === 0) msg.textContent = '';
    else if (s.overconfident > 0) {
        msg.textContent = `${s.overconfident} question${s.overconfident === 1 ? '' : 's'} you felt sure about turned out wrong. Those are scheduled to come back quickly.`;
    } else {
        msg.textContent = 'Your confidence matched your results this session.';
    }
}

const startStudyBtn = document.getElementById('start-study-btn');
// Wrapped, not passed directly: onclick hands the handler a MouseEvent, which
// would arrive as the `resume` argument and send a fresh session down the
// resume path with no ids - throwing, so the button appeared to do nothing.
if (startStudyBtn) startStudyBtn.onclick = () => startStudySession();

const studyNextBtn = document.getElementById('study-next-btn');
if (studyNextBtn) studyNextBtn.onclick = () => { if (studyState.aiOutcome) submitReview(studyState.aiOutcome); };

const endStudyBtn = document.getElementById('end-study-btn');
if (endStudyBtn) endStudyBtn.onclick = endStudySession;

const summaryDoneBtn = document.getElementById('summary-done-btn');
if (summaryDoneBtn) summaryDoneBtn.onclick = async () => {
    document.getElementById('study-summary').hidden = true;
    document.getElementById('study-home').hidden = false;
    await loadStudyHome();
};

// ---- Which course does something belong to? ----
// A course is what links questions to their exam (the server times reviews
// around it). Nobody should have to know that, so the app works it out:
//   1. the file's folder ("סטטיסטיקה") - how most people already sort files;
//   2. no folder: the course the AI read in the file itself, matched to a
//      course the user already has ("מבוא לסטטיסטיקה" -> "סטטיסטיקה");
//   3. nothing at all: the file name.
const COURSE_GENERIC_WORDS = new Set(['מבוא', 'יסודות', 'קורס', 'עקרונות', 'intro', 'introduction', 'to', 'of', 'the', 'and', 'course']);
function courseKey(name) {
    return String(name || '').toLowerCase()
        .replace(/["'`׳״.,:;!?()\[\]{}\-־–—_/\\]/g, ' ')
        .split(/\s+/)
        .filter(w => w && !COURSE_GENERIC_WORDS.has(w))
        // Prefix letters come off repeatedly on BOTH names, so "למדעי" and
        // "מדעי" end at the same root even though מ is also part of the word.
        .map(w => { while (w.length > 3 && /^[בלהמושכ]/.test(w)) w = w.slice(1); return w; })
        .filter(w => w && !COURSE_GENERIC_WORDS.has(w))
        .sort()
        .join(' ');
}
function realFolder(file) {
    const f = (file && file.folder || '').trim();
    return f && f !== 'No Folder' ? f : '';
}
async function knownCourses() {
    const [folders, cats] = await Promise.all([
        ipcRenderer.invoke('get-folders').catch(() => []),
        ipcRenderer.invoke('get-study-categories').catch(() => [])
    ]);
    const names = [...(folders || []).map(f => f.name), ...(cats || [])]
        .map(n => String(n || '').trim()).filter(n => n && n !== 'No Folder' && n !== 'Uncategorized');
    return [...new Set(names)];
}
function resolveCourse(file, aiCourse, known) {
    const folder = realFolder(file);
    if (folder) return folder;
    const guess = String(aiCourse || '').trim();
    if (guess) {
        const key = courseKey(guess);
        const existing = key && (known || []).find(k => courseKey(k) === key);
        return existing || guess;
    }
    return String(file && file.name || '').replace(/\.[^.]+$/, '').trim();
}

// ---- Generating questions from an uploaded file ----
// Used by "Make questions from a file" and by the offer after an upload.
// No "which course?" question any more - see resolveCourse above; the course
// is shown (and can be changed) on the review screen.
let questionsInProgress = false;
async function generateQuestionsFor(file, button = null) {
    if (questionsInProgress) { toast.info('Already making questions - one file at a time.'); return; }
    questionsInProgress = true;
    const folder = realFolder(file);
    const originalHTML = button ? button.innerHTML : '';
    if (button) { button.disabled = true; button.textContent = 'Reading the document...'; }
    const working = button ? null : toast.info(`Making questions from ${isolate(file.name)}… this takes about a minute.`, 'Working on it');

    try {
        const aiConfig = await ipcRenderer.invoke('get-ai-config');
        const opts = { category: folder, sourceFile: file.name };
        let response;

        if (aiConfig && aiConfig.visionAvailable && file.sourcePath && /\.pdf$/i.test(file.name)) {
            // The PDF itself: layout, formulas and Hebrew order intact.
            response = await ipcRenderer.invoke('generate-study-items-pdf', file.sourcePath, opts);
            const first = JSON.parse(response);
            // Fall back to the extracted text only when reading the PDF itself
            // failed (30/9). Not for a used-up allowance or a busy AI (the
            // text path would hit the same wall - and on the website it used
            // a SECOND file action), and not for "no examinable content"
            // (the text says the same thing, for another file action).
            const noPoint = (e) => isAiLimit(e) || /another ai job|no examinable content/i.test(String(e || ''));
            if (first.error && !noPoint(first.error)) {
                console.warn('⚠️ PDF generation failed, falling back to extracted text:', first.error);
                toast.info('Reading the PDF directly didn\'t work right now - using the text extracted from it instead. Formulas and tables may come out worse, so check the questions before adding them.', 'Using the extracted text');
                response = await ipcRenderer.invoke('generate-study-items', file.content, opts);
            }
        } else {
            response = await ipcRenderer.invoke('generate-study-items', file.content, opts);
        }

        const result = JSON.parse(response);
        if (result.error) { toast.error(result.error, 'Could not create questions'); return; }

        const course = folder || resolveCourse(file, result[0] && result[0].category, await knownCourses());
        result.forEach(item => { item.category = course; });

        // Draft first, deck second: a review screen before anything is saved.
        if (typeof working === 'function') working();
        const nav = document.getElementById('nav-study');
        if (nav && document.getElementById('view-study').style.display === 'none') nav.click();
        openReviewScreen(result, { course, fileName: file.name });
    } catch (e) {
        toast.error(e.message, 'Something went wrong');
    } finally {
        questionsInProgress = false;
        if (button) { button.disabled = false; button.innerHTML = originalHTML; }
    }
}

const generateStudyBtn = document.getElementById('generate-study-btn');
if (generateStudyBtn) {
    generateStudyBtn.onclick = async () => {
        const files = await ipcRenderer.invoke('get-files');
        if (!files || files.length === 0) {
            toast.info('Upload course material under Materials first.', 'No files yet');
            return;
        }
        const chosen = await pickOption('Create questions from which file?', files.map(f => f.name));
        if (!chosen) return;
        const file = files.find(f => f.name === chosen);
        if (file) await generateQuestionsFor(file, generateStudyBtn);
    };
}

const navStudyBtn = document.getElementById('nav-study');
if (navStudyBtn) navStudyBtn.addEventListener('click', loadStudyHome);

loadStudyHome();

// ---- Managing / deleting study questions ----
// Generated questions are only as good as the model that made them, so
// removing a bad batch has to be as easy as creating it. Without this the
// deck only ever grows, and one poor generation permanently pollutes it.
let manageSourceFilter = 'all';
// Selection for bulk-deleting questions. Deleting a bad batch one row at a
// time is exactly the chore the bulk bar removed from Tasks; Manage needed
// the same thing.
const selectedQuestionIds = new Set();


// Clears the Manage selection and removes its floating bar.
//
// The bar is appended to document.body, so it outlives the panel that created
// it: leaving Manage by any route left it hovering over the next screen with
// a stale count and a live handler pointing at deleted questions.
function clearManageSelection() {
    selectedQuestionIds.clear();
    const bar = document.getElementById('manage-selection-bar');
    if (bar) bar.remove();
}

function updateManageSelectionBar() {
    let bar = document.getElementById('manage-selection-bar');

    if (selectedQuestionIds.size === 0) {
        if (bar) bar.remove();
        return;
    }

    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'manage-selection-bar';
        bar.className = 'bulk-bar';
        document.body.appendChild(bar);
    }

    bar.innerHTML = `
        <span class="bulk-bar__count"><strong>${selectedQuestionIds.size}</strong> selected</span>
        <div class="bulk-bar__actions">
            <button class="btn-secondary bulk-danger" data-act="delete">Delete selected</button>
            <button class="btn-icon" data-act="clear" aria-label="Clear selection">${icon('close', { size: 16 })}</button>
        </div>`;

    bar.querySelector('[data-act="clear"]').onclick = () => {
        selectedQuestionIds.clear();
        updateManageSelectionBar();
        loadManageList();
    };

    bar.querySelector('[data-act="delete"]').onclick = async () => {
        const count = selectedQuestionIds.size;
        const ok = await confirmDialog(
            `Delete ${count} question(s)?`,
            'Their review history and any saved solutions go too. This cannot be undone.',
            { confirmText: 'Delete', danger: true }
        );
        if (!ok) return;

        const res = await ipcRenderer.invoke('delete-study-items-bulk', [...selectedQuestionIds]);
        if (res && res.error) { toast.error(res.error, 'Could not delete'); return; }

        clearManageSelection();
        toast.success(`Deleted ${res.deleted} question(s).`);
        await loadManageList();
    };
}

const manageStudyBtn = document.getElementById('manage-study-btn');
const closeManageBtn = document.getElementById('close-manage-btn');
const deleteScopeBtn = document.getElementById('delete-scope-btn');

if (manageStudyBtn) {
    manageStudyBtn.onclick = async () => {
        document.getElementById('study-home').hidden = true;
        document.getElementById('study-review').hidden = true;
        document.getElementById('study-manage').hidden = false;
        // The list loaded with the Study screen shows at once; a fresh copy
        // replaces it a moment later. Before, the screen sat empty with no
        // sign of loading while every question came from the server.
        if (studyItemsCache) await loadManageList(false);
        else renderSkeleton(document.getElementById('manage-list'), 4);
        await loadManageList();
    };
}

if (closeManageBtn) {
    closeManageBtn.onclick = async () => {
        clearManageSelection();
        document.getElementById('study-manage').hidden = true;
        document.getElementById('study-home').hidden = false;
        await loadStudyHome();
    };
}

// refetch = false: filter the list already here (switching the file chip is
// instant) instead of asking the server for every question again.
async function loadManageList(refetch = true) {
    if (refetch || !studyItemsCache) {
        const fresh = await ipcRenderer.invoke('get-study-items', { light: true });
        if (Array.isArray(fresh)) studyItemsCache = fresh;
    }
    const items = studyItemsCache || [];
    const listEl = document.getElementById('manage-list');
    const filtersEl = document.getElementById('manage-source-filters');
    if (!listEl) return;

    // Reset the bulk-delete control FIRST, before any early return.
    // The previous version only configured it on the path where items exist,
    // so deleting an entire set left the button visible with a stale click
    // handler still closing over the old list - hence "Delete this whole set
    // (14)" for 14 questions that no longer existed. Clearing the handler
    // matters as much as hiding it: hidden elements keep their listeners.
    if (deleteScopeBtn) {
        deleteScopeBtn.hidden = true;
        deleteScopeBtn.onclick = null;
    }

    if (!items || items.length === 0) {
        manageSourceFilter = 'all';
        renderEmptyState(listEl, {
            icon: 'list',
            title: 'No questions yet',
            message: 'Make questions from one of your files to start practicing.'
        });
        if (filtersEl) filtersEl.innerHTML = '';
        return;   // the delete button was already reset above
    }

    // Group by the file they came from - that's the unit you actually want to
    // delete, since a bad batch comes from one document.
    const sources = [...new Set(items.map(i => i.sourceFile || 'Manual'))].sort();

    // The selected source may have just been deleted entirely - without this
    // the filter stays pointing at something that no longer exists.
    if (manageSourceFilter !== 'all' && !sources.includes(manageSourceFilter)) {
        manageSourceFilter = 'all';
    }
    if (filtersEl) {
        filtersEl.innerHTML = ['all', ...sources].map(src => `
            <button class="filter-chip ${manageSourceFilter === src ? 'active' : ''}" data-source="${escapeHtml(src)}" dir="auto">
                ${src === 'all' ? 'All' : src === 'Manual' ? 'Manual' : escapeHtml((l => (l.length > 28 ? l.slice(0, 28) + '…' : l))(fileLabel(src)))}
            </button>`).join('');
        filtersEl.querySelectorAll('.filter-chip').forEach(chip => {
            chip.onclick = () => { manageSourceFilter = chip.dataset.source; loadManageList(false); };
        });
    }

    const visible = manageSourceFilter === 'all'
        ? items
        : items.filter(i => (i.sourceFile || 'Manual') === manageSourceFilter);

    // Deleting a whole set only makes sense when a set is selected.
    // Drop selections for questions that no longer exist.
    const liveIds = new Set(items.map(i => i.id));
    [...selectedQuestionIds].forEach(id => { if (!liveIds.has(id)) selectedQuestionIds.delete(id); });
    updateManageSelectionBar();

    // One delete control whose scope follows the active filter.
    if (deleteScopeBtn && items.length > 0) {
        const deletingAll = manageSourceFilter === 'all';
        const targets = deletingAll ? items : visible;

        if (targets.length > 0) {
            deleteScopeBtn.hidden = false;
            deleteScopeBtn.textContent = deletingAll
                ? `Delete everything (${targets.length})`
                : `Delete this set (${targets.length})`;

            deleteScopeBtn.onclick = async () => {
                const ok = await confirmDialog(
                    deletingAll
                        ? `Delete all ${targets.length} questions?`
                        : `Delete ${targets.length} question(s) from "${manageSourceFilter}"?`,
                    'This also removes the review history and any solutions you saved. It cannot be undone.',
                    { confirmText: 'Delete', danger: true }
                );
                if (!ok) return;

                const res = deletingAll
                    ? await ipcRenderer.invoke('delete-all-study-items')
                    : await ipcRenderer.invoke('delete-study-items-bulk', targets.map(i => i.id));

                if (res && res.error) { toast.error(res.error, 'Could not delete'); return; }
                toast.success(`Deleted ${res.deleted} question(s).`);
                manageSourceFilter = 'all';
                await loadManageList();
            };
        }
    }

    const allShownSelected = visible.length > 0 && visible.every(i => selectedQuestionIds.has(i.id));
    const selectAllHtml = `
        <div class="select-all-row">
            <label class="select-all-label">
                <input type="checkbox" id="manage-select-all" ${allShownSelected ? 'checked' : ''} />
                <span>Select all ${visible.length} shown</span>
            </label>
        </div>`;

    listEl.innerHTML = selectAllHtml + visible.map(i => `
        <div class="manage-item" data-id="${i.id}">
            <label class="manage-item__check">
                <input type="checkbox" class="manage-select-box" ${selectedQuestionIds.has(i.id) ? 'checked' : ''} />
            </label>
            <div class="manage-item__body">
                <div class="manage-item__q" dir="auto">${escapeHtml(i.question)}</div>
                <div class="manage-item__meta">
                    ${escapeHtml(MODE_LABELS[i.mode] || i.mode)}
                    ${i.category ? ' · ' + escapeHtml(i.category) : ''}
                    ${i.repetitions > 0 ? ` · reviewed ${i.repetitions}×` : i.lapses > 0 ? ` · ${t('answered, not known yet')}` : ' · never reviewed'}
                </div>
            </div>
            <button class="btn-icon btn-icon--danger manage-item__delete" aria-label="Delete question">${icon('trash', { size: 16 })}</button>
        </div>`).join('');

    const manageSelectAll = listEl.querySelector('#manage-select-all');
    if (manageSelectAll) {
        manageSelectAll.onchange = (e) => {
            const checked = e.target.checked;
            visible.forEach(i => checked ? selectedQuestionIds.add(i.id) : selectedQuestionIds.delete(i.id));
            // In place, for the same reason as the Tasks list: a full reload
            // would blank the screen for a selection change.
            listEl.querySelectorAll('.manage-select-box').forEach(b => {
                b.checked = checked;
                const r = b.closest('.manage-item');
                if (r) r.classList.toggle('is-selected', checked);
            });
            updateManageSelectionBar();
        };
    }

    listEl.querySelectorAll('.manage-item').forEach(row => {
        const box = row.querySelector('.manage-select-box');
        if (box) {
            box.onchange = (e) => {
                if (e.target.checked) selectedQuestionIds.add(row.dataset.id);
                else selectedQuestionIds.delete(row.dataset.id);
                row.classList.toggle('is-selected', e.target.checked);
                updateManageSelectionBar();
            };
            if (selectedQuestionIds.has(row.dataset.id)) row.classList.add('is-selected');
        }

        row.querySelector('.manage-item__delete').onclick = async () => {
            // Asked first (30/9) - its practice history goes with it.
            if (!await confirmDialog(t('Delete this question?'), t('Its practice history goes too. This cannot be undone.'), { confirmText: t('Delete'), danger: true })) return;
            const res = await ipcRenderer.invoke('delete-study-item', row.dataset.id);
            if (res && res.error) { toast.error(res.error, 'Could not delete'); return; }
            toast.info('Question deleted.');
            // Reload rather than just removing the row. Removing the element
            // left the "Delete this whole set" button holding a stale closure
            // that still counted the deleted items, so it offered to delete
            // 12 questions that no longer existed.
            await loadManageList();
        };
    });
}

// ---- Saving your own solution to a practice item ----
const saveSolutionBtn = document.getElementById('save-solution-btn');
const copyQuestionBtn = document.getElementById('copy-question-btn');

if (saveSolutionBtn) {
    saveSolutionBtn.onclick = async () => {
        const item = studyState.queue[studyState.index];
        const input = document.getElementById('study-solution-input');
        if (!item || !input) return;

        const text = input.value.trim();
        saveSolutionBtn.disabled = true;
        const res = await ipcRenderer.invoke('update-study-item', item.id, { mySolution: text });
        saveSolutionBtn.disabled = false;

        if (res && res.error) { toast.error(res.error, 'Could not save'); return; }
        item.mySolution = text;   // keep the in-memory copy in step
        toast.success('Saved. You will see this next time this question comes up.');
    };
}

if (copyQuestionBtn) {
    copyQuestionBtn.onclick = async () => {
        const item = studyState.queue[studyState.index];
        if (!item) return;
        // Verifying a proof or a calculation is something a large chat model
        // genuinely does better than anything running locally here, so make
        // handing it over easy rather than pretending to compete.
        const input = document.getElementById('study-solution-input');
        const mine = input && input.value.trim();
        const payload = mine
            ? `${item.question}\n\nMy solution:\n${mine}\n\nIs this correct? Where did I go wrong?`
            : item.question;
        try {
            await navigator.clipboard.writeText(payload);
            toast.success('Copied. Paste it into a chat model to check your working.');
        } catch (e) {
            toast.error('Could not access the clipboard.');
        }
    };
}

// ==========================================
// 16. Reviewing generated questions before they enter the deck
// ==========================================
// A generated question is a DRAFT. Filters catch the failures we've seen -
// garbled quotes, trivia, questions that need the document - but each new
// document finds a new way to break, and no rule set will ever be complete.
// A human glance catches all of them in seconds, so that's the last gate.

let reviewDraft = [];

function openReviewScreen(items, meta = {}) {
    // Questions finished while a practice session is on screen (30/9): both
    // screens used to show at once. Offer them instead; the session's place
    // is kept (it resumes from Study).
    const sessionEl = document.getElementById('study-session');
    const examOn = examState.running || examState.checking;
    if (((sessionEl && !sessionEl.hidden) || examOn) && !meta._fromToast) {
        showActionToast(t('Your new questions are ready to look over.'), t('Look over now'), async () => {
            if (!(await stopExam())) return;
            sessionEl.hidden = true;
            openReviewScreen(items, { ...meta, _fromToast: true });
        }, { duration: 60000 });
        return;
    }
    if (sessionEl) sessionEl.hidden = true;
    reviewDraft = items.map((it, i) => ({ ...it, _id: i, _selected: true }));

    const courseInput = document.getElementById('review-course-input');
    if (courseInput) {
        courseInput.value = meta.course || (items[0] && items[0].category) || '';
        knownCourses().then(names => {
            const dl = document.getElementById('review-course-list');
            if (dl) dl.innerHTML = names.map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
        }).catch(() => {});
    }

    document.getElementById('study-home').hidden = true;
    document.getElementById('study-manage').hidden = true;
    document.getElementById('study-review').hidden = false;

    renderReviewList();
}

function renderReviewList() {
    const listEl = document.getElementById('review-list');
    if (!listEl) return;

    listEl.innerHTML = reviewDraft.map(item => `
        <div class="review-item ${item._selected ? '' : 'is-excluded'}" data-id="${item._id}">
            <label class="review-item__check">
                <input type="checkbox" ${item._selected ? 'checked' : ''} />
            </label>
            <div class="review-item__body">
                <div class="review-item__q" contenteditable="plaintext-only" dir="auto" data-field="question">${escapeHtml(item.question)}</div>
                ${item.answer
                    ? `<details class="review-item__reveal" ${item.solutionSource === 'ai' ? 'open' : ''}>
                         <summary>${item.solutionSource === 'ai' ? 'AI solution' : 'Show the answer'}</summary>
                         <div class="review-item__a" contenteditable="plaintext-only" dir="auto" data-field="answer">${escapeHtml(item.answer)}</div>
                       </details>`
                    : '<div class="review-item__a review-item__a--empty">No answer passage — this will be a practice prompt.</div>'}
                <div class="review-item__meta">
                    ${escapeHtml(MODE_LABELS[item.mode] || item.mode)}
                    ${item.solutionSource === 'ai'
                        ? '<span class="review-item__source review-item__source--ai">AI solution — check this one</span>'
                        : '<span class="review-item__source review-item__source--doc">From the document</span>'}
                    ${item.skillTag ? ` · ${escapeHtml(item.skillTag)}` : ''}
                </div>
            </div>
        </div>`).join('');

    listEl.querySelectorAll('.review-item').forEach(row => {
        const id = Number(row.dataset.id);
        const item = reviewDraft.find(d => d._id === id);

        row.querySelector('input[type="checkbox"]').onchange = (e) => {
            item._selected = e.target.checked;
            row.classList.toggle('is-excluded', !e.target.checked);
            updateReviewCount();
        };

        // Edits are saved on blur, so fixing a clipped definition doesn't
        // require a separate save step.
        row.querySelectorAll('[contenteditable]').forEach(el => {
            // innerText keeps the line breaks (code, steps of a solution) - textContent lost them.
            el.onblur = () => { item[el.dataset.field] = el.innerText.replace(/\u00a0/g, ' ').trim(); };
        });
    });

    updateReviewCount();
}

function updateReviewCount() {
    const selected = reviewDraft.filter(d => d._selected).length;
    const selEl = document.getElementById('review-selected-count');
    const totEl = document.getElementById('review-total-count');
    const confirmBtn = document.getElementById('review-confirm-btn');
    if (selEl) selEl.textContent = selected;
    if (totEl) totEl.textContent = reviewDraft.length;
    if (confirmBtn) {
        confirmBtn.disabled = selected === 0;
        confirmBtn.textContent = selected === 0 ? 'Nothing selected' : `Add ${selected} question${selected === 1 ? '' : 's'}`;
    }
}

function closeReviewScreen() {
    reviewDraft = [];
    document.getElementById('study-review').hidden = true;
    document.getElementById('study-home').hidden = false;
}

const reviewSelectAll = document.getElementById('review-select-all');
if (reviewSelectAll) reviewSelectAll.onclick = () => {
    reviewDraft.forEach(d => { d._selected = true; });
    renderReviewList();
};

const reviewSelectNone = document.getElementById('review-select-none');
if (reviewSelectNone) reviewSelectNone.onclick = () => {
    reviewDraft.forEach(d => { d._selected = false; });
    renderReviewList();
};

const reviewCancelBtn = document.getElementById('review-cancel-btn');
if (reviewCancelBtn) reviewCancelBtn.onclick = async () => {
    const ok = await confirmDialog(
        'Discard all these questions?',
        'None of them will be added. You can generate again from the same file.',
        { confirmText: 'Discard', danger: true }
    );
    if (!ok) return;
    closeReviewScreen();
    await loadStudyHome();
};

const reviewConfirmBtn = document.getElementById('review-confirm-btn');
if (reviewConfirmBtn) reviewConfirmBtn.onclick = async () => {
    const chosen = reviewDraft
        .filter(d => d._selected && d.question && d.question.trim())
        .map(({ _id, _selected, ...clean }) => clean);   // keeps mode, solutionSource, skillTag

    if (chosen.length === 0) return;

    const courseInput = document.getElementById('review-course-input');
    const course = courseInput && courseInput.value.trim();
    if (course) chosen.forEach(c => { c.category = course; });

    reviewConfirmBtn.disabled = true;
    const res = await ipcRenderer.invoke('save-study-items', chosen);
    reviewConfirmBtn.disabled = false;

    if (res && res.error) { toast.error(res.error, 'Could not save'); return; }

    const discarded = reviewDraft.length - chosen.length;
    // What the server really saved, not what was sent (30/9).
    const added = res && Number.isInteger(res.created) ? res.created : chosen.length;
    toast.success(
        discarded > 0
            ? `Added ${added} questions. ${discarded} discarded.`
            : `Added ${added} questions.`,
        'Ready to study'
    );
    closeReviewScreen();
    await loadStudyHome();
};

// ==========================================
// 17. AI engine settings
// ==========================================
const geminiKeyInput = document.getElementById('gemini-key-input');
const saveKeyBtn = document.getElementById('save-key-btn');
const testKeyBtn = document.getElementById('test-key-btn');
const aiActiveLabel = document.getElementById('ai-active-label');
const aiKeyStatus = document.getElementById('ai-key-status');
const aiModelSelect = document.getElementById('ai-model-select');
const aiModelHint = document.getElementById('ai-model-hint');

// Which Gemini model writes summaries and questions. Flash is the default
// and works on a free key; Pro writes better but needs billing turned on
// for the key - without it, the app falls back to Flash and the summary
// window says so ("Gemini 3.1 Pro wasn't available").
const AI_MODEL_HINTS = {
    'gemini-3.8-flash': 'Fast, and works with a free key.',
    'gemini-3.1-pro-preview': 'Better summaries and questions, about 3x the cost of Flash. Works only if billing is turned on for your key in Google AI Studio - otherwise the app uses Flash and tells you.'
};
function showAiModelHint(model) {
    if (aiModelHint) aiModelHint.textContent = AI_MODEL_HINTS[model] || '';
}
if (aiModelSelect) {
    aiModelSelect.onchange = async () => {
        const model = aiModelSelect.value;
        const res = await ipcRenderer.invoke('save-ai-config', { geminiModel: model });
        if (res && res.error) { toast.error(res.error, 'Could not change the model'); return; }
        showAiModelHint(model);
        const name = aiModelSelect.options[aiModelSelect.selectedIndex].textContent.replace(/\s*\(.*\)$/, '');
        toast.success(`${name} will write your summaries and questions from now on.`, 'Model changed');
    };
}

async function loadAiSettings() {
    const cfg = await ipcRenderer.invoke('get-ai-config');
    if (!cfg) return;

    if (aiActiveLabel) {
        // Plain status instead of engine names ("Gemini - pages are read as
        // images...") that meant nothing to testers.
        aiActiveLabel.textContent = cfg.hasKey
            ? 'Connected ✓'
            : 'Not connected - summaries and questions won\'t work well until you add a key.';
        aiActiveLabel.classList.toggle('is-warning', !cfg.hasKey);
    }

    if (aiKeyStatus) {
        // Only ever show a masked form. The full key is never sent back from
        // the main process, so it can't leak through the UI.
        aiKeyStatus.innerHTML = cfg.hasKey
            ? `Saved (<span class="ms-tabular">${escapeHtml(cfg.keyPreview)}</span>). Paste a new one below to replace it.`
            : 'Not added yet.';
    }

    if (aiModelSelect && cfg.geminiModel) {
        const known = Array.from(aiModelSelect.options).some(o => o.value === cfg.geminiModel);
        aiModelSelect.value = known ? cfg.geminiModel : 'gemini-3.8-flash';
        showAiModelHint(aiModelSelect.value);
    }
}

if (testKeyBtn) {
    testKeyBtn.onclick = async () => {
        const key = geminiKeyInput.value.trim();
        if (!key) { toast.warning('Paste a key first.'); return; }

        testKeyBtn.disabled = true;
        testKeyBtn.textContent = 'Testing...';
        const res = await ipcRenderer.invoke('test-gemini-key', key);
        testKeyBtn.disabled = false;
        testKeyBtn.textContent = 'Test';

        // Testing before saving means a bad key is caught here, rather than
        // surfacing later as a mysterious generation failure.
        if (res.ok) toast.success('The key works.', 'Connected');
        else toast.error(res.error, 'Key rejected');
    };
}

if (saveKeyBtn) {
    saveKeyBtn.onclick = async () => {
        const key = geminiKeyInput.value.trim();
        if (!key) { toast.warning('Paste a key first.'); return; }

        saveKeyBtn.disabled = true;
        const test = await ipcRenderer.invoke('test-gemini-key', key);
        if (!test.ok) {
            saveKeyBtn.disabled = false;
            toast.error(test.error, 'Key rejected — not saved');
            return;
        }

        const res = await ipcRenderer.invoke('save-ai-config', { geminiKey: key });
        saveKeyBtn.disabled = false;
        if (res && res.error) { toast.error(res.error, 'Could not save'); return; }

        geminiKeyInput.value = '';
        await loadAiSettings();
        toast.success('Saved. Course material will now be read as pages.', 'Gemini connected');
    };
}

const navSettingsBtn = document.getElementById('nav-settings');
if (navSettingsBtn) navSettingsBtn.addEventListener('click', loadAiSettings);

// UX: the profile row already had role="button" and a title saying "Open
// settings", but nothing actually wired it up - clicking it did nothing.
const sidebarProfileTrigger = document.getElementById('sidebar-profile-trigger');
if (sidebarProfileTrigger && navSettingsBtn) {
    sidebarProfileTrigger.addEventListener('click', () => navSettingsBtn.click());
    sidebarProfileTrigger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            navSettingsBtn.click();
        }
    });
}

loadAiSettings();

const resumeSessionBtn = document.getElementById('resume-session-btn');
if (resumeSessionBtn) resumeSessionBtn.onclick = async () => {
    const resume = readSessionProgress();
    if (!resume) { toast.info('That session has expired.'); await loadStudyHome(); return; }
    await startStudySession(resume);
};

const discardSessionBtn = document.getElementById('discard-session-btn');
if (discardSessionBtn) discardSessionBtn.onclick = async () => {
    clearSessionProgress();
    await loadStudyHome();
    toast.info('Session cleared. Your answers were already saved.');
};

// ==========================================
// Full exam (1/10)
// ==========================================
// A whole exam paper for one course: written by the AI in the structure of
// the course's past exams (recommended, not required), sat with one clock,
// graded part by part with partial credit. main.js builds and grades it as
// background jobs; this screen starts them, polls, and shows the result.
const fullState = {
    course: '', exam: null, answers: {}, flags: new Set(), qIndex: 0,
    startedAt: 0, limitSec: 0, timer: null, running: false, grading: false,
    token: 0, clientRunId: '', autoSubmitFailed: false
};

const FULL_STAGE_TEXT = {
    reading: 'Reading your course files…',
    blueprint: 'Reading the past exams - how they are built and what repeats…',
    writing: 'Writing the questions and their full solutions…',
    checking: 'Solving every question a second time to check the solutions…',
    replacing: 'Writing a new part in place of one that turned out wrong…',
    saving: 'Saving the exam…',
    grading: 'Grading your answers…'
};

// Photographed answers of the sitting in progress ("q:p" -> [{ mimeType, data }]):
// in memory and on this device (IndexedDB, so the sitting can be continued).
// They go only to the reading of the handwriting and are deleted after grading.
const fullPhotos = new Map();
const FULL_PHOTOS_PER_PART = 3;
const FULL_PHOTO_MAX_BYTES = 700 * 1024;   // 3 of them fit one request
function fullPhotoDb() {
    return new Promise((resolve, reject) => {
        const r = indexedDB.open('mindsync-photos', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('runs');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}
async function fullPhotosStore(mode, runId, value) {
    if (!runId) return null;
    try {
        const db = await fullPhotoDb();
        return await new Promise((resolve) => {
            const tx = db.transaction('runs', mode === 'get' ? 'readonly' : 'readwrite');
            const store = tx.objectStore('runs');
            const r = mode === 'get' ? store.get(runId) : mode === 'put' ? store.put(value, runId) : store.delete(runId);
            r.onsuccess = () => resolve(mode === 'get' ? r.result || null : true);
            r.onerror = () => resolve(null);
        });
    } catch (e) { return null; }   // no storage here: the photos live in memory only
}
const saveFullPhotos = () => fullPhotosStore('put', fullState.clientRunId, [...fullPhotos.entries()]);
async function loadFullPhotos(runId) {
    const saved = await fullPhotosStore('get', runId);
    // Another sitting started meanwhile: these photos aren't its.
    if (!fullState.running || fullState.clientRunId !== runId) return false;
    fullPhotos.clear();
    if (Array.isArray(saved)) for (const [k, v] of saved) if (Array.isArray(v) && v.length) fullPhotos.set(k, v);
    // A part the draft says has photos that this device didn't keep: not answered.
    let lost = 0;
    for (const [k, a] of Object.entries(fullState.answers)) {
        const n = (fullPhotos.get(k) || []).length;
        if ((a.photos || 0) !== n) { if ((a.photos || 0) > n) lost += 1; fullState.answers[k] = { ...a, photos: n }; }
    }
    if (lost) { saveFullDraft(); toast.info(t('Some photos weren\'t kept on this device - photograph them again.')); }
    return true;
}
// Photos of sittings that can't be continued any more (graded, or left
// behind): deleted when the full exam opens.
async function pruneFullPhotos() {
    const live = new Set();
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || !k.startsWith('mindsync.fullExam.')) continue;
            const d = JSON.parse(localStorage.getItem(k) || 'null');
            if (d && d.clientRunId && !d.submitted) live.add(d.clientRunId);
        }
    } catch (e) { return; }   // no way to tell what is live: keep everything
    try {
        const db = await fullPhotoDb();
        const tx = db.transaction('runs', 'readwrite');
        const store = tx.objectStore('runs');
        const r = store.getAllKeys();
        r.onsuccess = () => { for (const k of r.result || []) if (!live.has(k) && k !== fullState.clientRunId) store.delete(k); };
    } catch (e) { /* no storage here */ }
}
// Worked out on paper: the writer says so; an older exam - maths in the text.
const FULL_MATHY = /[∫∑Σ√∞≤≥≠∂π∇²³]|\^|\b(lim|sin|cos|tan|log|ln|dx|dy)\b|\d\s*[+\-*/=]\s*\d/;
// A part graded by the choice alone takes a photo too, by the student's
// choice: it never changes the points - if the choice is wrong, the AI shows
// where the working went wrong.
function fullTakesPhoto(p, exam = fullState.exam) {
    if (p.type === 'code') return false;
    return exam && exam.handwrittenMarked ? p.handwritten === true : FULL_MATHY.test(p.text || '');
}

function showFullPart(part) {
    ['full-setup', 'full-building', 'full-intro', 'full-run', 'full-grading', 'full-result', 'full-reading', 'full-transcripts']
        .forEach(id => { document.getElementById(id).hidden = id !== part; });
    window.scrollTo(0, 0);
}

function fullDraftKey(examId) { return `mindsync.fullExam.${currentUserId || 'anon'}.${examId}`; }
function saveFullDraft() {
    if (!fullState.exam || !fullState.running) return;
    try {
        localStorage.setItem(fullDraftKey(fullState.exam.id), JSON.stringify({
            answers: fullState.answers, flags: [...fullState.flags], startedAt: fullState.startedAt,
            limitSec: fullState.limitSec, clientRunId: fullState.clientRunId
        }));
    } catch (e) { /* storage off: answers stay in memory */ }
}
function readFullDraft(examId) {
    try { return JSON.parse(localStorage.getItem(fullDraftKey(examId)) || 'null'); } catch (e) { return null; }
}
// A sitting sent for grading: its draft stays (in case grading fails) but
// is marked, so opening the exam again starts a new sitting.
function markFullDraft(examId, clientRunId, submitted) {
    const d = readFullDraft(examId);
    if (!d || d.clientRunId !== clientRunId) return;
    try { localStorage.setItem(fullDraftKey(examId), JSON.stringify({ ...d, submitted })); } catch (e) { /* storage off */ }
}
// Only the sitting that was graded - never a newer one of the same exam.
function clearFullDraft(examId, clientRunId) {
    const d = readFullDraft(examId);
    if (d && clientRunId && d.clientRunId !== clientRunId) return;
    try { localStorage.removeItem(fullDraftKey(examId)); } catch (e) { /* storage off */ }
}
// A draft that can be continued (not one already sent for grading).
function openFullDraft(examId) {
    const d = readFullDraft(examId);
    return d && !d.submitted ? d : null;
}

// Another screen wants Study while the exam runs: ask first. The answers
// stay on this device and the clock keeps its start time, so it can be
// picked up again from the course's list - like walking out and back in.
async function stopFullExam(ask = true) {
    const box = document.getElementById('study-full');
    if (fullState.running && ask) {
        const ok = await confirmDialog(t('Leave the exam?'), t('Your answers stay on this device - you can go back to the exam from the course\'s list. The clock keeps running.'), { confirmText: t('Leave the exam') });
        if (!ok) return false;
    }
    saveFullDraft();
    clearInterval(fullState.timer);
    fullState.running = false;
    fullState.token += 1;   // a build or grading still running belongs to the old screen
    if (fullState.cancelReading) fullState.cancelReading();
    if (box) box.hidden = true;
    return true;
}

async function openFullExam(course) {
    if (!(await stopExam())) return false;
    pruneFullPhotos();
    ['study-home', 'study-session', 'study-summary', 'study-review', 'study-manage', 'study-exam'].forEach(id => {
        const el = document.getElementById(id); if (el) el.hidden = true;
    });
    clearManageSelection();
    document.getElementById('study-full').hidden = false;
    const select = document.getElementById('full-course');
    const courses = await knownCourses();
    if (course && !courses.includes(course)) courses.unshift(course);
    select.textContent = '';
    for (const c of courses) {
        const o = document.createElement('option');
        o.value = c; o.textContent = c;
        select.appendChild(o);
    }
    fullState.course = course || courses[0] || '';
    select.value = fullState.course;
    showFullPart('full-setup');
    await loadFullSetup();
    return true;
}

async function loadFullSetup() {
    const course = fullState.course;
    const list = document.getElementById('full-past-list');
    list.textContent = '';
    document.getElementById('full-build-btn').disabled = !course;
    if (!course) {
        const p = document.createElement('div');
        p.className = 'full-past__empty';
        p.textContent = t('No courses yet. Upload your course files under Materials first.');
        list.appendChild(p);
        return;
    }
    const files = await ipcRenderer.invoke('get-files').catch(() => []);
    const mine = (Array.isArray(files) ? files : []).filter(f => (f.folder || '') === course);
    if (!mine.length) {
        const p = document.createElement('div');
        p.className = 'full-past__empty';
        p.textContent = t('No files in this course yet.');
        list.appendChild(p);
    }
    for (const f of mine) {
        const row = document.createElement('label');
        row.className = 'full-past__item';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = f.id || f._id;
        box.checked = PAST_EXAM_FILE.test(f.name || '');
        const name = document.createElement('span');
        name.className = 'file-name';
        name.dir = 'auto';
        name.textContent = f.name;
        row.append(box, name);
        list.appendChild(row);
    }
    // Exams already written for this course.
    const existing = await ipcRenderer.invoke('full-exam-list', course).catch(() => []);
    const wrap = document.getElementById('full-existing');
    const rows = document.getElementById('full-existing-list');
    rows.textContent = '';
    wrap.hidden = !(Array.isArray(existing) && existing.length);
    for (const e of (Array.isArray(existing) ? existing : [])) {
        const row = document.createElement('div');
        row.className = 'full-existing__row';
        const name = document.createElement('span');
        name.className = 'full-existing__name file-name';
        name.dir = 'auto';
        name.textContent = e.title || course;
        const meta = document.createElement('span');
        meta.className = 'full-existing__meta';
        const date = new Date(e.createdAt);
        meta.textContent = `${date.getDate()}/${date.getMonth() + 1}${e.lastRun ? ` · ${t('Last grade:')} ${e.lastRun.percent}` : ''}`;
        const take = document.createElement('button');
        take.className = 'btn-secondary btn-sm';
        take.textContent = openFullDraft(e.id) ? t('Continue') : t('Take it');
        take.onclick = () => openFullIntro(e.id);
        row.append(name, meta, take);
        if (e.lastRun) {
            const res = document.createElement('button');
            res.className = 'btn-secondary btn-sm';
            res.textContent = t('Last result');
            res.onclick = () => showLastFullResult(e.id);
            row.append(res);
        }
        const del = document.createElement('button');
        del.className = 'btn-icon';
        del.setAttribute('aria-label', t('Delete this exam'));
        del.innerHTML = icon('trash', { size: 15 });
        del.onclick = async () => {
            const ok = await confirmDialog(t('Delete this exam?'), t('The exam and your results in it are deleted.'), { confirmText: t('Delete'), danger: true });
            if (!ok) return;
            const r = await ipcRenderer.invoke('full-exam-delete', e.id).catch(err => ({ error: err.message }));
            if (r && r.error) { toast.error(r.error); return; }
            clearFullDraft(e.id);
            loadFullSetup();
        };
        row.append(del);
        rows.appendChild(row);
    }
}

document.getElementById('full-course').addEventListener('change', (e) => { fullState.course = e.target.value; loadFullSetup(); });
document.getElementById('full-cancel-btn').onclick = leaveFullExam;
document.getElementById('full-done-btn').onclick = leaveFullExam;
document.getElementById('full-exam-link').onclick = () => openFullExam('');
document.getElementById('full-upload-btn').onclick = () => {
    const course = fullState.course;
    stopFullExam(false);
    document.getElementById('nav-materials').click();
    if (course) toast.info(t('Upload the past exams into the folder "{c}" - then come back to Full exam.').replace('{c}', course));
};

function leaveFullExam() {
    stopFullExam(false);
    document.getElementById('study-home').hidden = false;
    loadStudyHome();
}

// Polls a build or grading job until it ends (or the screen moved on). A
// poll that fails (the network) is tried again - the job keeps running.
async function waitForFullJob(jobId, onStage) {
    const token = fullState.token;
    let misses = 0;
    for (;;) {
        await new Promise(r => setTimeout(r, 2500));
        const s = await ipcRenderer.invoke('full-exam-job', jobId).catch(err => ({ error: err.message }));
        if (!s || !s.status) {
            if (++misses >= 8) return { error: (s && s.error) || t('Lost touch with the server. Try again.'), token };
            continue;
        }
        misses = 0;
        if (s.status === 'gone') return { error: s.error, token };
        if (s.status === 'done') return { result: s.result, token };
        if (s.status === 'error') return { error: s.error, token };
        if (onStage && fullState.token === token) onStage(s.stage || '');
    }
}

document.getElementById('full-build-btn').onclick = async () => {
    const course = fullState.course;
    if (!course) return;
    const pastIds = [...document.querySelectorAll('#full-past-list input[type="checkbox"]:checked')].map(b => b.value);
    const btn = document.getElementById('full-build-btn');
    btn.disabled = true;
    const start = await ipcRenderer.invoke('full-exam-build', { course, pastIds }).catch(err => ({ error: err.message }));
    btn.disabled = false;
    if (!start || start.error || !start.jobId) { toast.error((start && start.error) || t('Couldn\'t start writing the exam. Try again.')); return; }
    const token = ++fullState.token;
    const text = document.getElementById('full-building-text');
    text.textContent = t(pastIds.length ? FULL_STAGE_TEXT.blueprint : FULL_STAGE_TEXT.reading);
    showFullPart('full-building');
    const out = await waitForFullJob(start.jobId, (stage) => {
        const key = String(stage).split(' ')[0];
        if (FULL_STAGE_TEXT[key]) text.textContent = t(FULL_STAGE_TEXT[key]);
    });
    const onScreen = fullState.token === token && !document.getElementById('study-full').hidden;
    if (out.error) {
        if (onScreen) { showFullPart('full-setup'); toast.error(out.error, t('The exam wasn\'t written')); }
        return;
    }
    if (onScreen) openFullIntro(out.result.examId);
    else showActionToast(t('Your full exam for {c} is ready.').replace('{c}', course), t('Open it'), () => {
        openFullExam(course).then(ok => { if (ok) openFullIntro(out.result.examId); });
    }, { duration: 60000 });
};

function fmtMinutes(min) {
    const h = Math.floor(min / 60), m = min % 60;
    if (!h) return t('{n} minutes').replace('{n}', m);
    if (!m) return h === 1 ? t('1 hour') : t('{n} hours').replace('{n}', h);
    return t('{h}:{m} hours').replace('{h}', h).replace('{m}', String(m).padStart(2, '0'));
}

async function openFullIntro(examId) {
    if (fullState.running || fullState.grading) return;   // one sitting at a time
    const exam = await ipcRenderer.invoke('full-exam-get', examId).catch(err => ({ error: err.message }));
    if (!exam || exam.error) { toast.error((exam && exam.error) || t('Couldn\'t open the exam.')); return; }
    exam.id = exam.id || exam._id;
    fullState.exam = exam;
    fullState.course = exam.course;
    document.getElementById('study-full').hidden = false;
    document.getElementById('full-intro-title').textContent = exam.title || t('Full exam');
    document.getElementById('full-intro-title').setAttribute('translate', 'no');
    const courseEl = document.getElementById('full-intro-course');
    courseEl.textContent = exam.course;
    courseEl.setAttribute('translate', 'no');
    const facts = document.getElementById('full-intro-facts');
    facts.textContent = '';
    const partsCount = exam.questions.reduce((n, q) => n + q.parts.length, 0);
    const fact = (txt) => { const li = document.createElement('li'); li.textContent = txt; facts.appendChild(li); };
    fact(t('{q} questions, {p} parts · {pts} points').replace('{q}', exam.questions.length).replace('{p}', partsCount).replace('{pts}', Math.round(exam.totalPoints)));
    if (exam.bonusPoints > 0) fact(t('Plus a bonus question of {b} points - harder than the rest, as in the past exams.').replace('{b}', Math.round(exam.bonusPoints * 100) / 100));
    if (exam.maxGrade > 0) fact(t('The questions add up to {t} points and the grade is at most {m}, as in the past exams.').replace('{t}', Math.round(exam.totalPoints * 100) / 100).replace('{m}', exam.maxGrade));
    else if (exam.bonusPoints > 0) fact(t('The grade is at most 100.'));
    if (exam.dontKnowShare > 0) fact(t('Writing "I don\'t know" on a part gets {p}% of its points, as in the past exams.').replace('{p}', Math.round(exam.dontKnowShare * 100)));
    fact(exam.basis === 'past_exams'
        ? t('Built on the structure of {n} past exams of the course.').replace('{n}', (exam.pastExamFiles || []).length)
        : t('Built from the course material - no past exams were given, so the structure is a general one.'));
    if (exam.materials) fact(`${t('Allowed material:')} ${exam.materials}`);
    const checked = exam.questions.reduce((n, q) => n + q.parts.filter(p => p.check === 'checked' || p.check === 'corrected').length, 0);
    const doubtful = exam.questions.reduce((n, q) => n + q.parts.filter(p => p.check === 'doubtful').length, 0);
    if (checked) fact(t('{n} of {m} solutions were checked by a second, independent solution.').replace('{n}', checked).replace('{m}', partsCount));
    if (doubtful) fact(t(doubtful === 1 ? 'The second check thinks 1 part is wrong or unclear - it says so in the solutions.' : 'The second check thinks {n} parts are wrong or unclear - it says so in the solutions.').replace('{n}', doubtful));
    // Solutions the second check never reached - said before the exam, with a way to check them.
    const unchecked = partsCount - checked - doubtful;
    document.getElementById('full-unchecked').hidden = !unchecked;
    document.getElementById('full-unchecked-text').textContent = t(unchecked === 1 ? '1 solution wasn\'t checked a second time - it may have a mistake.' : '{n} of {m} solutions weren\'t checked a second time - they may have mistakes.').replace('{n}', unchecked).replace('{m}', partsCount);
    const recheck = document.getElementById('full-recheck-btn');
    // A check of this exam may still be running (Back, then opened again).
    recheck.disabled = fullChecksRunning.has(String(exam.id));
    recheck.textContent = recheck.disabled ? t('Checking…') : t('Check them now');
    const instr = document.getElementById('full-intro-instructions');
    instr.textContent = exam.instructions || '';
    instr.setAttribute('translate', 'no');
    instr.hidden = !exam.instructions;
    const rec = document.getElementById('full-recurring');
    const recList = document.getElementById('full-recurring-list');
    recList.textContent = '';
    rec.hidden = !(exam.recurring && exam.recurring.length);
    for (const r of exam.recurring || []) {
        const li = document.createElement('li');
        const topic = document.createElement('span');
        topic.setAttribute('translate', 'no');
        topic.dir = 'auto';
        topic.textContent = r.topic;
        const count = document.createElement('span');
        count.className = 'full-recurring__count';
        count.textContent = ` · ${t('in {n} of {m} exams').replace('{n}', r.count).replace('{m}', r.of)}`;
        li.append(topic, count);
        recList.appendChild(li);
    }
    // The clock: the real exam's time first.
    const group = document.getElementById('full-time');
    group.textContent = '';
    const lengths = [...new Set([exam.durationMin, 60, 90, 120, 150, 180])].filter(m => m >= 5).sort((a, b) => a - b);
    const chips = lengths.map(m => ({ pick: String(m), minutes: m, label: m === exam.durationMin ? `${fmtMinutes(m)} (${t('as in the exam')})` : fmtMinutes(m) }));
    chips.push({ pick: 'own', label: t('Set my own') }, { pick: 'none', label: t('No limit') });
    for (const c of chips) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `filter-chip${c.minutes === exam.durationMin ? ' active' : ''}`;
        b.dataset.pick = c.pick;
        if (c.minutes) b.dataset.minutes = String(c.minutes);
        b.textContent = c.label;
        b.onclick = () => {
            group.querySelectorAll('.filter-chip').forEach(x => x.classList.toggle('active', x === b));
            document.getElementById('full-minutes-wrap').hidden = c.pick !== 'own';
        };
        group.appendChild(b);
    }
    document.getElementById('full-minutes-wrap').hidden = true;
    document.getElementById('full-minutes-input').value = String(exam.durationMin);
    const draft = openFullDraft(exam.id);
    document.getElementById('full-start-btn').textContent = draft ? t('Continue the exam') : t('Start the exam');
    showFullPart('full-intro');
}

document.getElementById('full-intro-back-btn').onclick = () => { showFullPart('full-setup'); loadFullSetup(); };

// Checks still running, by exam id / sitting id - so reopening a screen
// doesn't start a second one for the same parts.
const fullChecksRunning = new Set();

// "Check them now": the second check, on the saved exam (nothing is deleted).
document.getElementById('full-recheck-btn').onclick = async () => {
    const exam = fullState.exam;
    const btn = document.getElementById('full-recheck-btn');
    if (!exam || btn.disabled || fullChecksRunning.has(String(exam.id))) return;
    const examId = String(exam.id);
    fullChecksRunning.add(examId);
    btn.disabled = true;
    btn.textContent = t('Checking…');
    const start = await ipcRenderer.invoke('full-exam-recheck', examId).catch(err => ({ error: err.message }));
    const out = start && start.jobId ? await waitForFullJob(start.jobId, () => {}) : { error: (start && start.error) || t('Please try again.') };
    fullChecksRunning.delete(examId);
    // Still on this exam's intro (opened again is fine; not started, not another exam)?
    const here = !!fullState.exam && String(fullState.exam.id) === examId && !fullState.running && !fullState.grading && !document.getElementById('full-intro').hidden;
    if (out.error) {
        toast.error(out.error, t('The solutions weren\'t checked'));
        if (here) { btn.disabled = false; btn.textContent = t('Check them now'); }
        return;
    }
    const r = out.result || {};
    toast.success(r.left ? t('{n} more solutions checked; {m} still couldn\'t be.').replace('{n}', r.changed).replace('{m}', r.left) : t('Every solution is checked now.'));
    if (here) openFullIntro(examId);
};

document.getElementById('full-start-btn').onclick = () => {
    const exam = fullState.exam;
    if (!exam || fullState.running || fullState.grading) return;
    const draft = openFullDraft(exam.id);
    let limitSec;
    if (draft) {
        limitSec = draft.limitSec || 0;
    } else {
        const chosen = document.querySelector('#full-time .filter-chip.active');
        if (!chosen || chosen.dataset.pick === 'none') limitSec = 0;
        else if (chosen.dataset.pick === 'own') {
            const m = Math.round(Number(document.getElementById('full-minutes-input').value));
            if (!Number.isFinite(m) || m < 5 || m > 600) { toast.info(t('Set the time as a number of minutes, from 5 to 600.')); return; }
            limitSec = m * 60;
        } else limitSec = Number(chosen.dataset.minutes) * 60;
    }
    fullState.answers = draft && draft.answers ? draft.answers : {};
    fullState.flags = new Set(draft && draft.flags ? draft.flags : []);
    fullState.startedAt = draft && draft.startedAt ? draft.startedAt : Date.now();
    fullState.limitSec = limitSec;
    fullState.clientRunId = draft && draft.clientRunId ? draft.clientRunId : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    fullState.qIndex = 0;
    fullState.running = true;
    fullState.autoSubmitFailed = false;
    fullState.token += 1;
    const title = document.getElementById('full-run-title');
    title.textContent = exam.title || exam.course;
    title.setAttribute('translate', 'no');
    saveFullDraft();
    clearInterval(fullState.timer);
    fullState.timer = setInterval(tickFullExam, 1000);
    tickFullExam();
    showFullPart('full-run');
    renderFullNav();
    fullPhotos.clear();
    renderFullQuestion();
    // A continued sitting: its photos come back from this device.
    if (draft) {
        const runId = fullState.clientRunId;
        loadFullPhotos(runId).then((mine) => { if (mine) { renderFullNav(); renderFullQuestion(); } });
    }
};

function tickFullExam() {
    if (!fullState.running) return;
    const el = document.getElementById('full-timer');
    const used = Math.floor((Date.now() - fullState.startedAt) / 1000);
    const fmt = (sec) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`; };
    if (!fullState.limitSec) { el.textContent = fmt(used); el.classList.remove('is-low'); return; }
    const left = Math.max(0, fullState.limitSec - used);
    el.textContent = `${t('Time left')} ${fmt(left)}`;
    el.classList.toggle('is-low', left <= 300);
    // Time's up: hand it in - once; if grading then failed, the student
    // presses Submit again (it doesn't loop on its own).
    if (left === 0 && !fullState.autoSubmitFailed) submitFullExam(true);
}

const fullKey = (qi, pi) => `${qi}:${pi}`;
// (a photo of the working answers a written part - not a choice: there the choice is the answer)
const fullAnswered = (a, p) => !!a && (a.dontKnow === true || (a.photos > 0 && !(p && fullAutoMarked(p))) || !!String(a.choice || '').trim() || !!String(a.text || '').trim());
// Parts marked by the choice alone - "I don't know" doesn't apply to them.
const fullAutoMarked = (p) => (p.type === 'mc' || p.type === 'tf') && !p.reasonRequired;
// "What was checked | points": one row per criterion, with what was missing.
function fullMarksTable(part, marks) {
    const table = document.createElement('table');
    table.className = 'full-marks';
    const cap = document.createElement('caption');
    cap.textContent = t('Points by criterion');
    const head = document.createElement('thead');
    head.innerHTML = `<tr><th>${escapeHtml(t('What was checked'))}</th><th>${escapeHtml(t('Points'))}</th></tr>`;
    const body = document.createElement('tbody');
    const fmt = (n) => Math.round(n * 100) / 100;
    for (const m of marks) {
        const now = (part.rubric || [])[m.c] || {};
        const max = Number(m.criterion ? m.max : now.points) || 0;
        const criterion = m.criterion || now.criterion || '';
        const tr = document.createElement('tr');
        const crit = document.createElement('td');
        crit.className = 'full-marks__crit';
        crit.setAttribute('translate', 'no');
        crit.dir = 'auto';
        setMathText(crit, criterion === 'A complete and correct answer' ? t(criterion) : criterion);
        if (m.note) {
            const note = document.createElement('div');
            note.className = 'full-marks__note';
            note.dir = 'auto';
            setMathText(note, m.note);
            crit.appendChild(note);
        }
        const pts = document.createElement('td');
        pts.className = 'full-marks__pts' + (m.points >= max ? ' is-full' : m.points === 0 ? ' is-zero' : ' is-part');
        pts.textContent = outOfLabel(fmt(m.points), fmt(max));
        tr.append(crit, pts);
        body.appendChild(tr);
    }
    table.append(cap, head, body);
    return table;
}

function fullBonusBadge() {
    const b = document.createElement('span');
    b.className = 'full-bonus';
    b.textContent = t('Bonus');
    return b;
}

function renderFullNav() {
    const nav = document.getElementById('full-nav');
    nav.textContent = '';
    fullState.exam.questions.forEach((q, qi) => {
        const answered = q.parts.filter((p, pi) => fullAnswered(fullState.answers[fullKey(qi, pi)], p)).length;
        const need = q.choosePartsCount > 0 ? q.choosePartsCount : q.parts.length;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'full-nav__q';
        b.classList.toggle('is-current', qi === fullState.qIndex);
        b.classList.toggle('is-done', answered >= need);
        b.classList.toggle('is-flagged', fullState.flags.has(qi));
        const name = document.createElement('span');
        name.textContent = `${t('Question')} ${qi + 1}`;
        const state = document.createElement('span');
        state.className = 'full-nav__state';
        state.textContent = fullState.flags.has(qi) ? t('Come back') : `${Math.min(answered, need)}/${need}`;
        b.append(name, state);
        b.onclick = () => { fullState.qIndex = qi; renderFullNav(); renderFullQuestion(); };
        nav.appendChild(b);
    });
}

function setFullAnswer(qi, pi, patch) {
    const k = fullKey(qi, pi);
    fullState.answers[k] = { ...(fullState.answers[k] || { choice: '', text: '' }), ...patch };
    saveFullDraft();
    renderFullNav();
}

// "Photograph your solution": up to 3 pages, shown as thumbnails.
function fullPhotoBlock(qi, pi, p) {
    const feedbackOnly = fullAutoMarked(p);
    const key = fullKey(qi, pi);
    const wrap = document.createElement('div');
    wrap.className = 'full-photos';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.hidden = true;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary btn-sm full-photos__btn';
    const list = document.createElement('div');
    list.className = 'full-photos__list';
    const hint = document.createElement('p');
    hint.className = 'full-photos__hint';
    const draw = () => {
        const photos = fullPhotos.get(key) || [];
        list.textContent = '';
        photos.forEach((ph, i) => {
            const item = document.createElement('div');
            item.className = 'full-photos__item';
            const img = document.createElement('img');
            img.src = `data:${ph.mimeType};base64,${ph.data}`;
            img.alt = t('Page {n}').replace('{n}', i + 1);
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'full-photos__del';
            del.textContent = '×';
            del.title = t('Remove this page');
            del.onclick = () => {
                photos.splice(i, 1);
                if (photos.length) fullPhotos.set(key, photos); else fullPhotos.delete(key);
                saveFullPhotos();
                pagesChanged(photos.length);
            };
            item.append(img, del);
            list.appendChild(item);
        });
        btn.textContent = photos.length ? t('Add a page') : t(feedbackOnly ? 'Photograph your working (optional)' : 'Photograph your solution');
        btn.hidden = photos.length >= FULL_PHOTOS_PER_PART;
        hint.textContent = feedbackOnly
            ? t('The points are for the choice only. If it is wrong, the AI looks at your working and shows where it went wrong.')
            : photos.length ? t('The AI copies your handwriting when you submit - you check the copy before grading.')
            : t('Solved it on paper? Photograph it (up to 3 pages) instead of typing.');
    };
    btn.onclick = () => input.click();
    input.onchange = async () => {
        const files = [...input.files];
        input.value = '';
        btn.disabled = true;
        for (const f of files) {
            const photos = fullPhotos.get(key) || [];
            if (photos.length >= FULL_PHOTOS_PER_PART) break;
            try {
                photos.push(await shrinkPhoto(f, {
                    maxBytes: FULL_PHOTO_MAX_BYTES, steps: [[1800, 0.85], [1500, 0.75], [1200, 0.65]],
                    tooLarge: t('This photo is too large. Take it again, closer to the page.'),
                    cantOpen: t('This picture can\'t be opened here. Take it again as a regular photo.')
                }));
                fullPhotos.set(key, photos);
            } catch (e) { toast.error(e.message); }
        }
        btn.disabled = false;
        saveFullPhotos();
        pagesChanged((fullPhotos.get(key) || []).length);
    };
    // New pages make an old copy wrong: back to what was typed, read again on submit.
    const pagesChanged = (count) => {
        const a = fullState.answers[key] || {};
        if (a.fromPhoto) {
            setFullAnswer(qi, pi, { photos: count, text: a.typed || '', fromPhoto: false, photoEdited: false, photosRead: 0 });
            toast.info(t('The pages changed - they are read again when you submit.'));
            renderFullQuestion();
            return;
        }
        setFullAnswer(qi, pi, { photos: count });
        draw();
    };
    wrap.append(btn, input, list, hint);
    draw();
    return wrap;
}

// A written answer (a solution, code, a proof - or the reason for a choice).
function fullAnswerBox(qi, pi, p, a) {
    const ta = document.createElement('textarea');
    ta.className = `input-field full-answer${p.type === 'code' ? ' full-answer--code' : ''}`;
    ta.dir = p.type === 'code' ? 'ltr' : 'auto';
    ta.spellcheck = p.type !== 'code';
    ta.placeholder = p.type === 'tf' ? t('Prove it, or give a counterexample')
        : p.type === 'mc' ? t('Why? Explain your choice')
        : p.type === 'code' ? t('Your code') : t('Your solution - the steps and the result');
    ta.value = a.text || '';
    ta.addEventListener('input', () => {
        const k = fullKey(qi, pi);
        fullState.answers[k] = { ...(fullState.answers[k] || { choice: '' }), text: ta.value };
        clearTimeout(ta._t);
        ta._t = setTimeout(() => { saveFullDraft(); renderFullNav(); }, 400);
    });
    if (p.type === 'code') {
        ta.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab') return;
            e.preventDefault();
            const s = ta.selectionStart;
            ta.value = `${ta.value.slice(0, s)}    ${ta.value.slice(ta.selectionEnd)}`;
            ta.selectionStart = ta.selectionEnd = s + 4;
            ta.dispatchEvent(new Event('input'));
        });
    }
    return ta;
}

function renderFullQuestion() {
    const exam = fullState.exam;
    const qi = fullState.qIndex;
    const q = exam.questions[qi];
    const paper = document.getElementById('full-paper');
    paper.textContent = '';
    const head = document.createElement('div');
    head.className = 'full-q__head';
    const h = document.createElement('h3');
    h.className = 'full-q__title';
    h.textContent = `${t('Question')} ${qi + 1}`;
    if (q.title) {
        const sub = document.createElement('span');
        sub.setAttribute('translate', 'no');
        sub.dir = 'auto';
        sub.textContent = ` · ${q.title}`;
        h.appendChild(sub);
    }
    const pts = document.createElement('span');
    pts.className = 'full-q__points';
    pts.textContent = t(q.bonus ? '{n} bonus points' : '{n} points').replace('{n}', Math.round(q.points * 100) / 100);
    if (q.bonus) h.prepend(fullBonusBadge());
    head.append(h, pts);
    paper.appendChild(head);
    if (q.choosePartsCount > 0) {
        const c = document.createElement('p');
        c.className = 'full-q__choose';
        c.textContent = t('Answer {n} of the {m} parts. If you answer more, the first {n} count.').replace(/\{n\}/g, q.choosePartsCount).replace('{m}', q.parts.length);
        paper.appendChild(c);
    }
    if (q.stem) {
        const stem = document.createElement('div');
        stem.className = 'full-q__stem';
        stem.setAttribute('translate', 'no');
        stem.dir = 'auto';
        setMathText(stem, q.stem);
        paper.appendChild(stem);
    }
    q.parts.forEach((p, pi) => {
        const a = fullState.answers[fullKey(qi, pi)] || { choice: '', text: '' };
        const box = document.createElement('div');
        box.className = 'full-part';
        const ph = document.createElement('div');
        ph.className = 'full-part__head';
        if (p.label) {
            const lab = document.createElement('span');
            lab.className = 'full-part__label';
            lab.setAttribute('translate', 'no');
            lab.textContent = `${p.label}.`;
            ph.appendChild(lab);
        }
        const ptxt = document.createElement('span');
        ptxt.className = 'full-part__pts';
        ptxt.textContent = t('{n} points').replace('{n}', Math.round(p.points * 100) / 100);
        ph.appendChild(ptxt);
        const txt = document.createElement('div');
        txt.className = 'full-part__text';
        txt.setAttribute('translate', 'no');
        txt.dir = 'auto';
        // (a code line keeps its $ - math.js tells code lines apart)
        setMathText(txt, p.text);
        box.append(ph, txt);
        const name = `full-${qi}-${pi}`;
        if (p.type === 'mc') {
            const opts = document.createElement('div');
            opts.className = 'full-part__options';
            p.options.forEach((o, oi) => {
                const lab = document.createElement('label');
                lab.className = 'full-option';
                const r = document.createElement('input');
                r.type = 'radio'; r.name = name; r.value = String(oi);
                r.checked = String(a.choice) === String(oi);
                r.onchange = () => setFullAnswer(qi, pi, { choice: String(oi) });
                const s = document.createElement('span');
                s.setAttribute('translate', 'no');
                s.dir = 'auto';
                setMathText(s, `${oi + 1}. ${o}`);
                lab.append(r, s);
                opts.appendChild(lab);
            });
            box.appendChild(opts);
            // "Circle and explain": the reason is part of the answer.
            if (p.reasonRequired) box.appendChild(fullAnswerBox(qi, pi, p, a));
            if (fullTakesPhoto(p)) box.appendChild(fullPhotoBlock(qi, pi, p));
        } else {
            if (p.type === 'tf') {
                const tf = document.createElement('div');
                tf.className = 'full-tf';
                for (const [val, label] of [['true', t('True')], ['false', t('False')]]) {
                    const lab = document.createElement('label');
                    lab.className = 'full-option';
                    const r = document.createElement('input');
                    r.type = 'radio'; r.name = name; r.value = val;
                    r.checked = a.choice === val;
                    r.onchange = () => setFullAnswer(qi, pi, { choice: val });
                    const s = document.createElement('span');
                    s.textContent = label;
                    lab.append(r, s);
                    tf.appendChild(lab);
                }
                box.appendChild(tf);
            }
            if (p.type !== 'tf' || p.reasonRequired) box.appendChild(fullAnswerBox(qi, pi, p, a));
            if (fullTakesPhoto(p)) box.appendChild(fullPhotoBlock(qi, pi, p));
        }
        // "I don't know" - only where the past exams give points for it.
        if (exam.dontKnowShare > 0 && !fullAutoMarked(p) && !q.bonus) {
            const dk = document.createElement('label');
            dk.className = 'full-dontknow';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = a.dontKnow === true;
            const s = document.createElement('span');
            s.textContent = t('I don\'t know ({p}% of the points)').replace('{p}', Math.round(exam.dontKnowShare * 100));
            dk.append(cb, s);
            const lock = () => box.querySelectorAll('textarea, input[type=radio], .full-photos button').forEach(el => { el.disabled = cb.checked; });
            cb.onchange = () => { setFullAnswer(qi, pi, { dontKnow: cb.checked }); lock(); };
            box.appendChild(dk);
            lock();
        }
        paper.appendChild(box);
    });
    const nav = document.createElement('div');
    nav.className = 'full-q__nav';
    const prev = document.createElement('button');
    prev.className = 'btn-secondary';
    prev.textContent = t('Previous question');
    prev.disabled = qi === 0;
    prev.onclick = () => { fullState.qIndex -= 1; renderFullNav(); renderFullQuestion(); };
    const flag = document.createElement('button');
    flag.className = 'btn-secondary';
    flag.textContent = fullState.flags.has(qi) ? t('Unmark') : t('Mark to come back');
    flag.onclick = () => { if (fullState.flags.has(qi)) fullState.flags.delete(qi); else fullState.flags.add(qi); saveFullDraft(); renderFullNav(); renderFullQuestion(); };
    const next = document.createElement('button');
    next.className = 'btn-primary';
    const last = qi === exam.questions.length - 1;
    next.textContent = last ? t('Submit the exam') : t('Next question');
    next.onclick = () => {
        if (last) { submitFullExam(false); return; }
        fullState.qIndex += 1; renderFullNav(); renderFullQuestion();
    };
    nav.append(prev, flag, next);
    paper.appendChild(nav);
}

document.getElementById('full-submit-btn').onclick = () => submitFullExam(false);

// The photographed parts, read one by one, then a screen to check the copy.
// Resolves true to go on to grading; false when the student left meanwhile
// (the sitting stays on this device and can be continued).
async function readFullPhotoAnswers(exam, token) {
    const todo = [];
    exam.questions.forEach((q, qi) => q.parts.forEach((p, pi) => {
        const photos = fullPhotos.get(fullKey(qi, pi)) || [];
        const a = fullState.answers[fullKey(qi, pi)] || {};
        // (already read and checked - a grading that failed is submitted again - unless pages changed)
        if (photos.length && fullTakesPhoto(p, exam) && !fullAutoMarked(p) && a.dontKnow !== true && !(a.fromPhoto && a.photosRead === photos.length)) todo.push({ q, qi, p, pi, photos });
    }));
    if (!todo.length) return true;
    let cancelled = false;
    const stop = () => { cancelled = true; fullState.grading = false; };
    const stillHere = () => !cancelled && fullState.token === token;
    // Leaving now (stopFullExam) frees the exam at once - a read still on its way is ignored.
    fullState.cancelReading = () => { fullState.cancelReading = null; stop(); };
    showFullPart('full-reading');
    const read = async (item) => {
        const r = await ipcRenderer.invoke('full-exam-read-photos', { text: item.p.text, stem: item.q.stem || '', images: item.photos })
            .catch(err => ({ error: err.message }));
        item.result = r || { error: t('Please try again.') };
    };
    for (let i = 0; i < todo.length; i++) {
        if (!stillHere()) { if (!cancelled) stop(); return false; }
        document.getElementById('full-reading-text').textContent = t('Reading your handwriting… {d} of {n}').replace('{d}', i + 1).replace('{n}', todo.length);
        await read(todo[i]);
    }
    if (!stillHere()) { if (!cancelled) stop(); return false; }
    return new Promise((resolve) => {
        fullState.cancelReading = () => { fullState.cancelReading = null; stop(); resolve(false); };
        const list = document.getElementById('full-transcripts-list');
        list.textContent = '';
        for (const item of todo) {
            const a = fullState.answers[fullKey(item.qi, item.pi)] || {};
            const card = document.createElement('div');
            card.className = 'full-transcript';
            const h = document.createElement('div');
            h.className = 'full-transcript__head';
            h.textContent = `${t('Question')} ${item.qi + 1}${item.p.label ? ` · ${item.p.label}` : ''}`;
            const pics = document.createElement('div');
            pics.className = 'full-photos__list';
            item.photos.forEach((ph, i) => {
                const img = document.createElement('img');
                img.src = `data:${ph.mimeType};base64,${ph.data}`;
                img.alt = t('Page {n}').replace('{n}', i + 1);
                img.className = 'full-transcript__img';
                img.onclick = () => img.classList.toggle('is-large');
                pics.appendChild(img);
            });
            const ta = document.createElement('textarea');
            ta.className = 'input-field full-answer';
            // Hebrew with maths: a line starting with "f(x)" shouldn't turn the whole copy left-to-right.
            ta.dir = exam.language === 'he' || /[\u0590-\u05ff]/.test(item.p.text || '') ? 'rtl' : 'auto';
            const note = document.createElement('p');
            note.className = 'full-transcript__note';
            const fill = () => {
                const r = item.result;
                // What was typed stays; the copy of the page comes after it.
                item.typed = String(a.typed !== undefined ? a.typed : a.text || '').trim();
                item.start = [item.typed, r.error ? '' : r.text].filter(Boolean).join('\n\n');
                ta.value = item.start;
                note.textContent = r.error ? `${t('Couldn\'t read the photo:')} ${t(r.error)}`
                    : !r.text ? (r.problem || t('No answer was found in the photo.'))
                    // each one isolated, so "0·f'(x0)" keeps its own direction
                    : r.unsure && r.unsure.length ? `${t('Not sure of:')} ${r.unsure.map(u => `\u2068${u}\u2069`).join(', ')}` : '';
                note.classList.toggle('is-error', !!r.error || !r.text);
                again.hidden = !r.error && !!r.text;
            };
            const again = document.createElement('button');
            again.type = 'button';
            again.className = 'btn-secondary btn-sm';
            again.textContent = t('Read it again');
            again.onclick = async () => {
                again.disabled = true;
                again.textContent = t('Reading…');
                await read(item);
                again.disabled = false;
                again.textContent = t('Read it again');
                if (stillHere()) fill();
            };
            item.box = ta;
            card.append(h, pics, ta, note, again);
            list.appendChild(card);
            fill();
        }
        showFullPart('full-transcripts');
        document.getElementById('full-transcripts-done').onclick = () => {
            if (!stillHere()) return;
            fullState.cancelReading = null;
            for (const item of todo) {
                const k = fullKey(item.qi, item.pi);
                const text = item.box.value.trim();
                // "from a photo" only when something was copied from it
                const copied = !item.result.error && !!item.result.text;
                fullState.answers[k] = { ...(fullState.answers[k] || { choice: '' }), text, typed: item.typed, photosRead: copied ? item.photos.length : 0, fromPhoto: copied, photoEdited: copied && text !== item.start.trim() };
            }
            showFullPart('full-grading');
            resolve(true);
        };
    });
}

// "Where did I go wrong?" for each wrong choice with a photo of the working:
// shown under the part (if the result is on screen) and saved with the result.
async function fullPhotoFeedback(exam, run, jobs) {
    const runId = String(run.id || run._id);
    const box = (job) => document.querySelector(`#full-result-questions .full-rpart[data-key="${job.qi}:${job.pi}"]`);
    const show = (job, text, state) => {
        if (fullState.resultRunId !== runId) return;
        const part = box(job);
        if (!part) return;
        let el = part.querySelector('.full-photo-fb');
        if (!el) {
            el = document.createElement('div');
            el.className = 'full-photo-fb';
            el.setAttribute('translate', 'no');
            el.dir = 'auto';
            part.insertBefore(el, part.querySelector('details'));
        }
        el.textContent = text;
        el.classList.toggle('is-loading', state === 'loading');
        el.classList.toggle('is-error', state === 'error');
    };
    for (const job of jobs) {
        show(job, t('Looking at your working…'), 'loading');
        const r = await ipcRenderer.invoke('full-exam-photo-feedback', {
            part: { type: job.p.type, text: job.p.text, options: job.p.options, correct: job.p.correct, answer: job.p.answer },
            stem: job.q.stem || '', choice: job.choice, images: job.photos
        }).catch(err => ({ error: err.message }));
        if (r && r.feedback) {
            show(job, `${t('Where it went wrong:')} ${r.feedback}`);
            const row = (run.answers || []).find(x => x.q === job.qi && x.p === job.pi);
            if (row) row.photoFeedback = r.feedback;
            // Saved with the result (once more if the first try fails); if it still
            // can't be, say so - it is shown now but won't be there next time.
            const save = () => ipcRenderer.invoke('full-exam-save-photo-feedback', { examId: exam.id, runId, q: job.qi, p: job.pi, feedback: r.feedback }).catch(err => ({ error: err.message }));
            let saved = await save();
            if (!saved || saved.error) saved = await save();
            if (!saved || saved.error) show(job, `${t('Where it went wrong:')} ${r.feedback}\n(${t('Not saved - it is shown only now.')})`);
        } else {
            show(job, `${t('Couldn\'t look at your working:')} ${t((r && r.error) || 'Please try again.')}`, 'error');
        }
        job.photos = null;   // done with them
    }
}

async function submitFullExam(timeUp) {
    const exam = fullState.exam;
    if (!exam || !fullState.running || fullState.grading) return;
    if (!timeUp) {
        const empty = exam.questions.reduce((n, q, qi) => {
            const need = q.choosePartsCount > 0 ? q.choosePartsCount : q.parts.length;
            const done = q.parts.filter((p, pi) => fullAnswered(fullState.answers[fullKey(qi, pi)], p)).length;
            return n + Math.max(0, need - done);
        }, 0);
        const ok = await confirmDialog(t('Submit the exam?'),
            empty ? t('{n} parts have no answer yet - they get 0.').replace('{n}', empty) : t('Your answers are graded now, part by part.'),
            { confirmText: t('Submit') });
        // The clock may have handed it in while the dialog was open.
        if (!ok || fullState.exam !== exam || !fullState.running || fullState.grading) return;
    } else {
        toast.info(t('Time is up - grading what you wrote.'));
    }
    saveFullDraft();   // the latest answers on disk before it is marked as sent
    clearInterval(fullState.timer);
    fullState.running = false;
    fullState.grading = true;
    const token = ++fullState.token;
    const usedSec = Math.round((Date.now() - fullState.startedAt) / 1000);   // reading the photos isn't exam time
    // Photographed answers: copied by the AI, checked by the student.
    if (!(await readFullPhotoAnswers(exam, token))) return;
    const answers = Object.entries(fullState.answers).map(([k, a]) => {
        const [q, p] = k.split(':').map(Number);
        return { q, p, choice: a.choice || '', text: a.text || '', dontKnow: a.dontKnow === true, fromPhoto: a.fromPhoto === true, photoEdited: a.photoEdited === true };
    });
    const clientRunId = fullState.clientRunId;
    markFullDraft(exam.id, clientRunId, true);
    document.getElementById('full-grading-text').textContent = t('Grading your answers…');
    showFullPart('full-grading');
    const start = await ipcRenderer.invoke('full-exam-grade', {
        examId: exam.id, answers, startedAt: new Date(fullState.startedAt).toISOString(), usedSec,
        limitSec: fullState.limitSec, clientRunId
    }).catch(err => ({ error: err.message }));
    if (!start || start.error || !start.jobId) {
        markFullDraft(exam.id, clientRunId, false);
        fullState.grading = false;
        fullState.running = true;   // back to the paper; the answers are still here
        if (timeUp) fullState.autoSubmitFailed = true;
        fullState.timer = setInterval(tickFullExam, 1000);
        showFullPart('full-run');
        renderFullQuestion();   // a photographed answer now holds its copy
        toast.error((start && start.error) || t('Couldn\'t start grading. Try again.'));
        return;
    }
    const out = await waitForFullJob(start.jobId, (stage) => {
        const m = /grading (\d+)\/(\d+)/.exec(stage);
        if (m) document.getElementById('full-grading-text').textContent = t('Grading your answers… {d} of {n} questions').replace('{d}', m[1]).replace('{n}', m[2]);
    });
    fullState.grading = false;
    if (out.error) {
        markFullDraft(exam.id, clientRunId, false);   // it can be continued and submitted again
        if (fullState.token === token) {
            fullState.running = true;
            if (timeUp) fullState.autoSubmitFailed = true;
            fullState.timer = setInterval(tickFullExam, 1000);
            showFullPart('full-run');
            renderFullQuestion();
            toast.error(out.error, t('The exam wasn\'t graded'));
        }
        return;
    }
    clearFullDraft(exam.id, clientRunId);
    // A wrong choice with a photo of its working: feedback after the result
    // (these photos stay in memory until then; none are kept on the device).
    const run = out.result.run;
    const feedback = [];
    exam.questions.forEach((q, qi) => q.parts.forEach((p, pi) => {
        const photos = fullPhotos.get(fullKey(qi, pi));
        const row = (run.answers || []).find(r => r.q === qi && r.p === pi);
        if (photos && photos.length && fullAutoMarked(p) && row && row.status === 'graded' && row.points < row.max && String(row.choice || '')) {
            feedback.push({ q, qi, p, pi, photos, choice: row.choice });
        }
    }));
    fullPhotosStore('delete', clientRunId);   // the photos aren't kept after grading
    if (fullState.clientRunId === clientRunId) fullPhotos.clear();
    if (fullState.token === token && !document.getElementById('study-full').hidden) renderFullResult(exam, run);
    if (feedback.length) fullPhotoFeedback(exam, run, feedback);
}

async function showLastFullResult(examId) {
    const [exam, runs] = await Promise.all([
        ipcRenderer.invoke('full-exam-get', examId).catch(() => null),
        ipcRenderer.invoke('full-exam-runs', examId).catch(() => null)
    ]);
    if (!exam || exam.error || !Array.isArray(runs) || !runs.length) { toast.error(t('Couldn\'t open the result.')); return; }
    exam.id = exam.id || exam._id;
    fullState.exam = exam;
    renderFullResult(exam, runs[0]);
}

function renderFullResult(exam, run) {
    fullState.resultRunId = String(run.id || run._id || '');
    document.getElementById('full-score').textContent = String(run.percent);
    const usedMin = Math.round((run.usedSec || 0) / 60);
    const unchecked = (run.answers || []).filter(a => a.status === 'unchecked').length;
    // Older sittings have no outOf: the grade was out of the points graded.
    const outOf = run.outOf > 0 ? run.outOf : run.max;
    // With parts left out, the number is only for what was checked - said so.
    document.getElementById('full-result-label').textContent = unchecked ? t('Partial grade - only what was checked') : t('Your grade');
    // "Check them again": the parts the AI couldn't grade, graded now.
    const regrade = document.getElementById('full-regrade-btn');
    const runId = String(run.id || run._id);
    regrade.hidden = !unchecked;
    regrade.disabled = fullChecksRunning.has(runId);
    regrade.textContent = regrade.disabled ? t('Checking…') : t('Check them again');
    regrade.onclick = async () => {
        if (regrade.disabled || fullChecksRunning.has(runId)) return;
        fullChecksRunning.add(runId);
        regrade.disabled = true;
        regrade.textContent = t('Checking…');
        const start = await ipcRenderer.invoke('full-exam-regrade', { examId: exam.id, runId }).catch(err => ({ error: err.message }));
        const out = start && start.jobId ? await waitForFullJob(start.jobId, () => {}) : { error: (start && start.error) || t('Please try again.') };
        fullChecksRunning.delete(runId);
        // Still on this sitting's result (opened again is fine)?
        const here = !!fullState.exam && String(fullState.exam.id) === String(exam.id) && !document.getElementById('full-result').hidden && fullState.resultRunId === runId;
        if (out.error) {
            toast.error(out.error, t('Not checked'));
            if (here) { regrade.disabled = false; regrade.textContent = t('Check them again'); }
            return;
        }
        if (here) renderFullResult(fullState.exam, out.result.run);
        if (out.result.left) toast.info(t('{n} parts still couldn\'t be checked. Try again in a few minutes.').replace('{n}', out.result.left));
    };
    const capped = outOf > 0 && run.score > outOf;
    document.getElementById('full-score-text').textContent =
        `${t('{s} of {m} points').replace('{s}', Math.round(run.score * 10) / 10).replace('{m}', Math.round(outOf * 10) / 10)} · ${t('{n} minutes').replace('{n}', usedMin)}` +
        (capped ? ` · ${t('Over the top - the grade is capped at 100.')}` : '') +
        (unchecked ? ` · ${t('{n} parts couldn\'t be checked and are left out.').replace('{n}', unchecked)}` : '');
    const weak = document.getElementById('full-weak');
    weak.textContent = '';
    if (!(run.weakTopics || []).length) {
        const li = document.createElement('li');
        li.textContent = unchecked ? t('The topics show once every part is checked.') : t('No topic under 60% - well done.');
        weak.appendChild(li);
    }
    for (const w of run.weakTopics || []) {
        const li = document.createElement('li');
        li.setAttribute('translate', 'no');
        li.dir = 'auto';
        li.textContent = w;
        weak.appendChild(li);
    }
    const box = document.getElementById('full-result-questions');
    box.textContent = '';
    const byKey = new Map((run.answers || []).map(a => [fullKey(a.q, a.p), a]));
    exam.questions.forEach((q, qi) => {
        const rows = q.parts.map((p, pi) => byKey.get(fullKey(qi, pi)));
        const got = rows.reduce((n, r) => n + (r && (r.status === 'graded' || r.status === 'blank') ? r.points : 0), 0);
        const card = document.createElement('div');
        card.className = 'card full-rq';
        const head = document.createElement('div');
        head.className = 'full-rq__head';
        const h = document.createElement('h3');
        h.className = 'full-q__title';
        h.textContent = `${t('Question')} ${qi + 1}`;
        if (q.title) { const sub = document.createElement('span'); sub.setAttribute('translate', 'no'); sub.dir = 'auto'; sub.textContent = ` · ${q.title}`; h.appendChild(sub); }
        if (q.bonus) h.prepend(fullBonusBadge());
        const sc = document.createElement('span');
        sc.className = 'full-rq__score';
        sc.textContent = outOfLabel(Math.round(got * 10) / 10, Math.round(q.points * 10) / 10);
        head.append(h, sc);
        card.appendChild(head);
        if (q.stem) {
            const stem = document.createElement('div');
            stem.className = 'full-q__stem';
            stem.setAttribute('translate', 'no');
            stem.dir = 'auto';
            setMathText(stem, q.stem);
            card.appendChild(stem);
        }
        q.parts.forEach((p, pi) => {
            const r = rows[pi] || { choice: '', text: '', points: 0, max: p.points, status: 'blank', feedback: '' };
            const part = document.createElement('div');
            part.className = 'full-rpart';
            part.dataset.key = `${qi}:${pi}`;
            const ph = document.createElement('div');
            ph.className = 'full-rpart__head';
            const lab = document.createElement('span');
            lab.className = 'full-part__label';
            lab.setAttribute('translate', 'no');
            lab.textContent = p.label ? `${p.label}.` : '';
            const txt = document.createElement('span');
            txt.className = 'full-part__text';
            txt.setAttribute('translate', 'no');
            txt.dir = 'auto';
            // (shortened - unless it has a formula, which a cut would break)
            const shortText = p.text.length > 220 && !(window.MathText && window.MathText.hasMath(p.text)) ? `${p.text.slice(0, 220)}…` : p.text;
            setMathText(txt, shortText);
            const pts = document.createElement('span');
            pts.className = 'full-rpart__pts';
            if (r.status === 'not_chosen') pts.textContent = t('Not chosen');
            else if (r.status === 'unchecked') pts.textContent = t('Not checked');
            else {
                pts.textContent = outOfLabel(Math.round(r.points * 100) / 100, Math.round(r.max * 100) / 100);
                pts.classList.toggle('is-full', r.max > 0 && r.points >= r.max);
                pts.classList.toggle('is-zero', r.points === 0);
            }
            ph.append(lab, txt, pts);
            part.appendChild(ph);
            if (r.status !== 'not_chosen') {
                const mine = document.createElement('div');
                mine.className = 'full-rpart__mine';
                mine.setAttribute('translate', 'no');
                mine.dir = 'auto';
                let shown = '';
                if (r.dontKnow) shown = t('I don\'t know');
                else if (p.type === 'mc') shown = [r.choice !== '' && p.options[Number(r.choice)] != null ? `${Number(r.choice) + 1}. ${p.options[Number(r.choice)]}` : '', p.reasonRequired ? r.text : ''].filter(Boolean).join('\n');
                else if (p.type === 'tf') shown = [r.choice === 'true' ? t('True') : r.choice === 'false' ? t('False') : '', r.text].filter(Boolean).join(' - ');
                else shown = r.text;
                // (a chosen option can hold a formula; code stays as typed)
                if (p.type === 'code') mine.textContent = shown || t('No answer');
                else setMathText(mine, shown || t('No answer'));
                part.appendChild(mine);
                if (r.fromPhoto) {
                    const src = document.createElement('div');
                    src.className = 'full-check';
                    src.textContent = r.photoEdited ? t('Copied from your photo, and corrected by you.') : t('Copied from your photo.');
                    part.appendChild(src);
                }
            }
            // Points per criterion of the marking scheme - where the points went.
            // (Each mark carries its criterion as it was when graded - a late
            // "corrected" check can replace the part's scheme afterwards.)
            const marks = r.status === 'graded' && Array.isArray(r.marks) ? r.marks.filter(m => m.criterion || (Array.isArray(p.rubric) && p.rubric[m.c])) : [];
            if (marks.length) part.appendChild(fullMarksTable(p, marks));
            if (r.feedback) {
                const fb = document.createElement('div');
                fb.className = 'full-rpart__feedback';
                fb.setAttribute('translate', 'no');
                fb.dir = 'auto';
                setMathText(fb, r.feedback);
                part.appendChild(fb);
            }
            if (r.photoFeedback) {
                const pf = document.createElement('div');
                pf.className = 'full-photo-fb';
                pf.setAttribute('translate', 'no');
                pf.dir = 'auto';
                pf.textContent = `${t('Where it went wrong:')} ${r.photoFeedback}`;
                part.appendChild(pf);
            }

            const det = document.createElement('details');
            const sum = document.createElement('summary');
            sum.textContent = t('The solution');
            const sol = document.createElement('div');
            sol.className = 'full-rpart__solution';
            sol.setAttribute('translate', 'no');
            sol.dir = 'auto';
            const right = p.type === 'mc' ? `${Number(p.correct) + 1}. ${p.options[Number(p.correct)] || ''}\n\n` : p.type === 'tf' ? `${p.correct === 'true' ? t('True') : t('False')}\n\n` : '';
            if (p.type === 'code') sol.textContent = right + p.answer; else setMathText(sol, right + p.answer);
            det.append(sum, sol);
            if (p.check) {
                const c = document.createElement('div');
                c.className = 'full-check';
                c.textContent = p.check === 'checked' ? t('This solution was checked by a second, independent solution.')
                    : p.check === 'doubtful' ? t('The second check thinks this question itself is wrong or unclear - compare it with your course material.')
                    : t('A second solution found a mistake in the first one - this is the corrected solution.');
                if (p.check === 'doubtful') c.classList.add('full-check--doubtful');
                det.appendChild(c);
            } else {
                const c = document.createElement('div');
                c.className = 'full-check';
                c.textContent = t('Written by the AI - check it against your course material.');
                det.appendChild(c);
            }
            part.appendChild(det);
            card.appendChild(part);
        });
        box.appendChild(card);
    });
    document.getElementById('study-full').hidden = false;
    showFullPart('full-result');
}

document.getElementById('full-again-btn').onclick = () => { if (fullState.exam) openFullIntro(fullState.exam.id); };
document.getElementById('full-new-btn').onclick = () => openFullExam(fullState.course || (fullState.exam && fullState.exam.course) || '');
