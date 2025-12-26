// Global state
let pc = null;
let localStream = null;
const config = { 
    iceServers: [
        {urls: 'stun:stun.l.google.com:19302'},
        {urls: 'stun:stun1.l.google.com:19302'}
    ] 
};

// Business Logic API
const business = {
    // Reset everything
    resetConnection() {
        ui.logUI('🧹 Full reset');
        
        if (pc) {
            pc.close();
            pc = null;
        }
        
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        
        ui.resetUI();
    },

    // Single media setup
    async setupMedia() {
        if (localStream && localStream.active) {
            ui.logUI('✅ Reusing stream');
            return true;
        }
        
        ui.logUI('🔄 Requesting camera');
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: { 
                    width: { ideal: 640, max: 1280 }, 
                    height: { ideal: 480, max: 720 },
                    frameRate: { ideal: 15, max: 30 }, // Lower FPS for Android
                    facingMode: 'user'
                }, 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
            });
            localStream.getVideoTracks()[0].applyConstraints({
                width: { ideal: 640 },
                height: { ideal: 480 }
            });
            ui.setLocalVideo(localStream);
            ui.logUI('✅ Stage 1: Camera OK', { tracks: localStream.getTracks().length });
            return true;
        } catch (err) {
            ui.logUI(`❌ Camera: ${err.name} - ${err.message}`);
            ui.updateStatus(`❌ Camera: ${err.name}`);
            return false;
        }
    },


    getCopyData(type){
        if (!pc?.localDescription?.sdp) {
            ui.logUI('❌ No local description ready');
            return;
        }
        
        const sdp = pc.localDescription.sdp;
        ui.logUI('📋 Full SDP ready', { 
            type: pc.localDescription.type, 
            sdpLength: sdp.length,
            iceState: pc.iceGatheringState
        });
        return business.encodeChunks(sdp,type);
    },

    // Chunk encoding
    encodeChunks(sdp, type) {
        const CHUNK_SIZE = 2600;
        const chunks = [];
        
        for (let i = 0; i < sdp.length; i += CHUNK_SIZE) {
            const chunk = sdp.slice(i, i + CHUNK_SIZE);
            const data = { type, chunk: Math.floor(i / CHUNK_SIZE), total: Math.ceil(sdp.length / CHUNK_SIZE), sdp: chunk };
            let jsonStr = JSON.stringify(data);
            let base64 = btoa(jsonStr);
            base64 = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
            chunks.push(base64);
        }
        
        return chunks.join('!!!');
    },

    // Chunk decoding  
    decodeChunks(rawData, expectedType) {
        const lines = rawData.split('!!!');
        let fullSdp = '';
        
        ui.logUI(`🔄 Decoding ${lines.length} chunks (${expectedType})`);
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            try {
                let base64 = line.replace(/-/g, '+').replace(/_/g, '/');
                const padding = (4 - (base64.length % 4)) % 4;
                base64 += '='.repeat(padding);
                
                const decoded = atob(base64);
                const chunkData = JSON.parse(decoded);
                
                if (chunkData.type !== expectedType) {
                    throw new Error(`Expected ${expectedType}, got ${chunkData.type}`);
                }
                
                fullSdp += chunkData.sdp;
                ui.logUI(`✅ Chunk ${chunkData.chunk + 1}/${chunkData.total}`);
                
            } catch (chunkErr) {
                ui.logUI(`❌ Chunk ${i+1}: ${chunkErr.message}`);
                throw new Error(`Chunk ${i+1}: ${chunkErr.message}`);
            }
        }
        
        ui.logUI(`✅ Full SDP: ${fullSdp.length} chars`);
        return fullSdp;
    },

    async getLocalOffer() {
        business.resetConnection();
        
        const mediaReady = await business.setupMedia();
        if (!mediaReady) return;
        
        try {
            pc = new RTCPeerConnection(config);
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
                ui.logUI(`✅ Added track: ${track.kind}`);
            });
            
            pc.ontrack = e => {
                ui.logUI(`📹 Remote track: ${event.track.kind}`);
                ui.setRemoteVideo(event.streams[0]);
                
                // ANDROID FIX: Restart remote video track
                event.streams[0].getVideoTracks()[0]?.addEventListener('ended', () => {
                    ui.logUI('Remote track ended - restarting');
                });
            };
            if (pc.addTransceiver) {
                pc.addTransceiver('video', { direction: 'recvonly' });
                pc.addTransceiver('audio', { direction: 'recvonly' });
            }

            pc.onconnectionstatechange = () => {
                ui.logUI(`Connection state: ${pc.connectionState}`);
            };
            
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    ui.logUI('🧊 ICE candidate gathered');
                }
            };
            
            pc.onicegatheringstatechange = () => {
                ui.logUI(`ICE state: ${pc.iceGatheringState}`);
            };
            
            const offer = await pc.createOffer();//{ offerToReceiveAudio: true, offerToReceiveVideo: true }
            await pc.setLocalDescription(offer);
            ui.logUI(`✅ Offer ready. State: ${pc.signalingState}`);
            
            // Wait ICE
            setTimeout(() => {
                const data = business.getCopyData('offer');
                ui.storeOfferData(data);
            }, 2500);
            return;
        } catch (err) {
            ui.logUI(`❌ OFFER ERROR: ${err.message}`);
            ui.updateStatus(`❌ ${err.message}`);
            throw err;
        }
    },

    async getLocalAnswer() {
        business.resetConnection();
        
        try {
            const rawData = ui.getPasteData();
            if (!rawData) throw new Error('Paste offer first');
            
            const fullSdp = business.decodeChunks(rawData, 'offer');
            
            const mediaReady = await business.setupMedia();
            if (!mediaReady) throw new Error('Camera needed');
            
            pc = new RTCPeerConnection(config);
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
                ui.logUI(`✅ Added track: ${track.kind}`);
            });
            
            pc.ontrack = e => {
                ui.logUI('📹 Remote stream received');
                ui.setRemoteVideo(e.streams[0])
            };

            pc.onconnectionstatechange = () => {
                ui.logUI(`Connection state: ${pc.connectionState}`);
            };
            
            await pc.setRemoteDescription({ type: 'offer', sdp: fullSdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            setTimeout(() => {
                const data = business.getCopyData('answer');
                ui.storeAnswerData(data);
            }, 2500);
            return;
        } catch (err) {
            ui.logUI(`❌ ANSWER ERROR: ${err.message}`);
            ui.updateStatus(`❌ ${err.message}`);
            throw err;
        }
    },

    async useRemoteData() {
        try {
            const rawData = ui.getPasteData();
            if (!rawData) throw new Error('Paste answer first');
            
            const fullSdp = business.decodeChunks(rawData, 'answer');
            
            if (!pc)  {
                ui.updateStatus(`❌ Create fresh offer first`);
                return;
            }
            if(pc.signalingState !== 'have-local-offer'){
                ui.updateStatus(`❌ Wrong state: ${pc.signalingState}, expected 'have-local-offer'`);
                return;
            }
            
            await pc.setRemoteDescription({ type: 'answer', sdp: fullSdp });
            ui.logUI(`✅ Connected! State: ${pc.signalingState}`);
            ui.updateStatus('✅ P2P Connected!');
            return;
        } catch (err) {
            ui.logUI(`❌ USE ERROR: ${err.message}`);
            ui.updateStatus(`❌ ${err.message}`);
            throw err;
        }
    }
};

window.business = business;
