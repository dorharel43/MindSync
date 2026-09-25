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
const NAME_PATTERN = /^[\p{L}\s'-]+$/u;
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
function bootApp(user) {
    document.body.classList.remove('auth-pending');

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
        if (authForm) authForm.reset();
        setAuthMode('login');
        if (authLoading) authLoading.hidden = true;
        if (authFormWrap) authFormWrap.hidden = false;
        document.body.classList.add('auth-pending');
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
// 1. Navigation
// ==========================================
const menuItems = document.querySelectorAll('.menu-item');
const views = document.querySelectorAll('.view-section');

menuItems.forEach(item => {
    item.addEventListener('click', () => {
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
const VALID_THEMES = ['ink', 'paper', 'slate'];

function applyTheme(themeName) {
    if (!VALID_THEMES.includes(themeName)) themeName = 'ink';
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

function toggleTheme() {
    applyDarkMode(!document.body.classList.contains('dark-mode'));
}

if (themeBtnSidebar) themeBtnSidebar.addEventListener('click', toggleTheme);
if (darkToggleSettings) darkToggleSettings.addEventListener('click', toggleTheme);

document.querySelectorAll('.theme-option').forEach((btn) => {
    btn.addEventListener('click', () => {
        applyTheme(btn.dataset.themeValue);
        toast.success(`Theme set to ${btn.dataset.themeValue}.`);
    });
});

// Restore saved preferences on boot
applyTheme(localStorage.getItem(THEME_KEY) || 'ink');
applyDarkMode(localStorage.getItem(DARK_KEY) === '1');

// ==========================================
// 3. Focus Mode
// ==========================================
const focusBtn = document.getElementById('focus-btn');
let isFocusMode = false;

if (focusBtn) {
    focusBtn.addEventListener('click', () => {
        isFocusMode = !isFocusMode;
        ipcRenderer.send('toggle-blocking', isFocusMode);
        
        if (isFocusMode) {
            focusBtn.innerHTML = icon('shield') + ' Stop Focus Mode';
            focusBtn.style.borderColor = '#f44336';
            focusBtn.style.color = '#f44336';
        } else {
            focusBtn.innerHTML = icon('shield') + ' Start Focus Mode';
            focusBtn.style.borderColor = '#4caf50';
            focusBtn.style.color = '#4caf50';
        }
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

if(addEventBtn) addEventBtn.addEventListener('click', () => addEventModal.style.display = 'flex');
if(triggerAddEventWeekly) triggerAddEventWeekly.addEventListener('click', () => addEventModal.style.display = 'flex');
if(cancelEventBtn) cancelEventBtn.addEventListener('click', () => addEventModal.style.display = 'none');

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
            <div class="schedule-time">${evt.time}</div>
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
        deleteBtn.innerText = '⏳';
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
            icon: '📅',
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

// Tasks carry a real date (DD/MM/YYYY string, or a dueDate), unlike events,
// which repeat weekly by day name. Returns null for "Not set" / unparseable.
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
        loadAndRenderWeeklyBoard();
    });
}

async function loadAndRenderWeeklyBoard() {
    const dayColumns = document.querySelectorAll('.day-column');
    if (!dayColumns.length) return;

    const showTasks = !!(weeklyShowTasksToggle && weeklyShowTasksToggle.checked);
    const [events, folders, tasks] = await Promise.all([
        ipcRenderer.invoke('get-events'),
        ipcRenderer.invoke('get-folders').catch(() => []),
        showTasks ? ipcRenderer.invoke('get-tasks').catch(() => []) : Promise.resolve([])
    ]);

    const legendTask = document.getElementById('legend-task');
    // visibility, not hidden/display: the item keeps its space either way,
    // so toggling doesn't shift the toggle or the rest of the row.
    if (legendTask) legendTask.style.visibility = showTasks ? 'visible' : 'hidden';

    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    // The board is "this week", Sunday to Saturday. Each column gets its
    // real date, so a task due on the 18th has an obvious place to go.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay());

    dayColumns.forEach((column, index) => {
        const colDate = new Date(weekStart);
        colDate.setDate(weekStart.getDate() + index);
        const isToday = colDate.getTime() === today.getTime();

        column.innerHTML = '';
        column.classList.toggle('is-today', isToday);

        const header = document.createElement('div');
        header.className = 'day-header';
        header.innerHTML = `
            <div class="day-header__name">${days[index]}</div>
            <div class="day-header__date">${isToday ? 'Today · ' : ''}${colDate.getDate()}/${colDate.getMonth() + 1}</div>`;
        column.appendChild(header);

        // Sorted by time - the server only ever returned them in insertion
        // order within a day, so 18:00 could sit above 09:00.
        const dayEvents = events
            .filter(e => e.day === days[index])
            .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

        dayEvents.forEach(evt => {
            const dest = getEventLearningDestination(evt, folders);
            const taskCard = document.createElement('div');
            taskCard.className = `task-card ${weeklyClassMap[evt.type] || 'task-lesson'}`;
            taskCard.style.position = 'relative';

            taskCard.innerHTML = `
                <button class="btn-icon btn-icon--danger delete-weekly-btn" title="Delete from calendar" aria-label="Delete from calendar">${icon('trash')}</button>
                <div class="task-time">${escapeHtml(evt.time)}</div>${escapeHtml(evt.title)}
            `;

            // Clicking a study/exam event (or one whose title names a
            // Materials folder) jumps straight to the relevant place.
            if (dest) {
                taskCard.style.cursor = 'pointer';
                taskCard.title = dest.type === 'materials' ? `Open Materials — ${dest.folderName}` : 'Open in Study';
                taskCard.onclick = () => goToLearningDestination(dest);
            }

            const delBtn = taskCard.querySelector('.delete-weekly-btn');
            delBtn.onmouseenter = () => delBtn.style.opacity = '1';
            delBtn.onmouseleave = () => delBtn.style.opacity = '0.5';
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                delBtn.innerText = '⏳';
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
}

if(saveEventBtn) {
    saveEventBtn.addEventListener('click', async () => {
        const textInput = document.getElementById('smart-event-input');
        const text = textInput ? textInput.value.trim() : "";
        const syncToGoogle = document.getElementById('sync-google-check').checked;

        if (!text) {
            toast.error("You must write something!");
            return;
        }

        const originalText = saveEventBtn.innerText;
        saveEventBtn.innerText = 'Processing...';
        saveEventBtn.disabled = true;

        try {
            const response = await ipcRenderer.invoke('parse-smart-event', text);
            let parsedEvents = JSON.parse(response);

            if (parsedEvents.error) {
                toast.error("Oops: " + parsedEvents.error);
            } else {
                if (!Array.isArray(parsedEvents)) {
                    parsedEvents = [parsedEvents];
                }

                if (syncToGoogle) saveEventBtn.innerText = 'Syncing to Google...';
                const saveErrors = [];
                let syncErrors = [];

                for (const parsedEvent of parsedEvents) {
                    if (syncToGoogle) {
                        const result = await ipcRenderer.invoke('add-to-google-calendar', parsedEvent);
                        if (result.success) {
                            parsedEvent.googleEventId = result.eventId; 
                        } else {
                            console.error("Google Sync Error:", result.error);
                            syncErrors.push(result.error);
                        }
                    }
                    // The return value was being discarded, so a server-side
                    // rejection showed up only in the terminal and the event
                    // just silently never appeared.
                    const saveRes = await ipcRenderer.invoke('save-event', parsedEvent);
                    if (saveRes && saveRes.error) {
                        saveErrors.push(saveRes.error);
                        console.error('Save event failed:', saveRes.error, parsedEvent);
                    }
                }

                if (saveErrors.length > 0) {
                    toast.error(saveErrors[0], `Could not save ${saveErrors.length} event(s)`);
                }

                textInput.value = '';
                addEventModal.style.display = 'none';

                await loadAndRenderEvents();
                await loadAndRenderWeeklyBoard();
                await loadAndRenderHome();

                if (syncToGoogle && syncErrors.length > 0) {
                    toast.error(`⚠️ Could not sync to Google Calendar.\n\nReason: ${syncErrors[0]}\n\nThe event was still saved in MindSync itself.`);
                }
            }
        } catch (e) {
            toast.error("Communication error with AI.");
            console.error(e);
        } finally {
            saveEventBtn.innerText = originalText;
            saveEventBtn.disabled = false;
        }
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
    // Populate the datalist so you can reuse an existing category instead of
    // retyping it (and accidentally creating "Exam" vs "exam" duplicates).
    const datalist = document.getElementById('existing-categories');
    if (datalist) {
        const cats = await ipcRenderer.invoke('get-task-categories');
        datalist.innerHTML = (cats || []).map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
    }
};
if (cancelTaskBtn) cancelTaskBtn.onclick = () => addTaskModal.style.display = 'none';

if (saveSmartTaskBtn) {
    saveSmartTaskBtn.onclick = async () => {
        const text = smartTaskInput.value.trim();
        if (!text) {
            toast.error("You must write something!");
            return;
        }

        const categoryInput = document.getElementById('smart-task-category');
        const category = categoryInput ? categoryInput.value.trim() : '';

        const originalText = saveSmartTaskBtn.innerText;
        saveSmartTaskBtn.innerText = 'Processing...';
        saveSmartTaskBtn.disabled = true;

        try {
            const response = await ipcRenderer.invoke('add-smart-task', text, category);
            const result = JSON.parse(response);

            if (result.error) {
                toast.error("Oops: " + result.error);
            } else {
                smartTaskInput.value = '';
                if (categoryInput) categoryInput.value = '';
                addTaskModal.style.display = 'none';
                await refreshTasksData();
                await loadAndRenderHome();
            }
        } catch (e) {
            toast.error("Communication error with AI.");
            console.error(e);
        } finally {
            saveSmartTaskBtn.innerText = originalText;
            saveSmartTaskBtn.disabled = false;
        }
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

    cachedTasksData = await ipcRenderer.invoke('get-tasks') || [];
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
            icon: '🎉',
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
            `<button class="category-chip ${activeTaskCategory === cat ? 'active' : ''}" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`
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
                icon: '🔍',
                title: 'No matches',
                message: `Nothing matches "${taskSearchQuery}". Try a different search.`
            });
        } else if (activeTaskStatusFilter !== 'all') {
            renderEmptyState(empty, {
                icon: '✨',
                title: 'Nothing here',
                message: `No tasks match the "${activeTaskStatusFilter}" filter right now.`
            });
        } else {
            renderEmptyState(empty, {
                icon: '📂',
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
        let urgencyColor = 'var(--text-secondary)';
        if (task.urgency === 'Urgent') urgencyColor = '#f44336';
        else if (task.urgency === 'High') urgencyColor = '#ff9800';
        else if (task.urgency === 'Medium') urgencyColor = '#2196f3';

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
                        <select class="urgency-select" style="color: ${urgencyColor};">
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
                    <button class="toggle-checklist-btn" title="Show checklist" aria-label="Show checklist">${hasChecklist ? icon('list') : icon('plus')}</button>
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
                    <button class="delete-subtask-btn" title="Remove step">✕</button>
                `;

                row.querySelector('input[type="checkbox"]').onchange = async (e) => {
                    const newValue = e.target.checked;
                    const updated = await ipcRenderer.invoke('toggle-subtask', task.id, sub._id, newValue);
                    if (updated && updated.error) {
                        toast.error('Could not update step: ' + updated.error);
                        e.target.checked = !newValue; // revert the checkbox, the server rejected it
                        return;
                    }
                    task.subtasks = updated.subtasks;
                    task.status = updated.status;
                    refreshProgressUI();
                    renderChecklist();
                };

                row.querySelector('.delete-subtask-btn').onclick = async () => {
                    const updated = await ipcRenderer.invoke('delete-subtask', task.id, sub._id);
                    if (updated && updated.error) { toast.error('Could not remove step: ' + updated.error); return; }
                    task.subtasks = updated.subtasks;
                    task.status = updated.status;
                    refreshProgressUI();
                    renderChecklist();
                };

                checklistItems.appendChild(row);
            });
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
            if (!title) return;
            addSubtaskBtn.disabled = true;
            const updated = await ipcRenderer.invoke('add-subtask', task.id, title);
            addSubtaskBtn.disabled = false;
            if (updated && updated.error) { toast.error('Could not add step: ' + updated.error); return; }
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
                const colors = { Urgent: '#f44336', High: '#ff9800', Medium: '#2196f3', Normal: 'var(--text-secondary)' };
                e.target.style.color = colors[newUrgency];
            };
        }

        const deleteBtn = taskCard.querySelector('.delete-task-btn');
        deleteBtn.onclick = async () => {
            // Keep a copy so Undo can recreate it. The id will differ after
            // restore, which is fine - the content is what the user cares about.
            const snapshot = {
                title: task.title,
                date: task.date,
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
const uploadFileNameDisplay = document.getElementById('upload-file-name-display');
const uploadFolderSelect = document.getElementById('upload-folder-select');
const addFolderModal = document.getElementById('add-folder-modal');

let currentActiveFolder = 'All';
let pendingFileToSave = null;

async function loadAndRenderFolders() {
    if (!materialsGrid) return;
    const folders = await ipcRenderer.invoke('get-folders');
    materialsGrid.innerHTML = '';

    const allFolder = document.createElement('div');
    allFolder.className = 'card folder-card';
    allFolder.style.border = currentActiveFolder === 'All' ? '2px solid var(--accent-purple)' : '1px solid var(--border-color)';
    allFolder.innerHTML = `<div class="folder-icon">${icon('library')}</div><div class="folder-name">All Files</div>`;
    allFolder.onclick = () => {
        currentActiveFolder = 'All';
        loadAndRenderFolders();
        loadAndRenderFiles();
    };
    materialsGrid.appendChild(allFolder);

    folders.forEach((folder) => {
        const folderCard = document.createElement('div');
        folderCard.className = 'card folder-card';
        folderCard.style.position = 'relative';
        folderCard.style.border = currentActiveFolder === folder.name ? '2px solid var(--accent-purple)' : '1px solid var(--border-color)';
        
        folderCard.innerHTML = `
            <button class="btn-icon btn-icon--danger delete-folder-btn" aria-label="Delete folder">${icon('trash')}</button>
            <div class="folder-icon">${icon('folder')}</div>
            <div class="folder-name">${escapeHtml(folder.name)}</div>
        `;
        
        folderCard.onclick = (e) => {
            if (e.target.classList.contains('delete-folder-btn')) return;
            currentActiveFolder = folder.name;
            loadAndRenderFolders();
            loadAndRenderFiles();
        };

        const delBtn = folderCard.querySelector('.delete-folder-btn');
        delBtn.onmouseenter = () => delBtn.style.opacity = '1';
        delBtn.onmouseleave = () => delBtn.style.opacity = '0.5';
        delBtn.onclick = async (e) => {
            e.stopPropagation();
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
    addBtn.innerHTML = `<div class="add-icon">+</div><div class="folder-name" style="color: var(--text-secondary);">New Folder</div>`;
    addBtn.onclick = () => addFolderModal.style.display = 'flex';
    materialsGrid.appendChild(addBtn);

    if (uploadFolderSelect) {
        uploadFolderSelect.innerHTML = '<option value="No Folder">No Folder</option>';
        folders.forEach(f => {
            uploadFolderSelect.innerHTML += `<option value="${f.name}">${f.name}</option>`;
        });
    }
}

async function loadAndRenderFiles() {
    if (!filesListContainer) return;
    const files = await ipcRenderer.invoke('get-files');
    filesListContainer.innerHTML = '';

    const filteredFiles = currentActiveFolder === 'All' 
        ? files 
        : files.filter(f => f.folder === currentActiveFolder);

    if (filteredFiles.length === 0) {
        renderEmptyState(filesListContainer, {
            icon: '📄',
            title: 'No files here yet',
            message: 'Upload a PDF, summary or exercise sheet to summarize it or extract tasks from it.'
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
                    <div class="file-name">${escapeHtml(file.name)}</div>
                    <div class="file-meta">Folder: ${escapeHtml(file.folder)}</div>
                </div>
            </div>
            <div class="file-actions" style="display:flex; gap:8px; flex-wrap:wrap;">
                <button class="btn-secondary btn-extract">${icon('brain')} Extract Tasks</button>
                <button class="btn-primary btn-ai">${icon('sparkle')} ${file.summary ? 'View summary' : 'Summarize'}</button>
                <button class="btn-secondary delete-file-btn">${icon('trash')} Delete</button>
            </div>
        `;

        // Opens (or brings to front) a separate, resizable summary window.
        // A saved summary shows instantly; otherwise it's generated there.
        fileItem.querySelector('.btn-ai').onclick = () => ipcRenderer.invoke('open-summary-window', file.id, file.name);
        
        fileItem.querySelector('.delete-file-btn').onclick = async () => {
            const result = await ipcRenderer.invoke('delete-file', file.id); // Fixed: Pass ID directly without searching
            if (result && result.error) { toast.error('Could not delete file: ' + result.error); return; }
            await loadAndRenderFiles();
        };

        const extractBtn = fileItem.querySelector('.btn-extract');
        if (extractBtn) {
            extractBtn.onclick = async () => {
                const originalText = extractBtn.innerText;
                extractBtn.innerText = 'Analyzing document... ⏳';
                extractBtn.disabled = true;

                try {
                    const aiResponse = await ipcRenderer.invoke('extract-tasks-from-text', file.content);
                    const tasksArray = JSON.parse(aiResponse);

                    if (tasksArray.error) {
                        toast.error('Error: ' + tasksArray.error);
                    } else if (Array.isArray(tasksArray) && tasksArray.length > 0) {
                        // Group everything from one document under one category
                        // so a bulk import doesn't scatter itself through the
                        // whole task list. The filename is the default, but the
                        // user can change it - promptDialog is our own modal,
                        // since Electron doesn't implement window.prompt().
                        const suggested = file.name.replace(/\.[^.]+$/, '').trim();
                        const category = await promptDialog(
                            'Group these tasks',
                            `Found ${tasksArray.length} task(s). They'll be grouped under this category:`,
                            suggested
                        );
                        if (category === null) return; // cancelled

                        let failed = 0;
                        for (const task of tasksArray) {
                            const saveResult = await ipcRenderer.invoke('save-task', {
                                title: task.title,
                                date: task.date,
                                category: category,
                                urgency: task.urgency || 'Normal'
                            });
                            if (saveResult && saveResult.error) {
                                console.error('Failed to save task:', task.title, saveResult.error);
                                failed++;
                            }
                        }

                        await loadAndRenderTasks(); 
                        await loadAndRenderHome();

                        const saved = tasksArray.length - failed;
                        if (failed > 0) {
                            toast.error(`Added ${saved} task(s), but ${failed} failed to save. Check the console for details.`);
                        } else {
                            toast.success(`Added ${saved} tasks under "${category}".`, 'Extraction complete');
                        }
                    } else {
                        toast.error('The AI read the document but couldn\'t find clear tasks to extract.');
                    }
                } catch (err) {
                    toast.error('Error parsing the data from the AI: ' + err.message);
                    console.error(err);
                } finally {
                    extractBtn.innerText = originalText;
                    extractBtn.disabled = false;
                }
            };
        }

        filesListContainer.appendChild(fileItem);
    });
}

const uploadBtnElement = document.querySelector('.btn-upload');
if (uploadBtnElement) {
    uploadBtnElement.onclick = async () => {
        const result = await ipcRenderer.invoke('select-and-read-file');
        if (!result) return; // user cancelled the file picker - not an error
        // BUG FIX: this used to silently do nothing on a read error - which
        // is exactly "I clicked it and nothing happened" from the outside.
        // Now it surfaces main.js's actual message (e.g. a PDF that failed
        // to extract, or a file it couldn't read at all).
        if (result.error) { toast.error(result.error, 'Could not read file'); return; }
        pendingFileToSave = result;
        uploadFileNameDisplay.textContent = result.fileName;
        uploadFolderSelect.value = currentActiveFolder !== 'All' ? currentActiveFolder : "No Folder";
        uploadModal.style.display = 'flex';
    };
}

const confirmUploadBtn = document.getElementById('confirm-upload-btn');
if (confirmUploadBtn) {
    confirmUploadBtn.onclick = async () => {
        if (!pendingFileToSave) return;
        const result = await ipcRenderer.invoke('save-file', {
            name: pendingFileToSave.fileName,
            content: pendingFileToSave.fileContent,
            sourcePath: pendingFileToSave.filePath || '',
            folder: uploadFolderSelect.value
        });
        if (result && result.error) { toast.error('Could not save file: ' + result.error); return; }
        uploadModal.style.display = 'none';
        pendingFileToSave = null;
        await loadAndRenderFiles();
    };
}

const cancelUploadBtn = document.getElementById('cancel-upload-btn');
if (cancelUploadBtn) {
    cancelUploadBtn.onclick = () => uploadModal.style.display = 'none';
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
            <button class="blocked-app__remove" aria-label="Stop blocking ${appName}" title="Remove">${icon('close', { size: 14 })}</button>
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

// ==========================================
// 9. Modals closing
// ==========================================
document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
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
    await renderProgressInsights();
}

// Builds the two lower panels of the Progress view from the task list. This
// is what turns the page from three lonely numbers into something worth
// opening: where the workload actually sits, and what needs attention first.
async function renderProgressInsights() {
    const tasks = (await ipcRenderer.invoke('get-tasks')) || [];

    const openTasks = tasks.filter(t => t.status !== 'completed');
    const openEl = document.getElementById('metric-open-tasks');
    if (openEl) openEl.textContent = openTasks.length;

    // "Done this week" counts tasks updated in the last 7 days that are done.
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const weekDone = tasks.filter(t =>
        t.status === 'completed' && t.updatedAt && new Date(t.updatedAt).getTime() >= weekAgo
    ).length;
    const weekEl = document.getElementById('metric-week-done');
    if (weekEl) weekEl.textContent = weekDone;

    // ---- Workload by category ----
    const catEl = document.getElementById('category-breakdown');
    if (catEl) {
        const groups = {};
        openTasks.forEach(t => {
            const key = (t.category || '').trim() || 'Uncategorized';
            if (!groups[key]) groups[key] = { total: 0, done: 0 };
            groups[key].total++;
            // Count checklist progress so a half-finished task shows as such.
            if (t.subtasks && t.subtasks.length) {
                const d = t.subtasks.filter(st => st.completed).length;
                groups[key].done += d / t.subtasks.length;
            }
        });

        const entries = Object.entries(groups).sort((a, b) => b[1].total - a[1].total);
        if (entries.length === 0) {
            catEl.innerHTML = '<div class="ms-muted ms-text-sm">No open tasks to break down yet.</div>';
        } else {
            const max = Math.max(...entries.map(([, v]) => v.total));
            catEl.innerHTML = entries.map(([name, v]) => {
                const pct = Math.round((v.done / v.total) * 100);
                return `
                    <div class="cat-row">
                        <div class="cat-row__head">
                            <span class="cat-row__name" dir="auto">${escapeHtml(name)}</span>
                            <span class="cat-row__count">${v.total} task${v.total === 1 ? '' : 's'} · ${pct}% done</span>
                        </div>
                        <div class="cat-row__track">
                            <div class="cat-row__fill" style="width: ${Math.round((v.total / max) * 100)}%"></div>
                        </div>
                    </div>`;
            }).join('');
        }
    }

    // ---- Needs attention ----
    const attEl = document.getElementById('attention-list');
    if (attEl) {
        const rank = { Urgent: 0, High: 1, Medium: 2, Normal: 3 };
        const colors = {
            Urgent: 'var(--status-danger)',
            High: 'var(--status-warning)',
            Medium: 'var(--status-info)',
            Normal: 'var(--text-tertiary)'
        };
        const top = [...openTasks]
            .sort((a, b) => (rank[a.urgency] ?? 3) - (rank[b.urgency] ?? 3))
            .slice(0, 6);

        if (top.length === 0) {
            attEl.innerHTML = '<div class="ms-muted ms-text-sm">Nothing pending. Nice work.</div>';
        } else {
            attEl.innerHTML = top.map(t => {
                const meta = [t.urgency, t.date && t.date !== 'Not set' ? t.date : null]
                    .filter(Boolean).join(' · ');
                return `
                    <div class="attention-item">
                        <span class="attention-item__dot" style="background: ${colors[t.urgency] || colors.Normal}"></span>
                        <div class="attention-item__body">
                            <div class="attention-item__title" dir="auto">${escapeHtml(t.title)}</div>
                            <div class="attention-item__meta">${escapeHtml(meta)}</div>
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

    const name = profile.name || 'Guest';
    if (nameEl) nameEl.innerText = name;
    if (degreeEl) degreeEl.innerText = profile.degree || 'Student';
    if (picEl) picEl.innerText = name.charAt(0).toUpperCase();
    if (homeGreetingName) homeGreetingName.innerText = name;

    if (settingsName) settingsName.innerText = name;
    if (settingsMeta) settingsMeta.innerText = profile.degree || 'Student';
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

        finishOnboardBtn.innerText = 'Saving... ⏳';

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
            const nameEl = document.getElementById('sidebar-profile-name');
            const degreeEl = document.getElementById('sidebar-profile-degree');
            document.getElementById('onboard-name').value = (nameEl && nameEl.innerText !== 'Guest') ? nameEl.innerText : '';
            document.getElementById('onboard-degree').value = (degreeEl && degreeEl.innerText !== 'Student') ? degreeEl.innerText : '';
            onboardScreen.style.display = 'flex';
        }
    };
}

// ==========================================
// 12. Dynamic Home & Hard Reset
// ==========================================
async function loadAndRenderHome() {
    const tasks = await ipcRenderer.invoke('get-tasks') || [];
    const events = await ipcRenderer.invoke('get-events') || [];
    
    const statTasks = document.getElementById('home-stat-tasks');
    const statExams = document.getElementById('home-stat-exams');
    const statEvents = document.getElementById('home-stat-events');
    const statLessons = document.getElementById('home-stat-lessons');

    if (statTasks) statTasks.innerText = tasks.length;
    if (statExams) statExams.innerText = events.filter(e => e.type === 'exam').length;
    if (statEvents) statEvents.innerText = events.length;
    if (statLessons) statLessons.innerText = events.filter(e => e.type === 'lesson').length;

    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayName = days[new Date().getDay()]; 
    
    const todayEvents = events.filter(e => e.day === todayName).sort((a, b) => a.time.localeCompare(b.time));
    
    const timelineList = document.getElementById('home-timeline-list');
    const nextTitle = document.getElementById('home-next-title');
    const nextTime = document.getElementById('home-next-time');
    const sidebarNextTitle = document.getElementById('sidebar-next-title');
    const sidebarNextMeta = document.getElementById('sidebar-next-meta');
    
    if (timelineList) timelineList.innerHTML = '';
    
    if (todayEvents.length === 0) {
        if (timelineList) timelineList.innerHTML = '<div style="text-align:center; color: var(--text-secondary); padding: 20px;">No events planned for today. 🎉</div>';
        if (nextTitle) nextTitle.innerText = "Your day is free";
        if (nextTime) nextTime.innerText = "You can rest or crush some tasks!";
        if (sidebarNextTitle) sidebarNextTitle.innerText = "Nothing scheduled today";
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
                if (nextTime) nextTime.innerText = `⏱ ${todayName} • ${evt.time} • Up next`;
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
                    <span ${isNext ? 'style="font-weight: bold;"' : ''}>${escapeHtml(evt.title)}</span>
                    ${isNext ? '<span class="tag-active" style="margin-left:8px;">Next</span>' : ''}
                </div>
                <div class="timeline-time" ${isNext ? 'style="font-weight: bold;"' : ''}>${evt.time}</div>
            `;
            if (timelineList) timelineList.appendChild(div);
        });

        if (!nextEventFound) {
            if (nextTitle) nextTitle.innerText = "Done for today!";
            if (nextTime) nextTime.innerText = "All today's events have passed. See you tomorrow 🌙";
            if (sidebarNextTitle) sidebarNextTitle.innerText = "All done for today";
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
}

const navHomeBtn = document.getElementById('nav-home');
if (navHomeBtn) {
    navHomeBtn.addEventListener('click', loadAndRenderHome);
}

const sidebarHighlight = document.getElementById('sidebar-highlight');
if (sidebarHighlight) {
    sidebarHighlight.style.cursor = 'pointer';
    sidebarHighlight.title = 'Open Weekly Plan';
    sidebarHighlight.onclick = () => document.getElementById('nav-weekly').click();
}

loadAndRenderHome();

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
        const tasks = await ipcRenderer.invoke('get-tasks') || [];
        let events = await ipcRenderer.invoke('get-events') || [];

        if (!tasks.some(t => t.status !== 'completed')) {
            toast.info("No open tasks to plan. 🎉");
            return;
        }

        const originalText = generateWeeklyAiBtn.innerHTML;
        generateWeeklyAiBtn.innerHTML = 'Planning your week... ⏳';
        generateWeeklyAiBtn.disabled = true;

        try {
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
                
                const syncToGoogle = await confirmDialog("Sync to Google Calendar?", "The new study blocks will also be added to your Google Calendar.", { confirmText: "Sync", cancelText: "Skip" });
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
                    toast.error(`⚠️ ${syncErrors.length} out of ${newPlan.length} study blocks failed to sync to Google Calendar.\n\nReason: ${syncErrors[0]}\n\nThe blocks were still saved in MindSync itself.`);
                } else {
                    toast.success(`Added ${newPlan.length} blocks to your calendar${previousPlan.length ? ', replacing the previous plan' : ''}.`, 'Weekly plan ready');
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
    if (document.hidden) {
        new Notification(title, {
            body: message
        });
    }
}

// זיכרון קצר ששומר מזהים של אירועים שכבר קפצה עליהם התראה
let notifiedEvents = new Set();

// בודקים כל 30 שניות כדי לא לפספס אירועים קרובים
setInterval(async () => {
    const events = await ipcRenderer.invoke('get-events') || [];
    if (events.length === 0) return;

    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayName = days[now.getDay()];

    events.forEach(evt => {
        // בודקים רק אירועים של היום
        if (evt.day === todayName) {
            // ממירים את שעת האירוע לאובייקט זמן של ג'אווה-סקריפט
            const [evtHour, evtMin] = evt.time.split(':').map(Number);
            const eventTime = new Date();
            eventTime.setHours(evtHour, evtMin, 0, 0);

            // מחשבים כמה דקות נשארו בדיוק עד לאירוע
            const diffMinutes = (eventTime.getTime() - now.getTime()) / 60000;

            // אם נשארו בין 0 ל-10 דקות, ועוד לא התרענו - תקפיץ התראה!
            if (diffMinutes > 0 && diffMinutes <= 10 && !notifiedEvents.has(evt.id)) {
                showNotification("Upcoming Event", `${evt.title} starts at ${evt.time} ⏱️`);
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
        const allTasks = (await ipcRenderer.invoke('get-tasks')) || [];
        const snapshots = allTasks
            .filter(t => selectedTaskIds.has(t.id))
            .map(t => ({
                title: t.title, date: t.date, category: t.category, urgency: t.urgency,
                subtasks: (t.subtasks || []).map(st => ({ title: st.title, completed: st.completed }))
            }));

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
                <div class="ms-modal__header"><h3 class="ms-modal__title">${title}</h3></div>
                <div class="ms-modal__body ms-modal__body--structured">
                    <div class="option-list">
                        ${options.map(o => `<button class="option-row" data-value="${o}">${o}</button>`).join('')}
                    </div>
                </div>
                <div class="ms-modal__footer">
                    <button class="btn-secondary" data-action="cancel">Cancel</button>
                </div>
            </div>`;
        function close(v) { backdrop.remove(); resolve(v); }
        backdrop.querySelectorAll('.option-row').forEach(b => b.onclick = () => close(b.dataset.value));
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
    const d = new Date(yyyy, mm - 1, dd);
    if (d.getDate() !== dd || d.getMonth() !== mm - 1) return null; // 31/2, 40/13...
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
            openModal.style.display = 'none';
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
                <div class="ms-modal__header"><h3 class="ms-modal__title">${title}</h3></div>
                <div class="ms-modal__body ms-modal__body--structured">
                    <div class="option-list">
                        ${options.map(o => `
                            <label class="checkbox-field checkbox-field--compact">
                                <input type="checkbox" value="${o.value}">
                                <span class="checkbox-field__text">
                                    <span class="checkbox-field__label">${o.label}</span>
                                    <span class="checkbox-field__hint">${o.value}</span>
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
    session: { reviewed: 0, correct: 0, overconfident: 0 }
};

// Sessions survive leaving the screen and closing the app.
//
// Reviews are already saved to the server one at a time, so no answer was ever
// lost - but the PLACE in the queue was, so stopping at question 5 of 20 meant
// starting from the top next time. For a 20-item session that's enough friction
// to stop people opening it at all.
const SESSION_KEY = 'mindsync.activeSession';

function saveSessionProgress() {
    if (!studyState.queue.length || studyState.index >= studyState.queue.length) {
        localStorage.removeItem(SESSION_KEY);
        return;
    }
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({
            // Only ids are stored; the items themselves are re-fetched so a
            // resumed session never shows stale content.
            ids: studyState.queue.map(i => i.id),
            index: studyState.index,
            session: studyState.session,
            savedAt: Date.now()
        }));
    } catch (e) { /* storage full or unavailable - not worth failing over */ }
}

function readSessionProgress() {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);

        // A day-old session is stale: the schedule has moved on and different
        // items are due, so resuming it would be reviewing the wrong things.
        if (Date.now() - data.savedAt > 24 * 60 * 60 * 1000) {
            localStorage.removeItem(SESSION_KEY);
            return null;
        }
        return data;
    } catch { return null; }
}

function clearSessionProgress() {
    localStorage.removeItem(SESSION_KEY);
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

const MODE_LABELS = { recall: 'Recall', practice: 'Practice', explain: 'Explain' };
const MODE_PROMPTS = {
    recall: 'Think of your answer. How sure are you?',
    practice: 'Read the problem. How sure are you that you can solve it?',
    explain: 'Plan your explanation. How sure are you?'
};
const ANSWER_PROMPTS = {
    recall: 'How did you do?',
    practice: 'Solve it on paper, then tell the truth:',
    explain: 'Compare your explanation to the answer:'
};

async function loadStudyHome() {
    const stats = await ipcRenderer.invoke('get-study-stats');
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
                `You stopped at question ${resume.index + 1} of ${resume.ids.length} — ${remaining} left.`;
        } else {
            banner.hidden = true;
        }
    }

    renderCalibration(stats.calibration, stats.reviewsAllTime, stats.trendByConfidence);
    renderConfidentlyWrong(stats.confidentlyWrong);
    renderAttentionList('underconfident-panel', stats.underconfidentItems,
        'Nothing here yet — no pattern of doubting yourself on things you actually know.', 'good');
    renderAttentionList('genuine-difficulty-panel', stats.genuineDifficultyItems,
        'Nothing flagged as genuinely hard right now.', 'warn');
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
                    <div class="cal-ideal" style="left:${r.ideal}%" title="Well-calibrated: about ${r.ideal}%"></div>
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
                <div class="attention-item__meta">${escapeHtml(i.category || 'Uncategorized')} · ${MODE_LABELS[i.mode] || i.mode}${i.accuracy !== undefined ? ` · ${i.accuracy}% (${i.reviewCount})` : ''}</div>
            </div>
        </div>`).join('');
}

// ---- Session flow ----
async function startStudySession(resume = null) {
    let items;

    if (resume && Array.isArray(resume.ids)) {
        // Re-fetch by id rather than trusting a stored copy: an item may have
        // been edited or deleted since the session was paused.
        const all = await ipcRenderer.invoke('get-study-items', {});
        const byId = new Map((all || []).map(i => [i.id, i]));
        items = resume.ids.map(id => byId.get(id)).filter(Boolean);

        if (items.length === 0) {
            toast.info('Those questions are no longer available. Starting a new session.');
            clearSessionProgress();
            return startStudySession();
        }
    } else {
        items = await ipcRenderer.invoke('get-due-study-items', { limit: 20 });
        if (!items || items.length === 0) {
            toast.info('Nothing is due right now. Create questions from a file, or come back later.', 'All caught up');
            return;
        }
    }

    studyState.queue = items;
    studyState.index = resume ? Math.min(resume.index, items.length - 1) : 0;
    studyState.session = resume ? resume.session : { reviewed: 0, correct: 0, overconfident: 0 };

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
    document.getElementById('study-confidence-prompt').textContent = MODE_PROMPTS[item.mode] || MODE_PROMPTS.recall;

    document.getElementById('study-confidence-step').hidden = false;
    document.getElementById('study-answer-step').hidden = true;
}

// Step 1 -> 2: confidence is locked in before anything is revealed.
document.querySelectorAll('.confidence-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        studyState.confidence = btn.dataset.confidence;
        revealAnswer();
    });
});

function revealAnswer() {
    const item = studyState.queue[studyState.index];
    if (!item) return;

    const answerEl = document.getElementById('study-answer');
    const labelEl = document.querySelector('.study-answer-label');

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
                labelEl.innerHTML = `<span class="ai-answer-flag">${icon('sparkle', { size: 13 })} AI-generated solution — worth checking</span>`;
            } else {
                labelEl.textContent = item.sourceFile
                    ? `From your material — ${item.sourceFile}`
                    : 'From your material';
            }
        }
    } else {
        answerEl.textContent = item.mode === 'practice'
            ? (item.mySolution
                ? 'Compare what you did against your saved solution below.'
                : 'No stored solution yet. Solve it, then save your working below so it\'s here next time.')
            : 'No passage was stored for this one — check your notes.';
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
    });

    document.getElementById('study-confidence-step').hidden = true;
    document.getElementById('study-answer-step').hidden = false;
}

async function submitReview(outcome) {
    const item = studyState.queue[studyState.index];
    if (!item) return;

    const secondsSpent = Math.round((Date.now() - studyState.startedAt) / 1000);
    const res = await ipcRenderer.invoke('submit-study-review', item.id, {
        confidence: studyState.confidence,
        outcome,
        secondsSpent
    });

    if (res && res.error) { toast.error(res.error, 'Could not save review'); return; }

    studyState.session.reviewed += 1;
    if (res.item && res.item.reviews) {
        const last = res.item.reviews[res.item.reviews.length - 1];
        if (last && last.wasCorrect) studyState.session.correct += 1;
    }

    // Name the overconfidence at the moment it happens. Buried in a stats
    // screen a week later it teaches nothing.
    if (res.wasOverconfident) {
        studyState.session.overconfident += 1;
        toast.warning('You were certain about that one. Worth another look.', 'Overconfident');
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
    document.getElementById('summary-overconfident').textContent = s.overconfident;

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

const endStudyBtn = document.getElementById('end-study-btn');
if (endStudyBtn) endStudyBtn.onclick = endStudySession;

const summaryDoneBtn = document.getElementById('summary-done-btn');
if (summaryDoneBtn) summaryDoneBtn.onclick = async () => {
    document.getElementById('study-summary').hidden = true;
    document.getElementById('study-home').hidden = false;
    await loadStudyHome();
};

// ---- Generating questions from an uploaded file ----
const generateStudyBtn = document.getElementById('generate-study-btn');
if (generateStudyBtn) {
    generateStudyBtn.onclick = async () => {
        const files = await ipcRenderer.invoke('get-files');
        if (!files || files.length === 0) {
            toast.info('Upload course material under Materials first.', 'No files yet');
            return;
        }

        const chosen = await pickOption(
            'Create questions from which file?',
            files.map(f => f.name)
        );
        if (!chosen) return;

        const file = files.find(f => f.name === chosen);
        if (!file) return;

        const category = await promptDialog(
            'Which subject?',
            'Questions will be grouped under this, so you can study one course at a time.',
            file.name.replace(/\.[^.]+$/, '')
        );
        if (category === null) return;

        generateStudyBtn.disabled = true;
        const originalHTML = generateStudyBtn.innerHTML;

        try {
            const aiConfig = await ipcRenderer.invoke('get-ai-config');
            let response;

            // Prefer reading the actual page images. Text extraction is what
            // destroyed formulas, code layout and Hebrew ordering; a vision
            // model reads the page as rendered, so none of that damage occurs.
            if (aiConfig && aiConfig.visionAvailable && file.sourcePath && /\.pdf$/i.test(file.name)) {
                // Send the PDF itself. Gemini 3.x reads PDFs natively, so the
                // document arrives with its layout intact - no extraction step
                // to mangle formulas, code indentation or Hebrew ordering, and
                // no rasterising either.
                generateStudyBtn.textContent = 'Reading the document...';
                response = await ipcRenderer.invoke('generate-study-items-pdf', file.sourcePath, {
                    category: category.trim(),
                    sourceFile: file.name
                });

                // BUG FIX: vision had no fallback at all - a Gemini outage/
                // rate limit (503/429) meant a hard failure with no way
                // through, even though the text-based path a few lines down
                // already exists and already falls back to Ollama on its
                // own. The generated set still goes through the same review
                // screen before anything is saved, so a lower-quality draft
                // here is caught there, not served silently as final.
                const visionResult = JSON.parse(response);
                if (visionResult.error) {
                    console.warn('⚠️ Vision generation failed, falling back to extracted text:', visionResult.error);
                    toast.info('Direct PDF reading is unavailable right now (likely a Gemini outage/rate limit) - using the extracted text instead. Double-check the questions before saving.', 'Lower-quality fallback used');
                    generateStudyBtn.textContent = 'Reading the document...';
                    response = await ipcRenderer.invoke('generate-study-items', file.content, {
                        category: category.trim(),
                        sourceFile: file.name
                    });
                }
            } else {
                generateStudyBtn.textContent = 'Reading the document...';
                response = await ipcRenderer.invoke('generate-study-items', file.content, {
                    category: category.trim(),
                    sourceFile: file.name
                });
            }

            const result = JSON.parse(response);

            if (result.error) { toast.error(result.error, 'Could not create questions'); return; }

            // Draft first, deck second. Generated questions go to a review
            // screen rather than straight into the deck: the model is right
            // most of the time but not always, and a wrong definition that
            // gets studied and tested is worse than no question at all.
            openReviewScreen(result);
        } catch (e) {
            toast.error(e.message, 'Something went wrong');
        } finally {
            generateStudyBtn.disabled = false;
            generateStudyBtn.innerHTML = originalHTML;
        }
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

async function loadManageList() {
    const items = await ipcRenderer.invoke('get-study-items', {});
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
            icon: '🗂️',
            title: 'No questions yet',
            message: 'Create questions from a file to start building your deck.'
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
            chip.onclick = () => { manageSourceFilter = chip.dataset.source; loadManageList(); };
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
                    ${MODE_LABELS[i.mode] || i.mode}
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

function openReviewScreen(items) {
    reviewDraft = items.map((it, i) => ({ ...it, _id: i, _selected: true }));

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
                    ${MODE_LABELS[item.mode] || item.mode}
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
        confirmBtn.textContent = selected === 0 ? 'Nothing selected' : `Add ${selected} to deck`;
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

async function loadAiSettings() {
    const cfg = await ipcRenderer.invoke('get-ai-config');
    if (!cfg) return;

    if (aiActiveLabel) {
        aiActiveLabel.textContent = cfg.active === 'gemini'
            ? 'Gemini — pages are read as images, so formulas and code come through intact.'
            : 'Ollama — local and offline. Handles text well; formulas and code are unreliable.';
    }

    if (aiKeyStatus) {
        // Only ever show a masked form. The full key is never sent back from
        // the main process, so it can't leak through the UI.
        aiKeyStatus.innerHTML = cfg.hasKey
            ? `Key saved (<span class="ms-tabular">${escapeHtml(cfg.keyPreview)}</span>).`
            : 'No key saved.';
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