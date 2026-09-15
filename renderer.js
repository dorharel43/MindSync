const { ipcRenderer } = require('electron');

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

const aiModal = document.getElementById('ai-modal');
const aiCloseBtn = document.getElementById('ai-close-btn');
const aiInputText = document.getElementById('ai-input-text');
const aiGenerateBtn = document.getElementById('ai-generate-btn');
const aiResultBox = document.getElementById('ai-result-box');
const aiOutputText = document.getElementById('ai-output-text');
const aiLoading = document.getElementById('ai-loading');

function openAiSummary(content) {
    aiInputText.value = content; 
    aiResultBox.style.display = 'none'; 
    aiModal.style.display = 'flex'; 
}

if (aiCloseBtn) {
    aiCloseBtn.addEventListener('click', () => aiModal.style.display = 'none');
}

function formatAIText(text) {
    if (!text) return '';
    let html = text;
    html = html.replace(/^### (.*$)/gim, '<h3 style="color: var(--accent-purple); margin-top: 15px; margin-bottom: 5px;">$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2 style="color: var(--accent-purple); margin-top: 15px; margin-bottom: 5px;">$1</h2>');
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/^\* (.*$)/gim, '<div style="margin-left: 15px;">• $1</div>');
    html = html.replace(/\n/g, '<br>');
    return html;
}

if (aiGenerateBtn) {
    aiGenerateBtn.addEventListener('click', async () => {
        const textToSummarize = aiInputText.value;
        if (!textToSummarize) return;

        aiResultBox.style.display = 'block';
        aiOutputText.style.display = 'none';
        aiLoading.style.display = 'block';

        const summary = await ipcRenderer.invoke('summarize-text', textToSummarize);
        
        aiLoading.style.display = 'none';
        aiOutputText.style.display = 'block';
        aiOutputText.innerHTML = formatAIText(summary); 
    });
}

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

async function loadAndRenderEvents() {
    const events = await ipcRenderer.invoke('get-events');
    if(scheduleList) scheduleList.innerHTML = ''; 
    
    if (events.length === 0 && scheduleList) {
        renderEmptyState(scheduleList, {
            icon: '📅',
            title: 'Your schedule is empty',
            message: 'Add your lessons, exams and study blocks to see your week at a glance.'
        });
        return;
    }

    events.forEach((evt) => {
        const style = typeStyles[evt.type] || typeStyles.lesson;
        const div = document.createElement('div');
        div.className = 'schedule-bar';
        div.style.backgroundColor = style.bg;
        div.style.borderLeft = `4px solid ${style.border}`;
        
        div.innerHTML = `
            <div class="schedule-info">
                <div class="schedule-circle" style="border-color: ${style.border}; ${evt.type === 'exam' ? `background-color: ${style.border};` : ''}"></div>
                <div class="schedule-time">${evt.time}</div>
                <div class="schedule-title" ${evt.type === 'exam' || evt.type === 'study' ? 'style="font-weight: bold;"' : ''}>${evt.title} <span style="font-size:0.8rem; color:var(--text-secondary);">(${evt.day})</span></div>
            </div>
            <button class="btn-icon btn-icon--danger delete-event-btn" title="Delete event" aria-label="Delete event">${icon('trash')}</button>
        `;
        
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

        if(scheduleList) scheduleList.appendChild(div);
    });
}

async function loadAndRenderWeeklyBoard() {
    const events = await ipcRenderer.invoke('get-events');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayColumns = document.querySelectorAll('.day-column');
    
    if(!dayColumns.length) return;

    dayColumns.forEach((column, index) => {
        const header = column.querySelector('.day-header');
        column.innerHTML = ''; 
        column.appendChild(header);
        
        const dayEvents = events.filter(e => e.day === days[index]);
        
        dayEvents.forEach(evt => {
            const taskCard = document.createElement('div');
            // Planned blocks are marked. A study block you placed yourself and
            // one the planner placed behave differently - re-planning sweeps
            // the second and leaves the first - and that difference has to be
            // visible, or the next re-plan looks like it deleted things at
            // random.
            taskCard.className = `task-card ${weeklyClassMap[evt.type] || 'task-lesson'}${evt.autoScheduled ? ' task-card--planned' : ''}`;
            taskCard.style.position = 'relative';

            // A range, not a length. The board has no hour grid, so a block
            // gives no clue when it ends - but "90m" made you do the sum
            // yourself, and the question people actually have is "when am I
            // free again", not "how long is this".
            const timeLabel = evt.durationMinutes
                ? `${evt.time}–${toTimeString(toMinutes(evt.time) + evt.durationMinutes)}`
                : evt.time;

            taskCard.innerHTML = `
                <button class="btn-icon btn-icon--danger delete-weekly-btn" title="Delete from calendar" aria-label="Delete from calendar">${icon('trash')}</button>
                <div class="task-time">${timeLabel}</div>${escapeHtml(evt.title)}
            `;

            // A planned block exists because of a task, so it leads back to
            // it. Without this the calendar and the task list are two lists
            // of the same work with no connection between them.
            if (evt.autoScheduled && evt.task) {
                taskCard.classList.add('task-card--linked');
                taskCard.title = 'Open the task this block is for';
                taskCard.onclick = () => {
                    highlightTaskId = typeof evt.task === 'object' ? evt.task._id || evt.task.id : evt.task;
                    const nav = document.getElementById('nav-tasks');
                    if (nav) nav.click();
                };
            }
            
            const delBtn = taskCard.querySelector('.delete-weekly-btn');
            delBtn.onmouseenter = () => delBtn.style.opacity = '1';
            delBtn.onmouseleave = () => delBtn.style.opacity = '0.5';
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                delBtn.innerText = '⏳';
                await ipcRenderer.invoke('delete-event', evt.id);
                await loadAndRenderEvents();
                await loadAndRenderWeeklyBoard();
                await loadAndRenderHome();
            };
            
            column.appendChild(taskCard);
        });
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
            let response = await ipcRenderer.invoke('add-smart-task', text, category);
            let result = JSON.parse(response);

            // A sentence with a start and an end time describes something
            // already fixed. Nothing has been saved yet, so the answer decides
            // what gets created rather than correcting it afterwards.
            if (result.looksFixed) {
                const f = result.looksFixed;

                // Two ways to be a commitment: it states a time, or it IS one
                // by nature. The wording says which, because "this has a set
                // time" would be nonsense for a sentence that has no time.
                let why;
                if (f.time) {
                    const span = f.durationMinutes
                        ? `${f.time} for ${Math.round((f.durationMinutes / 60) * 10) / 10}h`
                        : f.time;
                    why = `This has a set time (${span}), so there's nothing for the planner to decide`;
                } else {
                    why = f.kind === 'exam'
                        ? "An exam happens when it happens — there's nothing for the planner to decide"
                        : "A class happens when it happens — there's nothing for the planner to decide";
                }

                const asEvent = await confirmDialog(
                    'Put this on your calendar?',
                    `${why} — it sounds like a commitment rather than work to fit in.`,
                    { confirmText: 'Add to calendar', cancelText: 'Keep as a task' }
                );

                if (asEvent) {
                    const eventResponse = await ipcRenderer.invoke('parse-smart-event', text);
                    const parsed = JSON.parse(eventResponse);
                    const events = Array.isArray(parsed) ? parsed : [parsed];

                    if (parsed.error) { toast.error('Oops: ' + parsed.error); return; }

                    for (const ev of events) {
                        // The end time came out of the sentence, so it isn't
                        // thrown away on the way to the calendar.
                        if (f.durationMinutes) ev.durationMinutes = f.durationMinutes;
                        await ipcRenderer.invoke('save-event', ev);
                    }

                    smartTaskInput.value = '';
                    if (categoryInput) categoryInput.value = '';
                    addTaskModal.style.display = 'none';
                    await loadAndRenderEvents();
                    await loadAndRenderWeeklyBoard();
                    await loadAndRenderHome();
                    toast.success('Added to your week.', 'Fixed commitment');
                    return;
                }

                // Kept as a task after all.
                response = await ipcRenderer.invoke('add-smart-task', text, category, { forceTask: true });
                result = JSON.parse(response);
            }

            if (result.error) {
                toast.error("Oops: " + result.error);
            } else {
                smartTaskInput.value = '';
                if (categoryInput) categoryInput.value = '';
                addTaskModal.style.display = 'none';
                await loadAndRenderTasks();
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
async function refreshTaskViews() {
    await loadAndRenderTasks();
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
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => loadAndRenderTasks(), 180);
    });
}

if (taskSearchClear) {
    taskSearchClear.addEventListener('click', () => {
        taskSearchQuery = '';
        if (taskSearchInput) taskSearchInput.value = '';
        if (taskSearchBox) taskSearchBox.classList.remove('has-value');
        loadAndRenderTasks();
    });
}

