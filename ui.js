/*global Telegram */

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
Telegram.WebApp.onEvent('themeChanged', updateTheme);

document.addEventListener('DOMContentLoaded', () => {
        // Telegram init (UI only)
        Telegram.WebApp.ready();
        Telegram.WebApp.hideKeyboard();
        Telegram.WebApp.enableVerticalSwipes();
        Telegram.WebApp.enableClosingConfirmation();
        // Telegram.WebApp.expand();
        if (navigator.userAgent.includes('TelegramAndroid')) {
            document.addEventListener('DOMContentLoaded', () => {
                // Telegram.WebApp.expand();
                // Force hardware acceleration
                document.body.style.transform = 'translateZ(0)';
            });
        }
        
        // Theme sync
    updateTheme();  // Initial theme
});

const elements = {
    dataOfferActionBtn: document.getElementById('dataOfferAction'),
    dataOfferCopyBtn: document.getElementById('dataOfferCopy'),
    dataAnswerActionBtn: document.getElementById('dataAnswerAction'),
    dataAnswerCopyBtn: document.getElementById('dataAnswerCopy'),
    videoOfferActionBtn: document.getElementById('videoOfferAction'),
    videoControls: document.getElementById('videoControls'),
    dataOfferEmoji: document.querySelector('#dataOfferCopy .emoji'),
    dataAnswerEmoji: document.querySelector('#dataAnswerCopy .emoji'),

    useDataBtn: document.getElementById('useDataBtn'),
    pasteData: document.getElementById('pasteData'),
    statusEl: document.getElementById('status'),
    localVideo: document.getElementById('localVideo'),
    remoteVideo: document.getElementById('remoteVideo'),
    debugBtn: document.getElementById('debugBtn'),
    debugLogEl: document.getElementById('debugLog'),
    useDataEmoji: document.querySelector('#useDataBtn .emoji'),

    resetBtn: document.getElementById('resetBtn'),

    testCircBtn: document.getElementById('testCircBtn')
};

// State (UI only)
let offerData = null;
let answerData = null;

// UI State Management
function setButtonStatus(buttonType, status) {
    const emoji = {
        'offer': elements.dataOfferEmoji,
        'answer': elements.dataAnswerEmoji,
        'use': elements.useDataEmoji
    }[buttonType];
    
    if (!emoji) return;
    
    emoji.textContent = status === 'processing' ? '🔄' : 
                       status === 'success' ? '✅' : '🌐';
    
    const button = {
        'offer': elements.dataOfferCopyBtn,
        'answer': elements.dataAnswerCopyBtn,
        'use': elements.useDataBtn
    }[buttonType];
    
    button.className = status === 'processing' ? 'processing' : 
                      status === 'success' ? 'success' : '';
    
    if (status === 'success') {
        button.disabled = false;
    }
}

// UI Actions
function copyOfferData() {
    if (!offerData) return;
    navigator.clipboard.writeText(offerData).then(() => {
        Telegram.WebApp.HapticFeedback?.impactOccurred('light');
        elements.statusEl.textContent = '✅ Offer copied! Send to peer';
        elements.dataOfferCopyBtn.classList.add('success');
        setTimeout(() => elements.dataOfferCopyBtn.classList.remove('success'), 1000);
    });
}

function copyAnswerData() {
    if (!answerData) return;
    navigator.clipboard.writeText(answerData).then(() => {
        Telegram.WebApp.HapticFeedback?.impactOccurred('light');
        elements.statusEl.textContent = '✅ Answer copied! Send back';
        elements.dataAnswerCopyBtn.classList.add('success');
        setTimeout(() => elements.dataAnswerCopyBtn.classList.remove('success'), 1000);
    });
}

function updateStatus(message) {
    elements.statusEl.textContent = message;
}

