// ==========================================
// Weekly planner
// ==========================================
// Fits open tasks into the gaps left by the week's fixed commitments.
//
// This is deliberately NOT an AI feature. A model asked to place appointments
// gives a different answer every time, can't be checked, and will happily put
// two things in the same hour. Placing blocks around fixed events is a
// constraint problem, and ordinary code solves it the same way every time and
// can be tested.
//
// The AI's job is upstream: turning "hand in the stats exercise by Thursday,
// maybe two hours" into a title, a deadline and a length. Interpretation for
// the model, arithmetic for the code - the same split already used for Hebrew
// day names and for answers that are located rather than written.
//
// The calendar is a WEEKLY TEMPLATE: an Event has a day name and a time, not
// a date. So everything here works on one repeating week, Sunday to Saturday.

const PLANNER_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const PLANNER_DEFAULTS = {
    // When work may be placed. Nobody wants a study block at 6am because it
    // was technically free.
    dayStart: '08:00',
    dayEnd: '22:00',

    // Assumed length of an event with no duration set, and of a task with no
    // estimate. An hour is the common case for both a lecture and a chunk of
    // work.
    defaultEventMinutes: 60,
    defaultTaskMinutes: 60,

    // Longest single block. Work longer than this gets split across sittings,
    // because a three-hour block is a block that doesn't happen.
    maxBlockMinutes: 90,

    // Shortest block worth putting in a calendar. Splitting two hours into
    // "1h45 + 15m" is technically correct and useless: the quarter of an hour
    // costs the same interruption as a real sitting and achieves nothing.
    minBlockMinutes: 25,

    // Breathing room either side of an existing commitment, so a block never
    // starts the same minute a lecture ends.
    bufferMinutes: 15,

    // Days the planner leaves alone.
    skipDays: ['Saturday'],

    // Where "now" is. Overridable so the behaviour can be tested on a fixed
    // day instead of only on whatever day the test happens to run.
    todayIndex: new Date().getDay(),
    nowMinutes: (new Date().getHours() * 60) + new Date().getMinutes()
};

function toMinutes(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return (h * 60) + (m || 0);
}

