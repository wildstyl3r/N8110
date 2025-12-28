// Global state

import { ui } from './ui.js';
const { circuitRelayTransport, circuitRelayServer } = window.Libp2PCircuitRelayV2;
const { createLibp2p } = window.Libp2P; 
const { noise } = window.ChainsafeLibp2PNoise;
const { yamux } = window.ChainsafeLibp2PYamux;
const { identify } = window.Libp2PIdentify;
const { bootstrap } = window.Libp2PBootstrap;
let dataPc = null;
let mediaPc = null;
let localStream = null;
let dataChannel = null;
let node = null;

const pako = window.pako;

const stunDomains = [
  'stun.l.google.com:19302',
  'stun1.l.google.com:19302',
  'stun2.l.google.com:19302',
  'stun3.l.google.com:19302',
  'stun4.l.google.com:19302',
  'stunserver.org',
  'stun.stunprotocol.org',
  'nonexistent.stunserver123.xyz', // This will fail
  'stun.qq.com:3478',
  'stun.arbuz.ru:3478',
  'stun.comtube.ru:3478',
  'stun.demos.ru:3478',
  'stun.sipnet.ru:3478',
  'stun.skylink.ru:3478',
  'stun.tagan.ru:3478',
  'stun.tatneft.ru:3478',
  'stun.tis-dialog.ru:3478',
];
const config = { 
    iceServers: [
        {urls: 'stun:stun.qq.com:3478'},
        // {urls: 'stun:stun1.l.google.com:19302'},
        // {urls: 'stun:stun.arbuz.ru:3478'},
        // {urls: 'stun:stun.comtube.ru:3478'},
        // {urls: 'stun:stun.demos.ru:3478'},
        // {urls: 'stun:stun.sipnet.ru:3478'},
        // // {urls: 'stun:stun.skylink.ru:3478'},
        // {urls: 'stun:stun.tagan.ru:3478'},
        // {urls: 'stun:stun.tatneft.ru:3478'},
        // {urls: 'stun:stun.tis-dialog.ru:3478'},
    ] 
};