function logUI(message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${message}`;
    elements.debugLogEl.innerHTML += line+`${data ? '<br>' : ''}<br>`;
    elements.debugLogEl.scrollTop = elements.debugLogEl.scrollHeight;
    elements.debugLogEl.style.display = 'block';
    console.log(line, data);
}

// Event Listeners
elements.testCircBtn.addEventListener('click', window.business.testCircuitRelays);

elements.resetBtn.addEventListener('click', ui.resetUI);

elements.useDataBtn.addEventListener('click', async () => {
    elements.useDataBtn.disabled = true;
    setButtonStatus('use', 'processing');
    
    try {
        await window.business.useRemoteData();
    } catch (err) {
        ui.logUI(`❌ Use data failed: ${err.message}`);
        setButtonStatus('use', ''); 
    } finally {
        elements.useDataBtn.disabled = false;
    }
});

elements.dataOfferActionBtn.addEventListener('click', async () => {
    elements.dataOfferActionBtn.disabled = true;
    setButtonStatus('offer', 'processing');
    try {
        await window.business.createDataOffer();
    } catch (err) {
        ui.logUI(`❌ Data offer failed: ${err.message}`);
    } finally {
        elements.dataOfferActionBtn.disabled = false;
    }
});

elements.dataAnswerActionBtn.addEventListener('click', async () => {
    elements.dataAnswerActionBtn.disabled = true;
    setButtonStatus('answer', 'processing');
    try {
        await window.business.createDataAnswer();
    } catch (err) {
        ui.logUI(`❌ Data answer failed: ${err.message}`);
    } finally {
        elements.dataAnswerActionBtn.disabled = false;
    }
});

// Copy handlers
elements.dataOfferCopyBtn.addEventListener('click', copyOfferData);
elements.dataAnswerCopyBtn.addEventListener('click', copyAnswerData);
elements.debugBtn.addEventListener('click', () => {
    elements.debugLogEl.style.display = elements.debugLogEl.style.display === 'none' ? 'block' : 'none';
});
elements.videoOfferActionBtn.addEventListener('click', async () => {
    elements.videoOfferActionBtn.disabled = true;
    elements.videoOfferActionBtn.textContent = '🔄 Starting...';
    try {
        await window.business.createVideoOffer();
    } catch (err) {
        ui.logUI(`❌ Video offer failed: ${err.message}`);
    } finally {
        elements.videoOfferActionBtn.disabled = false;
        elements.videoOfferActionBtn.textContent = '📹 Start Video Call';
    }
});

// Public UI API for window.business logic
export const ui = {
    setButtonStatus,
    storeOfferData: (data) => { offerData = data; setButtonStatus('offer', 'success'); },
    storeAnswerData: (data) => { answerData = data; setButtonStatus('answer', 'success'); elements.videoControls.style.display = 'block'; },
    showVideoControls: () => elements.videoControls.style.display = 'block',
    updateStatus,
    logUI,
    getPasteData: () => elements.pasteData.value.trim(),
    setLocalVideo: (stream) => {
        const video = elements.localVideo;
        video.srcObject = stream;
        
        // ANDROID WEBVIEW FIXES
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.style.objectFit = 'cover';
        video.style.width = '100%';
        video.style.height = '200px';
        
        // Force play on Android
        video.play().catch(e => ui.logUI('Local video play:', e));
    },
    setRemoteVideo: (stream) => {
        const video = elements.remoteVideo;
        video.srcObject = stream;
        
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.style.objectFit = 'cover';
        video.style.width = '100%';
        video.style.height = '200px';
        
        // Android remote video force-start
        setTimeout(() => video.play().catch(e => ui.logUI('Remote video play:', e)), 500);
    },
    resetUI: () => {
        offerData = null; answerData = null;
        elements.dataOfferCopyBtn.disabled = true;
        elements.dataAnswerCopyBtn.disabled = true;
        elements.dataOfferEmoji.textContent = '🌐';
        elements.dataAnswerEmoji.textContent = '🌐';
        elements.localVideo.srcObject = null;
        elements.remoteVideo.srcObject = null;
        elements.videoControls.style.display = 'none';
        updateStatus('🧹 Reset complete');
    }
};
window.uiReady = true;
