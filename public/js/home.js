'use strict';

console.log('Home', window.location);

const broadcastID = new URLSearchParams(window.location.search).get('id');

let adminOnlyBroadcast = false;
let broadcastingMode = 'p2p'; // RTMP ingest requires SFU mode; enabled only when the server confirms it

(async () => {
    try {
        const res = await fetch('/api/v1/config');
        const cfg = await res.json();
        adminOnlyBroadcast = !!cfg.adminOnlyBroadcast;
        broadcastingMode = String(cfg.broadcastingMode || 'p2p').toLowerCase();
    } catch (e) {
        console.error('Failed to load server config', e);
    }
    updateRtmpSourceAvailability();
})();

const body = document.querySelector('body');

const appName = document.getElementById('appName');
const copyright = document.getElementById('copyright');
const aboutDiv = document.getElementById('aboutDiv');
const about = document.getElementById('about');

const userName = document.getElementById('userName');
const userNameRandom = document.getElementById('userNameRandom');
const broadcasterIdLabel = document.getElementById('broadcasterIdLabel');
const broadcasterId = document.getElementById('broadcasterId');
const broadcasterIdWrapper = document.getElementById('broadcasterIdWrapper');
const broadcasterIdRandom = document.getElementById('broadcasterIdRandom');
const broadcasterLabel = document.getElementById('broadcasterLabel');
const broadcaster = document.getElementById('broadcaster');
const viewerLabel = document.getElementById('viewerLabel');
const viewer = document.getElementById('viewer');
const mode = document.getElementById('mode');

const sourceSelectGroup = document.getElementById('sourceSelectGroup');
const sourceCamera = document.getElementById('sourceCamera');
const sourceScreen = document.getElementById('sourceScreen');
const sourceRtmp = document.getElementById('sourceRtmp');

const rtmpPanel = document.getElementById('rtmpPanel');
const rtmpStatus = document.getElementById('rtmpStatus');
const rtmpRoomName = document.getElementById('rtmpRoomName');
const rtmpRoomId = document.getElementById('rtmpRoomId');
const rtmpCopyRoomId = document.getElementById('rtmpCopyRoomId');
const rtmpIngestServer = document.getElementById('rtmpIngestServer');
const rtmpCopyIngest = document.getElementById('rtmpCopyIngest');
const rtmpStreamKey = document.getElementById('rtmpStreamKey');
const rtmpToggleKey = document.getElementById('rtmpToggleKey');
const rtmpCopyKey = document.getElementById('rtmpCopyKey');
const rtmpViewerUrl = document.getElementById('rtmpViewerUrl');
const rtmpCopyViewerUrl = document.getElementById('rtmpCopyViewerUrl');
const rtmpRotateKey = document.getElementById('rtmpRotateKey');
const rtmpOpenViewer = document.getElementById('rtmpOpenViewer');
const rtmpDeleteRoom = document.getElementById('rtmpDeleteRoom');

appName.textContent = homePage.appName;
copyright.textContent = `© ${new Date().getFullYear()} ${homePage.appName}`;

// =====================================================
// handle element display
// =====================================================

if (broadcastID) {
    document.getElementById('setupTitle').textContent = 'Join this broadcast';
    elementDisplay(broadcasterIdLabel, false);
    elementDisplay(broadcasterIdWrapper, false);
    elementDisplay(broadcasterLabel, false);
    elementDisplay(broadcaster, false);
    elementDisplay(sourceSelectGroup, false);
}

// =====================================================
// About
// =====================================================

about.addEventListener('click', openAbout);

function openAbout() {
    openURL(homePage.about.url, true);
}

// =====================================================
// Handle username
// =====================================================

async function getUserName() {
    try {
        const { data: profile } = await axios.get('/profile', { timeout: 5000 });
        if (profile && profile.name) {
            console.log('AXIOS GET OIDC Profile retrieved successfully', profile);
            window.localStorage.name = profile.name;
        }
    } catch (error) {
        console.error('AXIOS OIDC Error fetching profile', error.message || error);
    }
    const name = window.localStorage.name || getRandomName();
    return name;
}

(async () => {
    userName.value = await getUserName();
})();

// =====================================================
// Handle broadcaster aka room id
// =====================================================

broadcasterId.value = broadcastID || window.localStorage.room || getUUID4();

