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
        authToggleLink.textContent = 'Log in';
    } else {
        authTitle.textContent = 'Log in';
        authSubtitle.textContent = 'Welcome back.';
        authNameField.hidden = true;
        authDegreeField.hidden = true;
        authPasswordHint.hidden = true;
        authSubmitBtn.textContent = 'Log in';
        authToggleText.textContent = "Don't have an account?";
        authToggleLink.textContent = 'Create one';
    }
}

if (authToggleLink) {
    authToggleLink.onclick = (e) => {
        e.preventDefault();
        setAuthMode(authMode === 'login' ? 'register' : 'login');
    };
}

// Called once, either immediately (a saved session was still valid) or
// after a successful login/register. Reveals the app and re-runs the loads
// that may have fired with empty/401 results while the login screen was up.
let currentUserId = null;
let currentProfile = { name: '', degree: '' };   // from loadProfile (30/9) // used to keep per-user UI preferences apart on a shared machine

function bootApp(user) {
    document.body.classList.remove('auth-pending');
    currentUserId = user && (user.id || user._id) ? String(user.id || user._id) : null;
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
                    degree: authDegreeInput.value.trim()
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
    } catch (err) {
        console.error('auth-get-session failed:', err.message);
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
        await ipcRenderer.invoke('delete-event', evt.id);
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

function eventOccursOn(evt, date) {
    if (evt.date) return evt.date === localIsoDate(date);
    // Weekly: every week on its day, up to and including `until` if it has one.
    if (evt.until && localIsoDate(date) > evt.until) return false;
    return evt.day === WEEKDAY_NAMES[date.getDay()];
}

// "2027-01-15" -> "15/1" when it's within the coming year (no doubt which
// one is meant, and it fits a narrow Planner column), else "15/1/2027".
function untilLabel(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    const days = (new Date(y, m - 1, d) - new Date()) / 86400000;
    return days > -60 && days < 330 ? `${d}/${m}` : `${d}/${m}/${y}`;
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
                <div class="task-time">${escapeHtml(evt.time)}${weekly ? ` <span class="task-repeat" title="${evt.until ? `Every week until ${untilLabel(evt.until)}` : 'Every week'}">↻${evt.until ? ` until ${untilLabel(evt.until)}` : ''}</span>` : ''}</div>
                <div class="task-card__title" dir="auto">${escapeHtml(evt.title)}</div>
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
                const ok = await confirmDialog(
                    weekly ? t('Delete "{name}" from every week?', { name: evt.title }) : t('Delete "{name}"?', { name: evt.title }),
                    evt.googleEventId ? t('It is removed from Google Calendar too.') : '',
                    { confirmText: t('Delete'), danger: true });
                if (!ok) return;
                delBtn.disabled = true;
                await ipcRenderer.invoke('delete-event', evt.id);
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
            <div class="ms-toast__message" dir="ltr"></div>
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
            renderEmptyState(empty, {
                icon: 'plus',
                title: 'Nothing here',
                message: `No tasks match the "${activeTaskStatusFilter}" filter right now.`
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
        setUploadRowStatus(i, 'done', 'Uploaded');
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
}

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

    // Ticked by default: everything that can go in and doesn't need a look.
    const items = res.items.map(i => {
        const note = syllabusNote(i);
        return { ...i, checked: !note };   // classes carry a (soft) note -> unticked
    });
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
    const course = syllabusCourse.value.trim();
    const syncToGoogle = !!(syllabusGoogle && syllabusGoogle.checked && picked.some(i => i.kind === 'exam' || i.kind === 'class'));

    state.saving = true;
    syllabusConfirm.disabled = true;
    syllabusCancel.disabled = true;
    syllabusConfirm.textContent = syncToGoogle ? 'Adding and syncing…' : 'Adding…';
    let res;
    try {
        res = await ipcRenderer.invoke('import-syllabus-items',
            picked.map(({ kind, title, date, until, time, durationMinutes, weekday, endTime }) => ({ kind, title, date, until, time, durationMinutes, weekday, endTime })),
            { course, syncToGoogle });
    } catch (e) {
        res = { created: { events: [], tasks: [] }, errors: [e.message], syncErrors: [] };
    }
    state.saving = false;
    syllabusCancel.disabled = false;

    const events = (res && res.created && res.created.events) || [];
    const tasks = (res && res.created && res.created.tasks) || [];
    if (!events.length && !tasks.length) {
        updateSyllabusConfirm();
        toast.error((res && res.errors && res.errors[0]) || 'Please try again.', 'Nothing was added');
        return;
    }
    closeSyllabusModal();

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

// What the numbers mean, in words - the student shouldn't have to work out
// what "12 / 3 / 5 / 10" says about next Thursday.
function readinessSentence(s) {
    const r = s.readiness;
    const parts = [];
    if (r.unseen === r.total) {
        parts.push('You haven\'t practiced this course yet.');
    } else {
        parts.push(`You know ${r.known} of ${r.total}.`);
        if (r.sureWrong) parts.push(r.sureWrong === 1
            ? '1 you were sure about turned out wrong - it comes first in practice.'
            : `${r.sureWrong} you were sure about turned out wrong - they come first in practice.`);
        if (r.shaky) parts.push(`${r.shaky} ${r.shaky === 1 ? 'is' : 'are'} shaky (partly right, or right by guessing).`);
        if (r.unseen) parts.push(`${r.unseen} not practiced yet.`);
    }
    const toGo = r.total - r.known;
    if (s.exam) {
        if (toGo === 0) parts.push('You know all of it - keep it fresh until the exam.');
        else if (s.exam.daysLeft <= 1) parts.push(`Before the exam, go over the ${toGo} you don't know for sure yet.`);
        else {
            const perDay = Math.ceil(toGo / (s.exam.daysLeft - 1));
            parts.push(`To get through the other ${toGo} before the exam: about ${perDay} a day.`);
        }
    } else {
        parts.push('No exam date yet - add it (Study or Planner) and practice is timed to it.');
    }
    return parts.join(' ');
}

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
        return;
    }
    withQuestions.forEach(s => {
        const r = s.readiness;
        const row = document.createElement('div');
        row.className = 'readiness-row';

        const head = document.createElement('div');
        head.className = 'readiness-row__head';
        const name = document.createElement('span');
        name.className = 'readiness-row__name';
        name.dir = 'auto';
        name.textContent = s.category === 'Uncategorized' ? t('No course') : s.category;
        const pct = document.createElement('span');
        pct.className = 'readiness-row__pct ms-tabular';
        pct.textContent = `${r.percent}%`;
        pct.title = 'Share of this course\'s questions you know';
        head.append(name);
        if (s.exam) {
            const exam = document.createElement('span');
            exam.className = 'study-course__exam' + (s.exam.daysLeft <= 7 ? ' is-soon' : '');
            exam.textContent = examChipText(s.exam);
            exam.title = s.exam.title;
            head.append(exam);
        }
        head.append(pct);

        const bar = document.createElement('div');
        bar.className = 'readiness-bar';
        [['known', 'rd-known', 'Know it'], ['shaky', 'rd-shaky', 'Shaky'], ['notKnown', 'rd-not', 'Don\'t know yet'], ['unseen', 'rd-unseen', 'Not practiced']]
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
        practice.onclick = () => {
            document.getElementById('nav-study').click();
            setTimeout(() => startStudySession(null, { category: s.category, label: name.textContent }), 60);
        };

        const foot = document.createElement('div');
        foot.className = 'readiness-row__foot';
        foot.append(text, practice);
        row.append(head, bar, foot);
        list.append(row);
    });
}

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
}

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
    const inThisWeek = (e) => !e.date || (e.date >= wkStart && e.date <= wkEnd);

    if (statTasks) statTasks.innerText = tasks.length;
    if (statExams) statExams.innerText = events.filter(e => e.type === 'exam' && (!e.date || e.date >= todayIso)).length;
    if (statEvents) statEvents.innerText = events.filter(inThisWeek).length;
    if (statLessons) statLessons.innerText = events.filter(e => e.type === 'lesson' && inThisWeek(e)).length;

    
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
                if (nextTime) nextTime.innerText = `${WEEKDAY_NAMES[new Date().getDay()]} • ${evt.time} • Up next`;
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
            if (nextTitle) nextTitle.innerText = t('All done for today');
            if (nextTime) nextTime.innerText = "Today's classes and events are over.";
            if (sidebarNextTitle) sidebarNextTitle.innerText = t('All done for today');
            if (sidebarNextMeta) sidebarNextMeta.innerText = tasks.length > 0 ? `${tasks.length} open task${tasks.length === 1 ? '' : 's'}` : '';
        }
    }
    
    const hour = new Date().getHours();
    let greeting = "Good night";
    if (hour >= 6 && hour < 12) greeting = "Good morning";
    else if (hour >= 12 && hour < 18) greeting = "Good afternoon";
    else if (hour >= 18 && hour < 22) greeting = "Good evening";
    
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
    btn.className = 'btn-primary';
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
        btn.className = 'btn-secondary';
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
        const sure = await confirmDialog("Reset everything?", "This deletes all tasks, calendar events, folders and files. Your profile is kept. This cannot be undone.", { confirmText: "Reset everything", danger: true });
        if (sure) {
            await ipcRenderer.invoke('hard-reset');
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
            const previousPlan = events.filter(e => e.autoScheduled);
            for (const old of previousPlan) {
                await ipcRenderer.invoke('delete-event', old.id);
            }
            if (previousPlan.length) events = events.filter(e => !e.autoScheduled);

            const aiResponse = await ipcRenderer.invoke('generate-weekly-plan', tasks, events);
            const parsed = JSON.parse(aiResponse);
            const newPlan = Array.isArray(parsed) ? parsed : (parsed.plan || []);
            const unplaced = (parsed && parsed.unplaced) || [];

            if (parsed.error) {
                toast.error("Could not build a plan: " + parsed.error);
            } else if (newPlan.length > 0) {
                
                // Web, not connected: don't ask - the blocks just stay in MindSync.
                const syncToGoogle = (IS_WEB && !googleConnected())
                    ? false
                    : await confirmDialog("Sync to Google Calendar?", "The new study blocks will also be added to your Google Calendar.", { confirmText: "Sync", cancelText: "Skip" });
                let syncErrors = [];

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
                    if (planRes && planRes.error) console.error('Save plan event failed:', planRes.error, planEvent);
                }
                
                await loadAndRenderEvents();
                await loadAndRenderWeeklyBoard();
                await loadAndRenderHome();

                if (syncToGoogle && syncErrors.length > 0) {
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
    const startBtn = document.getElementById('start-study-btn');
    if (startBtn) startBtn.textContent = stats.dueCount > 0 ? `Start smart practice · ${stats.dueCount} ready` : 'Start smart practice';
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
        actions.append(practice);

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
    const [cats, files] = await Promise.all([
        ipcRenderer.invoke('get-study-categories').catch(() => []),
        ipcRenderer.invoke('get-files-light').catch(() => [])
    ]);
    let moved = 0;
    for (const cat of cats || []) {
        const file = (files || []).find(f => f.name && f.name.replace(/\.[^.]+$/, '').trim() === String(cat).trim() && realFolder(f));
        if (!file) continue;
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

    if (resume && Array.isArray(resume.ids)) {
        // Re-fetch by id rather than trusting a stored copy: an item may have
        // been edited or deleted since the session was paused.
        const all = await ipcRenderer.invoke('get-study-items', {});
        const byId = new Map((all || []).map(i => [i.id, i]));
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
    } else {
        const filter = scope ? { category: scope.category, ...(scope.sourceFile !== undefined ? { sourceFile: scope.sourceFile } : {}) } : {};
        items = await ipcRenderer.invoke('get-due-study-items', { limit: 20, ...filter });
        if ((!items || items.length === 0) && scope) {
            // Nothing DUE in this course/file - say why, and offer the rest.
            const ok = await confirmDialog(
                `Nothing to practice in ${scope.label} right now`,
                'You practiced these recently, so none is due yet. Spacing questions out is what makes you remember them longer. You can still go over them now - handy right before an exam.',
                { confirmText: 'Practice anyway', cancelText: 'Not now' });
            if (!ok) return;
            items = await ipcRenderer.invoke('get-due-study-items', { limit: 20, all: true, ...filter });
        }
        if (!items || items.length === 0) {
            toast.info(scope
                ? 'There are no questions here yet.'
                : 'Nothing is due right now - you\'re up to date. Come back tomorrow, practice one course below, or make questions from a new file.', 'All caught up');
            return;
        }
    }

    studyState.queue = items;
    studyState.scope = scope;
    const scopeLabel = document.getElementById('study-scope-label');
    if (scopeLabel) scopeLabel.textContent = scope ? `· ${scope.label}` : '· Smart practice';
    studyState.index = resume ? Math.min(resume.index, items.length - 1) : 0;
    studyState.session = resume ? resume.session : { reviewed: 0, correct: 0, lucky: 0, overconfident: 0 };
    if (!Array.isArray(studyState.session.sureWrong)) studyState.session.sureWrong = [];

    clearManageSelection();
    document.getElementById('study-home').hidden = true;
    document.getElementById('study-summary').hidden = true;
    document.getElementById('study-review').hidden = true;
    document.getElementById('study-manage').hidden = true;
    document.getElementById('study-session').hidden = false;

    renderStudyCard();
}

function renderStudyCard() {
    const item = studyState.queue[studyState.index];
    if (!item) return endStudySession();

    studyState.confidence = null;
    studyState.startedAt = Date.now();
    studyState.aiOutcome = null;
    const typed = document.getElementById('study-typed-answer');
    if (typed) {
        typed.value = '';
        typed.placeholder = TYPE_PLACEHOLDERS[item.mode] || TYPE_PLACEHOLDERS.recall;
        typed.disabled = false;
    }
    document.querySelectorAll('.confidence-btn, #study-dont-know-btn').forEach(b => { b.disabled = false; });

    const total = studyState.queue.length;
    document.getElementById('study-position').textContent = `${studyState.index + 1} / ${total}`;
    document.getElementById('study-progress-fill').style.width = `${(studyState.index / total) * 100}%`;

    document.getElementById('study-mode-badge').textContent = MODE_LABELS[item.mode] || item.mode;
    const catBadge = document.getElementById('study-category-badge');
    // For a practice item the skill is more useful than the course name -
    // it's what the repetition is actually over.
    const badgeText = (item.mode === 'practice' && item.skillTag) ? item.skillTag : item.category;
    if (badgeText) { catBadge.textContent = badgeText; catBadge.hidden = false; }
    else catBadge.hidden = true;

    document.getElementById('study-question').textContent = item.question;
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
document.querySelectorAll('.confidence-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        const seen = Number(localStorage.getItem(confidenceHintKey()) || 0);
        if (seen < CONFIDENCE_HINT_TIMES) localStorage.setItem(confidenceHintKey(), String(seen + 1));
        studyState.confidence = btn.dataset.confidence;
        const item = studyState.queue[studyState.index];
        const typed = document.getElementById('study-typed-answer');
        const text = typed ? typed.value.trim() : '';
        if (!item || !text) { revealAnswer(); return; }   // answered in the head

        // Typed: the AI checks it. The buttons stay put (no jump), just busy.
        const buttons = document.querySelectorAll('.confidence-btn, #study-dont-know-btn');
        buttons.forEach(b => { b.disabled = true; });
        typed.disabled = true;
        const prompt = document.getElementById('study-confidence-prompt');
        const promptText = prompt.textContent;
        prompt.textContent = 'Checking your answer…';
        const res = await ipcRenderer.invoke('grade-study-answer', {
            question: item.question, expected: item.answer || item.mySolution || '', mode: item.mode, userAnswer: text
        }).catch(e => ({ error: e.message }));
        prompt.textContent = promptText;
        if (studyState.queue[studyState.index] !== item) return;   // stopped meanwhile
        revealAnswer(res && !res.error ? { ...res, typed: text } : { failed: (res && res.error) || 'no answer', typed: text });
    });
});