document.querySelectorAll('#task-status-filters .filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
        document.querySelectorAll('#task-status-filters .filter-chip')
            .forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        activeTaskStatusFilter = chip.dataset.filter;
        loadAndRenderTasks();
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

// Set when a planned calendar block is clicked, read once by the task list.
let highlightTaskId = null;

async function loadAndRenderTasks() {
    const tasksListContainer = document.querySelector('.tasks-list');
    if (!tasksListContainer) return;

    // Skeleton first: a blank region during a fetch is indistinguishable
    // from "you have nothing", which is misleading and feels broken.
    renderSkeleton(tasksListContainer, 3);

    const tasks = await ipcRenderer.invoke('get-tasks');

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
                loadAndRenderTasks();
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

        const taskCard = document.createElement('div');
        taskCard.className = 'card task-card-full' + (task.status === 'completed' ? ' is-done' : '');

        // Arrived here by clicking a planned block in the calendar. Marking
        // and scrolling to it is the whole point of the link - landing on a
        // list of thirty tasks and being left to find the right one is not
        // an answer.
        if (highlightTaskId && task.id === highlightTaskId) {
            taskCard.classList.add('task-card--highlight');
            requestAnimationFrame(() => {
                taskCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // One-shot: it marks the arrival, not a state the task is in.
                setTimeout(() => taskCard.classList.remove('task-card--highlight'), 2500);
            });
            highlightTaskId = null;
        }

        taskCard.innerHTML = `
            <div class="task-main-row">
                <label class="task-select" title="Select for bulk actions">
                    <input type="checkbox" class="task-select__box" ${selectedTaskIds.has(task.id) ? 'checked' : ''} />
                    <span class="ms-sr-only">Select task</span>
                </label>
                <div class="task-info-col">
                    <div class="task-title-text" dir="auto">${escapeHtml(task.title)}</div>
                    <div class="task-meta-line">
                        ${icon('calendar')} ${escapeHtml(task.date || 'Not set')} •
                        <select class="urgency-select" style="color: ${urgencyColor};">
                            <option value="Normal" ${task.urgency === 'Normal' ? 'selected' : ''}>Normal</option>
                            <option value="Medium" ${task.urgency === 'Medium' ? 'selected' : ''}>Medium</option>
                            <option value="High" ${task.urgency === 'High' ? 'selected' : ''}>High</option>
                            <option value="Urgent" ${task.urgency === 'Urgent' ? 'selected' : ''}>Urgent</option>
                        </select>
                        ${task.category ? ` • <span class="task-category-tag">${escapeHtml(task.category)}</span>` : ''}
                    </div>
                    ${hasChecklist ? `
                    <div class="progress-row">
                        <div class="progress-track"><div class="progress-fill" style="width: ${percent}%;"></div></div>
                        <span class="progress-label">${done}/${total} • ${percent}%</span>
                    </div>` : ''}
                </div>
                <div class="task-actions-col">
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

            await ipcRenderer.invoke('clear-events-for-task', task.id);
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

            // No points are awarded here any more. Finishing a task is worth
            // something because the task is finished, and a product whose
            // whole claim is an honest account of what you know shouldn't
            // also be inflating a score for showing up.

            // A finished task has no business still occupying three hours of
            // Thursday. Its planned blocks go with it - only the planned
            // ones, so a block the user placed by hand survives.
            await ipcRenderer.invoke('clear-events-for-task', task.id);

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
            <div class="folder-name">${folder.name}</div>
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
                    <div class="file-name">${file.name}</div>
                    <div class="file-meta">Folder: ${file.folder}</div>
                </div>
            </div>
            <div class="file-actions" style="display:flex; gap:8px; flex-wrap:wrap;">
                <button class="btn-secondary btn-extract">${icon('brain')} Extract Tasks</button>
                <button class="btn-primary btn-ai">${icon('sparkle')} Summarize</button>
                <button class="btn-secondary delete-file-btn">${icon('trash')} Delete</button>
            </div>
        `;

        fileItem.querySelector('.btn-ai').onclick = () => openAiSummary(file.content);
        
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
        if (!result || result.error) return;
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
// The study analytics, on the screen that exists to answer "how am I doing".
// Deck-wide rather than per-subject: this is the reflective view, and the
// subject-by-subject comparison below is what breaks it down.
async function renderStudyAnalytics() {
    const card = document.getElementById('study-analytics-card');
    if (!card) return;

    const stats = lastStudyStats || await ipcRenderer.invoke('get-study-stats');
    if (!stats) { card.hidden = true; return; }
    lastStudyStats = stats;

    renderConfidenceMix(stats.calibration);
    renderSureTrend(stats.trend);
    renderPace(stats.pace);
    renderSubjectCalibration(stats.subjectCalibration);

    // With no review history at all, every panel inside renders empty - so
    // the card would be a heading over nothing.
    card.hidden = !(stats.reviewsAllTime > 0);
}

// The link from Study across to it.
const studyProgressLink = document.getElementById('study-progress-link');
if (studyProgressLink) {
    studyProgressLink.onclick = () => {
        const nav = document.getElementById('nav-progress');
        if (nav) nav.click();
    };
}

async function loadAndRenderProgress() {
    const progressView = document.getElementById('view-progress');
    if (!progressView) return;

    renderStudyAnalytics();

    // The two numbers this screen now leads with come from the study record,
    // not from a points system: how much you have actually answered, and how
    // often "I'm sure" turned out to be true.
    const stats = lastStudyStats || await ipcRenderer.invoke('get-study-stats');
    if (stats) {
        lastStudyStats = stats;
        const reviewsEl = document.getElementById('metric-reviews');
        if (reviewsEl) reviewsEl.textContent = stats.reviewsAllTime || 0;

        const sureEl = document.getElementById('metric-sure-accuracy');
        const sure = stats.calibration && stats.calibration.sure;
        if (sureEl) {
            // An em dash, not 0%: no data and "wrong every time" are not the
            // same claim, and this panel of all places must not confuse them.
            sureEl.textContent = (sure && sure.accuracy !== null && sure.total >= CALIBRATION_MIN_REVIEWS)
                ? `${sure.accuracy}%`
                : '—';
        }
    }

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
// 11. Onboarding & Profile Settings
// ==========================================
async function loadProfile() {
    const profile = await ipcRenderer.invoke('get-profile');
    const onboardScreen = document.getElementById('onboarding-screen');
    
    const nameEl = document.getElementById('sidebar-profile-name');
    const degreeEl = document.getElementById('sidebar-profile-degree');
    const picEl = document.getElementById('sidebar-profile-pic');
    const homeGreeting = document.getElementById('home-greeting-main');

    const settingsName = document.getElementById('settings-profile-name');
    const settingsMeta = document.getElementById('settings-profile-meta');
    const settingsPic = document.getElementById('settings-profile-pic');

    if (!profile || !profile.name) {
        if (onboardScreen) onboardScreen.style.display = 'flex';
    } else {
        if (onboardScreen) onboardScreen.style.display = 'none';
        
        if (nameEl) nameEl.innerText = profile.name;
        if (degreeEl) degreeEl.innerText = profile.degree || 'Student';
        if (picEl) picEl.innerText = profile.name.charAt(0);
        if (homeGreeting) homeGreeting.innerText = `Hello, ${profile.name} 👋`;

        if (settingsName) settingsName.innerText = profile.name;
        if (settingsMeta) settingsMeta.innerText = profile.degree || 'Student';
        if (settingsPic) settingsPic.innerText = profile.name.charAt(0);
    }
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

        finishOnboardBtn.innerText = 'Preparing workspace... ⏳';
        
        await ipcRenderer.invoke('save-profile', { name: nameInput, degree: degreeInput });
        await loadProfile();
    };
}

loadProfile();

const settingsEditBtn = document.getElementById('settings-edit-btn');
if (settingsEditBtn) {
    settingsEditBtn.onclick = () => {
        const onboardScreen = document.getElementById('onboarding-screen');
        if (onboardScreen) {
            onboardScreen.style.display = 'flex';
            document.getElementById('finish-onboard-btn').innerText = 'Save Changes';
        }
    };
}

const notifBtn = document.getElementById('toggle-notif-btn');
const NOTIF_KEY = 'mindsync.notifications';

// The button used to set inline styles for the "on" case only, so the "Off"
// state fell back to an unstyled browser button. Both states are now real CSS
// classes, and the choice persists across restarts instead of resetting to on.
function applyNotifState(enabled) {
    if (!notifBtn) return;
    notifBtn.classList.toggle('active', enabled);
    notifBtn.textContent = enabled ? 'Active' : 'Off';
    notifBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    localStorage.setItem(NOTIF_KEY, enabled ? '1' : '0');
}

if (notifBtn) {
    notifBtn.onclick = () => {
        const nowEnabled = !notifBtn.classList.contains('active');
        applyNotifState(nowEnabled);

        if (nowEnabled) {
            // Browser/Electron notifications need OS permission; without this
            // the toggle could read "Active" while nothing ever appeared.
            if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
                Notification.requestPermission();
            }
            toast.success('You will be alerted 10 minutes before an event.', 'Notifications on');
        } else {
            toast.info('Event reminders are paused.', 'Notifications off');
        }
    };

    // Default to on for a first run, otherwise restore the saved choice.
    applyNotifState(localStorage.getItem(NOTIF_KEY) !== '0');
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
    
    if (timelineList) timelineList.innerHTML = '';
    
    if (todayEvents.length === 0) {
        if (timelineList) timelineList.innerHTML = '<div style="text-align:center; color: var(--text-secondary); padding: 20px;">No events planned for today. 🎉</div>';
        if (nextTitle) nextTitle.innerText = "Your day is free";
        if (nextTime) nextTime.innerText = "You can rest or crush some tasks!";
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
                    <span ${isNext ? 'style="font-weight: bold;"' : ''}>${evt.title}</span>
                    ${isNext ? '<span class="tag-active" style="margin-left:8px;">Next</span>' : ''}
                </div>
                <div class="timeline-time" ${isNext ? 'style="font-weight: bold;"' : ''}>${evt.time}</div>
            `;
            if (timelineList) timelineList.appendChild(div);
        });

        if (!nextEventFound) {
            if (nextTitle) nextTitle.innerText = "Done for today!";
            if (nextTime) nextTime.innerText = "All today's events have passed. See you tomorrow 🌙";
        }
    }
    
    const hour = new Date().getHours();
    let greeting = "Good night";
    if (hour >= 6 && hour < 12) greeting = "Good morning";
    else if (hour >= 12 && hour < 18) greeting = "Good afternoon";
    else if (hour >= 18 && hour < 22) greeting = "Good evening";
    
    const greetingEl = document.getElementById('home-greeting-sub');
    if (greetingEl) greetingEl.innerText = greeting;
}

const navHomeBtn = document.getElementById('nav-home');
if (navHomeBtn) {
    navHomeBtn.addEventListener('click', loadAndRenderHome);
}

loadAndRenderHome();

const resetBtn = document.getElementById('settings-hard-reset-btn');
if (resetBtn) {
    resetBtn.onclick = async () => {
        const sure = await confirmDialog("Reset everything?", "This deletes all tasks, calendar events, folders and XP. Your profile is kept. This cannot be undone.", { confirmText: "Reset everything", danger: true });
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
// ==========================================
// Planning the week
// ==========================================
// This used to send the tasks and the calendar to the model and ask it for a
// schedule. Placing appointments is the wrong job for a language model: it
// answers differently every time, can't be checked, and will cheerfully put
// two things in the same hour. Fitting work around fixed commitments is
// arithmetic, and weekPlanner.js does it the same way every time.
//
// The model's job is upstream - reading "hand in the stats exercise by
// Thursday, about two hours" and turning it into a deadline and a length.
// Interpretation for the model, arithmetic for the code.
const generateWeeklyAiBtn = document.getElementById('generate-weekly-ai-btn');
if (generateWeeklyAiBtn) {
    generateWeeklyAiBtn.onclick = async () => {
        const allTasks = await ipcRenderer.invoke('get-tasks') || [];
        const events = await ipcRenderer.invoke('get-events') || [];

        const openTasks = allTasks.filter(t => t.status !== 'completed');
        if (openTasks.length === 0) {
            toast.info('No open tasks to plan. Add some first.', 'Nothing to schedule');
            return;
        }

        // Previously placed blocks are excluded from the busy set, or the
        // planner would treat last week's plan as immovable furniture and
        // find no room at all.
        const fixedEvents = events.filter(e => !e.autoScheduled);
        const { blocks, unplaced, freeMinutes } = planWeek(openTasks, fixedEvents);

        if (blocks.length === 0) {
            toast.error('There is no free time left in the week to put anything in.', 'Nothing could be scheduled');
            return;
        }

        // Show the plan before touching the calendar. This rewrites the
        // week, and a rewrite you didn't agree to is the fastest way to lose
        // someone's trust in a planner.
        const preview = blocks
            .slice(0, 12)
            .map(b => `${b.day.slice(0, 3)} ${b.time} · ${b.durationMinutes}m · ${b.title}`)
            .join('\n');

        const tail = blocks.length > 12 ? `\n… and ${blocks.length - 12} more` : '';
        const leftOut = unplaced.length
            ? `\n\nNot scheduled: ${unplaced.map(u => `${u.title} (${u.reason})`).join('; ')}`
            : '';

        const ok = await confirmDialog(
            `Plan ${blocks.length} block(s) across your week?`,
            `${preview}${tail}${leftOut}\n\nAny blocks from a previous plan are replaced. Events you added yourself are left alone.`,
            { confirmText: 'Add to my week' }
        );
        if (!ok) return;

        const originalText = generateWeeklyAiBtn.innerHTML;
        generateWeeklyAiBtn.innerHTML = 'Planning…';
        generateWeeklyAiBtn.disabled = true;

        try {
            await ipcRenderer.invoke('clear-auto-scheduled-events');

            let failed = 0;
            for (const block of blocks) {
                const res = await ipcRenderer.invoke('save-event', {
                    title: block.title,
                    day: block.day,
                    time: block.time,
                    type: 'study',
                    durationMinutes: block.durationMinutes,
                    autoScheduled: true,
                    task: block.taskId || null
                });
                if (res && res.error) { failed += 1; console.error('Save plan block failed:', res.error, block); }
            }

            await loadAndRenderEvents();
            await loadAndRenderWeeklyBoard();
            await loadAndRenderHome();

            const hours = Math.round(freeMinutes / 60);
            if (failed > 0) toast.error(`${failed} block(s) could not be saved.`, 'Partly planned');
            else toast.success(`${blocks.length} block(s) placed. You had about ${hours} free hours this week.`, 'Week planned');
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
function showNotification(title, message) {
    // בודק אם המשתמש כיבה התראות במסך ההגדרות
    const notifBtn = document.getElementById('toggle-notif-btn');
    const isEnabled = notifBtn ? notifBtn.classList.contains('active') : true;
    if (!isEnabled) return;

    // 1. התראה פנימית - now uses the same toast system as the rest of the app,
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
        loadAndRenderTasks();
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

        await runBulk(async (id) => {
            await ipcRenderer.invoke('clear-events-for-task', id);
            return ipcRenderer.invoke('delete-task', id);
        }, `Deleted ${count} task(s).`);

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
    await loadAndRenderTasks();
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
                <div class="ms-modal__body">
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
                <div class="ms-modal__body">
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
            close({
                title,
                date: dateInput.value.trim() || 'Not set',
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

    // "/" jumps to search, like most web apps. Slash sits on the same physical
    // key in both layouts, so Code covers Hebrew too.
    if (e.code === 'Slash' && !e.ctrlKey && !e.metaKey) {
        const search = document.getElementById('task-search-input');
        if (search) { e.preventDefault(); search.focus(); }
        return;
    }

    // Escape clears any bulk selection.
    if (e.key === 'Escape' && selectedTaskIds.size > 0) {
        selectedTaskIds.clear();
        updateBulkBar();
        loadAndRenderTasks();
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
                <div class="ms-modal__body">
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

// Which subject the next session draws from. '' means every subject.
//
// Persisted, because it is a statement about what you are studying this week,
// not a per-visit whim: someone revising for a databases exam wants databases
// tomorrow too, and re-picking it on every visit is friction with no purpose.
const STUDY_CATEGORY_KEY = 'mindsync.studyCategory';
// Records that a choice was made at all, so that picking "All subjects"
// deliberately is remembered rather than re-defaulting to one subject on the
// next visit - an empty category and "never chose" are different states.
const STUDY_CATEGORY_PICKED_KEY = 'mindsync.studyCategoryPicked';
let studyCategory = localStorage.getItem(STUDY_CATEGORY_KEY) || '';
let lastStudyStats = null;

const studyState = {
    queue: [],
    index: 0,
    // The subject this session was drawn from, kept so its saved place goes
    // back to the right slot even after the home screen switches subject.
    category: '',
    confidence: null,
    startedAt: null,
    session: { reviewed: 0, correct: 0, overconfident: 0 }
};

// Sessions survive leaving the screen and closing the app, and there is one
// per subject.
//
// Reviews are already saved to the server one at a time, so no answer was
// ever lost - but the PLACE in the queue was, so stopping at question 5 of 20
// meant starting from the top next time.
//
// One shared slot was not enough once subjects existed: pausing halfway
// through data structures and then studying advanced programming silently
// destroyed the first session, which made having separate subjects
// pointless. Each subject now keeps its own place, so you can leave one
// mid-way, work on another, and come back to both exactly where you were.
const SESSION_KEY = 'mindsync.activeSessions';
const LEGACY_SESSION_KEY = 'mindsync.activeSession';
const ALL_SUBJECTS = '';   // the key a session covering every subject is stored under

function readAllSessions() {
    let map = {};
    try {
        map = JSON.parse(localStorage.getItem(SESSION_KEY)) || {};
        if (typeof map !== 'object' || Array.isArray(map)) map = {};
    } catch { map = {}; }

    // One-time carry-over from the single-slot format, so an in-progress
    // session isn't thrown away by the upgrade itself.
    try {
        const legacy = localStorage.getItem(LEGACY_SESSION_KEY);
        if (legacy) {
            const parsed = JSON.parse(legacy);
            if (parsed && Array.isArray(parsed.ids)) {
                map[parsed.category || ALL_SUBJECTS] = parsed;
                localStorage.setItem(SESSION_KEY, JSON.stringify(map));
            }
            localStorage.removeItem(LEGACY_SESSION_KEY);
        }
    } catch { /* a corrupt legacy value is not worth failing over */ }

    // A day-old session is stale: the schedule has moved on and different
    // items are due, so resuming it would be reviewing the wrong things.
    let changed = false;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    Object.keys(map).forEach(key => {
        const entry = map[key];
        if (!entry || !Array.isArray(entry.ids) || !(entry.savedAt > dayAgo)) {
            delete map[key];
            changed = true;
        }
    });
    if (changed) writeAllSessions(map);

    return map;
}

function writeAllSessions(map) {
    try {
        if (Object.keys(map).length === 0) localStorage.removeItem(SESSION_KEY);
        else localStorage.setItem(SESSION_KEY, JSON.stringify(map));
    } catch (e) { /* storage full or unavailable - not worth failing over */ }
}

function saveSessionProgress() {
    // The subject the session was STARTED with, not whatever is selected on
    // the home screen now - those can differ the moment the user goes back
    // and switches while a session is paused.
    const key = studyState.category || ALL_SUBJECTS;
    const map = readAllSessions();

    if (!studyState.queue.length || studyState.index >= studyState.queue.length) {
        delete map[key];
    } else {
        map[key] = {
            // Only ids are stored; the items themselves are re-fetched so a
            // resumed session never shows stale content.
            ids: studyState.queue.map(i => i.id),
            index: studyState.index,
            session: studyState.session,
            category: studyState.category,
            savedAt: Date.now()
        };
    }
    writeAllSessions(map);
    renderResumeBanner();
}

function readSessionProgress(category = studyCategory) {
    return readAllSessions()[category || ALL_SUBJECTS] || null;
}

function clearSessionProgress(category = studyState.category ?? studyCategory) {
    const map = readAllSessions();
    delete map[category || ALL_SUBJECTS];
    writeAllSessions(map);
    renderResumeBanner();
}

// The banner is a view of storage and nothing else, so it is redrawn wherever
// that storage changes rather than only inside loadStudyHome().
//
// It shows the session for the subject currently selected. A paused session
// in another subject is not gone - switch to that subject and it is there.
function renderResumeBanner() {
    const startBtn = document.getElementById('start-study-btn');
    const freshBtn = document.getElementById('start-fresh-btn');
    if (!startBtn) return;

    const resume = readSessionProgress(studyCategory);
    const hasResume = resume && Array.isArray(resume.ids) && resume.index < resume.ids.length;

    if (hasResume) {
        startBtn.innerHTML = `${icon('sparkle', { size: 18 })} Continue — ${resume.index + 1} of ${resume.ids.length}`;
        startBtn.title = `${resume.ids.length - resume.index} questions left in this session`;
    } else {
        startBtn.innerHTML = `${icon('sparkle', { size: 18 })} Start session`;
        startBtn.removeAttribute('title');
    }
    if (freshBtn) freshBtn.hidden = !hasResume;
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

    // Kept so switching subject is a redraw, not a round trip.
    lastStudyStats = stats;

    renderSubjectPicker(stats.subjects);

    // Every headline number follows the chosen subject. Showing the whole
    // deck's counts above a button that studies one course would make the
    // screen lie about what pressing it does.
    set('study-reviews-count', stats.reviewsAllTime);
    applyStudyScope();

    // Sidebar badge - the only nudge to come back, so it stays on the whole
    // deck: something due in another course is still something due.
    const badge = document.getElementById('study-due-badge');
    if (badge) {
        badge.textContent = stats.dueCount;
        badge.hidden = stats.dueCount === 0;
    }

    // Offer to pick up where you left off, before anything else on the page.
    renderResumeBanner();

}

function renderSubjectPicker(subjects) {
    const wrap = document.getElementById('subject-picker');
    const filters = document.getElementById('subject-filters');
    if (!wrap || !filters) return;

    const list = Array.isArray(subjects) ? subjects : [];

    // With one subject there is nothing to choose between, and a picker
    // offering a single option is just noise on the screen.
    if (list.length < 2) {
        wrap.hidden = true;
        studyCategory = '';
        localStorage.removeItem(STUDY_CATEGORY_KEY);
        return;
    }
    wrap.hidden = false;

    // A subject deleted since the choice was made would otherwise leave the
    // session drawing from a category that no longer exists - and reporting
    // "nothing is due" forever.
    if (studyCategory && !list.some(s => s.category === studyCategory)) {
        studyCategory = '';
        localStorage.removeItem(STUDY_CATEGORY_KEY);
    }

    // No choice made yet: start on the subject with the most waiting rather
    // than on everything at once. Exams are in one subject at a time, so a
    // mixed queue is the wrong default - it just makes you switch context
    // between questions for no gain.
    if (!studyCategory && !localStorage.getItem(STUDY_CATEGORY_PICKED_KEY)) {
        const busiest = list.find(s => s.due > 0) || list[0];
        if (busiest) studyCategory = busiest.category;
    }

    const totalDue = list.reduce((sum, s) => sum + s.due, 0);
    const options = [{ category: '', label: 'All subjects', due: totalDue }]
        .concat(list.map(s => ({ category: s.category, label: s.category, due: s.due })));

    filters.innerHTML = options.map(o => `
        <button class="filter-chip ${o.category === studyCategory ? 'active' : ''}" data-category="${escapeHtml(o.category)}">
            ${escapeHtml(o.label)}${o.due > 0 ? ` <span class="filter-chip__count">${o.due}</span>` : ''}
        </button>`).join('');

    filters.querySelectorAll('.filter-chip').forEach(chip => {
        chip.onclick = () => {
            studyCategory = chip.dataset.category;
            localStorage.setItem(STUDY_CATEGORY_PICKED_KEY, '1');
            if (studyCategory) localStorage.setItem(STUDY_CATEGORY_KEY, studyCategory);
            else localStorage.removeItem(STUDY_CATEGORY_KEY);

            // Redraw from what is already in memory. Switching subject used
            // to call loadStudyHome(), which re-fetched /study/stats - and
            // that endpoint loads every item in the deck to recompute
            // calibration. A second of waiting to change which of two numbers
            // already on the screen is shown.
            //
            // Nothing about the deck changed here, only which slice of it we
            // are looking at, so no server call is needed at all.
            applyStudyScope();
            // Each subject has its own paused session, so the banner belongs
            // to whichever one is now selected.
            renderResumeBanner();
        };
    });
}

// The parts of the study screen that depend on which subject is selected.
// Everything they need comes from the last stats response, so switching
// subject is a redraw rather than a round trip.
function applyStudyScope() {
    const stats = lastStudyStats;
    if (!stats) return;

    const scope = studyCategory
        ? (stats.subjects || []).find(s => s.category === studyCategory)
        : null;

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('study-due-count', scope ? scope.due : stats.dueCount);
    set('study-total-count', scope ? scope.items : stats.totalItems);
    set('study-new-count', scope ? scope.neverReviewed : stats.newCount);

    document.querySelectorAll('#subject-filters .filter-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.category === studyCategory);
    });

    const subjectRow = studyCategory
        ? (stats.subjectCalibration || []).find(s => s.category === studyCategory)
        : null;

    // "How well you judge yourself" - about the subject in front of you when
    // one is selected. An average across courses you are not studying tonight
    // answers a question nobody asked.
    if (studyCategory) {
        // No row means the subject has too little history to say anything.
        // Falling back to the deck-wide report here would quietly describe
        // every other course while this one is selected.
        renderCalibration(
            subjectRow ? subjectRow.calibration : null,
            subjectRow ? subjectRow.total : 0,
            studyCategory
        );
    } else {
        renderCalibration(stats.calibration, stats.reviewsAllTime, '');
    }

    renderConfidentlyWrong(stats.confidentlyWrong);
}

const CALIBRATION_MIN_REVIEWS = 5;

// How often each confidence level gets claimed at all.
//
// The accuracy rows above answer "is 'I'm sure' trustworthy?". This answers
// "how freely do you reach for it?" - a different habit, and one worth seeing:
// someone who marks everything "I'm sure" has stopped making a judgement, and
// the calibration number above quietly stops measuring anything.
function renderConfidenceMix(cal) {
    const el = document.getElementById('confidence-mix-panel');
    if (!el) return;

    const buckets = [
        { key: 'sure',     label: "I'm sure",   tone: 'good' },
        { key: 'think_so', label: 'I think so', tone: 'ok'   },
        { key: 'guessing', label: 'Guessing',   tone: 'bad'  }
    ];

    const total = buckets.reduce((sum, b) => sum + ((cal && cal[b.key] && cal[b.key].total) || 0), 0);
    if (!cal || total === 0) { el.innerHTML = ''; return; }

    const segments = buckets.map(b => {
        const n = (cal[b.key] && cal[b.key].total) || 0;
        const pct = Math.round((n / total) * 100);
        return { ...b, n, pct };
    }).filter(b => b.n > 0);

    el.innerHTML = `
        <div class="mix-head">
            <span class="ms-text-sm">How often you say each</span>
            <span class="ms-muted ms-text-xs">${total} answers</span>
        </div>
        <div class="mix-bar">
            ${segments.map(b => `<div class="mix-seg cal-${b.tone}" style="width:${b.pct}%" title="${b.label}: ${b.n}"></div>`).join('')}
        </div>
        <div class="mix-legend">
            ${segments.map(b => `<span class="mix-legend__item"><i class="mix-dot cal-${b.tone}"></i>${b.label} ${b.pct}%</span>`).join('')}
        </div>`;
}

// Whether the gap is closing.
//
// The rows above say how often "I'm sure" is right. They never said whether
// that is improving - which, after a couple of weeks, is the only number that
// matters here. The product's claim is that seeing the gap closes it, and
// this is the line that either backs that up or doesn't.
function renderSureTrend(trend) {
    const el = document.getElementById('trend-panel');
    if (!el) return;
    if (!trend) { el.innerHTML = ''; return; }

    const delta = trend.recent - trend.earlier;
    const tone = delta >= 8 ? 'good' : delta <= -8 ? 'bad' : 'ok';
    const verdict = delta >= 8
        ? 'Your judgement is getting more reliable.'
        : delta <= -8
            ? 'Your judgement has slipped — worth slowing down on the ones that feel obvious.'
            : 'Holding steady.';

    el.innerHTML = `
        <div class="trend">
            <div class="trend__title ms-text-sm">Is the gap closing?</div>
            <div class="trend__pair">
                <div class="trend__side">
                    <div class="trend__value ms-tabular">${trend.earlier}%</div>
                    <div class="trend__label ms-text-xs ms-muted">first ${trend.earlierCount}</div>
                </div>
                <div class="trend__arrow cal-${tone}">${delta > 0 ? '↗' : delta < 0 ? '↘' : '→'}</div>
                <div class="trend__side">
                    <div class="trend__value ms-tabular cal-${tone}">${trend.recent}%</div>
                    <div class="trend__label ms-text-xs ms-muted">last ${trend.recentCount}</div>
                </div>
            </div>
            <div class="trend__note ms-text-xs ms-muted">Right when you said "I'm sure". ${verdict}</div>
        </div>`;
}

// Speed against accuracy.
//
// secondsSpent has been recorded since the beginning and nothing ever read
// it. Comparing the student's own fastest third against their slowest third
// asks whether rushing costs THEM accuracy, in their own units - a fixed
// "under 10 seconds" would mean different things on a definition and on a
// Java exercise.
function renderPace(pace) {
    const el = document.getElementById('pace-panel');
    if (!el) return;
    if (!pace) { el.innerHTML = ''; return; }

    // Enough answers to look at, but they were all answered at much the same
    // speed - so there is no fast group and slow group to compare.
    if (pace.tooUniform) {
        el.innerHTML = `
            <div class="trend">
                <div class="trend__title ms-text-sm">Does rushing cost you?</div>
                <div class="trend__note ms-text-xs ms-muted">
                    You spend about the same time on everything (${pace.fastSeconds}s to ${pace.slowSeconds}s),
                    so there's no fast group and slow group to compare yet.
                </div>
            </div>`;
        return;
    }

    const gap = pace.slowAccuracy - pace.fastAccuracy;
    const note = gap >= 15
        ? 'Rushing is costing you. The ones that feel obvious are where marks go.'
        : gap <= -15
            ? 'You do better at speed — sitting longer may mean second-guessing a right answer.'
            : 'Speed makes little difference to you either way.';

    el.innerHTML = `
        <div class="trend">
            <div class="trend__title ms-text-sm">Does rushing cost you?</div>
            <div class="pace-row">
                <span>Quickest answers <span class="ms-muted">(~${pace.fastSeconds}s)</span></span>
                <strong class="ms-tabular cal-${pace.fastAccuracy < pace.slowAccuracy ? 'bad' : 'good'}">${pace.fastAccuracy}%</strong>
            </div>
            <div class="pace-row">
                <span>Slowest answers <span class="ms-muted">(~${pace.slowSeconds}s)</span></span>
                <strong class="ms-tabular cal-${pace.slowAccuracy >= pace.fastAccuracy ? 'good' : 'bad'}">${pace.slowAccuracy}%</strong>
            </div>
            <div class="trend__note ms-text-xs ms-muted">${note}</div>
        </div>`;
}

function renderCalibration(cal, totalReviews, subject = '') {
    const el = document.getElementById('calibration-panel');
    if (!el) return;

    // Below a handful of reviews this says nothing real, and a misleading
    // number here would undermine the whole point of the feature.
    //
    // Five rather than eight: a subject can legitimately produce only seven
    // or eight questions, and a threshold that a whole subject cannot reach
    // on its first pass is a panel that never appears.
    if (!cal || totalReviews < CALIBRATION_MIN_REVIEWS) {
        const left = Math.max(0, CALIBRATION_MIN_REVIEWS - (totalReviews || 0));
        const where = subject ? ` in ${bidiName(subject)}` : '';
        el.innerHTML = `<div class="ms-muted ms-text-sm">Answer about ${left} more questions${where} and this will show how reliable your sense of "I know this" actually is.</div>`;
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
            </div>`;
    }).join('');

    const gap = cal.overconfidenceGap;
    if (gap !== null && gap > 15) {
        el.innerHTML += `<div class="cal-verdict cal-verdict--warn">When you feel certain, you're wrong about ${100 - cal.sure.accuracy}% of the time. That gap is where marks get lost — slow down on the ones that feel obvious.</div>`;
    } else if (gap !== null) {
        el.innerHTML += `<div class="cal-verdict cal-verdict--good">Your sense of what you know is reliable. Trust it.</div>`;
    }
}

