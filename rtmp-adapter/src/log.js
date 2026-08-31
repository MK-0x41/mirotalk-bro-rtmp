'use strict';

/**
 * Structured JSON-lines logging for the rtmp-adapter.
 *
 * Security: callers must never pass tokens, stream keys, query strings or
 * auth headers into log fields. Errors are reduced to their message.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function createLogger(level = 'info') {
    const max = LEVELS[level] !== undefined ? LEVELS[level] : LEVELS.info;

    function emit(levelName, msg, fields) {
        if (LEVELS[levelName] > max) return;
        const entry = { ts: new Date().toISOString(), level: levelName, msg };
        if (fields && typeof fields === 'object') {
            for (const [key, value] of Object.entries(fields)) {
                if (value instanceof Error) {
                    entry[key] = value.message;
                } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
                    entry[key] = value;
                } else {
                    entry[key] = JSON.stringify(value);
                }
            }
        }
        process.stdout.write(JSON.stringify(entry) + '\n');
    }

    return {
        error: (msg, fields) => emit('error', msg, fields),
        warn: (msg, fields) => emit('warn', msg, fields),
        info: (msg, fields) => emit('info', msg, fields),
        debug: (msg, fields) => emit('debug', msg, fields),
    };
}

module.exports = { createLogger, LEVELS };
