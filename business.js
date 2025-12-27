/*global ui, pako */
// Global state
let dataPc = null;
let mediaPc = null;
let localStream = null;
let dataChannel = null;
const config = { 
    iceServers: [
        {urls: 'stun:stun.l.google.com:19302'},
        {urls: 'stun:stun1.l.google.com:19302'}
    ] 
};

// Business Logic API
const business = {
    // Reset everything
    resetAll() {
        ui.logUI('🧹 Full reset');
        if (dataPc) { dataPc.close(); dataPc = null; }
        if (mediaPc) { mediaPc.close(); mediaPc = null; }
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        if (dataChannel) dataChannel = null;
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


    getSDPEncoded(connection, type){
        if (!connection?.localDescription?.sdp) {
            ui.logUI('❌ No local description ready');
            throw new Error('❌ No local description ready');
        }
        
        const sdp = connection.localDescription.sdp;
        ui.logUI('📋 Full SDP ready', { 
            type: connection.localDescription.type, 
            sdpLength: sdp.length,
            iceState: connection.iceGatheringState
        });
        return business.encodeChunks(sdp,type);
    },

    // Chunk encoding
    encodeChunks(sdp, type) {
        ui.logUI(`🔄 Compressing ${sdp.length} chars SDP`);

        const minimalSdp = sdp
            .split('\n')
            .filter(line => 
                        !line.match(/candidate.*relay/)) // Skip TURN
            .join('\n');
        ui.logUI(`ℹ️ Minimal SDP is ${minimalSdp.length} chars`);
        
        let base64 = btoa(String.fromCharCode(...pako.deflate(minimalSdp)));
        base64 = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        
        let result = {"answer":"(a)","offer": "(o)"}[type]+base64;
        ui.logUI(`✅ Compressed to ${result.length} chars`);
        return result;
    },

    // Chunk decoding  
    decodeChunks(rawData, expectedType) {
        try {
            let rawParts = rawData.trim().split(")");
            if (rawParts[0].length != 2) {
                throw new Error(`Expected type mark, got ${rawParts[0]}`);
            }
            let dataType = {"(a":"answer", "(o":"offer"}[rawParts[0]];
            if (dataType !== expectedType) {
                throw new Error(`Expected ${expectedType}, got ${dataType}`);
            }
            
            let base64 = rawParts[1].replace(/-/g, '+').replace(/_/g, '/');
            base64 += '='.repeat((4 - base64.length % 4) % 4);
            const minimalSdp = pako.inflate(Uint8Array.from(atob(base64), c => c.charCodeAt(0)), { to: 'string' });
            
            ui.logUI(`✅ Decompressed ${minimalSdp.length} chars (${rawParts[1].length}→${minimalSdp.length})`);
            return minimalSdp;
        }catch (err) {
            ui.logUI(`❌ Decode failed: ${err.message} from ${err}`);
            throw new Error(`Invalid compressed SDP: ${err.message} from ${err}`);
        }
    },

    async createDataOffer() {
        business.resetAll();
        
        try{
            dataPc = new RTCPeerConnection(config);
            dataPc.onnegotiationneeded = null;

            dataPc.onconnectionstatechange = () => ui.logUI(`Connection state: ${dataPc.connectionState}`);
            dataPc.onicecandidate = (event) => { if (event.candidate) { ui.logUI('🧊 ICE candidate gathered'); } };
            dataPc.onicegatheringstatechange = () => ui.logUI(`ICE state: ${dataPc.iceGatheringState}`);
            dataPc.oniceconnectionstatechange = () => ui.logUI(`Data ICE: ${dataPc.iceConnectionState}`);
            
            // Minimal SDP - NO MEDIA
            const offer = await dataPc.createOffer({
                offerToReceiveAudio: 0,
                offerToReceiveVideo: 0
            });
            await dataPc.setLocalDescription(offer);
            ui.logUI(`✅ Offer ready. State: ${dataPc.signalingState}`);
            ui.storeOfferData(business.getSDPEncoded(dataPc, 'offer'));
        } catch (err) {
            ui.logUI(`❌ DATA OFFER ERROR: ${err.message}`);
            ui.updateStatus(`❌ ${err.message}`);
            throw err;
        }
    },

    async createDataAnswer() {
        business.resetAll();
        
        const rawData = ui.getPasteData();
        if (!rawData) throw new Error('Paste data offer first');
        
        try {
            const offerSdp = business.decodeChunks(rawData, 'offer');
            
            dataPc = new RTCPeerConnection(config);
            
            // Receive data channel
            dataPc.ondatachannel = (event) => {
                dataChannel = event.channel;
                dataChannel.onopen = () => {
                    ui.logUI('✅ Data channel open');
                    ui.updateStatus('✅ Data link ready! Video controls unlocked.');
                    ui.showVideoControls();
                };
                dataChannel.onmessage = business.handleDataChannelMessage;
            };

            await dataPc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
            const answer = await dataPc.createAnswer();
            await dataPc.setLocalDescription(answer);
            ui.logUI(`✅ Offer ready. State: ${dataPc.signalingState}`);
            ui.storeAnswerData(business.getSDPEncoded(dataPc, 'answer'));
        } catch (err) {
            ui.logUI(`❌ DATA ANSWER ERROR: ${err.message}`);
            ui.updateStatus(`❌ ${err.message}`);
            throw err;
        }
    },

    handleDataChannelMessage(event) {
        try {
            const msg = JSON.parse(event.data);
            ui.logUI(`📨 Data channel: ${msg.type}`);
            
            if (msg.type === 'video-offer') {
                business.handleVideoOffer(msg.sdp);
            } else if (msg.type === 'video-answer') {
                business.handleVideoAnswer(msg.sdp);
            }
        } catch (err) {
            ui.logUI(`❌ Data message error: ${err.message}`);
        }
    },

    async initMediaChannel(initType, sdpData) {
        const mediaStream = await business.setupMedia();
        if (!mediaStream) {
            ui.updateStatus('Failed to init media channel');
            return false;
        }
        
        mediaPc = new RTCPeerConnection(config);
        mediaStream.getTracks().forEach(track => mediaPc.addTrack(track, mediaStream));
        
        mediaPc.ontrack = (e) => {
            ui.logUI(`📹 Video track received`);
            ui.setRemoteVideo(e.streams[0]);
        };
        
        if (initType === 'answer') {
            await mediaPc.setRemoteDescription({ type: 'offer', sdp: business.decodeChunks(sdpData, 'offer') });
        }
        
        const description = await (initType === "offer" ? mediaPc.createOffer() : mediaPc.createAnswer());
        await mediaPc.setLocalDescription(description);
        
        // Send answer BACK via data channel
        dataChannel.send(JSON.stringify({
            type: 'video-'+initType,
            sdp: business.encodeChunks(mediaPc.localDescription.sdp, initType)
        }));
        return true;
    },

    async handleVideoOffer(sdpData) {
        ui.logUI('🔄 Processing video offer');
        try{
            if (business.initMediaChannel('answer', sdpData)) {
                ui.updateStatus('✅ Video connected!');
            }
        } catch (err) {
            ui.logUI(`❌ VIDEO ANSWER ERROR: ${err.message}`);
            ui.updateStatus(`❌ ${err.message}`);
            throw err;
        }
    },

    async handleVideoAnswer(sdpData) {
        const answerSdp = business.decodeChunks(sdpData, 'answer');
        await mediaPc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
        ui.logUI('✅ Video answer applied');
        ui.updateStatus('✅ Video call live!');
    },

    async createVideoOffer() {
        if (!dataChannel) {
            ui.updateStatus('❌ Data link required first');
            return;
        }

        if (dataChannel.readyState !== 'open') {
            ui.updateStatus(`❌ Data channel state is${dataChannel.readyState}`);
            return;
        }
        
        if (mediaPc) {
            ui.logUI('❌ Media PC already exists');
            return;
        }
        
        ui.logUI('🎥 Creating video offer');
        try {
            if (business.initMediaChannel('offer')) {
                ui.updateStatus('📤 Video offer sent via data channel...');
            }
        } catch (err) {
            ui.logUI(`❌ VIDEO OFFER ERROR: ${err.message}`);
            ui.updateStatus(`❌ ${err.message}`);
            throw err;
        }
    },

    async useRemoteData() {
        try {
            const rawData = ui.getPasteData();
            if (!rawData) throw new Error('Paste answer first');
            
            const fullSdp = business.decodeChunks(rawData, 'answer');
            
            if (!dataPc)  {
                ui.updateStatus(`❌ Create fresh offer first`);
                return;
            }
            if(dataPc.signalingState !== 'have-local-offer'){
                ui.updateStatus(`❌ Wrong state: ${dataPc.signalingState}, expected 'have-local-offer'`);
                return;
            }
            
            await dataPc.setRemoteDescription({ type: 'answer', sdp: fullSdp });
            ui.logUI(`✅ Connected! State: ${dataPc.signalingState}`);
            ui.updateStatus('✅ P2P Connected!');


            // Create signaling data channel
            dataChannel = dataPc.createDataChannel('signaling', { 
                ordered: true, 
                maxRetransmits: 0 
            });
            
            dataChannel.onopen = () => {
                ui.logUI('✅ Data channel ready');
                ui.updateStatus('✅ Data link established! Ready for video.');
                ui.showVideoControls();
            };
            dataChannel.onmessage = business.handleDataChannelMessage;
            return;
        } catch (err) {
            ui.logUI(`❌ USE ERROR: ${err.message}`);
            ui.updateStatus(`❌ ${err.message}`);
            throw err;
        }
    }
};

window.business = business;