// ---- Calibration by subject ----
//
// Rendering only. The grouping and the thresholds live on the server, in
// GET /api/study/stats, which already has every item in memory for the
// global report - computing it again here meant fetching the whole deck a
// second time, and over a slightly different set of items (that endpoint
// excludes suspended ones, GET /api/study does not), so the two panels on
// this screen could disagree.

function renderSubjectCalibration(rows) {
    const el = document.getElementById('subject-calibration-panel');
    if (!el) return;

    // Nothing worth saying yet: stay silent rather than adding an empty
    // section. The panel above already explains the "keep going" state.
    if (!rows || rows.length === 0) { el.innerHTML = ''; return; }

    let html = '<div class="ms-text-sm ms-muted" style="margin: var(--space-5) 0 var(--space-3)">Where that number comes apart:</div>';

    html += rows.map(r => {
        if (r.sureAccuracy === null) {
            return `
                <div class="cal-row">
                    <div class="cal-row__head">
                        <span>${escapeHtml(r.category)}</span>
                        <span class="ms-muted ms-text-xs">${r.accuracy}% overall</span>
                    </div>
                    <div class="cal-row__note ms-text-xs ms-muted">Not enough "I'm sure" answers here yet</div>
                </div>`;
        }
        // Measured against the same 95% ideal as the global panel: saying
        // "I'm sure" should mean being right almost every time.
        const off = Math.abs(r.sureAccuracy - 95);
        const tone = off <= 12 ? 'good' : off <= 25 ? 'ok' : 'bad';
        return `
            <div class="cal-row">
                <div class="cal-row__head">
                    <span>${escapeHtml(r.category)}</span>
                    <span class="cal-row__value cal-${tone}">${r.sureAccuracy}% right when sure</span>
                </div>
                <div class="cal-track">
                    <div class="cal-fill cal-${tone}" style="width:${r.sureAccuracy}%"></div>
                    <div class="cal-ideal" style="left:95%" title="Well-calibrated: about 95%"></div>
                </div>
                <div class="cal-row__note ms-text-xs ms-muted">${r.sureCorrect} of ${r.sureTotal} · ${r.accuracy}% overall across ${r.total} reviews</div>
            </div>`;
    }).join('');

    // The line worth reading. Only shown when the gap is wide enough to act
    // on - naming a 4-point difference as a weakness would be inventing one.
    const scored = rows.filter(r => r.sureAccuracy !== null);
    if (scored.length >= 2) {
        const worst = scored[0];
        const best = scored[scored.length - 1];
        if (best.sureAccuracy - worst.sureAccuracy >= 20) {
            // Laid out as rows rather than one sentence: two long Hebrew
            // course names inside an English sentence wrapped mid-name and
            // scrambled the punctuation between them.
            html += `
                <div class="cal-verdict cal-verdict--warn">
                    <div class="cal-verdict__row">
                        <span class="cal-verdict__label">Reliable in</span>
                        <span class="cal-verdict__name">${bidiName(best.category)}</span>
                        <span class="cal-verdict__pct">${best.sureAccuracy}%</span>
                    </div>
                    <div class="cal-verdict__row">
                        <span class="cal-verdict__label">Not in</span>
                        <span class="cal-verdict__name">${bidiName(worst.category)}</span>
                        <span class="cal-verdict__pct">${worst.sureAccuracy}%</span>
                    </div>
                    <div class="cal-verdict__tail">Both are "I'm sure" answers. The single number above averages them together and hides the gap — the second one is where tonight goes.</div>
                </div>`;
        }
    }

    el.innerHTML = html;
}