function toTimeString(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// The busy intervals of one day, merged so that overlapping or touching
// commitments become a single block. Without merging, a gap could be
// "found" between two events that actually overlap.
function busyIntervalsFor(day, events, options) {
    const intervals = events
        .filter(e => e.day === day)
        .map(e => {
            const start = toMinutes(e.time);
            const length = Number(e.durationMinutes) > 0
                ? Number(e.durationMinutes)
                : options.defaultEventMinutes;
            return {
                start: start - options.bufferMinutes,
                end: start + length + options.bufferMinutes
            };
        })
        .sort((a, b) => a.start - b.start);

    const merged = [];
    intervals.forEach(interval => {
        const last = merged[merged.length - 1];
        if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
        else merged.push({ ...interval });
    });
    return merged;
}

// Every free stretch of the week AHEAD, in order.
//
// The week is walked from today, not from Sunday. The calendar is a repeating
// template with no dates in it, so "Sunday" on its own is just a column - and
// filling from column one on a Tuesday put work into two days that had
// already happened. Each slot carries `offset`: 0 is today, 1 tomorrow, and
// that is what deadlines are measured against.
function freeSlots(events, options) {
    const windowStart = toMinutes(options.dayStart);
    const windowEnd = toMinutes(options.dayEnd);
    const slots = [];

    for (let offset = 0; offset < 7; offset++) {
        const dayIndex = (options.todayIndex + offset) % 7;
        const day = PLANNER_DAYS[dayIndex];
        if (options.skipDays.includes(day)) continue;

        // Today starts from now, rounded up to the next quarter hour, not
        // from 08:00. Nothing can be scheduled into a morning that is over.
        const startOfDay = offset === 0
            ? Math.max(windowStart, Math.ceil((options.nowMinutes + 10) / 15) * 15)
            : windowStart;

        if (startOfDay >= windowEnd) continue;

        const busy = busyIntervalsFor(day, events, options);
        let cursor = startOfDay;

        busy.forEach(interval => {
            if (interval.start > cursor) {
                slots.push({ day, dayIndex, offset, start: cursor, end: Math.min(interval.start, windowEnd) });
            }
            cursor = Math.max(cursor, interval.end);
        });

        if (cursor < windowEnd) slots.push({ day, dayIndex, offset, start: cursor, end: windowEnd });
    }

    return slots.filter(s => s.end - s.start >= options.minBlockMinutes);
}

const URGENCY_RANK = { Urgent: 0, High: 1, Medium: 2, Normal: 3 };

// How many days from today the deadline is, or null.
//
// Counted in days from now rather than as a weekday number: on a Tuesday, a
// deadline of "Sunday" means five days away, not "before Tuesday". Comparing
// raw weekday indexes made Sunday look earlier than everything and let work
// be planned into days that had already passed.
function deadlineOffset(task, options) {
    if (!task.dueDate) return null;
    const due = new Date(task.dueDate);
    if (Number.isNaN(due.getTime())) return null;
    return (due.getDay() - options.todayIndex + 7) % 7;
}

function planWeek(tasks, events, overrides = {}) {
    // Re-read the clock on every call: PLANNER_DEFAULTS is evaluated once at
    // load, and an app left open overnight would otherwise keep planning
    // around yesterday.
    const now = new Date();
    const options = {
        ...PLANNER_DEFAULTS,
        todayIndex: now.getDay(),
        nowMinutes: (now.getHours() * 60) + now.getMinutes(),
        ...overrides
    };

    const slots = freeSlots(events, options);
    const blocks = [];
    const unplaced = [];

    // Deadline first, then urgency. A task due tomorrow beats an urgent one
    // due next week, because the week runs out before the urgency does.
    const ordered = [...tasks].sort((a, b) => {
        const da = deadlineOffset(a, options);
        const db = deadlineOffset(b, options);
        if (da !== db) {
            if (da === null) return 1;
            if (db === null) return -1;
            return da - db;
        }
        return (URGENCY_RANK[a.urgency] ?? 3) - (URGENCY_RANK[b.urgency] ?? 3);
    });

    ordered.forEach(task => {
        let remaining = Number(task.estimatedMinutes) > 0
            ? Number(task.estimatedMinutes)
            : options.defaultTaskMinutes;

        const limit = deadlineOffset(task, options);
        const forThisTask = [];

        for (const slot of slots) {
            if (remaining <= 0) break;
            if (limit !== null && slot.offset > limit) continue;

            const available = slot.end - slot.start;
            if (available < options.minBlockMinutes) continue;

            let length = Math.min(remaining, options.maxBlockMinutes, available);

            // Don't leave a stub behind. Either swallow the remainder now, or
            // shorten this block so what's left is still worth scheduling.
            const leftover = remaining - length;
            if (leftover > 0 && leftover < options.minBlockMinutes) {
                length = available >= remaining
                    ? remaining
                    : Math.min(available, Math.max(options.minBlockMinutes, remaining - options.minBlockMinutes));
            }

            forThisTask.push({
                taskId: task.id || task._id,
                title: task.title,
                day: slot.day,
                dayIndex: slot.dayIndex,
                offset: slot.offset,
                time: toTimeString(slot.start),
                startMinutes: slot.start,
                durationMinutes: length,
                type: 'study',
                autoScheduled: true
            });

            // Consume the slot in place, so the next task starts after this
            // block rather than on top of it.
            slot.start += length + options.bufferMinutes;
            remaining -= length;
        }

        // Numbered only once all the parts are known. Counting them up front
        // from the maximum block length was wrong whenever a gap was smaller
        // than that maximum, which produced labels like "(4/3)".
        if (forThisTask.length > 1) {
            forThisTask.forEach((b, i) => { b.title = `${task.title} (${i + 1}/${forThisTask.length})`; });
        }
        blocks.push(...forThisTask);

        const placedAny = forThisTask.length > 0;

        if (remaining > 0) {
            unplaced.push({
                title: task.title,
                minutesLeft: remaining,
                // The two reasons are different problems with different fixes,
                // and saying which one is what makes the message useful.
                reason: limit !== null && !placedAny
                    ? 'no free time before its deadline'
                    : 'not enough free time left this week'
            });
        }
    });

    // Chronological order, because that is the only order a week is read in.
    // Tasks are placed one at a time, so without this the list comes out
    // grouped by task and looks like a scheduling error.
    blocks.sort((a, b) => a.offset - b.offset || a.startMinutes - b.startMinutes);

    return {
        blocks,
        unplaced,
        freeMinutes: slots.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0)
    };
}

// Exported for the tests; the renderer picks these up as globals.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { planWeek, freeSlots, toMinutes, toTimeString, PLANNER_DAYS, PLANNER_DEFAULTS };
}