// "I don't know": straight to the answer. No check (nothing to check), and no
// "How did you do?" - it's already known how it went. Saved as not known
// (missed / wrong), so it comes back soon.
const dontKnowBtn = document.getElementById('study-dont-know-btn');
if (dontKnowBtn) dontKnowBtn.onclick = () => {
    const item = studyState.queue[studyState.index];
    if (!item) return;
    studyState.confidence = 'dont_know';
    revealAnswer({ dontKnow: true });
    // The stored answer is a quote from the material - often long, with an
    // intro. Ask for the short direct one (or a solution when there's none).
    const stored = (item.answer || item.mySolution || '').trim();
    if (!stored || stored.length > SHORT_ENOUGH) fetchShortAnswer(item);
};
const SHORT_ENOUGH = 200;

async function fetchShortAnswer(item) {
    const index = studyState.index;
    const box = document.getElementById('study-short-answer');
    const text = document.getElementById('study-short-answer-text');
    if (!box || !text) return;
    box.hidden = false;
    box.classList.add('is-loading');
    text.textContent = t('Getting a short answer…');
    const res = await ipcRenderer.invoke('grade-study-answer', {
        question: item.question, expected: item.answer || item.mySolution || '', mode: item.mode, explainOnly: true
    }).catch(() => null);
    if (studyState.index !== index || studyState.queue[index] !== item) return;   // moved on meanwhile
    box.classList.remove('is-loading');
    if (res && res.answer) {
        text.textContent = res.answer;
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
    studyState.aiOutcome = dontKnow ? outcomeMap.wrong
        : (check && check.verdict ? outcomeMap[check.verdict] : null);
    if (verdictBox) {
        verdictBox.hidden = !check || dontKnow;
        verdictBox.className = 'study-verdict' + (check && check.verdict ? ` study-verdict--${check.verdict}` : '');
        if (check) {
            document.getElementById('study-verdict-title').textContent = check.verdict
                ? VERDICT_TITLES[check.verdict]
                : 'Couldn\'t check it right now - mark yourself below';
            document.getElementById('study-verdict-feedback').textContent = check.verdict ? (check.feedback || '') : '';
            document.getElementById('study-verdict-yours').textContent = `${t('You wrote:')} ${check.typed}`;
        }
    }
    const shortBox = document.getElementById('study-short-answer');
    if (shortBox) {
        const short = check && check.verdict && check.answer ? check.answer : '';
        shortBox.hidden = !short;
        shortBox.classList.remove('is-loading');
        document.getElementById('study-short-answer-text').textContent = short;
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

    if (item.mode === 'practice' && solutionBlock) {
        solutionBlock.hidden = false;
        solutionInput.value = item.mySolution || '';
        solutionLabel.textContent = item.mySolution
            ? 'Your solution from last time'
            : 'Your solution (saved for next time)';
    } else if (solutionBlock) {
        solutionBlock.hidden = true;
    }

    if (item.answer && item.answer.trim()) {
        answerEl.textContent = item.answer;
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
        res = await ipcRenderer.invoke('submit-study-review', item.id, {
            confidence: studyState.confidence,
            outcome,
            secondsSpent
        });
    } catch (err) {
        res = { error: (err && err.message) || 'No connection. Try again.' };
    } finally {
        reviewInFlight = false;
    }
    // Stopped, or moved on, while it was saving: nothing more to do here.
    if (studyState.queue[index] !== item || studyState.index !== index || document.getElementById('study-session').hidden) return;

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
        toast.warning('You were sure about that one. It will come back soon.', 'Sure but wrong');
    }

    // A same-session retry (interval 0) goes back in the queue rather than
    // being lost until tomorrow.
    if (res.nextInterval === 0) {
        studyState.queue.push(item);
    }

    studyState.index += 1;
    saveSessionProgress();

    if (studyState.index >= studyState.queue.length) endStudySession();
    else renderStudyCard();
}

function endStudySession() {
    clearSessionProgress();
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
            // Out of quota: the text path asks the same Gemini - just say so.
            if (first.error && !/quota/i.test(first.error)) {
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
            <button class="filter-chip ${manageSourceFilter === src ? 'active' : ''}" data-source="${escapeHtml(src)}">
                ${src === 'all' ? 'All' : escapeHtml(src.length > 28 ? src.slice(0, 28) + '…' : src)}
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
                    ${i.repetitions > 0 ? ` · reviewed ${i.repetitions}×` : ' · never reviewed'}
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
                <div class="review-item__q" contenteditable="true" dir="auto" data-field="question">${escapeHtml(item.question)}</div>
                ${item.answer
                    ? `<details class="review-item__reveal" ${item.solutionSource === 'ai' ? 'open' : ''}>
                         <summary>${item.solutionSource === 'ai' ? 'AI solution' : 'Show the answer'}</summary>
                         <div class="review-item__a" contenteditable="true" dir="auto" data-field="answer">${escapeHtml(item.answer)}</div>
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
            el.onblur = () => { item[el.dataset.field] = el.textContent.trim(); };
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
    toast.success(
        discarded > 0
            ? `Added ${chosen.length} questions. ${discarded} discarded.`
            : `Added ${chosen.length} questions.`,
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