broadcasterIdRandom.addEventListener('click', setRandomId);

function setRandomId() {
    scrambleReveal(broadcasterId, getUUID4(), broadcasterIdRandom);
}

userNameRandom.addEventListener('click', setRandomName);

function setRandomName() {
    scrambleReveal(userName, getRandomName(), userNameRandom);
}

// =====================================================
// Scramble text effect on generated values
// =====================================================

const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SCRAMBLE_TICK_MS = 30;
const SCRAMBLE_MAX_TICKS = 14; // keeps the effect under ~450ms whatever the value length
const scrambleFrames = new WeakMap();
const scramblePending = new WeakMap();

function scrambleReveal(input, finalValue, button) {
    finishScramble(input);

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        input.value = finalValue;
        return;
    }

    const chars = [...finalValue];
    // spread the reveal over a fixed number of ticks so long UUIDs are not slower than short names
    const revealAt = chars.map((_, i) => Math.round(((i + 1) / chars.length) * (SCRAMBLE_MAX_TICKS - 2)));

    scramblePending.set(input, { finalValue, button });
    input.classList.remove('is-generated');
    input.classList.add('is-scrambling');
    if (button) button.classList.add('is-spinning');

    let tick = 0;
    let last = performance.now();

    const step = (now) => {
        if (now - last >= SCRAMBLE_TICK_MS) {
            last = now;
            input.value = chars
                .map((char, i) => {
                    if (tick >= revealAt[i] || char === ' ' || char === '-') return char;
                    return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
                })
                .join('');
            tick++;
        }
        if (tick > SCRAMBLE_MAX_TICKS) return finishScramble(input);
        scrambleFrames.set(input, requestAnimationFrame(step));
    };

    scrambleFrames.set(input, requestAnimationFrame(step));
}

// commits the real value immediately, so the field is never left holding scrambled text
function finishScramble(input) {
    const frame = scrambleFrames.get(input);
    if (frame) cancelAnimationFrame(frame);
    scrambleFrames.delete(input);

    const pending = scramblePending.get(input);
    if (!pending) return;
    scramblePending.delete(input);

    input.value = pending.finalValue;
    input.classList.remove('is-scrambling');
    input.classList.add('is-generated');
    if (pending.button) pending.button.classList.remove('is-spinning');
    setTimeout(() => input.classList.remove('is-generated'), 450);
}

[userName, broadcasterId].forEach((input) => {
    ['focus', 'keydown', 'paste'].forEach((event) => input.addEventListener(event, () => finishScramble(input)));
});

// =====================================================
// Join as Broadcast
// =====================================================

broadcaster.addEventListener('click', startBroadcaster);

async function startBroadcaster() {
    if (!isFieldsOk()) return;
    if (selectedSource === 'rtmp') {
        createRtmpRoom();
        return;
    }
    // Screen keeps the exact studio flow, it only flags the broadcast page to defer the screen pickup
    const sourceParam = selectedSource === 'screen' ? '&source=screen' : '';
    if (adminOnlyBroadcast) {
        const { value: token, isConfirmed } = await Swal.fire({
            title: 'Admin token required',
            icon: 'warning',
            iconHtml: '<i class="fas fa-shield-halved"></i>',
            input: 'password',
            inputPlaceholder: 'Enter admin token',
            inputAttributes: { autocomplete: 'current-password' },
            showCancelButton: true,
            confirmButtonText: 'Join',
            showClass: { popup: 'animate__animated animate__fadeInDown' },
            hideClass: { popup: 'animate__animated animate__fadeOutUp' },
        });
        if (!isConfirmed || !token) return;
        window.location.href = `/broadcast?id=${broadcasterId.value}&name=${userName.value}&token=${encodeURIComponent(
            token
        )}${sourceParam}`;
    } else {
        window.location.href = `/broadcast?id=${broadcasterId.value}&name=${userName.value}${sourceParam}`;
    }
}

// =====================================================
// Join as Viewer
// =====================================================

viewer.addEventListener('click', startViewer);

function startViewer() {
    if (isFieldsOk()) window.location.href = `/viewer?id=${broadcasterId.value}&name=${userName.value}`;
}

// =====================================================
// Handle theme
// =====================================================

const getMode = window.localStorage.mode || 'dark';
if (getMode === 'dark') body.classList.add('dark');
updateThemeButton();
mode.addEventListener('click', setTheme);

