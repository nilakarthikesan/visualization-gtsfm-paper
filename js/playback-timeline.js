export const DEFAULT_PLAYBACK_SECONDS = 30;

// Map recorded event times directly onto the playback duration. There is no minimum
// event delay: simultaneous events stay simultaneous. Each animation occupies
// only the available interval immediately before its event's completion time.
export function planPlayback(events, duration = DEFAULT_PLAYBACK_SECONDS, animationDuration = 0.8) {
    if (!events.length) return { duration: 0, starts: [], ends: [], animationDurations: [] };
    const count = events.length;
    const gaps = events.map((e, i) => i ? Math.max(0, e.realGapSec || 0) : 0);
    const gapSum = gaps.reduce((sum, gap) => sum + gap, 0);
    let elapsed = 0;
    const ends = gaps.map((gap, i) => {
        elapsed += gap;
        return gapSum > 0 ? elapsed / gapSum * duration
            : count > 1 ? i / (count - 1) * duration : 0;
    });
    if (count > 1) ends[count - 1] = duration;
    const starts = ends.map((end, i) => i ? Math.max(ends[i - 1], end - animationDuration) : 0);
    const animationDurations = ends.map((end, i) => end - starts[i]);
    const timestamps = events.map(e => e.effTime ?? e.timestamp);
    const hasTimestamps = timestamps.every(t => Number.isFinite(t) && t > 0);
    const at = (boundaries, seconds) => {
        let index = 0;
        while (index + 1 < count && boundaries[index + 1] <= seconds) index++;
        return index;
    };
    return {
        duration, starts, ends, animationDurations, hasTimestamps,
        indexAt(seconds) { return at(starts, seconds); },
        runClock(seconds) {
            if (!hasTimestamps) return null;
            const index = at(ends, seconds), next = Math.min(index + 1, count - 1);
            const span = ends[next] - ends[index];
            const fraction = span > 0 ? Math.min(1, Math.max(0, (seconds - ends[index]) / span)) : 0;
            const gap = Math.max(0, timestamps[next] - timestamps[index]);
            return {
                elapsed: timestamps[index] - timestamps[0] + fraction * gap,
                rate: span > 0 ? gap / span : 0,
                compressedIdle: next !== index && !!events[next].wasStall
            };
        }
    };
}

// Use an absolute monotonic anchor instead of accumulating per-frame delays.
// Pausing excludes wall time; a late frame catches up without extending the run.
export class PlaybackClock {
    constructor(duration) {
        this.duration = duration;
        this.elapsed = 0;
        this.playing = false;
        this.anchor = 0;
        this.offset = 0;
    }
    update(now) {
        if (this.playing) this.elapsed = Math.min(this.duration, this.offset + Math.max(0, now - this.anchor));
        if (this.elapsed >= this.duration) this.playing = false;
        return this.elapsed;
    }
    play(now) {
        this.anchor = now;
        this.offset = this.elapsed;
        this.playing = this.elapsed < this.duration;
    }
    pause(now) {
        this.update(now);
        this.playing = false;
    }
    seek(seconds, now) {
        this.elapsed = Math.min(this.duration, Math.max(0, seconds));
        this.anchor = now;
        this.offset = this.elapsed;
    }
}

export function formatClock(seconds, tenths = false) {
    const ticks = Math.floor(Math.max(0, seconds) * 10 + 1e-7);
    const whole = Math.floor(ticks / 10);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor(whole / 60) % 60;
    const secs = whole % 60;
    const pad = n => String(n).padStart(2, '0');
    return `${hours || tenths ? pad(hours) + ':' : ''}${pad(minutes)}:${pad(secs)}${tenths ? '.' + ticks % 10 : ''}`;
}