// A course name dropped into an English sentence has to be isolated, or the
// bidi algorithm reorders the sentence around it. Every interpolation of a
// subject name goes through this.
function bidiName(text) {
    return `<span class="bidi-name" dir="auto">${escapeHtml(text)}</span>`;
}

// Cap the list. Past a handful this stops being "here is what to fix
// tonight" and becomes a wall of text nobody reads - which is the same as
// showing nothing, only noisier.
const CONFIDENTLY_WRONG_SHOWN = 5;

function renderConfidentlyWrong(items) {
    const el = document.getElementById('confidently-wrong-panel');
    if (!el) return;

    // Scoped to the selected subject, like everything else on this screen.
    const all = (items || []).filter(i =>
        !studyCategory || ((i.category || '').trim() || 'Uncategorized') === studyCategory
    );

    if (all.length === 0) {
        el.innerHTML = studyCategory
            ? `<div class="ms-muted ms-text-sm">Nothing in ${bidiName(studyCategory)} that you were certain about has turned out wrong.</div>`
            : '<div class="ms-muted ms-text-sm">Nothing here yet — nothing you were certain about has turned out wrong.</div>';
        return;
    }

    const shown = all.slice(0, CONFIDENTLY_WRONG_SHOWN);
    el.innerHTML = shown.map((i, idx) => `
        <div class="attention-item" data-index="${idx}">
            <span class="attention-item__dot" style="background: var(--status-danger)"></span>
            <div class="attention-item__body">
                <div class="attention-item__title" dir="auto"></div>
                <div class="attention-item__meta">${escapeHtml(i.category || 'Uncategorized')} · ${MODE_LABELS[i.mode] || i.mode}</div>
            </div>
        </div>`).join('');

    // Filled in afterwards so a question carrying a Java class renders as a
    // formatted, left-to-right code block instead of a wall of braces and
    // stray ``` fences running right to left through the Hebrew.
    el.querySelectorAll('.attention-item').forEach(row => {
        const body = row.querySelector('.attention-item__title');
        renderRichText(body, shown[Number(row.dataset.index)].question);

        // A clamped code block with no way past it is worse than no code at
        // all: you can see there is more and you can't reach it.
        //
        // The toggle is added whenever there IS a code block, rather than
        // only when measurement says it overflows. Measuring here is
        // unreliable: this panel is also drawn while the Study view is still
        // display:none at startup, and a hidden element reports a height of
        // zero - so "is it clipped?" answered "no" for everything and the
        // toggle was never created at all.
        //
        // The measurement below only ever REMOVES a toggle that turned out
        // to be unnecessary, and only when the numbers are trustworthy. An
        // unnecessary toggle on a short snippet costs a line; a missing one
        // costs the code.
        // Every code block in the row, not just the first. A question that
        // shows a set of classes and then a main method carries two, both of
        // them clamped - expanding only one looked like the button was doing
        // nothing at all.
        const blocks = [...body.querySelectorAll('.code-block')];
        if (blocks.length === 0) return;

        const toggle = document.createElement('button');
        toggle.className = 'code-expand';
        toggle.textContent = 'Show the full code';
        toggle.onclick = () => {
            const open = toggle.dataset.expanded !== 'true';
            toggle.dataset.expanded = String(open);

            blocks.forEach(block => {
                // setProperty with 'important' rather than a class or a plain
                // inline style. Several rules in styles.css touch .code-block
                // and which one wins is not worth reasoning about from here -
                // the one thing this button must never do is nothing.
                if (open) {
                    block.style.setProperty('max-height', 'none', 'important');
                    block.style.setProperty('mask-image', 'none', 'important');
                    block.style.setProperty('-webkit-mask-image', 'none', 'important');
                } else {
                    block.style.removeProperty('max-height');
                    block.style.removeProperty('mask-image');
                    block.style.removeProperty('-webkit-mask-image');
                }
            });

            toggle.textContent = open ? 'Collapse' : 'Show the full code';
            // Temporary, so a click that still appears to do nothing can be
            // told apart from a click that never reached this handler.
            console.log(`[code-expand] ${open ? 'expanded' : 'collapsed'} ${blocks.length} block(s)`);
        };
        body.appendChild(toggle);

        requestAnimationFrame(() => {
            // clientHeight of 0 means the panel isn't laid out yet - measured
            // now, every answer would be wrong.
            const measurable = blocks.filter(b => b.clientHeight > 0);
            if (measurable.length === 0) return;
            const anyClipped = measurable.some(b => b.scrollHeight > b.clientHeight + 4);
            if (!anyClipped) toggle.remove();
        });
    });

    const hidden = all.length - shown.length;
    if (hidden > 0) {
        // appendChild, NOT `el.innerHTML += ...`.
        //
        // `+=` on innerHTML serialises the whole panel back to a string and
        // re-parses it, which destroys and recreates every node inside. The
        // expand buttons created above survived as markup but lost their
        // onclick handlers with the objects they were attached to - so they
        // looked perfect and did nothing.
        const more = document.createElement('div');
        more.className = 'ms-muted ms-text-xs';
        more.style.marginTop = 'var(--space-3)';
        more.textContent = `and ${hidden} more — they are all scheduled to come back.`;
        el.appendChild(more);
    }
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
            clearSessionProgress(resume.category || ALL_SUBJECTS);
            return startStudySession();
        }
    } else {
        // The chosen subject, or everything when none is chosen. The server
        // has supported this filter all along; nothing was ever passing it.
        items = await ipcRenderer.invoke('get-due-study-items', {
            limit: 20,
            ...(studyCategory ? { category: studyCategory } : {})
        });
        if (!items || items.length === 0) {
            toast.info(
                studyCategory
                    ? `Nothing is due in "${studyCategory}" right now. Switch subject, or come back later.`
                    : 'Nothing is due right now. Create questions from a file, or come back later.',
                'All caught up'
            );
            // Nothing opened, so the home screen stays - and it has to be
            // truthful about whether a paused session is still waiting.
            renderResumeBanner();
            return;
        }
    }

    studyState.queue = items;
    studyState.index = resume ? Math.min(resume.index, items.length - 1) : 0;
    studyState.session = resume ? resume.session : { reviewed: 0, correct: 0, overconfident: 0 };
    studyState.category = resume ? (resume.category || '') : studyCategory;

    clearManageSelection();
    document.getElementById('study-home').hidden = true;
    document.getElementById('study-summary').hidden = true;
    document.getElementById('study-review').hidden = true;
    document.getElementById('study-manage').hidden = true;
    document.getElementById('study-browse').hidden = true;
    document.getElementById('study-session').hidden = false;

    renderStudyCard();
}