function setTheme() {
    body.classList.toggle('dark');
    window.localStorage.mode = body.classList.contains('dark') ? 'dark' : 'light';
    updateThemeButton();
    playSound('switch');
}

function updateThemeButton() {
    const isDark = body.classList.contains('dark');
    const label = `Switch to ${isDark ? 'light' : 'dark'} appearance`;
    mode.setAttribute('aria-label', label);
    mode.title = label;
    mode.querySelector('i').className = `fas fa-${isDark ? 'sun' : 'moon'}`;
}

// =====================================================
// Handle fields
// =====================================================

function isFieldsOk() {
    finishScramble(userName);
    finishScramble(broadcasterId);
    if (userName.value == '') {
        popupMessage('warning', 'Username', 'Username field empty!');
        return false;
    }
    if (broadcasterId.value == '') {
        popupMessage('warning', 'Room Id', 'Room ID field empty!');
        return false;
    }
    window.localStorage.name = userName.value;
    window.localStorage.room = broadcasterId.value;
    return true;
}

// =====================================================
// Hide Elements
// =====================================================

!homePage.showCopyright && elementDisplay(copyright, false);
!homePage.about.show && elementDisplay(aboutDiv, false);

if (!homePage.buttons.broadcast) {
    elementDisplay(broadcasterLabel, false);
    elementDisplay(broadcaster, false);
    elementDisplay(sourceSelectGroup, false);
}
if (!homePage.buttons.viewer) {
    elementDisplay(viewerLabel, false);
    elementDisplay(viewer, false);
}

// =====================================================
// Handle broadcast source selection (camera | screen | rtmp)
// =====================================================

const sourceButtons = {
    camera: sourceCamera,
    screen: sourceScreen,
    rtmp: sourceRtmp,
};

let selectedSource = 'camera';

Object.entries(sourceButtons).forEach(([source, button]) => {
    button.addEventListener('click', () => selectSource(source));
});

function selectSource(source) {
    if (!sourceButtons[source]) return;
    if (source === 'rtmp' && sourceRtmp.disabled) return; // RTMP ingest needs SFU mode
    selectedSource = source;
    for (const [key, button] of Object.entries(sourceButtons)) {
        button.classList.toggle('is-active', key === source);
        button.setAttribute('aria-pressed', key === source ? 'true' : 'false');
    }
    // The RTMP room id is generated by the API, the Room ID input only applies to camera/screen
    const usesRoomInput = source !== 'rtmp';
    elementDisplay(broadcasterIdLabel, usesRoomInput);
    elementDisplay(broadcasterIdWrapper, usesRoomInput);
    broadcaster.innerHTML = usesRoomInput
        ? 'Enter studio <i class="fas fa-arrow-right"></i>'
        : 'Create RTMP room <i class="fas fa-arrow-right"></i>';
}

function updateRtmpSourceAvailability() {
    const sfuMode = broadcastingMode === 'sfu';
    sourceRtmp.disabled = !sfuMode;
    if (sfuMode) {
        sourceRtmp.removeAttribute('title');
    } else {
        sourceRtmp.title = 'RTMP ingest requires SFU mode';
    }
    if (!sfuMode && selectedSource === 'rtmp') selectSource('camera');
}

// =====================================================
// Handle RTMP ingest rooms (admin API /api/v1/rooms)
// =====================================================

const RTMP_ROOM_PANEL_KEY = 'rtmpRoomPanel'; // panel metadata only (never key material), survives reload
const RTMP_POLL_INTERVAL_MS = 5000;
const RTMP_KEY_MASK = '••••••••';

let rtmpAdminToken = null; // memory only: never logged, never persisted
let rtmpState = null; // { id, name, viewerUrl, ingestServer, streamKey|null }
let rtmpKeyRevealed = false;
let rtmpPollTimer = null;

