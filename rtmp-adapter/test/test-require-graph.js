'use strict';

/**
 * Static require-graph guard for rtmp-adapter/src.
 *
 * Regression for the E2E-found MODULE_NOT_FOUND class defect: index.js
 * required './reconciler' but the implemented file was reconcile.js.
 *
 * Also enforces the zero-runtime-deps invariant: every non-relative require
 * in src/ must be a Node builtin, and package.json must have no dependencies.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules, isBuiltin } = require('node:module');

const SRC_DIR = path.join(__dirname, '../src');
const PKG_PATH = path.join(__dirname, '../package.json');

const REQUIRE_RE = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

function extractRequires(source) {
    const specs = [];
    REQUIRE_RE.lastIndex = 0;
    let match;
    while ((match = REQUIRE_RE.exec(source)) !== null) {
        specs.push(match[2]);
    }
    return specs;
}

function isRelative(spec) {
    return spec.startsWith('./') || spec.startsWith('../');
}

function isNodeBuiltin(spec) {
    if (typeof isBuiltin === 'function' && isBuiltin(spec)) return true;
    const name = spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
    return builtinModules.includes(name);
}

function listSrcFiles() {
    return fs
        .readdirSync(SRC_DIR)
        .filter((name) => name.endsWith('.js'))
        .sort()
        .map((name) => path.join(SRC_DIR, name));
}

describe('rtmp-adapter require graph (MODULE_NOT_FOUND guard)', () => {
    const srcFiles = listSrcFiles();

    it('scans every rtmp-adapter/src/*.js file including index.js', () => {
        assert.ok(srcFiles.length > 0, 'expected rtmp-adapter/src/*.js files');
        const names = srcFiles.map((file) => path.basename(file));
        assert.ok(
            names.includes('index.js'),
            'expected to scan src/index.js (site of the reconciler/reconcile defect)'
        );
    });

    it('every relative require() in src/ resolves to an existing .js file', () => {
        const missing = [];
        let relativeCount = 0;

        for (const file of srcFiles) {
            const source = fs.readFileSync(file, 'utf8');
            const fromDir = path.dirname(file);
            const relFile = path.relative(path.join(SRC_DIR, '..'), file);

            for (const spec of extractRequires(source)) {
                if (!isRelative(spec)) continue;
                relativeCount += 1;

                const withJs = path.extname(spec) === '' ? `${spec}.js` : spec;
                if (path.extname(withJs) !== '.js') {
                    missing.push({ file: relFile, specifier: spec, reason: 'non-.js target' });
                    continue;
                }

                const candidate = path.resolve(fromDir, withJs);
                if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
                    missing.push({
                        file: relFile,
                        specifier: spec,
                        candidate,
                        reason: 'MODULE_NOT_FOUND (missing .js file)',
                    });
                    continue;
                }

                let resolved;
                try {
                    resolved = require.resolve(spec, { paths: [fromDir] });
                } catch (err) {
                    missing.push({
                        file: relFile,
                        specifier: spec,
                        candidate,
                        reason: err.code || err.message,
                    });
                    continue;
                }

                if (path.resolve(resolved) !== path.resolve(candidate)) {
                    missing.push({
                        file: relFile,
                        specifier: spec,
                        candidate,
                        resolved,
                        reason: 'require.resolve path mismatch',
                    });
                }
            }
        }

        assert.ok(relativeCount > 0, 'expected at least one relative require() in src/');
        assert.equal(
            missing.length,
            0,
            `relative require() targets missing or not .js (MODULE_NOT_FOUND class): ${JSON.stringify(missing, null, 2)}`
        );
    });

    it('rejects any non-relative require() that is not a Node builtin', () => {
        const illegal = [];

        for (const file of srcFiles) {
            const source = fs.readFileSync(file, 'utf8');
            const relFile = path.relative(path.join(SRC_DIR, '..'), file);
            for (const spec of extractRequires(source)) {
                if (isRelative(spec)) continue;
                if (!isNodeBuiltin(spec)) {
                    illegal.push({ file: relFile, specifier: spec });
                }
            }
        }

        assert.equal(
            illegal.length,
            0,
            `non-builtin require() in src/ (zero-dep invariant): ${JSON.stringify(illegal)}`
        );
    });

    it('package.json has dependencies absent or empty (zero-dep invariant)', () => {
        const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
        const deps = pkg.dependencies;
        const empty =
            deps === undefined ||
            (deps !== null && typeof deps === 'object' && !Array.isArray(deps) && Object.keys(deps).length === 0);
        assert.ok(empty, `expected no runtime dependencies, got: ${JSON.stringify(deps)}`);
    });
});
