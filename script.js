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

function decodeChunks(rawData, expectedType) {
    const lines = rawData.split('\n---\n');
    let fullSdp = '';
    
    log(`🔄 Decoding ${lines.length} chunks for ${expectedType}`);
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        try {
            // URL-safe base64 → standard base64
            let base64 = line;
            base64 = base64.replace(/-/g, '+').replace(/_/g, '/');
            const padding = base64.length % 4;
            if (padding) base64 += '='.repeat(4 - padding);
            
            const decoded = atob(base64);
            const chunkData = JSON.parse(decoded);
            
            // Validate
            if (chunkData.type !== expectedType) {
                throw new Error(`Expected ${expectedType}, got ${chunkData.type} in chunk ${i+1}`);
            }
            if ('total' in chunkData && chunkData.chunk >= chunkData.total) {
                throw new Error(`Invalid chunk index ${chunkData.chunk}`);
            }
            
            fullSdp += chunkData.sdp;
            log(`✅ Chunk ${chunkData.chunk + 1}: ${chunkData.sdp.length} chars`);
            
        } catch (chunkErr) {
            log(`❌ Chunk ${i+1} RAW:`, line.substring(0, 50) + '...');
            throw new Error(`Chunk ${i+1} failed: ${chunkErr.message}`);
        }
    }
    
    log(`✅ Full SDP: ${fullSdp.length} chars`);
    return fullSdp;
}

async function getLocalAnswer() {
    log('🔄 Starting ANSWER creation');
    try {
        const rawData = pasteEl.value.trim();
        if (!rawData) throw new Error('Empty paste data');
        
        // Decode offer chunks
        const fullSdp = decodeChunks(rawData, 'offer');
        
        const mediaReady = await setupMedia();
        if (!mediaReady) throw new Error('Camera setup failed');
        
        log('🔄 Creating peer connection');
        pc = new RTCPeerConnection(config);
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        
        pc.ontrack = e => {
            log('📹 Remote stream received');
            document.getElementById('remoteVideo').srcObject = e.streams[0];
        };
        
        log('🔄 Setting remote offer');
        await pc.setRemoteDescription({ type: 'offer', sdp: fullSdp });
        log('✅ Remote offer set');
        
        log('🔄 Creating answer');
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        log('✅ Answer ready');
        
        // ICE gathering
        await new Promise(resolve => {
            const checkIce = setInterval(() => {
                if (pc.iceGatheringState === 'complete') {
                    clearInterval(checkIce);
                    updateCopyData();
                    resolve();
                }
            }, 200);
        });
        
    } catch (err) {
        log(`❌ ANSWER FAILED: ${err.message}`);
        statusEl.textContent = `❌ Invalid data: ${err.message}`;
    }
}


answerBtn.addEventListener('click', getLocalAnswer);

async function useRemoteData() {
    log('🔄 Using remote ANSWER');
    try {
        const rawData = pasteEl.value.trim();
        if (!rawData) throw new Error('Empty paste data');
        
        // Decode answer chunks
        const fullSdp = decodeChunks(rawData, 'answer');
        
        if (!pc) {
            log('❌ No peer connection - create offer first');
            statusEl.textContent = '❌ Create offer first';
            return;
        }
        
        log('🔄 Setting remote answer');
        await pc.setRemoteDescription({ type: 'answer', sdp: fullSdp });
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
    
    const sdp = pc.localDescription.sdp;
    log('📋 Full SDP ready', { 
        type: pc.localDescription.type, 
        sdpLength: sdp.length,
        iceState: pc.iceGatheringState
    });
    
    // FIXED: URL-safe base64 encoding (no +/= corruption)
    const CHUNK_SIZE = 2600;
    const chunks = [];
    
    for (let i = 0; i < sdp.length; i += CHUNK_SIZE) {
        const chunk = sdp.slice(i, i + CHUNK_SIZE);
        const data = { 
            type: pc.localDescription.type,
            chunk: Math.floor(i / CHUNK_SIZE),
            total: Math.ceil(sdp.length / CHUNK_SIZE),
            sdp: chunk 
        };
        
        // URL-safe base64: replace +/ with -_, remove =
        let jsonStr = JSON.stringify(data);
        let base64 = btoa(jsonStr);
        base64 = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        
        chunks.push(base64);
    }
    
    const copyText = chunks.join('\n---\n');
    copyEl.value = copyText;
    
    navigator.clipboard.writeText(copyText).then(() => {
        log('✅ URL-safe SDP copied', { chunks: chunks.length });
        copyFeedbackEl.textContent = `✅ Copied ${chunks.length} chunks! (URL-safe)`;
        copyFeedbackEl.style.display = 'block';
        setTimeout(() => copyFeedbackEl.style.display = 'none', 3000);
    });
    
    statusEl.textContent = `✅ ${pc.localDescription.type.toUpperCase()} (${chunks.length} chunks)`;
}