async function createRtmpRoom() {
    // The rooms API always requires the admin token, even when adminOnlyBroadcast is false
    const token = await requireRtmpAdminToken('Admin token required', 'Create room');
    if (!token) return;
    let response;
    try {
        response = await fetch('/api/v1/rooms', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ sourceType: 'rtmp', name: userName.value || undefined }),
        });
        if (response.status === 201) {
            const room = await response.json();
            if (room && room.id) {
                // The full response (including the one-time plaintext key) stays in memory only
                applyRtmpRoom(room);
                openRtmpPanel();
            } else {
                popupMessage('error', 'RTMP room', 'Failed to create RTMP room');
            }
            return;
        }
    } catch (error) {
        console.error('RTMP room creation request failed', error);
        return popupMessage('error', 'RTMP room', 'Failed to create RTMP room');
    }
    if (response.status === 401) {
        rtmpAdminToken = null; // force a fresh prompt on the next attempt
        return popupMessage('error', 'RTMP room', 'Invalid admin token');
    }
    if (response.status === 409) {
        return popupMessage('error', 'RTMP room', 'Too many active RTMP rooms');
    }
    return popupMessage('error', 'RTMP room', 'Failed to create RTMP room');
}

async function requireRtmpAdminToken(title, confirmButtonText) {
    if (rtmpAdminToken) return rtmpAdminToken;
    const { value: token, isConfirmed } = await Swal.fire({
        title: title,
        icon: 'warning',
        iconHtml: '<i class="fas fa-shield-halved"></i>',
        input: 'password',
        inputPlaceholder: 'Enter admin token',
        inputAttributes: { autocomplete: 'current-password' },
        showCancelButton: true,
        confirmButtonText: confirmButtonText,
        showClass: { popup: 'animate__animated animate__fadeInDown' },
        hideClass: { popup: 'animate__animated animate__fadeOutUp' },
    });
    if (!isConfirmed || !token) return null;
    rtmpAdminToken = token;
    return rtmpAdminToken;
}

function applyRtmpRoom(room) {
    rtmpState = {
        id: room.id,
        name: room.name || room.id,
        viewerUrl: room.viewerUrl || '',
        ingestServer: (room.rtmp && room.rtmp.ingestServer) || '',
        streamKey: room.rtmp && room.rtmp.streamKey ? room.rtmp.streamKey : null,
    };
    saveRtmpPanelMetadata();
}

function openRtmpPanel() {
    if (!rtmpState) return;
    renderRtmpPanel();
    rtmpPanel.hidden = false;
    startRtmpPolling();
}

// Restore the panel after a page reload: metadata only, the plaintext key is never persisted
(async function restoreRtmpPanel() {
    let metadata = null;
    try {
        metadata = JSON.parse(sessionStorage.getItem(RTMP_ROOM_PANEL_KEY) || 'null');
    } catch (error) {
        metadata = null;
    }
    if (!metadata || !metadata.id) return;
    rtmpState = {
        id: metadata.id,
        name: metadata.name || metadata.id,
        viewerUrl: metadata.viewerUrl || '',
        ingestServer: metadata.ingestServer || '',
        streamKey: null,
    };
    renderRtmpPanel();
    rtmpPanel.hidden = false;
    // The admin token lives only in memory: after a reload it must be re-entered to refresh the status
    const token = await requireRtmpAdminToken('Enter admin token to refresh', 'Refresh');
    if (token) startRtmpPolling();
})();

function saveRtmpPanelMetadata() {
    if (!rtmpState) return;
    // Metadata only — the plaintext stream key is never persisted
    sessionStorage.setItem(
        RTMP_ROOM_PANEL_KEY,
        JSON.stringify({
            id: rtmpState.id,
            name: rtmpState.name,
            viewerUrl: rtmpState.viewerUrl,
            ingestServer: rtmpState.ingestServer,
        })
    );
}

function renderRtmpPanel() {
    if (!rtmpState) return;
    rtmpRoomName.textContent = rtmpState.name;
    rtmpRoomId.textContent = rtmpState.id;
    rtmpIngestServer.textContent = rtmpState.ingestServer || '—';
    rtmpViewerUrl.textContent = rtmpState.viewerUrl || '—';
    setRtmpKeyRevealed(false);
    setRtmpStatus(rtmpAdminToken ? 'waiting' : 'unknown');
}

function setRtmpKeyRevealed(revealed) {
    rtmpKeyRevealed = revealed;
    rtmpStreamKey.textContent = revealed && rtmpState && rtmpState.streamKey ? rtmpState.streamKey : RTMP_KEY_MASK;
    rtmpToggleKey.querySelector('i').className = revealed ? 'fas fa-eye-slash' : 'fas fa-eye';
    rtmpToggleKey.title = revealed ? 'Hide' : 'Reveal';
}