// window.business Logic API
window.business = {
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
        return window.business.encodeChunks(sdp,type);
    },

    // Chunk encoding
    encodeChunks(sdp, type) {
        ui.logUI(`🔄 Compressing ${sdp.length} chars SDP`);
        
        let base64 = btoa(String.fromCharCode(...pako.deflate(sdp)));
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
        window.business.resetAll();
        
        try{
            dataPc = new RTCPeerConnection(config);

            dataPc.onconnectionstatechange = () => ui.logUI(`Connection state: ${dataPc.connectionState}`);
            dataPc.onicecandidate = (event) => {
                if (event.candidate) {
                    ui.logUI('🧊 ICE candidate gathered');
                } else {
                    ui.logUI('🧊 ICE gathering complete');
                }
            };
            dataPc.onicegatheringstatechange = () => ui.logUI(`ICE gathering: ${dataPc.iceGatheringState}`);
            dataPc.oniceconnectionstatechange = () => {
                ui.logUI(`dataPc ICE state becomes ${dataPc.iceConnectionState}`);
                if (dataPc.iceConnectionState === 'connected') {
                    ui.logUI('seems connected, trying to create datachannel');
                    dataChannel = dataPc.createDataChannel('signaling', { 
                        ordered: true, 
                        maxRetransmits: 0 
                    });
                    
                    dataChannel.onopen = () => {
                        ui.logUI('✅ Data channel ready');
                        ui.updateStatus('✅ Data link established! Ready for video.');
                        ui.showVideoControls();
                    };
                    dataChannel.onmessage = window.business.handleDataChannelMessage;
                }
            };
            
            // Minimal SDP - NO MEDIA
            const offer = await dataPc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
                iceRestart: false,
            });
            await dataPc.setLocalDescription(offer);
            ui.logUI(`✅ Offer ready. State: ${dataPc.signalingState}`);
            ui.storeOfferData(window.business.getSDPEncoded(dataPc, 'offer'));
        } catch (err) {
            ui.logUI(`❌ DATA OFFER ERROR: ${err.message}`);
            ui.updateStatus(`❌ ${err.message}`);
            throw err;
        }
    },

    async createDataAnswer() {
        window.business.resetAll();
        
        const rawData = ui.getPasteData();
        if (!rawData) throw new Error('Paste data offer first');
        
        try {
            const offerSdp = window.business.decodeChunks(rawData, 'offer');
            
            dataPc = new RTCPeerConnection(config);
            
            // Receive data channel
            dataPc.ondatachannel = (event) => {
                dataChannel = event.channel;
                dataChannel.onopen = () => {
                    ui.logUI('✅ Data channel open');
                    ui.updateStatus('✅ Data link ready! Video controls unlocked.');
                    ui.showVideoControls();
                };
                dataChannel.onmessage = window.business.handleDataChannelMessage;
            };

            await dataPc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
            const answer = await dataPc.createAnswer();
            await dataPc.setLocalDescription(answer);
            ui.logUI(`✅ Offer ready. State: ${dataPc.signalingState}`);
            ui.storeAnswerData(window.business.getSDPEncoded(dataPc, 'answer'));
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
                window.business.handleVideoOffer(msg.sdp);
            } else if (msg.type === 'video-answer') {
                window.business.handleVideoAnswer(msg.sdp);
            }
        } catch (err) {
            ui.logUI(`❌ Data message error: ${err.message}`);
        }
    },

    async initMediaChannel(initType, sdpData) {
        const mediaStream = await window.business.setupMedia();
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
            await mediaPc.setRemoteDescription({ type: 'offer', sdp: window.business.decodeChunks(sdpData, 'offer') });
        }
        
        const description = await (initType === "offer" ? mediaPc.createOffer() : mediaPc.createAnswer());
        await mediaPc.setLocalDescription(description);
        
        // Send answer BACK via data channel
        dataChannel.send(JSON.stringify({
            type: 'video-'+initType,
            sdp: window.business.encodeChunks(mediaPc.localDescription.sdp, initType)
        }));
        return true;
    },

    async handleVideoOffer(sdpData) {
        ui.logUI('🔄 Processing video offer');
        try{
            if (window.business.initMediaChannel('answer', sdpData)) {
                ui.updateStatus('✅ Video connected!');
            }
        } catch (err) {
            ui.logUI(`❌ VIDEO ANSWER ERROR: ${err.message}`);
            ui.updateStatus(`❌ ${err.message}`);
            throw err;
        }
    },

    async handleVideoAnswer(sdpData) {
        const answerSdp = window.business.decodeChunks(sdpData, 'answer');
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
            if (window.business.initMediaChannel('offer')) {
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
            
            const fullSdp = window.business.decodeChunks(rawData, 'answer');
            
            if (!dataPc)  {
                ui.updateStatus(`❌ Create fresh offer first`);
                return;
            }
            if(dataPc.signalingState !== 'have-local-offer'){
                ui.updateStatus(`❌ Wrong state: ${dataPc.signalingState}, expected 'have-local-offer'`);
                return;
            }

            ui.logUI(`BEFORE setRemote: signaling=${dataPc.signalingState}, ice=${dataPc.iceConnectionState}`);
            
            await dataPc.setRemoteDescription({ type: 'answer', sdp: fullSdp });
            ui.logUI(`AFTER setRemote: signaling=${dataPc.signalingState}, ice=${dataPc.iceConnectionState}`);
            ui.logUI(`✅ Connected! State: ${dataPc.signalingState}`);
            ui.updateStatus('✅ P2P Connected!');
            // Create signaling data channel
            
            return;
        } catch (err) {
            ui.logUI(`❌ USE ERROR: ${err.message}`);
            ui.updateStatus(`❌ ${err.message}`);
            throw err;
        }
    },

async testCircuitRelays() {
  console.log('Testing libp2p bootstraping...');
  if (node) await node.stop();
  node = await createLibp2p({
    addresses: {
      listen: ['/p2p-circuit']
    },
    transports: [
      circuitRelayTransport()
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
         bootstrap({
            list: [ // a list of bootstrap peer multiaddrs to connect to on node startup
                "/ip4/104.131.131.82/tcp/4001/ipfs/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
                "/dnsaddr/bootstrap.libp2p.io/ipfs/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
                "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
                "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
                "/dnsaddr/bootstrap.libp2p.io/ipfs/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa"
            ],
            timeout: 1000, // in ms,
            tagName: 'bootstrap',
            tagValue: 50,
            tagTTL: 120000 // in ms
            })
    ],
    services: {
      identify: identify()
    }
  });
  node.addEventListener('peer:discovery', (evt) => {
    console.log('found peer: ', evt.detail.toString())
    });
},


};