// ---- Rendering text that may contain code ----
//
// A question is set into a div, and HTML collapses every newline into a
// space - so a Java class the model formatted across thirty lines arrived as
// one unbroken paragraph running right to left, with the braces and
// semicolons scattered through it. The line breaks were in the database the
// whole time; the screen was throwing them away.
//
// Code also has to be laid out left-to-right even inside a Hebrew question,
// or the bidi algorithm reorders the punctuation and the snippet stops
// matching what the student would see in an IDE.

// A line is treated as code if it ends in a brace or semicolon, or opens with
// a keyword that has no business in prose. Deliberately conservative: a
// paragraph misread as code looks broken, which is worse than a code block
// left as prose.
const CODE_LINE_RE = /[;{}]\s*$|^\s*(?:@\w+|public|private|protected|static|final|abstract|class|interface|enum|extends|implements|import|package|void|int|double|float|boolean|char|String|var|let|const|function|def|return|if|else|for|while|switch|case|break|new|try|catch|finally|throw|print|println|System\.|console\.|#include|using)\b/;

// The model formats code however it feels like, and "however it feels like"
// regularly means one 900-character line: the fence is there, the newlines
// are not. Asking the prompt nicely helps and does not solve it, so the
// layout is rebuilt here from the syntax itself - which works the same on
// every response, including the ones already sitting in the deck.
//
// Only Java/C/JS-shaped code has anything to key off. Python and pseudo-code
// pass through untouched, which is correct: their line breaks carry meaning
// and cannot be reconstructed.
function reindentCode(source) {
    const text = String(source || '').replace(/\r\n/g, '\n').trim();

    // Leave well-formatted code alone. Only step in when a line is too long
    // to read without scrolling sideways.
    const longestLine = text.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
    if (longestLine <= 90) return text;
    if (!text.includes(';') && !text.includes('{')) return text;

    const lines = [];
    let line = '';
    let depth = 0;
    let parens = 0;
    let inString = false;
    let inChar = false;
    let escaped = false;

    const flush = () => {
        const trimmed = line.trim();
        if (trimmed) lines.push('    '.repeat(Math.max(0, depth)) + trimmed);
        line = '';
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        // Inside a string literal nothing is punctuation. "Galaxy S23" and
        // "iOS" must survive, and a brace or semicolon in a string must never
        // start a new line.
        if (escaped) { line += ch; escaped = false; continue; }
        if ((inString || inChar) && ch === '\\') { line += ch; escaped = true; continue; }
        if (ch === '"' && !inChar) { inString = !inString; line += ch; continue; }
        if (ch === "'" && !inString) { inChar = !inChar; line += ch; continue; }
        if (inString || inChar) { line += ch; continue; }

        if (ch === '(') { parens++; line += ch; continue; }
        if (ch === ')') { parens = Math.max(0, parens - 1); line += ch; continue; }

        if (ch === '{') {
            if (line.endsWith(' ')) line = line.slice(0, -1);
            line += (line.trim() ? ' ' : '') + '{';
            flush();
            depth++;
            continue;
        }

        if (ch === '}') {
            flush();                     // whatever was before the brace
            depth--;
            line = '}';
            // Keep a trailing semicolon attached: "};" is one thing.
            if (text[i + 1] === ';') { line += ';'; i++; }
            flush();
            continue;
        }

        // A semicolon inside parentheses is a for-loop separator, not a
        // statement end: for (int i = 0; i < n; i++) stays on one line.
        if (ch === ';' && parens === 0) { line += ';'; flush(); continue; }

        if (ch === '\n') { flush(); continue; }

        // Collapse runs of whitespace the model left behind.
        if (/\s/.test(ch)) {
            // An annotation gets its own line, the way it is written in a file.
            if (/^@\w+$/.test(line.trim())) { flush(); continue; }
            if (line && !line.endsWith(' ')) line += ' ';
            continue;
        }

        line += ch;
    }
    flush();

    return lines.join('\n');
}

function makeCodeBlock(text) {
    const pre = document.createElement('pre');
    pre.className = 'code-block';
    // Explicit LTR: the snippet must read as code, not as part of the
    // surrounding Hebrew sentence.
    pre.setAttribute('dir', 'ltr');
    pre.textContent = reindentCode(text);
    return pre;
}

function makeProseBlock(text) {
    const div = document.createElement('div');
    div.className = 'rich-prose';
    div.setAttribute('dir', 'auto');
    div.textContent = text.replace(/^\n+|\n+$/g, '');
    return div;
}

// Triple-backtick fences are unambiguous, so they win wherever they appear.
function splitFenced(raw) {
    return raw
        .split(/```[a-zA-Z]*\n?/)
        .map((text, i) => ({ code: i % 2 === 1, text }))
        .filter(seg => seg.text.trim().length > 0);
}

// Without fences, group consecutive lines by whether they look like code.
function splitByHeuristic(raw) {
    const segments = [];
    let buffer = [];
    let bufferIsCode = null;

    const flush = () => {
        if (buffer.length) segments.push({ code: bufferIsCode, text: buffer.join('\n') });
        buffer = [];
    };

    raw.split('\n').forEach(line => {
        // A blank line belongs to whatever it sits inside - code blocks have
        // blank lines between methods, and splitting on them would shatter
        // one class into five separate blocks.
        if (!line.trim()) { buffer.push(line); return; }

        const isCode = CODE_LINE_RE.test(line);
        if (bufferIsCode === null) bufferIsCode = isCode;
        else if (isCode !== bufferIsCode) { flush(); bufferIsCode = isCode; }
        buffer.push(line);
    });
    flush();

    // One lone code-looking line is far more likely to be a sentence that
    // happens to end in a brace than an actual block.
    return segments.map(seg =>
        seg.code && seg.text.trim().split('\n').length < 2 ? { code: false, text: seg.text } : seg
    ).filter(seg => seg.text.trim().length > 0);
}

function renderRichText(el, text) {
    if (!el) return;
    el.textContent = '';
    const raw = String(text || '');
    const segments = raw.includes('```') ? splitFenced(raw) : splitByHeuristic(raw);

    // Nothing detected either way: fall back to the plain behaviour.
    if (segments.length === 0) { el.textContent = raw; return; }

    segments.forEach(seg => el.appendChild(seg.code ? makeCodeBlock(seg.text) : makeProseBlock(seg.text)));
}

function renderStudyCard() {
    const item = studyState.queue[studyState.index];
    if (!item) return finishStudySession();

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

    renderRichText(document.getElementById('study-question'), item.question);
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
        renderRichText(answerEl, item.answer);
        answerEl.classList.remove('study-answer--none');
        answerEl.classList.toggle('study-answer--ai', item.solutionSource === 'ai');

        // Say plainly who wrote the answer. A passage from the lecturer's own
        // slides and a solution an AI worked out deserve very different levels
        // of trust, and hiding that difference would undercut the one thing
        // this app promises: telling you the truth about what you know.
        if (labelEl) {
            if (item.solutionSource === 'ai') {
                labelEl.innerHTML = `<span class="ai-answer-flag">${icon('sparkle', { size: 13 })} AI-generated solution — worth checking</span>`;
            } else if (item.solutionSource === 'imported') {
                // Imported cards were written by someone else, against
                // material this app has never read. That is a third kind of
                // trust and it gets said out loud, like the other two.
                labelEl.textContent = item.sourceFile
                    ? `Imported — ${item.sourceFile}`
                    : 'Imported from another deck';
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
    // The answer just recorded changes this item's history and its place in
    // the browse groups.
    invalidateListCache('browse');

    if (studyState.index >= studyState.queue.length) finishStudySession();
    else renderStudyCard();
}

// Two ways out of a session, and they must not do the same thing.
//
// Reaching the end of the queue is a real finish: nothing is left to come back
// to, so the saved place is deleted.
//
// Clicking the exit button at question 5 of 20 is a PAUSE. Deleting the place
// there was a bug - every early exit sent you back to question 1 next time,
// which is exactly the friction the saved session was meant to remove.
function finishStudySession() {
    clearSessionProgress(studyState.category);
    showStudySummary(true);
}

function pauseStudySession() {
    // Left before answering anything: there is no place worth keeping, and a
    // "continue from question 1" banner is just noise.
    if (studyState.index === 0) {
        clearSessionProgress(studyState.category);
        studyState.queue = [];
        document.getElementById('study-session').hidden = true;
        document.getElementById('study-home').hidden = false;
        loadStudyHome();
        return;
    }
    saveSessionProgress();
    showStudySummary(false);
}

function showStudySummary(finished) {
    document.getElementById('study-session').hidden = true;
    document.getElementById('study-summary').hidden = false;

    const title = document.getElementById('study-summary-title');
    if (title) title.textContent = finished ? 'Session complete' : 'Session paused';

    const s = studyState.session;
    document.getElementById('summary-reviewed').textContent = s.reviewed;
    document.getElementById('summary-correct').textContent = s.correct;
    document.getElementById('summary-overconfident').textContent = s.overconfident;

    const parts = [];
    if (s.overconfident > 0) {
        parts.push(`${s.overconfident} question${s.overconfident === 1 ? '' : 's'} you felt sure about turned out wrong. Those are scheduled to come back quickly.`);
    } else if (s.reviewed > 0) {
        parts.push('Your confidence matched your results this session.');
    }
    if (!finished) {
        const left = studyState.queue.length - studyState.index;
        parts.push(`Your place is saved - ${left} question${left === 1 ? '' : 's'} left. Pick it up from the Study screen.`);
    }
    document.getElementById('summary-message').textContent = parts.join(' ');
}

const startStudyBtn = document.getElementById('start-study-btn');
// Wrapped, not passed directly: onclick hands the handler a MouseEvent, which
// would arrive as the `resume` argument and send a fresh session down the
// resume path with no ids - throwing, so the button appeared to do nothing.
if (startStudyBtn) startStudyBtn.onclick = () => {
    // One button, two meanings, and the label always says which. Splitting
    // "continue" into a separate banner meant the page height changed every
    // time you switched subject.
    const resume = readSessionProgress(studyCategory);
    const hasResume = resume && Array.isArray(resume.ids) && resume.index < resume.ids.length;
    startStudySession(hasResume ? resume : null);
};

const startFreshBtn = document.getElementById('start-fresh-btn');
if (startFreshBtn) startFreshBtn.onclick = async () => {
    clearSessionProgress(studyCategory);
    toast.info('Session cleared. Your answers were already saved.');
    await loadStudyHome();
};

const endStudyBtn = document.getElementById('end-study-btn');
// Wrapped for the same reason as start-study-btn: onclick hands the handler a
// MouseEvent, which would arrive as the `finished` flag and read as truthy.
if (endStudyBtn) endStudyBtn.onclick = () => pauseStudySession();

const summaryDoneBtn = document.getElementById('summary-done-btn');
if (summaryDoneBtn) summaryDoneBtn.onclick = async () => {
    document.getElementById('study-summary').hidden = true;
    document.getElementById('study-home').hidden = false;
    await loadStudyHome();
};

// ---- The "this is still working" overlay ----
//
// Generation is the one action in the app that can run for minutes. It has no
// intermediate output to show, so the only defence against looking crashed is
// to say what is happening and keep a clock running.
const aiProgress = {
    timer: null,
    startedAt: 0,

    show(title) {
        const box = document.getElementById('ai-progress');
        if (!box) return;
        this.startedAt = Date.now();
        document.getElementById('ai-progress-title').textContent = title;
        document.getElementById('ai-progress-detail').textContent = 'This usually takes under a minute.';
        document.getElementById('ai-progress-elapsed').textContent = '0s';
        box.hidden = false;

        clearInterval(this.timer);
        this.timer = setInterval(() => {
            const secs = Math.floor((Date.now() - this.startedAt) / 1000);
            const el = document.getElementById('ai-progress-elapsed');
            if (el) el.textContent = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;

            // After a while, say so. A minute of silence on a task the user
            // was told takes "under a minute" needs acknowledging, or they
            // start wondering whether to force-quit.
            if (secs === 75) {
                const detail = document.getElementById('ai-progress-detail');
                if (detail) detail.textContent = 'Taking longer than usual — the model may be busy. Still working.';
            }
        }, 1000);
    },

    update(message) {
        const detail = document.getElementById('ai-progress-detail');
        if (detail && message) detail.textContent = message;
    },

    hide() {
        clearInterval(this.timer);
        this.timer = null;
        const box = document.getElementById('ai-progress');
        if (box) box.hidden = true;
    }
};

// Sent by the main process from inside the AI call: retries, model switches,
// and the handover to validation.
ipcRenderer.on('ai-progress', (_event, message) => aiProgress.update(message));

// ---- Generating questions from an uploaded file ----
const generateStudyBtn = document.getElementById('generate-study-btn');
if (generateStudyBtn) {
    generateStudyBtn.onclick = async () => {
        // Light: names and paths only. The full text of one file is fetched
        // below, and only on the path that actually needs it. Served from the
        // warm cache when there is one, so the picker opens immediately.
        const files = listCache.get('files:light')
            || await ipcRenderer.invoke('get-files', { light: true });
        listCache.set('files:light', files);
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
        aiProgress.show(`Reading ${file.name}`);

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
            } else {
                // This is the only path that reads the extracted text, so
                // this is where that text is fetched.
                const full = await ipcRenderer.invoke('get-file', file.id);
                response = await ipcRenderer.invoke('generate-study-items', (full && full.content) || '', {
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
            // In `finally`, so a thrown error or an early return can never
            // leave the overlay stuck over a screen the user cannot reach.
            aiProgress.hide();
            generateStudyBtn.disabled = false;
            generateStudyBtn.innerHTML = originalHTML;
        }
    };
}

const navStudyBtn = document.getElementById('nav-study');
if (navStudyBtn) navStudyBtn.addEventListener('click', loadStudyHome);

loadStudyHome();

// ---- Reviewing what you've already answered ----
//
// Finishing a session made questions disappear: they were scheduled for some
// future date and there was no way to look at one again. This screen is that
// way back, and it is strictly read-only - opening a question here records
// nothing and reschedules nothing, so browsing can never corrupt the history
// the calibration numbers are built from.
//
// Grouped by how the LAST attempt went, using the same vocabulary the session
// itself uses, so the three groups mean exactly what the buttons meant.
const BROWSE_GROUPS = [
    { key: 'wrong',   label: 'Got it wrong', outcomes: ['missed', 'wrong'],    tone: 'danger'  },
    { key: 'partial', label: 'Partly',       outcomes: ['partial', 'stuck'],   tone: 'warning' },
    { key: 'correct', label: 'Got it right', outcomes: ['got_it', 'solved'],   tone: 'success' }
];

let browseGroup = 'wrong';   // the one worth opening first
let browseItems = [];

function lastOutcomeGroup(item) {
    const reviews = Array.isArray(item.reviews) ? item.reviews : [];
    if (reviews.length === 0) return null;
    const last = reviews[reviews.length - 1];
    const found = BROWSE_GROUPS.find(g => g.outcomes.includes(last.outcome));
    return found ? found.key : null;
}

async function openBrowseScreen() {
    document.getElementById('study-home').hidden = true;
    document.getElementById('study-summary').hidden = true;
    document.getElementById('study-session').hidden = true;
    document.getElementById('study-manage').hidden = true;
    document.getElementById('study-browse').hidden = false;

    const listEl = document.getElementById('browse-list');
    if (listEl) {
        listEl.innerHTML = `
            <div class="ms-skeleton ms-skeleton--card"></div>
            <div class="ms-skeleton ms-skeleton--card"></div>`;
    }

    const titleEl = document.getElementById('browse-title');
    if (titleEl) {
        titleEl.innerHTML = studyCategory
            ? `${bidiName(studyCategory)} — questions you've answered`
            : "Questions you've answered";
    }

    // Full items, not the light form: this screen is entirely about the
    // review history and the stored answer.
    const key = `browse:${studyCategory || '*'}`;
    await cachedFetch(
        key,
        () => ipcRenderer.invoke('get-study-items', studyCategory ? { category: studyCategory } : {}),
        {
            onData: (items) => {
                browseItems = (items || []).filter(i => Array.isArray(i.reviews) && i.reviews.length > 0);
                // Don't redraw over a screen the user has already left.
                if (!document.getElementById('study-browse').hidden) renderBrowseScreen();
            }
        }
    );
}

function renderBrowseScreen() {
    const filtersEl = document.getElementById('browse-outcome-filters');
    const listEl = document.getElementById('browse-list');
    if (!listEl) return;

    const counts = {};
    BROWSE_GROUPS.forEach(g => { counts[g.key] = 0; });
    browseItems.forEach(i => {
        const key = lastOutcomeGroup(i);
        if (key) counts[key] += 1;
    });

    // Land on a group that has something in it, rather than on an empty tab.
    if (counts[browseGroup] === 0) {
        const firstWithContent = BROWSE_GROUPS.find(g => counts[g.key] > 0);
        if (firstWithContent) browseGroup = firstWithContent.key;
    }

    if (filtersEl) {
        filtersEl.innerHTML = BROWSE_GROUPS.map(g => `
            <button class="filter-chip ${g.key === browseGroup ? 'active' : ''}" data-group="${g.key}">
                ${g.label}${counts[g.key] > 0 ? ` <span class="filter-chip__count">${counts[g.key]}</span>` : ''}
            </button>`).join('');

        filtersEl.querySelectorAll('.filter-chip').forEach(chip => {
            chip.onclick = () => { browseGroup = chip.dataset.group; renderBrowseScreen(); };
        });
    }

    const visible = browseItems.filter(i => lastOutcomeGroup(i) === browseGroup);

    if (visible.length === 0) {
        listEl.innerHTML = browseItems.length === 0
            ? `<div class="ms-muted ms-text-sm">You haven't answered anything${studyCategory ? ` in ${bidiName(studyCategory)}` : ''} yet.</div>`
            : '<div class="ms-muted ms-text-sm">Nothing in this group.</div>';
        return;
    }

    listEl.innerHTML = visible.map((item, idx) => {
        const reviews = item.reviews;
        const last = reviews[reviews.length - 1];
        const due = item.dueDate ? new Date(item.dueDate) : null;
        const dueLabel = due
            ? (due <= new Date() ? 'due now' : `next on ${due.toLocaleDateString('en-GB')}`)
            : '';

        return `
            <div class="manage-item browse-item" data-index="${idx}">
                <div class="manage-item__body">
                    <div class="manage-item__q browse-item__q" dir="auto"></div>
                    <div class="manage-item__meta">
                        ${CONFIDENCE_LABELS[last.confidence] || last.confidence}
                        · ${OUTCOME_LABELS[last.outcome] || last.outcome}
                        · answered ${reviews.length}×
                        ${dueLabel ? ` · ${dueLabel}` : ''}
                    </div>
                    <details class="browse-item__reveal">
                        <summary>Show the answer</summary>
                        <div class="browse-item__a" dir="auto"></div>
                    </details>
                </div>
            </div>`;
    }).join('');

    // Question and answer are filled in afterwards rather than interpolated,
    // so a code block is laid out properly instead of collapsing into one
    // line - and so document text never reaches innerHTML.
    listEl.querySelectorAll('.browse-item').forEach(row => {
        const item = visible[Number(row.dataset.index)];
        renderRichText(row.querySelector('.browse-item__q'), item.question);

        const answerEl = row.querySelector('.browse-item__a');
        const text = item.answer && item.answer.trim()
            ? item.answer
            : (item.mySolution && item.mySolution.trim()
                ? item.mySolution
                : 'No stored answer for this one.');
        renderRichText(answerEl, text);
    });
}

const CONFIDENCE_LABELS = {
    sure: 'Said "I\'m sure"',
    think_so: 'Said "I think so"',
    guessing: 'Said "guessing"'
};

const OUTCOME_LABELS = {
    got_it: 'got it', partial: 'partly', missed: 'missed it',
    solved: 'solved it', stuck: 'got stuck', wrong: 'wrong'
};

const browseStudyBtn = document.getElementById('browse-study-btn');
if (browseStudyBtn) browseStudyBtn.onclick = openBrowseScreen;

const closeBrowseBtn = document.getElementById('close-browse-btn');
if (closeBrowseBtn) closeBrowseBtn.onclick = async () => {
    document.getElementById('study-browse').hidden = true;
    document.getElementById('study-home').hidden = false;
    await loadStudyHome();
};

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
        invalidateListCache('study'); invalidateListCache('browse');
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
        document.getElementById('study-browse').hidden = true;
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

// ---- Cached lists ----
//
// Opening Manage questions, Review answered or the file picker meant waiting
// on a full round trip before anything appeared: renderer -> IPC -> the local
// server -> MongoDB Atlas, which is across the internet. That is a second or
// more per screen, every time, for data that rarely changed since last look.
//
// So each of those lists is remembered, drawn instantly from memory, and then
// refreshed in the background. The screen is usable immediately and correct a
// moment later. Anything that changes the deck clears the relevant entry.
const listCache = new Map();

async function cachedFetch(key, fetcher, { onData }) {
    const cached = listCache.get(key);
    if (cached) onData(cached, { stale: true });

    const fresh = await fetcher();
    listCache.set(key, fresh);
    onData(fresh, { stale: false });
    return fresh;
}

// Called wherever questions or files are created, edited or deleted.
function invalidateListCache(prefix) {
    if (!prefix) { listCache.clear(); return; }
    [...listCache.keys()].filter(k => k.startsWith(prefix)).forEach(k => listCache.delete(k));
}

// Warm the caches once the app has settled, so even the FIRST time a screen
// is opened it is already there. Idle work, so it costs the user nothing.
function prefetchLists() {
    setTimeout(async () => {
        try {
            if (!listCache.has('study:light')) {
                listCache.set('study:light', await ipcRenderer.invoke('get-study-items', { light: true }));
            }
            if (!listCache.has('files:light')) {
                listCache.set('files:light', await ipcRenderer.invoke('get-files', { light: true }));
            }
        } catch { /* a warm cache is an optimisation, never a requirement */ }
    }, 2500);
}
prefetchLists();

async function loadManageList() {
    const listEl = document.getElementById('manage-list');
    if (!listEl) return;

    // Paint something before waiting. The fetch takes a second or two on a
    // real deck, and the old order - await first, touch the DOM after - left
    // the screen frozen on whatever was there before, which reads as a hang.
    listEl.innerHTML = `
        <div class="ms-skeleton ms-skeleton--card"></div>
        <div class="ms-skeleton ms-skeleton--card"></div>
        <div class="ms-skeleton ms-skeleton--card"></div>`;

    // `light` drops each item's review history: this screen shows the
    // question, its mode, its subject and its repetition count, and never
    // reads a single review.
    const cached = listCache.get('study:light');
    const items = cached || await ipcRenderer.invoke('get-study-items', { light: true });
    listCache.set('study:light', items);

    // Served from memory: check for changes behind the user's back and redraw
    // only if the deck actually moved.
    if (cached) {
        ipcRenderer.invoke('get-study-items', { light: true }).then(fresh => {
            if (!fresh) return;
            const changed = fresh.length !== items.length
                || fresh.some((f, i) => !items[i] || f.id !== items[i].id);
            listCache.set('study:light', fresh);
            if (changed && !document.getElementById('study-manage').hidden) loadManageList();
        }).catch(() => {});
    }

    const filtersEl = document.getElementById('manage-source-filters');

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
                invalidateListCache('study'); invalidateListCache('browse');

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
            invalidateListCache('study'); invalidateListCache('browse');
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
        invalidateListCache('browse');
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
// 15b. Importing an existing deck
// ==========================================
// Generating cards from a PDF is now something every study app does, and one
// of them is Google's, for free. What almost none of them do is bring the
// cards BACK - a NotebookLM set is generated once and then sits there.
//
// So this is the other way in: a deck the student already has, from Quizlet,
// Anki, a spreadsheet or anywhere else, arriving in two minutes instead of
// twenty. Once it's here it gets confidence tracking and scheduling like
// everything else.
//
// Imported cards go through the same approval screen as generated ones. They
// were written by someone else against material we have never seen, which is
// if anything MORE reason to look before they enter the deck.

// Splits one delimited line, honouring quotes. Card answers contain commas
// constantly ("a set, a list, or a map"), so a naive split() would cut cards
// in half and silently produce nonsense.
function splitDelimited(line, delimiter) {
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];

        if (ch === '"') {
            // "" inside a quoted field is one literal quote character.
            if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
            else inQuotes = !inQuotes;
            continue;
        }
        if (ch === delimiter && !inQuotes) { fields.push(current); current = ''; continue; }
        current += ch;
    }
    fields.push(current);
    return fields.map(f => f.trim());
}

// Which character separates the columns.
//
// Guessing from the first line alone is unreliable - a single question
// containing a comma would win the vote. This counts across the file and
// picks the delimiter that splits the MOST lines into the same number of
// fields, which is what a real table does and what prose does not.
function detectDelimiter(lines) {
    const candidates = ['\t', ',', ';', '|'];
    let best = { delimiter: '\t', score: 0 };

    candidates.forEach(delimiter => {
        const counts = lines.slice(0, 50).map(l => splitDelimited(l, delimiter).length);
        const twoOrMore = counts.filter(n => n >= 2);
        if (twoOrMore.length === 0) return;

        // Consistency, not just "did it split".
        const mode = twoOrMore.sort((a, b) =>
            twoOrMore.filter(v => v === a).length - twoOrMore.filter(v => v === b).length
        ).pop();
        const score = counts.filter(n => n === mode).length;

        if (score > best.score) best = { delimiter, score };
    });

    return best.delimiter;
}

function looksLikeHeaderRow(fields) {
    const header = fields.map(f => f.toLowerCase().trim());
    // Exports are labelled in whatever language the student's account is in,
    // so a German header row ("Frage;Antwort") would otherwise become the
    // first card in the deck.
    const known = [
        'question', 'front', 'term', 'prompt', 'word', 'key',
        'answer', 'back', 'definition', 'meaning', 'value',
        'שאלה', 'תשובה', 'מונח', 'הגדרה',
        'frage', 'antwort', 'begriff',
        'pregunta', 'respuesta',
        'question ', 'réponse'
    ];
    return header.some(f => known.includes(f));
}

function parseDeckText(raw) {
    const lines = String(raw || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(l => l.trim().length > 0);

    if (lines.length === 0) return { cards: [], skipped: 0 };

    const delimiter = detectDelimiter(lines);
    const cards = [];
    let skipped = 0;

    lines.forEach((line, index) => {
        const fields = splitDelimited(line, delimiter);

        if (index === 0 && looksLikeHeaderRow(fields)) return;

        // A row with nothing to answer is not a card. Anki exports carry tag
        // and metadata columns after the answer, which are ignored.
        const question = (fields[0] || '').trim();
        const answer = (fields[1] || '').trim();
        if (!question || !answer) { skipped += 1; return; }

        cards.push({
            question,
            answer,
            mode: 'recall',
            solutionSource: 'imported'
        });
    });

    return { cards, skipped, delimiter };
}

async function importDeck(rawText, sourceLabel) {
    const { cards, skipped, delimiter } = parseDeckText(rawText);

    if (cards.length === 0) {
        toast.error(
            'No question-and-answer pairs found. Each line needs a question and an answer separated by a tab, comma or semicolon.',
            'Nothing to import'
        );
        return;
    }
    if (cards.length > 200) {
        toast.info(`That deck has ${cards.length} cards. Only the first 200 are imported at once.`, 'Large deck');
        cards.length = 200;
    }

    // Same three-argument promptDialog used everywhere else: title, message,
    // default value.
    const category = await promptDialog(
        'Which subject?',
        'These cards are grouped under this name, so you can study them on their own.',
        sourceLabel
    );
    if (category === null) return;

    cards.forEach(c => {
        c.category = (category || '').trim();
        c.sourceFile = sourceLabel;
    });

    const named = { '\t': 'tabs', ',': 'commas', ';': 'semicolons', '|': 'pipes' };
    console.log(`📥 Imported ${cards.length} card(s), split on ${named[delimiter] || delimiter}, ${skipped} row(s) skipped.`);
    if (skipped > 0) {
        toast.info(`${skipped} row(s) had no answer and were left out.`, `${cards.length} cards ready`);
    }

    document.getElementById('study-import').hidden = true;
    openReviewScreen(cards);
}

const importDeckBtn = document.getElementById('import-deck-btn');
if (importDeckBtn) importDeckBtn.onclick = () => {
    document.getElementById('study-home').hidden = true;
    document.getElementById('study-manage').hidden = true;
    document.getElementById('study-browse').hidden = true;
    document.getElementById('study-review').hidden = true;
    document.getElementById('study-import').hidden = false;

    const box = document.getElementById('import-paste-box');
    if (box) { box.value = ''; box.focus(); }
    const fileNote = document.getElementById('import-file-note');
    if (fileNote) fileNote.textContent = '';
    importedFileName = '';
};

// Set when a file is chosen, so the subject defaults to the file's name the
// way it does for a generated deck.
let importedFileName = '';

const importFileBtn = document.getElementById('import-file-btn');
if (importFileBtn) importFileBtn.onclick = async () => {
    const file = await ipcRenderer.invoke('select-deck-file');
    if (!file) return;
    if (file.error) { toast.error(file.error, 'Could not read the file'); return; }

    const box = document.getElementById('import-paste-box');
    if (box) box.value = file.text;
    importedFileName = file.name.replace(/\.[^.]+$/, '');

    // Say what was understood before anything is committed. A parser that
    // silently reads two columns out of a five-column export is the kind of
    // thing you only notice a week later.
    const { cards, skipped } = parseDeckText(file.text);
    const note = document.getElementById('import-file-note');
    if (note) {
        note.textContent = cards.length
            ? `${file.name}: found ${cards.length} card(s)${skipped ? `, ${skipped} row(s) without an answer will be skipped` : ''}.`
            : `${file.name}: no question-and-answer pairs found. Check that each line has both, separated by a tab or a comma.`;
    }
};

const importContinueBtn = document.getElementById('import-continue-btn');
if (importContinueBtn) importContinueBtn.onclick = async () => {
    const box = document.getElementById('import-paste-box');
    const text = box ? box.value : '';
    if (!text.trim()) { toast.info('Paste some cards, or choose a file.'); return; }
    await importDeck(text, importedFileName || 'Imported');
};

const closeImportBtn = document.getElementById('close-import-btn');
if (closeImportBtn) closeImportBtn.onclick = async () => {
    document.getElementById('study-import').hidden = true;
    document.getElementById('study-home').hidden = false;
    await loadStudyHome();
};

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
    // New questions in the deck: every cached list is now out of date.
    invalidateListCache();
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
const aiProviderSelect = document.getElementById('ai-provider-select');
const geminiKeyInput = document.getElementById('gemini-key-input');
const saveKeyBtn = document.getElementById('save-key-btn');
const testKeyBtn = document.getElementById('test-key-btn');
const aiActiveLabel = document.getElementById('ai-active-label');
const aiKeyStatus = document.getElementById('ai-key-status');

async function loadAiSettings() {
    const cfg = await ipcRenderer.invoke('get-ai-config');
    if (!cfg) return;

    if (aiProviderSelect) aiProviderSelect.value = cfg.provider || 'auto';

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

if (aiProviderSelect) {
    aiProviderSelect.onchange = async () => {
        const res = await ipcRenderer.invoke('save-ai-config', { provider: aiProviderSelect.value });
        if (res && res.error) { toast.error(res.error, 'Could not save'); return; }
        await loadAiSettings();
        toast.success('AI engine updated.');
    };
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

const openAistudioBtn = document.getElementById('open-aistudio-btn');
if (openAistudioBtn) openAistudioBtn.onclick = async () => {
    const res = await ipcRenderer.invoke('open-external', 'https://aistudio.google.com/apikey');
    if (res && res.ok) toast.info('Opened in your browser. Come back here once you have the key.');
    else toast.error("Couldn't open the page. Visit aistudio.google.com/apikey in your browser.");
};

loadAiSettings();

// The resume controls moved onto the start row - see start-study-btn and
// start-fresh-btn above, next to the button they actually act on.