function setRtmpStatus(status) {
    rtmpStatus.classList.remove('is-live');
    rtmpStatus.title = 'Room status';
    switch (status) {
        case 'live':
            rtmpStatus.textContent = '● LIVE';
            rtmpStatus.classList.add('is-live');
            break;
        case 'unknown':
            rtmpStatus.textContent = 'Status unknown';
            rtmpStatus.title = 'Enter admin token to refresh';
            break;
        case 'unavailable':
            rtmpStatus.textContent = 'Status unavailable';
            break;
        default:
            rtmpStatus.textContent = 'Waiting for encoder…';
    }
}

function startRtmpPolling() {
    stopRtmpPolling();
    rtmpPollTimer = setInterval(pollRtmpRoomStatus, RTMP_POLL_INTERVAL_MS);
    pollRtmpRoomStatus();
}

function stopRtmpPolling() {
    if (rtmpPollTimer) clearInterval(rtmpPollTimer);
    rtmpPollTimer = null;
}

async function pollRtmpRoomStatus() {
    if (!rtmpState || !rtmpState.id || !rtmpAdminToken) return;
    let response;
    try {
        response = await fetch('/api/v1/rooms/' + encodeURIComponent(rtmpState.id), {
            headers: { Authorization: 'Bearer ' + rtmpAdminToken },
        });
    } catch (error) {
        console.error('RTMP room status request failed', error);
        setRtmpStatus('unavailable');
        return;
    }
    if (response.status === 200) {
        try {
            const room = await response.json();
            setRtmpStatus(room && room.ingestActive ? 'live' : 'waiting');
        } catch (error) {
            setRtmpStatus('unavailable');
        }
        return;
    }
    if (response.status === 401) {
        rtmpAdminToken = null;
        stopRtmpPolling();
        setRtmpStatus('unknown');
        popupMessage('error', 'RTMP room', 'Invalid admin token');
        return;
    }
    if (response.status === 404) {
        stopRtmpPolling();
        closeRtmpPanel();
        popupMessage('warning', 'RTMP room', 'Room no longer exists');
        return;
    }
    setRtmpStatus('unavailable');
}

function closeRtmpPanel() {
    stopRtmpPolling();
    rtmpState = null;
    setRtmpKeyRevealed(false);
    sessionStorage.removeItem(RTMP_ROOM_PANEL_KEY);
    rtmpPanel.hidden = true;
}

// =====================================================
// Handle RTMP panel actions
// =====================================================

rtmpStatus.addEventListener('click', async () => {
    if (!rtmpState || rtmpAdminToken) return;
    const token = await requireRtmpAdminToken('Enter admin token to refresh', 'Refresh');
    if (token) startRtmpPolling();
});

rtmpToggleKey.addEventListener('click', () => {
    if (!rtmpState) return;
    if (!rtmpState.streamKey) {
        return popupMessage(
            'toast',
            'Stream key',
            'The stream key is shown only once. Rotate the key to get a new one.',
            'top',
            3500
        );
    }
    setRtmpKeyRevealed(!rtmpKeyRevealed);
});

rtmpCopyRoomId.addEventListener('click', () => copyRtmpValue(rtmpState && rtmpState.id, 'Room ID'));
rtmpCopyIngest.addEventListener('click', () => copyRtmpValue(rtmpState && rtmpState.ingestServer, 'Ingest server'));
rtmpCopyViewerUrl.addEventListener('click', () => copyRtmpValue(rtmpState && rtmpState.viewerUrl, 'Viewer URL'));
rtmpCopyKey.addEventListener('click', () => {
    if (rtmpState && rtmpState.streamKey) {
        copyRtmpValue(rtmpState.streamKey, 'Stream key');
    } else {
        popupMessage(
            'toast',
            'Stream key',
            'The stream key is shown only once. Rotate the key to get a new one.',
            'top',
            3500
        );
    }
});

// navigator.clipboard requires a secure context (HTTPS), so fall back to the
// classic execCommand('copy') path to keep copy buttons working on plain HTTP.
function copyToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).catch(() => legacyCopyToClipboard(text));
    }
    return legacyCopyToClipboard(text);
}

