// Global state
let pc, localStream;
const config = { iceServers: [{urls: 'stun:stun.l.google.com:19302'}] };
let DEBUG = true;

// DOM elements
const statusEl = document.getElementById('status');
const copyEl = document.getElementById('copyData');
const pasteEl = document.getElementById('pasteData');
const debugLogEl = document.getElementById('debugLog');
const copyFeedbackEl = document.getElementById('copyFeedback');
const offerBtn = document.getElementById('offerBtn');
const answerBtn = document.getElementById('answerBtn');
const useDataBtn = document.getElementById('useDataBtn');
const debugBtn = document.getElementById('debugBtn');

// Initialize Telegram Mini App
Telegram.WebApp.ready();
Telegram.WebApp.expand();

// Dynamic theme sync
function updateTheme() {
    ['bg_color', 'text_color', 'button_color', 'button_text_color', 'secondary_bg_color', 'hint_color']
        .forEach(param => {
            if (Telegram.WebApp.themeParams[param]) {
                document.documentElement.style.setProperty(
                    `--tg-theme-${param.replace('_', '-')}`, 
                    Telegram.WebApp.themeParams[param]
                );
            }
        });
}
updateTheme();
Telegram.WebApp.onEvent('themeChanged', updateTheme);

// Debug logging
function log(message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${message}`;
    debugLogEl.innerHTML += line + (data ? '<br>' : '') + '<br>';
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
    console.log(line, data);
    if (DEBUG) debugLogEl.style.display = 'block';
}

debugBtn.addEventListener('click', () => {
    debugLogEl.style.display = debugLogEl.style.display === 'none' ? 'block' : 'none';
});

// Auto-copy functionality
copyEl.addEventListener('click', copyToClipboard);
copyEl.addEventListener('focus', copyToClipboard);

async function copyToClipboard() {
    if (copyEl.value) {
        try {
            await navigator.clipboard.writeText(copyEl.value);
            if (Telegram.WebApp.HapticFeedback) {
                Telegram.WebApp.HapticFeedback.impactOccurred('light');
            }
            copyFeedbackEl.textContent = '✅ Copied to clipboard!';
            copyFeedbackEl.style.display = 'block';
            setTimeout(() => { copyFeedbackEl.style.display = 'none'; }, 2000);
        } catch (err) {
            copyFeedbackEl.textContent = '❌ Copy failed';
            copyFeedbackEl.style.display = 'block';
        }
    }
}

// FIXED: Proper media setup
async function setupMedia() {
    log('🔄 Stage 1: Requesting camera...');
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, 
            audio: true 
        });
        document.getElementById('localVideo').srcObject = localStream;
        log('✅ Stage 1: Camera OK', { tracks: localStream.getTracks().length });
        statusEl.textContent = '✅ Camera ready';
        return true;
    } catch (err) {
        log(`❌ Stage 1 FAILED: ${err.name} - ${err.message}`);
        statusEl.textContent = `❌ Camera: ${err.name}`;
        return false;
    }
}

// FIXED: Proper ICE gathering + DTLS roles
async function getLocalOffer() {
    log('🚀 Starting OFFER creation');
    const mediaReady = await setupMedia();
    if (!mediaReady) return;
    
    try {
        log('🔄 Stage 2: Creating RTCPeerConnection');
        pc = new RTCPeerConnection(config);
        log('✅ Stage 2: PeerConnection created');
        
        // Add tracks BEFORE createOffer
        log('🔄 Stage 3: Adding tracks');
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
            log(`✅ Added track: ${track.kind}`);
        });
        
        pc.ontrack = e => {
            log('📹 Remote stream received');
            document.getElementById('remoteVideo').srcObject = e.streams[0];
            statusEl.textContent = '✅ Connected!';
        };
        
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                log('🧊 ICE candidate gathered');
            }
        };
        
        pc.onicegatheringstatechange = () => {
            log(`ICE state: ${pc.iceGatheringState}`);
        };
        
        // FIXED: Create offer AFTER tracks added
        log('🔄 Stage 4: Creating offer...');
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        log('✅ Stage 4: Offer created', { sdpLength: offer.sdp?.length });
        
        log('🔄 Stage 5: Setting local description');
        await pc.setLocalDescription(offer);
        log('✅ Stage 5: Local description set');
        
        // FIXED: Wait for FULL ICE gathering (3 seconds max)
        log('⏳ Waiting for complete ICE gathering...');
        await new Promise(resolve => {
            if (pc.iceGatheringState === 'complete') {
                log('✅ ICE already complete');
                resolve();
            } else {
                const timeout = setTimeout(() => {
                    log('⚠️ ICE timeout - using partial candidates');
                    resolve();
                }, 3000);
                
                const checkIce = setInterval(() => {
                    if (pc.iceGatheringState === 'complete') {
                        clearInterval(checkIce);
                        clearTimeout(timeout);
                        log('✅ ICE gathering complete');
                        resolve();
                    }
                }, 200);
            }
        });
        
        updateCopyData();
        
    } catch (err) {
        log(`❌ OFFER FAILED: ${err.message}`, err);
        statusEl.textContent = `❌ Offer failed: ${err.message}`;
    }
}

offerBtn.addEventListener('click', getLocalOffer);

// FIXED: Answerer creates PC FIRST, then adds tracks, THEN setRemoteDescription
async function getLocalAnswer() {
    log('🔄 Starting ANSWER creation');
    try {
        const rawData = pasteEl.value.trim();
        if (!rawData) throw new Error('Empty paste data');
        
        log('🔄 Stage 1: Decoding base64');
        const decoded = atob(rawData);
        log('✅ Stage 1: Base64 decoded', { length: decoded.length });
        
        log('🔄 Stage 2: Parsing JSON');
        const remoteData = JSON.parse(decoded);
        log('✅ Stage 2: JSON parsed', { hasSdp: !!remoteData.sdp });
        
        if (!remoteData.sdp) throw new Error('No SDP in data');
        
        // FIXED: Create PC and add tracks BEFORE setRemoteDescription
        log('🔄 Stage 3: Creating peer connection FIRST');
        pc = new RTCPeerConnection(config);
        
        // Get media BEFORE setting remote description
        const mediaReady = await setupMedia();
        if (!mediaReady) throw new Error('Camera setup failed');
        
        log('🔄 Stage 4: Adding tracks to answerer');
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
            log(`✅ Added track: ${track.kind}`);
        });
        
        pc.ontrack = e => {
            log('📹 Remote stream received');
            document.getElementById('remoteVideo').srcObject = e.streams[0];
        };
        
        log('🔄 Stage 5: Setting remote offer (AFTER tracks)');
        await pc.setRemoteDescription({ type: 'offer', sdp: remoteData.sdp });
        log('✅ Stage 5: Remote offer set');
        
        log('🔄 Stage 6: Creating answer');
        const answer = await pc.createAnswer();
        log('✅ Stage 6: Answer created');
        
        log('🔄 Stage 7: Setting local answer');
        await pc.setLocalDescription(answer);
        log('✅ Stage 7: Local answer set');
        
        // Wait for ICE
        log('⏳ Waiting ICE for answer...');
        await new Promise(resolve => {
            const timeout = setTimeout(() => {
                log('⚠️ Answer ICE timeout');
                resolve();
            }, 3000);
            
            const checkIce = setInterval(() => {
                if (pc.iceGatheringState === 'complete') {
                    clearInterval(checkIce);
                    clearTimeout(timeout);
                    log('✅ Answer ICE complete');
                    resolve();
                }
            }, 200);
        });
        
        updateCopyData();
        
    } catch (err) {
        log(`❌ ANSWER FAILED: ${err.message}`, { pastePreview: pasteEl.value.substring(0, 100) });
        statusEl.textContent = `❌ Invalid data: ${err.message}`;
    }
}

answerBtn.addEventListener('click', getLocalAnswer);

async function useRemoteData() {
    log('🔄 Using remote ANSWER');
    try {
        const rawData = pasteEl.value.trim();
        const decoded = atob(rawData);
        const remoteData = JSON.parse(decoded);
        
        log('✅ Parsed answer', { sdpLength: remoteData.sdp?.length });
        
        if (!pc) {
            log('❌ No peer connection - create offer first');
            statusEl.textContent = '❌ Create offer first';
            return;
        }
        
        log('🔄 Setting remote answer');
        await pc.setRemoteDescription({ type: 'answer', sdp: remoteData.sdp });
        log('✅ Remote answer set - P2P connected!');
        statusEl.textContent = '✅ Connected! Check video';
        
    } catch (err) {
        log(`❌ USE DATA FAILED: ${err.message}`);
        statusEl.textContent = `❌ Use failed: ${err.message}`;
    }
}

useDataBtn.addEventListener('click', useRemoteData);

function updateCopyData() {
    if (!pc?.localDescription?.sdp) {
        log('❌ No local description ready');
        return;
    }
    
    const data = { sdp: pc.localDescription.sdp };
    const compact = btoa(JSON.stringify(data));
    
    log('📋 Copy ready', { 
        type: pc.localDescription.type, 
        encodedSize: compact.length 
    });
    
    copyEl.value = compact;
    copyToClipboard();
    statusEl.textContent = `✅ ${pc.localDescription.type.toUpperCase()} ready! Copied to clipboard`;
}