function legacyCopyToClipboard(text) {
    return new Promise((resolve, reject) => {
        const activeElement = document.activeElement;
        const isTextControl = activeElement && /^(input|textarea)$/i.test(activeElement.tagName);
        const selStart = isTextControl ? activeElement.selectionStart : null;
        const selEnd = isTextControl ? activeElement.selectionEnd : null;
        const selection = window.getSelection();
        const selectedRange =
            selection && selection.rangeCount === 1 && !isTextControl ? selection.getRangeAt(0).cloneRange() : null;
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '0';
        textarea.style.left = '-9999px'; // off-screen
        document.body.appendChild(textarea);
        try {
            textarea.focus();
            textarea.select();
            const copied = document.execCommand('copy');
            if (!copied) return reject(new Error('execCommand copy failed'));
            resolve();
        } catch (error) {
            reject(error);
        } finally {
            textarea.remove();
            if (activeElement && typeof activeElement.focus === 'function') {
                activeElement.focus();
                if (isTextControl && selStart !== null && selEnd !== null) {
                    try {
                        activeElement.setSelectionRange(selStart, selEnd);
                    } catch (e) {
                        /* restoring the previous selection is best-effort */
                    }
                }
            }
            if (selectedRange && selection) {
                selection.removeAllRanges();
                selection.addRange(selectedRange);
            }
        }
    });
}

function copyRtmpValue(value, title) {
    if (!value) return;
    copyToClipboard(value)
        .then(() => popupMessage('toast', title, 'Copied to clipboard', 'top', 2000))
        .catch(() => popupMessage('error', title, 'Copy to clipboard failed'));
}

rtmpRotateKey.addEventListener('click', rotateRtmpKey);

async function rotateRtmpKey() {
    if (!rtmpState) return;
    const token = await requireRtmpAdminToken('Admin token required', 'Rotate key');
    if (!token) return;
    let response;
    try {
        response = await fetch('/api/v1/rooms/' + encodeURIComponent(rtmpState.id) + '/rotate-key', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token },
        });
        if (response.status === 200) {
            const data = await response.json();
            rtmpState.streamKey = data.streamKey; // new one-time plaintext, kept in memory only
            setRtmpKeyRevealed(false);
            return popupMessage('toast', 'Rotate key', 'Stream key rotated — the old key is revoked for new connections', 'top', 2500);
        }
    } catch (error) {
        console.error('RTMP key rotation request failed', error);
        return popupMessage('error', 'Rotate key', 'Failed to rotate stream key');
    }
    if (response.status === 401) {
        rtmpAdminToken = null;
        return popupMessage('error', 'Rotate key', 'Invalid admin token');
    }
    if (response.status === 404) {
        stopRtmpPolling();
        closeRtmpPanel();
        return popupMessage('warning', 'Rotate key', 'Room no longer exists');
    }
    return popupMessage('error', 'Rotate key', 'Failed to rotate stream key');
}

rtmpOpenViewer.addEventListener('click', () => {
    if (rtmpState && rtmpState.viewerUrl) openURL(rtmpState.viewerUrl, true);
});

rtmpDeleteRoom.addEventListener('click', deleteRtmpRoom);

async function deleteRtmpRoom() {
    if (!rtmpState) return;
    const { isConfirmed } = await Swal.fire({
        icon: 'warning',
        title: 'Delete RTMP room',
        text: 'Deleting the room stops the ingest best-effort and removes the stream key. Viewers will lose access.',
        showCancelButton: true,
        confirmButtonText: 'Delete room',
        showClass: { popup: 'animate__animated animate__fadeInDown' },
        hideClass: { popup: 'animate__animated animate__fadeOutUp' },
    });
    if (!isConfirmed) return;
    const token = await requireRtmpAdminToken('Admin token required', 'Delete room');
    if (!token) return;
    let response;
    try {
        response = await fetch('/api/v1/rooms/' + encodeURIComponent(rtmpState.id), {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + token },
        });
    } catch (error) {
        console.error('RTMP room deletion request failed', error);
        return popupMessage('error', 'Delete room', 'Failed to delete RTMP room');
    }
    if (response.status === 204 || response.status === 404) {
        closeRtmpPanel();
        return popupMessage('toast', 'RTMP room', 'RTMP room deleted', 'top', 2500);
    }
    if (response.status === 401) {
        rtmpAdminToken = null;
        return popupMessage('error', 'Delete room', 'Invalid admin token');
    }
    return popupMessage('error', 'Delete room', 'Failed to delete RTMP room');
}
//...
